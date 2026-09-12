//! Retained root state: parse, read, persist, and replace.
use std::ffi::{CStr, CString};
use std::fs;
use std::io;
use std::os::fd::AsRawFd;

use serde_json::{Value, json};

use crate::util::{
    open_at,
    open_at_mode,
};
use crate::FileIdentity;
use crate::PROMOTION_COMPONENT_MAX_BYTES;
use crate::promote_fs::{
    PromotionIdentity,
    promotion_absolute_path,
    promotion_identity_from_value,
    promotion_private_identity_valid,
    promotion_set_mode,
    promotion_test_pause,
    promotion_write_all,
    stat_promotion_journal_file,
    stat_promotion_private_at,
};

use super::RETAINED_ROOT_PROVENANCE_MAX_BYTES;
use super::private_files::{promotion_private_temporary_name, promotion_publish_private_exclusive, promotion_read_private_bounded_file, promotion_read_private_bounded_if_present, promotion_read_private_bounded_opened};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PromotionRootStateKind {
    Pending,
    Bound,
}

#[derive(Clone, Debug)]
pub(crate) struct PromotionRootState {
    pub(crate) kind: PromotionRootStateKind,
    pub(crate) path: String,
    pub(crate) parent: PromotionIdentity,
    pub(crate) root: PromotionIdentity,
    pub(crate) identity: FileIdentity,
}

pub(crate) fn promotion_root_state_name(provenance_name: &str) -> Result<(String, CString), String> {
    let name = format!("{provenance_name}.state");
    if name.len() > PROMOTION_COMPONENT_MAX_BYTES {
        return Err("promotion root state name is too long".to_string());
    }
    let c_name = CString::new(name.as_bytes())
        .map_err(|_| "promotion root state name contains NUL".to_string())?;
    Ok((name, c_name))
}

pub(crate) fn promotion_root_state_content(
    kind: PromotionRootStateKind,
    path: &str,
    parent: PromotionIdentity,
    root: PromotionIdentity,
) -> Result<Vec<u8>, String> {
    let state = match kind {
        PromotionRootStateKind::Pending => "pending",
        PromotionRootStateKind::Bound => "bound",
    };
    serde_json::to_vec(&json!({
        "version": 1,
        "state": state,
        "path": path,
        "parent": { "dev": parent.dev.to_string(), "ino": parent.ino.to_string() },
        "root": { "dev": root.dev.to_string(), "ino": root.ino.to_string() },
    }))
    .map_err(|error| format!("serialize promotion root state failed: {error}"))
}

pub(crate) fn promotion_parse_root_state(
    content: &[u8],
    field: &str,
    identity: FileIdentity,
) -> Result<PromotionRootState, String> {
    let value: Value = serde_json::from_slice(content)
        .map_err(|error| format!("{field} is malformed: {error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| format!("{field} is malformed"))?;
    if object.len() != 5 || object.get("version") != Some(&json!(1)) {
        return Err(format!("{field} is malformed"));
    }
    let kind = match object.get("state").and_then(Value::as_str) {
        Some("pending") => PromotionRootStateKind::Pending,
        Some("bound") => PromotionRootStateKind::Bound,
        _ => return Err(format!("{field} has an invalid state")),
    };
    let path = object
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{field}.path is missing"))?;
    promotion_absolute_path(path, &format!("{field}.path"))?;
    let parent = promotion_identity_from_value(
        object
            .get("parent")
            .ok_or_else(|| format!("{field}.parent is missing"))?,
        &format!("{field}.parent"),
    )?;
    let root = promotion_identity_from_value(
        object
            .get("root")
            .ok_or_else(|| format!("{field}.root is missing"))?,
        &format!("{field}.root"),
    )?;
    Ok(PromotionRootState { kind, path: path.to_string(), parent, root, identity })
}

pub(crate) fn promotion_read_root_state(
    parent: &fs::File,
    name: &CStr,
) -> Result<Option<PromotionRootState>, String> {
    let Some((identity, bytes)) = promotion_read_private_bounded_if_present(
        parent,
        name,
        RETAINED_ROOT_PROVENANCE_MAX_BYTES,
        "promotion root state",
    )? else {
        return Ok(None);
    };
    Ok(Some(promotion_parse_root_state(
        &bytes,
        "promotion root state",
        identity,
    )?))
}

/// Read the sole deterministic pending-state recovery slot. A temporary state
/// is admissible only as an identity-bound continuation: it must be a private
/// regular file with one link, parse as `pending`, and later match the opened
/// root before the slot is promoted to the final state name. A marker or
/// mutable tree is never used as a substitute for this record.
pub(crate) fn promotion_read_root_state_temporary(
    parent: &fs::File,
    name: &CStr,
) -> Result<Option<PromotionRootState>, String> {
    let temporary = promotion_private_temporary_name(name)?;
    let Some((identity, bytes)) = promotion_read_private_bounded_if_present(
        parent,
        &temporary,
        RETAINED_ROOT_PROVENANCE_MAX_BYTES,
        "promotion root state temporary",
    )? else {
        return Ok(None);
    };
    let state = promotion_parse_root_state(
        &bytes,
        "promotion root state temporary",
        identity,
    )?;
    if state.kind != PromotionRootStateKind::Pending {
        return Err("promotion root state temporary is not pending".to_string());
    }
    Ok(Some(state))
}

/// Create the durable pending tombstone through the same atomic private-file
/// publisher as provenance. A racing creator is accepted only when it
/// published byte-identical state for the same root; all other contents fail
/// closed.
pub(crate) fn promotion_persist_root_state(
    parent: &fs::File,
    name: &CStr,
    content: &[u8],
    pause_stage: Option<(&Value, &str)>,
) -> Result<FileIdentity, String> {
    promotion_publish_private_exclusive(
        parent,
        name,
        content,
        0o600,
        RETAINED_ROOT_PROVENANCE_MAX_BYTES,
        "promotion root state",
        pause_stage,
    )
}

/// Atomically advance a pending state to bound. The old pending record is
/// retained until the descriptor-bound replacement is durable, so a crash
/// before the rename is resumable; a corrupt/replaced state is never
/// reconstructed from the mutable root or marker.
pub(crate) fn promotion_replace_root_state(
    parent: &fs::File,
    name: &CStr,
    expected_identity: FileIdentity,
    content: &[u8],
    req: &Value,
) -> Result<FileIdentity, String> {
    if content.len() > RETAINED_ROOT_PROVENANCE_MAX_BYTES {
        return Err("promotion root state exceeds its bounded metadata size".to_string());
    }
    let (current_identity, _) = promotion_read_private_bounded_file(
        parent,
        name,
        RETAINED_ROOT_PROVENANCE_MAX_BYTES,
        "promotion root state",
    )?;
    let current_stat = stat_promotion_private_at(parent.as_raw_fd(), name)
        .map_err(|error| format!("stat promotion root state failed: {error}"))?;
    if current_identity != expected_identity
        || current_stat.file != current_identity
        || !promotion_private_identity_valid(current_stat, Some(0o600), RETAINED_ROOT_PROVENANCE_MAX_BYTES)
    {
        return Err("promotion root state identity changed before commit".to_string());
    }
    // Derive one bounded recovery slot from the state name.  A deterministic
    // slot means a crash can leave at most one pending replacement per state;
    // repeated restarts cannot accumulate process/sequence-named temporaries.
    let state_name = name.to_bytes();
    let state_prefix = state_name
        .strip_suffix(b".state")
        .ok_or("promotion root state name has no bounded temporary suffix")?;
    let mut temporary_name = state_prefix.to_vec();
    temporary_name.extend_from_slice(b".tmp");
    if temporary_name.len() > PROMOTION_COMPONENT_MAX_BYTES {
        return Err("promotion root state temporary name is too long".to_string());
    }
    let temporary = CString::new(temporary_name)
        .map_err(|_| "promotion root state temporary name contains NUL".to_string())?;
    let temporary_file = match open_at(
        parent.as_raw_fd(),
        &temporary,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    ) {
        Ok(file) => {
            let temporary_identity = stat_promotion_journal_file(&file)
                .map_err(|error| format!("fstat existing promotion root state temporary failed: {error}"))?;
            if !promotion_private_identity_valid(
                temporary_identity,
                Some(0o600),
                RETAINED_ROOT_PROVENANCE_MAX_BYTES,
            ) {
                return Err("promotion root state temporary is not a bounded private app-owned file".to_string());
            }
            let (_, observed) = promotion_read_private_bounded_opened(
                parent,
                &temporary,
                file.try_clone().map_err(|error| {
                    format!("clone existing promotion root state temporary failed: {error}")
                })?,
                RETAINED_ROOT_PROVENANCE_MAX_BYTES,
                "existing promotion root state temporary",
            )?;
            if observed != content {
                return Err("promotion root state temporary identity mismatch".to_string());
            }
            file
        }
        Err(error) if error.raw_os_error() == Some(libc::ENOENT) => {
            let mut file = open_at_mode(
                parent.as_raw_fd(),
                &temporary,
                libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
            .map_err(|error| format!("create promotion root state temporary failed: {error}"))?;
            promotion_write_all(&mut file, content, "promotion root state temporary")?;
            promotion_set_mode(&file, 0o600, "promotion root state temporary")?;
            file
                .sync_all()
                .map_err(|error| format!("sync promotion root state temporary failed: {error}"))?;
            let temporary_identity = stat_promotion_journal_file(&file)
                .map_err(|error| format!("fstat promotion root state temporary failed: {error}"))?;
            let temporary_path_identity = stat_promotion_private_at(parent.as_raw_fd(), &temporary)
                .map_err(|error| format!("stat promotion root state temporary failed: {error}"))?;
            if temporary_identity != temporary_path_identity
                || !promotion_private_identity_valid(
                    temporary_identity,
                    Some(0o600),
                    RETAINED_ROOT_PROVENANCE_MAX_BYTES,
                )
                || temporary_identity.file.len != content.len() as u64
            {
                return Err("promotion root state temporary changed while writing".to_string());
            }
            file
        }
        Err(error) => return Err(format!("open promotion root state temporary failed: {error}")),
    };

    // A descriptor-relative rename replaces the old state atomically and
    // removes the temporary slot in the same namespace operation.  Unlike an
    // exchange, a crash after this point cannot strand the old state under a
    // second pathname; a crash before it leaves the one deterministic slot
    // above for idempotent recovery.
    parent
        .sync_all()
        .map_err(|error| format!("sync promotion root state temporary parent failed: {error}"))?;
    promotion_test_pause(req, "retained-root-before-bound-state-rename")?;
    let temporary_before = stat_promotion_journal_file(&temporary_file)
        .map_err(|error| format!("fstat promotion root state temporary failed: {error}"))?;
    let temporary_path_before = stat_promotion_private_at(parent.as_raw_fd(), &temporary)
        .map_err(|error| format!("stat promotion root state temporary failed: {error}"))?;
    if temporary_before != temporary_path_before
        || !promotion_private_identity_valid(
            temporary_before,
            Some(0o600),
            RETAINED_ROOT_PROVENANCE_MAX_BYTES,
        )
    {
        return Err("promotion root state temporary changed before commit".to_string());
    }
    // The rename replaces the pending final record. Revalidate that target
    // too after the pause: otherwise an attacker could swap the state
    // pathname while the temporary fd is held and make the replacement
    // silently overwrite an unbound record.
    let current_before_rename = stat_promotion_private_at(parent.as_raw_fd(), name)
        .map_err(|error| format!("stat promotion root state before commit failed: {error}"))?;
    if current_before_rename != current_stat
        || current_before_rename.file != current_identity
        || !promotion_private_identity_valid(
            current_before_rename,
            Some(0o600),
            RETAINED_ROOT_PROVENANCE_MAX_BYTES,
        )
    {
        return Err("promotion root state changed before commit".to_string());
    }
    unsafe {
        if libc::renameat(parent.as_raw_fd(), temporary.as_ptr(), parent.as_raw_fd(), name.as_ptr()) == -1 {
            return Err(format!("replace promotion root state failed: {}", io::Error::last_os_error()));
        }
    }
    parent
        .sync_all()
        .map_err(|error| format!("sync replaced promotion root state parent failed: {error}"))?;
    let final_stat = stat_promotion_private_at(parent.as_raw_fd(), name)
        .map_err(|error| format!("stat promotion root state failed: {error}"))?;
    let descriptor_after = stat_promotion_journal_file(&temporary_file)
        .map_err(|error| format!("fstat promotion root state after commit failed: {error}"))?;
    if descriptor_after != final_stat
        || !promotion_private_identity_valid(
            descriptor_after,
            Some(0o600),
            RETAINED_ROOT_PROVENANCE_MAX_BYTES,
        )
    {
        return Err("promotion root state changed during commit".to_string());
    }
    let (identity, observed) = promotion_read_private_bounded_opened(
        parent,
        name,
        temporary_file.try_clone().map_err(|error| {
            format!("clone promotion root state after commit failed: {error}")
        })?,
        RETAINED_ROOT_PROVENANCE_MAX_BYTES,
        "promotion root state",
    )?;
    if observed != content {
        return Err("promotion root state changed during commit".to_string());
    }
    Ok(identity)
}
