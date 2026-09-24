//! Apply-state and template ops.
use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::fs;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

use crate::promote_fs::{
    PromotionCwd, open_or_create_promotion_parent, open_promotion_bound_root,
    promotion_bound_path_matches, promotion_directory_is_empty, promotion_set_mode,
    promotion_test_pause, promotion_write_all,
};
use crate::promotion_files::promotion_cleanup_same_namespace_identity;
use crate::util::{open_at_mode, s, stat_at, stat_file};
use git2::{ErrorCode, RepositoryInitOptions, RepositoryOpenFlags};
use git2::{Oid, Repository, Signature};
use serde_json::{Value, json};

use super::binding::open_store;
use super::materialize::materialize_state_bound;
use super::trees::FlatEntry;
use super::walk::state_entries;

/// Commit the staged index when it differs from HEAD. Returns the commit
/// oid when a commit was written.
fn commit_index_if_changed(repo: &Repository, message: &str) -> Result<Option<Oid>, String> {
    let mut index = repo.index().map_err(|e| e.to_string())?;
    let tree = index
        .write_tree_to(repo)
        .map_err(|e| format!("write-tree failed: {e}"))?;
    let head = match repo.head() {
        Ok(head) => Some(head),
        Err(e) if e.code() == ErrorCode::UnbornBranch || e.code() == ErrorCode::NotFound => None,
        Err(e) => return Err(format!("git head failed: {e}")),
    };
    let head_tree = match &head {
        Some(head) => Some(
            head.peel_to_tree()
                .map_err(|e| format!("HEAD tree is unreadable: {e}"))?
                .id(),
        ),
        None => None,
    };
    if head_tree == Some(tree) {
        return Ok(None);
    }
    let parent = match &head {
        Some(head) => Some(
            head.peel_to_commit()
                .map_err(|e| format!("HEAD commit is unreadable: {e}"))?,
        ),
        None => None,
    };
    let parent_refs: Vec<&git2::Commit> = parent.iter().collect();
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

/// Stage exactly the materialized snapshot. An explicit path is staged even
/// when ignored; preserved runtime paths and deleted entries remain excluded.
fn stage_workdir(repo: &Repository, state_flat: &HashMap<String, FlatEntry>) -> Result<(), String> {
    let mut index = repo.index().map_err(|e| e.to_string())?;
    index.clear().map_err(|e| e.to_string())?;
    for path in state_flat.keys() {
        index
            .add_path(Path::new(path))
            .map_err(|e| format!("stage snapshot path {path} failed: {e}"))?;
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
        libc::O_WRONLY
            | libc::O_CREAT
            | libc::O_TRUNC
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | libc::O_CLOEXEC,
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
        // The cwd is held by the target descriptor. Do not resolve the public
        // pathname again or search ancestors for a different repository.
        let candidate =
            Repository::open_ext(Path::new("."), RepositoryOpenFlags::NO_SEARCH, None::<&str>)
                .map_err(|error| format!("open apply-state repository failed: {error}"))?;
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

        // Invariant: Git layout names are compile-time literals (no NUL).
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

        stage_workdir(&template, &state_entries(&store, &state_commit)?)?;
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

#[cfg(test)]
mod tests {
    use super::commit_index_if_changed;
    use git2::Repository;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    struct RepoFixture {
        path: PathBuf,
        repo: Repository,
    }

    impl RepoFixture {
        fn new() -> Self {
            loop {
                let path = std::env::temp_dir().join(format!(
                    "termina-apply-head-{}-{}",
                    std::process::id(),
                    SEQ.fetch_add(1, Ordering::Relaxed)
                ));
                match fs::create_dir(&path) {
                    Ok(()) => {
                        let repo = Repository::init(&path).expect("init apply fixture");
                        return Self { path, repo };
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("create apply fixture: {error}"),
                }
            }
        }
    }

    impl Drop for RepoFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn stage_file(repo: &Repository, root: &Path, name: &str, bytes: &[u8]) {
        fs::write(root.join(name), bytes).expect("write worktree file");
        let mut index = repo.index().expect("index");
        index.add_path(Path::new(name)).expect("stage file");
        index.write().expect("write index");
    }

    #[test]
    fn unborn_repository_still_writes_a_root_commit() {
        let fixture = RepoFixture::new();
        stage_file(&fixture.repo, &fixture.path, "a.txt", b"hello\n");
        let oid = commit_index_if_changed(&fixture.repo, "termina state")
            .expect("unborn HEAD must still commit")
            .expect("unborn commit writes an oid");
        let commit = fixture.repo.find_commit(oid).expect("find unborn commit");
        assert_eq!(commit.parent_count(), 0);
    }

    #[test]
    fn corrupt_head_is_not_treated_as_unborn() {
        let fixture = RepoFixture::new();
        stage_file(&fixture.repo, &fixture.path, "a.txt", b"hello\n");
        commit_index_if_changed(&fixture.repo, "termina state")
            .expect("seed commit")
            .expect("seed oid");
        let blob = fixture.repo.blob(b"not a commit").expect("blob");
        fs::write(fixture.path.join(".git").join("HEAD"), format!("{blob}\n"))
            .expect("point HEAD at a blob");
        let repo = Repository::open(&fixture.path).expect("reopen after HEAD rewrite");
        stage_file(&repo, &fixture.path, "a.txt", b"changed\n");
        let err = commit_index_if_changed(&repo, "termina state")
            .expect_err("corrupt HEAD must fail closed");
        assert!(
            err.contains("HEAD tree is unreadable") || err.contains("HEAD commit is unreadable"),
            "expected unreadable HEAD, got {err}"
        );
    }
}
