//! Bounded Git tree walks, lookups, and state entry maps.
use std::collections::HashMap;
use std::io::Read;

use git2::{ObjectFormat, Oid, Repository};
use crate::{
    BUDGET_MAX_FILE_BYTES,
    BUDGET_MAX_PATHS,
    PROMOTION_COMPONENT_MAX_BYTES,
    PROMOTION_COPY_TREE_MAX_BYTES,
    PROMOTION_DIRECTORY_MAX_DEPTH,
    PROMOTION_DIRECTORY_MAX_NAME_BYTES,
    PROMOTION_PATH_MAX_BYTES,
};
use crate::util::{
    has_git_segment,
    is_safe_relative,
    oid_ext,
};

use super::trees::FlatEntry;

const GIT_STATE_MAX_ENTRIES: usize = BUDGET_MAX_PATHS;
const GIT_STATE_MAX_BYTES: u64 = PROMOTION_COPY_TREE_MAX_BYTES;
const GIT_STATE_MAX_WORK_BYTES: u64 = PROMOTION_DIRECTORY_MAX_NAME_BYTES;

pub(crate) struct GitTreeBudget {
    entries: usize,
    bytes: u64,
    work_bytes: u64,
}

impl GitTreeBudget {
    pub(crate) fn new() -> Self {
        Self { entries: 0, bytes: 0, work_bytes: 0 }
    }

    pub(crate) fn charge_entry(&mut self) -> Result<(), String> {
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

    pub(crate) fn charge_bytes(&mut self, amount: u64) -> Result<(), String> {
        self.bytes = self
            .bytes
            .checked_add(amount)
            .ok_or("Git state byte accounting overflow")?;
        if self.bytes > GIT_STATE_MAX_BYTES {
            return Err("Git state exceeds its byte bound".to_string());
        }
        Ok(())
    }

    pub(crate) fn charge_work(&mut self, amount: u64) -> Result<(), String> {
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

pub(crate) fn git_tree_object_bounded<'repo>(
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

pub(crate) fn git_blob_size_bounded(
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
pub(crate) fn git_blob_bytes_bounded(
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

pub(crate) fn git_tree_entry_path(prefix: &str, name: &str) -> Result<String, String> {
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
pub(crate) fn collect_tree_map(
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

/// The tree oid of a state commit.
pub(crate) fn resolve_tree(repo: &Repository, commit: Oid) -> Result<Oid, String> {
    let object = repo
        .revparse_single(&format!("{}^{{tree}}", commit))
        .map_err(|e| e.to_string())?;
    object
        .as_tree()
        .map(|t| t.id())
        .ok_or_else(|| "state is not a commit".to_string())
}

/// The flat entry map of a state commit.
pub(crate) fn state_entries(
    repo: &Repository,
    state_commit: &str,
) -> Result<HashMap<String, FlatEntry>, String> {
    let commit = oid_ext(repo, state_commit)?;
    let tree = resolve_tree(repo, commit)?;
    collect_tree_map(repo, tree)
}

#[derive(Clone, Copy)]
pub(crate) enum TreeLookupKind {
    Blob,
    Tree,
}

/// Look up one path in a tree by walking its components. O(depth).
///
/// The leaf contract is explicit because incremental tree patching resolves
/// directory entries while blob reads resolve file entries. A blob lookup
/// rejects a tree leaf; a tree lookup treats a non-tree leaf as absent so a
/// file-to-directory replacement can rebuild that subtree from scratch.
pub(crate) fn tree_lookup(
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
