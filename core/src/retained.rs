//! Retained promotion roots: validation, markers, provenance, root
//! state, and the root-transaction op.
use std::ffi::{CStr, CString};
use std::fs;
use std::io::{self, Read, Seek, SeekFrom};
use std::os::fd::AsRawFd;

use base64::Engine as _;
use serde_json::{Value, json};

use crate::util::{missing_path, open_at, open_at_mode, s, stat_at, stat_at_owned, stat_file, stat_file_owned};
use crate::FileIdentity;
use crate::PROMOTION_COMPONENT_MAX_BYTES;
use crate::promote_fs::{
    PromotionDirectoryStream, PromotionIdentity,
    issue_promotion_root_capability, open_promotion_absolute_directory,
    open_promotion_bound_root_values, promotion_absolute_path,
    promotion_component, promotion_directory_capability_result, promotion_directory_identity_matches,
    promotion_identity_from_value, promotion_mkdir_at, promotion_mode,
    promotion_private_identity_valid, promotion_rename_noreplace, promotion_set_mode,
    promotion_test_pause, promotion_write_all, stat_promotion_journal_file,
    stat_promotion_private_at,
};
pub(crate) const RETAINED_ROOT_MAX_ENTRIES: usize = 128 * 4;
pub(crate) const RETAINED_ROOT_MAX_SCAN_ENTRIES: usize = 250_000;
pub(crate) const RETAINED_ROOT_MAX_SCAN_DEPTH: usize = 64;
pub(crate) const RETAINED_ROOT_MAX_SCAN_BYTES: u64 = 4 * 1024 * 1024 * 1024;
pub(crate) const RETAINED_ROOT_MAX_SCAN_WORK_BYTES: u64 = 128 * 1024 * 1024;
pub(crate) const RETAINED_ROOT_MARKER_MAX_BYTES: usize = 128;
pub(crate) const RETAINED_ROOT_PROVENANCE_MAX_BYTES: usize = 4096;

/// Validate a directory opened through a trusted descriptor.  The retained
/// root uses the private variant; generic promotion roots only require the
/// current user to own the directory because a project root may be mode 755.
pub(crate) fn promotion_owned_directory(
    directory: &fs::File,
    field: &str,
    require_private: bool,
) -> Result<FileIdentity, String> {
    let (identity, uid) =
        stat_file_owned(directory).map_err(|error| format!("fstat promotion {field} failed: {error}"))?;
    if !identity.is_dir() {
        return Err(format!("promotion {field} is not a directory"));
    }
    if uid != unsafe { libc::geteuid() as u64 } {
        return Err(format!("promotion {field} is not owned by the current user"));
    }
    if require_private && identity.mode & 0o077 != 0 {
        return Err(format!("promotion {field} is not private"));
    }
    Ok(identity)
}

pub(crate) fn retained_root_safe_id(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

pub(crate) fn retained_root_hex_staging(name: &str) -> bool {
    name.len() == 34
        && name.starts_with("t-")
        && name[2..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) fn retained_root_claim(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(".termina-retained-claim-") else {
        return false;
    };
    let Some(run_id) = rest.strip_suffix(".json") else {
        return false;
    };
    retained_root_safe_id(run_id)
}

pub(crate) fn retained_root_metadata(name: &str) -> bool {
    name == ".termina-retained-session-root"
        || name == ".termina-retained-session-root.tmp"
        || name == ".termina-retained-session-admission.lock"
        || name == ".termina-retained-session-usage.json"
        || (name.starts_with(".termina-retained-session-usage.json.tmp-")
            && name.len() <= 256)
}

pub(crate) fn retained_root_top_level_name(name: &str) -> Result<bool, String> {
    if retained_root_metadata(name) {
        return Ok(false);
    }
    if retained_root_hex_staging(name) || retained_root_claim(name) || retained_root_safe_id(name) {
        return Ok(true);
    }
    Err(format!("retained session root contains an unexpected entry: {name}"))
}

pub(crate) struct RetainedRootScan {
    entries: usize,
    bytes: u64,
    work_bytes: u64,
}

/// Validate an existing retained tree while every directory component is
/// opened relative to the already-bound root descriptor. This is a
/// bounded structural proof only; Electron still performs the schema-aware
/// usage measurement before admission.  The walk is iterative so an
/// adversarial deep tree cannot consume native call-stack space.
pub(crate) fn promotion_validate_retained_directory(
    directory: &fs::File,
    depth: usize,
    root_level: bool,
    scan: &mut RetainedRootScan,
) -> Result<(), String> {
    struct RetainedScanFrame {
        directory: fs::File,
        stream: PromotionDirectoryStream,
        depth: usize,
        root_level: bool,
    }
    if depth > RETAINED_ROOT_MAX_SCAN_DEPTH {
        return Err("retained root exceeds its depth bound".to_string());
    }
    let mut stack = Vec::with_capacity(RETAINED_ROOT_MAX_SCAN_DEPTH + 1);
    stack.push(RetainedScanFrame {
        directory: directory
            .try_clone()
            .map_err(|error| format!("clone retained root directory failed: {error}"))?,
        stream: PromotionDirectoryStream::open(directory.as_raw_fd())?,
        depth,
        root_level,
    });
    let mut root_entry_count = 0usize;
    while !stack.is_empty() {
        let next = stack
            .last_mut()
            .expect("retained root scan stack is not empty")
            .stream
            .next_entry()?;
        let Some((name, c_name)) = next else {
            stack.pop();
            continue;
        };
        let frame = stack.last().expect("retained root scan frame exists");
        if frame.root_level {
            root_entry_count = root_entry_count
                .checked_add(1)
                .ok_or("retained root entry count overflow")?;
            if root_entry_count > RETAINED_ROOT_MAX_ENTRIES {
                return Err(format!(
                    "retained root contains too many entries ({RETAINED_ROOT_MAX_ENTRIES})"
                ));
            }
        }
        let added_work = u64::try_from(name.len())
            .map_err(|_| "retained root work overflow")?
            .checked_add(std::mem::size_of::<FileIdentity>() as u64)
            .ok_or("retained root work accounting overflow")?;
        scan.work_bytes = scan
            .work_bytes
            .checked_add(added_work)
            .ok_or("retained root work accounting overflow")?;
        if scan.work_bytes > RETAINED_ROOT_MAX_SCAN_WORK_BYTES {
            return Err("retained root scan exceeded its work bound".to_string());
        }
        if frame.root_level {
            retained_root_top_level_name(&name)?;
        }
        scan.entries = scan
            .entries
            .checked_add(1)
            .ok_or("retained root entry accounting overflow")?;
        if scan.entries > RETAINED_ROOT_MAX_SCAN_ENTRIES {
            return Err(format!(
                "retained root contains too many entries ({RETAINED_ROOT_MAX_SCAN_ENTRIES})"
            ));
        }
        let (directory_fd, depth) = (frame.directory.as_raw_fd(), frame.depth);
        let (identity, uid) = stat_at_owned(directory_fd, &c_name)
            .map_err(|error| format!("stat retained root entry {name} failed: {error}"))?;
        if uid != unsafe { libc::geteuid() as u64 } || identity.mode & 0o077 != 0 {
            return Err(format!("retained root entry {name} is not a private app-owned entry"));
        }
        if identity.is_symlink() || (!identity.is_dir() && !identity.is_file()) {
            return Err(format!("retained root entry {name} has an unsupported file type"));
        }
        if identity.is_file() {
            scan.bytes = scan
                .bytes
                .checked_add(identity.len)
                .ok_or("retained root byte accounting overflow")?;
            if scan.bytes > RETAINED_ROOT_MAX_SCAN_BYTES {
                return Err("retained root exceeds its byte bound".to_string());
            }
            let file = open_at(
                directory_fd,
                &c_name,
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|error| format!("open retained root file {name} failed: {error}"))?;
            if stat_file(&file)
                .map_err(|error| format!("fstat retained root file {name} failed: {error}"))?
                != identity
            {
                return Err(format!("retained root file {name} changed while validating"));
            }
            continue;
        }
        if depth >= RETAINED_ROOT_MAX_SCAN_DEPTH {
            return Err("retained root exceeds its depth bound".to_string());
        }
        let child = open_at(
            directory_fd,
            &c_name,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
        .map_err(|error| format!("open retained root directory {name} failed: {error}"))?;
        if stat_file(&child)
            .map_err(|error| format!("fstat retained root directory {name} failed: {error}"))?
            != identity
        {
            return Err(format!("retained root directory {name} changed while validating"));
        }
        if stack.len() >= RETAINED_ROOT_MAX_SCAN_DEPTH + 1 {
            return Err("retained root exceeds its depth bound".to_string());
        }
        stack.push(RetainedScanFrame {
            stream: PromotionDirectoryStream::open(child.as_raw_fd())?,
            directory: child,
            depth: depth + 1,
            root_level: false,
        });
    }
    Ok(())
}

pub(crate) fn promotion_validate_marker(
    root: &fs::File,
    name: &CStr,
    expected: &[u8],
    expected_mode: u32,
) -> Result<FileIdentity, String> {
    let (identity, bytes) = promotion_read_private_bounded_file(
        root,
        name,
        RETAINED_ROOT_MARKER_MAX_BYTES,
        "retained root marker",
    )?;
    if identity.mode & 0o777 != expected_mode || bytes != expected {
        return Err("retained root marker changed or is invalid".to_string());
    }
    Ok(identity)
}

pub(crate) fn promotion_create_bound_file(
    parent: &fs::File,
    name: &CStr,
    content: &[u8],
    mode: u32,
    field: &str,
    pause_stage: Option<(&Value, &str)>,
) -> Result<FileIdentity, String> {
    promotion_publish_private_exclusive(
        parent,
        name,
        content,
        mode,
        RETAINED_ROOT_MARKER_MAX_BYTES,
        field,
        pause_stage,
    )
}

/// Persist provenance below the descriptor-bound provenance parent. The
/// descriptor-relative temporary/no-replace publish keeps a crash from
/// exposing a partial final record. If another creator won the race, accept
/// only byte-for-byte equal durable provenance for the exact same root
/// identity.
pub(crate) fn promotion_persist_root_provenance(
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
        "promotion root provenance",
        pause_stage,
    )
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PromotionRootStateKind {
    Pending,
    Bound,
}

#[derive(Clone, Debug)]
pub(crate) struct PromotionRootState {
    kind: PromotionRootStateKind,
    path: String,
    parent: PromotionIdentity,
    root: PromotionIdentity,
    identity: FileIdentity,
}

/// Read one small private metadata file through the already-bound parent
/// descriptor. This is deliberately shared by the binding tombstone and
/// provenance paths so a pathname replacement cannot change the bytes between
/// the identity check and the read.
pub(crate) fn promotion_read_private_bounded_file(
    parent: &fs::File,
    name: &CStr,
    max_bytes: usize,
    field: &str,
) -> Result<(FileIdentity, Vec<u8>), String> {
    let file = open_at(
        parent.as_raw_fd(),
        name,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )
    .map_err(|error| format!("open {field} failed: {error}"))?;
    promotion_read_private_bounded_opened(parent, name, file, max_bytes, field)
}

pub(crate) fn promotion_read_private_bounded_if_present(
    parent: &fs::File,
    name: &CStr,
    max_bytes: usize,
    field: &str,
) -> Result<Option<(FileIdentity, Vec<u8>)>, String> {
    let file = match open_at(
        parent.as_raw_fd(),
        name,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    ) {
        Ok(file) => file,
        Err(error) if error.raw_os_error() == Some(libc::ENOENT) => return Ok(None),
        Err(error) => return Err(format!("open {field} failed: {error}")),
    };
    promotion_read_private_bounded_opened(parent, name, file, max_bytes, field).map(Some)
}

pub(crate) fn promotion_read_private_bounded_opened(
    parent: &fs::File,
    name: &CStr,
    mut file: fs::File,
    max_bytes: usize,
    field: &str,
) -> Result<(FileIdentity, Vec<u8>), String> {
    let before = stat_promotion_journal_file(&file)
        .map_err(|error| format!("fstat {field} failed: {error}"))?;
    if !promotion_private_identity_valid(before, None, max_bytes) {
        return Err(format!("{field} is not a bounded private app-owned file"));
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("seek {field} failed: {error}"))?;
    let mut bytes = Vec::new();
    (&file)
        .take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read {field} failed: {error}"))?;
    if bytes.len() > max_bytes {
        return Err(format!("{field} exceeds its bounded metadata size"));
    }
    let after = stat_promotion_journal_file(&file)
        .map_err(|error| format!("fstat {field} failed: {error}"))?;
    let path_after = stat_promotion_private_at(parent.as_raw_fd(), name)
        .map_err(|error| format!("stat {field} failed: {error}"))?;
    if before != after || after != path_after {
        return Err(format!("{field} changed while reading"));
    }
    Ok((after.file, bytes))
}

/// Derive the one recovery slot used when publishing a private metadata file.
/// The slot is descriptor-relative and deterministic: a killed writer cannot
/// leave an ever-growing sequence of process/clock-named files behind.
pub(crate) fn promotion_private_temporary_name(name: &CStr) -> Result<CString, String> {
    let mut bytes = name.to_bytes().to_vec();
    bytes.extend_from_slice(b".tmp");
    if bytes.len() > PROMOTION_COMPONENT_MAX_BYTES {
        return Err("promotion metadata temporary name is too long".to_string());
    }
    CString::new(bytes).map_err(|_| "promotion metadata temporary name contains NUL".to_string())
}

/// Publish one bounded private file with an exclusive, descriptor-relative
/// temporary followed by no-replace rename. The final name is never written
/// in place, so a crash can expose either the old complete record or the
/// complete temporary; it cannot expose a partially-written provenance,
/// state, or marker record. A racing creator is accepted only when its final
/// bytes are identical, preserving once-only identity binding.
pub(crate) fn promotion_publish_private_exclusive(
    parent: &fs::File,
    name: &CStr,
    content: &[u8],
    mode: u32,
    max_bytes: usize,
    field: &str,
    pause_stage: Option<(&Value, &str)>,
) -> Result<FileIdentity, String> {
    if content.is_empty() || content.len() > max_bytes {
        return Err(format!("{field} exceeds its bounded metadata size"));
    }

    // A complete final record is authoritative. Do not replace or rewrite
    // it, even when the caller is retrying after a process restart.
    if let Some(final_identity) = promotion_read_private_bounded_if_present(
        parent, name, max_bytes, field,
    )? {
        let final_stat = stat_promotion_private_at(parent.as_raw_fd(), name)
            .map_err(|error| format!("stat {field} failed: {error}"))?;
        if !promotion_private_identity_valid(final_stat, Some(mode), max_bytes)
            || final_stat.file != final_identity.0
        {
            return Err(format!("{field} is not a bounded private app-owned file"));
        }
        let (identity, observed) = final_identity;
        if observed != content {
            return Err(format!("{field} identity mismatch"));
        }
        parent
            .sync_all()
            .map_err(|error| format!("sync {field} parent failed: {error}"))?;
        return Ok(identity);
    }

    let temporary = promotion_private_temporary_name(name)?;
    let temporary_file = match open_at(
        parent.as_raw_fd(),
        &temporary,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    ) {
        Ok(file) => {
            let temporary_identity = stat_promotion_journal_file(&file)
                .map_err(|error| format!("fstat existing {field} temporary failed: {error}"))?;
            if !promotion_private_identity_valid(
                temporary_identity,
                Some(mode),
                max_bytes,
            ) {
                return Err(format!("{field} temporary is not a bounded private app-owned file"));
            }
            let (_, observed) = promotion_read_private_bounded_opened(
                parent,
                &temporary,
                file.try_clone()
                    .map_err(|error| format!("clone existing {field} temporary failed: {error}"))?,
                max_bytes,
                &format!("existing {field} temporary"),
            )?;
            if observed != content {
                return Err(format!("{field} temporary identity mismatch"));
            }
            file
        }
        Err(error) if error.raw_os_error() == Some(libc::ENOENT) => {
            let mut file = open_at_mode(
                parent.as_raw_fd(),
                &temporary,
                libc::O_RDWR
                    | libc::O_CREAT
                    | libc::O_EXCL
                    | libc::O_NOFOLLOW
                    | libc::O_CLOEXEC,
                mode as libc::mode_t,
            )
            .map_err(|error| format!("create {field} temporary failed: {error}"))?;
            promotion_write_all(&mut file, content, &format!("{field} temporary"))?;
            promotion_set_mode(&file, mode, &format!("{field} temporary"))?;
            file
                .sync_all()
                .map_err(|error| format!("sync {field} temporary failed: {error}"))?;
            let temporary_identity = stat_promotion_journal_file(&file)
                .map_err(|error| format!("fstat {field} temporary failed: {error}"))?;
            let temporary_path_identity = stat_promotion_private_at(parent.as_raw_fd(), &temporary)
                .map_err(|error| format!("stat {field} temporary failed: {error}"))?;
            if temporary_identity != temporary_path_identity
                || !promotion_private_identity_valid(temporary_identity, Some(mode), max_bytes)
                || temporary_identity.file.len != content.len() as u64
            {
                return Err(format!("{field} temporary changed while writing"));
            }
            file
        }
        Err(error) => return Err(format!("open {field} temporary failed: {error}")),
    };

    // Persist the directory entry for the recovery slot before publishing its
    // final name. A restart can therefore find and complete this exact
    // identity-bound record after a crash at any point before the rename.
    parent
        .sync_all()
        .map_err(|error| format!("sync {field} temporary parent failed: {error}"))?;
    if let Some((request, stage)) = pause_stage {
        promotion_test_pause(request, stage)?;
    }
    let temporary_before = stat_promotion_journal_file(&temporary_file)
        .map_err(|error| format!("fstat {field} temporary failed: {error}"))?;
    let temporary_path_before = stat_promotion_private_at(parent.as_raw_fd(), &temporary)
        .map_err(|error| format!("stat {field} temporary failed: {error}"))?;
    if temporary_before != temporary_path_before
        || !promotion_private_identity_valid(temporary_before, Some(mode), max_bytes)
    {
        return Err(format!("{field} temporary changed before publish"));
    }
    match promotion_rename_noreplace(
        parent.as_raw_fd(),
        &temporary,
        parent.as_raw_fd(),
        name,
    ) {
        Ok(()) => {}
        Err(error) if error.raw_os_error() == Some(libc::EEXIST) => {
            let (identity, observed) = promotion_read_private_bounded_file(
                parent, name, max_bytes, field,
            )?;
            if observed != content {
                return Err(format!("{field} identity mismatch after racing publish"));
            }
            parent
                .sync_all()
                .map_err(|sync_error| format!("sync {field} parent failed: {sync_error}"))?;
            return Ok(identity);
        }
        Err(error) => return Err(format!("publish {field} failed: {error}")),
    }
    parent
        .sync_all()
        .map_err(|error| format!("sync {field} parent failed: {error}"))?;
    let final_stat = stat_promotion_private_at(parent.as_raw_fd(), name)
        .map_err(|error| format!("stat {field} failed: {error}"))?;
    let descriptor_after = stat_promotion_journal_file(&temporary_file)
        .map_err(|error| format!("fstat {field} temporary after publish failed: {error}"))?;
    if descriptor_after != final_stat
        || !promotion_private_identity_valid(descriptor_after, Some(mode), max_bytes)
    {
        return Err(format!("{field} changed during publish"));
    }
    let (identity, observed) = promotion_read_private_bounded_opened(
        parent,
        name,
        temporary_file
            .try_clone()
            .map_err(|error| format!("clone published {field} failed: {error}"))?,
        max_bytes,
        field,
    )?;
    if observed != content {
        return Err(format!("{field} changed during publish"));
    }
    Ok(identity)
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
