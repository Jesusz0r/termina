//! Retained promotion roots: validation, markers, provenance, root
//! state, and the root-transaction op.
mod validate;
mod private_files;
mod root_state;
mod ops;

pub(crate) const RETAINED_ROOT_MAX_ENTRIES: usize = 128 * 4;
pub(crate) const RETAINED_ROOT_MAX_SCAN_ENTRIES: usize = 250_000;
pub(crate) const RETAINED_ROOT_MAX_SCAN_DEPTH: usize = 64;
pub(crate) const RETAINED_ROOT_MAX_SCAN_BYTES: u64 = 4 * 1024 * 1024 * 1024;
pub(crate) const RETAINED_ROOT_MAX_SCAN_WORK_BYTES: u64 = 128 * 1024 * 1024;
pub(crate) const RETAINED_ROOT_MARKER_MAX_BYTES: usize = 128;
pub(crate) const RETAINED_ROOT_PROVENANCE_MAX_BYTES: usize = 4096;

pub(crate) use ops::op_promotion_bound_root_transaction;
