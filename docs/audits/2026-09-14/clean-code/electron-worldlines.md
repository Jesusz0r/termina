# Clean Code / YAGNI / KISS — worldlines, core client, evidence, session fork/retention

Audit only. No production or test edits. No GitHub issues opened.

Date: 2026-09-14 (report committed 2026-09-15). Tree: `main` at `f66decf`.

## Scope

Exclusive domain (callers in `electron/main.ts` read only):

| Slice | Owner | Notes |
|---|---|---|
| `electron/worldlines/` | comparisons / promotion / evidence orchestration / runs | Includes `promotion-recovery/` |
| `electron/worldline-git.ts` + `electron/worldline-git/` | sole public TS client for `core/` | App code must not spawn `git` |
| `electron/evidence.ts`, `electron/evidence-home.ts` | evidence **measures** only | Ranking consumes current evidence |
| `electron/session-fork.ts` → `electron/session-worker.ts` | sole session-fork path | Worker also hosts off-thread search/export/diff/prompt |
| `electron/session-retention.ts` + `electron/session-retention/` | durable retained-session owner | Barrel is the listed entry; directory is the #38 split |

Matching tests (prefix list from the task): `worldlines-*`, `worldline-*`, `evidence-*`, `session-fork-*`, `session-retention-*`, `promotion-*`, `uncertain-*`, `run-registry*`, `core-client*`, `fork-trust*`, `moment-*`, `recording-bootstrap*`, `project-snapshot*`.

Skipped: `electron/main.ts` as primary, sidecar, terminal-runtime, renderer, Rust `core/` internals (signatures only), `node_modules`, `dist`, `docs/audits/2026-09-13`.

`shared/session-retention-lock.ts` is the lock primitive. It is **not** in the exclusive inventory. It is cited only to judge parallel locks.

## Inventory

Walked with `node:fs` line counts. Every path appears once.

### Production — 37 files, 14,031 lines

`electron/session-retention/` (1,750 lines across 5 modules) is included as the implementation of listed entry `electron/session-retention.ts`. Without that split: 32 files, 12,281 lines.

| Lines | Path |
|---:|---|
| 3708 | `electron/worldlines/manager.ts` |
| 1083 | `electron/evidence.ts` |
| 785 | `electron/worldlines/uncertain-comparison.ts` |
| 697 | `electron/worldlines/promotion-recovery/recovery.ts` |
| 589 | `electron/worldline-git/bound-promotion.ts` |
| 546 | `electron/session-fork.ts` |
| 477 | `electron/worldlines/promotion-recovery/bound-dirs.ts` |
| 445 | `electron/session-retention/measure.ts` |
| 439 | `electron/session-retention/ledger.ts` |
| 432 | `electron/session-worker.ts` |
| 402 | `electron/session-retention/owner.ts` |
| 396 | `electron/worldline-git/snapshot-store.ts` |
| 392 | `electron/worldline-git/core-process.ts` |
| 341 | `electron/worldlines/promotion-journal.ts` |
| 334 | `electron/worldlines/types.ts` |
| 333 | `electron/worldlines/export.ts` |
| 325 | `electron/worldline-git/bound-owned.ts` |
| 310 | `electron/session-retention/primitives.ts` |
| 273 | `electron/worldlines/promotion-recovery/journals.ts` |
| 228 | `electron/worldlines/export-candidate.ts` |
| 228 | `electron/worldlines/promotion-recovery/entry-state.ts` |
| 217 | `electron/worldlines/run-registry.ts` |
| 154 | `electron/session-retention/claims.ts` |
| 147 | `electron/worldlines/promotion-recovery/primitives.ts` |
| 135 | `electron/worldlines/bootstrap.ts` |
| 129 | `electron/evidence-home.ts` |
| 95 | `electron/worldline-git/git-reads.ts` |
| 67 | `electron/worldlines/promotion-recovery/manifests.ts` |
| 64 | `electron/worldlines/candidate-files.ts` |
| 56 | `electron/worldline-git/platform.ts` |
| 53 | `electron/worldlines/limits.ts` |
| 38 | `electron/worldlines/guards.ts` |
| 36 | `electron/worldlines/bindings.ts` |
| 26 | `electron/worldlines/index.ts` |
| 23 | `electron/worldline-git.ts` |
| 15 | `electron/session-retention.ts` |
| 13 | `electron/worldlines/promotion-recovery.ts` |

### Matching tests — 37 files, 8,303 lines

| Lines | Path |
|---:|---|
| 1357 | `tests/unit/electron/session-fork-retention.test.ts` |
| 542 | `tests/unit/electron/session-retention-performance.test.ts` |
| 522 | `tests/unit/electron/worldlines-promote-touched.test.ts` |
| 475 | `tests/unit/electron/moment-capture-lease.test.ts` |
| 449 | `tests/unit/electron/promotion-recovery.test.ts` |
| 380 | `tests/unit/electron/worldlines-copy-and-payload.test.ts` |
| 350 | `tests/unit/electron/worldline-runtime-flow.test.ts` |
| 319 | `tests/unit/electron/worldline-export.test.ts` |
| 318 | `tests/unit/electron/worldlines-unit.test.ts` |
| 261 | `tests/unit/electron/worldlines-manager-hardening.test.ts` |
| 259 | `tests/unit/electron/core-client-read-budget.test.ts` |
| 245 | `tests/unit/electron/worldlines-honest-details.test.ts` |
| 231 | `tests/unit/electron/fork-trust-gate.test.ts` |
| 201 | `tests/unit/electron/core-client-retirement.test.ts` |
| 188 | `tests/unit/electron/worldlines-export-pin.test.ts` |
| 187 | `tests/unit/electron/evidence-hardening.test.ts` |
| 165 | `tests/unit/electron/worldlines-candidate-env.test.ts` |
| 153 | `tests/unit/electron/session-fork-worker.test.ts` |
| 153 | `tests/unit/electron/session-retention-wave1.test.ts` |
| 150 | `tests/unit/electron/uncertain-admission.test.ts` |
| 144 | `tests/unit/electron/core-client.test.ts` |
| 142 | `tests/unit/electron/session-fork-architecture.test.ts` |
| 112 | `tests/unit/electron/evidence-home-copy.test.ts` |
| 112 | `tests/unit/electron/evidence-pin.test.ts` |
| 95 | `tests/unit/electron/evidence-dependencies.test.ts` |
| 92 | `tests/unit/electron/evidence-verdicts.test.ts` |
| 89 | `tests/unit/electron/worldlines-changed-files.test.ts` |
| 88 | `tests/unit/electron/session-fork-export-timeout.test.ts` |
| 85 | `tests/unit/electron/run-registry.test.ts` |
| 84 | `tests/unit/electron/promotion-entry-bounds.test.ts` |
| 77 | `tests/unit/electron/worldlines-guards.test.ts` |
| 74 | `tests/unit/electron/fixtures/core-client-stderr-shim.ts` |
| 60 | `tests/unit/electron/moment-hint-wiring.test.ts` |
| 54 | `tests/unit/electron/promotion-path-components.test.ts` |
| 42 | `tests/unit/electron/project-snapshot.test.ts` |
| 39 | `tests/unit/electron/recording-bootstrap.test.ts` |
| 9 | `tests/unit/electron/fixtures/core-client-admission-shim.ts` |

Related but **not** in the matching-prefix inventory: `tests/unit/electron/git-root-classify.test.ts` (bootstrap), `tests/e2e/worldlines.spec.ts`.

## Method

- Read `AGENTS.md` owners and the 800-line extract rule.
- Grepped exports, public `WorldlineManager` methods, lease fields, `git` CLI, challenge profiles, retention locks, section banners, and 4+ argument signatures.
- Cross-checked callers from `electron/main.ts`, tests, and in-domain modules only.
- Did not open issues. Did not recommend a second snapshot/merge implementation.

## Counts

| Class | Count |
|---|---:|
| Production files / lines | 37 / 14,031 |
| Matching test files / lines | 37 / 8,303 |
| New findings | 8 |
| Already-ticketed items in this domain | 3 tickets (#324, #326, #335) |
| Hunt items with no defect | 6 |
| Keep-reasons | 8 |
| Section-comment banners | 9 (all in `manager.ts`) |
| New public 4+ arg signatures beyond #326 | 12 |

## Already ticketed — do not re-ticket

### #326 — 4-arg param objects (this domain)

Still present:

- `boundedWorldlineEntries(path, limit, message, workBudget)` — `uncertain-comparison.ts:231`
- `buildUncertainComparisonLedgerEntry(root, name, safeIds, isClosing)` — `uncertain-comparison.ts:326`
- `promotionParentIdentity(abs, canonicalRoot, canonicalPath, prebound)` — `entry-state.ts:167`

#326 also lists functions outside this domain. This audit does not expand that ticket.

### #335 — unused / test-only exports

Domain samples still unused outside the defining file, or used only by tests/spikes:

- `platformHasCopyOnWrite` — exported from `worldline-git.ts`; no `electron/` caller. `cloneCandidates` always uses `boundPromotionCopyTree`.
- `TrajectorySignals` — exported from `evidence.ts`; only consumed inside that file.
- `dirBytes` re-export on `worldlines/index.ts` — manager imports `./promotion-journal.js` directly; the barrel export has no other caller.
- `promotionRetentionBytes` — exported from `promotion-journal.ts`; only used in that file.
- `setPromotionRecoveryTestHookForTest` — barrel-exported test seam.
- `CoreClient`, `coreClient`, `queueStats`, `CORE_REQUEST_QUEUE_HIGH_WATER_ITEMS`, `decodeTrustHashes` — private `worldline-git/` surface imported by unit tests.

Policy on #335 still applies: review per file; do not bulk-delete.

### #324 — oversize mention

`manager.ts` (3708) and `evidence.ts` (1083) are already named on #324. Line count is a review trigger, not an automatic split. See finding 8 for the one extract that has a distinct lifecycle.

## Hunt results (no defect)

### Dead lease fields

None confirmed.

- `UncertainComparisonAdmissionLease.bind` is written by `UncertainComparisonAdmissionOwner.acquire` and called from `forkRun` / `challengeFromCandidate` / `forkPoint`.
- `SessionRetentionLock.retentionRunId` is set in `session-retention/owner.ts` and read by `agent-core` retained cleanup.
- `BoundPromotionDirectory.capability` is live native-core state, threaded through open/copy/transition.

See finding 5 for a **duplicate type**, which is not a dead field.

### Unused `WorldlineManager` APIs

None. Every public method has a `electron/main.ts` IPC/host caller and/or an in-class caller (`list` → `listWithEvidence`, `setCandidateHead` → `updateHeadState` / evidence, `finishPromotion` → `promote`, `ignoredWrites` → `details` / `promote`).

### Parallel retention lock implementations

None. One primitive: `shared/session-retention-lock.ts` (`acquireSessionRetentionLock` / `releaseSessionRetentionLock`).

Three admission **owners** reuse it:

| Owner | Root locked |
|---|---|
| `SessionRetentionOwner` | retained-session root |
| `UncertainComparisonAdmissionOwner` | `worldsRoot` |
| `PromotionJournalAdmissionOwner` | `worldsRoot` |

Uncertain-comparison and promotion-journal therefore serialize on the **same** lock file (`.termina-retained-session-admission.lock`) under `worldsRoot`. That is coupling, not a second lock. In-process queues (`queueTail`) sit in front of the durable lock. Do not add another lock type.

### Speculative challenge-profile options

None. The closed set is `CHALLENGE_PROFILES` in `shared/types.ts`: `fewer-dependencies`, `preserve-api`, `simpler-implementation`, `performance-first`.

All four have:

- a constraint string in `CHALLENGE_CONSTRAINTS` (`manager.ts:167`)
- a ranking arm in `rankProfiles` (`evidence.ts:906–1022`)
- IPC validation in `electron/main.ts`

`challenge` is a thin wrapper over `forkRun({ challengeProfile })`. `challengeFromCandidate` is a different lifecycle (snapshot live candidate as new A). Not unused options.

### `git` CLI in app code

None in this domain. `worldline-git/` talks to `termina-core`. `dirBytes` spawns `du` (finding 3). `readProcessStart` spawns `ps`. `freeDiskBytes` spawns `df`. Those are not Git.

### Second snapshot / merge path

None. `SnapshotStore.capture` / `merge3` / `template` / `applyState` go through `coreClient.request`. Do not add a TypeScript remplementation.

## Keep-reasons

1. **One core client.** `coreClient` in `worldline-git/core-process.ts` is the process. Wrappers in `git-reads.ts` are the public reads. Do not add a parallel client.
2. **One session-fork path.** `SessionForkClient` → `session-worker.ts` is the only fork. Search, export-patch, line-diff, and read-prompt on the same worker (issue #60) avoid a second worker. That is reuse, not a second fork owner.
3. **One lock primitive.** Reuse of `session-retention-lock` by worldline admission owners is correct. Do not invent a worldline-specific lock.
4. **Four challenge profiles stay.** They are product surface, not speculative knobs.
5. **Tree walks stay separate.** `measureUncertainComparisonTree`, `measurePromotionTreeBytes`, and `measureRetainedClaimTree` share a walk shape but differ in fail-closed policy (symlinks, proofs, saturation). Unifying them is a new abstraction without a matching contract.
6. **`boundedWorldlineEntries` vs `boundedDirectoryEntries`.** Same idiom, different error text and work-budget constants. Incidental duplication; do not extract a third helper unless one call site is deleted.
7. **Journal `engine: "pi"`.** `validatePromotionJournalHeader` (`journals.ts:254`) accepts older on-disk journals. AGENTS.md allows that narrow disk-compat boundary. Do not spread `"pi"` elsewhere (`isCoreRun` is the leftover — finding 7).
8. **`manager.ts` is not an automatic split.** Nine section banners mark methods, not missing modules. Extract only the launch/reopen handshake (finding 8).

## New findings

### 1. Three comparison materializers — duplicate allocation + `ComparisonState`

**Severity:** high (YAGNI / one owner, in-file duplication).

`createComparison` (`manager.ts:1260–1334`) already allocates the directory, writes marker/manifest, and fills `ComparisonState` + two `CandidateState`s.

`challengeFromCandidate` (`manager.ts:704–776`) and `forkPoint` (`manager.ts:2687–2758`) copy that block: `allocateComparisonDirectory`, `rootBinding` from identity, `writeComparisonMarkerBound`, `writeComparisonManifestBound`, the same field list, and the same support-path layout (`{label}-support/{home,sessions,events,tmp,cache}`).

The three paths differ after construction (sessions, template source, candidate count). Construction should go through one helper in `manager.ts`. Do **not** add a new module for this.

### 2. Worldlines barrel re-exports `quoteShellArg`

**Severity:** medium (one owner).

`electron/worldlines/index.ts:10` re-exports `quoteShellArg` from `shared/terminal-control.ts`. `electron/main.ts` imports it from the worldlines barrel.

Shell quoting is not a worldline responsibility. Main (and `sandbox.ts`, `cli-install.ts`, `terminal-drop.ts`) already can import the shared owner. Drop the barrel re-export and migrate the one caller.

### 3. `dirBytes` (`du`) beside native tree measurement

**Severity:** medium (parallel measurement, not a second merge).

`promotion-journal.ts:326–340` spawns `du -sk` for template/candidate budget checks in `forkRun` (`manager.ts:1229`, `1235`).

Promotion admission already walks trees in-process (`measurePromotionTreeBytes`). Uncertain comparison and retained-session accounting do the same.

`du` is a second size implementation with a different fail mode (`Infinity` on error). Prefer the existing native walk, or record a one-line keep-reason that the cap check must stay off the event loop. Do not add a third measurer.

### 4. Three dispose names, one `CoreClient.dispose`

**Severity:** low.

```
disposeWorldlineGitCore          → coreClient.dispose()
disposeWorldlineCoreClient       → disposeWorldlineGitCore()
disposeSessionRetentionCoreClient → disposeWorldlineGitCore()
```

Main shutdown calls `disposeWorldlineGitCore`. Tests call the two aliases so harnesses can drop the shared process. Keep one public name (`disposeWorldlineGitCore` on the core-client owner). The aliases are not a second core.

### 5. Duplicate uncertain-admission lease types

**Severity:** low.

`UncertainComparisonAdmissionLease` and `UncertainComparisonAdmissionOwnerLease` in `types.ts:151–159` are the same shape (`release()`, optional `bind`). Manager types the result as the first; `acquire` returns the second. Collapse to one type.

### 6. Duplicate `MAX_AGENT_RESOURCE_BYTES`

**Severity:** low.

`electron/worldlines/limits.ts:13` and `electron/evidence-home.ts:20` both define `200 * 1024 * 1024`. Evidence-home should import the limits constant. Evidence-home measures; limits already owns the cap.

### 7. Extra 4+ argument signatures (not on #326)

**Severity:** medium (style). Do not reopen #326 for the three already listed.

Worst public / exported ones in this domain:

| Args | Function | File |
|---:|---|---|
| 6 | `mineChangeReason` | `evidence.ts:1065` |
| 6 | `copyBoundBeforeImage` | `entry-state.ts:125` |
| 6–8 | `rollbackPromotion` / `rollbackPromotionPaths` | `recovery.ts:514`, `:302` |
| 5 | `SnapshotStore.capture` / `captureIncremental` | `snapshot-store.ts:186`, `:209` |
| 5 | `loadUncertainComparisonUsageLedger` | `uncertain-comparison.ts:530` |
| 4 | `worldlineCaptureHead` | `bootstrap.ts:110` |
| 4 | `ensureBoundDirectory` | `bound-dirs.ts:292` |
| 4 | `ensureBoundRetainedRoot` | `bound-dirs.ts:364` |
| 4 | `promotionDestination` | `entry-state.ts:152` |
| 4 | `createOwnedDirectory` | `bound-owned.ts:168` |
| 4 | `WorldlineDeps.runSandboxedEvidence` | `manager.ts:250` |
| 4 | `writeRetainedClaim` / `removeRetainedClaim` | `session-retention/claims.ts` |

Several already take an options object at the native boundary (`boundPromotion*`). Prefer that shape for the table above, or record a keep-reason next to each (fail-closed identity args that must stay positional).

### 8. Section comments in `manager.ts` — one extract with a real lifecycle

**Severity:** low as comments; the extract is optional.

Nine banners (`listing`, `details on demand`, `fork-run`, `evidence`, `promote`, `fork any moment`, `session ready`, `control`, `stale sweep`) do not replace modules.

The only slice with a **distinct lifecycle and existing test surface** is the candidate launch / reopen handshake:

- `launchCandidate`, launch-attempt maps, `onSessionReady`, `openTerminal`, pending-ready timers
- Tests: `tests/unit/electron/worldlines-unit.test.ts`

Promote, evidence-queue, and fork-run stay in `WorldlineManager`. They share comparison maps, admission owners, and `WorldlineDeps`. Splitting those by banner would add a second owner.

`evidence.ts` (1083) already has a keep-reason on #324: it only measures. `rankProfiles` is four fixed product arms, not a fifth profile.

## Stale comments (not section banners)

- `types.ts:4` — “`worldlines.ts` re-exports the public surface during the extraction.” The barrel is `index.ts`.
- `manager.ts:1383` — “CoW clone the template… when the volume supports it.” `cloneCandidates` always `boundPromotionCopyTree`; `platformHasCopyOnWrite` is unused in app code (#335).

## Owner map (confirmed)

| Responsibility | Owner | Parallel path? |
|---|---|---|
| Snapshot / merge / git reads | `worldline-git.ts` → `core/` | No |
| Fork preflight / capture / read paths | `worldlines/bootstrap.ts` | No |
| Comparison + promotion + run catalog | `worldlines/` (`RunRegistry` for runs) | No |
| Evidence measurement + ranking | `evidence.ts` | No |
| Evidence HOME dirs | `evidence-home.ts` | No |
| Session fork | `session-fork.ts` → `session-worker.ts` | No |
| Retained session admission | `session-retention/` | No |
| Cross-process lock | `shared/session-retention-lock.ts` | No |

`session-retention/primitives.ts` imports `ensureBoundRetainedRoot` from the worldlines barrel. That is reuse of the bound-directory owner, not a second bind path.

## What not to do

- Do not implement snapshot, merge, or hash in TypeScript.
- Do not add a second session-fork worker or a worldline-specific lock.
- Do not split `manager.ts` by its nine banners.
- Do not bulk-delete exports (#335).
- Do not treat #326’s three names as the full 4-arg set in this domain (finding 7).

## Checks

Docs-only tier.

- Path exists: `docs/audits/2026-09-14/clean-code/electron-worldlines.md`
- Inventory: 37 production paths, 37 matching test paths; walk equals the tables above
- No production or test files edited
- `docs/audits/2026-09-13` not read
