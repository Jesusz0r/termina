# Clean Code / YAGNI / KISS — Electron main orchestration

Audit only. No production or test edits. No GitHub issues opened from this pass.

- **Date:** 2026-09-15
- **Tree:** `f66decf998ecb337a79c80a708d5761fedc6112e` (`main`)
- **Rules:** `AGENTS.md` (one owner, YAGNI, 800-line review trigger, renderer never does privileged work)
- **Hunt:** god-class methods, dead IPC, duplicate env builders beyond PATH, unused host seams, 4+ arg functions, LRU paste, comments replacing modules

## Scope

Exclusive domain: Electron app orchestration, IPC, project/workspace, explorer/search, prefs, sandbox, verify, watcher.

**In:** the 19 production files and 29 matching unit tests listed below.

**Out:** `electron/terminal-runtime.ts`, `electron/sidecar*`, `electron/pty-*`, `electron/roster*`, `electron/agent-activity.ts`, `electron/subagents.ts`, `electron/worldlines*`, `electron/worldline-git*`, `electron/evidence*`, `electron/session-fork.ts`, `electron/session-worker.ts`, `electron/session-retention.ts`. Also skipped: `node_modules`, `dist`, `docs/audits/2026-09-13`.

Worldline / terminal / sidecar **methods that still live in `electron/main.ts`** are counted as part of the god file (#323) but are not proposed as new owners or new IPC areas.

Do not recommend new IPC areas. Do not merge candidate/verify filters into `electron/agent-env.ts` (#328).

## Inventory

Every in-scope path appears once. Walked = inventory = matched = **48**.

### Production (19 files / 13,821 lines)

| Lines | Path | Owner note |
|---:|---|---|
| 9128 | `electron/main.ts` | Project/workspace orchestration + IPC. 0 module exports. **#323** |
| 177 | `electron/preload.ts` | Typed `window.termina` bridge only |
| 83 | `electron/preferences.ts` | File store; validator stays in `shared/preferences.ts` |
| 59 | `electron/agent-env.ts` | Primary-agent denylist (`filterAgentEnvironment`) |
| 625 | `electron/sandbox.ts` | Sandbox profiles + candidate/verify allowlists |
| 279 | `electron/plan-board.ts` | Plan parse / progress / dispatch |
| 82 | `electron/schedule.ts` | Schedule tick behind `ScheduleTickHost` |
| 181 | `electron/diagnostics.ts` | Background tsc behind `DiagnosticsHost` |
| 942 | `electron/watcher.ts` | Project FS watcher. **Over 800. New finding F1** |
| 388 | `electron/content-search.ts` | Project content search |
| 588 | `electron/quick-open.ts` | File-name search + path index |
| 427 | `electron/session-search.ts` | Session Search walk (`collectSessionSearchFiles`) |
| 54 | `electron/path-lookup.ts` | Cached realpath / PATH lookup |
| 114 | `electron/verify-detect.ts` | Test/benchmark probes |
| 81 | `electron/verify-map.ts` | One-ticket-one-run map. Unused in prod. **#335** |
| 59 | `electron/window-chrome.ts` | macOS traffic lights / titlebar |
| 281 | `electron/app-update.ts` | Auto-update controller |
| 154 | `electron/cli-install.ts` | `termina` CLI symlink |
| 119 | `electron/prompt-payload.ts` | Prompt payload reader |

### Matching unit tests (29 files / 5,953 lines)

Name match from the brief (prefs, sandbox, watcher, content-search, quick-open, session-search, plan-board, schedule, diagnostics, verify, cli, app-update, ipc-project, main-hardening, explorer-no-replace, flush-save, save-revert, durable-replace, prompt-payload, agent-env, verify-env), plus the prod-file pair `window-chrome.test.ts`.

| Lines | Path |
|---:|---|
| 226 | `tests/unit/electron/prefs-confirm-reset.test.ts` |
| 36 | `tests/unit/electron/sandbox-gate.test.ts` |
| 21 | `tests/unit/electron/sandbox-security.test.ts` |
| 89 | `tests/unit/electron/renderer-sandbox.test.ts` |
| 301 | `tests/unit/electron/watcher.test.ts` |
| 103 | `tests/unit/electron/watcher-generation.test.ts` |
| 92 | `tests/unit/electron/watcher-reconcile-skip.test.ts` |
| 352 | `tests/unit/electron/content-search.test.ts` |
| 623 | `tests/unit/electron/quick-open.test.ts` |
| 271 | `tests/unit/electron/session-search-merge.test.ts` |
| 80 | `tests/unit/electron/plan-board.test.ts` |
| 45 | `tests/unit/electron/schedule.test.ts` |
| 53 | `tests/unit/electron/diagnostics.test.ts` |
| 141 | `tests/unit/electron/verify-detect.test.ts` |
| 57 | `tests/unit/electron/verify-map.test.ts` |
| 137 | `tests/unit/electron/verify-env.test.ts` |
| 267 | `tests/unit/electron/cli-launch.test.ts` |
| 230 | `tests/unit/electron/app-update.test.ts` |
| 305 | `tests/unit/electron/ipc-project-flow.test.ts` |
| 592 | `tests/unit/electron/main-hardening-batch.test.ts` |
| 247 | `tests/unit/electron/explorer-no-replace.test.ts` |
| 391 | `tests/unit/electron/flush-save-lease.test.ts` |
| 716 | `tests/unit/electron/save-revert-lease.test.ts` |
| 238 | `tests/unit/electron/durable-replace.test.ts` |
| 59 | `tests/unit/electron/prompt-payload-read.test.ts` |
| 115 | `tests/unit/electron/agent-env.test.ts` |
| 32 | `tests/unit/electron/agent-environment.test.ts` |
| 69 | `tests/unit/electron/window-chrome.test.ts` |
| 65 | `tests/unit/electron/dispatch-auto-verify.test.ts` |

No `tests/unit/electron/path-lookup*.test.ts`. Coverage-matrix work stays on **#331**.

## Counts

| Metric | Value |
|---|---|
| Production files / lines | 19 / 13,821 |
| Matching unit tests / lines | 29 / 5,953 |
| Inventory paths | 48 |
| Files over 800 lines | 2 (`main.ts` 9128, `watcher.ts` 942) |
| `electron/main.ts` `//` comments | 694 (7.6%) |
| `electron/main.ts` section markers | 20 |
| `ipcMain.handle` channels | 66 |
| `ipcMain.on` channels | 2 (`pty:ready`, `pty:ack`) plus `renderer:capability` sendSync |
| Dead IPC in this domain | 0 |
| Unused host seams | 0 (all three live) |
| Env-builder policy owners | 2 (`agent-env.ts`, `sandbox.ts`); PATH wrap only remains (**#328**) |
| Domain `map.keys().next()` LRU sites | 7 (list under #322) |
| New findings | 2 |
| Already-ticketed classes refreshed | 6 (#323, #328, #322, #326, #335, #320) |

## Already ticketed

Do not open duplicates. Line numbers re-checked on this tree.

### #323 — Split `electron/main.ts` (9128 lines)

Still 9128 lines, 0 exports, 694 `//` comments (7.6%), 20 section markers. The markers do not replace module boundaries.

God-method spans (next-signature heuristic):

| Lines | Start | Method | Domain slice |
|---:|---:|---|---|
| 582 | 7806 | `registerIpc` | IPC validation |
| 342 | 4664 | `handleSidecarEvent` | sidecar (out of exclusive hunt; still in this file) |
| 229 | 1193 | `createWindow` | window |
| 216 | 5069 | `handlePreflightRequest` | run / worldlines |
| 215 | 7152 | `startWatcher` | watcher adapter (owner already exists) |
| 197 | 3261 | `runVerify` | verify |
| 194 | 2938 | `createTerminal` | terminal |
| 142 | 6933 | `closeProjectOnce` | project |
| 130 | 1428 | `buildMenu` | window |
| 80 | 6722 | `openProject` | project |

Explorer mutations (`mutateExplorer`, `renameNoReplace`, `unusedCopyDest`, `listDir`) still sit in the `paths` / `IPC` sections. Extract them with the project-workspace slice of #323. Do not add a second explorer owner or a new IPC area.

### #328 — PATH prefix only

Confirmed. Do **not** merge sandbox filters into `agent-env.ts`.

| Builder | Line | Policy owner | Extra |
|---|---:|---|---|
| `cleanEnv` | 242 | `filterAgentEnvironment` | prepend `resourcesPath/node/bin` if present |
| `candidateEnv` | 266 | `filterCandidateEnvironment` | same PATH prefix via `pathPrefixes` |
| `verifyEnv` | 278 | `filterVerifyEnvironment` (wraps candidate allowlist + HOME/tmp) | same PATH prefix |

Remaining duplication is the bundled-node PATH prepend. One helper or a one-line keep-reason next to spawn. `filterVerifyEnvironment` already reuses `filterCandidateEnvironment` — that is the right reuse, not a third policy.

### #322 — `evictOldest` (domain refresh)

`map.keys().next().value` sites **in this domain**:

| Line | Map | Note |
|---|---|---|
| `electron/main.ts:4408` | `edits` | count cap; can use existing `setBounded` |
| `electron/main.ts:6472` | `inst.baselines` | count **or** byte budget; not a plain `setBounded` |
| `electron/main.ts:6491` | `inst.runSnapshots` | count **or** byte budget |
| `electron/main.ts:6533` | `map` inside `setBounded` | helper already exists |
| `electron/main.ts:7188` | `this.lastWatchChange` | count cap; can use `setBounded` |
| `electron/watcher.ts:881` | `this.lastContents` | count **or** byte budget (+ paired `lastOids`) |
| `electron/diagnostics.ts:110` | `this.lastDiagnostics` | count cap |

`setBounded` (`electron/main.ts:6530`) is already used at 4267, 6573, 6593, 7286. The count-only sites above still paste the idiom beside the helper.

**Not this idiom (do not add):**

- `electron/main.ts:5566` — `Set.values().next()` on `pendingHints`
- `electron/main.ts:5969` — `lastToolAt` time-based cutoff
- `electron/path-lookup.ts:19,33` — `Map.clear()` at size 16 (not LRU)

Out-of-domain sites from #322 (`agent-core/cache.ts`, `electron/subagents.ts`, `src/main.ts`) were not re-walked.

### #326 — 4+ arg functions + Demeter (domain refresh)

Still present:

- `formatSessionHitSnippet(role, text, matchIdx, matchLen)` — `electron/session-search.ts:113`
- Demeter chain — `electron/main.ts:2969` (`workspaces.values().next().value?.id` behind four `??`)
- `applyPreferences(next, persist, activateShortcuts, confirmReset)` — `src/main.ts:788` (renderer; **outside this exclusive domain**)

Additional **4+ positional** signatures in this domain (not on the original ticket list):

| File | Line | Signature |
|---|---:|---|
| `electron/session-search.ts` | 133 | `isProjectFileInRoot(relPath, projectCwd, canonicalize, isFile)` |
| `electron/session-search.ts` | 167 | `resolveSessionHitPath(parsed, projectCwd, canonicalize, isProjectFile)` |
| `electron/quick-open.ts` | 275 | `rankProjectPaths(candidates, rawQuery, truncated, recent)` |
| `electron/quick-open.ts` | 146 | `ensureGitignoreChain(rules, loaded, root, posixDir)` — also **F2** |
| `electron/content-search.ts` | 270 | identical `ensureGitignoreChain` — also **F2** |
| `electron/content-search.ts` | 178 | `ripgrepContentSearch(rg, root, pattern, stop)` |
| `electron/content-search.ts` | 290 | `scanContentSearch(root, pattern, candidates, stop)` |
| `electron/plan-board.ts` | 180 | `pickNamedDispatchTask(plan, taskText, used, pathKey)` |
| `electron/plan-board.ts` | 195 | `pickScopedDispatchTasks(plan, remainingSlots, used, pathKey)` |
| `electron/watcher.ts` | 171 | `ProjectWatcher` constructor (5 args, last three are test seams) |
| `electron/main.ts` | 2058 | `writeEventLeaf(inst, name, content, maxBytes)` |
| `electron/main.ts` | 2079 | `removeBoundEventLeaf(rootPath, root, name, expectedIdentity?)` |
| `electron/main.ts` | 5958 | `toolSnapshot(inst, path, toolName, edits, ev)` (5) |
| `electron/main.ts` | 6464 | `setBaseline(inst, path, value, stateId?)` |
| `electron/main.ts` | 6530 | `setBounded(map, key, value, limit)` |
| `electron/main.ts` | 7404 | `explorerWorkspaceIsLive(projectId, project, workspace, requester)` |
| `electron/main.ts` | 8512 | `saveEditorFile(absPath, content, owner, restore)` |

Worldline 4-arg functions named on #326 stay out of this domain.

### #335 — Dead / test-only exports (domain refresh)

Review per file. Do not bulk-delete. Intended seams stay.

| Export | File | Disposition |
|---|---|---|
| `DiagnosticsHost` (+ `DiagnosticsTerminal`, `DiagnosticsWorkspace`) | `diagnostics.ts` | Type unused outside the file; **seam is live** — main passes an inline object at 655 |
| `ScheduleTickHost` (+ `ScheduleTickTask`) | `schedule.ts` | Same pattern; main wires at 686 |
| `createVerifyMap`, `VerifyMap`, cite types | `verify-map.ts` | **Entire module unused in production.** Only `tests/unit/electron/verify-map.test.ts` imports it. `electron/main.ts` has no `cite` / `ticketFor` call. Test-only until wired or deleted with a keep-reason |
| `writeEvidenceProfile` | `sandbox.ts` | No prod caller. Main uses `evidenceProfileContent` (2464). `scripts/sandbox-security-test.ts` still greps main for `writeEvidenceProfile` — stale |
| `fuzzyScore` | `quick-open.ts` | Test-only wrapper over `fuzzyMatch` |
| `quoteAppleScriptString`, `getCliSourcePath` | `cli-install.ts` | Used internally + pinned by `cli-launch.test.ts` |
| `MAC_TRAFFIC_LIGHTS` | `window-chrome.ts` | Used internally + tests |
| `blobOid` | `watcher.ts` | Internal + `scripts/spikes/tree-delta.ts` |
| Watcher re-exports of `IGNORED_SEGMENTS` / `parseGitignore` / `matchGitignore` | `watcher.ts` | Prod `main.ts` imports `IGNORED_SEGMENTS` from watcher; search modules import from `shared/gitignore.ts`. Barrel exists for spikes |

### #320 — Durable async write (domain refresh)

#320 listed sidecar/trace writers. **This domain has two more copies of the same async + file-sync + parent-sync contract:**

- `electron/main.ts:8418` `durableReplaceFile` — comment says it is “the same sequence as the prefs store and sidecar durable writes”
- `electron/preferences.ts:59` `write`

Do not add atomic rename to `shared/fsync.ts`. Fold these into #320’s “one durable async writer or keep-reason” work, or record that prefs/editor writes stay next to their owners.

### #327 — Docs only

Out of scope for this code audit. No code change recommended here.

## New findings

### F1 — `electron/watcher.ts` exceeds the 800-line trigger (942)

**As-is:** 942 lines, one `ProjectWatcher` class, 62 `//` comments (6.6%). Largest methods: `reconcile` ~99 (`:645`), `emit` ~91 (`:770`), `seedExisting` ~50 (`:893`). Tests already split by concern (`watcher.test.ts`, `watcher-generation.test.ts`, `watcher-reconcile-skip.test.ts`).

**Should-be:** Either a one-line keep-reason that this is a single generation-fenced observer, or extract a cohesive slice with its own lifecycle/test surface (admission queue vs overflow reconcile vs content cache). Shared `generation` / `seen` / gitignore state is the coupling; do not invent a second watcher.

**Not #323.** #323 is `main.ts`. `startWatcher` (~215 lines, `:7152`) is the main-side adapter and travels with that split.

**Done when:** keep-reason recorded, **or** one extraction behind the existing `ProjectWatcher` owner; `pnpm run typecheck` + `tests/unit/electron/watcher*.test.ts`.

### F2 — `ensureGitignoreChain` is copy-pasted (4 args)

**As-is:** Identical private helper in `electron/quick-open.ts:146` and `electron/content-search.ts:270`. The quick-open copy’s comment already says it is “Same nested-load as content-search `ensureGitignoreChain`”. Both take `(rules, loaded, root, posixDir)`.

**Should-be:** One helper. `content-search.ts` already imports `readGitignoreFile` (and `listProjectPaths`) from `quick-open.ts`. Lift the chain loader next to `readGitignoreFile`. Do **not** move live `.gitignore` loading into `shared/gitignore.ts` (parse/match only; watcher comment at `watcher.ts:20` keeps live files on the watcher).

**Done when:** one implementation; both search walks call it; `pnpm run typecheck` + `tests/unit/electron/quick-open.test.ts` + `content-search.test.ts`.

## Hunt results (not findings)

### Dead IPC — none

`registerIpc` (`:7806`) registers 66 `handle` channels plus `pty:ready` / `pty:ack`. Preload invoke/send names match. Push channels used in main all have `on*` bindings on `TerminaBridge`.

e2e-only with a keep-reason (not dead):

- `project:open-path` — documented on the bridge: “the test suites cannot drive the dialog”
- `clipboard:read` — used by `tests/e2e/terminal-clipboard.spec.ts`

Capability gate: every invoke pops the preload-minted capability (`handleIpc` `:917`). Renderer cannot mint it. Do not add IPC areas.

### Unused host seams — none

| Seam | Wired |
|---|---|
| `DiagnosticsHost` | `electron/main.ts:655` |
| `ScheduleTickHost` | `electron/main.ts:686` |
| `PathLookup` | `electron/main.ts:1898` (also `worldlines/bootstrap.ts`, out of hunt) |

`verify-detect.ts` has no `Host` interface; it is a pure probe module. Main and worldlines call the functions. That is KISS, not an unused seam.

### Duplicate env builders beyond PATH — none

Policy already has two owners. Verify wraps candidate. See #328.

### Comments replacing modules — `main.ts` only

20 dash-line section headers in `electron/main.ts` (window, terminals, workspaces, trust, promotion, evidence, verify, plan board, session search, dispatch, mine, user edits, sidecar, run boundaries, fork, project, watcher, paths, IPC, boot). That is the #323 smell. Other domain files are real modules; `createAppUpdater` is 192 lines inside a 281-line file and can stay as the single factory.

### Other keep-reasons

- `canonicalPath` in main (`:7367`, async walk-up for dangling paths) is not `PathLookup.cachedRealpath` (sync, never caches misses). Different contracts.
- `detectDiagnosticsCommand` vs `detectTestCommand` — similar fs probes, different owners, different commands. Leave.
- `SearchGenerations` + `ProjectPathIndex` — used; content search reuses `listProjectPaths`.
- Session search: main orchestrates (`searchSessions` `:3692`); walk lives in `session-search.ts` via the session worker. Correct split.
- Plan parse stays in `plan-board.ts`; tick stays in `schedule.ts`.
- Prefs store vs `shared/preferences.ts` validator — matches AGENTS.md.
- Preload is 177 lines and only exposes the typed bridge. Isolation holds.

## Checks

Docs-only tier: path and command checks.

```text
19 production paths exist
29 matching test paths exist
electron/main.ts = 9128 lines
electron/watcher.ts = 942 lines
```

Not run: typecheck, unit, build, e2e (no code change).
