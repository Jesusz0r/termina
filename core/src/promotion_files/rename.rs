//! Promotion rename helpers: same-namespace checks, exchange, and results.
use std::ffi::CStr;
use std::io::self;
use std::os::fd::RawFd;

use serde_json::{Value, json};

use crate::store::FileIdentity;

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
