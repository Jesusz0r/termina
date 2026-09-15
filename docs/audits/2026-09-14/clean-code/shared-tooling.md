# Clean Code / YAGNI / KISS — shared contracts, scripts, website, docs-as-code, test infra

**Audited:** 2026-09-15  
**Wave folder:** `docs/audits/2026-09-14/clean-code/`  
**Mode:** audit only. No production or test edits. No GitHub issues. No refactors.  
**Tree:** `main` at audit start (`0.1.43`). Line counts are `wc -l`.

## Scope

In: `shared/`, `scripts/` (including `scripts/spikes/`), `website/`, `docs/reference/`, `docs/README.md`, AGENTS.md / CONTRIBUTING.md / RELEASING.md as drift vs code only, root configs (`package.json` scripts, `tsconfig*.json`, `vitest.config.ts`, `playwright.config.ts`, `vite.config.ts`, `electron-builder.yml`, `.github/workflows/`), `tests/e2e/fixtures.ts` plus `tests/e2e/owned-processes.ts` / `tmpdir.ts` as the isolation harness, `tests/unit/build/`, `tests/unit/scripts/`, `tests/unit/website/`, `tests/unit/docs/`, `bin/termina`.

Out as primary: `electron/`, `agent-core/`, `core/`, `src/`. Grepped only to prove a shared export is live or dead.

Skipped: `docs/audits/2026-09-13`, `.pnpm-store`, `node_modules`, `dist-*`, `src/theme-tokens.gen.ts`.

`AGENTS.md` was read and is **not** rewritten. Owner lines for `shared/preferences.ts`, `shared/guards.ts`, `shared/fsync.ts`, and `shared/grep-pattern.ts` match the files.

## Method

- Named-export scan of `shared/*.{ts,js}` (119 exports), then identifier search outside the defining file.
- `package.json` script graph vs CI, other scripts, docs, and tests (`pnpm run <name>`).
- Duplicate `isRecord` / `errorCode` / `isErrno` / fsync helpers.
- Path checks for documented scripts (`e2e.mjs`, `prepare-resources.mjs`, `worldline-*-test.mjs`, `docs/archive/`).
- Website install/copy commands vs `scripts/install.sh` and `tests/unit/website/install-commands.test.ts`.
- Already-open tickets #320, #325, #327, #331, #335 re-validated against this tree; not re-filed.

## Inventory

| Slice | Files | Lines | Notes |
|---|---:|---:|---|
| `shared/` | 16 | 2 198 | 14 `.ts` + `process-identity.js` + `.d.ts`. `wc` double-counts the `.d.ts` if globbed twice. |
| `scripts/` root (incl. README) | 35 | 5 763 | #325 said 31 / 5 641. This pass includes README, `.sh`, and the sandbox-security cluster. |
| `scripts/` root code only | 34 | 5 746 | Exclude `scripts/README.md` (17). |
| `scripts/spikes/` | 18 | 5 923 | 305 295 bytes (~298 KiB). #325 said 332 K. |
| `website/` html/js/css | 4 | 2 291 | `index.html` 542, `guide.html` 537, `app.js` 254, `styles.css` 958. Assets not counted. |
| `docs/reference/` + `docs/README.md` | 10 | 3 508 | `WORLDLINES.md` 1 618 is the bulk. |
| AGENTS / CONTRIBUTING / RELEASING | 3 | 327 | Drift only. |
| `tests/unit/build/` | 7 | 1 539 | Includes `prepare-resources.test.ts` 862. |
| `tests/unit/scripts/` | 16 | 2 320 | Probe tests sit next to build/theme tests. |
| E2E isolation harness | 3 | 407 | `fixtures.ts` 256, `owned-processes.ts` 116, `tmpdir.ts` 35. |
| `tests/test-support.ts` | 1 | 70 | Callback reporter used by `test-infra.test.ts`. |
| Root configs + workflows + `bin/termina` | 11 | 723 | `release.yml` 193, `bin/termina` 194. |
| `package.json` scripts | 29 | — | See unused-script table. |
| Shared named exports | 119 | — | 24 unused outside the defining file. |

### `shared/` by file

| File | Lines | Dedicated unit test | Role |
|---|---:|---|---|
| `types.ts` | 778 | none (consumed everywhere) | IPC / prefs / worldline contracts. Near the 800-line review trigger. |
| `session-retention-lock.ts` | 473 | none under `tests/unit/shared/` | Full admission-lock implementation, not types only. |
| `preferences.ts` | 232 | `tests/unit/shared/preferences.test.ts` | Only prefs validator (AGENTS.md). |
| `gitignore.ts` | 220 | `gitignore-bounded` + `ignored-segments` | Pattern compiler. |
| `line-diff.ts` | 121 | via `tests/unit/electron/issue-60-main-loop.test.ts` | Paint lines. |
| `commands.ts` | 90 | `menu-tui-scope.test.ts` | Command registry. Re-exported from `types.ts`. |
| `grep-pattern.ts` | 53 | via `harness-kernel.test.ts` | Only grep-pattern validator. |
| `process-identity.js` + `.d.ts` | 44 + 1 | via `owned-processes.test.ts` | JS + decl, not TypeScript. |
| `fsync.ts` | 39 | via electron durable-write tests | fsync only. Do not add writers (#320). |
| `canonical-path.ts` | 35 | `canonical-path.test.ts` | Renderer-safe macOS aliases. |
| `agent-environment.ts` | 26 | none | Session-env consume. |
| `guards.ts` | 22 | none under `tests/unit/shared/` | `isRecord` / `errorCode` / `isErrno` only. |
| `unsaved-close.ts` | 22 | `unsaved-close.test.ts` | Close decision. |
| `terminal-control.ts` | 21 | via harness / pty tests | CSI + `quoteShellArg`. |
| `plan-task.ts` | 21 | none under `tests/unit/shared/` | Plan Board regexes. |

Six files under `tests/unit/shared/` cover four modules. The rest are exercised from electron / agent-core / scripts tests. Module↔test matrix is **#331** (already ticketed).

## Already ticketed — do not re-file

### #320 — do not expand `shared/fsync.ts`

Holds. `shared/fsync.ts` exports `syncDirectory`, `syncDirectoryAsync`, `syncParentDir` only. Callers: electron preferences / roster / main / sidecar tailer, agent-core sidecar / auth / trace, session-retention lock.

Parallel fsyncs that must **not** move here:

- `agent-core/session/descriptors.ts` `fsyncDirectory` / `fsyncDirectoryDescriptor` / `fsyncDirectoryAndParent` — fd-anchored session durability, different contract.
- `electron/sandbox.ts` raw `fsyncSync` on a profile file.
- `electron/sidecar/tailer.ts` `syncParentDirectory` — thin async wrapper over `syncDirectoryAsync` (listed in #320).
- File-level `fsyncSync` next to atomic writes in agent-core sidecar / auth / session bundles.

No second fsync owner in `shared/`. Do not add atomic rename to this module.

### #325 — archive `scripts/spikes/` and consolidate provider probes

Holds. This pass:

| Claim in #325 | This tree |
|---|---|
| 18 spike files | 18 |
| 332 K | 305 295 bytes (~298 KiB) |
| Root `scripts/` 31 / 5 641 | 35 / 5 763 including README; 34 / 5 746 code |
| `promotion-native-boundary.ts` 1 562 | 1 562 |
| `capture.ts` 1 334 | 1 334 |
| Probe sizes | cache 259, breakpoint 202, xai 179, opencode 172, transport 169 — match |

`test:native` runs 9 spikes. **Not** in the release graph: `core-inc-bisect`, `core-latency-probe`, `divider-probe`, `owned-cleanup`, `promotion-retention`, `store-lifecycle`, `tree-format-validate` (plus helpers `owned-fixtures.ts`). `scripts/README.md` still says probes are “kept deliberately.” That is the ticket, not a keep-reason against it.

`tsconfig.json` `include`s `scripts/`, so unused probes and spikes fail `pnpm run typecheck`. Archiving them shrinks the typecheck tax.

### #327 — stale sidecar / terminal-runtime paths

Holds. Still present: `docs/reference/WORLDLINES.md` 517, 1185, 1290; `docs/reference/PINNED-CONTEXT.md` 54–55. AGENTS.md owner lines match code.

This ticket does **not** cover the larger WORLDLINES test-plan drift below (new finding).

### #331 — module↔test matrix (knip not required)

Holds. 6 dedicated `tests/unit/shared/` files for 16 shared modules. No published matrix. knip is not installed and is not required.

### #335 — unused shared exports (full proof)

Holds. Shared-only subset of that inventory (24 names unused **outside the defining file**):

**Unexport candidates** (never imported; not TerminaBridge members):

- `commands.ts`: `CommandCategory`, `CommandScope`, `CommandDefinition`
- `gitignore.ts`: `GitignoreSegment`
- `types.ts`: `AGENT_ACTIVITY_STATES`, `AGENT_ACTIVITY_REASONS` (only feed local types)
- `unsaved-close.ts`: `UnsavedCloseDecision` (return type is inferred)

**Contract keep** (named only as `TerminaBridge` / same-file members; intended public surface per #335 policy):

`FileChangedPayload`, `ToolTargetPayload`, `FileDeletedPayload`, `ModifiedListPayload`, `BusyPayload`, `PlanPayload`, `PtyDataPayload`, `PtyExitPayload`, `PtyModesPayload`, `AgentStatusPayload`, `WorldlineUpdatePayload`, `WorldlineRemovedPayload`, `WorldlineEvidencePayload`, `LoginHintPayload`, `ProjectListItem`, `FileSearchSource`, `ContentSearchSource`.

No test-only shared exports. Do not bulk-delete. Triage stays on #335.

## New findings

Severity is review priority, not a product defect class.

### 1. Contributor and release docs teach commands the tree does not run — P2

`GOVERNORS.md` already records one of these. The rest are still live.

| Path | Claim | Reality |
|---|---|---|
| `CONTRIBUTING.md:46` | `node scripts/e2e.mjs --skip-build worldline-capture-test.mjs` | Neither file exists. Entry is `pnpm run test:e2e`. Named in `GOVERNORS.md:125`. |
| `CONTRIBUTING.md:32` | `scripts/` is “the e2e suites, the launcher, and the build steps” | E2E lives in `tests/e2e/`. `scripts/` is build + probes + spikes + measurement. |
| `CONTRIBUTING.md:31` | `shared/` is “types shared between main, preload, and renderer” | Also validators, fsync, gitignore, locks, process identity. |
| `RELEASING.md:113–114` | `install.sh` “downloads the prebuilt core … no cargo and no git required” | `scripts/install.sh` requires Node ≥ 22.19, pnpm, and cargo; builds from the checkout; refuses a pipe. Pinned by `tests/unit/build/install-source.test.ts` and `tests/unit/website/install-commands.test.ts`. |
| `RELEASING.md:103` | Sign nested binaries in `scripts/prepare-resources.mjs` | File is `scripts/prepare-resources.ts`. `make-icon.test.ts` already forbids a leftover `.mjs` for `render-icon`. |
| `README.md:105` | `test:spikes` = “capture · merge · platform · tree-delta” | Script is `test:native` (9 suites) plus `platform`. |
| `README.md:109` | `pnpm test` = “typecheck + agent-core + build + spikes” | Script is `typecheck && test:unit`. |
| `README.md:135` | `scripts/` is “the e2e suites…” | Same stale layout as CONTRIBUTING. |
| `README.md:137` | Completed phase records under `docs/archive/worldlines/` | Directory does not exist. |
| `docs/README.md` | Lists 3 of 9 reference docs | Missing GOVERNORS, TOOLING-WATCH, CALIBRATION, AUDIT-LEDGER, PINNED-CONTEXT, LAZINESS-BASELINE. |

AGENTS.md is current. Do not “fix” it to match the stale contributor docs.

### 2. `WORLDLINES.md` still documents deleted `.mjs` suites — P2

Beyond #327’s sidecar cites, the Phase 3 / test-plan sections name files that are gone:

- `scripts/build.mjs`, `scripts/dev.mjs` (`WORLDLINES.md:1217–1218`)
- `scripts/worldline-preflight-test.mjs`
- `scripts/worldline-capture-test.mjs` (also CONTRIBUTING)
- `scripts/worldline-isolation-test.mjs` — `tests/unit/docs/support-contract.test.ts:50` slices the doc at this heading
- `scripts/worldline-fork-run-test.mjs`
- `scripts/worldline-any-moment-test.mjs`
- `scripts/worldline-evidence-test.mjs`
- `scripts/worldline-challenge-test.mjs`
- `scripts/worldline-promote-test.mjs`
- `scripts/worldline-trust-test.mjs`
- `scripts/worldline-cleanup-test.mjs`

Also `electron/worldlines.ts` and `electron/pty-terminal.ts` as “files expected to change.” Owners today are `electron/worldlines/` and `electron/terminal-runtime.ts`.

This is docs-as-code drift, not a sidecar-path ticket. Path/command checks fail on every heading.

### 3. Dual user guides have already drifted — P2

`docs/reference/USER-GUIDE.md` (546) and `website/guide.html` (537) are two maintained copies of the same product guide. `support-contract.test.ts` pins only sandbox/MCP phrases.

Observed drift (website guide behind the repo guide):

| Topic | `USER-GUIDE.md` | `website/guide.html` |
|---|---|---|
| Settings sections | General + Appearance + Keyboard; “Open files the agent edits” | Appearance only |
| Content search | `Cmd/Ctrl+Alt+F` in the shortcut table | Absent |
| Timeline fork | Click **or** Enter on a dot; Esc dismisses review | Click only |
| Quick Open vs TUI | Notes Ctrl+P cycles models in a core terminal | “Quick Open a project file by name” only |

That is two owners for one user-facing contract. KISS: one source, or generate the site page from the markdown.

### 4. Website claims that imply extra install / platform surface — P3

Install commands themselves are honest. `install-commands.test.ts` forbids a piped installer and requires Node / pnpm / cargo on the source pane. The site does **not** advertise `TERMINA_EVENTS_DIR`, `TERMINA_BIN`, `TERMINA_APP_PATH`, `CARGO`, or `TERMINA_SKIP_CORE_BUILD`.

Claims that still add implied setup:

| Claim | Where | Why it is extra surface |
|---|---|---|
| “Two minutes from download to your first worldline” | `index.html` install H2 + final CTA | Worldlines need a Git repo and macOS sandbox helpers. Linux AppImage download cannot complete that sentence. `guide.html` already says candidates are macOS-only. |
| Ticker: “sandbox-exec isolation”, “APFS copy-on-write forks” | `index.html` ticker | macOS-only mechanisms presented as the product. |
| “~7× faster snapshots” + “ratios predate the single-boundary timing fix — re-measurement pending” | bench note | A pending number is still a public performance claim. |
| SVG comment `<!-- PI TUI -->` | architecture figure | Retired “pi” name next to “agent”. |
| Mockup model `gemini-2.5-pro` | cockpit | Pins a vendor/model in marketing. |

`bin/termina` adds `TERMINA_APP_PATH` / `TERMINA_BIN`. Those are launcher escapes, not website knobs. Keep them off the site.

Closed #290 is headline copy only. Not this finding.

### 5. Unused `package.json` scripts — P3

29 scripts. CI and the release graph use the typecheck / unit / native / macos gate. These four have **zero** `pnpm run` / docs / CI references:

| Script | Body | Why it looks dead |
|---|---|---|
| `start` | `electron .` | Needs a prior `build`. Not in CONTRIBUTING or CI. |
| `dist` | build + `prepare-resources.ts` + `electron-builder` | Release workflow runs those steps inlined, not this alias. |
| `dist:dir` | same + `--dir` | No hits outside `package.json`. |
| `dist:mac` | same + `--mac` | No hits. Useless on Linux CI. |

Overlapping **focused** aliases (used only as convenience / graph pins, not unused):

- `test:agent-core` = harness-kernel only
- `test:agent-core-focused` = `tests/unit/agent-core/`
- `test:agent-core-main` = `main-*.test.ts`
- `test:release-core` / `test:release-workflow` = single files already inside `test:unit`

`release-graph.test.ts` correctly keeps the last two **out** of `test:release`. The three `test:agent-core*` names are YAGNI unless a human workflow needs all three.

`report:agent-core` is documented in `AGENT-CORE.md`. Keep.

### 6. Dead or spike-only script helpers — P3

| File | Lines | Callers |
|---|---:|---|
| `scripts/wait-for.ts` | 10 | **None.** Local `waitFor` copies live in electron unit tests and spikes. |
| `scripts/e2e-port.ts` | 11 | Only `scripts/spikes/divider-probe.ts`, which is not in `test:native`. Reads `TERMINA_E2E_PORT` — leftover of the deleted `scripts/e2e.mjs` runner. |

`wait-for.ts` is a 10-line poll helper with no import. Delete with #325 or on its own.

### 7. Duplicate `isRecord` in an in-scope script — P3

Canonical owner is `shared/guards.ts`. In-scope duplicate:

```50:52:scripts/laziness-metrics.ts
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

`shared/guards.ts` uses `Boolean(value) && typeof value === "object" && !Array.isArray(value)` — same predicate. `scripts/audit-ledger.ts`, `handoff-check.ts`, and `trace-baseline.ts` already import the shared helper.

Out of primary scope (do not ticket from this audit): the same local copy in `tests/unit/agent-core/token-calibration.ts` and `tests/unit/agent-core/provider-probe.ts`.

### 8. Test-infra overlap and mis-shelving — P3

Not a second e2e runner. Isolation in `tests/e2e/fixtures.ts` matches AGENTS.md (fresh roots, Playwright Electron, owned cleanup).

YAGNI / locality:

- `tests/unit/scripts/owned-processes.test.ts` tests `tests/e2e/owned-processes.ts`. The file is shelved under scripts because the spike runner shares the idea, not because it tests a script.
- `tests/unit/build/test-infra.test.ts` and `release-graph.test.ts` both pin `package.json` script strings (`test:agent-core-*`, `test:e2e`, `test:release`).
- `tests/unit/build/prepare-resources.test.ts` is 862 lines — over the 800-line review trigger, same as `scripts/prepare-resources.ts` (794).
- Callback reporter (`tests/test-support.ts`) is a second assertion style next to Vitest `expect`. Justified for leftover spike-shaped checks; do not grow it.

`pages.yml` still uses floating action tags. `TOOLING-WATCH.md` already records that as a retained deviation. Not a new finding.

## Watch / keep-reasons (not findings)

| Item | Why it stays |
|---|---|
| `shared/types.ts` 778 lines | One IPC/prefs contract. `commands.ts` is already extracted. Do not split for the 800-line trigger alone. |
| `shared/session-retention-lock.ts` 473 | One admission lock for agent-core and electron. Size is implementation, not a second owner. |
| `process-identity.js` | Node-only, imported as `.js` from TS. Dual `.d.ts` is small. |
| Live probes off `package.json` | `scripts/README.md` + GOVERNORS + TOOLING-WATCH. Money + credentials. Disposition is #325. |
| Measurement scripts (`laziness-metrics`, `trace-baseline`, `audit-ledger`, `handoff-check`, `perf-*`) | Documented governors / watches. Not request-path. |
| Sandbox-security cluster (~1 188 lines, 6 files) | Live gate + policy + lifecycle. Wired as `test:sandbox-security-live` on macOS release. |
| `CARGO` / `TERMINA_SKIP_CORE_BUILD` in `install.sh` | Installer escapes, unset on purpose. Not website config. |
| AGENTS.md shared owners | Match the files. No rewrite. |

## Counts

| Metric | Count |
|---|---:|
| New findings | 8 |
| Already-ticketed items re-validated | 5 (#320, #325, #327, #331, #335) |
| Shared modules | 16 |
| Shared named exports | 119 |
| Unused outside defining file | 24 (7 unexport candidates, 17 TerminaBridge keep) |
| Dedicated `tests/unit/shared/` tests | 6 |
| `package.json` scripts | 29 |
| Scripts with zero external `pnpm run` | 4 (`start`, `dist`, `dist:dir`, `dist:mac`) |
| Spike files / lines | 18 / 5 923 |
| Root script files / lines | 35 / 5 763 |
| Duplicate `isRecord` in `scripts/` | 1 (`laziness-metrics.ts`) |
| Duplicate fsync owner in `shared/` | 0 |
| Stale documented `.mjs` paths (WORLDLINES + CONTRIBUTING) | 12+ |
| Dual user-guide owners | 2 |

## Top findings (short)

1. **P2 — Docs teach deleted commands.** CONTRIBUTING `e2e.mjs`, RELEASING “no cargo” / `prepare-resources.mjs`, WORLDLINES `worldline-*-test.mjs` + `build.mjs`, README `docs/archive/` and stale `pnpm test` graph.
2. **P2 — Two user guides.** `USER-GUIDE.md` and `website/guide.html` already disagree on settings, content search, and fork chords.
3. **P3 — Dead aliases and helpers.** `start` / `dist` / `dist:dir` / `dist:mac`; `scripts/wait-for.ts`; `e2e-port.ts` + `divider-probe`.
4. **P3 — Local `isRecord` in `laziness-metrics.ts`.** Import `shared/guards.ts`.
5. **P3 — Website “first worldline” / ticker / 7×.** Implies macOS+Git setup the AppImage path cannot deliver; bench note admits the ratio is stale.
6. **Already ticketed — do not re-file.** Spikes/probes (#325), unused exports (#335), sidecar doc paths (#327), test matrix (#331), fsync writers (#320).

## Checks run

- `wc -l` on every in-scope tree listed in Inventory.
- Export/identifier scan (`/tmp/shared-tooling-audit.mjs`, not committed).
- Path existence: `scripts/e2e.mjs`, `scripts/prepare-resources.mjs`, `scripts/worldline-*.mjs`, `docs/archive/` — all absent.
- `scripts/install.sh` vs website source pane vs RELEASING.md — installer requires cargo; RELEASING.md does not.
- Open issues #320, #325, #327, #331, #335 read and compared to this tree.

Not run (audit-only, no code change): `pnpm run typecheck`, `pnpm run test:unit`, build, e2e.

## Disposition

This file is the only commit. No issues opened. Remediation is one-ticket-one-run if filed later: docs path/command checks; script deletions need typecheck + the unit tests that pin `package.json` strings (`test-infra`, `release-graph`).
