//! Promotion quarantine, remove-tree, and transition: cleanup-tree
//! validation, quarantine accounting and containers, and the two ops.
use std::ffi::CString;
use std::fs;
use std::io::{self};
use std::os::fd::AsRawFd;

use std::time::{SystemTime, UNIX_EPOCH};

use std::sync::atomic::Ordering;

use serde_json::{Value, json};

use crate::{
    PROMOTION_CLEANUP_SEQUENCE, PROMOTION_DIRECTORY_MAX_DEPTH, PROMOTION_DIRECTORY_MAX_ENTRIES,
    PROMOTION_DIRECTORY_MAX_NAME_BYTES, PROMOTION_QUARANTINE_MAX_BYTES,
    PROMOTION_QUARANTINE_MAX_CONTAINERS, PROMOTION_QUARANTINE_MAX_ENTRIES,
    PROMOTION_QUARANTINE_PREFIX, missing_path, open_at, s, stat_at, stat_file,
};
use crate::store::FileIdentity;
use crate::promotion_files::{promotion_cleanup_same_namespace_identity, promotion_rename_exchange, promotion_rename_unsupported, promotion_transition_result};
use crate::capture::read_link_at;
use crate::promote_fs::{
    PromotionDirectoryStream, open_promotion_absolute_directory,
    observe_promotion_leaf, open_promotion_bound_root,
    open_promotion_bound_root_values, open_promotion_parent,
    parse_promotion_expected, parse_promotion_expected_destination,
    promotion_add_work, promotion_child_relative,
    promotion_components, promotion_components_for,
    promotion_components_value, promotion_directory_identity_matches,
    promotion_expected_matches,
    promotion_expected_state_description,
    promotion_identity_from_value, promotion_mkdir_at, promotion_name, promotion_path_work_bytes,
    promotion_rename_noreplace, promotion_test_pause,
};

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
    let mut entries = 1usize;
    let mut bytes = 0u64;
    let mut work_bytes = u64::try_from(relative.len())
        .map_err(|_| "cleanup tree work accounting overflow")?;
    promotion_add_work(
        &mut work_bytes,
        std::mem::size_of::<FileIdentity>() as u64,
        PROMOTION_DIRECTORY_MAX_NAME_BYTES,
        "promotion cleanup quarantine incoming tree",
    )?;
    let mut stack = Vec::with_capacity(PROMOTION_DIRECTORY_MAX_DEPTH);
    stack.push((
        dir.try_clone().map_err(|error| format!("clone cleanup tree failed: {error}"))?,
        PromotionDirectoryStream::open(dir.as_raw_fd())?,
        relative.to_string(),
    ));
    while !stack.is_empty() {
        let next = stack
            .last_mut()
            .expect("cleanup scan stack is not empty")
            .1
            .next_entry()?;
        let Some((name, c_name)) = next else {
            stack.pop();
            continue;
        };
        let current_relative = stack.last().expect("cleanup scan frame exists").2.clone();
        let path_work = promotion_path_work_bytes(&current_relative, &name)?;
        promotion_add_work(
            &mut work_bytes,
            path_work,
            PROMOTION_DIRECTORY_MAX_NAME_BYTES,
            "promotion cleanup quarantine incoming tree",
        )?;
        let child_relative = promotion_child_relative(&current_relative, &name)?;
        let directory = stack.last().expect("cleanup scan frame exists").0.as_raw_fd();
        let identity = match stat_at(directory, &c_name) {
            Ok(identity) => identity,
            Err(error) if missing_path(&error) => continue,
            Err(error) => {
                return Err(format!("stat cleanup entry {child_relative} failed: {error}"));
            }
        };
        entries = entries
            .checked_add(1)
            .ok_or("cleanup tree entry count overflow")?;
        if entries > PROMOTION_QUARANTINE_MAX_ENTRIES {
            return Err("promotion cleanup quarantine incoming tree exceeds its entry bound; resolve or export retained evidence before retrying".to_string());
        }
        if !identity.is_dir() && !identity.is_symlink() && !identity.is_file() {
            return Err(format!(
                "cleanup entry {child_relative} has unsupported type; evidence retained"
            ));
        }
        let logical_bytes = if identity.is_file() {
            identity.len
        } else if identity.is_symlink() {
            u64::try_from(
                read_link_at(directory, &c_name)
                    .map_err(|error| format!("read cleanup symlink {child_relative} failed: {error}"))?
                    .len(),
            )
            .map_err(|_| "cleanup symlink byte count overflow")?
        } else {
            0
        };
        bytes = bytes
            .checked_add(logical_bytes)
            .ok_or("cleanup tree byte count overflow")?;
        if bytes > PROMOTION_QUARANTINE_MAX_BYTES {
            return Err("promotion cleanup quarantine incoming tree exceeds its byte bound; resolve or export retained evidence before retrying".to_string());
        }
        promotion_test_pause(req, "promotion-cleanup-leaf-validated")?;
        let after_validation = stat_at(directory, &c_name)
            .map_err(|error| format!("stat cleanup entry {child_relative} failed: {error}"))?;
        if after_validation != identity {
            return Err(format!(
                "cleanup entry {child_relative} changed; evidence retained"
            ));
        }
        if identity.is_dir() && !identity.is_symlink() {
            if stack.len() >= PROMOTION_DIRECTORY_MAX_DEPTH {
                return Err("promotion cleanup quarantine incoming tree exceeds its depth bound; evidence retained".to_string());
            }
            let child = open_at(
                directory,
                &c_name,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|error| format!("open cleanup directory {child_relative} failed: {error}"))?;
            let child_identity = stat_file(&child).map_err(|error| {
                format!("fstat cleanup directory {child_relative} failed: {error}")
            })?;
            if !promotion_cleanup_same_namespace_identity(child_identity, identity) {
                return Err(format!(
                    "cleanup directory {child_relative} changed while opening; evidence retained"
                ));
            }
            let child_stream = PromotionDirectoryStream::open(child.as_raw_fd())?;
            stack.push((child, child_stream, child_relative));
        }
    }
    Ok((entries, bytes, work_bytes))
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
    let mut entries = 0usize;
    let mut bytes = 0u64;
    let mut work_bytes = std::mem::size_of::<FileIdentity>() as u64;
    if work_bytes > PROMOTION_DIRECTORY_MAX_NAME_BYTES {
        return Err("promotion cleanup quarantine exceeds its work bound".to_string());
    }
    let mut stack = Vec::with_capacity(PROMOTION_DIRECTORY_MAX_DEPTH);
    stack.push((
        dir.try_clone().map_err(|error| format!("clone promotion quarantine failed: {error}"))?,
        PromotionDirectoryStream::open(dir.as_raw_fd())?,
        String::new(),
    ));
    while !stack.is_empty() {
        let next = stack
            .last_mut()
            .expect("quarantine scan stack is not empty")
            .1
            .next_entry()?;
        let Some((name, c_name)) = next else {
            stack.pop();
            continue;
        };
        let current_relative = stack.last().expect("quarantine scan frame exists").2.clone();
        let path_work = promotion_path_work_bytes(&current_relative, &name)?;
        promotion_add_work(
            &mut work_bytes,
            path_work,
            PROMOTION_DIRECTORY_MAX_NAME_BYTES,
            "promotion cleanup quarantine",
        )?;
        let child_relative = promotion_child_relative(&current_relative, &name)?;
        let directory = stack.last().expect("quarantine scan frame exists").0.as_raw_fd();
        let child_identity = stat_at(directory, &c_name)
            .map_err(|error| format!("stat promotion quarantine entry {child_relative} failed: {error}"))?;
        if !child_identity.is_dir() && !child_identity.is_symlink() && !child_identity.is_file() {
            return Err(format!(
                "promotion quarantine entry {child_relative} has unsupported type; resolve or export retained evidence before retrying"
            ));
        }
        entries = entries
            .checked_add(1)
            .ok_or("promotion quarantine entry count overflow")?;
        if entries > PROMOTION_QUARANTINE_MAX_ENTRIES {
            return Err("promotion cleanup quarantine is at its entry bound; resolve or export retained evidence before retrying".to_string());
        }
        let logical_bytes = if child_identity.is_file() {
            child_identity.len
        } else if child_identity.is_symlink() {
            u64::try_from(
                read_link_at(directory, &c_name)
                    .map_err(|error| format!("read promotion quarantine symlink {child_relative} failed: {error}"))?
                    .len(),
            )
            .map_err(|_| "promotion quarantine symlink byte count overflow")?
        } else {
            0
        };
        bytes = bytes
            .checked_add(logical_bytes)
            .ok_or("promotion quarantine byte count overflow")?;
        if bytes > PROMOTION_QUARANTINE_MAX_BYTES {
            return Err("promotion cleanup quarantine exceeds its byte bound; resolve or export retained evidence before retrying".to_string());
        }
        if child_identity.is_dir() && !child_identity.is_symlink() {
            if stack.len() >= PROMOTION_DIRECTORY_MAX_DEPTH {
                return Err("promotion cleanup quarantine exceeds its depth bound; resolve or export retained evidence before retrying".to_string());
            }
            let child = open_at(
                directory,
                &c_name,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|error| format!("open promotion quarantine entry {child_relative} failed: {error}"))?;
            let opened_identity = stat_file(&child)
                .map_err(|error| format!("fstat promotion quarantine entry {child_relative} failed: {error}"))?;
            if !promotion_cleanup_same_namespace_identity(opened_identity, child_identity) {
                return Err(format!("promotion quarantine entry {child_relative} changed while opening; resolve or export retained evidence before retrying"));
            }
            let child_stream = PromotionDirectoryStream::open(child.as_raw_fd())?;
            stack.push((child, child_stream, child_relative));
        }
    }
    Ok((entries, bytes, work_bytes))
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

fn promotion_quarantine_usage(grandparent: &fs::File) -> Result<PromotionQuarantineUsage, String> {
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
    grandparent: fs::File,
    quarantine_root: fs::File,
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

pub(crate) fn op_promotion_bound_remove_tree(req: &Value) -> Result<Value, String> {
    let (root, root_identity, _capability) =
        open_promotion_bound_root(req, "root", "rootIdentity", "rootCapability")?;
    let components = promotion_components_for(req, "components")?;
    let parent = open_promotion_parent(&root, &components, "cleanup")?;
    let parent_identity = promotion_identity_from_value(
        req.get("parentIdentity").ok_or("missing parentIdentity")?,
        "parentIdentity",
    )?;
    promotion_directory_identity_matches(&parent, parent_identity, "cleanup parent")?;
    let (_, leaf) = components.last().expect("non-empty components");
    let expected = promotion_identity_from_value(
        req.get("expectedIdentity")
            .ok_or("missing expectedIdentity")?,
        "expectedIdentity",
    )?;
    // Bind either a directory tree or a regular-file/symlink leaf below the
    // already-bound parent.  Symlink leaves intentionally have no portable
    // read descriptor with O_NOFOLLOW, so their namespace identity is held by
    // fstatat and the final descriptor-relative rename instead.
    let observed_child = stat_at(parent.as_raw_fd(), leaf)
        .map_err(|error| format!("stat cleanup root failed: {error}"))?;
    let child = if observed_child.is_symlink() {
        None
    } else {
        Some(
            open_at(
                parent.as_raw_fd(),
                leaf,
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|error| format!("open cleanup root failed: {error}"))?,
        )
    };
    let child_identity = match &child {
        Some(child) => stat_file(child)
            .map_err(|error| format!("fstat cleanup root failed: {error}"))?,
        None => observed_child,
    };
    if (!child_identity.is_dir() && !child_identity.is_file() && !child_identity.is_symlink())
        || child_identity.dev != expected.dev
        || child_identity.ino != expected.ino
    {
        return Err("cleanup root identity mismatch".to_string());
    }
    promotion_test_pause(req, "promotion-cleanup-root-open")?;
    let after_open = stat_at(parent.as_raw_fd(), leaf)
        .map_err(|error| format!("stat cleanup root failed: {error}"))?;
    if (!after_open.is_dir() && !after_open.is_file() && !after_open.is_symlink())
        || after_open.dev != expected.dev
        || after_open.ino != expected.ino
        || after_open.file_type() != child_identity.file_type()
    {
        return Err("cleanup root changed; evidence retained".to_string());
    }
    promotion_test_pause(req, "promotion-cleanup-root-validated")?;
    let after_validation = stat_at(parent.as_raw_fd(), leaf)
        .map_err(|error| format!("stat cleanup root failed: {error}"))?;
    if after_validation != after_open {
        return Err("cleanup root changed; evidence retained".to_string());
    }
    // The descriptor pins the object that will be moved, but it does not by
    // itself prove that the caller's absolute root path still resolves
    // through the same ancestor chain.  Re-open the trusted path and compare
    // its final identity immediately before the mutation so an ancestor
    // rename/replacement cannot turn a bound cleanup into an unexpected
    // pathname operation.  The original object remains reachable through
    // `root` when this check fails.
    let requested_root = s(req, "root")?;
    let path_root = open_promotion_absolute_directory(&requested_root, "root")?;
    let path_root_identity = stat_file(&path_root)
        .map_err(|error| format!("fstat cleanup root path failed: {error}"))?;
    if path_root_identity.dev != root_identity.dev || path_root_identity.ino != root_identity.ino {
        return Err("cleanup root ancestry changed; evidence retained".to_string());
    }
    let (expected_entries, expected_bytes, expected_work_bytes) = if child_identity.is_dir() {
        validate_promotion_cleanup_tree(
            child.as_ref().expect("directory cleanup child is opened"),
            req,
            "cleanup root",
        )?
    } else {
        promotion_test_pause(req, "promotion-cleanup-leaf-validated")?;
        let after_leaf = stat_at(parent.as_raw_fd(), leaf)
            .map_err(|error| format!("stat cleanup root after validation failed: {error}"))?;
        if after_leaf != after_open {
            return Err("cleanup root changed; evidence retained".to_string());
        }
        let work = u64::try_from(components.last().expect("non-empty cleanup components").0.len())
            .map_err(|_| "cleanup root work accounting overflow")?
            .checked_add(std::mem::size_of::<FileIdentity>() as u64)
            .ok_or("cleanup root work accounting overflow")?;
        let bytes = if child_identity.is_symlink() {
            u64::try_from(
                read_link_at(parent.as_raw_fd(), leaf)
                    .map_err(|error| format!("read cleanup symlink failed: {error}"))?
                    .len(),
            )
            .map_err(|_| "cleanup symlink byte accounting overflow")?
        } else {
            child_identity.len
        };
        (1, bytes, work)
    };
    // Admission reserves the aggregate entry/byte budget while holding a
    // stable grandparent descriptor lock.  Keep that reservation alive until
    // the descriptor-bound no-replace rename and final validation complete;
    // any failed move drops the lock without deleting retained evidence.
    let reservation =
        create_promotion_quarantine_container(
            &parent,
            expected_entries,
            expected_bytes,
            expected_work_bytes,
        )?;
    let quarantine_root = &reservation.quarantine_root;
    // Revalidate the incoming object after admission has serialized against
    // other quarantine movers. If a writer changed the tree while the first
    // accounting pass was running, do not consume a reservation calculated
    // for the old shape; dropping the reservation leaves the source intact.
    let (rechecked_entries, rechecked_bytes, rechecked_work_bytes) = if child_identity.is_dir() {
        validate_promotion_cleanup_tree(
            child.as_ref().expect("directory cleanup child is opened"),
            req,
            "cleanup root",
        )?
    } else {
        let rechecked = match &child {
            Some(child) => stat_file(child)
                .map_err(|error| format!("fstat cleanup root after admission failed: {error}"))?,
            None => stat_at(parent.as_raw_fd(), leaf)
                .map_err(|error| format!("stat cleanup root after admission failed: {error}"))?,
        };
        let path_rechecked = stat_at(parent.as_raw_fd(), leaf)
            .map_err(|error| format!("stat cleanup root after admission failed: {error}"))?;
        if rechecked != child_identity || path_rechecked != after_open {
            return Err(
                "cleanup root changed during quarantine admission; evidence retained".to_string(),
            );
        }
        let work = u64::try_from(components.last().expect("non-empty cleanup components").0.len())
            .map_err(|_| "cleanup root work accounting overflow")?
            .checked_add(std::mem::size_of::<FileIdentity>() as u64)
            .ok_or("cleanup root work accounting overflow")?;
        let bytes = if child_identity.is_symlink() {
            u64::try_from(
                read_link_at(parent.as_raw_fd(), leaf)
                    .map_err(|error| format!("read cleanup symlink failed: {error}"))?
                    .len(),
            )
            .map_err(|_| "cleanup symlink byte accounting overflow")?
        } else {
            rechecked.len
        };
        (1, bytes, work)
    };
    if rechecked_entries != expected_entries
        || rechecked_bytes != expected_bytes
        || rechecked_work_bytes != expected_work_bytes
    {
        return Err(
            "cleanup root changed during quarantine admission; evidence retained".to_string(),
        );
    }
    let mut quarantine_name = None;
    // The core process can restart while the durable quarantine survives.
    // Include process-local entropy in the candidate and still handle an
    // adversarial collision with bounded noreplace retries; a process-reset
    // sequence alone would repeatedly collide with prior evidence.
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    for _ in 0..64 {
        let sequence = PROMOTION_CLEANUP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let candidate = CString::new(format!(
            ".termina-promotion-cleanup-root-{}-{nonce:032x}-{sequence:016x}.tmp",
            std::process::id(),
        ))
        .expect("cleanup root quarantine name has no NUL");
        match promotion_rename_noreplace(
            parent.as_raw_fd(),
            leaf,
            quarantine_root.as_raw_fd(),
            &candidate,
        ) {
            Ok(()) => {
                quarantine_name = Some(candidate);
                break;
            }
            Err(error) if error.raw_os_error() == Some(libc::EEXIST) => continue,
            Err(error) if promotion_rename_unsupported(&error) => {
                return Err("promotion cleanup quarantine is unsupported".to_string());
            }
            Err(error) => {
                return Err(format!(
                    "quarantine cleanup root failed: {error}; evidence retained"
                ));
            }
        }
    }
    let quarantine_name =
        quarantine_name.ok_or("could not allocate a cleanup root quarantine name")?;
    let moved = stat_at(quarantine_root.as_raw_fd(), &quarantine_name).map_err(|error| {
        format!("stat quarantined cleanup root failed: {error}; evidence retained")
    })?;
    if !promotion_cleanup_same_namespace_identity(moved, child_identity) {
        return Err("cleanup root changed during quarantine; evidence retained".to_string());
    }
    // This seam is intentionally after the final stat.  There is no unlink
    // after it: a replacement can only make the operation fail closed while
    // both the original and replacement remain durable evidence.
    promotion_test_pause(req, "promotion-cleanup-quarantine-final-stat")?;
    let after_final_stat =
        stat_at(quarantine_root.as_raw_fd(), &quarantine_name).map_err(|error| {
            format!("stat quarantined cleanup root failed: {error}; evidence retained")
        })?;
    if !promotion_cleanup_same_namespace_identity(after_final_stat, child_identity) {
        return Err("quarantined cleanup root changed; evidence retained".to_string());
    }
    // Re-scan while admission is still reserved.  This catches any
    // unexpected retained-tree growth before reporting success; the object
    // remains durable evidence and no cleanup unlink is attempted.
    promotion_quarantine_usage(&reservation.grandparent).map_err(|error| {
        format!("promotion cleanup quarantine changed during admission: {error}; evidence retained")
    })?;
    quarantine_root
        .sync_all()
        .map_err(|error| format!("sync promotion cleanup quarantine failed: {error}"))?;
    parent
        .sync_all()
        .map_err(|error| format!("sync cleanup parent failed: {error}"))?;
    Ok(json!({
        "result": {
            "removed": true,
            "retained": true,
            "quarantineName": quarantine_name.to_string_lossy(),
        }
    }))
}

pub(crate) fn op_promotion_bound_transition(req: &Value) -> Result<Value, String> {
    let (primary, _primary_identity, _primary_capability) = open_promotion_bound_root(
        req,
        "primaryRoot",
        "primaryRootIdentity",
        "primaryRootCapability",
    )?;
    let components = promotion_components(req)?;
    let parent_identity = promotion_identity_from_value(
        req.get("parentIdentity").ok_or("missing parentIdentity")?,
        "parentIdentity",
    )?;
    let destination_name = components
        .last()
        .ok_or("promotion destination is missing")?;
    let parent = open_promotion_parent(&primary, &components, "primary")?;
    promotion_directory_identity_matches(&parent, parent_identity, "promotion parent")?;
    promotion_test_pause(req, "primary-parent-open")?;

    let transition = req
        .get("transition")
        .and_then(Value::as_object)
        .ok_or("transition must be an object")?;
    let kind = transition
        .get("kind")
        .and_then(Value::as_str)
        .ok_or("transition.kind is missing")?;
    let destination = &destination_name.1;
    match kind {
        "exchange" => {
            let (source_name, source) = promotion_name(
                transition
                    .get("sourceName")
                    .ok_or("exchange sourceName is missing")?,
                "sourceName",
                ".termina-promotion-",
            )?;
            if source_name == destination_name.0 {
                return Err("promotion exchange source and destination must differ".to_string());
            }
            let expected_source = parse_promotion_expected(
                transition
                    .get("expectedSource")
                    .ok_or("exchange expectedSource is missing")?,
                "expectedSource",
            )?;
            let expected_destination = parse_promotion_expected(
                transition
                    .get("expectedDestination")
                    .ok_or("exchange expectedDestination is missing")?,
                "expectedDestination",
            )?;
            if expected_source.identity == expected_destination.identity {
                return Err("promotion exchange identities must differ".to_string());
            }
            let observed_source = observe_promotion_leaf(parent.as_raw_fd(), &source)?;
            let observed_destination = observe_promotion_leaf(parent.as_raw_fd(), destination)?;
            if !promotion_expected_matches(&expected_source, observed_source.as_ref())
                || !promotion_expected_matches(&expected_destination, observed_destination.as_ref())
            {
                return Err(format!(
                    "promotion exchange expected {} identities were not present",
                    promotion_expected_state_description(&expected_source),
                ));
            }
            promotion_test_pause(req, "promotion-leaf-validated")?;
            if let Err(error) = promotion_rename_exchange(
                parent.as_raw_fd(),
                &source,
                parent.as_raw_fd(),
                destination,
            ) {
                if promotion_rename_unsupported(&error) {
                    return Err("promotion bound rename mode is unsupported".to_string());
                }
                return Err(format!("promotion exchange failed: {error}"));
            }
            promotion_test_pause(req, "promotion-syscall")?;
            let post_destination = observe_promotion_leaf(parent.as_raw_fd(), destination);
            let post_source = observe_promotion_leaf(parent.as_raw_fd(), &source);
            let mut post_error = None;
            if !post_destination
                .as_ref()
                .ok()
                .and_then(|observed| observed.as_ref())
                .is_some_and(|observed| {
                    promotion_expected_matches(&expected_source, Some(observed))
                })
                || !post_source
                    .as_ref()
                    .ok()
                    .and_then(|observed| observed.as_ref())
                    .is_some_and(|observed| {
                        promotion_expected_matches(&expected_destination, Some(observed))
                    })
            {
                post_error =
                    Some("promotion exchange changed an operand after mutation".to_string());
            }
            if let Err(error) = parent.sync_all() {
                post_error = Some(format!("promotion parent durability failed: {error}"));
            }
            if let Some(error) = post_error {
                return Ok(promotion_transition_result(
                    "exchange",
                    "conflict-after-mutation",
                    false,
                    None,
                    Some(error),
                ));
            }
            Ok(promotion_transition_result(
                "exchange", "applied", true, None, None,
            ))
        }
        "install" => {
            let source_root_path = transition
                .get("sourceRoot")
                .and_then(Value::as_str)
                .ok_or("install sourceRoot is missing")?;
            let source_root_identity = promotion_identity_from_value(
                transition
                    .get("sourceRootIdentity")
                    .ok_or("install sourceRootIdentity is missing")?,
                "install sourceRootIdentity",
            )?;
            let source_root = open_promotion_bound_root_values(
                source_root_path,
                Some(source_root_identity),
                transition
                    .get("sourceRootCapability")
                    .and_then(Value::as_str),
                "install sourceRoot",
            )?
            .0;
            // Reuse the same strict component validation as destination paths
            // while keeping this source tree explicitly separate.
            let source_components = promotion_components_value(
                transition
                    .get("sourceComponents")
                    .ok_or("install sourceComponents is missing")?,
                "install sourceComponents",
            )?;
            let source_name = source_components
                .last()
                .ok_or("install sourceComponents is missing")?;
            let source_parent =
                open_promotion_parent(&source_root, &source_components, "install source")?;
            let source_parent_identity = promotion_identity_from_value(
                transition
                    .get("sourceParentIdentity")
                    .ok_or("install sourceParentIdentity is missing")?,
                "install sourceParentIdentity",
            )?;
            promotion_directory_identity_matches(
                &source_parent,
                source_parent_identity,
                "install source parent",
            )?;
            if source_parent_identity == parent_identity && source_name.0 == destination_name.0 {
                // Same names under equal identities identify one namespace
                // entry, never two independent install operands.
                return Err("promotion install source and destination must differ".to_string());
            }
            let expected_source = parse_promotion_expected(
                transition
                    .get("expectedSource")
                    .ok_or("install expectedSource is missing")?,
                "install expectedSource",
            )?;
            let expected_destination = parse_promotion_expected_destination(
                transition
                    .get("expectedDestination")
                    .ok_or("install expectedDestination is missing")?,
                "install expectedDestination",
            )?;
            if expected_destination
                .as_ref()
                .is_some_and(|expected| expected.identity == expected_source.identity)
            {
                return Err("promotion install identities must differ".to_string());
            }
            let observed_source =
                observe_promotion_leaf(source_parent.as_raw_fd(), &source_name.1)?;
            let observed_destination = observe_promotion_leaf(parent.as_raw_fd(), destination)?;
            if !promotion_expected_matches(&expected_source, observed_source.as_ref()) {
                return Err(format!(
                    "promotion install expected {} source identity was not present",
                    promotion_expected_state_description(&expected_source),
                ));
            }
            let destination_matches = match (&expected_destination, &observed_destination) {
                (None, None) => true,
                (Some(expected), Some(observed)) => {
                    promotion_expected_matches(expected, Some(observed))
                }
                _ => false,
            };
            if !destination_matches {
                return Err(
                    "promotion install expected destination state was not present".to_string(),
                );
            }
            promotion_test_pause(req, "promotion-leaf-validated")?;
            let rename_result = if expected_destination.is_some() {
                promotion_rename_exchange(
                    source_parent.as_raw_fd(),
                    &source_name.1,
                    parent.as_raw_fd(),
                    destination,
                )
            } else {
                promotion_rename_noreplace(
                    source_parent.as_raw_fd(),
                    &source_name.1,
                    parent.as_raw_fd(),
                    destination,
                )
            };
            if let Err(error) = rename_result {
                if promotion_rename_unsupported(&error) {
                    return Err("promotion bound rename mode is unsupported".to_string());
                }
                return Err(format!("promotion install failed: {error}"));
            }
            promotion_test_pause(req, "promotion-syscall")?;
            let post_destination = observe_promotion_leaf(parent.as_raw_fd(), destination);
            let post_source = observe_promotion_leaf(source_parent.as_raw_fd(), &source_name.1);
            let mut post_error = None;
            let destination_is_expected = post_destination
                .as_ref()
                .ok()
                .and_then(|observed| observed.as_ref())
                .is_some_and(|observed| {
                    promotion_expected_matches(&expected_source, Some(observed))
                });
            let source_is_expected = match &expected_destination {
                None => post_source
                    .as_ref()
                    .ok()
                    .and_then(|observed| observed.as_ref())
                    .is_none(),
                Some(expected) => post_source
                    .as_ref()
                    .ok()
                    .and_then(|observed| observed.as_ref())
                    .is_some_and(|observed| promotion_expected_matches(expected, Some(observed))),
            };
            if !destination_is_expected || !source_is_expected {
                post_error =
                    Some("promotion install changed an operand after mutation".to_string());
            }
            if let Err(error) = parent.sync_all() {
                post_error = Some(format!(
                    "promotion destination parent durability failed: {error}"
                ));
            }
            if let Err(error) = source_parent.sync_all() {
                post_error = Some(format!(
                    "promotion source parent durability failed: {error}"
                ));
            }
            if let Some(error) = post_error {
                return Ok(promotion_transition_result(
                    "install",
                    "conflict-after-mutation",
                    false,
                    None,
                    Some(error),
                ));
            }
            Ok(promotion_transition_result(
                "install", "applied", true, None, None,
            ))
        }
        "retire" => {
            let (retained_name, retained) = promotion_name(
                transition
                    .get("retainedName")
                    .ok_or("retire retainedName is missing")?,
                "retainedName",
                ".termina-promotion-retained-",
            )?;
            if retained_name == destination_name.0 {
                return Err(
                    "promotion retire retained and destination names must differ".to_string(),
                );
            }
            let external_retained_fields = [
                transition.get("retainedRoot"),
                transition.get("retainedRootIdentity"),
                transition.get("retainedComponents"),
                transition.get("retainedParentIdentity"),
            ];
            let external_retained = external_retained_fields.iter().any(Option::is_some);
            if external_retained && external_retained_fields.iter().any(Option::is_none) {
                return Err("promotion retire retained destination is incomplete".to_string());
            }
            let (retained_parent, retained) = if external_retained {
                let retained_root_path = transition
                    .get("retainedRoot")
                    .and_then(Value::as_str)
                    .ok_or("retire retainedRoot is missing")?;
                let retained_root_identity = promotion_identity_from_value(
                    transition
                        .get("retainedRootIdentity")
                        .ok_or("retire retainedRootIdentity is missing")?,
                    "retire retainedRootIdentity",
                )?;
                let retained_root = open_promotion_bound_root_values(
                    retained_root_path,
                    Some(retained_root_identity),
                    transition
                        .get("retainedRootCapability")
                        .and_then(Value::as_str),
                    "retire retainedRoot",
                )?
                .0;
                let retained_components = promotion_components_value(
                    transition
                        .get("retainedComponents")
                        .ok_or("retire retainedComponents is missing")?,
                    "retire retainedComponents",
                )?;
                let retained_leaf = retained_components
                    .last()
                    .ok_or("retire retainedComponents is missing")?;
                if retained_leaf.0 != retained_name {
                    return Err("retire retainedName does not match retainedComponents".to_string());
                }
                let retained_parent =
                    open_promotion_parent(&retained_root, &retained_components, "retire retained")?;
                let retained_parent_identity = promotion_identity_from_value(
                    transition
                        .get("retainedParentIdentity")
                        .ok_or("retire retainedParentIdentity is missing")?,
                    "retire retainedParentIdentity",
                )?;
                promotion_directory_identity_matches(
                    &retained_parent,
                    retained_parent_identity,
                    "retire retained parent",
                )?;
                (retained_parent, retained_leaf.1.clone())
            } else {
                (
                    parent.try_clone().map_err(|error| {
                        format!("clone promotion retire parent failed: {error}")
                    })?,
                    retained,
                )
            };
            let expected_destination = parse_promotion_expected(
                transition
                    .get("expectedDestination")
                    .ok_or("retire expectedDestination is missing")?,
                "expectedDestination",
            )?;
            let observed_destination = observe_promotion_leaf(parent.as_raw_fd(), destination)?;
            let observed_retained = observe_promotion_leaf(retained_parent.as_raw_fd(), &retained)?;
            if !promotion_expected_matches(&expected_destination, observed_destination.as_ref()) {
                return Err(format!(
                    "promotion retire expected {} identity was not present",
                    promotion_expected_state_description(&expected_destination),
                ));
            }
            if observed_retained.is_some() {
                return Err("promotion retire retained name is occupied".to_string());
            }
            promotion_test_pause(req, "promotion-leaf-validated")?;
            if let Err(error) = promotion_rename_noreplace(
                parent.as_raw_fd(),
                destination,
                retained_parent.as_raw_fd(),
                &retained,
            ) {
                if promotion_rename_unsupported(&error) {
                    return Err("promotion bound rename mode is unsupported".to_string());
                }
                return Err(format!("promotion retire failed: {error}"));
            }
            promotion_test_pause(req, "promotion-syscall")?;
            let post_destination = observe_promotion_leaf(parent.as_raw_fd(), destination);
            let post_retained = observe_promotion_leaf(retained_parent.as_raw_fd(), &retained);
            let mut post_error = None;
            if post_destination
                .as_ref()
                .ok()
                .and_then(|observed| observed.as_ref())
                .is_some()
                || !post_retained
                    .as_ref()
                    .ok()
                    .and_then(|observed| observed.as_ref())
                    .is_some_and(|observed| {
                        promotion_expected_matches(&expected_destination, Some(observed))
                    })
            {
                post_error = Some("promotion retire changed an operand after mutation".to_string());
            }
            if let Err(error) = parent.sync_all() {
                post_error = Some(format!("promotion parent durability failed: {error}"));
            }
            if let Err(error) = retained_parent.sync_all() {
                post_error = Some(format!(
                    "promotion retained parent durability failed: {error}"
                ));
            }
            if let Some(error) = post_error {
                return Ok(promotion_transition_result(
                    "retire",
                    "conflict-after-mutation",
                    false,
                    Some(&retained_name),
                    Some(error),
                ));
            }
            Ok(promotion_transition_result(
                "retire",
                "applied",
                true,
                Some(&retained_name),
                None,
            ))
        }
        _ => Err("unsupported promotion transition kind".to_string()),
    }
}

pub(crate) fn hook_matches(rel_path: &str, hook_path: &str) -> bool {
    rel_path == hook_path
        || (rel_path.len() > hook_path.len()
            && rel_path.ends_with(hook_path)
            && rel_path.as_bytes()[rel_path.len() - hook_path.len() - 1] == b'/')
}
