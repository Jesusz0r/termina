# Terminal File Drop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

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
- Treat the live manifest rename as the producer commit point and recheck the captured terminal identity inside the queue lock immediately before that rename.
- Keep lock, manifest, claim, quarantine, owner, producer-transaction, and staging records below the canonical events directory; use strict names, no-follow regular-file reads, capped schemas, and bounded cleanup.
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
  export type PendingImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  export type PendingImageInput = { bytes: Buffer; mediaType: PendingImageMediaType; id: string };
  export type PendingImageResult =
    | { ok: true; count: number; names: string[] }
    | { ok: false; error: string };

  export function appendPendingImages(
    eventsDir: string,
    terminalId: string,
    images: readonly PendingImageInput[],
    options?: { canCommit?: () => boolean },
  ): Promise<PendingImageResult>;
  ```
- Removes: exported `appendPendingImage(...)`.
- Consumes: existing `MAX_PENDING_IMAGES`, `MAX_IMAGE_BYTES`, `isSafeImageName()`, and live manifest shape `{ images: ImageRef[] }`.

- [x] **Step 1: Convert the existing harness assertions into failing async batch tests**

  Replace the one-at-a-time assertions with calls such as:

  ```js
  const batch = await host.appendPendingImages(imgDir, hostId, [
    { bytes: png1x1, mediaType: "image/png", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    { bytes: png1x1, mediaType: "image/png", id: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee" },
  ]);
  check("appendPendingImages commits one batch", batch.ok && batch.count === 2 && batch.names.length === 2);
  ```

  Add rejection checks for invalid IDs, unsupported media types, empty bytes, bytes over 4 MiB, duplicate IDs, an empty batch, and existing-plus-new count over four. Pre-create a directory at the second final image name to force a mid-commit rename failure; assert that the manifest remains unchanged and the first final file from the failed batch is removed. Pass `canCommit: () => false` and assert that every staged/final file from that batch is removed, the manifest is unchanged, and the stable error is `terminal closed`. Simulate a process death after final-file renames but before the manifest rename by leaving a complete producer-transaction record. On the next locked operation, assert that unreferenced final files are removed. Force one artifact removal to fail and assert the transaction remains for retry. Repeat with the manifest already committed and assert that referenced files survive while only the transaction record is removed, including when the recorded PID is the current live process after a prior transaction-unlink failure.

- [x] **Step 2: Run the harness and verify the new API is missing**

  Run: `npm run test:agent-core`

  Expected: FAIL because `appendPendingImages` is not exported and the old append semantics still partially mutate.

- [x] **Step 3: Implement the fixed-file hard-link lock and strict record readers**

  In `agent-core/host.ts`, use these constants and private operations:

  ```ts
  const IMAGE_LOCK_WAIT_MS = 250;
  const IMAGE_LOCK_STALE_MS = 5_000;
  const MAX_IMAGE_RECORD_BYTES = 16 * 1024;

  async function withPendingImageLock<T>(eventsDir: string, terminalId: string, fn: () => Promise<T>): Promise<T>;
  async function readImageRecord(path: string): Promise<{ images: ImageRef[] }>;
  ```

  Validate `terminalId` before deriving any name. Create the complete unique owner record with mode `0o600`, close it, then acquire the fixed lock with `link(ownerPath, lockPath)`. Retry `EEXIST` with timers until 250 ms; do not use a blocking sleep. Steal only after a fresh no-follow regular-file read shows the same owner nonce and inode, `process.kill(pid, 0)` returns `ESRCH`, and the record is older than 5 seconds. Treat `EPERM`, a live PID, changed ownership, symlinks, oversized/malformed records, and unsupported hard links as non-stealable failures. Before every commit, verify that the fixed lock and this operation's owner record still have the same device/inode. In `finally`, unlink the fixed path only when that identity still matches, so a delayed release cannot remove a successor's lock; then remove this operation's unique owner record.

  Read manifests, claims, and producer transactions by opening with `O_RDONLY | O_NOFOLLOW`, checking a regular file and the 16 KiB cap through that descriptor, then parsing their exact capped schemas. A producer transaction names its terminal, owner PID, creation time, operation nonce, staged names, and final names; every name must pass its strict app-owned validator. While holding the lock, atomically rename a malformed/oversized live record to a strict unique quarantine name and return `image queue is invalid`. Add cleanup capped at 32 directory entries per successful operation. It may remove only stale unlinked owner, staging, manifest-temp, producer-transaction, and quarantine records with strict app-owned names; it must never follow a link, remove a consumer claim, or infer that an unrecognized file belongs to the app.

  Recover producer transactions only at lock entry, before creating the current operation's transaction. Exclusive ownership of the terminal lock proves that every transaction already present belongs to a prior operation, so recovery must not depend on PID liveness or age. Scan the live manifest and every strict claim for that terminal, preserve every referenced final image, and remove only the transaction's unreferenced staged/final names. Remove the transaction record only after every required artifact removal succeeds; if any removal or reference scan is incomplete, retain the transaction and fail closed so a later operation can retry without losing recovery metadata. This also handles a committed transaction whose final unlink failed while its process remains alive or its PID was reused.

- [x] **Step 4: Implement `appendPendingImages` with one manifest commit point**

  Validate the complete batch before staging and cap its aggregate bytes at 16 MiB. Write collision-resistant `*.stage-*` files outside the lock with exclusive creation. Under the lock, recover prior transactions, read and validate the live manifest, and enforce remaining capacity. Before the first staged-to-final rename, write, sync, and close one complete strict producer-transaction record for the batch; this is recovery metadata, not a second business-state commit. Then rename every staged file to a non-existing final strict name and write a unique complete manifest temporary file. Invoke `options?.canCommit` under the lock after the final files exist but immediately before starting the atomic rename over `images-${terminalId}.json`; a false result returns `terminal closed`. Treat the final manifest rename as the only attachment commit point. On a pre-commit failure, remove only paths listed by this transaction and remove the transaction record only after every required removal succeeds; otherwise retain it for recovery. After commit, try to remove the transaction record; failure to remove it is maintenance only because the next lock owner can prove the prior operation is inactive and preserve manifest-referenced final names before removing the record. Cleanup failure cannot turn a successful attachment into an error. Map contention, invalid records, capacity, and commit-guard failures to the stable errors `image queue busy`, `image queue is invalid`, `too many pending images`, and `terminal closed` instead of returning raw filesystem paths.

- [x] **Step 5: Run queue producer tests**

  Run: `npm run test:agent-core`

  Expected: PASS for batch validation, capacity, atomic failure, and existing image-host tests migrated to async.

- [x] **Step 6: Commit the producer migration**

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
  export type PendingImageStateResult =
    | { ok: true; count: number; hasImages: boolean }
    | { ok: false; error: string };
  export type PendingImageClaimResult =
    | { ok: true; claim: PendingImageClaim }
    | { ok: false; error: string };

  export function pendingImageState(eventsDir: string, terminalId: string): Promise<PendingImageStateResult>;
  export function claimPendingImages(eventsDir: string, terminalId: string): Promise<PendingImageClaimResult>;
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

- [x] **Step 1: Write failing claim lifecycle tests**

  Cover: producer racing consumer with an explicit barrier on both sides of the lock; producer-first and consumer-first outcomes; current-process claim reuse; oldest dead-owner claim adoption; a live foreign-owner claim that is skipped without mutation while a live manifest can still become a separate claim; lock timeout; `EPERM` owner checks; lock-owner replacement before release; malformed/oversized locks, manifests, and claims; quarantine; partial acknowledgement; zero acknowledgement; full acknowledgement; and strict-name cleanup that never deletes a referenced image. Assert that a live manifest published after a claim remains untouched when that older claim is acknowledged. Simulate a consumer crash by leaving a claim, use a definitely dead child PID in its strict name, and assert that the next consumer adopts it instead of age-deleting it.

  Add a TUI check that `setPendingImageCount(2)` updates the title and a standalone `CSI 201~` invokes one `onHostRefresh` callback without changing the prompt draft. Force session-image persistence to fail and assert that acknowledgement receives no source name, the claim remains durable, and the next claim call recovers the same bytes.

- [x] **Step 2: Run the focused harness**

  Run: `npm run test:agent-core`

  Expected: FAIL because claim/query/acknowledgement exports do not exist.

- [x] **Step 3: Implement claim/query/acknowledgement under the same lock**

  Encode terminal ID, owner PID, creation time, and nonce in the strict claim file name, and keep the claim body in the unchanged `{ images: ImageRef[] }` manifest shape. This lets `claimPendingImages` atomically rename the live manifest directly to a durable claim without a metadata rewrite window. It adopts the oldest claim owned by this PID or a PID confirmed dead; it skips live or `EPERM` foreign claims and may claim a separate live manifest. It releases the lock before opening each referenced image with no-follow semantics and bounded descriptor reads. A missing, linked, resized, or malformed referenced image returns `image queue is invalid` without acknowledging or deleting the claim. `acknowledgePendingImages` validates `claimId` as an opaque strict basename, reacquires the same lock, removes only acknowledged refs and their strict source files, rewrites a partial claim through an atomic temporary rename, or removes an empty claim. Zero acknowledgement is a successful no-op.

- [x] **Step 4: Migrate `runPrompt` to claim before use and acknowledge after persistence**

  Replace the unlocked peek and synchronous consume with:

  ```ts
  const pendingResult = eventsDir && terminalId
    ? await pendingImageState(eventsDir, terminalId)
    : { ok: true as const, count: 0, hasImages: false };
  if (!pendingResult.ok) throw new Error(pendingResult.error);
  // preflight uses pendingResult.hasImages
  const claimResult = eventsDir && terminalId
    ? await claimPendingImages(eventsDir, terminalId)
    : { ok: true as const, claim: { claimId: "", images: [] } };
  if (!claimResult.ok) throw new Error(claimResult.error);
  const claim = claimResult.claim;
  ```

  Use `pendingResult.hasImages` for preflight and surface a queue error before logging `agent_start`; restore the prompt draft just as the existing preflight failure path does. After `persistLoadedImages`, derive persisted pending source names by index only when the returned session ref differs from the claim source name and the stored file exists. Call `acknowledgePendingImages` with only those names. Leave unpersisted refs in the durable claim and report an acknowledgement failure without deleting source files. Do not acknowledge extra startup images because they do not belong to this queue.

  Replace the synchronous `pendingImages: () => number` constructor callback with cached `setPendingImageCount(count)`. Add `onHostRefresh?: () => void` to `AgentTui` and invoke it only for a standalone paste-end `CSI 201~`; a real bracketed-paste end still only closes paste mode. In `agent-core/main.ts`, implement one coalesced guarded async `refreshPendingImageCount()` that permits at most one query in flight, schedules one rerun when another refresh arrives, and updates the captured surface only if it is still current. Run it after surface startup, after claim/acknowledgement, and from `onHostRefresh`. On a query error, retain the last cached count and append one concise host error instead of producing an unhandled rejection.

- [x] **Step 5: Run the harness and typecheck**

  Run: `npm run test:agent-core && npm run typecheck`

  Expected: PASS; no synchronous queue export remains referenced.

- [x] **Step 6: Commit the consumer migration**

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
  export function readStableImage(handle: Pick<import("node:fs/promises").FileHandle, "stat" | "read">, expectedSize: number): Promise<{ ok: true; bytes: Buffer } | DropFailure>;
  export function readDroppedImages(paths: readonly string[], remaining: number): Promise<{ ok: true; images: DropImage[] } | DropFailure>;
  export function isAuthorizedDropSender(
    event: Pick<Electron.IpcMainInvokeEvent, "sender" | "senderFrame">,
    win: Electron.BrowserWindow | null,
  ): boolean;
  ```
- Consumes: `MAX_PENDING_IMAGES`, `MAX_IMAGE_BYTES`, and `PendingImageMediaType` from `agent-core/host.ts`. Use the `.ts` import in this directly executed unit-test module so Node's type-stripping runner does not look for a non-existent source `.js` file; the Electron bundle still resolves it normally.

- [x] **Step 1: Write the standalone failing unit test**

  Test normalization order/deduplication, empty input, non-string values, NUL/CR/LF, per-path and pre-deduplication total UTF-8 byte limits, the pre-deduplication 16-path limit, relative paths, lexical `normalize()` behavior without `realpath()`, macOS/Linux quoting, unsupported platform, spaces, quotes, dollars, backticks, backslashes, and leading dashes. Assert path-only validation accepts existing regular files, directories, and symlinks but rejects missing paths. Create minimal real PNG/JPEG/WebP/GIF fixtures plus uppercase extensions, extension/signature mismatch, zero-byte, directory, symlink, oversized, hard-link duplicate, and too-many-unique cases. Test concurrent resize deterministically with a fake `readStableImage` handle whose second `stat()` returns a different size, whose bounded reads return early EOF, and whose one-byte probe after `expectedSize` reports extra data.

- [x] **Step 2: Add and run the test command**

  Add:

  ```json
  "test:terminal-drop": "node --experimental-strip-types --no-warnings scripts/terminal-drop-unit-test.mjs"
  ```

  Include it in `npm test` immediately after typecheck. Run: `npm run test:terminal-drop`.

  Expected: FAIL because `electron/terminal-drop.ts` does not exist.

- [x] **Step 3: Implement normalized path and POSIX quote functions**

  Reject the raw array before deduplication when it is empty, has more than 16 entries, or exceeds either UTF-8 byte budget. Require each entry to be a non-empty absolute path without NUL/CR/LF, apply `node:path.normalize` lexically, and preserve the first normalized string occurrence without calling `realpath`. `validatePathDropTargets` uses asynchronous `lstat` only to require that every path still exists; it accepts files, directories, and symbolic links without resolving or reading them. Quote every path as `'${path.replaceAll("'", "'\\''")}'` and join with one space. Return `unsupported platform` unless `platform` is `darwin` or `linux`.

- [x] **Step 4: Implement descriptor-based image reads**

  Validate `remaining` as an integer from 0 through four. Open every candidate with `O_RDONLY | O_NOFOLLOW`, inspect the descriptor with `stat()`, require a non-empty regular file no larger than 4 MiB, deduplicate the stable `${dev}:${ino}` identity while preserving first order, and close duplicate descriptors immediately. Before allocating any full buffer, reject when unique count exceeds `remaining` or aggregate descriptor sizes exceed 16 MiB. `readStableImage` fills one exact-size buffer through bounded positional reads, rejects early EOF, probes one byte at `expectedSize` to reject growth, then requires a second descriptor stat to match the original size. Validate case-insensitive extensions against PNG's full eight-byte prefix, JPEG's `ff d8 ff` prefix, WebP's `RIFF....WEBP` header, and `GIF87a`/`GIF89a` from the exact final bytes. Generate one fresh UUID only for each retained unique image. Close every retained descriptor in `finally`, including every early-return path.

- [x] **Step 5: Run the standalone test and typecheck**

  Run: `npm run test:terminal-drop && npm run typecheck`

  Expected: PASS.

- [x] **Step 6: Commit the drop primitives**

  ```bash
  git add electron/terminal-drop.ts scripts/terminal-drop-unit-test.mjs package.json
  git commit -m "feat: validate dropped terminal files"
  ```

### Task 4: Wire privileged main, preload, and clipboard behavior

**Files:**
- Modify: `shared/types.ts:440-478`
- Modify: `electron/preload.ts:1-110`
- Modify: `electron/main.ts:1060-1095, 4885-4910`
- Modify: `src/pty-view.ts:25-173`
- Modify: `src/main.ts:455-466`
- Test: `scripts/terminal-drop-unit-test.mjs`
- Test: `scripts/terminal-clipboard-test.mjs`

**Interfaces:**
- Consumes: Task 1 batch writer and Task 3 drop helpers.
- Produces:
  ```ts
  export type TerminalPasteResult =
    | { ok: true; kind: "text"; text: string }
    | { ok: true; kind: "image"; count: number; queued: boolean }
    | { ok: false; error: string };

  dropTerminalFiles(id: string, files: readonly File[]): Promise<TerminalPasteResult>;
  pasteTerminal(id: string): Promise<TerminalPasteResult>;
  ```
- Changes `PtyView` in this task, before its typecheck, to consume `TerminalPasteResult` for clipboard paste and to report an attachment failure through one injected `reportTerminalError(message)` callback. Task 5 reuses that callback for drop errors.

- [x] **Step 1: Add failing contract and authorization tests**

  Extend the unit test with `isAuthorizedDropSender(event, win)` using fakes. Cover the current non-destroyed window's exact `webContents` plus exact main frame, a subframe, mismatched/stale `webContents`, a null frame, a destroyed window, and no window. In the host harness, exercise the Task 1 commit guard with a captured fake terminal, delete or replace that object before commit, and assert the manifest never changes.

- [x] **Step 2: Run the tests and typecheck to observe failures**

  Run: `npm run test:terminal-drop && npm run typecheck`

  Expected: FAIL on missing bridge/result types and sender predicate.

- [x] **Step 3: Implement the narrow preload bridge**

  Import `webUtils` and add the fixed wrapper below. The catch is required because `getPathForFile` throws for a non-`File`; an in-memory JavaScript `File` returns an empty path and main rejects it authoritatively.

  ```ts
  dropTerminalFiles: (id, files): Promise<TerminalPasteResult> => {
    if (!Array.isArray(files) || files.length === 0) return Promise.resolve({ ok: false, error: "no files" });
    if (files.length > 16) return Promise.resolve({ ok: false, error: "too many files" });
    try {
      const paths = files.map((file) => webUtils.getPathForFile(file));
      return ipcRenderer.invoke("terminals:drop-files", id, paths);
    } catch {
      return Promise.resolve({ ok: false, error: "invalid dropped file" });
    }
  },
  ```

  Do not expose `getPathForFile`, paths, or bytes separately.

- [x] **Step 4: Implement the main handler and async clipboard path**

  Register one `terminals:drop-files` handler that first calls `isAuthorizedDropSender`; then validate the terminal ID and capture its object identity. Normalize paths and branch by engine before state change. For core, query remaining capacity, read descriptors, recheck `this.terminals.get(id) === captured`, then call `appendPendingImages(..., { canCommit: () => this.terminals.get(id) === captured })`; return its locked count and `queued: captured.busy`. For Pi/shell, validate existence and quote without opening content, then recheck the captured identity immediately before returning text. Return `terminal closed` for a deleted/replaced identity.

  Make `pasteTerminal` async and capture the same terminal identity. An empty clipboard image keeps the existing text path. Once a non-empty image exists, PNG conversion, size, queue, or liveness failure returns `{ ok: false, error }` and never falls back to unrelated clipboard text. Use the same batch writer and commit guard, and return `queued: captured.busy`. In this task, update `PtyView.pasteClipboard`, its constructor type, `createPaneShell`, and `PiBridge` atomically: paste successful text through `term.paste`, send standalone `CSI 201~` only for a successful image result, and show the exact failure through `toast`. This makes the Task 4 typecheck independent of Task 5.

- [x] **Step 5: Run unit, harness, and type tests**

  Run: `npm run test:terminal-drop && npm run test:agent-core && npm run typecheck && npm run build && npm run test:e2e -- terminal-clipboard --skip-build`

  Expected: PASS.

- [x] **Step 6: Commit the privileged bridge**

  ```bash
  git add shared/types.ts electron/preload.ts electron/main.ts src/pty-view.ts src/main.ts scripts/terminal-drop-unit-test.mjs scripts/terminal-clipboard-test.mjs
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
  ```
- Reuses `reportTerminalError(message: string)` introduced in Task 4.

- [x] **Step 1: Add failing Electron interaction checks**

  In `scripts/terminal-clipboard-test.mjs`, create a unique temporary fixture directory below `TERMINA_INITIAL_CWD`, write files with spaces and a single quote plus a minimal PNG there, and remove that exact directory in `finally`. Create a hidden file input in the page, use CDP `DOM.setFileInputFiles` with those real fixture paths, obtain its disk-backed `File` objects, and dispatch file `dragenter`, `dragover`, and `drop` on the active `.term-pane`. Assert `dragover` is cancelled, the drop class appears and clears, and a text-only drag is not cancelled. For the restored Pi terminal, read xterm buffer lines and assert the exact quoted text appears without a submitted command. Create a core terminal, repeat with the real PNG, then assert its strict events manifest contains one image and its xterm title refreshes to `1 image`. Dispatch a JavaScript-created `File` and assert one `.toast-error` contains the main rejection. Start a delayed drop, dispose/close its pane before resolution, and assert it neither pastes nor reports success.

- [x] **Step 2: Run the focused Electron suite**

  Run: `npm run test:e2e -- terminal-clipboard --skip-build`

  Expected: FAIL because the terminal has no drag listeners.

- [x] **Step 3: Implement `PtyView` drag lifecycle**

  Store the constructor `container`, a drag depth, and `dropInFlight`. Define file drag as `Array.from(event.dataTransfer?.types ?? []).includes("Files")`; leave text/URL drags untouched. For file drags, prevent default on `dragover` and `drop`, maintain depth across xterm children, and toggle `term-drop-target`. Clear depth/class on drop, final qualifying `dragleave`, `dragend`, window blur, and disposal. Reject a second request on this view with `drop already in progress`. Snapshot the `File[]`, await one request, then check `disposed` before any paste, CSI, focus, or feedback. Paste text with `this.term.paste`, send `\x1b[201~` only for a successful core attachment, focus on success, and route failures to `reportTerminalError`. When `result.queued` is true, show the informational text `queued for next prompt`; do not imply that the active request changed. Remove every window/container listener in `dispose()`.

- [x] **Step 4: Wire the renderer and token-based style**

  In `createPaneShell`, pass `(files) => window.pi.dropTerminalFiles(instanceId, files)` and reuse `(message) => toast(message, "error")` from Task 4. Style `.term-pane.term-drop-target` with an inset outline or border using `--accent`, `--bg-hover`, and existing transition patterns; do not add raw colors, shadows, or gradients.

- [x] **Step 5: Run focused E2E and production checks**

  Run: `npm run build && npm run test:e2e -- terminal-clipboard --skip-build`

  Expected: PASS for copy, clipboard paste, Pi path drop, core attachment, in-memory file rejection, and drag cleanup.

- [x] **Step 6: Commit the UI behavior**

  ```bash
  git add src/pty-view.ts src/main.ts src/styles.css scripts/terminal-clipboard-test.mjs
  git commit -m "feat: support terminal file drops"
  ```

### Task 6: Full verification and documentation alignment

**Files:**
- Modify: `docs/AGENT-CORE.md`
- Verify: all files changed in Tasks 1-5

**Interfaces:**
- Consumes: complete terminal-drop feature.
- Produces: one verified implementation with no legacy queue callers.

- [x] **Step 1: Scan for duplicate or obsolete paths**

  Run:

  ```bash
  rg -n "appendPendingImage\(|consumePendingImages\(|peekPendingImages\(|peekPendingImageCount\(|removePendingImageFiles\(" agent-core electron src shared scripts
  ```

  Expected: no old public queue call remains. Also run `rg -n "readFileSync|writeFileSync|renameSync|rmSync|statSync|lstatSync" agent-core/host.ts electron/terminal-drop.ts` and inspect each match: none may belong to the pending-image producer, claim, acknowledgement, state-query, cleanup, or desktop-drop paths. References in historical design text are acceptable.

- [x] **Step 2: Run the complete automated verification**

  Run: `npm run test`

  Expected: PASS.

- [x] **Step 3: Run the focused Electron suite from a fresh build**

  Run: `npm run test:e2e -- terminal-clipboard`

  Expected: PASS.

- [x] **Step 4: Inspect repository scope**

  Run: `git diff --check && git status --short && git diff --stat`

  Expected: no whitespace errors; only planned files plus the user's pre-existing changes are present.

- [x] **Step 5: Document and commit the canonical drop behavior**

  Document Finder image attachment, path-only terminal quoting, four-image/4 MiB limits, and durable claim recovery in `docs/AGENT-CORE.md`. Do not document lock-file names as user-facing API.

  ```bash
  git add docs/AGENT-CORE.md
  git commit -m "docs: describe terminal image drops"
  ```
