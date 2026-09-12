//! Nested-tree assembly, delta writes, and flat/nested conversions.
use std::collections::{HashMap, HashSet};

use git2::{Oid, Repository};
use crate::util::object_oid;
use crate::{
    StoreObjectTransaction,
    write_transaction_object,
    write_transaction_object_with_oid,
};

use super::walk::{TreeLookupKind, tree_lookup};

/// One entry of the flat tree representation.
pub(crate) type FlatEntry = (u32, Oid);

/// A nested tree node: a blob or a directory.
pub(crate) enum Node {
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
pub(crate) struct TreeEntry {
    mode: u32,
    name: String,
    oid: Oid,
}

pub(crate) fn write_nested_tree(
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
pub(crate) fn write_nested_tree_for_ref(
    transaction: &mut StoreObjectTransaction,
    repo: &Repository,
    root: &mut HashMap<String, Node>,
    ref_namespace: &str,
) -> Result<Oid, String> {
    let entries = build_tree_entries(transaction, repo, root)?;
    let content = tree_object_content(&entries);
    let oid = object_oid(repo, "tree", &content);
    let written = write_transaction_object_with_oid(transaction, repo, "tree", &content, oid)?.0;
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
pub(crate) fn write_tree_delta(
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
    // Index the changed directory paths once.  The recursive writer only
    // needs direct child directories for the current level; rescanning every
    // `per_dir` key at every level turns a large sparse delta into O(D^2)
    // work.
    let mut child_dirs: HashMap<String, Vec<String>> = HashMap::new();
    for dir in per_dir.keys() {
        if dir.is_empty() {
            continue;
        }
        let (parent, child) = match dir.rsplit_once('/') {
            Some((parent, child)) => (parent, child),
            None => ("", dir.as_str()),
        };
        child_dirs
            .entry(parent.to_string())
            .or_default()
            .push(child.to_string());
    }
    for children in child_dirs.values_mut() {
        children.sort_unstable();
        children.dedup();
    }
    write_dir_delta(transaction, repo, parent_tree, "", &per_dir, &child_dirs)
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
    child_dirs: &HashMap<String, Vec<String>>,
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
    for child in child_dirs.get(dir_rel).into_iter().flatten() {
        let child_oid = write_dir_delta(
            transaction,
            repo,
            parent_root,
            &format!("{prefix}{child}"),
            per_dir,
            child_dirs,
        )?;
        entries.retain(|e| e.name != child.as_str());
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
pub(crate) fn build_tree_entries(
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
fn compare_git_entry_names(left: &TreeEntry, right: &TreeEntry) -> std::cmp::Ordering {
    let left_name = left.name.as_bytes();
    let right_name = right.name.as_bytes();
    let common = left_name.len().min(right_name.len());
    for index in 0..common {
        let ordering = left_name[index].cmp(&right_name[index]);
        if ordering != std::cmp::Ordering::Equal {
            return ordering;
        }
    }
    let left_tail = left_name
        .get(common)
        .copied()
        .or_else(|| (left.mode == 0o040000).then_some(b'/'));
    let right_tail = right_name
        .get(common)
        .copied()
        .or_else(|| (right.mode == 0o040000).then_some(b'/'));
    match (left_tail, right_tail) {
        (None, None) => std::cmp::Ordering::Equal,
        (None, Some(_)) => std::cmp::Ordering::Less,
        (Some(_), None) => std::cmp::Ordering::Greater,
        (Some(left_byte), Some(right_byte)) => left_byte.cmp(&right_byte),
    }
}

fn sort_git_entries(entries: &mut [TreeEntry]) {
    entries.sort_by(compare_git_entry_names);
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

pub(crate) fn nested_from_flat(flat: &HashMap<String, FlatEntry>) -> Result<HashMap<String, Node>, String> {
    let mut nested = HashMap::new();
    for (path, (mode, oid)) in flat {
        insert_node(&mut nested, path, *oid, *mode)?;
    }
    Ok(nested)
}
