//! Promotion-bound directory ops: open, list, prepare, and ensure.
use std::os::fd::AsRawFd;

use serde_json::{Value, json};

use crate::{
    PROMOTION_DIRECTORY_MAX_NAME_BYTES,
    PROMOTION_RECOVERY_ROOT_MAX_ENTRIES,
};
use crate::util::{
    missing_path,
    open_at,
    s,
    stat_at,
    stat_file,
};
use crate::store::FileIdentity;
use crate::retained::op_promotion_bound_root_transaction;
use crate::promote_fs::{
    PromotionDirectoryStream,
    PromotionIdentity,
    issue_promotion_root_capability,
    open_promotion_bound_root,
    open_promotion_bound_root_values,
    promotion_component,
    promotion_components_value,
    promotion_directory_capability_result,
    promotion_directory_identity_matches,
    promotion_identity_chain_from_value,
    promotion_identity_from_value,
    promotion_mkdir_at,
    promotion_path_with_components,
    promotion_test_pause,
};

/// Bind an existing absolute directory without a TypeScript pathname
/// preflight.  The descriptor opened here is the source of the returned
/// identity; callers must carry that identity through every later mutation.
pub(crate) fn op_promotion_bound_open_directory(req: &Value) -> Result<Value, String> {
    let (directory, identity, capability) =
        open_promotion_bound_root(req, "path", "expectedIdentity", "capability")?;
    promotion_test_pause(req, "promotion-directory-prebind")?;
    promotion_directory_identity_matches(&directory, identity, "directory")?;
    Ok(json!({
        "result": promotion_directory_capability_result(identity, &capability)
    }))
}

/// Enumerate immediate child directories and bind each child's identity from
/// the same native root descriptor.  Recovery uses this instead of a
/// pathname `readdir` followed by a fresh pathname identity capture, which
/// would allow an operation-directory ABA between those two steps.
pub(crate) fn op_promotion_bound_list_directories(req: &Value) -> Result<Value, String> {
    let (root, _root_identity, _capability) =
        open_promotion_bound_root(req, "root", "rootIdentity", "rootCapability")?;
    let mut entries = Vec::new();
    let mut stream = PromotionDirectoryStream::open(root.as_raw_fd())?;
    let mut scanned_entries = 0usize;
    let mut scanned_name_bytes = 0u64;
    while let Some((name, c_name)) = stream.next_entry()? {
        scanned_entries = scanned_entries
            .checked_add(1)
            .ok_or("promotion recovery root entry count overflow")?;
        if scanned_entries > PROMOTION_RECOVERY_ROOT_MAX_ENTRIES {
            return Err("promotion recovery root exceeds its 128-entry bound".to_string());
        }
        let scan_work = u64::try_from(name.len())
            .map_err(|_| "promotion recovery root work accounting overflow")?
            .checked_add(std::mem::size_of::<FileIdentity>() as u64)
            .ok_or("promotion recovery root work accounting overflow")?;
        scanned_name_bytes = scanned_name_bytes
            .checked_add(scan_work)
            .ok_or("promotion recovery root name accounting overflow")?;
        if scanned_name_bytes > PROMOTION_DIRECTORY_MAX_NAME_BYTES {
            return Err("promotion recovery root exceeds its work bound".to_string());
        }
        let identity = match stat_at(root.as_raw_fd(), &c_name) {
            Ok(identity) if identity.is_dir() && !identity.is_symlink() => identity,
            Ok(_) => continue,
            Err(error) if missing_path(&error) => continue,
            Err(error) => return Err(format!("stat promotion directory entry failed: {error}")),
        };
        entries.push(json!({
            "name": name,
            "identity": { "dev": identity.dev.to_string(), "ino": identity.ino.to_string() },
        }));
    }
    Ok(json!({ "result": { "entries": entries } }))
}

/// Enumerate immediate private leaves with their namespace identities from the
/// same descriptor-bound root.  Callers use these observations as the
/// expected identity for a later descriptor-relative cleanup; a pathname
/// rebind after the scan therefore fails closed instead of deleting a
/// replacement leaf.
pub(crate) fn op_promotion_bound_list_entries(req: &Value) -> Result<Value, String> {
    let (root, _root_identity, _capability) =
        open_promotion_bound_root(req, "root", "rootIdentity", "rootCapability")?;
    let mut entries = Vec::new();
    let mut scanned_entries = 0usize;
    let mut scanned_name_bytes = 0u64;
    let mut stream = PromotionDirectoryStream::open(root.as_raw_fd())?;
    while let Some((name, c_name)) = stream.next_entry()? {
        scanned_entries = scanned_entries
            .checked_add(1)
            .ok_or("promotion entry count overflow")?;
        if scanned_entries > PROMOTION_RECOVERY_ROOT_MAX_ENTRIES {
            return Err("promotion root exceeds its 128-entry bound".to_string());
        }
        scanned_name_bytes = scanned_name_bytes
            .checked_add(
                u64::try_from(name.len())
                    .map_err(|_| "promotion entry name accounting overflow")?
                    .checked_add(std::mem::size_of::<FileIdentity>() as u64)
                    .ok_or("promotion entry name accounting overflow")?,
            )
            .ok_or("promotion entry name accounting overflow")?;
        if scanned_name_bytes > PROMOTION_DIRECTORY_MAX_NAME_BYTES {
            return Err("promotion root exceeds its work bound".to_string());
        }
        let identity = match stat_at(root.as_raw_fd(), &c_name) {
            Ok(identity) => identity,
            Err(error) if missing_path(&error) => continue,
            Err(error) => return Err(format!("stat promotion entry failed: {error}")),
        };
        let kind = if identity.is_dir() && !identity.is_symlink() {
            "directory"
        } else if identity.is_file() {
            "file"
        } else if identity.is_symlink() {
            "symlink"
        } else {
            "other"
        };
        entries.push(json!({
            "name": name,
            "identity": { "dev": identity.dev.to_string(), "ino": identity.ino.to_string() },
            "kind": kind,
        }));
    }
    Ok(json!({ "result": { "entries": entries } }))
}

/// Bind (and, when requested, create) a directory chain below an identity
/// that was obtained by the native opener above.  `allowMissing` is used for
/// a preflight probe: it reports the first absent component without asking
/// Electron to resolve a mutable pathname.  A later create request can pass
/// that index as `expectedMissingAt`, making an unexpected pre-created
/// component a conflict instead of silently accepting it.
pub(crate) fn op_promotion_bound_prepare_directory(req: &Value) -> Result<Value, String> {
    let root_path = s(req, "root")?;
    let (root, _root_identity, _capability) =
        open_promotion_bound_root(req, "root", "rootIdentity", "rootCapability")?;
    let components = match req.get("components") {
        None => Vec::new(),
        Some(value) if value.as_array().is_some_and(Vec::is_empty) => Vec::new(),
        Some(value) => promotion_components_value(value, "components")?,
    };
    let create_missing = req
        .get("createMissing")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let allow_missing = req
        .get("allowMissing")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let expected_missing_at = req
        .get("expectedMissingAt")
        .and_then(Value::as_u64)
        .map(|value| usize::try_from(value).map_err(|_| "expectedMissingAt is too large"))
        .transpose()?;
    let expected_chain = req
        .get("expectedChain")
        .map(|value| promotion_identity_chain_from_value(value, "expectedChain"))
        .transpose()?
        .unwrap_or_default();
    if let Some(index) = expected_missing_at {
        if index >= components.len() {
            return Err("expectedMissingAt is outside promotion components".to_string());
        }
        if !create_missing {
            return Err("expectedMissingAt requires createMissing".to_string());
        }
        if expected_chain.len() != index {
            return Err("expectedChain must cover the existing promotion prefix".to_string());
        }
    } else if !expected_chain.is_empty() && expected_chain.len() != components.len() {
        return Err("expectedChain must cover all promotion components".to_string());
    }

    let mut current = root
        .try_clone()
        .map_err(|error| format!("clone promotion prepare root failed: {error}"))?;
    let mut missing_at = None;
    let mut created = false;
    let mut chain = Vec::with_capacity(components.len());
    for (index, (_, component)) in components.iter().enumerate() {
        match open_at(
            current.as_raw_fd(),
            component,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        ) {
            Ok(next) => {
                let next_identity = stat_file(&next).map_err(|error| {
                    format!("fstat promotion prepare component {index} failed: {error}")
                })?;
                if !next_identity.is_dir() {
                    return Err(format!(
                        "promotion prepare component {index} is not a directory"
                    ));
                }
                if let Some(expected) = expected_missing_at {
                    if index >= expected {
                        return Err(format!(
                            "promotion prepare component {index} was expected to be missing"
                        ));
                    }
                }
                if let Some(expected) = expected_chain.get(index) {
                    if next_identity.dev != expected.dev || next_identity.ino != expected.ino {
                        return Err(format!(
                            "promotion prepare component {index} identity mismatch"
                        ));
                    }
                }
                chain.push(next_identity);
                current = next;
            }
            Err(error) if missing_path(&error) => {
                let first_missing = missing_at.is_none();
                if first_missing {
                    missing_at = Some(index);
                }
                if !create_missing {
                    if allow_missing {
                        return Ok(json!({
                            "result": {
                                "identity": null,
                                "missingAt": index,
                                "chain": chain.iter().map(|identity| json!({
                                    "dev": identity.dev.to_string(),
                                    "ino": identity.ino.to_string(),
                                })).collect::<Vec<_>>(),
                            }
                        }));
                    }
                    return Err(format!(
                        "promotion prepare component {index} is missing: {error}"
                    ));
                }
                if let Some(expected) = expected_missing_at {
                    if (first_missing && index != expected) || index < expected {
                        return Err(format!(
                            "promotion prepare component {index} changed before expected missing tail"
                        ));
                    }
                }
                promotion_mkdir_at(current.as_raw_fd(), component, 0o700).map_err(
                    |mkdir_error| {
                        format!("create promotion prepare component {index} failed: {mkdir_error}")
                    },
                )?;
                created = true;
                current = open_at(
                    current.as_raw_fd(),
                    component,
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
                .map_err(|open_error| {
                    format!("open created promotion prepare component {index} failed: {open_error}")
                })?;
                let created_identity = stat_file(&current).map_err(|error| {
                    format!("fstat created promotion prepare component {index} failed: {error}")
                })?;
                if !created_identity.is_dir() {
                    return Err(format!(
                        "created promotion prepare component {index} is not a directory"
                    ));
                }
                chain.push(created_identity);
            }
            Err(error) => {
                return Err(format!(
                    "open promotion prepare component {index} failed: {error}"
                ));
            }
        }
    }
    if let Some(expected) = expected_missing_at {
        if missing_at != Some(expected) {
            return Err("promotion prepare missing-tail identity changed".to_string());
        }
    }
    let identity = stat_file(&current)
        .map_err(|error| format!("fstat promotion prepared directory failed: {error}"))?;
    if !identity.is_dir() {
        return Err("promotion prepared target is not a directory".to_string());
    }
    if created {
        current
            .sync_all()
            .map_err(|error| format!("sync promotion prepared directory failed: {error}"))?;
    }
    let prepared_identity = PromotionIdentity {
        dev: identity.dev,
        ino: identity.ino,
    };
    let capability = issue_promotion_root_capability(
        &promotion_path_with_components(&root_path, &components),
        prepared_identity,
    )?;
    Ok(json!({
        "result": {
            "identity": {
                "dev": identity.dev.to_string(),
                "ino": identity.ino.to_string(),
                "capability": capability,
            },
            "missingAt": missing_at,
            "chain": chain.iter().map(|identity| json!({
                "dev": identity.dev.to_string(),
                "ino": identity.ino.to_string(),
            })).collect::<Vec<_>>(),
        }
    }))
}

/// Ensure an absolute directory chain using only descriptor-relative
/// operations from the native root descriptor.
pub(crate) fn op_promotion_bound_ensure_directory(req: &Value) -> Result<Value, String> {
    let object = req
        .as_object()
        .ok_or("promotion directory request must be an object")?;
    for field in object.keys() {
        if !matches!(
            field.as_str(),
            "op"
                | "requestId"
                | "path"
                | "expectedIdentity"
                | "capability"
                | "trustedParent"
                | "provenance"
                | "marker"
                | "testHook"
        ) {
            return Err("promotion directory request contains an unknown field".to_string());
        }
    }
    // Requests carrying provenance state use the single native create/bind
    // transaction. Already-proven roots use the ordinary identity opener.
    if req.get("provenance").is_some() || req.get("marker").is_some() {
        return op_promotion_bound_root_transaction(req);
    }
    let path = s(req, "path")?;
    if req.get("capability").is_some() || req.get("expectedIdentity").is_some() {
        let (directory, identity, capability) =
            open_promotion_bound_root(req, "path", "expectedIdentity", "capability")?;
        promotion_test_pause(req, "promotion-directory-prebind")?;
        promotion_directory_identity_matches(&directory, identity, "directory")?;
        directory
            .sync_all()
            .map_err(|error| format!("sync ensured promotion directory failed: {error}"))?;
        return Ok(json!({
            "result": promotion_directory_capability_result(identity, &capability)
        }));
    }
    // A first bind may create exactly one app-owned root leaf, but only from
    // a parent whose identity was already supplied by the trusted owner.
    let trusted_parent = req.get("trustedParent").and_then(Value::as_object).ok_or(
        "promotion directory requires a previously trusted identity, capability, or parent",
    )?;
    let parent_path = trusted_parent
        .get("path")
        .and_then(Value::as_str)
        .ok_or("trusted promotion parent path is missing")?;
    let parent_identity = promotion_identity_from_value(
        trusted_parent
            .get("identity")
            .ok_or("trusted promotion parent identity is missing")?,
        "trustedParent.identity",
    )?;
    let (parent, _parent_bound_identity, _parent_capability) = open_promotion_bound_root_values(
        parent_path,
        Some(parent_identity),
        trusted_parent.get("capability").and_then(Value::as_str),
        "trustedParent",
    )?;
    let name_value = trusted_parent
        .get("name")
        .ok_or("trusted promotion parent leaf is missing")?;
    let (name, c_name) = promotion_component(name_value, "trustedParent.name")?;
    let expected_path = format!("{}/{}", parent_path.trim_end_matches('/'), name);
    if expected_path != path {
        return Err("promotion directory path is not the trusted parent leaf".to_string());
    }
    let directory = match open_at(
        parent.as_raw_fd(),
        &c_name,
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    ) {
        Ok(existing) => {
            let expected = req
                .get("expectedIdentity")
                .ok_or_else(|| {
                    "existing promotion directory requires a previously trusted expectedIdentity"
                        .to_string()
                })
                .and_then(|value| promotion_identity_from_value(value, "expectedIdentity"))?;
            promotion_directory_identity_matches(&existing, expected, "directory")?;
            existing
        }
        Err(error) if missing_path(&error) => {
            promotion_mkdir_at(parent.as_raw_fd(), &c_name, 0o700).map_err(|mkdir_error| {
                format!("create promotion directory {name} failed: {mkdir_error}")
            })?;
            open_at(
                parent.as_raw_fd(),
                &c_name,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|open_error| {
                format!("open created promotion directory {name} failed: {open_error}")
            })?
        }
        Err(error) => return Err(format!("open promotion directory {name} failed: {error}")),
    };
    let identity = stat_file(&directory)
        .map_err(|error| format!("fstat ensured promotion directory failed: {error}"))?;
    if !identity.is_dir() {
        return Err("ensured promotion directory is not a directory".to_string());
    }
    parent
        .sync_all()
        .map_err(|error| format!("sync promotion directory parent failed: {error}"))?;
    directory
        .sync_all()
        .map_err(|error| format!("sync ensured promotion directory failed: {error}"))?;
    let capability = issue_promotion_root_capability(
        &path,
        PromotionIdentity {
            dev: identity.dev,
            ino: identity.ino,
        },
    )?;
    Ok(json!({
        "result": promotion_directory_capability_result(
            PromotionIdentity { dev: identity.dev, ino: identity.ino },
            &capability,
        )
    }))
}
