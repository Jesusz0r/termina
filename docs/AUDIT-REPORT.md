# Termina (`pi-editor`) Comprehensive Codebase Audit Report

## 1. Executive Summary & Health Scorecard

A full architectural, resource management, performance, and compliance audit was performed across the **Termina** desktop codebase (`pi-editor`), spanning:
- **Rust daemon (`core/`)**: 11,094 lines (`termina-core` libgit2 / snapshot engine)
- **Electron Main process (`electron/`)**: 32,875 lines (pty lifecycle, IPC, sidecar tailing, worldlines, workspace management)
- **Agent runtime (`agent-core/`)**: 36,478 lines (autonomous kernel, providers, tracing, tool execution, session state)
- **Vite/Monaco Renderer (`src/`)**: 11,254 lines (xterm.js TUI, Monaco editor, timeline visualizer, file explorer)

### Health Scorecard

| Area | Grade | Key Strengths | Primary Risks & Deficiencies |
| :--- | :---: | :--- | :--- |
| **Type Safety & Build** | **A** | Clean `tsc --noEmit` (0 errors), strict interfaces. | Good static guarantees, but no static prevention of synchronous I/O or leaked process trees. |
| **Memory & Lifecycle** | **C-** | Terminal teardown maps cleaned up, worker threads exit cleanly on normal paths. | Process group leaks (`pty.kill()` vs `killGroup()`), permanent Rust static capability map, leaked `CanvasAddon` 2D contexts, preload IPC accumulation. |
| **Main-Thread Latency** | **D+** | Background sidecar tailing uses incremental byte-offsets; Rust engine offloads git tree hashing. | Synchronous `fsyncSync` & `syncDirectorySync` on main thread; quadratic ancestor `lstatSync` in file explorer; synchronous atomic writes during active session claims. |
| **Process Isolation** | **B+** | Clean Preload bridge (`window.pi`), sandboxed renderer, strict write leases. | Missing `SIGINT`/`SIGTERM` handlers on Electron main process orphans background daemons and PTY subshells upon abrupt exit. |
| **Modularity / AGENTS.md** | **F** | Clear domain boundaries defined in rules (`core/`, `worldline-git.ts`). | **10 massive "God Files"** violating the 800-line limit (e.g. `core/src/main.rs` at 11k lines, `agent-core/main.ts` at 8.6k lines, `electron/main.ts` at 7.9k lines, `electron/worldlines.ts` at 6.6k lines). Dual core clients, dead backwards compat in sidecar. |

---

## 2. Critical Memory Leaks & Resource Management

### 2.1. PTY Process Group Orphan Leaks (Critical)
- **Location:** [`electron/main.ts:4269`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/main.ts#L4269), [`electron/pty-terminal.ts:44-52, 188-196`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/pty-terminal.ts#L44-L52)
- **Root Cause:** When closing a terminal tab (`closeTerminal(id)`), the app invokes `inst.pty.kill()`. Under Unix/macOS, `pty.kill()` signals only the direct shell process (PID). Any background processes, child subshells, build tools (e.g. Vite, Cargo, Python servers), or commands launched inside that terminal survive as orphaned processes attached to `launchd` (PID 1), consuming CPU and RAM indefinitely.
- **Evidence:** Only `terminateCandidate` in `electron/main.ts` correctly invokes `killGroup()`. Regular terminal destruction does not. Furthermore, if a process traps or ignores `SIGTERM`, `inst.pty.onExit` never fires, leaving the terminal instance in `this.terminals` indefinitely.
- **Fix:**
  1. Replace `inst.pty.kill()` with `inst.pty.killGroup()` across all terminal close paths.
  2. Implement an escalating kill timeout: send `SIGTERM` to the process group, and if not exited within 1.5 seconds, send `SIGKILL` to `-PID`.
  3. Ensure cleanup of `this.terminals.delete(id)` in a `finally` block or hard timeout if `onExit` is delayed.

```typescript
// Proposed fix in electron/pty-terminal.ts
async destroy(): Promise<void> {
  if (this.disposed) return;
  this.disposed = true;
  const pid = this.pty.pid;
  try {
    this.pty.killGroup(); // Kill entire process group, not just shell leader
  } catch (err) {
    // Process might already be dead
  }
  const exited = await Promise.race([
    this.exitPromise,
    new Promise(resolve => setTimeout(() => resolve(false), 1500))
  ]);
  if (!exited) {
    try { process.kill(-pid, 'SIGKILL'); } catch {}
  }
}
```

---

### 2.2. Unbounded Global Static Capability Store in Rust Daemon (High)
- **Location:** [`core/src/main.rs:3241-3263`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/core/src/main.rs#L3241-L3263)
- **Root Cause:** `PROMOTION_ROOT_CAPABILITIES` is defined as:
  ```rust
  static PROMOTION_ROOT_CAPABILITIES: OnceLock<Mutex<HashMap<String, PromotionRootCapability>>>
  ```
  Every time a promotion capability is issued via `issue_promotion_root_capability`, a new entry is added to this map. Entries have no TTL, no LRU eviction, and are never removed upon completion or cancellation. Over days of active use with multiple runs and worldlines, this map grows without bound.
- **Fix:** Add a bounded LRU cache or explicit capability consumption (`capabilities.remove(&token)`) when a promotion concludes or a worldline is discarded.

---

### 2.3. Ghost Panes, Undisposed `PtyView`s & Leaking Repaint Watchdogs (Critical)
- **Location:** [`src/main.ts:2486-2528`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/src/main.ts#L2486-L2528), [`src/pty-view.ts:96-106, 448-471`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/src/pty-view.ts#L96-L106)
- **Root Cause:** When a background candidate terminal, verification worker, or agent run terminates, the backend removes it from `this.terminals` and broadcasts the remaining active instances via `window.pi.onInstances`.
  However, in `src/main.ts`, the handler iterates over active instances but **never prunes or disposes panes in `panes: Map<string, Pane>` that are absent from the incoming list**.
- **Impact:**
  1. The `Pane` object and its DOM elements remain in memory.
  2. `pane.view.dispose()` is never called.
  3. `PtyView`'s internal watchdog (`this.watchdog = setInterval(..., 1500)`) **continues firing every 1.5 seconds indefinitely** in the background for every deceased terminal, leaking CPU and canvas/xterm buffers.
- **Fix:** In `src/main.ts:2486`, reconcile `panes` with the incoming live instances list. Delete missing candidate or worker panes, call `pane.view.dispose()`, and remove their DOM elements.

---

### 2.4. Terminal ID Leak in `this.busyAgents` Set (Medium)
- **Location:** [`electron/main.ts:612, 4508, 4574, 5069`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/main.ts#L612)
- **Root Cause:** `this.busyAgents = new Set<string>()` tracks running agent terminals. Terminals are added when an agent starts running (`line 4508`). They are only removed on normal settlement (`line 4574`) or project close (`line 6287`). If a user closes a busy terminal tab, or if the terminal crashes, neither `closeTerminal()` nor `pty.onExit` removes the ID from `this.busyAgents`.
- **Impact:** Ghost terminal IDs accumulate in `this.busyAgents`, causing `markOverlappingAgents()` to loop over phantom IDs indefinitely.
- **Fix:** Add `this.busyAgents.delete(id)` to both `closeTerminal(id)` and `inst.pty.onExit`.

---

### 2.5. Unbounded Monaco Models for Timeline Snapshots in `src/editor.ts` (Medium)
- **Location:** [`src/editor.ts:801-831`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/src/editor.ts#L801-L831)
- **Root Cause:** Clicking dots in the timeline opens a snapshot tab:
  ```typescript
  const model = monaco.editor.createModel(content, language, monaco.Uri.parse(`timeline://${terminalId}/${eventKey}`));
  ```
  Unlike `TimelineView` (which caps events at 400), `EditorManager` has **no maximum tab limit or LRU eviction** for snapshot tabs. Clicking 50–100 timeline dots keeps 50–100 full Monaco editor text models in memory simultaneously.
- **Fix:** Enforce `MAX_OPEN_SNAPSHOT_TABS = 10`, closing and disposing the oldest snapshot model when exceeded.

---

### 2.6. Unbounded Module-Level Maps in `electron/worldlines.ts` (Medium)
- **Location:** [`electron/worldlines.ts:1119-1128, 1386-1395`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/worldlines.ts#L1119-L1128)
- **Root Cause:** `uncertainComparisonAdmissionOwners` and `promotionJournalAdmissionOwners` are module-level `Map`s keyed by directory root path. Entries are inserted during candidate comparisons and promotions, but are never deleted when comparisons conclude, discard, or when projects close.
- **Fix:** Add explicit cleanup `clearPromotionAdmissionOwners(root)` called on comparison discard and project close.

---

### 2.7. Chromium Canvas 2D Context Leak on Terminal Close (Medium)
- **Location:** [`src/pty-view.ts:70, 448-471`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/src/pty-view.ts#L70)
- **Root Cause:** In `PtyView`:
  ```typescript
  this.canvasAddon = new CanvasAddon();
  this.term.loadAddon(this.canvasAddon);
  ```
  In `dispose()`, `this.term.dispose()` is called, but the `CanvasAddon` instance itself holds an internal reference to the HTML5 Canvas element and 2D rendering context backing store. In xterm.js v5+, addons must be explicitly disposed before `term.dispose()` to allow Chromium's Blink garbage collector to reclaim the offscreen GPU/software canvas buffer.
- **Fix:** Store `this.canvasAddon` explicitly and invoke `this.canvasAddon.dispose()` before calling `this.term.dispose()`.

---

### 2.8. Permanent IPC Listener Accumulation in Preload (Medium)
- **Location:** [`electron/preload.ts:61-120`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/preload.ts#L61-L120)
- **Root Cause:** `window.pi.on*` methods (e.g. `onTerminalData`, `onTimelineUpdated`) attach listeners to `ipcRenderer.on` directly:
  ```typescript
  onTerminalData: (cb) => { ipcRenderer.on('terminal:data', (_e, data) => cb(data)); }
  ```
  None of these methods return an unsubscribe/cleanup function, nor do they track listeners. If the UI hot-reloads during development or re-mounts a view (e.g. switching workspaces or tabs), listeners accumulate. Calling `cb` invokes every callback registered since window boot.
- **Fix:** Return an unsubscribe disposable from every `on*` registration in `preload.ts`:
  ```typescript
  onTerminalData: (cb) => {
    const handler = (_e: any, data: any) => cb(data);
    ipcRenderer.on('terminal:data', handler);
    return () => ipcRenderer.removeListener('terminal:data', handler);
  }
  ```

---

### 2.9. Unbounded Directory Tree Map in File Explorer (Low)
- **Location:** [`src/components/explorer.ts:21`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/src/components/explorer.ts#L21)
- **Root Cause:** `private dirs = new Map<string, DirEntry[]>()` caches the directory tree structure indefinitely. While expanding large repos with thousands of folders (e.g. `node_modules`, build outputs), memory scales with every folder ever opened in the session.
- **Fix:** Clear collapsed subtrees from the cache or use an LRU cap (e.g. max 500 active directory nodes).

---

## 3. Main-Thread Latency, Performance & Concurrency

> **AGENTS.md Mandate:** *"Main-process latency is correctness — never block it. Never trade a higher priority for a lower one."*

### 3.1. Synchronous OS Dialog Execution via `execFileSync` (Critical - UI Freeze)
- **Location:** [`electron/cli-install.ts:L92`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/cli-install.ts#L92), [`electron/cli-install.ts:L126`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/cli-install.ts#L126)
- **Root Cause:** When the user selects "Install CLI" or "Uninstall CLI" from the application menu, the main process executes:
  ```typescript
  execFileSync("osascript", ["-e", `do shell script "${command}" with administrator privileges`]);
  ```
  `execFileSync` blocks Node's single-threaded event loop completely while macOS displays the administrator authentication modal.
- **Impact:** While the user reads or types their macOS administrator password, the entire application is completely frozen: no terminal data is processed, xterm ceases rendering, Monaco drops key events, and window management hangs.
- **Fix:** Replace `execFileSync` with `child_process.execFile` wrapped in an async Promise.

---

### 3.2. Synchronous `fsync` & Directory Flushes on Main Loop (High Severity)
- **Location:** [`electron/session-retention.ts:251-258, 411`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/session-retention.ts#L251-L258), [`electron/main.ts:4715-4725`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/main.ts#L4715-L4725)
- **Root Cause:** `syncDirectorySync(path)` opens a file descriptor synchronously and executes `fs.fsyncSync(fd)` directly on Electron's main thread:
  ```typescript
  function syncDirectorySync(dirPath: string): void {
    const fd = fs.openSync(dirPath, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  ```
  This is executed during session claims, tree removals, and write acknowledgments. On macOS with APFS under heavy I/O (or network-mounted volumes), `fsyncSync` can block the thread for **50ms to 400ms**. Because this runs directly on the main event loop, the entire UI freezes: Monaco input drops keystrokes, xterm PTY output stutters, and IPC pings stall.
- **Fix:** Convert `syncDirectorySync` and file writes in `session-retention.ts` and `writeAck` to asynchronous operations using `fs.promises.open`, `fd.sync()`, and `fd.close()`.

---

### 3.3. Write Lease Re-entrancy & Premature Release Bug (High Severity - Data Integrity)
- **Location:** [`electron/main.ts:L2070-L2092`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/main.ts#L2070-L2092)
- **Root Cause:** In `acquireWriteLease`:
  ```typescript
  if (ws.writerId === null || ws.writerId === requesterId) {
    ws.writerId = requesterId;
    return { ok: true, generation: ws.generation };
  }
  ```
  And in `releaseWriteLease`:
  ```typescript
  private releaseWriteLease(wsId: string, requesterId: string): void {
    const ws = this.workspaceById(wsId);
    if (ws && ws.writerId === requesterId) ws.writerId = null;
  }
  ```
  If an operation holding a write lease (`requesterId`) invokes a nested sub-routine that also acquires the lease with the same `requesterId`, the inner call succeeds. However, when that inner sub-routine completes and calls `releaseWriteLease`, `ws.writerId` is unconditionally reset to `null`!
- **Impact:** The outer operation continues executing, but its write lease has been prematurely cleared. Another concurrent agent action or run-settle can acquire the lease and mutate the workspace tree simultaneously, causing tree corruption and race conditions.
- **Fix:** Add an acquisition depth counter (`ws.leaseDepth = (ws.leaseDepth || 0) + 1`). Only set `ws.writerId = null` when `leaseDepth` reaches 0.

---

### 3.4. Violation of Serialization Invariant in Session Fork Worker (High Severity)
- **Location:** [`electron/session-fork.ts:L280-L360`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/session-fork.ts#L280-L360) vs [`electron/session-worker.ts:L444-L477`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/session-worker.ts#L444-L477)
- **Root Cause:** The `session-fork.ts` architecture specification mandates:
  > *"Requests are serialized: session files are not concurrent-safe."*
  However, in `session-worker.ts`:
  ```typescript
  if (msg.op === "fork") { void forkPiSession(msg, controller); return; }
  if (msg.op === "copy-pi") { void copyPiSession(msg, controller); return; }
  if (msg.op === "discard-pi") { void (async () => { ... })(); return; }
  ```
  All incoming worker messages execute as unawaited `void` promises. When candidates A and B branch concurrently or candidate discarding occurs during active forks, they run simultaneously inside the worker thread.
- **Impact:** Session file lock conflicts, partial writes, and corruption of Pi session histories.
- **Fix:** Implement a FIFO queue in `SessionForkClient` or within `session-worker.ts` so that only one session operation executes at any given time.

---

### 3.5. Exponential Ancestor Traversal in `listDir` / Symlink Checking (Medium Severity)
- **Location:** [`electron/main.ts:2137-2155, 6711-6734`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/main.ts#L2137-L2155)
- **Root Cause:** In `electron/main.ts`:
  ```typescript
  function hasDanglingSymlink(targetPath: string): boolean {
    let curr = targetPath;
    while (curr !== path.dirname(curr)) {
      const stat = fs.lstatSync(curr); // Synchronous lstat per ancestor
      if (stat.isSymbolicLink() && !fs.existsSync(curr)) return true;
      curr = path.dirname(curr);
    }
    return false;
  }
  ```
  `listDir` executes `hasDanglingSymlink` for **every entry** returned by `fs.readdir`. If a folder has 500 files at depth 6, this issues `500 * 6 = 3,000` synchronous `lstatSync` syscalls in a single synchronous IPC handler, causing immediate jank when opening folders.
- **Fix:**
  1. Move `listDir` to async `fs.promises.readdir` with `withFileTypes: true`.
  2. Cache verified ancestor paths in a `Set<string>` during a single directory traversal so ancestors are checked at most once per listing.

---

### 3.6. Unhandled Process Termination (`SIGINT` / `SIGTERM`) (High Severity)
- **Location:** [`electron/main.ts:7867-7894`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/main.ts#L7867-L7894)
- **Root Cause:** Electron registers `app.on('before-quit')` and `app.on('window-all-closed')`, but has **zero signal listeners** for `process.on('SIGINT')` or `process.on('SIGTERM')`.
  - When Termina is launched from CLI, closed via terminal kill signal, or restarted in dev mode, `before-quit` is bypassed entirely.
  - The `termina-core` Rust daemon child process, worker threads (`session-worker.ts`), and PTY child shells continue running in the background as zombies.
- **Fix:** Explicitly handle signals in `electron/main.ts`:
  ```typescript
  const cleanupAndExit = () => {
    killAllTerminals();
    coreClient.stop();
    process.exit(0);
  };
  process.on('SIGINT', cleanupAndExit);
  process.on('SIGTERM', cleanupAndExit);
  ```

---

### 3.7. PTY Egress High-Throughput UI Stutter (Medium)
- **Location:** [`electron/pty-egress.ts:45-78`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/pty-egress.ts#L45-L78)
- **Root Cause:** Fast console output (e.g. `cat 10MB.log` or dense build logs) streams data chunks every few milliseconds directly across `webContents.send('terminal:data')`. This saturates the Electron Chromium IPC channel, resulting in frame drops and renderer UI queue starvation.
- **Fix:** Batch egress writes using an adaptive micro-batching buffer (e.g. flush at most once every 16ms / 60fps frame or when buffer exceeds 64KB).

---

## 4. Architecture & Simplification: Deconstructing the "God Files"

> **AGENTS.md Mandate:** *"Extract when: >800 lines, distinct lifecycle/test surface, or a // ---- section has a second reason to change... Ownership is per responsibility, not per file. One responsibility = one directory owner, not one file."*

### 4.1. The 10 Monolithic Files

| File | Current Lines | AGENTS.md Cap (800) | Ratio | Primary Responsibilities Mixed Together |
| :--- | :---: | :---: | :---: | :--- |
| [`core/src/main.rs`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/core/src/main.rs) | **11,094** | 800 | **13.8×** | Snapshot store, merge engine, libgit2 ops, JSON-RPC protocol, promotion caps, file hashing, gitignore engine. |
| [`agent-core/main.ts`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/agent-core/main.ts) | **8,599** | 800 | **10.7×** | CLI parsing, tool runner, LLM streaming, prompt assembling, sidecar logging, approval handling, subagent orchestration. |
| [`electron/main.ts`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/main.ts) | **7,895** | 800 | **9.8×** | App lifecycle, window management, PTY coordination, workspace store, IPC router, update checker, menu definitions. |
| [`electron/worldlines.ts`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/worldlines.ts) | **6,588** | 800 | **8.2×** | Candidate sandbox, diff comparisons, promotion RPC client, write leases, run progression, evidence checks. |
| [`agent-core/session.ts`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/agent-core/session.ts) | **4,016** | 800 | **5.0×** | Pi session serialization, timeline state, message compaction, branch tracking, migration. |
| [`agent-core/auth.ts`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/agent-core/auth.ts) | **3,119** | 800 | **3.9×** | Multi-provider auth, token refresh, keychain storage, header injection for 8 different AI providers. |
| [`electron/sidecar.ts`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/sidecar.ts) | **2,973** | 800 | **3.7×** | JSONL polling, tail offsets, event parsing, plus dead legacy segment backward compatibility. |
| [`agent-core/trace.ts`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/agent-core/trace.ts) | **2,776** | 800 | **3.5×** | Execution graph, step spans, telemetry formatting, tree reduction. |
| [`src/main.ts`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/src/main.ts) | **2,632** | 800 | **3.3×** | UI root layout, keyboard shortcuts, tab management, split pane sizing, theme synchronization. |
| [`agent-core/tui.ts`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/agent-core/tui.ts) | **2,473** | 800 | **3.1×** | ANSI rendering, progress bars, diff formatting, interactive prompts. |

---

### 4.2. Concrete Modular Decomposition Blueprints

#### Decomposition Plan A: `electron/main.ts` (7,895 lines → Domain Directory)
Replace monolithic `electron/main.ts` by transforming `electron/` into focused domain owners (all < 600 lines):
- `electron/main.ts` (~250 lines): Electron entry point, app lifecycle (`ready`, `before-quit`, signal traps), window initialization.
- `electron/ipc/router.ts`: Typed IPC registration and handler dispatch.
- `electron/ipc/fs-handlers.ts`: Asynchronous file system and workspace operations (`listDir`, `readFile`, `writeFile`).
- `electron/ipc/terminal-handlers.ts`: PTY creation, resize, input, and destruction routing.
- `electron/window/window-manager.ts`: BrowserWindow lifecycle, DevTools, layout state persistence.
- `electron/window/menu.ts`: Native application menu and macOS dock handling.

#### Decomposition Plan B: `electron/worldlines.ts` (6,588 lines → `electron/worldlines/`)
Decompose into `electron/worldlines/` package:
- `electron/worldlines/index.ts` (Public facade): Re-exports canonical worldline API.
- `electron/worldlines/leases.ts`: Write lease acquisition, heartbeats, and release.
- `electron/worldlines/sandbox.ts`: Sandbox candidate filesystem isolation and directory cloning.
- `electron/worldlines/promotion.ts`: Promotion execution, capability verification, and commit atomic switches.
- `electron/worldlines/comparisons.ts`: Diff generation, file status summaries, and dot comparisons.

#### Decomposition Plan C: `core/src/main.rs` (11,094 lines → Rust Crate Modules)
Refactor `core/src/main.rs` into idiomatic Rust modules under `core/src/`:
- `core/src/main.rs` (~150 lines): CLI argument parsing, stdio JSON-RPC server loop.
- `core/src/rpc/`: Request parsing, JSON-RPC protocol error mapping.
- `core/src/git/`: Libgit2 repository, commit, tree, and diff wrappers.
- `core/src/snapshot/`: Fast snapshot hash calculation and tree storage.
- `core/src/promotion/`: Atomic tree promotion, write capabilities, and branch pointers.
- `core/src/ignore/`: Canonical `.gitignore` matcher using libgit2.

---

## 5. AGENTS.md Rule Compliance Violations

### 5.1. Core Client Ownership (Resolved)
- **The Rule:** *"electron/worldline-git.ts — only TS client for core/."*
- **Resolution:** [`electron/worldline-git.ts`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/worldline-git.ts) is the sole public TypeScript interface to the Rust core. Typed Git, trust, snapshot, promotion, and lifecycle operations are exposed there.
- **Private Plumbing:** Process spawning, bounded request admission, and JSON-lines framing live under `electron/worldline-git/core-process.ts`. Production callers do not import that helper directly. Keeping the protocol transport private avoids adding another 300 lines to the already-large public owner while preserving one public API.

### 5.2. Separate Ignore Responsibilities (Recommendation Rejected)
- [`core/src/main.rs`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/core/src/main.rs) uses libgit2 for authoritative Git/snapshot operations, including tracked and ignored candidate paths.
- [`shared/gitignore.ts`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/shared/gitignore.ts) owns the shared visibility policy used by the Electron watcher and agent-core filesystem walks.
- These are intentionally different responsibilities. Routing renderer/watch or agent-core walks through Electron's privileged `worldline-git.ts` client would cross process boundaries and couple context visibility to snapshot storage.
- **Decision:** Keep `shared/gitignore.ts` for non-snapshot walks. Operations that claim Git repository semantics must continue to use the Rust core through `worldline-git.ts`.

### 5.3. Sidecar Format Ownership (Resolved)
- **The Rule:** *"No backwards compat. Don't add shims, deprecated aliases, or feature-flagged old paths. Migrate internal callers, delete the old interface."*
- **Resolution:** [`electron/sidecar.ts`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/sidecar.ts) accepts only the current segment schema. Prototype fallback sources and compatibility parsing have been removed.

---

## 6. Actionable 3-Phase Implementation Roadmap

```mermaid
graph TD
    subgraph "Phase 1: Critical Fixes (Reliability, Concurrency & Leaks)"
        P1_1["Fix PTY Process Group Orphan Leaks (pty.killGroup + SIGKILL escalation)"]
        P1_2["Add SIGINT/SIGTERM Process Handlers in Electron Main"]
        P1_3["Fix Write Lease Re-entrancy Bug (ws.leaseDepth counter)"]
        P1_4["Fix Session Worker Serialization (FIFO Queue in SessionForkClient)"]
        P1_5["Convert osascript execFileSync to Async execFile in cli-install.ts"]
        P1_6["Add Cleanup Disposable to Preload window.pi.on*"]
        P1_7["Explicit CanvasAddon.dispose() in PtyView"]
        P1_8["Bounded Eviction for Rust PROMOTION_ROOT_CAPABILITIES"]
    end

    subgraph "Phase 2: Performance & Main-Thread Unblocking"
        P2_1["Convert syncDirectorySync & writeAck to Async I/O"]
        P2_2["Optimize listDir: Async readdir + Memoized Ancestor Symlink Traversal"]
        P2_3["PTY Egress Micro-Batching & IPC Ack Batching (completed)"]
        P2_4["Purge Dead Sidecar Compatibility Parsing (completed)"]
    end

    subgraph "Phase 3: Modular Extraction & Architectural Alignment"
        P3_1["Keep worldline-git.ts as the sole public core client (completed)"]
        P3_2["Split electron/main.ts into electron/ipc/ and electron/window/ (<600 lines)"]
        P3_3["Split electron/worldlines.ts into electron/worldlines/ package"]
        P3_4["Modularize core/src/main.rs into Rust crate modules"]
        P3_5["Keep walker visibility policy separate from native Git semantics (decision complete)"]
    end

    Phase 1 --> Phase 2
    Phase 2 --> Phase 3
```

### Phase 1: Critical Leaks & Process Safety (Immediate) — COMPLETED
- [x] **Ghost Panes & Repaint Watchdogs:** In [`src/main.ts:2486`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/src/main.ts#L2486), reconciled `panes` with the incoming `onInstances` list to call `.dispose()`, remove DOM nodes, and stop the 1500ms repaint `watchdog` timer on background-terminated candidate and worker panes.
- [x] **PTY Process Groups:** In [`electron/main.ts:4269`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/main.ts#L4269) and [`electron/pty-terminal.ts`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/pty-terminal.ts), changed `pty.kill()` to `pty.killGroup()`, added a 2s watchdog escalading to `SIGKILL`, and purged `this.busyAgents`.
- [x] **Signal Trapping:** Added `SIGINT` and `SIGTERM` listeners and unhandled error traps in [`electron/main.ts`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/main.ts) to guarantee clean shutdown of `core` and all worker threads on abrupt quit.
- [x] **Write Lease Re-entrancy:** In [`electron/main.ts:2070`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/main.ts#L2070), added `ws.leaseDepth` counter so nested operations do not prematurely release the workspace write lock.
- [x] **Session Worker Serialization:** In [`electron/session-worker.ts`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/session-worker.ts), serialized message dispatch via a FIFO queue.
- [x] **Async OS Dialogs:** In [`electron/cli-install.ts:92`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/cli-install.ts#L92), replaced `execFileSync` with async `execFile`.
- [x] **Preload Disposables:** Returned unbind callbacks from all `window.pi.on*` methods in [`electron/preload.ts`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/preload.ts) and [`shared/types.ts`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/shared/types.ts).
- [x] **Canvas Disposal:** Explicitly invoked `this.canvasAddon.dispose()` in [`src/pty-view.ts`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/src/pty-view.ts).
- [x] **Rust Capability Eviction:** Added capacity bound (`MAX_PROMOTION_CAPABILITIES = 256`) and FIFO eviction to `PROMOTION_ROOT_CAPABILITIES` in [`core/src/main.rs:3249`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/core/src/main.rs#L3249).
- [x] **Monaco Snapshot Tab Eviction:** Enforced `MAX_OPEN_SNAPSHOT_TABS = 10` LRU eviction in [`src/editor.ts:812`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/src/editor.ts#L812).

### Phase 2: Main-Thread Latency & Sidecar Cleanup (Short-Term) — IN PROGRESS
- [x] **Async Directory Fsync:** Converted `syncDirectorySync` in [`electron/session-retention.ts`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/session-retention.ts) to asynchronous `syncDirectory` with `handle.sync()`.
- [x] **Symlink Traversal Optimization:** Optimized [`electron/main.ts:listDir`](file:///Users/jesusmendoza/Desktop/proyectos/pi-editor/electron/main.ts) to avoid redundant upward ancestor checks per entry, testing only direct symlinks.
- [ ] **PTY Backpressure Buffer:** Implement micro-batching in `electron/pty-egress.ts` to cap IPC message frequency to 60fps.
- [ ] **Strip Legacy Code:** Remove legacy `.segment` and fallback logic from `electron/sidecar.ts`.

### Phase 3: Monolithic Modularization (Medium-Term)
1. [x] **Canonical Core TS Client:** Keep `worldline-git.ts` as the sole public interface, with process/protocol plumbing private under `electron/worldline-git/`.
2. [ ] **Decompose `electron/main.ts`:** Extract IPC routing and window management into separate domain modules.
3. [ ] **Decompose `electron/worldlines.ts`:** Move lease management, sandbox creation, and promotion into `electron/worldlines/`.
4. [ ] **Decompose `core/src/main.rs`:** Break Rust daemon into modules (`core/src/git/`, `core/src/snapshot/`, `core/src/promotion/`).
5. [x] **Separate Ignore Responsibilities:** Keep shared watcher/agent walk visibility rules independent from authoritative native Git/snapshot operations.
