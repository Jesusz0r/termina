//! Expected/observed promotion leaf states and request-field parsers.
use std::ffi::{CStr, CString};
use std::io::Read;
use std::os::fd::RawFd;

use sha2::{Digest, Sha256};
use serde_json::Value;

use crate::{
    BUDGET_MAX_FILE_BYTES,
    PROMOTION_COMPONENT_MAX_BYTES,
    PROMOTION_PATH_MAX_BYTES,
};
use crate::util::{
    missing_path,
    open_at,
    read_link_at,
    stat_at,
    stat_file,
};

use super::capability::PromotionIdentity;

#[derive(Clone, Debug)]
pub(crate) enum PromotionExpectedState {
    File {
        mode: u32,
        size: u64,
        sha256: String,
    },
    Symlink {
        target: String,
    },
}

#[derive(Clone, Debug)]
pub(crate) struct PromotionExpectedLeaf {
    pub(crate) identity: PromotionIdentity,
    pub(crate) state: PromotionExpectedState,
}

#[derive(Clone, Debug)]
pub(crate) enum PromotionObservedState {
    File {
        mode: u32,
        size: u64,
        sha256: String,
    },
    Symlink {
        target: String,
    },
    Other,
}

#[derive(Clone, Debug)]
pub(crate) struct PromotionObservedLeaf {
    pub(crate) identity: PromotionIdentity,
    pub(crate) state: PromotionObservedState,
}

pub(crate) fn promotion_identity_from_value(value: &Value, field: &str) -> Result<PromotionIdentity, String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{field} must be an object"))?;
    let parse = |key: &str| -> Result<u64, String> {
        let raw = object
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{field}.{key} must be a decimal string"))?;
        if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(format!("{field}.{key} must be an unsigned decimal string"));
        }
        raw.parse::<u64>()
            .map_err(|_| format!("{field}.{key} does not fit u64"))
    };
    Ok(PromotionIdentity {
        dev: parse("dev")?,
        ino: parse("ino")?,
    })
}

pub(crate) fn promotion_component(value: &Value, field: &str) -> Result<(String, CString), String> {
    let value = value
        .as_str()
        .ok_or_else(|| format!("{field} must be a string"))?;
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
        || value.contains('\0')
        || value.len() > PROMOTION_COMPONENT_MAX_BYTES
    {
        return Err(format!("invalid promotion path component: {field}"));
    }
    let cstring = CString::new(value.as_bytes())
        .map_err(|_| format!("invalid promotion path component: {field}"))?;
    Ok((value.to_string(), cstring))
}

pub(crate) fn promotion_name(value: &Value, field: &str, prefix: &str) -> Result<(String, CString), String> {
    let (value, cstring) = promotion_component(value, field)?;
    if !value.starts_with(prefix) || !value.ends_with(".tmp") {
        return Err(format!("invalid promotion {field}"));
    }
    Ok((value, cstring))
}

pub(crate) fn promotion_absolute_path(value: &str, field: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > PROMOTION_PATH_MAX_BYTES || !value.starts_with('/') {
        return Err(format!("invalid promotion {field}"));
    }
    if value.contains('\0') {
        return Err(format!("invalid promotion {field}"));
    }
    Ok(())
}

pub(crate) fn promotion_sha256(value: &Value, field: &str) -> Result<String, String> {
    let value = value
        .as_str()
        .ok_or_else(|| format!("{field} must be a lowercase SHA-256 string"))?;
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(format!("{field} must be a lowercase SHA-256 string"));
    }
    Ok(value.to_string())
}

pub(crate) fn promotion_size(value: &Value, field: &str) -> Result<u64, String> {
    let value = value
        .as_str()
        .ok_or_else(|| format!("{field} must be a decimal string"))?;
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("{field} must be an unsigned decimal string"));
    }
    value
        .parse::<u64>()
        .map_err(|_| format!("{field} does not fit u64"))
}

pub(crate) fn parse_promotion_expected(value: &Value, field: &str) -> Result<PromotionExpectedLeaf, String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{field} must be an object"))?;
    let identity = promotion_identity_from_value(
        object
            .get("identity")
            .ok_or_else(|| format!("{field}.identity is missing"))?,
        &format!("{field}.identity"),
    )?;
    let state = object
        .get("state")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{field}.state must be an object"))?;
    let state_type = state
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{field}.state.type is missing"))?;
    let state = match state_type {
        "file" => {
            let mode = state
                .get("mode")
                .and_then(Value::as_u64)
                .filter(|mode| *mode <= 0o777)
                .ok_or_else(|| format!("{field}.state.mode is invalid"))?
                as u32;
            let size = promotion_size(
                state
                    .get("size")
                    .ok_or_else(|| format!("{field}.state.size is missing"))?,
                &format!("{field}.state.size"),
            )?;
            if size > BUDGET_MAX_FILE_BYTES {
                return Err(format!(
                    "{field}.state.size exceeds the promotion file budget"
                ));
            }
            PromotionExpectedState::File {
                mode,
                size,
                sha256: promotion_sha256(
                    state
                        .get("sha256")
                        .ok_or_else(|| format!("{field}.state.sha256 is missing"))?,
                    &format!("{field}.state.sha256"),
                )?,
            }
        }
        "symlink" => {
            let target = state
                .get("target")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("{field}.state.target is missing"))?;
            if target.contains('\0') || target.len() > PROMOTION_PATH_MAX_BYTES {
                return Err(format!("{field}.state.target is too long"));
            }
            PromotionExpectedState::Symlink {
                target: target.to_string(),
            }
        }
        _ => return Err(format!("{field}.state.type is unsupported")),
    };
    Ok(PromotionExpectedLeaf { identity, state })
}

/// Parse a destination expectation for an install. An absent destination is
/// represented explicitly as `{state:{type:"missing"}}`; unlike a
/// materialized leaf it has no identity to bind.
pub(crate) fn parse_promotion_expected_destination(
    value: &Value,
    field: &str,
) -> Result<Option<PromotionExpectedLeaf>, String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{field} must be an object"))?;
    let state_type = object
        .get("state")
        .and_then(Value::as_object)
        .and_then(|state| state.get("type"))
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{field}.state.type is missing"))?;
    if state_type == "missing" {
        let state = object
            .get("state")
            .and_then(Value::as_object)
            .expect("state object was checked above");
        if state.len() != 1 || object.len() != 1 {
            return Err(format!("{field} missing expectation has unexpected fields"));
        }
        return Ok(None);
    }
    Ok(Some(parse_promotion_expected(value, field)?))
}

pub(crate) fn promotion_sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn promotion_expected_matches(
    expected: &PromotionExpectedLeaf,
    observed: Option<&PromotionObservedLeaf>,
) -> bool {
    let Some(observed) = observed else {
        return false;
    };
    if expected.identity.dev != observed.identity.dev
        || expected.identity.ino != observed.identity.ino
    {
        return false;
    }
    match (&expected.state, &observed.state) {
        (
            PromotionExpectedState::File { mode, size, sha256 },
            PromotionObservedState::File {
                mode: actual_mode,
                size: actual_size,
                sha256: actual_sha256,
            },
        ) => mode == actual_mode && size == actual_size && sha256 == actual_sha256,
        (
            PromotionExpectedState::Symlink { target },
            PromotionObservedState::Symlink {
                target: actual_target,
            },
        ) => target == actual_target,
        _ => false,
    }
}

pub(crate) fn promotion_expected_state_description(expected: &PromotionExpectedLeaf) -> &'static str {
    match expected.state {
        PromotionExpectedState::File { .. } => "file",
        PromotionExpectedState::Symlink { .. } => "symlink",
    }
}

pub(crate) fn observe_promotion_leaf(
    parent: RawFd,
    name: &CStr,
) -> Result<Option<PromotionObservedLeaf>, String> {
    let identity = match stat_at(parent, name) {
        Ok(identity) => identity,
        Err(error) if missing_path(&error) => return Ok(None),
        Err(error) => return Err(format!("stat promotion leaf failed: {error}")),
    };
    let promotion_identity = PromotionIdentity {
        dev: identity.dev,
        ino: identity.ino,
    };
    if identity.is_file() {
        let file = open_at(
            parent,
            name,
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
        .map_err(|error| format!("open promotion leaf failed: {error}"))?;
        let before =
            stat_file(&file).map_err(|error| format!("fstat promotion leaf failed: {error}"))?;
        if !before.is_file() || before.dev != identity.dev || before.ino != identity.ino {
            return Err("promotion leaf changed type or identity while opening".to_string());
        }
        let mut bytes = Vec::new();
        let read_limit = BUDGET_MAX_FILE_BYTES
            .checked_add(1)
            .ok_or("promotion file budget overflow")?;
        (&file)
            .take(read_limit)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("read promotion leaf failed: {error}"))?;
        if bytes.len() as u64 > BUDGET_MAX_FILE_BYTES {
            return Err("promotion leaf exceeds the file budget".to_string());
        }
        let after =
            stat_file(&file).map_err(|error| format!("fstat promotion leaf failed: {error}"))?;
        let path_after = stat_at(parent, name)
            .map_err(|error| format!("stat promotion leaf failed: {error}"))?;
        if before != after || after != path_after {
            return Err("promotion leaf changed while reading".to_string());
        }
        return Ok(Some(PromotionObservedLeaf {
            identity: promotion_identity,
            state: PromotionObservedState::File {
                mode: before.mode & 0o777,
                size: bytes.len() as u64,
                sha256: promotion_sha256_hex(&bytes),
            },
        }));
    }
    if identity.is_symlink() {
        let target = read_link_at(parent, name)
            .map_err(|error| format!("read promotion symlink failed: {error}"))?;
        let after = stat_at(parent, name)
            .map_err(|error| format!("stat promotion symlink failed: {error}"))?;
        if identity != after {
            return Err("promotion symlink changed while reading".to_string());
        }
        let target = String::from_utf8(target)
            .map_err(|_| "promotion symlink target is not valid UTF-8".to_string())?;
        if target.len() > PROMOTION_PATH_MAX_BYTES {
            return Err("promotion symlink target is too long".to_string());
        }
        return Ok(Some(PromotionObservedLeaf {
            identity: promotion_identity,
            state: PromotionObservedState::Symlink { target },
        }));
    }
    Ok(Some(PromotionObservedLeaf {
        identity: promotion_identity,
        state: PromotionObservedState::Other,
    }))
}
