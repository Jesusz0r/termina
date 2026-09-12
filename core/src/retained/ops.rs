//! Retained root-transaction op and its final bound checks.
use std::ffi::CStr;
use std::os::fd::AsRawFd;

use base64::Engine as _;
use serde_json::{Value, json};

use crate::util::{
    missing_path,
    open_at,
    s,
    stat_at,
};
use crate::FileIdentity;
use crate::promote_fs::{
    PromotionIdentity,
    issue_promotion_root_capability,
    open_promotion_absolute_directory,
    open_promotion_bound_root_values,
    promotion_component,
    promotion_directory_capability_result,
    promotion_directory_identity_matches,
    promotion_identity_from_value,
    promotion_mkdir_at,
    promotion_mode,
    promotion_private_identity_valid,
    promotion_test_pause,
    stat_promotion_private_at,
};

use super::{RETAINED_ROOT_MARKER_MAX_BYTES, RETAINED_ROOT_MAX_SCAN_WORK_BYTES, RETAINED_ROOT_PROVENANCE_MAX_BYTES};
use super::validate::{RetainedRootScan, promotion_owned_directory, promotion_validate_marker, promotion_validate_retained_directory};
use super::private_files::{promotion_create_bound_file, promotion_persist_root_provenance, promotion_read_private_bounded_file};
use super::root_state::{PromotionRootStateKind, promotion_persist_root_state, promotion_read_root_state, promotion_read_root_state_temporary, promotion_replace_root_state, promotion_root_state_content, promotion_root_state_name};

pub(crate) fn promotion_final_bound_child_check(
    path: &str,
    parent_path: &str,
    name: &CStr,
    parent_identity: PromotionIdentity,
    root_identity: PromotionIdentity,
    marker: Option<(&CStr, FileIdentity)>,
    provenance_path: Option<(&str, PromotionIdentity, &CStr, FileIdentity)>,
) -> Result<(), String> {
    let parent = open_promotion_absolute_directory(parent_path, "trusted promotion parent final")?;
    promotion_directory_identity_matches(&parent, parent_identity, "trusted promotion parent final")?;
    let child = open_at(
        parent.as_raw_fd(),
        name,
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )
    .map_err(|error| format!("open promotion root final path failed: {error}"))?;
    promotion_directory_identity_matches(&child, root_identity, "promotion root final path")?;
    if let Some((marker_name, marker_identity)) = marker {
        let final_marker = stat_promotion_private_at(child.as_raw_fd(), marker_name)
            .map_err(|error| format!("stat retained root marker final path failed: {error}"))?;
        if final_marker.file != marker_identity
            || !promotion_private_identity_valid(
                final_marker,
                None,
                RETAINED_ROOT_MARKER_MAX_BYTES,
            )
        {
            return Err("retained root marker changed during binding".to_string());
        }
    }
    if let Some((provenance_parent_path, provenance_parent_identity, provenance_name, provenance_identity)) = provenance_path {
        let provenance_parent = open_promotion_absolute_directory(
            provenance_parent_path,
            "promotion provenance parent final",
        )?;
        promotion_directory_identity_matches(
            &provenance_parent,
            provenance_parent_identity,
            "promotion provenance parent final",
        )?;
        let final_provenance = stat_promotion_private_at(provenance_parent.as_raw_fd(), provenance_name)
            .map_err(|error| format!("stat promotion provenance final path failed: {error}"))?;
        if final_provenance.file != provenance_identity
            || !promotion_private_identity_valid(
                final_provenance,
                None,
                RETAINED_ROOT_PROVENANCE_MAX_BYTES,
            )
        {
            return Err("promotion root provenance changed during binding".to_string());
        }
    }
    let actual_path = format!("{}/{}", parent_path.trim_end_matches('/'), name.to_string_lossy());
    if actual_path != path {
        return Err("promotion root path changed during binding".to_string());
    }
    Ok(())
}

/// One descriptor-bound create/bind transaction. Existing roots require an
/// expected identity captured at their explicit admission boundary. The child,
/// marker, and external provenance are all authenticated
/// and durably written before any capability is returned.
pub(crate) fn op_promotion_bound_root_transaction(req: &Value) -> Result<Value, String> {
    let path = s(req, "path")?;
    let trusted_parent = req.get("trustedParent").and_then(Value::as_object).ok_or(
        "promotion directory transaction requires a trusted parent capability",
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
    let (name, c_name) = promotion_component(
        trusted_parent
            .get("name")
            .ok_or("trusted promotion parent leaf is missing")?,
        "trustedParent.name",
    )?;
    let expected_path = format!("{}/{}", parent_path.trim_end_matches('/'), name);
    if expected_path != path {
        return Err("promotion directory path is not the trusted parent leaf".to_string());
    }
    let parent = open_promotion_bound_root_values(
        parent_path,
        Some(parent_identity),
        trusted_parent.get("capability").and_then(Value::as_str),
        "trustedParent",
    )?
    .0;
    let parent_actual = promotion_owned_directory(&parent, "trusted parent", false)?;
    if parent_actual.dev != parent_identity.dev || parent_actual.ino != parent_identity.ino {
        return Err("trusted promotion parent identity changed".to_string());
    }
    let marker = if let Some(value) = req.get("marker") {
        let object = value.as_object().ok_or("promotion root marker must be an object")?;
        let (marker_name, marker_c_name) = promotion_component(
            object.get("name").ok_or("promotion root marker name is missing")?,
            "marker.name",
        )?;
        let encoded = object
            .get("content")
            .and_then(Value::as_str)
            .ok_or("promotion root marker content is missing")?;
        let content = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| format!("promotion root marker content is not valid base64: {error}"))?;
        if content.is_empty() || content.len() > RETAINED_ROOT_MARKER_MAX_BYTES {
            return Err("promotion root marker exceeds its bounded metadata size".to_string());
        }
        let mode = promotion_mode(object.get("mode"), "marker.mode", 0o600)?;
        Some((marker_name, marker_c_name, content, mode))
    } else {
        None
    };

    // Open the outside-root provenance directory before touching the mutable
    // leaf. The state/tombstone below is therefore always bound to the same
    // trusted descriptor as the final provenance record.
    let provenance = req
        .get("provenance")
        .and_then(Value::as_object)
        .ok_or("promotion root provenance binding is missing")?;
    let provenance_name_value = provenance
        .get("name")
        .ok_or("promotion root provenance name is missing")?;
    let (provenance_name, provenance_c_name) =
        promotion_component(provenance_name_value, "provenance.name")?;
    let provenance_parent = provenance
        .get("parent")
        .and_then(Value::as_object)
        .ok_or("promotion root provenance parent is missing")?;
    let provenance_parent_path = provenance_parent
        .get("path")
        .and_then(Value::as_str)
        .ok_or("promotion root provenance parent path is missing")?;
    let provenance_parent_identity = promotion_identity_from_value(
        provenance_parent
            .get("identity")
            .ok_or("promotion root provenance parent identity is missing")?,
        "provenance.parent.identity",
    )?;
    let provenance_parent_file = open_promotion_bound_root_values(
        provenance_parent_path,
        Some(provenance_parent_identity),
        provenance_parent.get("capability").and_then(Value::as_str),
        "provenance.parent",
    )?
    .0;
    let provenance_parent_actual = promotion_owned_directory(
        &provenance_parent_file,
        "provenance parent",
        false,
    )?;
    if provenance_parent_actual.dev != provenance_parent_identity.dev
        || provenance_parent_actual.ino != provenance_parent_identity.ino
    {
        return Err("promotion provenance parent identity changed".to_string());
    }
    let (_state_name, state_c_name) = promotion_root_state_name(&provenance_name)?;
    let mut expected = req
        .get("expectedIdentity")
        .map(|value| promotion_identity_from_value(value, "expectedIdentity"))
        .transpose()?;
    let mut existing_state = promotion_read_root_state(&provenance_parent_file, &state_c_name)?;
    let mut state_recovery_from_temporary = false;
    if existing_state.is_none() {
        existing_state = promotion_read_root_state_temporary(
            &provenance_parent_file,
            &state_c_name,
        )?;
        state_recovery_from_temporary = existing_state.is_some();
    }
    if let Some(state) = &existing_state {
        if state.path != path
            || state.parent.dev != parent_actual.dev
            || state.parent.ino != parent_actual.ino
        {
            return Err("promotion root state is bound to a different parent or path".to_string());
        }
        if let Some(requested) = expected {
            if requested != state.root {
                return Err("promotion root state identity mismatch".to_string());
            }
        }
        expected = Some(state.root);
        if state.kind == PromotionRootStateKind::Bound {
            match stat_promotion_private_at(provenance_parent_file.as_raw_fd(), &provenance_c_name) {
                Ok(identity)
                    if promotion_private_identity_valid(
                        identity,
                        Some(0o600),
                        RETAINED_ROOT_PROVENANCE_MAX_BYTES,
                    ) => {}
                Ok(_) => return Err("promotion root provenance is not a bounded private regular file".to_string()),
                Err(error) if missing_path(&error) => {
                    return Err("promotion root provenance was deleted after binding".to_string())
                }
                Err(error) => return Err(format!("stat promotion root provenance failed: {error}")),
            }
        }
    }

    promotion_test_pause(req, "retained-root-parent-open")?;

    let (directory, created) = match open_at(
        parent.as_raw_fd(),
        &c_name,
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    ) {
        Ok(existing) => {
            let identity = promotion_owned_directory(&existing, "root", marker.is_some())?;
            if let Some(expected) = expected {
                if identity.dev != expected.dev || identity.ino != expected.ino {
                    return Err("promotion root identity mismatch".to_string());
                }
            } else {
                return Err("existing promotion directory requires a previously trusted expectedIdentity".to_string());
            }
            (existing, false)
        }
        Err(error) if missing_path(&error) => {
            if expected.is_some() {
                return Err(format!("promotion root {name} is missing"));
            }
            promotion_mkdir_at(parent.as_raw_fd(), &c_name, 0o700)
                .map_err(|mkdir_error| format!("create promotion root {name} failed: {mkdir_error}"))?;
            let created = open_at(
                parent.as_raw_fd(),
                &c_name,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|open_error| format!("open created promotion root {name} failed: {open_error}"))?;
            (created, true)
        }
        Err(error) => return Err(format!("open promotion root {name} failed: {error}")),
    };
    let root_identity = promotion_owned_directory(&directory, "root", marker.is_some())?;
    if let Some(expected) = expected {
        if root_identity.dev != expected.dev || root_identity.ino != expected.ino {
            return Err("promotion root identity changed while binding".to_string());
        }
    }
    if created {
        // Make the newly allocated leaf durable before publishing any
        // metadata that could make it admissible. If the process dies before
        // the pending tombstone, the empty, marker-less leaf is not a valid
        // retained root and is rejected deterministically on retry.
        directory
            .sync_all()
            .map_err(|error| format!("sync newly created promotion root failed: {error}"))?;
        parent
            .sync_all()
            .map_err(|error| format!("sync newly created promotion root parent failed: {error}"))?;
        promotion_test_pause(req, "retained-root-created")?;
    }

    // Validate the retained tree before creating durable state. A copied
    // marker cannot establish root identity.
    if marker.is_some() {
        let mut scan = RetainedRootScan {
            entries: 1,
            bytes: 0,
            work_bytes: path.len() as u64,
        };
        if scan.work_bytes > RETAINED_ROOT_MAX_SCAN_WORK_BYTES {
            return Err("retained root path exceeds its work bound".to_string());
        }
        promotion_validate_retained_directory(&directory, 0, true, &mut scan)?;
    }

    let mut state_identity = existing_state.as_ref().map(|state| state.identity);
    if existing_state.is_none() || state_recovery_from_temporary {
        let pending_content = promotion_root_state_content(
            PromotionRootStateKind::Pending,
            &path,
            PromotionIdentity { dev: parent_actual.dev, ino: parent_actual.ino },
            PromotionIdentity { dev: root_identity.dev, ino: root_identity.ino },
        )?;
        state_identity = Some(promotion_persist_root_state(
            &provenance_parent_file,
            &state_c_name,
            &pending_content,
            Some((req, "retained-root-before-state-rename")),
        )?);
        // The pending tombstone is the first durable proof that this exact
        // root identity is being bound. A restart after this point
        // resumes the same identity-bound transaction rather than inferring
        // trust again from the mutable marker/tree.
        promotion_test_pause(req, "retained-root-state-persisted")?;
    }
    promotion_test_pause(req, "retained-root-child-open")?;

    let marker_identity = if let Some((_, marker_name, content, mode)) = &marker {
        let marker_missing = match stat_at(directory.as_raw_fd(), marker_name) {
            Ok(_) => false,
            Err(error) if missing_path(&error) => true,
            Err(error) => return Err(format!("stat retained root marker failed: {error}")),
        };
        // A pending state is the native transaction's durable recovery proof.
        // It permits completing a marker write interrupted after the root was
        // opened, but never permits marker-only admission: an unproven
        // existing root is rejected before pending state is created.
        let create_marker = created
            || (marker_missing
                && existing_state
                    .as_ref()
                    .is_some_and(|state| state.kind == PromotionRootStateKind::Pending));
        let created_identity = if create_marker {
            Some(promotion_create_bound_file(
                &directory,
                marker_name,
                content,
                *mode,
                "retained root marker",
                Some((req, "retained-root-before-marker-rename")),
            )?)
        } else {
            None
        };
        if created_identity.is_some() {
            // The marker is evidence only after the pending state exists; the
            // hook exercises the crash boundary after its atomic publication.
            promotion_test_pause(req, "retained-root-marker-persisted")?;
        }
        let validated_identity = promotion_validate_marker(&directory, marker_name, content, *mode)?;
        if let Some(created_identity) = created_identity {
            if created_identity != validated_identity {
                return Err("retained root marker changed after creation".to_string());
            }
        }
        promotion_test_pause(req, "retained-root-marker-validated")?;
        Some(validated_identity)
    } else {
        None
    };

    let provenance_content = serde_json::to_vec(&json!({
        "version": 1,
        "path": path,
        "parent": { "dev": parent_actual.dev.to_string(), "ino": parent_actual.ino.to_string() },
        "root": { "dev": root_identity.dev.to_string(), "ino": root_identity.ino.to_string() },
    }))
    .map_err(|error| format!("serialize promotion root provenance failed: {error}"))?;
    promotion_test_pause(req, "retained-root-before-provenance")?;
    let provenance_identity = promotion_persist_root_provenance(
        &provenance_parent_file,
        &provenance_c_name,
        &provenance_content,
        Some((req, "retained-root-before-provenance-rename")),
    )?;
    promotion_test_pause(req, "retained-root-provenance-persisted")?;
    parent
        .sync_all()
        .map_err(|error| format!("sync promotion root parent failed: {error}"))?;
    directory
        .sync_all()
        .map_err(|error| format!("sync promotion root failed: {error}"))?;
    provenance_parent_file
        .sync_all()
        .map_err(|error| format!("sync promotion provenance parent failed: {error}"))?;

    let bound_state_content = promotion_root_state_content(
        PromotionRootStateKind::Bound,
        &path,
        PromotionIdentity { dev: parent_actual.dev, ino: parent_actual.ino },
        PromotionIdentity { dev: root_identity.dev, ino: root_identity.ino },
    )?;
    let current_state_identity = state_identity
        .ok_or("promotion root state was not durably initialized")?;
    let final_state_identity = match existing_state.as_ref().map(|state| state.kind) {
        Some(PromotionRootStateKind::Bound) => {
            let (identity, observed) = promotion_read_private_bounded_file(
                &provenance_parent_file,
                &state_c_name,
                RETAINED_ROOT_PROVENANCE_MAX_BYTES,
                "promotion root state",
            )?;
            if identity != current_state_identity || observed != bound_state_content {
                return Err("promotion root bound state changed during commit".to_string());
            }
            identity
        }
        _ => promotion_replace_root_state(
            &provenance_parent_file,
            &state_c_name,
            current_state_identity,
            &bound_state_content,
            req,
        )?,
    };
    promotion_test_pause(req, "retained-root-durable")?;

    let root_identity = PromotionIdentity { dev: root_identity.dev, ino: root_identity.ino };
    let marker_final = marker.as_ref().and_then(|(_, marker_name, _, _)| {
        marker_identity.map(|identity| (marker_name.as_c_str(), identity))
    });
    promotion_final_bound_child_check(
        &path,
        parent_path,
        &c_name,
        parent_identity,
        root_identity,
        marker_final,
        Some((
            provenance_parent_path,
            provenance_parent_identity,
            &provenance_c_name,
            provenance_identity,
        )),
    )?;
    let final_state = promotion_read_root_state(&provenance_parent_file, &state_c_name)?
        .ok_or("promotion root state disappeared during binding")?;
    if final_state.kind != PromotionRootStateKind::Bound
        || final_state.identity != final_state_identity
        || final_state.path != path
        || final_state.parent.dev != parent_actual.dev
        || final_state.parent.ino != parent_actual.ino
        || final_state.root.dev != root_identity.dev
        || final_state.root.ino != root_identity.ino
    {
        return Err("promotion root state changed during binding".to_string());
    }
    let capability = issue_promotion_root_capability(&path, root_identity)?;
    Ok(json!({
        "result": promotion_directory_capability_result(root_identity, &capability)
    }))
}
