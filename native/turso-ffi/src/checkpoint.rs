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
    peak: Mutex<Option<u64>>,
    open_limit: Mutex<Option<(u64, u64)>>,
}

impl Observer {
    pub fn new(path: &str) -> Self {
        Self {
            paths: [
                path.into(),
                format!("{path}-log").into(),
                format!("{path}-wal").into(),
            ],
            peak: Mutex::new(None),
            open_limit: Mutex::new(None),
        }
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

    pub fn limit_open(&self, block: u64, bytes: u64) {
        *self.open_limit.lock().unwrap() = (block != 0).then_some((block, bytes));
    }

    fn check_write(&self, pos: u64, len: u64) -> Result<()> {
        if let Some((block, remaining)) = self.open_limit.lock().unwrap().as_mut() {
            // Charge every block the call can touch, including an unaligned
            // tail, even when a filesystem can reuse an existing allocation.
            let cost = if len == 0 {
                Some(0)
            } else {
                (pos % *block)
                    .checked_add(len)
                    .and_then(|span| span.div_ceil(*block).checked_mul(*block))
            };
            *remaining = cost
                .and_then(|cost| remaining.checked_sub(cost))
                .ok_or(turso_core::LimboError::DatabaseFull)?;
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
        let file = self.0.open_file(path, flags, direct)?;
        Ok(Arc::new(ObservedFile(file, self.1.clone())))
    }

    fn remove_file(&self, path: &str) -> Result<()> {
        if self.1.paths.iter().any(|owned| owned == Path::new(path)) {
            self.1.sample();
        }
        self.0.remove_file(path)
    }

    fn open_shared_wal_file(&self, path: &str) -> Result<Arc<dyn File>> {
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
        if self.1.open_limit.lock().unwrap().is_some() {
            let old_size = self.0.size()?;
            self.1.check_write(old_size, len.saturating_sub(old_size))?;
        }
        self.1.sample();
        self.0.truncate(len, completion)
    }
}
