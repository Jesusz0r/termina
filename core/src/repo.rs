//! Read-only repository inspection ops: head, topology, status, diff,
//! tree and file reads, and the ignore list.
use std::fs;
use std::path::PathBuf;

use git2::{ErrorCode, ObjectFormat, Oid, Repository, StatusOptions};
use base64::Engine as _;
use serde_json::{Value, json};

use crate::{
    GitTreeBudget,
    PROMOTION_DIRECTORY_MAX_DEPTH,
    PROMOTION_PATH_MAX_BYTES,
    READ_BLOB_MAX_BYTES,
    TreeLookupKind,
    git_blob_bytes_bounded,
    git_blob_size_bounded,
    git_tree_entry_path,
    git_tree_object_bounded,
    tree_lookup,
};
use crate::util::{
    open_repo,
    s,
};

pub(crate) fn op_git_head(req: &Value) -> Result<Value, String> {
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

pub(crate) fn op_git_top_level(req: &Value) -> Result<Value, String> {
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

pub(crate) fn op_git_common_dir(req: &Value) -> Result<Value, String> {
    let root = PathBuf::from(s(req, "root")?);
    let repo = open_repo(&root)?;
    Ok(json!({ "gitDir": repo.commondir().to_string_lossy().into_owned() }))
}

pub(crate) fn op_git_object_format(req: &Value) -> Result<Value, String> {
    let root = PathBuf::from(s(req, "root")?);
    let repo = open_repo(&root)?;
    let format = match repo.object_format() {
        ObjectFormat::Sha1 => "sha1",
        ObjectFormat::Sha256 => "sha256",
    };
    Ok(json!({ "format": format }))
}

pub(crate) fn op_ls_tracked(req: &Value) -> Result<Value, String> {
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
pub(crate) fn op_repo_status(req: &Value) -> Result<Value, String> {
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
pub(crate) fn op_repo_diff(req: &Value) -> Result<Value, String> {
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
pub(crate) fn op_repo_tree(req: &Value) -> Result<Value, String> {
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
pub(crate) fn op_repo_file(req: &Value) -> Result<Value, String> {
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
pub(crate) fn op_ls_ignored(req: &Value) -> Result<Value, String> {
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
