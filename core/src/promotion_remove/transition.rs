//! Promotion transition op: preservation-first namespace transitions.
use std::os::fd::AsRawFd;

use serde_json::Value;

use crate::promotion_files::{
    promotion_rename_exchange,
    promotion_rename_unsupported,
    promotion_transition_result,
};
use crate::promote_fs::{
    observe_promotion_leaf,
    open_promotion_bound_root,
    open_promotion_bound_root_values,
    open_promotion_parent,
    parse_promotion_expected,
    parse_promotion_expected_destination,
    promotion_components,
    promotion_components_value,
    promotion_directory_identity_matches,
    promotion_expected_matches,
    promotion_expected_state_description,
    promotion_identity_from_value,
    promotion_name,
    promotion_rename_noreplace,
    promotion_test_pause,
};


pub(crate) fn op_promotion_bound_transition(req: &Value) -> Result<Value, String> {
    let (primary, _primary_identity, _primary_capability) = open_promotion_bound_root(
        req,
        "primaryRoot",
        "primaryRootIdentity",
        "primaryRootCapability",
    )?;
    let components = promotion_components(req)?;
    let parent_identity = promotion_identity_from_value(
        req.get("parentIdentity").ok_or("missing parentIdentity")?,
        "parentIdentity",
    )?;
    let destination_name = components
        .last()
        .ok_or("promotion destination is missing")?;
    let parent = open_promotion_parent(&primary, &components, "primary")?;
    promotion_directory_identity_matches(&parent, parent_identity, "promotion parent")?;
    promotion_test_pause(req, "primary-parent-open")?;

    let transition = req
        .get("transition")
        .and_then(Value::as_object)
        .ok_or("transition must be an object")?;
    let kind = transition
        .get("kind")
        .and_then(Value::as_str)
        .ok_or("transition.kind is missing")?;
    let destination = &destination_name.1;
    match kind {
        "exchange" => {
            let (source_name, source) = promotion_name(
                transition
                    .get("sourceName")
                    .ok_or("exchange sourceName is missing")?,
                "sourceName",
                ".termina-promotion-",
            )?;
            if source_name == destination_name.0 {
                return Err("promotion exchange source and destination must differ".to_string());
            }
            let expected_source = parse_promotion_expected(
                transition
                    .get("expectedSource")
                    .ok_or("exchange expectedSource is missing")?,
                "expectedSource",
            )?;
            let expected_destination = parse_promotion_expected(
                transition
                    .get("expectedDestination")
                    .ok_or("exchange expectedDestination is missing")?,
                "expectedDestination",
            )?;
            if expected_source.identity == expected_destination.identity {
                return Err("promotion exchange identities must differ".to_string());
            }
            let observed_source = observe_promotion_leaf(parent.as_raw_fd(), &source)?;
            let observed_destination = observe_promotion_leaf(parent.as_raw_fd(), destination)?;
            if !promotion_expected_matches(&expected_source, observed_source.as_ref())
                || !promotion_expected_matches(&expected_destination, observed_destination.as_ref())
            {
                return Err(format!(
                    "promotion exchange expected {} identities were not present",
                    promotion_expected_state_description(&expected_source),
                ));
            }
            promotion_test_pause(req, "promotion-leaf-validated")?;
            if let Err(error) = promotion_rename_exchange(
                parent.as_raw_fd(),
                &source,
                parent.as_raw_fd(),
                destination,
            ) {
                if promotion_rename_unsupported(&error) {
                    return Err("promotion bound rename mode is unsupported".to_string());
                }
                return Err(format!("promotion exchange failed: {error}"));
            }
            promotion_test_pause(req, "promotion-syscall")?;
            let post_destination = observe_promotion_leaf(parent.as_raw_fd(), destination);
            let post_source = observe_promotion_leaf(parent.as_raw_fd(), &source);
            let mut post_error = None;
            if !post_destination
                .as_ref()
                .ok()
                .and_then(|observed| observed.as_ref())
                .is_some_and(|observed| {
                    promotion_expected_matches(&expected_source, Some(observed))
                })
                || !post_source
                    .as_ref()
                    .ok()
                    .and_then(|observed| observed.as_ref())
                    .is_some_and(|observed| {
                        promotion_expected_matches(&expected_destination, Some(observed))
                    })
            {
                post_error =
                    Some("promotion exchange changed an operand after mutation".to_string());
            }
            if let Err(error) = parent.sync_all() {
                post_error = Some(format!("promotion parent durability failed: {error}"));
            }
            if let Some(error) = post_error {
                return Ok(promotion_transition_result(
                    "exchange",
                    "conflict-after-mutation",
                    false,
                    None,
                    Some(error),
                ));
            }
            Ok(promotion_transition_result(
                "exchange", "applied", true, None, None,
            ))
        }
        "install" => {
            let source_root_path = transition
                .get("sourceRoot")
                .and_then(Value::as_str)
                .ok_or("install sourceRoot is missing")?;
            let source_root_identity = promotion_identity_from_value(
                transition
                    .get("sourceRootIdentity")
                    .ok_or("install sourceRootIdentity is missing")?,
                "install sourceRootIdentity",
            )?;
            let source_root = open_promotion_bound_root_values(
                source_root_path,
                Some(source_root_identity),
                transition
                    .get("sourceRootCapability")
                    .and_then(Value::as_str),
                "install sourceRoot",
            )?
            .0;
            // Reuse the same strict component validation as destination paths
            // while keeping this source tree explicitly separate.
            let source_components = promotion_components_value(
                transition
                    .get("sourceComponents")
                    .ok_or("install sourceComponents is missing")?,
                "install sourceComponents",
            )?;
            let source_name = source_components
                .last()
                .ok_or("install sourceComponents is missing")?;
            let source_parent =
                open_promotion_parent(&source_root, &source_components, "install source")?;
            let source_parent_identity = promotion_identity_from_value(
                transition
                    .get("sourceParentIdentity")
                    .ok_or("install sourceParentIdentity is missing")?,
                "install sourceParentIdentity",
            )?;
            promotion_directory_identity_matches(
                &source_parent,
                source_parent_identity,
                "install source parent",
            )?;
            if source_parent_identity == parent_identity && source_name.0 == destination_name.0 {
                // Same names under equal identities identify one namespace
                // entry, never two independent install operands.
                return Err("promotion install source and destination must differ".to_string());
            }
            let expected_source = parse_promotion_expected(
                transition
                    .get("expectedSource")
                    .ok_or("install expectedSource is missing")?,
                "install expectedSource",
            )?;
            let expected_destination = parse_promotion_expected_destination(
                transition
                    .get("expectedDestination")
                    .ok_or("install expectedDestination is missing")?,
                "install expectedDestination",
            )?;
            if expected_destination
                .as_ref()
                .is_some_and(|expected| expected.identity == expected_source.identity)
            {
                return Err("promotion install identities must differ".to_string());
            }
            let observed_source =
                observe_promotion_leaf(source_parent.as_raw_fd(), &source_name.1)?;
            let observed_destination = observe_promotion_leaf(parent.as_raw_fd(), destination)?;
            if !promotion_expected_matches(&expected_source, observed_source.as_ref()) {
                return Err(format!(
                    "promotion install expected {} source identity was not present",
                    promotion_expected_state_description(&expected_source),
                ));
            }
            let destination_matches = match (&expected_destination, &observed_destination) {
                (None, None) => true,
                (Some(expected), Some(observed)) => {
                    promotion_expected_matches(expected, Some(observed))
                }
                _ => false,
            };
            if !destination_matches {
                return Err(
                    "promotion install expected destination state was not present".to_string(),
                );
            }
            promotion_test_pause(req, "promotion-leaf-validated")?;
            let rename_result = if expected_destination.is_some() {
                promotion_rename_exchange(
                    source_parent.as_raw_fd(),
                    &source_name.1,
                    parent.as_raw_fd(),
                    destination,
                )
            } else {
                promotion_rename_noreplace(
                    source_parent.as_raw_fd(),
                    &source_name.1,
                    parent.as_raw_fd(),
                    destination,
                )
            };
            if let Err(error) = rename_result {
                if promotion_rename_unsupported(&error) {
                    return Err("promotion bound rename mode is unsupported".to_string());
                }
                return Err(format!("promotion install failed: {error}"));
            }
            promotion_test_pause(req, "promotion-syscall")?;
            let post_destination = observe_promotion_leaf(parent.as_raw_fd(), destination);
            let post_source = observe_promotion_leaf(source_parent.as_raw_fd(), &source_name.1);
            let mut post_error = None;
            let destination_is_expected = post_destination
                .as_ref()
                .ok()
                .and_then(|observed| observed.as_ref())
                .is_some_and(|observed| {
                    promotion_expected_matches(&expected_source, Some(observed))
                });
            let source_is_expected = match &expected_destination {
                None => post_source
                    .as_ref()
                    .ok()
                    .and_then(|observed| observed.as_ref())
                    .is_none(),
                Some(expected) => post_source
                    .as_ref()
                    .ok()
                    .and_then(|observed| observed.as_ref())
                    .is_some_and(|observed| promotion_expected_matches(expected, Some(observed))),
            };
            if !destination_is_expected || !source_is_expected {
                post_error =
                    Some("promotion install changed an operand after mutation".to_string());
            }
            if let Err(error) = parent.sync_all() {
                post_error = Some(format!(
                    "promotion destination parent durability failed: {error}"
                ));
            }
            if let Err(error) = source_parent.sync_all() {
                post_error = Some(format!(
                    "promotion source parent durability failed: {error}"
                ));
            }
            if let Some(error) = post_error {
                return Ok(promotion_transition_result(
                    "install",
                    "conflict-after-mutation",
                    false,
                    None,
                    Some(error),
                ));
            }
            Ok(promotion_transition_result(
                "install", "applied", true, None, None,
            ))
        }
        "retire" => {
            let (retained_name, retained) = promotion_name(
                transition
                    .get("retainedName")
                    .ok_or("retire retainedName is missing")?,
                "retainedName",
                ".termina-promotion-retained-",
            )?;
            if retained_name == destination_name.0 {
                return Err(
                    "promotion retire retained and destination names must differ".to_string(),
                );
            }
            let external_retained_fields = [
                transition.get("retainedRoot"),
                transition.get("retainedRootIdentity"),
                transition.get("retainedComponents"),
                transition.get("retainedParentIdentity"),
            ];
            let external_retained = external_retained_fields.iter().any(Option::is_some);
            if external_retained && external_retained_fields.iter().any(Option::is_none) {
                return Err("promotion retire retained destination is incomplete".to_string());
            }
            let (retained_parent, retained) = if external_retained {
                let retained_root_path = transition
                    .get("retainedRoot")
                    .and_then(Value::as_str)
                    .ok_or("retire retainedRoot is missing")?;
                let retained_root_identity = promotion_identity_from_value(
                    transition
                        .get("retainedRootIdentity")
                        .ok_or("retire retainedRootIdentity is missing")?,
                    "retire retainedRootIdentity",
                )?;
                let retained_root = open_promotion_bound_root_values(
                    retained_root_path,
                    Some(retained_root_identity),
                    transition
                        .get("retainedRootCapability")
                        .and_then(Value::as_str),
                    "retire retainedRoot",
                )?
                .0;
                let retained_components = promotion_components_value(
                    transition
                        .get("retainedComponents")
                        .ok_or("retire retainedComponents is missing")?,
                    "retire retainedComponents",
                )?;
                let retained_leaf = retained_components
                    .last()
                    .ok_or("retire retainedComponents is missing")?;
                if retained_leaf.0 != retained_name {
                    return Err("retire retainedName does not match retainedComponents".to_string());
                }
                let retained_parent =
                    open_promotion_parent(&retained_root, &retained_components, "retire retained")?;
                let retained_parent_identity = promotion_identity_from_value(
                    transition
                        .get("retainedParentIdentity")
                        .ok_or("retire retainedParentIdentity is missing")?,
                    "retire retainedParentIdentity",
                )?;
                promotion_directory_identity_matches(
                    &retained_parent,
                    retained_parent_identity,
                    "retire retained parent",
                )?;
                (retained_parent, retained_leaf.1.clone())
            } else {
                (
                    parent.try_clone().map_err(|error| {
                        format!("clone promotion retire parent failed: {error}")
                    })?,
                    retained,
                )
            };
            let expected_destination = parse_promotion_expected(
                transition
                    .get("expectedDestination")
                    .ok_or("retire expectedDestination is missing")?,
                "expectedDestination",
            )?;
            let observed_destination = observe_promotion_leaf(parent.as_raw_fd(), destination)?;
            let observed_retained = observe_promotion_leaf(retained_parent.as_raw_fd(), &retained)?;
            if !promotion_expected_matches(&expected_destination, observed_destination.as_ref()) {
                return Err(format!(
                    "promotion retire expected {} identity was not present",
                    promotion_expected_state_description(&expected_destination),
                ));
            }
            if observed_retained.is_some() {
                return Err("promotion retire retained name is occupied".to_string());
            }
            promotion_test_pause(req, "promotion-leaf-validated")?;
            if let Err(error) = promotion_rename_noreplace(
                parent.as_raw_fd(),
                destination,
                retained_parent.as_raw_fd(),
                &retained,
            ) {
                if promotion_rename_unsupported(&error) {
                    return Err("promotion bound rename mode is unsupported".to_string());
                }
                return Err(format!("promotion retire failed: {error}"));
            }
            promotion_test_pause(req, "promotion-syscall")?;
            let post_destination = observe_promotion_leaf(parent.as_raw_fd(), destination);
            let post_retained = observe_promotion_leaf(retained_parent.as_raw_fd(), &retained);
            let mut post_error = None;
            if post_destination
                .as_ref()
                .ok()
                .and_then(|observed| observed.as_ref())
                .is_some()
                || !post_retained
                    .as_ref()
                    .ok()
                    .and_then(|observed| observed.as_ref())
                    .is_some_and(|observed| {
                        promotion_expected_matches(&expected_destination, Some(observed))
                    })
            {
                post_error = Some("promotion retire changed an operand after mutation".to_string());
            }
            if let Err(error) = parent.sync_all() {
                post_error = Some(format!("promotion parent durability failed: {error}"));
            }
            if let Err(error) = retained_parent.sync_all() {
                post_error = Some(format!(
                    "promotion retained parent durability failed: {error}"
                ));
            }
            if let Some(error) = post_error {
                return Ok(promotion_transition_result(
                    "retire",
                    "conflict-after-mutation",
                    false,
                    Some(&retained_name),
                    Some(error),
                ));
            }
            Ok(promotion_transition_result(
                "retire",
                "applied",
                true,
                Some(&retained_name),
                None,
            ))
        }
        _ => Err("unsupported promotion transition kind".to_string()),
    }
}
