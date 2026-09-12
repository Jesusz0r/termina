//! Apply-state and template ops.
use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::fs;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

use git2::{IndexAddOption, IndexEntry, Oid, Repository, Signature};
use serde_json::{Value, json};
use crate::util::{
    open_at_mode,
    open_repo,
    s,
    stat_at,
    stat_file,
};
use crate::promote_fs::{
    PromotionCwd,
    open_or_create_promotion_parent,
    open_promotion_bound_root,
    promotion_bound_path_matches,
    promotion_directory_is_empty,
    promotion_set_mode,
    promotion_test_pause,
    promotion_write_all,
};
use crate::promotion_files::promotion_cleanup_same_namespace_identity;
use git2::{ErrorCode, RepositoryInitOptions};

use super::binding::open_store;
use super::trees::FlatEntry;
use super::walk::state_entries;
use super::materialize::materialize_state_bound;

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

pub(crate) fn op_apply_state(req: &Value) -> Result<Value, String> {
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

pub(crate) fn op_template(req: &Value) -> Result<Value, String> {
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
