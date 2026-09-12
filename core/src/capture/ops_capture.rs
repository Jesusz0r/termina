//! Full and incremental capture ops.
use std::collections::{HashMap, HashSet};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use git2::{IndexEntry, Oid, Repository, StatusOptions};
use serde_json::{Value, json};
use crate::{
    BUDGET_MAX_FILE_BYTES,
    BUDGET_MAX_NEW_BLOB_BYTES,
    BUDGET_MAX_PATHS,
};
use crate::util::{
    after_cache_hooks,
    apply_rewrite_hooks,
    before_read_hooks,
    has_git_segment,
    hash_path,
    is_safe_relative,
    now_ms,
    oid_ext,
    opt_s,
    s,
    stat_at,
};
use crate::{
    FileIdentity,
    StoreMutationLock,
    StoreObjectTransaction,
    ensure_blob_budget,
    recover_store_transaction,
    write_blob,
};

use super::binding::{AnchoredPath, BoundSourceRepository, CaptureRoot, open_store, preload_cached_blobs};
use super::trees::{FlatEntry, nested_from_flat, write_nested_tree, write_tree_delta};
use super::walk::{TreeLookupKind, collect_tree_map, resolve_tree, tree_lookup};
use super::tree_cache::{cache_tree_map, collect_tree_map_cached};
use super::refs::{commit_tree, fail_before_state_ref, pause_at_hook, update_state_ref};

/// Enumerate the capture domain: tracked files plus untracked non-ignored
/// files. Matches `git ls-files -z` plus `ls-files --others
/// --exclude-standard` run in the capture root. Repo paths are relative to
/// the working directory; the capture root can be a subdirectory, so strip
/// the working-directory prefix and keep only paths under the root.
pub(crate) fn enumerate_domain(
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
pub(crate) fn stat_cached_entry(
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

pub(crate) fn op_capture(req: &Value) -> Result<Value, String> {
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
                    Some(oid),
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

pub(crate) fn op_capture_incremental(req: &Value) -> Result<Value, String> {
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
