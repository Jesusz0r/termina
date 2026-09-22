//! Promotion cleanup validation and quarantine accounting + containers.
use std::ffi::CString;
use std::fs;
use std::io;
use std::os::fd::{AsRawFd, RawFd};
use std::sync::atomic::Ordering;

use serde_json::Value;

use crate::promote_fs::{
    PromotionDirectoryStream, promotion_add_work, promotion_child_relative, promotion_mkdir_at,
    promotion_path_work_bytes, promotion_test_pause,
};
use crate::promotion_files::promotion_cleanup_same_namespace_identity;
use crate::store::FileIdentity;
use crate::util::read_link_at;
use crate::util::{missing_path, open_at, stat_at, stat_file};
use crate::{
    PROMOTION_CLEANUP_SEQUENCE, PROMOTION_DIRECTORY_MAX_DEPTH, PROMOTION_DIRECTORY_MAX_ENTRIES,
    PROMOTION_DIRECTORY_MAX_NAME_BYTES, PROMOTION_QUARANTINE_MAX_BYTES,
    PROMOTION_QUARANTINE_MAX_CONTAINERS, PROMOTION_QUARANTINE_MAX_ENTRIES,
    PROMOTION_QUARANTINE_PREFIX,
};

#[derive(Clone, Copy)]
enum CleanupTreeKind {
    Incoming,
    Quarantine,
}

impl CleanupTreeKind {
    fn work_label(self) -> &'static str {
        match self {
            Self::Incoming => "promotion cleanup quarantine incoming tree",
            Self::Quarantine => "promotion cleanup quarantine",
        }
    }

    fn skip_missing(self) -> bool {
        matches!(self, Self::Incoming)
    }

    fn child(self) -> &'static str {
        match self {
            Self::Incoming => "cleanup entry",
            Self::Quarantine => "promotion quarantine entry",
        }
    }

    fn directory(self) -> &'static str {
        match self {
            Self::Incoming => "cleanup directory",
            Self::Quarantine => "promotion quarantine entry",
        }
    }

    fn symlink(self) -> &'static str {
        match self {
            Self::Incoming => "cleanup symlink",
            Self::Quarantine => "promotion quarantine symlink",
        }
    }

    fn retained(self) -> &'static str {
        match self {
            Self::Incoming => "evidence retained",
            Self::Quarantine => "resolve or export retained evidence before retrying",
        }
    }
}

/// Bounded nofollow walk that counts `(entries, bytes, work)`.  `after_child`
/// runs after each observed child is counted and before a directory is opened.
fn promotion_cleanup_tree_counts(
    dir: &fs::File,
    relative: &str,
    mut entries: usize,
    mut work_bytes: u64,
    kind: CleanupTreeKind,
    mut after_child: impl FnMut(RawFd, &CString, &str, FileIdentity) -> Result<(), String>,
) -> Result<(usize, u64, u64), String> {
    let mut bytes = 0u64;
    let mut stack = Vec::with_capacity(PROMOTION_DIRECTORY_MAX_DEPTH);
    stack.push((
        dir.try_clone().map_err(|error| match kind {
            CleanupTreeKind::Incoming => format!("clone cleanup tree failed: {error}"),
            CleanupTreeKind::Quarantine => format!("clone promotion quarantine failed: {error}"),
        })?,
        PromotionDirectoryStream::open(dir.as_raw_fd())?,
        relative.to_string(),
    ));
    // Invariant: last/pop see a frame while the stack is non-empty.
    while !stack.is_empty() {
        let next = stack
            .last_mut()
            .expect("cleanup tree scan stack is not empty")
            .1
            .next_entry()?;
        let Some((name, c_name)) = next else {
            stack.pop();
            continue;
        };
        let current_relative = stack
            .last()
            .expect("cleanup tree scan frame exists")
            .2
            .clone();
        let path_work = promotion_path_work_bytes(&current_relative, &name)?;
        promotion_add_work(
            &mut work_bytes,
            path_work,
            PROMOTION_DIRECTORY_MAX_NAME_BYTES,
            kind.work_label(),
        )?;
        let child_relative = promotion_child_relative(&current_relative, &name)?;
        let directory = stack
            .last()
            .expect("cleanup tree scan frame exists")
            .0
            .as_raw_fd();
        let identity = match stat_at(directory, &c_name) {
            Ok(identity) => identity,
            Err(error) if kind.skip_missing() && missing_path(&error) => continue,
            Err(error) => {
                return Err(format!(
                    "stat {} {child_relative} failed: {error}",
                    kind.child()
                ));
            }
        };
        if matches!(kind, CleanupTreeKind::Quarantine)
            && !identity.is_dir()
            && !identity.is_symlink()
            && !identity.is_file()
        {
            return Err(format!(
                "{} {child_relative} has unsupported type; {}",
                kind.child(),
                kind.retained()
            ));
        }
        entries = entries.checked_add(1).ok_or(match kind {
            CleanupTreeKind::Incoming => "cleanup tree entry count overflow",
            CleanupTreeKind::Quarantine => "promotion quarantine entry count overflow",
        })?;
        if entries > PROMOTION_QUARANTINE_MAX_ENTRIES {
            return Err(match kind {
                CleanupTreeKind::Incoming => format!(
                    "{} exceeds its entry bound; resolve or export retained evidence before retrying",
                    kind.work_label()
                ),
                CleanupTreeKind::Quarantine => format!(
                    "{} is at its entry bound; resolve or export retained evidence before retrying",
                    kind.work_label()
                ),
            });
        }
        if matches!(kind, CleanupTreeKind::Incoming)
            && !identity.is_dir()
            && !identity.is_symlink()
            && !identity.is_file()
        {
            return Err(format!(
                "{} {child_relative} has unsupported type; {}",
                kind.child(),
                kind.retained()
            ));
        }
        let logical_bytes = if identity.is_file() {
            identity.len
        } else if identity.is_symlink() {
            u64::try_from(
                read_link_at(directory, &c_name)
                    .map_err(|error| {
                        format!("read {} {child_relative} failed: {error}", kind.symlink())
                    })?
                    .len(),
            )
            .map_err(|_| match kind {
                CleanupTreeKind::Incoming => "cleanup symlink byte count overflow",
                CleanupTreeKind::Quarantine => "promotion quarantine symlink byte count overflow",
            })?
        } else {
            0
        };
        bytes = bytes.checked_add(logical_bytes).ok_or(match kind {
            CleanupTreeKind::Incoming => "cleanup tree byte count overflow",
            CleanupTreeKind::Quarantine => "promotion quarantine byte count overflow",
        })?;
        if bytes > PROMOTION_QUARANTINE_MAX_BYTES {
            return Err(format!(
                "{} exceeds its byte bound; resolve or export retained evidence before retrying",
                kind.work_label()
            ));
        }
        after_child(directory, &c_name, &child_relative, identity)?;
        if identity.is_dir() && !identity.is_symlink() {
            if stack.len() >= PROMOTION_DIRECTORY_MAX_DEPTH {
                return Err(format!(
                    "{} exceeds its depth bound; {}",
                    kind.work_label(),
                    kind.retained()
                ));
            }
            let child = open_at(
                directory,
                &c_name,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|error| {
                format!("open {} {child_relative} failed: {error}", kind.directory())
            })?;
            let opened_identity = stat_file(&child).map_err(|error| {
                format!(
                    "fstat {} {child_relative} failed: {error}",
                    kind.directory()
                )
            })?;
            if !promotion_cleanup_same_namespace_identity(opened_identity, identity) {
                return Err(format!(
                    "{} {child_relative} changed while opening; {}",
                    kind.directory(),
                    kind.retained()
                ));
            }
            let child_stream = PromotionDirectoryStream::open(child.as_raw_fd())?;
            stack.push((child, child_stream, child_relative));
        }
    }
    Ok((entries, bytes, work_bytes))
}

/// Validate a cleanup tree through descriptors without mutating it.  The
/// final cleanup operation moves the complete tree, so deleting individual
/// children is unnecessary and would reintroduce an inode check/use race.
/// Every observed child is nevertheless rechecked at the deterministic seam;
/// this keeps the existing leaf ABA probes meaningful and rejects a change
/// before the tree is moved.
pub(crate) fn validate_promotion_cleanup_tree(
    dir: &fs::File,
    req: &Value,
    relative: &str,
) -> Result<(usize, u64, u64), String> {
    let root =
        stat_file(dir).map_err(|error| format!("fstat cleanup tree {relative} failed: {error}"))?;
    if !root.is_dir() || root.is_symlink() {
        return Err(format!("cleanup tree {relative} is not a real directory"));
    }
    let mut work_bytes =
        u64::try_from(relative.len()).map_err(|_| "cleanup tree work accounting overflow")?;
    promotion_add_work(
        &mut work_bytes,
        std::mem::size_of::<FileIdentity>() as u64,
        PROMOTION_DIRECTORY_MAX_NAME_BYTES,
        CleanupTreeKind::Incoming.work_label(),
    )?;
    promotion_cleanup_tree_counts(
        dir,
        relative,
        1,
        work_bytes,
        CleanupTreeKind::Incoming,
        |directory, c_name, child_relative, identity| {
            promotion_test_pause(req, "promotion-cleanup-leaf-validated")?;
            let after_validation = stat_at(directory, c_name)
                .map_err(|error| format!("stat cleanup entry {child_relative} failed: {error}"))?;
            if after_validation != identity {
                return Err(format!(
                    "cleanup entry {child_relative} changed; evidence retained"
                ));
            }
            Ok(())
        },
    )
}

/// Return the number of entries and logical bytes already retained under one
/// quarantine container.  No symlink is followed.  Ambiguous or unsupported
/// evidence fails closed because this is the durable admission boundary.
pub(crate) fn promotion_quarantine_tree_usage(dir: &fs::File) -> Result<(usize, u64, u64), String> {
    let identity =
        stat_file(dir).map_err(|error| format!("fstat promotion quarantine failed: {error}"))?;
    if !identity.is_dir() || identity.is_symlink() {
        return Err("promotion quarantine container is not a real directory".to_string());
    }
    let work_bytes = std::mem::size_of::<FileIdentity>() as u64;
    if work_bytes > PROMOTION_DIRECTORY_MAX_NAME_BYTES {
        return Err("promotion cleanup quarantine exceeds its work bound".to_string());
    }
    promotion_cleanup_tree_counts(
        dir,
        "",
        0,
        work_bytes,
        CleanupTreeKind::Quarantine,
        |_, _, _, _| Ok(()),
    )
}

/// Scan all app-created quarantine containers under the descriptor-bound
/// grandparent.  Containers are deliberately fresh: an existing pathname is
/// never accepted as a trust root, and the aggregate scan makes retention
/// bounded across process restarts.
pub(crate) struct PromotionQuarantineUsage {
    containers: usize,
    entries: usize,
    bytes: u64,
    work_bytes: u64,
    reusable: Option<(fs::File, CString)>,
}

pub(crate) fn promotion_quarantine_usage(
    grandparent: &fs::File,
) -> Result<PromotionQuarantineUsage, String> {
    let mut containers = 0usize;
    let mut entries = 0usize;
    let mut bytes = 0u64;
    let mut work_bytes = 0u64;
    let mut reusable = None;
    let mut scanned_entries = 0usize;
    let mut scanned_name_bytes = 0u64;
    let mut stream = PromotionDirectoryStream::open(grandparent.as_raw_fd())?;
    while let Some((name, c_name)) = stream.next_entry()? {
        scanned_entries = scanned_entries
            .checked_add(1)
            .ok_or("promotion quarantine directory entry count overflow")?;
        if scanned_entries > PROMOTION_DIRECTORY_MAX_ENTRIES {
            return Err("promotion cleanup quarantine scan exceeds its entry bound; resolve or export retained evidence before retrying".to_string());
        }
        scanned_name_bytes = scanned_name_bytes
            .checked_add(name.len() as u64)
            .ok_or("promotion quarantine directory name accounting overflow")?;
        if scanned_name_bytes > PROMOTION_DIRECTORY_MAX_NAME_BYTES {
            return Err("promotion cleanup quarantine scan exceeds its name-work bound; resolve or export retained evidence before retrying".to_string());
        }
        promotion_add_work(
            &mut work_bytes,
            u64::try_from(name.len())
                .map_err(|_| "promotion quarantine scan work accounting overflow")?
                .checked_add(std::mem::size_of::<FileIdentity>() as u64)
                .ok_or("promotion quarantine scan work accounting overflow")?,
            PROMOTION_DIRECTORY_MAX_NAME_BYTES,
            "promotion cleanup quarantine scan",
        )?;
        if !name.starts_with(PROMOTION_QUARANTINE_PREFIX) {
            continue;
        }
        let identity = stat_at(grandparent.as_raw_fd(), &c_name).map_err(|error| {
            format!("stat promotion quarantine container {name} failed: {error}")
        })?;
        if !identity.is_dir() || identity.is_symlink() {
            return Err(format!(
                "promotion quarantine container {name} is not a real directory"
            ));
        }
        containers = containers
            .checked_add(1)
            .ok_or("promotion quarantine container count overflow")?;
        if containers > PROMOTION_QUARANTINE_MAX_CONTAINERS {
            return Err("promotion cleanup quarantine is at its container bound; resolve or export retained evidence before retrying".to_string());
        }
        let container = open_at(
            grandparent.as_raw_fd(),
            &c_name,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
        .map_err(|error| format!("open promotion quarantine container {name} failed: {error}"))?;
        let (container_entries, container_bytes, container_work_bytes) =
            promotion_quarantine_tree_usage(&container)?;
        entries = entries
            .checked_add(container_entries)
            .ok_or("promotion quarantine entry count overflow")?;
        bytes = bytes
            .checked_add(container_bytes)
            .ok_or("promotion quarantine byte count overflow")?;
        work_bytes = work_bytes
            .checked_add(container_work_bytes)
            .ok_or("promotion quarantine work accounting overflow")?;
        if entries > PROMOTION_QUARANTINE_MAX_ENTRIES {
            return Err("promotion cleanup quarantine is at its entry bound; resolve or export retained evidence before retrying".to_string());
        }
        if bytes > PROMOTION_QUARANTINE_MAX_BYTES {
            return Err("promotion cleanup quarantine exceeds its byte bound; resolve or export retained evidence before retrying".to_string());
        }
        if work_bytes > PROMOTION_DIRECTORY_MAX_NAME_BYTES {
            return Err("promotion cleanup quarantine exceeds its work bound; resolve or export retained evidence before retrying".to_string());
        }
        if reusable.is_none() {
            reusable = Some((container, c_name));
        }
    }
    Ok(PromotionQuarantineUsage {
        containers,
        entries,
        bytes,
        work_bytes,
        reusable,
    })
}

/// Create a fresh durable quarantine container beside the bound source
/// parent.  The grandparent descriptor comes from an already identity-checked
/// parent, so no mutable absolute pathname is used for the container bind.
pub(crate) struct PromotionQuarantineReservation {
    pub(crate) grandparent: fs::File,
    pub(crate) quarantine_root: fs::File,
    _quarantine_name: CString,
}

impl Drop for PromotionQuarantineReservation {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.grandparent.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

pub(crate) fn create_promotion_quarantine_container(
    parent: &fs::File,
    expected_entries: usize,
    expected_bytes: u64,
    expected_work_bytes: u64,
) -> Result<PromotionQuarantineReservation, String> {
    // Invariant: ".." is a compile-time literal (no NUL).
    let grandparent_name = CString::new("..").expect("parent component has no NUL");
    let grandparent = open_at(
        parent.as_raw_fd(),
        &grandparent_name,
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )
    .map_err(|error| format!("open promotion cleanup grandparent failed: {error}"))?;
    let lock_result = unsafe { libc::flock(grandparent.as_raw_fd(), libc::LOCK_EX) };
    if lock_result == -1 {
        return Err(format!(
            "lock promotion cleanup quarantine admission failed: {}",
            io::Error::last_os_error()
        ));
    }
    let usage = match promotion_quarantine_usage(&grandparent) {
        Ok(usage) => usage,
        Err(error) => return Err(error),
    };
    if expected_entries > PROMOTION_QUARANTINE_MAX_ENTRIES.saturating_sub(usage.entries)
        || expected_bytes > PROMOTION_QUARANTINE_MAX_BYTES.saturating_sub(usage.bytes)
        || expected_work_bytes > PROMOTION_DIRECTORY_MAX_NAME_BYTES.saturating_sub(usage.work_bytes)
    {
        return Err(format!(
            "promotion cleanup quarantine is full ({}/{} entries, {}/{} bytes, {}/{} work); resolve or export retained evidence before retrying",
            usage.entries,
            PROMOTION_QUARANTINE_MAX_ENTRIES,
            usage.bytes,
            PROMOTION_QUARANTINE_MAX_BYTES,
            usage.work_bytes,
            PROMOTION_DIRECTORY_MAX_NAME_BYTES,
        ));
    }
    // Reuse one already validated quarantine container when possible. The
    // object is still moved with the descriptor-bound rename below, while a
    // shared container keeps repeated explicit discard/reclamation from
    // exhausting the global 128-container bound after only 128 successful
    // proven-bundle removals.
    if let Some((quarantine_root, quarantine_name)) = usage.reusable {
        return Ok(PromotionQuarantineReservation {
            grandparent,
            quarantine_root,
            _quarantine_name: quarantine_name,
        });
    }
    if usage.containers >= PROMOTION_QUARANTINE_MAX_CONTAINERS {
        return Err(format!(
            "promotion cleanup quarantine is full ({}/{PROMOTION_QUARANTINE_MAX_CONTAINERS} containers); resolve or export retained evidence before retrying",
            usage.containers,
        ));
    }
    for _ in 0..64 {
        let sequence = PROMOTION_CLEANUP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        // Invariant: prefix is a literal; sequence is hex. No request or dirent bytes.
        let name = CString::new(format!("{PROMOTION_QUARANTINE_PREFIX}{sequence:016x}"))
            .expect("promotion quarantine container name has no NUL");
        match promotion_mkdir_at(grandparent.as_raw_fd(), &name, 0o700) {
            Ok(()) => {
                let container = open_at(
                    grandparent.as_raw_fd(),
                    &name,
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
                .map_err(|error| format!("open created promotion quarantine failed: {error}"))?;
                grandparent
                    .sync_all()
                    .map_err(|error| format!("sync promotion quarantine parent failed: {error}"))?;
                return Ok(PromotionQuarantineReservation {
                    grandparent,
                    quarantine_root: container,
                    _quarantine_name: name,
                });
            }
            Err(error) if error.raw_os_error() == Some(libc::EEXIST) => continue,
            Err(error) => return Err(format!("create promotion quarantine failed: {error}")),
        }
    }
    Err("could not allocate a unique promotion cleanup quarantine container".to_string())
}
