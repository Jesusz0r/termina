//! Raw descriptor-relative promotion I/O: streams, mutation, and identity checks.
use std::ffi::{CStr, CString};
use std::fs;
use std::io::{self, Write};
use std::os::fd::{AsRawFd, RawFd};

use serde_json::Value;

use crate::{
    PROMOTION_COMPONENT_MAX_BYTES,
    PROMOTION_PATH_MAX_BYTES,
};
use crate::util::stat_file;
use crate::FileIdentity;

use super::capability::PromotionIdentity;
use super::expected::promotion_absolute_path;

pub(crate) fn promotion_mkdir_at(parent: RawFd, name: &CStr, mode: libc::mode_t) -> io::Result<()> {
    let rc = unsafe { libc::mkdirat(parent, name.as_ptr(), mode) };
    if rc == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub(crate) fn promotion_symlink_at(target: &CStr, parent: RawFd, name: &CStr) -> io::Result<()> {
    let rc = unsafe { libc::symlinkat(target.as_ptr(), parent, name.as_ptr()) };
    if rc == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Read directory names through a descriptor. `std::fs::read_dir` is not
/// suitable for this boundary because it would re-resolve the directory by
/// pathname after an ancestor swap.
pub(crate) fn promotion_clear_errno() {
    #[cfg(target_os = "linux")]
    unsafe {
        *libc::__errno_location() = 0;
    }
    #[cfg(target_os = "macos")]
    unsafe {
        *libc::__error() = 0;
    }
}

pub(crate) fn promotion_errno() -> i32 {
    #[cfg(target_os = "linux")]
    unsafe {
        *libc::__errno_location()
    }
    #[cfg(target_os = "macos")]
    unsafe {
        *libc::__error()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        0
    }
}

/// One descriptor-relative directory stream. Keeping the `DIR *` open while
/// an iterative walk descends means each frame holds only one native stream,
/// not a collected names vector for every ancestor.
pub(crate) struct PromotionDirectoryStream {
    stream: *mut libc::DIR,
}

impl PromotionDirectoryStream {
    pub(crate) fn open(dir: RawFd) -> Result<Self, String> {
        // `dup` shares the directory stream offset with the caller. Open `.`
        // through the bound descriptor instead so repeated scans (including
        // quarantine accounting followed by container reuse) remain
        // independent of the caller's stream state.
        let dot = CString::new(".").expect("directory component has no NUL");
        let duplicate = unsafe {
            libc::openat(
                dir,
                dot.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if duplicate == -1 {
            return Err(format!(
                "duplicate promotion directory descriptor failed: {}",
                io::Error::last_os_error()
            ));
        }
        let stream = unsafe { libc::fdopendir(duplicate) };
        if stream.is_null() {
            let error = io::Error::last_os_error();
            unsafe { libc::close(duplicate) };
            return Err(format!("open promotion directory stream failed: {error}"));
        }
        Ok(Self { stream })
    }

    pub(crate) fn next_entry(&mut self) -> Result<Option<(String, CString)>, String> {
        loop {
            promotion_clear_errno();
            let entry = unsafe { libc::readdir(self.stream) };
            if entry.is_null() {
                let error = promotion_errno();
                if error != 0 {
                    return Err(format!(
                        "read promotion directory failed: {}",
                        io::Error::from_raw_os_error(error)
                    ));
                }
                return Ok(None);
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
            if name.to_bytes() == b"." || name.to_bytes() == b".." {
                continue;
            }
            let text = std::str::from_utf8(name.to_bytes())
                .map_err(|_| "promotion directory contains a non-UTF-8 name".to_string())?;
            if text.len() > PROMOTION_COMPONENT_MAX_BYTES {
                return Err("promotion directory entry name is too long".to_string());
            }
            let c_name = CString::new(name.to_bytes())
                .map_err(|_| "promotion directory contains a NUL name".to_string())?;
            return Ok(Some((text.to_string(), c_name)));
        }
    }
}

impl Drop for PromotionDirectoryStream {
    fn drop(&mut self) {
        unsafe {
            libc::closedir(self.stream);
        }
    }
}

/// Check emptiness without materializing the directory names. This is used by
/// copy/template destinations where the answer is a boolean; allocating a
/// vector there lets a hostile breadth fan out consume the entire collector
/// envelope before the caller can do useful work.
pub(crate) fn promotion_directory_is_empty(dir: RawFd) -> Result<bool, String> {
    let mut stream = PromotionDirectoryStream::open(dir)?;
    Ok(stream.next_entry()?.is_none())
}

pub(crate) fn promotion_child_relative(relative: &str, name: &str) -> Result<String, String> {
    let child = if relative.is_empty() {
        name.to_string()
    } else {
        format!("{relative}/{name}")
    };
    if child.len() > PROMOTION_PATH_MAX_BYTES {
        return Err("promotion traversal path exceeds its bounded work budget".to_string());
    }
    Ok(child)
}

pub(crate) fn promotion_path_work_bytes(relative: &str, name: &str) -> Result<u64, String> {
    let path_len = relative
        .len()
        .checked_add(if relative.is_empty() { 0 } else { 1 })
        .and_then(|length| length.checked_add(name.len()))
        .filter(|length| *length <= PROMOTION_PATH_MAX_BYTES)
        .ok_or("promotion traversal path exceeds its bounded work budget")?;
    let path_len = u64::try_from(path_len).map_err(|_| "promotion traversal work overflow")?;
    let name_len = u64::try_from(name.len()).map_err(|_| "promotion traversal work overflow")?;
    path_len
        .checked_add(name_len)
        .and_then(|work| work.checked_add(std::mem::size_of::<FileIdentity>() as u64))
        .ok_or_else(|| "promotion traversal work accounting overflow".to_string())
}

pub(crate) fn promotion_add_work(
    work: &mut u64,
    amount: u64,
    max: u64,
    field: &str,
) -> Result<(), String> {
    *work = work
        .checked_add(amount)
        .ok_or_else(|| format!("{field} work accounting overflow"))?;
    if *work > max {
        return Err(format!("{field} exceeds its work bound"));
    }
    Ok(())
}

pub(crate) fn promotion_write_all(file: &mut fs::File, bytes: &[u8], field: &str) -> Result<(), String> {
    file.write_all(bytes)
        .map_err(|error| format!("write promotion {field} failed: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("sync promotion {field} failed: {error}"))
}

pub(crate) fn promotion_set_mode(file: &fs::File, mode: u32, field: &str) -> Result<(), String> {
    let rc = unsafe { libc::fchmod(file.as_raw_fd(), mode as libc::mode_t) };
    if rc == -1 {
        return Err(format!(
            "chmod promotion {field} failed: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(())
}

/// Remove one entry through its already-open parent descriptor.  No pathname
/// is re-resolved and a directory is never accepted by the regular unlink
/// path.  Callers must have performed any identity/type checks before invoking
/// this helper.
pub(crate) fn promotion_unlink_at_field(
    parent: RawFd,
    name: &CStr,
    is_dir: bool,
    field: &str,
) -> Result<(), String> {
    let flags = if is_dir { libc::AT_REMOVEDIR } else { 0 };
    let rc = unsafe { libc::unlinkat(parent, name.as_ptr(), flags) };
    if rc == -1 {
        return Err(format!(
            "remove promotion {field} failed: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(())
}

pub(crate) fn promotion_directory_identity_matches(
    file: &fs::File,
    expected: PromotionIdentity,
    field: &str,
) -> Result<(), String> {
    let actual =
        stat_file(file).map_err(|error| format!("fstat promotion {field} failed: {error}"))?;
    if !actual.is_dir() || actual.dev != expected.dev || actual.ino != expected.ino {
        return Err(format!("promotion {field} identity mismatch"));
    }
    Ok(())
}

pub(crate) fn stat_promotion_journal_file(file: &fs::File) -> io::Result<PromotionJournalFileIdentity> {
    let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
    let rc = unsafe { libc::fstat(file.as_raw_fd(), st.as_mut_ptr()) };
    if rc == -1 {
        Err(io::Error::last_os_error())
    } else {
        let st = unsafe { st.assume_init() };
        Ok(PromotionJournalFileIdentity {
            file: FileIdentity::from_stat(&st),
            uid: st.st_uid as u64,
            links: st.st_nlink as u64,
        })
    }
}

pub(crate) fn stat_promotion_private_at(parent: RawFd, name: &CStr) -> io::Result<PromotionJournalFileIdentity> {
    let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
    let rc = unsafe {
        libc::fstatat(
            parent,
            name.as_ptr(),
            st.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if rc == -1 {
        Err(io::Error::last_os_error())
    } else {
        let st = unsafe { st.assume_init() };
        Ok(PromotionJournalFileIdentity {
            file: FileIdentity::from_stat(&st),
            uid: st.st_uid as u64,
            links: st.st_nlink as u64,
        })
    }
}

pub(crate) fn promotion_private_identity_valid(
    identity: PromotionJournalFileIdentity,
    mode: Option<u32>,
    max_bytes: usize,
) -> bool {
    identity.file.is_file()
        && identity.uid == unsafe { libc::geteuid() as u64 }
        && identity.links == 1
        && identity.file.mode & 0o077 == 0
        && mode.is_none_or(|expected| identity.file.mode & 0o777 == expected)
        && identity.file.len <= max_bytes as u64
}

pub(crate) fn promotion_test_pause(req: &Value, stage: &str) -> Result<(), String> {
    if std::env::var_os("TERMINA_CORE_TEST").is_none() {
        return Ok(());
    }
    let Some(hook) = req.get("testHook").and_then(Value::as_object) else {
        return Ok(());
    };
    if hook.get("stage").and_then(Value::as_str) != Some(stage) {
        return Ok(());
    }
    let ready = hook
        .get("readyPath")
        .and_then(Value::as_str)
        .ok_or("promotion test hook readyPath is missing")?;
    let release = hook
        .get("releasePath")
        .and_then(Value::as_str)
        .ok_or("promotion test hook releasePath is missing")?;
    promotion_absolute_path(ready, "test hook readyPath")?;
    promotion_absolute_path(release, "test hook releasePath")?;
    crate::test_hooks::pause(ready, release, "promotion")
}

pub(crate) fn promotion_rename_noreplace(
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
                libc::RENAME_NOREPLACE,
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
                libc::RENAME_EXCL,
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

pub(crate) fn promotion_mode(value: Option<&Value>, field: &str, default: u32) -> Result<u32, String> {
    let mode = value.and_then(Value::as_u64).unwrap_or(u64::from(default));
    if mode > 0o777 {
        return Err(format!("{field} is invalid"));
    }
    Ok(mode as u32)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct PromotionJournalFileIdentity {
    pub(crate) file: FileIdentity,
    pub(crate) uid: u64,
    pub(crate) links: u64,
}
