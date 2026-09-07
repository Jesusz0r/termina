//! Snapshot-store identity, lifecycle, and durable file primitives.
use std::ffi::{CStr, CString};
use std::fs;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

use crate::{open_at, s, stat_file};


pub(crate) const STORE_GENERATION_FILE: &str = "termina-store-generation";
pub(crate) const STORE_GENERATION_HEX_BYTES: usize = 64;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct StoreIdentity {
    pub(crate) dev: u64,
    pub(crate) ino: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct StoreLifecycle {
    pub(crate) generation: String,
    pub(crate) identity: StoreIdentity,
    /// The bare repository and its stable mutable subdirectories are part of
    /// the same lifecycle.  The root generation alone cannot distinguish a
    /// child-Git replacement at the unchanged store pathname.
    pub(crate) git: StoreGitLayout,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct StoreGitLayout {
    pub(crate) git: StoreIdentity,
    pub(crate) objects: StoreIdentity,
    pub(crate) objects_info: StoreIdentity,
    pub(crate) objects_pack: StoreIdentity,
    pub(crate) refs: StoreIdentity,
    pub(crate) refs_heads: StoreIdentity,
    pub(crate) refs_tags: StoreIdentity,
}

/// Identity used by store-destroy's commit boundary.  Directory mtime is
/// intentionally excluded from equality: Git mutates child entries while the
/// store remains the same object.  Link count is retained separately because
/// a same-inode hard-link/namespace change must not pass the final admission.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct StoreNodeIdentity {
    pub(crate) identity: StoreIdentity,
    pub(crate) file_type: u32,
    pub(crate) links: u64,
}

pub(crate) fn store_node_from_stat(identity: FileIdentity, links: u64, label: &str) -> Result<StoreNodeIdentity, String> {
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

pub(crate) fn store_node_at(parent: RawFd, name: &CStr, label: &str) -> Result<StoreNodeIdentity, String> {
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

pub(crate) fn store_node_at_optional(
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

pub(crate) fn store_node_file(file: &fs::File, label: &str) -> Result<StoreNodeIdentity, String> {
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

pub(crate) fn store_node_matches(left: StoreNodeIdentity, right: StoreNodeIdentity) -> bool {
    left.identity == right.identity
        && left.file_type == right.file_type
        && left.links == right.links
}

pub(crate) fn store_generation_path(store_dir: &Path) -> PathBuf {
    store_dir.join(STORE_GENERATION_FILE)
}

pub(crate) fn store_identity_at(store_dir: &Path) -> Result<StoreIdentity, String> {
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

pub(crate) fn store_directory_identity(path: &Path, label: &str) -> Result<StoreIdentity, String> {
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

pub(crate) fn store_git_layout_at(store_dir: &Path) -> Result<StoreGitLayout, String> {
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

pub(crate) fn store_directory_from_parent(
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
pub(crate) fn store_lifecycle_at_root(root: &fs::File) -> Result<StoreLifecycle, String> {
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

pub(crate) fn valid_store_generation(value: &str) -> bool {
    value.len() == STORE_GENERATION_HEX_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) fn read_store_generation(store_dir: &Path) -> Result<String, String> {
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
pub(crate) fn read_store_generation_file(file: &mut fs::File) -> Result<String, String> {
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

pub(crate) fn read_store_generation_at(root: &fs::File) -> Result<String, String> {
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

pub(crate) fn current_store_lifecycle(store_dir: &Path) -> Result<StoreLifecycle, String> {
    Ok(StoreLifecycle {
        generation: read_store_generation(store_dir)?,
        identity: store_identity_at(store_dir)?,
        git: store_git_layout_at(store_dir)?,
    })
}

pub(crate) fn parse_store_identity(value: &Value, field: &str) -> Result<StoreIdentity, String> {
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

pub(crate) fn requested_store_lifecycle(req: &Value) -> Result<StoreLifecycle, String> {
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

pub(crate) fn lifecycle_json(lifecycle: &StoreLifecycle) -> Value {
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

pub(crate) fn lifecycle_mismatch(expected: &StoreLifecycle, observed: &StoreLifecycle) -> String {
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
pub(crate) fn validate_store_lifecycle(store_dir: &Path, req: &Value) -> Result<StoreLifecycle, String> {
    let expected = requested_store_lifecycle(req)?;
    let observed = current_store_lifecycle(store_dir)?;
    if observed != expected {
        return Err(lifecycle_mismatch(&expected, &observed));
    }
    Ok(observed)
}

pub(crate) fn fresh_store_generation() -> Result<String, String> {
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

pub(crate) fn write_store_generation(store_dir: &Path, generation: &str) -> Result<(), String> {
    if !valid_store_generation(generation) {
        return Err("cannot write an invalid snapshot store generation".to_string());
    }
    durable_write(&store_generation_path(store_dir), generation.as_bytes())
}

pub(crate) fn insert_lifecycle_fields(target: &mut serde_json::Map<String, Value>, lifecycle: &StoreLifecycle) {
    if let Value::Object(fields) = lifecycle_json(lifecycle) {
        for (key, value) in fields {
            target.insert(key, value);
        }
    }
}

/// Recheck and bind a successful result to the same lifecycle.  Capture and
/// merge responses carry their payload under `state`/`result`; other store
/// operations return the fields at the top level.
pub(crate) fn bind_store_result(req: &Value, mut payload: Value) -> Result<Value, String> {
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

pub(crate) fn sync_directory(path: &Path) -> Result<(), String> {
    fs::File::open(path)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| format!("sync directory {} failed: {e}", path.display()))
}

pub(crate) fn sync_directory_nofollow(path: &Path) -> Result<(), String> {
    let directory = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|e| format!("open directory {} for sync failed: {e}", path.display()))?;
    directory
        .sync_all()
        .map_err(|e| format!("sync directory {} failed: {e}", path.display()))
}

pub(crate) fn ensure_real_directory(path: &Path, mode: u32) -> Result<bool, String> {
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

pub(crate) fn durable_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
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


pub(crate) fn read_regular_file_nofollow(path: &Path) -> Result<Vec<u8>, String> {
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

pub(crate) fn same_regular_file(left: &Path, right: &Path) -> bool {
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct FileIdentity {
    pub(crate) dev: u64,
    pub(crate) ino: u64,
    pub(crate) len: u64,
    pub(crate) mode: u32,
    pub(crate) mtime: (i64, i64),
    pub(crate) ctime: (i64, i64),
}

impl FileIdentity {
    pub(crate) fn from_stat(st: &libc::stat) -> Self {
        Self {
            dev: st.st_dev as u64,
            ino: st.st_ino as u64,
            len: st.st_size as u64,
            mode: st.st_mode as u32,
            mtime: stat_mtime(st),
            ctime: stat_ctime(st),
        }
    }

    pub(crate) fn file_type(self) -> u32 {
        self.mode & libc::S_IFMT as u32
    }

    pub(crate) fn is_file(self) -> bool {
        self.file_type() == libc::S_IFREG as u32
    }

    pub(crate) fn is_dir(self) -> bool {
        self.file_type() == libc::S_IFDIR as u32
    }

    pub(crate) fn is_symlink(self) -> bool {
        self.file_type() == libc::S_IFLNK as u32
    }
}

pub(crate) fn stat_mtime(st: &libc::stat) -> (i64, i64) {
    (st.st_mtime, st.st_mtime_nsec)
}

pub(crate) fn stat_ctime(st: &libc::stat) -> (i64, i64) {
    (st.st_ctime, st.st_ctime_nsec)
}
