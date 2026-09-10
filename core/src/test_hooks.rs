//! Bounded pause/release seams for cross-process tests, never an indefinite
//! wait for a test owner that has exited. Callers own hook admission checks.
use std::fs;
use std::io;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

const PAUSE_TIMEOUT: Duration = Duration::from_secs(30);

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
