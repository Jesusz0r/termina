//! Identity-bound copy engine: copy budgets, frames, tree contents,
//! leaf results, expected directories, and small content decoders.
use std::ffi::CString;
use std::fs;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;

use serde_json::{Value, json};

use crate::{
    PROMOTION_COMPONENT_MAX_BYTES, PROMOTION_DIRECTORY_MAX_DEPTH, PROMOTION_PATH_MAX_BYTES,
    missing_path, open_at, open_at_mode, stat_at, stat_file,
};
use crate::FileIdentity;
use crate::promote_fs::{
    PromotionDirectoryStream, PromotionIdentity, PromotionObservedLeaf, PromotionObservedState,
    promotion_child_relative, promotion_identity_from_value, promotion_mkdir_at,
    promotion_set_mode, promotion_symlink_at,
};
use crate::capture::read_link_at;

/// Copy the contents of one identity-bound directory into another.  Every
/// source and destination component is opened relative to a descriptor and
/// checked again after its bytes/name have been observed.  This is deliberately
/// a native primitive: a TypeScript `cp -R` would discard the allocation
/// capability and can follow a same-UID ancestor replacement.
pub(crate) struct PromotionCopyBudget {
    pub(crate) bytes: u64,
    pub(crate) entries: usize,
    pub(crate) work_bytes: u64,
    pub(crate) max_bytes: u64,
    pub(crate) max_entries: usize,
    pub(crate) max_work_bytes: u64,
}

impl PromotionCopyBudget {
    fn charge_entry(&mut self) -> Result<(), String> {
        self.entries = self
            .entries
            .checked_add(1)
            .ok_or("promotion tree copy entry count overflow")?;
        if self.entries > self.max_entries {
            return Err("promotion tree copy exceeds its entry bound".to_string());
        }
        Ok(())
    }

    fn charge_bytes(&mut self, amount: u64) -> Result<(), String> {
        self.bytes = self
            .bytes
            .checked_add(amount)
            .ok_or("promotion tree copy byte accounting overflow")?;
        if self.bytes > self.max_bytes {
            return Err("promotion tree copy exceeds its byte bound".to_string());
        }
        Ok(())
    }

    fn charge_work(&mut self, amount: u64) -> Result<(), String> {
        self.work_bytes = self
            .work_bytes
            .checked_add(amount)
            .ok_or("promotion tree copy work accounting overflow")?;
        if self.work_bytes > self.max_work_bytes {
            return Err("promotion tree copy exceeds its work bound".to_string());
        }
        Ok(())
    }
}

pub(crate) fn promotion_copy_path_len(relative: &str, name: &str) -> Result<usize, String> {
    if name.is_empty() || name.len() > PROMOTION_COMPONENT_MAX_BYTES {
        return Err("promotion tree copy entry name is invalid".to_string());
    }
    relative
        .len()
        .checked_add(if relative.is_empty() { 0 } else { 1 })
        .and_then(|length| length.checked_add(name.len()))
        .filter(|length| *length <= PROMOTION_PATH_MAX_BYTES)
        .ok_or_else(|| "promotion traversal path exceeds its bounded work budget".to_string())
}

pub(crate) struct PromotionCopyFrame {
    source: fs::File,
    destination: fs::File,
    stream: PromotionDirectoryStream,
    relative: String,
    parent_name: Option<CString>,
    identity: Option<FileIdentity>,
}

pub(crate) fn promotion_copy_tree_contents(
    source: &fs::File,
    destination: &fs::File,
    budget: &mut PromotionCopyBudget,
    relative: &str,
) -> Result<(), String> {
    let root_work = u64::try_from(relative.len())
        .map_err(|_| "promotion tree copy root work accounting overflow")?
        .checked_add(std::mem::size_of::<FileIdentity>() as u64)
        .ok_or("promotion tree copy root work accounting overflow")?;
    budget.charge_work(root_work)?;
    let stream = PromotionDirectoryStream::open(source.as_raw_fd())?;
    let mut stack = Vec::with_capacity(PROMOTION_DIRECTORY_MAX_DEPTH);
    stack.push(PromotionCopyFrame {
        source: source.try_clone().map_err(|error| format!("clone promotion tree source failed: {error}"))?,
        destination: destination.try_clone().map_err(|error| format!("clone promotion tree destination failed: {error}"))?,
        stream,
        relative: relative.to_string(),
        parent_name: None,
        identity: None,
    });
    while !stack.is_empty() {
        let next = stack
            .last_mut()
            .expect("promotion copy stack is not empty")
            .stream
            .next_entry()?;
        let Some((name, c_name)) = next else {
            let frame = stack.pop().expect("promotion copy frame exists");
            if let (Some(parent_name), Some(source_identity)) =
                (frame.parent_name.as_ref(), frame.identity)
            {
                let parent = stack
                    .last()
                    .ok_or("promotion copy parent frame is missing")?;
                promotion_set_mode(
                    &frame.destination,
                    source_identity.mode & 0o777,
                    &frame.relative,
                )?;
                frame.destination.sync_all().map_err(|error| {
                    format!("sync promotion tree directory {} failed: {error}", frame.relative)
                })?;
                let source_after = stat_file(&frame.source).map_err(|error| {
                    format!("fstat promotion tree source {} failed: {error}", frame.relative)
                })?;
                let destination_after = stat_file(&frame.destination).map_err(|error| {
                    format!("fstat promotion tree destination {} failed: {error}", frame.relative)
                })?;
                let destination_path = stat_at(parent.destination.as_raw_fd(), parent_name).map_err(|error| {
                    format!("stat promotion tree destination {} failed: {error}", frame.relative)
                })?;
                if source_after != source_identity
                    || destination_after != destination_path
                    || !destination_after.is_dir()
                {
                    return Err(format!("promotion tree {} changed during copy", frame.relative));
                }
                parent.destination.sync_all().map_err(|error| {
                    format!("sync promotion tree parent for {} failed: {error}", frame.relative)
                })?;
            }
            continue;
        };
        budget.charge_entry()?;
        let (source_fd, destination_fd, relative) = {
            let frame = stack.last().expect("promotion copy frame exists");
            (
                frame.source.as_raw_fd(),
                frame.destination.as_raw_fd(),
                frame.relative.clone(),
            )
        };
        let path_len = promotion_copy_path_len(&relative, &name)?;
        let work = u64::try_from(path_len)
            .map_err(|_| "promotion tree copy work accounting overflow")?
            .checked_add(
                u64::try_from(name.len())
                    .map_err(|_| "promotion tree copy work accounting overflow")?,
            )
            .and_then(|value| {
                value.checked_add(std::mem::size_of::<FileIdentity>() as u64)
            })
            .ok_or("promotion tree copy work accounting overflow")?;
        budget.charge_work(work)?;
        let child_relative = promotion_child_relative(&relative, &name)?;
        let source_identity = stat_at(source_fd, &c_name).map_err(|error| {
            format!("stat promotion tree source {child_relative} failed: {error}")
        })?;
        if !source_identity.is_dir() && !source_identity.is_file() && !source_identity.is_symlink()
        {
            return Err(format!(
                "promotion tree source {child_relative} has an unsupported file type"
            ));
        }
        match stat_at(destination_fd, &c_name) {
            Ok(_) => {
                return Err(format!(
                    "promotion tree destination {child_relative} is occupied"
                ));
            }
            Err(error) if missing_path(&error) => {}
            Err(error) => {
                return Err(format!(
                    "stat promotion tree destination {child_relative} failed: {error}"
                ));
            }
        }
        if source_identity.is_dir() && !source_identity.is_symlink() {
            if stack.len() >= PROMOTION_DIRECTORY_MAX_DEPTH {
                return Err("promotion tree copy exceeds its depth bound".to_string());
            }
            promotion_mkdir_at(destination_fd, &c_name, 0o700).map_err(|error| {
                format!("create promotion tree directory {child_relative} failed: {error}")
            })?;
            let source_child = open_at(
                source_fd,
                &c_name,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|error| {
                format!("open promotion tree source {child_relative} failed: {error}")
            })?;
            let destination_child = open_at(
                destination_fd,
                &c_name,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|error| {
                format!("open promotion tree destination {child_relative} failed: {error}")
            })?;
            let opened_source = stat_file(&source_child).map_err(|error| {
                format!("fstat promotion tree source {child_relative} failed: {error}")
            })?;
            if opened_source != source_identity {
                return Err(format!(
                    "promotion tree source {child_relative} changed while opening"
                ));
            }
            let child_stream = PromotionDirectoryStream::open(source_child.as_raw_fd())?;
            stack.push(PromotionCopyFrame {
                source: source_child,
                destination: destination_child,
                stream: child_stream,
                relative: child_relative,
                parent_name: Some(c_name),
                identity: Some(source_identity),
            });
            continue;
        }
        if source_identity.is_symlink() {
            let target = read_link_at(source_fd, &c_name).map_err(|error| {
                format!("read promotion tree symlink {child_relative} failed: {error}")
            })?;
            if target.len() > PROMOTION_PATH_MAX_BYTES {
                return Err(format!("promotion tree symlink {child_relative} is too long"));
            }
            budget.charge_bytes(
                u64::try_from(target.len())
                    .map_err(|_| "promotion tree symlink byte accounting overflow")?,
            )?;
            let target_c = CString::new(target.clone())
                .map_err(|_| format!("promotion tree symlink {child_relative} contains NUL"))?;
            promotion_symlink_at(&target_c, destination_fd, &c_name).map_err(|error| {
                format!("create promotion tree symlink {child_relative} failed: {error}")
            })?;
            let destination_after = stat_at(destination_fd, &c_name).map_err(|error| {
                format!("stat promotion tree symlink {child_relative} failed: {error}")
            })?;
            let target_after = read_link_at(destination_fd, &c_name).map_err(|error| {
                format!("read promotion tree symlink {child_relative} failed: {error}")
            })?;
            let source_after = stat_at(source_fd, &c_name).map_err(|error| {
                format!("stat promotion tree symlink {child_relative} failed: {error}")
            })?;
            if !destination_after.is_symlink()
                || source_after != source_identity
                || target_after != target
            {
                return Err(format!("promotion tree symlink {child_relative} changed during copy"));
            }
            stack.last().expect("promotion copy frame exists").destination.sync_all().map_err(|error| {
                format!("sync promotion tree symlink parent for {child_relative} failed: {error}")
            })?;
            continue;
        }
        let mut source_file = open_at(
            source_fd,
            &c_name,
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
        .map_err(|error| {
            format!("open promotion tree source file {child_relative} failed: {error}")
        })?;
        let opened_source = stat_file(&source_file).map_err(|error| {
            format!("fstat promotion tree source file {child_relative} failed: {error}")
        })?;
        if opened_source != source_identity || !opened_source.is_file() {
            return Err(format!(
                "promotion tree source file {child_relative} changed while opening"
            ));
        }
        budget.charge_bytes(source_identity.len)?;
        let mut destination_file = open_at_mode(
            destination_fd,
            &c_name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
        .map_err(|error| {
            format!("create promotion tree destination file {child_relative} failed: {error}")
        })?;
        let mut copied = 0u64;
        let mut chunk = [0u8; 64 * 1024];
        loop {
            let read = source_file.read(&mut chunk).map_err(|error| {
                format!("read promotion tree source file {child_relative} failed: {error}")
            })?;
            if read == 0 {
                break;
            }
            let read = u64::try_from(read).map_err(|_| "promotion tree copy byte overflow")?;
            let available = source_identity
                .len
                .checked_sub(copied)
                .ok_or("promotion tree source file exceeded its observed length")?;
            if read > available {
                return Err("promotion tree source file grew during copy".to_string());
            }
            destination_file
                .write_all(&chunk[..read as usize])
                .map_err(|error| format!("write promotion tree destination file {child_relative} failed: {error}"))?;
            copied = copied
                .checked_add(read)
                .ok_or("promotion tree copy byte accounting overflow")?;
        }
        let source_after = stat_file(&source_file).map_err(|error| {
            format!("fstat promotion tree source file {child_relative} failed: {error}")
        })?;
        if source_after != source_identity || source_after.len != copied {
            return Err(format!(
                "promotion tree source file {child_relative} changed while reading"
            ));
        }
        promotion_set_mode(&destination_file, source_identity.mode & 0o777, &child_relative)?;
        destination_file.sync_all().map_err(|error| {
            format!("sync promotion tree destination file {child_relative} failed: {error}")
        })?;
        let destination_after = stat_file(&destination_file).map_err(|error| {
            format!("fstat promotion tree destination file {child_relative} failed: {error}")
        })?;
        let destination_path = stat_at(destination_fd, &c_name).map_err(|error| {
            format!("stat promotion tree destination file {child_relative} failed: {error}")
        })?;
        if destination_after != destination_path
            || !destination_after.is_file()
            || destination_after.len != copied
        {
            return Err(format!(
                "promotion tree destination file {child_relative} changed during copy"
            ));
        }
        if copied != source_identity.len {
            return Err("promotion tree source file changed its length during copy".to_string());
        }
        stack.last().expect("promotion copy frame exists").destination.sync_all().map_err(|error| {
            format!("sync promotion tree parent for {child_relative} failed: {error}")
        })?;
    }
    Ok(())
}


pub(crate) fn promotion_leaf_result(observed: &PromotionObservedLeaf) -> Value {
    let state = match &observed.state {
        PromotionObservedState::File { mode, size, sha256 } => json!({
            "type": "file",
            "mode": mode,
            "size": size.to_string(),
            "sha256": sha256,
        }),
        PromotionObservedState::Symlink { target } => {
            json!({ "type": "symlink", "target": target })
        }
        PromotionObservedState::Other => json!({ "type": "other" }),
    };
    json!({
        "identity": {
            "dev": observed.identity.dev.to_string(),
            "ino": observed.identity.ino.to_string(),
        },
        "state": state,
    })
}


pub(crate) fn promotion_expected_directory(
    value: &Value,
    field: &str,
) -> Result<(PromotionIdentity, u32), String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{field} must be an object"))?;
    let identity = promotion_identity_from_value(
        object
            .get("identity")
            .ok_or_else(|| format!("{field}.identity is missing"))?,
        &format!("{field}.identity"),
    )?;
    let mode = object
        .get("mode")
        .and_then(Value::as_u64)
        .filter(|mode| *mode <= 0o777)
        .ok_or_else(|| format!("{field}.mode is invalid"))? as u32;
    Ok((identity, mode))
}
