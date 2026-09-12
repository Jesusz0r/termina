//! Promotion-bound writes: create, write, symlink, and install.
use std::ffi::CString;
use std::os::fd::AsRawFd;

use base64::Engine as _;
use serde_json::{Value, json};

use crate::{
    PROMOTION_PATH_MAX_BYTES,
    PROMOTION_JOURNAL_MAX_BYTES,
};
use crate::util::{
    missing_path,
    open_at,
    open_at_mode,
    s,
    stat_at,
    stat_file,
};
use crate::capture::read_link_at;
use crate::copy::{
    promotion_expected_directory,
    promotion_leaf_result,
};
use crate::promote_fs::{
    PromotionIdentity,
    PromotionObservedLeaf,
    PromotionExpectedLeaf,
    PromotionObservedState,
    issue_promotion_root_capability,
    observe_promotion_leaf,
    open_or_create_promotion_parent,
    open_promotion_bound_root,
    open_promotion_parent,
    parse_promotion_expected_destination,
    promotion_bound_path_matches,
    promotion_components_for,
    promotion_directory_identity_matches,
    promotion_expected_matches,
    promotion_identity_from_value,
    promotion_mkdir_at,
    promotion_mode,
    promotion_path_with_components,
    promotion_rename_noreplace,
    promotion_set_mode,
    promotion_sha256_hex,
    promotion_symlink_at,
    promotion_test_pause,
    promotion_write_all,
};

use super::rename::promotion_rename_unsupported;

pub(crate) fn op_promotion_bound_create_directory(req: &Value) -> Result<Value, String> {
    let root_path = s(req, "root")?;
    let (root, root_identity, _capability) =
        open_promotion_bound_root(req, "root", "rootIdentity", "rootCapability")?;
    promotion_test_pause(req, "promotion-directory-root-open")?;
    // The descriptor keeps the operation on the originally bound root, but a
    // caller-visible create must also fail closed if that root pathname (or
    // one of its ancestors) was replaced while the request waited.  Without
    // this provenance assertion the child would be created in a parked,
    // unreachable directory and the returned pathname could describe a
    // different root.
    promotion_bound_path_matches(&root_path, root_identity, "directory root")?;
    let components = promotion_components_for(req, "components")?;
    let parent_components = &components[..components.len() - 1];
    let parent =
        open_or_create_promotion_parent(&root, parent_components, "directory parent", 0o700)?;
    let parent_identity = promotion_identity_from_value(
        req.get("parentIdentity").ok_or("missing parentIdentity")?,
        "parentIdentity",
    )?;
    promotion_directory_identity_matches(&parent, parent_identity, "directory parent")?;
    promotion_test_pause(req, "promotion-directory-parent-open")?;
    let parent_path = promotion_path_with_components(&root_path, parent_components);
    promotion_bound_path_matches(&root_path, root_identity, "directory root")?;
    promotion_bound_path_matches(&parent_path, parent_identity, "directory parent")?;
    let (leaf_name, leaf) = components.last().expect("non-empty components");
    let require_missing = req
        .get("requireMissing")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let existing = stat_at(parent.as_raw_fd(), leaf);
    let leaf_file = match existing {
        Ok(identity) => {
            if require_missing {
                return Err(format!("promotion directory {leaf_name} already exists"));
            }
            if !identity.is_dir() || identity.is_symlink() {
                return Err(format!(
                    "promotion directory {leaf_name} is not a directory"
                ));
            }
            open_at(
                parent.as_raw_fd(),
                leaf,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|error| format!("open promotion directory {leaf_name} failed: {error}"))?
        }
        Err(error) if missing_path(&error) => {
            promotion_mkdir_at(parent.as_raw_fd(), leaf, 0o700).map_err(|error| {
                format!("create promotion directory {leaf_name} failed: {error}")
            })?;
            open_at(
                parent.as_raw_fd(),
                leaf,
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|error| {
                format!("open created promotion directory {leaf_name} failed: {error}")
            })?
        }
        Err(error) => {
            return Err(format!(
                "stat promotion directory {leaf_name} failed: {error}"
            ));
        }
    };
    let leaf_identity = stat_file(&leaf_file)
        .map_err(|error| format!("fstat promotion directory {leaf_name} failed: {error}"))?;
    if !leaf_identity.is_dir() {
        return Err(format!(
            "promotion directory {leaf_name} is not a directory"
        ));
    }
    promotion_test_pause(req, "promotion-directory-leaf-open")?;
    promotion_bound_path_matches(&root_path, root_identity, "directory root")?;
    promotion_bound_path_matches(&parent_path, parent_identity, "directory parent")?;
    let path_identity = stat_at(parent.as_raw_fd(), leaf)
        .map_err(|error| format!("stat promotion directory {leaf_name} failed: {error}"))?;
    if path_identity != leaf_identity {
        return Err(format!(
            "promotion directory {leaf_name} changed while opening"
        ));
    }
    parent
        .sync_all()
        .map_err(|error| format!("sync promotion directory parent failed: {error}"))?;
    let leaf_identity = PromotionIdentity {
        dev: leaf_identity.dev,
        ino: leaf_identity.ino,
    };
    let capability = issue_promotion_root_capability(
        &promotion_path_with_components(&root_path, &components),
        leaf_identity,
    )?;
    Ok(json!({
        "result": {
            "identity": {
                "dev": leaf_identity.dev.to_string(),
                "ino": leaf_identity.ino.to_string(),
                "capability": capability,
            }
        }
    }))
}

fn parse_promotion_expected_missing_or_leaf(
    value: &Value,
    field: &str,
) -> Result<Option<PromotionExpectedLeaf>, String> {
    parse_promotion_expected_destination(value, field)
}

fn promotion_decode_content(req: &Value) -> Result<Vec<u8>, String> {
    let content = req
        .get("content")
        .and_then(Value::as_str)
        .ok_or("content must be a base64 string")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content)
        .map_err(|error| format!("promotion content is not valid base64: {error}"))?;
    if bytes.len() as u64 > PROMOTION_JOURNAL_MAX_BYTES {
        return Err("promotion content exceeds the 16 MiB budget".to_string());
    }
    Ok(bytes)
}

pub(crate) fn op_promotion_bound_write_file(req: &Value) -> Result<Value, String> {
    let root_path = s(req, "root")?;
    let (root, root_identity, _capability) =
        open_promotion_bound_root(req, "root", "rootIdentity", "rootCapability")?;
    let components = promotion_components_for(req, "components")?;
    let parent = open_promotion_parent(&root, &components, "write")?;
    let parent_identity = promotion_identity_from_value(
        req.get("parentIdentity").ok_or("missing parentIdentity")?,
        "parentIdentity",
    )?;
    promotion_directory_identity_matches(&parent, parent_identity, "write parent")?;
    promotion_test_pause(req, "promotion-write-parent-open")?;
    let parent_path = promotion_path_with_components(&root_path, &components[..components.len() - 1]);
    promotion_bound_path_matches(&root_path, root_identity, "write root")?;
    promotion_bound_path_matches(&parent_path, parent_identity, "write parent")?;
    let (_, leaf) = components.last().expect("non-empty components");
    let expected = parse_promotion_expected_missing_or_leaf(
        req.get("expectedDestination")
            .ok_or("missing expectedDestination")?,
        "expectedDestination",
    )?;
    let bytes = promotion_decode_content(req)?;
    let mode = promotion_mode(req.get("mode"), "mode", 0o600)?;
    let mut file = if let Some(expected) = &expected {
        let observed = observe_promotion_leaf(parent.as_raw_fd(), leaf)?;
        if !promotion_expected_matches(expected, observed.as_ref()) {
            return Err("promotion write expected destination was not present".to_string());
        }
        open_at(
            parent.as_raw_fd(),
            leaf,
            libc::O_WRONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
        .map_err(|error| format!("open promotion file failed: {error}"))?
    } else {
        open_at_mode(
            parent.as_raw_fd(),
            leaf,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            mode as libc::mode_t,
        )
        .map_err(|error| format!("create promotion file failed: {error}"))?
    };
    promotion_test_pause(req, "promotion-write-file-open")?;
    let opened =
        stat_file(&file).map_err(|error| format!("fstat promotion file failed: {error}"))?;
    if !opened.is_file() {
        return Err("promotion write destination is not a regular file".to_string());
    }
    // Revalidate the public root/parent ancestry and the leaf namespace before
    // truncating.  The descriptor still pins the file opened above, but a
    // replacement at the pathname must not cause us to mutate an old parked
    // file and then report a result for the replacement.
    promotion_bound_path_matches(&root_path, root_identity, "write root")?;
    promotion_bound_path_matches(&parent_path, parent_identity, "write parent")?;
    let path_before_write = stat_at(parent.as_raw_fd(), leaf)
        .map_err(|error| format!("stat promotion file before writing failed: {error}"))?;
    if path_before_write != opened {
        return Err("promotion write destination changed before writing; evidence retained".to_string());
    }
    if let Some(expected) = &expected {
        if opened.dev != expected.identity.dev || opened.ino != expected.identity.ino {
            return Err("promotion write destination identity changed while opening".to_string());
        }
    }
    file.set_len(0)
        .map_err(|error| format!("truncate promotion file failed: {error}"))?;
    promotion_write_all(&mut file, &bytes, "file")?;
    promotion_set_mode(&file, mode, "file")?;
    file.sync_all()
        .map_err(|error| format!("sync promotion file failed: {error}"))?;
    let after =
        stat_file(&file).map_err(|error| format!("fstat promotion file failed: {error}"))?;
    let path_after = stat_at(parent.as_raw_fd(), leaf)
        .map_err(|error| format!("stat promotion file failed: {error}"))?;
    if after != path_after || !after.is_file() || after.len != bytes.len() as u64 {
        return Err("promotion file changed while writing; evidence retained".to_string());
    }
    if after.dev != opened.dev || after.ino != opened.ino {
        return Err("promotion file identity changed while writing; evidence retained".to_string());
    }
    parent
        .sync_all()
        .map_err(|error| format!("sync promotion write parent failed: {error}"))?;
    // Keep the result bound to the descriptor that was actually truncated and
    // written.  A pathname-only observation here could accept a replacement
    // leaf in the final interval (and poison the journal with its identity).
    promotion_test_pause(req, "promotion-write-final-observe")?;
    let final_descriptor =
        stat_file(&file).map_err(|error| format!("fstat promotion file failed: {error}"))?;
    let final_path = stat_at(parent.as_raw_fd(), leaf)
        .map_err(|error| format!("stat promotion file failed: {error}"))?;
    if final_descriptor != after
        || final_path != final_descriptor
        || !final_descriptor.is_file()
        || final_descriptor.len != bytes.len() as u64
    {
        return Err(
            "promotion file changed during final observation; evidence retained".to_string(),
        );
    }
    let observed = PromotionObservedLeaf {
        identity: PromotionIdentity {
            dev: final_descriptor.dev,
            ino: final_descriptor.ino,
        },
        state: PromotionObservedState::File {
            mode: final_descriptor.mode & 0o777,
            size: bytes.len() as u64,
            sha256: promotion_sha256_hex(&bytes),
        },
    };
    Ok(json!({ "result": { "leaf": promotion_leaf_result(&observed) } }))
}

pub(crate) fn op_promotion_bound_create_symlink(req: &Value) -> Result<Value, String> {
    let (root, _root_identity, _capability) =
        open_promotion_bound_root(req, "root", "rootIdentity", "rootCapability")?;
    let components = promotion_components_for(req, "components")?;
    let parent = open_promotion_parent(&root, &components, "symlink")?;
    let parent_identity = promotion_identity_from_value(
        req.get("parentIdentity").ok_or("missing parentIdentity")?,
        "parentIdentity",
    )?;
    promotion_directory_identity_matches(&parent, parent_identity, "symlink parent")?;
    promotion_test_pause(req, "promotion-symlink-parent-open")?;
    let (_, leaf) = components.last().expect("non-empty components");
    if stat_at(parent.as_raw_fd(), leaf).is_ok() {
        return Err("promotion symlink destination is occupied".to_string());
    }
    let target = req
        .get("target")
        .and_then(Value::as_str)
        .ok_or("symlink target must be a string")?;
    if target.contains('\0') || target.len() > PROMOTION_PATH_MAX_BYTES {
        return Err("promotion symlink target is too long".to_string());
    }
    let requested_target = target.to_string();
    let target =
        CString::new(target).map_err(|_| "promotion symlink target contains NUL".to_string())?;
    promotion_symlink_at(&target, parent.as_raw_fd(), leaf)
        .map_err(|error| format!("create promotion symlink failed: {error}"))?;
    // Symlinks cannot be opened with a portable read descriptor on both
    // supported hosts.  Bind the created directory entry's identity and
    // requested target immediately, then require the final name to still
    // identify that exact object before reporting it to Electron.
    let created_identity = stat_at(parent.as_raw_fd(), leaf)
        .map_err(|error| format!("stat created promotion symlink failed: {error}"))?;
    if !created_identity.is_symlink() {
        return Err("promotion symlink changed type after creation".to_string());
    }
    let created_target = read_link_at(parent.as_raw_fd(), leaf)
        .map_err(|error| format!("read created promotion symlink failed: {error}"))?;
    if created_target != requested_target.as_bytes() {
        return Err("promotion symlink target changed after creation".to_string());
    }
    parent
        .sync_all()
        .map_err(|error| format!("sync promotion symlink parent failed: {error}"))?;
    promotion_test_pause(req, "promotion-symlink-final-observe")?;
    let final_identity = stat_at(parent.as_raw_fd(), leaf)
        .map_err(|error| format!("stat promotion symlink failed: {error}"))?;
    let final_target = read_link_at(parent.as_raw_fd(), leaf)
        .map_err(|error| format!("read promotion symlink failed: {error}"))?;
    if final_identity != created_identity || final_target != created_target {
        return Err(
            "promotion symlink changed during final observation; evidence retained".to_string(),
        );
    }
    let observed = PromotionObservedLeaf {
        identity: PromotionIdentity {
            dev: created_identity.dev,
            ino: created_identity.ino,
        },
        state: PromotionObservedState::Symlink {
            target: requested_target,
        },
    };
    Ok(json!({ "result": { "leaf": promotion_leaf_result(&observed) } }))
}

pub(crate) fn op_promotion_bound_install_directory(req: &Value) -> Result<Value, String> {
    let (source_root, _source_root_identity, _source_capability) = open_promotion_bound_root(
        req,
        "sourceRoot",
        "sourceRootIdentity",
        "sourceRootCapability",
    )?;
    let source_components = promotion_components_for(req, "sourceComponents")?;
    let source_parent =
        open_promotion_parent(&source_root, &source_components, "install directory source")?;
    let source_parent_identity = promotion_identity_from_value(
        req.get("sourceParentIdentity")
            .ok_or("missing sourceParentIdentity")?,
        "sourceParentIdentity",
    )?;
    promotion_directory_identity_matches(
        &source_parent,
        source_parent_identity,
        "install directory source parent",
    )?;
    let (destination_root, _destination_root_identity, _destination_capability) =
        open_promotion_bound_root(
            req,
            "destinationRoot",
            "destinationRootIdentity",
            "destinationRootCapability",
        )?;
    let destination_components = promotion_components_for(req, "destinationComponents")?;
    let destination_parent = open_promotion_parent(
        &destination_root,
        &destination_components,
        "install directory destination",
    )?;
    let destination_parent_identity = promotion_identity_from_value(
        req.get("destinationParentIdentity")
            .ok_or("missing destinationParentIdentity")?,
        "destinationParentIdentity",
    )?;
    promotion_directory_identity_matches(
        &destination_parent,
        destination_parent_identity,
        "install directory destination parent",
    )?;
    promotion_test_pause(req, "promotion-install-directory-parents-open")?;
    let (_, source_name) = source_components
        .last()
        .expect("non-empty source components");
    let (_, destination_name) = destination_components
        .last()
        .expect("non-empty destination components");
    let expected = promotion_expected_directory(
        req.get("expectedSource").ok_or("missing expectedSource")?,
        "expectedSource",
    )?;
    let source_stat = stat_at(source_parent.as_raw_fd(), source_name)
        .map_err(|error| format!("stat install directory source failed: {error}"))?;
    if !source_stat.is_dir()
        || source_stat.dev != expected.0.dev
        || source_stat.ino != expected.0.ino
        || source_stat.mode & 0o777 != expected.1
    {
        return Err("install directory source identity or type mismatch".to_string());
    }
    if stat_at(destination_parent.as_raw_fd(), destination_name).is_ok() {
        return Err("install directory destination is occupied".to_string());
    }
    promotion_test_pause(req, "promotion-install-directory-validated")?;
    promotion_rename_noreplace(
        source_parent.as_raw_fd(),
        source_name,
        destination_parent.as_raw_fd(),
        destination_name,
    )
    .map_err(|error| {
        if promotion_rename_unsupported(&error) {
            "promotion bound directory install is unsupported".to_string()
        } else {
            format!("promotion directory install failed: {error}")
        }
    })?;
    promotion_test_pause(req, "promotion-install-directory-syscall")?;
    let destination_stat = stat_at(destination_parent.as_raw_fd(), destination_name)
        .map_err(|error| format!("stat installed directory failed: {error}"))?;
    let source_gone = stat_at(source_parent.as_raw_fd(), source_name);
    if destination_stat.dev != expected.0.dev
        || destination_stat.ino != expected.0.ino
        || !destination_stat.is_dir()
        || source_gone.is_ok()
    {
        return Ok(json!({
            "result": {
                "outcome": "conflict-after-mutation",
                "durable": false,
                "error": "promotion directory install changed an operand after mutation"
            }
        }));
    }
    destination_parent
        .sync_all()
        .map_err(|error| format!("sync installed directory parent failed: {error}"))?;
    source_parent
        .sync_all()
        .map_err(|error| format!("sync source directory parent failed: {error}"))?;
    Ok(json!({
        "result": {
            "outcome": "applied",
            "durable": true,
            "error": null,
            "identity": { "dev": destination_stat.dev.to_string(), "ino": destination_stat.ino.to_string() }
        }
    }))
}
