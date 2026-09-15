//! Bounded pause/release seams for cross-process tests, never an indefinite
//! wait for a test owner that has exited. Callers own hook admission checks.
use std::fs;
use std::io;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

const PAUSE_TIMEOUT: Duration = Duration::from_secs(30);

/// Deterministic cross-process test seam. The core announces that it reached
/// a publication boundary, then waits for the spike process to release it.
pub(crate) fn pause_at_hook(req: &Value, name: &str) -> Result<(), String> {
    if std::env::var_os("TERMINA_CORE_TEST").is_none() {
        return Ok(());
    }
    let Some(hook) = req.pointer(&format!("/hooks/{name}")) else {
        return Ok(());
    };
    let ready = hook
        .get("readyPath")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing {name} readyPath"))?;
    let release = hook
        .get("releasePath")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing {name} releasePath"))?;
    crate::promote_fs::promotion_absolute_path(ready, "test hook readyPath")?;
    crate::promote_fs::promotion_absolute_path(release, "test hook releasePath")?;
    pause(ready, release, name)
}

pub(crate) fn pause(ready: &str, release: &str, name: &str) -> Result<(), String> {
    let parent = unsafe { libc::getppid() };
    fs::write(ready, b"ready").map_err(|e| format!("write {name} ready marker failed: {e}"))?;
    wait_for_release(
        Path::new(release),
        name,
        parent,
        Instant::now() + PAUSE_TIMEOUT,
    )
}

fn wait_for_release(
    release: &Path,
    name: &str,
    parent: libc::pid_t,
    deadline: Instant,
) -> Result<(), String> {
    loop {
        // Fail the paused operation rather than resume a mutation after its
        // owner died. In particular, a late release marker is not permission.
        if parent <= 1 || unsafe { libc::getppid() } != parent {
            return Err(format!("{name} test hook owner exited"));
        }
        match fs::symlink_metadata(release) {
            Ok(_) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("read {name} release marker failed: {error}")),
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(format!("timed out waiting for {name} release marker"));
        }
        thread::sleep(Duration::from_millis(5).min(deadline - now));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(0);

    struct Fixture(std::path::PathBuf);

    impl Fixture {
        fn new() -> Self {
            loop {
                let path = std::env::temp_dir().join(format!(
                    "termina-test-hook-{}-{}",
                    std::process::id(),
                    SEQ.fetch_add(1, Ordering::Relaxed)
                ));
                match fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(e) => panic!("create test fixture: {e}"),
                }
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn release_completes_the_pause() {
        let root = Fixture::new();
        let ready = root.0.join("ready");
        let release = root.0.join("release");
        fs::write(&release, b"release").unwrap();
        pause(ready.to_str().unwrap(), release.to_str().unwrap(), "test").unwrap();
        assert_eq!(fs::read(ready).unwrap(), b"ready");
    }

    #[test]
    fn abandoned_release_has_a_deadline() {
        let root = Fixture::new();
        let result = wait_for_release(
            &root.0.join("missing"),
            "test",
            unsafe { libc::getppid() },
            Instant::now(),
        );
        assert!(result.unwrap_err().contains("timed out"));
    }

    #[test]
    fn changed_owner_cannot_resume_even_with_a_release_marker() {
        let root = Fixture::new();
        let release = root.0.join("release");
        fs::write(&release, b"release").unwrap();
        let result = wait_for_release(
            &release,
            "test",
            unsafe { libc::getppid() } + 1,
            Instant::now() + PAUSE_TIMEOUT,
        );
        assert!(result.unwrap_err().contains("owner exited"));
    }

    #[test]
    fn invalid_marker_path_fails_instead_of_polling() {
        let root = Fixture::new();
        let file = root.0.join("not-a-directory");
        fs::write(&file, b"file").unwrap();
        let result = wait_for_release(
            &file.join("release"),
            "test",
            unsafe { libc::getppid() },
            Instant::now() + PAUSE_TIMEOUT,
        );
        assert!(result.unwrap_err().contains("release marker failed"));
    }
}

#[cfg(test)]
mod pause_at_hook_tests {
    use super::*;
    use serde_json::json;
    use std::ffi::OsString;
    use std::fs;

    /// Serializes the env-mutating tests below: Rust tests share one process,
    /// so concurrent set/remove of TERMINA_CORE_TEST would flake them.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Restores the process env on drop so a panic mid-test cannot leak
    /// TERMINA_CORE_TEST into other tests.
    struct EnvGuard {
        prior: Option<OsString>,
    }

    impl EnvGuard {
        fn set() -> Self {
            let prior = std::env::var_os("TERMINA_CORE_TEST");
            // SAFETY: ENV_LOCK serializes these tests against each other, and
            // no other test in this binary touches this variable.
            unsafe { std::env::set_var("TERMINA_CORE_TEST", "1") };
            Self { prior }
        }

        fn cleared() -> Self {
            let prior = std::env::var_os("TERMINA_CORE_TEST");
            // SAFETY: see set().
            unsafe { std::env::remove_var("TERMINA_CORE_TEST") };
            Self { prior }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            // SAFETY: see set().
            unsafe {
                if let Some(value) = self.prior.take() {
                    std::env::set_var("TERMINA_CORE_TEST", value);
                } else {
                    std::env::remove_var("TERMINA_CORE_TEST");
                }
            }
        }
    }

    struct Fixture(std::path::PathBuf);

    impl Fixture {
        fn named(name: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("termina-capture-hook-{}-{name}", std::process::id()));
            fs::create_dir_all(&path).expect("hook test fixture directory");
            Self(path)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).expect("hook test fixture cleanup");
        }
    }

    #[test]
    fn hook_payload_is_ignored_without_the_test_env() {
        let _lock = ENV_LOCK
            .lock()
            .expect("hook test env lock is never poisoned");
        let _env = EnvGuard::cleared();
        let marker = std::env::temp_dir().join(format!(
            "termina-capture-hook-{}-must-not-exist.ready",
            std::process::id()
        ));
        let req = json!({ "hooks": { "probe": {
            "readyPath": marker.to_str().expect("temp hook marker path is UTF-8"),
            "releasePath": marker.to_str().expect("temp hook marker path is UTF-8"),
        } } });
        assert!(pause_at_hook(&req, "probe").is_ok());
        assert!(!marker.exists());
    }

    #[test]
    fn relative_hook_paths_are_rejected_before_any_write() {
        let _lock = ENV_LOCK
            .lock()
            .expect("hook test env lock is never poisoned");
        let _env = EnvGuard::set();
        let req = json!({ "hooks": { "probe": {
            "readyPath": "relative-ready",
            "releasePath": "relative-release",
        } } });
        assert!(pause_at_hook(&req, "probe").is_err());
        assert!(!std::path::Path::new("relative-ready").exists());
    }

    #[test]
    fn absolute_hook_paths_pause_and_release() {
        let _lock = ENV_LOCK
            .lock()
            .expect("hook test env lock is never poisoned");
        let _env = EnvGuard::set();
        let root = Fixture::named("absolute");
        let ready = root.0.join("ready");
        let release = root.0.join("release");
        fs::write(&release, b"release").expect("hook test release marker write");
        let req = json!({ "hooks": { "probe": {
            "readyPath": ready.to_str().expect("temp hook path is UTF-8"),
            "releasePath": release.to_str().expect("temp hook path is UTF-8"),
        } } });
        assert!(pause_at_hook(&req, "probe").is_ok());
        assert_eq!(fs::read(ready).expect("hook test ready marker read"), b"ready");
    }
}
