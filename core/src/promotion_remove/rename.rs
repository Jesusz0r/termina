//! Atomic Explorer moves: never unlink a pathname after copying/linking it.
use crate::promote_fs::{
    open_promotion_bound_root, open_promotion_parent, promotion_components_for,
    promotion_identity_from_value, promotion_rename_noreplace, promotion_test_pause,
};
use crate::util::{missing_path, stat_at};
use serde_json::{Value, json};
use std::os::fd::AsRawFd;

pub(crate) fn op_promotion_bound_rename(req: &Value) -> Result<Value, String> {
    let (root, _, _) = open_promotion_bound_root(req, "root", "rootIdentity", "rootCapability")?;
    let source = promotion_components_for(req, "sourceComponents")?;
    let destination = promotion_components_for(req, "destinationComponents")?;
    let source_parent = open_promotion_parent(&root, &source, "rename source")?;
    let destination_parent = open_promotion_parent(&root, &destination, "rename destination")?;
    let source_name = &source.last().expect("non-empty components").1;
    let destination_name = &destination.last().expect("non-empty components").1;
    let expected = promotion_identity_from_value(
        req.get("expectedIdentity")
            .ok_or("missing expectedIdentity")?,
        "expectedIdentity",
    )?;
    let observed = stat_at(source_parent.as_raw_fd(), source_name)
        .map_err(|e| format!("stat rename source failed: {e}"))?;
    if observed.dev != expected.dev || observed.ino != expected.ino {
        return Err("rename source identity changed".into());
    }
    promotion_test_pause(req, "rename-before-syscall")?;
    // The kernel performs the move in one operation. If the source is replaced
    // at this boundary, the moved object is retained at the destination; no
    // compensating unlink can destroy a concurrent writer's replacement.
    if let Err(error) = promotion_rename_noreplace(
        source_parent.as_raw_fd(),
        source_name,
        destination_parent.as_raw_fd(),
        destination_name,
    ) {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            // Two hardlink names already address the same object: preserve the
            // existing no-op contract without ever replacing either pathname.
            let same_source = stat_at(source_parent.as_raw_fd(), source_name)
                .is_ok_and(|id| id.dev == observed.dev && id.ino == observed.ino);
            let same_destination = stat_at(destination_parent.as_raw_fd(), destination_name)
                .is_ok_and(|id| id.dev == observed.dev && id.ino == observed.ino);
            if same_source && same_destination {
                return Ok(json!({ "ok": true }));
            }
            return Err("destination already exists".into());
        }
        return Err(format!("rename without replacement failed: {error}"));
    }
    promotion_test_pause(req, "rename-after-syscall")?;
    let moved = stat_at(destination_parent.as_raw_fd(), destination_name)
        .map_err(|e| format!("observe renamed destination failed; entries retained: {e}"))?;
    if moved.dev != observed.dev
        || moved.ino != observed.ino
        || moved.file_type() != observed.file_type()
    {
        return Err(
            "rename source changed during mutation; moved entry retained at destination".into(),
        );
    }
    match stat_at(source_parent.as_raw_fd(), source_name) {
        // A case-only rename on a case-insensitive volume still resolves the
        // source spelling to the same object. Other replacements are conflicts.
        Ok(current) if current.dev == moved.dev && current.ino == moved.ino => (),
        Err(error) if missing_path(&error) => (),
        _ => {
            return Err("rename source was replaced during mutation; both entries retained".into());
        }
    }
    destination_parent
        .sync_all()
        .map_err(|e| format!("sync rename destination failed: {e}"))?;
    source_parent
        .sync_all()
        .map_err(|e| format!("sync rename source failed: {e}"))?;
    Ok(json!({ "ok": true }))
}
