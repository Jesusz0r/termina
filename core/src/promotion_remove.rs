//! Promotion quarantine, remove-tree, transition, and in-place unlink.
mod cleanup;
mod remove_tree;
mod transition;
mod unlink;

pub(crate) use remove_tree::op_promotion_bound_remove_tree;
pub(crate) use transition::op_promotion_bound_transition;
pub(crate) use unlink::promotion_remove_tree_contents;
