//! State commits, transaction refs, and test hooks.
use std::fs;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;

use git2::{Oid, Repository, Signature};
use serde_json::Value;
use crate::util::{
    object_oid,
    oid_ext,
};
use crate::{
    StoreObjectTransaction,
    ensure_real_directory,
    sync_directory_nofollow,
    write_transaction_object_with_oid,
};

/// Create the synthetic state commit.
pub(crate) fn commit_tree(
    transaction: &mut StoreObjectTransaction,
    repo: &Repository,
    tree: Oid,
    parents: &[git2::Commit<'_>],
    message: &str,
) -> Result<Oid, String> {
    // Future callers cannot accidentally ask libgit2 to resolve a tree that
    // is still only in the private staging ledger.
    transaction.flush(repo)?;
    let signature = Signature::now("termina", "dev@termina.local").map_err(|e| e.to_string())?;
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    let tree_obj = repo.find_tree(tree).map_err(|e| e.to_string())?;
    let content = repo
        .commit_create_buffer(&signature, &signature, message, &tree_obj, &parent_refs)
        .map_err(|e| format!("commit buffer failed: {e}"))?;
    let oid = object_oid(repo, "commit", content.as_ref());
    let written = write_transaction_object_with_oid(transaction, repo, "commit", content.as_ref(), oid)?.0;
    if written != oid {
        return Err("state commit oid changed while staged".to_string());
    }
    transaction.set_intended_ref(format!("refs/termina/state/{oid}"), oid)?;
    Ok(oid)
}

pub(crate) fn exact_ref_target(repo: &Repository, name: &str) -> Option<Oid> {
    repo.find_reference(name)
        .ok()
        .and_then(|reference| reference.target())
}

pub(crate) fn validate_transaction_ref(
    repo: &Repository,
    name: &str,
    target_hex: &str,
) -> Result<Oid, String> {
    let target = oid_ext(repo, target_hex)
        .map_err(|_| format!("invalid transaction ref target: {target_hex}"))?;
    let canonical_target = target.to_string();
    let state = format!("refs/termina/state/{canonical_target}");
    let merge = format!("refs/termina/merge/{canonical_target}");
    if name != state && name != merge {
        return Err(format!("invalid transaction ref name: {name}"));
    }
    Ok(target)
}

pub(crate) fn prepare_transaction_ref_path(
    repo: &Repository,
    name: &str,
    target: Oid,
) -> Result<PathBuf, String> {
    validate_transaction_ref(repo, name, &target.to_string())?;
    let git_dir = repo.path();
    if !fs::symlink_metadata(git_dir)
        .map_err(|e| format!("inspect store git directory failed: {e}"))?
        .file_type()
        .is_dir()
    {
        return Err("store git path is not a real directory".to_string());
    }
    let refs = git_dir.join("refs");
    let termina = refs.join("termina");
    let namespace = if name.starts_with("refs/termina/state/") {
        termina.join("state")
    } else {
        termina.join("merge")
    };
    ensure_real_directory(&refs, 0o755)?;
    ensure_real_directory(&termina, 0o755)?;
    ensure_real_directory(&namespace, 0o755)?;
    Ok(git_dir.join(name))
}

/// Make an exact loose transaction ref and every ancestor directory durable,
/// then reread the direct target. Visibility before this barrier is not a
/// committed publication.
pub(crate) fn sync_exact_transaction_ref(repo: &Repository, name: &str, target: Oid) -> Result<u64, String> {
    let ref_path = prepare_transaction_ref_path(repo, name, target)?;
    if exact_ref_target(repo, name) != Some(target) {
        return Err(format!(
            "transaction ref is not visible at exact target: {name}"
        ));
    }
    let ref_file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&ref_path)
        .map_err(|e| format!("open transaction ref {} failed: {e}", ref_path.display()))?;
    if !ref_file
        .metadata()
        .map_err(|e| format!("inspect transaction ref failed: {e}"))?
        .file_type()
        .is_file()
    {
        return Err(format!(
            "transaction ref is not a regular file: {}",
            ref_path.display()
        ));
    }
    ref_file
        .sync_all()
        .map_err(|e| format!("sync transaction ref {} failed: {e}", ref_path.display()))?;

    let git_dir = repo.path();
    let mut current = ref_path
        .parent()
        .ok_or("transaction ref has no parent directory")?;
    let mut directory_count = 0u64;
    loop {
        if !current.starts_with(git_dir) {
            return Err("transaction ref escaped the store git directory".to_string());
        }
        sync_directory_nofollow(current)?;
        directory_count += 1;
        if current == git_dir {
            break;
        }
        current = current
            .parent()
            .ok_or("transaction ref directory chain is incomplete")?;
    }
    if exact_ref_target(repo, name) != Some(target) {
        return Err(format!(
            "transaction ref changed during durability sync: {name}"
        ));
    }
    Ok(directory_count)
}

/// Publish the exact transaction ref. A libgit2 error can happen after the
/// lockfile was renamed into place, so the visible ref is authoritative.
pub(crate) fn publish_transaction_ref(
    transaction: &mut StoreObjectTransaction,
    repo: &Repository,
    name: &str,
    target: Oid,
    req: &Value,
    post_write_hook: &str,
    durability_hook: &str,
    durability_error: &str,
    label: &str,
) -> Result<(), String> {
    if !transaction.pending.is_empty() {
        return Err("cannot publish a transaction ref with pending objects".to_string());
    }
    prepare_transaction_ref_path(repo, name, target)?;
    let mut publication = repo
        .reference(name, target, true, "")
        .map(|_| ())
        .map_err(|error| format!("{label} failed: {error}"));
    if publication.is_ok()
        && let Some(marker) = req
            .pointer(&format!("/hooks/{post_write_hook}/markerPath"))
            .and_then(Value::as_str)
    {
        publication = fs::write(marker, b"injected-after-ref-write")
            .map_err(|error| format!("write {post_write_hook} marker failed: {error}"))
            .and(Err(format!("injected {label} failure after write")));
    }
    match publication {
        Ok(()) => {}
        Err(_) if exact_ref_target(repo, name) == Some(target) => {}
        Err(error) => return Err(error),
    }
    if let Some(marker) = req
        .pointer(&format!("/hooks/{durability_hook}/markerPath"))
        .and_then(Value::as_str)
    {
        fs::write(marker, b"injected-before-ref-durability")
            .map_err(|error| format!("write {durability_hook} marker failed: {error}"))?;
        return Err(durability_error.to_string());
    }
    let directory_count = sync_exact_transaction_ref(repo, name, target)?;
    transaction.record_ref_sync(directory_count);
    Ok(())
}

/// Pin a state commit with a store-local ref so gc never prunes it.
pub(crate) fn update_state_ref(
    transaction: &mut StoreObjectTransaction,
    repo: &Repository,
    commit: Oid,
    req: &Value,
) -> Result<(), String> {
    publish_transaction_ref(
        transaction,
        repo,
        &format!("refs/termina/state/{commit}"),
        commit,
        req,
        "failStateRefAfterWrite",
        "failStateRefDurability",
        "injected state ref durability failure",
        "state ref update",
    )
}

pub(crate) fn fail_before_state_ref(req: &Value) -> Result<(), String> {
    if req
        .pointer("/hooks/failStateRef")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err("injected state-ref failure".to_string());
    }
    Ok(())
}

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
    crate::test_hooks::pause(ready, release, name)
}

#[cfg(test)]
mod tests {
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
