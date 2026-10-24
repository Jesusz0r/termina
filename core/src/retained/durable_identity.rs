//! Persist volume identity, never a mount's transient device number on macOS.
//! Device/inode pairs remain the live, descriptor-bound capability contract.
use crate::promote_fs::{
    PromotionIdentity, open_promotion_absolute_directory, promotion_identity_from_value,
};
use crate::util::stat_file;
use serde_json::{Value, json};
use std::fs;
use std::path::Path;

pub(super) fn durable_directory_identity(directory: &fs::File) -> Result<Value, String> {
    let actual = stat_file(directory).map_err(|e| format!("stat durable directory failed: {e}"))?;
    #[cfg(target_os = "macos")]
    return Ok(json!({"volume": volume_uuid(directory)?, "ino": actual.ino.to_string()}));
    #[cfg(not(target_os = "macos"))]
    Ok(json!({"dev": actual.dev.to_string(), "ino": actual.ino.to_string()}))
}

#[cfg(target_os = "macos")]
fn volume_uuid(directory: &fs::File) -> Result<String, String> {
    use std::ffi::CStr;
    use std::os::fd::AsRawFd;
    // fstatfs locates the volume for the already opened directory. Request
    // ATTR_VOL_UUID on its mount root, and verify it is the same device.
    let mut mount: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatfs(directory.as_raw_fd(), &mut mount) } != 0 {
        return Err(format!(
            "read durable volume mount failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    let path = unsafe { CStr::from_ptr(mount.f_mntonname.as_ptr()) }
        .to_str()
        .map_err(|_| "volume mount path is not UTF-8")?;
    let volume = open_promotion_absolute_directory(path, "durable volume mount")?;
    let actual = stat_file(directory).map_err(|e| e.to_string())?;
    let volume_stat = stat_file(&volume).map_err(|e| e.to_string())?;
    if actual.dev != volume_stat.dev {
        return Err("durable volume mount changed".into());
    }
    let mut attrs: libc::attrlist = unsafe { std::mem::zeroed() };
    attrs.bitmapcount = libc::ATTR_BIT_MAP_COUNT;
    attrs.volattr = libc::ATTR_VOL_INFO | libc::ATTR_VOL_UUID;
    let mut buffer = [0u32; 5]; // length followed by the 16-byte UUID, aligned to 4 bytes.
    if unsafe {
        libc::fgetattrlist(
            volume.as_raw_fd(),
            (&mut attrs as *mut libc::attrlist).cast(),
            buffer.as_mut_ptr().cast(),
            std::mem::size_of_val(&buffer),
            0,
        )
    } != 0
    {
        return Err(format!(
            "read durable volume UUID failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    if buffer[0] != 20 {
        return Err("durable volume UUID has an invalid length".into());
    }
    let bytes: Vec<u8> = buffer[1..]
        .iter()
        .flat_map(|word| word.to_ne_bytes())
        .collect();
    if bytes.iter().all(|byte| *byte == 0) {
        return Err("volume has no persistent UUID".into());
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// v1 is admitted only when its original device/inode pair still matches.
/// v2 authenticates the stable volume and inode before returning a live pair.
fn resolve_directory_identity(
    value: &Value,
    version: u64,
    path: &str,
    field: &str,
) -> Result<PromotionIdentity, String> {
    let directory = open_promotion_absolute_directory(path, field)?;
    let actual = stat_file(&directory).map_err(|e| format!("stat {field} failed: {e}"))?;
    let identity = PromotionIdentity {
        dev: actual.dev,
        ino: actual.ino,
    };
    let matches = if version == 1 {
        value.as_object().is_some_and(|o| o.len() == 2)
            && promotion_identity_from_value(value, field)? == identity
    } else {
        *value == durable_directory_identity(&directory)?
    };
    if !matches {
        return Err(format!("{field} identity changed"));
    }
    Ok(identity)
}

pub(super) fn resolve_root_record(
    value: &Value,
    field: &str,
    state: bool,
) -> Result<(String, PromotionIdentity, PromotionIdentity), String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{field} is malformed"))?;
    let version = object
        .get("version")
        .and_then(Value::as_u64)
        .filter(|v| *v == 1 || *v == 2)
        .ok_or_else(|| format!("{field} has an invalid version"))?;
    if object.len() != if state { 5 } else { 4 } {
        return Err(format!("{field} is malformed"));
    }
    let path = object
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{field}.path is missing"))?;
    let parent_path = Path::new(path)
        .parent()
        .and_then(Path::to_str)
        .ok_or_else(|| format!("{field}.path has no parent"))?;
    let parent = resolve_directory_identity(
        &value["parent"],
        version,
        parent_path,
        &format!("{field} parent"),
    )?;
    let root = resolve_directory_identity(&value["root"], version, path, &format!("{field} root"))?;
    Ok((path.to_string(), parent, root))
}

/// A legacy crash temporary may complete only the very same authenticated
/// transaction. This is format migration, never identity recovery.
pub(super) fn equivalent_legacy_record(legacy: &[u8], current: &[u8]) -> Result<bool, String> {
    let old: Value = serde_json::from_slice(legacy).map_err(|e| e.to_string())?;
    let new: Value = serde_json::from_slice(current).map_err(|e| e.to_string())?;
    if old["version"] != 1 || new["version"] != 2 || old.get("state") != new.get("state") {
        return Ok(false);
    }
    let state = old.get("state").is_some();
    Ok(
        resolve_root_record(&old, "legacy root metadata temporary", state)?
            == resolve_root_record(&new, "current root metadata", state)?,
    )
}
