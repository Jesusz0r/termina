//! Promotion quarantine, remove-tree, and transition: cleanup-tree
//! validation, quarantine accounting and containers, and the two ops.
mod cleanup;
mod remove_tree;
mod transition;

pub(crate) use remove_tree::op_promotion_bound_remove_tree;
pub(crate) use transition::op_promotion_bound_transition;
