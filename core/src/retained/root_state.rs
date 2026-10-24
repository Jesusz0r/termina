//! Retained root state: parse, read, persist, and replace.
use std::ffi::{CStr, CString};
use std::fs;

use serde_json::{Value, json};

use crate::FileIdentity;
use crate::PROMOTION_COMPONENT_MAX_BYTES;
use crate::promote_fs::PromotionIdentity;

use super::RETAINED_ROOT_PROVENANCE_MAX_BYTES;
use super::durable_identity::{durable_directory_identity, resolve_root_record};
use super::private_files::{
    promotion_private_temporary_name, promotion_publish_root_metadata,
    promotion_read_private_bounded_if_present,
};

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

pub(crate) fn promotion_root_state_name(
    provenance_name: &str,
) -> Result<(String, CString), String> {
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
    parent: &fs::File,
    root: &fs::File,
) -> Result<Vec<u8>, String> {
    let state = match kind {
        PromotionRootStateKind::Pending => "pending",
        PromotionRootStateKind::Bound => "bound",
    };
    serde_json::to_vec(&json!({
        "version": 2,
        "state": state,
        "path": path,
        "parent": durable_directory_identity(parent)?,
        "root": durable_directory_identity(root)?,
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
    let (path, parent, root) = resolve_root_record(&value, field, true)?;
    let kind = match value.get("state").and_then(Value::as_str) {
        Some("pending") => PromotionRootStateKind::Pending,
        Some("bound") => PromotionRootStateKind::Bound,
        _ => return Err(format!("{field} has an invalid state")),
    };
    Ok(PromotionRootState {
        kind,
        path: path.to_string(),
        parent,
        root,
        identity,
    })
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
    )?
    else {
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
    )?
    else {
        return Ok(None);
    };
    let state = promotion_parse_root_state(&bytes, "promotion root state temporary", identity)?;
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
    promotion_publish_root_metadata(parent, name, content, "promotion root state", pause_stage)
}
