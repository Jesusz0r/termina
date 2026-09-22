//! Capture hashing: rewrite-hook seams and descriptor-anchored blob writes.
use std::fs;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::time::SystemTime;

use git2::{Oid, Repository};
use serde_json::Value;

use crate::util::{open_at, read_link_at, stat_at, stat_file};
use crate::{StoreObjectTransaction, write_blob};

use super::binding::{AnchoredPath, CaptureRoot};

/// True when a capture path falls under a hook path: an exact match or a
/// suffix at a segment boundary.
fn hook_matches(rel_path: &str, hook_path: &str) -> bool {
    rel_path == hook_path
        || (rel_path.len() > hook_path.len()
            && rel_path.ends_with(hook_path)
            && rel_path.as_bytes()[rel_path.len() - hook_path.len() - 1] == b'/')
}

/// Rewrite-hook entries at one capture JSON pointer (`/hooks/beforeRead`
/// or `/hooks/afterCache`).
pub(crate) fn rewrite_hooks(
    req: &Value,
    pointer: &str,
) -> Result<Vec<(String, String, bool)>, String> {
    let Some(value) = req.pointer(pointer) else {
        return Ok(Vec::new());
    };
    let hooks = value
        .as_array()
        .ok_or_else(|| format!("{pointer} must be an array"))?;
    let mut out = Vec::with_capacity(hooks.len());
    for hook in hooks {
        let path = hook
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("missing {pointer} path"))?;
        let content = hook
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("missing {pointer} content"))?;
        let restore_mtime = match hook.get("restoreMtime") {
            None => false,
            Some(Value::Bool(value)) => *value,
            Some(_) => {
                return Err(format!("{pointer} restoreMtime must be a boolean"));
            }
        };
        out.push((path.to_string(), content.to_string(), restore_mtime));
    }
    Ok(out)
}

/// Apply the spike-only rewrite after the read descriptor is open. Opening
/// through the retained parent descriptor keeps the seam inside the same
/// capture boundary as production reads. A requested hook that cannot
/// apply fails the capture instead of hashing the original bytes.
pub(crate) fn apply_rewrite_hooks(
    path: &AnchoredPath,
    before_read: &[(String, String, bool)],
    original_mtime: Option<SystemTime>,
) -> Result<(), String> {
    for (hook_path, content, restore_mtime) in before_read {
        if !hook_matches(&path.rel_path, hook_path) {
            continue;
        }
        let mut target = open_at(
            path.parent.as_raw_fd(),
            &path.leaf,
            libc::O_WRONLY | libc::O_TRUNC | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
        .map_err(|e| format!("rewrite hook open failed for {}: {e}", path.rel_path))?;
        target
            .write_all(content.as_bytes())
            .map_err(|e| format!("rewrite hook write failed for {}: {e}", path.rel_path))?;
        if *restore_mtime {
            let modified = original_mtime.ok_or_else(|| {
                format!("rewrite hook cannot restore mtime for {}", path.rel_path)
            })?;
            target
                .set_times(fs::FileTimes::new().set_modified(modified))
                .map_err(|e| {
                    format!(
                        "rewrite hook restore mtime failed for {}: {e}",
                        path.rel_path
                    )
                })?;
        }
    }
    Ok(())
}

/// Hash one descriptor-anchored working-tree path into the store. Returns
/// None for a directory (a gitlink). Returns (mode, oid, new bytes).
pub(crate) fn hash_path(
    transaction: &mut StoreObjectTransaction,
    repo: &Repository,
    capture_root: &CaptureRoot,
    path: AnchoredPath,
    max_file_bytes: u64,
    current_new_blob_bytes: u64,
    max_new_blob_bytes: u64,
    before_read: &[(String, String, bool)],
) -> Result<Option<(u32, Oid, u64)>, String> {
    let display = capture_root.display_path(&path.rel_path);
    if path.identity.is_symlink() {
        let bytes = read_link_at(path.parent.as_raw_fd(), &path.leaf)
            .map_err(|e| format!("readlink failed for {}: {e}", display.display()))?;
        let after = stat_at(path.parent.as_raw_fd(), &path.leaf)
            .map_err(|_| format!("symlink vanished while captured: {}", display.display()))?;
        if path.identity != after {
            return Err(format!(
                "symlink changed while captured: {}",
                display.display()
            ));
        }
        std::str::from_utf8(&bytes)
            .map_err(|_| format!("symlink target is not valid UTF-8: {}", display.display()))?;
        let link_bytes =
            u64::try_from(bytes.len()).map_err(|_| "symlink length does not fit u64")?;
        if link_bytes > max_file_bytes {
            return Err(format!(
                "symlink exceeds the {max_file_bytes} byte budget: {}",
                display.display()
            ));
        }
        let (oid, new_bytes) = write_blob(
            transaction,
            repo,
            &bytes,
            current_new_blob_bytes,
            max_new_blob_bytes,
            None,
        )?;
        return Ok(Some((0o120000, oid, new_bytes)));
    }
    if path.identity.is_dir() {
        return Ok(None);
    }
    if !path.identity.is_file() {
        return Err("unsupported file type".to_string());
    }
    if path.identity.len > max_file_bytes {
        return Err(format!(
            "file exceeds the {max_file_bytes} byte budget: {}",
            display.display()
        ));
    }
    let mut file = open_at(
        path.parent.as_raw_fd(),
        &path.leaf,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
    )
    .map_err(|e| format!("open failed for {}: {e}", display.display()))?;
    let before = stat_file(&file).map_err(|e| format!("fstat failed: {e}"))?;
    if path.identity != before || !before.is_file() {
        return Err(format!(
            "file replaced while captured: {}",
            display.display()
        ));
    }
    let original_mtime = if before_read.iter().any(|(_, _, restore)| *restore) {
        Some(
            file.metadata()
                .and_then(|metadata| metadata.modified())
                .map_err(|e| format!("rewrite hook mtime failed: {e}"))?,
        )
    } else {
        None
    };
    apply_rewrite_hooks(&path, before_read, original_mtime)?;
    let mut bytes = Vec::new();
    let read_limit = max_file_bytes.checked_add(1).unwrap_or(u64::MAX);
    Read::by_ref(&mut file)
        .take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read failed: {e}"))?;
    let after = stat_file(&file).map_err(|e| format!("fstat failed: {e}"))?;
    if before != after {
        return Err(format!(
            "file changed while captured: {}",
            display.display()
        ));
    }
    let path_after = stat_at(path.parent.as_raw_fd(), &path.leaf)
        .map_err(|_| format!("file vanished while captured: {}", display.display()))?;
    if path_after != after {
        return Err(format!(
            "file replaced while captured: {}",
            display.display()
        ));
    }
    // The stat above approved the size. A file can grow between the stat
    // and the read: verify the budget again after the bytes are in memory.
    if bytes.len() as u64 > max_file_bytes {
        return Err(format!(
            "file grew past the {max_file_bytes} byte budget while captured: {}",
            display.display()
        ));
    }
    let mode = if before.mode & 0o111 != 0 {
        0o100755
    } else {
        0o100644
    };
    let (oid, new_bytes) = write_blob(
        transaction,
        repo,
        &bytes,
        current_new_blob_bytes,
        max_new_blob_bytes,
        None,
    )?;
    Ok(Some((mode, oid, new_bytes)))
}

#[cfg(test)]
mod tests {
    use super::super::binding::CaptureRoot;
    use super::{apply_rewrite_hooks, rewrite_hooks};
    use serde_json::json;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            loop {
                let path = std::env::temp_dir().join(format!(
                    "termina-rewrite-{}-{}",
                    std::process::id(),
                    SEQ.fetch_add(1, Ordering::Relaxed)
                ));
                match fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("create rewrite fixture: {error}"),
                }
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn rewrite_hooks_reject_malformed_entries() {
        let err = rewrite_hooks(
            &json!({ "hooks": { "beforeRead": [{ "path": "a.txt" }] } }),
            "/hooks/beforeRead",
        )
        .expect_err("incomplete hook must fail closed");
        assert!(
            err.contains("missing /hooks/beforeRead content"),
            "expected missing content, got {err}"
        );
    }

    #[test]
    fn rewrite_hook_open_failure_fails_closed() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("target.txt"), "original\n").expect("write target");
        let mut permissions = fs::metadata(fixture.0.join("target.txt"))
            .expect("stat target")
            .permissions();
        permissions.set_mode(0o444);
        fs::set_permissions(fixture.0.join("target.txt"), permissions).expect("chmod target");
        let root = CaptureRoot::open(&fixture.0).expect("open capture root");
        let path = root
            .resolve("target.txt")
            .expect("resolve")
            .expect("target exists");
        let err = apply_rewrite_hooks(
            &path,
            &[("target.txt".to_string(), "rewritten\n".to_string(), false)],
            None,
        )
        .expect_err("unwritable hook target must fail closed");
        assert!(
            err.contains("rewrite hook open failed"),
            "expected open error, got {err}"
        );
        let original = fs::read_to_string(fixture.0.join("target.txt")).expect("read original");
        assert_eq!(original, "original\n");
    }

    #[test]
    fn rewrite_hook_restore_mtime_without_mtime_fails_closed() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("target.txt"), "original\n").expect("write target");
        let root = CaptureRoot::open(&fixture.0).expect("open capture root");
        let path = root
            .resolve("target.txt")
            .expect("resolve")
            .expect("target exists");
        let err = apply_rewrite_hooks(
            &path,
            &[("target.txt".to_string(), "rewritten\n".to_string(), true)],
            None,
        )
        .expect_err("restoreMtime without a captured mtime must fail closed");
        assert!(
            err.contains("rewrite hook cannot restore mtime"),
            "expected mtime error, got {err}"
        );
    }
}
