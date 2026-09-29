//! Shared unit-test temp-dir fixture.
//!
//! One owner for `pid + SEQ` temp dirs in `core` unit tests. Integration
//! tests use `core/tests/common/mod.rs`; unit tests inside `src/` cannot
//! import that helper, so they share this one instead of re-implementing
//! the same loop. Production code must not use it: prod temp state lives
//! under the store/transaction/quarantine roots with journaling and fsyncs.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

/// Owned temporary directory. Removed on drop.
pub(crate) struct TestTempDir {
    path: PathBuf,
}

impl TestTempDir {
    pub(crate) fn new(prefix: &str) -> Self {
        debug_assert!(
            !prefix.contains('/') && !prefix.contains('\0'),
            "test fixture prefix must be a single path component"
        );
        loop {
            let candidate = std::env::temp_dir().join(format!(
                "termina-{prefix}-{}-{}",
                std::process::id(),
                SEQ.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&candidate) {
                Ok(()) => {
                    let canonical = fs::canonicalize(&candidate).unwrap_or(candidate);
                    return Self { path: canonical };
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("create test fixture {prefix}: {error}"),
            }
        }
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn join(&self, name: impl AsRef<Path>) -> PathBuf {
        self.path.join(name)
    }
}

impl Drop for TestTempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
