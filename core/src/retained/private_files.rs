//! Private retained metadata files: bounded reads and exclusive publish.
use std::ffi::{CStr, CString};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::os::fd::AsRawFd;

use serde_json::Value;

use crate::util::{
    open_at,
    open_at_mode,
};
use crate::FileIdentity;
use crate::PROMOTION_COMPONENT_MAX_BYTES;
use crate::promote_fs::{
    promotion_private_identity_valid,
    promotion_rename_noreplace,
    promotion_set_mode,
    promotion_test_pause,
    promotion_write_all,
    stat_promotion_journal_file,
    stat_promotion_private_at,
};

use super::{RETAINED_ROOT_MARKER_MAX_BYTES, RETAINED_ROOT_PROVENANCE_MAX_BYTES};


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
