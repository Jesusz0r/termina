//! Promotion remove-tree op: validated moves into quarantine.
use std::ffi::CString;
use std::os::fd::AsRawFd;
use std::time::{SystemTime, UNIX_EPOCH};
use std::sync::atomic::Ordering;

use serde_json::{Value, json};

use crate::PROMOTION_CLEANUP_SEQUENCE;
use crate::util::{
    open_at,
    s,
    stat_at,
    stat_file,
};
use crate::store::FileIdentity;
use crate::promotion_files::{
    promotion_cleanup_same_namespace_identity,
    promotion_rename_unsupported,
};
use crate::util::read_link_at;
use crate::promote_fs::{
    open_promotion_absolute_directory,
    open_promotion_bound_root,
    open_promotion_parent,
    promotion_components_for,
    promotion_directory_identity_matches,
    promotion_identity_from_value,
    promotion_rename_noreplace,
    promotion_test_pause,
};

use super::cleanup::{create_promotion_quarantine_container, promotion_quarantine_usage, validate_promotion_cleanup_tree};


pub(crate) fn op_promotion_bound_remove_tree(req: &Value) -> Result<Value, String> {
    let (root, root_identity, _capability) =
        open_promotion_bound_root(req, "root", "rootIdentity", "rootCapability")?;
    let components = promotion_components_for(req, "components")?;
    let parent = open_promotion_parent(&root, &components, "cleanup")?;
    let parent_identity = promotion_identity_from_value(
        req.get("parentIdentity").ok_or("missing parentIdentity")?,
        "parentIdentity",
    )?;
    promotion_directory_identity_matches(&parent, parent_identity, "cleanup parent")?;
    let (_, leaf) = components.last().expect("non-empty components");
    let expected = promotion_identity_from_value(
        req.get("expectedIdentity")
            .ok_or("missing expectedIdentity")?,
        "expectedIdentity",
    )?;
    // Bind either a directory tree or a regular-file/symlink leaf below the
    // already-bound parent.  Symlink leaves intentionally have no portable
    // read descriptor with O_NOFOLLOW, so their namespace identity is held by
    // fstatat and the final descriptor-relative rename instead.
    let observed_child = stat_at(parent.as_raw_fd(), leaf)
        .map_err(|error| format!("stat cleanup root failed: {error}"))?;
    let child = if observed_child.is_symlink() {
        None
    } else {
        Some(
            open_at(
                parent.as_raw_fd(),
                leaf,
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
            .map_err(|error| format!("open cleanup root failed: {error}"))?,
        )
    };
    let child_identity = match &child {
        Some(child) => stat_file(child)
            .map_err(|error| format!("fstat cleanup root failed: {error}"))?,
        None => observed_child,
    };
    if (!child_identity.is_dir() && !child_identity.is_file() && !child_identity.is_symlink())
        || child_identity.dev != expected.dev
        || child_identity.ino != expected.ino
    {
        return Err("cleanup root identity mismatch".to_string());
    }
    promotion_test_pause(req, "promotion-cleanup-root-open")?;
    let after_open = stat_at(parent.as_raw_fd(), leaf)
        .map_err(|error| format!("stat cleanup root failed: {error}"))?;
    if (!after_open.is_dir() && !after_open.is_file() && !after_open.is_symlink())
        || after_open.dev != expected.dev
        || after_open.ino != expected.ino
        || after_open.file_type() != child_identity.file_type()
    {
        return Err("cleanup root changed; evidence retained".to_string());
    }
    promotion_test_pause(req, "promotion-cleanup-root-validated")?;
    let after_validation = stat_at(parent.as_raw_fd(), leaf)
        .map_err(|error| format!("stat cleanup root failed: {error}"))?;
    if after_validation != after_open {
        return Err("cleanup root changed; evidence retained".to_string());
    }
    // The descriptor pins the object that will be moved, but it does not by
    // itself prove that the caller's absolute root path still resolves
    // through the same ancestor chain.  Re-open the trusted path and compare
    // its final identity immediately before the mutation so an ancestor
    // rename/replacement cannot turn a bound cleanup into an unexpected
    // pathname operation.  The original object remains reachable through
    // `root` when this check fails.
    let requested_root = s(req, "root")?;
    let path_root = open_promotion_absolute_directory(&requested_root, "root")?;
    let path_root_identity = stat_file(&path_root)
        .map_err(|error| format!("fstat cleanup root path failed: {error}"))?;
    if path_root_identity.dev != root_identity.dev || path_root_identity.ino != root_identity.ino {
        return Err("cleanup root ancestry changed; evidence retained".to_string());
    }
    let (expected_entries, expected_bytes, expected_work_bytes) = if child_identity.is_dir() {
        validate_promotion_cleanup_tree(
            child.as_ref().expect("directory cleanup child is opened"),
            req,
            "cleanup root",
        )?
    } else {
        promotion_test_pause(req, "promotion-cleanup-leaf-validated")?;
        let after_leaf = stat_at(parent.as_raw_fd(), leaf)
            .map_err(|error| format!("stat cleanup root after validation failed: {error}"))?;
        if after_leaf != after_open {
            return Err("cleanup root changed; evidence retained".to_string());
        }
        let work = u64::try_from(components.last().expect("non-empty cleanup components").0.len())
            .map_err(|_| "cleanup root work accounting overflow")?
            .checked_add(std::mem::size_of::<FileIdentity>() as u64)
            .ok_or("cleanup root work accounting overflow")?;
        let bytes = if child_identity.is_symlink() {
            u64::try_from(
                read_link_at(parent.as_raw_fd(), leaf)
                    .map_err(|error| format!("read cleanup symlink failed: {error}"))?
                    .len(),
            )
            .map_err(|_| "cleanup symlink byte accounting overflow")?
        } else {
            child_identity.len
        };
        (1, bytes, work)
    };
    // Admission reserves the aggregate entry/byte budget while holding a
    // stable grandparent descriptor lock.  Keep that reservation alive until
    // the descriptor-bound no-replace rename and final validation complete;
    // any failed move drops the lock without deleting retained evidence.
    let reservation =
        create_promotion_quarantine_container(
            &parent,
            expected_entries,
            expected_bytes,
            expected_work_bytes,
        )?;
    let quarantine_root = &reservation.quarantine_root;
    // Revalidate the incoming object after admission has serialized against
    // other quarantine movers. If a writer changed the tree while the first
    // accounting pass was running, do not consume a reservation calculated
    // for the old shape; dropping the reservation leaves the source intact.
    let (rechecked_entries, rechecked_bytes, rechecked_work_bytes) = if child_identity.is_dir() {
        validate_promotion_cleanup_tree(
            child.as_ref().expect("directory cleanup child is opened"),
            req,
            "cleanup root",
        )?
    } else {
        let rechecked = match &child {
            Some(child) => stat_file(child)
                .map_err(|error| format!("fstat cleanup root after admission failed: {error}"))?,
            None => stat_at(parent.as_raw_fd(), leaf)
                .map_err(|error| format!("stat cleanup root after admission failed: {error}"))?,
        };
        let path_rechecked = stat_at(parent.as_raw_fd(), leaf)
            .map_err(|error| format!("stat cleanup root after admission failed: {error}"))?;
        if rechecked != child_identity || path_rechecked != after_open {
            return Err(
                "cleanup root changed during quarantine admission; evidence retained".to_string(),
            );
        }
        let work = u64::try_from(components.last().expect("non-empty cleanup components").0.len())
            .map_err(|_| "cleanup root work accounting overflow")?
            .checked_add(std::mem::size_of::<FileIdentity>() as u64)
            .ok_or("cleanup root work accounting overflow")?;
        let bytes = if child_identity.is_symlink() {
            u64::try_from(
                read_link_at(parent.as_raw_fd(), leaf)
                    .map_err(|error| format!("read cleanup symlink failed: {error}"))?
                    .len(),
            )
            .map_err(|_| "cleanup symlink byte accounting overflow")?
        } else {
            rechecked.len
        };
        (1, bytes, work)
    };
    if rechecked_entries != expected_entries
        || rechecked_bytes != expected_bytes
        || rechecked_work_bytes != expected_work_bytes
    {
        return Err(
            "cleanup root changed during quarantine admission; evidence retained".to_string(),
        );
    }
    let mut quarantine_name = None;
    // The core process can restart while the durable quarantine survives.
    // Include process-local entropy in the candidate and still handle an
    // adversarial collision with bounded noreplace retries; a process-reset
    // sequence alone would repeatedly collide with prior evidence.
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    for _ in 0..64 {
        let sequence = PROMOTION_CLEANUP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let candidate = CString::new(format!(
            ".termina-promotion-cleanup-root-{}-{nonce:032x}-{sequence:016x}.tmp",
            std::process::id(),
        ))
        .expect("cleanup root quarantine name has no NUL");
        match promotion_rename_noreplace(
            parent.as_raw_fd(),
            leaf,
            quarantine_root.as_raw_fd(),
            &candidate,
        ) {
            Ok(()) => {
                quarantine_name = Some(candidate);
                break;
            }
            Err(error) if error.raw_os_error() == Some(libc::EEXIST) => continue,
            Err(error) if promotion_rename_unsupported(&error) => {
                return Err("promotion cleanup quarantine is unsupported".to_string());
            }
            Err(error) => {
                return Err(format!(
                    "quarantine cleanup root failed: {error}; evidence retained"
                ));
            }
        }
    }
    let quarantine_name =
        quarantine_name.ok_or("could not allocate a cleanup root quarantine name")?;
    let moved = stat_at(quarantine_root.as_raw_fd(), &quarantine_name).map_err(|error| {
        format!("stat quarantined cleanup root failed: {error}; evidence retained")
    })?;
    if !promotion_cleanup_same_namespace_identity(moved, child_identity) {
        return Err("cleanup root changed during quarantine; evidence retained".to_string());
    }
    // This seam is intentionally after the final stat.  There is no unlink
    // after it: a replacement can only make the operation fail closed while
    // both the original and replacement remain durable evidence.
    promotion_test_pause(req, "promotion-cleanup-quarantine-final-stat")?;
    let after_final_stat =
        stat_at(quarantine_root.as_raw_fd(), &quarantine_name).map_err(|error| {
            format!("stat quarantined cleanup root failed: {error}; evidence retained")
        })?;
    if !promotion_cleanup_same_namespace_identity(after_final_stat, child_identity) {
        return Err("quarantined cleanup root changed; evidence retained".to_string());
    }
    // Re-scan while admission is still reserved.  This catches any
    // unexpected retained-tree growth before reporting success; the object
    // remains durable evidence and no cleanup unlink is attempted.
    promotion_quarantine_usage(&reservation.grandparent).map_err(|error| {
        format!("promotion cleanup quarantine changed during admission: {error}; evidence retained")
    })?;
    quarantine_root
        .sync_all()
        .map_err(|error| format!("sync promotion cleanup quarantine failed: {error}"))?;
    parent
        .sync_all()
        .map_err(|error| format!("sync cleanup parent failed: {error}"))?;
    Ok(json!({
        "result": {
            "removed": true,
            "retained": true,
            "quarantineName": quarantine_name.to_string_lossy(),
        }
    }))
}
