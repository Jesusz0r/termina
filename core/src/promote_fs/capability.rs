//! Promotion identities and the bound-root capability registry.
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};

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
    pub(crate) path: String,
    pub(crate) identity: PromotionIdentity,
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
        let active = issue_promotion_root_capability("/active", active_identity)
            .expect("test capability fits a cleared registry");
        for index in 1..MAX_PROMOTION_ROOT_CAPABILITIES {
            issue_promotion_root_capability(
                &format!("/root-{index}"),
                PromotionIdentity {
                    dev: 1,
                    ino: index as u64 + 1,
                },
            )
            .expect("test capability fits a bounded registry");
        }

        assert_eq!(
            issue_promotion_root_capability("/active", active_identity)
                .expect("reused test capability resolves"),
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
