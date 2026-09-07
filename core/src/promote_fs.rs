//! Descriptor-bound promotion filesystem primitives: identities,
//! capabilities, expected/observed states, components, bound roots, the
//! bound cwd guard, directory streams, and raw at(2) mutation helpers.
use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::fs;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use std::sync::atomic::{AtomicU64, Ordering};

use sha2::{Digest, Sha256};
use serde_json::{Value, json};

use crate::{
    BUDGET_MAX_FILE_BYTES,
    PROMOTION_COMPONENT_ARRAY_MAX_ENTRIES,
    PROMOTION_COMPONENT_ARRAY_MAX_NAME_BYTES,
    PROMOTION_COMPONENT_MAX_BYTES,
    PROMOTION_PATH_MAX_BYTES,
    read_link_at,
};
use crate::util::{
    missing_path,
    normalize_system_alias_path,
    open_at,
    opt_s,
    s,
    stat_at,
    stat_file,
};
use crate::FileIdentity;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct PromotionIdentity {
    pub(crate) dev: u64,
    pub(crate) ino: u64,
}

/// A root capability is intentionally scoped to this long-lived core child.
/// Callers may use it instead of re-authenticating a mutable pathname.  The
/// registry is process-local by design: after a core restart an old token is
/// unknown and every operation fails closed until the caller presents a
/// previously persisted identity from its trusted owner.
#[derive(Clone, Debug)]
pub(crate) struct PromotionRootCapability {
    path: String,
    identity: PromotionIdentity,
}

pub(crate) const MAX_PROMOTION_ROOT_CAPABILITIES: usize = 4_096;
pub(crate) static PROMOTION_ROOT_CAPABILITIES: OnceLock<Mutex<HashMap<String, PromotionRootCapability>>> =
    OnceLock::new();
pub(crate) static PROMOTION_ROOT_CAPABILITY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(crate) fn promotion_root_capabilities() -> &'static Mutex<HashMap<String, PromotionRootCapability>> {
    PROMOTION_ROOT_CAPABILITIES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn issue_promotion_root_capability(
    path: &str,
    identity: PromotionIdentity,
) -> Result<String, String> {
    let mut capabilities = promotion_root_capabilities()
        .lock()
        .map_err(|_| "promotion root capability registry poisoned".to_string())?;
    if let Some((token, _)) = capabilities
        .iter()
        .find(|(_, capability)| capability.path == path && capability.identity == identity)
    {
        return Ok(token.clone());
    }
    if capabilities.len() >= MAX_PROMOTION_ROOT_CAPABILITIES {
        return Err(format!(
            "promotion root capability registry is at capacity ({MAX_PROMOTION_ROOT_CAPABILITIES}); restart core to rebind trusted roots"
        ));
    }
    let sequence = PROMOTION_ROOT_CAPABILITY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let token = format!("promotion-root-{sequence:016x}-{}", std::process::id());
    capabilities.insert(
        token.clone(),
        PromotionRootCapability {
            path: path.to_string(),
            identity,
        },
    );
    Ok(token)
}

pub(crate) fn promotion_directory_capability_result(identity: PromotionIdentity, capability: &str) -> Value {
    json!({
        "identity": {
            "dev": identity.dev.to_string(),
            "ino": identity.ino.to_string(),
        },
        "capability": capability,
    })
}

#[cfg(test)]
mod promotion_root_capability_tests {
    use super::*;

    #[test]
    fn registry_is_bounded_without_replacing_reused_capabilities() {
        let mut registry = promotion_root_capabilities()
            .lock()
            .expect("promotion root capability registry poisoned");
        registry.clear();
        drop(registry);

        let active_identity = PromotionIdentity { dev: 1, ino: 1 };
        let active = issue_promotion_root_capability("/active", active_identity).unwrap();
        for index in 1..MAX_PROMOTION_ROOT_CAPABILITIES {
            issue_promotion_root_capability(
                &format!("/root-{index}"),
                PromotionIdentity {
                    dev: 1,
                    ino: index as u64 + 1,
                },
            )
            .unwrap();
        }

        assert_eq!(
            issue_promotion_root_capability("/active", active_identity).unwrap(),
            active
        );
        assert!(issue_promotion_root_capability(
            "/overflow",
            PromotionIdentity {
                dev: 2,
                ino: 1,
            },
        )
        .is_err());
        assert_eq!(
            promotion_root_capabilities()
                .lock()
                .expect("promotion root capability registry poisoned")
                .len(),
            MAX_PROMOTION_ROOT_CAPABILITIES
        );

        promotion_root_capabilities()
            .lock()
            .expect("promotion root capability registry poisoned")
            .clear();
    }
}

#[derive(Clone, Debug)]
pub(crate) enum PromotionExpectedState {
    File {
        mode: u32,
        size: u64,
        sha256: String,
    },
    Symlink {
        target: String,
    },
}

#[derive(Clone, Debug)]
pub(crate) struct PromotionExpectedLeaf {
    pub(crate) identity: PromotionIdentity,
    pub(crate) state: PromotionExpectedState,
}

#[derive(Clone, Debug)]
pub(crate) enum PromotionObservedState {
    File {
        mode: u32,
        size: u64,
        sha256: String,
    },
    Symlink {
        target: String,
    },
    Other,
}

#[derive(Clone, Debug)]
pub(crate) struct PromotionObservedLeaf {
    pub(crate) identity: PromotionIdentity,
    pub(crate) state: PromotionObservedState,
}

pub(crate) fn promotion_identity_from_value(value: &Value, field: &str) -> Result<PromotionIdentity, String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{field} must be an object"))?;
    let parse = |key: &str| -> Result<u64, String> {
        let raw = object
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{field}.{key} must be a decimal string"))?;
        if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(format!("{field}.{key} must be an unsigned decimal string"));
        }
        raw.parse::<u64>()
            .map_err(|_| format!("{field}.{key} does not fit u64"))
    };
    Ok(PromotionIdentity {
        dev: parse("dev")?,
        ino: parse("ino")?,
    })
}

pub(crate) fn promotion_component(value: &Value, field: &str) -> Result<(String, CString), String> {
    let value = value
        .as_str()
        .ok_or_else(|| format!("{field} must be a string"))?;
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
        || value.contains('\0')
        || value.len() > PROMOTION_COMPONENT_MAX_BYTES
    {
        return Err(format!("invalid promotion path component: {field}"));
    }
    let cstring = CString::new(value.as_bytes())
        .map_err(|_| format!("invalid promotion path component: {field}"))?;
    Ok((value.to_string(), cstring))
}

pub(crate) fn promotion_name(value: &Value, field: &str, prefix: &str) -> Result<(String, CString), String> {
    let (value, cstring) = promotion_component(value, field)?;
    if !value.starts_with(prefix) || !value.ends_with(".tmp") {
        return Err(format!("invalid promotion {field}"));
    }
    Ok((value, cstring))
}

pub(crate) fn promotion_absolute_path(value: &str, field: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > PROMOTION_PATH_MAX_BYTES || !value.starts_with('/') {
        return Err(format!("invalid promotion {field}"));
    }
    if value.contains('\0') {
        return Err(format!("invalid promotion {field}"));
    }
    Ok(())
}

pub(crate) fn promotion_sha256(value: &Value, field: &str) -> Result<String, String> {
    let value = value
        .as_str()
        .ok_or_else(|| format!("{field} must be a lowercase SHA-256 string"))?;
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(format!("{field} must be a lowercase SHA-256 string"));
    }
    Ok(value.to_string())
}

pub(crate) fn promotion_size(value: &Value, field: &str) -> Result<u64, String> {
    let value = value
        .as_str()
        .ok_or_else(|| format!("{field} must be a decimal string"))?;
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("{field} must be an unsigned decimal string"));
    }
    value
        .parse::<u64>()
        .map_err(|_| format!("{field} does not fit u64"))
}

pub(crate) fn parse_promotion_expected(value: &Value, field: &str) -> Result<PromotionExpectedLeaf, String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{field} must be an object"))?;
    let identity = promotion_identity_from_value(
        object
            .get("identity")
            .ok_or_else(|| format!("{field}.identity is missing"))?,
        &format!("{field}.identity"),
    )?;
    let state = object
        .get("state")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{field}.state must be an object"))?;
    let state_type = state
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{field}.state.type is missing"))?;
    let state = match state_type {
        "file" => {
            let mode = state
                .get("mode")
                .and_then(Value::as_u64)
                .filter(|mode| *mode <= 0o777)
                .ok_or_else(|| format!("{field}.state.mode is invalid"))?
                as u32;
            let size = promotion_size(
                state
                    .get("size")
                    .ok_or_else(|| format!("{field}.state.size is missing"))?,
                &format!("{field}.state.size"),
            )?;
            if size > BUDGET_MAX_FILE_BYTES {
                return Err(format!(
                    "{field}.state.size exceeds the promotion file budget"
                ));
            }
            PromotionExpectedState::File {
                mode,
                size,
                sha256: promotion_sha256(
                    state
                        .get("sha256")
                        .ok_or_else(|| format!("{field}.state.sha256 is missing"))?,
                    &format!("{field}.state.sha256"),
                )?,
            }
        }
        "symlink" => {
            let target = state
                .get("target")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("{field}.state.target is missing"))?;
            if target.contains('\0') || target.len() > PROMOTION_PATH_MAX_BYTES {
                return Err(format!("{field}.state.target is too long"));
            }
            PromotionExpectedState::Symlink {
                target: target.to_string(),
            }
        }
        _ => return Err(format!("{field}.state.type is unsupported")),
    };
    Ok(PromotionExpectedLeaf { identity, state })
}

/// Parse a destination expectation for an install. An absent destination is
/// represented explicitly as `{state:{type:"missing"}}`; unlike a
/// materialized leaf it has no identity to bind.
pub(crate) fn parse_promotion_expected_destination(
    value: &Value,
    field: &str,
) -> Result<Option<PromotionExpectedLeaf>, String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{field} must be an object"))?;
    let state_type = object
        .get("state")
        .and_then(Value::as_object)
        .and_then(|state| state.get("type"))
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{field}.state.type is missing"))?;
    if state_type == "missing" {
        let state = object
            .get("state")
            .and_then(Value::as_object)
            .expect("state object was checked above");
        if state.len() != 1 || object.len() != 1 {
            return Err(format!("{field} missing expectation has unexpected fields"));
        }
        return Ok(None);
    }
    Ok(Some(parse_promotion_expected(value, field)?))
}

pub(crate) fn promotion_sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn promotion_expected_matches(
    expected: &PromotionExpectedLeaf,
    observed: Option<&PromotionObservedLeaf>,
) -> bool {
    let Some(observed) = observed else {
        return false;
    };
    if expected.identity.dev != observed.identity.dev
        || expected.identity.ino != observed.identity.ino
    {
        return false;
    }
    match (&expected.state, &observed.state) {
        (
            PromotionExpectedState::File { mode, size, sha256 },
            PromotionObservedState::File {
                mode: actual_mode,
                size: actual_size,
                sha256: actual_sha256,
            },
        ) => mode == actual_mode && size == actual_size && sha256 == actual_sha256,
        (
            PromotionExpectedState::Symlink { target },
            PromotionObservedState::Symlink {
                target: actual_target,
            },
        ) => target == actual_target,
        _ => false,
    }
}

pub(crate) fn promotion_expected_state_description(expected: &PromotionExpectedLeaf) -> &'static str {
    match expected.state {
        PromotionExpectedState::File { .. } => "file",
        PromotionExpectedState::Symlink { .. } => "symlink",
    }
}

pub(crate) fn observe_promotion_leaf(
    parent: RawFd,
    name: &CStr,
) -> Result<Option<PromotionObservedLeaf>, String> {
    let identity = match stat_at(parent, name) {
        Ok(identity) => identity,
        Err(error) if missing_path(&error) => return Ok(None),
        Err(error) => return Err(format!("stat promotion leaf failed: {error}")),
    };
    let promotion_identity = PromotionIdentity {
        dev: identity.dev,
        ino: identity.ino,
    };
    if identity.is_file() {
        let file = open_at(
            parent,
            name,
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
        .map_err(|error| format!("open promotion leaf failed: {error}"))?;
        let before =
            stat_file(&file).map_err(|error| format!("fstat promotion leaf failed: {error}"))?;
        if !before.is_file() || before.dev != identity.dev || before.ino != identity.ino {
            return Err("promotion leaf changed type or identity while opening".to_string());
        }
        let mut bytes = Vec::new();
        let read_limit = BUDGET_MAX_FILE_BYTES
            .checked_add(1)
            .ok_or("promotion file budget overflow")?;
        (&file)
            .take(read_limit)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("read promotion leaf failed: {error}"))?;
        if bytes.len() as u64 > BUDGET_MAX_FILE_BYTES {
            return Err("promotion leaf exceeds the file budget".to_string());
        }
        let after =
            stat_file(&file).map_err(|error| format!("fstat promotion leaf failed: {error}"))?;
        let path_after = stat_at(parent, name)
            .map_err(|error| format!("stat promotion leaf failed: {error}"))?;
        if before != after || after != path_after {
            return Err("promotion leaf changed while reading".to_string());
        }
        return Ok(Some(PromotionObservedLeaf {
            identity: promotion_identity,
            state: PromotionObservedState::File {
                mode: before.mode & 0o777,
                size: bytes.len() as u64,
                sha256: promotion_sha256_hex(&bytes),
            },
        }));
    }
    if identity.is_symlink() {
        let target = read_link_at(parent, name)
            .map_err(|error| format!("read promotion symlink failed: {error}"))?;
        let after = stat_at(parent, name)
            .map_err(|error| format!("stat promotion symlink failed: {error}"))?;
        if identity != after {
            return Err("promotion symlink changed while reading".to_string());
        }
        let target = String::from_utf8(target)
            .map_err(|_| "promotion symlink target is not valid UTF-8".to_string())?;
        if target.len() > PROMOTION_PATH_MAX_BYTES {
            return Err("promotion symlink target is too long".to_string());
        }
        return Ok(Some(PromotionObservedLeaf {
            identity: promotion_identity,
            state: PromotionObservedState::Symlink { target },
        }));
    }
    Ok(Some(PromotionObservedLeaf {
        identity: promotion_identity,
        state: PromotionObservedState::Other,
    }))
}

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

pub(crate) fn promotion_mkdir_at(parent: RawFd, name: &CStr, mode: libc::mode_t) -> io::Result<()> {
    let rc = unsafe { libc::mkdirat(parent, name.as_ptr(), mode) };
    if rc == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub(crate) fn promotion_symlink_at(target: &CStr, parent: RawFd, name: &CStr) -> io::Result<()> {
    let rc = unsafe { libc::symlinkat(target.as_ptr(), parent, name.as_ptr()) };
    if rc == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Read directory names through a descriptor. `std::fs::read_dir` is not
/// suitable for this boundary because it would re-resolve the directory by
/// pathname after an ancestor swap.
pub(crate) fn promotion_clear_errno() {
    #[cfg(target_os = "linux")]
    unsafe {
        *libc::__errno_location() = 0;
    }
    #[cfg(target_os = "macos")]
    unsafe {
        *libc::__error() = 0;
    }
}

pub(crate) fn promotion_errno() -> i32 {
    #[cfg(target_os = "linux")]
    unsafe {
        *libc::__errno_location()
    }
    #[cfg(target_os = "macos")]
    unsafe {
        *libc::__error()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        0
    }
}

/// One descriptor-relative directory stream. Keeping the `DIR *` open while
/// an iterative walk descends means each frame holds only one native stream,
/// not a collected names vector for every ancestor.
pub(crate) struct PromotionDirectoryStream {
    stream: *mut libc::DIR,
}

impl PromotionDirectoryStream {
    pub(crate) fn open(dir: RawFd) -> Result<Self, String> {
        // `dup` shares the directory stream offset with the caller. Open `.`
        // through the bound descriptor instead so repeated scans (including
        // quarantine accounting followed by container reuse) remain
        // independent of the caller's stream state.
        let dot = CString::new(".").expect("directory component has no NUL");
        let duplicate = unsafe {
            libc::openat(
                dir,
                dot.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if duplicate == -1 {
            return Err(format!(
                "duplicate promotion directory descriptor failed: {}",
                io::Error::last_os_error()
            ));
        }
        let stream = unsafe { libc::fdopendir(duplicate) };
        if stream.is_null() {
            let error = io::Error::last_os_error();
            unsafe { libc::close(duplicate) };
            return Err(format!("open promotion directory stream failed: {error}"));
        }
        Ok(Self { stream })
    }

    pub(crate) fn next_entry(&mut self) -> Result<Option<(String, CString)>, String> {
        loop {
            promotion_clear_errno();
            let entry = unsafe { libc::readdir(self.stream) };
            if entry.is_null() {
                let error = promotion_errno();
                if error != 0 {
                    return Err(format!(
                        "read promotion directory failed: {}",
                        io::Error::from_raw_os_error(error)
                    ));
                }
                return Ok(None);
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
            if name.to_bytes() == b"." || name.to_bytes() == b".." {
                continue;
            }
            let text = std::str::from_utf8(name.to_bytes())
                .map_err(|_| "promotion directory contains a non-UTF-8 name".to_string())?;
            if text.len() > PROMOTION_COMPONENT_MAX_BYTES {
                return Err("promotion directory entry name is too long".to_string());
            }
            let c_name = CString::new(name.to_bytes())
                .map_err(|_| "promotion directory contains a NUL name".to_string())?;
            return Ok(Some((text.to_string(), c_name)));
        }
    }
}

impl Drop for PromotionDirectoryStream {
    fn drop(&mut self) {
        unsafe {
            libc::closedir(self.stream);
        }
    }
}

/// Check emptiness without materializing the directory names. This is used by
/// copy/template destinations where the answer is a boolean; allocating a
/// vector there lets a hostile breadth fan out consume the entire collector
/// envelope before the caller can do useful work.
pub(crate) fn promotion_directory_is_empty(dir: RawFd) -> Result<bool, String> {
    let mut stream = PromotionDirectoryStream::open(dir)?;
    Ok(stream.next_entry()?.is_none())
}

pub(crate) fn promotion_child_relative(relative: &str, name: &str) -> Result<String, String> {
    let child = if relative.is_empty() {
        name.to_string()
    } else {
        format!("{relative}/{name}")
    };
    if child.len() > PROMOTION_PATH_MAX_BYTES {
        return Err("promotion traversal path exceeds its bounded work budget".to_string());
    }
    Ok(child)
}

pub(crate) fn promotion_path_work_bytes(relative: &str, name: &str) -> Result<u64, String> {
    let path_len = relative
        .len()
        .checked_add(if relative.is_empty() { 0 } else { 1 })
        .and_then(|length| length.checked_add(name.len()))
        .filter(|length| *length <= PROMOTION_PATH_MAX_BYTES)
        .ok_or("promotion traversal path exceeds its bounded work budget")?;
    let path_len = u64::try_from(path_len).map_err(|_| "promotion traversal work overflow")?;
    let name_len = u64::try_from(name.len()).map_err(|_| "promotion traversal work overflow")?;
    path_len
        .checked_add(name_len)
        .and_then(|work| work.checked_add(std::mem::size_of::<FileIdentity>() as u64))
        .ok_or_else(|| "promotion traversal work accounting overflow".to_string())
}

pub(crate) fn promotion_add_work(
    work: &mut u64,
    amount: u64,
    max: u64,
    field: &str,
) -> Result<(), String> {
    *work = work
        .checked_add(amount)
        .ok_or_else(|| format!("{field} work accounting overflow"))?;
    if *work > max {
        return Err(format!("{field} exceeds its work bound"));
    }
    Ok(())
}

pub(crate) fn promotion_write_all(file: &mut fs::File, bytes: &[u8], field: &str) -> Result<(), String> {
    file.write_all(bytes)
        .map_err(|error| format!("write promotion {field} failed: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("sync promotion {field} failed: {error}"))
}

pub(crate) fn promotion_set_mode(file: &fs::File, mode: u32, field: &str) -> Result<(), String> {
    let rc = unsafe { libc::fchmod(file.as_raw_fd(), mode as libc::mode_t) };
    if rc == -1 {
        return Err(format!(
            "chmod promotion {field} failed: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(())
}

/// Remove one entry through its already-open parent descriptor.  No pathname
/// is re-resolved and a directory is never accepted by the regular unlink
/// path.  Callers must have performed any identity/type checks before invoking
/// this helper.
pub(crate) fn promotion_unlink_at_field(
    parent: RawFd,
    name: &CStr,
    is_dir: bool,
    field: &str,
) -> Result<(), String> {
    let flags = if is_dir { libc::AT_REMOVEDIR } else { 0 };
    let rc = unsafe { libc::unlinkat(parent, name.as_ptr(), flags) };
    if rc == -1 {
        return Err(format!(
            "remove promotion {field} failed: {}",
            io::Error::last_os_error()
        ));
    }
    Ok(())
}

pub(crate) fn promotion_directory_identity_matches(
    file: &fs::File,
    expected: PromotionIdentity,
    field: &str,
) -> Result<(), String> {
    let actual =
        stat_file(file).map_err(|error| format!("fstat promotion {field} failed: {error}"))?;
    if !actual.is_dir() || actual.dev != expected.dev || actual.ino != expected.ino {
        return Err(format!("promotion {field} identity mismatch"));
    }
    Ok(())
}

pub(crate) fn stat_promotion_journal_file(file: &fs::File) -> io::Result<PromotionJournalFileIdentity> {
    let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
    let rc = unsafe { libc::fstat(file.as_raw_fd(), st.as_mut_ptr()) };
    if rc == -1 {
        Err(io::Error::last_os_error())
    } else {
        let st = unsafe { st.assume_init() };
        Ok(PromotionJournalFileIdentity {
            file: FileIdentity::from_stat(&st),
            uid: st.st_uid as u64,
            links: st.st_nlink as u64,
        })
    }
}

pub(crate) fn stat_promotion_private_at(parent: RawFd, name: &CStr) -> io::Result<PromotionJournalFileIdentity> {
    let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
    let rc = unsafe {
        libc::fstatat(
            parent,
            name.as_ptr(),
            st.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if rc == -1 {
        Err(io::Error::last_os_error())
    } else {
        let st = unsafe { st.assume_init() };
        Ok(PromotionJournalFileIdentity {
            file: FileIdentity::from_stat(&st),
            uid: st.st_uid as u64,
            links: st.st_nlink as u64,
        })
    }
}

pub(crate) fn promotion_private_identity_valid(
    identity: PromotionJournalFileIdentity,
    mode: Option<u32>,
    max_bytes: usize,
) -> bool {
    identity.file.is_file()
        && identity.uid == unsafe { libc::geteuid() as u64 }
        && identity.links == 1
        && identity.file.mode & 0o077 == 0
        && mode.is_none_or(|expected| identity.file.mode & 0o777 == expected)
        && identity.file.len <= max_bytes as u64
}

pub(crate) fn promotion_test_pause(req: &Value, stage: &str) -> Result<(), String> {
    if std::env::var_os("TERMINA_CORE_TEST").is_none() {
        return Ok(());
    }
    let Some(hook) = req.get("testHook").and_then(Value::as_object) else {
        return Ok(());
    };
    if hook.get("stage").and_then(Value::as_str) != Some(stage) {
        return Ok(());
    }
    let ready = hook
        .get("readyPath")
        .and_then(Value::as_str)
        .ok_or("promotion test hook readyPath is missing")?;
    let release = hook
        .get("releasePath")
        .and_then(Value::as_str)
        .ok_or("promotion test hook releasePath is missing")?;
    promotion_absolute_path(ready, "test hook readyPath")?;
    promotion_absolute_path(release, "test hook releasePath")?;
    fs::write(ready, b"ready")
        .map_err(|error| format!("write promotion test hook failed: {error}"))?;
    loop {
        match fs::symlink_metadata(release) {
            Ok(_) => break,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                thread::sleep(Duration::from_millis(1))
            }
            Err(error) => return Err(format!("read promotion test hook failed: {error}")),
        }
    }
    Ok(())
}

pub(crate) fn promotion_rename_noreplace(
    source_parent: RawFd,
    source: &CStr,
    destination_parent: RawFd,
    destination: &CStr,
) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        let rc = unsafe {
            libc::renameat2(
                source_parent,
                source.as_ptr(),
                destination_parent,
                destination.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if rc == -1 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
    #[cfg(target_os = "macos")]
    {
        let rc = unsafe {
            libc::renameatx_np(
                source_parent,
                source.as_ptr(),
                destination_parent,
                destination.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        if rc == -1 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (source_parent, source, destination_parent, destination);
        Err(io::Error::from_raw_os_error(libc::ENOTSUP))
    }
}

pub(crate) fn promotion_mode(value: Option<&Value>, field: &str, default: u32) -> Result<u32, String> {
    let mode = value.and_then(Value::as_u64).unwrap_or(u64::from(default));
    if mode > 0o777 {
        return Err(format!("{field} is invalid"));
    }
    Ok(mode as u32)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct PromotionJournalFileIdentity {
    pub(crate) file: FileIdentity,
    pub(crate) uid: u64,
    pub(crate) links: u64,
}
