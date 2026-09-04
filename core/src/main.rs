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

use std::collections::{HashMap, HashSet};
use std::ffi::{CStr, CString};
use std::fs;
use std::io::{self, BufRead, Read, Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use git2::{
    ErrorCode, IndexAddOption, IndexEntry, ObjectFormat, Oid, Repository, RepositoryInitOptions,
    RepositoryOpenFlags, Signature, StatusOptions,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha1::Sha1;
use sha2::{Digest, Sha256};

/// The trust-hash walk stops after this many files.
const TRUST_MAX_FILES: usize = 10_000;
/// The trust-hash walk stops after this many bytes.
const TRUST_MAX_BYTES: u64 = 64 * 1024 * 1024;
/// Trust files larger than this are skipped.
const TRUST_MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// The default capture budgets (WORLDLINES section 9).
const BUDGET_MAX_PATHS: usize = 100_000;
const BUDGET_MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
/// A raw blob delivered in a base64 JSON response must stay below the
/// CoreClient's bounded stdout line buffer. This is intentionally separate
/// from the 64 MiB capture-file budget.
const READ_BLOB_MAX_BYTES: u64 = 47 * 1024 * 1024;
const BUDGET_MAX_NEW_BLOB_BYTES: u64 = 256 * 1024 * 1024;
/// Maximum journal bytes returned by the descriptor-bound promotion read.
/// Promotion policy remains in Electron; core only authenticates the file
/// descriptor and returns bounded raw bytes.
const PROMOTION_JOURNAL_MAX_BYTES: u64 = 16 * 1024 * 1024;
const PROMOTION_PATH_MAX_BYTES: usize = 4_096;
const PROMOTION_COMPONENT_MAX_BYTES: usize = 255;
const PROMOTION_COMPONENT_ARRAY_MAX_ENTRIES: usize = 256;
const PROMOTION_COMPONENT_ARRAY_MAX_NAME_BYTES: usize = 128 * 1024;
/// Descriptor-bound tree copies are used to populate comparison templates and
/// candidates.  Keep the native copy envelope finite even when a caller
/// supplies a runtime directory rather than a captured state.
const PROMOTION_COPY_TREE_MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const PROMOTION_COPY_TREE_MAX_ENTRIES: usize = 1_000_000;
const PROMOTION_COPY_TREE_MAX_WORK_BYTES: u64 = 128 * 1024 * 1024;
/// Every native promotion directory collector has an explicit envelope. The
/// collector checks both limits before pushing another name, so a hostile
/// directory cannot force an unbounded allocation even on paths that sort or
/// revisit entries.
const PROMOTION_DIRECTORY_MAX_ENTRIES: usize = PROMOTION_COPY_TREE_MAX_ENTRIES;
const PROMOTION_DIRECTORY_MAX_NAME_BYTES: u64 = 128 * 1024 * 1024;
const PROMOTION_DIRECTORY_MAX_DEPTH: usize = 64;
/// Startup recovery only needs the bounded journal-root envelope. Keep this
/// stricter than the general copy collector so an oversized adjacent root is
/// rejected before any response array is materialized.
const PROMOTION_RECOVERY_ROOT_MAX_ENTRIES: usize = 128;
/// The retained-session root binder is deliberately stricter than the
/// general promotion directory helper. It validates the complete legacy
/// retained shape while the parent and leaf descriptors are still held.
const RETAINED_ROOT_MAX_ENTRIES: usize = 128 * 4;
const RETAINED_ROOT_MAX_SCAN_ENTRIES: usize = 250_000;
const RETAINED_ROOT_MAX_SCAN_DEPTH: usize = 64;
const RETAINED_ROOT_MAX_SCAN_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const RETAINED_ROOT_MAX_SCAN_WORK_BYTES: u64 = 128 * 1024 * 1024;
const RETAINED_ROOT_MARKER_MAX_BYTES: usize = 128;
const RETAINED_ROOT_PROVENANCE_MAX_BYTES: usize = 4096;
/// Darwin and Linux have no inode-conditional unlinkat.  Cleanup therefore
/// retains each quarantined object in a fresh descriptor-bound container.  A
/// durable cap keeps a sequence of failed/uncertain cleanups from becoming an
/// unbounded disk sink; the caller must resolve or export evidence before the
/// cap is reached.
const PROMOTION_QUARANTINE_MAX_CONTAINERS: usize = 128;
const PROMOTION_QUARANTINE_MAX_ENTRIES: usize = 250_000;
const PROMOTION_QUARANTINE_MAX_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const PROMOTION_QUARANTINE_PREFIX: &str = ".termina-promotion-quarantine-";
/// Unref prunes loose objects only past this many files. Small stores skip
/// the reachability walk.
const PRUNE_LOOSE_THRESHOLD: u64 = 20_000;
/// Cached tree maps kept across requests. Captures chain parent to child,
/// so the parent map of the next request is usually the one just built.
const TREE_MAP_CACHE_SIZE: usize = 8;
/// Loose-object compression level. The format matches Git at every level;
/// the fast level cuts capture CPU on the hot path.
const BLOB_COMPRESSION: flate2::Compression = flate2::Compression::fast();
/// A burst of unrefs shares one prune: the walk does not rerun inside this
/// many seconds.
const PRUNE_MIN_INTERVAL_SECS: u64 = 60;
const STORE_TRANSACTION_VERSION: u32 = 1;
const STORE_TRANSACTION_FILE: &str = "termina-object-transaction.json";
const STORE_TRANSACTION_DIR: &str = "termina-object-transaction";
/// Durable per-session identity for the app-owned snapshot store.  The
/// sibling mutation lock survives store deletion, so the marker must live in
/// the store itself and change on every store-create.
const STORE_GENERATION_FILE: &str = "termina-store-generation";
const STORE_GENERATION_HEX_BYTES: usize = 64;
/// Publish large captures in bounded groups while keeping common captures to
/// one blob/tree group plus the final commit. Directory durability work is
/// per group, never per object.
const STORE_OBJECT_BATCH_SIZE: usize = 4_096;
static PROMOTION_CLEANUP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static STORE_DESTROY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn s(v: &Value, key: &str) -> Result<String, String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(String::from)
        .ok_or_else(|| format!("missing field {key}"))
}

fn opt_s(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(String::from)
}

/// The before-read test seams of a capture request.
fn before_read_hooks(req: &Value) -> Vec<(String, String, bool)> {
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
fn after_cache_hooks(req: &Value) -> Vec<(String, String, bool)> {
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

fn oid_ext(repo: &Repository, value: &str) -> Result<Oid, String> {
    Oid::from_str_ext(value, repo.object_format()).map_err(|e| format!("invalid oid {value}: {e}"))
}

fn object_format(value: &str) -> Result<ObjectFormat, String> {
    match value {
        "sha1" => Ok(ObjectFormat::Sha1),
        "sha256" => Ok(ObjectFormat::Sha256),
        other => Err(format!("unsupported object format: {other}")),
    }
}

/// The hash of an object for the store's object format.
fn object_oid(repo: &Repository, kind: &str, content: &[u8]) -> Oid {
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
fn loose_path(repo: &Repository, oid: Oid) -> Option<PathBuf> {
    let hex = oid.to_string();
    if hex.len() < 3 {
        return None;
    }
    Some(repo.path().join("objects").join(&hex[0..2]).join(&hex[2..]))
}

fn store_lock_path(store_dir: &Path) -> Result<PathBuf, String> {
    let parent = store_dir
        .parent()
        .ok_or("snapshot store has no parent directory")?;
    let name = store_dir
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("snapshot store name is not valid UTF-8")?;
    Ok(parent.join(format!(".{name}.termina-store.lock")))
}

fn write_lock_attempt_marker(req: &Value) -> Result<(), String> {
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
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct StoreIdentity {
    dev: u64,
    ino: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct StoreLifecycle {
    generation: String,
    identity: StoreIdentity,
    /// The bare repository and its stable mutable subdirectories are part of
    /// the same lifecycle.  The root generation alone cannot distinguish a
    /// child-Git replacement at the unchanged store pathname.
    git: StoreGitLayout,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct StoreGitLayout {
    git: StoreIdentity,
    objects: StoreIdentity,
    objects_info: StoreIdentity,
    objects_pack: StoreIdentity,
    refs: StoreIdentity,
    refs_heads: StoreIdentity,
    refs_tags: StoreIdentity,
}

/// Identity used by store-destroy's commit boundary.  Directory mtime is
/// intentionally excluded from equality: Git mutates child entries while the
/// store remains the same object.  Link count is retained separately because
/// a same-inode hard-link/namespace change must not pass the final admission.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct StoreNodeIdentity {
    identity: StoreIdentity,
    file_type: u32,
    links: u64,
}

fn store_node_from_stat(identity: FileIdentity, links: u64, label: &str) -> Result<StoreNodeIdentity, String> {
    if !identity.is_dir() {
        return Err(format!("{label} is not a real directory"));
    }
    Ok(StoreNodeIdentity {
        identity: StoreIdentity {
            dev: identity.dev,
            ino: identity.ino,
        },
        file_type: identity.file_type(),
        links,
    })
}

fn store_node_at(parent: RawFd, name: &CStr, label: &str) -> Result<StoreNodeIdentity, String> {
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
        return Err(format!(
            "inspect {label} failed: {}",
            io::Error::last_os_error()
        ));
    }
    let st = unsafe { st.assume_init() };
    store_node_from_stat(FileIdentity::from_stat(&st), st.st_nlink as u64, label)
}

fn store_node_at_optional(
    parent: RawFd,
    name: &CStr,
    label: &str,
) -> Result<Option<StoreNodeIdentity>, String> {
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
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::NotFound {
            return Ok(None);
        }
        return Err(format!(
            "inspect {label} failed: {error}"
        ));
    }
    let st = unsafe { st.assume_init() };
    Ok(Some(store_node_from_stat(
        FileIdentity::from_stat(&st),
        st.st_nlink as u64,
        label,
    )?))
}

fn store_node_file(file: &fs::File, label: &str) -> Result<StoreNodeIdentity, String> {
    let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
    let rc = unsafe { libc::fstat(file.as_raw_fd(), st.as_mut_ptr()) };
    if rc == -1 {
        return Err(format!(
            "fstat {label} failed: {}",
            io::Error::last_os_error()
        ));
    }
    let st = unsafe { st.assume_init() };
    store_node_from_stat(FileIdentity::from_stat(&st), st.st_nlink as u64, label)
}

fn store_node_matches(left: StoreNodeIdentity, right: StoreNodeIdentity) -> bool {
    left.identity == right.identity
        && left.file_type == right.file_type
        && left.links == right.links
}

fn store_generation_path(store_dir: &Path) -> PathBuf {
    store_dir.join(STORE_GENERATION_FILE)
}

fn store_identity_at(store_dir: &Path) -> Result<StoreIdentity, String> {
    let metadata = fs::symlink_metadata(store_dir)
        .map_err(|error| format!("inspect snapshot store identity failed: {error}"))?;
    if !metadata.file_type().is_dir() {
        return Err("snapshot store path is not a real directory".to_string());
    }
    Ok(StoreIdentity {
        dev: metadata.dev(),
        ino: metadata.ino(),
    })
}

fn store_directory_identity(path: &Path, label: &str) -> Result<StoreIdentity, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("inspect {label} identity failed: {error}"))?;
    if !metadata.file_type().is_dir() {
        return Err(format!("{label} is not a real directory"));
    }
    Ok(StoreIdentity {
        dev: metadata.dev(),
        ino: metadata.ino(),
    })
}

fn store_git_layout_at(store_dir: &Path) -> Result<StoreGitLayout, String> {
    let git = store_dir.join("git");
    let objects = git.join("objects");
    let refs = git.join("refs");
    Ok(StoreGitLayout {
        git: store_directory_identity(&git, "snapshot store Git directory")?,
        objects: store_directory_identity(&objects, "snapshot store object database")?,
        objects_info: store_directory_identity(
            &objects.join("info"),
            "snapshot store object info directory",
        )?,
        objects_pack: store_directory_identity(
            &objects.join("pack"),
            "snapshot store object pack directory",
        )?,
        refs: store_directory_identity(&refs, "snapshot store refs directory")?,
        refs_heads: store_directory_identity(
            &refs.join("heads"),
            "snapshot store refs heads directory",
        )?,
        refs_tags: store_directory_identity(
            &refs.join("tags"),
            "snapshot store refs tags directory",
        )?,
    })
}

fn store_directory_from_parent(
    parent: &fs::File,
    name: &str,
    label: &str,
) -> Result<(fs::File, StoreIdentity), String> {
    let name = CString::new(name).map_err(|_| format!("{label} name contains NUL"))?;
    let file = open_at(
        parent.as_raw_fd(),
        &name,
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )
    .map_err(|error| format!("open {label} failed: {error}"))?;
    let identity = store_node_file(&file, label)?.identity;
    Ok((file, identity))
}

/// Read the complete store lifecycle from a root descriptor.  This is used at
/// the destroy commit boundary so the result cannot be sourced from a
/// replacement ancestor or child pathname after the root was validated.
fn store_lifecycle_at_root(root: &fs::File) -> Result<StoreLifecycle, String> {
    let generation = read_store_generation_at(root)?;
    let (git, git_identity) = store_directory_from_parent(root, "git", "snapshot store Git directory")?;
    let (objects, objects_identity) =
        store_directory_from_parent(&git, "objects", "snapshot store object database")?;
    let (_, objects_info_identity) =
        store_directory_from_parent(&objects, "info", "snapshot store object info directory")?;
    let (_, objects_pack_identity) =
        store_directory_from_parent(&objects, "pack", "snapshot store object pack directory")?;
    let (refs, refs_identity) =
        store_directory_from_parent(&git, "refs", "snapshot store refs directory")?;
    let (_, refs_heads_identity) =
        store_directory_from_parent(&refs, "heads", "snapshot store refs heads directory")?;
    let (_, refs_tags_identity) =
        store_directory_from_parent(&refs, "tags", "snapshot store refs tags directory")?;
    Ok(StoreLifecycle {
        generation,
        identity: store_node_file(root, "snapshot store root")?.identity,
        git: StoreGitLayout {
            git: git_identity,
            objects: objects_identity,
            objects_info: objects_info_identity,
            objects_pack: objects_pack_identity,
            refs: refs_identity,
            refs_heads: refs_heads_identity,
            refs_tags: refs_tags_identity,
        },
    })
}

fn valid_store_generation(value: &str) -> bool {
    value.len() == STORE_GENERATION_HEX_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn read_store_generation(store_dir: &Path) -> Result<String, String> {
    let path = store_generation_path(store_dir);
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&path)
        .map_err(|error| format!("read snapshot store generation failed: {error}"))?;
    read_store_generation_file(&mut file)
}

/// Read the lifecycle marker through a descriptor already bound to the store
/// root.  The pathname helper above is retained only for initial lifecycle
/// discovery; destroy's final validation never reopens this leaf by path.
fn read_store_generation_file(file: &mut fs::File) -> Result<String, String> {
    let before = stat_file(&file)
        .map_err(|error| format!("fstat snapshot store generation failed: {error}"))?;
    if !before.is_file() || before.len != STORE_GENERATION_HEX_BYTES as u64 {
        return Err("snapshot store generation marker is not a regular 64-byte file".to_string());
    }
    let mut bytes = Vec::with_capacity(STORE_GENERATION_HEX_BYTES);
    Read::by_ref(&mut *file)
        .take(STORE_GENERATION_HEX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read snapshot store generation failed: {error}"))?;
    let after = stat_file(&file)
        .map_err(|error| format!("fstat snapshot store generation failed: {error}"))?;
    if before != after || bytes.len() != STORE_GENERATION_HEX_BYTES {
        return Err("snapshot store generation marker changed while read".to_string());
    }
    let value = String::from_utf8(bytes)
        .map_err(|_| "snapshot store generation marker is not UTF-8".to_string())?;
    if !valid_store_generation(&value) {
        return Err("snapshot store generation marker is not lowercase hex".to_string());
    }
    Ok(value)
}

fn read_store_generation_at(root: &fs::File) -> Result<String, String> {
    let name = CString::new(STORE_GENERATION_FILE)
        .expect("snapshot store generation name has no NUL");
    let mut file = open_at(
        root.as_raw_fd(),
        &name,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )
    .map_err(|error| format!("read snapshot store generation failed: {error}"))?;
    read_store_generation_file(&mut file)
}

fn current_store_lifecycle(store_dir: &Path) -> Result<StoreLifecycle, String> {
    Ok(StoreLifecycle {
        generation: read_store_generation(store_dir)?,
        identity: store_identity_at(store_dir)?,
        git: store_git_layout_at(store_dir)?,
    })
}

fn parse_store_identity(value: &Value, field: &str) -> Result<StoreIdentity, String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{field} must be an object"))?;
    if object.get("type").and_then(Value::as_str) != Some("directory") {
        return Err(format!("{field}.type must be directory"));
    }
    let parse = |key: &str| -> Result<u64, String> {
        let raw = object
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{field}.{key} must be a decimal string"))?;
        if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(format!("{field}.{key} must be an unsigned decimal string"));
        }
        raw.parse::<u64>()
            .map_err(|_| format!("{field}.{key} does not fit u64"))
    };
    Ok(StoreIdentity {
        dev: parse("dev")?,
        ino: parse("ino")?,
    })
}

fn requested_store_lifecycle(req: &Value) -> Result<StoreLifecycle, String> {
    let generation = s(req, "storeGeneration")?;
    if !valid_store_generation(&generation) {
        return Err("storeGeneration must be a 64-character lowercase hex string".to_string());
    }
    let identity = parse_store_identity(
        req.get("storeIdentity")
            .ok_or("missing field storeIdentity")?,
        "storeIdentity",
    )?;
    let git = StoreGitLayout {
        git: parse_store_identity(
            req.get("storeGitIdentity")
                .ok_or("missing field storeGitIdentity")?,
            "storeGitIdentity",
        )?,
        objects: parse_store_identity(
            req.get("storeGitObjectsIdentity")
                .ok_or("missing field storeGitObjectsIdentity")?,
            "storeGitObjectsIdentity",
        )?,
        objects_info: parse_store_identity(
            req.get("storeGitObjectsInfoIdentity")
                .ok_or("missing field storeGitObjectsInfoIdentity")?,
            "storeGitObjectsInfoIdentity",
        )?,
        objects_pack: parse_store_identity(
            req.get("storeGitObjectsPackIdentity")
                .ok_or("missing field storeGitObjectsPackIdentity")?,
            "storeGitObjectsPackIdentity",
        )?,
        refs: parse_store_identity(
            req.get("storeGitRefsIdentity")
                .ok_or("missing field storeGitRefsIdentity")?,
            "storeGitRefsIdentity",
        )?,
        refs_heads: parse_store_identity(
            req.get("storeGitRefsHeadsIdentity")
                .ok_or("missing field storeGitRefsHeadsIdentity")?,
            "storeGitRefsHeadsIdentity",
        )?,
        refs_tags: parse_store_identity(
            req.get("storeGitRefsTagsIdentity")
                .ok_or("missing field storeGitRefsTagsIdentity")?,
            "storeGitRefsTagsIdentity",
        )?,
    };
    Ok(StoreLifecycle {
        generation,
        identity,
        git,
    })
}

fn lifecycle_json(lifecycle: &StoreLifecycle) -> Value {
    let identity_json = |identity: StoreIdentity| {
        json!({
            "dev": identity.dev.to_string(),
            "ino": identity.ino.to_string(),
            "type": "directory",
        })
    };
    json!({
        "storeGeneration": lifecycle.generation,
        "storeIdentity": identity_json(lifecycle.identity),
        "storeGitIdentity": identity_json(lifecycle.git.git),
        "storeGitObjectsIdentity": identity_json(lifecycle.git.objects),
        "storeGitObjectsInfoIdentity": identity_json(lifecycle.git.objects_info),
        "storeGitObjectsPackIdentity": identity_json(lifecycle.git.objects_pack),
        "storeGitRefsIdentity": identity_json(lifecycle.git.refs),
        "storeGitRefsHeadsIdentity": identity_json(lifecycle.git.refs_heads),
        "storeGitRefsTagsIdentity": identity_json(lifecycle.git.refs_tags),
    })
}

fn lifecycle_mismatch(expected: &StoreLifecycle, observed: &StoreLifecycle) -> String {
    format!(
        "snapshot store lifecycle is stale: expected generation {} identity {}:{}, found generation {} identity {}:{}",
        expected.generation,
        expected.identity.dev,
        expected.identity.ino,
        observed.generation,
        observed.identity.dev,
        observed.identity.ino,
    )
}

/// Validate the request against the store currently at the pathname.  This
/// must run after a contended mutation lock is acquired: that is the point at
/// which a destroy/recreate ABA can have replaced the pathname.
fn validate_store_lifecycle(store_dir: &Path, req: &Value) -> Result<StoreLifecycle, String> {
    let expected = requested_store_lifecycle(req)?;
    let observed = current_store_lifecycle(store_dir)?;
    if observed != expected {
        return Err(lifecycle_mismatch(&expected, &observed));
    }
    Ok(observed)
}

fn fresh_store_generation() -> Result<String, String> {
    let mut random = fs::File::open("/dev/urandom")
        .map_err(|error| format!("open snapshot store generation source failed: {error}"))?;
    let mut bytes = [0u8; STORE_GENERATION_HEX_BYTES / 2];
    random
        .read_exact(&mut bytes)
        .map_err(|error| format!("read snapshot store generation source failed: {error}"))?;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut generation = String::with_capacity(STORE_GENERATION_HEX_BYTES);
    for byte in bytes {
        generation.push(HEX[(byte >> 4) as usize] as char);
        generation.push(HEX[(byte & 0x0f) as usize] as char);
    }
    Ok(generation)
}

fn write_store_generation(store_dir: &Path, generation: &str) -> Result<(), String> {
    if !valid_store_generation(generation) {
        return Err("cannot write an invalid snapshot store generation".to_string());
    }
    durable_write(&store_generation_path(store_dir), generation.as_bytes())
}

fn insert_lifecycle_fields(target: &mut serde_json::Map<String, Value>, lifecycle: &StoreLifecycle) {
    if let Value::Object(fields) = lifecycle_json(lifecycle) {
        for (key, value) in fields {
            target.insert(key, value);
        }
    }
}

/// Recheck and bind a successful result to the same lifecycle.  Capture and
/// merge responses carry their payload under `state`/`result`; other store
/// operations return the fields at the top level.
fn bind_store_result(req: &Value, mut payload: Value) -> Result<Value, String> {
    let store_dir = PathBuf::from(s(req, "storeDir")?);
    let lifecycle = validate_store_lifecycle(&store_dir, req)?;
    let nested_key = if payload.get("state").is_some() {
        Some("state")
    } else if payload.get("result").is_some() {
        Some("result")
    } else {
        None
    };
    if let Some(key) = nested_key
        && let Some(object) = payload.get_mut(key).and_then(Value::as_object_mut)
    {
        insert_lifecycle_fields(object, &lifecycle);
    } else {
        let object = payload
            .as_object_mut()
            .ok_or("snapshot store operation returned a non-object result")?;
        insert_lifecycle_fields(object, &lifecycle);
    }
    Ok(payload)
}

/// Serialize the complete store lifecycle across core processes. The lock is
/// a stable sibling of the deletable store, so destroy/recreate cannot replace
/// its inode while an older request still holds it.
struct StoreMutationLock {
    _file: fs::File,
    contended: bool,
}

impl StoreMutationLock {
    fn acquire(store_dir: &Path, req: &Value) -> Result<Self, String> {
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

    fn was_contended(&self) -> bool {
        self.contended
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct IntendedStoreRef {
    name: String,
    target: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct StoreStagingIdentity {
    dev: u64,
    ino: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct StoreTransactionJournal {
    version: u32,
    #[serde(default)]
    staging_directory: Option<StoreStagingIdentity>,
    #[serde(default)]
    intended_ref: Option<IntendedStoreRef>,
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
struct StoreTransactionMetrics {
    journal_writes: u64,
    journal_bytes_written: u64,
    staged_file_syncs: u64,
    staging_directory_syncs: u64,
    published_objects: u64,
    canonical_directory_syncs: u64,
    ref_file_syncs: u64,
    ref_directory_syncs: u64,
}

struct PendingStoreObject {
    stage: PathBuf,
    canonical: PathBuf,
}

fn sync_directory(path: &Path) -> Result<(), String> {
    fs::File::open(path)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| format!("sync directory {} failed: {e}", path.display()))
}

fn sync_directory_nofollow(path: &Path) -> Result<(), String> {
    let directory = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|e| format!("open directory {} for sync failed: {e}", path.display()))?;
    directory
        .sync_all()
        .map_err(|e| format!("sync directory {} failed: {e}", path.display()))
}

fn ensure_real_directory(path: &Path, mode: u32) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(false),
        Ok(_) => Err(format!(
            "transaction directory path is not a real directory: {}",
            path.display()
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::DirBuilder::new()
                .mode(mode)
                .create(path)
                .map_err(|e| format!("create directory {} failed: {e}", path.display()))?;
            Ok(true)
        }
        Err(error) => Err(format!(
            "inspect directory {} failed: {error}",
            path.display()
        )),
    }
}

fn durable_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("durable file has no parent directory")?;
    fs::create_dir_all(parent).map_err(|e| format!("create durable directory failed: {e}"))?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("durable file name is not valid UTF-8")?;
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let temp = parent.join(format!(".{name}.tmp-{}-{suffix}", std::process::id()));
    let result = (|| -> Result<(), String> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&temp)
            .map_err(|e| format!("create durable temp file failed: {e}"))?;
        file.write_all(bytes)
            .map_err(|e| format!("write durable temp file failed: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("sync durable temp file failed: {e}"))?;
        drop(file);
        fs::rename(&temp, path).map_err(|e| format!("publish durable file failed: {e}"))?;
        sync_directory(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn transaction_file(store_dir: &Path) -> PathBuf {
    store_dir.join(STORE_TRANSACTION_FILE)
}

fn transaction_dir(store_dir: &Path) -> PathBuf {
    store_dir.join(STORE_TRANSACTION_DIR)
}

fn staged_object_path(store_dir: &Path, oid: Oid) -> PathBuf {
    transaction_dir(store_dir).join(oid.to_string())
}

fn read_regular_file_nofollow(path: &Path) -> Result<Vec<u8>, String> {
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|e| format!("open {} failed: {e}", path.display()))?;
    if !file
        .metadata()
        .map_err(|e| format!("inspect {} failed: {e}", path.display()))?
        .file_type()
        .is_file()
    {
        return Err(format!(
            "transaction file is not regular: {}",
            path.display()
        ));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("read {} failed: {e}", path.display()))?;
    Ok(bytes)
}

fn same_regular_file(left: &Path, right: &Path) -> bool {
    let Ok(left_meta) = fs::symlink_metadata(left) else {
        return false;
    };
    let Ok(right_meta) = fs::symlink_metadata(right) else {
        return false;
    };
    left_meta.file_type().is_file()
        && right_meta.file_type().is_file()
        && left_meta.dev() == right_meta.dev()
        && left_meta.ino() == right_meta.ino()
}

fn clear_store_transaction(store_dir: &Path) -> Result<(), String> {
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

fn staged_transaction_objects(
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

fn staging_directory_identity(store_dir: &Path) -> Result<StoreStagingIdentity, String> {
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

fn cleanup_transaction_temps(store_dir: &Path, repo: &Repository) -> Result<(), String> {
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

fn recover_store_transaction(store_dir: &Path, repo: &Repository) -> Result<(), String> {
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
struct StoreObjectTransaction {
    store_dir: PathBuf,
    journal: StoreTransactionJournal,
    started: bool,
    pending: Vec<PendingStoreObject>,
    staged_oids: HashSet<Oid>,
    metrics: StoreTransactionMetrics,
    metrics_path: Option<PathBuf>,
    committed: bool,
}

impl StoreObjectTransaction {
    fn new(store_dir: &Path, req: &Value) -> Self {
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

    fn set_intended_ref(&mut self, name: String, target: Oid) -> Result<(), String> {
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
    fn flush(&mut self, repo: &Repository) -> Result<(), String> {
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

    fn record_ref_sync(&mut self, directory_count: u64) {
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

    fn commit(&mut self) -> Result<(), String> {
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
fn ensure_blob_budget(
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
fn write_blob(
    transaction: &mut StoreObjectTransaction,
    repo: &Repository,
    bytes: &[u8],
    current_bytes: u64,
    max_new_blob_bytes: u64,
) -> Result<(Oid, u64), String> {
    let oid = object_oid(repo, "blob", bytes);
    let blob_bytes = u64::try_from(bytes.len()).map_err(|_| "blob length does not fit u64")?;
    ensure_blob_budget(
        transaction,
        repo,
        oid,
        blob_bytes,
        current_bytes,
        max_new_blob_bytes,
    )?;
    write_transaction_object(transaction, repo, "blob", bytes)
}

/// Publish one object through the request transaction. The ODB existence
/// check covers canonical loose/packed objects and alternates. Ownership is
/// based only on the no-overwrite canonical loose publish, so rollback cannot
/// remove a pre-existing or concurrently adopted object.
fn write_transaction_object(
    transaction: &mut StoreObjectTransaction,
    repo: &Repository,
    kind: &str,
    content: &[u8],
) -> Result<(Oid, u64), String> {
    let oid = object_oid(repo, kind, content);
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

/// True when a path has no absolute or parent segments.
fn is_safe_relative(path: &str) -> bool {
    !path.is_empty()
        && path != "."
        && !path.starts_with('/')
        && !path.split(['/', '\\']).any(|seg| seg == "..")
}

/// Open a repository from an arbitrary folder. Searches upward, like the
/// git CLI does.
fn open_repo(root: &Path) -> Result<Repository, String> {
    let root = normalize_system_alias_path(root, "repository root")?;
    Repository::open_ext(&root, RepositoryOpenFlags::empty(), None::<&str>)
        .map_err(|e| format!("open source repository failed: {e}"))
}

/// True when a path contains a `.git` segment (a nested repository).
fn has_git_segment(path: &str) -> bool {
    path.split('/').any(|seg| seg == ".git")
}

/// Stable identity and capture-relevant metadata read from a descriptor or
/// descriptor-relative path. ctime closes the restored-mtime rewrite gap;
/// mode includes both the file type and executable bits used by state trees.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileIdentity {
    dev: u64,
    ino: u64,
    len: u64,
    mode: u32,
    mtime: (i64, i64),
    ctime: (i64, i64),
}

impl FileIdentity {
    fn from_stat(st: &libc::stat) -> Self {
        Self {
            dev: st.st_dev as u64,
            ino: st.st_ino as u64,
            len: st.st_size as u64,
            mode: st.st_mode as u32,
            mtime: stat_mtime(st),
            ctime: stat_ctime(st),
        }
    }

    fn file_type(self) -> u32 {
        self.mode & libc::S_IFMT as u32
    }

    fn is_file(self) -> bool {
        self.file_type() == libc::S_IFREG as u32
    }

    fn is_dir(self) -> bool {
        self.file_type() == libc::S_IFDIR as u32
    }

    fn is_symlink(self) -> bool {
        self.file_type() == libc::S_IFLNK as u32
    }
}

fn stat_mtime(st: &libc::stat) -> (i64, i64) {
    (st.st_mtime, st.st_mtime_nsec)
}

fn stat_ctime(st: &libc::stat) -> (i64, i64) {
    (st.st_ctime, st.st_ctime_nsec)
}

fn stat_at(parent: RawFd, name: &CStr) -> io::Result<FileIdentity> {
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

fn stat_file(file: &fs::File) -> io::Result<FileIdentity> {
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PromotionJournalFileIdentity {
    file: FileIdentity,
    uid: u64,
    links: u64,
}

fn stat_promotion_journal_file(file: &fs::File) -> io::Result<PromotionJournalFileIdentity> {
    let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
    let rc = unsafe { libc::fstat(file.as_raw_fd(), st.as_mut_ptr()) };
    if rc == -1 {
        Err(io::Error::last_os_error())
    } else {
        let st = unsafe { st.assume_init() };
        Ok(PromotionJournalFileIdentity {
            file: FileIdentity::from_stat(&st),
            uid: st.st_uid as u64,
            links: st.st_nlink as u64,
        })
    }
}

/// `fstatat(2)` metadata for a private publication pathname. Keep the link
/// count and owner alongside the ordinary identity so a hardlink or pathname
/// replacement cannot pass a dev/ino-only check during metadata publication.
fn stat_promotion_private_at(parent: RawFd, name: &CStr) -> io::Result<PromotionJournalFileIdentity> {
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
        Ok(PromotionJournalFileIdentity {
            file: FileIdentity::from_stat(&st),
            uid: st.st_uid as u64,
            links: st.st_nlink as u64,
        })
    }
}

fn promotion_private_identity_valid(
    identity: PromotionJournalFileIdentity,
    mode: Option<u32>,
    max_bytes: usize,
) -> bool {
    identity.file.is_file()
        && identity.uid == unsafe { libc::geteuid() as u64 }
        && identity.links == 1
        && identity.file.mode & 0o077 == 0
        && mode.is_none_or(|expected| identity.file.mode & 0o777 == expected)
        && identity.file.len <= max_bytes as u64
}

fn open_at(parent: RawFd, name: &CStr, flags: libc::c_int) -> io::Result<fs::File> {
    let fd = unsafe { libc::openat(parent, name.as_ptr(), flags) };
    if fd == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { fs::File::from_raw_fd(fd) })
    }
}

fn open_at_mode(
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

fn missing_path(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ENOTDIR))
}

/// Open an absolute directory one component at a time without following a
/// symlink in the directory chain.  The returned descriptor is the capability
/// used by the capture boundary; callers must retain it for the whole
/// operation instead of resolving the pathname again.
fn open_absolute_directory_nofollow(path: &Path, field: &str) -> Result<fs::File, String> {
    let path = normalize_system_alias_path(path, field)?;
    open_absolute_directory_nofollow_raw(&path, field)
}

/// Normalize the one macOS system spelling that cannot be opened with
/// `O_NOFOLLOW`: `/var` is a fixed symlink to `/private/var`.  The native
/// boundary must not turn this into general symlink traversal, so only that
/// exact root link target is accepted; all other symlink components continue
/// through the descriptor walk and fail closed.
fn normalize_system_alias_path(path: &Path, field: &str) -> Result<PathBuf, String> {
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
fn same_directory_identity(left: FileIdentity, right: FileIdentity) -> bool {
    left.dev == right.dev && left.ino == right.ino && left.is_dir() && right.is_dir()
}

fn open_relative_directory(
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

/// One capture leaf resolved beneath an already-open root. The retained
/// parent descriptor prevents later ancestor swaps from redirecting reads.
struct AnchoredPath {
    parent: fs::File,
    leaf: CString,
    rel_path: String,
    identity: FileIdentity,
}

struct CaptureRoot {
    dir: fs::File,
    display: PathBuf,
    identity: FileIdentity,
}

impl CaptureRoot {
    fn open(root: &Path) -> Result<Self, String> {
        let display = normalize_system_alias_path(root, "capture root")?;
        let dir = open_absolute_directory_nofollow(&display, "capture root")?;
        let identity = stat_file(&dir).map_err(|e| format!("fstat capture root failed: {e}"))?;
        Ok(Self {
            dir,
            display,
            identity,
        })
    }

    fn resolve(&self, rel_path: &str) -> Result<Option<AnchoredPath>, String> {
        if !is_safe_relative(rel_path) || has_git_segment(rel_path) {
            return Err(format!("unsafe capture path: {rel_path}"));
        }
        let mut parts = rel_path.split('/').peekable();
        let mut parent = self
            .dir
            .try_clone()
            .map_err(|e| format!("clone capture root failed: {e}"))?;
        while let Some(part) = parts.next() {
            let name = CString::new(part)
                .map_err(|_| format!("capture path contains a NUL byte: {rel_path}"))?;
            if parts.peek().is_none() {
                let identity = match stat_at(parent.as_raw_fd(), &name) {
                    Ok(identity) => identity,
                    Err(error) if missing_path(&error) => return Ok(None),
                    Err(error) => return Err(format!("stat failed for {rel_path}: {error}")),
                };
                return Ok(Some(AnchoredPath {
                    parent,
                    leaf: name,
                    rel_path: rel_path.to_string(),
                    identity,
                }));
            }

            let identity = match stat_at(parent.as_raw_fd(), &name) {
                Ok(identity) => identity,
                Err(error) if missing_path(&error) => return Ok(None),
                Err(error) => {
                    return Err(format!("stat failed for ancestor of {rel_path}: {error}"));
                }
            };
            if identity.is_symlink() {
                return Err(format!(
                    "ancestor symlink (symlinked-directory) while capturing {rel_path}"
                ));
            }
            if !identity.is_dir() {
                return Ok(None);
            }
            parent = match open_at(
                parent.as_raw_fd(),
                &name,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            ) {
                Ok(next) => next,
                Err(error) if missing_path(&error) => return Ok(None),
                Err(error) if error.raw_os_error() == Some(libc::ELOOP) => {
                    return Err(format!(
                        "ancestor symlink (symlinked-directory) while capturing {rel_path}"
                    ));
                }
                Err(error) => {
                    return Err(format!("open ancestor failed for {rel_path}: {error}"));
                }
            };
        }
        Err(format!("unsafe capture path: {rel_path}"))
    }

    fn display_path(&self, rel_path: &str) -> PathBuf {
        self.display.join(rel_path)
    }
}

/// The source repository binding used by a full capture.  libgit2 only
/// accepts pathnames, so opening a repository is not by itself a capability:
/// every path libgit2 reports is opened and checked against descriptors that
/// were established before the open.  Those descriptors stay alive until the
/// capture is complete, and all source ODB/index reads finish before the
/// descriptor-relative working-tree pass starts.
struct BoundSourceRepository {
    repo: Repository,
    capture_root_path: PathBuf,
    capture_root_identity: FileIdentity,
    source_git_dir_path: PathBuf,
    source_git_dir: fs::File,
    source_git_dir_identity: FileIdentity,
    workdir_path: PathBuf,
    workdir: fs::File,
    workdir_identity: FileIdentity,
    repository_git_dir_path: PathBuf,
    repository_git_dir: fs::File,
    repository_git_dir_identity: FileIdentity,
    common_git_dir_path: PathBuf,
    common_git_dir: fs::File,
    common_git_dir_identity: FileIdentity,
    objects_dir: fs::File,
    objects_dir_identity: FileIdentity,
    index: Option<fs::File>,
    index_identity: Option<FileIdentity>,
    capture_prefix: Option<String>,
}

impl BoundSourceRepository {
    fn open(
        req: &Value,
        capture_root: &CaptureRoot,
        source_git_dir_path: &Path,
        expected_format: ObjectFormat,
    ) -> Result<Self, String> {
        let source_git_dir_path =
            normalize_system_alias_path(source_git_dir_path, "source Git directory")?;
        let source_git_dir =
            open_absolute_directory_nofollow(&source_git_dir_path, "source Git directory")?;
        let source_git_dir_identity = stat_file(&source_git_dir)
            .map_err(|error| format!("fstat source Git directory failed: {error}"))?;
        pause_at_hook(req, "pauseAfterCaptureGitDirOpen")?;

        // This is the only pathname open libgit2 gets.  The root and Git
        // directory capabilities above are checked against the repository it
        // returns before any index, status, or ODB operation is allowed.
        let repo = open_repo(&capture_root.display)?;
        pause_at_hook(req, "pauseAfterSourceRepoOpen")?;
        if repo.is_bare() {
            return Err("source repository has no working directory".to_string());
        }
        if repo.object_format() != expected_format {
            return Err(
                "source repository object format does not match the snapshot store".to_string(),
            );
        }
        let workdir_path = repo
            .workdir()
            .ok_or("source repository has no working directory")?
            .to_path_buf();
        let repository_git_dir_path = repo.path().to_path_buf();
        let common_git_dir_path = repo.commondir().to_path_buf();
        let workdir =
            open_absolute_directory_nofollow(&workdir_path, "source repository worktree")?;
        let workdir_identity = stat_file(&workdir)
            .map_err(|error| format!("fstat source repository worktree failed: {error}"))?;
        let repository_git_dir = open_absolute_directory_nofollow(
            &repository_git_dir_path,
            "source repository .git directory",
        )?;
        let repository_git_dir_identity = stat_file(&repository_git_dir)
            .map_err(|error| format!("fstat source repository .git directory failed: {error}"))?;
        let common_git_dir = open_absolute_directory_nofollow(
            &common_git_dir_path,
            "source repository common Git directory",
        )?;
        let common_git_dir_identity = stat_file(&common_git_dir).map_err(|error| {
            format!("fstat source repository common Git directory failed: {error}")
        })?;
        let objects_dir = open_relative_directory(
            &common_git_dir,
            Path::new("objects"),
            "source repository object database",
        )?;
        let objects_dir_identity = stat_file(&objects_dir)
            .map_err(|error| format!("fstat source repository object database failed: {error}"))?;

        let capture_canon = fs::canonicalize(&capture_root.display).map_err(|error| {
            format!("canonicalize capture root for repository binding failed: {error}")
        })?;
        let workdir_canon = fs::canonicalize(&workdir_path)
            .map_err(|error| format!("canonicalize source repository worktree failed: {error}"))?;
        let capture_relative = capture_canon
            .strip_prefix(&workdir_canon)
            .map_err(|_| "capture root is outside the source repository worktree".to_string())?
            .to_path_buf();
        let capture_prefix = if capture_relative.as_os_str().is_empty() {
            None
        } else {
            let relative = capture_relative
                .to_str()
                .ok_or("capture root path is not valid UTF-8")?
                .replace(std::path::MAIN_SEPARATOR, "/");
            if relative.is_empty() {
                None
            } else {
                Some(format!("{relative}/"))
            }
        };
        let anchored_capture_root = open_relative_directory(
            &workdir,
            &capture_relative,
            "source repository capture root",
        )?;
        let anchored_capture_identity = stat_file(&anchored_capture_root)
            .map_err(|error| format!("fstat source repository capture root failed: {error}"))?;
        if !same_directory_identity(anchored_capture_identity, capture_root.identity) {
            return Err(
                "source repository worktree does not contain the bound capture root".to_string(),
            );
        }

        let common_canon = fs::canonicalize(&common_git_dir_path).map_err(|error| {
            format!("canonicalize source repository common Git directory failed: {error}")
        })?;
        let repository_git_canon = fs::canonicalize(&repository_git_dir_path).map_err(|error| {
            format!("canonicalize source repository .git directory failed: {error}")
        })?;
        let repository_git_relative = repository_git_canon
            .strip_prefix(&common_canon)
            .map_err(|_| {
                "source repository .git directory is outside its common Git directory".to_string()
            })?
            .to_path_buf();
        let anchored_repository_git_dir = open_relative_directory(
            &common_git_dir,
            &repository_git_relative,
            "source repository .git directory",
        )?;
        let anchored_repository_git_identity =
            stat_file(&anchored_repository_git_dir).map_err(|error| {
                format!("fstat bound source repository .git directory failed: {error}")
            })?;
        if !same_directory_identity(
            anchored_repository_git_identity,
            repository_git_dir_identity,
        ) {
            return Err(
                "source repository .git directory is not bound to its common Git directory"
                    .to_string(),
            );
        }
        if !same_directory_identity(source_git_dir_identity, common_git_dir_identity) {
            return Err("source Git directory does not match the opened repository".to_string());
        }

        let index_name = CString::new("index").expect("index has no NUL");
        let index = match open_at(
            repository_git_dir.as_raw_fd(),
            &index_name,
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        ) {
            Ok(index) => Some(index),
            Err(error) if missing_path(&error) => None,
            Err(error) => return Err(format!("open source repository index failed: {error}")),
        };
        let index_identity = index
            .as_ref()
            .map(stat_file)
            .transpose()
            .map_err(|error| format!("fstat source repository index failed: {error}"))?;

        let binding = Self {
            repo,
            capture_root_path: capture_root.display.clone(),
            capture_root_identity: capture_root.identity,
            source_git_dir_path: source_git_dir_path.to_path_buf(),
            source_git_dir,
            source_git_dir_identity,
            workdir_path,
            workdir,
            workdir_identity,
            repository_git_dir_path,
            repository_git_dir,
            repository_git_dir_identity,
            common_git_dir_path,
            common_git_dir,
            common_git_dir_identity,
            objects_dir,
            objects_dir_identity,
            index,
            index_identity,
            capture_prefix,
        };
        binding.verify(capture_root)?;
        pause_at_hook(req, "pauseAfterSourceBinding")?;
        binding.verify(capture_root)?;
        Ok(binding)
    }

    fn verify(&self, capture_root: &CaptureRoot) -> Result<(), String> {
        let capture_identity = stat_file(&capture_root.dir)
            .map_err(|error| format!("fstat bound capture root failed: {error}"))?;
        if !same_directory_identity(capture_identity, self.capture_root_identity) {
            return Err("capture root identity changed while captured".to_string());
        }
        if capture_root.display != self.capture_root_path {
            return Err("capture root pathname changed while captured".to_string());
        }
        self.verify_held_directory(
            &self.source_git_dir,
            self.source_git_dir_identity,
            "source Git directory",
        )?;
        self.verify_held_directory(
            &self.workdir,
            self.workdir_identity,
            "source repository worktree",
        )?;
        self.verify_held_directory(
            &self.repository_git_dir,
            self.repository_git_dir_identity,
            "source repository .git directory",
        )?;
        self.verify_held_directory(
            &self.common_git_dir,
            self.common_git_dir_identity,
            "source repository common Git directory",
        )?;
        self.verify_held_directory(
            &self.objects_dir,
            self.objects_dir_identity,
            "source repository object database",
        )?;
        self.verify_path_directory(
            &self.source_git_dir_path,
            self.source_git_dir_identity,
            "source Git directory",
        )?;
        self.verify_path_directory(
            &self.workdir_path,
            self.workdir_identity,
            "source repository worktree",
        )?;
        self.verify_path_directory(
            &self.repository_git_dir_path,
            self.repository_git_dir_identity,
            "source repository .git directory",
        )?;
        self.verify_path_directory(
            &self.common_git_dir_path,
            self.common_git_dir_identity,
            "source repository common Git directory",
        )?;
        let objects_path = self.common_git_dir_path.join("objects");
        self.verify_path_directory(
            &objects_path,
            self.objects_dir_identity,
            "source repository object database",
        )?;
        if let Some(index) = &self.index {
            let index_identity = stat_file(index)
                .map_err(|error| format!("fstat bound source repository index failed: {error}"))?;
            let expected = self
                .index_identity
                .ok_or("source repository index binding is incomplete")?;
            if index_identity != expected {
                return Err("source repository index changed while captured".to_string());
            }
            let index_name = CString::new("index").expect("index has no NUL");
            let current = open_at(
                self.repository_git_dir.as_raw_fd(),
                &index_name,
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|error| format!("open bound source repository index failed: {error}"))?;
            let current_identity = stat_file(&current).map_err(|error| {
                format!("fstat current source repository index failed: {error}")
            })?;
            if current_identity != expected {
                return Err("source repository index path changed while captured".to_string());
            }
        } else {
            let index_name = CString::new("index").expect("index has no NUL");
            match open_at(
                self.repository_git_dir.as_raw_fd(),
                &index_name,
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            ) {
                Ok(_) => return Err("source repository index appeared while captured".to_string()),
                Err(error) if missing_path(&error) => {}
                Err(error) => {
                    return Err(format!("inspect source repository index failed: {error}"));
                }
            }
        }
        Ok(())
    }

    fn verify_held_directory(
        &self,
        descriptor: &fs::File,
        expected: FileIdentity,
        field: &str,
    ) -> Result<(), String> {
        let observed = stat_file(descriptor)
            .map_err(|error| format!("fstat bound {field} failed: {error}"))?;
        if !same_directory_identity(observed, expected) {
            return Err(format!("bound {field} identity changed while captured"));
        }
        Ok(())
    }

    fn verify_path_directory(
        &self,
        path: &Path,
        expected: FileIdentity,
        field: &str,
    ) -> Result<(), String> {
        let descriptor = open_absolute_directory_nofollow(path, field)?;
        let observed =
            stat_file(&descriptor).map_err(|error| format!("fstat {field} failed: {error}"))?;
        if !same_directory_identity(observed, expected) {
            return Err(format!("{field} identity changed while captured"));
        }
        Ok(())
    }

    fn index_write_time(&self) -> Result<Option<SystemTime>, String> {
        self.index
            .as_ref()
            .map(|index| {
                index
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .map_err(|error| {
                        format!("inspect source repository index time failed: {error}")
                    })
            })
            .transpose()
    }
}

// ---------------------------------------------------------------- trees ----

/// One entry of the flat tree representation.
type FlatEntry = (u32, Oid);

/// A nested tree node: a blob or a directory.
enum Node {
    Blob { oid: Oid, mode: u32 },
    Dir(HashMap<String, Node>),
}

/// Insert a flat path into the nested tree. Errors on path conflicts.
fn insert_node(
    root: &mut HashMap<String, Node>,
    path: &str,
    oid: Oid,
    mode: u32,
) -> Result<(), String> {
    let parts: Vec<&str> = path.split('/').collect();
    let mut current = root;
    for (i, part) in parts.iter().enumerate() {
        let last = i == parts.len() - 1;
        if last {
            if current.contains_key(*part) {
                return Err(format!("duplicate path in tree: {path}"));
            }
            current.insert(part.to_string(), Node::Blob { oid, mode });
        } else {
            let entry = current
                .entry(part.to_string())
                .or_insert_with(|| Node::Dir(HashMap::new()));
            match entry {
                Node::Dir(map) => current = map,
                Node::Blob { .. } => {
                    return Err(format!("path component conflicts with a file: {path}"));
                }
            }
        }
    }
    Ok(())
}

/// Write the nested tree into the repository. Returns the tree oid.
/// One prepared entry of a tree being written.
struct TreeEntry {
    mode: u32,
    name: String,
    oid: Oid,
}

fn write_nested_tree(
    transaction: &mut StoreObjectTransaction,
    repo: &Repository,
    root: &mut HashMap<String, Node>,
) -> Result<Oid, String> {
    let entries = build_tree_entries(transaction, repo, root)?;
    let content = tree_object_content(&entries);
    // The read-back verification in the capture ops parses this object
    // through libgit2, so a format mistake fails loudly there.
    write_transaction_object(transaction, repo, "tree", &content).map(|(oid, _)| oid)
}

/// Write the root tree whose exact ref will make this transaction durable.
/// Child trees are already covered by the ownership journal; before the root
/// is published, record the ref name and its target as well.
fn write_nested_tree_for_ref(
    transaction: &mut StoreObjectTransaction,
    repo: &Repository,
    root: &mut HashMap<String, Node>,
    ref_namespace: &str,
) -> Result<Oid, String> {
    let entries = build_tree_entries(transaction, repo, root)?;
    let content = tree_object_content(&entries);
    let oid = object_oid(repo, "tree", &content);
    let written = write_transaction_object(transaction, repo, "tree", &content)?.0;
    if written != oid {
        return Err("merged root tree oid changed while staged".to_string());
    }
    transaction.set_intended_ref(format!("{ref_namespace}/{oid}"), oid)?;
    Ok(oid)
}

/// Write a new tree by patching the parent tree with only the changed
/// paths. Unchanged directories keep their existing tree objects; only
/// the ancestors of a change are rewritten bottom-up. Returns None when
/// every path is gone and the root ends up empty; the caller then writes
/// an explicit empty root tree.
fn write_tree_delta(
    transaction: &mut StoreObjectTransaction,
    repo: &Repository,
    parent_tree: Oid,
    changes: &HashMap<String, Option<FlatEntry>>,
) -> Result<Option<Oid>, String> {
    // A deletion of X is superseded when the same batch also changes paths
    // under X/: the path turned into a directory and its children carry
    // the truth. Without this rule a "rm -rf d && echo hi > d" batch would
    // resurrect the stale child deletions over the new file.
    let mut superseded: HashSet<String> = HashSet::new();
    for path in changes.keys() {
        if changes.get(path) == Some(&None) {
            continue;
        }
        let mut rest = path.as_str();
        while let Some(i) = rest.rfind('/') {
            rest = &rest[..i];
            if changes.get(rest) == Some(&None) {
                superseded.insert(rest.to_string());
            }
        }
    }

    // Group the changes under their parent directory so one recursion
    // level only touches its own direct children.
    let mut per_dir: HashMap<String, HashMap<String, Option<FlatEntry>>> = HashMap::new();
    for (path, entry) in changes {
        if superseded.contains(path) {
            continue;
        }
        let (dir, name) = match path.rsplit_once('/') {
            Some((dir, name)) => (dir.to_string(), name.to_string()),
            None => (String::new(), path.clone()),
        };
        per_dir.entry(dir).or_default().insert(name, entry.clone());
    }
    write_dir_delta(transaction, repo, parent_tree, "", &per_dir)
}

/// The existing entries of one directory inside the parent root tree.
/// A non-tree entry at the path (the parent state had a file where this
/// batch builds a directory) counts as absent.
fn dir_entries(
    repo: &Repository,
    parent_root: Oid,
    dir_rel: &str,
) -> Result<Vec<TreeEntry>, String> {
    let mut entries = Vec::new();
    let dir_oid = if dir_rel.is_empty() {
        Some(parent_root)
    } else {
        match tree_lookup(repo, parent_root, dir_rel, TreeLookupKind::Tree)? {
            Some((mode, oid)) if mode == 0o040000 => Some(oid),
            _ => None,
        }
    };
    if let Some(oid) = dir_oid {
        let tree = repo
            .find_tree(oid)
            .map_err(|e| format!("tree read failed for {dir_rel}: {e}"))?;
        for entry in tree.iter() {
            let name = entry
                .name()
                .map_err(|e| format!("tree entry name read failed: {e}"))?;
            entries.push(TreeEntry {
                mode: entry.filemode() as u32,
                name: name.to_string(),
                oid: entry.id(),
            });
        }
    }
    Ok(entries)
}

/// Recursively patch one directory. Returns None when it ends up empty so
/// the parent drops its entry (Git trees carry no empty directories).
fn write_dir_delta(
    transaction: &mut StoreObjectTransaction,
    repo: &Repository,
    parent_root: Oid,
    dir_rel: &str,
    per_dir: &HashMap<String, HashMap<String, Option<FlatEntry>>>,
) -> Result<Option<Oid>, String> {
    let mut entries = dir_entries(repo, parent_root, dir_rel)?;
    // Descend first: children are patched against the parent state, then
    // direct changes below apply last and win. The ordering decides type
    // flips — a "rm -rf d && echo hi > d" batch must end with the file,
    // not with the stale empty subtree.
    let prefix = if dir_rel.is_empty() {
        String::new()
    } else {
        format!("{dir_rel}/")
    };
    let mut child_names: Vec<&str> = Vec::new();
    for key in per_dir.keys() {
        if key.as_str() == dir_rel {
            continue;
        }
        let Some(rest) = key.strip_prefix(prefix.as_str()) else {
            continue;
        };
        if let Some(child) = rest.split('/').next() {
            if !child.is_empty() && !child_names.contains(&child) {
                child_names.push(child);
            }
        }
    }
    for child in child_names {
        let child_oid = write_dir_delta(
            transaction,
            repo,
            parent_root,
            &format!("{prefix}{child}"),
            per_dir,
        )?;
        entries.retain(|e| e.name != child);
        if let Some(oid) = child_oid {
            entries.push(TreeEntry {
                mode: 0o040000,
                name: child.to_string(),
                oid,
            });
        }
    }
    let none = HashMap::new();
    for (name, change) in per_dir.get(dir_rel).unwrap_or(&none) {
        entries.retain(|e| e.name != *name);
        if let Some((mode, oid)) = change {
            entries.push(TreeEntry {
                mode: *mode,
                name: name.clone(),
                oid: *oid,
            });
        }
    }
    if entries.is_empty() {
        return Ok(None);
    }
    sort_git_entries(&mut entries);
    let content = tree_object_content(&entries);
    write_transaction_object(transaction, repo, "tree", &content).map(|(oid, _)| Some(oid))
}

/// Write nested trees bottom-up and collect the entries of one directory.
fn build_tree_entries(
    transaction: &mut StoreObjectTransaction,
    repo: &Repository,
    dir: &mut HashMap<String, Node>,
) -> Result<Vec<TreeEntry>, String> {
    let mut entries: Vec<TreeEntry> = Vec::with_capacity(dir.len());
    for (name, node) in dir.iter_mut() {
        match node {
            Node::Blob { oid, mode } => entries.push(TreeEntry {
                mode: *mode,
                name: name.clone(),
                oid: *oid,
            }),
            Node::Dir(sub) => {
                let sub_oid = write_nested_tree(transaction, repo, sub)?;
                entries.push(TreeEntry {
                    mode: 0o040000,
                    name: name.clone(),
                    oid: sub_oid,
                });
            }
        }
    }
    sort_git_entries(&mut entries);
    Ok(entries)
}

/// Sort tree entries byte-wise; directories compare as if their name
/// carried a trailing slash.
fn sort_git_entries(entries: &mut [TreeEntry]) {
    let sort_key = |e: &TreeEntry| {
        if e.mode == 0o040000 {
            format!("{}/", e.name)
        } else {
            e.name.clone()
        }
    };
    entries.sort_by(|a, b| sort_key(a).cmp(&sort_key(b)));
}

/// The canonical Git tree object bytes for sorted entries.
fn tree_object_content(entries: &[TreeEntry]) -> Vec<u8> {
    let mut content = Vec::new();
    for entry in entries {
        content.extend_from_slice(format!("{:o} {}\0", entry.mode, entry.name).as_bytes());
        content.extend_from_slice(entry.oid.as_bytes());
    }
    content
}

const GIT_STATE_MAX_ENTRIES: usize = BUDGET_MAX_PATHS;
const GIT_STATE_MAX_BYTES: u64 = PROMOTION_COPY_TREE_MAX_BYTES;
const GIT_STATE_MAX_WORK_BYTES: u64 = PROMOTION_DIRECTORY_MAX_NAME_BYTES;

struct GitTreeBudget {
    entries: usize,
    bytes: u64,
    work_bytes: u64,
}

impl GitTreeBudget {
    fn new() -> Self {
        Self { entries: 0, bytes: 0, work_bytes: 0 }
    }

    fn charge_entry(&mut self) -> Result<(), String> {
        self.entries = self
            .entries
            .checked_add(1)
            .ok_or("Git tree entry count overflow")?;
        if self.entries > GIT_STATE_MAX_ENTRIES {
            return Err(format!(
                "Git state exceeds its {GIT_STATE_MAX_ENTRIES}-entry bound"
            ));
        }
        Ok(())
    }

    fn charge_bytes(&mut self, amount: u64) -> Result<(), String> {
        self.bytes = self
            .bytes
            .checked_add(amount)
            .ok_or("Git state byte accounting overflow")?;
        if self.bytes > GIT_STATE_MAX_BYTES {
            return Err("Git state exceeds its byte bound".to_string());
        }
        Ok(())
    }

    fn charge_work(&mut self, amount: u64) -> Result<(), String> {
        self.work_bytes = self
            .work_bytes
            .checked_add(amount)
            .ok_or("Git state work accounting overflow")?;
        if self.work_bytes > GIT_STATE_MAX_WORK_BYTES {
            return Err("Git state exceeds its work bound".to_string());
        }
        Ok(())
    }
}

fn git_tree_object_bounded<'repo>(
    repo: &'repo Repository,
    tree_oid: Oid,
    budget: &mut GitTreeBudget,
) -> Result<git2::Tree<'repo>, String> {
    let odb = repo.odb().map_err(|error| format!("open Git object database failed: {error}"))?;
    let (size, kind) = odb
        .read_header(tree_oid)
        .map_err(|error| format!("read Git tree header failed: {error}"))?;
    if kind != git2::ObjectType::Tree {
        return Err("Git state tree object has the wrong type".to_string());
    }
    let size = u64::try_from(size).map_err(|_| "Git tree size does not fit u64")?;
    budget.charge_work(size)?;
    // A Git tree entry needs at least one mode byte, a separator, a NUL, and
    // one object id. Reject a raw tree that could exceed the remaining entry
    // envelope before libgit2 materializes its entry table; the iterative
    // walker still charges each actual entry as it visits it.
    let object_id_bytes = match repo.object_format() {
        ObjectFormat::Sha1 => 20u64,
        ObjectFormat::Sha256 => 32u64,
    };
    let minimum_entry_bytes = object_id_bytes
        .checked_add(3)
        .ok_or("Git tree entry-size accounting overflow")?;
    let remaining_entries = GIT_STATE_MAX_ENTRIES.saturating_sub(budget.entries) as u64;
    if size / minimum_entry_bytes > remaining_entries {
        return Err(format!(
            "Git state tree could exceed its {GIT_STATE_MAX_ENTRIES}-entry bound"
        ));
    }
    repo.find_tree(tree_oid)
        .map_err(|error| format!("read Git tree failed: {error}"))
}

fn git_blob_size_bounded(
    repo: &Repository,
    oid: Oid,
    max_bytes: u64,
    field: &str,
) -> Result<u64, String> {
    let odb = repo.odb().map_err(|error| format!("open Git object database failed: {error}"))?;
    let (size, kind) = odb
        .read_header(oid)
        .map_err(|error| format!("read {field} header failed: {error}"))?;
    if kind != git2::ObjectType::Blob {
        return Err(format!("{field} is not a blob"));
    }
    let size = u64::try_from(size).map_err(|_| format!("{field} size does not fit u64"))?;
    if size > max_bytes {
        return Err(format!("{field} exceeds its {max_bytes}-byte bound"));
    }
    Ok(size)
}

/// Read one Git blob only after its ODB header has established a bounded
/// logical size. The stream path keeps the destination allocation bounded in
/// chunks; the libgit2 fallback is reached only for backends without read
/// streams and is still protected by the header limit.
fn git_blob_bytes_bounded(
    repo: &Repository,
    oid: Oid,
    max_bytes: u64,
    field: &str,
) -> Result<Vec<u8>, String> {
    let size = git_blob_size_bounded(repo, oid, max_bytes, field)?;
    let streamed = (|| -> Result<Option<Vec<u8>>, String> {
        let odb = repo
            .odb()
            .map_err(|error| format!("open Git object database failed: {error}"))?;
        let Ok((mut reader, stream_size, stream_kind)) = odb.reader(oid) else {
            return Ok(None);
        };
        if stream_kind != git2::ObjectType::Blob || u64::try_from(stream_size).ok() != Some(size) {
            return Err(format!("{field} changed its bounded ODB header"));
        }
        let mut bytes = Vec::with_capacity(usize::try_from(size).map_err(|_| {
            format!("{field} size does not fit the native allocation budget")
        })?);
        let mut chunk = [0u8; 64 * 1024];
        loop {
            let read = reader
                .read(&mut chunk)
                .map_err(|error| format!("read {field} failed: {error}"))?;
            if read == 0 {
                break;
            }
            let next = bytes
                .len()
                .checked_add(read)
                .ok_or_else(|| format!("{field} byte accounting overflow"))?;
            if u64::try_from(next).map_err(|_| format!("{field} size does not fit u64"))? > max_bytes {
                return Err(format!("{field} exceeds its {max_bytes}-byte bound"));
            }
            bytes.extend_from_slice(&chunk[..read]);
        }
        if u64::try_from(bytes.len()).ok() != Some(size) {
            return Err(format!("{field} changed size while reading"));
        }
        Ok(Some(bytes))
    })()?;
    if let Some(bytes) = streamed {
        return Ok(bytes);
    }

    let blob = repo
        .find_blob(oid)
        .map_err(|error| format!("read {field} failed: {error}"))?;
    if u64::try_from(blob.content().len()).ok() != Some(size) {
        return Err(format!("{field} changed size while reading"));
    }
    Ok(blob.content().to_vec())
}

fn git_tree_entry_path(prefix: &str, name: &str) -> Result<String, String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.len() > PROMOTION_COMPONENT_MAX_BYTES
    {
        return Err("Git state contains an invalid tree entry name".to_string());
    }
    let path_len = prefix
        .len()
        .checked_add(if prefix.is_empty() { 0 } else { 1 })
        .and_then(|length| length.checked_add(name.len()))
        .ok_or("Git state path length overflow")?;
    if path_len > PROMOTION_PATH_MAX_BYTES {
        return Err("Git state path exceeds its bounded path budget".to_string());
    }
    let mut path = String::with_capacity(path_len);
    if !prefix.is_empty() {
        path.push_str(prefix);
        path.push('/');
    }
    path.push_str(name);
    Ok(path)
}

/// Walk a tree and collect every non-tree entry into a bounded flat map.
fn collect_tree_map(
    repo: &Repository,
    tree_oid: Oid,
) -> Result<HashMap<String, FlatEntry>, String> {
    let mut out = HashMap::new();
    let mut budget = GitTreeBudget::new();
    let mut stack: Vec<(Oid, String, usize)> = Vec::with_capacity(PROMOTION_DIRECTORY_MAX_DEPTH + 1);
    stack.push((tree_oid, String::new(), 0));
    while let Some((current_oid, current_prefix, depth)) = stack.pop() {
        let tree = git_tree_object_bounded(repo, current_oid, &mut budget)?;
        for entry in tree.iter() {
            budget.charge_entry()?;
            let name = entry.name().map_err(|error| error.to_string())?;
            let kind = entry
                .kind()
                .ok_or("Git state tree entry has no object type")?;
            if kind == git2::ObjectType::Tree && depth >= PROMOTION_DIRECTORY_MAX_DEPTH {
                return Err("Git state exceeds its depth bound".to_string());
            }
            let path = git_tree_entry_path(&current_prefix, name)?;
            let path_work = u64::try_from(path.len())
                .and_then(|path_len| {
                    u64::try_from(name.len()).map(|name_len| path_len.saturating_add(name_len))
                })
                .map_err(|_| "Git state path work accounting overflow")?;
            budget.charge_work(path_work)?;
            match kind {
                git2::ObjectType::Tree => {
                    if entry.filemode() as u32 != 0o040000 {
                        return Err(format!("Git state tree entry {path} has an invalid mode"));
                    }
                    stack.push((entry.id(), path, depth + 1));
                }
                git2::ObjectType::Blob => {
                    let mode = entry.filemode() as u32;
                    let max_blob = match mode {
                        0o100644 | 0o100755 => BUDGET_MAX_FILE_BYTES,
                        0o120000 => PROMOTION_PATH_MAX_BYTES as u64,
                        _ => return Err(format!("Git state entry {path} has an unsupported mode")),
                    };
                    let size = git_blob_size_bounded(repo, entry.id(), max_blob, &format!("Git state blob {path}"))?;
                    budget.charge_bytes(size)?;
                    out.insert(path, (mode, entry.id()));
                }
                _ => return Err(format!("Git state entry {path} has an unsupported object type")),
            }
        }
    }
    Ok(out)
}

type TreeMap = HashMap<String, FlatEntry>;
type TreeMapCache = HashMap<Oid, std::sync::Arc<TreeMap>>;

fn tree_map_cache() -> &'static Mutex<TreeMapCache> {
    static CACHE: std::sync::OnceLock<Mutex<TreeMapCache>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Cached flat map of a tree. The core process handles requests one at a
/// time, so the parent tree of the next capture is usually cached.
fn collect_tree_map_cached(
    repo: &Repository,
    tree_oid: Oid,
) -> Result<std::sync::Arc<TreeMap>, String> {
    if let Some(hit) = tree_map_cache().lock().unwrap().get(&tree_oid) {
        return Ok(hit.clone());
    }
    let map = std::sync::Arc::new(collect_tree_map(repo, tree_oid)?);
    let mut cache = tree_map_cache().lock().unwrap();
    if cache.len() >= TREE_MAP_CACHE_SIZE {
        // Evict one arbitrary entry. Any policy beats a full walk here.
        if let Some(oldest) = cache.keys().next().cloned() {
            cache.remove(&oldest);
        }
    }
    cache.insert(tree_oid, map.clone());
    Ok(map)
}

/// Remember the flat map of a freshly written tree.
fn cache_tree_map(tree_oid: Oid, map: std::sync::Arc<TreeMap>) {
    let mut cache = tree_map_cache().lock().unwrap();
    if cache.len() >= TREE_MAP_CACHE_SIZE {
        if let Some(oldest) = cache.keys().next().cloned() {
            cache.remove(&oldest);
        }
    }
    cache.insert(tree_oid, map);
}

/// The tree oid of a state commit.
fn resolve_tree(repo: &Repository, commit: Oid) -> Result<Oid, String> {
    let object = repo
        .revparse_single(&format!("{}^{{tree}}", commit))
        .map_err(|e| e.to_string())?;
    object
        .as_tree()
        .map(|t| t.id())
        .ok_or_else(|| "state is not a commit".to_string())
}

/// Create the synthetic state commit.
fn commit_tree(
    transaction: &mut StoreObjectTransaction,
    repo: &Repository,
    tree: Oid,
    parents: &[git2::Commit<'_>],
    message: &str,
) -> Result<Oid, String> {
    // Future callers cannot accidentally ask libgit2 to resolve a tree that
    // is still only in the private staging ledger.
    transaction.flush(repo)?;
    let signature = Signature::now("termina", "dev@termina.local").map_err(|e| e.to_string())?;
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    let tree_obj = repo.find_tree(tree).map_err(|e| e.to_string())?;
    let content = repo
        .commit_create_buffer(&signature, &signature, message, &tree_obj, &parent_refs)
        .map_err(|e| format!("commit buffer failed: {e}"))?;
    let oid = object_oid(repo, "commit", content.as_ref());
    let written = write_transaction_object(transaction, repo, "commit", content.as_ref())?.0;
    if written != oid {
        return Err("state commit oid changed while staged".to_string());
    }
    transaction.set_intended_ref(format!("refs/termina/state/{oid}"), oid)?;
    Ok(oid)
}

fn exact_ref_target(repo: &Repository, name: &str) -> Option<Oid> {
    repo.find_reference(name)
        .ok()
        .and_then(|reference| reference.target())
}

fn validate_transaction_ref(
    repo: &Repository,
    name: &str,
    target_hex: &str,
) -> Result<Oid, String> {
    let target = oid_ext(repo, target_hex)
        .map_err(|_| format!("invalid transaction ref target: {target_hex}"))?;
    let canonical_target = target.to_string();
    let state = format!("refs/termina/state/{canonical_target}");
    let merge = format!("refs/termina/merge/{canonical_target}");
    if name != state && name != merge {
        return Err(format!("invalid transaction ref name: {name}"));
    }
    Ok(target)
}

fn prepare_transaction_ref_path(
    repo: &Repository,
    name: &str,
    target: Oid,
) -> Result<PathBuf, String> {
    validate_transaction_ref(repo, name, &target.to_string())?;
    let git_dir = repo.path();
    if !fs::symlink_metadata(git_dir)
        .map_err(|e| format!("inspect store git directory failed: {e}"))?
        .file_type()
        .is_dir()
    {
        return Err("store git path is not a real directory".to_string());
    }
    let refs = git_dir.join("refs");
    let termina = refs.join("termina");
    let namespace = if name.starts_with("refs/termina/state/") {
        termina.join("state")
    } else {
        termina.join("merge")
    };
    ensure_real_directory(&refs, 0o755)?;
    ensure_real_directory(&termina, 0o755)?;
    ensure_real_directory(&namespace, 0o755)?;
    Ok(git_dir.join(name))
}

/// Make an exact loose transaction ref and every ancestor directory durable,
/// then reread the direct target. Visibility before this barrier is not a
/// committed publication.
fn sync_exact_transaction_ref(repo: &Repository, name: &str, target: Oid) -> Result<u64, String> {
    let ref_path = prepare_transaction_ref_path(repo, name, target)?;
    if exact_ref_target(repo, name) != Some(target) {
        return Err(format!(
            "transaction ref is not visible at exact target: {name}"
        ));
    }
    let ref_file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&ref_path)
        .map_err(|e| format!("open transaction ref {} failed: {e}", ref_path.display()))?;
    if !ref_file
        .metadata()
        .map_err(|e| format!("inspect transaction ref failed: {e}"))?
        .file_type()
        .is_file()
    {
        return Err(format!(
            "transaction ref is not a regular file: {}",
            ref_path.display()
        ));
    }
    ref_file
        .sync_all()
        .map_err(|e| format!("sync transaction ref {} failed: {e}", ref_path.display()))?;

    let git_dir = repo.path();
    let mut current = ref_path
        .parent()
        .ok_or("transaction ref has no parent directory")?;
    let mut directory_count = 0u64;
    loop {
        if !current.starts_with(git_dir) {
            return Err("transaction ref escaped the store git directory".to_string());
        }
        sync_directory_nofollow(current)?;
        directory_count += 1;
        if current == git_dir {
            break;
        }
        current = current
            .parent()
            .ok_or("transaction ref directory chain is incomplete")?;
    }
    if exact_ref_target(repo, name) != Some(target) {
        return Err(format!(
            "transaction ref changed during durability sync: {name}"
        ));
    }
    Ok(directory_count)
}

/// Publish the exact transaction ref. A libgit2 error can happen after the
/// lockfile was renamed into place, so the visible ref is authoritative.
fn publish_transaction_ref(
    transaction: &mut StoreObjectTransaction,
    repo: &Repository,
    name: &str,
    target: Oid,
    req: &Value,
    post_write_hook: &str,
    durability_hook: &str,
    durability_error: &str,
    label: &str,
) -> Result<(), String> {
    if !transaction.pending.is_empty() {
        return Err("cannot publish a transaction ref with pending objects".to_string());
    }
    prepare_transaction_ref_path(repo, name, target)?;
    let mut publication = repo
        .reference(name, target, true, "")
        .map(|_| ())
        .map_err(|error| format!("{label} failed: {error}"));
    if publication.is_ok()
        && let Some(marker) = req
            .pointer(&format!("/hooks/{post_write_hook}/markerPath"))
            .and_then(Value::as_str)
    {
        publication = fs::write(marker, b"injected-after-ref-write")
            .map_err(|error| format!("write {post_write_hook} marker failed: {error}"))
            .and(Err(format!("injected {label} failure after write")));
    }
    match publication {
        Ok(()) => {}
        Err(_) if exact_ref_target(repo, name) == Some(target) => {}
        Err(error) => return Err(error),
    }
    if let Some(marker) = req
        .pointer(&format!("/hooks/{durability_hook}/markerPath"))
        .and_then(Value::as_str)
    {
        fs::write(marker, b"injected-before-ref-durability")
            .map_err(|error| format!("write {durability_hook} marker failed: {error}"))?;
        return Err(durability_error.to_string());
    }
    let directory_count = sync_exact_transaction_ref(repo, name, target)?;
    transaction.record_ref_sync(directory_count);
    Ok(())
}

/// Pin a state commit with a store-local ref so gc never prunes it.
fn update_state_ref(
    transaction: &mut StoreObjectTransaction,
    repo: &Repository,
    commit: Oid,
    req: &Value,
) -> Result<(), String> {
    publish_transaction_ref(
        transaction,
        repo,
        &format!("refs/termina/state/{commit}"),
        commit,
        req,
        "failStateRefAfterWrite",
        "failStateRefDurability",
        "injected state ref durability failure",
        "state ref update",
    )
}

fn fail_before_state_ref(req: &Value) -> Result<(), String> {
    if req
        .pointer("/hooks/failStateRef")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err("injected state-ref failure".to_string());
    }
    Ok(())
}

/// Deterministic cross-process test seam. The core announces that it reached
/// a publication boundary, then waits for the spike process to release it.
fn pause_at_hook(req: &Value, name: &str) -> Result<(), String> {
    let Some(hook) = req.pointer(&format!("/hooks/{name}")) else {
        return Ok(());
    };
    let ready = hook
        .get("readyPath")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing {name} readyPath"))?;
    let release = hook
        .get("releasePath")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing {name} releasePath"))?;
    fs::write(ready, b"ready").map_err(|e| format!("write {name} ready marker failed: {e}"))?;
    for _ in 0..6_000 {
        if Path::new(release).exists() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(5));
    }
    Err(format!("timed out waiting for {name} release marker"))
}

// ------------------------------------------------------------ capture -----

/// Enumerate the capture domain: tracked files plus untracked non-ignored
/// files. Matches `git ls-files -z` plus `ls-files --others
/// --exclude-standard` run in the capture root. Repo paths are relative to
/// the working directory; the capture root can be a subdirectory, so strip
/// the working-directory prefix and keep only paths under the root.
fn enumerate_domain(
    repo: &Repository,
    capture_prefix: Option<&str>,
) -> Result<(Vec<String>, HashMap<String, IndexEntry>), String> {
    let map_path = |path: String| -> Option<String> {
        match capture_prefix {
            Some(prefix) => path.strip_prefix(prefix).map(String::from),
            None => Some(path),
        }
    };
    let mut seen = HashSet::new();
    let mut paths = Vec::new();
    // Stage-0 index entries feed the stat-cache: an unchanged file reuses
    // the index blob instead of being read and hashed again.
    let mut index_entries: HashMap<String, IndexEntry> = HashMap::new();
    let index = repo.index().map_err(|e| e.to_string())?;
    for entry in index.iter() {
        let path = String::from_utf8(entry.path.clone())
            .map_err(|_| "a tracked path is not valid UTF-8".to_string())?;
        let Some(path) = map_path(path) else { continue };
        if has_git_segment(&path) {
            return Err(format!("nested repository in capture domain: {path}"));
        }
        // Stage 0 only: conflict stages must re-hash.
        if (entry.flags & 0x3000) >> 12 == 0 {
            index_entries.insert(path.clone(), entry);
        }
        if seen.insert(path.clone()) {
            paths.push(path);
        }
    }
    let statuses = repo
        .statuses(Some(
            &mut StatusOptions::new()
                .include_untracked(true)
                .recurse_untracked_dirs(true),
        ))
        .map_err(|e| e.to_string())?;
    for status in statuses.iter() {
        if status.status().is_wt_new() {
            let path = status.path().unwrap_or("").to_string();
            if path.is_empty() {
                continue;
            }
            let Some(path) = map_path(path) else { continue };
            if has_git_segment(&path) {
                return Err(format!("nested repository in capture domain: {path}"));
            }
            if seen.insert(path.clone()) {
                paths.push(path);
            }
        }
    }
    Ok((paths, index_entries))
}

/// The stat-cached blob for one unchanged working-tree path. Returns None
/// unless the descriptor-relative leaf metadata matches its stage-0 index
/// entry exactly. Callers must still copy the referenced blob into the store.
fn stat_cached_entry(
    st: FileIdentity,
    entry: &IndexEntry,
    max_file_bytes: u64,
    index_write: Option<std::time::SystemTime>,
) -> Option<(u32, Oid)> {
    let mode = entry.mode;
    if mode != 0o100644 && mode != 0o100755 && mode != 0o120000 {
        return None;
    }
    // Racy-git rule: a file modified at or after the last index write is
    // re-read even when every other stat field matches.
    if let Some(index_write) = index_write {
        let index_write = index_write.duration_since(UNIX_EPOCH).ok()?;
        let index_write = (
            index_write.as_secs() as i64,
            index_write.subsec_nanos() as i64,
        );
        if st.mtime >= index_write {
            return None;
        }
    }
    let entry_mtime = entry.mtime;
    let entry_ctime = entry.ctime;
    let stat_matches = st.dev == u64::from(entry.dev)
        && st.ino == u64::from(entry.ino)
        && st.len == u64::from(entry.file_size)
        && st.mtime.0 == i64::from(entry_mtime.seconds())
        && st.mtime.1 == i64::from(entry_mtime.nanoseconds())
        && st.ctime.0 == i64::from(entry_ctime.seconds())
        && st.ctime.1 == i64::from(entry_ctime.nanoseconds());
    if !stat_matches {
        return None;
    }
    if mode == 0o120000 {
        if !st.is_symlink() {
            return None;
        }
        return Some((0o120000, entry.id));
    }
    if !st.is_file() {
        return None;
    }
    if st.len > max_file_bytes {
        return None;
    }
    // An executable-bit change must re-hash so the tree records the mode.
    let live_mode = if st.mode & 0o111 != 0 {
        0o100755
    } else {
        0o100644
    };
    if live_mode != mode {
        return None;
    }
    Some((mode, entry.id))
}

/// Read every blob that may be supplied by the stat cache while the source
/// repository binding is still active.  The full capture never asks libgit2
/// for an object after this function returns; later source reads are all
/// descriptor-relative and therefore cannot mix an object store from a
/// replaced repository with bytes from the retained worktree descriptor.
fn preload_cached_blobs(
    source: &BoundSourceRepository,
    capture_root: &CaptureRoot,
    oids: &HashSet<Oid>,
    store: &Repository,
) -> Result<HashMap<Oid, Vec<u8>>, String> {
    let mut blobs = HashMap::with_capacity(oids.len());
    for oid in oids {
        source.verify(capture_root)?;
        let blob = source
            .repo
            .find_blob(*oid)
            .map_err(|error| format!("cached source blob {oid} is unavailable: {error}"))?;
        let content = blob.content().to_vec();
        source.verify(capture_root)?;
        if object_oid(store, "blob", &content) != *oid {
            return Err(format!(
                "cached source blob {oid} failed object identity verification"
            ));
        }
        blobs.insert(*oid, content);
    }
    Ok(blobs)
}

fn read_link_at(parent: RawFd, name: &CStr) -> io::Result<Vec<u8>> {
    let mut bytes = vec![0u8; PROMOTION_PATH_MAX_BYTES + 1];
    let len = unsafe {
        libc::readlinkat(
            parent,
            name.as_ptr(),
            bytes.as_mut_ptr().cast::<libc::c_char>(),
            bytes.len(),
        )
    };
    if len == -1 {
        return Err(io::Error::last_os_error());
    }
    let len = len as usize;
    if len > PROMOTION_PATH_MAX_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "promotion symlink target exceeds its bounded path budget",
        ));
    }
    bytes.truncate(len);
    Ok(bytes)
}

// ------------------------------------------------ promotion native boundary --

/// The native promotion boundary deliberately returns no parsed journal
/// fields. Electron owns promotion policy; core only binds descriptors,
/// verifies expected identities/states, and performs preservation-first
/// namespace transitions.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PromotionIdentity {
    dev: u64,
    ino: u64,
}

/// A root capability is intentionally scoped to this long-lived core child.
/// Callers may use it instead of re-authenticating a mutable pathname.  The
/// registry is process-local by design: after a core restart an old token is
/// unknown and every operation fails closed until the caller presents a
/// previously persisted identity from its trusted owner.
#[derive(Clone, Debug)]
struct PromotionRootCapability {
    path: String,
    identity: PromotionIdentity,
}

const MAX_PROMOTION_ROOT_CAPABILITIES: usize = 4_096;
static PROMOTION_ROOT_CAPABILITIES: OnceLock<Mutex<HashMap<String, PromotionRootCapability>>> =
    OnceLock::new();
static PROMOTION_ROOT_CAPABILITY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn promotion_root_capabilities() -> &'static Mutex<HashMap<String, PromotionRootCapability>> {
    PROMOTION_ROOT_CAPABILITIES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn issue_promotion_root_capability(
    path: &str,
    identity: PromotionIdentity,
) -> Result<String, String> {
    let mut capabilities = promotion_root_capabilities()
        .lock()
        .map_err(|_| "promotion root capability registry poisoned".to_string())?;
    if let Some((token, _)) = capabilities
        .iter()
        .find(|(_, capability)| capability.path == path && capability.identity == identity)
    {
        return Ok(token.clone());
    }
    if capabilities.len() >= MAX_PROMOTION_ROOT_CAPABILITIES {
        return Err(format!(
            "promotion root capability registry is at capacity ({MAX_PROMOTION_ROOT_CAPABILITIES}); restart core to rebind trusted roots"
        ));
    }
    let sequence = PROMOTION_ROOT_CAPABILITY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let token = format!("promotion-root-{sequence:016x}-{}", std::process::id());
    capabilities.insert(
        token.clone(),
        PromotionRootCapability {
            path: path.to_string(),
            identity,
        },
    );
    Ok(token)
}

#[cfg(test)]
mod promotion_root_capability_tests {
    use super::*;

    #[test]
    fn registry_is_bounded_without_replacing_reused_capabilities() {
        let mut registry = promotion_root_capabilities()
            .lock()
            .expect("promotion root capability registry poisoned");
        registry.clear();
        drop(registry);

        let active_identity = PromotionIdentity { dev: 1, ino: 1 };
        let active = issue_promotion_root_capability("/active", active_identity).unwrap();
        for index in 1..MAX_PROMOTION_ROOT_CAPABILITIES {
            issue_promotion_root_capability(
                &format!("/root-{index}"),
                PromotionIdentity {
                    dev: 1,
                    ino: index as u64 + 1,
                },
            )
            .unwrap();
        }

        assert_eq!(
            issue_promotion_root_capability("/active", active_identity).unwrap(),
            active
        );
        assert!(issue_promotion_root_capability(
            "/overflow",
            PromotionIdentity {
                dev: 2,
                ino: 1,
            },
        )
        .is_err());
        assert_eq!(
            promotion_root_capabilities()
                .lock()
                .expect("promotion root capability registry poisoned")
                .len(),
            MAX_PROMOTION_ROOT_CAPABILITIES
        );

        promotion_root_capabilities()
            .lock()
            .expect("promotion root capability registry poisoned")
            .clear();
    }
}

#[derive(Clone, Debug)]
enum PromotionExpectedState {
    File {
        mode: u32,
        size: u64,
        sha256: String,
    },
    Symlink {
        target: String,
    },
}

#[derive(Clone, Debug)]
struct PromotionExpectedLeaf {
    identity: PromotionIdentity,
    state: PromotionExpectedState,
}

#[derive(Clone, Debug)]
enum PromotionObservedState {
    File {
        mode: u32,
        size: u64,
        sha256: String,
    },
    Symlink {
        target: String,
    },
    Other,
}

#[derive(Clone, Debug)]
struct PromotionObservedLeaf {
    identity: PromotionIdentity,
    state: PromotionObservedState,
}

fn promotion_identity_from_value(value: &Value, field: &str) -> Result<PromotionIdentity, String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{field} must be an object"))?;
    let parse = |key: &str| -> Result<u64, String> {
        let raw = object
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{field}.{key} must be a decimal string"))?;
        if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(format!("{field}.{key} must be an unsigned decimal string"));
        }
        raw.parse::<u64>()
            .map_err(|_| format!("{field}.{key} does not fit u64"))
    };
    Ok(PromotionIdentity {
        dev: parse("dev")?,
        ino: parse("ino")?,
    })
}

fn promotion_component(value: &Value, field: &str) -> Result<(String, CString), String> {
    let value = value
        .as_str()
        .ok_or_else(|| format!("{field} must be a string"))?;
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
        || value.contains('\0')
        || value.len() > PROMOTION_COMPONENT_MAX_BYTES
    {
        return Err(format!("invalid promotion path component: {field}"));
    }
    let cstring = CString::new(value.as_bytes())
        .map_err(|_| format!("invalid promotion path component: {field}"))?;
    Ok((value.to_string(), cstring))
}

fn promotion_name(value: &Value, field: &str, prefix: &str) -> Result<(String, CString), String> {
    let (value, cstring) = promotion_component(value, field)?;
    if !value.starts_with(prefix) || !value.ends_with(".tmp") {
        return Err(format!("invalid promotion {field}"));
    }
    Ok((value, cstring))
}

fn promotion_absolute_path(value: &str, field: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > PROMOTION_PATH_MAX_BYTES || !value.starts_with('/') {
        return Err(format!("invalid promotion {field}"));
    }
    if value.contains('\0') {
        return Err(format!("invalid promotion {field}"));
    }
    Ok(())
}

fn promotion_sha256(value: &Value, field: &str) -> Result<String, String> {
    let value = value
        .as_str()
        .ok_or_else(|| format!("{field} must be a lowercase SHA-256 string"))?;
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(format!("{field} must be a lowercase SHA-256 string"));
    }
    Ok(value.to_string())
}

fn promotion_size(value: &Value, field: &str) -> Result<u64, String> {
    let value = value
        .as_str()
        .ok_or_else(|| format!("{field} must be a decimal string"))?;
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("{field} must be an unsigned decimal string"));
    }
    value
        .parse::<u64>()
        .map_err(|_| format!("{field} does not fit u64"))
}

fn parse_promotion_expected(value: &Value, field: &str) -> Result<PromotionExpectedLeaf, String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{field} must be an object"))?;
    let identity = promotion_identity_from_value(
        object
            .get("identity")
            .ok_or_else(|| format!("{field}.identity is missing"))?,
        &format!("{field}.identity"),
    )?;
    let state = object
        .get("state")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{field}.state must be an object"))?;
    let state_type = state
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{field}.state.type is missing"))?;
    let state = match state_type {
        "file" => {
            let mode = state
                .get("mode")
                .and_then(Value::as_u64)
                .filter(|mode| *mode <= 0o777)
                .ok_or_else(|| format!("{field}.state.mode is invalid"))?
                as u32;
            let size = promotion_size(
                state
                    .get("size")
                    .ok_or_else(|| format!("{field}.state.size is missing"))?,
                &format!("{field}.state.size"),
            )?;
            if size > BUDGET_MAX_FILE_BYTES {
                return Err(format!(
                    "{field}.state.size exceeds the promotion file budget"
                ));
            }
            PromotionExpectedState::File {
                mode,
                size,
                sha256: promotion_sha256(
                    state
                        .get("sha256")
                        .ok_or_else(|| format!("{field}.state.sha256 is missing"))?,
                    &format!("{field}.state.sha256"),
                )?,
            }
        }
        "symlink" => {
            let target = state
                .get("target")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("{field}.state.target is missing"))?;
            if target.contains('\0') || target.len() > PROMOTION_PATH_MAX_BYTES {
                return Err(format!("{field}.state.target is too long"));
            }
            PromotionExpectedState::Symlink {
                target: target.to_string(),
            }
        }
        _ => return Err(format!("{field}.state.type is unsupported")),
    };
    Ok(PromotionExpectedLeaf { identity, state })
}

/// Parse a destination expectation for an install. An absent destination is
/// represented explicitly as `{state:{type:"missing"}}`; unlike a
/// materialized leaf it has no identity to bind.
fn parse_promotion_expected_destination(
    value: &Value,
    field: &str,
) -> Result<Option<PromotionExpectedLeaf>, String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{field} must be an object"))?;
    let state_type = object
        .get("state")
        .and_then(Value::as_object)
        .and_then(|state| state.get("type"))
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{field}.state.type is missing"))?;
    if state_type == "missing" {
        let state = object
            .get("state")
            .and_then(Value::as_object)
            .expect("state object was checked above");
        if state.len() != 1 || object.len() != 1 {
            return Err(format!("{field} missing expectation has unexpected fields"));
        }
        return Ok(None);
    }
    Ok(Some(parse_promotion_expected(value, field)?))
}

fn promotion_sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn promotion_expected_matches(
    expected: &PromotionExpectedLeaf,
    observed: Option<&PromotionObservedLeaf>,
) -> bool {
    let Some(observed) = observed else {
        return false;
    };
    if expected.identity.dev != observed.identity.dev
        || expected.identity.ino != observed.identity.ino
    {
        return false;
    }
    match (&expected.state, &observed.state) {
        (
            PromotionExpectedState::File { mode, size, sha256 },
            PromotionObservedState::File {
                mode: actual_mode,
                size: actual_size,
                sha256: actual_sha256,
            },
        ) => mode == actual_mode && size == actual_size && sha256 == actual_sha256,
        (
            PromotionExpectedState::Symlink { target },
            PromotionObservedState::Symlink {
                target: actual_target,
            },
        ) => target == actual_target,
        _ => false,
    }
}

fn promotion_expected_state_description(expected: &PromotionExpectedLeaf) -> &'static str {
    match expected.state {
        PromotionExpectedState::File { .. } => "file",
        PromotionExpectedState::Symlink { .. } => "symlink",
    }
}

fn observe_promotion_leaf(
    parent: RawFd,
    name: &CStr,
) -> Result<Option<PromotionObservedLeaf>, String> {
    let identity = match stat_at(parent, name) {
        Ok(identity) => identity,
        Err(error) if missing_path(&error) => return Ok(None),
        Err(error) => return Err(format!("stat promotion leaf failed: {error}")),
    };
    let promotion_identity = PromotionIdentity {
        dev: identity.dev,
        ino: identity.ino,
    };
    if identity.is_file() {
        let file = open_at(
            parent,
            name,
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
        .map_err(|error| format!("open promotion leaf failed: {error}"))?;
        let before =
            stat_file(&file).map_err(|error| format!("fstat promotion leaf failed: {error}"))?;
        if !before.is_file() || before.dev != identity.dev || before.ino != identity.ino {
            return Err("promotion leaf changed type or identity while opening".to_string());
        }
        let mut bytes = Vec::new();
        let read_limit = BUDGET_MAX_FILE_BYTES
            .checked_add(1)
            .ok_or("promotion file budget overflow")?;
        (&file)
            .take(read_limit)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("read promotion leaf failed: {error}"))?;
        if bytes.len() as u64 > BUDGET_MAX_FILE_BYTES {
            return Err("promotion leaf exceeds the file budget".to_string());
        }
        let after =
            stat_file(&file).map_err(|error| format!("fstat promotion leaf failed: {error}"))?;
        let path_after = stat_at(parent, name)
            .map_err(|error| format!("stat promotion leaf failed: {error}"))?;
        if before != after || after != path_after {
            return Err("promotion leaf changed while reading".to_string());
        }
        return Ok(Some(PromotionObservedLeaf {
            identity: promotion_identity,
            state: PromotionObservedState::File {
                mode: before.mode & 0o777,
                size: bytes.len() as u64,
                sha256: promotion_sha256_hex(&bytes),
            },
        }));
    }
    if identity.is_symlink() {
        let target = read_link_at(parent, name)
            .map_err(|error| format!("read promotion symlink failed: {error}"))?;
        let after = stat_at(parent, name)
            .map_err(|error| format!("stat promotion symlink failed: {error}"))?;
        if identity != after {
            return Err("promotion symlink changed while reading".to_string());
        }
        let target = String::from_utf8(target)
            .map_err(|_| "promotion symlink target is not valid UTF-8".to_string())?;
        if target.len() > PROMOTION_PATH_MAX_BYTES {
            return Err("promotion symlink target is too long".to_string());
        }
        return Ok(Some(PromotionObservedLeaf {
            identity: promotion_identity,
            state: PromotionObservedState::Symlink { target },
        }));
    }
    Ok(Some(PromotionObservedLeaf {
        identity: promotion_identity,
        state: PromotionObservedState::Other,
    }))
}

fn open_promotion_absolute_directory(path: &str, field: &str) -> Result<fs::File, String> {
    promotion_absolute_path(path, field)?;
    // macOS exposes /var as a fixed system alias.  Accept that one
    // system-owned spelling consistently with the source capture boundary;
    // arbitrary caller-controlled symlink components remain rejected by the
    // descriptor walk below.
    let normalized = normalize_system_alias_path(Path::new(path), field)?;
    let mut current = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open("/")
        .map_err(|error| format!("open promotion root failed: {error}"))?;
    for component in normalized.components() {
        let Component::Normal(name) = component else {
            if matches!(component, Component::RootDir) {
                continue;
            }
            return Err(format!("promotion {field} must be canonical"));
        };
        let name = CString::new(name.to_string_lossy().as_bytes())
            .map_err(|_| format!("promotion {field} contains invalid bytes"))?;
        current = open_at(
            current.as_raw_fd(),
            &name,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
        .map_err(|error| {
            format!(
                "open promotion {field} path {path} component {} failed: {error}",
                name.to_string_lossy()
            )
        })?;
    }
    let identity =
        stat_file(&current).map_err(|error| format!("fstat promotion {field} failed: {error}"))?;
    if !identity.is_dir() {
        return Err(format!("promotion {field} is not a directory"));
    }
    Ok(current)
}

/// Run a Git operation with the process working directory set from an
/// already-open directory descriptor.  libgit2 only accepts paths, but a
/// descriptor-relative cwd keeps `Repository::init/open` and its subsequent
/// index/object writes on the bound directory even if an ancestor is swapped
/// while the request is in flight.  Core handles requests serially, so this
/// short-lived cwd change cannot be observed by another core operation.
struct PromotionCwd {
    previous: fs::File,
}

impl PromotionCwd {
    fn enter(directory: &fs::File, field: &str) -> Result<Self, String> {
        let dot = CString::new(".").expect("directory component has no NUL");
        let previous = open_at(
            libc::AT_FDCWD,
            &dot,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
        .map_err(|error| format!("open previous cwd for promotion {field} failed: {error}"))?;
        let rc = unsafe { libc::fchdir(directory.as_raw_fd()) };
        if rc == -1 {
            return Err(format!(
                "change cwd for promotion {field} failed: {}",
                io::Error::last_os_error()
            ));
        }
        Ok(Self { previous })
    }
}

impl Drop for PromotionCwd {
    fn drop(&mut self) {
        // There is no useful recovery path if restoring cwd fails.  Keep the
        // core process alive; all later absolute/descriptor-relative work is
        // still valid and the next bound repository request rebinds cwd.
        let _ = unsafe { libc::fchdir(self.previous.as_raw_fd()) };
    }
}

fn promotion_bound_path_matches(
    path: &str,
    expected: PromotionIdentity,
    field: &str,
) -> Result<(), String> {
    let directory = open_promotion_absolute_directory(path, field)?;
    promotion_directory_identity_matches(&directory, expected, field)
}

/// Open one promotion root either through a capability held by this core
/// process or through a caller-supplied identity established by its trusted
/// owner.  A pathname alone is never an authentication input.  Capability
/// requests still carry the path for diagnostics and must match the path that
/// was bound when the token was issued; the actual open uses the registry's
/// stored path and identity.
fn open_promotion_bound_root(
    req: &Value,
    path_field: &str,
    identity_field: &str,
    capability_field: &str,
) -> Result<(fs::File, PromotionIdentity, String), String> {
    let requested_path = s(req, path_field)?;
    let expected = req
        .get(identity_field)
        .map(|value| promotion_identity_from_value(value, identity_field))
        .transpose()?;
    open_promotion_bound_root_values(
        &requested_path,
        expected,
        opt_s(req, capability_field).as_deref(),
        path_field,
    )
}

fn open_promotion_bound_root_values(
    requested_path: &str,
    expected: Option<PromotionIdentity>,
    capability_token: Option<&str>,
    path_field: &str,
) -> Result<(fs::File, PromotionIdentity, String), String> {
    if let Some(token) = capability_token {
        let capability = {
            let capabilities = promotion_root_capabilities()
                .lock()
                .map_err(|_| "promotion root capability registry poisoned".to_string())?;
            capabilities
                .get(token)
                .cloned()
                .ok_or_else(|| "promotion root capability is unknown; core was restarted; rebind from persisted trusted identity".to_string())?
        };
        if capability.path != requested_path {
            return Err(format!(
                "promotion {path_field} does not match its bound capability"
            ));
        }
        let directory = open_promotion_absolute_directory(&capability.path, path_field)?;
        promotion_directory_identity_matches(&directory, capability.identity, path_field)?;
        if expected.is_some_and(|expected| expected != capability.identity) {
            return Err(format!(
                "promotion {path_field} identity does not match its bound capability"
            ));
        }
        return Ok((directory, capability.identity, token.to_string()));
    }
    let expected = expected.ok_or_else(|| {
        format!("{path_field} requires a previously trusted identity or capability")
    })?;
    let directory = open_promotion_absolute_directory(&requested_path, path_field)?;
    promotion_directory_identity_matches(&directory, expected, path_field)?;
    let token = issue_promotion_root_capability(&requested_path, expected)?;
    Ok((directory, expected, token))
}

fn promotion_path_with_components(root: &str, components: &[(String, CString)]) -> String {
    let mut path = root.trim_end_matches('/').to_string();
    for (name, _) in components {
        path.push('/');
        path.push_str(name);
    }
    if path.is_empty() {
        "/".to_string()
    } else {
        path
    }
}

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
/// component a conflict instead of silently adopting it.
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

/// Validate a directory opened through a trusted descriptor.  The retained
/// root uses the private variant; generic promotion roots only require the
/// current user to own the directory because a project root may be mode 755.
fn promotion_owned_directory(
    directory: &fs::File,
    field: &str,
    require_private: bool,
) -> Result<FileIdentity, String> {
    let (identity, uid) =
        stat_file_owned(directory).map_err(|error| format!("fstat promotion {field} failed: {error}"))?;
    if !identity.is_dir() {
        return Err(format!("promotion {field} is not a directory"));
    }
    if uid != unsafe { libc::geteuid() as u64 } {
        return Err(format!("promotion {field} is not owned by the current user"));
    }
    if require_private && identity.mode & 0o077 != 0 {
        return Err(format!("promotion {field} is not private"));
    }
    Ok(identity)
}

fn retained_root_safe_id(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn retained_root_hex_staging(name: &str) -> bool {
    name.len() == 34
        && name.starts_with("t-")
        && name[2..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn retained_root_claim(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(".termina-retained-claim-") else {
        return false;
    };
    let Some(run_id) = rest.strip_suffix(".json") else {
        return false;
    };
    retained_root_safe_id(run_id)
}

fn retained_root_metadata(name: &str) -> bool {
    name == ".termina-retained-session-root"
        || name == ".termina-retained-session-root.tmp"
        || name == ".termina-retained-session-admission.lock"
        || name == ".termina-retained-session-usage.json"
        || (name.starts_with(".termina-retained-session-usage.json.tmp-")
            && name.len() <= 256)
}

fn retained_root_top_level_name(name: &str) -> Result<bool, String> {
    if retained_root_metadata(name) {
        return Ok(false);
    }
    if retained_root_hex_staging(name) || retained_root_claim(name) || retained_root_safe_id(name) {
        return Ok(true);
    }
    Err(format!("retained session root contains an unexpected entry: {name}"))
}

struct RetainedRootScan {
    entries: usize,
    bytes: u64,
    work_bytes: u64,
    has_data: bool,
}

/// Validate an existing legacy retained tree while every directory component
/// is opened relative to the already-bound root descriptor.  This is a
/// bounded structural proof only; Electron still performs the schema-aware
/// usage measurement before admission.  The walk is iterative so an
/// adversarial deep tree cannot consume native call-stack space.
fn promotion_validate_retained_directory(
    directory: &fs::File,
    depth: usize,
    root_level: bool,
    scan: &mut RetainedRootScan,
) -> Result<(), String> {
    struct RetainedScanFrame {
        directory: fs::File,
        stream: PromotionDirectoryStream,
        depth: usize,
        root_level: bool,
    }
    if depth > RETAINED_ROOT_MAX_SCAN_DEPTH {
        return Err("retained root exceeds its depth bound".to_string());
    }
    let mut stack = Vec::with_capacity(RETAINED_ROOT_MAX_SCAN_DEPTH + 1);
    stack.push(RetainedScanFrame {
        directory: directory
            .try_clone()
            .map_err(|error| format!("clone retained root directory failed: {error}"))?,
        stream: PromotionDirectoryStream::open(directory.as_raw_fd())?,
        depth,
        root_level,
    });
    let mut root_entry_count = 0usize;
    while !stack.is_empty() {
        let next = stack
            .last_mut()
            .expect("retained root scan stack is not empty")
            .stream
            .next_entry()?;
        let Some((name, c_name)) = next else {
            stack.pop();
            continue;
        };
        let frame = stack.last().expect("retained root scan frame exists");
        if frame.root_level {
            root_entry_count = root_entry_count
                .checked_add(1)
                .ok_or("retained root entry count overflow")?;
            if root_entry_count > RETAINED_ROOT_MAX_ENTRIES {
                return Err(format!(
                    "retained root contains too many entries ({RETAINED_ROOT_MAX_ENTRIES})"
                ));
            }
        }
        let added_work = u64::try_from(name.len())
            .map_err(|_| "retained root work overflow")?
            .checked_add(std::mem::size_of::<FileIdentity>() as u64)
            .ok_or("retained root work accounting overflow")?;
        scan.work_bytes = scan
            .work_bytes
            .checked_add(added_work)
            .ok_or("retained root work accounting overflow")?;
        if scan.work_bytes > RETAINED_ROOT_MAX_SCAN_WORK_BYTES {
            return Err("retained root scan exceeded its work bound".to_string());
        }
        if frame.root_level && retained_root_top_level_name(&name)? {
            scan.has_data = true;
        }
        scan.entries = scan
            .entries
            .checked_add(1)
            .ok_or("retained root entry accounting overflow")?;
        if scan.entries > RETAINED_ROOT_MAX_SCAN_ENTRIES {
            return Err(format!(
                "retained root contains too many entries ({RETAINED_ROOT_MAX_SCAN_ENTRIES})"
            ));
        }
        let (directory_fd, depth) = (frame.directory.as_raw_fd(), frame.depth);
        let (identity, uid) = stat_at_owned(directory_fd, &c_name)
            .map_err(|error| format!("stat retained root entry {name} failed: {error}"))?;
        if uid != unsafe { libc::geteuid() as u64 } || identity.mode & 0o077 != 0 {
            return Err(format!("retained root entry {name} is not a private app-owned entry"));
        }
        if identity.is_symlink() || (!identity.is_dir() && !identity.is_file()) {
            return Err(format!("retained root entry {name} has an unsupported file type"));
        }
        if identity.is_file() {
            scan.bytes = scan
                .bytes
                .checked_add(identity.len)
                .ok_or("retained root byte accounting overflow")?;
            if scan.bytes > RETAINED_ROOT_MAX_SCAN_BYTES {
                return Err("retained root exceeds its byte bound".to_string());
            }
            let file = open_at(
                directory_fd,
                &c_name,
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|error| format!("open retained root file {name} failed: {error}"))?;
            if stat_file(&file)
                .map_err(|error| format!("fstat retained root file {name} failed: {error}"))?
                != identity
            {
                return Err(format!("retained root file {name} changed while validating"));
            }
            continue;
        }
        if depth >= RETAINED_ROOT_MAX_SCAN_DEPTH {
            return Err("retained root exceeds its depth bound".to_string());
        }
        let child = open_at(
            directory_fd,
            &c_name,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
        .map_err(|error| format!("open retained root directory {name} failed: {error}"))?;
        if stat_file(&child)
            .map_err(|error| format!("fstat retained root directory {name} failed: {error}"))?
            != identity
        {
            return Err(format!("retained root directory {name} changed while validating"));
        }
        if stack.len() >= RETAINED_ROOT_MAX_SCAN_DEPTH + 1 {
            return Err("retained root exceeds its depth bound".to_string());
        }
        stack.push(RetainedScanFrame {
            stream: PromotionDirectoryStream::open(child.as_raw_fd())?,
            directory: child,
            depth: depth + 1,
            root_level: false,
        });
    }
    Ok(())
}

fn promotion_validate_marker(
    root: &fs::File,
    name: &CStr,
    expected: &[u8],
    expected_mode: u32,
) -> Result<FileIdentity, String> {
    let (identity, bytes) = promotion_read_private_bounded_file(
        root,
        name,
        RETAINED_ROOT_MARKER_MAX_BYTES,
        "retained root marker",
    )?;
    if identity.mode & 0o777 != expected_mode || bytes != expected {
        return Err("retained root marker changed or is invalid".to_string());
    }
    Ok(identity)
}

fn promotion_create_bound_file(
    parent: &fs::File,
    name: &CStr,
    content: &[u8],
    mode: u32,
    field: &str,
    pause_stage: Option<(&Value, &str)>,
) -> Result<FileIdentity, String> {
    promotion_publish_private_exclusive(
        parent,
        name,
        content,
        mode,
        RETAINED_ROOT_MARKER_MAX_BYTES,
        field,
        pause_stage,
    )
}

/// Persist provenance below the descriptor-bound provenance parent. The
/// descriptor-relative temporary/no-replace publish keeps a crash from
/// exposing a partial final record. If another creator won the race, accept
/// only byte-for-byte equal durable provenance for the exact same root
/// identity.
fn promotion_persist_root_provenance(
    parent: &fs::File,
    name: &CStr,
    content: &[u8],
    pause_stage: Option<(&Value, &str)>,
) -> Result<FileIdentity, String> {
    promotion_publish_private_exclusive(
        parent,
        name,
        content,
        0o600,
        RETAINED_ROOT_PROVENANCE_MAX_BYTES,
        "promotion root provenance",
        pause_stage,
    )
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PromotionRootStateKind {
    Pending,
    Bound,
}

#[derive(Clone, Debug)]
struct PromotionRootState {
    kind: PromotionRootStateKind,
    path: String,
    parent: PromotionIdentity,
    root: PromotionIdentity,
    identity: FileIdentity,
}

/// Read one small private metadata file through the already-bound parent
/// descriptor. This is deliberately shared by the adoption tombstone and
/// provenance paths so a pathname replacement cannot change the bytes between
/// the identity check and the read.
fn promotion_read_private_bounded_file(
    parent: &fs::File,
    name: &CStr,
    max_bytes: usize,
    field: &str,
) -> Result<(FileIdentity, Vec<u8>), String> {
    let file = open_at(
        parent.as_raw_fd(),
        name,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )
    .map_err(|error| format!("open {field} failed: {error}"))?;
    promotion_read_private_bounded_opened(parent, name, file, max_bytes, field)
}

fn promotion_read_private_bounded_if_present(
    parent: &fs::File,
    name: &CStr,
    max_bytes: usize,
    field: &str,
) -> Result<Option<(FileIdentity, Vec<u8>)>, String> {
    let file = match open_at(
        parent.as_raw_fd(),
        name,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    ) {
        Ok(file) => file,
        Err(error) if error.raw_os_error() == Some(libc::ENOENT) => return Ok(None),
        Err(error) => return Err(format!("open {field} failed: {error}")),
    };
    promotion_read_private_bounded_opened(parent, name, file, max_bytes, field).map(Some)
}

fn promotion_read_private_bounded_opened(
    parent: &fs::File,
    name: &CStr,
    mut file: fs::File,
    max_bytes: usize,
    field: &str,
) -> Result<(FileIdentity, Vec<u8>), String> {
    let before = stat_promotion_journal_file(&file)
        .map_err(|error| format!("fstat {field} failed: {error}"))?;
    if !promotion_private_identity_valid(before, None, max_bytes) {
        return Err(format!("{field} is not a bounded private app-owned file"));
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("seek {field} failed: {error}"))?;
    let mut bytes = Vec::new();
    (&file)
        .take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read {field} failed: {error}"))?;
    if bytes.len() > max_bytes {
        return Err(format!("{field} exceeds its bounded metadata size"));
    }
    let after = stat_promotion_journal_file(&file)
        .map_err(|error| format!("fstat {field} failed: {error}"))?;
    let path_after = stat_promotion_private_at(parent.as_raw_fd(), name)
        .map_err(|error| format!("stat {field} failed: {error}"))?;
    if before != after || after != path_after {
        return Err(format!("{field} changed while reading"));
    }
    Ok((after.file, bytes))
}

/// Derive the one recovery slot used when publishing a private metadata file.
/// The slot is descriptor-relative and deterministic: a killed writer cannot
/// leave an ever-growing sequence of process/clock-named files behind.
fn promotion_private_temporary_name(name: &CStr) -> Result<CString, String> {
    let mut bytes = name.to_bytes().to_vec();
    bytes.extend_from_slice(b".tmp");
    if bytes.len() > PROMOTION_COMPONENT_MAX_BYTES {
        return Err("promotion metadata temporary name is too long".to_string());
    }
    CString::new(bytes).map_err(|_| "promotion metadata temporary name contains NUL".to_string())
}

/// Publish one bounded private file with an exclusive, descriptor-relative
/// temporary followed by no-replace rename. The final name is never written
/// in place, so a crash can expose either the old complete record or the
/// complete temporary; it cannot expose a partially-written provenance,
/// state, or marker record. A racing creator is accepted only when its final
/// bytes are identical, preserving once-only identity binding.
fn promotion_publish_private_exclusive(
    parent: &fs::File,
    name: &CStr,
    content: &[u8],
    mode: u32,
    max_bytes: usize,
    field: &str,
    pause_stage: Option<(&Value, &str)>,
) -> Result<FileIdentity, String> {
    if content.is_empty() || content.len() > max_bytes {
        return Err(format!("{field} exceeds its bounded metadata size"));
    }

    // A complete final record is authoritative. Do not replace or rewrite
    // it, even when the caller is retrying after a process restart.
    if let Some(final_identity) = promotion_read_private_bounded_if_present(
        parent, name, max_bytes, field,
    )? {
        let final_stat = stat_promotion_private_at(parent.as_raw_fd(), name)
            .map_err(|error| format!("stat {field} failed: {error}"))?;
        if !promotion_private_identity_valid(final_stat, Some(mode), max_bytes)
            || final_stat.file != final_identity.0
        {
            return Err(format!("{field} is not a bounded private app-owned file"));
        }
        let (identity, observed) = final_identity;
        if observed != content {
            return Err(format!("{field} identity mismatch"));
        }
        parent
            .sync_all()
            .map_err(|error| format!("sync {field} parent failed: {error}"))?;
        return Ok(identity);
    }

    let temporary = promotion_private_temporary_name(name)?;
    let temporary_file = match open_at(
        parent.as_raw_fd(),
        &temporary,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    ) {
        Ok(file) => {
            let temporary_identity = stat_promotion_journal_file(&file)
                .map_err(|error| format!("fstat existing {field} temporary failed: {error}"))?;
            if !promotion_private_identity_valid(
                temporary_identity,
                Some(mode),
                max_bytes,
            ) {
                return Err(format!("{field} temporary is not a bounded private app-owned file"));
            }
            let (_, observed) = promotion_read_private_bounded_opened(
                parent,
                &temporary,
                file.try_clone()
                    .map_err(|error| format!("clone existing {field} temporary failed: {error}"))?,
                max_bytes,
                &format!("existing {field} temporary"),
            )?;
            if observed != content {
                return Err(format!("{field} temporary identity mismatch"));
            }
            file
        }
        Err(error) if error.raw_os_error() == Some(libc::ENOENT) => {
            let mut file = open_at_mode(
                parent.as_raw_fd(),
                &temporary,
                libc::O_RDWR
                    | libc::O_CREAT
                    | libc::O_EXCL
                    | libc::O_NOFOLLOW
                    | libc::O_CLOEXEC,
                mode as libc::mode_t,
            )
            .map_err(|error| format!("create {field} temporary failed: {error}"))?;
            promotion_write_all(&mut file, content, &format!("{field} temporary"))?;
            promotion_set_mode(&file, mode, &format!("{field} temporary"))?;
            file
                .sync_all()
                .map_err(|error| format!("sync {field} temporary failed: {error}"))?;
            let temporary_identity = stat_promotion_journal_file(&file)
                .map_err(|error| format!("fstat {field} temporary failed: {error}"))?;
            let temporary_path_identity = stat_promotion_private_at(parent.as_raw_fd(), &temporary)
                .map_err(|error| format!("stat {field} temporary failed: {error}"))?;
            if temporary_identity != temporary_path_identity
                || !promotion_private_identity_valid(temporary_identity, Some(mode), max_bytes)
                || temporary_identity.file.len != content.len() as u64
            {
                return Err(format!("{field} temporary changed while writing"));
            }
            file
        }
        Err(error) => return Err(format!("open {field} temporary failed: {error}")),
    };

    // Persist the directory entry for the recovery slot before publishing its
    // final name. A restart can therefore find and complete this exact
    // identity-bound record after a crash at any point before the rename.
    parent
        .sync_all()
        .map_err(|error| format!("sync {field} temporary parent failed: {error}"))?;
    if let Some((request, stage)) = pause_stage {
        promotion_test_pause(request, stage)?;
    }
    let temporary_before = stat_promotion_journal_file(&temporary_file)
        .map_err(|error| format!("fstat {field} temporary failed: {error}"))?;
    let temporary_path_before = stat_promotion_private_at(parent.as_raw_fd(), &temporary)
        .map_err(|error| format!("stat {field} temporary failed: {error}"))?;
    if temporary_before != temporary_path_before
        || !promotion_private_identity_valid(temporary_before, Some(mode), max_bytes)
    {
        return Err(format!("{field} temporary changed before publish"));
    }
    match promotion_rename_noreplace(
        parent.as_raw_fd(),
        &temporary,
        parent.as_raw_fd(),
        name,
    ) {
        Ok(()) => {}
        Err(error) if error.raw_os_error() == Some(libc::EEXIST) => {
            let (identity, observed) = promotion_read_private_bounded_file(
                parent, name, max_bytes, field,
            )?;
            if observed != content {
                return Err(format!("{field} identity mismatch after racing publish"));
            }
            parent
                .sync_all()
                .map_err(|sync_error| format!("sync {field} parent failed: {sync_error}"))?;
            return Ok(identity);
        }
        Err(error) => return Err(format!("publish {field} failed: {error}")),
    }
    parent
        .sync_all()
        .map_err(|error| format!("sync {field} parent failed: {error}"))?;
    let final_stat = stat_promotion_private_at(parent.as_raw_fd(), name)
        .map_err(|error| format!("stat {field} failed: {error}"))?;
    let descriptor_after = stat_promotion_journal_file(&temporary_file)
        .map_err(|error| format!("fstat {field} temporary after publish failed: {error}"))?;
    if descriptor_after != final_stat
        || !promotion_private_identity_valid(descriptor_after, Some(mode), max_bytes)
    {
        return Err(format!("{field} changed during publish"));
    }
    let (identity, observed) = promotion_read_private_bounded_opened(
        parent,
        name,
        temporary_file
            .try_clone()
            .map_err(|error| format!("clone published {field} failed: {error}"))?,
        max_bytes,
        field,
    )?;
    if observed != content {
        return Err(format!("{field} changed during publish"));
    }
    Ok(identity)
}

fn promotion_root_state_name(provenance_name: &str) -> Result<(String, CString), String> {
    let name = format!("{provenance_name}.state");
    if name.len() > PROMOTION_COMPONENT_MAX_BYTES {
        return Err("promotion root state name is too long".to_string());
    }
    let c_name = CString::new(name.as_bytes())
        .map_err(|_| "promotion root state name contains NUL".to_string())?;
    Ok((name, c_name))
}

fn promotion_root_state_content(
    kind: PromotionRootStateKind,
    path: &str,
    parent: PromotionIdentity,
    root: PromotionIdentity,
) -> Result<Vec<u8>, String> {
    let state = match kind {
        PromotionRootStateKind::Pending => "pending",
        PromotionRootStateKind::Bound => "bound",
    };
    serde_json::to_vec(&json!({
        "version": 1,
        "state": state,
        "path": path,
        "parent": { "dev": parent.dev.to_string(), "ino": parent.ino.to_string() },
        "root": { "dev": root.dev.to_string(), "ino": root.ino.to_string() },
    }))
    .map_err(|error| format!("serialize promotion root state failed: {error}"))
}

fn promotion_parse_root_state(
    content: &[u8],
    field: &str,
    identity: FileIdentity,
) -> Result<PromotionRootState, String> {
    let value: Value = serde_json::from_slice(content)
        .map_err(|error| format!("{field} is malformed: {error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| format!("{field} is malformed"))?;
    if object.len() != 5 || object.get("version") != Some(&json!(1)) {
        return Err(format!("{field} is malformed"));
    }
    let kind = match object.get("state").and_then(Value::as_str) {
        Some("pending") => PromotionRootStateKind::Pending,
        Some("bound") => PromotionRootStateKind::Bound,
        _ => return Err(format!("{field} has an invalid state")),
    };
    let path = object
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{field}.path is missing"))?;
    promotion_absolute_path(path, &format!("{field}.path"))?;
    let parent = promotion_identity_from_value(
        object
            .get("parent")
            .ok_or_else(|| format!("{field}.parent is missing"))?,
        &format!("{field}.parent"),
    )?;
    let root = promotion_identity_from_value(
        object
            .get("root")
            .ok_or_else(|| format!("{field}.root is missing"))?,
        &format!("{field}.root"),
    )?;
    Ok(PromotionRootState { kind, path: path.to_string(), parent, root, identity })
}

fn promotion_read_root_state(
    parent: &fs::File,
    name: &CStr,
) -> Result<Option<PromotionRootState>, String> {
    let Some((identity, bytes)) = promotion_read_private_bounded_if_present(
        parent,
        name,
        RETAINED_ROOT_PROVENANCE_MAX_BYTES,
        "promotion root state",
    )? else {
        return Ok(None);
    };
    Ok(Some(promotion_parse_root_state(
        &bytes,
        "promotion root state",
        identity,
    )?))
}

/// Read the sole deterministic pending-state recovery slot. A temporary state
/// is admissible only as an identity-bound continuation: it must be a private
/// regular file with one link, parse as `pending`, and later match the opened
/// root before the slot is promoted to the final state name. A marker or
/// mutable tree is never used as a substitute for this record.
fn promotion_read_root_state_temporary(
    parent: &fs::File,
    name: &CStr,
) -> Result<Option<PromotionRootState>, String> {
    let temporary = promotion_private_temporary_name(name)?;
    let Some((identity, bytes)) = promotion_read_private_bounded_if_present(
        parent,
        &temporary,
        RETAINED_ROOT_PROVENANCE_MAX_BYTES,
        "promotion root state temporary",
    )? else {
        return Ok(None);
    };
    let state = promotion_parse_root_state(
        &bytes,
        "promotion root state temporary",
        identity,
    )?;
    if state.kind != PromotionRootStateKind::Pending {
        return Err("promotion root state temporary is not pending".to_string());
    }
    Ok(Some(state))
}

/// Create the durable pending tombstone through the same atomic private-file
/// publisher as provenance. A racing creator is accepted only when it
/// published byte-identical state for the same root; all other contents fail
/// closed.
fn promotion_persist_root_state(
    parent: &fs::File,
    name: &CStr,
    content: &[u8],
    pause_stage: Option<(&Value, &str)>,
) -> Result<FileIdentity, String> {
    promotion_publish_private_exclusive(
        parent,
        name,
        content,
        0o600,
        RETAINED_ROOT_PROVENANCE_MAX_BYTES,
        "promotion root state",
        pause_stage,
    )
}

/// Atomically advance a pending state to bound. The old pending record is
/// retained until the descriptor-bound replacement is durable, so a crash
/// before the rename is resumable; a corrupt/replaced state is never
/// reconstructed from the mutable root or marker.
fn promotion_replace_root_state(
    parent: &fs::File,
    name: &CStr,
    expected_identity: FileIdentity,
    content: &[u8],
    req: &Value,
) -> Result<FileIdentity, String> {
    if content.len() > RETAINED_ROOT_PROVENANCE_MAX_BYTES {
        return Err("promotion root state exceeds its bounded metadata size".to_string());
    }
    let (current_identity, _) = promotion_read_private_bounded_file(
        parent,
        name,
        RETAINED_ROOT_PROVENANCE_MAX_BYTES,
        "promotion root state",
    )?;
    let current_stat = stat_promotion_private_at(parent.as_raw_fd(), name)
        .map_err(|error| format!("stat promotion root state failed: {error}"))?;
    if current_identity != expected_identity
        || current_stat.file != current_identity
        || !promotion_private_identity_valid(current_stat, Some(0o600), RETAINED_ROOT_PROVENANCE_MAX_BYTES)
    {
        return Err("promotion root state identity changed before commit".to_string());
    }
    // Derive one bounded recovery slot from the state name.  A deterministic
    // slot means a crash can leave at most one pending replacement per state;
    // repeated restarts cannot accumulate process/sequence-named temporaries.
    let state_name = name.to_bytes();
    let state_prefix = state_name
        .strip_suffix(b".state")
        .ok_or("promotion root state name has no bounded temporary suffix")?;
    let mut temporary_name = state_prefix.to_vec();
    temporary_name.extend_from_slice(b".tmp");
    if temporary_name.len() > PROMOTION_COMPONENT_MAX_BYTES {
        return Err("promotion root state temporary name is too long".to_string());
    }
    let temporary = CString::new(temporary_name)
        .map_err(|_| "promotion root state temporary name contains NUL".to_string())?;
    let temporary_file = match open_at(
        parent.as_raw_fd(),
        &temporary,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    ) {
        Ok(file) => {
            let temporary_identity = stat_promotion_journal_file(&file)
                .map_err(|error| format!("fstat existing promotion root state temporary failed: {error}"))?;
            if !promotion_private_identity_valid(
                temporary_identity,
                Some(0o600),
                RETAINED_ROOT_PROVENANCE_MAX_BYTES,
            ) {
                return Err("promotion root state temporary is not a bounded private app-owned file".to_string());
            }
            let (_, observed) = promotion_read_private_bounded_opened(
                parent,
                &temporary,
                file.try_clone().map_err(|error| {
                    format!("clone existing promotion root state temporary failed: {error}")
                })?,
                RETAINED_ROOT_PROVENANCE_MAX_BYTES,
                "existing promotion root state temporary",
            )?;
            if observed != content {
                return Err("promotion root state temporary identity mismatch".to_string());
            }
            file
        }
        Err(error) if error.raw_os_error() == Some(libc::ENOENT) => {
            let mut file = open_at_mode(
                parent.as_raw_fd(),
                &temporary,
                libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
            .map_err(|error| format!("create promotion root state temporary failed: {error}"))?;
            promotion_write_all(&mut file, content, "promotion root state temporary")?;
            promotion_set_mode(&file, 0o600, "promotion root state temporary")?;
            file
                .sync_all()
                .map_err(|error| format!("sync promotion root state temporary failed: {error}"))?;
            let temporary_identity = stat_promotion_journal_file(&file)
                .map_err(|error| format!("fstat promotion root state temporary failed: {error}"))?;
            let temporary_path_identity = stat_promotion_private_at(parent.as_raw_fd(), &temporary)
                .map_err(|error| format!("stat promotion root state temporary failed: {error}"))?;
            if temporary_identity != temporary_path_identity
                || !promotion_private_identity_valid(
                    temporary_identity,
                    Some(0o600),
                    RETAINED_ROOT_PROVENANCE_MAX_BYTES,
                )
                || temporary_identity.file.len != content.len() as u64
            {
                return Err("promotion root state temporary changed while writing".to_string());
            }
            file
        }
        Err(error) => return Err(format!("open promotion root state temporary failed: {error}")),
    };

    // A descriptor-relative rename replaces the old state atomically and
    // removes the temporary slot in the same namespace operation.  Unlike an
    // exchange, a crash after this point cannot strand the old state under a
    // second pathname; a crash before it leaves the one deterministic slot
    // above for idempotent recovery.
    parent
        .sync_all()
        .map_err(|error| format!("sync promotion root state temporary parent failed: {error}"))?;
    promotion_test_pause(req, "retained-root-before-bound-state-rename")?;
    let temporary_before = stat_promotion_journal_file(&temporary_file)
        .map_err(|error| format!("fstat promotion root state temporary failed: {error}"))?;
    let temporary_path_before = stat_promotion_private_at(parent.as_raw_fd(), &temporary)
        .map_err(|error| format!("stat promotion root state temporary failed: {error}"))?;
    if temporary_before != temporary_path_before
        || !promotion_private_identity_valid(
            temporary_before,
            Some(0o600),
            RETAINED_ROOT_PROVENANCE_MAX_BYTES,
        )
    {
        return Err("promotion root state temporary changed before commit".to_string());
    }
    // The rename replaces the pending final record. Revalidate that target
    // too after the pause: otherwise an attacker could swap the state
    // pathname while the temporary fd is held and make the replacement
    // silently overwrite an unbound record.
    let current_before_rename = stat_promotion_private_at(parent.as_raw_fd(), name)
        .map_err(|error| format!("stat promotion root state before commit failed: {error}"))?;
    if current_before_rename != current_stat
        || current_before_rename.file != current_identity
        || !promotion_private_identity_valid(
            current_before_rename,
            Some(0o600),
            RETAINED_ROOT_PROVENANCE_MAX_BYTES,
        )
    {
        return Err("promotion root state changed before commit".to_string());
    }
    unsafe {
        if libc::renameat(parent.as_raw_fd(), temporary.as_ptr(), parent.as_raw_fd(), name.as_ptr()) == -1 {
            return Err(format!("replace promotion root state failed: {}", io::Error::last_os_error()));
        }
    }
    parent
        .sync_all()
        .map_err(|error| format!("sync replaced promotion root state parent failed: {error}"))?;
    let final_stat = stat_promotion_private_at(parent.as_raw_fd(), name)
        .map_err(|error| format!("stat promotion root state failed: {error}"))?;
    let descriptor_after = stat_promotion_journal_file(&temporary_file)
        .map_err(|error| format!("fstat promotion root state after commit failed: {error}"))?;
    if descriptor_after != final_stat
        || !promotion_private_identity_valid(
            descriptor_after,
            Some(0o600),
            RETAINED_ROOT_PROVENANCE_MAX_BYTES,
        )
    {
        return Err("promotion root state changed during commit".to_string());
    }
    let (identity, observed) = promotion_read_private_bounded_opened(
        parent,
        name,
        temporary_file.try_clone().map_err(|error| {
            format!("clone promotion root state after commit failed: {error}")
        })?,
        RETAINED_ROOT_PROVENANCE_MAX_BYTES,
        "promotion root state",
    )?;
    if observed != content {
        return Err("promotion root state changed during commit".to_string());
    }
    Ok(identity)
}

fn promotion_final_bound_child_check(
    path: &str,
    parent_path: &str,
    name: &CStr,
    parent_identity: PromotionIdentity,
    root_identity: PromotionIdentity,
    marker: Option<(&CStr, FileIdentity)>,
    provenance_path: Option<(&str, PromotionIdentity, &CStr, FileIdentity)>,
) -> Result<(), String> {
    let parent = open_promotion_absolute_directory(parent_path, "trusted promotion parent final")?;
    promotion_directory_identity_matches(&parent, parent_identity, "trusted promotion parent final")?;
    let child = open_at(
        parent.as_raw_fd(),
        name,
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )
    .map_err(|error| format!("open promotion root final path failed: {error}"))?;
    promotion_directory_identity_matches(&child, root_identity, "promotion root final path")?;
    if let Some((marker_name, marker_identity)) = marker {
        let final_marker = stat_promotion_private_at(child.as_raw_fd(), marker_name)
            .map_err(|error| format!("stat retained root marker final path failed: {error}"))?;
        if final_marker.file != marker_identity
            || !promotion_private_identity_valid(
                final_marker,
                None,
                RETAINED_ROOT_MARKER_MAX_BYTES,
            )
        {
            return Err("retained root marker changed during binding".to_string());
        }
    }
    if let Some((provenance_parent_path, provenance_parent_identity, provenance_name, provenance_identity)) = provenance_path {
        let provenance_parent = open_promotion_absolute_directory(
            provenance_parent_path,
            "promotion provenance parent final",
        )?;
        promotion_directory_identity_matches(
            &provenance_parent,
            provenance_parent_identity,
            "promotion provenance parent final",
        )?;
        let final_provenance = stat_promotion_private_at(provenance_parent.as_raw_fd(), provenance_name)
            .map_err(|error| format!("stat promotion provenance final path failed: {error}"))?;
        if final_provenance.file != provenance_identity
            || !promotion_private_identity_valid(
                final_provenance,
                None,
                RETAINED_ROOT_PROVENANCE_MAX_BYTES,
            )
        {
            return Err("promotion root provenance changed during binding".to_string());
        }
    }
    let actual_path = format!("{}/{}", parent_path.trim_end_matches('/'), name.to_string_lossy());
    if actual_path != path {
        return Err("promotion root path changed during binding".to_string());
    }
    Ok(())
}

/// One descriptor-bound create/adopt transaction.  This is used by retained
/// roots and by the narrow explicit bootstrap path for existing promotion
/// roots. The child, marker, and external provenance are all authenticated
/// and durably written before any capability is returned.
fn op_promotion_bound_root_transaction(req: &Value) -> Result<Value, String> {
    let path = s(req, "path")?;
    let trusted_parent = req.get("trustedParent").and_then(Value::as_object).ok_or(
        "promotion directory transaction requires a trusted parent capability",
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
    let (name, c_name) = promotion_component(
        trusted_parent
            .get("name")
            .ok_or("trusted promotion parent leaf is missing")?,
        "trustedParent.name",
    )?;
    let expected_path = format!("{}/{}", parent_path.trim_end_matches('/'), name);
    if expected_path != path {
        return Err("promotion directory path is not the trusted parent leaf".to_string());
    }
    let parent = open_promotion_bound_root_values(
        parent_path,
        Some(parent_identity),
        trusted_parent.get("capability").and_then(Value::as_str),
        "trustedParent",
    )?
    .0;
    let parent_actual = promotion_owned_directory(&parent, "trusted parent", false)?;
    if parent_actual.dev != parent_identity.dev || parent_actual.ino != parent_identity.ino {
        return Err("trusted promotion parent identity changed".to_string());
    }
    let marker = if let Some(value) = req.get("marker") {
        let object = value.as_object().ok_or("promotion root marker must be an object")?;
        let (marker_name, marker_c_name) = promotion_component(
            object.get("name").ok_or("promotion root marker name is missing")?,
            "marker.name",
        )?;
        let encoded = object
            .get("content")
            .and_then(Value::as_str)
            .ok_or("promotion root marker content is missing")?;
        let content = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| format!("promotion root marker content is not valid base64: {error}"))?;
        if content.is_empty() || content.len() > RETAINED_ROOT_MARKER_MAX_BYTES {
            return Err("promotion root marker exceeds its bounded metadata size".to_string());
        }
        let mode = promotion_mode(object.get("mode"), "marker.mode", 0o600)?;
        Some((marker_name, marker_c_name, content, mode))
    } else {
        None
    };

    // Open the outside-root provenance directory before touching the mutable
    // leaf. The state/tombstone below is therefore always bound to the same
    // trusted descriptor as the final provenance record.
    let provenance = req
        .get("provenance")
        .and_then(Value::as_object)
        .ok_or("promotion root provenance binding is missing")?;
    let provenance_name_value = provenance
        .get("name")
        .ok_or("promotion root provenance name is missing")?;
    let (provenance_name, provenance_c_name) =
        promotion_component(provenance_name_value, "provenance.name")?;
    let provenance_parent = provenance
        .get("parent")
        .and_then(Value::as_object)
        .ok_or("promotion root provenance parent is missing")?;
    let provenance_parent_path = provenance_parent
        .get("path")
        .and_then(Value::as_str)
        .ok_or("promotion root provenance parent path is missing")?;
    let provenance_parent_identity = promotion_identity_from_value(
        provenance_parent
            .get("identity")
            .ok_or("promotion root provenance parent identity is missing")?,
        "provenance.parent.identity",
    )?;
    let provenance_parent_file = open_promotion_bound_root_values(
        provenance_parent_path,
        Some(provenance_parent_identity),
        provenance_parent.get("capability").and_then(Value::as_str),
        "provenance.parent",
    )?
    .0;
    let provenance_parent_actual = promotion_owned_directory(
        &provenance_parent_file,
        "provenance parent",
        false,
    )?;
    if provenance_parent_actual.dev != provenance_parent_identity.dev
        || provenance_parent_actual.ino != provenance_parent_identity.ino
    {
        return Err("promotion provenance parent identity changed".to_string());
    }
    let (_state_name, state_c_name) = promotion_root_state_name(&provenance_name)?;
    let mut expected = req
        .get("expectedIdentity")
        .map(|value| promotion_identity_from_value(value, "expectedIdentity"))
        .transpose()?;
    let mut existing_state = promotion_read_root_state(&provenance_parent_file, &state_c_name)?;
    let mut state_recovery_from_temporary = false;
    if existing_state.is_none() {
        existing_state = promotion_read_root_state_temporary(
            &provenance_parent_file,
            &state_c_name,
        )?;
        state_recovery_from_temporary = existing_state.is_some();
    }
    if let Some(state) = &existing_state {
        if state.path != path
            || state.parent.dev != parent_actual.dev
            || state.parent.ino != parent_actual.ino
        {
            return Err("promotion root state is bound to a different parent or path".to_string());
        }
        if let Some(requested) = expected {
            if requested != state.root {
                return Err("promotion root state identity mismatch".to_string());
            }
        }
        expected = Some(state.root);
        if state.kind == PromotionRootStateKind::Bound {
            match stat_promotion_private_at(provenance_parent_file.as_raw_fd(), &provenance_c_name) {
                Ok(identity)
                    if promotion_private_identity_valid(
                        identity,
                        Some(0o600),
                        RETAINED_ROOT_PROVENANCE_MAX_BYTES,
                    ) => {}
                Ok(_) => return Err("promotion root provenance is not a bounded private regular file".to_string()),
                Err(error) if missing_path(&error) => {
                    return Err("promotion root provenance was deleted after adoption".to_string())
                }
                Err(error) => return Err(format!("stat promotion root provenance failed: {error}")),
            }
        }
    }

    promotion_test_pause(req, "retained-root-parent-open")?;

    let bootstrap_existing = req
        .get("bootstrapExisting")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let (directory, created) = match open_at(
        parent.as_raw_fd(),
        &c_name,
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    ) {
        Ok(existing) => {
            let identity = promotion_owned_directory(&existing, "root", marker.is_some())?;
            if let Some(expected) = expected {
                if identity.dev != expected.dev || identity.ino != expected.ino {
                    return Err("promotion root identity mismatch".to_string());
                }
            } else if !bootstrap_existing {
                return Err("existing promotion directory requires a previously trusted expectedIdentity".to_string());
            }
            (existing, false)
        }
        Err(error) if missing_path(&error) => {
            if expected.is_some() {
                return Err(format!("promotion root {name} is missing"));
            }
            promotion_mkdir_at(parent.as_raw_fd(), &c_name, 0o700)
                .map_err(|mkdir_error| format!("create promotion root {name} failed: {mkdir_error}"))?;
            let created = open_at(
                parent.as_raw_fd(),
                &c_name,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|open_error| format!("open created promotion root {name} failed: {open_error}"))?;
            (created, true)
        }
        Err(error) => return Err(format!("open promotion root {name} failed: {error}")),
    };
    let root_identity = promotion_owned_directory(&directory, "root", marker.is_some())?;
    if let Some(expected) = expected {
        if root_identity.dev != expected.dev || root_identity.ino != expected.ino {
            return Err("promotion root identity changed while binding".to_string());
        }
    }
    if created {
        // Make the newly allocated leaf durable before publishing any
        // metadata that could make it admissible. If the process dies before
        // the pending tombstone, the empty, marker-less leaf is not a valid
        // retained root and is rejected deterministically on retry.
        directory
            .sync_all()
            .map_err(|error| format!("sync newly created promotion root failed: {error}"))?;
        parent
            .sync_all()
            .map_err(|error| format!("sync newly created promotion root parent failed: {error}"))?;
        promotion_test_pause(req, "retained-root-created")?;
    }

    // Prove an unproven existing legacy tree before creating its durable
    // state. A marker-only copied directory is rejected without leaving a
    // resumable adoption record that could later be abused.
    if marker.is_some() {
        let mut scan = RetainedRootScan {
            entries: 1,
            bytes: 0,
            work_bytes: path.len() as u64,
            has_data: false,
        };
        if scan.work_bytes > RETAINED_ROOT_MAX_SCAN_WORK_BYTES {
            return Err("retained root path exceeds its work bound".to_string());
        }
        promotion_validate_retained_directory(&directory, 0, true, &mut scan)?;
        if !created && expected.is_none() && !scan.has_data {
            return Err("existing retained root has no legacy app-owned evidence".to_string());
        }
    }

    let mut state_identity = existing_state.as_ref().map(|state| state.identity);
    if existing_state.is_none() || state_recovery_from_temporary {
        let pending_content = promotion_root_state_content(
            PromotionRootStateKind::Pending,
            &path,
            PromotionIdentity { dev: parent_actual.dev, ino: parent_actual.ino },
            PromotionIdentity { dev: root_identity.dev, ino: root_identity.ino },
        )?;
        state_identity = Some(promotion_persist_root_state(
            &provenance_parent_file,
            &state_c_name,
            &pending_content,
            Some((req, "retained-root-before-state-rename")),
        )?);
        // The pending tombstone is the first durable proof that this exact
        // root identity is being created/adopted. A restart after this point
        // resumes the same identity-bound transaction rather than inferring
        // trust again from the mutable marker/tree.
        promotion_test_pause(req, "retained-root-state-persisted")?;
    }
    promotion_test_pause(req, "retained-root-child-open")?;

    let marker_identity = if let Some((_, marker_name, content, mode)) = &marker {
        let marker_missing = match stat_at(directory.as_raw_fd(), marker_name) {
            Ok(_) => false,
            Err(error) if missing_path(&error) => true,
            Err(error) => return Err(format!("stat retained root marker failed: {error}")),
        };
        // A pending state is the native transaction's durable recovery proof.
        // It permits completing a marker write interrupted after the root was
        // opened, but never permits a marker-only legacy adoption: an
        // unproven existing root is rejected before pending state is created.
        let create_marker = created
            || (marker_missing
                && existing_state
                    .as_ref()
                    .is_some_and(|state| state.kind == PromotionRootStateKind::Pending));
        let created_identity = if create_marker {
            Some(promotion_create_bound_file(
                &directory,
                marker_name,
                content,
                *mode,
                "retained root marker",
                Some((req, "retained-root-before-marker-rename")),
            )?)
        } else {
            None
        };
        if created_identity.is_some() {
            // The marker is evidence only after the pending state exists; the
            // hook exercises the crash boundary after its atomic publication.
            promotion_test_pause(req, "retained-root-marker-persisted")?;
        }
        let validated_identity = promotion_validate_marker(&directory, marker_name, content, *mode)?;
        if let Some(created_identity) = created_identity {
            if created_identity != validated_identity {
                return Err("retained root marker changed after creation".to_string());
            }
        }
        promotion_test_pause(req, "retained-root-marker-validated")?;
        Some(validated_identity)
    } else {
        None
    };

    let provenance_content = serde_json::to_vec(&json!({
        "version": 1,
        "path": path,
        "parent": { "dev": parent_actual.dev.to_string(), "ino": parent_actual.ino.to_string() },
        "root": { "dev": root_identity.dev.to_string(), "ino": root_identity.ino.to_string() },
    }))
    .map_err(|error| format!("serialize promotion root provenance failed: {error}"))?;
    promotion_test_pause(req, "retained-root-before-provenance")?;
    let provenance_identity = promotion_persist_root_provenance(
        &provenance_parent_file,
        &provenance_c_name,
        &provenance_content,
        Some((req, "retained-root-before-provenance-rename")),
    )?;
    promotion_test_pause(req, "retained-root-provenance-persisted")?;
    parent
        .sync_all()
        .map_err(|error| format!("sync promotion root parent failed: {error}"))?;
    directory
        .sync_all()
        .map_err(|error| format!("sync promotion root failed: {error}"))?;
    provenance_parent_file
        .sync_all()
        .map_err(|error| format!("sync promotion provenance parent failed: {error}"))?;

    let bound_state_content = promotion_root_state_content(
        PromotionRootStateKind::Bound,
        &path,
        PromotionIdentity { dev: parent_actual.dev, ino: parent_actual.ino },
        PromotionIdentity { dev: root_identity.dev, ino: root_identity.ino },
    )?;
    let current_state_identity = state_identity
        .ok_or("promotion root state was not durably initialized")?;
    let final_state_identity = match existing_state.as_ref().map(|state| state.kind) {
        Some(PromotionRootStateKind::Bound) => {
            let (identity, observed) = promotion_read_private_bounded_file(
                &provenance_parent_file,
                &state_c_name,
                RETAINED_ROOT_PROVENANCE_MAX_BYTES,
                "promotion root state",
            )?;
            if identity != current_state_identity || observed != bound_state_content {
                return Err("promotion root bound state changed during commit".to_string());
            }
            identity
        }
        _ => promotion_replace_root_state(
            &provenance_parent_file,
            &state_c_name,
            current_state_identity,
            &bound_state_content,
            req,
        )?,
    };
    promotion_test_pause(req, "retained-root-durable")?;

    let root_identity = PromotionIdentity { dev: root_identity.dev, ino: root_identity.ino };
    let marker_final = marker.as_ref().and_then(|(_, marker_name, _, _)| {
        marker_identity.map(|identity| (marker_name.as_c_str(), identity))
    });
    promotion_final_bound_child_check(
        &path,
        parent_path,
        &c_name,
        parent_identity,
        root_identity,
        marker_final,
        Some((
            provenance_parent_path,
            provenance_parent_identity,
            &provenance_c_name,
            provenance_identity,
        )),
    )?;
    let final_state = promotion_read_root_state(&provenance_parent_file, &state_c_name)?
        .ok_or("promotion root state disappeared during binding")?;
    if final_state.kind != PromotionRootStateKind::Bound
        || final_state.identity != final_state_identity
        || final_state.path != path
        || final_state.parent.dev != parent_actual.dev
        || final_state.parent.ino != parent_actual.ino
        || final_state.root.dev != root_identity.dev
        || final_state.root.ino != root_identity.ino
    {
        return Err("promotion root state changed during binding".to_string());
    }
    let capability = issue_promotion_root_capability(&path, root_identity)?;
    Ok(json!({
        "result": promotion_directory_capability_result(root_identity, &capability)
    }))
}

/// Ensure an absolute directory chain using only descriptor-relative
/// operations from the native root descriptor. This replaces the old
/// TypeScript walk that selected a mutable pathname as the trusted root.
fn op_promotion_bound_ensure_directory(req: &Value) -> Result<Value, String> {
    // Any request carrying explicit provenance/legacy-bootstrap state uses
    // the single native create/adopt transaction. The ordinary capability or
    // expected-identity opener remains available for already-proven roots.
    if req.get("provenance").is_some()
        || req.get("marker").is_some()
        || req.get("bootstrapExisting").is_some()
    {
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

fn promotion_directory_identity_matches(
    file: &fs::File,
    expected: PromotionIdentity,
    field: &str,
) -> Result<(), String> {
    let actual =
        stat_file(file).map_err(|error| format!("fstat promotion {field} failed: {error}"))?;
    if !actual.is_dir() || actual.dev != expected.dev || actual.ino != expected.ino {
        return Err(format!("promotion {field} identity mismatch"));
    }
    Ok(())
}

fn promotion_cleanup_same_namespace_identity(actual: FileIdentity, expected: FileIdentity) -> bool {
    actual.dev == expected.dev
        && actual.ino == expected.ino
        && actual.file_type() == expected.file_type()
}

fn promotion_test_pause(req: &Value, stage: &str) -> Result<(), String> {
    if std::env::var_os("TERMINA_CORE_TEST").is_none() {
        return Ok(());
    }
    let Some(hook) = req.get("testHook").and_then(Value::as_object) else {
        return Ok(());
    };
    if hook.get("stage").and_then(Value::as_str) != Some(stage) {
        return Ok(());
    }
    let ready = hook
        .get("readyPath")
        .and_then(Value::as_str)
        .ok_or("promotion test hook readyPath is missing")?;
    let release = hook
        .get("releasePath")
        .and_then(Value::as_str)
        .ok_or("promotion test hook releasePath is missing")?;
    promotion_absolute_path(ready, "test hook readyPath")?;
    promotion_absolute_path(release, "test hook releasePath")?;
    fs::write(ready, b"ready")
        .map_err(|error| format!("write promotion test hook failed: {error}"))?;
    loop {
        match fs::symlink_metadata(release) {
            Ok(_) => break,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                thread::sleep(Duration::from_millis(1))
            }
            Err(error) => return Err(format!("read promotion test hook failed: {error}")),
        }
    }
    Ok(())
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

fn promotion_rename_noreplace(
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
                libc::RENAME_NOREPLACE,
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
                libc::RENAME_EXCL,
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

fn promotion_components_value(value: &Value, key: &str) -> Result<Vec<(String, CString)>, String> {
    let values = value
        .as_array()
        .ok_or_else(|| format!("{key} must be an array"))?;
    if values.is_empty() || values.len() > PROMOTION_COMPONENT_ARRAY_MAX_ENTRIES {
        return Err(format!("invalid promotion {key}"));
    }
    let mut components = Vec::with_capacity(values.len());
    let mut name_bytes = 0usize;
    for (index, value) in values.iter().enumerate() {
        let (name, component) = promotion_component(value, &format!("{key}[{index}]"))?;
        name_bytes = name_bytes
            .checked_add(name.len())
            .ok_or_else(|| format!("{key} name accounting overflow"))?;
        if name_bytes > PROMOTION_COMPONENT_ARRAY_MAX_NAME_BYTES {
            return Err(format!("promotion {key} exceeds its name-work bound"));
        }
        components.push((name, component));
    }
    Ok(components)
}

fn promotion_identity_chain_from_value(
    value: &Value,
    field: &str,
) -> Result<Vec<PromotionIdentity>, String> {
    let values = value
        .as_array()
        .ok_or_else(|| format!("{field} must be an array"))?;
    if values.len() > PROMOTION_COMPONENT_ARRAY_MAX_ENTRIES {
        return Err(format!("invalid promotion {field}"));
    }
    let mut identities = Vec::with_capacity(values.len());
    for (index, value) in values.iter().enumerate() {
        identities.push(promotion_identity_from_value(
            value,
            &format!("{field}[{index}]"),
        )?);
    }
    Ok(identities)
}

fn promotion_components_for(req: &Value, key: &str) -> Result<Vec<(String, CString)>, String> {
    promotion_components_value(
        req.get(key).ok_or_else(|| format!("missing field {key}"))?,
        key,
    )
}

fn promotion_components(req: &Value) -> Result<Vec<(String, CString)>, String> {
    promotion_components_for(req, "destinationComponents")
}

fn open_promotion_parent(
    root: &fs::File,
    components: &[(String, CString)],
    field: &str,
) -> Result<fs::File, String> {
    if components.is_empty() {
        return Err(format!("promotion {field} components are missing"));
    }
    let mut parent = root
        .try_clone()
        .map_err(|error| format!("clone promotion {field} root failed: {error}"))?;
    for (index, (_, component)) in components.iter().enumerate().take(components.len() - 1) {
        parent = open_at(
            parent.as_raw_fd(),
            component,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
        .map_err(|error| format!("open promotion {field} component {index} failed: {error}"))?;
    }
    Ok(parent)
}

/// Open every directory component below `root`, creating missing components
/// through the already-open parent descriptor.  This is the only directory
/// materialization primitive used by live promotion.  In particular, it never
/// re-resolves a component through a pathname after the root descriptor has
/// been acquired.
fn open_or_create_promotion_parent(
    root: &fs::File,
    components: &[(String, CString)],
    field: &str,
    mode: libc::mode_t,
) -> Result<fs::File, String> {
    let mut parent = root
        .try_clone()
        .map_err(|error| format!("clone promotion {field} root failed: {error}"))?;
    for (index, (_, component)) in components.iter().enumerate() {
        match open_at(
            parent.as_raw_fd(),
            component,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        ) {
            Ok(next) => parent = next,
            Err(error) if missing_path(&error) => {
                unsafe {
                    if libc::mkdirat(parent.as_raw_fd(), component.as_ptr(), mode) == -1 {
                        let mkdir_error = io::Error::last_os_error();
                        if mkdir_error.raw_os_error() != Some(libc::EEXIST) {
                            return Err(format!(
                                "create promotion {field} component {index} failed: {mkdir_error}"
                            ));
                        }
                    }
                }
                parent = open_at(
                    parent.as_raw_fd(),
                    component,
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
                .map_err(|open_error| {
                    format!("open created promotion {field} component {index} failed: {open_error}")
                })?;
            }
            Err(error) => {
                return Err(format!(
                    "open promotion {field} component {index} failed: {error}"
                ));
            }
        }
    }
    Ok(parent)
}

fn promotion_mkdir_at(parent: RawFd, name: &CStr, mode: libc::mode_t) -> io::Result<()> {
    let rc = unsafe { libc::mkdirat(parent, name.as_ptr(), mode) };
    if rc == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn promotion_symlink_at(target: &CStr, parent: RawFd, name: &CStr) -> io::Result<()> {
    let rc = unsafe { libc::symlinkat(target.as_ptr(), parent, name.as_ptr()) };
    if rc == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Read directory names through a descriptor. `std::fs::read_dir` is not
/// suitable for this boundary because it would re-resolve the directory by
/// pathname after an ancestor swap.
fn promotion_clear_errno() {
    #[cfg(target_os = "linux")]
    unsafe {
        *libc::__errno_location() = 0;
    }
    #[cfg(target_os = "macos")]
    unsafe {
        *libc::__error() = 0;
    }
}

fn promotion_errno() -> i32 {
    #[cfg(target_os = "linux")]
    unsafe {
        *libc::__errno_location()
    }
    #[cfg(target_os = "macos")]
    unsafe {
        *libc::__error()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        0
    }
}

/// One descriptor-relative directory stream. Keeping the `DIR *` open while
/// an iterative walk descends means each frame holds only one native stream,
/// not a collected names vector for every ancestor.
struct PromotionDirectoryStream {
    stream: *mut libc::DIR,
}

impl PromotionDirectoryStream {
    fn open(dir: RawFd) -> Result<Self, String> {
        // `dup` shares the directory stream offset with the caller. Open `.`
        // through the bound descriptor instead so repeated scans (including
        // quarantine accounting followed by container reuse) remain
        // independent of the caller's stream state.
        let dot = CString::new(".").expect("directory component has no NUL");
        let duplicate = unsafe {
            libc::openat(
                dir,
                dot.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if duplicate == -1 {
            return Err(format!(
                "duplicate promotion directory descriptor failed: {}",
                io::Error::last_os_error()
            ));
        }
        let stream = unsafe { libc::fdopendir(duplicate) };
        if stream.is_null() {
            let error = io::Error::last_os_error();
            unsafe { libc::close(duplicate) };
            return Err(format!("open promotion directory stream failed: {error}"));
        }
        Ok(Self { stream })
    }

    fn next_entry(&mut self) -> Result<Option<(String, CString)>, String> {
        loop {
            promotion_clear_errno();
            let entry = unsafe { libc::readdir(self.stream) };
            if entry.is_null() {
                let error = promotion_errno();
                if error != 0 {
                    return Err(format!(
                        "read promotion directory failed: {}",
                        io::Error::from_raw_os_error(error)
                    ));
                }
                return Ok(None);
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
            if name.to_bytes() == b"." || name.to_bytes() == b".." {
                continue;
            }
            let text = std::str::from_utf8(name.to_bytes())
                .map_err(|_| "promotion directory contains a non-UTF-8 name".to_string())?;
            if text.len() > PROMOTION_COMPONENT_MAX_BYTES {
                return Err("promotion directory entry name is too long".to_string());
            }
            let c_name = CString::new(name.to_bytes())
                .map_err(|_| "promotion directory contains a NUL name".to_string())?;
            return Ok(Some((text.to_string(), c_name)));
        }
    }
}

impl Drop for PromotionDirectoryStream {
    fn drop(&mut self) {
        unsafe {
            libc::closedir(self.stream);
        }
    }
}

/// Check emptiness without materializing the directory names. This is used by
/// copy/template destinations where the answer is a boolean; allocating a
/// vector there lets a hostile breadth fan out consume the entire collector
/// envelope before the caller can do useful work.
fn promotion_directory_is_empty(dir: RawFd) -> Result<bool, String> {
    let mut stream = PromotionDirectoryStream::open(dir)?;
    Ok(stream.next_entry()?.is_none())
}

fn promotion_child_relative(relative: &str, name: &str) -> Result<String, String> {
    let child = if relative.is_empty() {
        name.to_string()
    } else {
        format!("{relative}/{name}")
    };
    if child.len() > PROMOTION_PATH_MAX_BYTES {
        return Err("promotion traversal path exceeds its bounded work budget".to_string());
    }
    Ok(child)
}

fn promotion_path_work_bytes(relative: &str, name: &str) -> Result<u64, String> {
    let path_len = relative
        .len()
        .checked_add(if relative.is_empty() { 0 } else { 1 })
        .and_then(|length| length.checked_add(name.len()))
        .filter(|length| *length <= PROMOTION_PATH_MAX_BYTES)
        .ok_or("promotion traversal path exceeds its bounded work budget")?;
    let path_len = u64::try_from(path_len).map_err(|_| "promotion traversal work overflow")?;
    let name_len = u64::try_from(name.len()).map_err(|_| "promotion traversal work overflow")?;
    path_len
        .checked_add(name_len)
        .and_then(|work| work.checked_add(std::mem::size_of::<FileIdentity>() as u64))
        .ok_or_else(|| "promotion traversal work accounting overflow".to_string())
}

fn promotion_add_work(
    work: &mut u64,
    amount: u64,
    max: u64,
    field: &str,
) -> Result<(), String> {
    *work = work
        .checked_add(amount)
        .ok_or_else(|| format!("{field} work accounting overflow"))?;
    if *work > max {
        return Err(format!("{field} exceeds its work bound"));
    }
    Ok(())
}

fn promotion_write_all(file: &mut fs::File, bytes: &[u8], field: &str) -> Result<(), String> {
    file.write_all(bytes)
        .map_err(|error| format!("write promotion {field} failed: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("sync promotion {field} failed: {error}"))
}

fn promotion_set_mode(file: &fs::File, mode: u32, field: &str) -> Result<(), String> {
    let rc = unsafe { libc::fchmod(file.as_raw_fd(), mode as libc::mode_t) };
    if rc == -1 {
        return Err(format!(
            "chmod promotion {field} failed: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(())
}

/// Remove one entry through its already-open parent descriptor.  No pathname
/// is re-resolved and a directory is never accepted by the regular unlink
/// path.  Callers must have performed any identity/type checks before invoking
/// this helper.
fn promotion_unlink_at_field(
    parent: RawFd,
    name: &CStr,
    is_dir: bool,
    field: &str,
) -> Result<(), String> {
    let flags = if is_dir { libc::AT_REMOVEDIR } else { 0 };
    let rc = unsafe { libc::unlinkat(parent, name.as_ptr(), flags) };
    if rc == -1 {
        return Err(format!(
            "remove promotion {field} failed: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(())
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

fn promotion_mode(value: Option<&Value>, field: &str, default: u32) -> Result<u32, String> {
    let mode = value.and_then(Value::as_u64).unwrap_or(u64::from(default));
    if mode > 0o777 {
        return Err(format!("{field} is invalid"));
    }
    Ok(mode as u32)
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

fn promotion_directory_capability_result(identity: PromotionIdentity, capability: &str) -> Value {
    json!({
        "identity": {
            "dev": identity.dev.to_string(),
            "ino": identity.ino.to_string(),
        },
        "capability": capability,
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
/// never adopted as a trust root, and the aggregate scan makes retention
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
fn apply_rewrite_hooks(
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
fn hash_path(
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
    )?;
    Ok(Some((mode, oid, new_bytes)))
}

fn op_capture(req: &Value) -> Result<Value, String> {
    let source_root = PathBuf::from(s(req, "sourceRoot")?);
    let head = opt_s(req, "head");
    let parent_commit = opt_s(req, "parentCommit");
    let capture_root = opt_s(req, "captureRoot")
        .map(PathBuf::from)
        .unwrap_or(source_root);
    let max_paths = req
        .pointer("/budget/maxPaths")
        .and_then(Value::as_u64)
        .unwrap_or(BUDGET_MAX_PATHS as u64) as usize;
    let max_file_bytes = req
        .pointer("/budget/maxFileBytes")
        .and_then(Value::as_u64)
        .unwrap_or(BUDGET_MAX_FILE_BYTES);
    let max_new_blob_bytes = req
        .pointer("/budget/maxNewBlobBytes")
        .and_then(Value::as_u64)
        .unwrap_or(BUDGET_MAX_NEW_BLOB_BYTES);

    // The store owns every object and ref. The source repo feeds only the
    // enumeration and the raw file bytes.
    let store_dir = PathBuf::from(s(req, "storeDir")?);
    let _mutation_lock = StoreMutationLock::acquire(&store_dir, req)?;
    let store = open_store(&store_dir, req)?;
    recover_store_transaction(&store_dir, &store)?;
    let capture_fs = CaptureRoot::open(&capture_root)?;
    pause_at_hook(req, "pauseAfterCaptureRootOpen")?;
    let capture_git_dir = opt_s(req, "captureGitDir")
        .or_else(|| opt_s(req, "sourceGitDir"))
        .ok_or("full capture requires a source Git directory")?;
    let source = BoundSourceRepository::open(
        req,
        &capture_fs,
        Path::new(&capture_git_dir),
        store.object_format(),
    )?;
    let parent_oid = parent_commit
        .as_deref()
        .map(|p| oid_ext(&store, p))
        .transpose()?;
    // Resolve the parent before publishing the first object. A syntactically
    // valid but unavailable parent must not become a late capture failure.
    let parent_commits: Vec<git2::Commit<'_>> = parent_oid
        .map(|oid| store.find_commit(oid).map_err(|e| e.to_string()))
        .transpose()?
        .into_iter()
        .collect();
    let hooks = before_read_hooks(req);
    let cache_hooks = after_cache_hooks(req);

    source.verify(&capture_fs)?;
    let paths_and_index = enumerate_domain(&source.repo, source.capture_prefix.as_deref())?;
    source.verify(&capture_fs)?;
    let paths = paths_and_index.0;
    let index_entries = paths_and_index.1;
    if paths.len() > max_paths {
        return Err(format!(
            "capture exceeds the {max_paths} path budget ({} paths)",
            paths.len()
        ));
    }

    // Racy-git baseline: the index write time. Files modified at or after
    // it are re-read even when their other stat fields match.
    let index_write = source.index_write_time()?;

    // Resolve the capture domain through the trusted root descriptor before
    // loading any source object.  The resulting descriptors are consumed by
    // the working-tree pass below, so a later root/ancestor swap cannot make
    // a Git path set point at different file bytes.
    let mut resolved_paths: Vec<(String, Option<AnchoredPath>, Option<(u32, Oid)>)> =
        Vec::with_capacity(paths.len());
    let mut cached_oids = HashSet::new();
    for rel_path in &paths {
        let Some(path) = capture_fs.resolve(rel_path)? else {
            resolved_paths.push((rel_path.clone(), None, None));
            continue;
        };
        // The test seam rewrites files mid-read; bypass the stat-cache so
        // its verification semantics stay intact.
        let cached = if hooks.is_empty() {
            index_entries.get(rel_path).and_then(|entry| {
                stat_cached_entry(path.identity, entry, max_file_bytes, index_write)
            })
        } else {
            None
        };
        if let Some((_, oid)) = cached {
            cached_oids.insert(oid);
        }
        resolved_paths.push((rel_path.clone(), Some(path), cached));
    }
    source.verify(&capture_fs)?;
    let cached_blobs = preload_cached_blobs(&source, &capture_fs, &cached_oids, &store)?;
    source.verify(&capture_fs)?;

    // No source Git operation occurs after this point.  Delay transaction
    // creation until all identity-bound enumeration and ODB reads succeed so
    // a rejected binding leaves the prior store refs and evidence untouched.
    let mut object_transaction = StoreObjectTransaction::new(&store_dir, req);

    let mut flat: HashMap<String, FlatEntry> = HashMap::new();
    let mut new_blob_bytes = 0u64;
    for (rel_path, path, cached) in resolved_paths {
        let Some(path) = path else {
            continue;
        };
        let captured = match cached {
            Some((mode, oid)) => {
                let blob = cached_blobs
                    .get(&oid)
                    .ok_or_else(|| format!("cached source blob {oid} was not preloaded"))?;
                let cached_len = u64::try_from(blob.len())
                    .map_err(|_| format!("cached source blob {oid} size does not fit u64"))?;
                if cached_len != path.identity.len {
                    return Err(format!(
                        "cached source blob {oid} size {cached_len} does not match live/index size {} for {rel_path}",
                        path.identity.len
                    ));
                }
                if cached_len > max_file_bytes {
                    return Err(format!(
                        "cached source blob {oid} exceeds the {max_file_bytes} file byte budget"
                    ));
                }
                ensure_blob_budget(
                    &object_transaction,
                    &store,
                    oid,
                    cached_len,
                    new_blob_bytes,
                    max_new_blob_bytes,
                )?;
                apply_rewrite_hooks(&path, &cache_hooks, None);
                let (owned_oid, new_bytes) = write_blob(
                    &mut object_transaction,
                    &store,
                    blob,
                    new_blob_bytes,
                    max_new_blob_bytes,
                )?;
                if owned_oid != oid {
                    return Err(format!(
                        "cached source blob oid mismatch: expected {oid}, wrote {owned_oid}"
                    ));
                }
                let after = stat_at(path.parent.as_raw_fd(), &path.leaf)
                    .map_err(|_| format!("file vanished while captured: {rel_path}"))?;
                if path.identity != after {
                    return Err(format!("file changed while captured: {rel_path}"));
                }
                Some((mode, owned_oid, new_bytes))
            }
            None => hash_path(
                &mut object_transaction,
                &store,
                &capture_fs,
                path,
                max_file_bytes,
                new_blob_bytes,
                max_new_blob_bytes,
                &hooks,
            )?,
        };
        if let Some((mode, oid, new_bytes)) = captured {
            new_blob_bytes = new_blob_bytes
                .checked_add(new_bytes)
                .ok_or("new-blob byte accounting overflow")?;
            flat.insert(rel_path, (mode, oid));
        }
    }
    source.verify(&capture_fs)?;

    let tree = write_nested_tree(
        &mut object_transaction,
        &store,
        &mut nested_from_flat(&flat)?,
    )?;
    object_transaction.flush(&store)?;
    // Read the tree back and verify every captured entry before the state ref
    // becomes durable. Any failure still rolls back request-created blobs.
    let seen = collect_tree_map(&store, tree)?;
    verify_expected(&seen, &flat, true)?;
    let commit = commit_tree(
        &mut object_transaction,
        &store,
        tree,
        &parent_commits,
        "termina source state",
    )?;
    object_transaction.flush(&store)?;
    pause_at_hook(req, "pauseBeforeStateRef")?;
    fail_before_state_ref(req)?;
    update_state_ref(&mut object_transaction, &store, commit, req)?;
    pause_at_hook(req, "pauseAfterStateRef")?;
    object_transaction.commit()?;
    cache_tree_map(tree, std::sync::Arc::new(flat.clone()));

    Ok(json!({
        "state": {
            "commit": commit.to_string(),
            "tree": tree.to_string(),
            "head": head,
            "pathCount": flat.len(),
            "newBlobBytes": new_blob_bytes,
            "parentCommit": parent_commit,
            "ts": now_ms(),
        }
    }))
}

fn nested_from_flat(flat: &HashMap<String, FlatEntry>) -> Result<HashMap<String, Node>, String> {
    let mut nested = HashMap::new();
    for (path, (mode, oid)) in flat {
        insert_node(&mut nested, path, *oid, *mode)?;
    }
    Ok(nested)
}

/// Verify every expected entry matches the written tree. When `exact` is
/// true, the tree must contain exactly the expected entries.
fn verify_expected(
    seen: &HashMap<String, FlatEntry>,
    expected: &HashMap<String, FlatEntry>,
    exact: bool,
) -> Result<(), String> {
    if exact && seen.len() != expected.len() {
        return Err(format!(
            "tree verification size mismatch: {} vs {}",
            seen.len(),
            expected.len()
        ));
    }
    for (path, exp) in expected {
        match seen.get(path) {
            Some((mode, oid)) if *mode == exp.0 && *oid == exp.1 => {}
            _ => return Err(format!("tree verification mismatch for {path}")),
        }
    }
    Ok(())
}

// ------------------------------------------------- capture incremental ----

fn op_capture_incremental(req: &Value) -> Result<Value, String> {
    let source_root = PathBuf::from(s(req, "sourceRoot")?);
    let parent_commit = s(req, "parentCommit")?;
    let capture_root = opt_s(req, "captureRoot")
        .map(PathBuf::from)
        .unwrap_or(source_root);
    let max_file_bytes = req
        .pointer("/budget/maxFileBytes")
        .and_then(Value::as_u64)
        .unwrap_or(BUDGET_MAX_FILE_BYTES);
    let max_new_blob_bytes = req
        .pointer("/budget/maxNewBlobBytes")
        .and_then(Value::as_u64)
        .unwrap_or(BUDGET_MAX_NEW_BLOB_BYTES);
    let max_paths = req
        .pointer("/budget/maxPaths")
        .and_then(Value::as_u64)
        .unwrap_or(BUDGET_MAX_PATHS as u64) as usize;
    let hints: Vec<String> = req
        .get("hints")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let reconcile: Vec<(String, String)> = req
        .get("reconcile")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| {
                    let rel = v.get("relPath").and_then(Value::as_str)?;
                    let oid = v.get("oid").and_then(Value::as_str)?;
                    Some((rel.to_string(), oid.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();

    // The store owns every object and ref. The delta comes from the hints
    // and the reconcile map; no source enumeration is needed.
    let store_dir = PathBuf::from(s(req, "storeDir")?);
    let _mutation_lock = StoreMutationLock::acquire(&store_dir, req)?;
    let store = open_store(&store_dir, req)?;
    recover_store_transaction(&store_dir, &store)?;
    let mut object_transaction = StoreObjectTransaction::new(&store_dir, req);
    let capture_fs = CaptureRoot::open(&capture_root)?;
    let hooks = before_read_hooks(req);
    let parent_oid = oid_ext(&store, &parent_commit)?;
    let parent_commit_obj = store.find_commit(parent_oid).map_err(|e| e.to_string())?;
    let parent_tree = resolve_tree(&store, parent_oid)?;
    let parent_arc = collect_tree_map_cached(&store, parent_tree)?;
    let parent_flat = (*parent_arc).clone();

    // The changed set: hints plus reconciled cache entries whose blob
    // differs from the parent tree.
    let mut changed: HashSet<String> = HashSet::new();
    for hint in &hints {
        // A nested repository path must never enter the tree: apply-state
        // would write into the target's own Git directory.
        if is_safe_relative(hint) && !has_git_segment(hint) {
            changed.insert(hint.clone());
        }
    }
    for (rel_path, oid_hex) in &reconcile {
        if !is_safe_relative(rel_path) || has_git_segment(rel_path) {
            continue;
        }
        // The watcher precomputed this blob oid from the cached content.
        // A malformed oid is a caller bug: fail loudly instead of silently
        // skipping the safety net. Validate against the store's object
        // format before the domain lookup so bad input never slips
        // through on an unknown path.
        let reconciled = oid_ext(&store, oid_hex)
            .map_err(|_| format!("reconcile oid is invalid for {rel_path}"))?;
        let Some((_, parent_oid)) = parent_flat.get(rel_path) else {
            continue; // not in the capture domain
        };
        if reconciled != *parent_oid {
            changed.insert(rel_path.clone());
        }
    }
    if changed.len() > max_paths {
        return Err(format!(
            "capture exceeds the {max_paths} path budget ({} paths)",
            changed.len()
        ));
    }
    if changed.is_empty() {
        return Ok(json!({
            "state": {
                "commit": parent_commit,
                "tree": parent_tree.to_string(),
                "head": null,
                "pathCount": 0,
                "newBlobBytes": 0,
                "parentCommit": parent_commit,
                "ts": now_ms(),
            }
        }));
    }

    // Seed the flat map from the parent tree, then apply the delta. The
    // delta also drives the tree writer below: only the ancestors of a
    // change are rewritten, untouched directories keep their objects.
    let mut flat = parent_flat;
    let mut expected: HashMap<String, FlatEntry> = HashMap::new();
    let mut changed_entries: HashMap<String, Option<FlatEntry>> =
        HashMap::with_capacity(changed.len());
    let mut new_blob_bytes = 0u64;
    for rel_path in changed.iter() {
        let Some(path) = capture_fs.resolve(rel_path)? else {
            flat.remove(rel_path);
            changed_entries.insert(rel_path.clone(), None);
            continue;
        };
        match hash_path(
            &mut object_transaction,
            &store,
            &capture_fs,
            path,
            max_file_bytes,
            new_blob_bytes,
            max_new_blob_bytes,
            &hooks,
        )? {
            Some((mode, oid, new_bytes)) => {
                new_blob_bytes = new_blob_bytes
                    .checked_add(new_bytes)
                    .ok_or("new-blob byte accounting overflow")?;
                flat.insert(rel_path.clone(), (mode, oid));
                expected.insert(rel_path.clone(), (mode, oid));
                changed_entries.insert(rel_path.clone(), Some((mode, oid)));
            }
            None => {
                // The path is gone or is a gitlink: drop it from the tree.
                flat.remove(rel_path);
                changed_entries.insert(rel_path.clone(), None);
            }
        }
    }
    let tree = match write_tree_delta(
        &mut object_transaction,
        &store,
        parent_tree,
        &changed_entries,
    )? {
        Some(oid) => oid,
        None => write_nested_tree(&mut object_transaction, &store, &mut HashMap::new())?,
    };
    object_transaction.flush(&store)?;
    // Verify only the changed paths before publishing the state ref. A full
    // read-back would walk every entry; untouched paths came from the parent.
    for (rel_path, (exp_mode, exp_oid)) in &expected {
        match tree_lookup(&store, tree, rel_path, TreeLookupKind::Blob)? {
            Some((mode, oid)) if mode == *exp_mode && oid == *exp_oid => {}
            _ => return Err(format!("tree verification mismatch for {rel_path}")),
        }
    }
    let commit = commit_tree(
        &mut object_transaction,
        &store,
        tree,
        &[parent_commit_obj],
        "termina source state",
    )?;
    object_transaction.flush(&store)?;
    pause_at_hook(req, "pauseBeforeStateRef")?;
    fail_before_state_ref(req)?;
    update_state_ref(&mut object_transaction, &store, commit, req)?;
    pause_at_hook(req, "pauseAfterStateRef")?;
    object_transaction.commit()?;
    cache_tree_map(tree, std::sync::Arc::new(flat));

    Ok(json!({
        "state": {
            "commit": commit.to_string(),
            "tree": tree.to_string(),
            "head": null,
            "pathCount": expected.len(),
            "newBlobBytes": new_blob_bytes,
            "parentCommit": parent_commit,
            "ts": now_ms(),
        }
    }))
}

// --------------------------------------------------------- materialize -----

/// The flat entry map of a state commit.
fn state_entries(
    repo: &Repository,
    state_commit: &str,
) -> Result<HashMap<String, FlatEntry>, String> {
    let commit = oid_ext(repo, state_commit)?;
    let tree = resolve_tree(repo, commit)?;
    collect_tree_map(repo, tree)
}

/// Every parent directory of the desired paths.
fn desired_directories(desired: &HashSet<String>) -> Result<HashSet<String>, String> {
    let mut directories = HashSet::new();
    let mut work_bytes = 0u64;
    for path in desired {
        if !is_safe_relative(path) || has_git_segment(path) {
            return Err(format!("unsafe materialize path: {path}"));
        }
        if path.len() > PROMOTION_PATH_MAX_BYTES {
            return Err("materialize path exceeds its bounded path budget".to_string());
        }
        let mut current = String::with_capacity(path.len());
        let mut parts = path.split('/').peekable();
        while let Some(part) = parts.next() {
            // The final component is a file/symlink leaf, not a directory.
            if parts.peek().is_none() {
                break;
            }
            if part.is_empty() || part == "." || part == ".." || part.len() > PROMOTION_COMPONENT_MAX_BYTES {
                return Err(format!("invalid materialize path component in {path}"));
            }
            if current.is_empty() {
                current.push_str(part);
            } else {
                current.push('/');
                current.push_str(part);
            }
            if current.len() > PROMOTION_PATH_MAX_BYTES {
                return Err("materialize directory path exceeds its bounded path budget".to_string());
            }
            work_bytes = work_bytes
                .checked_add(current.len() as u64)
                .ok_or("materialize directory work accounting overflow")?;
            if work_bytes > PROMOTION_DIRECTORY_MAX_NAME_BYTES {
                return Err("materialize directory work exceeds its bound".to_string());
            }
            if !directories.contains(&current) {
                if directories.len() >= PROMOTION_DIRECTORY_MAX_ENTRIES {
                    return Err("materialize contains too many directories".to_string());
                }
                directories.insert(current.clone());
            }
        }
    }
    Ok(directories)
}

/// Remove a complete stale entry through an already-open parent descriptor.
/// The recursive walk never re-resolves an ancestor by pathname.  A second
/// identity check immediately before each unlink closes the deterministic
/// replacement/type-flip seam; if a hostile writer wins the final kernel
/// interval, the operation can only remove the name in this bound parent.
fn promotion_remove_tree_entry(
    parent: RawFd,
    name: &CStr,
    expected: FileIdentity,
    req: &Value,
    relative: &str,
) -> Result<(), String> {
    let current = stat_at(parent, name)
        .map_err(|error| format!("stat stale promotion entry {relative} failed: {error}"))?;
    if !promotion_cleanup_same_namespace_identity(current, expected) {
        return Err(format!(
            "stale promotion entry {relative} changed before removal; evidence retained"
        ));
    }
    if current.is_dir() && !current.is_symlink() {
        let child = open_at(
            parent,
            name,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
        .map_err(|error| format!("open stale promotion directory {relative} failed: {error}"))?;
        let child_identity = stat_file(&child).map_err(|error| {
            format!("fstat stale promotion directory {relative} failed: {error}")
        })?;
        if !promotion_cleanup_same_namespace_identity(child_identity, current) {
            return Err(format!(
                "stale promotion directory {relative} changed while opening; evidence retained"
            ));
        }
        promotion_remove_tree_contents(&child, req, relative)?;
        let before_unlink = stat_at(parent, name).map_err(|error| {
            format!("stat stale promotion directory {relative} failed: {error}")
        })?;
        if !promotion_cleanup_same_namespace_identity(before_unlink, current) {
            return Err(format!(
                "stale promotion directory {relative} changed before removal; evidence retained"
            ));
        }
        promotion_unlink_at_field(parent, name, true, relative)?;
    } else {
        promotion_test_pause(req, "promotion-materialize-leaf-validated")?;
        let before_unlink = stat_at(parent, name)
            .map_err(|error| format!("stat stale promotion entry {relative} failed: {error}"))?;
        if !promotion_cleanup_same_namespace_identity(before_unlink, current) {
            return Err(format!(
                "stale promotion entry {relative} changed before removal; evidence retained"
            ));
        }
        promotion_unlink_at_field(parent, name, false, relative)?;
    }
    Ok(())
}

fn promotion_remove_tree_contents(
    directory: &fs::File,
    req: &Value,
    relative: &str,
) -> Result<(), String> {
    struct RemoveFrame {
        directory: fs::File,
        stream: PromotionDirectoryStream,
        relative: String,
        parent_name: Option<CString>,
        identity: Option<FileIdentity>,
    }
    let mut stack = Vec::with_capacity(PROMOTION_DIRECTORY_MAX_DEPTH);
    stack.push(RemoveFrame {
        directory: directory.try_clone().map_err(|error| format!("clone stale promotion directory failed: {error}"))?,
        stream: PromotionDirectoryStream::open(directory.as_raw_fd())?,
        relative: relative.to_string(),
        parent_name: None,
        identity: None,
    });
    let mut entries = 0usize;
    let mut bytes = 0u64;
    let mut work_bytes = u64::try_from(relative.len())
        .map_err(|_| "stale promotion work accounting overflow")?;
    promotion_add_work(
        &mut work_bytes,
        std::mem::size_of::<FileIdentity>() as u64,
        PROMOTION_DIRECTORY_MAX_NAME_BYTES,
        "stale promotion tree",
    )?;
    while !stack.is_empty() {
        let next = stack
            .last_mut()
            .expect("stale removal stack is not empty")
            .stream
            .next_entry()?;
        let Some((name, c_name)) = next else {
            let frame = stack.pop().expect("stale removal frame exists");
            if let (Some(parent_name), Some(identity)) =
                (frame.parent_name.as_ref(), frame.identity)
            {
                let parent = stack
                    .last()
                    .ok_or("stale removal parent frame is missing")?;
                let before_unlink = stat_at(parent.directory.as_raw_fd(), parent_name).map_err(|error| {
                    format!("stat stale promotion directory {} failed: {error}", frame.relative)
                })?;
                if !promotion_cleanup_same_namespace_identity(before_unlink, identity) {
                    return Err(format!(
                        "stale promotion directory {} changed before removal; evidence retained",
                        frame.relative
                    ));
                }
                promotion_unlink_at_field(
                    parent.directory.as_raw_fd(),
                    parent_name,
                    true,
                    &frame.relative,
                )?;
            }
            continue;
        };
        entries = entries
            .checked_add(1)
            .ok_or("stale promotion entry count overflow")?;
        if entries > PROMOTION_QUARANTINE_MAX_ENTRIES {
            return Err("stale promotion tree exceeds its entry bound; evidence retained".to_string());
        }
        let current_relative = stack.last().expect("stale removal frame exists").relative.clone();
        let path_work = promotion_path_work_bytes(&current_relative, &name)?;
        promotion_add_work(
            &mut work_bytes,
            path_work,
            PROMOTION_DIRECTORY_MAX_NAME_BYTES,
            "stale promotion tree",
        )?;
        let child_relative = promotion_child_relative(&current_relative, &name)?;
        let directory_fd = stack.last().expect("stale removal frame exists").directory.as_raw_fd();
        let identity = match stat_at(directory_fd, &c_name) {
            Ok(identity) => identity,
            Err(error) if missing_path(&error) => continue,
            Err(error) => {
                return Err(format!(
                    "stat stale promotion entry {child_relative} failed: {error}"
                ));
            }
        };
        let logical_bytes = if identity.is_file() {
            identity.len
        } else if identity.is_symlink() {
            u64::try_from(
                read_link_at(directory_fd, &c_name)
                    .map_err(|error| format!("read stale promotion symlink {child_relative} failed: {error}"))?
                    .len(),
            )
            .map_err(|_| "stale promotion symlink byte accounting overflow")?
        } else {
            0
        };
        bytes = bytes
            .checked_add(logical_bytes)
            .ok_or("stale promotion byte accounting overflow")?;
        if bytes > PROMOTION_QUARANTINE_MAX_BYTES {
            return Err("stale promotion tree exceeds its byte bound; evidence retained".to_string());
        }
        if identity.is_dir() && !identity.is_symlink() {
            if stack.len() >= PROMOTION_DIRECTORY_MAX_DEPTH {
                return Err("stale promotion tree exceeds its depth bound; evidence retained".to_string());
            }
            let child = open_at(
                directory_fd,
                &c_name,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|error| format!("open stale promotion directory {child_relative} failed: {error}"))?;
            let child_identity = stat_file(&child).map_err(|error| {
                format!("fstat stale promotion directory {child_relative} failed: {error}")
            })?;
            if !promotion_cleanup_same_namespace_identity(child_identity, identity) {
                return Err(format!(
                    "stale promotion directory {child_relative} changed while opening; evidence retained"
                ));
            }
            let child_stream = PromotionDirectoryStream::open(child.as_raw_fd())?;
            stack.push(RemoveFrame {
                directory: child,
                stream: child_stream,
                relative: child_relative,
                parent_name: Some(c_name),
                identity: Some(identity),
            });
        } else {
            promotion_test_pause(req, "promotion-materialize-leaf-validated")?;
            let before_unlink = stat_at(directory_fd, &c_name).map_err(|error| {
                format!("stat stale promotion entry {child_relative} failed: {error}")
            })?;
            if !promotion_cleanup_same_namespace_identity(before_unlink, identity) {
                return Err(format!(
                    "stale promotion entry {child_relative} changed before removal; evidence retained"
                ));
            }
            promotion_unlink_at_field(directory_fd, &c_name, false, &child_relative)?;
        }
    }
    Ok(())
}

/// Remove stale entries while preserving `.git` and the caller's runtime
/// allowlist.  Desired directories are retained and reconciled recursively;
/// wrong-type desired ancestors are removed only after their descriptor and
/// current namespace identity have been checked.
fn promotion_remove_stale_paths(
    directory: &fs::File,
    relative: &str,
    desired: &HashSet<String>,
    desired_directories: &HashSet<String>,
    preserve: &HashSet<String>,
    req: &Value,
) -> Result<(), String> {
    struct StaleFrame {
        directory: fs::File,
        stream: PromotionDirectoryStream,
        relative: String,
    }
    let mut stack = Vec::with_capacity(PROMOTION_DIRECTORY_MAX_DEPTH);
    stack.push(StaleFrame {
        directory: directory.try_clone().map_err(|error| format!("clone promotion directory failed: {error}"))?,
        stream: PromotionDirectoryStream::open(directory.as_raw_fd())?,
        relative: relative.to_string(),
    });
    let mut entries = 0usize;
    let mut bytes = 0u64;
    let mut work_bytes = u64::try_from(relative.len())
        .map_err(|_| "promotion stale-path work accounting overflow")?;
    promotion_add_work(
        &mut work_bytes,
        std::mem::size_of::<FileIdentity>() as u64,
        PROMOTION_DIRECTORY_MAX_NAME_BYTES,
        "promotion stale-path scan",
    )?;
    while !stack.is_empty() {
        let next = stack
            .last_mut()
            .expect("stale-path stack is not empty")
            .stream
            .next_entry()?;
        let Some((name, c_name)) = next else {
            stack.pop();
            continue;
        };
        let current_relative = stack.last().expect("stale-path frame exists").relative.clone();
        if current_relative.is_empty() && preserve.contains(&name) {
            continue;
        }
        entries = entries
            .checked_add(1)
            .ok_or("promotion stale-path entry count overflow")?;
        if entries > PROMOTION_QUARANTINE_MAX_ENTRIES {
            return Err("promotion stale-path scan exceeds its entry bound".to_string());
        }
        let path_work = promotion_path_work_bytes(&current_relative, &name)?;
        promotion_add_work(
            &mut work_bytes,
            path_work,
            PROMOTION_DIRECTORY_MAX_NAME_BYTES,
            "promotion stale-path scan",
        )?;
        let child_relative = promotion_child_relative(&current_relative, &name)?;
        let directory_fd = stack.last().expect("stale-path frame exists").directory.as_raw_fd();
        let identity = match stat_at(directory_fd, &c_name) {
            Ok(identity) => identity,
            Err(error) if missing_path(&error) => continue,
            Err(error) => {
                return Err(format!(
                    "stat promotion entry {child_relative} failed: {error}"
                ));
            }
        };
        let logical_bytes = if identity.is_file() {
            identity.len
        } else if identity.is_symlink() {
            u64::try_from(
                read_link_at(directory_fd, &c_name)
                    .map_err(|error| format!("read promotion stale symlink {child_relative} failed: {error}"))?
                    .len(),
            )
            .map_err(|_| "promotion stale symlink byte accounting overflow")?
        } else {
            0
        };
        bytes = bytes
            .checked_add(logical_bytes)
            .ok_or("promotion stale-path byte accounting overflow")?;
        if bytes > PROMOTION_QUARANTINE_MAX_BYTES {
            return Err("promotion stale-path scan exceeds its byte bound".to_string());
        }
        if identity.is_dir()
            && !identity.is_symlink()
            && desired_directories.contains(&child_relative)
        {
            if stack.len() >= PROMOTION_DIRECTORY_MAX_DEPTH {
                return Err("promotion stale-path scan exceeds its depth bound".to_string());
            }
            let child = open_at(
                directory_fd,
                &c_name,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|error| {
                format!("open promotion directory {child_relative} failed: {error}")
            })?;
            let child_identity = stat_file(&child).map_err(|error| {
                format!("fstat promotion directory {child_relative} failed: {error}")
            })?;
            if !promotion_cleanup_same_namespace_identity(child_identity, identity) {
                return Err(format!(
                    "promotion directory {child_relative} changed while opening"
                ));
            }
            let child_stream = PromotionDirectoryStream::open(child.as_raw_fd())?;
            stack.push(StaleFrame {
                directory: child,
                stream: child_stream,
                relative: child_relative,
            });
        } else if !desired.contains(&child_relative) || !identity.is_dir() || identity.is_symlink()
        {
            promotion_remove_tree_entry(
                directory_fd,
                &c_name,
                identity,
                req,
                &child_relative,
            )?;
        }
    }
    Ok(())
}

fn promotion_write_entry(
    repo: &Repository,
    target: &fs::File,
    rel_path: &str,
    mode: u32,
    oid: Oid,
    req: &Value,
) -> Result<(), String> {
    if !is_safe_relative(rel_path) || has_git_segment(rel_path) {
        return Err(format!("unsafe promotion materialize path: {rel_path}"));
    }
    if rel_path.len() > PROMOTION_PATH_MAX_BYTES {
        return Err(format!("promotion materialize path exceeds its bounded path budget: {rel_path}"));
    }
    let component_count = rel_path.split('/').count();
    if component_count > PROMOTION_DIRECTORY_MAX_DEPTH {
        return Err(format!("promotion materialize path exceeds its depth bound: {rel_path}"));
    }
    let mut names = Vec::with_capacity(component_count);
    for (index, name) in rel_path.split('/').enumerate() {
        names.push(promotion_component(
            &Value::String(name.to_string()),
            &format!("materialize path component {index}"),
        )?);
    }
    let blob_bytes = match mode {
        0o120000 => git_blob_bytes_bounded(
            repo,
            oid,
            PROMOTION_PATH_MAX_BYTES as u64,
            &format!("symlink blob {rel_path}"),
        )?,
        0o100644 | 0o100755 => git_blob_bytes_bounded(
            repo,
            oid,
            BUDGET_MAX_FILE_BYTES,
            &format!("materialized blob {rel_path}"),
        )?,
        _ => return Err(format!("unsupported materialized mode for {rel_path}")),
    };
    let leaf = names.last().ok_or("promotion materialize path is empty")?;
    let parent = open_or_create_promotion_parent(
        target,
        &names[..names.len() - 1],
        "materialize parent",
        0o700,
    )?;
    let existing = stat_at(parent.as_raw_fd(), &leaf.1).ok();
    match mode {
        0o120000 => {
            let target_text = String::from_utf8(blob_bytes)
                .map_err(|error| format!("symlink blob is not valid UTF-8: {error}"))?;
            if target_text.contains('\0') || target_text.len() > PROMOTION_PATH_MAX_BYTES {
                return Err(format!("symlink target is too long: {rel_path}"));
            }
            let desired_target = target_text.clone();
            if let Some(current) = existing {
                let same = current.is_symlink()
                    && read_link_at(parent.as_raw_fd(), &leaf.1)
                        .ok()
                        .and_then(|bytes| String::from_utf8(bytes).ok())
                        .is_some_and(|value| value == desired_target);
                if !same {
                    promotion_remove_tree_entry(
                        parent.as_raw_fd(),
                        &leaf.1,
                        current,
                        req,
                        rel_path,
                    )?;
                } else {
                    return Ok(());
                }
            }
            let target_text = CString::new(target_text)
                .map_err(|_| format!("symlink target contains NUL: {rel_path}"))?;
            promotion_symlink_at(&target_text, parent.as_raw_fd(), &leaf.1)
                .map_err(|error| format!("symlink failed for {rel_path}: {error}"))?;
            let created = stat_at(parent.as_raw_fd(), &leaf.1)
                .map_err(|error| format!("stat created symlink {rel_path} failed: {error}"))?;
            let created_target = read_link_at(parent.as_raw_fd(), &leaf.1)
                .map_err(|error| format!("read created symlink {rel_path} failed: {error}"))?;
            if !created.is_symlink() || created_target != desired_target.as_bytes() {
                return Err(format!(
                    "promotion symlink changed after creation: {rel_path}"
                ));
            }
        }
        0o100644 | 0o100755 => {
            let mut file = if let Some(current) = existing {
                if !current.is_file() || current.is_symlink() {
                    promotion_remove_tree_entry(
                        parent.as_raw_fd(),
                        &leaf.1,
                        current,
                        req,
                        rel_path,
                    )?;
                    open_at_mode(
                        parent.as_raw_fd(),
                        &leaf.1,
                        libc::O_WRONLY
                            | libc::O_CREAT
                            | libc::O_EXCL
                            | libc::O_NOFOLLOW
                            | libc::O_CLOEXEC,
                        0o600,
                    )
                } else {
                    open_at(
                        parent.as_raw_fd(),
                        &leaf.1,
                        libc::O_WRONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                }
            } else {
                open_at_mode(
                    parent.as_raw_fd(),
                    &leaf.1,
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o600,
                )
            }
            .map_err(|error| format!("open materialized file failed for {rel_path}: {error}"))?;
            let opened = stat_file(&file).map_err(|error| {
                format!("fstat materialized file failed for {rel_path}: {error}")
            })?;
            if !opened.is_file() || opened.is_symlink() {
                return Err(format!("materialized file changed type: {rel_path}"));
            }
            if let Some(current) = existing {
                if !promotion_cleanup_same_namespace_identity(opened, current) {
                    return Err(format!(
                        "materialized file identity changed while opening: {rel_path}"
                    ));
                }
            }
            file.set_len(0).map_err(|error| {
                format!("truncate materialized file failed for {rel_path}: {error}")
            })?;
            promotion_write_all(&mut file, &blob_bytes, rel_path)?;
            promotion_set_mode(
                &file,
                if mode == 0o100755 { 0o755 } else { 0o644 },
                rel_path,
            )?;
            file.sync_all().map_err(|error| {
                format!("sync materialized file failed for {rel_path}: {error}")
            })?;
            let after = stat_file(&file).map_err(|error| {
                format!("fstat materialized file failed for {rel_path}: {error}")
            })?;
            let path_after = stat_at(parent.as_raw_fd(), &leaf.1).map_err(|error| {
                format!("stat materialized file failed for {rel_path}: {error}")
            })?;
            if !promotion_cleanup_same_namespace_identity(after, path_after)
                || after.len != blob_bytes.len() as u64
            {
                return Err(format!(
                    "materialized file changed while writing: {rel_path}"
                ));
            }
        }
        _ => unreachable!("materialized mode was validated before reading"),
    }
    parent
        .sync_all()
        .map_err(|error| format!("sync materialized parent failed for {rel_path}: {error}"))?;
    Ok(())
}

/// Materialize into a directory already opened and authenticated by the
/// native promotion boundary.  Both empty staging directories (template and
/// merged materialization) and existing candidate repositories use this one
/// implementation; no caller can select a separate pathname-based writer.
fn materialize_state_bound(
    repo: &Repository,
    state_commit: &str,
    target_path: &str,
    target: &fs::File,
    target_identity: PromotionIdentity,
    preserve_top: &[String],
    req: &Value,
) -> Result<(), String> {
    promotion_directory_identity_matches(target, target_identity, "materialize target")?;
    promotion_test_pause(req, "promotion-materialize-root-open")?;
    promotion_test_pause(req, "promotion-target-root-open")?;
    let flat = state_entries(repo, state_commit)?;
    let desired: HashSet<String> = flat.keys().cloned().collect();
    let desired_directories = desired_directories(&desired)?;
    let mut preserve: HashSet<String> = HashSet::from([".git".to_string()]);
    preserve.extend(preserve_top.iter().cloned());
    promotion_remove_stale_paths(target, "", &desired, &desired_directories, &preserve, req)?;
    let mut paths: Vec<(&String, &(u32, Oid))> = flat.iter().collect();
    paths.sort_by(|(left, _), (right, _)| left.cmp(right));
    for (rel_path, (mode, oid)) in paths {
        promotion_write_entry(repo, target, rel_path, *mode, *oid, req)?;
    }
    target
        .sync_all()
        .map_err(|error| format!("sync materialize target failed: {error}"))?;
    // A swapped configured path must never be accepted as the successful
    // destination.  All actual writes above used the original descriptor;
    // this final check only authenticates the public name before returning.
    promotion_bound_path_matches(target_path, target_identity, "materialize target")?;
    Ok(())
}

/// Commit the staged index when it differs from HEAD. Returns the commit
/// oid when a commit was written.
fn commit_index_if_changed(repo: &Repository, message: &str) -> Result<Option<Oid>, String> {
    let mut index = repo.index().map_err(|e| e.to_string())?;
    let tree = index
        .write_tree_to(repo)
        .map_err(|e| format!("write-tree failed: {e}"))?;
    let head_tree = match repo.head() {
        Ok(head) => match head.peel_to_tree() {
            Ok(tree) => Some(tree.id()),
            Err(_) => None,
        },
        Err(e) if e.code() == ErrorCode::UnbornBranch || e.code() == ErrorCode::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    if head_tree == Some(tree) {
        return Ok(None);
    }
    let parents: Vec<git2::Commit> = match repo.head() {
        Ok(head) => match head.peel_to_commit() {
            Ok(commit) => vec![commit],
            Err(_) => vec![],
        },
        Err(_) => vec![],
    };
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    let signature = Signature::now("termina", "dev@termina.local").map_err(|e| e.to_string())?;
    let tree_obj = repo.find_tree(tree).map_err(|e| e.to_string())?;
    let oid = repo
        .commit(
            Some("HEAD"),
            &signature,
            &signature,
            message,
            &tree_obj,
            &parent_refs,
        )
        .map_err(|e| format!("commit failed: {e}"))?;
    Ok(Some(oid))
}

/// Stage the working tree, then drop entries not in the state. Mirrors
/// `git add -A -- . :(exclude)<runtime>`.
fn stage_workdir(repo: &Repository, state_flat: &HashMap<String, FlatEntry>) -> Result<(), String> {
    let mut index = repo.index().map_err(|e| e.to_string())?;
    index
        .add_all(&[] as &[&str], IndexAddOption::DEFAULT, None)
        .map_err(|e| format!("git add failed: {e}"))?;
    // Drop every staged entry the state does not contain. The preserved
    // runtime paths stay on disk and stay untracked; entries deleted from
    // disk drop out of the index here too (the stage step cannot remove
    // them by itself).
    let mut kept: Vec<IndexEntry> = Vec::new();
    for entry in index.iter() {
        let path = String::from_utf8(entry.path.clone())
            .map_err(|_| "a staged path is not valid UTF-8".to_string())?;
        if state_flat.contains_key(&path) {
            kept.push(entry);
        }
    }
    index.clear().map_err(|e| e.to_string())?;
    for entry in kept {
        index
            .add(&entry)
            .map_err(|e| format!("index rebuild failed: {e}"))?;
    }
    index.write().map_err(|e| e.to_string())
}

/// Write a small Git control file below a descriptor-bound directory.  The
/// final component is opened with `O_NOFOLLOW`; the resulting descriptor is
/// checked before and after the write so a replacement cannot redirect the
/// bytes through a symlink or a different type.
fn promotion_write_control_file(
    parent: &fs::File,
    name: &CStr,
    bytes: &[u8],
    field: &str,
) -> Result<(), String> {
    let mut file = open_at_mode(
        parent.as_raw_fd(),
        name,
        libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        0o600,
    )
    .map_err(|error| format!("open promotion {field} failed: {error}"))?;
    let opened =
        stat_file(&file).map_err(|error| format!("fstat promotion {field} failed: {error}"))?;
    if !opened.is_file() || opened.is_symlink() {
        return Err(format!("promotion {field} is not a regular file"));
    }
    file.set_len(0)
        .map_err(|error| format!("truncate promotion {field} failed: {error}"))?;
    promotion_write_all(&mut file, bytes, field)?;
    promotion_set_mode(&file, 0o600, field)?;
    file.sync_all()
        .map_err(|error| format!("sync promotion {field} failed: {error}"))?;
    let after =
        stat_file(&file).map_err(|error| format!("fstat promotion {field} failed: {error}"))?;
    let path_after = stat_at(parent.as_raw_fd(), name)
        .map_err(|error| format!("stat promotion {field} failed: {error}"))?;
    if !promotion_cleanup_same_namespace_identity(after, path_after)
        || !after.is_file()
        || after.len != bytes.len() as u64
    {
        return Err(format!("promotion {field} changed while writing"));
    }
    parent
        .sync_all()
        .map_err(|error| format!("sync promotion {field} parent failed: {error}"))
}

fn op_apply_state(req: &Value) -> Result<Value, String> {
    let store_dir = PathBuf::from(s(req, "storeDir")?);
    let state_commit = s(req, "stateId")?;
    let target_path = s(req, "targetDir")?;
    let preserve_top: Vec<String> = req
        .get("preserveTopLevel")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    // Candidate roots are allocated/bound by the native caller.  There is no
    // pathname-only apply-state path: a missing identity is a protocol error.
    let (target, target_identity, _target_capability) =
        open_promotion_bound_root(req, "targetDir", "boundRootIdentity", "boundRootCapability")?;
    promotion_test_pause(req, "promotion-apply-state-root-open")?;
    let cwd = PromotionCwd::enter(&target, "apply-state target")?;
    let result = (|| {
        let repo = open_store(&store_dir, req)?;
        let flat = state_entries(&repo, &state_commit)?;
        materialize_state_bound(
            &repo,
            &state_commit,
            &target_path,
            &target,
            target_identity,
            &preserve_top,
            req,
        )?;

        promotion_test_pause(req, "promotion-apply-state-repo-open")?;
        let candidate = open_repo(Path::new("."))?;
        stage_workdir(&candidate, &flat)?;
        commit_index_if_changed(&candidate, "termina state")?;
        promotion_bound_path_matches(&target_path, target_identity, "apply-state target")?;
        Ok(json!({}))
    })();
    drop(cwd);
    result
}

fn op_template(req: &Value) -> Result<Value, String> {
    let store_dir = PathBuf::from(s(req, "storeDir")?);
    let source_git_dir = PathBuf::from(s(req, "sourceGitDir")?);
    let state_commit = s(req, "stateId")?;
    let target_path = s(req, "targetDir")?;
    let source_objects_dir = PathBuf::from(s(req, "sourceObjectsDir")?);

    let (target, target_identity, _target_capability) =
        open_promotion_bound_root(req, "targetDir", "boundRootIdentity", "boundRootCapability")?;
    promotion_test_pause(req, "promotion-template-root-open")?;
    let cwd = PromotionCwd::enter(&target, "template target")?;
    let result = (|| {
        if !promotion_directory_is_empty(target.as_raw_fd())? {
            return Err("promotion template target is not empty".to_string());
        }
        let store = open_store(&store_dir, req)?;
        // An independent local repository with read-only object access.  The
        // init path is `.` under the bound descriptor, never the mutable
        // target pathname.
        let mut init_opts = RepositoryInitOptions::new();
        init_opts.object_format(store.object_format());
        let template =
            Repository::init_opts(Path::new("."), &init_opts).map_err(|e| e.to_string())?;
        promotion_test_pause(req, "promotion-template-repo-open")?;

        let alternates_name = CString::new("alternates").expect("constant has no NUL");
        let alternates_parent = open_or_create_promotion_parent(
            &target,
            &[
                (
                    ".git".to_string(),
                    CString::new(".git").expect("constant has no NUL"),
                ),
                (
                    "objects".to_string(),
                    CString::new("objects").expect("constant has no NUL"),
                ),
                (
                    "info".to_string(),
                    CString::new("info").expect("constant has no NUL"),
                ),
            ],
            "template alternates parent",
            0o700,
        )?;
        let store_objects = store_dir.join("git").join("objects");
        let alternate_bytes = format!(
            "{}\n{}\n",
            store_objects.display(),
            source_git_dir.join("objects").display()
        );
        promotion_write_control_file(
            &alternates_parent,
            &alternates_name,
            alternate_bytes.as_bytes(),
            "template alternates",
        )?;

        materialize_state_bound(
            &store,
            &state_commit,
            &target_path,
            &target,
            target_identity,
            &[],
            req,
        )?;

        let mut index = template.index().map_err(|e| e.to_string())?;
        index
            .add_all(&[] as &[&str], IndexAddOption::DEFAULT, None)
            .map_err(|e| format!("git add failed: {e}"))?;
        index.write().map_err(|e| e.to_string())?;
        let commit = commit_index_if_changed(&template, "termina base")?
            .ok_or("template commit was not written")?;

        // Pull the store objects into a local pack, then drop the store
        // alternate. The template then needs only the read-only source
        // objects. Both paths are relative to the bound cwd.
        let mut packbuilder = template.packbuilder().map_err(|e| e.to_string())?;
        packbuilder
            .insert_commit(commit)
            .map_err(|e| e.to_string())?;
        let pack_dir = Path::new(".git").join("objects").join("pack");
        packbuilder
            .write(&pack_dir, 0o644)
            .map_err(|e| format!("repack failed: {e}"))?;
        promotion_write_control_file(
            &alternates_parent,
            &alternates_name,
            format!("{}\n", source_objects_dir.display()).as_bytes(),
            "template source alternates",
        )?;
        promotion_bound_path_matches(&target_path, target_identity, "template target")?;
        Ok(json!({ "commit": commit.to_string() }))
    })();
    drop(cwd);
    result
}

/// Open the bare store repository and validate the object format.
fn open_store(store_dir: &Path, req: &Value) -> Result<Repository, String> {
    let lifecycle = validate_store_lifecycle(store_dir, req)?;
    let requested = object_format(&s(req, "objectFormat")?)?;
    let git_dir = store_dir.join("git");
    let repo = Repository::open_bare(&git_dir).map_err(|e| format!("open store failed: {e}"))?;
    if repo.object_format() != requested {
        return Err(format!(
            "object format mismatch: requested {requested}, store has {}",
            match repo.object_format() {
                ObjectFormat::Sha1 => "sha1",
                ObjectFormat::Sha256 => "sha256",
            }
        ));
    }
    // The store pathname may have been replaced while libgit2 opened the
    // repository.  Return only when both the request and the opened path are
    // still the same lifecycle; otherwise the caller must rebind/retry.
    let observed = current_store_lifecycle(store_dir)?;
    if observed != lifecycle {
        return Err(lifecycle_mismatch(&lifecycle, &observed));
    }
    Ok(repo)
}

#[derive(Clone, Copy)]
enum TreeLookupKind {
    Blob,
    Tree,
}

/// Look up one path in a tree by walking its components. O(depth).
///
/// The leaf contract is explicit because incremental tree patching resolves
/// directory entries while blob reads resolve file entries. A blob lookup
/// rejects a tree leaf; a tree lookup treats a non-tree leaf as absent so a
/// file-to-directory replacement can rebuild that subtree from scratch.
fn tree_lookup(
    repo: &Repository,
    tree_oid: Oid,
    rel: &str,
    leaf_kind: TreeLookupKind,
) -> Result<Option<FlatEntry>, String> {
    if !is_safe_relative(rel) || has_git_segment(rel) {
        return Err("Git tree lookup path is unsafe".to_string());
    }
    if rel.len() > PROMOTION_PATH_MAX_BYTES {
        return Err("Git tree lookup path exceeds its bounded path budget".to_string());
    }
    let mut budget = GitTreeBudget::new();
    let mut current = git_tree_object_bounded(repo, tree_oid, &mut budget)?;
    let mut parts = rel.split('/').peekable();
    let mut depth = 0usize;
    while let Some(part) = parts.next() {
        depth = depth
            .checked_add(1)
            .ok_or("Git tree lookup depth overflow")?;
        if depth > PROMOTION_DIRECTORY_MAX_DEPTH {
            return Err("Git tree lookup exceeds its depth bound".to_string());
        }
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.contains('\\')
            || part.len() > PROMOTION_COMPONENT_MAX_BYTES
        {
            return Err("Git tree lookup contains an invalid path component".to_string());
        }
        budget.charge_work(
            u64::try_from(part.len()).map_err(|_| "Git tree lookup work overflow")?,
        )?;
        let found = match current.get_name(part) {
            Some(entry) => (entry.id(), entry.filemode() as u32, entry.kind()),
            None => return Ok(None),
        };
        if parts.peek().is_none() {
            let expected_kind = match leaf_kind {
                TreeLookupKind::Blob => git2::ObjectType::Blob,
                TreeLookupKind::Tree => git2::ObjectType::Tree,
            };
            if found.2 != Some(expected_kind) {
                return match leaf_kind {
                    TreeLookupKind::Blob => {
                        Err("Git tree lookup leaf is not a blob".to_string())
                    }
                    TreeLookupKind::Tree => Ok(None),
                };
            }
            return Ok(Some((found.1, found.0)));
        }
        if found.2 != Some(git2::ObjectType::Tree) || found.1 != 0o040000 {
            return Ok(None);
        }
        current = git_tree_object_bounded(repo, found.0, &mut budget)?;
    }
    Ok(None)
}

// ---------------------------------------------------------- trust hash ----

fn op_trust_hashes(req: &Value) -> Result<Value, String> {
    let agent_dir = PathBuf::from(s(req, "agentDir")?);
    let project_root = opt_s(req, "projectRoot").map(PathBuf::from);
    let mut out = serde_json::Map::new();
    let mut files = 0usize;
    let mut bytes = 0u64;

    for name in [
        "settings.json",
        "models.json",
        "models-store.json",
        "prompts",
        "skills",
        "themes",
        "extensions",
    ] {
        let full = agent_dir.join(name);
        let metadata = match fs::symlink_metadata(&full) {
            Ok(metadata) => metadata,
            Err(_) => continue, // absent
        };
        if metadata.file_type().is_dir() {
            walk_hashes(
                &full,
                &format!("agent/{name}"),
                &mut out,
                &mut files,
                &mut bytes,
            );
        } else if metadata.file_type().is_file()
            && let Some((key, hash)) =
                hash_file(&full, &format!("agent/{name}"), &mut files, &mut bytes)
        {
            out.insert(key, Value::String(hash));
        }
    }
    if let Some(root) = project_root {
        for rel in [".pi", ".agents/skills"] {
            walk_hashes(
                &root.join(rel),
                &format!("project/{rel}"),
                &mut out,
                &mut files,
                &mut bytes,
            );
        }
    }
    Ok(json!({ "state": Value::Object(out) }))
}

fn walk_hashes(
    abs_root: &Path,
    prefix: &str,
    out: &mut serde_json::Map<String, Value>,
    files: &mut usize,
    bytes: &mut u64,
) {
    let entries = match fs::read_dir(abs_root) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if *files >= TRUST_MAX_FILES || *bytes >= TRUST_MAX_BYTES {
            return;
        }
        let Some(name) = entry.file_name().to_str().map(String::from) else {
            continue; // a non-UTF-8 name cannot key the map
        };
        let full = entry.path();
        let metadata = match fs::symlink_metadata(&full) {
            Ok(metadata) => metadata,
            Err(_) => continue, // a transient file — skip
        };
        let key = format!("{prefix}/{name}");
        if metadata.file_type().is_dir() {
            walk_hashes(&full, &key, out, files, bytes);
        } else if metadata.file_type().is_file()
            && let Some((key, hash)) = hash_file(&full, &key, files, bytes)
        {
            out.insert(key, Value::String(hash));
        }
    }
}

fn hash_file(
    path: &Path,
    key: &str,
    files: &mut usize,
    bytes: &mut u64,
) -> Option<(String, String)> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > TRUST_MAX_FILE_BYTES {
        return None;
    }
    let content = fs::read(path).ok()?;
    *files += 1;
    *bytes += content.len() as u64;
    let digest = Sha256::digest(&content);
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    Some((key.to_string(), hex))
}

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

fn op_merge3(req: &Value) -> Result<Value, String> {
    let store_dir = PathBuf::from(s(req, "storeDir")?);
    // Input resolution, tree publication, and the protective merge ref are
    // one store mutation. Unref/prune cannot race any part of it.
    let _mutation_lock = StoreMutationLock::acquire(&store_dir, req)?;
    let store = open_store(&store_dir, req)?;
    recover_store_transaction(&store_dir, &store)?;
    let mut object_transaction = StoreObjectTransaction::new(&store_dir, req);
    let ours = oid_ext(&store, &s(req, "ours")?)?;
    let theirs = oid_ext(&store, &s(req, "theirs")?)?;
    // The commit graph provides the base: every state chains from the root
    // primary state, so its LCA is that root.
    let base = store
        .merge_base(ours, theirs)
        .map_err(|e| format!("merge base failed: {e}"))?;
    let base_tree = store
        .find_commit(base)
        .map_err(|e| e.to_string())?
        .tree()
        .map_err(|e| e.to_string())?;
    let ours_tree = store
        .find_commit(ours)
        .map_err(|e| e.to_string())?
        .tree()
        .map_err(|e| e.to_string())?;
    let theirs_tree = store
        .find_commit(theirs)
        .map_err(|e| e.to_string())?
        .tree()
        .map_err(|e| e.to_string())?;
    let index = store
        .merge_trees(&base_tree, &ours_tree, &theirs_tree, None)
        .map_err(|e| format!("merge failed: {e}"))?;
    let conflicts: Vec<String> = index
        .conflicts()
        .map_err(|e| e.to_string())?
        .filter_map(|conflict| conflict.ok())
        .filter_map(|conflict| {
            let entry = conflict.our.or(conflict.their)?;
            Some(String::from_utf8_lossy(&entry.path).into_owned())
        })
        .collect();
    if index.has_conflicts() {
        return Ok(json!({ "result": { "ok": false, "tree": null, "conflicts": conflicts } }));
    }
    let mut flat: HashMap<String, FlatEntry> = HashMap::new();
    for entry in index.iter() {
        let path = String::from_utf8(entry.path)
            .map_err(|_| "merge produced a non-UTF-8 path".to_string())?;
        if !is_safe_relative(&path) || has_git_segment(&path) {
            return Err(format!("merge produced an unsafe path: {path}"));
        }
        flat.insert(path, (entry.mode, entry.id));
    }
    let tree = write_nested_tree_for_ref(
        &mut object_transaction,
        &store,
        &mut nested_from_flat(&flat)?,
        "refs/termina/merge",
    )?;
    object_transaction.flush(&store)?;
    pause_at_hook(req, "pauseBeforeMergeRef")?;
    // Pin the merged tree: a concurrent unref prune must not delete it
    // before the caller materializes it. Store-create clears these refs
    // with the next session.
    publish_transaction_ref(
        &mut object_transaction,
        &store,
        &format!("refs/termina/merge/{tree}"),
        tree,
        req,
        "failMergeRefAfterWrite",
        "failMergeRefDurability",
        "injected merge ref durability failure",
        "merge pin",
    )?;
    pause_at_hook(req, "pauseAfterMergeRef")?;
    object_transaction.commit()?;
    Ok(json!({ "result": { "ok": true, "tree": tree.to_string(), "conflicts": [] } }))
}

// ------------------------------------------------------------- diff-tree ----

fn op_diff_tree(req: &Value) -> Result<Value, String> {
    let store = open_store(&PathBuf::from(s(req, "storeDir")?), req)?;
    let a = state_entries(&store, &s(req, "stateA")?)?;
    let b = state_entries(&store, &s(req, "stateB")?)?;
    let mut changes: Vec<Value> = Vec::new();
    for (path, entry) in &a {
        match b.get(path) {
            Some(other) if other != entry => {
                changes.push(json!({ "relPath": path, "status": "modified" }));
            }
            Some(_) => {}
            None => {
                changes.push(json!({ "relPath": path, "status": "deleted" }));
            }
        }
    }
    for path in b.keys() {
        if !a.contains_key(path) {
            changes.push(json!({ "relPath": path, "status": "created" }));
        }
    }
    changes.sort_by(|x, y| {
        x.get("relPath")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(y.get("relPath").and_then(Value::as_str).unwrap_or(""))
    });
    Ok(json!({ "changes": changes }))
}

// ------------------------------------------------------------ materialize ----

fn op_materialize(req: &Value) -> Result<Value, String> {
    // Materialization is a destructive tree operation.  It has one canonical
    // descriptor-bound implementation; pathname-only writes are not a valid
    // store protocol anymore.
    // Authenticate the store lifecycle before opening or mutating the target.
    // This keeps a waited request from doing any target-side work after the
    // store pathname has been destroyed and rebound.
    let store = open_store(&PathBuf::from(s(req, "storeDir")?), req)?;
    let (target, target_identity, _target_capability) =
        open_promotion_bound_root(req, "targetDir", "boundRootIdentity", "boundRootCapability")?;
    let state_commit = s(req, "stateId")?;
    let target_path = s(req, "targetDir")?;
    if target_path.len() > PROMOTION_PATH_MAX_BYTES {
        return Err("materialize target path exceeds its bounded path budget".to_string());
    }
    let preserve_top: Vec<String> = req
        .get("preserveTopLevel")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    materialize_state_bound(
        &store,
        &state_commit,
        &target_path,
        &target,
        target_identity,
        &preserve_top,
        req,
    )?;
    Ok(json!({}))
}

fn op_tree_paths(req: &Value) -> Result<Value, String> {
    let store = open_store(&PathBuf::from(s(req, "storeDir")?), req)?;
    let flat = state_entries(&store, &s(req, "stateId")?)?;
    let mut paths: Vec<&String> = flat.keys().collect();
    paths.sort();
    Ok(json!({ "paths": paths }))
}

fn op_symlink_target(req: &Value) -> Result<Value, String> {
    let store = open_store(&PathBuf::from(s(req, "storeDir")?), req)?;
    let state_commit = s(req, "stateId")?;
    let rel = s(req, "relPath")?;
    let tree = resolve_tree(&store, oid_ext(&store, &state_commit)?)?;
    let target = match tree_lookup(&store, tree, &rel, TreeLookupKind::Blob)? {
        Some((0o120000, oid)) => {
            let bytes = git_blob_bytes_bounded(
                &store,
                oid,
                PROMOTION_PATH_MAX_BYTES as u64,
                "symlink blob",
            )?;
            Some(
                String::from_utf8(bytes)
                    .map_err(|e| format!("symlink blob is not valid UTF-8: {e}"))?,
            )
        }
        _ => None,
    };
    Ok(json!({ "target": target }))
}

fn op_read_blob(req: &Value) -> Result<Value, String> {
    let store = open_store(&PathBuf::from(s(req, "storeDir")?), req)?;
    let state_commit = s(req, "stateId")?;
    let rel = s(req, "relPath")?;
    let tree = resolve_tree(&store, oid_ext(&store, &state_commit)?)?;
    let content = match tree_lookup(&store, tree, &rel, TreeLookupKind::Blob)? {
        Some((_, oid)) => {
            let bytes = git_blob_bytes_bounded(&store, oid, READ_BLOB_MAX_BYTES, &format!("blob {rel}"))?;
            Some(base64::engine::general_purpose::STANDARD.encode(bytes))
        }
        None => None,
    };
    Ok(json!({ "content": content }))
}

fn op_unref(req: &Value) -> Result<Value, String> {
    let store_dir = PathBuf::from(s(req, "storeDir")?);
    let _mutation_lock = StoreMutationLock::acquire(&store_dir, req)?;
    let store = open_store(&store_dir, req)?;
    recover_store_transaction(&store_dir, &store)?;
    let commit = oid_ext(&store, &s(req, "commit")?)?;
    let name = format!("refs/termina/state/{commit}");
    if let Ok(reference) = store.find_reference(&name) {
        let mut reference = reference;
        reference.delete().map_err(|e| e.to_string())?;
    }
    // The ref deletion makes objects unreachable. Prune them past the
    // threshold so a long session does not grow the store without bound.
    prune_unreachable(&store)?;
    Ok(json!({}))
}

/// Count the loose objects of the store. Stops at the prune threshold.
fn loose_object_count(git_dir: &Path) -> u64 {
    let mut count = 0u64;
    let objects = git_dir.join("objects");
    let Ok(entries) = fs::read_dir(&objects) else {
        return 0;
    };
    for entry in entries.flatten() {
        if count >= PRUNE_LOOSE_THRESHOLD {
            return count;
        }
        let path = entry.path();
        let is_two_hex = path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.len() == 2);
        if !path.is_dir() || !is_two_hex {
            continue;
        }
        if let Ok(inner) = fs::read_dir(&path) {
            count += inner.flatten().count() as u64;
        }
    }
    count
}

/// Collect every object a ref reaches: commits, trees, and blobs. The tree
/// walk is iterative: deep trees must not overflow the stack.
fn collect_reachable(repo: &Repository) -> Result<HashSet<Oid>, String> {
    let mut reachable = HashSet::new();
    let mut commits: Vec<Oid> = Vec::new();
    let mut trees: Vec<Oid> = Vec::new();
    for reference in repo.references().map_err(|e| e.to_string())? {
        let reference = reference.map_err(|e| e.to_string())?;
        if let Ok(commit) = reference.peel_to_commit() {
            commits.push(commit.id());
        } else if let Some(target) = reference.target() {
            // A ref can pin a tree (the merge pin). Walk it like a commit tree.
            trees.push(target);
        }
    }
    let mut visited = HashSet::new();
    while let Some(commit_oid) = commits.pop() {
        if !visited.insert(commit_oid) {
            continue;
        }
        reachable.insert(commit_oid);
        let Ok(commit) = repo.find_commit(commit_oid) else {
            continue;
        };
        for parent in commit.parent_ids() {
            commits.push(parent);
        }
        trees.push(commit.tree_id());
    }
    // Iterative tree walk: deep trees must not overflow the stack.
    while let Some(tree_oid) = trees.pop() {
        if !reachable.insert(tree_oid) {
            continue;
        }
        let Ok(tree) = repo.find_tree(tree_oid) else {
            continue;
        };
        for entry in tree.iter() {
            match entry.kind() {
                Some(git2::ObjectType::Tree) => trees.push(entry.id()),
                _ => {
                    reachable.insert(entry.id());
                }
            }
        }
    }
    Ok(reachable)
}

/// Delete loose objects that no ref reaches. Runs after an unref, past the
/// threshold. Packed objects stay: the store does not pack its own objects.
fn prune_unreachable(repo: &Repository) -> Result<(), String> {
    let git_dir = repo.path().to_path_buf();
    if loose_object_count(&git_dir) < PRUNE_LOOSE_THRESHOLD {
        return Ok(());
    }
    // Throttle: a burst of unrefs must not repeat the full walk. One prune
    // per minute is enough. The marker lives in the git dir, which Git
    // ignores.
    let marker = git_dir.join("prune-marker");
    if let Ok(text) = fs::read_to_string(&marker)
        && let Ok(last) = text.trim().parse::<u64>()
        && now_ms() / 1000 - last < PRUNE_MIN_INTERVAL_SECS
    {
        return Ok(());
    }
    let reachable = collect_reachable(repo)?;
    let objects = git_dir.join("objects");
    let Ok(entries) = fs::read_dir(&objects) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(dir_name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if dir_name.len() != 2 {
            continue;
        }
        let Ok(inner) = fs::read_dir(&path) else {
            continue;
        };
        for file in inner.flatten() {
            let file_path = file.path();
            let Some(file_name) = file_path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let hex = format!("{dir_name}{file_name}");
            let Ok(oid) = Oid::from_str(&hex) else {
                continue; // pack and index files stay
            };
            if !reachable.contains(&oid) {
                fs::remove_file(&file_path).ok();
            }
        }
    }
    fs::write(&marker, format!("{}", now_ms() / 1000)).ok();
    Ok(())
}

// ---------------------------------------------------------- source queries ----

fn op_git_head(req: &Value) -> Result<Value, String> {
    let root = PathBuf::from(s(req, "root")?);
    let repo = open_repo(&root)?;
    // Distinguish an unborn branch from a broken repository: the caller
    // treats null as "no commits yet", but must see every real failure.
    let head = match repo.head() {
        Ok(head) => head.target().map(|oid| oid.to_string()),
        Err(err) if err.code() == ErrorCode::UnbornBranch => None,
        Err(err) => return Err(format!("git head failed: {err}")),
    };
    Ok(json!({ "head": head }))
}

fn op_git_top_level(req: &Value) -> Result<Value, String> {
    let root = PathBuf::from(s(req, "root")?);
    let repo = match open_repo(&root) {
        Ok(repo) => repo,
        Err(_) => return Ok(json!({ "root": null })),
    };
    let top = repo
        .workdir()
        .map(|workdir| fs::canonicalize(workdir).unwrap_or_else(|_| workdir.to_path_buf()));
    Ok(json!({ "root": top.map(|path| path.to_string_lossy().into_owned()) }))
}

fn op_git_common_dir(req: &Value) -> Result<Value, String> {
    let root = PathBuf::from(s(req, "root")?);
    let repo = open_repo(&root)?;
    Ok(json!({ "gitDir": repo.commondir().to_string_lossy().into_owned() }))
}

fn op_git_object_format(req: &Value) -> Result<Value, String> {
    let root = PathBuf::from(s(req, "root")?);
    let repo = open_repo(&root)?;
    let format = match repo.object_format() {
        ObjectFormat::Sha1 => "sha1",
        ObjectFormat::Sha256 => "sha256",
    };
    Ok(json!({ "format": format }))
}

fn op_ls_tracked(req: &Value) -> Result<Value, String> {
    let root = PathBuf::from(s(req, "root")?);
    let repo = open_repo(&root)?;
    let index = repo.index().map_err(|e| e.to_string())?;
    let mut paths: Vec<String> = Vec::new();
    for entry in index.iter() {
        paths.push(
            String::from_utf8(entry.path.clone())
                .map_err(|_| "a tracked path is not valid UTF-8".to_string())?,
        );
    }
    Ok(json!({ "paths": paths }))
}

// ------------------------------------------------- candidate repo queries --

/// The working-directory status of a candidate repo: staged, unstaged,
/// and untracked changes as porcelain would report them.
fn op_repo_status(req: &Value) -> Result<Value, String> {
    let root = PathBuf::from(s(req, "root")?);
    let repo = open_repo(&root)?;
    let statuses = repo.statuses(None).map_err(|e| e.to_string())?;
    let mut changes: Vec<Value> = Vec::new();
    for status in statuses.iter() {
        let Ok(path) = status.path() else { continue };
        let flags = status.status();
        let kind = if flags.is_wt_deleted() || flags.is_index_deleted() {
            "deleted"
        } else if flags.is_wt_new() || flags.is_index_new() {
            "created"
        } else {
            "modified"
        };
        changes.push(json!({ "relPath": path, "status": kind }));
    }
    changes.sort_by(|x, y| {
        x.get("relPath")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(y.get("relPath").and_then(Value::as_str).unwrap_or(""))
    });
    Ok(json!({ "changes": changes }))
}

/// The committed changes between two commits of a candidate repo.
fn op_repo_diff(req: &Value) -> Result<Value, String> {
    let root = PathBuf::from(s(req, "root")?);
    let repo = open_repo(&root)?;
    let from = repo
        .revparse_single(&s(req, "from")?)
        .map_err(|e| e.to_string())?;
    let to = repo
        .revparse_single(&s(req, "to")?)
        .map_err(|e| e.to_string())?;
    let from_tree = from.peel_to_tree().map_err(|e| e.to_string())?;
    let to_tree = to.peel_to_tree().map_err(|e| e.to_string())?;
    let diff = repo
        .diff_tree_to_tree(Some(&from_tree), Some(&to_tree), None)
        .map_err(|e| e.to_string())?;
    let mut changes: Vec<Value> = Vec::new();
    for delta in diff.deltas() {
        use git2::Delta;
        match delta.status() {
            Delta::Added => changes.push(json!({ "relPath": delta.new_file().path().and_then(|p| p.to_str()).unwrap_or(""), "status": "created" })),
            Delta::Deleted => changes.push(json!({ "relPath": delta.old_file().path().and_then(|p| p.to_str()).unwrap_or(""), "status": "deleted" })),
            Delta::Modified | Delta::Typechange | Delta::Conflicted => {
                changes.push(json!({ "relPath": delta.new_file().path().and_then(|p| p.to_str()).unwrap_or(""), "status": "modified" }))
            }
            Delta::Renamed => {
                changes.push(json!({ "relPath": delta.old_file().path().and_then(|p| p.to_str()).unwrap_or(""), "status": "deleted" }));
                changes.push(json!({ "relPath": delta.new_file().path().and_then(|p| p.to_str()).unwrap_or(""), "status": "created" }));
            }
            Delta::Copied => changes.push(json!({ "relPath": delta.new_file().path().and_then(|p| p.to_str()).unwrap_or(""), "status": "created" })),
            Delta::Unmodified | Delta::Unreadable | Delta::Untracked | Delta::Ignored => {}
        }
    }
    changes.sort_by(|x, y| {
        x.get("relPath")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(y.get("relPath").and_then(Value::as_str).unwrap_or(""))
    });
    Ok(json!({ "changes": changes }))
}

/// The recursive tree of a candidate commit with blob sizes.
fn op_repo_tree(req: &Value) -> Result<Value, String> {
    let root = PathBuf::from(s(req, "root")?);
    let repo = open_repo(&root)?;
    let commit = repo
        .revparse_single(&s(req, "commit")?)
        .map_err(|e| e.to_string())?;
    let tree = commit.peel_to_tree().map_err(|e| e.to_string())?;
    let mut entries: Vec<Value> = Vec::new();
    collect_repo_tree(&repo, &tree, "", &mut entries)?;
    Ok(json!({ "entries": entries }))
}

fn collect_repo_tree(
    repo: &Repository,
    tree: &git2::Tree,
    prefix: &str,
    out: &mut Vec<Value>,
) -> Result<(), String> {
    // Iterative walk: a deep tree must not overflow the stack.
    let mut stack: Vec<(Oid, String)> = vec![(tree.id(), prefix.to_string())];
    let mut budget = GitTreeBudget::new();
    while let Some((current_oid, current_prefix)) = stack.pop() {
        let depth = current_prefix.split('/').filter(|part| !part.is_empty()).count();
        if depth > PROMOTION_DIRECTORY_MAX_DEPTH {
            return Err("Git repository tree exceeds its depth bound".to_string());
        }
        let current = git_tree_object_bounded(repo, current_oid, &mut budget)?;
        for entry in current.iter() {
            budget.charge_entry()?;
            let name = entry.name().map_err(|e| e.to_string())?;
            let kind = entry
                .kind()
                .ok_or("Git repository tree entry has no object type")?;
            if kind == git2::ObjectType::Tree && depth >= PROMOTION_DIRECTORY_MAX_DEPTH {
                return Err("Git repository tree exceeds its depth bound".to_string());
            }
            let path = git_tree_entry_path(&current_prefix, name)?;
            budget.charge_work(
                u64::try_from(path.len() + name.len())
                    .map_err(|_| "Git repository tree work accounting overflow")?,
            )?;
            match kind {
                git2::ObjectType::Tree => {
                    if entry.filemode() as u32 != 0o040000 {
                        return Err(format!(
                            "Git repository tree entry {path} has an invalid mode"
                        ));
                    }
                    stack.push((entry.id(), path));
                }
                git2::ObjectType::Blob => {
                    let mode = entry.filemode() as u32;
                    let max_blob = match mode {
                        0o100644 | 0o100755 => READ_BLOB_MAX_BYTES,
                        0o120000 => PROMOTION_PATH_MAX_BYTES as u64,
                        _ => {
                            return Err(format!(
                                "Git repository tree entry {path} has an unsupported mode"
                            ));
                        }
                    };
                    let size = git_blob_size_bounded(
                        repo,
                        entry.id(),
                        max_blob,
                        &format!("Git repository blob {path}"),
                    )?;
                    budget.charge_bytes(size)?;
                    out.push(json!({ "path": path, "mode": format!("{:o}", entry.filemode()), "size": size }));
                }
                _ => {
                    return Err(format!(
                        "Git repository tree entry {path} has an unsupported object type"
                    ));
                }
            }
        }
    }
    Ok(())
}

/// One file of a candidate commit, or null when absent.
fn op_repo_file(req: &Value) -> Result<Value, String> {
    let root = PathBuf::from(s(req, "root")?);
    let repo = open_repo(&root)?;
    let commit = repo
        .revparse_single(&s(req, "commit")?)
        .map_err(|e| e.to_string())?;
    let tree = commit.peel_to_tree().map_err(|e| e.to_string())?;
    let rel = s(req, "path")?;
    let content = match tree_lookup(&repo, tree.id(), &rel, TreeLookupKind::Blob)? {
        Some((_, oid)) => {
            let bytes = git_blob_bytes_bounded(&repo, oid, READ_BLOB_MAX_BYTES, &format!("blob {rel}"))?;
            Some(base64::engine::general_purpose::STANDARD.encode(bytes))
        }
        None => None,
    };
    Ok(json!({ "content": content }))
}

/// The ignored untracked files of a candidate repo.
fn op_ls_ignored(req: &Value) -> Result<Value, String> {
    let root = PathBuf::from(s(req, "root")?);
    let repo = open_repo(&root)?;
    let statuses = repo
        .statuses(Some(
            &mut StatusOptions::new()
                .include_untracked(true)
                .include_ignored(true),
        ))
        .map_err(|e| e.to_string())?;
    let mut paths: Vec<String> = statuses
        .iter()
        .filter(|status| status.status().is_ignored())
        .filter_map(|status| status.path().ok().map(String::from))
        .collect();
    paths.sort();
    Ok(json!({ "paths": paths }))
}

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
