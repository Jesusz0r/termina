# Clean-code audit — electron session

Audit only. No production or test edits. No GitHub issues. No refactors.

**Date:** 2026-09-14  
**Tree:** `main` at `f66decf`  
**Domain:** in-process terminal lifecycle, PTY, sidecar, roster, activity, headless subagent host  
**Lens:** Clean Code, YAGNI, KISS, one owner (`AGENTS.md`)

`docs/audits/2026-09-13/` was not read. #139 is historical and is not a deferred set.

## Scope

In:

- `electron/terminal-runtime.ts`, `electron/terminal-instance.ts`, `electron/terminal-roster.ts`, `electron/terminal-drop.ts`
- `electron/pty-terminal.ts`, `electron/pty-egress.ts`, `electron/pty-bracketed-paste.ts`
- `electron/sidecar.ts`, `electron/sidecar/`
- `electron/roster-store.ts`
- `electron/agent-activity.ts`
- `electron/subagents.ts`
- Matching tests named in the inventory

Out:

- `electron/main.ts` except as caller
- worldlines, session-fork, renderer
- `node_modules`, `dist`, `docs/audits/2026-09-13`
- `electron/diagnostics.ts` (`DiagnosticsHost` is #335 out of this domain)
- `agent-core/subagents.ts` except as the host contract the electron host calls
- `scripts/spikes/terminal-roster.ts`

## Method

Walked every in-scope path once. Grepped production and tests for owners, drain/watch APIs, UTF-8 truncate helpers, atomic writes, viewer APIs, and `export` tokens. Read `AGENTS.md` and open tickets #320, #333, #335 (plus #327 as a docs-only cite). Did not invent behavior.

A finding is **new** only when it is not already filed. Already-ticketed items are listed with extra in-scope cites, not re-opened.

## Counts

| Bucket | Files | Lines |
|---|---:|---:|
| Production | 15 | 6698 |
| Matching tests | 16 | 6036 |
| **Walked** | **31** | **12734** |

Inventory paths = 31. Matched paths = 31. Walked = inventory = matched.

| Status | Count |
|---|---:|
| New findings | 5 |
| Already-ticketed (in-scope cites) | 3 |
| Keep-reasons | 8 |
| 800-line watches | 3 |
| Unused-export rows (in-scope) | 14 |
| Comments-as-sections | 0 |

A class with more than one item is not closed by this report.

## Inventory

Every in-scope path appears exactly once.

### Production

| Path | Lines | Role |
|---|---:|---|
| `electron/terminal-runtime.ts` | 442 | Only in-process lifecycle owner: instance map, spawn/exit, egress, primary tailer, roster store, sidecar queues, generation fence, viewer registry |
| `electron/terminal-instance.ts` | 130 | Plain state holder (PTY + session fields). Lifecycle stays in runtime |
| `electron/terminal-roster.ts` | 158 | On-disk roster shape: parse and cap |
| `electron/terminal-drop.ts` | 198 | Privileged drop path/image helpers (main only) |
| `electron/pty-terminal.ts` | 241 | node-pty adapter: bounded input/output, group kill. Only `@lydell/node-pty` import in this domain |
| `electron/pty-egress.ts` | 848 | Lossless PTY ledger + renderer document identity guards |
| `electron/pty-bracketed-paste.ts` | 89 | DECSET 2004 tracker for late attach |
| `electron/sidecar.ts` | 15 | Parse/tail entry. Re-exports `electron/sidecar/` (#38) |
| `electron/sidecar/events.ts` | 121 | Bounds, marker tokens, `SidecarEvent` union |
| `electron/sidecar/parse.ts` | 222 | JSONL record → event |
| `electron/sidecar/queue.ts` | 319 | Bounded ordered delivery; replaceable snapshots may coalesce |
| `electron/sidecar/tailer.ts` | 2610 | Durable watch/poll, cursors, sealed/retained segments |
| `electron/roster-store.ts` | 146 | Roster file: path, atomic load/save, commit chain |
| `electron/agent-activity.ts` | 217 | Only idle/working/blocked reducer |
| `electron/subagents.ts` | 942 | Only `--subagent-task` spawner. Piped stdio, never node-pty |

### Matching tests

| Path | Lines | Pins |
|---|---:|---|
| `tests/unit/electron/terminal-runtime.test.ts` | 282 | Spawn/adopt, attach/detach, viewers, sidecar admit |
| `tests/unit/electron/terminal-roster.test.ts` | 128 | Parse, model, fit |
| `tests/unit/electron/terminal-drop.test.ts` | 281 | Paths, images, sender |
| `tests/unit/electron/pty-terminal-queues.test.ts` | 141 | Input cap, output split |
| `tests/unit/electron/pty-egress.test.ts` | 1320 | Ledger, identity, no `drain()` |
| `tests/unit/electron/pty-bracketed-paste.test.ts` | 105 | DECSET 2004 + hydrate cite |
| `tests/unit/electron/sidecar.test.ts` | 375 | Queue + tailer ownership |
| `tests/unit/electron/sidecar-races.test.ts` | 284 | Watch/stop races, `watchReady` |
| `tests/unit/electron/sidecar-wave1.test.ts` | 1033 | Pause/resume, wakes, quarantine |
| `tests/unit/electron/sidecar-retirement-race.test.ts` | 471 | Sealed/retained retirement |
| `tests/unit/electron/roster-store.test.ts` | 229 | Load/save/drain |
| `tests/unit/electron/agent-activity.test.ts` | 152 | Reducer folds |
| `tests/e2e/agent-activity.spec.ts` | 104 | Live idle/working/blocked |
| `tests/unit/electron/subagents-host.test.ts` | 816 | Host spawn/settle/kill |
| `tests/unit/electron/subagents-wiring.test.ts` | 99 | Source probes: one host, no pty, viewer subscribe |
| `tests/unit/electron/subagents-sandbox-escape.test.ts` | 216 | Candidate refuse, cwd/claims |

`tests/unit/agent-core/subagents.test.ts` is the registry/contract suite. Out of this domain.

## House-rule checks

| Rule | Result |
|---|---|
| `terminal-runtime.ts` is the only in-process lifecycle owner | **Partial.** Runtime owns the live PTY map, egress, primary tailer instance, roster store, and per-PTY sidecar queues. Main still owns candidate `SidecarTailer` instances and subagent stream watch/stop. See F1 |
| Viewers subscribe; none own the session | **Holds** for teardown: `detachViewer` never calls `stopWatching`. The viewer `Set` itself is write-only in production. See F2 |
| `stopWatching` is destroy-only | **Holds** at the runtime API. Callers also invoke it on the primary tailer after `release` / `stopSidecar` already did. See F1 |
| `sidecar.ts` is the parse/tail entry; writers are agent-core only | **Holds.** Entry re-exports `electron/sidecar/`. No write path in this domain |
| `agent-activity.ts` is the only idle/working/blocked reducer | **Holds.** Main folds `AgentActivityInput` and calls `activityFor` |
| `subagents.ts` is the only `--subagent-task` spawner | **Holds.** One `new SubagentHost`. Piped stdio. Wiring test forbids a pty import |
| Do not dump atomic writes into `shared/fsync.ts` | **Holds.** Tailer `atomicWriteFile` skips fsync on purpose. Roster uses `syncParentDir`. See #320 |
| 800-line trigger is a watch, not an automatic split | Applied. Tailer ~2610 is the named watch. See watches |

## Already ticketed

Do not file these again.

### #333 — shared run-reset helper (ALREADY-TICKETED)

`electron/agent-activity.ts` `agent_start` (122–134) and `agent_settled` (135–147) repeat the same field reset (`openToolIds`, error streak, prompt/preflight flags, `ptyExitedMidRun`). They differ only in the boundary name and `lastSettledError`. The switch is at line 106.

This audit confirms the cite. No new activity finding.

### #320 — one durable async writer; do not expand `shared/fsync.ts` (ALREADY-TICKETED)

In-scope writers:

| Site | Contract |
|---|---|
| `electron/sidecar/tailer.ts:124` `durableAtomicWrite` | async, file sync, parent sync |
| `electron/sidecar/tailer.ts:165` `atomicWriteFile` | async rename only, **no fsync** (intentional cursor throughput) |
| `electron/sidecar/tailer.ts:208` `syncParentDirectory` | async wrapper over `syncDirectoryAsync` |
| `electron/roster-store.ts:111–121` roster `save` | same durable pair as `durableAtomicWrite` (wx, write, sync, rename, `syncParentDir`) |
| `electron/subagents.ts:867–869` result file | sync `writeFileSync` + `renameSync`, no fsync |

#320 listed the tailer pair and the agent-core writers. It did not list the roster commit. The roster path matches the durable async contract and is an extra in-scope site for that ticket, not a new class.

Keep (already in #320): cursor `atomicWriteFile`; subagent result write (sync, mailbox is the fallback). Do not move either into `shared/fsync.ts`.

### #335 — prune dead and test-only exports (ALREADY-TICKETED)

In-scope samples named on the ticket: `DropImage`, `MAX_SUBAGENT_HOST_CHILDREN`, activity exports. `DiagnosticsHost` is `electron/diagnostics` — out of scope.

This audit’s in-scope unused-export table is an input to #335, not a second ticket. Policy unchanged: no bulk-delete.

### #327 — stale sidecar/terminal-runtime docs (out of scope)

Docs still cite `electron/sidecar.ts` as the implementation file. The entry is a 15-line re-export. AGENTS.md already matches code. Docs-only; not this domain’s code.

## New findings

### F1 — Parallel sidecar watch owners (YAGNI / one owner)

**As-is.** Three watch/stop paths exist for one protocol:

1. **Runtime primary.** Constructor builds `this.tailer` when `eventsDir` is set (`terminal-runtime.ts:139–141`). `adopt` records the injected tailer in `sidecarSources` and calls `watch` unless `skipSidecarWatch` (`257–259`). `release` and `stopSidecar` call `stopWatching` (`429–438`).
2. **Main candidate fleet.** `main.ts:2175–2179` does `new SidecarTailer(eventsDir)`, `start()`, `watchReady`, then `worldlineTailers.set`. Teardown is `worldlineTailers.get(id)?.stop()` (`3193–3194`, `6992–6993`, `8914–8915`). Runtime receives that tailer as a spawn option; it does not own the map or `start`/`stop`.
3. **Subagent child streams.** `main.ts:614–617` calls `this.tailer.watch` / `stopWatching` plus `runtime.deleteSidecarQueue`. Those ids never enter `sidecarSources`. Admission is `shouldAdmitSidecar` via `subagents.hasStream`.

Project close then **double-stops** the primary tailer (`6989–6991`):

```text
this.runtime.stopSidecar(id);   // sidecarSources.stopWatching
this.tailer.stopWatching(id);   // same instance for primary terminals
```

PTY exit after-release calls `this.tailer.stopWatching` again (`3195`) after `release` already stopped `sidecarSources`.

**Should-be.** One owner starts and stops every watch. Runtime already has `RuntimeSidecarTailer`, `stopSidecar`, and `deleteSidecarQueue`. Candidate instances can stay distinct (different events dirs) but their lifecycle should sit on the runtime, not a second map in main. Child stream watch/release should go through the same owner. Callers should not pair `stopSidecar` with a second `tailer.stopWatching`.

**Why it matters.** Two stop paths hide whether `stopWatching` is really destroy-only. A recycled `term-N` on the primary tailer can be `stopWatching`’d because a candidate with the same id exited. The house rule already forbids a viewer owning the session; it also forbids a second watch owner.

### F2 — Viewer registry is write-only; query APIs are test-only (YAGNI)

**As-is.** Runtime keeps `viewers: Map<string, Set<string>>` (`terminal-runtime.ts:128`). Production writes it:

- renderer `attach` / `detachViewer` via `RENDERER_VIEWER_ID`
- dispatch `subscribe(..., dispatchViewerId(ownerId))`
- worldline `subscribe(..., worldlineViewerId(...))`
- subagent host `attachSession` / `detachSession` via `subagentViewerId`

Production never reads `viewersOf`, `viewerCount`, or `detachAllViewers`. Those three are used only in `tests/unit/electron/terminal-runtime.test.ts`. `unsubscribeViewer` is live only because `detachViewer` calls it. The wiring test (`subagents-wiring.test.ts:81–88`) pins that subscribe is *called*, not that anyone consults the set.

Detach already proves “viewers do not own the session” by not calling `stopWatching` (`287–288`). The `Set` does not participate in pause, watch, queue, or egress.

**Should-be.** Either one production reader (and then the query APIs earn their keep) or drop the unused query surface. Do not keep `viewersOf` / `viewerCount` / `detachAllViewers` as a public contract with no caller. If the set stays, it needs a stated reason beyond the tests that only observe it.

### F3 — `truncateUtf8Tail` duplicates `utf8TextSuffix` (reuse)

**As-is.** `electron/subagents.ts:194–201` defines a private tail cutter. The same file already imports `truncateUtf8` from `agent-core/subagents.ts`, which is `utf8TextPrefix`. `agent-core/tool-output.ts:127–134` already exports `utf8TextSuffix` — keep the trailing complete UTF-8 characters that fit `maxBytes`. The loop (`start` over continuation bytes) is the same algorithm.

`electron/sidecar/parse.ts:183–189` has a second private prefix cutter (`utf8BytePrefix` on strings) beside `utf8TextPrefix`. That is inbound tool-edit bounding (consumer must not trust the producer). Smaller overlap; not the hunt target.

**Should-be.** Host stdout/stderr caps call `utf8TextSuffix` (or a re-export next to `truncateUtf8`). Do not keep a third UTF-8 cutter in the host.

### F4 — Dead drain / watch / teardown APIs (YAGNI)

PTY egress already forbids a `drain()` API (`pty-egress.test.ts:1312–1314`: every public method except `stats` must have a production caller). The same standard is not applied next door.

**No production caller (this domain):**

| API | Where | Who calls it |
|---|---|---|
| `SidecarTailer.resume` | `tailer.ts:867` | Tests. Pause auto-retries (`2198–2213`: “safety net for consumers which do not explicitly call resume”) |
| `SidecarTailer.isPaused` | `tailer.ts:879` | Tests. Main uses `isHeld` (`3113`) |
| `SidecarTailer.isBacklogOverflowed` | `tailer.ts:894` | Nobody |
| `SidecarTailer.tailWakeCounts` | `tailer.ts:406` | Tests only |
| `TerminalRuntime.cancel` | `terminal-runtime.ts:381` | Nobody. `egress.cancel` is used internally |
| `TerminalRuntime.size` | `terminal-runtime.ts:166` | Nobody |
| `SubagentHost.streamInfo` | `subagents.ts:275` | Host unit tests only |
| `SidecarEventQueue.enqueue` | `queue.ts:159` | Tests. Runtime uses `enqueueTracked` |
| `SidecarEventQueue.dispose` | `queue.ts:230` | Tests. Runtime `Map.delete`s the queue |

`clear()` (`terminal-runtime.ts:170–175`) stops watches and drops the instance map. It does not cancel egress or clear sidecar queues. Shutdown happens to call `disposeEgress` and `clearSidecarQueues` first (`main.ts:8840–8849` then `8913`). The method is not a complete teardown on its own.

**Should-be.** Match the egress rule: a public method without a production caller is removed or marked as a test/diagnostics seam (`stats` is the existing pattern). `resume` stays only if a consumer must skip the 300 ms safety net; today none does.

### F5 — Entry re-exports unused types and a protocol token (YAGNI)

`electron/sidecar.ts` re-exports `SIDECAR_SEALED_PROOF_SUFFIX`, `ToolEdits`, `SidecarEventClass`, `SidecarEventQueueOptions`, `SidecarEventQueueStats`, and `SidecarTailerOptions`. No production file imports those from the entry. `SIDECAR_SEALED_PROOF_SUFFIX` is used inside `tailer.ts` and duplicated as a private const in `agent-core/main/sidecar.ts` (writer side; out of scope).

Live entry imports: `SidecarEvent`, `SidecarEventDelivery`, `SidecarTailer`, `SidecarEventQueue`, `parseSidecarRecord`, `sidecarEventFromRecord`, `MAX_SIDECAR_BYTES`, `AgentStartEvent`.

**Should-be.** Re-export only what callers import, or keep a type as an explicit public contract with a one-line reason. Fold into #335; listed here because the entry is in this domain.

## Keep-reasons

1. **Tailer `atomicWriteFile` without fsync.** Cursor throughput. App-crash redelivery is one event. #320 already narrowed this. Do not add rename+fsync to `shared/fsync.ts`.
2. **Subagent result write without fsync.** Sync rename; mailbox note is the fallback. Different contract from durable async writers.
3. **Candidate needs its own `SidecarTailer` instance.** Different `TERMINA_EVENTS_DIR`. That does not justify main owning `start`/`stop`/`watchReady` (F1). The instance can stay distinct under the runtime.
4. **`AgentTerminalInstance` field bag.** By design a state holder. Main mutates timeline/baselines/plan. Not a second lifecycle owner.
5. **`PtyEgressScheduler.stats`.** Documented test/diagnostics seam. Production-caller rule already excludes it.
6. **`SidecarEventQueue.dispose` unused in production.** Runtime drops the map entry and does not await handlers. Different from `drain()`. Keep only if a shutdown path must reject in-flight acknowledgements; today it does not call it.
7. **Parse-side edit bounding.** Consumer caps must not trust producer `edits`. Sharing `utf8TextPrefix` is optional; the responsibility is not a second parser.
8. **`lastResultFrame` export.** Host unit tests pin the last framed line. Behavioral test, not a dead export.

## 800-line watches

Line count is a review trigger, not an automatic split. Section comments do not replace a module boundary.

| File | Lines | Watch |
|---|---:|---|
| `electron/sidecar/tailer.ts` | 2610 | Named watch. One lifecycle (cursors, sealed/retained, watch/poll). No banner sections. Do not split on line count alone |
| `electron/subagents.ts` | 942 | One host: admit, spawn, settle, result, mailbox. Header already defers stream-UI (slice 2b). No split without a second lifecycle |
| `electron/pty-egress.ts` | 848 | Scheduler plus renderer identity guards (`isPty*`, `sendPtyRendererMessage`). Identity is used by main, not by the pump. Cohesion watch only |

`electron/sidecar/queue.ts` (319), `parse.ts` (222), `events.ts` (121) are already the #38 split. The 15-line entry is the public surface.

## Unused exports (in-scope)

Inputs to #335. Not a bulk-delete list.

| Export | File | Outside defining file | Note |
|---|---|---|---|
| `DropImage` | `terminal-drop.ts:30` | No | Named on #335 |
| `MAX_SUBAGENT_HOST_CHILDREN` | `subagents.ts:41` | No | Named on #335. Used as the default `maxChildren` |
| `IDLE_ACTIVITY` | `agent-activity.ts:16` | No | Named on #335 (activity exports) |
| `isStalledSettleError` | `agent-activity.ts:84` | No | Internal to `activityFor` |
| `PTY_EXIT_DRAIN_TIMEOUT_MS` | `terminal-runtime.ts:30` | No | Used only in `spawn` |
| `RENDERER_VIEWER_ID` | `terminal-runtime.ts:84` | No | Used only inside runtime |
| `MAX_SUBAGENT_HOST_CHILDREN_USER` | `subagents.ts:44` | No | Internal cap |
| `SUBAGENT_MAX_ATTEMPTS` | `subagents.ts:46` | No | Default option |
| `SUBAGENT_RETRY_BACKOFF_MS` | `subagents.ts:48` | No | Default option |
| `SUBAGENT_STDOUT_CAP_BYTES` | `subagents.ts:50` | No | Internal |
| `SUBAGENT_STDERR_CAP_BYTES` | `subagents.ts:52` | No | Internal |
| `SUBAGENT_NOTE_RESULT_CHARS` | `subagents.ts:54` | No | Internal |
| `SUBAGENT_NOTE_TASK_CHARS` | `subagents.ts:56` | No | Internal |
| `SIDECAR_SEALED_PROOF_SUFFIX` (entry) | `sidecar.ts:9` | No importer of the entry | Used inside tailer; writer has its own copy |

Test-only (keep if a behavioral test pins them): `lastResultFrame`, `streamInfo`, `SidecarTailer.resume` / `isPaused` / `tailWakeCounts`, `viewersOf` / `viewerCount` / `detachAllViewers`, `SidecarEventQueue.enqueue` / `dispose`.

## Comments-as-sections

None in this domain. No `// ----` / `// ===` banners. Tailer documents maps with field JSDoc; that is not a substitute module. `electron/main.ts` still has `// ------------------------------------------------------------- verify ----` — caller only, out of scope.

## What is already tight

- One `PtyTerminal` / one `node-pty` import.
- One `SubagentHost`; children cannot get a pty (wiring test).
- Activity is one reducer; main only folds and displays.
- Roster parse vs file store vs runtime save/drain is a clean seam.
- `detachViewer` does not pause PTY, sidecar, or session.
- Egress already deleted `drain()` and pins production callers.

## Checks

Docs-only tier: path and command checks.

```text
test -f docs/audits/2026-09-14/clean-code/electron-session.md
wc -l <inventory paths>
```

Walked 31, inventory 31, matched 31.

Not run: `pnpm run typecheck`, unit, e2e, build. No code changed.

## Out of scope notes (do not ticket from this page)

- Main one-line wrappers `drainSidecarQueues` / `clearSidecarQueues` / `enqueueSidecarEvent` (`main.ts:4652–4661`).
- Writer-side `SIDECAR_SEALED_PROOF_SUFFIX` / `SIDECAR_QUARANTINE_PREFIX` copies in `agent-core/main/sidecar.ts`.
- `utf8TextPrefix` vs parse `utf8BytePrefix` (optional reuse; consumer bounding stays).
