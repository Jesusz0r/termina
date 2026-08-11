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
use std::io::{BufRead, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use git2::{
    ErrorCode, IndexAddOption, IndexEntry, ObjectFormat, Oid, Repository, RepositoryInitOptions,
    Signature, StatusOptions,
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

/// The hash of a blob object for the store's object format.
fn blob_oid(repo: &Repository, bytes: &[u8]) -> Oid {
    let header = format!("blob {}\0", bytes.len()).into_bytes();
    let digest = match repo.object_format() {
        ObjectFormat::Sha1 => {
            let mut hasher = Sha1::new();
            hasher.update(&header);
            hasher.update(bytes);
            hasher.finalize().to_vec()
        }
        ObjectFormat::Sha256 => {
            let mut hasher = Sha256::new();
            hasher.update(&header);
            hasher.update(bytes);
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

/// Write a blob into the store when it is new. The loose-path check ignores
/// the source alternate, so the store keeps its own copy of every captured
/// blob. Returns (oid, new bytes).
fn write_blob(repo: &Repository, bytes: &[u8]) -> Result<(Oid, u64), String> {
    let oid = blob_oid(repo, bytes);
    let loose = loose_path(repo, oid).ok_or("oid length does not match the object format")?;
    if loose.exists() {
        return Ok((oid, 0));
    }
    // The loose format is zlib(header + bytes); the oid is the hash of
    // header + bytes. Write it directly; the bytes match Git's format.
    let header = format!("blob {}\0", bytes.len()).into_bytes();
    use std::io::Write as _;
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder
        .write_all(&header)
        .and_then(|_| encoder.write_all(bytes))
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
    Ok((oid, bytes.len() as u64))
}

/// Read a file and verify it did not change while reading.
fn read_file_verified(abs: &Path) -> Result<Vec<u8>, String> {
    let before = fs::metadata(abs).map_err(|e| format!("stat failed: {e}"))?;
    let mut file = fs::File::open(abs).map_err(|e| format!("open failed: {e}"))?;
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
fn write_nested_tree(repo: &Repository, root: &mut HashMap<String, Node>) -> Result<Oid, String> {
    let mut builder = repo.treebuilder(None).map_err(|e| e.to_string())?;
    let names: Vec<String> = root.keys().cloned().collect();
    for name in names {
        match root.remove(&name) {
            Some(Node::Blob { oid, mode }) => {
                builder
                    .insert(&name, oid, mode as i32)
                    .map_err(|e| format!("tree insert failed: {e}"))?;
            }
            Some(Node::Dir(mut sub)) => {
                let sub_oid = write_nested_tree(repo, &mut sub)?;
                builder
                    .insert(&name, sub_oid, 0o40000)
                    .map_err(|e| format!("tree insert failed: {e}"))?;
            }
            None => {}
        }
    }
    builder
        .write()
        .map_err(|e| format!("tree write failed: {e}"))
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

fn collect_tree_map_at(
    repo: &Repository,
    tree_oid: Oid,
    prefix: &str,
    out: &mut HashMap<String, FlatEntry>,
) -> Result<(), String> {
    let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;
    for entry in tree.iter() {
        let name = entry.name().map_err(|e| e.to_string())?;
        let path = if prefix.is_empty() {
            name.to_string()
        } else {
            format!("{prefix}/{name}")
        };
        match entry.kind() {
            Some(git2::ObjectType::Tree) => collect_tree_map_at(repo, entry.id(), &path, out)?,
            _ => {
                out.insert(path, (entry.filemode() as u32, entry.id()));
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
/// --exclude-standard`.
fn enumerate_domain(repo: &Repository) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let mut paths = Vec::new();
    let index = repo.index().map_err(|e| e.to_string())?;
    for entry in index.iter() {
        let path = String::from_utf8_lossy(&entry.path).to_string();
        if has_git_segment(&path) {
            return Err(format!("nested repository in capture domain: {path}"));
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
            if has_git_segment(&path) {
                return Err(format!("nested repository in capture domain: {path}"));
            }
            if seen.insert(path.clone()) {
                paths.push(path);
            }
        }
    }
    Ok(paths)
}

/// Hash one working-tree path into the store. Returns None when the path
/// is gone or is a directory (a gitlink). Returns (mode, oid, new bytes).
fn hash_path(
    repo: &Repository,
    abs: &Path,
    max_file_bytes: u64,
) -> Result<Option<(u32, Oid, u64)>, String> {
    let st = match fs::symlink_metadata(abs) {
        Ok(st) => st,
        Err(_) => return Ok(None),
    };
    if st.file_type().is_symlink() {
        let target = fs::read_link(abs).map_err(|e| format!("readlink failed: {e}"))?;
        let bytes = target.to_string_lossy().into_owned().into_bytes();
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
    let bytes = read_file_verified(abs)?;
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
    let source = Repository::open(&capture_root)
        .map_err(|e| format!("open source repository failed: {e}"))?;
    let parent_oid = parent_commit
        .as_deref()
        .map(|p| oid_ext(&store, p))
        .transpose()?;

    let paths = enumerate_domain(&source)?;
    if paths.len() > max_paths {
        return Err(format!(
            "capture exceeds the {max_paths} path budget ({} paths)",
            paths.len()
        ));
    }

    let mut flat: HashMap<String, FlatEntry> = HashMap::new();
    let mut new_blob_bytes = 0u64;
    for rel_path in &paths {
        let abs = capture_root.join(rel_path);
        if let Some((mode, oid, new_bytes)) = hash_path(&store, &abs, max_file_bytes)? {
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

    Ok(json!({
        "state": {
            "commit": commit.to_string(),
            "tree": tree.to_string(),
            "head": head,
            "pathCount": paths.len(),
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
    let parent_oid = oid_ext(&store, &parent_commit)?;
    let parent_tree = resolve_tree(&store, parent_oid)?;
    let parent_flat = collect_tree_map(&store, parent_tree)?;

    // The changed set: hints plus reconciled cache entries whose blob
    // differs from the parent tree.
    let mut changed: HashSet<String> = HashSet::new();
    for hint in &hints {
        if is_safe_relative(hint) {
            changed.insert(hint.clone());
        }
    }
    for (rel_path, content) in &reconcile {
        if !is_safe_relative(rel_path) {
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
        match hash_path(&store, &abs, max_file_bytes)? {
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

    if !expected.is_empty() {
        let seen = collect_tree_map(&store, tree)?;
        verify_expected(&seen, &expected, false)?;
    }

    Ok(json!({
        "state": {
            "commit": commit.to_string(),
            "tree": tree.to_string(),
            "head": null,
            "pathCount": changed.len(),
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
                fs::remove_dir_all(&full).ok();
            }
        } else if !desired.contains(&rel_path) {
            fs::remove_file(&full).ok();
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
        let target_text = String::from_utf8_lossy(blob.content()).into_owned();
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
    let kept: Vec<IndexEntry> = index
        .iter()
        .filter(|entry| {
            let path = String::from_utf8_lossy(&entry.path).into_owned();
            state_flat.contains_key(&path)
        })
        .collect();
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

    let candidate =
        Repository::open(&target).map_err(|e| format!("open candidate repository failed: {e}"))?;
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
    // An independent local repository with read-only object access.
    let template =
        Repository::init_opts(&target, &RepositoryInitOptions::new()).map_err(|e| e.to_string())?;
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
        if *files > TRUST_MAX_FILES || *bytes > TRUST_MAX_BYTES {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
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

// ------------------------------------------------------------ dispatch -----

fn dispatch(op: &str, req: &Value) -> Result<Value, String> {
    match op {
        "capture" => op_capture(req),
        "capture-incremental" => op_capture_incremental(req),
        "apply-state" => op_apply_state(req),
        "template" => op_template(req),
        "trust-hashes" => op_trust_hashes(req),
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
            Err(_) => continue,
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
