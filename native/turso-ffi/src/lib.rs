//! Owned JSON replies across a small C ABI. Every pointer returned by a call
//! belongs to the caller until ffi_free. Engine work runs on Tokio workers.
use serde_json::{json, Value as Json};
use std::collections::HashMap;
use std::ffi::{c_char, CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use turso::{Connection, Database, Value};

#[derive(Debug)]
struct Failure {
    code: i32,
    message: String,
    last_error: String,
}

type Result<T> = std::result::Result<T, Failure>;

impl Failure {
    fn binding(message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            code: 21,
            last_error: message.clone(),
            message,
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
        }
    }
}

struct File {
    database: Database,
    references: usize,
    path: PathBuf,
}

type SharedConnection = Arc<tokio::sync::Mutex<Connection>>;

#[derive(Default)]
struct Handles {
    next: u32,
    files: HashMap<u32, File>,
    paths: HashMap<PathBuf, u32>,
    connections: HashMap<u32, (u32, SharedConnection)>,
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
                                 "last_error": error.last_error}),
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
                Value::Real(value) => json!(value),
                Value::Text(value) => json!(value),
                Value::Blob(value) => json!(value),
            };
            object.insert(name.clone(), value);
        }
        output.push(Json::Object(object));
    }
    Ok(json!(output))
}

fn connection(handle: u32) -> Result<SharedConnection> {
    handles()?
        .connections
        .get(&handle)
        .map(|(_, value)| value.clone())
        .ok_or_else(|| Failure::binding("invalid connection"))
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
        let path = canonical_file(&text(path)?)?;
        let mut handles = handles()?;
        if let Some(handle) = handles.paths.get(&path).copied() {
            let file = handles
                .files
                .get_mut(&handle)
                .ok_or_else(|| Failure::binding("missing file handle"))?;
            file.references += 1;
            return Ok(json!(handle));
        }
        let name = path
            .to_str()
            .ok_or_else(|| Failure::binding("non-UTF8 path"))?
            .to_owned();
        let database = run(async move {
            let database = turso::Builder::new_local(&name).build().await?;
            let connection = database.connect()?;
            query(&connection, "PRAGMA journal_mode=mvcc", vec![]).await?;
            query(&connection, "PRAGMA synchronous=FULL", vec![]).await?;
            Ok(database)
        })?;
        let handle = handles.id()?;
        handles.paths.insert(path.clone(), handle);
        handles.files.insert(
            handle,
            File {
                database,
                references: 1,
                path,
            },
        );
        Ok(json!(handle))
    })
}

#[no_mangle]
pub extern "C" fn ffi_connect(handle: u32) -> *mut c_char {
    reply(|| {
        let mut handles = handles()?;
        let connection = handles
            .files
            .get(&handle)
            .ok_or_else(|| Failure::binding("invalid database"))?
            .database
            .connect()?;
        let connection = run(async move {
            query(&connection, "PRAGMA synchronous=FULL", vec![]).await?;
            Ok(connection)
        })?;
        let id = handles.id()?;
        handles
            .connections
            .insert(id, (handle, Arc::new(tokio::sync::Mutex::new(connection))));
        Ok(json!(id))
    })
}

#[no_mangle]
pub unsafe extern "C" fn ffi_exec(handle: u32, sql: *const c_char) -> *mut c_char {
    reply(|| {
        let connection = connection(handle)?;
        let sql = text(sql)?;
        run(async move {
            connection.lock().await.execute_batch(sql).await?;
            Ok(Json::Null)
        })
    })
}

#[no_mangle]
pub unsafe extern "C" fn ffi_execute(
    handle: u32,
    sql: *const c_char,
    params: *const c_char,
) -> *mut c_char {
    reply(|| {
        let connection = connection(handle)?;
        let sql = text(sql)?;
        let params = parameters(text(params)?)?;
        run(async move {
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
        let connection = connection(handle)?;
        let sql = text(sql)?;
        let params = parameters(text(params)?)?;
        run(async move { query(&*connection.lock().await, &sql, params).await })
    })
}

fn control(handle: u32, sql: &'static str) -> Result<Json> {
    let connection = connection(handle)?;
    run(async move { query(&*connection.lock().await, sql, vec![]).await })
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
pub extern "C" fn ffi_rollback(handle: u32) -> *mut c_char {
    reply(|| {
        let connection = connection(handle)?;
        run(async move {
            let connection = connection.lock().await;
            if !connection.is_autocommit()? {
                query(&connection, "ROLLBACK", vec![]).await?;
            }
            Ok(Json::Null)
        })
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
pub extern "C" fn ffi_close(handle: u32, kind: u32) -> *mut c_char {
    reply(|| {
        let mut handles = handles()?;
        match kind {
            1 => {
                handles
                    .connections
                    .remove(&handle)
                    .ok_or_else(|| Failure::binding("invalid connection"))?;
            }
            0 => {
                let file = handles
                    .files
                    .get(&handle)
                    .ok_or_else(|| Failure::binding("invalid database"))?;
                if file.references == 1 && handles.connections.values().any(|(id, _)| *id == handle)
                {
                    return Err(Failure::binding("database has live connections"));
                }
                if file.references == 1 {
                    let path = file.path.clone();
                    handles.files.remove(&handle);
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
