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
use std::fs;
use std::sync::Mutex;
use std::io::{BufRead, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use git2::{
    ErrorCode, IndexAddOption, IndexEntry, ObjectFormat, Oid, Repository, RepositoryInitOptions,
    RepositoryOpenFlags, Signature, StatusOptions,
};
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
const BUDGET_MAX_NEW_BLOB_BYTES: u64 = 256 * 1024 * 1024;
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
fn before_read_hooks(req: &Value) -> Vec<(String, String)> {
    req.pointer("/hooks/beforeRead")
        .and_then(Value::as_array)
        .map(|hooks| {
            hooks
                .iter()
                .filter_map(|hook| {
                    let path = hook.get("path").and_then(Value::as_str)?;
                    let content = hook.get("content").and_then(Value::as_str)?;
                    Some((path.to_string(), content.to_string()))
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

/// The hash of a blob object for the store's object format.
fn blob_oid(repo: &Repository, bytes: &[u8]) -> Oid {
    object_oid(repo, "blob", bytes)
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

/// Write a blob into the store when it is new. The loose-path check ignores
/// the source alternate, so the store keeps its own copy of every captured
/// blob. The store never packs its own objects (gc.auto is disabled), so a
/// loose check is a complete check of the store. Returns (oid, new bytes).
fn write_blob(repo: &Repository, bytes: &[u8]) -> Result<(Oid, u64), String> {
    write_loose_object(repo, "blob", bytes)
}

/// Write one loose object in Git's format. The oid is the hash of
/// header + content; an existing object short-circuits to no write.
fn write_loose_object(
    repo: &Repository,
    kind: &str,
    content: &[u8],
) -> Result<(Oid, u64), String> {
    let oid = object_oid(repo, kind, content);
    let loose = loose_path(repo, oid).ok_or("oid length does not match the object format")?;
    if loose.exists() {
        return Ok((oid, 0));
    }
    // The loose format is zlib(header + bytes).
    let header = format!("{} {}\0", kind, content.len()).into_bytes();
    use std::io::Write as _;
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), BLOB_COMPRESSION);
    encoder
        .write_all(&header)
        .and_then(|_| encoder.write_all(content))
        .and_then(|_| encoder.finish())
        .map_err(|e| format!("deflate failed: {e}"))
        .and_then(|compressed| {
            let parent = loose.parent().ok_or("loose object path has no parent")?;
            fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
            let tmp = parent.join(format!(
                "tmp-{}-{:08x}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.subsec_nanos())
                    .unwrap_or(0)
            ));
            fs::write(&tmp, compressed).map_err(|e| format!("write failed: {e}"))?;
            match fs::rename(&tmp, &loose) {
                Ok(()) => Ok(()),
                Err(_) => {
                    fs::remove_file(&tmp).ok();
                    if loose.exists() {
                        Ok(()) // a concurrent writer won the race
                    } else {
                        Err("loose object rename failed".to_string())
                    }
                }
            }
        })?;
    Ok((oid, content.len() as u64))
}

/// Read a file and verify it did not change while reading.
fn read_file_verified(abs: &Path, before_read: &[(String, String)]) -> Result<Vec<u8>, String> {
    let before = fs::metadata(abs).map_err(|e| format!("stat failed: {e}"))?;
    let mut file = fs::File::open(abs).map_err(|e| format!("open failed: {e}"))?;
    // The test seam rewrites a file after the open, before the read. The
    // verification must then detect the change.
    for (hook_path, content) in before_read {
        let target = abs.to_string_lossy();
        // Match on a path boundary: a hook for "foo.txt" must not also
        // rewrite "barfoo.txt".
        if target == hook_path.as_str()
            || (target.len() > hook_path.len()
                && target.ends_with(hook_path.as_str())
                && target.as_bytes()[target.len() - hook_path.len() - 1] == b'/')
        {
            fs::write(abs, content).ok();
        }
    }
    let mut bytes = Vec::new();
    use std::io::Read;
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("read failed: {e}"))?;
    let after = file.metadata().map_err(|e| format!("fstat failed: {e}"))?;
    let same = before.dev() == after.dev()
        && before.ino() == after.ino()
        && before.len() == after.len()
        && before.mtime() == after.mtime()
        && before.mtime_nsec() == after.mtime_nsec();
    if !same {
        return Err(format!("file changed while captured: {}", abs.display()));
    }
    let path_st = fs::symlink_metadata(abs)
        .map_err(|_| format!("file vanished while captured: {}", abs.display()))?;
    if path_st.dev() != after.dev() || path_st.ino() != after.ino() {
        return Err(format!("file replaced while captured: {}", abs.display()));
    }
    Ok(bytes)
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
    Repository::open_ext(root, RepositoryOpenFlags::empty(), None::<&str>)
        .map_err(|e| format!("open source repository failed: {e}"))
}

/// True when a path contains a `.git` segment (a nested repository).
fn has_git_segment(path: &str) -> bool {
    path.split('/').any(|seg| seg == ".git")
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

fn write_nested_tree(repo: &Repository, root: &mut HashMap<String, Node>) -> Result<Oid, String> {
    let entries = build_tree_entries(repo, root)?;
    let content = tree_object_content(&entries);
    // The read-back verification in the capture ops parses this object
    // through libgit2, so a format mistake fails loudly there.
    write_loose_object(repo, "tree", &content).map(|(oid, _)| oid)
}

/// Write nested trees bottom-up and collect the entries of one directory.
fn build_tree_entries(
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
                let sub_oid = write_nested_tree(repo, sub)?;
                entries.push(TreeEntry {
                    mode: 0o040000,
                    name: name.clone(),
                    oid: sub_oid,
                });
            }
        }
    }
    // Git sorts tree entries byte-wise; directories compare as if their
    // name carried a trailing slash.
    let sort_key = |e: &TreeEntry| {
        if e.mode == 0o040000 {
            format!("{}/", e.name)
        } else {
            e.name.clone()
        }
    };
    entries.sort_by(|a, b| sort_key(a).cmp(&sort_key(b)));
    Ok(entries)
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

/// Walk a tree and collect every non-tree entry into a flat map.
fn collect_tree_map(
    repo: &Repository,
    tree_oid: Oid,
) -> Result<HashMap<String, FlatEntry>, String> {
    let mut out = HashMap::new();
    collect_tree_map_at(repo, tree_oid, "", &mut out)?;
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

fn collect_tree_map_at(
    repo: &Repository,
    tree_oid: Oid,
    prefix: &str,
    out: &mut HashMap<String, FlatEntry>,
) -> Result<(), String> {
    // Iterative walk: a deep tree must not overflow the stack.
    let mut stack: Vec<(Oid, String)> = vec![(tree_oid, prefix.to_string())];
    while let Some((current_oid, current_prefix)) = stack.pop() {
        let tree = repo.find_tree(current_oid).map_err(|e| e.to_string())?;
        for entry in tree.iter() {
            let name = entry.name().map_err(|e| e.to_string())?;
            let path = if current_prefix.is_empty() {
                name.to_string()
            } else {
                format!("{current_prefix}/{name}")
            };
            match entry.kind() {
                Some(git2::ObjectType::Tree) => stack.push((entry.id(), path)),
                _ => {
                    out.insert(path, (entry.filemode() as u32, entry.id()));
                }
            }
        }
    }
    Ok(())
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
    repo: &Repository,
    tree: Oid,
    parent: Option<Oid>,
    message: &str,
) -> Result<Oid, String> {
    let signature = Signature::now("termina", "dev@termina.local").map_err(|e| e.to_string())?;
    let parents: Vec<git2::Commit> = match parent {
        Some(oid) => vec![repo.find_commit(oid).map_err(|e| e.to_string())?],
        None => vec![],
    };
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    let tree_obj = repo.find_tree(tree).map_err(|e| e.to_string())?;
    repo.commit(
        None,
        &signature,
        &signature,
        message,
        &tree_obj,
        &parent_refs,
    )
    .map_err(|e| format!("commit failed: {e}"))
}

/// Pin a state commit with a store-local ref so gc never prunes it.
fn update_state_ref(repo: &Repository, commit: Oid) -> Result<(), String> {
    let name = format!("refs/termina/state/{commit}");
    repo.reference(&name, commit, true, "")
        .map_err(|e| e.to_string())
        .map(|_| ())
}

// ------------------------------------------------------------ capture -----

/// Enumerate the capture domain: tracked files plus untracked non-ignored
/// files. Matches `git ls-files -z` plus `ls-files --others
/// --exclude-standard` run in the capture root. Repo paths are relative to
/// the working directory; the capture root can be a subdirectory, so strip
/// the working-directory prefix and keep only paths under the root.
fn enumerate_domain(
    repo: &Repository,
    capture_root: &Path,
) -> Result<(Vec<String>, HashMap<String, IndexEntry>), String> {
    let workdir = repo
        .workdir()
        .ok_or("the source repository has no working directory")?;
    let root_canon = fs::canonicalize(capture_root).unwrap_or_else(|_| capture_root.to_path_buf());
    let workdir_canon = fs::canonicalize(workdir).unwrap_or_else(|_| workdir.to_path_buf());
    let prefix: Option<String> = if root_canon == workdir_canon {
        None
    } else {
        let rel = root_canon
            .strip_prefix(&workdir_canon)
            .map_err(|_| "capture root is outside the repository".to_string())?;
        Some(format!("{}/", rel.to_string_lossy()))
    };
    let map_path = |path: String| -> Option<String> {
        match &prefix {
            Some(prefix) => path.strip_prefix(prefix.as_str()).map(String::from),
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
/// unless the file's stat data matches its stage-0 index entry exactly.
/// The store reads the referenced blob through its read-only alternate, so
/// no bytes are copied.
fn stat_cached_entry(
    abs: &Path,
    entry: &IndexEntry,
    max_file_bytes: u64,
    index_write: Option<std::time::SystemTime>,
) -> Option<(u32, Oid)> {
    let mode = entry.mode;
    if mode != 0o100644 && mode != 0o100755 && mode != 0o120000 {
        return None;
    }
    let st = fs::symlink_metadata(abs).ok()?;
    // Racy-git rule: a file modified at or after the last index write is
    // re-read even when every other stat field matches.
    if let Some(index_write) = index_write {
        let mtime = st.modified().ok()?;
        if mtime >= index_write {
            return None;
        }
    }
    let entry_mtime = entry.mtime;
    let stat_matches = st.dev() == u64::from(entry.dev)
        && st.ino() == u64::from(entry.ino)
        && st.len() == u64::from(entry.file_size)
        && st.mtime() == i64::from(entry_mtime.seconds())
        && st.mtime_nsec() == i64::from(entry_mtime.nanoseconds());
    if !stat_matches {
        return None;
    }
    if mode == 0o120000 {
        if !st.file_type().is_symlink() {
            return None;
        }
        return Some((0o120000, entry.id));
    }
    if !st.is_file() {
        return None;
    }
    if st.len() > max_file_bytes {
        return None;
    }
    // An executable-bit change must re-hash so the tree records the mode.
    let live_mode = if st.mode() & 0o111 != 0 {
        0o100755
    } else {
        0o100644
    };
    if live_mode != mode {
        return None;
    }
    Some((mode, entry.id))
}

/// Hash one working-tree path into the store. Returns None when the path
/// is gone or is a directory (a gitlink). Returns (mode, oid, new bytes).
fn hash_path(
    repo: &Repository,
    abs: &Path,
    max_file_bytes: u64,
    before_read: &[(String, String)],
) -> Result<Option<(u32, Oid, u64)>, String> {
    let st = match fs::symlink_metadata(abs) {
        Ok(st) => st,
        Err(_) => return Ok(None),
    };
    if st.file_type().is_symlink() {
        let target = fs::read_link(abs).map_err(|e| format!("readlink failed: {e}"))?;
        let bytes = target
            .into_os_string()
            .into_string()
            .map_err(|_| format!("symlink target is not valid UTF-8: {}", abs.display()))?
            .into_bytes();
        let (oid, new_bytes) = write_blob(repo, &bytes)?;
        return Ok(Some((0o120000, oid, new_bytes)));
    }
    if st.file_type().is_dir() {
        return Ok(None);
    }
    if !st.file_type().is_file() {
        return Err("unsupported file type".to_string());
    }
    if st.len() > max_file_bytes {
        return Err(format!(
            "file exceeds the {max_file_bytes} byte budget: {}",
            abs.display()
        ));
    }
    let bytes = read_file_verified(abs, before_read)?;
    // The stat above approved the size. A file can grow between the stat
    // and the read: verify the budget again after the bytes are in memory.
    if bytes.len() as u64 > max_file_bytes {
        return Err(format!(
            "file grew past the {max_file_bytes} byte budget while captured: {}",
            abs.display()
        ));
    }
    let mode = if st.mode() & 0o111 != 0 {
        0o100755
    } else {
        0o100644
    };
    let (oid, new_bytes) = write_blob(repo, &bytes)?;
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
    let store = open_store(&PathBuf::from(s(req, "storeDir")?), req)?;
    let source = open_repo(&capture_root)?;
    let parent_oid = parent_commit
        .as_deref()
        .map(|p| oid_ext(&store, p))
        .transpose()?;
    let hooks = before_read_hooks(req);

    let paths_and_index = enumerate_domain(&source, &capture_root)?;
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
    let index_write = fs::metadata(source.path().join("index"))
        .and_then(|m| m.modified())
        .ok();

    let mut flat: HashMap<String, FlatEntry> = HashMap::new();
    let mut new_blob_bytes = 0u64;
    for rel_path in &paths {
        let abs = capture_root.join(rel_path);
        // The test seam rewrites files mid-read; bypass the stat-cache so
        // its verification semantics stay intact.
        let cached = if hooks.is_empty() {
            index_entries
                .get(rel_path)
                .and_then(|e| stat_cached_entry(&abs, e, max_file_bytes, index_write))
                .map(|(mode, oid)| (mode, oid, 0u64))
        } else {
            None
        };
        let captured = match cached {
            Some(hit) => Some(hit),
            None => hash_path(&store, &abs, max_file_bytes, &hooks)?,
        };
        if let Some((mode, oid, new_bytes)) = captured {
            new_blob_bytes += new_bytes;
            flat.insert(rel_path.clone(), (mode, oid));
        }
    }
    if new_blob_bytes > max_new_blob_bytes {
        return Err(format!(
            "capture exceeds the {max_new_blob_bytes} new-blob byte budget ({new_blob_bytes} bytes)"
        ));
    }

    let tree = write_nested_tree(&store, &mut nested_from_flat(&flat)?)?;
    let commit = commit_tree(&store, tree, parent_oid, "termina source state")?;
    update_state_ref(&store, commit)?;

    // Read the tree back and verify every captured entry.
    let seen = collect_tree_map(&store, tree)?;
    verify_expected(&seen, &flat, true)?;
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
                    let content = v.get("content").and_then(Value::as_str)?;
                    Some((rel.to_string(), content.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();

    // The store owns every object and ref. The delta comes from the hints
    // and the reconcile map; no source enumeration is needed.
    let store = open_store(&PathBuf::from(s(req, "storeDir")?), req)?;
    let hooks = before_read_hooks(req);
    let parent_oid = oid_ext(&store, &parent_commit)?;
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
    for (rel_path, content) in &reconcile {
        if !is_safe_relative(rel_path) || has_git_segment(rel_path) {
            continue;
        }
        let Some((_, parent_oid)) = parent_flat.get(rel_path) else {
            continue; // not in the capture domain
        };
        let content_oid = blob_oid(&store, content.as_bytes());
        if content_oid != *parent_oid {
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

    // Seed the flat map from the parent tree, then apply the delta.
    let mut flat = parent_flat;
    let mut expected: HashMap<String, FlatEntry> = HashMap::new();
    let mut new_blob_bytes = 0u64;
    for rel_path in changed.iter() {
        let abs = capture_root.join(rel_path);
        match hash_path(&store, &abs, max_file_bytes, &hooks)? {
            Some((mode, oid, new_bytes)) => {
                new_blob_bytes += new_bytes;
                flat.insert(rel_path.clone(), (mode, oid));
                expected.insert(rel_path.clone(), (mode, oid));
            }
            None => {
                // The path is gone or is a gitlink: drop it from the tree.
                flat.remove(rel_path);
            }
        }
    }
    if new_blob_bytes > max_new_blob_bytes {
        return Err(format!(
            "capture exceeds the {max_new_blob_bytes} new-blob byte budget ({new_blob_bytes} bytes)"
        ));
    }

    let tree = write_nested_tree(&store, &mut nested_from_flat(&flat)?)?;
    let commit = commit_tree(&store, tree, Some(parent_oid), "termina source state")?;
    update_state_ref(&store, commit)?;

    // Verify only the changed paths. A full read-back would walk every
    // entry; the untouched ones came straight from the verified parent.
    for (rel_path, (exp_mode, exp_oid)) in &expected {
        match tree_lookup(&store, tree, rel_path)? {
            Some((mode, oid)) if mode == *exp_mode && oid == *exp_oid => {}
            _ => return Err(format!("tree verification mismatch for {rel_path}")),
        }
    }
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
fn desired_directories(desired: &HashSet<String>) -> HashSet<String> {
    let mut directories = HashSet::new();
    for path in desired {
        let mut parts: Vec<&str> = path.split('/').collect();
        parts.pop();
        let mut current = String::new();
        for part in parts {
            current = if current.is_empty() {
                part.to_string()
            } else {
                format!("{current}/{part}")
            };
            directories.insert(current.clone());
        }
    }
    directories
}

/// Remove files and directories the state does not contain.
fn remove_stale_paths(
    dir: &Path,
    rel_dir: &str,
    desired: &HashSet<String>,
    desired_directories: &HashSet<String>,
    preserve: &HashSet<String>,
) -> Result<(), String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel_path = if rel_dir.is_empty() {
            name.clone()
        } else {
            format!("{rel_dir}/{name}")
        };
        if rel_dir.is_empty() && preserve.contains(&name) {
            continue;
        }
        let full = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if file_type.is_dir() && !file_type.is_symlink() {
            if desired_directories.contains(&rel_path) {
                remove_stale_paths(&full, &rel_path, desired, desired_directories, preserve)?;
            } else {
                // A failed removal must surface: stale content otherwise
                // survives inside the materialized tree.
                fs::remove_dir_all(&full).map_err(|e| format!("remove failed for {}: {e}", full.display()))?;
            }
        } else if !desired.contains(&rel_path) {
            fs::remove_file(&full).map_err(|e| format!("remove failed for {}: {e}", full.display()))?;
        }
    }
    Ok(())
}

/// Write one state entry onto disk.
fn write_entry_file(
    repo: &Repository,
    target: &Path,
    rel_path: &str,
    mode: u32,
    oid: Oid,
) -> Result<(), String> {
    let full = target.join(rel_path);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }
    if mode == 0o120000 {
        let blob = repo
            .find_blob(oid)
            .map_err(|e| format!("missing blob {oid}: {e}"))?;
        let target_text = String::from_utf8(blob.content().to_vec())
            .map_err(|e| format!("symlink blob is not valid UTF-8: {e}"))?;
        let current = read_link_target(&full);
        if current.as_deref() != Some(target_text.as_str()) {
            fs::remove_file(&full).ok();
            fs::remove_dir_all(&full).ok();
            symlink(&target_text, &full).map_err(|e| format!("symlink failed: {e}"))?;
        }
        return Ok(());
    }
    let blob = repo
        .find_blob(oid)
        .map_err(|e| format!("missing blob {oid} while materializing {rel_path}: {e}"))?;
    if let Ok(metadata) = fs::symlink_metadata(&full)
        && !metadata.file_type().is_file()
    {
        fs::remove_dir_all(&full).ok();
        fs::remove_file(&full).ok();
    }
    let file_mode = if mode == 0o100755 { 0o755 } else { 0o644 };
    fs::write(&full, blob.content()).map_err(|e| format!("write failed: {e}"))?;
    fs::set_permissions(&full, fs::Permissions::from_mode(file_mode))
        .map_err(|e| format!("chmod failed: {e}"))?;
    Ok(())
}

fn read_link_target(path: &Path) -> Option<String> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_symlink() {
        return None;
    }
    fs::read_link(path)
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

/// Materialize a captured state into a directory.
fn materialize_state(
    repo: &Repository,
    state_commit: &str,
    target: &Path,
    preserve_top: &[String],
) -> Result<(), String> {
    let flat = state_entries(repo, state_commit)?;
    fs::create_dir_all(target).map_err(|e| e.to_string())?;
    let desired: HashSet<String> = flat.keys().cloned().collect();
    let dirs = desired_directories(&desired);
    let mut preserve: HashSet<String> = HashSet::from([".git".to_string()]);
    preserve.extend(preserve_top.iter().cloned());
    remove_stale_paths(target, "", &desired, &dirs, &preserve)?;
    for (rel_path, (mode, oid)) in &flat {
        write_entry_file(repo, target, rel_path, *mode, *oid)?;
    }
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

fn op_apply_state(req: &Value) -> Result<Value, String> {
    let store_dir = PathBuf::from(s(req, "storeDir")?);
    let state_commit = s(req, "stateId")?;
    let target = PathBuf::from(s(req, "targetDir")?);
    let preserve_top: Vec<String> = req
        .get("preserveTopLevel")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let repo = open_store(&store_dir, req)?;
    let flat = state_entries(&repo, &state_commit)?;
    materialize_state(&repo, &state_commit, &target, &preserve_top)?;

    let candidate = open_repo(&target)?;
    stage_workdir(&candidate, &flat)?;
    commit_index_if_changed(&candidate, "termina state")?;
    Ok(json!({}))
}

fn op_template(req: &Value) -> Result<Value, String> {
    let store_dir = PathBuf::from(s(req, "storeDir")?);
    let source_git_dir = PathBuf::from(s(req, "sourceGitDir")?);
    let state_commit = s(req, "stateId")?;
    let target = PathBuf::from(s(req, "targetDir")?);
    let source_objects_dir = PathBuf::from(s(req, "sourceObjectsDir")?);

    let store = open_store(&store_dir, req)?;
    // An independent local repository with read-only object access. Use the
    // store's object format: the alternates point at sha256 objects when the
    // source uses them.
    let mut init_opts = RepositoryInitOptions::new();
    init_opts.object_format(store.object_format());
    let template = Repository::init_opts(&target, &init_opts).map_err(|e| e.to_string())?;
    let alternates = target
        .join(".git")
        .join("objects")
        .join("info")
        .join("alternates");
    if let Some(parent) = alternates.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let store_objects = store_dir.join("git").join("objects");
    fs::write(
        &alternates,
        format!(
            "{}\n{}\n",
            store_objects.display(),
            source_git_dir.join("objects").display()
        ),
    )
    .map_err(|e| e.to_string())?;

    materialize_state(&store, &state_commit, &target, &[])?;

    let mut index = template.index().map_err(|e| e.to_string())?;
    index
        .add_all(&[] as &[&str], IndexAddOption::DEFAULT, None)
        .map_err(|e| format!("git add failed: {e}"))?;
    index.write().map_err(|e| e.to_string())?;
    let commit = commit_index_if_changed(&template, "termina base")?
        .ok_or("template commit was not written")?;

    // Pull the store objects into a local pack, then drop the store
    // alternate. The template then needs only the read-only source objects.
    let mut packbuilder = template.packbuilder().map_err(|e| e.to_string())?;
    packbuilder
        .insert_commit(commit)
        .map_err(|e| e.to_string())?;
    let pack_dir = template.path().join("objects").join("pack");
    fs::create_dir_all(&pack_dir).map_err(|e| e.to_string())?;
    // The packbuilder writes the pack and index into the pack directory.
    packbuilder
        .write(&pack_dir, 0o644)
        .map_err(|e| format!("repack failed: {e}"))?;
    fs::write(&alternates, format!("{}\n", source_objects_dir.display()))
        .map_err(|e| e.to_string())?;

    Ok(json!({}))
}

/// Open the bare store repository and validate the object format.
fn open_store(store_dir: &Path, req: &Value) -> Result<Repository, String> {
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
    Ok(repo)
}

/// Look up one path in a tree by walking its components. O(depth).
fn tree_lookup(repo: &Repository, tree_oid: Oid, rel: &str) -> Result<Option<FlatEntry>, String> {
    let parts: Vec<&str> = rel.split('/').collect();
    let mut current = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;
    for (i, part) in parts.iter().enumerate() {
        let found = {
            let entry = match current.get_name(part) {
                Some(entry) => entry,
                None => return Ok(None),
            };
            (entry.id(), entry.filemode() as u32)
        };
        if i == parts.len() - 1 {
            return Ok(Some((found.1, found.0)));
        }
        current = repo.find_tree(found.0).map_err(|e| e.to_string())?;
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
        let refs = repo
            .references_glob(glob)
            .map_err(|e| e.to_string())?;
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
    Ok(json!({}))
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
    if config_has_driver(&config, "diff", "command") || config_has_driver(&config, "diff", "textconv")
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
    let store = open_store(&PathBuf::from(s(req, "storeDir")?), req)?;
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
    let mut index = store
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
    let tree = index
        .write_tree_to(&store)
        .map_err(|e| format!("merge write-tree failed: {e}"))?;
    // Pin the merged tree: a concurrent unref prune must not delete it
    // before the caller materializes it. Store-create clears these refs
    // with the next session.
    store
        .reference(&format!("refs/termina/merge/{tree}"), tree, true, "")
        .map_err(|e| format!("merge pin failed: {e}"))?;
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
    let store = open_store(&PathBuf::from(s(req, "storeDir")?), req)?;
    let state_commit = s(req, "stateId")?;
    let target = PathBuf::from(s(req, "targetDir")?);
    let preserve_top: Vec<String> = req
        .get("preserveTopLevel")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    materialize_state(&store, &state_commit, &target, &preserve_top)?;
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
    let target = match tree_lookup(&store, tree, &rel)? {
        Some((0o120000, oid)) => {
            let blob = store.find_blob(oid).map_err(|e| e.to_string())?;
            Some(
                String::from_utf8(blob.content().to_vec())
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
    let content = match tree_lookup(&store, tree, &rel)? {
        Some((_, oid)) => {
            let blob = store.find_blob(oid).map_err(|e| e.to_string())?;
            if blob.content().len() as u64 > BUDGET_MAX_FILE_BYTES {
                return Err(format!(
                    "blob exceeds the {BUDGET_MAX_FILE_BYTES} byte read budget: {rel}"
                ));
            }
            Some(base64::engine::general_purpose::STANDARD.encode(blob.content()))
        }
        None => None,
    };
    Ok(json!({ "content": content }))
}

fn op_unref(req: &Value) -> Result<Value, String> {
    let store = open_store(&PathBuf::from(s(req, "storeDir")?), req)?;
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
    while let Some((current_oid, current_prefix)) = stack.pop() {
        let current = repo.find_tree(current_oid).map_err(|e| e.to_string())?;
        for entry in current.iter() {
            let name = entry.name().map_err(|e| e.to_string())?;
            let path = if current_prefix.is_empty() {
                name.to_string()
            } else {
                format!("{current_prefix}/{name}")
            };
            match entry.kind() {
                Some(git2::ObjectType::Tree) => stack.push((entry.id(), path)),
                Some(git2::ObjectType::Blob) => {
                    let size = repo
                        .find_blob(entry.id())
                        .map(|blob| blob.size())
                        .unwrap_or(0);
                    out.push(json!({ "path": path, "mode": format!("{:o}", entry.filemode()), "size": size }));
                }
                _ => {}
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
    let content = match tree_lookup(&repo, tree.id(), &rel)? {
        Some((_, oid)) => {
            let blob = repo.find_blob(oid).map_err(|e| e.to_string())?;
            if blob.content().len() as u64 > BUDGET_MAX_FILE_BYTES {
                return Err(format!(
                    "blob exceeds the {BUDGET_MAX_FILE_BYTES} byte read budget: {rel}"
                ));
            }
            Some(base64::engine::general_purpose::STANDARD.encode(blob.content()))
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

fn dispatch(op: &str, req: &Value) -> Result<Value, String> {
    match op {
        "capture" => op_capture(req),
        "capture-incremental" => op_capture_incremental(req),
        "apply-state" => op_apply_state(req),
        "template" => op_template(req),
        "trust-hashes" => op_trust_hashes(req),
        "store-create" => op_store_create(req),
        "preflight" => op_preflight(req),
        "merge3" => op_merge3(req),
        "diff-tree" => op_diff_tree(req),
        "materialize" => op_materialize(req),
        "tree-paths" => op_tree_paths(req),
        "symlink-target" => op_symlink_target(req),
        "read-blob" => op_read_blob(req),
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
                eprintln!("[core] {op} failed: {error}");
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
