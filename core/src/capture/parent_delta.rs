//! Parent capture via one status comparison.
//!
//! The indexed snapshot is the baseline. Run start must not walk and rehash
//! the repository again. Git status plus the index blob ids name the delta;
//! a dirty-file stat cache skips bytes that are still the snapshot.

use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use git2::{IndexEntry, Oid, Repository, StatusOptions};
use serde_json::{Value, json};

use crate::test_hooks::pause_at_hook;
use crate::util::{has_git_segment, is_safe_relative, now_ms, oid_ext};
use crate::{FileIdentity, StoreObjectTransaction, TREE_MAP_CACHE_SIZE, write_blob};

use super::binding::{BoundSourceRepository, CaptureRoot, preload_cached_blobs};
use super::hash::hash_path;
use super::ops_capture::stat_cached_entry;
use super::refs::{commit_tree, fail_before_state_ref, update_state_ref};
use super::tree_cache::cache_tree_map;
use super::trees::{FlatEntry, delta_directories, write_nested_tree, write_tree_delta};
use super::walk::{TreeLookupKind, tree_lookup};

const CACHE_FILE: &str = "capture-stat-cache";
const FILE_MODE: u32 = 0o100644;
const EXEC_MODE: u32 = 0o100755;
const LINK_MODE: u32 = 0o120000;
/// Index flags that make Git status skip the worktree comparison.
const ASSUME_VALID: u16 = 0x8000;
const SKIP_WORKTREE: u16 = 0x4000;

#[derive(Clone)]
struct CacheEntry {
    identity: FileIdentity,
    git_mode: u32,
    oid: Oid,
    recorded_at: (i64, i64),
}

enum Plan {
    Hash,
    Delete,
}

pub(crate) struct ParentDelta<'a> {
    pub(crate) req: &'a Value,
    pub(crate) store_dir: &'a Path,
    pub(crate) store: &'a Repository,
    pub(crate) source: &'a BoundSourceRepository,
    pub(crate) capture_fs: &'a CaptureRoot,
    pub(crate) head: &'a Option<String>,
    pub(crate) parent_commit_value: &'a Option<String>,
    pub(crate) parent_commit: &'a str,
    pub(crate) parent_tree: Oid,
    pub(crate) parent_map: &'a HashMap<String, FlatEntry>,
    pub(crate) parents: &'a [git2::Commit<'a>],
    pub(crate) max_paths: usize,
    pub(crate) max_file_bytes: u64,
    pub(crate) max_new_blob_bytes: u64,
}

pub(crate) fn try_parent_status_delta(input: ParentDelta<'_>) -> Result<Value, String> {
    let ParentDelta {
        req,
        store_dir,
        store,
        source,
        capture_fs,
        head,
        parent_commit_value,
        parent_commit,
        parent_tree,
        parent_map,
        parents,
        max_paths,
        max_file_bytes,
        max_new_blob_bytes,
    } = input;
    source.verify(capture_fs)?;
    let cache = load_cache(store_dir, store, parent_commit);
    let prefix = source.capture_prefix.as_deref();
    let (index, conflicted, unverified) = read_index(&source.repo, prefix)?;
    let (plan, untracked) = read_status(&source.repo, prefix, &conflicted)?;
    source.verify(capture_fs)?;

    let mut seen = HashSet::new();
    let mut hashes = Vec::new();
    let mut deletes = Vec::new();
    let mut index_blobs = Vec::new();
    let mut kept: HashMap<String, CacheEntry> = HashMap::new();
    for (path, action) in plan {
        seen.insert(path.clone());
        match action {
            Plan::Delete => deletes.push(path),
            Plan::Hash => match cache_hit(capture_fs, parent_map, &cache, &path)? {
                Some(entry) => {
                    kept.insert(path, entry);
                }
                None => hashes.push(path),
            },
        }
    }
    // A snapshot path that the index and untracked status no longer admit
    // is gone or now ignored.
    for path in parent_map.keys() {
        if index.contains_key(path)
            || untracked.contains(path)
            || seen.contains(path)
            || kept.contains_key(path)
        {
            continue;
        }
        seen.insert(path.clone());
        deletes.push(path.clone());
    }
    // A clean worktree matches the index. Compare ids so a checkout or
    // `git add` still moves the snapshot without hashing those files.
    // Status never compared assume-unchanged or skip-worktree entries, so
    // those always go through the stat check below.
    for (path, entry) in &index {
        if seen.contains(path) || kept.contains_key(path) {
            continue;
        }
        let mode = entry.mode;
        if !is_file_mode(mode) {
            if parent_map.contains_key(path) {
                deletes.push(path.clone());
            }
            continue;
        }
        match parent_map.get(path) {
            Some((parent_mode, parent_oid))
                if *parent_mode == mode
                    && *parent_oid == entry.id
                    && !unverified.contains(path) => {}
            _ => index_blobs.push((path.clone(), mode, entry.id)),
        }
    }

    if hashes.is_empty() && deletes.is_empty() && index_blobs.is_empty() {
        source.verify(capture_fs)?;
        save_cache(store_dir, store, parent_commit, &kept);
        return Ok(reused_parent_state(
            parent_commit,
            parent_tree,
            head,
            parent_map.len(),
        ));
    }

    let mut flat = parent_map.clone();
    for path in &deletes {
        flat.remove(path);
    }
    let index_write = source.index_write_time()?;
    let mut accepted: Vec<(String, u32, Oid)> = Vec::new();
    for (path, mode, oid) in index_blobs {
        // Like the full walk, a domain path absent from disk is not captured.
        let Some(anchored) = capture_fs.resolve(&path)? else {
            flat.remove(&path);
            continue;
        };
        let Some(entry) = index.get(&path) else {
            hashes.push(path);
            continue;
        };
        match stat_cached_entry(anchored.identity, entry, max_file_bytes, index_write) {
            Some((cached_mode, cached_oid)) if cached_mode == mode && cached_oid == oid => {
                if parent_map.get(&path) != Some(&(mode, oid)) {
                    accepted.push((path, mode, oid));
                }
            }
            _ => hashes.push(path),
        }
    }
    let cached_oids: HashSet<Oid> = accepted.iter().map(|(_, _, oid)| *oid).collect();
    let cached_blobs = preload_cached_blobs(source, capture_fs, &cached_oids, store)?;
    source.verify(capture_fs)?;

    let mut object_transaction = StoreObjectTransaction::new(store_dir, req);
    let mut new_blob_bytes = 0u64;
    let mut fresh: HashMap<String, CacheEntry> = HashMap::new();
    let recorded_at = now_pair();
    for (path, mode, oid) in accepted {
        let blob = cached_blobs
            .get(&oid)
            .ok_or_else(|| format!("cached source blob {oid} was not preloaded"))?;
        let cached_len = u64::try_from(blob.len())
            .map_err(|_| format!("cached source blob {oid} size does not fit u64"))?;
        if cached_len > max_file_bytes {
            return Err(format!(
                "cached source blob {oid} exceeds the {max_file_bytes} file byte budget"
            ));
        }
        let (owned_oid, new_bytes) = write_blob(
            &mut object_transaction,
            store,
            blob,
            new_blob_bytes,
            max_new_blob_bytes,
            Some(oid),
        )?;
        if owned_oid != oid {
            return Err(format!(
                "cached source blob oid mismatch: expected {oid}, wrote {owned_oid}"
            ));
        }
        new_blob_bytes = new_blob_bytes
            .checked_add(new_bytes)
            .ok_or("new-blob byte accounting overflow")?;
        flat.insert(path, (mode, owned_oid));
    }
    for path in hashes {
        let Some(anchored) = capture_fs.resolve(&path)? else {
            flat.remove(&path);
            continue;
        };
        let identity = anchored.identity;
        let captured = hash_path(
            &mut object_transaction,
            store,
            capture_fs,
            anchored,
            max_file_bytes,
            new_blob_bytes,
            max_new_blob_bytes,
            &[],
        )?;
        match captured {
            Some((mode, oid, new_bytes)) => {
                new_blob_bytes = new_blob_bytes
                    .checked_add(new_bytes)
                    .ok_or("new-blob byte accounting overflow")?;
                fresh.insert(
                    path.clone(),
                    CacheEntry {
                        identity,
                        git_mode: mode,
                        oid,
                        recorded_at,
                    },
                );
                flat.insert(path, (mode, oid));
            }
            None => {
                flat.remove(&path);
            }
        }
    }
    source.verify(capture_fs)?;
    if flat.len() > max_paths {
        return Err(format!(
            "capture exceeds the {max_paths} path budget ({} paths)",
            flat.len()
        ));
    }
    let mut next_cache = kept;
    next_cache.extend(fresh);
    if &flat == parent_map {
        save_cache(store_dir, store, parent_commit, &next_cache);
        return Ok(reused_parent_state(
            parent_commit,
            parent_tree,
            head,
            flat.len(),
        ));
    }
    let response = publish_parent_delta(
        req,
        &mut object_transaction,
        store,
        parent_tree,
        parent_map,
        &flat,
        parents,
        new_blob_bytes,
        head,
        parent_commit_value,
    )?;
    if let Some(commit) = response.pointer("/state/commit").and_then(Value::as_str) {
        save_cache(store_dir, store, commit, &next_cache);
    }
    Ok(response)
}

fn cache_hit(
    capture_fs: &CaptureRoot,
    parent_map: &HashMap<String, FlatEntry>,
    cache: &HashMap<String, CacheEntry>,
    path: &str,
) -> Result<Option<CacheEntry>, String> {
    let Some(entry) = cache.get(path) else {
        return Ok(None);
    };
    let Some((parent_mode, parent_oid)) = parent_map.get(path) else {
        return Ok(None);
    };
    if *parent_mode != entry.git_mode || *parent_oid != entry.oid {
        return Ok(None);
    }
    let Some(anchored) = capture_fs.resolve(path)? else {
        return Ok(None);
    };
    if anchored.identity == entry.identity && anchored.identity.mtime < entry.recorded_at {
        return Ok(Some(entry.clone()));
    }
    Ok(None)
}

fn is_file_mode(mode: u32) -> bool {
    mode == FILE_MODE || mode == EXEC_MODE || mode == LINK_MODE
}

type IndexView = (
    HashMap<String, IndexEntry>,
    HashSet<String>,
    HashSet<String>,
);

/// Stage-0 entries, conflicted paths, and entries status does not compare.
fn read_index(repo: &Repository, prefix: Option<&str>) -> Result<IndexView, String> {
    let mut index = HashMap::new();
    let mut conflicted = HashSet::new();
    let mut unverified = HashSet::new();
    let git_index = repo.index().map_err(|e| e.to_string())?;
    for entry in git_index.iter() {
        let path = require_utf8_path_bytes(entry.path.clone())?;
        let Some(path) = map_capture_path(&path, prefix) else {
            continue;
        };
        check_path(&path)?;
        if (entry.flags & 0x3000) >> 12 != 0 {
            conflicted.insert(path);
            continue;
        }
        if entry.flags & ASSUME_VALID != 0 || entry.flags_extended & SKIP_WORKTREE != 0 {
            unverified.insert(path.clone());
        }
        index.insert(path, entry);
    }
    Ok((index, conflicted, unverified))
}

fn require_utf8_path_bytes(path: Vec<u8>) -> Result<String, String> {
    String::from_utf8(path).map_err(|_| "a tracked path is not valid UTF-8".to_string())
}

fn read_status(
    repo: &Repository,
    prefix: Option<&str>,
    conflicted: &HashSet<String>,
) -> Result<(HashMap<String, Plan>, HashSet<String>), String> {
    let mut plan = HashMap::new();
    let mut untracked = HashSet::new();
    let statuses = repo
        .statuses(Some(
            &mut StatusOptions::new()
                .include_untracked(true)
                .recurse_untracked_dirs(true),
        ))
        .map_err(|e| e.to_string())?;
    for status in statuses.iter() {
        let path = status
            .path()
            .map_err(|e| format!("status path is missing: {e}"))?;
        let Some(path) = map_capture_path(path, prefix) else {
            continue;
        };
        check_path(&path)?;
        let flags = status.status();
        if flags.is_ignored() && flags.is_wt_new() {
            continue;
        }
        if conflicted.contains(&path) || flags.is_conflicted() {
            plan.insert(path, Plan::Hash);
            continue;
        }
        if flags.is_wt_deleted() {
            plan.insert(path, Plan::Delete);
            continue;
        }
        if flags.is_wt_new() {
            untracked.insert(path.clone());
            plan.insert(path, Plan::Hash);
            continue;
        }
        if flags.is_wt_modified() || flags.is_wt_typechange() || flags.is_wt_renamed() {
            plan.insert(path, Plan::Hash);
        }
    }
    Ok((plan, untracked))
}

fn map_capture_path(path: &str, prefix: Option<&str>) -> Option<String> {
    match prefix {
        Some(prefix) => path.strip_prefix(prefix).map(str::to_string),
        None => Some(path.to_string()),
    }
}

fn check_path(path: &str) -> Result<(), String> {
    if !is_safe_relative(path) || has_git_segment(path) {
        return Err(format!("unsafe capture path: {path}"));
    }
    Ok(())
}

fn caches() -> &'static Mutex<HashMap<Oid, HashMap<String, CacheEntry>>> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<Oid, HashMap<String, CacheEntry>>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_pair() -> (i64, i64) {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => (
            i64::try_from(duration.as_secs()).unwrap_or(i64::MAX),
            i64::from(duration.subsec_nanos()),
        ),
        Err(_) => (0, 0),
    }
}

fn load_cache(store_dir: &Path, store: &Repository, commit: &str) -> HashMap<String, CacheEntry> {
    let Ok(oid) = oid_ext(store, commit) else {
        return HashMap::new();
    };
    if let Some(hit) = caches()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .get(&oid)
    {
        return hit.clone();
    }
    let Some(loaded) = read_cache_file(store_dir, store, commit) else {
        return HashMap::new();
    };
    remember(oid, loaded.clone());
    loaded
}

/// Keep the in-memory stat caches bounded like the tree-map cache; the
/// store file is the durable copy.
fn remember(oid: Oid, entries: HashMap<String, CacheEntry>) {
    let mut cache = caches().lock().unwrap_or_else(|poison| poison.into_inner());
    if cache.len() >= TREE_MAP_CACHE_SIZE && !cache.contains_key(&oid) {
        if let Some(oldest) = cache.keys().next().cloned() {
            cache.remove(&oldest);
        }
    }
    cache.insert(oid, entries);
}

fn save_cache(
    store_dir: &Path,
    store: &Repository,
    commit: &str,
    entries: &HashMap<String, CacheEntry>,
) {
    if entries.is_empty() {
        return;
    }
    let Ok(oid) = oid_ext(store, commit) else {
        return;
    };
    remember(oid, entries.clone());
    let _ = write_cache_file(store_dir, commit, entries);
}

pub(crate) fn remember_dirty_stats(
    store_dir: &Path,
    store: &Repository,
    commit: &str,
    dirty: &HashMap<String, (FileIdentity, u32, Oid)>,
) {
    if dirty.is_empty() {
        return;
    }
    let recorded_at = now_pair();
    let entries = dirty
        .iter()
        .map(|(path, (identity, git_mode, oid))| {
            (
                path.clone(),
                CacheEntry {
                    identity: *identity,
                    git_mode: *git_mode,
                    oid: *oid,
                    recorded_at,
                },
            )
        })
        .collect();
    save_cache(store_dir, store, commit, &entries);
}

fn read_cache_file(
    store_dir: &Path,
    store: &Repository,
    commit: &str,
) -> Option<HashMap<String, CacheEntry>> {
    let bytes = fs::read(store_dir.join(CACHE_FILE)).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    if value.get("commit").and_then(Value::as_str) != Some(commit) {
        return None;
    }
    let listed = value.get("entries").and_then(Value::as_array)?;
    let mut entries = HashMap::new();
    for item in listed {
        let path = item.get("path").and_then(Value::as_str)?;
        if check_path(path).is_err() {
            continue;
        }
        let git_mode = u32::try_from(item.get("gitMode").and_then(Value::as_u64)?).ok()?;
        let oid = oid_ext(store, item.get("oid").and_then(Value::as_str)?).ok()?;
        let identity = FileIdentity {
            dev: item.get("dev").and_then(Value::as_u64)?,
            ino: item.get("ino").and_then(Value::as_u64)?,
            len: item.get("len").and_then(Value::as_u64)?,
            mode: u32::try_from(item.get("mode").and_then(Value::as_u64)?).ok()?,
            mtime: pair(item.get("mtime")?)?,
            ctime: pair(item.get("ctime")?)?,
        };
        let recorded_at = pair(item.get("recorded")?)?;
        entries.insert(
            path.to_string(),
            CacheEntry {
                identity,
                git_mode,
                oid,
                recorded_at,
            },
        );
    }
    Some(entries)
}

fn pair(value: &Value) -> Option<(i64, i64)> {
    let items = value.as_array()?;
    Some((items.first()?.as_i64()?, items.get(1)?.as_i64()?))
}

fn write_cache_file(
    store_dir: &Path,
    commit: &str,
    entries: &HashMap<String, CacheEntry>,
) -> Result<(), String> {
    let listed: Vec<Value> = entries
        .iter()
        .map(|(path, entry)| {
            json!({
                "path": path,
                "gitMode": entry.git_mode,
                "oid": entry.oid.to_string(),
                "dev": entry.identity.dev,
                "ino": entry.identity.ino,
                "len": entry.identity.len,
                "mode": entry.identity.mode,
                "mtime": [entry.identity.mtime.0, entry.identity.mtime.1],
                "ctime": [entry.identity.ctime.0, entry.identity.ctime.1],
                "recorded": [entry.recorded_at.0, entry.recorded_at.1],
            })
        })
        .collect();
    let body = serde_json::to_vec(&json!({ "commit": commit, "entries": listed }))
        .map_err(|e| format!("encode capture stat cache failed: {e}"))?;
    let temp = store_dir.join(format!("{CACHE_FILE}.{}.tmp", std::process::id()));
    let _ = fs::remove_file(&temp);
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(&temp)
        .map_err(|e| format!("create capture stat cache failed: {e}"))?;
    file.write_all(&body)
        .map_err(|e| format!("write capture stat cache failed: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("sync capture stat cache failed: {e}"))?;
    fs::rename(&temp, store_dir.join(CACHE_FILE))
        .map_err(|e| format!("publish capture stat cache failed: {e}"))?;
    Ok(())
}

/// Answer with the parent state when the working tree still matches it.
pub(crate) fn reused_parent_state(
    commit: &str,
    tree: Oid,
    head: &Option<String>,
    path_count: usize,
) -> Value {
    json!({
        "state": {
            "commit": commit,
            "tree": tree.to_string(),
            "head": head,
            "pathCount": path_count,
            "newBlobBytes": 0,
            "parentCommit": commit,
            "ts": now_ms(),
        }
    })
}

/// Publish a parent capture that changed only part of the tree.
pub(crate) fn publish_parent_delta(
    req: &Value,
    transaction: &mut StoreObjectTransaction,
    store: &Repository,
    parent_tree: Oid,
    parent_map: &HashMap<String, FlatEntry>,
    flat: &HashMap<String, FlatEntry>,
    parents: &[git2::Commit<'_>],
    new_blob_bytes: u64,
    head: &Option<String>,
    parent_commit: &Option<String>,
) -> Result<Value, String> {
    let mut changed_entries: HashMap<String, Option<FlatEntry>> = HashMap::new();
    let mut expected: HashMap<String, FlatEntry> = HashMap::new();
    for (path, entry) in flat {
        match parent_map.get(path) {
            Some(prev) if prev == entry => {}
            _ => {
                changed_entries.insert(path.clone(), Some(*entry));
                expected.insert(path.clone(), *entry);
            }
        }
    }
    for path in parent_map.keys() {
        if !flat.contains_key(path) {
            changed_entries.insert(path.clone(), None);
        }
    }
    let tree = match write_tree_delta(transaction, store, parent_tree, &changed_entries)? {
        Some(oid) => oid,
        None => write_nested_tree(transaction, store, &mut HashMap::new())?,
    };
    transaction.flush(store)?;
    verify_sparse_changes(store, tree, &expected, &changed_entries)?;
    if tree == parent_tree && flat != parent_map {
        return Err("capture tree does not match its flat map".to_string());
    }
    let commit = commit_tree(transaction, store, tree, parents, "termina source state")?;
    transaction.flush(store)?;
    pause_at_hook(req, "pauseBeforeStateRef")?;
    fail_before_state_ref(req)?;
    update_state_ref(transaction, store, commit, req)?;
    pause_at_hook(req, "pauseAfterStateRef")?;
    transaction.commit()?;
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

/// Verify only the changed paths of a delta tree. Untouched paths came
/// from the parent and are not walked again.
pub(crate) fn verify_sparse_changes(
    store: &Repository,
    tree: Oid,
    expected: &HashMap<String, FlatEntry>,
    changed_entries: &HashMap<String, Option<FlatEntry>>,
) -> Result<(), String> {
    for (rel_path, (exp_mode, exp_oid)) in expected {
        match tree_lookup(store, tree, rel_path, TreeLookupKind::Blob)? {
            Some((mode, oid)) if mode == *exp_mode && oid == *exp_oid => {}
            _ => return Err(format!("tree verification mismatch for {rel_path}")),
        }
    }
    // A deletion superseded by a descendant addition turned its path into a
    // directory; every other deletion must leave the path absent.
    let directories = delta_directories(changed_entries);
    for (rel_path, entry) in changed_entries {
        if entry.is_some() {
            continue;
        }
        if directories.contains(rel_path) {
            match tree_lookup(store, tree, rel_path, TreeLookupKind::Tree)? {
                Some(_) => {}
                None => return Err(format!("tree verification mismatch for {rel_path}")),
            }
            continue;
        }
        if tree_lookup(store, tree, rel_path, TreeLookupKind::Tree)?.is_some() {
            return Err(format!("tree verification mismatch for {rel_path}"));
        }
        if tree_lookup(store, tree, rel_path, TreeLookupKind::Blob)?.is_some() {
            return Err(format!("tree verification mismatch for {rel_path}"));
        }
    }
    Ok(())
}
