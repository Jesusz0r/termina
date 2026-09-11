//! Source-tree capture, incremental capture, state application, and
//! template creation: descriptor-bound reads assembled into Git state.
use std::collections::{HashMap, HashSet};
use std::ffi::{CStr, CString};
use std::fs;
use std::io::{self, Read};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use git2::{IndexAddOption, IndexEntry, ObjectFormat, Oid, Repository, Signature, StatusOptions};
use serde_json::{Value, json};
use crate::{
    BUDGET_MAX_FILE_BYTES,
    BUDGET_MAX_NEW_BLOB_BYTES,
    BUDGET_MAX_PATHS,
    PROMOTION_COMPONENT_MAX_BYTES,
    PROMOTION_COPY_TREE_MAX_BYTES,
    PROMOTION_DIRECTORY_MAX_DEPTH,
    PROMOTION_DIRECTORY_MAX_ENTRIES,
    PROMOTION_DIRECTORY_MAX_NAME_BYTES,
    PROMOTION_PATH_MAX_BYTES,
    PROMOTION_QUARANTINE_MAX_BYTES,
    PROMOTION_QUARANTINE_MAX_ENTRIES,
    TREE_MAP_CACHE_SIZE,
};
use crate::util::{
    after_cache_hooks,
    apply_rewrite_hooks,
    before_read_hooks,
    has_git_segment,
    hash_path,
    is_safe_relative,
    missing_path,
    normalize_system_alias_path,
    now_ms,
    object_format,
    object_oid,
    oid_ext,
    open_at,
    open_at_mode,
    open_absolute_directory_nofollow,
    open_relative_directory,
    open_repo,
    opt_s,
    s,
    same_directory_identity,
    stat_at,
    stat_file,
};
use crate::{
    FileIdentity, StoreMutationLock, StoreObjectTransaction, current_store_lifecycle,
    ensure_blob_budget, ensure_real_directory, lifecycle_mismatch, recover_store_transaction,
    sync_directory_nofollow, validate_store_lifecycle, write_blob, write_transaction_object,
    write_transaction_object_with_oid,
};
use crate::promote_fs::{
    PromotionCwd, PromotionDirectoryStream, PromotionIdentity, open_or_create_promotion_parent,
    open_promotion_bound_root, promotion_add_work, promotion_bound_path_matches,
    promotion_child_relative, promotion_component, promotion_directory_identity_matches,
    promotion_directory_is_empty, promotion_path_work_bytes, promotion_set_mode,
    promotion_symlink_at, promotion_test_pause, promotion_unlink_at_field, promotion_write_all,
};
use crate::promotion_files::promotion_cleanup_same_namespace_identity;

use git2::{ErrorCode, RepositoryInitOptions};


/// One capture leaf resolved beneath an already-open root. The retained
/// parent descriptor prevents later ancestor swaps from redirecting reads.
pub(crate) struct AnchoredPath {
    pub(crate) parent: fs::File,
    pub(crate) leaf: CString,
    pub(crate) rel_path: String,
    pub(crate) identity: FileIdentity,
}

pub(crate) struct CaptureRoot {
    dir: fs::File,
    display: PathBuf,
    identity: FileIdentity,
}

impl CaptureRoot {
    fn open(root: &Path) -> Result<Self, String> {
        let display = normalize_system_alias_path(root, "capture root")?;
        let dir = open_absolute_directory_nofollow(&display, "capture root")?;
        let identity = stat_file(&dir).map_err(|e| format!("fstat capture root failed: {e}"))?;
        Ok(Self {
            dir,
            display,
            identity,
        })
    }

    fn resolve(&self, rel_path: &str) -> Result<Option<AnchoredPath>, String> {
        if !is_safe_relative(rel_path) || has_git_segment(rel_path) {
            return Err(format!("unsafe capture path: {rel_path}"));
        }
        let mut parts = rel_path.split('/').peekable();
        let mut parent = self
            .dir
            .try_clone()
            .map_err(|e| format!("clone capture root failed: {e}"))?;
        while let Some(part) = parts.next() {
            let name = CString::new(part)
                .map_err(|_| format!("capture path contains a NUL byte: {rel_path}"))?;
            if parts.peek().is_none() {
                let identity = match stat_at(parent.as_raw_fd(), &name) {
                    Ok(identity) => identity,
                    Err(error) if missing_path(&error) => return Ok(None),
                    Err(error) => return Err(format!("stat failed for {rel_path}: {error}")),
                };
                return Ok(Some(AnchoredPath {
                    parent,
                    leaf: name,
                    rel_path: rel_path.to_string(),
                    identity,
                }));
            }

            let identity = match stat_at(parent.as_raw_fd(), &name) {
                Ok(identity) => identity,
                Err(error) if missing_path(&error) => return Ok(None),
                Err(error) => {
                    return Err(format!("stat failed for ancestor of {rel_path}: {error}"));
                }
            };
            if identity.is_symlink() {
                return Err(format!(
                    "ancestor symlink (symlinked-directory) while capturing {rel_path}"
                ));
            }
            if !identity.is_dir() {
                return Ok(None);
            }
            parent = match open_at(
                parent.as_raw_fd(),
                &name,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            ) {
                Ok(next) => next,
                Err(error) if missing_path(&error) => return Ok(None),
                Err(error) if error.raw_os_error() == Some(libc::ELOOP) => {
                    return Err(format!(
                        "ancestor symlink (symlinked-directory) while capturing {rel_path}"
                    ));
                }
                Err(error) => {
                    return Err(format!("open ancestor failed for {rel_path}: {error}"));
                }
            };
        }
        Err(format!("unsafe capture path: {rel_path}"))
    }

    pub(crate) fn display_path(&self, rel_path: &str) -> PathBuf {
        self.display.join(rel_path)
    }
}

/// The source repository binding used by a full capture.  libgit2 only
/// accepts pathnames, so opening a repository is not by itself a capability:
/// every path libgit2 reports is opened and checked against descriptors that
/// were established before the open.  Those descriptors stay alive until the
/// capture is complete, and all source ODB/index reads finish before the
/// descriptor-relative working-tree pass starts.
pub(crate) struct BoundSourceRepository {
    repo: Repository,
    capture_root_path: PathBuf,
    capture_root_identity: FileIdentity,
    source_git_dir_path: PathBuf,
    source_git_dir: fs::File,
    source_git_dir_identity: FileIdentity,
    workdir_path: PathBuf,
    workdir: fs::File,
    workdir_identity: FileIdentity,
    repository_git_dir_path: PathBuf,
    repository_git_dir: fs::File,
    repository_git_dir_identity: FileIdentity,
    common_git_dir_path: PathBuf,
    common_git_dir: fs::File,
    common_git_dir_identity: FileIdentity,
    objects_dir: fs::File,
    objects_dir_identity: FileIdentity,
    index: Option<fs::File>,
    index_identity: Option<FileIdentity>,
    capture_prefix: Option<String>,
}

impl BoundSourceRepository {
    fn open(
        req: &Value,
        capture_root: &CaptureRoot,
        source_git_dir_path: &Path,
        expected_format: ObjectFormat,
    ) -> Result<Self, String> {
        let source_git_dir_path =
            normalize_system_alias_path(source_git_dir_path, "source Git directory")?;
        let source_git_dir =
            open_absolute_directory_nofollow(&source_git_dir_path, "source Git directory")?;
        let source_git_dir_identity = stat_file(&source_git_dir)
            .map_err(|error| format!("fstat source Git directory failed: {error}"))?;
        pause_at_hook(req, "pauseAfterCaptureGitDirOpen")?;

        // This is the only pathname open libgit2 gets.  The root and Git
        // directory capabilities above are checked against the repository it
        // returns before any index, status, or ODB operation is allowed.
        let repo = open_repo(&capture_root.display)?;
        pause_at_hook(req, "pauseAfterSourceRepoOpen")?;
        if repo.is_bare() {
            return Err("source repository has no working directory".to_string());
        }
        if repo.object_format() != expected_format {
            return Err(
                "source repository object format does not match the snapshot store".to_string(),
            );
        }
        let workdir_path = repo
            .workdir()
            .ok_or("source repository has no working directory")?
            .to_path_buf();
        let repository_git_dir_path = repo.path().to_path_buf();
        let common_git_dir_path = repo.commondir().to_path_buf();
        let workdir =
            open_absolute_directory_nofollow(&workdir_path, "source repository worktree")?;
        let workdir_identity = stat_file(&workdir)
            .map_err(|error| format!("fstat source repository worktree failed: {error}"))?;
        let repository_git_dir = open_absolute_directory_nofollow(
            &repository_git_dir_path,
            "source repository .git directory",
        )?;
        let repository_git_dir_identity = stat_file(&repository_git_dir)
            .map_err(|error| format!("fstat source repository .git directory failed: {error}"))?;
        let common_git_dir = open_absolute_directory_nofollow(
            &common_git_dir_path,
            "source repository common Git directory",
        )?;
        let common_git_dir_identity = stat_file(&common_git_dir).map_err(|error| {
            format!("fstat source repository common Git directory failed: {error}")
        })?;
        let objects_dir = open_relative_directory(
            &common_git_dir,
            Path::new("objects"),
            "source repository object database",
        )?;
        let objects_dir_identity = stat_file(&objects_dir)
            .map_err(|error| format!("fstat source repository object database failed: {error}"))?;

        let capture_canon = fs::canonicalize(&capture_root.display).map_err(|error| {
            format!("canonicalize capture root for repository binding failed: {error}")
        })?;
        let workdir_canon = fs::canonicalize(&workdir_path)
            .map_err(|error| format!("canonicalize source repository worktree failed: {error}"))?;
        let capture_relative = capture_canon
            .strip_prefix(&workdir_canon)
            .map_err(|_| "capture root is outside the source repository worktree".to_string())?
            .to_path_buf();
        let capture_prefix = if capture_relative.as_os_str().is_empty() {
            None
        } else {
            let relative = capture_relative
                .to_str()
                .ok_or("capture root path is not valid UTF-8")?
                .replace(std::path::MAIN_SEPARATOR, "/");
            if relative.is_empty() {
                None
            } else {
                Some(format!("{relative}/"))
            }
        };
        let anchored_capture_root = open_relative_directory(
            &workdir,
            &capture_relative,
            "source repository capture root",
        )?;
        let anchored_capture_identity = stat_file(&anchored_capture_root)
            .map_err(|error| format!("fstat source repository capture root failed: {error}"))?;
        if !same_directory_identity(anchored_capture_identity, capture_root.identity) {
            return Err(
                "source repository worktree does not contain the bound capture root".to_string(),
            );
        }

        let common_canon = fs::canonicalize(&common_git_dir_path).map_err(|error| {
            format!("canonicalize source repository common Git directory failed: {error}")
        })?;
        let repository_git_canon = fs::canonicalize(&repository_git_dir_path).map_err(|error| {
            format!("canonicalize source repository .git directory failed: {error}")
        })?;
        let repository_git_relative = repository_git_canon
            .strip_prefix(&common_canon)
            .map_err(|_| {
                "source repository .git directory is outside its common Git directory".to_string()
            })?
            .to_path_buf();
        let anchored_repository_git_dir = open_relative_directory(
            &common_git_dir,
            &repository_git_relative,
            "source repository .git directory",
        )?;
        let anchored_repository_git_identity =
            stat_file(&anchored_repository_git_dir).map_err(|error| {
                format!("fstat bound source repository .git directory failed: {error}")
            })?;
        if !same_directory_identity(
            anchored_repository_git_identity,
            repository_git_dir_identity,
        ) {
            return Err(
                "source repository .git directory is not bound to its common Git directory"
                    .to_string(),
            );
        }
        if !same_directory_identity(source_git_dir_identity, common_git_dir_identity) {
            return Err("source Git directory does not match the opened repository".to_string());
        }

        let index_name = CString::new("index").expect("index has no NUL");
        let index = match open_at(
            repository_git_dir.as_raw_fd(),
            &index_name,
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        ) {
            Ok(index) => Some(index),
            Err(error) if missing_path(&error) => None,
            Err(error) => return Err(format!("open source repository index failed: {error}")),
        };
        let index_identity = index
            .as_ref()
            .map(stat_file)
            .transpose()
            .map_err(|error| format!("fstat source repository index failed: {error}"))?;

        let binding = Self {
            repo,
            capture_root_path: capture_root.display.clone(),
            capture_root_identity: capture_root.identity,
            source_git_dir_path: source_git_dir_path.to_path_buf(),
            source_git_dir,
            source_git_dir_identity,
            workdir_path,
            workdir,
            workdir_identity,
            repository_git_dir_path,
            repository_git_dir,
            repository_git_dir_identity,
            common_git_dir_path,
            common_git_dir,
            common_git_dir_identity,
            objects_dir,
            objects_dir_identity,
            index,
            index_identity,
            capture_prefix,
        };
        binding.verify(capture_root)?;
        pause_at_hook(req, "pauseAfterSourceBinding")?;
        binding.verify(capture_root)?;
        Ok(binding)
    }

    fn verify(&self, capture_root: &CaptureRoot) -> Result<(), String> {
        let capture_identity = stat_file(&capture_root.dir)
            .map_err(|error| format!("fstat bound capture root failed: {error}"))?;
        if !same_directory_identity(capture_identity, self.capture_root_identity) {
            return Err("capture root identity changed while captured".to_string());
        }
        if capture_root.display != self.capture_root_path {
            return Err("capture root pathname changed while captured".to_string());
        }
        self.verify_held_directory(
            &self.source_git_dir,
            self.source_git_dir_identity,
            "source Git directory",
        )?;
        self.verify_held_directory(
            &self.workdir,
            self.workdir_identity,
            "source repository worktree",
        )?;
        self.verify_held_directory(
            &self.repository_git_dir,
            self.repository_git_dir_identity,
            "source repository .git directory",
        )?;
        self.verify_held_directory(
            &self.common_git_dir,
            self.common_git_dir_identity,
            "source repository common Git directory",
        )?;
        self.verify_held_directory(
            &self.objects_dir,
            self.objects_dir_identity,
            "source repository object database",
        )?;
        self.verify_path_directory(
            &self.source_git_dir_path,
            self.source_git_dir_identity,
            "source Git directory",
        )?;
        self.verify_path_directory(
            &self.workdir_path,
            self.workdir_identity,
            "source repository worktree",
        )?;
        self.verify_path_directory(
            &self.repository_git_dir_path,
            self.repository_git_dir_identity,
            "source repository .git directory",
        )?;
        self.verify_path_directory(
            &self.common_git_dir_path,
            self.common_git_dir_identity,
            "source repository common Git directory",
        )?;
        let objects_path = self.common_git_dir_path.join("objects");
        self.verify_path_directory(
            &objects_path,
            self.objects_dir_identity,
            "source repository object database",
        )?;
        if let Some(index) = &self.index {
            let index_identity = stat_file(index)
                .map_err(|error| format!("fstat bound source repository index failed: {error}"))?;
            let expected = self
                .index_identity
                .ok_or("source repository index binding is incomplete")?;
            if index_identity != expected {
                return Err("source repository index changed while captured".to_string());
            }
            let index_name = CString::new("index").expect("index has no NUL");
            let current = open_at(
                self.repository_git_dir.as_raw_fd(),
                &index_name,
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|error| format!("open bound source repository index failed: {error}"))?;
            let current_identity = stat_file(&current).map_err(|error| {
                format!("fstat current source repository index failed: {error}")
            })?;
            if current_identity != expected {
                return Err("source repository index path changed while captured".to_string());
            }
        } else {
            let index_name = CString::new("index").expect("index has no NUL");
            match open_at(
                self.repository_git_dir.as_raw_fd(),
                &index_name,
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            ) {
                Ok(_) => return Err("source repository index appeared while captured".to_string()),
                Err(error) if missing_path(&error) => {}
                Err(error) => {
                    return Err(format!("inspect source repository index failed: {error}"));
                }
            }
        }
        Ok(())
    }

    fn verify_held_directory(
        &self,
        descriptor: &fs::File,
        expected: FileIdentity,
        field: &str,
    ) -> Result<(), String> {
        let observed = stat_file(descriptor)
            .map_err(|error| format!("fstat bound {field} failed: {error}"))?;
        if !same_directory_identity(observed, expected) {
            return Err(format!("bound {field} identity changed while captured"));
        }
        Ok(())
    }

    fn verify_path_directory(
        &self,
        path: &Path,
        expected: FileIdentity,
        field: &str,
    ) -> Result<(), String> {
        let descriptor = open_absolute_directory_nofollow(path, field)?;
        let observed =
            stat_file(&descriptor).map_err(|error| format!("fstat {field} failed: {error}"))?;
        if !same_directory_identity(observed, expected) {
            return Err(format!("{field} identity changed while captured"));
        }
        Ok(())
    }

    fn index_write_time(&self) -> Result<Option<SystemTime>, String> {
        self.index
            .as_ref()
            .map(|index| {
                index
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .map_err(|error| {
                        format!("inspect source repository index time failed: {error}")
                    })
            })
            .transpose()
    }
}

// ---------------------------------------------------------------- trees ----

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
fn write_tree_delta(
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
fn collect_tree_map(
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

type TreeMap = HashMap<String, FlatEntry>;
type TreeMapCache = HashMap<Oid, std::sync::Arc<TreeMap>>;

fn tree_map_cache() -> &'static Mutex<TreeMapCache> {
    static CACHE: std::sync::OnceLock<Mutex<TreeMapCache>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Cached flat map of a tree. The core process handles requests one at a
/// time, so the parent tree of the next capture is usually cached.
pub(crate) fn collect_tree_map_cached(
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

/// Create the synthetic state commit.
pub(crate) fn commit_tree(
    transaction: &mut StoreObjectTransaction,
    repo: &Repository,
    tree: Oid,
    parents: &[git2::Commit<'_>],
    message: &str,
) -> Result<Oid, String> {
    // Future callers cannot accidentally ask libgit2 to resolve a tree that
    // is still only in the private staging ledger.
    transaction.flush(repo)?;
    let signature = Signature::now("termina", "dev@termina.local").map_err(|e| e.to_string())?;
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    let tree_obj = repo.find_tree(tree).map_err(|e| e.to_string())?;
    let content = repo
        .commit_create_buffer(&signature, &signature, message, &tree_obj, &parent_refs)
        .map_err(|e| format!("commit buffer failed: {e}"))?;
    let oid = object_oid(repo, "commit", content.as_ref());
    let written = write_transaction_object_with_oid(transaction, repo, "commit", content.as_ref(), oid)?.0;
    if written != oid {
        return Err("state commit oid changed while staged".to_string());
    }
    transaction.set_intended_ref(format!("refs/termina/state/{oid}"), oid)?;
    Ok(oid)
}

pub(crate) fn exact_ref_target(repo: &Repository, name: &str) -> Option<Oid> {
    repo.find_reference(name)
        .ok()
        .and_then(|reference| reference.target())
}

pub(crate) fn validate_transaction_ref(
    repo: &Repository,
    name: &str,
    target_hex: &str,
) -> Result<Oid, String> {
    let target = oid_ext(repo, target_hex)
        .map_err(|_| format!("invalid transaction ref target: {target_hex}"))?;
    let canonical_target = target.to_string();
    let state = format!("refs/termina/state/{canonical_target}");
    let merge = format!("refs/termina/merge/{canonical_target}");
    if name != state && name != merge {
        return Err(format!("invalid transaction ref name: {name}"));
    }
    Ok(target)
}

pub(crate) fn prepare_transaction_ref_path(
    repo: &Repository,
    name: &str,
    target: Oid,
) -> Result<PathBuf, String> {
    validate_transaction_ref(repo, name, &target.to_string())?;
    let git_dir = repo.path();
    if !fs::symlink_metadata(git_dir)
        .map_err(|e| format!("inspect store git directory failed: {e}"))?
        .file_type()
        .is_dir()
    {
        return Err("store git path is not a real directory".to_string());
    }
    let refs = git_dir.join("refs");
    let termina = refs.join("termina");
    let namespace = if name.starts_with("refs/termina/state/") {
        termina.join("state")
    } else {
        termina.join("merge")
    };
    ensure_real_directory(&refs, 0o755)?;
    ensure_real_directory(&termina, 0o755)?;
    ensure_real_directory(&namespace, 0o755)?;
    Ok(git_dir.join(name))
}

/// Make an exact loose transaction ref and every ancestor directory durable,
/// then reread the direct target. Visibility before this barrier is not a
/// committed publication.
pub(crate) fn sync_exact_transaction_ref(repo: &Repository, name: &str, target: Oid) -> Result<u64, String> {
    let ref_path = prepare_transaction_ref_path(repo, name, target)?;
    if exact_ref_target(repo, name) != Some(target) {
        return Err(format!(
            "transaction ref is not visible at exact target: {name}"
        ));
    }
    let ref_file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&ref_path)
        .map_err(|e| format!("open transaction ref {} failed: {e}", ref_path.display()))?;
    if !ref_file
        .metadata()
        .map_err(|e| format!("inspect transaction ref failed: {e}"))?
        .file_type()
        .is_file()
    {
        return Err(format!(
            "transaction ref is not a regular file: {}",
            ref_path.display()
        ));
    }
    ref_file
        .sync_all()
        .map_err(|e| format!("sync transaction ref {} failed: {e}", ref_path.display()))?;

    let git_dir = repo.path();
    let mut current = ref_path
        .parent()
        .ok_or("transaction ref has no parent directory")?;
    let mut directory_count = 0u64;
    loop {
        if !current.starts_with(git_dir) {
            return Err("transaction ref escaped the store git directory".to_string());
        }
        sync_directory_nofollow(current)?;
        directory_count += 1;
        if current == git_dir {
            break;
        }
        current = current
            .parent()
            .ok_or("transaction ref directory chain is incomplete")?;
    }
    if exact_ref_target(repo, name) != Some(target) {
        return Err(format!(
            "transaction ref changed during durability sync: {name}"
        ));
    }
    Ok(directory_count)
}

/// Publish the exact transaction ref. A libgit2 error can happen after the
/// lockfile was renamed into place, so the visible ref is authoritative.
pub(crate) fn publish_transaction_ref(
    transaction: &mut StoreObjectTransaction,
    repo: &Repository,
    name: &str,
    target: Oid,
    req: &Value,
    post_write_hook: &str,
    durability_hook: &str,
    durability_error: &str,
    label: &str,
) -> Result<(), String> {
    if !transaction.pending.is_empty() {
        return Err("cannot publish a transaction ref with pending objects".to_string());
    }
    prepare_transaction_ref_path(repo, name, target)?;
    let mut publication = repo
        .reference(name, target, true, "")
        .map(|_| ())
        .map_err(|error| format!("{label} failed: {error}"));
    if publication.is_ok()
        && let Some(marker) = req
            .pointer(&format!("/hooks/{post_write_hook}/markerPath"))
            .and_then(Value::as_str)
    {
        publication = fs::write(marker, b"injected-after-ref-write")
            .map_err(|error| format!("write {post_write_hook} marker failed: {error}"))
            .and(Err(format!("injected {label} failure after write")));
    }
    match publication {
        Ok(()) => {}
        Err(_) if exact_ref_target(repo, name) == Some(target) => {}
        Err(error) => return Err(error),
    }
    if let Some(marker) = req
        .pointer(&format!("/hooks/{durability_hook}/markerPath"))
        .and_then(Value::as_str)
    {
        fs::write(marker, b"injected-before-ref-durability")
            .map_err(|error| format!("write {durability_hook} marker failed: {error}"))?;
        return Err(durability_error.to_string());
    }
    let directory_count = sync_exact_transaction_ref(repo, name, target)?;
    transaction.record_ref_sync(directory_count);
    Ok(())
}

/// Pin a state commit with a store-local ref so gc never prunes it.
pub(crate) fn update_state_ref(
    transaction: &mut StoreObjectTransaction,
    repo: &Repository,
    commit: Oid,
    req: &Value,
) -> Result<(), String> {
    publish_transaction_ref(
        transaction,
        repo,
        &format!("refs/termina/state/{commit}"),
        commit,
        req,
        "failStateRefAfterWrite",
        "failStateRefDurability",
        "injected state ref durability failure",
        "state ref update",
    )
}

pub(crate) fn fail_before_state_ref(req: &Value) -> Result<(), String> {
    if req
        .pointer("/hooks/failStateRef")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err("injected state-ref failure".to_string());
    }
    Ok(())
}

/// Deterministic cross-process test seam. The core announces that it reached
/// a publication boundary, then waits for the spike process to release it.
pub(crate) fn pause_at_hook(req: &Value, name: &str) -> Result<(), String> {
    if std::env::var_os("TERMINA_CORE_TEST").is_none() {
        return Ok(());
    }
    let Some(hook) = req.pointer(&format!("/hooks/{name}")) else {
        return Ok(());
    };
    let ready = hook
        .get("readyPath")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing {name} readyPath"))?;
    let release = hook
        .get("releasePath")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing {name} releasePath"))?;
    crate::promote_fs::promotion_absolute_path(ready, "test hook readyPath")?;
    crate::promote_fs::promotion_absolute_path(release, "test hook releasePath")?;
    crate::test_hooks::pause(ready, release, name)
}

// ------------------------------------------------------------ capture -----

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

/// Read every blob that may be supplied by the stat cache while the source
/// repository binding is still active.  The full capture never asks libgit2
/// for an object after this function returns; later source reads are all
/// descriptor-relative and therefore cannot mix an object store from a
/// replaced repository with bytes from the retained worktree descriptor.
pub(crate) fn preload_cached_blobs(
    source: &BoundSourceRepository,
    capture_root: &CaptureRoot,
    oids: &HashSet<Oid>,
    store: &Repository,
) -> Result<HashMap<Oid, Vec<u8>>, String> {
    let mut blobs = HashMap::with_capacity(oids.len());
    for oid in oids {
        source.verify(capture_root)?;
        let blob = source
            .repo
            .find_blob(*oid)
            .map_err(|error| format!("cached source blob {oid} is unavailable: {error}"))?;
        let content = blob.content().to_vec();
        source.verify(capture_root)?;
        if object_oid(store, "blob", &content) != *oid {
            return Err(format!(
                "cached source blob {oid} failed object identity verification"
            ));
        }
        blobs.insert(*oid, content);
    }
    Ok(blobs)
}

pub(crate) fn read_link_at(parent: RawFd, name: &CStr) -> io::Result<Vec<u8>> {
    let mut bytes = vec![0u8; PROMOTION_PATH_MAX_BYTES + 1];
    let len = unsafe {
        libc::readlinkat(
            parent,
            name.as_ptr(),
            bytes.as_mut_ptr().cast::<libc::c_char>(),
            bytes.len(),
        )
    };
    if len == -1 {
        return Err(io::Error::last_os_error());
    }
    let len = len as usize;
    if len > PROMOTION_PATH_MAX_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "promotion symlink target exceeds its bounded path budget",
        ));
    }
    bytes.truncate(len);
    Ok(bytes)
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

pub(crate) fn nested_from_flat(flat: &HashMap<String, FlatEntry>) -> Result<HashMap<String, Node>, String> {
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

// --------------------------------------------------------- materialize -----

/// The flat entry map of a state commit.
pub(crate) fn state_entries(
    repo: &Repository,
    state_commit: &str,
) -> Result<HashMap<String, FlatEntry>, String> {
    let commit = oid_ext(repo, state_commit)?;
    let tree = resolve_tree(repo, commit)?;
    collect_tree_map(repo, tree)
}

/// Every parent directory of the desired paths.
fn desired_directories(desired: &HashSet<String>) -> Result<HashSet<String>, String> {
    let mut directories = HashSet::new();
    let mut work_bytes = 0u64;
    for path in desired {
        if !is_safe_relative(path) || has_git_segment(path) {
            return Err(format!("unsafe materialize path: {path}"));
        }
        if path.len() > PROMOTION_PATH_MAX_BYTES {
            return Err("materialize path exceeds its bounded path budget".to_string());
        }
        let mut current = String::with_capacity(path.len());
        let mut parts = path.split('/').peekable();
        while let Some(part) = parts.next() {
            // The final component is a file/symlink leaf, not a directory.
            if parts.peek().is_none() {
                break;
            }
            if part.is_empty() || part == "." || part == ".." || part.len() > PROMOTION_COMPONENT_MAX_BYTES {
                return Err(format!("invalid materialize path component in {path}"));
            }
            if current.is_empty() {
                current.push_str(part);
            } else {
                current.push('/');
                current.push_str(part);
            }
            if current.len() > PROMOTION_PATH_MAX_BYTES {
                return Err("materialize directory path exceeds its bounded path budget".to_string());
            }
            work_bytes = work_bytes
                .checked_add(current.len() as u64)
                .ok_or("materialize directory work accounting overflow")?;
            if work_bytes > PROMOTION_DIRECTORY_MAX_NAME_BYTES {
                return Err("materialize directory work exceeds its bound".to_string());
            }
            if !directories.contains(&current) {
                if directories.len() >= PROMOTION_DIRECTORY_MAX_ENTRIES {
                    return Err("materialize contains too many directories".to_string());
                }
                directories.insert(current.clone());
            }
        }
    }
    Ok(directories)
}

/// Remove a complete stale entry through an already-open parent descriptor.
/// The recursive walk never re-resolves an ancestor by pathname.  A second
/// identity check immediately before each unlink closes the deterministic
/// replacement/type-flip seam; if a hostile writer wins the final kernel
/// interval, the operation can only remove the name in this bound parent.
fn promotion_remove_tree_entry(
    parent: RawFd,
    name: &CStr,
    expected: FileIdentity,
    req: &Value,
    relative: &str,
) -> Result<(), String> {
    let current = stat_at(parent, name)
        .map_err(|error| format!("stat stale promotion entry {relative} failed: {error}"))?;
    if !promotion_cleanup_same_namespace_identity(current, expected) {
        return Err(format!(
            "stale promotion entry {relative} changed before removal; evidence retained"
        ));
    }
    if current.is_dir() && !current.is_symlink() {
        let child = open_at(
            parent,
            name,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
        .map_err(|error| format!("open stale promotion directory {relative} failed: {error}"))?;
        let child_identity = stat_file(&child).map_err(|error| {
            format!("fstat stale promotion directory {relative} failed: {error}")
        })?;
        if !promotion_cleanup_same_namespace_identity(child_identity, current) {
            return Err(format!(
                "stale promotion directory {relative} changed while opening; evidence retained"
            ));
        }
        promotion_remove_tree_contents(&child, req, relative)?;
        let before_unlink = stat_at(parent, name).map_err(|error| {
            format!("stat stale promotion directory {relative} failed: {error}")
        })?;
        if !promotion_cleanup_same_namespace_identity(before_unlink, current) {
            return Err(format!(
                "stale promotion directory {relative} changed before removal; evidence retained"
            ));
        }
        promotion_unlink_at_field(parent, name, true, relative)?;
    } else {
        promotion_test_pause(req, "promotion-materialize-leaf-validated")?;
        let before_unlink = stat_at(parent, name)
            .map_err(|error| format!("stat stale promotion entry {relative} failed: {error}"))?;
        if !promotion_cleanup_same_namespace_identity(before_unlink, current) {
            return Err(format!(
                "stale promotion entry {relative} changed before removal; evidence retained"
            ));
        }
        promotion_unlink_at_field(parent, name, false, relative)?;
    }
    Ok(())
}

pub(crate) fn promotion_remove_tree_contents(
    directory: &fs::File,
    req: &Value,
    relative: &str,
) -> Result<(), String> {
    struct RemoveFrame {
        directory: fs::File,
        stream: PromotionDirectoryStream,
        relative: String,
        parent_name: Option<CString>,
        identity: Option<FileIdentity>,
    }
    let mut stack = Vec::with_capacity(PROMOTION_DIRECTORY_MAX_DEPTH);
    stack.push(RemoveFrame {
        directory: directory.try_clone().map_err(|error| format!("clone stale promotion directory failed: {error}"))?,
        stream: PromotionDirectoryStream::open(directory.as_raw_fd())?,
        relative: relative.to_string(),
        parent_name: None,
        identity: None,
    });
    let mut entries = 0usize;
    let mut bytes = 0u64;
    let mut work_bytes = u64::try_from(relative.len())
        .map_err(|_| "stale promotion work accounting overflow")?;
    promotion_add_work(
        &mut work_bytes,
        std::mem::size_of::<FileIdentity>() as u64,
        PROMOTION_DIRECTORY_MAX_NAME_BYTES,
        "stale promotion tree",
    )?;
    while !stack.is_empty() {
        let next = stack
            .last_mut()
            .expect("stale removal stack is not empty")
            .stream
            .next_entry()?;
        let Some((name, c_name)) = next else {
            let frame = stack.pop().expect("stale removal frame exists");
            if let (Some(parent_name), Some(identity)) =
                (frame.parent_name.as_ref(), frame.identity)
            {
                let parent = stack
                    .last()
                    .ok_or("stale removal parent frame is missing")?;
                let before_unlink = stat_at(parent.directory.as_raw_fd(), parent_name).map_err(|error| {
                    format!("stat stale promotion directory {} failed: {error}", frame.relative)
                })?;
                if !promotion_cleanup_same_namespace_identity(before_unlink, identity) {
                    return Err(format!(
                        "stale promotion directory {} changed before removal; evidence retained",
                        frame.relative
                    ));
                }
                promotion_unlink_at_field(
                    parent.directory.as_raw_fd(),
                    parent_name,
                    true,
                    &frame.relative,
                )?;
            }
            continue;
        };
        entries = entries
            .checked_add(1)
            .ok_or("stale promotion entry count overflow")?;
        if entries > PROMOTION_QUARANTINE_MAX_ENTRIES {
            return Err("stale promotion tree exceeds its entry bound; evidence retained".to_string());
        }
        let current_relative = stack.last().expect("stale removal frame exists").relative.clone();
        let path_work = promotion_path_work_bytes(&current_relative, &name)?;
        promotion_add_work(
            &mut work_bytes,
            path_work,
            PROMOTION_DIRECTORY_MAX_NAME_BYTES,
            "stale promotion tree",
        )?;
        let child_relative = promotion_child_relative(&current_relative, &name)?;
        let directory_fd = stack.last().expect("stale removal frame exists").directory.as_raw_fd();
        let identity = match stat_at(directory_fd, &c_name) {
            Ok(identity) => identity,
            Err(error) if missing_path(&error) => continue,
            Err(error) => {
                return Err(format!(
                    "stat stale promotion entry {child_relative} failed: {error}"
                ));
            }
        };
        let logical_bytes = if identity.is_file() {
            identity.len
        } else if identity.is_symlink() {
            u64::try_from(
                read_link_at(directory_fd, &c_name)
                    .map_err(|error| format!("read stale promotion symlink {child_relative} failed: {error}"))?
                    .len(),
            )
            .map_err(|_| "stale promotion symlink byte accounting overflow")?
        } else {
            0
        };
        bytes = bytes
            .checked_add(logical_bytes)
            .ok_or("stale promotion byte accounting overflow")?;
        if bytes > PROMOTION_QUARANTINE_MAX_BYTES {
            return Err("stale promotion tree exceeds its byte bound; evidence retained".to_string());
        }
        if identity.is_dir() && !identity.is_symlink() {
            if stack.len() >= PROMOTION_DIRECTORY_MAX_DEPTH {
                return Err("stale promotion tree exceeds its depth bound; evidence retained".to_string());
            }
            let child = open_at(
                directory_fd,
                &c_name,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|error| format!("open stale promotion directory {child_relative} failed: {error}"))?;
            let child_identity = stat_file(&child).map_err(|error| {
                format!("fstat stale promotion directory {child_relative} failed: {error}")
            })?;
            if !promotion_cleanup_same_namespace_identity(child_identity, identity) {
                return Err(format!(
                    "stale promotion directory {child_relative} changed while opening; evidence retained"
                ));
            }
            let child_stream = PromotionDirectoryStream::open(child.as_raw_fd())?;
            stack.push(RemoveFrame {
                directory: child,
                stream: child_stream,
                relative: child_relative,
                parent_name: Some(c_name),
                identity: Some(identity),
            });
        } else {
            promotion_test_pause(req, "promotion-materialize-leaf-validated")?;
            let before_unlink = stat_at(directory_fd, &c_name).map_err(|error| {
                format!("stat stale promotion entry {child_relative} failed: {error}")
            })?;
            if !promotion_cleanup_same_namespace_identity(before_unlink, identity) {
                return Err(format!(
                    "stale promotion entry {child_relative} changed before removal; evidence retained"
                ));
            }
            promotion_unlink_at_field(directory_fd, &c_name, false, &child_relative)?;
        }
    }
    Ok(())
}

/// Remove stale entries while preserving `.git` and the caller's runtime
/// allowlist.  Desired directories are retained and reconciled recursively;
/// wrong-type desired ancestors are removed only after their descriptor and
/// current namespace identity have been checked.
fn promotion_remove_stale_paths(
    directory: &fs::File,
    relative: &str,
    desired: &HashSet<String>,
    desired_directories: &HashSet<String>,
    preserve: &HashSet<String>,
    req: &Value,
) -> Result<(), String> {
    struct StaleFrame {
        directory: fs::File,
        stream: PromotionDirectoryStream,
        relative: String,
    }
    let mut stack = Vec::with_capacity(PROMOTION_DIRECTORY_MAX_DEPTH);
    stack.push(StaleFrame {
        directory: directory.try_clone().map_err(|error| format!("clone promotion directory failed: {error}"))?,
        stream: PromotionDirectoryStream::open(directory.as_raw_fd())?,
        relative: relative.to_string(),
    });
    let mut entries = 0usize;
    let mut bytes = 0u64;
    let mut work_bytes = u64::try_from(relative.len())
        .map_err(|_| "promotion stale-path work accounting overflow")?;
    promotion_add_work(
        &mut work_bytes,
        std::mem::size_of::<FileIdentity>() as u64,
        PROMOTION_DIRECTORY_MAX_NAME_BYTES,
        "promotion stale-path scan",
    )?;
    while !stack.is_empty() {
        let next = stack
            .last_mut()
            .expect("stale-path stack is not empty")
            .stream
            .next_entry()?;
        let Some((name, c_name)) = next else {
            stack.pop();
            continue;
        };
        let current_relative = stack.last().expect("stale-path frame exists").relative.clone();
        if current_relative.is_empty() && preserve.contains(&name) {
            continue;
        }
        entries = entries
            .checked_add(1)
            .ok_or("promotion stale-path entry count overflow")?;
        if entries > PROMOTION_QUARANTINE_MAX_ENTRIES {
            return Err("promotion stale-path scan exceeds its entry bound".to_string());
        }
        let path_work = promotion_path_work_bytes(&current_relative, &name)?;
        promotion_add_work(
            &mut work_bytes,
            path_work,
            PROMOTION_DIRECTORY_MAX_NAME_BYTES,
            "promotion stale-path scan",
        )?;
        let child_relative = promotion_child_relative(&current_relative, &name)?;
        let directory_fd = stack.last().expect("stale-path frame exists").directory.as_raw_fd();
        let identity = match stat_at(directory_fd, &c_name) {
            Ok(identity) => identity,
            Err(error) if missing_path(&error) => continue,
            Err(error) => {
                return Err(format!(
                    "stat promotion entry {child_relative} failed: {error}"
                ));
            }
        };
        let logical_bytes = if identity.is_file() {
            identity.len
        } else if identity.is_symlink() {
            u64::try_from(
                read_link_at(directory_fd, &c_name)
                    .map_err(|error| format!("read promotion stale symlink {child_relative} failed: {error}"))?
                    .len(),
            )
            .map_err(|_| "promotion stale symlink byte accounting overflow")?
        } else {
            0
        };
        bytes = bytes
            .checked_add(logical_bytes)
            .ok_or("promotion stale-path byte accounting overflow")?;
        if bytes > PROMOTION_QUARANTINE_MAX_BYTES {
            return Err("promotion stale-path scan exceeds its byte bound".to_string());
        }
        if identity.is_dir()
            && !identity.is_symlink()
            && desired_directories.contains(&child_relative)
        {
            if stack.len() >= PROMOTION_DIRECTORY_MAX_DEPTH {
                return Err("promotion stale-path scan exceeds its depth bound".to_string());
            }
            let child = open_at(
                directory_fd,
                &c_name,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|error| {
                format!("open promotion directory {child_relative} failed: {error}")
            })?;
            let child_identity = stat_file(&child).map_err(|error| {
                format!("fstat promotion directory {child_relative} failed: {error}")
            })?;
            if !promotion_cleanup_same_namespace_identity(child_identity, identity) {
                return Err(format!(
                    "promotion directory {child_relative} changed while opening"
                ));
            }
            let child_stream = PromotionDirectoryStream::open(child.as_raw_fd())?;
            stack.push(StaleFrame {
                directory: child,
                stream: child_stream,
                relative: child_relative,
            });
        } else if !desired.contains(&child_relative) || !identity.is_dir() || identity.is_symlink()
        {
            promotion_remove_tree_entry(
                directory_fd,
                &c_name,
                identity,
                req,
                &child_relative,
            )?;
        }
    }
    Ok(())
}

fn promotion_write_entry(
    repo: &Repository,
    target: &fs::File,
    rel_path: &str,
    mode: u32,
    oid: Oid,
    req: &Value,
) -> Result<(), String> {
    if !is_safe_relative(rel_path) || has_git_segment(rel_path) {
        return Err(format!("unsafe promotion materialize path: {rel_path}"));
    }
    if rel_path.len() > PROMOTION_PATH_MAX_BYTES {
        return Err(format!("promotion materialize path exceeds its bounded path budget: {rel_path}"));
    }
    let component_count = rel_path.split('/').count();
    if component_count > PROMOTION_DIRECTORY_MAX_DEPTH {
        return Err(format!("promotion materialize path exceeds its depth bound: {rel_path}"));
    }
    let mut names = Vec::with_capacity(component_count);
    for (index, name) in rel_path.split('/').enumerate() {
        names.push(promotion_component(
            &Value::String(name.to_string()),
            &format!("materialize path component {index}"),
        )?);
    }
    let blob_bytes = match mode {
        0o120000 => git_blob_bytes_bounded(
            repo,
            oid,
            PROMOTION_PATH_MAX_BYTES as u64,
            &format!("symlink blob {rel_path}"),
        )?,
        0o100644 | 0o100755 => git_blob_bytes_bounded(
            repo,
            oid,
            BUDGET_MAX_FILE_BYTES,
            &format!("materialized blob {rel_path}"),
        )?,
        _ => return Err(format!("unsupported materialized mode for {rel_path}")),
    };
    let leaf = names.last().ok_or("promotion materialize path is empty")?;
    let parent = open_or_create_promotion_parent(
        target,
        &names[..names.len() - 1],
        "materialize parent",
        0o700,
    )?;
    let existing = stat_at(parent.as_raw_fd(), &leaf.1).ok();
    match mode {
        0o120000 => {
            let target_text = String::from_utf8(blob_bytes)
                .map_err(|error| format!("symlink blob is not valid UTF-8: {error}"))?;
            if target_text.contains('\0') || target_text.len() > PROMOTION_PATH_MAX_BYTES {
                return Err(format!("symlink target is too long: {rel_path}"));
            }
            let desired_target = target_text.clone();
            if let Some(current) = existing {
                let same = current.is_symlink()
                    && read_link_at(parent.as_raw_fd(), &leaf.1)
                        .ok()
                        .and_then(|bytes| String::from_utf8(bytes).ok())
                        .is_some_and(|value| value == desired_target);
                if !same {
                    promotion_remove_tree_entry(
                        parent.as_raw_fd(),
                        &leaf.1,
                        current,
                        req,
                        rel_path,
                    )?;
                } else {
                    return Ok(());
                }
            }
            let target_text = CString::new(target_text)
                .map_err(|_| format!("symlink target contains NUL: {rel_path}"))?;
            promotion_symlink_at(&target_text, parent.as_raw_fd(), &leaf.1)
                .map_err(|error| format!("symlink failed for {rel_path}: {error}"))?;
            let created = stat_at(parent.as_raw_fd(), &leaf.1)
                .map_err(|error| format!("stat created symlink {rel_path} failed: {error}"))?;
            let created_target = read_link_at(parent.as_raw_fd(), &leaf.1)
                .map_err(|error| format!("read created symlink {rel_path} failed: {error}"))?;
            if !created.is_symlink() || created_target != desired_target.as_bytes() {
                return Err(format!(
                    "promotion symlink changed after creation: {rel_path}"
                ));
            }
        }
        0o100644 | 0o100755 => {
            let mut file = if let Some(current) = existing {
                if !current.is_file() || current.is_symlink() {
                    promotion_remove_tree_entry(
                        parent.as_raw_fd(),
                        &leaf.1,
                        current,
                        req,
                        rel_path,
                    )?;
                    open_at_mode(
                        parent.as_raw_fd(),
                        &leaf.1,
                        libc::O_WRONLY
                            | libc::O_CREAT
                            | libc::O_EXCL
                            | libc::O_NOFOLLOW
                            | libc::O_CLOEXEC,
                        0o600,
                    )
                } else {
                    open_at(
                        parent.as_raw_fd(),
                        &leaf.1,
                        libc::O_WRONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                }
            } else {
                open_at_mode(
                    parent.as_raw_fd(),
                    &leaf.1,
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o600,
                )
            }
            .map_err(|error| format!("open materialized file failed for {rel_path}: {error}"))?;
            let opened = stat_file(&file).map_err(|error| {
                format!("fstat materialized file failed for {rel_path}: {error}")
            })?;
            if !opened.is_file() || opened.is_symlink() {
                return Err(format!("materialized file changed type: {rel_path}"));
            }
            if let Some(current) = existing {
                if !promotion_cleanup_same_namespace_identity(opened, current) {
                    return Err(format!(
                        "materialized file identity changed while opening: {rel_path}"
                    ));
                }
            }
            file.set_len(0).map_err(|error| {
                format!("truncate materialized file failed for {rel_path}: {error}")
            })?;
            promotion_write_all(&mut file, &blob_bytes, rel_path)?;
            promotion_set_mode(
                &file,
                if mode == 0o100755 { 0o755 } else { 0o644 },
                rel_path,
            )?;
            file.sync_all().map_err(|error| {
                format!("sync materialized file failed for {rel_path}: {error}")
            })?;
            let after = stat_file(&file).map_err(|error| {
                format!("fstat materialized file failed for {rel_path}: {error}")
            })?;
            let path_after = stat_at(parent.as_raw_fd(), &leaf.1).map_err(|error| {
                format!("stat materialized file failed for {rel_path}: {error}")
            })?;
            if !promotion_cleanup_same_namespace_identity(after, path_after)
                || after.len != blob_bytes.len() as u64
            {
                return Err(format!(
                    "materialized file changed while writing: {rel_path}"
                ));
            }
        }
        _ => unreachable!("materialized mode was validated before reading"),
    }
    parent
        .sync_all()
        .map_err(|error| format!("sync materialized parent failed for {rel_path}: {error}"))?;
    Ok(())
}

/// Materialize into a directory already opened and authenticated by the
/// native promotion boundary.  Both empty staging directories (template and
/// merged materialization) and existing candidate repositories use this one
/// implementation; no caller can select a separate pathname-based writer.
pub(crate) fn materialize_state_bound(
    repo: &Repository,
    state_commit: &str,
    target_path: &str,
    target: &fs::File,
    target_identity: PromotionIdentity,
    preserve_top: &[String],
    req: &Value,
) -> Result<(), String> {
    promotion_directory_identity_matches(target, target_identity, "materialize target")?;
    promotion_test_pause(req, "promotion-materialize-root-open")?;
    promotion_test_pause(req, "promotion-target-root-open")?;
    let flat = state_entries(repo, state_commit)?;
    let desired: HashSet<String> = flat.keys().cloned().collect();
    let desired_directories = desired_directories(&desired)?;
    let mut preserve: HashSet<String> = HashSet::from([".git".to_string()]);
    preserve.extend(preserve_top.iter().cloned());
    promotion_remove_stale_paths(target, "", &desired, &desired_directories, &preserve, req)?;
    let mut paths: Vec<(&String, &(u32, Oid))> = flat.iter().collect();
    paths.sort_by(|(left, _), (right, _)| left.cmp(right));
    for (rel_path, (mode, oid)) in paths {
        promotion_write_entry(repo, target, rel_path, *mode, *oid, req)?;
    }
    target
        .sync_all()
        .map_err(|error| format!("sync materialize target failed: {error}"))?;
    // A swapped configured path must never be accepted as the successful
    // destination.  All actual writes above used the original descriptor;
    // this final check only authenticates the public name before returning.
    promotion_bound_path_matches(target_path, target_identity, "materialize target")?;
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

/// Open the bare store repository and validate the object format.
pub(crate) fn open_store(store_dir: &Path, req: &Value) -> Result<Repository, String> {
    let lifecycle = validate_store_lifecycle(store_dir, req)?;
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
    // The store pathname may have been replaced while libgit2 opened the
    // repository.  Return only when both the request and the opened path are
    // still the same lifecycle; otherwise the caller must rebind/retry.
    let observed = current_store_lifecycle(store_dir)?;
    if observed != lifecycle {
        return Err(lifecycle_mismatch(&lifecycle, &observed));
    }
    Ok(repo)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::fs;

    /// Serializes the env-mutating tests below: Rust tests share one process,
    /// so concurrent set/remove of TERMINA_CORE_TEST would flake them.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Restores the process env on drop so a panic mid-test cannot leak
    /// TERMINA_CORE_TEST into other tests.
    struct EnvGuard {
        prior: Option<OsString>,
    }

    impl EnvGuard {
        fn set() -> Self {
            let prior = std::env::var_os("TERMINA_CORE_TEST");
            // SAFETY: ENV_LOCK serializes these tests against each other, and
            // no other test in this binary touches this variable.
            unsafe { std::env::set_var("TERMINA_CORE_TEST", "1") };
            Self { prior }
        }

        fn cleared() -> Self {
            let prior = std::env::var_os("TERMINA_CORE_TEST");
            // SAFETY: see set().
            unsafe { std::env::remove_var("TERMINA_CORE_TEST") };
            Self { prior }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            // SAFETY: see set().
            unsafe {
                if let Some(value) = self.prior.take() {
                    std::env::set_var("TERMINA_CORE_TEST", value);
                } else {
                    std::env::remove_var("TERMINA_CORE_TEST");
                }
            }
        }
    }

    struct Fixture(std::path::PathBuf);

    impl Fixture {
        fn named(name: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("termina-capture-hook-{}-{name}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn hook_payload_is_ignored_without_the_test_env() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _env = EnvGuard::cleared();
        let marker = std::env::temp_dir().join(format!(
            "termina-capture-hook-{}-must-not-exist.ready",
            std::process::id()
        ));
        let req = json!({ "hooks": { "probe": {
            "readyPath": marker.to_str().unwrap(),
            "releasePath": marker.to_str().unwrap(),
        } } });
        assert!(pause_at_hook(&req, "probe").is_ok());
        assert!(!marker.exists());
    }

    #[test]
    fn relative_hook_paths_are_rejected_before_any_write() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _env = EnvGuard::set();
        let req = json!({ "hooks": { "probe": {
            "readyPath": "relative-ready",
            "releasePath": "relative-release",
        } } });
        assert!(pause_at_hook(&req, "probe").is_err());
        assert!(!std::path::Path::new("relative-ready").exists());
    }

    #[test]
    fn absolute_hook_paths_pause_and_release() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _env = EnvGuard::set();
        let root = Fixture::named("absolute");
        let ready = root.0.join("ready");
        let release = root.0.join("release");
        fs::write(&release, b"release").unwrap();
        let req = json!({ "hooks": { "probe": {
            "readyPath": ready.to_str().unwrap(),
            "releasePath": release.to_str().unwrap(),
        } } });
        assert!(pause_at_hook(&req, "probe").is_ok());
        assert_eq!(fs::read(ready).unwrap(), b"ready");
    }
}
