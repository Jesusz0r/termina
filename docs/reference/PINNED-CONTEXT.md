# Pinned-context adoption tiers

> **Status:** recorded 2026-09-15 for issue #239. This is the owner map
> for source-state and run-context pins. It is not a second pin store.

A **source-state pin** is a capture plus a recheck. The owner records a
content-addressed tree (and the capture commit that names it), then
recaptures before it publishes a result that names that state. The tree
proves stillness: synthetic capture commits embed wall-clock timestamps,
so two captures of identical bytes never share a commit.

A field, type, or comment may say a result is pinned only when that
owner recaptures and fails closed on movement or capture failure. If the
implementation does not recheck, the claim is removed or the surface is
listed here as unpinned.

There is one pin primitive: `core/` capture through
`electron/worldline-git.ts` (`worldlineCaptureHead` in
`electron/worldlines/bootstrap.ts`). Consumers call that API. Do not add
a second registry.

## Tiers

| Tier | Rule |
|---|---|
| **0 — Reference** | Prompt-audit baseline. Already shipped. Cite only. |
| **Must-pin** | A published result names a source or run state and is false if that state moved. Capture, recheck, fail closed. |
| **Should-pin** | A pin would help an audit or a comparison. Not required this wave. |
| **Must-not-pin** | The surface is a live or unbounded stream, or it does not name a source state. A pin would lie or grow without bound. |

Prompt auditing is tier 0. See
[`LAZINESS-BASELINE.md`](LAZINESS-BASELINE.md) and
`scripts/laziness-metrics.ts`. Those files are the reference
implementation. This wave does not edit them.

## Owner map

Each in-scope owner maps to exactly one tier. Status is not a second
tier: it only says whether that tier is done, already shipped, or
deferred.

| Owner | Tier | Status |
|---|---|---|
| `scripts/laziness-metrics.ts` + `docs/reference/LAZINESS-BASELINE.md` | 0 — Reference | Shipped. Fixture numbers are pinned by the unit test. Cite only. |
| `electron/evidence.ts` | Must-pin | **This wave.** `measure` captures a state id, writes it on every evidence record, and rechecks the tree before return. |
| `electron/worldlines/export-candidate.ts` | Must-pin | Already shipped in #191. `metadata.json` records `headStateId` / `headTree`; export recaptures and refuses a moved tree. Do not duplicate. |
| `agent-core` settle (`agent-core/main.ts` settle path) | Must-pin | **Deferred.** Issue #237 owns settle fail-closed this wave (No Quiet Wins + one-ticket-one-run). |
| `core/` + `electron/worldline-git.ts` | Must-pin | Already the pin primitive. They mint and persist state ids. They do not publish a measured result. |
| `electron/worldlines/run-registry.ts` | Should-pin | Retention pin only: settled run ids skip eviction. That is not a source-state recheck. Do not call it a source pin. |
| `electron/worldlines/` comparisons, details, promotion, `bootstrap.ts` | Should-pin | Deferred. Comparisons already share one `baseStateId`. Details capture on demand. Promotion journals are crash-durable. A full capture/recheck on every details read is out of this wave. |
| `electron/session-fork.ts` → `session-worker.ts` | Should-pin | Deferred. A fork already requires a paired session entry and source state. No extra pin store this wave. |
| `electron/plan-board.ts` | Should-pin | Deferred. Plan tasks are live dispatch, not a published source-state artifact. |
| `electron/verify-detect.ts` | Should-pin | Deferred. The test command is already read from a named store state. Not a published result pin. |
| `electron/sidecar.ts` + `electron/sidecar/` (parse/queue/tailer/events) | Must-not-pin | Unbounded JSONL event stream. |
| `electron/terminal-runtime.ts` | Must-not-pin | Live PTY egress and instance map. |
| `electron/session-search.ts` | Must-not-pin | Walk over many session files. |
| `electron/content-search.ts` | Must-not-pin | Project content search. |
| `electron/quick-open.ts` | Must-not-pin | File-name search. |
| `electron/agent-activity.ts` | Must-not-pin | Live idle/working/blocked reducer. Not a snapshot. |
| `electron/subagents.ts` + `agent-core/subagents.ts` | Must-not-pin | Live child stdio and mailbox notes. |
| `electron/diagnostics.ts` | Must-not-pin | Live process metrics. |
| `electron/schedule.ts` | Must-not-pin | Timers. No source-state claim. |
| `electron/roster-store.ts` | Must-not-pin | Roster file. No source-state claim. |
| `electron/terminal-instance.ts` | Must-not-pin | Instance records. No source-state claim. |
| `electron/path-lookup.ts` | Must-not-pin | Path resolve. No source-state claim. |
| `electron/evidence-home.ts` | Must-not-pin | Fresh temp home for an evidence run. Not a state pin. |
| `electron/sandbox.ts` | Must-not-pin | Isolation profiles. Not a context pin. |
| `shared/preferences.ts` + `electron/preferences.ts` | Must-not-pin | Prefs store. Not a source-state pin. |
| `shared/guards.ts` | Must-not-pin | Unknown-value inspectors. |
| `shared/fsync.ts` | Must-not-pin | Durability helpers. |
| `shared/grep-pattern.ts` | Must-not-pin | Pattern validator. |
| `electron/main.ts` | Must-not-pin | Orchestration. Must not become a second pin registry. |
| `src/` | Must-not-pin | Renderer. No privileged pin. Displays records that main already pinned. |

## This wave (must-pin)

**Owner:** `electron/evidence.ts`.

`EvidenceEngine.measure` is the one new pin:

1. Capture the candidate head against the shared base (`captureHead`).
2. Fail closed if the capture throws or omits commit or tree.
3. Write that commit on every returned `EvidenceRecord.stateId`.
4. Recapture after Verify, dependencies, API, footprint, and trajectory.
5. Fail closed if the recapture fails or the tree moved.

`EvidenceRecord.stateId` from `measure` is therefore a real pin. Callers
must not treat a hand-built record in a unit test as a live pin.

Verify's per-run `sourceUnchanged` check stays. That check asks whether
the test command mutated the tree. It is not a second pin store.

`measureBenchmarks` reuses the state id that `measure` already pinned.
It does not recapture. A later candidate change is a manager generation
check, not a second evidence pin. That reuse is recorded so the
benchmark record does not silently claim an independent pin.

## Already pinned (do not redo)

- **Export (#191).** `electron/worldlines/export-candidate.ts` captures
  before gather, recaptures before write, and records `headStateId` and
  `headTree` in `metadata.json`. Tests:
  `tests/unit/electron/worldlines-export-pin.test.ts`.
- **Run retention.** `electron/worldlines/run-registry.ts` keeps run ids
  that a live comparison still names. Eviction pin only.
- **Store capture.** `core/` already mints the ids that consumers pin.

## Deferred reasons

| Surface | Tier | Why deferred |
|---|---|---|
| Agent-core settle | Must-pin | Issue #237 owns settle fail-closed this wave. A pin here would fork that work. |
| Worldline comparisons, details, promotion | Should-pin | Shared `baseStateId` and on-demand details already exist. A capture/recheck on every comparison read is a later audit, not this wave. |
| Session fork | Should-pin | Fork already refuses a point that lacks session or source state. |
| Plan Board | Should-pin | Dispatch is live. No published source-state artifact. |
| Verify-detect | Should-pin | Command body already comes from the captured base blob. |
| Sidecar, PTY, search, activity, subagents | Must-not-pin | Unbounded or live. A pin would be a lie or an unbounded store. |

## Honesty

- `EvidenceRecord.stateId` from `measure` is pinned (capture + recheck).
- Export `headStateId` / `headTree` are pinned (#191).
- Run-registry "pinned" means "do not evict", not "source state rechecked".
- Agent-core settle does not pin this wave.
- Benchmark records inherit the `measure` pin; they do not recapture.
- Renderer labels and comments must not say "pinned" unless this map
  says the owner recertifies.

## Verify

- Path check: this file, the one-line pointer in
  [`WORLDLINES.md`](WORLDLINES.md) §1, and `electron/evidence.ts`.
- `pnpm run typecheck`
- Focused units: `tests/unit/electron/evidence-pin.test.ts` plus the
  existing evidence tests under `tests/unit/electron/`.
