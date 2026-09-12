//! Promotion-bound file ops: open, list, prepare, ensure, journal/file
//! reads, create, write, copy, symlink, and install-directory.
mod dirs;
mod rename;
mod read;
mod write;
mod bound_copy;

pub(crate) use dirs::{
    op_promotion_bound_ensure_directory, op_promotion_bound_list_directories,
    op_promotion_bound_list_entries, op_promotion_bound_open_directory,
    op_promotion_bound_prepare_directory,
};
pub(crate) use rename::{
    promotion_cleanup_same_namespace_identity, promotion_rename_exchange,
    promotion_rename_unsupported, promotion_transition_result,
};
pub(crate) use read::{op_promotion_bound_read_file, op_promotion_bound_read_journal};
pub(crate) use write::{
    op_promotion_bound_create_directory, op_promotion_bound_create_symlink,
    op_promotion_bound_install_directory, op_promotion_bound_write_file,
};
pub(crate) use bound_copy::{op_promotion_bound_copy_file, op_promotion_bound_copy_tree};
