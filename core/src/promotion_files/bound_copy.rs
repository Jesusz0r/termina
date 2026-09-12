//! Promotion-bound copies: files and trees.
use std::io::Read;
use std::os::fd::AsRawFd;

use serde_json::{Value, json};

use crate::{
    BUDGET_MAX_FILE_BYTES,
    PROMOTION_COPY_TREE_MAX_BYTES,
    PROMOTION_COPY_TREE_MAX_ENTRIES,
    PROMOTION_COPY_TREE_MAX_WORK_BYTES,
};
use crate::util::{
    open_at,
    open_at_mode,
    stat_at,
    stat_file,
};
use crate::copy::{
    PromotionCopyBudget,
    promotion_copy_tree_contents,
    promotion_leaf_result,
};
use crate::promote_fs::{
    PromotionIdentity,
    PromotionObservedLeaf,
    PromotionExpectedState,
    PromotionObservedState,
    observe_promotion_leaf,
    open_promotion_bound_root,
    open_promotion_parent,
    parse_promotion_expected,
    promotion_components_for,
    promotion_directory_identity_matches,
    promotion_directory_is_empty,
    promotion_expected_matches,
    promotion_identity_from_value,
    promotion_set_mode,
    promotion_sha256_hex,
    promotion_test_pause,
    promotion_write_all,
};

pub(crate) fn op_promotion_bound_copy_file(req: &Value) -> Result<Value, String> {
    let (source_root, _source_root_identity, _source_capability) = open_promotion_bound_root(
        req,
        "sourceRoot",
        "sourceRootIdentity",
        "sourceRootCapability",
    )?;
    let source_components = promotion_components_for(req, "sourceComponents")?;
    let source_parent = open_promotion_parent(&source_root, &source_components, "copy source")?;
    let source_parent_identity = promotion_identity_from_value(
        req.get("sourceParentIdentity")
            .ok_or("missing sourceParentIdentity")?,
        "sourceParentIdentity",
    )?;
    promotion_directory_identity_matches(
        &source_parent,
        source_parent_identity,
        "copy source parent",
    )?;
    let source_expected = parse_promotion_expected(
        req.get("expectedSource").ok_or("missing expectedSource")?,
        "expectedSource",
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
        "copy destination",
    )?;
    let destination_parent_identity = promotion_identity_from_value(
        req.get("destinationParentIdentity")
            .ok_or("missing destinationParentIdentity")?,
        "destinationParentIdentity",
    )?;
    promotion_directory_identity_matches(
        &destination_parent,
        destination_parent_identity,
        "copy destination parent",
    )?;
    promotion_test_pause(req, "promotion-copy-roots-open")?;
    let (_, source_name) = source_components
        .last()
        .expect("non-empty source components");
    let (_, destination_name) = destination_components
        .last()
        .expect("non-empty destination components");
    let observed_source = observe_promotion_leaf(source_parent.as_raw_fd(), source_name)?;
    if !promotion_expected_matches(&source_expected, observed_source.as_ref()) {
        return Err("promotion copy source changed before reading".to_string());
    }
    let source_file = open_at(
        source_parent.as_raw_fd(),
        source_name,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )
    .map_err(|error| format!("open promotion copy source failed: {error}"))?;
    let source_stat = stat_file(&source_file)
        .map_err(|error| format!("fstat promotion copy source failed: {error}"))?;
    if !source_stat.is_file()
        || source_stat.dev != source_expected.identity.dev
        || source_stat.ino != source_expected.identity.ino
    {
        return Err("promotion copy source identity changed while opening".to_string());
    }
    let read_limit = BUDGET_MAX_FILE_BYTES
        .checked_add(1)
        .ok_or("promotion copy budget overflow")?;
    let mut bytes = Vec::new();
    (&source_file)
        .take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read promotion copy source failed: {error}"))?;
    if bytes.len() as u64 > BUDGET_MAX_FILE_BYTES {
        return Err("promotion copy source exceeds the file budget".to_string());
    }
    if !matches!(source_expected.state, PromotionExpectedState::File { .. }) {
        return Err("promotion copy source is not a regular file".to_string());
    }
    let after_source = stat_file(&source_file)
        .map_err(|error| format!("fstat promotion copy source failed: {error}"))?;
    if after_source != source_stat
        || promotion_sha256_hex(&bytes)
            != match &source_expected.state {
                PromotionExpectedState::File { sha256, .. } => sha256.clone(),
                PromotionExpectedState::Symlink { .. } => String::new(),
            }
    {
        return Err("promotion copy source changed while reading".to_string());
    }
    if stat_at(source_parent.as_raw_fd(), source_name)
        .map_err(|error| format!("stat promotion copy source failed: {error}"))?
        != source_stat
    {
        return Err("promotion copy source name changed while reading".to_string());
    }
    if stat_at(destination_parent.as_raw_fd(), destination_name).is_ok() {
        return Err("promotion copy destination is occupied".to_string());
    }
    let mut destination_file = open_at_mode(
        destination_parent.as_raw_fd(),
        destination_name,
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        0o600,
    )
    .map_err(|error| format!("create promotion copy destination failed: {error}"))?;
    promotion_write_all(&mut destination_file, &bytes, "copy destination")?;
    let mode = match source_expected.state {
        PromotionExpectedState::File { mode, .. } => mode,
        PromotionExpectedState::Symlink { .. } => 0o600,
    };
    promotion_set_mode(&destination_file, mode, "copy destination")?;
    destination_file
        .sync_all()
        .map_err(|error| format!("sync promotion copy destination failed: {error}"))?;
    let destination_stat = stat_file(&destination_file)
        .map_err(|error| format!("fstat promotion copy destination failed: {error}"))?;
    let destination_path_stat = stat_at(destination_parent.as_raw_fd(), destination_name)
        .map_err(|error| format!("stat promotion copy destination failed: {error}"))?;
    if destination_stat != destination_path_stat || !destination_stat.is_file() {
        return Err(
            "promotion copy destination changed while writing; evidence retained".to_string(),
        );
    }
    source_parent
        .sync_all()
        .map_err(|error| format!("sync promotion copy source parent failed: {error}"))?;
    destination_parent
        .sync_all()
        .map_err(|error| format!("sync promotion copy destination parent failed: {error}"))?;
    // Do not re-open the destination by pathname for the returned evidence.
    // The descriptor remains the authority for the bytes and identity that
    // were copied; the final name check only proves it still names that fd.
    promotion_test_pause(req, "promotion-copy-final-observe")?;
    let final_descriptor = stat_file(&destination_file)
        .map_err(|error| format!("fstat promotion copy destination failed: {error}"))?;
    let final_path = stat_at(destination_parent.as_raw_fd(), destination_name)
        .map_err(|error| format!("stat promotion copy destination failed: {error}"))?;
    if final_descriptor != destination_stat
        || final_path != final_descriptor
        || !final_descriptor.is_file()
        || final_descriptor.len != bytes.len() as u64
    {
        return Err(
            "promotion copy destination changed during final observation; evidence retained"
                .to_string(),
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

/// Copy a complete directory tree between two already-bound roots.  The
/// destination must be empty; callers allocate it first and retain its
/// capability for the lifetime of the comparison.  Partial output is left in
/// place on failure so the owner can retain or remove it only after an
/// identity-bound teardown decision.
pub(crate) fn op_promotion_bound_copy_tree(req: &Value) -> Result<Value, String> {
    let (source_root, _source_identity, _source_capability) = open_promotion_bound_root(
        req,
        "sourceRoot",
        "sourceRootIdentity",
        "sourceRootCapability",
    )?;
    let (destination_root, _destination_identity, _destination_capability) =
        open_promotion_bound_root(
            req,
            "destinationRoot",
            "destinationRootIdentity",
            "destinationRootCapability",
        )?;
    promotion_test_pause(req, "promotion-copy-tree-roots-open")?;
    if !promotion_directory_is_empty(destination_root.as_raw_fd())? {
        return Err("promotion tree destination is not empty".to_string());
    }
    let max_bytes = req
        .get("maxBytes")
        .and_then(Value::as_u64)
        .unwrap_or(PROMOTION_COPY_TREE_MAX_BYTES);
    if max_bytes == 0 || max_bytes > PROMOTION_COPY_TREE_MAX_BYTES {
        return Err("promotion tree copy maxBytes exceeds its native budget".to_string());
    }
    let max_work_bytes = req
        .get("maxWorkBytes")
        .and_then(Value::as_u64)
        .unwrap_or(PROMOTION_COPY_TREE_MAX_WORK_BYTES);
    if max_work_bytes == 0 || max_work_bytes > PROMOTION_COPY_TREE_MAX_WORK_BYTES {
        return Err("promotion tree copy maxWorkBytes exceeds its native budget".to_string());
    }
    let mut budget = PromotionCopyBudget {
        bytes: 0,
        entries: 0,
        work_bytes: 0,
        max_bytes,
        max_entries: PROMOTION_COPY_TREE_MAX_ENTRIES,
        max_work_bytes,
    };
    promotion_copy_tree_contents(&source_root, &destination_root, &mut budget, "")?;
    source_root
        .sync_all()
        .map_err(|error| format!("sync promotion tree source failed: {error}"))?;
    destination_root
        .sync_all()
        .map_err(|error| format!("sync promotion tree destination failed: {error}"))?;
    promotion_test_pause(req, "promotion-copy-tree-final-observe")?;
    Ok(json!({
        "result": {
            "bytes": budget.bytes,
            "entries": budget.entries,
            "workBytes": budget.work_bytes,
        }
    }))
}
