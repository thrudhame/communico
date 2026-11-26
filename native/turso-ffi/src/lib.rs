//! Owned JSON replies across a small C ABI. Every pointer returned by a call
//! belongs to the caller until ffi_free. Engine work runs on Tokio workers.
use serde_json::{json, Value as Json};
use std::collections::HashMap;
use std::ffi::{c_char, CStr, CString};
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use turso::{Connection, Database, Value};
mod checkpoint;

#[derive(Debug)]
struct Failure {
    code: i32,
    message: String,
    last_error: String,
    required_write_bytes: Option<u64>,
}

type Result<T> = std::result::Result<T, Failure>;

impl Failure {
    fn binding(message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            code: 21,
            last_error: message.clone(),
            message,
            required_write_bytes: None,
        }
    }
}

impl From<turso::Error> for Failure {
    fn from(error: turso::Error) -> Self {
        let code = match &error {
            turso::Error::Busy(_) => 5,
            turso::Error::BusySnapshot(_) => 517,
            turso::Error::Interrupt(_) => 9,
            turso::Error::Constraint(_) => 19,
            turso::Error::Misuse(_) => 21,
            turso::Error::Readonly(_) => 8,
            turso::Error::DatabaseFull(_) => 13,
            turso::Error::NotAdb(_) => 26,
            turso::Error::Corrupt(_) => 11,
            turso::Error::IoError(..) => 10,
            _ => 1,
        };
        Self {
            code,
            message: error.to_string(),
            last_error: format!("{error:?}"),
            required_write_bytes: None,
        }
    }
}

struct File {
    database: Arc<Database>,
    checkpoint: Arc<checkpoint::Observer>,
    references: usize,
    connecting: usize,
    path: PathBuf,
}

#[derive(Default)]
struct Opening {
    done: Mutex<bool>,
    finished: Condvar,
}

// A reservation survives failure and unwind, so waiters always retry against
// the registry after the sole initializer has either published or failed.
struct OpenReservation {
    path: PathBuf,
    opening: Arc<Opening>,
}

impl Drop for OpenReservation {
    fn drop(&mut self) {
        if let Ok(mut handles) = handles() {
            handles.opening.remove(&self.path);
        }
        if let Ok(mut done) = self.opening.done.lock() {
            *done = true;
            self.opening.finished.notify_all();
        }
    }
}

struct Connecting(u32);

impl Drop for Connecting {
    fn drop(&mut self) {
        if let Ok(mut handles) = handles() {
            if let Some(file) = handles.files.get_mut(&self.0) {
                file.connecting -= 1;
            }
        }
    }
}

type SharedConnection = Arc<tokio::sync::Mutex<Connection>>;
type ConnectionLimit = Option<Arc<checkpoint::Grant>>;

#[derive(Default)]
struct Handles {
    next: u32,
    files: HashMap<u32, File>,
    paths: HashMap<PathBuf, u32>,
    opening: HashMap<PathBuf, Arc<Opening>>,
    connections: HashMap<u32, (u32, SharedConnection, ConnectionLimit)>,
    locks: HashMap<u32, std::fs::File>,
}

impl Handles {
    fn id(&mut self) -> Result<u32> {
        self.next = self
            .next
            .checked_add(1)
            .ok_or_else(|| Failure::binding("handle space exhausted"))?;
        Ok(self.next)
    }
}

fn handles() -> Result<MutexGuard<'static, Handles>> {
    static HANDLES: OnceLock<Mutex<Handles>> = OnceLock::new();
    HANDLES
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| Failure::binding("handle registry poisoned"))
}

fn run<T: Send + 'static>(
    future: impl std::future::Future<Output = Result<T>> + Send + 'static,
) -> Result<T> {
    static RUNTIME: OnceLock<std::result::Result<tokio::runtime::Runtime, String>> =
        OnceLock::new();
    let runtime = RUNTIME
        .get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(4)
                .enable_all()
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(Failure::binding)?;
    runtime
        .block_on(runtime.spawn(future))
        .map_err(|e| Failure::binding(format!("runtime task: {e}")))?
}

unsafe fn text(pointer: *const c_char) -> Result<String> {
    if pointer.is_null() {
        return Err(Failure::binding("null string"));
    }
    CStr::from_ptr(pointer)
        .to_str()
        .map(str::to_owned)
        .map_err(|e| Failure::binding(e.to_string()))
}

fn reply(call: impl FnOnce() -> Result<Json>) -> *mut c_char {
    // Include serialization in the unwind boundary as well as the operation.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let value = match call() {
            Ok(value) => json!({"code": 0, "value": value}),
            Err(error) => json!({"code": error.code, "message": error.message,
                                 "last_error": error.last_error,
                                 "required_write_bytes": error.required_write_bytes}),
        };
        CString::new(value.to_string())
    }));
    match result {
        Ok(Ok(value)) => value.into_raw(),
        _ => CString::new(
            r#"{"code":21,"message":"Rust panic","last_error":"ABI operation panicked"}"#,
        )
        .map(CString::into_raw)
        .unwrap_or(std::ptr::null_mut()),
    }
}

fn parameters(text: String) -> Result<Vec<Value>> {
    let values: Vec<Json> =
        serde_json::from_str(&text).map_err(|e| Failure::binding(e.to_string()))?;
    values
        .into_iter()
        .map(|value| {
            Ok(match value {
                Json::Null => Value::Null,
                Json::String(value) => Value::Text(value),
                Json::Number(value) => match value.as_i64() {
                    Some(value) => Value::Integer(value),
                    None => Value::Real(
                        value
                            .as_f64()
                            .ok_or_else(|| Failure::binding("invalid numeric parameter"))?,
                    ),
                },
                Json::Array(values) => Value::Blob(
                    values
                        .into_iter()
                        .map(|value| {
                            value
                                .as_u64()
                                .filter(|value| *value <= 255)
                                .map(|value| value as u8)
                                .ok_or_else(|| Failure::binding("invalid blob byte"))
                        })
                        .collect::<Result<Vec<_>>>()?,
                ),
                _ => return Err(Failure::binding("unsupported parameter")),
            })
        })
        .collect()
}

async fn query(connection: &Connection, sql: &str, parameters: Vec<Value>) -> Result<Json> {
    let mut statement = connection.prepare(sql).await?;
    let names = statement.column_names();
    let mut rows = statement
        .query(turso::params::Params::Positional(parameters))
        .await?;
    let mut output = Vec::new();
    while let Some(row) = rows.next().await? {
        let mut object = serde_json::Map::new();
        for (index, name) in names.iter().enumerate() {
            let value = match row.get_value(index)? {
                Value::Null => Json::Null,
                Value::Integer(value) => json!(value),
                Value::Real(value) => {
                    // serde_json maps infinities to null. Reject before that
                    // lossy boundary so callers never mistake an error for SQL NULL.
                    if !value.is_finite() {
                        return Err(Failure::binding("query returned nonfinite REAL"));
                    }
                    json!(value)
                }
                Value::Text(value) => json!(value),
                Value::Blob(value) => json!(value),
            };
            object.insert(name.clone(), value);
        }
        output.push(Json::Object(object));
    }
    Ok(json!(output))
}

fn connection(handle: u32) -> Result<(SharedConnection, ConnectionLimit)> {
    handles()?
        .connections
        .get(&handle)
        .map(|(_, value, limit)| (value.clone(), limit.clone()))
        .ok_or_else(|| Failure::binding("invalid connection"))
}

#[no_mangle]
pub extern "C" fn ffi_set_limit(
    handle: u32,
    block: u64,
    bytes: u64,
    undo: u64,
    creates: u32,
) -> *mut c_char {
    reply(|| {
        if block == 0 || undo > bytes {
            return Err(Failure::binding("invalid native grant"));
        }
        let mut handles = handles()?;
        let (_, _, limit) = handles
            .connections
            .get_mut(&handle)
            .ok_or_else(|| Failure::binding("invalid connection"))?;
        *limit = Some(Arc::new(checkpoint::Grant::new(
            block, bytes, undo, creates,
        )));
        Ok(Json::Null)
    })
}

fn run_limited<T: Send + 'static>(
    limit: ConnectionLimit,
    cleanup: bool,
    work: impl std::future::Future<Output = Result<T>> + Send + 'static,
) -> Result<T> {
    let result = run(checkpoint::LIMIT.scope(limit.clone().map(|grant| (grant, cleanup)), work));
    result.map_err(|mut error| {
        if !cleanup {
            error.required_write_bytes = limit.and_then(|grant| grant.required_write_bytes());
        }
        error
    })
}

fn canonical_file(path: &str) -> Result<PathBuf> {
    let path = Path::new(path);
    if path.exists() {
        return path
            .canonicalize()
            .map_err(|e| Failure::binding(e.to_string()));
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .ok_or_else(|| Failure::binding("invalid file path"))?;
    Ok(parent
        .canonicalize()
        .map_err(|e| Failure::binding(e.to_string()))?
        .join(name))
}

#[no_mangle]
pub unsafe extern "C" fn ffi_open(path: *const c_char) -> *mut c_char {
    reply(|| {
        open_file(canonical_file(&text(path)?)?, None, |name, observer| {
            initialize_database(name, observer, false)
        })
        .map(|id| json!(id))
    })
}

/// Query enforcement on this filesystem, not the limit assigned to an identity.
/// Unsupported kernels/filesystems and denied probes report no detected quota.
#[no_mangle]
pub unsafe extern "C" fn ffi_quota_enforced(path: *const c_char) -> *mut c_char {
    reply(|| Ok(json!(quota_enforced(Path::new(&text(path)?)))))
}

fn quota_enforced(_path: &Path) -> bool {
    #[cfg(target_os = "linux")]
    {
        // O_PATH selects the actual filesystem without opening file contents
        // or needing access to its block device (e.g. inside a container).
        let Ok(file) = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_PATH | libc::O_NOFOLLOW)
            .open(_path)
        else {
            return false;
        };
        // Linux uapi dqblk_xfs.h: fs_quota_statv v1 is a fixed 160 bytes;
        // qs_flags is a native-endian u16 at offset 2. Querying any supported
        // quota type returns flags for all three types.
        const Q_XGETQSTATV: libc::c_uint = (b'X' as libc::c_uint) << 8 | 8;
        const ENFORCED: u16 = (1 << 1) | (1 << 3) | (1 << 5);
        for kind in 0..3 {
            let mut status = [0u8; 160];
            status[0] = 1;
            let rc = unsafe {
                libc::syscall(
                    libc::SYS_quotactl_fd,
                    file.as_raw_fd(),
                    (Q_XGETQSTATV << 8) | kind,
                    0 as libc::c_uint,
                    status.as_mut_ptr(),
                )
            };
            if rc == 0 {
                return u16::from_ne_bytes([status[2], status[3]]) & ENFORCED != 0;
            }
        }
    }
    false
}

#[no_mangle]
pub unsafe extern "C" fn ffi_open_bounded(
    path: *const c_char,
    block: u64,
    bytes: u64,
    creates: u32,
    scratch_root: *const c_char,
) -> *mut c_char {
    reply(|| {
        if block == 0 {
            return Err(Failure::binding("invalid native grant"));
        }
        let scratch = if scratch_root.is_null() {
            None
        } else {
            Some(
                std::fs::canonicalize(text(scratch_root)?)
                    .map_err(|e| Failure::binding(e.to_string()))?,
            )
        };
        open_file(canonical_file(&text(path)?)?, scratch, |name, observer| {
            let grant = Arc::new(checkpoint::Grant::new(block, bytes, 0, creates));
            observer.limit_open(Some(grant.clone()));
            let result = initialize_database(name, observer.clone(), true);
            observer.limit_open(None);
            result.map_err(|mut error| {
                error.required_write_bytes = grant.required_write_bytes();
                error
            })
        })
        .map(|id| json!(id))
    })
}

fn initialize_database(
    name: String,
    observer: Arc<checkpoint::Observer>,
    managed: bool,
) -> Result<Database> {
    run(async move {
        let io = turso_core::io::PlatformIO::new().map_err(|e| Failure::binding(e.to_string()))?;
        let database = turso::Builder::new_local(&name)
            .with_io_impl(Arc::new(checkpoint::ObservedIo(io, observer)))
            .build()
            .await?;
        let connection = database.connect()?;
        query(&connection, "PRAGMA journal_mode=mvcc", vec![]).await?;
        query(&connection, "PRAGMA synchronous=FULL", vec![]).await?;
        if managed {
            // A group leader can write a peer's frame under its task-local
            // grant, then report the peer's refusal after writing its own.
            // Keep one log pwrite + sync per managed commit, and leave all
            // checkpoint writes to the explicit maintenance path.
            query(&connection, "PRAGMA mvcc_group_commit=off", vec![]).await?;
            query(&connection, "PRAGMA mvcc_checkpoint_threshold=-1", vec![]).await?;
        }
        Ok(database)
    })
}

fn open_file(
    path: PathBuf,
    scratch: Option<PathBuf>,
    initialize: impl FnOnce(String, Arc<checkpoint::Observer>) -> Result<Database>,
) -> Result<u32> {
    let reservation = loop {
        let mut handles = handles()?;
        if let Some(handle) = handles.paths.get(&path).copied() {
            let file = handles
                .files
                .get_mut(&handle)
                .ok_or_else(|| Failure::binding("missing file handle"))?;
            file.references += 1;
            return Ok(handle);
        }
        if let Some(opening) = handles.opening.get(&path).cloned() {
            drop(handles);
            let done = opening
                .done
                .lock()
                .map_err(|_| Failure::binding("opening reservation poisoned"))?;
            drop(
                opening
                    .finished
                    .wait_while(done, |done| !*done)
                    .map_err(|_| Failure::binding("opening reservation poisoned"))?,
            );
            continue;
        }
        let opening = Arc::new(Opening::default());
        handles.opening.insert(path.clone(), opening.clone());
        break OpenReservation {
            path: path.clone(),
            opening,
        };
    };
    let name = path
        .to_str()
        .ok_or_else(|| Failure::binding("non-UTF8 path"))?
        .to_owned();
    let checkpoint = Arc::new(checkpoint::Observer::new(&name, scratch));
    let database = Arc::new(initialize(name, checkpoint.clone())?);
    let handle = {
        let mut handles = handles()?;
        let handle = handles.id()?;
        handles.paths.insert(path.clone(), handle);
        handles.files.insert(
            handle,
            File {
                database,
                checkpoint,
                references: 1,
                connecting: 0,
                path,
            },
        );
        handle
    };
    drop(reservation);
    Ok(handle)
}

#[cfg(test)]
mod registry_tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn slow_open_does_not_block_unrelated_registry_work() {
        let (entered, ready) = mpsc::channel();
        let (release, held) = mpsc::channel();
        let slow = std::thread::spawn(move || {
            open_file(PathBuf::from("slow-registry-test"), |_, _| {
                entered.send(()).unwrap();
                held.recv().unwrap();
                Err(Failure::binding("injected initialization failure"))
            })
        });
        ready.recv_timeout(Duration::from_secs(5)).unwrap();
        let (completed, result) = mpsc::channel();
        let fast = std::thread::spawn(move || {
            let outcome = open_file(PathBuf::from("other-registry-test"), |_, _| {
                Err(Failure::binding("independent initialization"))
            });
            completed.send(outcome.is_err()).unwrap();
        });
        let independent = result.recv_timeout(Duration::from_secs(1));
        release.send(()).unwrap();
        assert!(slow.join().unwrap().is_err());
        fast.join().unwrap();
        assert_eq!(
            independent.ok(),
            Some(true),
            "registry held during initialization"
        );
    }

    #[test]
    fn same_path_has_one_initializer_and_failure_releases_waiters() {
        let (entered, ready) = mpsc::channel();
        let (release, held) = mpsc::channel();
        let first = std::thread::spawn(move || {
            open_file(PathBuf::from("same-registry-test"), |_, _| {
                entered.send(()).unwrap();
                held.recv().unwrap();
                Err(Failure::binding("first initialization fails"))
            })
        });
        ready.recv_timeout(Duration::from_secs(5)).unwrap();
        let (entered_second, second_ready) = mpsc::channel();
        let second = std::thread::spawn(move || {
            open_file(PathBuf::from("same-registry-test"), |_, _| {
                entered_second.send(()).unwrap();
                Err(Failure::binding("retry initialization fails"))
            })
        });
        let premature = second_ready.recv_timeout(Duration::from_millis(100));
        release.send(()).unwrap();
        assert!(first.join().unwrap().is_err());
        assert!(second.join().unwrap().is_err());
        assert!(premature.is_err(), "same path initialized concurrently");
        second_ready.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(!handles()
            .unwrap()
            .opening
            .contains_key(&PathBuf::from("same-registry-test")));
    }

    #[test]
    fn connecting_releases_registry_but_reserves_file_lifetime() {
        let dir = std::path::PathBuf::from(std::env::var("TMPDIR").unwrap())
            .join(format!("registry-connect-{}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let handle = open_file(dir.join("data.db"), initialize_database).unwrap();
        let (entered, ready) = mpsc::channel();
        let (release, held) = mpsc::channel();
        let connecting = std::thread::spawn(move || {
            connect_file(handle, None, |connection| {
                entered.send(()).unwrap();
                held.recv().unwrap();
                Ok(connection)
            })
        });
        ready.recv_timeout(Duration::from_secs(5)).unwrap();
        let (completed, result) = mpsc::channel();
        let closing = std::thread::spawn(move || {
            let pointer = ffi_close(handle, 0, false);
            let result = unsafe { text(pointer) }.unwrap();
            unsafe { ffi_free(pointer) };
            completed
                .send(serde_json::from_str::<Json>(&result).unwrap())
                .unwrap();
        });
        let close_result = result.recv_timeout(Duration::from_secs(1));
        release.send(()).unwrap();
        let connection = connecting.join().unwrap().unwrap();
        closing.join().unwrap();
        unsafe { ffi_free(ffi_close(connection, 1, false)) };
        unsafe { ffi_free(ffi_close(handle, 0, false)) };
        std::fs::remove_dir_all(dir).unwrap();
        assert_eq!(close_result.unwrap()["code"], 21);
    }
}

#[no_mangle]
pub extern "C" fn ffi_connect(handle: u32) -> *mut c_char {
    connect(handle, None)
}

#[no_mangle]
pub extern "C" fn ffi_connect_bounded(handle: u32) -> *mut c_char {
    connect(handle, Some(Arc::new(checkpoint::Grant::new(1, 0, 0, 0))))
}

fn connect(handle: u32, limit: ConnectionLimit) -> *mut c_char {
    reply(|| {
        let startup_limit = limit.clone();
        connect_file(handle, limit, |connection| {
            run_limited(startup_limit, false, async move {
                query(&connection, "PRAGMA synchronous=FULL", vec![]).await?;
                Ok(connection)
            })
        })
        .map(|id| json!(id))
    })
}

fn connect_file(
    handle: u32,
    limit: ConnectionLimit,
    initialize: impl FnOnce(Connection) -> Result<Connection>,
) -> Result<u32> {
    let (database, connecting) = {
        let mut handles = handles()?;
        let file = handles
            .files
            .get_mut(&handle)
            .ok_or_else(|| Failure::binding("invalid database"))?;
        file.connecting += 1;
        (file.database.clone(), Connecting(handle))
    };
    let connection = checkpoint::LIMIT
        .sync_scope(limit.clone().map(|grant| (grant, false)), || {
            initialize(database.connect()?)
        })?;
    let id = {
        let mut handles = handles()?;
        let id = handles.id()?;
        handles.connections.insert(
            id,
            (handle, Arc::new(tokio::sync::Mutex::new(connection)), limit),
        );
        id
    };
    drop(connecting);
    Ok(id)
}

#[no_mangle]
pub unsafe extern "C" fn ffi_exec(handle: u32, sql: *const c_char) -> *mut c_char {
    reply(|| {
        let (connection, limit) = connection(handle)?;
        let sql = text(sql)?;
        run_limited(limit, false, async move {
            connection.lock().await.execute_batch(sql).await?;
            Ok(Json::Null)
        })
    })
}

// The pin does not decode SQL-escaped path literals. Keep every SQL path
// controlled, even when the real store/staging ancestors contain quote marks.
#[no_mangle]
pub unsafe extern "C" fn ffi_vacuum_into(handle: u32, staging: *const c_char) -> *mut c_char {
    reply(|| {
        let staging = PathBuf::from(text(staging)?);
        if !std::fs::symlink_metadata(&staging)
            .map_err(|error| Failure::binding(error.to_string()))?
            .is_dir()
        {
            return Err(Failure::binding("backup staging must be a real directory"));
        }
        let directory =
            std::fs::File::open(&staging).map_err(|error| Failure::binding(error.to_string()))?;
        let sql = format!(
            "VACUUM INTO '/proc/self/fd/{}/data.db'",
            directory.as_raw_fd()
        );
        let (connection, limit) = connection(handle)?;
        run_limited(limit, false, async move {
            let connection = connection.lock().await;
            if !connection.is_autocommit()? {
                return Err(Failure::binding("backup snapshot requires autocommit"));
            }
            connection.execute_batch(sql).await?;
            drop(directory);
            Ok(Json::Null)
        })
    })
}

// Atomic no-replace publication; false means the caller must stage a copy on
// the destination filesystem. Never emulate no-replace with stat + rename.
#[no_mangle]
pub unsafe extern "C" fn ffi_rename_noreplace(
    source: *const c_char,
    destination: *const c_char,
) -> *mut c_char {
    unsafe extern "C" {
        fn renameat2(
            olddirfd: i32,
            oldpath: *const c_char,
            newdirfd: i32,
            newpath: *const c_char,
            flags: u32,
        ) -> i32;
    }
    reply(|| {
        let source =
            CString::new(text(source)?).map_err(|error| Failure::binding(error.to_string()))?;
        let destination = CString::new(text(destination)?)
            .map_err(|error| Failure::binding(error.to_string()))?;
        if renameat2(-100, source.as_ptr(), -100, destination.as_ptr(), 1) == 0 {
            return Ok(json!(true));
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(18) {
            return Ok(json!(false));
        }
        Err(Failure::binding(format!(
            "no-replace publication failed: {error}"
        )))
    })
}

#[no_mangle]
pub unsafe extern "C" fn ffi_lock_store(path: *const c_char) -> *mut c_char {
    unsafe extern "C" {
        fn flock(fd: i32, operation: i32) -> i32;
    }
    reply(|| {
        let path = text(path)?;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(0o400000)
            .open(path)
            .map_err(|error| Failure::binding(format!("store ownership lock: {error}")))?;
        if !file
            .metadata()
            .map_err(|error| Failure::binding(error.to_string()))?
            .is_file()
        {
            return Err(Failure::binding(
                "store ownership lock must be a regular file",
            ));
        }
        if flock(file.as_raw_fd(), 2 | 4) != 0 {
            return Err(Failure::binding(format!(
                "store is already owned: {}",
                std::io::Error::last_os_error()
            )));
        }
        let mut handles = handles()?;
        let id = handles.id()?;
        handles.locks.insert(id, file);
        Ok(json!(id))
    })
}

#[no_mangle]
pub unsafe extern "C" fn ffi_execute(
    handle: u32,
    sql: *const c_char,
    params: *const c_char,
) -> *mut c_char {
    reply(|| {
        let (connection, limit) = connection(handle)?;
        let sql = text(sql)?;
        let params = parameters(text(params)?)?;
        run_limited(limit, false, async move {
            let count = connection
                .lock()
                .await
                .execute(sql, turso::params::Params::Positional(params))
                .await?;
            Ok(json!(count))
        })
    })
}

#[no_mangle]
pub unsafe extern "C" fn ffi_query(
    handle: u32,
    sql: *const c_char,
    params: *const c_char,
) -> *mut c_char {
    reply(|| {
        let (connection, limit) = connection(handle)?;
        let sql = text(sql)?;
        let params = parameters(text(params)?)?;
        run_limited(limit, false, async move {
            query(&*connection.lock().await, &sql, params).await
        })
    })
}

fn control(handle: u32, sql: &'static str) -> Result<Json> {
    let (connection, limit) = connection(handle)?;
    run_limited(limit, false, async move {
        query(&*connection.lock().await, sql, vec![]).await
    })
}

#[no_mangle]
pub extern "C" fn ffi_begin(handle: u32, mode: u32) -> *mut c_char {
    reply(|| {
        control(
            handle,
            match mode {
                0 => "BEGIN",
                1 => "BEGIN IMMEDIATE",
                2 => "BEGIN CONCURRENT",
                _ => return Err(Failure::binding("invalid begin mode")),
            },
        )
    })
}

#[no_mangle]
pub extern "C" fn ffi_commit(handle: u32) -> *mut c_char {
    reply(|| control(handle, "COMMIT"))
}

#[no_mangle]
pub extern "C" fn ffi_rollback(handle: u32, owned_checkpoint: bool) -> *mut c_char {
    reply(|| {
        let (connection, limit) = connection(handle)?;
        run_limited(
            if owned_checkpoint { None } else { limit },
            true,
            async move {
                let connection = connection.lock().await;
                if !connection.is_autocommit()? {
                    query(&connection, "ROLLBACK", vec![]).await?;
                }
                Ok(Json::Null)
            },
        )
    })
}

#[no_mangle]
pub extern "C" fn ffi_checkpoint(handle: u32, mode: u32) -> *mut c_char {
    reply(|| {
        control(
            handle,
            match mode {
                0 => "PRAGMA wal_checkpoint(PASSIVE)",
                1 => "PRAGMA wal_checkpoint(FULL)",
                2 => "PRAGMA wal_checkpoint(RESTART)",
                3 => "PRAGMA wal_checkpoint(TRUNCATE)",
                _ => return Err(Failure::binding("invalid checkpoint mode")),
            },
        )
    })
}

#[no_mangle]
pub extern "C" fn ffi_owned_checkpoint(handle: u32) -> *mut c_char {
    reply(|| {
        let (connection, observer) = {
            let handles = handles()?;
            let (file, connection, _) = handles
                .connections
                .get(&handle)
                .ok_or_else(|| Failure::binding("invalid connection"))?;
            let observer = handles
                .files
                .get(file)
                .ok_or_else(|| Failure::binding("invalid database"))?
                .checkpoint
                .clone();
            (connection.clone(), observer)
        };
        run(async move {
            let connection = connection.lock().await;
            let _measurement = observer.begin();
            let result = query(&connection, "PRAGMA wal_checkpoint(TRUNCATE)", vec![]).await;
            let peak = observer.sample();
            // Report the peak even if the pager failed. JS owns rollback and
            // decides whether this connection is safe to return to the pool.
            Ok(match result {
                Ok(rows) => json!({"peakBytes": peak, "rows": rows}),
                Err(error) => json!({"peakBytes": peak, "error": {
                    "code": error.code, "message": error.message, "lastError": error.last_error,
                }}),
            })
        })
    })
}

#[no_mangle]
pub extern "C" fn ffi_close(handle: u32, kind: u32, owned_checkpoint: bool) -> *mut c_char {
    reply(|| {
        let mut handles = handles()?;
        match kind {
            2 => {
                handles
                    .locks
                    .remove(&handle)
                    .ok_or_else(|| Failure::binding("invalid store lock"))?;
            }
            1 => {
                let (_, connection, limit) = handles
                    .connections
                    .remove(&handle)
                    .ok_or_else(|| Failure::binding("invalid connection"))?;
                drop(handles);
                return run_limited(
                    if owned_checkpoint { None } else { limit },
                    true,
                    async move {
                        drop(connection);
                        Ok(Json::Null)
                    },
                );
            }
            0 | 3 => {
                let file = handles
                    .files
                    .get(&handle)
                    .ok_or_else(|| Failure::binding("invalid database"))?;
                if file.references == 1
                    && (file.connecting > 0
                        || handles.connections.values().any(|(id, _, _)| *id == handle))
                {
                    return Err(Failure::binding("database has live connections"));
                }
                if file.references == 1 {
                    let path = file.path.clone();
                    // Final drop is cleanup, not an implicit checkpoint or a
                    // second opportunity to grow files after a grant ended.
                    let limit =
                        (kind == 3).then(|| (Arc::new(checkpoint::Grant::new(1, 0, 0, 0)), true));
                    checkpoint::LIMIT.sync_scope(limit, || drop(handles.files.remove(&handle)));
                    handles.paths.remove(&path);
                } else if let Some(file) = handles.files.get_mut(&handle) {
                    file.references -= 1;
                }
            }
            _ => return Err(Failure::binding("invalid handle kind")),
        }
        Ok(Json::Null)
    })
}

#[no_mangle]
pub unsafe extern "C" fn ffi_free(pointer: *mut c_char) {
    let _ = std::panic::catch_unwind(|| {
        if !pointer.is_null() {
            drop(CString::from_raw(pointer));
        }
    });
}

// The library states what it is. These are compile-time env! reads: a build
// without tools/native-build.sh's variables fails to compile, so a plain
// cargo build cannot produce a loadable library.
fn build_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect()
}

#[no_mangle]
pub unsafe extern "C" fn ffi_build_info() -> *mut c_char {
    reply(|| {
        Ok(json!({
            "turso_version": env!("COMMUNICO_TURSO_VERSION"),
            "turso_rev": env!("COMMUNICO_TURSO_REV"),
            "patches": build_list(env!("COMMUNICO_TURSO_PATCHES")),
            "default_features": env!("COMMUNICO_TURSO_DEFAULT_FEATURES") == "true",
            "features": build_list(env!("COMMUNICO_TURSO_FEATURES")),
        }))
    })
}
