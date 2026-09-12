//! Bound roots and repositories: capture roots, source bindings, and store opens.
use std::collections::{HashMap, HashSet};
use std::ffi::CString;
use std::fs;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use git2::{ObjectFormat, Oid, Repository};
use serde_json::Value;
use crate::util::{
    has_git_segment,
    is_safe_relative,
    missing_path,
    normalize_system_alias_path,
    object_format,
    object_oid,
    open_at,
    open_absolute_directory_nofollow,
    open_relative_directory,
    open_repo,
    s,
    same_directory_identity,
    stat_at,
    stat_file,
};
use crate::{
    FileIdentity,
    current_store_lifecycle,
    lifecycle_mismatch,
    validate_store_lifecycle,
};

use super::refs::pause_at_hook;

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
    pub(crate) fn open(root: &Path) -> Result<Self, String> {
        let display = normalize_system_alias_path(root, "capture root")?;
        let dir = open_absolute_directory_nofollow(&display, "capture root")?;
        let identity = stat_file(&dir).map_err(|e| format!("fstat capture root failed: {e}"))?;
        Ok(Self {
            dir,
            display,
            identity,
        })
    }

    pub(crate) fn resolve(&self, rel_path: &str) -> Result<Option<AnchoredPath>, String> {
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
    pub(crate) repo: Repository,
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
    pub(crate) capture_prefix: Option<String>,
}

impl BoundSourceRepository {
    pub(crate) fn open(
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

    pub(crate) fn verify(&self, capture_root: &CaptureRoot) -> Result<(), String> {
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

    pub(crate) fn index_write_time(&self) -> Result<Option<SystemTime>, String> {
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
