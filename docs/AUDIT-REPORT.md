# Termina Codebase Audit Report

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

| Priority | File | Current lines | Required direction |
| :---: | :--- | ---: | :--- |
| 1 | `electron/main.ts` | 7,983 | Extract coherent terminal/IPC/window lifecycle owners while keeping app state in main and avoiding a second routing path. |
| 2 | `electron/worldlines.ts` | 6,628 | Move coherent comparison, promotion, evidence/run, and lifecycle units under one `electron/worldlines/` owner with one public API. |
| 3 | `core/src/main.rs` | 11,164 | Split protocol, Git, snapshot, promotion, and storage internals into Rust modules without moving Git behavior into TypeScript. |

### 3.2. Other files above the extraction threshold

| File | Current lines | Primary concern |
| :--- | ---: | :--- |
| `agent-core/main.ts` | 8,576 | CLI/runtime orchestration, provider streaming, tool execution, sidecar logging, and subagents remain concentrated. |
| `agent-core/session.ts` | 3,977 | Session serialization, compaction, timeline, and branch state remain concentrated. |
| `agent-core/auth.ts` | 3,112 | Multi-provider authentication and token lifecycle remain concentrated. |
| `agent-core/trace.ts` | 2,775 | Trace graph, span lifecycle, formatting, and reduction remain concentrated. |
| `src/main.ts` | 2,651 | Renderer composition, panes, shortcuts, project tabs, and synchronization remain concentrated. |
| `electron/sidecar.ts` | 2,647 | Current-schema parsing, tailing, validation, and lifecycle remain concentrated despite compatibility removal. |
| `agent-core/tui.ts` | 2,472 | ANSI rendering and interactive terminal UI behavior remain concentrated. |

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
- [ ] Decompose `electron/main.ts`
- [ ] Decompose `electron/worldlines.ts`
- [ ] Modularize `core/src/main.rs`
- [ ] Continue with the secondary oversized files after the three priority owners

---

## 5. Validation Record

For the PTY frame-pacing change:

- `tsc --noEmit` passed.
- PTY egress and IPC project-flow unit tests passed.
- `git diff --check` passed.
- Electron main and preload builds completed successfully.
- The subsequent Vite renderer build attempt was terminated by `SIGKILL` during transformation; no renderer source changed in that patch, but a complete renderer build should be rerun with adequate resources before release.

The audit is now a current-state document: resolved defects are recorded as completed work, and unchecked items represent remaining implementation work rather than stale historical findings.
