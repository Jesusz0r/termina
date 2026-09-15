//! State commits and transaction refs.
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
