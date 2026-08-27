# Terminal File Drop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users drop Finder files into every terminal while core terminals attach validated images through a crash-safe pending-image queue and Pi/shell terminals receive quoted paths through xterm paste.

**Architecture:** `PtyView` owns drag interaction, preload converts disk-backed `File` objects into paths through Electron's narrow `webUtils` API, and main authorizes the sender and terminal before choosing attachment or path-paste behavior. `agent-core/host.ts` remains the only pending-image owner; its synchronous manifest mutation is replaced with one asynchronous lock, batch, claim, and acknowledgement protocol shared by clipboard, drop, and prompt consumption.

**Tech Stack:** Electron 37, TypeScript 5.8, xterm 5.5, Node.js filesystem promises, existing Node/Electron test scripts.

**Spec:** `docs/superpowers/specs/2026-08-27-terminal-images-semantic-transcript-design.md`

## Global Constraints

- Support the current macOS and Linux builds; fail closed on a future platform without a quoting rule.
- Accept at most 16 input paths, 4,096 UTF-8 bytes per path, and 64 KiB total path data.
- Keep `MAX_PENDING_IMAGES = 4`, `MAX_IMAGE_BYTES = 4 MiB`, and a 16 MiB maximum unique image batch.
- Use asynchronous filesystem calls on every main-process and queue path.
- Keep `agent-core/host.ts` as the one pending-image implementation; remove the synchronous append and consume paths after migration.
- Keep the live manifest JSON shape and final image-file format unchanged.
- Do not add a dependency, binary IPC payload, general path resolver, new sidecar schema, or renderer filesystem access.
- Route path insertion through xterm's bracketed-paste behavior and never append Enter.
- Preserve the user's existing uncommitted changes in `agent-core/main.ts`, `agent-core/tui.ts`, `docs/AGENT-CORE.md`, `scripts/agent-core-harness-test.mjs`, and `src/terminal-themes.ts`.
- Use ASD-STE100 comments for new or changed comments.

---

## File Structure

- Modify `agent-core/host.ts`: canonical async queue lock, batch producer, durable claim, acknowledgement, query, and cleanup.
- Modify `agent-core/main.ts`: await queue state/claim and acknowledge only persisted image refs.
- Create `electron/terminal-drop.ts`: pure path validation, POSIX quoting, and descriptor-based image loading used only by main.
- Modify `electron/main.ts`: sender/terminal authorization, async clipboard attachment, drop dispatch, and terminal identity recheck.
- Modify `electron/preload.ts`: narrow `webUtils.getPathForFile` bridge.
- Modify `shared/types.ts`: drop and paste result contracts.
- Modify `src/pty-view.ts`: file-drag lifecycle, one in-flight request, xterm paste, and disposal checks.
- Modify `src/main.ts`: wire per-terminal drop callback and toast errors.
- Modify `src/styles.css`: token-based terminal drop target.
- Modify `scripts/agent-core-harness-test.mjs`: queue atomicity, recovery, and acknowledgement coverage.
- Create `scripts/terminal-drop-unit-test.mjs`: path validation, quoting, signature, descriptor, and identity-independent helper tests.
- Modify `package.json`: run the new unit test in the default test chain.
- Modify `scripts/terminal-clipboard-test.mjs`: Electron drop integration for Pi and core terminals.

### Task 1: Replace the pending-image writer with an atomic async batch

**Files:**
- Modify: `agent-core/host.ts:232-329`
- Test: `scripts/agent-core-harness-test.mjs:330-405`

**Interfaces:**
- Produces:
  ```ts
  export type PendingImageInput = { bytes: Buffer; mediaType: string; id: string };
  export type PendingImageResult =
    | { ok: true; count: number; names: string[] }
    | { ok: false; error: string };

  export function appendPendingImages(
    eventsDir: string,
    terminalId: string,
    images: readonly PendingImageInput[],
  ): Promise<PendingImageResult>;
  ```
- Removes: exported `appendPendingImage(...)`.
- Consumes: existing `MAX_PENDING_IMAGES`, `MAX_IMAGE_BYTES`, `isSafeImageName()`, and live manifest shape `{ images: ImageRef[] }`.

- [ ] **Step 1: Convert the existing harness assertions into failing async batch tests**

  Replace the one-at-a-time assertions with calls such as:

  ```js
  const batch = await host.appendPendingImages(imgDir, hostId, [
    { bytes: png1x1, mediaType: "image/png", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    { bytes: png1x1, mediaType: "image/png", id: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee" },
  ]);
  check("appendPendingImages commits one batch", batch.ok && batch.count === 2 && batch.names.length === 2);
  ```

  Add rejection checks for invalid IDs, empty bytes, bytes over 4 MiB, duplicate IDs, an empty batch, and existing-plus-new count over four. Pre-create a directory at the second final image name to force a mid-commit rename failure; assert that the manifest remains unchanged and the first final file from the failed batch is removed.

- [ ] **Step 2: Run the harness and verify the new API is missing**

  Run: `npm run test:agent-core`

  Expected: FAIL because `appendPendingImages` is not exported and the old append semantics still partially mutate.

- [ ] **Step 3: Implement the fixed-file hard-link lock and strict record readers**

  In `agent-core/host.ts`, use these constants and private operations:

  ```ts
  const IMAGE_LOCK_WAIT_MS = 250;
  const IMAGE_LOCK_STALE_MS = 5_000;
  const MAX_IMAGE_RECORD_BYTES = 16 * 1024;

  async function withPendingImageLock<T>(eventsDir: string, terminalId: string, fn: () => Promise<T>): Promise<T>;
  async function readImageRecord(path: string): Promise<ImageRef[]>;
  ```

  Write a complete unique owner file in the events directory, close it, then acquire the fixed lock with `link(ownerPath, lockPath)`. Retry `EEXIST` asynchronously until 250 ms. Steal only when `process.kill(pid, 0)` proves the owner dead and the record is older than 5 seconds; treat `EPERM`, a live PID, symlinks, and malformed fixed locks as non-stealable failures. Release by unlinking the fixed path and the unique owner record in `finally`.

- [ ] **Step 4: Implement `appendPendingImages` with one manifest commit point**

  Validate the complete batch before staging. Write unique `*.stage-*` files outside the lock. Under the lock, read and validate the live manifest, enforce remaining capacity, rename every staged file to its final strict name, write a unique manifest temporary file, and atomically rename it over `images-${terminalId}.json`. Treat that final manifest rename as the commit point. Before commit, remove only files created by this batch; after commit, never roll back published files.

- [ ] **Step 5: Run queue producer tests**

  Run: `npm run test:agent-core`

  Expected: PASS for batch validation, capacity, atomic failure, and existing image-host tests migrated to async.

- [ ] **Step 6: Commit the producer migration**

  ```bash
  git add agent-core/host.ts scripts/agent-core-harness-test.mjs
  git commit -m "refactor: make pending image writes atomic"
  ```

### Task 2: Add durable image claims and post-persistence acknowledgement

**Files:**
- Modify: `agent-core/host.ts:232-345`
- Modify: `agent-core/main.ts:3398-3445`
- Modify: `agent-core/tui.ts:250-340, 770-800`
- Test: `scripts/agent-core-harness-test.mjs:330-430`

**Interfaces:**
- Consumes: `withPendingImageLock()` and strict record parsing from Task 1.
- Produces:
  ```ts
  export type PendingImageClaim = { claimId: string; images: LoadedImage[] };

  export function pendingImageState(eventsDir: string, terminalId: string): Promise<{ count: number; hasImages: boolean }>;
  export function claimPendingImages(eventsDir: string, terminalId: string): Promise<PendingImageClaim>;
  export function acknowledgePendingImages(
    eventsDir: string,
    terminalId: string,
    claimId: string,
    persistedNames: readonly string[],
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  // AgentTui replaces its synchronous callback with cached state.
  setPendingImageCount(count: number): void;
  ```
- Removes: exported synchronous `peekPendingImages`, `peekPendingImageCount`, `consumePendingImages`, and `removePendingImageFiles` paths once all callers migrate.

- [ ] **Step 1: Write failing claim lifecycle tests**

  Cover: producer racing consumer with `Promise.all`; current-process claim reuse; dead-owner claim adoption; live foreign-owner claim refusal; lock timeout; malformed/oversized live records and claims; partial acknowledgement; zero acknowledgement; full acknowledgement; and cleanup that never deletes a referenced image. Assert that a live manifest published after a claim remains untouched when that older claim is acknowledged.

  Add a TUI check that `setPendingImageCount(2)` updates the title and a standalone `CSI 201~` invokes one `onHostRefresh` callback without changing the prompt draft.

- [ ] **Step 2: Run the focused harness**

  Run: `npm run test:agent-core`

  Expected: FAIL because claim/query/acknowledgement exports do not exist.

- [ ] **Step 3: Implement claim/query/acknowledgement under the same lock**

  Claim files must include terminal ID, owner PID, creation time, nonce, and the unchanged `images` array. `claimPendingImages` adopts the oldest claim owned by this PID or a confirmed-dead PID; otherwise it renames the live manifest to a new claim. It reads bounded image bytes after releasing the lock. `acknowledgePendingImages` reacquires the lock, removes only acknowledged refs and their strict source files, rewrites a partial claim atomically, or removes an empty claim.

- [ ] **Step 4: Migrate `runPrompt` to claim before use and acknowledge after persistence**

  Replace the unlocked peek and synchronous consume with:

  ```ts
  const pending = eventsDir && terminalId
    ? await pendingImageState(eventsDir, terminalId)
    : { count: 0, hasImages: false };
  // preflight uses pending.hasImages
  const claim = eventsDir && terminalId
    ? await claimPendingImages(eventsDir, terminalId)
    : { claimId: "", images: [] };
  ```

  After `persistLoadedImages`, derive the persisted pending source names by index and call `acknowledgePendingImages`. Leave unpersisted refs in the claim. Do not acknowledge extra startup images because they do not belong to this queue.

  Replace the synchronous `pendingImages: () => number` constructor callback with cached `setPendingImageCount(count)`. Add `onHostRefresh?: () => void` to `AgentTui` and invoke it for standalone paste-end `CSI 201~`. In `agent-core/main.ts`, implement one guarded async `refreshPendingImageCount()` that calls `pendingImageState`, updates the current surface if it is still live, runs after surface startup, after claim/acknowledgement, and from `onHostRefresh`.

- [ ] **Step 5: Run the harness and typecheck**

  Run: `npm run test:agent-core && npm run typecheck`

  Expected: PASS; no synchronous queue export remains referenced.

- [ ] **Step 6: Commit the consumer migration**

  ```bash
  git add agent-core/host.ts agent-core/main.ts agent-core/tui.ts scripts/agent-core-harness-test.mjs
  git commit -m "fix: preserve pending images until persistence"
  ```

### Task 3: Add pure drop validation, quoting, and image loading

**Files:**
- Create: `electron/terminal-drop.ts`
- Create: `scripts/terminal-drop-unit-test.mjs`
- Modify: `package.json:14-22`

**Interfaces:**
- Produces:
  ```ts
  export type DropImage = { bytes: Buffer; mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; id: string };
  export type DropFailure = { ok: false; error: string };

  export function normalizeDroppedPaths(raw: unknown): { ok: true; paths: string[] } | DropFailure;
  export function validatePathDropTargets(paths: readonly string[]): Promise<{ ok: true } | DropFailure>;
  export function quotePosixPaths(paths: readonly string[], platform: NodeJS.Platform): { ok: true; text: string } | DropFailure;
  export function readStableImage(handle: Pick<import("node:fs/promises").FileHandle, "stat" | "read">, expectedSize: number): Promise<Buffer>;
  export function readDroppedImages(paths: readonly string[], remaining: number): Promise<{ ok: true; images: DropImage[] } | DropFailure>;
  export function isAuthorizedDropSender(senderFrame: Electron.WebFrameMain | null, win: Electron.BrowserWindow | null): boolean;
  ```
- Consumes: `MAX_PENDING_IMAGES` and `MAX_IMAGE_BYTES` from `agent-core/host.ts`.

- [ ] **Step 1: Write the standalone failing unit test**

  Test normalization order/deduplication, NUL/CR/LF, per-path and total UTF-8 byte limits, 16-path limit, relative paths, macOS/Linux quoting, unsupported platform, spaces, quotes, dollars, backticks, backslashes, and leading dashes. Assert path-only validation accepts existing regular files, directories, and symlinks but rejects missing paths. Create real PNG/JPEG/WebP/GIF fixtures plus extension/signature mismatch, zero-byte, directory, symlink, oversized, hard-link duplicate, and too-many-unique cases. Test concurrent resize deterministically with a fake `readStableImage` handle whose second `stat()` returns a different size and whose `read()` returns a short or long count.

- [ ] **Step 2: Add and run the test command**

  Add:

  ```json
  "test:terminal-drop": "node --experimental-strip-types --no-warnings scripts/terminal-drop-unit-test.mjs"
  ```

  Include it in `npm test` immediately after typecheck. Run: `npm run test:terminal-drop`.

  Expected: FAIL because `electron/terminal-drop.ts` does not exist.

- [ ] **Step 3: Implement normalized path and POSIX quote functions**

  Require an absolute path and reject empty/control-bearing values. Preserve the first normalized path occurrence. `validatePathDropTargets` uses asynchronous `lstat` only to require that every path still exists; it accepts files, directories, and symbolic links without resolving or reading them. Quote every path as `'${path.replaceAll("'", "'\\''")}'` and join with one space. Return `unsupported platform` unless `platform` is `darwin` or `linux`.

- [ ] **Step 4: Implement descriptor-based image reads**

  Open every candidate with `O_RDONLY | O_NOFOLLOW`, `fstat` it, deduplicate `{dev, ino}`, and enforce remaining count and 16 MiB total before allocating. `readStableImage` fills one exact-size buffer through bounded positional reads, rejects early EOF or extra bytes, then checks a second `fstat` size. Validate case-insensitive extensions against PNG, JPEG, WebP, and GIF magic from the final bytes. Close every descriptor in `finally`.

- [ ] **Step 5: Run the standalone test and typecheck**

  Run: `npm run test:terminal-drop && npm run typecheck`

  Expected: PASS.

- [ ] **Step 6: Commit the drop primitives**

  ```bash
  git add electron/terminal-drop.ts scripts/terminal-drop-unit-test.mjs package.json
  git commit -m "feat: validate dropped terminal files"
  ```

### Task 4: Wire privileged main, preload, and clipboard behavior

**Files:**
- Modify: `shared/types.ts:440-478`
- Modify: `electron/preload.ts:1-110`
- Modify: `electron/main.ts:1060-1095, 4885-4910`
- Test: `scripts/terminal-drop-unit-test.mjs`

**Interfaces:**
- Consumes: Task 1 batch writer and Task 3 drop helpers.
- Produces:
  ```ts
  export type TerminalPasteResult =
    | { ok: true; kind: "text"; text: string }
    | { ok: true; kind: "image"; count: number; queued: boolean }
    | { ok: false; error: string };

  dropTerminalFiles(id: string, files: File[]): Promise<TerminalPasteResult>;
  pasteTerminal(id: string): Promise<TerminalPasteResult>;
  ```

- [ ] **Step 1: Add failing contract and authorization tests**

  Extend the unit test with a small exported `isAuthorizedDropSender(senderFrame, win)` predicate using fakes. Cover the current main frame, a subframe, a stale webContents, a closed terminal identity, and a replaced object under the same ID.

- [ ] **Step 2: Run the tests and typecheck to observe failures**

  Run: `npm run test:terminal-drop && npm run typecheck`

  Expected: FAIL on missing bridge/result types and sender predicate.

- [ ] **Step 3: Implement the narrow preload bridge**

  Import `webUtils` and add:

  ```ts
  dropTerminalFiles: (id, files) => {
    if (!Array.isArray(files) || files.length > 16) return Promise.resolve({ ok: false, error: "too many files" });
    const paths = files.map((file) => webUtils.getPathForFile(file));
    return ipcRenderer.invoke("terminals:drop-files", id, paths);
  },
  ```

  Do not expose `getPathForFile`, paths, or bytes separately.

- [ ] **Step 4: Implement the main handler and async clipboard path**

  Validate `event.senderFrame === this.win.webContents.mainFrame`, capture the terminal object, normalize paths, branch by engine, and require `this.terminals.get(id) === captured` before returning. Core calls `pendingImageState`, `readDroppedImages`, and `appendPendingImages`. Pi/shell calls `validatePathDropTargets` then `quotePosixPaths` without reading file content. Make `pasteTerminal` async and return `{ ok: false, error }` for image attachment failure instead of falling back to clipboard text.

- [ ] **Step 5: Run unit, harness, and type tests**

  Run: `npm run test:terminal-drop && npm run test:agent-core && npm run typecheck`

  Expected: PASS.

- [ ] **Step 6: Commit the privileged bridge**

  ```bash
  git add shared/types.ts electron/preload.ts electron/main.ts scripts/terminal-drop-unit-test.mjs
  git commit -m "feat: route terminal file drops through main"
  ```

### Task 5: Add terminal drag interaction and feedback

**Files:**
- Modify: `src/pty-view.ts:12-285`
- Modify: `src/main.ts:420-490`
- Modify: `src/styles.css`
- Modify: `scripts/terminal-clipboard-test.mjs`

**Interfaces:**
- Consumes: `PiBridge.dropTerminalFiles()` and `TerminalPasteResult` from Task 4.
- Changes `PtyView` constructor to accept:
  ```ts
  dropFromHost: (files: File[]) => Promise<TerminalPasteResult>,
  reportError: (message: string) => void,
  ```

- [ ] **Step 1: Add failing Electron interaction checks**

  In `scripts/terminal-clipboard-test.mjs`, create a hidden file input in the page, use CDP `DOM.setFileInputFiles` with a real fixture path, obtain its disk-backed `File`, and dispatch `dragenter`, `dragover`, and `drop` on the active `.term-pane`. Assert the drop class appears and clears. For the restored Pi terminal, assert quoted text reaches the terminal input without Enter. Create a core terminal, repeat with a real PNG, and assert `window.pi` reports an image count and the events manifest exists. Also dispatch a JavaScript-created `File` and assert a visible error.

- [ ] **Step 2: Run the focused Electron suite**

  Run: `npm run test:e2e -- terminal-clipboard --skip-build`

  Expected: FAIL because the terminal has no drag listeners.

- [ ] **Step 3: Implement `PtyView` drag lifecycle**

  Store the container, a drag depth, and `dropInFlight`. Handle only `dataTransfer.types` containing `Files`; prevent navigation on dragover/drop, maintain depth across xterm children, and toggle `term-drop-target`. Reject a second request with `drop already in progress`. After awaiting, check `disposed`; paste text with `this.term.paste`, send `\x1b[201~` for a core attachment, focus on success, and route failures to `reportError`. Remove window and container listeners in `dispose()`.

- [ ] **Step 4: Wire the renderer and token-based style**

  In `createPaneShell`, pass `(files) => window.pi.dropTerminalFiles(instanceId, files)` and `(message) => toast(message, "error")`. Style `.term-pane.term-drop-target` with an inset outline or border using `--accent`, `--bg-hover`, and existing transition patterns; do not add raw colors, shadows, or gradients.

- [ ] **Step 5: Run focused E2E and production checks**

  Run: `npm run build && npm run test:e2e -- terminal-clipboard --skip-build`

  Expected: PASS for copy, clipboard paste, Pi path drop, core attachment, in-memory file rejection, and drag cleanup.

- [ ] **Step 6: Commit the UI behavior**

  ```bash
  git add src/pty-view.ts src/main.ts src/styles.css scripts/terminal-clipboard-test.mjs
  git commit -m "feat: support terminal file drops"
  ```

### Task 6: Full verification and documentation alignment

**Files:**
- Modify if behavior changed: `docs/AGENT-CORE.md`
- Verify: all files changed in Tasks 1-5

**Interfaces:**
- Consumes: complete terminal-drop feature.
- Produces: one verified implementation with no legacy queue callers.

- [ ] **Step 1: Scan for duplicate or obsolete paths**

  Run:

  ```bash
  rg -n "appendPendingImage\(|consumePendingImages\(|peekPendingImageCount\(|removePendingImageFiles\(" agent-core electron src shared scripts
  ```

  Expected: no old public queue call remains. References in historical design text are acceptable.

- [ ] **Step 2: Run the complete automated verification**

  Run: `npm run test`

  Expected: PASS.

- [ ] **Step 3: Run the focused Electron suite from a fresh build**

  Run: `npm run test:e2e -- terminal-clipboard`

  Expected: PASS.

- [ ] **Step 4: Inspect repository scope**

  Run: `git diff --check && git status --short && git diff --stat`

  Expected: no whitespace errors; only planned files plus the user's pre-existing changes are present.

- [ ] **Step 5: Commit final documentation or cleanup only if needed**

  ```bash
  git add docs/AGENT-CORE.md
  git commit -m "docs: describe terminal image drops"
  ```

  Skip this commit when the existing documentation already matches the shipped behavior.
