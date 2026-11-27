//! Observe allocations before the pager truncates its files. JS polling
//! alone cannot see spills that are written and released in one native call.
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use turso_core::io::{
    clock::{MonotonicInstant, WallClockInstant},
    Clock, File, FileSyncType, PlatformIO,
};
use turso_core::{Buffer, Completion, OpenFlags, Result, IO};

pub struct Observer {
    paths: [PathBuf; 3],
    scratch: Option<PathBuf>,
    peak: Mutex<Option<u64>>,
    open_limit: Mutex<Option<Arc<Grant>>>,
    opens: Mutex<()>,
}

pub struct Grant {
    block: u64,
    bytes: u64,
    undo: u64,
    usage: Mutex<Usage>,
}

struct Usage {
    remaining: u64,
    required_write_bytes: Option<u64>,
    creates: u32,
    refused_create: bool,
}

tokio::task_local! {
    pub static LIMIT: Option<(Arc<Grant>, bool)>;
}

impl Grant {
    pub fn new(block: u64, bytes: u64, undo: u64, creates: u32) -> Self {
        Self {
            block,
            bytes,
            undo,
            usage: Mutex::new(Usage {
                remaining: bytes,
                required_write_bytes: None,
                creates,
                refused_create: false,
            }),
        }
    }

    fn create(&self) -> Result<()> {
        let mut usage = self.usage.lock().unwrap();
        if let Some(left) = usage.creates.checked_sub(1) {
            usage.creates = left;
            Ok(())
        } else {
            usage.refused_create = true;
            Err(turso_core::LimboError::DatabaseFull)
        }
    }

    fn charge(&self, pos: u64, len: u64, cleanup: bool) -> Result<()> {
        if len == 0 {
            return Ok(());
        }
        let mut usage = self.usage.lock().unwrap();
        let cost = (pos % self.block)
            .checked_add(len)
            .and_then(|span| span.div_ceil(self.block).checked_mul(self.block));
        let floor = if cleanup { 0 } else { self.undo };
        if let Some(left) = cost
            .and_then(|n| usage.remaining.checked_sub(n))
            .filter(|left| *left >= floor)
        {
            usage.remaining = left;
            return Ok(());
        }
        if !cleanup {
            // Measure the failed charge before submitting it to the OS. Only
            // report the work footprint: the owner separately books undo.
            let spent = self.bytes - usage.remaining;
            let required = cost.and_then(|n| spent.checked_add(n));
            usage.required_write_bytes = usage.required_write_bytes.max(required);
        }
        Err(turso_core::LimboError::DatabaseFull)
    }

    pub fn required_write_bytes(&self) -> Option<u64> {
        self.usage.lock().unwrap().required_write_bytes
    }

    pub fn refused_allocation(&self) -> bool {
        let usage = self.usage.lock().unwrap();
        usage.refused_create || usage.required_write_bytes.is_some()
    }
}

impl Observer {
    pub fn new(path: &str, scratch: Option<PathBuf>) -> Self {
        Self {
            paths: [
                path.into(),
                format!("{path}-log").into(),
                format!("{path}-wal").into(),
            ],
            scratch,
            peak: Mutex::new(None),
            open_limit: Mutex::new(None),
            opens: Mutex::new(()),
        }
    }

    // A7: scratch is measured by the capacity owner, but does not spend the
    // database grant. Match directory components of the actual destination.
    fn is_scratch(&self, path: &str) -> bool {
        let Some(root) = &self.scratch else {
            return false;
        };
        let path = Path::new(path);
        let actual = fs::canonicalize(path).or_else(|error| {
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(error);
            }
            let Some((parent, name)) = path.parent().zip(path.file_name()) else {
                return Err(error);
            };
            // If the last component is a dangling symlink we cannot attest
            // that a create would land within the configured scratch root.
            if fs::symlink_metadata(path).is_ok() {
                return Err(error);
            }
            fs::canonicalize(parent).map(|dir| dir.join(name))
        });
        actual.is_ok_and(|actual| actual.starts_with(root))
    }

    fn bytes(path: &Path) -> u64 {
        fs::metadata(path).map_or(0, |metadata| metadata.blocks() * 512)
    }

    fn total(&self) -> u64 {
        self.paths.iter().map(|path| Self::bytes(path)).sum()
    }

    pub fn begin(&self) -> Measurement<'_> {
        let mut peak = self.peak.lock().unwrap();
        assert!(peak.is_none(), "checkpoint is already observed");
        *peak = Some(self.total());
        Measurement(self)
    }

    pub fn sample(&self) -> Option<u64> {
        let mut peak = self.peak.lock().unwrap();
        if let Some(peak) = peak.as_mut() {
            *peak = (*peak).max(self.total());
        }
        *peak
    }

    pub fn limit_open(&self, grant: Option<Arc<Grant>>) {
        *self.open_limit.lock().unwrap() = grant;
    }

    fn check_create(&self, path: &str) -> Result<()> {
        if !fs::metadata(path).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound) {
            return Ok(());
        }
        LIMIT
            .try_with(|limit| limit.as_ref().map_or(Ok(()), |(grant, _)| grant.create()))
            .unwrap_or(Ok(()))?;
        self.open_limit
            .lock()
            .unwrap()
            .as_ref()
            .map_or(Ok(()), |grant| grant.create())
    }

    fn check_write(&self, pos: u64, len: u64) -> Result<()> {
        LIMIT
            .try_with(|limit| -> Result<()> {
                if let Some((grant, cleanup)) = limit {
                    grant.charge(pos, len, *cleanup)?;
                }
                Ok(())
            })
            .unwrap_or(Ok(()))?;
        if let Some(grant) = self.open_limit.lock().unwrap().as_ref() {
            grant.charge(pos, len, false)?;
        }
        Ok(())
    }
}

pub struct Measurement<'a>(&'a Observer);

impl Drop for Measurement<'_> {
    fn drop(&mut self) {
        *self.0.peak.lock().unwrap() = None;
    }
}

// Delegate to the same synchronous platform backend and keep vector writes
// intact. Only paths of this database may contribute to its checkpoint peak.
pub struct ObservedIo(pub PlatformIO, pub Arc<Observer>);

impl Clock for ObservedIo {
    fn current_time_monotonic(&self) -> MonotonicInstant {
        self.0.current_time_monotonic()
    }

    fn current_time_wall_clock(&self) -> WallClockInstant {
        self.0.current_time_wall_clock()
    }
}

impl IO for ObservedIo {
    fn open_file(&self, path: &str, flags: OpenFlags, direct: bool) -> Result<Arc<dyn File>> {
        let _open = self.1.opens.lock().unwrap();
        if self.1.is_scratch(path) {
            return self.0.open_file(path, flags, direct);
        }
        self.1.check_create(path)?;
        let file = self.0.open_file(path, flags, direct)?;
        Ok(Arc::new(ObservedFile(file, self.1.clone())))
    }

    fn remove_file(&self, path: &str) -> Result<()> {
        let _open = self.1.opens.lock().unwrap();
        if self.1.paths.iter().any(|owned| owned == Path::new(path)) {
            self.1.sample();
        }
        self.0.remove_file(path)
    }

    fn open_shared_wal_file(&self, path: &str) -> Result<Arc<dyn File>> {
        let _open = self.1.opens.lock().unwrap();
        if self.1.is_scratch(path) {
            return self.0.open_shared_wal_file(path);
        }
        self.1.check_create(path)?;
        let file = self.0.open_shared_wal_file(path)?;
        Ok(Arc::new(ObservedFile(file, self.1.clone())))
    }

    fn supports_shared_wal_coordination(&self) -> bool {
        self.0.supports_shared_wal_coordination()
    }
}

struct ObservedFile(Arc<dyn File>, Arc<Observer>);

impl File for ObservedFile {
    fn lock_file(&self, exclusive: bool) -> Result<()> {
        self.0.lock_file(exclusive)
    }

    fn unlock_file(&self) -> Result<()> {
        self.0.unlock_file()
    }

    fn pread(&self, pos: u64, completion: Completion) -> Result<Completion> {
        self.0.pread(pos, completion)
    }

    fn pwrite(&self, pos: u64, buffer: Arc<Buffer>, completion: Completion) -> Result<Completion> {
        self.1.check_write(pos, buffer.len() as u64)?;
        self.0.pwrite(pos, buffer, completion)
    }

    fn pwritev(
        &self,
        pos: u64,
        buffers: Vec<Arc<Buffer>>,
        completion: Completion,
    ) -> Result<Completion> {
        self.1
            .check_write(pos, buffers.iter().map(|b| b.len() as u64).sum())?;
        self.0.pwritev(pos, buffers, completion)
    }

    fn sync(&self, completion: Completion, sync_type: FileSyncType) -> Result<Completion> {
        self.0.sync(completion, sync_type)
    }

    fn size(&self) -> Result<u64> {
        self.0.size()
    }

    fn truncate(&self, len: u64, completion: Completion) -> Result<Completion> {
        if LIMIT.try_with(Option::is_some).unwrap_or(false)
            || self.1.open_limit.lock().unwrap().is_some()
        {
            let old_size = self.0.size()?;
            self.1.check_write(old_size, len.saturating_sub(old_size))?;
        }
        self.1.sample();
        self.0.truncate(len, completion)
    }
}
