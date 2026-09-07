//! Promotion-bound file ops: open, list, prepare, ensure, journal/file
//! reads, create, write, copy, symlink, and install-directory.
use std::ffi::{CStr, CString};
use std::io::{self, Read};
use std::os::fd::{AsRawFd, RawFd};

use base64::Engine as _;
use serde_json::{Value, json};

use crate::{
    BUDGET_MAX_FILE_BYTES,
    PROMOTION_COPY_TREE_MAX_BYTES,
    PROMOTION_COPY_TREE_MAX_ENTRIES,
    PROMOTION_COPY_TREE_MAX_WORK_BYTES,
    PROMOTION_DIRECTORY_MAX_NAME_BYTES,
    PROMOTION_PATH_MAX_BYTES,
    PROMOTION_JOURNAL_MAX_BYTES,
    PROMOTION_RECOVERY_ROOT_MAX_ENTRIES,
};
use crate::util::{
    missing_path,
    open_at,
    open_at_mode,
    s,
    stat_at,
    stat_file,
};
use crate::store::FileIdentity;
use crate::retained::op_promotion_bound_root_transaction;
use crate::capture::read_link_at;
use crate::copy::{
    PromotionCopyBudget, promotion_copy_tree_contents, promotion_expected_directory,
    promotion_leaf_result,
};
use crate::promote_fs::{
    PromotionDirectoryStream, PromotionIdentity, PromotionObservedLeaf,
    issue_promotion_root_capability, observe_promotion_leaf, open_or_create_promotion_parent,
    open_promotion_bound_root,
    open_promotion_bound_root_values, open_promotion_parent, parse_promotion_expected,
    parse_promotion_expected_destination,
    promotion_bound_path_matches, promotion_component,
    promotion_components_for, promotion_components_value,
    promotion_directory_identity_matches, promotion_directory_is_empty, promotion_expected_matches,
    promotion_identity_chain_from_value, promotion_identity_from_value, promotion_mkdir_at,
    promotion_mode, promotion_path_with_components, promotion_rename_noreplace,
    promotion_set_mode, promotion_sha256_hex, promotion_symlink_at, promotion_test_pause,
    promotion_write_all, stat_promotion_journal_file,
    PromotionExpectedLeaf,
    PromotionExpectedState,
    PromotionObservedState,
    promotion_directory_capability_result,
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


pub(crate) fn promotion_cleanup_same_namespace_identity(actual: FileIdentity, expected: FileIdentity) -> bool {
    actual.dev == expected.dev
        && actual.ino == expected.ino
        && actual.file_type() == expected.file_type()
}


pub(crate) fn promotion_rename_exchange(
    source_parent: RawFd,
    source: &CStr,
    destination_parent: RawFd,
    destination: &CStr,
) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        let rc = unsafe {
            libc::renameat2(
                source_parent,
                source.as_ptr(),
                destination_parent,
                destination.as_ptr(),
                libc::RENAME_EXCHANGE,
            )
        };
        if rc == -1 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
    #[cfg(target_os = "macos")]
    {
        let rc = unsafe {
            libc::renameatx_np(
                source_parent,
                source.as_ptr(),
                destination_parent,
                destination.as_ptr(),
                libc::RENAME_SWAP,
            )
        };
        if rc == -1 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (source_parent, source, destination_parent, destination);
        Err(io::Error::from_raw_os_error(libc::ENOTSUP))
    }
}


pub(crate) fn promotion_rename_unsupported(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(libc::ENOSYS | libc::EINVAL | libc::ENOTSUP | libc::EOPNOTSUPP)
    )
}

pub(crate) fn promotion_transition_result(
    transition: &str,
    outcome: &str,
    durable: bool,
    retained_name: Option<&str>,
    error: Option<String>,
) -> Value {
    json!({
        "result": {
            "outcome": outcome,
            "transition": transition,
            "durable": durable,
            "retainedName": retained_name,
            "error": error,
        }
    })
}

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
/// the mutable root leaf.  The file descriptor and its parent/name identity
/// are checked before and after the bounded read so a pathname replacement
/// cannot supply or alter the provenance bytes.
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
    let opened = stat_promotion_journal_file(&file)
        .map_err(|error| format!("fstat promotion read file failed: {error}"))?;
    if !opened.file.is_file()
        || opened.file.mode & 0o077 != 0
        || opened.uid != unsafe { libc::geteuid() as u64 }
        || opened.links != 1
        || opened.file.len > max_bytes
    {
        return Err("promotion read file is not a bounded private regular file".to_string());
    }
    if let Some(expected) = expected {
        if opened.file.dev != expected.dev || opened.file.ino != expected.ino {
            return Err("promotion read file identity mismatch".to_string());
        }
    }
    let mut bytes = Vec::new();
    let read_limit = max_bytes
        .checked_add(1)
        .ok_or("promotion read file budget overflow")?;
    (&file)
        .take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read promotion file failed: {error}"))?;
    if bytes.len() as u64 > max_bytes {
        return Err("promotion read file exceeds its bounded read budget".to_string());
    }
    let after = stat_promotion_journal_file(&file)
        .map_err(|error| format!("fstat promotion read file failed: {error}"))?;
    let path_after = stat_at(parent.as_raw_fd(), leaf)
        .map_err(|error| format!("stat promotion read file failed: {error}"))?;
    if opened != after || after.file != path_after {
        return Err("promotion read file changed while reading".to_string());
    }
    Ok(json!({
        "content": base64::engine::general_purpose::STANDARD.encode(&bytes),
        "byteLength": bytes.len(),
        "identity": {
            "dev": after.file.dev.to_string(),
            "ino": after.file.ino.to_string(),
        },
    }))
}



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
