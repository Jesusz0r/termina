# Termina Codebase Audit Report

> **Status:** active — resolved findings are historical context; unchecked modularization items remain open.

## 1. Current Status

The original audit identified concrete reliability, lifecycle, concurrency, main-thread latency, and architecture issues. The concrete defects have been resolved. The remaining implementation work is structural modularization of files that still exceed the extraction threshold in `AGENTS.md`.

| Area | Status | Current assessment |
| :--- | :---: | :--- |
| Reliability and process cleanup | Resolved | PTY process groups, termination escalation, signal handling, worker shutdown, and terminal bookkeeping have explicit owners and cleanup paths. |
| Memory and lifecycle bounds | Resolved | Promotion capabilities, timeline snapshot tabs, admission-owner maps, renderer listeners, panes, canvas resources, and explorer directory state are bounded or released. |
| Main-thread latency and concurrency | Resolved | Session durability work and acknowledgement writes are asynchronous; session-worker operations are serialized; directory listing avoids repeated synchronous ancestor traversal. |
| PTY egress | Resolved | Output is lossless, acknowledgement-bound, coalesced to 64 KiB, and paced to at most one IPC message per terminal per 16ms frame. |
| Native core ownership | Resolved | `electron/worldline-git.ts` is the sole public TypeScript interface to `core/`; private process/protocol plumbing lives under `electron/worldline-git/`. |
| Ignore semantics | Resolved by design | Rust/libgit2 owns Git and snapshot ignore behavior. `shared/gitignore.ts` separately owns watcher and agent-context visibility matching. |
| Sidecar compatibility | Resolved | Legacy segment and fallback parsing were removed; only the current sidecar schema remains. |
| Modularization | Open | Several files remain substantially above the 800-line extraction threshold. |

---

## 2. Resolved Findings

### 2.1. Process and terminal lifecycle

- Regular terminal shutdown uses process-group termination rather than killing only the direct shell.
- Shutdown escalates from `SIGTERM` to `SIGKILL` when required.
- Natural PTY exit, user close, and app teardown clean terminal ownership and `busyAgents` state.
- Electron handles `SIGINT` and `SIGTERM` through the canonical shutdown path.
- Dead candidate and worker panes are reconciled from the live instance list and disposed.

### 2.2. Memory and resource bounds

- Rust promotion-root capabilities have a fixed capacity and eviction policy.
- Timeline snapshot tabs have a fixed maximum and dispose evicted Monaco models.
- `CanvasAddon` is explicitly disposed with its terminal view.
- Preload push subscriptions return removal callbacks.
- Worldline admission-owner maps release entries when their final participant leaves.
- Collapsing explorer branches prunes hidden descendant state; project switches clear all directory state.

### 2.3. Concurrency and main-process responsiveness

- Nested workspace write leases track acquisition depth and cannot release an outer lease prematurely.
- Session worker requests execute through one FIFO serialization path.
- Session-retention directory synchronization uses asynchronous file-handle operations.
- Bridge acknowledgement files are written asynchronously and retain directory identity checks.
- CLI installation invokes privileged OS dialogs asynchronously.
- Directory listing no longer performs repeated synchronous ancestor checks for every entry.

### 2.4. PTY delivery

`electron/pty-egress.ts` remains the single PTY-to-renderer delivery owner:

- queued plus in-flight bytes and records remain bounded;
- source pause/resume applies backpressure at the retained high-water mark;
- renderer acknowledgements retire exact terminal-local sequences;
- unacknowledged output and natural-exit markers replay after renderer replacement;
- adjacent source quanta coalesce up to 64 KiB;
- delivery uses a 16ms frame cadence;
- one terminal emits at most one IPC message in a frame.

Benchmark of the scheduler before and after frame pacing:

| Workload | Before | After |
| :--- | :--- | :--- |
| 128 × 64-byte source quanta | 128 IPC messages in 10.74ms | 1 coalesced 8 KiB IPC message in 17.09ms |
| Saturated 2 MiB queue | Not frame-capped | 32 × 64 KiB messages; at most one per 16.7ms bucket; 15.16ms minimum observed spacing |

The benchmark measures scheduler admission and transport calls, not Chromium rendering time. ACK, replay, ordering, hydration, and source-backpressure tests continue to cover delivery correctness.

### 2.5. Architectural ownership

- `electron/worldline-git.ts` exposes typed native Git, trust, snapshot, promotion, and lifecycle operations.
- `electron/worldline-git/core-process.ts` privately owns process lifecycle, bounded request scheduling, stderr handling, and JSON-lines framing.
- Production callers no longer import a second core client.
- `shared/gitignore.ts` is intentionally retained for non-snapshot visibility walks; native Git semantics remain in Rust/libgit2.
- Sidecar parsing accepts only the current schema.

---

## 3. Remaining Work: Modularization

`AGENTS.md` requires extraction when a file exceeds 800 lines, owns distinct lifecycle or test surfaces, or a section gains a second reason to change. The primary remaining audit work is therefore modular decomposition without compatibility aliases or parallel ownership paths.

### 3.1. Priority targets

Counts refreshed 2026-09-07 against the working tree.

| Priority | File | Current lines | Required direction |
| :---: | :--- | ---: | :--- |
| 1 | `electron/main.ts` | 8,126 | Extract coherent terminal/IPC/window lifecycle owners while keeping app state in main and avoiding a second routing path. |
| 2 | `electron/worldlines/` | 3,911 (manager) + 8 lifecycle modules | ✅ Done — monolith split into one owner directory with a public `index.ts`: manager, types, limits, guards, bindings, uncertain-comparison, promotion-journal, promotion-recovery. |
| 3 | `core/src/main.rs` | 11,210 → 290 | Split protocol, Git, snapshot, promotion, and storage internals into Rust modules without moving Git behavior into TypeScript. Done: `trust.rs`, `repo.rs`, `store.rs` (identity/lifecycle/durable files), `store_tx.rs` (lock/journal/recovery), `promote_fs.rs` (bound-fs primitives), `capture.rs` (capture engine + 4 ops), `trees.rs` (merge/materialize/read/prune ops), `retained.rs` (retained roots + root transaction), `copy.rs` (copy engine), `promotion_files.rs` (bound file ops), `promotion_remove.rs` (quarantine/remove/transition), `store_ops.rs` (store create/destroy), `preflight.rs` (capability checks), `util.rs` (shared plumbing). `main.rs` keeps only constants, dispatch, and the protocol loop. Item closed. |

### 3.2. Other files above the extraction threshold

| File | Current lines | Primary concern |
| :--- | ---: | :--- |
| `agent-core/main.ts` | 8,475 | Assessed 2026-09-07: kernel owner (CLI/runtime orchestration, streaming, tools, sidecar, subagents). 260 top-level exports with dense cross-calls; any cut relocates entanglement op-by-op (same finding as the core bound-fs proposal). No honest seam — do not split without a dedicated session. |
| `agent-core/session.ts` | 4,012 | Assessed 2026-09-07: single session-serialization owner (bundle ops, replay, recovery, pi-copy, fork share types and lifecycle). No honest seam — do not split. |
| `agent-core/auth.ts` | 2,969 | Assessed 2026-09-07: canonical auth/policy owner (per AGENTS.md). Per-provider policy, family rules, and capability composition already extracted. Credential persistence + login/refresh orchestration is the remaining core — do not split. |
| `agent-core/trace.ts` | 2,775 | Assessed 2026-09-07: `TraceRuntime` + pure record constructors share span types and lifecycle; record fns have 3 test importers, making extraction churn without a distinct owner. Do not split. |
| `src/main.ts` | 2,968 | Assessed 2026-09-07: renderer composition owner (AGENTS.md: `src/` owns rendering/transient UI state). Project views, panes, and sync share view lifecycle — splitting would create a second rendering owner. Do not split. |
| `electron/sidecar.ts` | 2,673 | Assessed 2026-09-07: canonical sidecar parse/tail owner (AGENTS.md). Queue, parser, and tailer share the event schema — do not split. |
| `agent-core/tui.ts` | 2,456 → 2,047 | ✅ Done 2026-09-07 — pure completion/text helpers extracted to `agent-core/tui-text.ts` (426 lines, no terminal IO); `tui.ts` keeps rendering and `AgentTui`. No exported symbols lost; typecheck + tui perf test green. |
| `agent-core/openai-compat.ts` | 1,824 | Assessed 2026-09-07: canonical protocol-serialization owner (AGENTS.md). 7 importers + dense shared helpers; splitting by protocol family would read as a second protocol mapper. Do not split. |
| `electron/session-retention.ts` | 1,622 | Assessed 2026-09-07: single retention-accounting owner (ledger validation, accounting, claims share schema). Do not split. |
| `electron/worldline-git.ts` | 1,370 | Assessed 2026-09-07: only public TS client for `core/` (AGENTS.md) — thin typed wrappers, one per op. Splitting violates the single-client rule. Do not split. |
| `agent-core/host.ts` | 1,287 | Assessed 2026-09-07: sidecar-exchange owner (AGENTS.md writer); image queue is part of that exchange lifecycle. Do not split. |
| `agent-core/mcp.ts` | 1,256 | Assessed 2026-09-07: single MCP lifecycle owner (config, transport, output share types and one request flow). Do not split. |
| `electron/evidence.ts` | 974 | Evidence measurement remains canonical but exceeds the extraction threshold. |
| `src/editor.ts` | 893 | Monaco model, tab, and editor interaction responsibilities remain concentrated. |
| `electron/watcher.ts` | 874 | Watch lifecycle and visibility reconciliation remain concentrated. |
| `electron/pty-egress.ts` | 852 | The canonical PTY delivery owner is bounded and cohesive but remains just above the extraction threshold. |

Line counts are a prioritization signal, not permission to create parallel public interfaces. Each extraction must move one existing responsibility to one canonical owner, migrate callers directly, and delete obsolete paths.

---

## 4. Implementation Roadmap

### Phase 1: Reliability, lifecycle, and concurrency — Completed

- [x] PTY process-group termination and escalation
- [x] Electron signal handling and shutdown cleanup
- [x] Write-lease re-entrancy protection
- [x] FIFO session-worker serialization
- [x] Async privileged OS dialog execution
- [x] Preload listener disposables
- [x] Terminal canvas and pane disposal
- [x] Bounded Rust promotion capabilities
- [x] Bounded Monaco snapshot tabs
- [x] Admission-owner and explorer-state cleanup

### Phase 2: Main-thread latency, PTY delivery, and compatibility cleanup — Completed

- [x] Async session durability operations and bridge acknowledgements
- [x] Directory-listing symlink traversal optimization
- [x] Bounded ACK-backed PTY egress
- [x] 16ms PTY frame pacing and 64 KiB coalescing
- [x] Current-only sidecar parsing

### Phase 3: Canonical ownership and modularization — In progress

- [x] Keep `electron/worldline-git.ts` as the sole public TypeScript core interface
- [x] Keep watcher/context visibility separate from native Git ignore semantics
- [x] Decompose `electron/worldlines.ts` → `electron/worldlines/` owner directory
- [x] Modularize `core/src/main.rs` → 14 modules, `main.rs` keeps constants/dispatch/loop
- [ ] Decompose `electron/main.ts` (assessed: no honest seam — thin IPC adapters over owned app state)
- [ ] Continue with the secondary oversized files after the three priority owners

---

## 5. Validation Record

For the PTY frame-pacing change:

- `tsc --noEmit` passed.
- PTY egress and IPC project-flow unit tests passed.
- `git diff --check` passed.
- Electron main and preload builds completed successfully.
- A subsequent full Vite renderer production build completed successfully (1,277 modules transformed in 57.46s); only the existing large-chunk advisory was reported.

The audit is now a current-state document: resolved defects are recorded as completed work, and unchecked items represent remaining implementation work rather than stale historical findings.
