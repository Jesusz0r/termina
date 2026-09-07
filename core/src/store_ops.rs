//! Snapshot-store lifecycle ops: create (clone + verify) and destroy
//! (validate, recover, delete).
use std::ffi::CString;
use std::fs;
use std::io;
use std::os::fd::AsRawFd;
use std::path::PathBuf;
use std::sync::atomic::Ordering;

use git2::{Repository, RepositoryInitOptions};
use serde_json::{Value, json};

use crate::{
    STORE_DESTROY_SEQUENCE,
    open_store,
    store_lifecycle_at_root,
    store_node_at,
    store_node_at_optional,
    store_node_file,
    store_node_matches,
    validate_store_lifecycle,
};
use crate::util::{
    object_format,
    open_absolute_directory_nofollow,
    open_at,
    s,
};
use crate::{
    StoreMutationLock, StoreNodeIdentity,
    current_store_lifecycle, fresh_store_generation, lifecycle_json, lifecycle_mismatch,
    recover_store_transaction, write_store_generation,
};
use crate::{
    promotion_directory_is_empty, promotion_rename_noreplace,
    promotion_rename_unsupported, promotion_unlink_at_field,
};
use crate::capture::{pause_at_hook, promotion_remove_tree_contents};

pub(crate) fn op_store_create(req: &Value) -> Result<Value, String> {
    let store_dir = PathBuf::from(s(req, "storeDir")?);
    let source_git_dir = PathBuf::from(s(req, "sourceGitDir")?);
    let requested = object_format(&s(req, "objectFormat")?)?;
    let git_dir = store_dir.join("git");
    if let Ok(metadata) = fs::symlink_metadata(&store_dir)
        && !metadata.file_type().is_dir()
    {
        return Err("snapshot store path is not a real directory".to_string());
    }
    let mutation_lock = StoreMutationLock::acquire(&store_dir, req)?;
    if mutation_lock.was_contended() {
        return Err(
            "snapshot store changed while store-create waited for its mutation lock".to_string(),
        );
    }
    if let Ok(existing) = Repository::open_bare(&git_dir) {
        recover_store_transaction(&store_dir, &existing)?;
    }
    fs::create_dir_all(&store_dir).map_err(|e| e.to_string())?;
    let mut opts = RepositoryInitOptions::new();
    opts.bare(true).object_format(requested);
    let repo = Repository::init_opts(&git_dir, &opts)
        .map_err(|e| format!("snapshot store init failed: {e}"))?;
    // Disable gc: the store keeps objects that a gc run would prune.
    repo.config()
        .map_err(|e| e.to_string())?
        .set_bool("gc.auto", false)
        .map_err(|e| e.to_string())?;
    // A new app session has no in-memory run records. Remove refs left by a
    // crashed session before the first capture.
    let mut stale: Vec<String> = Vec::new();
    for glob in ["refs/termina/state/*", "refs/termina/merge/*"] {
        let refs = repo.references_glob(glob).map_err(|e| e.to_string())?;
        for reference in refs.flatten() {
            if let Ok(name) = reference.name() {
                stale.push(name.to_string());
            }
        }
    }
    for name in stale {
        if let Ok(reference) = repo.find_reference(&name) {
            let mut reference = reference;
            reference.delete().ok();
        }
    }
    // Read-only object access to the source repository.
    let alt_dir = git_dir.join("objects").join("info");
    fs::create_dir_all(&alt_dir).map_err(|e| e.to_string())?;
    fs::write(
        alt_dir.join("alternates"),
        format!("{}\n", source_git_dir.join("objects").display()),
    )
    .map_err(|e| e.to_string())?;
    let generation = fresh_store_generation()?;
    write_store_generation(&store_dir, &generation)?;
    pause_at_hook(req, "pauseAfterStoreGeneration")?;
    let lifecycle = current_store_lifecycle(&store_dir)?;
    Ok(lifecycle_json(&lifecycle))
}

pub(crate) fn op_store_destroy(req: &Value) -> Result<Value, String> {
    let store_dir = PathBuf::from(s(req, "storeDir")?);
    let _mutation_lock = StoreMutationLock::acquire(&store_dir, req)?;
    let metadata = match fs::symlink_metadata(&store_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(json!({})),
        Err(error) => return Err(format!("inspect snapshot store failed: {error}")),
    };
    if !metadata.file_type().is_dir() {
        return Err("not a valid snapshot store: store path is not a real directory".to_string());
    }
    let git_dir = store_dir.join("git");
    let git_metadata = fs::symlink_metadata(&git_dir).map_err(|error| {
        format!("not a valid snapshot store: inspect git directory failed: {error}")
    })?;
    if !git_metadata.file_type().is_dir() {
        return Err("not a valid snapshot store: git path is not a real directory".to_string());
    }
    let store = open_store(&store_dir, req)
        .map_err(|error| format!("not a valid snapshot store: {error}"))?;
    recover_store_transaction(&store_dir, &store)?;
    drop(store);
    let lifecycle = validate_store_lifecycle(&store_dir, req)?;
    // Bind the parent and store root through descriptors before the final
    // lifecycle check.  The old pathname-only `rename`/`remove_dir_all`
    // sequence could destroy a replacement installed after validation.
    let parent = store_dir
        .parent()
        .ok_or("snapshot store has no parent directory")?;
    let name = store_dir
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("snapshot store name is not valid UTF-8")?;
    let parent_file = open_absolute_directory_nofollow(parent, "snapshot store parent")?;
    let parent_node = store_node_file(&parent_file, "snapshot store parent")?;
    let store_name = CString::new(name)
        .map_err(|_| "snapshot store name contains NUL".to_string())?;
    let store_root = open_at(
        parent_file.as_raw_fd(),
        &store_name,
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )
    .map_err(|error| format!("open snapshot store root failed: {error}"))?;
    let store_node = store_node_file(&store_root, "snapshot store root")?;
    if !store_node_matches(
        store_node,
        StoreNodeIdentity {
            identity: lifecycle.identity,
            file_type: libc::S_IFDIR as u32,
            links: store_node.links,
        },
    ) {
        return Err("snapshot store root identity changed before destroy".to_string());
    }
    let bound_lifecycle = store_lifecycle_at_root(&store_root)?;
    if bound_lifecycle != lifecycle {
        return Err(lifecycle_mismatch(&lifecycle, &bound_lifecycle));
    }

    // Every check below is descriptor-relative.  Re-opening the public path
    // is used only as a provenance assertion: if an ancestor, the public
    // leaf, a hard-link count, or any lifecycle child changed, destroy fails
    // closed and leaves all names/objects in place.
    let validate_destroy_commit = || -> Result<(), String> {
        let current_parent = open_absolute_directory_nofollow(parent, "snapshot store parent")?;
        let current_parent_node = store_node_file(&current_parent, "snapshot store parent")?;
        if !store_node_matches(current_parent_node, parent_node) {
            return Err("snapshot store parent identity or link count changed; destroy retained".to_string());
        }
        let public_node = store_node_at(
            current_parent.as_raw_fd(),
            &store_name,
            "snapshot store public root",
        )?;
        if !store_node_matches(public_node, store_node) {
            return Err("snapshot store public root identity or link count changed; destroy retained".to_string());
        }
        let descriptor_lifecycle = store_lifecycle_at_root(&store_root)?;
        if descriptor_lifecycle != lifecycle {
            return Err(lifecycle_mismatch(&lifecycle, &descriptor_lifecycle));
        }
        Ok(())
    };
    pause_at_hook(req, "pauseBeforeStoreDestroyRename")?;
    validate_destroy_commit()?;

    // Move the exact validated directory with a descriptor-relative
    // no-replace rename.  The quarantine stays under the held parent; no
    // ancestor pathname is resolved after this point.
    let mut quarantine_name = None;
    for _ in 0..64 {
        let sequence = STORE_DESTROY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let candidate = CString::new(format!(
            ".{name}.termina-destroy-{}-{sequence}",
            std::process::id()
        ))
        .expect("snapshot store quarantine name has no NUL");
        match promotion_rename_noreplace(
            parent_file.as_raw_fd(),
            &store_name,
            parent_file.as_raw_fd(),
            &candidate,
        ) {
            Ok(()) => {
                quarantine_name = Some(candidate);
                break;
            }
            Err(error) if error.raw_os_error() == Some(libc::EEXIST) => continue,
            Err(error) if promotion_rename_unsupported(&error) => {
                return Err("destroy snapshot store quarantine is unsupported".to_string());
            }
            Err(error) => {
                return Err(format!(
                    "destroy snapshot store quarantine failed: {error}; store retained"
                ));
            }
        }
    }
    let quarantine_name = quarantine_name
        .ok_or("could not allocate a snapshot store destroy quarantine name")?;
    let quarantined_node = store_node_at(
        parent_file.as_raw_fd(),
        &quarantine_name,
        "snapshot store quarantine",
    )?;
    if !store_node_matches(quarantined_node, store_node) {
        return Err("snapshot store quarantine identity changed; store retained".to_string());
    }
    let quarantined_lifecycle = store_lifecycle_at_root(&store_root)?;
    if quarantined_lifecycle != lifecycle {
        return Err(lifecycle_mismatch(&lifecycle, &quarantined_lifecycle));
    }
    parent_file
        .sync_all()
        .map_err(|error| format!("sync snapshot store quarantine parent failed: {error}"))?;

    // The rename is descriptor-relative, but a non-cooperating actor may
    // still replace the public ancestor or recreate the public leaf while
    // the quarantined tree is being inspected.  Keep the quarantine as
    // durable evidence and fail closed if the public provenance no longer
    // describes the operation that was just claimed.
    let validate_destroy_quarantine_commit = || -> Result<(), String> {
        let current_parent = open_absolute_directory_nofollow(parent, "snapshot store parent")?;
        let current_parent_node = store_node_file(&current_parent, "snapshot store parent")?;
        if !store_node_matches(current_parent_node, parent_node) {
            return Err("snapshot store parent changed after destroy claim; store retained".to_string());
        }
        match store_node_at_optional(
            current_parent.as_raw_fd(),
            &store_name,
            "snapshot store public root",
        )? {
            Some(_) => Err("snapshot store public root was replaced after destroy claim; store retained".to_string()),
            None => Ok(()),
        }
    };
    validate_destroy_quarantine_commit()?;
    pause_at_hook(req, "pauseAfterStoreDestroyRename")?;
    validate_destroy_quarantine_commit()?;

    // Recursive cleanup is also descriptor-relative.  A replacement at the
    // public pathname is never inspected or removed; an uncertain quarantine
    // remains durable evidence and the request fails closed.
    promotion_remove_tree_contents(&store_root, req, "snapshot store quarantine")?;
    if !promotion_directory_is_empty(store_root.as_raw_fd())? {
        return Err("snapshot store quarantine is not empty; store retained".to_string());
    }
    let final_quarantine = store_node_at(
        parent_file.as_raw_fd(),
        &quarantine_name,
        "snapshot store quarantine",
    )?;
    // Removing the quarantine's child directories legitimately changes its
    // directory link count.  Its exact link count was already checked at the
    // rename/claim boundary above; at this post-cleanup point retain the
    // stronger immutable identity and type check without treating expected
    // recursive unlinking as an ABA.
    if final_quarantine.identity != store_node.identity
        || final_quarantine.file_type != store_node.file_type
    {
        return Err("snapshot store quarantine changed during cleanup; store retained".to_string());
    }
    validate_destroy_quarantine_commit()?;
    promotion_unlink_at_field(
        parent_file.as_raw_fd(),
        &quarantine_name,
        true,
        "snapshot store quarantine",
    )?;
    parent_file
        .sync_all()
        .map_err(|error| format!("sync destroyed snapshot store parent failed: {error}"))?;
    let mut result = lifecycle_json(&lifecycle);
    if let Some(object) = result.as_object_mut() {
        object.insert("destroyed".to_string(), Value::Bool(true));
    }
    Ok(result)
}
