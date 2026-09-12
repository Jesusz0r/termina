//! Source-tree capture, incremental capture, state application, and
//! template creation: descriptor-bound reads assembled into Git state.
mod binding;
mod trees;
mod walk;
mod tree_cache;
mod refs;
mod materialize;
mod ops_capture;
mod ops_apply;

pub(crate) use binding::{AnchoredPath, CaptureRoot, open_store};
pub(crate) use trees::{FlatEntry, nested_from_flat, write_nested_tree_for_ref};
pub(crate) use walk::{
    GitTreeBudget, TreeLookupKind, git_blob_bytes_bounded, git_blob_size_bounded,
    git_tree_entry_path, git_tree_object_bounded, resolve_tree, state_entries, tree_lookup,
};
pub(crate) use refs::{
    exact_ref_target, pause_at_hook, publish_transaction_ref, sync_exact_transaction_ref,
    validate_transaction_ref,
};
pub(crate) use materialize::{materialize_state_bound, promotion_remove_tree_contents};
pub(crate) use ops_capture::{op_capture, op_capture_incremental};
pub(crate) use ops_apply::{op_apply_state, op_template};
