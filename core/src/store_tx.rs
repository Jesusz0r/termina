//! Snapshot-store transactions: mutation lock, staging journal, durable
//! object writes, blob budgets, and crash recovery.
use std::collections::HashSet;
use std::fs;
use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use git2::{Oid, Repository};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{BLOB_COMPRESSION, exact_ref_target, sync_exact_transaction_ref, validate_transaction_ref};
use crate::util::{loose_path, object_oid, oid_ext};

use super::store::{
    durable_write, ensure_real_directory, read_regular_file_nofollow, same_regular_file,
    sync_directory, sync_directory_nofollow,
};


pub(crate) const STORE_TRANSACTION_VERSION: u32 = 1;
pub(crate) const STORE_TRANSACTION_FILE: &str = "termina-object-transaction.json";
pub(crate) const STORE_TRANSACTION_DIR: &str = "termina-object-transaction";
pub(crate) const STORE_OBJECT_BATCH_SIZE: usize = 4_096;

pub(crate) fn store_lock_path(store_dir: &Path) -> Result<PathBuf, String> {
    let parent = store_dir
        .parent()
        .ok_or("snapshot store has no parent directory")?;
    let name = store_dir
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("snapshot store name is not valid UTF-8")?;
    Ok(parent.join(format!(".{name}.termina-store.lock")))
}

pub(crate) fn write_lock_attempt_marker(req: &Value) -> Result<(), String> {
    let Some(path) = req
        .pointer("/hooks/mutationLockAttemptPath")
        .and_then(Value::as_str)
    else {
        return Ok(());
    };
    fs::write(path, b"attempting")
        .map_err(|e| format!("write mutation-lock attempt marker failed: {e}"))
}

/// The directory identity and durable generation together identify one
/// incarnation of a snapshot store.  Either value alone is insufficient:
/// device/inode pairs can be reused after destroy, while a pathname can be
/// rebound to a different directory carrying an old request's metadata.
pub(crate) struct StoreMutationLock {
    pub(crate) _file: fs::File,
    pub(crate) contended: bool,
}

impl StoreMutationLock {
    pub(crate) fn acquire(store_dir: &Path, req: &Value) -> Result<Self, String> {
        let path = store_lock_path(store_dir)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("create store lock directory failed: {e}"))?;
        }
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&path)
            .map_err(|e| format!("open store mutation lock failed: {e}"))?;
        write_lock_attempt_marker(req)?;
        loop {
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                return Ok(Self {
                    _file: file,
                    contended: false,
                });
            }
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            if error.kind() != io::ErrorKind::WouldBlock {
                return Err(format!("lock snapshot store failed: {error}"));
            }
            loop {
                if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0 {
                    return Ok(Self {
                        _file: file,
                        contended: true,
                    });
                }
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(format!("lock snapshot store failed: {error}"));
                }
            }
        }
    }

    pub(crate) fn was_contended(&self) -> bool {
        self.contended
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct IntendedStoreRef {
    pub(crate) name: String,
    pub(crate) target: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct StoreStagingIdentity {
    pub(crate) dev: u64,
    pub(crate) ino: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct StoreTransactionJournal {
    pub(crate) version: u32,
    #[serde(default)]
    pub(crate) staging_directory: Option<StoreStagingIdentity>,
    #[serde(default)]
    pub(crate) intended_ref: Option<IntendedStoreRef>,
}

impl StoreTransactionJournal {
    fn empty() -> Self {
        Self {
            version: STORE_TRANSACTION_VERSION,
            staging_directory: None,
            intended_ref: None,
        }
    }
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoreTransactionMetrics {
    pub(crate) journal_writes: u64,
    pub(crate) journal_bytes_written: u64,
    pub(crate) staged_file_syncs: u64,
    pub(crate) staging_directory_syncs: u64,
    pub(crate) published_objects: u64,
    pub(crate) canonical_directory_syncs: u64,
    pub(crate) ref_file_syncs: u64,
    pub(crate) ref_directory_syncs: u64,
}

pub(crate) struct PendingStoreObject {
    pub(crate) stage: PathBuf,
    pub(crate) canonical: PathBuf,
}

pub(crate) fn clear_store_transaction(store_dir: &Path) -> Result<(), String> {
    let journal_path = transaction_file(store_dir);
    match fs::remove_file(&journal_path) {
        Ok(()) => sync_directory(store_dir)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("remove store transaction journal failed: {error}")),
    }
    let stage_dir = transaction_dir(store_dir);
    match fs::symlink_metadata(&stage_dir) {
        Ok(metadata) if metadata.file_type().is_dir() => {
            fs::remove_dir_all(&stage_dir)
                .map_err(|e| format!("remove store transaction directory failed: {e}"))?;
            sync_directory(store_dir)?;
        }
        Ok(_) => {
            fs::remove_file(&stage_dir)
                .map_err(|e| format!("remove invalid transaction staging path failed: {e}"))?;
            sync_directory(store_dir)?;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "inspect store transaction directory failed: {error}"
            ));
        }
    }
    Ok(())
}

pub(crate) fn staged_transaction_objects(
    store_dir: &Path,
    repo: &Repository,
) -> Result<Vec<(Oid, PathBuf)>, String> {
    let stage_dir = transaction_dir(store_dir);
    let metadata = match fs::symlink_metadata(&stage_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("inspect transaction staging failed: {error}")),
    };
    if !metadata.file_type().is_dir() {
        return Err("transaction staging path is not a real directory".to_string());
    }
    let mut staged = Vec::new();
    for entry in
        fs::read_dir(&stage_dir).map_err(|e| format!("read transaction staging failed: {e}"))?
    {
        let entry = entry.map_err(|e| format!("read transaction staging entry failed: {e}"))?;
        if !entry
            .file_type()
            .map_err(|e| format!("inspect transaction staging entry failed: {e}"))?
            .is_file()
        {
            return Err(format!(
                "transaction staging entry is not a regular file: {}",
                entry.path().display()
            ));
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "transaction staging object name is not UTF-8".to_string())?;
        let oid = oid_ext(repo, &name)
            .map_err(|_| format!("invalid oid in transaction staging: {name}"))?;
        if oid.to_string() != name {
            return Err(format!("non-canonical oid in transaction staging: {name}"));
        }
        staged.push((oid, entry.path()));
    }
    Ok(staged)
}

pub(crate) fn staging_directory_identity(store_dir: &Path) -> Result<StoreStagingIdentity, String> {
    let stage_dir = transaction_dir(store_dir);
    let metadata = fs::symlink_metadata(&stage_dir)
        .map_err(|e| format!("inspect transaction staging directory failed: {e}"))?;
    if !metadata.file_type().is_dir() {
        return Err("transaction staging path is not a real directory".to_string());
    }
    Ok(StoreStagingIdentity {
        dev: metadata.dev(),
        ino: metadata.ino(),
    })
}

pub(crate) fn cleanup_transaction_temps(store_dir: &Path, repo: &Repository) -> Result<(), String> {
    if let Ok(entries) = fs::read_dir(store_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if name.starts_with(&format!(".{STORE_TRANSACTION_FILE}.tmp-"))
                && entry.file_type().is_ok_and(|kind| kind.is_file())
            {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    let objects = repo.path().join("objects");
    let Ok(fanouts) = fs::read_dir(&objects) else {
        return Ok(());
    };
    for fanout in fanouts.flatten() {
        let path = fanout.path();
        let is_fanout = fanout.file_name().to_str().is_some_and(|name| {
            name.len() == 2 && name.bytes().all(|byte| byte.is_ascii_hexdigit())
        });
        if !is_fanout || !fanout.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let mut removed = false;
        if let Ok(entries) = fs::read_dir(&path) {
            for entry in entries.flatten() {
                let is_temp = entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with("tmp-"));
                if is_temp && entry.file_type().is_ok_and(|kind| kind.is_file()) {
                    removed |= fs::remove_file(entry.path()).is_ok();
                }
            }
        }
        if removed {
            sync_directory(&path)?;
        }
    }
    Ok(())
}

pub(crate) fn recover_store_transaction(store_dir: &Path, repo: &Repository) -> Result<(), String> {
    let journal_path = transaction_file(store_dir);
    let bytes = match fs::symlink_metadata(&journal_path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            read_regular_file_nofollow(&journal_path)?
        }
        Ok(_) => {
            return Err(format!(
                "store transaction journal is not a regular file: {}",
                journal_path.display()
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let stage_dir = transaction_dir(store_dir);
            match fs::symlink_metadata(&stage_dir) {
                Ok(metadata) if metadata.file_type().is_dir() => {
                    fs::remove_dir_all(&stage_dir)
                        .map_err(|e| format!("remove stale transaction staging failed: {e}"))?;
                    sync_directory(store_dir)?;
                }
                Ok(_) => {
                    fs::remove_file(&stage_dir)
                        .map_err(|e| format!("remove invalid stale staging path failed: {e}"))?;
                    sync_directory(store_dir)?;
                }
                Err(stage_error) if stage_error.kind() == io::ErrorKind::NotFound => {}
                Err(stage_error) => {
                    return Err(format!(
                        "inspect stale transaction staging failed: {stage_error}"
                    ));
                }
            }
            cleanup_transaction_temps(store_dir, repo)?;
            return Ok(());
        }
        Err(error) => return Err(format!("inspect store transaction journal failed: {error}")),
    };
    let journal: StoreTransactionJournal = serde_json::from_slice(&bytes)
        .map_err(|e| format!("parse store transaction journal failed: {e}"))?;
    if journal.version != STORE_TRANSACTION_VERSION {
        return Err(format!(
            "unsupported store transaction journal version {}",
            journal.version
        ));
    }
    if let Some(expected) = &journal.staging_directory
        && staging_directory_identity(store_dir)? != *expected
    {
        return Err("transaction staging directory changed after journal publication".to_string());
    }
    let intended_ref_visible = match journal.intended_ref.as_ref() {
        Some(intended) => {
            let target = validate_transaction_ref(repo, &intended.name, &intended.target)?;
            if exact_ref_target(repo, &intended.name) == Some(target) {
                sync_exact_transaction_ref(repo, &intended.name, target)?;
                true
            } else {
                false
            }
        }
        None => false,
    };
    if !intended_ref_visible {
        let mut changed_directories = HashSet::new();
        for (oid, stage) in staged_transaction_objects(store_dir, repo)?
            .into_iter()
            .rev()
        {
            let canonical =
                loose_path(repo, oid).ok_or("staged oid does not match the store format")?;
            if same_regular_file(&stage, &canonical) {
                match fs::remove_file(&canonical) {
                    Ok(()) => {
                        if let Some(parent) = canonical.parent() {
                            changed_directories.insert(parent.to_path_buf());
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(format!(
                            "remove recovered request object {} failed: {error}",
                            canonical.display()
                        ));
                    }
                }
            }
        }
        for directory in changed_directories {
            sync_directory_nofollow(&directory)?;
        }
    }
    clear_store_transaction(store_dir)?;
    cleanup_transaction_temps(store_dir, repo)
}

/// Objects created by one store request. The durable journal and hard-linked
/// staging files prove ownership after a crash; Drop performs the same recovery
/// while the stable store lock is still held for ordinary returned errors.
pub(crate) struct StoreObjectTransaction {
    pub(crate) store_dir: PathBuf,
    pub(crate) journal: StoreTransactionJournal,
    pub(crate) started: bool,
    pub(crate) pending: Vec<PendingStoreObject>,
    pub(crate) staged_oids: HashSet<Oid>,
    pub(crate) metrics: StoreTransactionMetrics,
    pub(crate) metrics_path: Option<PathBuf>,
    pub(crate) committed: bool,
}

impl StoreObjectTransaction {
    pub(crate) fn new(store_dir: &Path, req: &Value) -> Self {
        Self {
            store_dir: store_dir.to_path_buf(),
            journal: StoreTransactionJournal::empty(),
            started: false,
            pending: Vec::new(),
            staged_oids: HashSet::new(),
            metrics: StoreTransactionMetrics::default(),
            metrics_path: req
                .pointer("/hooks/transactionMetricsPath")
                .and_then(Value::as_str)
                .map(PathBuf::from),
            committed: false,
        }
    }

    fn persist(&mut self) -> Result<(), String> {
        let bytes = serde_json::to_vec(&self.journal)
            .map_err(|e| format!("encode store transaction journal failed: {e}"))?;
        durable_write(&transaction_file(&self.store_dir), &bytes)?;
        self.metrics.journal_writes += 1;
        self.metrics.journal_bytes_written += bytes.len() as u64;
        self.started = true;
        Ok(())
    }

    fn ensure_started(&mut self) -> Result<(), String> {
        if !self.started {
            self.persist()?;
        }
        Ok(())
    }

    pub(crate) fn set_intended_ref(&mut self, name: String, target: Oid) -> Result<(), String> {
        self.journal.intended_ref = Some(IntendedStoreRef {
            name,
            target: target.to_string(),
        });
        self.persist()
    }

    fn remember_staging_directory(&mut self) -> Result<(), String> {
        let identity = staging_directory_identity(&self.store_dir)?;
        match &self.journal.staging_directory {
            Some(existing) if *existing != identity => {
                Err("transaction staging directory changed while active".to_string())
            }
            Some(_) => Ok(()),
            None => {
                self.journal.staging_directory = Some(identity);
                if self.started {
                    self.persist()?;
                }
                Ok(())
            }
        }
    }

    fn contains(&self, oid: Oid) -> bool {
        self.staged_oids.contains(&oid)
    }

    /// Durably record and publish one bounded object group. Staged files stay
    /// linked until commit because their inode identity is the recovery ledger.
    pub(crate) fn flush(&mut self, repo: &Repository) -> Result<(), String> {
        if self.pending.is_empty() {
            return Ok(());
        }
        // durable_write also syncs store_dir. Because the staging directory
        // was created before this header, its store_dir entry is durable before
        // any canonical hard link can be published.
        self.ensure_started()?;
        let stage_dir = transaction_dir(&self.store_dir);
        sync_directory_nofollow(&stage_dir)?;
        self.metrics.staging_directory_syncs += 1;

        let objects_dir = repo.path().join("objects");
        ensure_real_directory(&objects_dir, 0o755)?;
        let mut changed_directories = HashSet::new();
        for pending in &self.pending {
            let parent = pending
                .canonical
                .parent()
                .ok_or("loose object path has no parent")?;
            ensure_real_directory(parent, 0o755)?;
            match fs::hard_link(&pending.stage, &pending.canonical) {
                Ok(()) => {
                    self.metrics.published_objects += 1;
                    changed_directories.insert(parent.to_path_buf());
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(format!("loose object publish failed: {error}")),
            }
        }
        for directory in changed_directories {
            sync_directory_nofollow(&directory)?;
            self.metrics.canonical_directory_syncs += 1;
        }
        sync_directory_nofollow(&objects_dir)?;
        self.metrics.canonical_directory_syncs += 1;
        self.pending.clear();
        Ok(())
    }

    pub(crate) fn record_ref_sync(&mut self, directory_count: u64) {
        self.metrics.ref_file_syncs += 1;
        self.metrics.ref_directory_syncs += directory_count;
    }

    fn emit_metrics(&self) -> Result<(), String> {
        let Some(path) = &self.metrics_path else {
            return Ok(());
        };
        let bytes = serde_json::to_vec(&self.metrics)
            .map_err(|e| format!("encode transaction metrics failed: {e}"))?;
        fs::write(path, bytes).map_err(|e| format!("write transaction metrics failed: {e}"))
    }

    pub(crate) fn commit(&mut self) -> Result<(), String> {
        if !self.pending.is_empty() {
            return Err("transaction has unpublished objects at commit".to_string());
        }
        clear_store_transaction(&self.store_dir)?;
        self.committed = true;
        self.emit_metrics()
    }
}

impl Drop for StoreObjectTransaction {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        let result = Repository::open_bare(self.store_dir.join("git"))
            .map_err(|e| format!("open store for rollback failed: {e}"))
            .and_then(|repo| recover_store_transaction(&self.store_dir, &repo));
        if let Err(error) = result {
            let stderr = io::stderr();
            let mut stderr = stderr.lock();
            let _ = writeln!(
                stderr,
                "[core] failed to roll back store transaction: {error}"
            );
        }
    }
}

/// Reject a new loose blob before writing when it would cross the aggregate
/// budget. Existing store-owned blobs cost zero even when an alternate also
/// contains them. Returns the checked aggregate after this blob.
pub(crate) fn ensure_blob_budget(
    transaction: &StoreObjectTransaction,
    repo: &Repository,
    oid: Oid,
    blob_bytes: u64,
    current_bytes: u64,
    max_new_blob_bytes: u64,
) -> Result<u64, String> {
    let loose = loose_path(repo, oid).ok_or("oid length does not match the object format")?;
    if loose.exists() || transaction.contains(oid) {
        return Ok(current_bytes);
    }
    let next = current_bytes
        .checked_add(blob_bytes)
        .ok_or("new-blob byte accounting overflow")?;
    if next > max_new_blob_bytes {
        return Err(format!(
            "capture exceeds the {max_new_blob_bytes} new-blob byte budget ({next} bytes)"
        ));
    }
    Ok(next)
}

/// Write a budget-approved blob into the canonical store when it is new.
/// The loose-path check ignores the source alternate, and the store never
/// packs its own objects, so the check completely describes local ownership.
pub(crate) fn write_blob(
    transaction: &mut StoreObjectTransaction,
    repo: &Repository,
    bytes: &[u8],
    current_bytes: u64,
    max_new_blob_bytes: u64,
    verified_oid: Option<Oid>,
) -> Result<(Oid, u64), String> {
    let oid = verified_oid.unwrap_or_else(|| object_oid(repo, "blob", bytes));
    let blob_bytes = u64::try_from(bytes.len()).map_err(|_| "blob length does not fit u64")?;
    ensure_blob_budget(
        transaction,
        repo,
        oid,
        blob_bytes,
        current_bytes,
        max_new_blob_bytes,
    )?;
    write_transaction_object_with_oid(transaction, repo, "blob", bytes, oid)
}

/// Publish one object through the request transaction. The ODB existence
/// check covers canonical loose/packed objects and alternates. Ownership is
/// based only on the no-overwrite canonical loose publish, so rollback cannot
/// remove a pre-existing or concurrently replaced object.
pub(crate) fn write_transaction_object(
    transaction: &mut StoreObjectTransaction,
    repo: &Repository,
    kind: &str,
    content: &[u8],
) -> Result<(Oid, u64), String> {
    let oid = object_oid(repo, kind, content);
    write_transaction_object_with_oid(transaction, repo, kind, content, oid)
}

/// Publish an object when the caller already computed and, where required,
/// verified its object id. Keeping the oid separate avoids hashing large blob
/// contents again before the transaction's existence check.
pub(crate) fn write_transaction_object_with_oid(
    transaction: &mut StoreObjectTransaction,
    repo: &Repository,
    kind: &str,
    content: &[u8],
    oid: Oid,
) -> Result<(Oid, u64), String> {
    let loose = loose_path(repo, oid).ok_or("oid length does not match the object format")?;
    if loose.exists() || transaction.contains(oid) {
        return Ok((oid, 0));
    }
    if transaction.pending.len() >= STORE_OBJECT_BATCH_SIZE {
        transaction.flush(repo)?;
    }
    let header = format!("{} {}\0", kind, content.len()).into_bytes();
    use std::io::Write as _;
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), BLOB_COMPRESSION);
    let compressed = encoder
        .write_all(&header)
        .and_then(|_| encoder.write_all(content))
        .and_then(|_| encoder.finish())
        .map_err(|e| format!("deflate failed: {e}"))?;
    let stage_dir = transaction_dir(&transaction.store_dir);
    ensure_real_directory(&stage_dir, 0o700)?;
    transaction.remember_staging_directory()?;
    let stage = staged_object_path(&transaction.store_dir, oid);
    let mut stage_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&stage)
        .map_err(|e| format!("create staged object failed: {e}"))?;
    stage_file
        .write_all(&compressed)
        .map_err(|e| format!("write staged object failed: {e}"))?;
    stage_file
        .sync_all()
        .map_err(|e| format!("sync staged object failed: {e}"))?;
    drop(stage_file);
    transaction.metrics.staged_file_syncs += 1;
    transaction.staged_oids.insert(oid);
    transaction.pending.push(PendingStoreObject {
        stage,
        canonical: loose,
    });
    let new_bytes = u64::try_from(content.len()).map_err(|_| "object length does not fit u64")?;
    Ok((oid, new_bytes))
}


pub(crate) fn transaction_file(store_dir: &Path) -> PathBuf {
    store_dir.join(STORE_TRANSACTION_FILE)
}

pub(crate) fn transaction_dir(store_dir: &Path) -> PathBuf {
    store_dir.join(STORE_TRANSACTION_DIR)
}

pub(crate) fn staged_object_path(store_dir: &Path, oid: Oid) -> PathBuf {
    transaction_dir(store_dir).join(oid.to_string())
}