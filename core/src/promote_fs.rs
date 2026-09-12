//! Descriptor-bound promotion filesystem primitives: identities,
//! capabilities, expected/observed states, components, bound roots, the
//! bound cwd guard, directory streams, and raw at(2) mutation helpers.
mod capability;
mod expected;
mod bound;
mod io;

pub(crate) use capability::{
    PromotionIdentity, issue_promotion_root_capability, promotion_directory_capability_result,
};
pub(crate) use expected::{
    PromotionExpectedLeaf, PromotionExpectedState, PromotionObservedLeaf, PromotionObservedState,
    observe_promotion_leaf, parse_promotion_expected, parse_promotion_expected_destination,
    promotion_absolute_path, promotion_component, promotion_expected_matches,
    promotion_expected_state_description, promotion_identity_from_value, promotion_name,
    promotion_sha256_hex,
};
pub(crate) use bound::{
    PromotionCwd, open_or_create_promotion_parent, open_promotion_absolute_directory,
    open_promotion_bound_root, open_promotion_bound_root_values, open_promotion_parent,
    promotion_bound_path_matches, promotion_components, promotion_components_for,
    promotion_components_value, promotion_identity_chain_from_value,
    promotion_path_with_components,
};
pub(crate) use io::{
    PromotionDirectoryStream, promotion_add_work, promotion_child_relative,
    promotion_directory_identity_matches, promotion_directory_is_empty, promotion_mkdir_at,
    promotion_mode, promotion_path_work_bytes, promotion_private_identity_valid,
    promotion_rename_noreplace, promotion_set_mode, promotion_symlink_at, promotion_test_pause,
    promotion_unlink_at_field, promotion_write_all, stat_promotion_journal_file,
    stat_promotion_private_at,
};
