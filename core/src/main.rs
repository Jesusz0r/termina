//! The Termina snapshot core.
//!
//! Performs every app-owned Git store operation off the Electron main
//! thread: captures, incremental captures, state application, template
//! creation, and trust hashes. The store is a bare Git repository that
//! reads source objects through a read-only alternate. It never writes
//! the user's Git directory.
//!
//! Protocol: JSON-lines over stdin/stdout. The main process writes one
//! request per line and reads one response per line. Every request carries
//! `op` and `requestId`; every response carries `op: "<op>-result"`,
//! `requestId`, and `ok`. A failed op returns `error` with the reason.

use std::io::{self, BufRead, Write};
use std::sync::atomic::AtomicU64;

use serde_json::{Value, json};

mod store;
mod store_tx;
mod promote_fs;
mod test_hooks;
mod capture;
use capture::{
    FlatEntry, GitTreeBudget, TreeLookupKind, exact_ref_target,
    git_blob_bytes_bounded, git_blob_size_bounded, git_tree_entry_path, git_tree_object_bounded,
    materialize_state_bound, nested_from_flat, op_apply_state, op_capture, op_capture_incremental,
    op_template, open_store, pause_at_hook,
    publish_transaction_ref, read_link_at, resolve_tree, state_entries, sync_exact_transaction_ref,
    tree_lookup, validate_transaction_ref, write_nested_tree_for_ref,
};
mod copy;
mod promotion_files;
use promotion_files::{
    op_promotion_bound_copy_file, op_promotion_bound_copy_tree, op_promotion_bound_create_directory,
    op_promotion_bound_create_symlink, op_promotion_bound_ensure_directory,
    op_promotion_bound_install_directory, op_promotion_bound_list_directories,
    op_promotion_bound_list_entries, op_promotion_bound_open_directory,
    op_promotion_bound_prepare_directory, op_promotion_bound_read_file,
    op_promotion_bound_read_journal, op_promotion_bound_write_file, promotion_rename_unsupported,
};
use crate::promote_fs::{
    promotion_directory_is_empty, promotion_rename_noreplace, promotion_unlink_at_field,
};
mod promotion_remove;
use promotion_remove::{op_promotion_bound_remove_tree, op_promotion_bound_transition};
mod retained;
mod util;
mod store_ops;
use store_ops::{op_store_create, op_store_destroy};
mod preflight;
use preflight::op_preflight;
mod trees;
use trees::{op_diff_tree, op_materialize, op_merge3, op_read_blob, op_symlink_target, op_tree_paths, op_unref};
mod trust;
use store::{
    FileIdentity, StoreNodeIdentity,
    bind_store_result, current_store_lifecycle, ensure_real_directory,
    fresh_store_generation, lifecycle_json, lifecycle_mismatch,
    store_lifecycle_at_root, store_node_at, store_node_at_optional,
    store_node_file, store_node_matches, sync_directory_nofollow,
    validate_store_lifecycle, write_store_generation,
};
use store_tx::{
    StoreMutationLock, StoreObjectTransaction, ensure_blob_budget,
    recover_store_transaction, write_blob, write_transaction_object,
    write_transaction_object_with_oid,
};
use trust::op_trust_hashes;

mod repo;
use repo::{op_git_common_dir, op_git_head, op_git_object_format, op_git_top_level, op_ls_ignored, op_ls_tracked, op_repo_diff, op_repo_file, op_repo_status, op_repo_tree};

/// The default capture budgets (WORLDLINES section 9).
pub(crate) const BUDGET_MAX_PATHS: usize = 100_000;
pub(crate) const BUDGET_MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
/// A raw blob delivered in a base64 JSON response must stay below the
/// CoreClient's bounded stdout line buffer. This is intentionally separate
/// from the 64 MiB capture-file budget.
pub(crate) const READ_BLOB_MAX_BYTES: u64 = 47 * 1024 * 1024;
pub(crate) const BUDGET_MAX_NEW_BLOB_BYTES: u64 = 256 * 1024 * 1024;
/// Maximum journal bytes returned by the descriptor-bound promotion read.
/// Promotion policy remains in Electron; core only authenticates the file
/// descriptor and returns bounded raw bytes.
pub(crate) const PROMOTION_JOURNAL_MAX_BYTES: u64 = 16 * 1024 * 1024;
pub(crate) const PROMOTION_PATH_MAX_BYTES: usize = 4_096;
pub(crate) const PROMOTION_COMPONENT_MAX_BYTES: usize = 255;
pub(crate) const PROMOTION_COMPONENT_ARRAY_MAX_ENTRIES: usize = 256;
pub(crate) const PROMOTION_COMPONENT_ARRAY_MAX_NAME_BYTES: usize = 128 * 1024;
/// Descriptor-bound tree copies are used to populate comparison templates and
/// candidates.  Keep the native copy envelope finite even when a caller
/// supplies a runtime directory rather than a captured state.
pub(crate) const PROMOTION_COPY_TREE_MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const PROMOTION_COPY_TREE_MAX_ENTRIES: usize = 1_000_000;
const PROMOTION_COPY_TREE_MAX_WORK_BYTES: u64 = 128 * 1024 * 1024;
/// Every native promotion directory collector has an explicit envelope. The
/// collector checks both limits before pushing another name, so a hostile
/// directory cannot force an unbounded allocation even on paths that sort or
/// revisit entries.
pub(crate) const PROMOTION_DIRECTORY_MAX_ENTRIES: usize = PROMOTION_COPY_TREE_MAX_ENTRIES;
pub(crate) const PROMOTION_DIRECTORY_MAX_NAME_BYTES: u64 = 128 * 1024 * 1024;
pub(crate) const PROMOTION_DIRECTORY_MAX_DEPTH: usize = 64;
/// Startup recovery only needs the bounded journal-root envelope. Keep this
/// stricter than the general copy collector so an oversized adjacent root is
/// rejected before any response array is materialized.
pub(crate) const PROMOTION_RECOVERY_ROOT_MAX_ENTRIES: usize = 128;
/// The retained-session root binder is deliberately stricter than the
/// general promotion directory helper. It validates the complete retained
/// shape while the parent and leaf descriptors are still held.
/// Darwin and Linux have no inode-conditional unlinkat.  Cleanup therefore
/// retains each quarantined object in a fresh descriptor-bound container.  A
/// durable cap keeps a sequence of failed/uncertain cleanups from becoming an
/// unbounded disk sink; the caller must resolve or export evidence before the
/// cap is reached.
const PROMOTION_QUARANTINE_MAX_CONTAINERS: usize = 128;
pub(crate) const PROMOTION_QUARANTINE_MAX_ENTRIES: usize = 250_000;
pub(crate) const PROMOTION_QUARANTINE_MAX_BYTES: u64 = 8 * 1024 * 1024 * 1024;
pub(crate) const PROMOTION_QUARANTINE_PREFIX: &str = ".termina-promotion-quarantine-";
/// Unref prunes loose objects only past this many files. Small stores skip
/// Cached tree maps kept across requests. Captures chain parent to child,
/// so the parent map of the next request is usually the one just built.
pub(crate) const TREE_MAP_CACHE_SIZE: usize = 8;
/// Loose-object compression level. The format matches Git at every level;
/// the fast level cuts capture CPU on the hot path.
pub(crate) const BLOB_COMPRESSION: flate2::Compression = flate2::Compression::fast();
/// A burst of unrefs shares one prune: the walk does not rerun inside this
/// Durable per-session identity for the app-owned snapshot store.  The
/// sibling mutation lock survives store deletion, so the marker must live in
/// the store itself and change on every store-create.
/// Publish large captures in bounded groups while keeping common captures to
/// one blob/tree group plus the final commit. Directory durability work is
/// per group, never per object.
pub(crate) static PROMOTION_CLEANUP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
pub(crate) static STORE_DESTROY_SEQUENCE: AtomicU64 = AtomicU64::new(0);



// ---------------------------------------------------------- trust hash ----


// ---------------------------------------------------------- store create ----


// ------------------------------------------------------------ preflight ----


// --------------------------------------------------------------- merge3 ----


// ---------------------------------------------------------- source queries ----


// ------------------------------------------------------------ dispatch -----

fn store_lifecycle_operation(op: &str) -> bool {
    matches!(
        op,
        "capture"
            | "capture-incremental"
            | "apply-state"
            | "template"
            | "merge3"
            | "diff-tree"
            | "materialize"
            | "tree-paths"
            | "symlink-target"
            | "read-blob"
            | "unref"
    )
}

fn dispatch(op: &str, req: &Value) -> Result<Value, String> {
    let result = match op {
        "capture" => op_capture(req),
        "capture-incremental" => op_capture_incremental(req),
        "apply-state" => op_apply_state(req),
        "template" => op_template(req),
        "trust-hashes" => op_trust_hashes(req),
        "store-create" => op_store_create(req),
        "store-destroy" => op_store_destroy(req),
        "preflight" => op_preflight(req),
        "merge3" => op_merge3(req),
        "diff-tree" => op_diff_tree(req),
        "materialize" => op_materialize(req),
        "tree-paths" => op_tree_paths(req),
        "symlink-target" => op_symlink_target(req),
        "read-blob" => op_read_blob(req),
        "promotion-bound-read-journal" => op_promotion_bound_read_journal(req),
        "promotion-bound-read-file" => op_promotion_bound_read_file(req),
        "promotion-bound-open-directory" => op_promotion_bound_open_directory(req),
        "promotion-bound-list-directories" => op_promotion_bound_list_directories(req),
        "promotion-bound-list-entries" => op_promotion_bound_list_entries(req),
        "promotion-bound-prepare-directory" => op_promotion_bound_prepare_directory(req),
        "promotion-bound-ensure-directory" => op_promotion_bound_ensure_directory(req),
        "promotion-bound-transition" => op_promotion_bound_transition(req),
        "promotion-bound-create-directory" => op_promotion_bound_create_directory(req),
        "promotion-bound-write-file" => op_promotion_bound_write_file(req),
        "promotion-bound-copy-file" => op_promotion_bound_copy_file(req),
        "promotion-bound-copy-tree" => op_promotion_bound_copy_tree(req),
        "promotion-bound-create-symlink" => op_promotion_bound_create_symlink(req),
        "promotion-bound-install-directory" => op_promotion_bound_install_directory(req),
        "promotion-bound-remove-tree" => op_promotion_bound_remove_tree(req),
        "unref" => op_unref(req),
        "git-head" => op_git_head(req),
        "git-top-level" => op_git_top_level(req),
        "git-common-dir" => op_git_common_dir(req),
        "git-object-format" => op_git_object_format(req),
        "ls-tracked" => op_ls_tracked(req),
        "repo-status" => op_repo_status(req),
        "repo-diff" => op_repo_diff(req),
        "repo-tree" => op_repo_tree(req),
        "repo-file" => op_repo_file(req),
        "ls-ignored" => op_ls_ignored(req),
        other => Err(format!("unknown op: {other}")),
    }?;
    if store_lifecycle_operation(op) {
        bind_store_result(req, result)
    } else {
        Ok(result)
    }
}

fn main() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => {
                // Answer every input line. The client times out and respawns.
                let response = json!({
                    "op": "error",
                    "requestId": Value::Null,
                    "ok": false,
                    "error": "invalid request json"
                });
                let mut stdout = stdout.lock();
                if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
                    break;
                }
                continue;
            }
        };
        let op = request
            .get("op")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let request_id = request
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let response = match dispatch(&op, &request) {
            Ok(payload) => {
                let mut response =
                    json!({ "op": format!("{op}-result"), "requestId": request_id, "ok": true });
                if let Some(obj) = payload.as_object() {
                    for (key, value) in obj {
                        // Payload keys must not overwrite the envelope.
                        if key == "op" || key == "requestId" || key == "ok" || key == "error" {
                            continue;
                        }
                        response[key] = value.clone();
                    }
                }
                response
            }
            Err(error) => {
                let stderr = io::stderr();
                let mut stderr = stderr.lock();
                let _ = writeln!(stderr, "[core] {op} failed: {error}");
                json!({ "op": format!("{op}-result"), "requestId": request_id, "ok": false, "error": error })
            }
        };
        let mut stdout = stdout.lock();
        if writeln!(stdout, "{response}").is_err() {
            break;
        }
        if stdout.flush().is_err() {
            break;
        }
    }
}
