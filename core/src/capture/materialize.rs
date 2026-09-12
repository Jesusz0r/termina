//! Workdir materialization: stale removal and entry writes.
use std::collections::HashSet;
use std::ffi::{CStr, CString};
use std::fs;
use std::os::fd::{AsRawFd, RawFd};

use git2::{Oid, Repository};
use serde_json::Value;
use crate::{
    BUDGET_MAX_FILE_BYTES,
    PROMOTION_COMPONENT_MAX_BYTES,
    PROMOTION_DIRECTORY_MAX_DEPTH,
    PROMOTION_DIRECTORY_MAX_ENTRIES,
    PROMOTION_DIRECTORY_MAX_NAME_BYTES,
    PROMOTION_PATH_MAX_BYTES,
    PROMOTION_QUARANTINE_MAX_BYTES,
    PROMOTION_QUARANTINE_MAX_ENTRIES,
};
use crate::util::{
    has_git_segment,
    is_safe_relative,
    missing_path,
    open_at,
    open_at_mode,
    read_link_at,
    stat_at,
    stat_file,
};
use crate::FileIdentity;
use crate::promote_fs::{
    PromotionDirectoryStream,
    PromotionIdentity,
    open_or_create_promotion_parent,
    promotion_add_work,
    promotion_bound_path_matches,
    promotion_child_relative,
    promotion_component,
    promotion_directory_identity_matches,
    promotion_path_work_bytes,
    promotion_set_mode,
    promotion_symlink_at,
    promotion_test_pause,
    promotion_unlink_at_field,
    promotion_write_all,
};
use crate::promotion_files::promotion_cleanup_same_namespace_identity;

use super::walk::{git_blob_bytes_bounded, state_entries};

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
