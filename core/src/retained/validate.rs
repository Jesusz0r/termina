//! Retained-root validation: shape proofs, markers, and scan envelopes.
use std::ffi::CStr;
use std::fs;
use std::os::fd::AsRawFd;


use crate::util::{
    open_at,
    stat_at_owned,
    stat_file,
    stat_file_owned,
};
use crate::FileIdentity;
use crate::promote_fs::{
    PromotionDirectoryStream,
};

use super::{RETAINED_ROOT_MARKER_MAX_BYTES, RETAINED_ROOT_MAX_ENTRIES, RETAINED_ROOT_MAX_SCAN_BYTES, RETAINED_ROOT_MAX_SCAN_DEPTH, RETAINED_ROOT_MAX_SCAN_ENTRIES, RETAINED_ROOT_MAX_SCAN_WORK_BYTES};
use super::private_files::promotion_read_private_bounded_file;

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
    pub(crate) entries: usize,
    pub(crate) bytes: u64,
    pub(crate) work_bytes: u64,
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
