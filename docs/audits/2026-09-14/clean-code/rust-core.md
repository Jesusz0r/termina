# Clean Code / YAGNI / KISS audit — `core/` (`termina-core`)

Audit only. No production or test code was changed. No GitHub issues opened.

Date of this pass: 2026-09-15. House-rule priority when Clean Code conflicts with Termina rules: correctness / data integrity → security / isolation → task → hot-path performance → public contracts → one owner → simplicity → developer convenience. Incidental syntax duplication is not a finding. Duplicated *responsibility* is. An 800-line file is a review trigger, not an automatic split. `#[cfg(test)]` unwraps are not defects. Prod `.unwrap()` / `.expect()` are not reopened here except as already ticketed.

## Scope + files / lines audited

**Exclusive domain:** `core/` Rust sources. `electron/worldline-git.ts` and `electron/worldline-git/` were read only as callers (is a core op dead or duplicated?). Not audited as primary scope.

**Skipped:** `target/`, `node_modules`, `docs/audits/2026-09-13`.

| Tree | Files | Lines (`wc -l`) |
| --- | ---: | ---: |
| `core/src/**/*.rs` | 40 | 13 604 |
| `core/tests/**/*.rs` | 8 | 2 021 |
| `core/Cargo.toml` | 1 | 14 |
| **Primary audit (src)** | **40** | **13 604** |

`#332` recorded 40 / 13 605; this tree is 40 / 13 604.

### Internal owners vs `AGENTS.md`

`AGENTS.md` names one crate owner: `core/` owns application Git / snapshot operations (capture, hash, merge). Application code must not spawn the `git` CLI. Inside the crate the map is:

| Responsibility | Owner (entry) | Files (lines) |
| --- | --- | --- |
| JSONL protocol + budgets | `main.rs` | 291 |
| Store identity / lifecycle / durable files | `store.rs` | 644 |
| Store mutation lock + object journal | `store_tx.rs` | 671 |
| `store-create` / `store-destroy` | `store_ops.rs` | 300 |
| Capture / apply / template / materialize | `capture.rs` + `capture/` | 24 + 3 275 |
| Merge / diff / materialize op / blob / unref | `trees.rs` | 489 |
| Identity-bound copy engine | `copy.rs` | 415 |
| Promotion file ops | `promotion_files.rs` + `promotion_files/` | 23 + 1 457 |
| Promotion quarantine / remove / transition | `promotion_remove.rs` + `promotion_remove/` | 8 + 1 183 |
| Descriptor-bound FS primitives | `promote_fs.rs` + `promote_fs/` | 33 + 1 327 |
| Retained-root binder | `retained.rs` + `retained/` | 16 + 1 384 |
| Trust hashes | `trust.rs` | 600 (incl. tests) |
| Capture preflight | `preflight.rs` | 362 (incl. tests) |
| Source-repo reads | `repo.rs` | 293 |
| Shared plumbing + capture hash | `util.rs` | 651 |
| Test pause primitive | `test_hooks.rs` | 128 |

Largest src files (review trigger only; none exceed 800): `store_tx.rs` 671, `util.rs` 651, `store.rs` 644, `capture/materialize.rs` 644, `capture/ops_capture.rs` 643, `trust.rs` 600.

### Caller check (not primary scope)

Every `dispatch` op in `main.rs` has a TypeScript caller except `promotion-bound-root-transaction`, which is not a protocol op: `promotion_files/dirs.rs` forwards `ensure-directory` into `retained::op_promotion_bound_root_transaction` when `provenance` / `marker` is present. No dead public op. No parallel TS `git` CLI path was requested or recommended.

## Counts

| | P1 | P2 | P3 | Total |
| --- | ---: | ---: | ---: | ---: |
| **NEW** | 1 | 9 | 8 | 18 |
| **ALREADY-TICKETED** | 0 | 0 | 2 tickets / 3 items | 3 items |
| **All** | 1 | 9 | 11 | 21 |

Already ticketed: `#332` (`store_tx` size + `materialize.rs` clones), `#334` (53 prod `.expect()`). Not re-proposed.

Top 10 below are the 10 NEW P1/P2 items. P3s and already-ticketed items are after the checked-clean list.

## Findings table (top 10 — NEW)

| ID | Path:line | Principle | Sev | As-is | Should-be | Smallest fix | Do **not** |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | `promote_fs/bound.rs:28` and `util.rs:357` / `419` | Clean / YAGNI (owner-dup) | **P1** | Two live nofollow absolute-directory walks. Promotion copies the `/` + `O_NOFOLLOW` component loop after `normalize_system_alias_path`; capture/store already own that walk. Comment at `bound.rs:30` even says the `/var` alias must match the capture boundary. | One opener owns the descriptor walk. Promotion keeps its extra string admission (`promotion_absolute_path`: length, NUL, leading `/`) and then **composes**. | After `promotion_absolute_path`, call `open_absolute_directory_nofollow(Path::new(path), field)` (or a one-line wrapper). Delete the copied loop. | Do not invent a `PathWalker` trait. Do not drop the promotion length/NUL check. Do not change fail-closed error strings without updating the tests that match them. Do not reimplement this in TS. |
| F2 | `promotion_remove/cleanup.rs:44` and `:162` | KISS | **P2** | `validate_promotion_cleanup_tree` and `promotion_quarantine_tree_usage` both do the same bounded nofollow tree accounting (entry / byte / work / depth / type / open+identity). Validate adds pause + post-stat recheck. | One private helper in *this* file walks and counts; validate supplies the extra seam. | Extract a same-file helper that returns `(entries, bytes, work)`. Validate wraps it with `promotion_test_pause` + identity recheck. | Do not add a crate-wide directory-walker abstraction. Do not merge validate into usage and lose the ABA recheck. Do not “just split the file” for size. |
| F3 | `copy.rs:79` / `:164–185` vs `promote_fs/io.rs:149–174` | YAGNI | **P2** | Copy charges path work with a local `promotion_copy_path_len` plus a hand-rolled `path_len + name + size_of::<FileIdentity>()` add. `promotion_child_relative` and `promotion_path_work_bytes` already encode that budget. | Copy uses the existing helpers. | Replace the local length/work block with `promotion_path_work_bytes` + `budget.charge_work`. Delete `promotion_copy_path_len` if it has no other caller (it does not). | Do not share a budget *type* with `GitTreeBudget` (different fail-closed strings). Do not change copy’s entry/byte caps. |
| F4 | `util.rs:39–77`, `:509`, `:536` | Clean (one owner) | **P2** | `util.rs` is documented as shared plumbing, but it owns capture hashing: `before_read_hooks`, `after_cache_hooks`, `apply_rewrite_hooks`, `hash_path` (imports `CaptureRoot` / `AnchoredPath` / `StoreObjectTransaction`). | Capture hashing lives under `capture/`. `util.rs` keeps JSON accessors, path safety, and `open_at` / `stat_*`. | Move the four functions into `capture/` (e.g. next to `ops_capture.rs`). Update imports. Leave `s` / `opt_s` / `is_safe_relative` / descriptor helpers. | Do not split `util.rs` into a new subsystem. Do not touch the rewrite-hook JSON contract (`/hooks/beforeRead`, `/hooks/afterCache`). |
| F5 | `main.rs:119–153`; `util.rs:132–134`, `:492–504`; `trees.rs:34–36`; `capture/trees.rs:54–56` | Clean | **P2** | Extraction leftovers. `TREE_MAP_CACHE_SIZE` is documented with an unref-prune sentence; `PROMOTION_CLEANUP_SEQUENCE` carries three unrelated comment fragments (unref throttle, store generation, capture grouping) plus six empty `// ----` section banners. `util.rs` parks a store-lock doc on `require_utf8_git_path` and a journal/cwd essay on `apply_rewrite_hooks`. `trees.rs` docs are `"many seconds."` / `"the reachability walk."`. `TreeEntry` inherited `write_nested_tree`’s sentence. | Comments describe the item they sit on. Empty banners gone. | Delete or rewrite those comments in place. No behavior change. | Do not use this as a reason to split `main.rs` or `util.rs`. Do not add a `constants.rs` just to “clean up.” |
| F6 | `store.rs:144` and `:156` | KISS | **P2** | `store_identity_at` and `store_directory_identity` are the same “symlink_metadata + must be a real directory → `{dev,ino}`” rule with different labels. | One function. | `store_identity_at` → `store_directory_identity(store_dir, "snapshot store")` (or keep the exact current error strings via the label). | Do not merge `StoreIdentity` with `PromotionIdentity` or `FileIdentity`. Those extra fields exist for integrity. |
| F7 | `util.rs:39` and `:60` | KISS | **P2** | `before_read_hooks` and `after_cache_hooks` are the same parser on two JSON pointers. | One helper, two call sites. | `fn rewrite_hooks(req, pointer) -> Vec<(String, String, bool)>`. | Do not invent a hook-framework type. Do not merge the two *seam names*; spikes distinguish them. |
| F8 | `capture/refs.rs:231` | Clean (one owner) | **P2** | `pause_at_hook` is crate-wide (store-create/destroy, merge pin, capture refs) but lives in the capture-ref module. The actual wait is already `test_hooks::pause`. Promotion has a second adapter (`promotion_test_pause` in `promote_fs/io.rs:293`) because the JSON shape is `testHook.stage`, not `/hooks/{name}`. | Capture-ref module owns refs. Test-seam adapters sit with `test_hooks` (or next to each other). | Move `pause_at_hook` into `test_hooks.rs`. Leave `promotion_test_pause` as the other JSON adapter. | Do not unify the two request shapes (public test contract). Do not add a generic hook dispatcher. Do not weaken `TERMINA_CORE_TEST` gating. |
| F9 | `capture/materialize.rs:155`; caller `store_ops.rs:266` | Clean (one owner) | **P2** | `promotion_remove_tree_contents` is the in-place unlink walker. Materialize uses it; **store-destroy also uses it** to empty a quarantined store. Capture is the wrong owner for store-destroy cleanup. | One unlink walker, owned with the other descriptor-bound FS mutators (`promote_fs` or `promotion_remove`), called by materialize and destroy. | Move the existing function. Update the two callers. | Do not merge this with `op_promotion_bound_remove_tree` (that path is quarantine-*move*, not unlink). Do not write a second walker. Do not reimplement destroy cleanup in TS. |
| F10 | `promotion_files/read.rs:103` vs `retained/private_files.rs:106` | YAGNI | **P2** | `op_promotion_bound_read_file` inlines the private-file read (open `O_NOFOLLOW`, uid/links/mode/`maxBytes`, before/after `stat`, path re-stat). `promotion_read_private_bounded_opened` already does that with `promotion_private_identity_valid` (same `0o077` policy). | Read-file composes the retained helper. | Call `promotion_read_private_bounded_opened` (or `_file`) and map the JSON envelope. | Do **not** point `read-journal` at the same helper without checking policy: journal uses `mode & 0o022` (`read.rs:66`), not `0o077`. Do not change the 16 MiB journal budget. |

## Already ticketed (do not re-propose)

| Ticket | Path:line | Principle | Sev | Note |
| --- | --- | --- | --- | --- |
| `#332` | `store_tx.rs` (671 lines) | Clean (size watch) | P3 | Staging state machine. Size flag, not an abstraction smell. Either document keep-reason or split later. |
| `#332` | `capture/materialize.rs:223`, `:345` | Hot-path | P3 | `.relative.clone()` inside removal walks. Bounded paths; profile before changing. |
| `#334` | 53 prod `.expect()` sites | Correctness | — | Disposition each site (propagate or document invariant). Priority: untrusted JSON / dirents. This pass confirms **0 prod `.unwrap()`** (all `.unwrap()` hits are in `#[cfg(test)]` modules: `trust.rs`, `test_hooks.rs`, `util.rs`). Not reopened as a new P1. |

## Checked, no finding

- **No `git` CLI spawn** in `core/src`. `std::process` is only `id()` / `getppid()`. `open_repo` uses libgit2 and mentions the CLI only in a comment (`util.rs:217`).
- **No unused Cargo features or deps.** `git2` `unstable-sha256` is required for `ObjectFormat::Sha256`. `sha1` / `sha2` hash store objects (`util.rs:102`). `base64` serves `read-blob` / promotion reads. `flate2` + `BLOB_COMPRESSION` write loose objects. `serde`/`serde_json`/`libc` are load-bearing. No `[features]` table of unused flags.
- **No needless traits or generics.** The crate has zero `trait` definitions. `require_utf8_git_path<E>` is the only generic and matches `git2`’s `Result<&str, E>`.
- **No dead protocol op.** All `dispatch` arms are used by `electron/worldline-git/`. Nested retained root-transaction is live.
- **One materialize implementation.** `trees.rs` `op_materialize` and `ops_apply` (`apply-state` / `template`) both call `materialize_state_bound`. Pathname-only writers are gone (comment at `trees.rs:156` is accurate, not a leftover path).
- **Copy vs bound-copy is a correct split.** `copy.rs` is the engine; `promotion_files/bound_copy.rs` is the op wrapper. Not a parallel copy.
- **Remove-tree vs materialize-unlink are different responsibilities.** Quarantine *move* (`promotion_remove/remove_tree.rs`) vs in-place unlink (`promotion_remove_tree_contents`). Do not unify.
- **Identity types are not YAGNI.** `FileIdentity` (full stat), `PromotionIdentity` / `StoreIdentity` (`{dev,ino}`), `StoreNodeIdentity` (+ type/nlink), `PromotionJournalFileIdentity` (+ uid/links) exist so equality does not paper over ABA. Do not collapse them.
- **Budget structs are not a family to abstract.** `GitTreeBudget`, `PromotionCopyBudget`, `TrustBudget` share `charge_*` *shape*. Error strings and caps are the fail-closed contract. Incidental.
- **Trust walk vs promotion walk.** Trust hashes agent files by pathname (`symlink_metadata` + `read_dir`). Promotion mutates user trees through descriptors. Unifying those would weaken isolation.
- **Two test-pause JSON adapters** (`pause_at_hook` vs `promotion_test_pause`) are a protocol difference, not a parallel production path. F8 only moves the capture-named one; it does not merge shapes.
- **`test_hooks.rs` is not speculative.** Cross-process crash/ABA spikes need a bounded pause.
- **`StoreTransactionMetrics` / lock-attempt markers** are hook-only durability instrumentation, not unused options.
- **800-line trigger:** no src file ≥ 800. `store_tx.rs` 671 is already `#332`. Other 600+ files (`util`, `store`, `materialize`, `ops_capture`) have specific smells above; size alone is not a split demand.
- **Section comments** in live modules (`repo.rs` “candidate repo queries”, `trees.rs` “diff-tree”) still sit on the code they name. Only the *orphaned* banners in F5 are a finding.

## Appendix — P3 watch (compact)

| ID | Path:line | Principle | Note / smallest later move / do not |
| --- | --- | --- | --- |
| A1 | `trees.rs` vs `capture/trees.rs` | Clean | Two `trees` modules (ops vs nested-tree assembly). Rename the crate-root file to `tree_ops.rs` if a later edit touches it. Do not merge the modules. |
| A2 | `copy.rs:373`, `:396` | Clean | `promotion_leaf_result` / `promotion_expected_directory` are response/request helpers used by `write.rs` and `bound_copy.rs`, not the copy engine. Move next to `promote_fs/expected.rs` on a touch. |
| A3 | `capture/refs.rs:152` (`publish_transaction_ref`, 9 args); `util.rs:536` (`hash_path`, 8 args); `materialize.rs:613` (7 args); `store_tx.rs:573` (`write_blob`, 6 args) | Clean | Over the “4 args” line. Group only if a later change already needs a struct (e.g. hook names on publish). Do not add parameter objects prophylactically. |
| A4 | `store.rs:599` `FileIdentity` | Clean | General stat tuple lives in the store module because destroy/lifecycle started there. Fine until F9/F4 moves force a better home (`util` or a tiny `identity` module). Do not create that module now. |
| A5 | `promotion_files/dirs.rs:53` vs `:96` | KISS | `list-directories` and `list-entries` share the 128-entry / name-byte envelope. A same-file scan helper is enough if either op is edited. Do not genericize `PromotionDirectoryStream`. |
| A6 | `capture/tree_cache.rs:36–41` and `:51–55` | KISS | Evict-one-arbitrary-key is copy-pasted. Three-line private `fn evict_one`. Do not add an LRU crate. |
| A7 | `promotion_files/read.rs:25` (journal) vs `:103` (file) | YAGNI | Similar read loops; journal mode policy is `0o022` not `0o077` (see F10). Watch only. |
| A8 | `util.rs:461` vs `promote_fs/bound.rs:241` | KISS | Relative nofollow walks (`open_relative_directory` vs `open_promotion_parent`). Different inputs (Path vs component list) and stop rules (all components vs all-but-leaf). Incidental. Do not unify. |

## Method notes

1. Inventory via `find core -name '*.rs'` + `wc -l`.
2. Mapped modules to `AGENTS.md` (`core/` is the owner; table above is the internal map).
3. Read hot paths in full: `store_tx.rs`, `capture/materialize.rs`, `copy.rs`, `promotion_files/*`, `promotion_remove/*`, `trust.rs`, `preflight.rs`, plus `store.rs`, `store_ops.rs`, `util.rs`, `main.rs`, `trees.rs`, `promote_fs/*`, `retained/*`, `capture/*`, `repo.rs`.
4. Grepped unused-looking `pub(crate)` items against callers; grepped `Command::new` / `git` spawn; grepped `.unwrap()` / `.expect()`; listed TS `op:` strings.
5. `#332` / `#334` read from GitHub so those items are marked ALREADY-TICKETED.
