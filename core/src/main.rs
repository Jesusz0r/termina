//! The Termina snapshot core.
//!
//! Performs every app-owned Git store operation off the Electron main
//! thread: captures, incremental captures, state application, template
//! creation, and trust hashes. The store is a bare Git repository that
//! reads source objects through a read-only alternate. It never writes
//! the user's Git directory.
//!
//! Protocol: JSON-lines over stdin/stdout. The main process writes one
//! request per line and reads one response per line. Every request carries
//! `op` and `requestId`; every response carries `op: "<op>-result"`,
//! `requestId`, and `ok`. A failed op returns `error` with the reason.

use std::ffi::{CStr, CString};
use std::fs;
use std::io::{self, BufRead, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::time::{SystemTime, UNIX_EPOCH};

use git2::{
    ObjectFormat, Oid, Repository, RepositoryOpenFlags,
};
use serde_json::{Value, json};
use sha1::Sha1;
use sha2::{Digest, Sha256};

mod store;
mod store_tx;
mod promote_fs;
mod capture;
use capture::{
    AnchoredPath, CaptureRoot, FlatEntry, GitTreeBudget, TreeLookupKind, exact_ref_target,
    git_blob_bytes_bounded, git_blob_size_bounded, git_tree_entry_path, git_tree_object_bounded,
    materialize_state_bound, nested_from_flat, op_apply_state, op_capture, op_capture_incremental,
    op_template, open_store, pause_at_hook,
    publish_transaction_ref, read_link_at, resolve_tree, state_entries, sync_exact_transaction_ref,
    tree_lookup, validate_transaction_ref, write_nested_tree_for_ref,
};
mod copy;
mod promotion_files;
use promotion_files::{
    op_promotion_bound_copy_file, op_promotion_bound_copy_tree, op_promotion_bound_create_directory,
    op_promotion_bound_create_symlink, op_promotion_bound_ensure_directory,
    op_promotion_bound_install_directory, op_promotion_bound_list_directories,
    op_promotion_bound_list_entries, op_promotion_bound_open_directory,
    op_promotion_bound_prepare_directory, op_promotion_bound_read_file,
    op_promotion_bound_read_journal, op_promotion_bound_write_file, promotion_rename_unsupported,
};
use crate::promote_fs::{
    promotion_directory_is_empty, promotion_rename_noreplace, promotion_unlink_at_field,
};
mod promotion_remove;
use promotion_remove::{hook_matches, op_promotion_bound_remove_tree, op_promotion_bound_transition};
mod retained;
mod store_ops;
use store_ops::{op_store_create, op_store_destroy};
mod preflight;
use preflight::op_preflight;
mod trees;
use trees::{op_diff_tree, op_materialize, op_merge3, op_read_blob, op_symlink_target, op_tree_paths, op_unref};
mod trust;
use store::{
    FileIdentity, StoreNodeIdentity,
    bind_store_result, current_store_lifecycle, ensure_real_directory,
    fresh_store_generation, lifecycle_json, lifecycle_mismatch,
    store_lifecycle_at_root, store_node_at, store_node_at_optional,
    store_node_file, store_node_matches, sync_directory_nofollow,
    validate_store_lifecycle, write_store_generation,
};
use store_tx::{
    StoreMutationLock, StoreObjectTransaction, ensure_blob_budget,
    recover_store_transaction, write_blob, write_transaction_object,
    write_transaction_object_with_oid,
};
use trust::op_trust_hashes;

mod repo;
use repo::{op_git_common_dir, op_git_head, op_git_object_format, op_git_top_level, op_ls_ignored, op_ls_tracked, op_repo_diff, op_repo_file, op_repo_status, op_repo_tree};

/// The default capture budgets (WORLDLINES section 9).
pub(crate) const BUDGET_MAX_PATHS: usize = 100_000;
pub(crate) const BUDGET_MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
/// A raw blob delivered in a base64 JSON response must stay below the
/// CoreClient's bounded stdout line buffer. This is intentionally separate
/// from the 64 MiB capture-file budget.
pub(crate) const READ_BLOB_MAX_BYTES: u64 = 47 * 1024 * 1024;
pub(crate) const BUDGET_MAX_NEW_BLOB_BYTES: u64 = 256 * 1024 * 1024;
/// Maximum journal bytes returned by the descriptor-bound promotion read.
/// Promotion policy remains in Electron; core only authenticates the file
/// descriptor and returns bounded raw bytes.
pub(crate) const PROMOTION_JOURNAL_MAX_BYTES: u64 = 16 * 1024 * 1024;
pub(crate) const PROMOTION_PATH_MAX_BYTES: usize = 4_096;
pub(crate) const PROMOTION_COMPONENT_MAX_BYTES: usize = 255;
pub(crate) const PROMOTION_COMPONENT_ARRAY_MAX_ENTRIES: usize = 256;
pub(crate) const PROMOTION_COMPONENT_ARRAY_MAX_NAME_BYTES: usize = 128 * 1024;
/// Descriptor-bound tree copies are used to populate comparison templates and
/// candidates.  Keep the native copy envelope finite even when a caller
/// supplies a runtime directory rather than a captured state.
pub(crate) const PROMOTION_COPY_TREE_MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const PROMOTION_COPY_TREE_MAX_ENTRIES: usize = 1_000_000;
const PROMOTION_COPY_TREE_MAX_WORK_BYTES: u64 = 128 * 1024 * 1024;
/// Every native promotion directory collector has an explicit envelope. The
/// collector checks both limits before pushing another name, so a hostile
/// directory cannot force an unbounded allocation even on paths that sort or
/// revisit entries.
pub(crate) const PROMOTION_DIRECTORY_MAX_ENTRIES: usize = PROMOTION_COPY_TREE_MAX_ENTRIES;
pub(crate) const PROMOTION_DIRECTORY_MAX_NAME_BYTES: u64 = 128 * 1024 * 1024;
pub(crate) const PROMOTION_DIRECTORY_MAX_DEPTH: usize = 64;
/// Startup recovery only needs the bounded journal-root envelope. Keep this
/// stricter than the general copy collector so an oversized adjacent root is
/// rejected before any response array is materialized.
pub(crate) const PROMOTION_RECOVERY_ROOT_MAX_ENTRIES: usize = 128;
/// The retained-session root binder is deliberately stricter than the
/// general promotion directory helper. It validates the complete retained
/// shape while the parent and leaf descriptors are still held.
/// Darwin and Linux have no inode-conditional unlinkat.  Cleanup therefore
/// retains each quarantined object in a fresh descriptor-bound container.  A
/// durable cap keeps a sequence of failed/uncertain cleanups from becoming an
/// unbounded disk sink; the caller must resolve or export evidence before the
/// cap is reached.
const PROMOTION_QUARANTINE_MAX_CONTAINERS: usize = 128;
pub(crate) const PROMOTION_QUARANTINE_MAX_ENTRIES: usize = 250_000;
pub(crate) const PROMOTION_QUARANTINE_MAX_BYTES: u64 = 8 * 1024 * 1024 * 1024;
pub(crate) const PROMOTION_QUARANTINE_PREFIX: &str = ".termina-promotion-quarantine-";
/// Unref prunes loose objects only past this many files. Small stores skip
/// Cached tree maps kept across requests. Captures chain parent to child,
/// so the parent map of the next request is usually the one just built.
pub(crate) const TREE_MAP_CACHE_SIZE: usize = 8;
/// Loose-object compression level. The format matches Git at every level;
/// the fast level cuts capture CPU on the hot path.
pub(crate) const BLOB_COMPRESSION: flate2::Compression = flate2::Compression::fast();
/// A burst of unrefs shares one prune: the walk does not rerun inside this
/// Durable per-session identity for the app-owned snapshot store.  The
/// sibling mutation lock survives store deletion, so the marker must live in
/// the store itself and change on every store-create.
/// Publish large captures in bounded groups while keeping common captures to
/// one blob/tree group plus the final commit. Directory durability work is
/// per group, never per object.
pub(crate) static PROMOTION_CLEANUP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
pub(crate) static STORE_DESTROY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn s(v: &Value, key: &str) -> Result<String, String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(String::from)
        .ok_or_else(|| format!("missing field {key}"))
}

pub(crate) fn opt_s(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(String::from)
}

/// The before-read test seams of a capture request.
pub(crate) fn before_read_hooks(req: &Value) -> Vec<(String, String, bool)> {
    req.pointer("/hooks/beforeRead")
        .and_then(Value::as_array)
        .map(|hooks| {
            hooks
                .iter()
                .filter_map(|hook| {
                    let path = hook.get("path").and_then(Value::as_str)?;
                    let content = hook.get("content").and_then(Value::as_str)?;
                    let restore_mtime = hook
                        .get("restoreMtime")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    Some((path.to_string(), content.to_string(), restore_mtime))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The after-cache test seams of a full capture request.
pub(crate) fn after_cache_hooks(req: &Value) -> Vec<(String, String, bool)> {
    req.pointer("/hooks/afterCache")
        .and_then(Value::as_array)
        .map(|hooks| {
            hooks
                .iter()
                .filter_map(|hook| {
                    let path = hook.get("path").and_then(Value::as_str)?;
                    let content = hook.get("content").and_then(Value::as_str)?;
                    let restore_mtime = hook
                        .get("restoreMtime")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    Some((path.to_string(), content.to_string(), restore_mtime))
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn oid_ext(repo: &Repository, value: &str) -> Result<Oid, String> {
    Oid::from_str_ext(value, repo.object_format()).map_err(|e| format!("invalid oid {value}: {e}"))
}

pub(crate) fn object_format(value: &str) -> Result<ObjectFormat, String> {
    match value {
        "sha1" => Ok(ObjectFormat::Sha1),
        "sha256" => Ok(ObjectFormat::Sha256),
        other => Err(format!("unsupported object format: {other}")),
    }
}

/// The hash of an object for the store's object format.
pub(crate) fn object_oid(repo: &Repository, kind: &str, content: &[u8]) -> Oid {
    let header = format!("{} {}\0", kind, content.len()).into_bytes();
    let digest = match repo.object_format() {
        ObjectFormat::Sha1 => {
            let mut hasher = Sha1::new();
            hasher.update(&header);
            hasher.update(content);
            hasher.finalize().to_vec()
        }
        ObjectFormat::Sha256 => {
            let mut hasher = Sha256::new();
            hasher.update(&header);
            hasher.update(content);
            hasher.finalize().to_vec()
        }
    };
    Oid::from_bytes(&digest).expect("digest length matches the object format")
}

/// The loose-object path of a blob in the store, or None when the oid
/// length does not match the store format.
pub(crate) fn loose_path(repo: &Repository, oid: Oid) -> Option<PathBuf> {
    let hex = oid.to_string();
    if hex.len() < 3 {
        return None;
    }
    Some(repo.path().join("objects").join(&hex[0..2]).join(&hex[2..]))
}


/// Serialize the complete store lifecycle across core processes. The lock is
/// a stable sibling of the deletable store, so destroy/recreate cannot replace
/// its inode while an older request still holds it.


/// True when a path has no absolute or parent segments.
pub(crate) fn is_safe_relative(path: &str) -> bool {
    !path.is_empty()
        && path != "."
        && !path.starts_with('/')
        && !path.split(['/', '\\']).any(|seg| seg == "..")
}

/// Open a repository from an arbitrary folder. Searches upward, like the
/// git CLI does.
pub(crate) fn open_repo(root: &Path) -> Result<Repository, String> {
    let root = normalize_system_alias_path(root, "repository root")?;
    Repository::open_ext(&root, RepositoryOpenFlags::empty(), None::<&str>)
        .map_err(|e| format!("open source repository failed: {e}"))
}

/// True when a path contains a `.git` segment (a nested repository).
pub(crate) fn has_git_segment(path: &str) -> bool {
    path.split('/').any(|seg| seg == ".git")
}

/// Stable identity and capture-relevant metadata read from a descriptor or
/// descriptor-relative path. ctime closes the restored-mtime rewrite gap;
/// mode includes both the file type and executable bits used by state trees.

pub(crate) fn stat_at(parent: RawFd, name: &CStr) -> io::Result<FileIdentity> {
    let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
    let rc = unsafe {
        libc::fstatat(
            parent,
            name.as_ptr(),
            st.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if rc == -1 {
        Err(io::Error::last_os_error())
    } else {
        let st = unsafe { st.assume_init() };
        Ok(FileIdentity::from_stat(&st))
    }
}

/// `fstatat(2)` metadata plus the current owner.  The retained-root bootstrap
/// must establish ownership from the same descriptor-relative lookup used for
/// the type/identity check; a separate pathname `metadata` call would reopen
/// the mutable leaf between those decisions.
fn stat_at_owned(parent: RawFd, name: &CStr) -> io::Result<(FileIdentity, u64)> {
    let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
    let rc = unsafe {
        libc::fstatat(
            parent,
            name.as_ptr(),
            st.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if rc == -1 {
        Err(io::Error::last_os_error())
    } else {
        let st = unsafe { st.assume_init() };
        Ok((FileIdentity::from_stat(&st), st.st_uid as u64))
    }
}

pub(crate) fn stat_file(file: &fs::File) -> io::Result<FileIdentity> {
    let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
    let rc = unsafe { libc::fstat(file.as_raw_fd(), st.as_mut_ptr()) };
    if rc == -1 {
        Err(io::Error::last_os_error())
    } else {
        let st = unsafe { st.assume_init() };
        Ok(FileIdentity::from_stat(&st))
    }
}

/// Descriptor metadata plus owner for a root/child opened with `O_NOFOLLOW`.
fn stat_file_owned(file: &fs::File) -> io::Result<(FileIdentity, u64)> {
    let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
    let rc = unsafe { libc::fstat(file.as_raw_fd(), st.as_mut_ptr()) };
    if rc == -1 {
        Err(io::Error::last_os_error())
    } else {
        let st = unsafe { st.assume_init() };
        Ok((FileIdentity::from_stat(&st), st.st_uid as u64))
    }
}



/// `fstatat(2)` metadata for a private publication pathname. Keep the link
/// count and owner alongside the ordinary identity so a hardlink or pathname
/// replacement cannot pass a dev/ino-only check during metadata publication.


pub(crate) fn open_at(parent: RawFd, name: &CStr, flags: libc::c_int) -> io::Result<fs::File> {
    let fd = unsafe { libc::openat(parent, name.as_ptr(), flags) };
    if fd == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { fs::File::from_raw_fd(fd) })
    }
}

pub(crate) fn open_at_mode(
    parent: RawFd,
    name: &CStr,
    flags: libc::c_int,
    mode: libc::mode_t,
) -> io::Result<fs::File> {
    let fd = unsafe { libc::openat(parent, name.as_ptr(), flags, mode as libc::c_uint) };
    if fd == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { fs::File::from_raw_fd(fd) })
    }
}

pub(crate) fn missing_path(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ENOTDIR))
}

/// Open an absolute directory one component at a time without following a
/// symlink in the directory chain.  The returned descriptor is the capability
/// used by the capture boundary; callers must retain it for the whole
/// operation instead of resolving the pathname again.
pub(crate) fn open_absolute_directory_nofollow(path: &Path, field: &str) -> Result<fs::File, String> {
    let path = normalize_system_alias_path(path, field)?;
    open_absolute_directory_nofollow_raw(&path, field)
}

/// Normalize the one macOS system spelling that cannot be opened with
/// `O_NOFOLLOW`: `/var` is a fixed symlink to `/private/var`.  The native
/// boundary must not turn this into general symlink traversal, so only that
/// exact root link target is accepted; all other symlink components continue
/// through the descriptor walk and fail closed.
pub(crate) fn normalize_system_alias_path(path: &Path, field: &str) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!("{field} must be an absolute path"));
    }

    #[cfg(target_os = "macos")]
    {
        let mut components = path.components();
        if !matches!(components.next(), Some(Component::RootDir)) {
            return Err(format!("{field} must be an absolute path"));
        }
        let Some(Component::Normal(first)) = components.next() else {
            return Ok(path.to_path_buf());
        };
        if first.to_str() != Some("var") {
            return Ok(path.to_path_buf());
        }

        // `symlink_metadata` intentionally inspects `/var` itself.  Do not
        // canonicalize an arbitrary caller path: that would silently admit a
        // user-controlled symlink chain into the trusted descriptor boundary.
        let alias = Path::new("/var");
        let metadata = fs::symlink_metadata(alias)
            .map_err(|error| format!("inspect macOS /var alias failed: {error}"))?;
        if !metadata.file_type().is_symlink() {
            return Ok(path.to_path_buf());
        }
        let target = fs::read_link(alias)
            .map_err(|error| format!("read macOS /var alias failed: {error}"))?;
        if target != Path::new("private/var") && target != Path::new("/private/var") {
            return Err(format!(
                "{field} contains an unsupported /var symlink target"
            ));
        }

        let mut normalized = PathBuf::from("/private/var");
        for component in components {
            normalized.push(component.as_os_str());
        }
        Ok(normalized)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = field;
        Ok(path.to_path_buf())
    }
}

fn open_absolute_directory_nofollow_raw(path: &Path, field: &str) -> Result<fs::File, String> {
    if !path.is_absolute() {
        return Err(format!("{field} must be an absolute path"));
    }
    let mut current = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open("/")
        .map_err(|error| format!("open {field} root failed: {error}"))?;
    for component in path.components() {
        let Component::Normal(name) = component else {
            if matches!(component, Component::RootDir) {
                continue;
            }
            return Err(format!("{field} must not contain . or .. components"));
        };
        let name = CString::new(name.to_string_lossy().as_bytes())
            .map_err(|_| format!("{field} contains an invalid path component"))?;
        current = open_at(
            current.as_raw_fd(),
            &name,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
        .map_err(|error| format!("open {field} component failed: {error}"))?;
    }
    let identity = stat_file(&current).map_err(|error| format!("fstat {field} failed: {error}"))?;
    if !identity.is_dir() {
        return Err(format!("{field} is not a directory"));
    }
    Ok(current)
}

/// Directory metadata changes when children are added or removed.  A
/// descriptor-bound directory identity therefore uses only the object identity
/// and type, while regular-file identities retain the complete stat tuple.
pub(crate) fn same_directory_identity(left: FileIdentity, right: FileIdentity) -> bool {
    left.dev == right.dev && left.ino == right.ino && left.is_dir() && right.is_dir()
}

pub(crate) fn open_relative_directory(
    root: &fs::File,
    relative: &Path,
    field: &str,
) -> Result<fs::File, String> {
    let mut current = root
        .try_clone()
        .map_err(|error| format!("clone {field} descriptor failed: {error}"))?;
    for component in relative.components() {
        let Component::Normal(name) = component else {
            if matches!(component, Component::CurDir) {
                continue;
            }
            return Err(format!("{field} contains an unsafe relative component"));
        };
        let name = CString::new(name.to_string_lossy().as_bytes())
            .map_err(|_| format!("{field} contains an invalid path component"))?;
        current = open_at(
            current.as_raw_fd(),
            &name,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
        .map_err(|error| format!("open {field} component failed: {error}"))?;
    }
    let identity = stat_file(&current).map_err(|error| format!("fstat {field} failed: {error}"))?;
    if !identity.is_dir() {
        return Err(format!("{field} is not a directory"));
    }
    Ok(current)
}


// ------------------------------------------------ promotion native boundary --

/// The native promotion boundary deliberately returns no parsed journal
/// fields. Electron owns promotion policy; core only binds descriptors,
/// verifies expected identities/states, and performs preservation-first
/// namespace transitions.


/// Run a Git operation with the process working directory set from an
/// already-open directory descriptor.  libgit2 only accepts paths, but a
/// descriptor-relative cwd keeps `Repository::init/open` and its subsequent
/// index/object writes on the bound directory even if an ancestor is swapped
/// while the request is in flight.  Core handles requests serially, so this
/// short-lived cwd change cannot be observed by another core operation.



/// Apply the spike-only rewrite after the read descriptor is open. Opening
/// through the retained parent descriptor keeps the seam inside the same
/// capture boundary as production reads.
pub(crate) fn apply_rewrite_hooks(
    path: &AnchoredPath,
    before_read: &[(String, String, bool)],
    original_mtime: Option<SystemTime>,
) {
    for (hook_path, content, restore_mtime) in before_read {
        if !hook_matches(&path.rel_path, hook_path) {
            continue;
        }
        let Ok(mut target) = open_at(
            path.parent.as_raw_fd(),
            &path.leaf,
            libc::O_WRONLY | libc::O_TRUNC | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        ) else {
            continue;
        };
        target.write_all(content.as_bytes()).ok();
        if *restore_mtime && let Some(modified) = original_mtime {
            target
                .set_times(fs::FileTimes::new().set_modified(modified))
                .ok();
        }
    }
}

/// Hash one descriptor-anchored working-tree path into the store. Returns
/// None for a directory (a gitlink). Returns (mode, oid, new bytes).
pub(crate) fn hash_path(
    transaction: &mut StoreObjectTransaction,
    repo: &Repository,
    capture_root: &CaptureRoot,
    path: AnchoredPath,
    max_file_bytes: u64,
    current_new_blob_bytes: u64,
    max_new_blob_bytes: u64,
    before_read: &[(String, String, bool)],
) -> Result<Option<(u32, Oid, u64)>, String> {
    let display = capture_root.display_path(&path.rel_path);
    if path.identity.is_symlink() {
        let bytes = read_link_at(path.parent.as_raw_fd(), &path.leaf)
            .map_err(|e| format!("readlink failed for {}: {e}", display.display()))?;
        let after = stat_at(path.parent.as_raw_fd(), &path.leaf)
            .map_err(|_| format!("symlink vanished while captured: {}", display.display()))?;
        if path.identity != after {
            return Err(format!(
                "symlink changed while captured: {}",
                display.display()
            ));
        }
        std::str::from_utf8(&bytes)
            .map_err(|_| format!("symlink target is not valid UTF-8: {}", display.display()))?;
        let link_bytes =
            u64::try_from(bytes.len()).map_err(|_| "symlink length does not fit u64")?;
        if link_bytes > max_file_bytes {
            return Err(format!(
                "symlink exceeds the {max_file_bytes} byte budget: {}",
                display.display()
            ));
        }
        let (oid, new_bytes) = write_blob(
            transaction,
            repo,
            &bytes,
            current_new_blob_bytes,
            max_new_blob_bytes,
            None,
        )?;
        return Ok(Some((0o120000, oid, new_bytes)));
    }
    if path.identity.is_dir() {
        return Ok(None);
    }
    if !path.identity.is_file() {
        return Err("unsupported file type".to_string());
    }
    if path.identity.len > max_file_bytes {
        return Err(format!(
            "file exceeds the {max_file_bytes} byte budget: {}",
            display.display()
        ));
    }
    let mut file = open_at(
        path.parent.as_raw_fd(),
        &path.leaf,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
    )
    .map_err(|e| format!("open failed for {}: {e}", display.display()))?;
    let before = stat_file(&file).map_err(|e| format!("fstat failed: {e}"))?;
    if path.identity != before || !before.is_file() {
        return Err(format!(
            "file replaced while captured: {}",
            display.display()
        ));
    }
    let original_mtime = file
        .metadata()
        .and_then(|metadata| metadata.modified())
        .ok();
    apply_rewrite_hooks(&path, before_read, original_mtime);
    let mut bytes = Vec::new();
    let read_limit = max_file_bytes.checked_add(1).unwrap_or(u64::MAX);
    Read::by_ref(&mut file)
        .take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read failed: {e}"))?;
    let after = stat_file(&file).map_err(|e| format!("fstat failed: {e}"))?;
    if before != after {
        return Err(format!(
            "file changed while captured: {}",
            display.display()
        ));
    }
    let path_after = stat_at(path.parent.as_raw_fd(), &path.leaf)
        .map_err(|_| format!("file vanished while captured: {}", display.display()))?;
    if path_after != after {
        return Err(format!(
            "file replaced while captured: {}",
            display.display()
        ));
    }
    // The stat above approved the size. A file can grow between the stat
    // and the read: verify the budget again after the bytes are in memory.
    if bytes.len() as u64 > max_file_bytes {
        return Err(format!(
            "file grew past the {max_file_bytes} byte budget while captured: {}",
            display.display()
        ));
    }
    let mode = if before.mode & 0o111 != 0 {
        0o100755
    } else {
        0o100644
    };
    let (oid, new_bytes) = write_blob(
        transaction,
        repo,
        &bytes,
        current_new_blob_bytes,
        max_new_blob_bytes,
        None,
    )?;
    Ok(Some((mode, oid, new_bytes)))
}


// ---------------------------------------------------------- trust hash ----


// ---------------------------------------------------------- store create ----


// ------------------------------------------------------------ preflight ----


// --------------------------------------------------------------- merge3 ----


// ---------------------------------------------------------- source queries ----


// ------------------------------------------------------------ dispatch -----

fn store_lifecycle_operation(op: &str) -> bool {
    matches!(
        op,
        "capture"
            | "capture-incremental"
            | "apply-state"
            | "template"
            | "merge3"
            | "diff-tree"
            | "materialize"
            | "tree-paths"
            | "symlink-target"
            | "read-blob"
            | "unref"
    )
}

fn dispatch(op: &str, req: &Value) -> Result<Value, String> {
    let result = match op {
        "capture" => op_capture(req),
        "capture-incremental" => op_capture_incremental(req),
        "apply-state" => op_apply_state(req),
        "template" => op_template(req),
        "trust-hashes" => op_trust_hashes(req),
        "store-create" => op_store_create(req),
        "store-destroy" => op_store_destroy(req),
        "preflight" => op_preflight(req),
        "merge3" => op_merge3(req),
        "diff-tree" => op_diff_tree(req),
        "materialize" => op_materialize(req),
        "tree-paths" => op_tree_paths(req),
        "symlink-target" => op_symlink_target(req),
        "read-blob" => op_read_blob(req),
        "promotion-bound-read-journal" => op_promotion_bound_read_journal(req),
        "promotion-bound-read-file" => op_promotion_bound_read_file(req),
        "promotion-bound-open-directory" => op_promotion_bound_open_directory(req),
        "promotion-bound-list-directories" => op_promotion_bound_list_directories(req),
        "promotion-bound-list-entries" => op_promotion_bound_list_entries(req),
        "promotion-bound-prepare-directory" => op_promotion_bound_prepare_directory(req),
        "promotion-bound-ensure-directory" => op_promotion_bound_ensure_directory(req),
        "promotion-bound-transition" => op_promotion_bound_transition(req),
        "promotion-bound-create-directory" => op_promotion_bound_create_directory(req),
        "promotion-bound-write-file" => op_promotion_bound_write_file(req),
        "promotion-bound-copy-file" => op_promotion_bound_copy_file(req),
        "promotion-bound-copy-tree" => op_promotion_bound_copy_tree(req),
        "promotion-bound-create-symlink" => op_promotion_bound_create_symlink(req),
        "promotion-bound-install-directory" => op_promotion_bound_install_directory(req),
        "promotion-bound-remove-tree" => op_promotion_bound_remove_tree(req),
        "unref" => op_unref(req),
        "git-head" => op_git_head(req),
        "git-top-level" => op_git_top_level(req),
        "git-common-dir" => op_git_common_dir(req),
        "git-object-format" => op_git_object_format(req),
        "ls-tracked" => op_ls_tracked(req),
        "repo-status" => op_repo_status(req),
        "repo-diff" => op_repo_diff(req),
        "repo-tree" => op_repo_tree(req),
        "repo-file" => op_repo_file(req),
        "ls-ignored" => op_ls_ignored(req),
        other => Err(format!("unknown op: {other}")),
    }?;
    if store_lifecycle_operation(op) {
        bind_store_result(req, result)
    } else {
        Ok(result)
    }
}

fn main() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => {
                // Answer every input line. The client times out and respawns.
                let response = json!({
                    "op": "error",
                    "requestId": Value::Null,
                    "ok": false,
                    "error": "invalid request json"
                });
                let mut stdout = stdout.lock();
                if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
                    break;
                }
                continue;
            }
        };
        let op = request
            .get("op")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let request_id = request
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let response = match dispatch(&op, &request) {
            Ok(payload) => {
                let mut response =
                    json!({ "op": format!("{op}-result"), "requestId": request_id, "ok": true });
                if let Some(obj) = payload.as_object() {
                    for (key, value) in obj {
                        // Payload keys must not overwrite the envelope.
                        if key == "op" || key == "requestId" || key == "ok" || key == "error" {
                            continue;
                        }
                        response[key] = value.clone();
                    }
                }
                response
            }
            Err(error) => {
                let stderr = io::stderr();
                let mut stderr = stderr.lock();
                let _ = writeln!(stderr, "[core] {op} failed: {error}");
                json!({ "op": format!("{op}-result"), "requestId": request_id, "ok": false, "error": error })
            }
        };
        let mut stdout = stdout.lock();
        if writeln!(stdout, "{response}").is_err() {
            break;
        }
        if stdout.flush().is_err() {
            break;
        }
    }
}
