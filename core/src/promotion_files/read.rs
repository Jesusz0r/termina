//! Promotion-bound reads: journals and files.
use std::ffi::CString;
use std::io::Read;
use std::os::fd::AsRawFd;

use base64::Engine as _;
use serde_json::{Value, json};

use crate::PROMOTION_JOURNAL_MAX_BYTES;
use crate::util::{
    open_at,
    stat_at,
};
use crate::promote_fs::{
    open_promotion_bound_root,
    open_promotion_parent,
    promotion_component,
    promotion_components_for,
    promotion_directory_identity_matches,
    promotion_identity_from_value,
    promotion_test_pause,
    stat_promotion_journal_file,
};
use crate::retained::promotion_read_private_bounded_opened;

pub(crate) fn op_promotion_bound_read_journal(req: &Value) -> Result<Value, String> {
    let (root, _root_identity, _capability) = open_promotion_bound_root(
        req,
        "journalRoot",
        "journalRootIdentity",
        "journalRootCapability",
    )?;

    let (operation_name, operation) = promotion_component(
        req.get("operationName").ok_or("missing operationName")?,
        "operationName",
    )?;
    let operation_identity = promotion_identity_from_value(
        req.get("operationIdentity")
            .ok_or("missing operationIdentity")?,
        "operationIdentity",
    )?;
    let operation_dir = open_at(
        root.as_raw_fd(),
        &operation,
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )
    .map_err(|error| format!("open promotion operation directory failed: {error}"))?;
    promotion_directory_identity_matches(
        &operation_dir,
        operation_identity,
        "operation directory",
    )?;
    promotion_test_pause(req, "journal-operation-open")?;

    let journal_name = CString::new("journal.json").expect("constant has no NUL");
    let journal_file = open_at(
        operation_dir.as_raw_fd(),
        &journal_name,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
    )
    .map_err(|error| format!("open promotion journal failed: {error}"))?;
    promotion_test_pause(req, "journal-file-open")?;
    let raw = stat_promotion_journal_file(&journal_file)
        .map_err(|error| format!("fstat promotion journal failed: {error}"))?;
    if !raw.file.is_file()
        || raw.file.mode & 0o022 != 0
        || raw.uid != unsafe { libc::geteuid() as u64 }
        || raw.links != 1
        || raw.file.len > PROMOTION_JOURNAL_MAX_BYTES
    {
        return Err("promotion journal is not a bounded private regular file".to_string());
    }
    let mut bytes = Vec::new();
    let read_limit = PROMOTION_JOURNAL_MAX_BYTES
        .checked_add(1)
        .ok_or("promotion journal budget overflow")?;
    (&journal_file)
        .take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read promotion journal failed: {error}"))?;
    if bytes.len() as u64 > PROMOTION_JOURNAL_MAX_BYTES {
        return Err("promotion journal exceeds the 16 MiB read budget".to_string());
    }
    let after = stat_promotion_journal_file(&journal_file)
        .map_err(|error| format!("fstat promotion journal failed: {error}"))?;
    let path_after = stat_at(operation_dir.as_raw_fd(), &journal_name)
        .map_err(|error| format!("stat promotion journal failed: {error}"))?;
    if raw != after || after.file != path_after {
        return Err("promotion journal changed while reading".to_string());
    }
    Ok(json!({
        "content": base64::engine::general_purpose::STANDARD.encode(&bytes),
        "byteLength": bytes.len(),
        "operationName": operation_name,
    }))
}

/// Read one private regular file below a descriptor-bound parent.  This is
/// used for root provenance records, which live beside (rather than inside)
/// the mutable root leaf.  The retained private-file helper authenticates
/// the descriptor and pathname before and after the bounded read so a
/// pathname replacement cannot supply or alter the provenance bytes.
pub(crate) fn op_promotion_bound_read_file(req: &Value) -> Result<Value, String> {
    let (root, _root_identity, _capability) =
        open_promotion_bound_root(req, "root", "rootIdentity", "rootCapability")?;
    let components = promotion_components_for(req, "components")?;
    let parent = open_promotion_parent(&root, &components, "read")?;
    let parent_identity = promotion_identity_from_value(
        req.get("parentIdentity").ok_or("missing parentIdentity")?,
        "parentIdentity",
    )?;
    promotion_directory_identity_matches(&parent, parent_identity, "read parent")?;
    let (_, leaf) = components.last().expect("non-empty components");
    let expected = req
        .get("expectedIdentity")
        .map(|value| promotion_identity_from_value(value, "expectedIdentity"))
        .transpose()?;
    let max_bytes = req
        .get("maxBytes")
        .and_then(Value::as_u64)
        .unwrap_or(PROMOTION_JOURNAL_MAX_BYTES);
    if max_bytes == 0 || max_bytes > PROMOTION_JOURNAL_MAX_BYTES {
        return Err("promotion read file maxBytes exceeds the 16 MiB budget".to_string());
    }
    let file = open_at(
        parent.as_raw_fd(),
        leaf,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
    )
    .map_err(|error| format!("open promotion read file failed: {error}"))?;
    let (identity, bytes) = promotion_read_private_bounded_opened(
        &parent,
        leaf,
        file,
        max_bytes as usize,
        "promotion read file",
    )?;
    if let Some(expected) = expected {
        if identity.dev != expected.dev || identity.ino != expected.ino {
            return Err("promotion read file identity mismatch".to_string());
        }
    }
    Ok(json!({
        "content": base64::engine::general_purpose::STANDARD.encode(&bytes),
        "byteLength": bytes.len(),
        "identity": {
            "dev": identity.dev.to_string(),
            "ino": identity.ino.to_string(),
        },
    }))
}
