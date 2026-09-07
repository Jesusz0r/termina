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
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use git2::{
    ObjectFormat, Oid, Repository, RepositoryInitOptions, RepositoryOpenFlags,
};
use serde_json::{Value, json};
use sha1::Sha1;
use sha2::{Digest, Sha256};

mod store;
mod store_tx;
mod promote_fs;
use promote_fs::{
    PromotionCwd, PromotionDirectoryStream, PromotionExpectedLeaf, PromotionExpectedState,
    PromotionIdentity, PromotionObservedLeaf, PromotionObservedState, issue_promotion_root_capability,
    observe_promotion_leaf, open_or_create_promotion_parent, open_promotion_absolute_directory,
    open_promotion_bound_root, open_promotion_bound_root_values, open_promotion_parent,
    parse_promotion_expected,     promotion_add_work, promotion_bound_path_matches, promotion_child_relative, promotion_component,
    promotion_components, promotion_components_for, promotion_components_value,
    promotion_directory_identity_matches,
    promotion_directory_is_empty, promotion_expected_matches, promotion_expected_state_description,
    promotion_identity_chain_from_value, promotion_identity_from_value, promotion_mkdir_at,
    promotion_name, promotion_path_with_components, promotion_path_work_bytes, promotion_set_mode,
    promotion_sha256_hex, promotion_symlink_at, promotion_unlink_at_field, promotion_write_all,
    parse_promotion_expected_destination, promotion_directory_capability_result, promotion_mode,
    promotion_rename_noreplace, promotion_test_pause, stat_promotion_journal_file,
};
mod capture;
use capture::{
    AnchoredPath, CaptureRoot, FlatEntry, GitTreeBudget, TreeLookupKind, exact_ref_target,
    git_blob_bytes_bounded, git_blob_size_bounded, git_tree_entry_path, git_tree_object_bounded,
    materialize_state_bound, nested_from_flat, op_apply_state, op_capture, op_capture_incremental,
    op_template, open_store, pause_at_hook, promotion_remove_tree_contents,
    publish_transaction_ref, read_link_at, resolve_tree, state_entries, sync_exact_transaction_ref,
    tree_lookup, validate_transaction_ref, write_nested_tree_for_ref,
};
mod retained;
mod trees;
use retained::op_promotion_bound_root_transaction;
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
const PROMOTION_JOURNAL_MAX_BYTES: u64 = 16 * 1024 * 1024;
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
const PROMOTION_RECOVERY_ROOT_MAX_ENTRIES: usize = 128;
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
const PROMOTION_QUARANTINE_PREFIX: &str = ".termina-promotion-quarantine-";
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
static PROMOTION_CLEANUP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static STORE_DESTROY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

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

/// Bind an existing absolute directory without a TypeScript pathname
/// preflight.  The descriptor opened here is the source of the returned
/// identity; callers must carry that identity through every later mutation.
fn op_promotion_bound_open_directory(req: &Value) -> Result<Value, String> {
    let (directory, identity, capability) =
        open_promotion_bound_root(req, "path", "expectedIdentity", "capability")?;
    promotion_test_pause(req, "promotion-directory-prebind")?;
    promotion_directory_identity_matches(&directory, identity, "directory")?;
    Ok(json!({
        "result": promotion_directory_capability_result(identity, &capability)
    }))
}

/// Enumerate immediate child directories and bind each child's identity from
/// the same native root descriptor.  Recovery uses this instead of a
/// pathname `readdir` followed by a fresh pathname identity capture, which
/// would allow an operation-directory ABA between those two steps.
fn op_promotion_bound_list_directories(req: &Value) -> Result<Value, String> {
    let (root, _root_identity, _capability) =
        open_promotion_bound_root(req, "root", "rootIdentity", "rootCapability")?;
    let mut entries = Vec::new();
    let mut stream = PromotionDirectoryStream::open(root.as_raw_fd())?;
    let mut scanned_entries = 0usize;
    let mut scanned_name_bytes = 0u64;
    while let Some((name, c_name)) = stream.next_entry()? {
        scanned_entries = scanned_entries
            .checked_add(1)
            .ok_or("promotion recovery root entry count overflow")?;
        if scanned_entries > PROMOTION_RECOVERY_ROOT_MAX_ENTRIES {
            return Err("promotion recovery root exceeds its 128-entry bound".to_string());
        }
        let scan_work = u64::try_from(name.len())
            .map_err(|_| "promotion recovery root work accounting overflow")?
            .checked_add(std::mem::size_of::<FileIdentity>() as u64)
            .ok_or("promotion recovery root work accounting overflow")?;
        scanned_name_bytes = scanned_name_bytes
            .checked_add(scan_work)
            .ok_or("promotion recovery root name accounting overflow")?;
        if scanned_name_bytes > PROMOTION_DIRECTORY_MAX_NAME_BYTES {
            return Err("promotion recovery root exceeds its work bound".to_string());
        }
        let identity = match stat_at(root.as_raw_fd(), &c_name) {
            Ok(identity) if identity.is_dir() && !identity.is_symlink() => identity,
            Ok(_) => continue,
            Err(error) if missing_path(&error) => continue,
            Err(error) => return Err(format!("stat promotion directory entry failed: {error}")),
        };
        entries.push(json!({
            "name": name,
            "identity": { "dev": identity.dev.to_string(), "ino": identity.ino.to_string() },
        }));
    }
    Ok(json!({ "result": { "entries": entries } }))
}

/// Enumerate immediate private leaves with their namespace identities from the
/// same descriptor-bound root.  Callers use these observations as the
/// expected identity for a later descriptor-relative cleanup; a pathname
/// rebind after the scan therefore fails closed instead of deleting a
/// replacement leaf.
fn op_promotion_bound_list_entries(req: &Value) -> Result<Value, String> {
    let (root, _root_identity, _capability) =
        open_promotion_bound_root(req, "root", "rootIdentity", "rootCapability")?;
    let mut entries = Vec::new();
    let mut scanned_entries = 0usize;
    let mut scanned_name_bytes = 0u64;
    let mut stream = PromotionDirectoryStream::open(root.as_raw_fd())?;
    while let Some((name, c_name)) = stream.next_entry()? {
        scanned_entries = scanned_entries
            .checked_add(1)
            .ok_or("promotion entry count overflow")?;
        if scanned_entries > PROMOTION_RECOVERY_ROOT_MAX_ENTRIES {
            return Err("promotion root exceeds its 128-entry bound".to_string());
        }
        scanned_name_bytes = scanned_name_bytes
            .checked_add(
                u64::try_from(name.len())
                    .map_err(|_| "promotion entry name accounting overflow")?
                    .checked_add(std::mem::size_of::<FileIdentity>() as u64)
                    .ok_or("promotion entry name accounting overflow")?,
            )
            .ok_or("promotion entry name accounting overflow")?;
        if scanned_name_bytes > PROMOTION_DIRECTORY_MAX_NAME_BYTES {
            return Err("promotion root exceeds its work bound".to_string());
        }
        let identity = match stat_at(root.as_raw_fd(), &c_name) {
            Ok(identity) => identity,
            Err(error) if missing_path(&error) => continue,
            Err(error) => return Err(format!("stat promotion entry failed: {error}")),
        };
        let kind = if identity.is_dir() && !identity.is_symlink() {
            "directory"
        } else if identity.is_file() {
            "file"
        } else if identity.is_symlink() {
            "symlink"
        } else {
            "other"
        };
        entries.push(json!({
            "name": name,
            "identity": { "dev": identity.dev.to_string(), "ino": identity.ino.to_string() },
            "kind": kind,
        }));
    }
    Ok(json!({ "result": { "entries": entries } }))
}

/// Bind (and, when requested, create) a directory chain below an identity
/// that was obtained by the native opener above.  `allowMissing` is used for
/// a preflight probe: it reports the first absent component without asking
/// Electron to resolve a mutable pathname.  A later create request can pass
/// that index as `expectedMissingAt`, making an unexpected pre-created
/// component a conflict instead of silently accepting it.
fn op_promotion_bound_prepare_directory(req: &Value) -> Result<Value, String> {
    let root_path = s(req, "root")?;
    let (root, _root_identity, _capability) =
        open_promotion_bound_root(req, "root", "rootIdentity", "rootCapability")?;
    let components = match req.get("components") {
        None => Vec::new(),
        Some(value) if value.as_array().is_some_and(Vec::is_empty) => Vec::new(),
        Some(value) => promotion_components_value(value, "components")?,
    };
    let create_missing = req
        .get("createMissing")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let allow_missing = req
        .get("allowMissing")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let expected_missing_at = req
        .get("expectedMissingAt")
        .and_then(Value::as_u64)
        .map(|value| usize::try_from(value).map_err(|_| "expectedMissingAt is too large"))
        .transpose()?;
    let expected_chain = req
        .get("expectedChain")
        .map(|value| promotion_identity_chain_from_value(value, "expectedChain"))
        .transpose()?
        .unwrap_or_default();
    if let Some(index) = expected_missing_at {
        if index >= components.len() {
            return Err("expectedMissingAt is outside promotion components".to_string());
        }
        if !create_missing {
            return Err("expectedMissingAt requires createMissing".to_string());
        }
        if expected_chain.len() != index {
            return Err("expectedChain must cover the existing promotion prefix".to_string());
        }
    } else if !expected_chain.is_empty() && expected_chain.len() != components.len() {
        return Err("expectedChain must cover all promotion components".to_string());
    }

    let mut current = root
        .try_clone()
        .map_err(|error| format!("clone promotion prepare root failed: {error}"))?;
    let mut missing_at = None;
    let mut created = false;
    let mut chain = Vec::with_capacity(components.len());
    for (index, (_, component)) in components.iter().enumerate() {
        match open_at(
            current.as_raw_fd(),
            component,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        ) {
            Ok(next) => {
                let next_identity = stat_file(&next).map_err(|error| {
                    format!("fstat promotion prepare component {index} failed: {error}")
                })?;
                if !next_identity.is_dir() {
                    return Err(format!(
                        "promotion prepare component {index} is not a directory"
                    ));
                }
                if let Some(expected) = expected_missing_at {
                    if index >= expected {
                        return Err(format!(
                            "promotion prepare component {index} was expected to be missing"
                        ));
                    }
                }
                if let Some(expected) = expected_chain.get(index) {
                    if next_identity.dev != expected.dev || next_identity.ino != expected.ino {
                        return Err(format!(
                            "promotion prepare component {index} identity mismatch"
                        ));
                    }
                }
                chain.push(next_identity);
                current = next;
            }
            Err(error) if missing_path(&error) => {
                let first_missing = missing_at.is_none();
                if first_missing {
                    missing_at = Some(index);
                }
                if !create_missing {
                    if allow_missing {
                        return Ok(json!({
                            "result": {
                                "identity": null,
                                "missingAt": index,
                                "chain": chain.iter().map(|identity| json!({
                                    "dev": identity.dev.to_string(),
                                    "ino": identity.ino.to_string(),
                                })).collect::<Vec<_>>(),
                            }
                        }));
                    }
                    return Err(format!(
                        "promotion prepare component {index} is missing: {error}"
                    ));
                }
                if let Some(expected) = expected_missing_at {
                    if (first_missing && index != expected) || index < expected {
                        return Err(format!(
                            "promotion prepare component {index} changed before expected missing tail"
                        ));
                    }
                }
                promotion_mkdir_at(current.as_raw_fd(), component, 0o700).map_err(
                    |mkdir_error| {
                        format!("create promotion prepare component {index} failed: {mkdir_error}")
                    },
                )?;
                created = true;
                current = open_at(
                    current.as_raw_fd(),
                    component,
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
                .map_err(|open_error| {
                    format!("open created promotion prepare component {index} failed: {open_error}")
                })?;
                let created_identity = stat_file(&current).map_err(|error| {
                    format!("fstat created promotion prepare component {index} failed: {error}")
                })?;
                if !created_identity.is_dir() {
                    return Err(format!(
                        "created promotion prepare component {index} is not a directory"
                    ));
                }
                chain.push(created_identity);
            }
            Err(error) => {
                return Err(format!(
                    "open promotion prepare component {index} failed: {error}"
                ));
            }
        }
    }
    if let Some(expected) = expected_missing_at {
        if missing_at != Some(expected) {
            return Err("promotion prepare missing-tail identity changed".to_string());
        }
    }
    let identity = stat_file(&current)
        .map_err(|error| format!("fstat promotion prepared directory failed: {error}"))?;
    if !identity.is_dir() {
        return Err("promotion prepared target is not a directory".to_string());
    }
    if created {
        current
            .sync_all()
            .map_err(|error| format!("sync promotion prepared directory failed: {error}"))?;
    }
    let prepared_identity = PromotionIdentity {
        dev: identity.dev,
        ino: identity.ino,
    };
    let capability = issue_promotion_root_capability(
        &promotion_path_with_components(&root_path, &components),
        prepared_identity,
    )?;
    Ok(json!({
        "result": {
            "identity": {
                "dev": identity.dev.to_string(),
                "ino": identity.ino.to_string(),
                "capability": capability,
            },
            "missingAt": missing_at,
            "chain": chain.iter().map(|identity| json!({
                "dev": identity.dev.to_string(),
                "ino": identity.ino.to_string(),
            })).collect::<Vec<_>>(),
        }
    }))
}


/// Ensure an absolute directory chain using only descriptor-relative
/// operations from the native root descriptor.
fn op_promotion_bound_ensure_directory(req: &Value) -> Result<Value, String> {
    let object = req
        .as_object()
        .ok_or("promotion directory request must be an object")?;
    for field in object.keys() {
        if !matches!(
            field.as_str(),
            "op"
                | "requestId"
                | "path"
                | "expectedIdentity"
                | "capability"
                | "trustedParent"
                | "provenance"
                | "marker"
                | "testHook"
        ) {
            return Err("promotion directory request contains an unknown field".to_string());
        }
    }
    // Requests carrying provenance state use the single native create/bind
    // transaction. Already-proven roots use the ordinary identity opener.
    if req.get("provenance").is_some() || req.get("marker").is_some() {
        return op_promotion_bound_root_transaction(req);
    }
    let path = s(req, "path")?;
    if req.get("capability").is_some() || req.get("expectedIdentity").is_some() {
        let (directory, identity, capability) =
            open_promotion_bound_root(req, "path", "expectedIdentity", "capability")?;
        promotion_test_pause(req, "promotion-directory-prebind")?;
        promotion_directory_identity_matches(&directory, identity, "directory")?;
        directory
            .sync_all()
            .map_err(|error| format!("sync ensured promotion directory failed: {error}"))?;
        return Ok(json!({
            "result": promotion_directory_capability_result(identity, &capability)
        }));
    }
    // A first bind may create exactly one app-owned root leaf, but only from
    // a parent whose identity was already supplied by the trusted owner.
    let trusted_parent = req.get("trustedParent").and_then(Value::as_object).ok_or(
        "promotion directory requires a previously trusted identity, capability, or parent",
    )?;
    let parent_path = trusted_parent
        .get("path")
        .and_then(Value::as_str)
        .ok_or("trusted promotion parent path is missing")?;
    let parent_identity = promotion_identity_from_value(
        trusted_parent
            .get("identity")
            .ok_or("trusted promotion parent identity is missing")?,
        "trustedParent.identity",
    )?;
    let (parent, _parent_bound_identity, _parent_capability) = open_promotion_bound_root_values(
        parent_path,
        Some(parent_identity),
        trusted_parent.get("capability").and_then(Value::as_str),
        "trustedParent",
    )?;
    let name_value = trusted_parent
        .get("name")
        .ok_or("trusted promotion parent leaf is missing")?;
    let (name, c_name) = promotion_component(name_value, "trustedParent.name")?;
    let expected_path = format!("{}/{}", parent_path.trim_end_matches('/'), name);
    if expected_path != path {
        return Err("promotion directory path is not the trusted parent leaf".to_string());
    }
    let directory = match open_at(
        parent.as_raw_fd(),
        &c_name,
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    ) {
        Ok(existing) => {
            let expected = req
                .get("expectedIdentity")
                .ok_or_else(|| {
                    "existing promotion directory requires a previously trusted expectedIdentity"
                        .to_string()
                })
                .and_then(|value| promotion_identity_from_value(value, "expectedIdentity"))?;
            promotion_directory_identity_matches(&existing, expected, "directory")?;
            existing
        }
        Err(error) if missing_path(&error) => {
            promotion_mkdir_at(parent.as_raw_fd(), &c_name, 0o700).map_err(|mkdir_error| {
                format!("create promotion directory {name} failed: {mkdir_error}")
            })?;
            open_at(
                parent.as_raw_fd(),
                &c_name,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|open_error| {
                format!("open created promotion directory {name} failed: {open_error}")
            })?
        }
        Err(error) => return Err(format!("open promotion directory {name} failed: {error}")),
    };
    let identity = stat_file(&directory)
        .map_err(|error| format!("fstat ensured promotion directory failed: {error}"))?;
    if !identity.is_dir() {
        return Err("ensured promotion directory is not a directory".to_string());
    }
    parent
        .sync_all()
        .map_err(|error| format!("sync promotion directory parent failed: {error}"))?;
    directory
        .sync_all()
        .map_err(|error| format!("sync ensured promotion directory failed: {error}"))?;
    let capability = issue_promotion_root_capability(
        &path,
        PromotionIdentity {
            dev: identity.dev,
            ino: identity.ino,
        },
    )?;
    Ok(json!({
        "result": promotion_directory_capability_result(
            PromotionIdentity { dev: identity.dev, ino: identity.ino },
            &capability,
        )
    }))
}


fn promotion_cleanup_same_namespace_identity(actual: FileIdentity, expected: FileIdentity) -> bool {
    actual.dev == expected.dev
        && actual.ino == expected.ino
        && actual.file_type() == expected.file_type()
}


fn promotion_rename_exchange(
    source_parent: RawFd,
    source: &CStr,
    destination_parent: RawFd,
    destination: &CStr,
) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        let rc = unsafe {
            libc::renameat2(
                source_parent,
                source.as_ptr(),
                destination_parent,
                destination.as_ptr(),
                libc::RENAME_EXCHANGE,
            )
        };
        if rc == -1 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
    #[cfg(target_os = "macos")]
    {
        let rc = unsafe {
            libc::renameatx_np(
                source_parent,
                source.as_ptr(),
                destination_parent,
                destination.as_ptr(),
                libc::RENAME_SWAP,
            )
        };
        if rc == -1 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (source_parent, source, destination_parent, destination);
        Err(io::Error::from_raw_os_error(libc::ENOTSUP))
    }
}


fn promotion_rename_unsupported(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(libc::ENOSYS | libc::EINVAL | libc::ENOTSUP | libc::EOPNOTSUPP)
    )
}

fn promotion_transition_result(
    transition: &str,
    outcome: &str,
    durable: bool,
    retained_name: Option<&str>,
    error: Option<String>,
) -> Value {
    json!({
        "result": {
            "outcome": outcome,
            "transition": transition,
            "durable": durable,
            "retainedName": retained_name,
            "error": error,
        }
    })
}

fn op_promotion_bound_read_journal(req: &Value) -> Result<Value, String> {
    let (root, _root_identity, _capability) = open_promotion_bound_root(
        req,
        "journalRoot",
        "journalRootIdentity",
        "journalRootCapability",
    )?;

    let (operation_name, operation) = promotion_component(
        req.get("operationName").ok_or("missing operationName")?,
        "operationName",
    )?;
    let operation_identity = promotion_identity_from_value(
        req.get("operationIdentity")
            .ok_or("missing operationIdentity")?,
        "operationIdentity",
    )?;
    let operation_dir = open_at(
        root.as_raw_fd(),
        &operation,
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )
    .map_err(|error| format!("open promotion operation directory failed: {error}"))?;
    promotion_directory_identity_matches(
        &operation_dir,
        operation_identity,
        "operation directory",
    )?;
    promotion_test_pause(req, "journal-operation-open")?;

    let journal_name = CString::new("journal.json").expect("constant has no NUL");
    let journal_file = open_at(
        operation_dir.as_raw_fd(),
        &journal_name,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
    )
    .map_err(|error| format!("open promotion journal failed: {error}"))?;
    promotion_test_pause(req, "journal-file-open")?;
    let raw = stat_promotion_journal_file(&journal_file)
        .map_err(|error| format!("fstat promotion journal failed: {error}"))?;
    if !raw.file.is_file()
        || raw.file.mode & 0o022 != 0
        || raw.uid != unsafe { libc::geteuid() as u64 }
        || raw.links != 1
        || raw.file.len > PROMOTION_JOURNAL_MAX_BYTES
    {
        return Err("promotion journal is not a bounded private regular file".to_string());
    }
    let mut bytes = Vec::new();
    let read_limit = PROMOTION_JOURNAL_MAX_BYTES
        .checked_add(1)
        .ok_or("promotion journal budget overflow")?;
    (&journal_file)
        .take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read promotion journal failed: {error}"))?;
    if bytes.len() as u64 > PROMOTION_JOURNAL_MAX_BYTES {
        return Err("promotion journal exceeds the 16 MiB read budget".to_string());
    }
    let after = stat_promotion_journal_file(&journal_file)
        .map_err(|error| format!("fstat promotion journal failed: {error}"))?;
    let path_after = stat_at(operation_dir.as_raw_fd(), &journal_name)
        .map_err(|error| format!("stat promotion journal failed: {error}"))?;
    if raw != after || after.file != path_after {
        return Err("promotion journal changed while reading".to_string());
    }
    Ok(json!({
        "content": base64::engine::general_purpose::STANDARD.encode(&bytes),
        "byteLength": bytes.len(),
        "operationName": operation_name,
    }))
}

/// Read one private regular file below a descriptor-bound parent.  This is
/// used for root provenance records, which live beside (rather than inside)
/// the mutable root leaf.  The file descriptor and its parent/name identity
/// are checked before and after the bounded read so a pathname replacement
/// cannot supply or alter the provenance bytes.
fn op_promotion_bound_read_file(req: &Value) -> Result<Value, String> {
    let (root, _root_identity, _capability) =
        open_promotion_bound_root(req, "root", "rootIdentity", "rootCapability")?;
    let components = promotion_components_for(req, "components")?;
    let parent = open_promotion_parent(&root, &components, "read")?;
    let parent_identity = promotion_identity_from_value(
        req.get("parentIdentity").ok_or("missing parentIdentity")?,
        "parentIdentity",
    )?;
    promotion_directory_identity_matches(&parent, parent_identity, "read parent")?;
    let (_, leaf) = components.last().expect("non-empty components");
    let expected = req
        .get("expectedIdentity")
        .map(|value| promotion_identity_from_value(value, "expectedIdentity"))
        .transpose()?;
    let max_bytes = req
        .get("maxBytes")
        .and_then(Value::as_u64)
        .unwrap_or(PROMOTION_JOURNAL_MAX_BYTES);
    if max_bytes == 0 || max_bytes > PROMOTION_JOURNAL_MAX_BYTES {
        return Err("promotion read file maxBytes exceeds the 16 MiB budget".to_string());
    }
    let file = open_at(
        parent.as_raw_fd(),
        leaf,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
    )
    .map_err(|error| format!("open promotion read file failed: {error}"))?;
    let opened = stat_promotion_journal_file(&file)
        .map_err(|error| format!("fstat promotion read file failed: {error}"))?;
    if !opened.file.is_file()
        || opened.file.mode & 0o077 != 0
        || opened.uid != unsafe { libc::geteuid() as u64 }
        || opened.links != 1
        || opened.file.len > max_bytes
    {
        return Err("promotion read file is not a bounded private regular file".to_string());
    }
    if let Some(expected) = expected {
        if opened.file.dev != expected.dev || opened.file.ino != expected.ino {
            return Err("promotion read file identity mismatch".to_string());
        }
    }
    let mut bytes = Vec::new();
    let read_limit = max_bytes
        .checked_add(1)
        .ok_or("promotion read file budget overflow")?;
    (&file)
        .take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read promotion file failed: {error}"))?;
    if bytes.len() as u64 > max_bytes {
        return Err("promotion read file exceeds its bounded read budget".to_string());
    }
    let after = stat_promotion_journal_file(&file)
        .map_err(|error| format!("fstat promotion read file failed: {error}"))?;
    let path_after = stat_at(parent.as_raw_fd(), leaf)
        .map_err(|error| format!("stat promotion read file failed: {error}"))?;
    if opened != after || after.file != path_after {
        return Err("promotion read file changed while reading".to_string());
    }
    Ok(json!({
        "content": base64::engine::general_purpose::STANDARD.encode(&bytes),
        "byteLength": bytes.len(),
        "identity": {
            "dev": after.file.dev.to_string(),
            "ino": after.file.ino.to_string(),
        },
    }))
}


/// Copy the contents of one identity-bound directory into another.  Every
/// source and destination component is opened relative to a descriptor and
/// checked again after its bytes/name have been observed.  This is deliberately
/// a native primitive: a TypeScript `cp -R` would discard the allocation
/// capability and can follow a same-UID ancestor replacement.
struct PromotionCopyBudget {
    bytes: u64,
    entries: usize,
    work_bytes: u64,
    max_bytes: u64,
    max_entries: usize,
    max_work_bytes: u64,
}

impl PromotionCopyBudget {
    fn charge_entry(&mut self) -> Result<(), String> {
        self.entries = self
            .entries
            .checked_add(1)
            .ok_or("promotion tree copy entry count overflow")?;
        if self.entries > self.max_entries {
            return Err("promotion tree copy exceeds its entry bound".to_string());
        }
        Ok(())
    }

    fn charge_bytes(&mut self, amount: u64) -> Result<(), String> {
        self.bytes = self
            .bytes
            .checked_add(amount)
            .ok_or("promotion tree copy byte accounting overflow")?;
        if self.bytes > self.max_bytes {
            return Err("promotion tree copy exceeds its byte bound".to_string());
        }
        Ok(())
    }

    fn charge_work(&mut self, amount: u64) -> Result<(), String> {
        self.work_bytes = self
            .work_bytes
            .checked_add(amount)
            .ok_or("promotion tree copy work accounting overflow")?;
        if self.work_bytes > self.max_work_bytes {
            return Err("promotion tree copy exceeds its work bound".to_string());
        }
        Ok(())
    }
}

fn promotion_copy_path_len(relative: &str, name: &str) -> Result<usize, String> {
    if name.is_empty() || name.len() > PROMOTION_COMPONENT_MAX_BYTES {
        return Err("promotion tree copy entry name is invalid".to_string());
    }
    relative
        .len()
        .checked_add(if relative.is_empty() { 0 } else { 1 })
        .and_then(|length| length.checked_add(name.len()))
        .filter(|length| *length <= PROMOTION_PATH_MAX_BYTES)
        .ok_or_else(|| "promotion traversal path exceeds its bounded work budget".to_string())
}

struct PromotionCopyFrame {
    source: fs::File,
    destination: fs::File,
    stream: PromotionDirectoryStream,
    relative: String,
    parent_name: Option<CString>,
    identity: Option<FileIdentity>,
}

fn promotion_copy_tree_contents(
    source: &fs::File,
    destination: &fs::File,
    budget: &mut PromotionCopyBudget,
    relative: &str,
) -> Result<(), String> {
    let root_work = u64::try_from(relative.len())
        .map_err(|_| "promotion tree copy root work accounting overflow")?
        .checked_add(std::mem::size_of::<FileIdentity>() as u64)
        .ok_or("promotion tree copy root work accounting overflow")?;
    budget.charge_work(root_work)?;
    let stream = PromotionDirectoryStream::open(source.as_raw_fd())?;
    let mut stack = Vec::with_capacity(PROMOTION_DIRECTORY_MAX_DEPTH);
    stack.push(PromotionCopyFrame {
        source: source.try_clone().map_err(|error| format!("clone promotion tree source failed: {error}"))?,
        destination: destination.try_clone().map_err(|error| format!("clone promotion tree destination failed: {error}"))?,
        stream,
        relative: relative.to_string(),
        parent_name: None,
        identity: None,
    });
    while !stack.is_empty() {
        let next = stack
            .last_mut()
            .expect("promotion copy stack is not empty")
            .stream
            .next_entry()?;
        let Some((name, c_name)) = next else {
            let frame = stack.pop().expect("promotion copy frame exists");
            if let (Some(parent_name), Some(source_identity)) =
                (frame.parent_name.as_ref(), frame.identity)
            {
                let parent = stack
                    .last()
                    .ok_or("promotion copy parent frame is missing")?;
                promotion_set_mode(
                    &frame.destination,
                    source_identity.mode & 0o777,
                    &frame.relative,
                )?;
                frame.destination.sync_all().map_err(|error| {
                    format!("sync promotion tree directory {} failed: {error}", frame.relative)
                })?;
                let source_after = stat_file(&frame.source).map_err(|error| {
                    format!("fstat promotion tree source {} failed: {error}", frame.relative)
                })?;
                let destination_after = stat_file(&frame.destination).map_err(|error| {
                    format!("fstat promotion tree destination {} failed: {error}", frame.relative)
                })?;
                let destination_path = stat_at(parent.destination.as_raw_fd(), parent_name).map_err(|error| {
                    format!("stat promotion tree destination {} failed: {error}", frame.relative)
                })?;
                if source_after != source_identity
                    || destination_after != destination_path
                    || !destination_after.is_dir()
                {
                    return Err(format!("promotion tree {} changed during copy", frame.relative));
                }
                parent.destination.sync_all().map_err(|error| {
                    format!("sync promotion tree parent for {} failed: {error}", frame.relative)
                })?;
            }
            continue;
        };
        budget.charge_entry()?;
        let (source_fd, destination_fd, relative) = {
            let frame = stack.last().expect("promotion copy frame exists");
            (
                frame.source.as_raw_fd(),
                frame.destination.as_raw_fd(),
                frame.relative.clone(),
            )
        };
        let path_len = promotion_copy_path_len(&relative, &name)?;
        let work = u64::try_from(path_len)
            .map_err(|_| "promotion tree copy work accounting overflow")?
            .checked_add(
                u64::try_from(name.len())
                    .map_err(|_| "promotion tree copy work accounting overflow")?,
            )
            .and_then(|value| {
                value.checked_add(std::mem::size_of::<FileIdentity>() as u64)
            })
            .ok_or("promotion tree copy work accounting overflow")?;
        budget.charge_work(work)?;
        let child_relative = promotion_child_relative(&relative, &name)?;
        let source_identity = stat_at(source_fd, &c_name).map_err(|error| {
            format!("stat promotion tree source {child_relative} failed: {error}")
        })?;
        if !source_identity.is_dir() && !source_identity.is_file() && !source_identity.is_symlink()
        {
            return Err(format!(
                "promotion tree source {child_relative} has an unsupported file type"
            ));
        }
        match stat_at(destination_fd, &c_name) {
            Ok(_) => {
                return Err(format!(
                    "promotion tree destination {child_relative} is occupied"
                ));
            }
            Err(error) if missing_path(&error) => {}
            Err(error) => {
                return Err(format!(
                    "stat promotion tree destination {child_relative} failed: {error}"
                ));
            }
        }
        if source_identity.is_dir() && !source_identity.is_symlink() {
            if stack.len() >= PROMOTION_DIRECTORY_MAX_DEPTH {
                return Err("promotion tree copy exceeds its depth bound".to_string());
            }
            promotion_mkdir_at(destination_fd, &c_name, 0o700).map_err(|error| {
                format!("create promotion tree directory {child_relative} failed: {error}")
            })?;
            let source_child = open_at(
                source_fd,
                &c_name,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|error| {
                format!("open promotion tree source {child_relative} failed: {error}")
            })?;
            let destination_child = open_at(
                destination_fd,
                &c_name,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|error| {
                format!("open promotion tree destination {child_relative} failed: {error}")
            })?;
            let opened_source = stat_file(&source_child).map_err(|error| {
                format!("fstat promotion tree source {child_relative} failed: {error}")
            })?;
            if opened_source != source_identity {
                return Err(format!(
                    "promotion tree source {child_relative} changed while opening"
                ));
            }
            let child_stream = PromotionDirectoryStream::open(source_child.as_raw_fd())?;
            stack.push(PromotionCopyFrame {
                source: source_child,
                destination: destination_child,
                stream: child_stream,
                relative: child_relative,
                parent_name: Some(c_name),
                identity: Some(source_identity),
            });
            continue;
        }
        if source_identity.is_symlink() {
            let target = read_link_at(source_fd, &c_name).map_err(|error| {
                format!("read promotion tree symlink {child_relative} failed: {error}")
            })?;
            if target.len() > PROMOTION_PATH_MAX_BYTES {
                return Err(format!("promotion tree symlink {child_relative} is too long"));
            }
            budget.charge_bytes(
                u64::try_from(target.len())
                    .map_err(|_| "promotion tree symlink byte accounting overflow")?,
            )?;
            let target_c = CString::new(target.clone())
                .map_err(|_| format!("promotion tree symlink {child_relative} contains NUL"))?;
            promotion_symlink_at(&target_c, destination_fd, &c_name).map_err(|error| {
                format!("create promotion tree symlink {child_relative} failed: {error}")
            })?;
            let destination_after = stat_at(destination_fd, &c_name).map_err(|error| {
                format!("stat promotion tree symlink {child_relative} failed: {error}")
            })?;
            let target_after = read_link_at(destination_fd, &c_name).map_err(|error| {
                format!("read promotion tree symlink {child_relative} failed: {error}")
            })?;
            let source_after = stat_at(source_fd, &c_name).map_err(|error| {
                format!("stat promotion tree symlink {child_relative} failed: {error}")
            })?;
            if !destination_after.is_symlink()
                || source_after != source_identity
                || target_after != target
            {
                return Err(format!("promotion tree symlink {child_relative} changed during copy"));
            }
            stack.last().expect("promotion copy frame exists").destination.sync_all().map_err(|error| {
                format!("sync promotion tree symlink parent for {child_relative} failed: {error}")
            })?;
            continue;
        }
        let mut source_file = open_at(
            source_fd,
            &c_name,
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
        .map_err(|error| {
            format!("open promotion tree source file {child_relative} failed: {error}")
        })?;
        let opened_source = stat_file(&source_file).map_err(|error| {
            format!("fstat promotion tree source file {child_relative} failed: {error}")
        })?;
        if opened_source != source_identity || !opened_source.is_file() {
            return Err(format!(
                "promotion tree source file {child_relative} changed while opening"
            ));
        }
        budget.charge_bytes(source_identity.len)?;
        let mut destination_file = open_at_mode(
            destination_fd,
            &c_name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
        .map_err(|error| {
            format!("create promotion tree destination file {child_relative} failed: {error}")
        })?;
        let mut copied = 0u64;
        let mut chunk = [0u8; 64 * 1024];
        loop {
            let read = source_file.read(&mut chunk).map_err(|error| {
                format!("read promotion tree source file {child_relative} failed: {error}")
            })?;
            if read == 0 {
                break;
            }
            let read = u64::try_from(read).map_err(|_| "promotion tree copy byte overflow")?;
            let available = source_identity
                .len
                .checked_sub(copied)
                .ok_or("promotion tree source file exceeded its observed length")?;
            if read > available {
                return Err("promotion tree source file grew during copy".to_string());
            }
            destination_file
                .write_all(&chunk[..read as usize])
                .map_err(|error| format!("write promotion tree destination file {child_relative} failed: {error}"))?;
            copied = copied
                .checked_add(read)
                .ok_or("promotion tree copy byte accounting overflow")?;
        }
        let source_after = stat_file(&source_file).map_err(|error| {
            format!("fstat promotion tree source file {child_relative} failed: {error}")
        })?;
        if source_after != source_identity || source_after.len != copied {
            return Err(format!(
                "promotion tree source file {child_relative} changed while reading"
            ));
        }
        promotion_set_mode(&destination_file, source_identity.mode & 0o777, &child_relative)?;
        destination_file.sync_all().map_err(|error| {
            format!("sync promotion tree destination file {child_relative} failed: {error}")
        })?;
        let destination_after = stat_file(&destination_file).map_err(|error| {
            format!("fstat promotion tree destination file {child_relative} failed: {error}")
        })?;
        let destination_path = stat_at(destination_fd, &c_name).map_err(|error| {
            format!("stat promotion tree destination file {child_relative} failed: {error}")
        })?;
        if destination_after != destination_path
            || !destination_after.is_file()
            || destination_after.len != copied
        {
            return Err(format!(
                "promotion tree destination file {child_relative} changed during copy"
            ));
        }
        if copied != source_identity.len {
            return Err("promotion tree source file changed its length during copy".to_string());
        }
        stack.last().expect("promotion copy frame exists").destination.sync_all().map_err(|error| {
            format!("sync promotion tree parent for {child_relative} failed: {error}")
        })?;
    }
    Ok(())
}


fn promotion_leaf_result(observed: &PromotionObservedLeaf) -> Value {
    let state = match &observed.state {
        PromotionObservedState::File { mode, size, sha256 } => json!({
            "type": "file",
            "mode": mode,
            "size": size.to_string(),
            "sha256": sha256,
        }),
        PromotionObservedState::Symlink { target } => {
            json!({ "type": "symlink", "target": target })
        }
        PromotionObservedState::Other => json!({ "type": "other" }),
    };
    json!({
        "identity": {
            "dev": observed.identity.dev.to_string(),
            "ino": observed.identity.ino.to_string(),
        },
        "state": state,
    })
}


fn promotion_expected_directory(
    value: &Value,
    field: &str,
) -> Result<(PromotionIdentity, u32), String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{field} must be an object"))?;
    let identity = promotion_identity_from_value(
        object
            .get("identity")
            .ok_or_else(|| format!("{field}.identity is missing"))?,
        &format!("{field}.identity"),
    )?;
    let mode = object
        .get("mode")
        .and_then(Value::as_u64)
        .filter(|mode| *mode <= 0o777)
        .ok_or_else(|| format!("{field}.mode is invalid"))? as u32;
    Ok((identity, mode))
}

fn op_promotion_bound_create_directory(req: &Value) -> Result<Value, String> {
    let root_path = s(req, "root")?;
    let (root, root_identity, _capability) =
        open_promotion_bound_root(req, "root", "rootIdentity", "rootCapability")?;
    promotion_test_pause(req, "promotion-directory-root-open")?;
    // The descriptor keeps the operation on the originally bound root, but a
    // caller-visible create must also fail closed if that root pathname (or
    // one of its ancestors) was replaced while the request waited.  Without
    // this provenance assertion the child would be created in a parked,
    // unreachable directory and the returned pathname could describe a
    // different root.
    promotion_bound_path_matches(&root_path, root_identity, "directory root")?;
    let components = promotion_components_for(req, "components")?;
    let parent_components = &components[..components.len() - 1];
    let parent =
        open_or_create_promotion_parent(&root, parent_components, "directory parent", 0o700)?;
    let parent_identity = promotion_identity_from_value(
        req.get("parentIdentity").ok_or("missing parentIdentity")?,
        "parentIdentity",
    )?;
    promotion_directory_identity_matches(&parent, parent_identity, "directory parent")?;
    promotion_test_pause(req, "promotion-directory-parent-open")?;
    let parent_path = promotion_path_with_components(&root_path, parent_components);
    promotion_bound_path_matches(&root_path, root_identity, "directory root")?;
    promotion_bound_path_matches(&parent_path, parent_identity, "directory parent")?;
    let (leaf_name, leaf) = components.last().expect("non-empty components");
    let require_missing = req
        .get("requireMissing")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let existing = stat_at(parent.as_raw_fd(), leaf);
    let leaf_file = match existing {
        Ok(identity) => {
            if require_missing {
                return Err(format!("promotion directory {leaf_name} already exists"));
            }
            if !identity.is_dir() || identity.is_symlink() {
                return Err(format!(
                    "promotion directory {leaf_name} is not a directory"
                ));
            }
            open_at(
                parent.as_raw_fd(),
                leaf,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|error| format!("open promotion directory {leaf_name} failed: {error}"))?
        }
        Err(error) if missing_path(&error) => {
            promotion_mkdir_at(parent.as_raw_fd(), leaf, 0o700).map_err(|error| {
                format!("create promotion directory {leaf_name} failed: {error}")
            })?;
            open_at(
                parent.as_raw_fd(),
                leaf,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|error| {
                format!("open created promotion directory {leaf_name} failed: {error}")
            })?
        }
        Err(error) => {
            return Err(format!(
                "stat promotion directory {leaf_name} failed: {error}"
            ));
        }
    };
    let leaf_identity = stat_file(&leaf_file)
        .map_err(|error| format!("fstat promotion directory {leaf_name} failed: {error}"))?;
    if !leaf_identity.is_dir() {
        return Err(format!(
            "promotion directory {leaf_name} is not a directory"
        ));
    }
    promotion_test_pause(req, "promotion-directory-leaf-open")?;
    promotion_bound_path_matches(&root_path, root_identity, "directory root")?;
    promotion_bound_path_matches(&parent_path, parent_identity, "directory parent")?;
    let path_identity = stat_at(parent.as_raw_fd(), leaf)
        .map_err(|error| format!("stat promotion directory {leaf_name} failed: {error}"))?;
    if path_identity != leaf_identity {
        return Err(format!(
            "promotion directory {leaf_name} changed while opening"
        ));
    }
    parent
        .sync_all()
        .map_err(|error| format!("sync promotion directory parent failed: {error}"))?;
    let leaf_identity = PromotionIdentity {
        dev: leaf_identity.dev,
        ino: leaf_identity.ino,
    };
    let capability = issue_promotion_root_capability(
        &promotion_path_with_components(&root_path, &components),
        leaf_identity,
    )?;
    Ok(json!({
        "result": {
            "identity": {
                "dev": leaf_identity.dev.to_string(),
                "ino": leaf_identity.ino.to_string(),
                "capability": capability,
            }
        }
    }))
}

fn parse_promotion_expected_missing_or_leaf(
    value: &Value,
    field: &str,
) -> Result<Option<PromotionExpectedLeaf>, String> {
    parse_promotion_expected_destination(value, field)
}

fn promotion_decode_content(req: &Value) -> Result<Vec<u8>, String> {
    let content = req
        .get("content")
        .and_then(Value::as_str)
        .ok_or("content must be a base64 string")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content)
        .map_err(|error| format!("promotion content is not valid base64: {error}"))?;
    if bytes.len() as u64 > PROMOTION_JOURNAL_MAX_BYTES {
        return Err("promotion content exceeds the 16 MiB budget".to_string());
    }
    Ok(bytes)
}

fn op_promotion_bound_write_file(req: &Value) -> Result<Value, String> {
    let root_path = s(req, "root")?;
    let (root, root_identity, _capability) =
        open_promotion_bound_root(req, "root", "rootIdentity", "rootCapability")?;
    let components = promotion_components_for(req, "components")?;
    let parent = open_promotion_parent(&root, &components, "write")?;
    let parent_identity = promotion_identity_from_value(
        req.get("parentIdentity").ok_or("missing parentIdentity")?,
        "parentIdentity",
    )?;
    promotion_directory_identity_matches(&parent, parent_identity, "write parent")?;
    promotion_test_pause(req, "promotion-write-parent-open")?;
    let parent_path = promotion_path_with_components(&root_path, &components[..components.len() - 1]);
    promotion_bound_path_matches(&root_path, root_identity, "write root")?;
    promotion_bound_path_matches(&parent_path, parent_identity, "write parent")?;
    let (_, leaf) = components.last().expect("non-empty components");
    let expected = parse_promotion_expected_missing_or_leaf(
        req.get("expectedDestination")
            .ok_or("missing expectedDestination")?,
        "expectedDestination",
    )?;
    let bytes = promotion_decode_content(req)?;
    let mode = promotion_mode(req.get("mode"), "mode", 0o600)?;
    let mut file = if let Some(expected) = &expected {
        let observed = observe_promotion_leaf(parent.as_raw_fd(), leaf)?;
        if !promotion_expected_matches(expected, observed.as_ref()) {
            return Err("promotion write expected destination was not present".to_string());
        }
        open_at(
            parent.as_raw_fd(),
            leaf,
            libc::O_WRONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
        .map_err(|error| format!("open promotion file failed: {error}"))?
    } else {
        open_at_mode(
            parent.as_raw_fd(),
            leaf,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            mode as libc::mode_t,
        )
        .map_err(|error| format!("create promotion file failed: {error}"))?
    };
    promotion_test_pause(req, "promotion-write-file-open")?;
    let opened =
        stat_file(&file).map_err(|error| format!("fstat promotion file failed: {error}"))?;
    if !opened.is_file() {
        return Err("promotion write destination is not a regular file".to_string());
    }
    // Revalidate the public root/parent ancestry and the leaf namespace before
    // truncating.  The descriptor still pins the file opened above, but a
    // replacement at the pathname must not cause us to mutate an old parked
    // file and then report a result for the replacement.
    promotion_bound_path_matches(&root_path, root_identity, "write root")?;
    promotion_bound_path_matches(&parent_path, parent_identity, "write parent")?;
    let path_before_write = stat_at(parent.as_raw_fd(), leaf)
        .map_err(|error| format!("stat promotion file before writing failed: {error}"))?;
    if path_before_write != opened {
        return Err("promotion write destination changed before writing; evidence retained".to_string());
    }
    if let Some(expected) = &expected {
        if opened.dev != expected.identity.dev || opened.ino != expected.identity.ino {
            return Err("promotion write destination identity changed while opening".to_string());
        }
    }
    file.set_len(0)
        .map_err(|error| format!("truncate promotion file failed: {error}"))?;
    promotion_write_all(&mut file, &bytes, "file")?;
    promotion_set_mode(&file, mode, "file")?;
    file.sync_all()
        .map_err(|error| format!("sync promotion file failed: {error}"))?;
    let after =
        stat_file(&file).map_err(|error| format!("fstat promotion file failed: {error}"))?;
    let path_after = stat_at(parent.as_raw_fd(), leaf)
        .map_err(|error| format!("stat promotion file failed: {error}"))?;
    if after != path_after || !after.is_file() || after.len != bytes.len() as u64 {
        return Err("promotion file changed while writing; evidence retained".to_string());
    }
    if after.dev != opened.dev || after.ino != opened.ino {
        return Err("promotion file identity changed while writing; evidence retained".to_string());
    }
    parent
        .sync_all()
        .map_err(|error| format!("sync promotion write parent failed: {error}"))?;
    // Keep the result bound to the descriptor that was actually truncated and
    // written.  A pathname-only observation here could accept a replacement
    // leaf in the final interval (and poison the journal with its identity).
    promotion_test_pause(req, "promotion-write-final-observe")?;
    let final_descriptor =
        stat_file(&file).map_err(|error| format!("fstat promotion file failed: {error}"))?;
    let final_path = stat_at(parent.as_raw_fd(), leaf)
        .map_err(|error| format!("stat promotion file failed: {error}"))?;
    if final_descriptor != after
        || final_path != final_descriptor
        || !final_descriptor.is_file()
        || final_descriptor.len != bytes.len() as u64
    {
        return Err(
            "promotion file changed during final observation; evidence retained".to_string(),
        );
    }
    let observed = PromotionObservedLeaf {
        identity: PromotionIdentity {
            dev: final_descriptor.dev,
            ino: final_descriptor.ino,
        },
        state: PromotionObservedState::File {
            mode: final_descriptor.mode & 0o777,
            size: bytes.len() as u64,
            sha256: promotion_sha256_hex(&bytes),
        },
    };
    Ok(json!({ "result": { "leaf": promotion_leaf_result(&observed) } }))
}

fn op_promotion_bound_copy_file(req: &Value) -> Result<Value, String> {
    let (source_root, _source_root_identity, _source_capability) = open_promotion_bound_root(
        req,
        "sourceRoot",
        "sourceRootIdentity",
        "sourceRootCapability",
    )?;
    let source_components = promotion_components_for(req, "sourceComponents")?;
    let source_parent = open_promotion_parent(&source_root, &source_components, "copy source")?;
    let source_parent_identity = promotion_identity_from_value(
        req.get("sourceParentIdentity")
            .ok_or("missing sourceParentIdentity")?,
        "sourceParentIdentity",
    )?;
    promotion_directory_identity_matches(
        &source_parent,
        source_parent_identity,
        "copy source parent",
    )?;
    let source_expected = parse_promotion_expected(
        req.get("expectedSource").ok_or("missing expectedSource")?,
        "expectedSource",
    )?;

    let (destination_root, _destination_root_identity, _destination_capability) =
        open_promotion_bound_root(
            req,
            "destinationRoot",
            "destinationRootIdentity",
            "destinationRootCapability",
        )?;
    let destination_components = promotion_components_for(req, "destinationComponents")?;
    let destination_parent = open_promotion_parent(
        &destination_root,
        &destination_components,
        "copy destination",
    )?;
    let destination_parent_identity = promotion_identity_from_value(
        req.get("destinationParentIdentity")
            .ok_or("missing destinationParentIdentity")?,
        "destinationParentIdentity",
    )?;
    promotion_directory_identity_matches(
        &destination_parent,
        destination_parent_identity,
        "copy destination parent",
    )?;
    promotion_test_pause(req, "promotion-copy-roots-open")?;
    let (_, source_name) = source_components
        .last()
        .expect("non-empty source components");
    let (_, destination_name) = destination_components
        .last()
        .expect("non-empty destination components");
    let observed_source = observe_promotion_leaf(source_parent.as_raw_fd(), source_name)?;
    if !promotion_expected_matches(&source_expected, observed_source.as_ref()) {
        return Err("promotion copy source changed before reading".to_string());
    }
    let source_file = open_at(
        source_parent.as_raw_fd(),
        source_name,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )
    .map_err(|error| format!("open promotion copy source failed: {error}"))?;
    let source_stat = stat_file(&source_file)
        .map_err(|error| format!("fstat promotion copy source failed: {error}"))?;
    if !source_stat.is_file()
        || source_stat.dev != source_expected.identity.dev
        || source_stat.ino != source_expected.identity.ino
    {
        return Err("promotion copy source identity changed while opening".to_string());
    }
    let read_limit = BUDGET_MAX_FILE_BYTES
        .checked_add(1)
        .ok_or("promotion copy budget overflow")?;
    let mut bytes = Vec::new();
    (&source_file)
        .take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read promotion copy source failed: {error}"))?;
    if bytes.len() as u64 > BUDGET_MAX_FILE_BYTES {
        return Err("promotion copy source exceeds the file budget".to_string());
    }
    if !matches!(source_expected.state, PromotionExpectedState::File { .. }) {
        return Err("promotion copy source is not a regular file".to_string());
    }
    let after_source = stat_file(&source_file)
        .map_err(|error| format!("fstat promotion copy source failed: {error}"))?;
    if after_source != source_stat
        || promotion_sha256_hex(&bytes)
            != match &source_expected.state {
                PromotionExpectedState::File { sha256, .. } => sha256.clone(),
                PromotionExpectedState::Symlink { .. } => String::new(),
            }
    {
        return Err("promotion copy source changed while reading".to_string());
    }
    if stat_at(source_parent.as_raw_fd(), source_name)
        .map_err(|error| format!("stat promotion copy source failed: {error}"))?
        != source_stat
    {
        return Err("promotion copy source name changed while reading".to_string());
    }
    if stat_at(destination_parent.as_raw_fd(), destination_name).is_ok() {
        return Err("promotion copy destination is occupied".to_string());
    }
    let mut destination_file = open_at_mode(
        destination_parent.as_raw_fd(),
        destination_name,
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        0o600,
    )
    .map_err(|error| format!("create promotion copy destination failed: {error}"))?;
    promotion_write_all(&mut destination_file, &bytes, "copy destination")?;
    let mode = match source_expected.state {
        PromotionExpectedState::File { mode, .. } => mode,
        PromotionExpectedState::Symlink { .. } => 0o600,
    };
    promotion_set_mode(&destination_file, mode, "copy destination")?;
    destination_file
        .sync_all()
        .map_err(|error| format!("sync promotion copy destination failed: {error}"))?;
    let destination_stat = stat_file(&destination_file)
        .map_err(|error| format!("fstat promotion copy destination failed: {error}"))?;
    let destination_path_stat = stat_at(destination_parent.as_raw_fd(), destination_name)
        .map_err(|error| format!("stat promotion copy destination failed: {error}"))?;
    if destination_stat != destination_path_stat || !destination_stat.is_file() {
        return Err(
            "promotion copy destination changed while writing; evidence retained".to_string(),
        );
    }
    source_parent
        .sync_all()
        .map_err(|error| format!("sync promotion copy source parent failed: {error}"))?;
    destination_parent
        .sync_all()
        .map_err(|error| format!("sync promotion copy destination parent failed: {error}"))?;
    // Do not re-open the destination by pathname for the returned evidence.
    // The descriptor remains the authority for the bytes and identity that
    // were copied; the final name check only proves it still names that fd.
    promotion_test_pause(req, "promotion-copy-final-observe")?;
    let final_descriptor = stat_file(&destination_file)
        .map_err(|error| format!("fstat promotion copy destination failed: {error}"))?;
    let final_path = stat_at(destination_parent.as_raw_fd(), destination_name)
        .map_err(|error| format!("stat promotion copy destination failed: {error}"))?;
    if final_descriptor != destination_stat
        || final_path != final_descriptor
        || !final_descriptor.is_file()
        || final_descriptor.len != bytes.len() as u64
    {
        return Err(
            "promotion copy destination changed during final observation; evidence retained"
                .to_string(),
        );
    }
    let observed = PromotionObservedLeaf {
        identity: PromotionIdentity {
            dev: final_descriptor.dev,
            ino: final_descriptor.ino,
        },
        state: PromotionObservedState::File {
            mode: final_descriptor.mode & 0o777,
            size: bytes.len() as u64,
            sha256: promotion_sha256_hex(&bytes),
        },
    };
    Ok(json!({ "result": { "leaf": promotion_leaf_result(&observed) } }))
}

/// Copy a complete directory tree between two already-bound roots.  The
/// destination must be empty; callers allocate it first and retain its
/// capability for the lifetime of the comparison.  Partial output is left in
/// place on failure so the owner can retain or remove it only after an
/// identity-bound teardown decision.
fn op_promotion_bound_copy_tree(req: &Value) -> Result<Value, String> {
    let (source_root, _source_identity, _source_capability) = open_promotion_bound_root(
        req,
        "sourceRoot",
        "sourceRootIdentity",
        "sourceRootCapability",
    )?;
    let (destination_root, _destination_identity, _destination_capability) =
        open_promotion_bound_root(
            req,
            "destinationRoot",
            "destinationRootIdentity",
            "destinationRootCapability",
        )?;
    promotion_test_pause(req, "promotion-copy-tree-roots-open")?;
    if !promotion_directory_is_empty(destination_root.as_raw_fd())? {
        return Err("promotion tree destination is not empty".to_string());
    }
    let max_bytes = req
        .get("maxBytes")
        .and_then(Value::as_u64)
        .unwrap_or(PROMOTION_COPY_TREE_MAX_BYTES);
    if max_bytes == 0 || max_bytes > PROMOTION_COPY_TREE_MAX_BYTES {
        return Err("promotion tree copy maxBytes exceeds its native budget".to_string());
    }
    let max_work_bytes = req
        .get("maxWorkBytes")
        .and_then(Value::as_u64)
        .unwrap_or(PROMOTION_COPY_TREE_MAX_WORK_BYTES);
    if max_work_bytes == 0 || max_work_bytes > PROMOTION_COPY_TREE_MAX_WORK_BYTES {
        return Err("promotion tree copy maxWorkBytes exceeds its native budget".to_string());
    }
    let mut budget = PromotionCopyBudget {
        bytes: 0,
        entries: 0,
        work_bytes: 0,
        max_bytes,
        max_entries: PROMOTION_COPY_TREE_MAX_ENTRIES,
        max_work_bytes,
    };
    promotion_copy_tree_contents(&source_root, &destination_root, &mut budget, "")?;
    source_root
        .sync_all()
        .map_err(|error| format!("sync promotion tree source failed: {error}"))?;
    destination_root
        .sync_all()
        .map_err(|error| format!("sync promotion tree destination failed: {error}"))?;
    promotion_test_pause(req, "promotion-copy-tree-final-observe")?;
    Ok(json!({
        "result": {
            "bytes": budget.bytes,
            "entries": budget.entries,
            "workBytes": budget.work_bytes,
        }
    }))
}

fn op_promotion_bound_create_symlink(req: &Value) -> Result<Value, String> {
    let (root, _root_identity, _capability) =
        open_promotion_bound_root(req, "root", "rootIdentity", "rootCapability")?;
    let components = promotion_components_for(req, "components")?;
    let parent = open_promotion_parent(&root, &components, "symlink")?;
    let parent_identity = promotion_identity_from_value(
        req.get("parentIdentity").ok_or("missing parentIdentity")?,
        "parentIdentity",
    )?;
    promotion_directory_identity_matches(&parent, parent_identity, "symlink parent")?;
    promotion_test_pause(req, "promotion-symlink-parent-open")?;
    let (_, leaf) = components.last().expect("non-empty components");
    if stat_at(parent.as_raw_fd(), leaf).is_ok() {
        return Err("promotion symlink destination is occupied".to_string());
    }
    let target = req
        .get("target")
        .and_then(Value::as_str)
        .ok_or("symlink target must be a string")?;
    if target.contains('\0') || target.len() > PROMOTION_PATH_MAX_BYTES {
        return Err("promotion symlink target is too long".to_string());
    }
    let requested_target = target.to_string();
    let target =
        CString::new(target).map_err(|_| "promotion symlink target contains NUL".to_string())?;
    promotion_symlink_at(&target, parent.as_raw_fd(), leaf)
        .map_err(|error| format!("create promotion symlink failed: {error}"))?;
    // Symlinks cannot be opened with a portable read descriptor on both
    // supported hosts.  Bind the created directory entry's identity and
    // requested target immediately, then require the final name to still
    // identify that exact object before reporting it to Electron.
    let created_identity = stat_at(parent.as_raw_fd(), leaf)
        .map_err(|error| format!("stat created promotion symlink failed: {error}"))?;
    if !created_identity.is_symlink() {
        return Err("promotion symlink changed type after creation".to_string());
    }
    let created_target = read_link_at(parent.as_raw_fd(), leaf)
        .map_err(|error| format!("read created promotion symlink failed: {error}"))?;
    if created_target != requested_target.as_bytes() {
        return Err("promotion symlink target changed after creation".to_string());
    }
    parent
        .sync_all()
        .map_err(|error| format!("sync promotion symlink parent failed: {error}"))?;
    promotion_test_pause(req, "promotion-symlink-final-observe")?;
    let final_identity = stat_at(parent.as_raw_fd(), leaf)
        .map_err(|error| format!("stat promotion symlink failed: {error}"))?;
    let final_target = read_link_at(parent.as_raw_fd(), leaf)
        .map_err(|error| format!("read promotion symlink failed: {error}"))?;
    if final_identity != created_identity || final_target != created_target {
        return Err(
            "promotion symlink changed during final observation; evidence retained".to_string(),
        );
    }
    let observed = PromotionObservedLeaf {
        identity: PromotionIdentity {
            dev: created_identity.dev,
            ino: created_identity.ino,
        },
        state: PromotionObservedState::Symlink {
            target: requested_target,
        },
    };
    Ok(json!({ "result": { "leaf": promotion_leaf_result(&observed) } }))
}

fn op_promotion_bound_install_directory(req: &Value) -> Result<Value, String> {
    let (source_root, _source_root_identity, _source_capability) = open_promotion_bound_root(
        req,
        "sourceRoot",
        "sourceRootIdentity",
        "sourceRootCapability",
    )?;
    let source_components = promotion_components_for(req, "sourceComponents")?;
    let source_parent =
        open_promotion_parent(&source_root, &source_components, "install directory source")?;
    let source_parent_identity = promotion_identity_from_value(
        req.get("sourceParentIdentity")
            .ok_or("missing sourceParentIdentity")?,
        "sourceParentIdentity",
    )?;
    promotion_directory_identity_matches(
        &source_parent,
        source_parent_identity,
        "install directory source parent",
    )?;
    let (destination_root, _destination_root_identity, _destination_capability) =
        open_promotion_bound_root(
            req,
            "destinationRoot",
            "destinationRootIdentity",
            "destinationRootCapability",
        )?;
    let destination_components = promotion_components_for(req, "destinationComponents")?;
    let destination_parent = open_promotion_parent(
        &destination_root,
        &destination_components,
        "install directory destination",
    )?;
    let destination_parent_identity = promotion_identity_from_value(
        req.get("destinationParentIdentity")
            .ok_or("missing destinationParentIdentity")?,
        "destinationParentIdentity",
    )?;
    promotion_directory_identity_matches(
        &destination_parent,
        destination_parent_identity,
        "install directory destination parent",
    )?;
    promotion_test_pause(req, "promotion-install-directory-parents-open")?;
    let (_, source_name) = source_components
        .last()
        .expect("non-empty source components");
    let (_, destination_name) = destination_components
        .last()
        .expect("non-empty destination components");
    let expected = promotion_expected_directory(
        req.get("expectedSource").ok_or("missing expectedSource")?,
        "expectedSource",
    )?;
    let source_stat = stat_at(source_parent.as_raw_fd(), source_name)
        .map_err(|error| format!("stat install directory source failed: {error}"))?;
    if !source_stat.is_dir()
        || source_stat.dev != expected.0.dev
        || source_stat.ino != expected.0.ino
        || source_stat.mode & 0o777 != expected.1
    {
        return Err("install directory source identity or type mismatch".to_string());
    }
    if stat_at(destination_parent.as_raw_fd(), destination_name).is_ok() {
        return Err("install directory destination is occupied".to_string());
    }
    promotion_test_pause(req, "promotion-install-directory-validated")?;
    promotion_rename_noreplace(
        source_parent.as_raw_fd(),
        source_name,
        destination_parent.as_raw_fd(),
        destination_name,
    )
    .map_err(|error| {
        if promotion_rename_unsupported(&error) {
            "promotion bound directory install is unsupported".to_string()
        } else {
            format!("promotion directory install failed: {error}")
        }
    })?;
    promotion_test_pause(req, "promotion-install-directory-syscall")?;
    let destination_stat = stat_at(destination_parent.as_raw_fd(), destination_name)
        .map_err(|error| format!("stat installed directory failed: {error}"))?;
    let source_gone = stat_at(source_parent.as_raw_fd(), source_name);
    if destination_stat.dev != expected.0.dev
        || destination_stat.ino != expected.0.ino
        || !destination_stat.is_dir()
        || source_gone.is_ok()
    {
        return Ok(json!({
            "result": {
                "outcome": "conflict-after-mutation",
                "durable": false,
                "error": "promotion directory install changed an operand after mutation"
            }
        }));
    }
    destination_parent
        .sync_all()
        .map_err(|error| format!("sync installed directory parent failed: {error}"))?;
    source_parent
        .sync_all()
        .map_err(|error| format!("sync source directory parent failed: {error}"))?;
    Ok(json!({
        "result": {
            "outcome": "applied",
            "durable": true,
            "error": null,
            "identity": { "dev": destination_stat.dev.to_string(), "ino": destination_stat.ino.to_string() }
        }
    }))
}

/// Validate a cleanup tree through descriptors without mutating it.  The
/// final cleanup operation moves the complete tree, so deleting individual
/// children is unnecessary and would reintroduce an inode check/use race.
/// Every observed child is nevertheless rechecked at the deterministic seam;
/// this keeps the existing leaf ABA probes meaningful and rejects a change
/// before the tree is moved.
fn validate_promotion_cleanup_tree(
    dir: &fs::File,
    req: &Value,
    relative: &str,
) -> Result<(usize, u64, u64), String> {
    let root =
        stat_file(dir).map_err(|error| format!("fstat cleanup tree {relative} failed: {error}"))?;
    if !root.is_dir() || root.is_symlink() {
        return Err(format!("cleanup tree {relative} is not a real directory"));
    }
    let mut entries = 1usize;
    let mut bytes = 0u64;
    let mut work_bytes = u64::try_from(relative.len())
        .map_err(|_| "cleanup tree work accounting overflow")?;
    promotion_add_work(
        &mut work_bytes,
        std::mem::size_of::<FileIdentity>() as u64,
        PROMOTION_DIRECTORY_MAX_NAME_BYTES,
        "promotion cleanup quarantine incoming tree",
    )?;
    let mut stack = Vec::with_capacity(PROMOTION_DIRECTORY_MAX_DEPTH);
    stack.push((
        dir.try_clone().map_err(|error| format!("clone cleanup tree failed: {error}"))?,
        PromotionDirectoryStream::open(dir.as_raw_fd())?,
        relative.to_string(),
    ));
    while !stack.is_empty() {
        let next = stack
            .last_mut()
            .expect("cleanup scan stack is not empty")
            .1
            .next_entry()?;
        let Some((name, c_name)) = next else {
            stack.pop();
            continue;
        };
        let current_relative = stack.last().expect("cleanup scan frame exists").2.clone();
        let path_work = promotion_path_work_bytes(&current_relative, &name)?;
        promotion_add_work(
            &mut work_bytes,
            path_work,
            PROMOTION_DIRECTORY_MAX_NAME_BYTES,
            "promotion cleanup quarantine incoming tree",
        )?;
        let child_relative = promotion_child_relative(&current_relative, &name)?;
        let directory = stack.last().expect("cleanup scan frame exists").0.as_raw_fd();
        let identity = match stat_at(directory, &c_name) {
            Ok(identity) => identity,
            Err(error) if missing_path(&error) => continue,
            Err(error) => {
                return Err(format!("stat cleanup entry {child_relative} failed: {error}"));
            }
        };
        entries = entries
            .checked_add(1)
            .ok_or("cleanup tree entry count overflow")?;
        if entries > PROMOTION_QUARANTINE_MAX_ENTRIES {
            return Err("promotion cleanup quarantine incoming tree exceeds its entry bound; resolve or export retained evidence before retrying".to_string());
        }
        if !identity.is_dir() && !identity.is_symlink() && !identity.is_file() {
            return Err(format!(
                "cleanup entry {child_relative} has unsupported type; evidence retained"
            ));
        }
        let logical_bytes = if identity.is_file() {
            identity.len
        } else if identity.is_symlink() {
            u64::try_from(
                read_link_at(directory, &c_name)
                    .map_err(|error| format!("read cleanup symlink {child_relative} failed: {error}"))?
                    .len(),
            )
            .map_err(|_| "cleanup symlink byte count overflow")?
        } else {
            0
        };
        bytes = bytes
            .checked_add(logical_bytes)
            .ok_or("cleanup tree byte count overflow")?;
        if bytes > PROMOTION_QUARANTINE_MAX_BYTES {
            return Err("promotion cleanup quarantine incoming tree exceeds its byte bound; resolve or export retained evidence before retrying".to_string());
        }
        promotion_test_pause(req, "promotion-cleanup-leaf-validated")?;
        let after_validation = stat_at(directory, &c_name)
            .map_err(|error| format!("stat cleanup entry {child_relative} failed: {error}"))?;
        if after_validation != identity {
            return Err(format!(
                "cleanup entry {child_relative} changed; evidence retained"
            ));
        }
        if identity.is_dir() && !identity.is_symlink() {
            if stack.len() >= PROMOTION_DIRECTORY_MAX_DEPTH {
                return Err("promotion cleanup quarantine incoming tree exceeds its depth bound; evidence retained".to_string());
            }
            let child = open_at(
                directory,
                &c_name,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|error| format!("open cleanup directory {child_relative} failed: {error}"))?;
            let child_identity = stat_file(&child).map_err(|error| {
                format!("fstat cleanup directory {child_relative} failed: {error}")
            })?;
            if !promotion_cleanup_same_namespace_identity(child_identity, identity) {
                return Err(format!(
                    "cleanup directory {child_relative} changed while opening; evidence retained"
                ));
            }
            let child_stream = PromotionDirectoryStream::open(child.as_raw_fd())?;
            stack.push((child, child_stream, child_relative));
        }
    }
    Ok((entries, bytes, work_bytes))
}

/// Return the number of entries and logical bytes already retained under one
/// quarantine container.  No symlink is followed.  Ambiguous or unsupported
/// evidence fails closed because this is the durable admission boundary.
fn promotion_quarantine_tree_usage(dir: &fs::File) -> Result<(usize, u64, u64), String> {
    let identity =
        stat_file(dir).map_err(|error| format!("fstat promotion quarantine failed: {error}"))?;
    if !identity.is_dir() || identity.is_symlink() {
        return Err("promotion quarantine container is not a real directory".to_string());
    }
    let mut entries = 0usize;
    let mut bytes = 0u64;
    let mut work_bytes = std::mem::size_of::<FileIdentity>() as u64;
    if work_bytes > PROMOTION_DIRECTORY_MAX_NAME_BYTES {
        return Err("promotion cleanup quarantine exceeds its work bound".to_string());
    }
    let mut stack = Vec::with_capacity(PROMOTION_DIRECTORY_MAX_DEPTH);
    stack.push((
        dir.try_clone().map_err(|error| format!("clone promotion quarantine failed: {error}"))?,
        PromotionDirectoryStream::open(dir.as_raw_fd())?,
        String::new(),
    ));
    while !stack.is_empty() {
        let next = stack
            .last_mut()
            .expect("quarantine scan stack is not empty")
            .1
            .next_entry()?;
        let Some((name, c_name)) = next else {
            stack.pop();
            continue;
        };
        let current_relative = stack.last().expect("quarantine scan frame exists").2.clone();
        let path_work = promotion_path_work_bytes(&current_relative, &name)?;
        promotion_add_work(
            &mut work_bytes,
            path_work,
            PROMOTION_DIRECTORY_MAX_NAME_BYTES,
            "promotion cleanup quarantine",
        )?;
        let child_relative = promotion_child_relative(&current_relative, &name)?;
        let directory = stack.last().expect("quarantine scan frame exists").0.as_raw_fd();
        let child_identity = stat_at(directory, &c_name)
            .map_err(|error| format!("stat promotion quarantine entry {child_relative} failed: {error}"))?;
        if !child_identity.is_dir() && !child_identity.is_symlink() && !child_identity.is_file() {
            return Err(format!(
                "promotion quarantine entry {child_relative} has unsupported type; resolve or export retained evidence before retrying"
            ));
        }
        entries = entries
            .checked_add(1)
            .ok_or("promotion quarantine entry count overflow")?;
        if entries > PROMOTION_QUARANTINE_MAX_ENTRIES {
            return Err("promotion cleanup quarantine is at its entry bound; resolve or export retained evidence before retrying".to_string());
        }
        let logical_bytes = if child_identity.is_file() {
            child_identity.len
        } else if child_identity.is_symlink() {
            u64::try_from(
                read_link_at(directory, &c_name)
                    .map_err(|error| format!("read promotion quarantine symlink {child_relative} failed: {error}"))?
                    .len(),
            )
            .map_err(|_| "promotion quarantine symlink byte count overflow")?
        } else {
            0
        };
        bytes = bytes
            .checked_add(logical_bytes)
            .ok_or("promotion quarantine byte count overflow")?;
        if bytes > PROMOTION_QUARANTINE_MAX_BYTES {
            return Err("promotion cleanup quarantine exceeds its byte bound; resolve or export retained evidence before retrying".to_string());
        }
        if child_identity.is_dir() && !child_identity.is_symlink() {
            if stack.len() >= PROMOTION_DIRECTORY_MAX_DEPTH {
                return Err("promotion cleanup quarantine exceeds its depth bound; resolve or export retained evidence before retrying".to_string());
            }
            let child = open_at(
                directory,
                &c_name,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|error| format!("open promotion quarantine entry {child_relative} failed: {error}"))?;
            let opened_identity = stat_file(&child)
                .map_err(|error| format!("fstat promotion quarantine entry {child_relative} failed: {error}"))?;
            if !promotion_cleanup_same_namespace_identity(opened_identity, child_identity) {
                return Err(format!("promotion quarantine entry {child_relative} changed while opening; resolve or export retained evidence before retrying"));
            }
            let child_stream = PromotionDirectoryStream::open(child.as_raw_fd())?;
            stack.push((child, child_stream, child_relative));
        }
    }
    Ok((entries, bytes, work_bytes))
}

/// Scan all app-created quarantine containers under the descriptor-bound
/// grandparent.  Containers are deliberately fresh: an existing pathname is
/// never accepted as a trust root, and the aggregate scan makes retention
/// bounded across process restarts.
struct PromotionQuarantineUsage {
    containers: usize,
    entries: usize,
    bytes: u64,
    work_bytes: u64,
    reusable: Option<(fs::File, CString)>,
}

fn promotion_quarantine_usage(grandparent: &fs::File) -> Result<PromotionQuarantineUsage, String> {
    let mut containers = 0usize;
    let mut entries = 0usize;
    let mut bytes = 0u64;
    let mut work_bytes = 0u64;
    let mut reusable = None;
    let mut scanned_entries = 0usize;
    let mut scanned_name_bytes = 0u64;
    let mut stream = PromotionDirectoryStream::open(grandparent.as_raw_fd())?;
    while let Some((name, c_name)) = stream.next_entry()? {
        scanned_entries = scanned_entries
            .checked_add(1)
            .ok_or("promotion quarantine directory entry count overflow")?;
        if scanned_entries > PROMOTION_DIRECTORY_MAX_ENTRIES {
            return Err("promotion cleanup quarantine scan exceeds its entry bound; resolve or export retained evidence before retrying".to_string());
        }
        scanned_name_bytes = scanned_name_bytes
            .checked_add(name.len() as u64)
            .ok_or("promotion quarantine directory name accounting overflow")?;
        if scanned_name_bytes > PROMOTION_DIRECTORY_MAX_NAME_BYTES {
            return Err("promotion cleanup quarantine scan exceeds its name-work bound; resolve or export retained evidence before retrying".to_string());
        }
        promotion_add_work(
            &mut work_bytes,
            u64::try_from(name.len())
                .map_err(|_| "promotion quarantine scan work accounting overflow")?
                .checked_add(std::mem::size_of::<FileIdentity>() as u64)
                .ok_or("promotion quarantine scan work accounting overflow")?,
            PROMOTION_DIRECTORY_MAX_NAME_BYTES,
            "promotion cleanup quarantine scan",
        )?;
        if !name.starts_with(PROMOTION_QUARANTINE_PREFIX) {
            continue;
        }
        let identity = stat_at(grandparent.as_raw_fd(), &c_name).map_err(|error| {
            format!("stat promotion quarantine container {name} failed: {error}")
        })?;
        if !identity.is_dir() || identity.is_symlink() {
            return Err(format!(
                "promotion quarantine container {name} is not a real directory"
            ));
        }
        containers = containers
            .checked_add(1)
            .ok_or("promotion quarantine container count overflow")?;
        if containers > PROMOTION_QUARANTINE_MAX_CONTAINERS {
            return Err("promotion cleanup quarantine is at its container bound; resolve or export retained evidence before retrying".to_string());
        }
        let container = open_at(
            grandparent.as_raw_fd(),
            &c_name,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
        .map_err(|error| format!("open promotion quarantine container {name} failed: {error}"))?;
        let (container_entries, container_bytes, container_work_bytes) =
            promotion_quarantine_tree_usage(&container)?;
        entries = entries
            .checked_add(container_entries)
            .ok_or("promotion quarantine entry count overflow")?;
        bytes = bytes
            .checked_add(container_bytes)
            .ok_or("promotion quarantine byte count overflow")?;
        work_bytes = work_bytes
            .checked_add(container_work_bytes)
            .ok_or("promotion quarantine work accounting overflow")?;
        if entries > PROMOTION_QUARANTINE_MAX_ENTRIES {
            return Err("promotion cleanup quarantine is at its entry bound; resolve or export retained evidence before retrying".to_string());
        }
        if bytes > PROMOTION_QUARANTINE_MAX_BYTES {
            return Err("promotion cleanup quarantine exceeds its byte bound; resolve or export retained evidence before retrying".to_string());
        }
        if work_bytes > PROMOTION_DIRECTORY_MAX_NAME_BYTES {
            return Err("promotion cleanup quarantine exceeds its work bound; resolve or export retained evidence before retrying".to_string());
        }
        if reusable.is_none() {
            reusable = Some((container, c_name));
        }
    }
    Ok(PromotionQuarantineUsage {
        containers,
        entries,
        bytes,
        work_bytes,
        reusable,
    })
}

/// Create a fresh durable quarantine container beside the bound source
/// parent.  The grandparent descriptor comes from an already identity-checked
/// parent, so no mutable absolute pathname is used for the container bind.
struct PromotionQuarantineReservation {
    grandparent: fs::File,
    quarantine_root: fs::File,
    _quarantine_name: CString,
}

impl Drop for PromotionQuarantineReservation {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.grandparent.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

fn create_promotion_quarantine_container(
    parent: &fs::File,
    expected_entries: usize,
    expected_bytes: u64,
    expected_work_bytes: u64,
) -> Result<PromotionQuarantineReservation, String> {
    let grandparent_name = CString::new("..").expect("parent component has no NUL");
    let grandparent = open_at(
        parent.as_raw_fd(),
        &grandparent_name,
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )
    .map_err(|error| format!("open promotion cleanup grandparent failed: {error}"))?;
    let lock_result = unsafe { libc::flock(grandparent.as_raw_fd(), libc::LOCK_EX) };
    if lock_result == -1 {
        return Err(format!(
            "lock promotion cleanup quarantine admission failed: {}",
            io::Error::last_os_error()
        ));
    }
    let usage = match promotion_quarantine_usage(&grandparent) {
        Ok(usage) => usage,
        Err(error) => return Err(error),
    };
    if expected_entries > PROMOTION_QUARANTINE_MAX_ENTRIES.saturating_sub(usage.entries)
        || expected_bytes > PROMOTION_QUARANTINE_MAX_BYTES.saturating_sub(usage.bytes)
        || expected_work_bytes > PROMOTION_DIRECTORY_MAX_NAME_BYTES.saturating_sub(usage.work_bytes)
    {
        return Err(format!(
            "promotion cleanup quarantine is full ({}/{} entries, {}/{} bytes, {}/{} work); resolve or export retained evidence before retrying",
            usage.entries,
            PROMOTION_QUARANTINE_MAX_ENTRIES,
            usage.bytes,
            PROMOTION_QUARANTINE_MAX_BYTES,
            usage.work_bytes,
            PROMOTION_DIRECTORY_MAX_NAME_BYTES,
        ));
    }
    // Reuse one already validated quarantine container when possible. The
    // object is still moved with the descriptor-bound rename below, while a
    // shared container keeps repeated explicit discard/reclamation from
    // exhausting the global 128-container bound after only 128 successful
    // proven-bundle removals.
    if let Some((quarantine_root, quarantine_name)) = usage.reusable {
        return Ok(PromotionQuarantineReservation {
            grandparent,
            quarantine_root,
            _quarantine_name: quarantine_name,
        });
    }
    if usage.containers >= PROMOTION_QUARANTINE_MAX_CONTAINERS {
        return Err(format!(
            "promotion cleanup quarantine is full ({}/{PROMOTION_QUARANTINE_MAX_CONTAINERS} containers); resolve or export retained evidence before retrying",
            usage.containers,
        ));
    }
    for _ in 0..64 {
        let sequence = PROMOTION_CLEANUP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let name = CString::new(format!("{PROMOTION_QUARANTINE_PREFIX}{sequence:016x}"))
            .expect("promotion quarantine container name has no NUL");
        match promotion_mkdir_at(grandparent.as_raw_fd(), &name, 0o700) {
            Ok(()) => {
                let container = open_at(
                    grandparent.as_raw_fd(),
                    &name,
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
                .map_err(|error| format!("open created promotion quarantine failed: {error}"))?;
                grandparent
                    .sync_all()
                    .map_err(|error| format!("sync promotion quarantine parent failed: {error}"))?;
                return Ok(PromotionQuarantineReservation {
                    grandparent,
                    quarantine_root: container,
                    _quarantine_name: name,
                });
            }
            Err(error) if error.raw_os_error() == Some(libc::EEXIST) => continue,
            Err(error) => return Err(format!("create promotion quarantine failed: {error}")),
        }
    }
    Err("could not allocate a unique promotion cleanup quarantine container".to_string())
}

fn op_promotion_bound_remove_tree(req: &Value) -> Result<Value, String> {
    let (root, root_identity, _capability) =
        open_promotion_bound_root(req, "root", "rootIdentity", "rootCapability")?;
    let components = promotion_components_for(req, "components")?;
    let parent = open_promotion_parent(&root, &components, "cleanup")?;
    let parent_identity = promotion_identity_from_value(
        req.get("parentIdentity").ok_or("missing parentIdentity")?,
        "parentIdentity",
    )?;
    promotion_directory_identity_matches(&parent, parent_identity, "cleanup parent")?;
    let (_, leaf) = components.last().expect("non-empty components");
    let expected = promotion_identity_from_value(
        req.get("expectedIdentity")
            .ok_or("missing expectedIdentity")?,
        "expectedIdentity",
    )?;
    // Bind either a directory tree or a regular-file/symlink leaf below the
    // already-bound parent.  Symlink leaves intentionally have no portable
    // read descriptor with O_NOFOLLOW, so their namespace identity is held by
    // fstatat and the final descriptor-relative rename instead.
    let observed_child = stat_at(parent.as_raw_fd(), leaf)
        .map_err(|error| format!("stat cleanup root failed: {error}"))?;
    let child = if observed_child.is_symlink() {
        None
    } else {
        Some(
            open_at(
                parent.as_raw_fd(),
                leaf,
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|error| format!("open cleanup root failed: {error}"))?,
        )
    };
    let child_identity = match &child {
        Some(child) => stat_file(child)
            .map_err(|error| format!("fstat cleanup root failed: {error}"))?,
        None => observed_child,
    };
    if (!child_identity.is_dir() && !child_identity.is_file() && !child_identity.is_symlink())
        || child_identity.dev != expected.dev
        || child_identity.ino != expected.ino
    {
        return Err("cleanup root identity mismatch".to_string());
    }
    promotion_test_pause(req, "promotion-cleanup-root-open")?;
    let after_open = stat_at(parent.as_raw_fd(), leaf)
        .map_err(|error| format!("stat cleanup root failed: {error}"))?;
    if (!after_open.is_dir() && !after_open.is_file() && !after_open.is_symlink())
        || after_open.dev != expected.dev
        || after_open.ino != expected.ino
        || after_open.file_type() != child_identity.file_type()
    {
        return Err("cleanup root changed; evidence retained".to_string());
    }
    promotion_test_pause(req, "promotion-cleanup-root-validated")?;
    let after_validation = stat_at(parent.as_raw_fd(), leaf)
        .map_err(|error| format!("stat cleanup root failed: {error}"))?;
    if after_validation != after_open {
        return Err("cleanup root changed; evidence retained".to_string());
    }
    // The descriptor pins the object that will be moved, but it does not by
    // itself prove that the caller's absolute root path still resolves
    // through the same ancestor chain.  Re-open the trusted path and compare
    // its final identity immediately before the mutation so an ancestor
    // rename/replacement cannot turn a bound cleanup into an unexpected
    // pathname operation.  The original object remains reachable through
    // `root` when this check fails.
    let requested_root = s(req, "root")?;
    let path_root = open_promotion_absolute_directory(&requested_root, "root")?;
    let path_root_identity = stat_file(&path_root)
        .map_err(|error| format!("fstat cleanup root path failed: {error}"))?;
    if path_root_identity.dev != root_identity.dev || path_root_identity.ino != root_identity.ino {
        return Err("cleanup root ancestry changed; evidence retained".to_string());
    }
    let (expected_entries, expected_bytes, expected_work_bytes) = if child_identity.is_dir() {
        validate_promotion_cleanup_tree(
            child.as_ref().expect("directory cleanup child is opened"),
            req,
            "cleanup root",
        )?
    } else {
        promotion_test_pause(req, "promotion-cleanup-leaf-validated")?;
        let after_leaf = stat_at(parent.as_raw_fd(), leaf)
            .map_err(|error| format!("stat cleanup root after validation failed: {error}"))?;
        if after_leaf != after_open {
            return Err("cleanup root changed; evidence retained".to_string());
        }
        let work = u64::try_from(components.last().expect("non-empty cleanup components").0.len())
            .map_err(|_| "cleanup root work accounting overflow")?
            .checked_add(std::mem::size_of::<FileIdentity>() as u64)
            .ok_or("cleanup root work accounting overflow")?;
        let bytes = if child_identity.is_symlink() {
            u64::try_from(
                read_link_at(parent.as_raw_fd(), leaf)
                    .map_err(|error| format!("read cleanup symlink failed: {error}"))?
                    .len(),
            )
            .map_err(|_| "cleanup symlink byte accounting overflow")?
        } else {
            child_identity.len
        };
        (1, bytes, work)
    };
    // Admission reserves the aggregate entry/byte budget while holding a
    // stable grandparent descriptor lock.  Keep that reservation alive until
    // the descriptor-bound no-replace rename and final validation complete;
    // any failed move drops the lock without deleting retained evidence.
    let reservation =
        create_promotion_quarantine_container(
            &parent,
            expected_entries,
            expected_bytes,
            expected_work_bytes,
        )?;
    let quarantine_root = &reservation.quarantine_root;
    // Revalidate the incoming object after admission has serialized against
    // other quarantine movers. If a writer changed the tree while the first
    // accounting pass was running, do not consume a reservation calculated
    // for the old shape; dropping the reservation leaves the source intact.
    let (rechecked_entries, rechecked_bytes, rechecked_work_bytes) = if child_identity.is_dir() {
        validate_promotion_cleanup_tree(
            child.as_ref().expect("directory cleanup child is opened"),
            req,
            "cleanup root",
        )?
    } else {
        let rechecked = match &child {
            Some(child) => stat_file(child)
                .map_err(|error| format!("fstat cleanup root after admission failed: {error}"))?,
            None => stat_at(parent.as_raw_fd(), leaf)
                .map_err(|error| format!("stat cleanup root after admission failed: {error}"))?,
        };
        let path_rechecked = stat_at(parent.as_raw_fd(), leaf)
            .map_err(|error| format!("stat cleanup root after admission failed: {error}"))?;
        if rechecked != child_identity || path_rechecked != after_open {
            return Err(
                "cleanup root changed during quarantine admission; evidence retained".to_string(),
            );
        }
        let work = u64::try_from(components.last().expect("non-empty cleanup components").0.len())
            .map_err(|_| "cleanup root work accounting overflow")?
            .checked_add(std::mem::size_of::<FileIdentity>() as u64)
            .ok_or("cleanup root work accounting overflow")?;
        let bytes = if child_identity.is_symlink() {
            u64::try_from(
                read_link_at(parent.as_raw_fd(), leaf)
                    .map_err(|error| format!("read cleanup symlink failed: {error}"))?
                    .len(),
            )
            .map_err(|_| "cleanup symlink byte accounting overflow")?
        } else {
            rechecked.len
        };
        (1, bytes, work)
    };
    if rechecked_entries != expected_entries
        || rechecked_bytes != expected_bytes
        || rechecked_work_bytes != expected_work_bytes
    {
        return Err(
            "cleanup root changed during quarantine admission; evidence retained".to_string(),
        );
    }
    let mut quarantine_name = None;
    // The core process can restart while the durable quarantine survives.
    // Include process-local entropy in the candidate and still handle an
    // adversarial collision with bounded noreplace retries; a process-reset
    // sequence alone would repeatedly collide with prior evidence.
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    for _ in 0..64 {
        let sequence = PROMOTION_CLEANUP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let candidate = CString::new(format!(
            ".termina-promotion-cleanup-root-{}-{nonce:032x}-{sequence:016x}.tmp",
            std::process::id(),
        ))
        .expect("cleanup root quarantine name has no NUL");
        match promotion_rename_noreplace(
            parent.as_raw_fd(),
            leaf,
            quarantine_root.as_raw_fd(),
            &candidate,
        ) {
            Ok(()) => {
                quarantine_name = Some(candidate);
                break;
            }
            Err(error) if error.raw_os_error() == Some(libc::EEXIST) => continue,
            Err(error) if promotion_rename_unsupported(&error) => {
                return Err("promotion cleanup quarantine is unsupported".to_string());
            }
            Err(error) => {
                return Err(format!(
                    "quarantine cleanup root failed: {error}; evidence retained"
                ));
            }
        }
    }
    let quarantine_name =
        quarantine_name.ok_or("could not allocate a cleanup root quarantine name")?;
    let moved = stat_at(quarantine_root.as_raw_fd(), &quarantine_name).map_err(|error| {
        format!("stat quarantined cleanup root failed: {error}; evidence retained")
    })?;
    if !promotion_cleanup_same_namespace_identity(moved, child_identity) {
        return Err("cleanup root changed during quarantine; evidence retained".to_string());
    }
    // This seam is intentionally after the final stat.  There is no unlink
    // after it: a replacement can only make the operation fail closed while
    // both the original and replacement remain durable evidence.
    promotion_test_pause(req, "promotion-cleanup-quarantine-final-stat")?;
    let after_final_stat =
        stat_at(quarantine_root.as_raw_fd(), &quarantine_name).map_err(|error| {
            format!("stat quarantined cleanup root failed: {error}; evidence retained")
        })?;
    if !promotion_cleanup_same_namespace_identity(after_final_stat, child_identity) {
        return Err("quarantined cleanup root changed; evidence retained".to_string());
    }
    // Re-scan while admission is still reserved.  This catches any
    // unexpected retained-tree growth before reporting success; the object
    // remains durable evidence and no cleanup unlink is attempted.
    promotion_quarantine_usage(&reservation.grandparent).map_err(|error| {
        format!("promotion cleanup quarantine changed during admission: {error}; evidence retained")
    })?;
    quarantine_root
        .sync_all()
        .map_err(|error| format!("sync promotion cleanup quarantine failed: {error}"))?;
    parent
        .sync_all()
        .map_err(|error| format!("sync cleanup parent failed: {error}"))?;
    Ok(json!({
        "result": {
            "removed": true,
            "retained": true,
            "quarantineName": quarantine_name.to_string_lossy(),
        }
    }))
}

fn op_promotion_bound_transition(req: &Value) -> Result<Value, String> {
    let (primary, _primary_identity, _primary_capability) = open_promotion_bound_root(
        req,
        "primaryRoot",
        "primaryRootIdentity",
        "primaryRootCapability",
    )?;
    let components = promotion_components(req)?;
    let parent_identity = promotion_identity_from_value(
        req.get("parentIdentity").ok_or("missing parentIdentity")?,
        "parentIdentity",
    )?;
    let destination_name = components
        .last()
        .ok_or("promotion destination is missing")?;
    let parent = open_promotion_parent(&primary, &components, "primary")?;
    promotion_directory_identity_matches(&parent, parent_identity, "promotion parent")?;
    promotion_test_pause(req, "primary-parent-open")?;

    let transition = req
        .get("transition")
        .and_then(Value::as_object)
        .ok_or("transition must be an object")?;
    let kind = transition
        .get("kind")
        .and_then(Value::as_str)
        .ok_or("transition.kind is missing")?;
    let destination = &destination_name.1;
    match kind {
        "exchange" => {
            let (source_name, source) = promotion_name(
                transition
                    .get("sourceName")
                    .ok_or("exchange sourceName is missing")?,
                "sourceName",
                ".termina-promotion-",
            )?;
            if source_name == destination_name.0 {
                return Err("promotion exchange source and destination must differ".to_string());
            }
            let expected_source = parse_promotion_expected(
                transition
                    .get("expectedSource")
                    .ok_or("exchange expectedSource is missing")?,
                "expectedSource",
            )?;
            let expected_destination = parse_promotion_expected(
                transition
                    .get("expectedDestination")
                    .ok_or("exchange expectedDestination is missing")?,
                "expectedDestination",
            )?;
            if expected_source.identity == expected_destination.identity {
                return Err("promotion exchange identities must differ".to_string());
            }
            let observed_source = observe_promotion_leaf(parent.as_raw_fd(), &source)?;
            let observed_destination = observe_promotion_leaf(parent.as_raw_fd(), destination)?;
            if !promotion_expected_matches(&expected_source, observed_source.as_ref())
                || !promotion_expected_matches(&expected_destination, observed_destination.as_ref())
            {
                return Err(format!(
                    "promotion exchange expected {} identities were not present",
                    promotion_expected_state_description(&expected_source),
                ));
            }
            promotion_test_pause(req, "promotion-leaf-validated")?;
            if let Err(error) = promotion_rename_exchange(
                parent.as_raw_fd(),
                &source,
                parent.as_raw_fd(),
                destination,
            ) {
                if promotion_rename_unsupported(&error) {
                    return Err("promotion bound rename mode is unsupported".to_string());
                }
                return Err(format!("promotion exchange failed: {error}"));
            }
            promotion_test_pause(req, "promotion-syscall")?;
            let post_destination = observe_promotion_leaf(parent.as_raw_fd(), destination);
            let post_source = observe_promotion_leaf(parent.as_raw_fd(), &source);
            let mut post_error = None;
            if !post_destination
                .as_ref()
                .ok()
                .and_then(|observed| observed.as_ref())
                .is_some_and(|observed| {
                    promotion_expected_matches(&expected_source, Some(observed))
                })
                || !post_source
                    .as_ref()
                    .ok()
                    .and_then(|observed| observed.as_ref())
                    .is_some_and(|observed| {
                        promotion_expected_matches(&expected_destination, Some(observed))
                    })
            {
                post_error =
                    Some("promotion exchange changed an operand after mutation".to_string());
            }
            if let Err(error) = parent.sync_all() {
                post_error = Some(format!("promotion parent durability failed: {error}"));
            }
            if let Some(error) = post_error {
                return Ok(promotion_transition_result(
                    "exchange",
                    "conflict-after-mutation",
                    false,
                    None,
                    Some(error),
                ));
            }
            Ok(promotion_transition_result(
                "exchange", "applied", true, None, None,
            ))
        }
        "install" => {
            let source_root_path = transition
                .get("sourceRoot")
                .and_then(Value::as_str)
                .ok_or("install sourceRoot is missing")?;
            let source_root_identity = promotion_identity_from_value(
                transition
                    .get("sourceRootIdentity")
                    .ok_or("install sourceRootIdentity is missing")?,
                "install sourceRootIdentity",
            )?;
            let source_root = open_promotion_bound_root_values(
                source_root_path,
                Some(source_root_identity),
                transition
                    .get("sourceRootCapability")
                    .and_then(Value::as_str),
                "install sourceRoot",
            )?
            .0;
            // Reuse the same strict component validation as destination paths
            // while keeping this source tree explicitly separate.
            let source_components = promotion_components_value(
                transition
                    .get("sourceComponents")
                    .ok_or("install sourceComponents is missing")?,
                "install sourceComponents",
            )?;
            let source_name = source_components
                .last()
                .ok_or("install sourceComponents is missing")?;
            let source_parent =
                open_promotion_parent(&source_root, &source_components, "install source")?;
            let source_parent_identity = promotion_identity_from_value(
                transition
                    .get("sourceParentIdentity")
                    .ok_or("install sourceParentIdentity is missing")?,
                "install sourceParentIdentity",
            )?;
            promotion_directory_identity_matches(
                &source_parent,
                source_parent_identity,
                "install source parent",
            )?;
            if source_parent_identity == parent_identity && source_name.0 == destination_name.0 {
                // Same names under equal identities identify one namespace
                // entry, never two independent install operands.
                return Err("promotion install source and destination must differ".to_string());
            }
            let expected_source = parse_promotion_expected(
                transition
                    .get("expectedSource")
                    .ok_or("install expectedSource is missing")?,
                "install expectedSource",
            )?;
            let expected_destination = parse_promotion_expected_destination(
                transition
                    .get("expectedDestination")
                    .ok_or("install expectedDestination is missing")?,
                "install expectedDestination",
            )?;
            if expected_destination
                .as_ref()
                .is_some_and(|expected| expected.identity == expected_source.identity)
            {
                return Err("promotion install identities must differ".to_string());
            }
            let observed_source =
                observe_promotion_leaf(source_parent.as_raw_fd(), &source_name.1)?;
            let observed_destination = observe_promotion_leaf(parent.as_raw_fd(), destination)?;
            if !promotion_expected_matches(&expected_source, observed_source.as_ref()) {
                return Err(format!(
                    "promotion install expected {} source identity was not present",
                    promotion_expected_state_description(&expected_source),
                ));
            }
            let destination_matches = match (&expected_destination, &observed_destination) {
                (None, None) => true,
                (Some(expected), Some(observed)) => {
                    promotion_expected_matches(expected, Some(observed))
                }
                _ => false,
            };
            if !destination_matches {
                return Err(
                    "promotion install expected destination state was not present".to_string(),
                );
            }
            promotion_test_pause(req, "promotion-leaf-validated")?;
            let rename_result = if expected_destination.is_some() {
                promotion_rename_exchange(
                    source_parent.as_raw_fd(),
                    &source_name.1,
                    parent.as_raw_fd(),
                    destination,
                )
            } else {
                promotion_rename_noreplace(
                    source_parent.as_raw_fd(),
                    &source_name.1,
                    parent.as_raw_fd(),
                    destination,
                )
            };
            if let Err(error) = rename_result {
                if promotion_rename_unsupported(&error) {
                    return Err("promotion bound rename mode is unsupported".to_string());
                }
                return Err(format!("promotion install failed: {error}"));
            }
            promotion_test_pause(req, "promotion-syscall")?;
            let post_destination = observe_promotion_leaf(parent.as_raw_fd(), destination);
            let post_source = observe_promotion_leaf(source_parent.as_raw_fd(), &source_name.1);
            let mut post_error = None;
            let destination_is_expected = post_destination
                .as_ref()
                .ok()
                .and_then(|observed| observed.as_ref())
                .is_some_and(|observed| {
                    promotion_expected_matches(&expected_source, Some(observed))
                });
            let source_is_expected = match &expected_destination {
                None => post_source
                    .as_ref()
                    .ok()
                    .and_then(|observed| observed.as_ref())
                    .is_none(),
                Some(expected) => post_source
                    .as_ref()
                    .ok()
                    .and_then(|observed| observed.as_ref())
                    .is_some_and(|observed| promotion_expected_matches(expected, Some(observed))),
            };
            if !destination_is_expected || !source_is_expected {
                post_error =
                    Some("promotion install changed an operand after mutation".to_string());
            }
            if let Err(error) = parent.sync_all() {
                post_error = Some(format!(
                    "promotion destination parent durability failed: {error}"
                ));
            }
            if let Err(error) = source_parent.sync_all() {
                post_error = Some(format!(
                    "promotion source parent durability failed: {error}"
                ));
            }
            if let Some(error) = post_error {
                return Ok(promotion_transition_result(
                    "install",
                    "conflict-after-mutation",
                    false,
                    None,
                    Some(error),
                ));
            }
            Ok(promotion_transition_result(
                "install", "applied", true, None, None,
            ))
        }
        "retire" => {
            let (retained_name, retained) = promotion_name(
                transition
                    .get("retainedName")
                    .ok_or("retire retainedName is missing")?,
                "retainedName",
                ".termina-promotion-retained-",
            )?;
            if retained_name == destination_name.0 {
                return Err(
                    "promotion retire retained and destination names must differ".to_string(),
                );
            }
            let external_retained_fields = [
                transition.get("retainedRoot"),
                transition.get("retainedRootIdentity"),
                transition.get("retainedComponents"),
                transition.get("retainedParentIdentity"),
            ];
            let external_retained = external_retained_fields.iter().any(Option::is_some);
            if external_retained && external_retained_fields.iter().any(Option::is_none) {
                return Err("promotion retire retained destination is incomplete".to_string());
            }
            let (retained_parent, retained) = if external_retained {
                let retained_root_path = transition
                    .get("retainedRoot")
                    .and_then(Value::as_str)
                    .ok_or("retire retainedRoot is missing")?;
                let retained_root_identity = promotion_identity_from_value(
                    transition
                        .get("retainedRootIdentity")
                        .ok_or("retire retainedRootIdentity is missing")?,
                    "retire retainedRootIdentity",
                )?;
                let retained_root = open_promotion_bound_root_values(
                    retained_root_path,
                    Some(retained_root_identity),
                    transition
                        .get("retainedRootCapability")
                        .and_then(Value::as_str),
                    "retire retainedRoot",
                )?
                .0;
                let retained_components = promotion_components_value(
                    transition
                        .get("retainedComponents")
                        .ok_or("retire retainedComponents is missing")?,
                    "retire retainedComponents",
                )?;
                let retained_leaf = retained_components
                    .last()
                    .ok_or("retire retainedComponents is missing")?;
                if retained_leaf.0 != retained_name {
                    return Err("retire retainedName does not match retainedComponents".to_string());
                }
                let retained_parent =
                    open_promotion_parent(&retained_root, &retained_components, "retire retained")?;
                let retained_parent_identity = promotion_identity_from_value(
                    transition
                        .get("retainedParentIdentity")
                        .ok_or("retire retainedParentIdentity is missing")?,
                    "retire retainedParentIdentity",
                )?;
                promotion_directory_identity_matches(
                    &retained_parent,
                    retained_parent_identity,
                    "retire retained parent",
                )?;
                (retained_parent, retained_leaf.1.clone())
            } else {
                (
                    parent.try_clone().map_err(|error| {
                        format!("clone promotion retire parent failed: {error}")
                    })?,
                    retained,
                )
            };
            let expected_destination = parse_promotion_expected(
                transition
                    .get("expectedDestination")
                    .ok_or("retire expectedDestination is missing")?,
                "expectedDestination",
            )?;
            let observed_destination = observe_promotion_leaf(parent.as_raw_fd(), destination)?;
            let observed_retained = observe_promotion_leaf(retained_parent.as_raw_fd(), &retained)?;
            if !promotion_expected_matches(&expected_destination, observed_destination.as_ref()) {
                return Err(format!(
                    "promotion retire expected {} identity was not present",
                    promotion_expected_state_description(&expected_destination),
                ));
            }
            if observed_retained.is_some() {
                return Err("promotion retire retained name is occupied".to_string());
            }
            promotion_test_pause(req, "promotion-leaf-validated")?;
            if let Err(error) = promotion_rename_noreplace(
                parent.as_raw_fd(),
                destination,
                retained_parent.as_raw_fd(),
                &retained,
            ) {
                if promotion_rename_unsupported(&error) {
                    return Err("promotion bound rename mode is unsupported".to_string());
                }
                return Err(format!("promotion retire failed: {error}"));
            }
            promotion_test_pause(req, "promotion-syscall")?;
            let post_destination = observe_promotion_leaf(parent.as_raw_fd(), destination);
            let post_retained = observe_promotion_leaf(retained_parent.as_raw_fd(), &retained);
            let mut post_error = None;
            if post_destination
                .as_ref()
                .ok()
                .and_then(|observed| observed.as_ref())
                .is_some()
                || !post_retained
                    .as_ref()
                    .ok()
                    .and_then(|observed| observed.as_ref())
                    .is_some_and(|observed| {
                        promotion_expected_matches(&expected_destination, Some(observed))
                    })
            {
                post_error = Some("promotion retire changed an operand after mutation".to_string());
            }
            if let Err(error) = parent.sync_all() {
                post_error = Some(format!("promotion parent durability failed: {error}"));
            }
            if let Err(error) = retained_parent.sync_all() {
                post_error = Some(format!(
                    "promotion retained parent durability failed: {error}"
                ));
            }
            if let Some(error) = post_error {
                return Ok(promotion_transition_result(
                    "retire",
                    "conflict-after-mutation",
                    false,
                    Some(&retained_name),
                    Some(error),
                ));
            }
            Ok(promotion_transition_result(
                "retire",
                "applied",
                true,
                Some(&retained_name),
                None,
            ))
        }
        _ => Err("unsupported promotion transition kind".to_string()),
    }
}

fn hook_matches(rel_path: &str, hook_path: &str) -> bool {
    rel_path == hook_path
        || (rel_path.len() > hook_path.len()
            && rel_path.ends_with(hook_path)
            && rel_path.as_bytes()[rel_path.len() - hook_path.len() - 1] == b'/')
}

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

fn op_store_create(req: &Value) -> Result<Value, String> {
    let store_dir = PathBuf::from(s(req, "storeDir")?);
    let source_git_dir = PathBuf::from(s(req, "sourceGitDir")?);
    let requested = object_format(&s(req, "objectFormat")?)?;
    let git_dir = store_dir.join("git");
    if let Ok(metadata) = fs::symlink_metadata(&store_dir)
        && !metadata.file_type().is_dir()
    {
        return Err("snapshot store path is not a real directory".to_string());
    }
    let mutation_lock = StoreMutationLock::acquire(&store_dir, req)?;
    if mutation_lock.was_contended() {
        return Err(
            "snapshot store changed while store-create waited for its mutation lock".to_string(),
        );
    }
    if let Ok(existing) = Repository::open_bare(&git_dir) {
        recover_store_transaction(&store_dir, &existing)?;
    }
    fs::create_dir_all(&store_dir).map_err(|e| e.to_string())?;
    let mut opts = RepositoryInitOptions::new();
    opts.bare(true).object_format(requested);
    let repo = Repository::init_opts(&git_dir, &opts)
        .map_err(|e| format!("snapshot store init failed: {e}"))?;
    // Disable gc: the store keeps objects that a gc run would prune.
    repo.config()
        .map_err(|e| e.to_string())?
        .set_bool("gc.auto", false)
        .map_err(|e| e.to_string())?;
    // A new app session has no in-memory run records. Remove refs left by a
    // crashed session before the first capture.
    let mut stale: Vec<String> = Vec::new();
    for glob in ["refs/termina/state/*", "refs/termina/merge/*"] {
        let refs = repo.references_glob(glob).map_err(|e| e.to_string())?;
        for reference in refs.flatten() {
            if let Ok(name) = reference.name() {
                stale.push(name.to_string());
            }
        }
    }
    for name in stale {
        if let Ok(reference) = repo.find_reference(&name) {
            let mut reference = reference;
            reference.delete().ok();
        }
    }
    // Read-only object access to the source repository.
    let alt_dir = git_dir.join("objects").join("info");
    fs::create_dir_all(&alt_dir).map_err(|e| e.to_string())?;
    fs::write(
        alt_dir.join("alternates"),
        format!("{}\n", source_git_dir.join("objects").display()),
    )
    .map_err(|e| e.to_string())?;
    let generation = fresh_store_generation()?;
    write_store_generation(&store_dir, &generation)?;
    pause_at_hook(req, "pauseAfterStoreGeneration")?;
    let lifecycle = current_store_lifecycle(&store_dir)?;
    Ok(lifecycle_json(&lifecycle))
}

fn op_store_destroy(req: &Value) -> Result<Value, String> {
    let store_dir = PathBuf::from(s(req, "storeDir")?);
    let _mutation_lock = StoreMutationLock::acquire(&store_dir, req)?;
    let metadata = match fs::symlink_metadata(&store_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(json!({})),
        Err(error) => return Err(format!("inspect snapshot store failed: {error}")),
    };
    if !metadata.file_type().is_dir() {
        return Err("not a valid snapshot store: store path is not a real directory".to_string());
    }
    let git_dir = store_dir.join("git");
    let git_metadata = fs::symlink_metadata(&git_dir).map_err(|error| {
        format!("not a valid snapshot store: inspect git directory failed: {error}")
    })?;
    if !git_metadata.file_type().is_dir() {
        return Err("not a valid snapshot store: git path is not a real directory".to_string());
    }
    let store = open_store(&store_dir, req)
        .map_err(|error| format!("not a valid snapshot store: {error}"))?;
    recover_store_transaction(&store_dir, &store)?;
    drop(store);
    let lifecycle = validate_store_lifecycle(&store_dir, req)?;
    // Bind the parent and store root through descriptors before the final
    // lifecycle check.  The old pathname-only `rename`/`remove_dir_all`
    // sequence could destroy a replacement installed after validation.
    let parent = store_dir
        .parent()
        .ok_or("snapshot store has no parent directory")?;
    let name = store_dir
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("snapshot store name is not valid UTF-8")?;
    let parent_file = open_absolute_directory_nofollow(parent, "snapshot store parent")?;
    let parent_node = store_node_file(&parent_file, "snapshot store parent")?;
    let store_name = CString::new(name)
        .map_err(|_| "snapshot store name contains NUL".to_string())?;
    let store_root = open_at(
        parent_file.as_raw_fd(),
        &store_name,
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )
    .map_err(|error| format!("open snapshot store root failed: {error}"))?;
    let store_node = store_node_file(&store_root, "snapshot store root")?;
    if !store_node_matches(
        store_node,
        StoreNodeIdentity {
            identity: lifecycle.identity,
            file_type: libc::S_IFDIR as u32,
            links: store_node.links,
        },
    ) {
        return Err("snapshot store root identity changed before destroy".to_string());
    }
    let bound_lifecycle = store_lifecycle_at_root(&store_root)?;
    if bound_lifecycle != lifecycle {
        return Err(lifecycle_mismatch(&lifecycle, &bound_lifecycle));
    }

    // Every check below is descriptor-relative.  Re-opening the public path
    // is used only as a provenance assertion: if an ancestor, the public
    // leaf, a hard-link count, or any lifecycle child changed, destroy fails
    // closed and leaves all names/objects in place.
    let validate_destroy_commit = || -> Result<(), String> {
        let current_parent = open_absolute_directory_nofollow(parent, "snapshot store parent")?;
        let current_parent_node = store_node_file(&current_parent, "snapshot store parent")?;
        if !store_node_matches(current_parent_node, parent_node) {
            return Err("snapshot store parent identity or link count changed; destroy retained".to_string());
        }
        let public_node = store_node_at(
            current_parent.as_raw_fd(),
            &store_name,
            "snapshot store public root",
        )?;
        if !store_node_matches(public_node, store_node) {
            return Err("snapshot store public root identity or link count changed; destroy retained".to_string());
        }
        let descriptor_lifecycle = store_lifecycle_at_root(&store_root)?;
        if descriptor_lifecycle != lifecycle {
            return Err(lifecycle_mismatch(&lifecycle, &descriptor_lifecycle));
        }
        Ok(())
    };
    pause_at_hook(req, "pauseBeforeStoreDestroyRename")?;
    validate_destroy_commit()?;

    // Move the exact validated directory with a descriptor-relative
    // no-replace rename.  The quarantine stays under the held parent; no
    // ancestor pathname is resolved after this point.
    let mut quarantine_name = None;
    for _ in 0..64 {
        let sequence = STORE_DESTROY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let candidate = CString::new(format!(
            ".{name}.termina-destroy-{}-{sequence}",
            std::process::id()
        ))
        .expect("snapshot store quarantine name has no NUL");
        match promotion_rename_noreplace(
            parent_file.as_raw_fd(),
            &store_name,
            parent_file.as_raw_fd(),
            &candidate,
        ) {
            Ok(()) => {
                quarantine_name = Some(candidate);
                break;
            }
            Err(error) if error.raw_os_error() == Some(libc::EEXIST) => continue,
            Err(error) if promotion_rename_unsupported(&error) => {
                return Err("destroy snapshot store quarantine is unsupported".to_string());
            }
            Err(error) => {
                return Err(format!(
                    "destroy snapshot store quarantine failed: {error}; store retained"
                ));
            }
        }
    }
    let quarantine_name = quarantine_name
        .ok_or("could not allocate a snapshot store destroy quarantine name")?;
    let quarantined_node = store_node_at(
        parent_file.as_raw_fd(),
        &quarantine_name,
        "snapshot store quarantine",
    )?;
    if !store_node_matches(quarantined_node, store_node) {
        return Err("snapshot store quarantine identity changed; store retained".to_string());
    }
    let quarantined_lifecycle = store_lifecycle_at_root(&store_root)?;
    if quarantined_lifecycle != lifecycle {
        return Err(lifecycle_mismatch(&lifecycle, &quarantined_lifecycle));
    }
    parent_file
        .sync_all()
        .map_err(|error| format!("sync snapshot store quarantine parent failed: {error}"))?;

    // The rename is descriptor-relative, but a non-cooperating actor may
    // still replace the public ancestor or recreate the public leaf while
    // the quarantined tree is being inspected.  Keep the quarantine as
    // durable evidence and fail closed if the public provenance no longer
    // describes the operation that was just claimed.
    let validate_destroy_quarantine_commit = || -> Result<(), String> {
        let current_parent = open_absolute_directory_nofollow(parent, "snapshot store parent")?;
        let current_parent_node = store_node_file(&current_parent, "snapshot store parent")?;
        if !store_node_matches(current_parent_node, parent_node) {
            return Err("snapshot store parent changed after destroy claim; store retained".to_string());
        }
        match store_node_at_optional(
            current_parent.as_raw_fd(),
            &store_name,
            "snapshot store public root",
        )? {
            Some(_) => Err("snapshot store public root was replaced after destroy claim; store retained".to_string()),
            None => Ok(()),
        }
    };
    validate_destroy_quarantine_commit()?;
    pause_at_hook(req, "pauseAfterStoreDestroyRename")?;
    validate_destroy_quarantine_commit()?;

    // Recursive cleanup is also descriptor-relative.  A replacement at the
    // public pathname is never inspected or removed; an uncertain quarantine
    // remains durable evidence and the request fails closed.
    promotion_remove_tree_contents(&store_root, req, "snapshot store quarantine")?;
    if !promotion_directory_is_empty(store_root.as_raw_fd())? {
        return Err("snapshot store quarantine is not empty; store retained".to_string());
    }
    let final_quarantine = store_node_at(
        parent_file.as_raw_fd(),
        &quarantine_name,
        "snapshot store quarantine",
    )?;
    // Removing the quarantine's child directories legitimately changes its
    // directory link count.  Its exact link count was already checked at the
    // rename/claim boundary above; at this post-cleanup point retain the
    // stronger immutable identity and type check without treating expected
    // recursive unlinking as an ABA.
    if final_quarantine.identity != store_node.identity
        || final_quarantine.file_type != store_node.file_type
    {
        return Err("snapshot store quarantine changed during cleanup; store retained".to_string());
    }
    validate_destroy_quarantine_commit()?;
    promotion_unlink_at_field(
        parent_file.as_raw_fd(),
        &quarantine_name,
        true,
        "snapshot store quarantine",
    )?;
    parent_file
        .sync_all()
        .map_err(|error| format!("sync destroyed snapshot store parent failed: {error}"))?;
    let mut result = lifecycle_json(&lifecycle);
    if let Some(object) = result.as_object_mut() {
        object.insert("destroyed".to_string(), Value::Bool(true));
    }
    Ok(result)
}

// ------------------------------------------------------------ preflight ----

/// True when the attributes text contains a content-transforming pattern.
/// Git LFS `filter=lfs` is not a transform here: capture hashes working-tree
/// bytes, so pointer files and smudged files both round-trip.
fn has_transform_attr(text: &str) -> bool {
    const WORDS: [&str; 6] = [
        "filter",
        "eol",
        "working-tree-encoding",
        "ident",
        "text",
        "export-subst",
    ];
    for line in text.lines() {
        for token in line.split_whitespace() {
            let lower = token.to_ascii_lowercase();
            if lower == "filter=lfs" || lower.starts_with("filter=lfs,") || lower == "-filter=lfs" {
                continue;
            }
            if WORDS
                .iter()
                .any(|word| token == *word || token.starts_with(&format!("{word}=")))
            {
                return true;
            }
        }
    }
    false
}

/// True when `name` is a Git LFS config key (`filter.lfs.*`, `diff.lfs.*`).
fn is_lfs_config_key(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains(".lfs.") || lower.ends_with(".lfs")
}

/// True when a non-LFS config key under `section` ends with `suffix`
/// (for example `diff.tool.command` or `merge.ours.driver`).
fn config_has_driver(config: &git2::Config, section: &str, suffix: &str) -> bool {
    let glob = format!("{section}.*");
    let Ok(mut entries) = config.entries(Some(&glob)) else {
        return false;
    };
    let needle = format!(".{suffix}");
    while let Some(entry) = entries.next() {
        let Ok(entry) = entry else { continue };
        let Ok(name) = entry.name() else { continue };
        if is_lfs_config_key(name) {
            continue;
        }
        if name.to_ascii_lowercase().ends_with(&needle) {
            return true;
        }
    }
    false
}

/// True when any non-LFS `filter.*` key exists (a real clean/smudge filter).
fn config_has_non_lfs_filter(config: &git2::Config) -> bool {
    let Ok(mut entries) = config.entries(Some("filter.*")) else {
        return false;
    };
    while let Some(entry) = entries.next() {
        let Ok(entry) = entry else { continue };
        let Ok(name) = entry.name() else { continue };
        if !is_lfs_config_key(name) {
            return true;
        }
    }
    false
}

fn op_preflight(req: &Value) -> Result<Value, String> {
    let source_root = PathBuf::from(s(req, "sourceRoot")?);
    let source_git_dir = PathBuf::from(s(req, "sourceGitDir")?);
    let worlds_root = opt_s(req, "worldsRoot").map(PathBuf::from);
    let mut reasons: Vec<String> = Vec::new();

    let repo = match open_repo(&source_root) {
        Ok(repo) => repo,
        Err(_) => {
            reasons.push("the opened folder is not inside a Git repository".to_string());
            return Ok(json!({ "result": { "ok": false, "reasons": reasons } }));
        }
    };
    let cwd_canon = fs::canonicalize(&source_root).unwrap_or_else(|_| source_root.clone());
    if repo.workdir().is_none() {
        reasons.push("the opened folder is not inside a Git repository".to_string());
    }
    if let Some(worlds) = &worlds_root {
        // Compare canonical forms: macOS reports /tmp and /private/tmp for
        // the same directory.
        let worlds_canon = fs::canonicalize(worlds).unwrap_or_else(|_| worlds.clone());
        if cwd_canon == worlds_canon || cwd_canon.starts_with(&worlds_canon) {
            reasons.push("the opened folder is inside the app-owned worlds root".to_string());
        }
    }

    // Active merge/rebase/cherry-pick/revert state.
    for (marker, label) in [
        ("MERGE_HEAD", "merge-head"),
        ("CHERRY_PICK_HEAD", "cherry-pick-head"),
        ("REVERT_HEAD", "revert-head"),
        ("BISECT_LOG", "bisect-log"),
    ] {
        if source_git_dir.join(marker).exists() {
            reasons.push(format!("the repository has an active {label} operation"));
        }
    }
    if source_git_dir.join("rebase-merge").exists() || source_git_dir.join("rebase-apply").exists()
    {
        reasons.push("the repository has an active rebase".to_string());
    }

    let index = repo.index().map_err(|e| e.to_string())?;
    // Unresolved index entries (unmerged paths).
    if index.has_conflicts() {
        reasons.push("the repository has unresolved index entries".to_string());
    }
    // Submodules and gitlinks in the index.
    if index.iter().any(|entry| entry.mode == 0o160000) {
        reasons.push("the project contains a submodule".to_string());
    }
    let config = repo.config().map_err(|e| e.to_string())?;
    // Sparse checkout and partial clones.
    if let Ok(value) = config.get_string("core.sparseCheckout")
        && value.trim() != "false"
    {
        reasons.push("a sparse checkout is active".to_string());
    }
    if config.get_string("extensions.partialClone").is_ok() {
        reasons.push("a partial clone is active".to_string());
    }
    // A source object alternate in the user's repository.
    if source_git_dir
        .join("objects")
        .join("info")
        .join("alternates")
        .exists()
    {
        reasons.push("a source object alternate is active".to_string());
    }
    // Content-transforming settings that break byte-exact materialization.
    if let Ok(value) = config.get_string("core.autocrlf")
        && value.trim() != "false"
    {
        reasons.push("core.autocrlf is not false".to_string());
    }
    if let Ok(value) = config.get_string("core.eol")
        && value.trim() != "native"
    {
        reasons.push("core.eol is configured".to_string());
    }
    if config_has_non_lfs_filter(&config) {
        reasons.push("a Git clean/smudge filter is configured".to_string());
    }
    if config_has_driver(&config, "diff", "command")
        || config_has_driver(&config, "diff", "textconv")
    {
        reasons.push("a custom diff driver is configured".to_string());
    }
    if config_has_driver(&config, "merge", "driver") {
        reasons.push("a custom merge driver is configured".to_string());
    }

    // Transform-bearing attributes in any tracked .gitattributes file.
    let attr_files: Vec<String> = index
        .iter()
        .filter_map(|entry| {
            let path = String::from_utf8_lossy(&entry.path).into_owned();
            if path.rsplit('/').next() == Some(".gitattributes") {
                Some(path)
            } else {
                None
            }
        })
        .collect();
    for attr in attr_files {
        let attr_root = repo.workdir().unwrap_or(source_root.as_path());
        let content = match fs::read_to_string(attr_root.join(&attr)) {
            Ok(content) => content,
            Err(_) => continue, // unreadable attributes file — leave as-is
        };
        if has_transform_attr(&content) {
            reasons.push("a .gitattributes file contains content-transforming entries".to_string());
            break;
        }
    }
    Ok(json!({ "result": { "ok": reasons.is_empty(), "reasons": reasons } }))
}

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
