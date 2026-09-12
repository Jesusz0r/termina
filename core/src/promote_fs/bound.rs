//! Bound promotion roots: absolute opens, components, and parents.
use std::ffi::CString;
use std::fs;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path};

use serde_json::Value;

use crate::{
    PROMOTION_COMPONENT_ARRAY_MAX_ENTRIES,
    PROMOTION_COMPONENT_ARRAY_MAX_NAME_BYTES,
};
use crate::util::{
    missing_path,
    normalize_system_alias_path,
    open_at,
    opt_s,
    s,
    stat_file,
};

use super::capability::{PromotionIdentity, issue_promotion_root_capability, promotion_root_capabilities};
use super::expected::{promotion_absolute_path, promotion_component, promotion_identity_from_value};
use super::io::promotion_directory_identity_matches;

pub(crate) fn open_promotion_absolute_directory(path: &str, field: &str) -> Result<fs::File, String> {
    promotion_absolute_path(path, field)?;
    // macOS exposes /var as a fixed system alias.  Accept that one
    // system-owned spelling consistently with the source capture boundary;
    // arbitrary caller-controlled symlink components remain rejected by the
    // descriptor walk below.
    let normalized = normalize_system_alias_path(Path::new(path), field)?;
    let mut current = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open("/")
        .map_err(|error| format!("open promotion root failed: {error}"))?;
    for component in normalized.components() {
        let Component::Normal(name) = component else {
            if matches!(component, Component::RootDir) {
                continue;
            }
            return Err(format!("promotion {field} must be canonical"));
        };
        let name = CString::new(name.to_string_lossy().as_bytes())
            .map_err(|_| format!("promotion {field} contains invalid bytes"))?;
        current = open_at(
            current.as_raw_fd(),
            &name,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
        .map_err(|error| {
            format!(
                "open promotion {field} path {path} component {} failed: {error}",
                name.to_string_lossy()
            )
        })?;
    }
    let identity =
        stat_file(&current).map_err(|error| format!("fstat promotion {field} failed: {error}"))?;
    if !identity.is_dir() {
        return Err(format!("promotion {field} is not a directory"));
    }
    Ok(current)
}

pub(crate) struct PromotionCwd {
    previous: fs::File,
}

impl PromotionCwd {
    pub(crate) fn enter(directory: &fs::File, field: &str) -> Result<Self, String> {
        let dot = CString::new(".").expect("directory component has no NUL");
        let previous = open_at(
            libc::AT_FDCWD,
            &dot,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
        .map_err(|error| format!("open previous cwd for promotion {field} failed: {error}"))?;
        let rc = unsafe { libc::fchdir(directory.as_raw_fd()) };
        if rc == -1 {
            return Err(format!(
                "change cwd for promotion {field} failed: {}",
                io::Error::last_os_error()
            ));
        }
        Ok(Self { previous })
    }
}

impl Drop for PromotionCwd {
    fn drop(&mut self) {
        // There is no useful recovery path if restoring cwd fails.  Keep the
        // core process alive; all later absolute/descriptor-relative work is
        // still valid and the next bound repository request rebinds cwd.
        let _ = unsafe { libc::fchdir(self.previous.as_raw_fd()) };
    }
}

pub(crate) fn promotion_bound_path_matches(
    path: &str,
    expected: PromotionIdentity,
    field: &str,
) -> Result<(), String> {
    let directory = open_promotion_absolute_directory(path, field)?;
    promotion_directory_identity_matches(&directory, expected, field)
}

/// Open one promotion root either through a capability held by this core
/// process or through a caller-supplied identity established by its trusted
/// owner.  A pathname alone is never an authentication input.  Capability
/// requests still carry the path for diagnostics and must match the path that
/// was bound when the token was issued; the actual open uses the registry's
/// stored path and identity.
pub(crate) fn open_promotion_bound_root(
    req: &Value,
    path_field: &str,
    identity_field: &str,
    capability_field: &str,
) -> Result<(fs::File, PromotionIdentity, String), String> {
    let requested_path = s(req, path_field)?;
    let expected = req
        .get(identity_field)
        .map(|value| promotion_identity_from_value(value, identity_field))
        .transpose()?;
    open_promotion_bound_root_values(
        &requested_path,
        expected,
        opt_s(req, capability_field).as_deref(),
        path_field,
    )
}

pub(crate) fn open_promotion_bound_root_values(
    requested_path: &str,
    expected: Option<PromotionIdentity>,
    capability_token: Option<&str>,
    path_field: &str,
) -> Result<(fs::File, PromotionIdentity, String), String> {
    if let Some(token) = capability_token {
        let capability = {
            let capabilities = promotion_root_capabilities()
                .lock()
                .map_err(|_| "promotion root capability registry poisoned".to_string())?;
            capabilities
                .get(token)
                .cloned()
                .ok_or_else(|| "promotion root capability is unknown; core was restarted; rebind from persisted trusted identity".to_string())?
        };
        if capability.path != requested_path {
            return Err(format!(
                "promotion {path_field} does not match its bound capability"
            ));
        }
        let directory = open_promotion_absolute_directory(&capability.path, path_field)?;
        promotion_directory_identity_matches(&directory, capability.identity, path_field)?;
        if expected.is_some_and(|expected| expected != capability.identity) {
            return Err(format!(
                "promotion {path_field} identity does not match its bound capability"
            ));
        }
        return Ok((directory, capability.identity, token.to_string()));
    }
    let expected = expected.ok_or_else(|| {
        format!("{path_field} requires a previously trusted identity or capability")
    })?;
    let directory = open_promotion_absolute_directory(&requested_path, path_field)?;
    promotion_directory_identity_matches(&directory, expected, path_field)?;
    let token = issue_promotion_root_capability(&requested_path, expected)?;
    Ok((directory, expected, token))
}

pub(crate) fn promotion_path_with_components(root: &str, components: &[(String, CString)]) -> String {
    let mut path = root.trim_end_matches('/').to_string();
    for (name, _) in components {
        path.push('/');
        path.push_str(name);
    }
    if path.is_empty() {
        "/".to_string()
    } else {
        path
    }
}

pub(crate) fn promotion_components_value(value: &Value, key: &str) -> Result<Vec<(String, CString)>, String> {
    let values = value
        .as_array()
        .ok_or_else(|| format!("{key} must be an array"))?;
    if values.is_empty() || values.len() > PROMOTION_COMPONENT_ARRAY_MAX_ENTRIES {
        return Err(format!("invalid promotion {key}"));
    }
    let mut components = Vec::with_capacity(values.len());
    let mut name_bytes = 0usize;
    for (index, value) in values.iter().enumerate() {
        let (name, component) = promotion_component(value, &format!("{key}[{index}]"))?;
        name_bytes = name_bytes
            .checked_add(name.len())
            .ok_or_else(|| format!("{key} name accounting overflow"))?;
        if name_bytes > PROMOTION_COMPONENT_ARRAY_MAX_NAME_BYTES {
            return Err(format!("promotion {key} exceeds its name-work bound"));
        }
        components.push((name, component));
    }
    Ok(components)
}

pub(crate) fn promotion_identity_chain_from_value(
    value: &Value,
    field: &str,
) -> Result<Vec<PromotionIdentity>, String> {
    let values = value
        .as_array()
        .ok_or_else(|| format!("{field} must be an array"))?;
    if values.len() > PROMOTION_COMPONENT_ARRAY_MAX_ENTRIES {
        return Err(format!("invalid promotion {field}"));
    }
    let mut identities = Vec::with_capacity(values.len());
    for (index, value) in values.iter().enumerate() {
        identities.push(promotion_identity_from_value(
            value,
            &format!("{field}[{index}]"),
        )?);
    }
    Ok(identities)
}

pub(crate) fn promotion_components_for(req: &Value, key: &str) -> Result<Vec<(String, CString)>, String> {
    promotion_components_value(
        req.get(key).ok_or_else(|| format!("missing field {key}"))?,
        key,
    )
}

pub(crate) fn promotion_components(req: &Value) -> Result<Vec<(String, CString)>, String> {
    promotion_components_for(req, "destinationComponents")
}

pub(crate) fn open_promotion_parent(
    root: &fs::File,
    components: &[(String, CString)],
    field: &str,
) -> Result<fs::File, String> {
    if components.is_empty() {
        return Err(format!("promotion {field} components are missing"));
    }
    let mut parent = root
        .try_clone()
        .map_err(|error| format!("clone promotion {field} root failed: {error}"))?;
    for (index, (_, component)) in components.iter().enumerate().take(components.len() - 1) {
        parent = open_at(
            parent.as_raw_fd(),
            component,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
        .map_err(|error| format!("open promotion {field} component {index} failed: {error}"))?;
    }
    Ok(parent)
}

/// Open every directory component below `root`, creating missing components
/// through the already-open parent descriptor.  This is the only directory
/// materialization primitive used by live promotion.  In particular, it never
/// re-resolves a component through a pathname after the root descriptor has
/// been acquired.
pub(crate) fn open_or_create_promotion_parent(
    root: &fs::File,
    components: &[(String, CString)],
    field: &str,
    mode: libc::mode_t,
) -> Result<fs::File, String> {
    let mut parent = root
        .try_clone()
        .map_err(|error| format!("clone promotion {field} root failed: {error}"))?;
    for (index, (_, component)) in components.iter().enumerate() {
        match open_at(
            parent.as_raw_fd(),
            component,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        ) {
            Ok(next) => parent = next,
            Err(error) if missing_path(&error) => {
                unsafe {
                    if libc::mkdirat(parent.as_raw_fd(), component.as_ptr(), mode) == -1 {
                        let mkdir_error = io::Error::last_os_error();
                        if mkdir_error.raw_os_error() != Some(libc::EEXIST) {
                            return Err(format!(
                                "create promotion {field} component {index} failed: {mkdir_error}"
                            ));
                        }
                    }
                }
                parent = open_at(
                    parent.as_raw_fd(),
                    component,
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
                .map_err(|open_error| {
                    format!("open created promotion {field} component {index} failed: {open_error}")
                })?;
            }
            Err(error) => {
                return Err(format!(
                    "open promotion {field} component {index} failed: {error}"
                ));
            }
        }
    }
    Ok(parent)
}
