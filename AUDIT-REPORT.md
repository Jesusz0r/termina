# Hardening audit — Jesusz0r/termina

- **Repo:** Jesusz0r/termina
- **Branch audited:** master
- **Commit:** `785c3a8db5087fcf3602ebb5d19582232477cc45` (`785c3a8` — “Deploy the marketing site from website/ on GitHub Pages.”)
- **Scope:** Read-only. No application code was changed. Findings below are from repository search only. Proposed fixes were not applied.

This is a desktop Electron app (main + preload + renderer + Rust `termina-core`). It has no HTTP API server, no SQL database, and no money ledger. Checks that assume those systems were still searched; when they do not apply, the report says so.

---

## 1. Duplicate utility functions

**Status:** findings (4)

### 1a. Identical path basename helpers

`src/main.ts:706` and `src/editor.ts:508` implement the same function:

```ts
return p.split(/[\\/]/).pop() || p;
```

**Proposed fix:** Keep one helper (for example next to `cssFontFamily` in `shared/types.ts`, or a small `shared/path.ts`) and call it from both files. Delete the other.

### 1b. Identical POSIX shell quoting

`electron/worldlines.ts:22` (`quoteArg`) and `electron/main.ts:442` (`quoteShellArg`) both do POSIX single-quote escaping (`'` → `'\''`).

`electron/sandbox.ts:61` (`quote`) is a different helper (double-quote + backslash for sandbox profiles). That one is not a duplicate.

**Proposed fix:** Keep one `quoteShellArg` in a single main-process module and import it from `worldlines.ts`. Do not merge it with `sandbox.ts` `quote`.

### 1c. Duplicate directory-size measurement

- `electron/worldlines.ts:209` `dirBytes` — spawns `du -sk`
- `electron/main.ts:1787` `dirBytesOf` — walks the tree with `readdir`/`stat`

Both exist to answer “how large is this directory?”

**Proposed fix:** Pick one implementation (the walk is already bounded; `du` is faster but a second process). Use it from both call sites. Delete the other.

### 1d. Copy-pasted test `waitFor` helpers

The same deadline-loop helper appears in:

- `scripts/multiproj-test.mjs:70`
- `scripts/worldline-compare-test.mjs:75`
- `scripts/worldline-cleanup-test.mjs:69`
- `scripts/worldline-isolation-test.mjs:83`
- `scripts/worldline-promote-test.mjs:80`
- `scripts/worldline-any-moment-test.mjs:74`
- `scripts/worldline-capture-test.mjs:70`
- `scripts/worldline-trust-test.mjs:75`
- `scripts/worldline-preflight-test.mjs:67`
- `scripts/worldline-fork-run-test.mjs:76`
- `scripts/worldline-evidence-test.mjs:80`
- `scripts/worldline-challenge-test.mjs:73`
- `scripts/worldline-run-boundary-test.mjs:77` (`waitForRun`)

**Proposed fix:** Extract one `waitFor` into a small test helper module and import it. This is test-only; it is not a product-path duplicate.

---

## 2. Secrets committed in config files

**Status:** none found

Searched `*.json`, `*.yml`, `*.yaml`, `*.toml`, `*.env*`, `package.json`, `electron-builder.yml`, `.github/workflows/*`, `core/Cargo.toml`, and source for key/token/password patterns.

What exists is not a committed secret:

- `.github/workflows/release.yml:56-62` references GitHub Actions secrets (`CSC_LINK`, `APPLE_ID`, …) by name only.
- `electron/main.ts:630-661` lists provider **environment variable names** (`OPENAI_API_KEY`, …) for sanitization, not values.
- `RELEASING.md` documents how operators set those secrets.
- `website/app.js` “TokenValidator” / `valid-jwt-token` text is marketing demo HTML, not a credential.

No `.env`, API key, private key, or password value is committed.

---

## 3. Functions over 400 lines

**Status:** none found

Function bodies were measured by declaration + brace match (TypeScript methods and Rust `fn`).

Largest product functions, all under the 400-line bar:

| Lines | Location | Name |
|------:|----------|------|
| 393 | `electron/main.ts:5258-5650` | `registerIpc` |
| 228 | `electron/main.ts:3535-3762` | `handleSidecarEvent` |
| 136 | `electron/evidence.ts:828-963` | `rankProfiles` |
| 136 | `core/src/main.rs:604-739` | `op_capture_incremental` |
| 135 | `electron/main.ts:5039-5173` | `startWatcher` |
| 123 | `electron/main.ts:1108-1230` | `initWorldlines` |
| 117 | `core/src/main.rs:1305-1421` | `op_preflight` |

`electron/main.ts` itself is 5863 lines (one class file, not one function).

**Proposed fix if desired later:** Split `registerIpc` before it crosses 400 lines (group handlers by area). Not a finding at the current threshold.

---

## 4. Components over 200 lines

**Status:** findings (8)

This repo is vanilla TypeScript, not React. UI “components” are the exported view classes under `src/` plus the marketing page script.

| Lines | File | Component |
|------:|------|-----------|
| 833 | `src/worldlines.ts` | `WorldlinesView` (class starts `src/worldlines.ts:237`) |
| 587 | `website/app.js` | marketing page (single script) |
| 541 | `src/editor.ts` | `EditorManager` (class starts `src/editor.ts:62`) |
| 453 | `src/settings.ts` | `SettingsView` (class starts `src/settings.ts:124`) |
| 340 | `src/timeline.ts` | `TimelineView` (class starts `src/timeline.ts:12`) |
| 254 | `src/components/explorer.ts` | `Explorer` (class starts `src/components/explorer.ts:14`) |
| 231 | `src/review.ts` | `ReviewView` (class starts `src/review.ts:10`) |
| 230 | `src/pty-view.ts` | `PtyView` (class starts `src/pty-view.ts:29`) |

Under the bar: `src/session-search.ts` (118), `src/components/modals.ts` (109).

`src/main.ts` (1696) is the renderer orchestrator, not a component. It is not counted here.

**Proposed fix:** Split the largest views along existing seams (worldline card vs actions, editor tabs vs models, settings form vs shortcut table). Do not add a component framework.

---

## 5. Dead code

**Status:** findings (3)

### 5a. Unused `realHome()` helper

`electron/sandbox.ts:156` exports `realHome()`. No import or call exists. Callers pass `homedir()` / `deps.realHome` instead (`electron/main.ts:1114`, `electron/worldlines.ts:1069`).

**Proposed fix:** Delete `realHome()` in `electron/sandbox.ts`.

### 5b. Unused compare IPC stack

`WorldlineManager.compare` (`electron/worldlines.ts:315`) is only reached from `ipcMain.handle("worldline:compare")` (`electron/main.ts:5427`) and `window.pi.compareWorldline` (`electron/preload.ts:119`, `shared/types.ts:547`).

No renderer, test, or other TypeScript caller invokes `compareWorldline`. The UI builds A⇄B lists from already-fetched details (`src/worldlines.ts:750-762`).

**Proposed fix:** Either call `compareWorldline` from the A⇄B modal, or delete `compare`, the IPC channel, the preload method, and the `PiBridge` field.

### 5c. Unused `folder:open` / `openFolder` bridge

`ipcMain.handle("folder:open")` at `electron/main.ts:5281` duplicates `project:open` at `electron/main.ts:5270` (both call `this.openFolder()`).

`window.pi.openFolder` is declared (`electron/preload.ts:153`, `shared/types.ts:589`). The renderer only calls `window.pi.projectOpen()` (`src/main.ts:1006`, `1010`, `1015`; `src/components/explorer.ts:86`). The menu calls `this.openFolder()` in main, not IPC.

**Proposed fix:** Remove `folder:open`, `openFolder` on the bridge, and the `PiBridge` field. Keep `project:open`.

---

## 6. Silent or empty catch blocks

**Status:** findings (89 in product code)

These swallow errors with an empty body, a comment only, or `.catch(() => undefined|{}|false|0|null)`. Many are intentional best-effort cleanup. They still match this check.

### Empty or comment-only `catch`

| File:line | Body |
|-----------|------|
| `electron/main.ts:98` | `catch {}` (inside the generated bridge template) |
| `electron/main.ts:116` | comment only |
| `electron/main.ts:165` | comment only |
| `electron/main.ts:275` | `catch {}` (bridge template) |
| `electron/main.ts:281` | `catch {}` (bridge template) |
| `electron/main.ts:816` | comment only |
| `electron/main.ts:1133` | comment only |
| `electron/main.ts:1352` | comment only |
| `electron/main.ts:1679` | comment only |
| `electron/main.ts:1802` | comment only |
| `electron/main.ts:1829` | comment only |
| `electron/main.ts:1833` | comment only |
| `electron/main.ts:1855` | comment only |
| `electron/main.ts:1865` | comment only |
| `electron/main.ts:2307` | comment only |
| `electron/main.ts:2453` | comment only |
| `electron/main.ts:2471` | comment only |
| `electron/main.ts:2594` | comment only |
| `electron/main.ts:2635` | comment only |
| `electron/main.ts:2872` | comment only |
| `electron/main.ts:3205` | `/* ignore */` |
| `electron/main.ts:3299` | `/* ignore */` |
| `electron/main.ts:3324` | comment only |
| `electron/main.ts:3451` | `/* ignore */` |
| `electron/main.ts:4062` | comment only |
| `electron/main.ts:4804` | comment only |
| `electron/main.ts:4964` | comment only |
| `electron/main.ts:5012` | comment only |
| `electron/main.ts:5031` | comment only |
| `electron/worldlines.ts:538` | comment only |
| `electron/worldlines.ts:631` | comment only |
| `electron/worldlines.ts:747` | comment only |
| `electron/worldlines.ts:824` | comment only |
| `electron/worldlines.ts:1082` | comment only |
| `electron/worldlines.ts:1091` | comment only |
| `electron/worldlines.ts:1195` | comment only |
| `electron/worldlines.ts:1501` | comment only |
| `electron/worldlines.ts:1511` | comment only |
| `electron/worldlines.ts:1588` | comment only |
| `electron/worldlines.ts:1593` | comment only |
| `electron/evidence.ts:421` | comment only |
| `electron/evidence.ts:750` | comment only |
| `electron/evidence.ts:1013` | comment only |
| `electron/pty-terminal.ts:40` | comment only |
| `electron/pty-terminal.ts:66` | `/* ignore */` |
| `electron/pty-terminal.ts:75` | `/* ignore */` |
| `electron/pty-terminal.ts:84` | `/* ignore */` |
| `electron/sidecar.ts:121` | comment only |
| `electron/sidecar.ts:206` | comment only |
| `electron/sidecar.ts:223` | comment only |
| `electron/watcher.ts:119` | `/* ignore */` |
| `electron/watcher.ts:236` | `/* non-fatal */` |
| `electron/core-client.ts:62` | comment only |
| `src/pty-view.ts:78` | `/* ignore */` |
| `src/pty-view.ts:94` | comment only |
| `src/pty-view.ts:144` | comment only |
| `src/pty-view.ts:207` | `/* ignore */` |

### Silent promise `.catch`

| File:line |
|-----------|
| `electron/preferences.ts:30` (`.catch(() => {})`) |
| `electron/preferences.ts:45` |
| `electron/worldlines.ts:971` |
| `electron/worldlines.ts:975` |
| `electron/worldlines.ts:979` |
| `electron/worldlines.ts:1418` |
| `electron/worldlines.ts:1517` |
| `electron/worldlines.ts:1596` |
| `electron/core-client.ts:103` |
| `electron/main.ts:570` |
| `electron/main.ts:1170` (`.catch(() => null)`) |
| `electron/main.ts:1874` |
| `electron/main.ts:1919` |
| `electron/main.ts:2097` |
| `electron/main.ts:2100` |
| `electron/main.ts:3512` |
| `electron/main.ts:3518` |
| `electron/main.ts:3527` |
| `electron/main.ts:4042` |
| `electron/main.ts:4044` |
| `electron/main.ts:4168` |
| `electron/main.ts:4709` (`.catch(() => 0)`) |
| `electron/main.ts:4870` |
| `electron/main.ts:4872` |
| `electron/main.ts:4975` |
| `electron/main.ts:5703` |
| `electron/main.ts:5707` |
| `electron/main.ts:5856` (`.catch(() => false)`) |
| `src/pty-view.ts:89` |
| `src/pty-view.ts:181` |
| `src/main.ts:375` |
| `src/main.ts:438` |

**Proposed fix:** For user-visible failures, log at `console.warn` with the operation name (the file already does this in many other catches). For expected absence (missing optional file), keep the catch but return a named result (`null` / `false`) at the call site instead of a bare ignore. Do not add a logging framework.

---

## 7. API calls in the UI missing loading/error states

**Status:** findings (12)

The UI talks to main through `window.pi` (IPC), not HTTP. The same loading/error rule applies to those calls.

| File:line | Call | Missing |
|-----------|------|---------|
| `src/session-search.ts:80` | `searchSessions` | No try/catch, no error row, no “searching…” state |
| `src/review.ts:88-91` | `reviewBaseline` / `openFile` | No try/catch; no loading; failures become empty diff |
| `src/review.ts:144-146` | `getWorldlineFile` A/B | Failed reads become empty strings; no error hint (unlike `showCandidateDiff` at `:135`) |
| `src/review.ts:177` | `openFile` in `refreshCurrent` | No error handling |
| `src/components/explorer.ts:155-159` | `listDir` | On `res.error`, children are cleared with no toast and no loading row |
| `src/editor.ts:394-403` | `saveFile` | Failed save is silent (dirty dot stays; no toast) |
| `src/main.ts:268` | `getMineFiles` | No `.catch`; a throw leaves marks empty |
| `src/main.ts:539` | `getRuns` | No error handling |
| `src/main.ts:586` | `detectTest` | No error handling (unlike `refreshTestCommand` at `:799`) |
| `src/main.ts:605-614` | `getTimeline` / `getTimelinePrefix` | No error handling; `timelineLoaded` is set true before success |
| `src/main.ts:1497` | `openFile` after a capped push | No error handling |
| `src/main.ts:1541` | `getWorldlines` | No error handling |

Calls that **do** show errors (not findings): fork/promote/verify/dispatch/challenge/discard (`src/main.ts`, `src/worldlines.ts`), explorer create/rename/delete (`src/components/explorer.ts:232-250`), settings save toast (`src/main.ts:373`), worldline details (`src/worldlines.ts:667-675` has “computing…” and an error row).

**Proposed fix:** For each row, add a `.catch`/result check and a `toast(..., "error")` or inline empty-state. For search, review, and explorer expand, show a short loading label before the await (the details panel already does this).

---

## 8. Database queries written directly in route handlers

**Status:** none found

This app has no SQL database, no ORM, and no HTTP route handlers.

Search hits were unrelated: `electron/evidence.ts:215` lists `node:sqlite` in a Node-module deny list; `src/editor.ts:533` maps the `.sql` extension to Monaco’s `sql` language.

---

## 9. Synchronous I/O in request handlers

**Status:** findings (4)

There are no HTTP request handlers. The request surface is `ipcMain.handle` in `registerIpc` (`electron/main.ts:5258`). These handlers (or functions they call on the same turn) perform synchronous filesystem I/O on the Electron main process:

| Handler | File:line | Sync I/O |
|---------|-----------|----------|
| `project:list` | `electron/main.ts:5260` → `piNeedsLogin` `4831-4847` | `statSync` + `readFileSync` on `~/.pi/agent/auth.json` |
| `project:open-path` | `electron/main.ts:5271-5272` | `existsSync(cwd)` |
| `terminals:shells` | `electron/main.ts:5306` → `detectShells` `451-462` | `existsSync` on each shell path |
| `session:search` | `electron/main.ts:5533` → `resolveHitPath` `2870-2871` | `existsSync` per token while building hits |

Other sync I/O in `electron/main.ts` (bridge write, mine/edits markdown, journal) runs outside these handlers or on background paths; it is not listed here.

**Proposed fix:** Use the existing `fs/promises` APIs (`stat`, `readFile`, `access`) inside these handlers. Cache `piNeedsLogin` already exists (`loginHint`); keep it, but make the miss path async. `detectShells` can stay a one-time async probe at startup.

---

## 10. List endpoints with no pagination

**Status:** findings (1)

No HTTP list endpoints exist.

IPC list handlers that already bound results (not findings): `session:search` (50 sessions / 50 hits, `electron/main.ts:2807-2844`), timeline buffer caps, `MAX_MINE_FILES`, `MAX_RETAINED_RUNS`, `MAX_MODIFIED_FILES`.

Unbounded list:

| Handler | File:line | Issue |
|---------|-----------|-------|
| `explorer:list-dir` | `electron/main.ts:5608` → `listDir` `5213-5235` | Returns every non-ignored directory entry. No limit, cursor, or page size. |

**Proposed fix:** Cap `entries` (for example 2000) and return `{ entries, truncated: true }` when the cap hits. The explorer already loads directories lazily, so a per-directory cap is enough. Do not add a pagination protocol for in-memory lists of a few projects/terminals.

---

## 11. Inconsistent API response shapes

**Status:** findings (1 family)

IPC responses do not share one envelope. Observed shapes in `electron/main.ts:5258-5650` and `5652`:

| Shape | Examples |
|-------|----------|
| `{ ok: true }` / `{ ok: false, error }` | `project:close`, `file:save`, `review:revert`, most worldline ops |
| `{ cancelled: true }` (no `ok`) | `project:open-path` (`5272`), `openFolder` |
| `{ id }` / `{ error }` (no `ok`) | `terminals:create` (`5301-5303`) |
| `{ path, content }` / `{ path, error }` | `file:open` (`5652`) |
| `{ status, baseline }` | `review:baseline` (`5558-5565`) |
| `{ entries, error? }` | `explorer:list-dir` |
| `{ available, bin, message? }` | `app:pi-status` (`5307-5309`) |
| raw arrays | `project:list`, `terminals:list`, `worldline:list`, `mine:list`, `timeline:get`, `plan:get`, `worldline:runs` |
| raw string | `clipboard:read` (`5288`) |
| `undefined` / void | `terminals:write`, `terminals:resize`, `terminals:abort` |

**Proposed fix:** Use one envelope for mutating/fallible ops: `{ ok: true, ...data }` or `{ ok: false, error }`. Keep list reads as arrays. Add `ok` to `terminals:create` and `file:open` so the renderer does not need `"content" in res` / `res.error` special cases.

---

## 12. Floats used for money instead of integer cents

**Status:** none found

No product money, prices, invoices, or currency fields.

The only `cost` object is a fixture in `scripts/spikes/session-fork.ts:35` (`cost: { input: 0, output: 0, ... }`) matching a pi session usage shape. It is not application money handling.

---

## 13. Dates stored as plain strings instead of ISO 8601

**Status:** findings (1)

Persisted domain timestamps are epoch milliseconds (`number`), not ambiguous date strings: `createdAt: Date.now()` in `electron/worldlines.ts:391,405,885,901,1282,1298`; run `startedAt`/`settledAt` in `electron/main.ts`; evidence `ts: Date.now()` at `electron/main.ts:2081`. Display uses `toLocaleTimeString` / `toLocaleString` in the renderer (`src/timeline.ts:215`, `src/session-search.ts:101`, `src/main.ts:645`). That is not storage.

App-written storage that is a locale date string, not ISO 8601:

| File:line | What |
|-----------|------|
| `electron/main.ts:2693-2701` | `new Date().toLocaleTimeString()` written into `verify-${ownerId}.md` (`## Test run — … — ${stamp}`) |

**Proposed fix:** Write `new Date().toISOString()` (or the existing epoch ms) into the verify context file.

---

## 14. External calls with no retry/backoff

**Status:** findings (2)

The running app does not call third-party HTTP APIs. Network `fetch` in product TypeScript is absent. Test suites fetch `127.0.0.1:9222` (local Chrome DevTools). `core-client` talks to a local stdio process and times out/respawns (`electron/core-client.ts:16-17,112-116`); that is not an external HTTP call.

The packaging script performs two external HTTPS fetches with no retry/backoff:

| File:line | Call |
|-----------|------|
| `scripts/prepare-resources.mjs:26` | `fetch("https://nodejs.org/dist/index.json")` |
| `scripts/prepare-resources.mjs:56` | `fetch(url)` for the Node tarball |

`.github/workflows/release.yml:51-54` retries `electron-builder` once after 15s. That retry does not wrap the Node index/tarball fetches.

**Proposed fix:** Retry those two `fetch` calls with a short bounded backoff (for example 3 attempts, 2s/4s/8s) and the same `!res.ok` throw. Keep it local to `prepare-resources.mjs`.

---

## 15. Stale comments that no longer match the code

**Status:** findings (2)

Searched source comments for leftover architecture (old snapshot worker, “waits forever”, “shared editor”) and checked them against the current code. Only these two no longer match.

| File:line | Comment | Why it is stale |
|-----------|---------|-----------------|
| `src/main.ts:5` | “Right: shared Monaco editor + file explorer” | Each project now has its own `EditorManager` (`src/main.ts:103`). `baseEditor` (`src/main.ts:70`) is only the no-project fallback. |
| `core/src/main.rs:1977-1978` | “The client waits forever for a reply that never comes.” | `electron/core-client.ts:16-17` and `:112-116` time out after 10 minutes and kill the core. |

Comments that still match (not findings): sidecar recovery poll at 300 ms (`electron/sidecar.ts:6-8,74-79`); “legacy generated bridge” cleanup (`electron/main.ts:5022-5024`); “Rust snapshot core replaces the old snapshot worker” in `scripts/build.mjs:22` (historical reason, still true).

**Proposed fix:** Change the renderer header to “per-project Monaco editor”. Change the Rust comment to say the client times out and respawns.

---

## 16. Unvalidated user input

**Status:** findings (6)

The renderer is untrusted relative to the main process. Several IPC handlers take renderer arguments without a runtime type/range check. Path-scoped file ops that go through `managedPath` / `projectAbs` / `isSafeRelativePath` are not listed.

| File:line | Handler | Gap |
|-----------|---------|-----|
| `electron/main.ts:5312-5316` | `terminals:write` | `data` is coerced with `String(data)` and written to the pty with no type or size cap (clipboard and file saves cap bytes). |
| `electron/main.ts:5318-5319` | `terminals:resize` | `cols`/`rows` are not checked as finite numbers. `Math.floor(undefined)` is `NaN`; `Math.max(2, NaN)` is `NaN`. |
| `electron/main.ts:5533` → `2809-2812` | `session:search` | `query` is not checked to be a string. A non-string throws on `.trim()`. |
| `electron/main.ts:5609-5618` | `explorer:create` | `kind` is not checked. Any value other than `"dir"` creates a file. |
| `electron/main.ts:5275-5277` | `project:activate` | `projectId` is not checked to be a string. |
| `electron/main.ts:5482-5487` | `editor:flush-report` | `result` is not validated. A renderer can resolve a flush waiter with an arbitrary object. |

Worldline file reads validate `relPath` (`electron/worldlines.ts:673`). `file:save` / `file:flush-save` check content type and size. `clipboard:write` and `project:open-path` check types. Preferences go through `normalizeAppPreferences`.

**Proposed fix:** Reject non-strings / non-finite numbers at the handler. Cap `terminals:write` (reuse `MAX_PTY_IPC_CHUNK` or a similar budget). Require `kind === "file" \|\| kind === "dir"`. Validate flush `result` as `{ ok: boolean, failed: string[] }`.

---

## 17. API routes missing auth checks

**Status:** none found

There are no HTTP API routes and no multi-user auth.

Privilege is process isolation: the renderer uses the preload `window.pi` bridge (`electron/preload.ts`); it cannot touch the filesystem or pty directly. That is the documented model (`AGENTS.md`). Adding session/JWT checks on local IPC would not match this app.

---

## 18. Missing indexes on frequently queried columns

**Status:** none found

No database, no tables, no query planner. State lives in memory (`Map`s on `PiEditorApp` / `WorldlineManager`) and in the Rust snapshot store (Git objects, not SQL). Nothing to index.

---

## 19. N+1 queries

**Status:** none found

No database query loop. Snapshot work is batched in `termina-core` (`diff-tree`, `ls-tracked`, captures). Renderer lists are in-memory arrays already held by main.

---

## 20. Third-party SDKs initialized in more than one place

**Status:** none found

| SDK | Initialization site |
|-----|---------------------|
| Monaco workers / `MonacoEnvironment` | `src/main.ts:14` only |
| `monaco.editor.defineTheme` | `src/editor.ts:16` only |
| xterm `Terminal` / `FitAddon` / `CanvasAddon` | `src/pty-view.ts:50-60` (per terminal view; one module) |
| `CoreClient` / `coreClient` | `electron/core-client.ts:184` singleton |
| `node-pty` | `electron/pty-terminal.ts:48` (thin wrapper; one module) |

`monaco.editor.create` (`src/editor.ts:95`) and `createDiffEditor` (`src/review.ts:31`) create editor instances after the single environment/theme setup. That is not a second SDK init.

No AWS/OpenAI/Stripe (or similar) client is constructed in application code.

---

## Summary

| # | Check | Status | Count |
|---|-------|--------|------:|
| 1 | Duplicate utility functions | findings | 4 |
| 2 | Secrets committed in config files | none found | 0 |
| 3 | Functions over 400 lines | none found | 0 |
| 4 | Components over 200 lines | findings | 8 |
| 5 | Dead code | findings | 3 |
| 6 | Silent or empty catch blocks | findings | 89 |
| 7 | API calls in the UI missing loading/error states | findings | 12 |
| 8 | Database queries written directly in route handlers | none found | 0 |
| 9 | Synchronous I/O in request handlers | findings | 4 |
| 10 | List endpoints with no pagination | findings | 1 |
| 11 | Inconsistent API response shapes | findings | 1 |
| 12 | Floats used for money instead of integer cents | none found | 0 |
| 13 | Dates stored as plain strings instead of ISO 8601 | findings | 1 |
| 14 | External calls with no retry/backoff | findings | 2 |
| 15 | Stale comments that no longer match the code | findings | 2 |
| 16 | Unvalidated user input | findings | 6 |
| 17 | API routes missing auth checks | none found | 0 |
| 18 | Missing indexes on frequently queried columns | none found | 0 |
| 19 | N+1 queries | none found | 0 |
| 20 | Third-party SDKs initialized in more than one place | none found | 0 |

Checks 8, 12, 17, 18, and 19 do not apply to this architecture (no SQL database, no HTTP API, no money ledger). They were still searched.

Highest-value fixes if a follow-up change is requested: validate IPC inputs (check 16), make the listed IPC handlers async (check 9), add error/loading on the listed UI calls (check 7), and remove the dead compare / `folder:open` / `realHome()` surfaces (check 5).
