//! Git tree merge, materialize, read, and prune ops: three-way merge,
//! destructive state materialization, tree paths, symlink targets, bounded
//! blob reads, unref with unreachable pruning.
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use git2::{Oid, Repository};
use serde_json::{Value, json};

use crate::{
    PROMOTION_PATH_MAX_BYTES, READ_BLOB_MAX_BYTES, git_blob_bytes_bounded, has_git_segment,
    is_safe_relative, now_ms, oid_ext, open_store, s,
};
use crate::recover_store_transaction;
use crate::{StoreMutationLock, StoreObjectTransaction};
use crate::{
    materialize_state_bound, nested_from_flat, pause_at_hook, publish_transaction_ref,
    resolve_tree, state_entries, tree_lookup, write_nested_tree_for_ref, FlatEntry,
};
use crate::promote_fs::open_promotion_bound_root;
use crate::capture::TreeLookupKind;

/// many seconds.
pub(crate) const PRUNE_MIN_INTERVAL_SECS: u64 = 60;
/// the reachability walk.
pub(crate) const PRUNE_LOOSE_THRESHOLD: u64 = 20_000;

pub(crate) fn op_merge3(req: &Value) -> Result<Value, String> {
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

pub(crate) fn op_diff_tree(req: &Value) -> Result<Value, String> {
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

pub(crate) fn op_materialize(req: &Value) -> Result<Value, String> {
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

pub(crate) fn op_tree_paths(req: &Value) -> Result<Value, String> {
    let store = open_store(&PathBuf::from(s(req, "storeDir")?), req)?;
    let flat = state_entries(&store, &s(req, "stateId")?)?;
    let mut paths: Vec<&String> = flat.keys().collect();
    paths.sort();
    Ok(json!({ "paths": paths }))
}

pub(crate) fn op_symlink_target(req: &Value) -> Result<Value, String> {
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

pub(crate) fn op_read_blob(req: &Value) -> Result<Value, String> {
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

pub(crate) fn op_unref(req: &Value) -> Result<Value, String> {
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
