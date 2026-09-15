//! In-place descriptor-bound unlink of a directory's contents.
use std::ffi::CString;
use std::fs;
use std::os::fd::AsRawFd;

use serde_json::Value;

use crate::{
    PROMOTION_DIRECTORY_MAX_DEPTH,
    PROMOTION_DIRECTORY_MAX_NAME_BYTES,
    PROMOTION_QUARANTINE_MAX_BYTES,
    PROMOTION_QUARANTINE_MAX_ENTRIES,
};
use crate::util::{
    missing_path,
    open_at,
    read_link_at,
    stat_at,
    stat_file,
};
use crate::FileIdentity;
use crate::promote_fs::{
    PromotionDirectoryStream,
    promotion_add_work,
    promotion_child_relative,
    promotion_path_work_bytes,
    promotion_test_pause,
    promotion_unlink_at_field,
};
use crate::promotion_files::promotion_cleanup_same_namespace_identity;

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
    // Invariant: last/pop see a frame while the stack is non-empty.
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
        // Bounded relative path (PROMOTION_PATH_MAX_BYTES). Clone keeps this
        // frame's walk identity while later last()/push() reborrow the stack.
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
