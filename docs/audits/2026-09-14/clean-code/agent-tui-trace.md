# Clean-code audit: agent TUI / trace / stall (2026-09-14)

Audit only. No production or test edits. No GitHub issues opened. No refactors.

## Scope

Exclusive domain:

- `agent-core/tui.ts`, `agent-core/tui/`, `agent-core/tui-text.ts`
- `agent-core/trace.ts`, `agent-core/trace/`
- `agent-core/stall.ts`
- Matching tests: `tests/unit/agent-core/tui-*`, `trace-*`, `stall-*`, `quiet-wins*`, `login-secret*`, `tui-performance*`, `tui-hardening*`, `tui-secret*`

Out of scope (cited only as caller evidence): `agent-core/main.ts`, `agent-core/auth/`, `agent-core/models.ts`, `electron/`, `docs/audits/2026-09-13/`.

Skipped: `node_modules`, `dist`.

House rules applied: AGENTS.md one-owner + YAGNI; 800-line review trigger is not an automatic split; `shared/fsync.ts` stays fsync-only; `truncateMiddle` is display/cells, not a byte cap.

## Inventory

Every in-scope path appears once. Walk = inventory = 25 files.

### Production (12 files, 6,304 lines)

| Path | Lines |
|---|---|
| `agent-core/tui.ts` | 9 |
| `agent-core/tui-text.ts` | 462 |
| `agent-core/tui/app.ts` | 1,689 |
| `agent-core/tui/layout.ts` | 245 |
| `agent-core/tui/transcript.ts` | 375 |
| `agent-core/trace.ts` | 15 |
| `agent-core/trace/schema.ts` | 647 |
| `agent-core/trace/normalize.ts` | 421 |
| `agent-core/trace/records.ts` | 511 |
| `agent-core/trace/runtime.ts` | 1,555 |
| `agent-core/trace/quiet-wins.ts` | 99 |
| `agent-core/stall.ts` | 276 |

### Tests (13 files, 5,285 lines)

| Path | Lines |
|---|---|
| `tests/unit/agent-core/tui-hardening.test.ts` | 129 |
| `tests/unit/agent-core/tui-performance.test.ts` | 260 |
| `tests/unit/agent-core/tui-secret.test.ts` | 48 |
| `tests/unit/agent-core/trace-critic.test.ts` | 109 |
| `tests/unit/agent-core/trace-hardening.test.ts` | 299 |
| `tests/unit/agent-core/trace-links.ts` | 222 |
| `tests/unit/agent-core/trace-report.ts` | 1,606 |
| `tests/unit/agent-core/trace-retention.test.ts` | 130 |
| `tests/unit/agent-core/trace-runtime.test.ts` | 934 |
| `tests/unit/agent-core/trace-v2.test.ts` | 916 |
| `tests/unit/agent-core/stall-tracker.test.ts` | 302 |
| `tests/unit/agent-core/quiet-wins.test.ts` | 268 |
| `tests/unit/agent-core/login-secret.test.ts` | 62 |

`login-secret.test.ts` is listed because it matches the requested glob. It imports `agent-core/auth/login.ts` only; the TUI secret contract lives in `tui-secret.test.ts`.

## Method

Read every production file in the domain. Cross-checked slash dispatch, schema field writes, and critic/quiet-wins call sites against in-domain tests plus (evidence only) `agent-core/main.ts` and `docs/reference/{CALIBRATION,GOVERNORS,TOOLING-WATCH}.md`. Compared open tickets #320, #321 (closed not_planned), #335.

## Counts

| | |
|---|---|
| Files audited | 25 |
| Production lines | 6,304 |
| Test lines | 5,285 |
| Findings NEW | 12 |
| Findings ALREADY-TICKETED | 3 |
| P1 | 1 |
| P2 | 7 |
| P3 | 4 |
| Dead listed slash commands | 0 |

## Findings

### F1 — Critic role and settle verdict leftover after #124 — YAGNI — P1 — NEW

**Path:** `agent-core/trace/schema.ts:49`, `agent-core/trace/schema.ts:320-339`, `agent-core/trace/normalize.ts:409-420`, `agent-core/trace/records.ts:37-38`, `tests/unit/agent-core/trace-critic.test.ts:1-109`

**As-is:** `TraceRole` includes `"critic"`. `TraceTaskSettled.critic` is a first-class `TraceCriticVerdict`. `createAttemptRecord` accepts the role; `criticVerdict()` normalizes pass/fail + rounds. `trace-critic.test.ts` pins write, reject, and link-index behavior. Schema comment still cites #124.

**Should-be:** Production never writes a critic attempt or a settle verdict. Caller evidence (not audited as a finding): `settleTraceTask` is only invoked as `settleTraceTask(taskOutcomeStatus)` so `critic` stays `null`; `completeText(..., { traceRole })` is never passed; `beginTraceAttempt` is called with `"main"` or `"summary"` only. Docs (`CALIBRATION.md`, `GOVERNORS.md`, `TOOLING-WATCH.md`) say the #124 critic-before-settle gate was removed in `f77883c` and must not be restored. AGENTS.md: when a feature is removed, remove its types/helpers/tests too.

**Smallest fix:** Drop write-side critic: remove `TraceCriticVerdict`, `settled.critic`, `criticVerdict()`, and `trace-critic.test.ts`. Narrow `TraceRole` to `"main" | "summary"` on new records. If on-disk traces from the removed gate can still appear, keep `"critic"` only in `inspectExisting` / `validTraceLinkIndex` as a read-side tombstone and map it to `"summary"` — that is the narrow disk-compat exception, not a live role.

**What NOT to do:** Do not restore a critic-before-settle gate. Do not add options/flags to "support critic later". Do not keep the test file as documentation of a removed feature.

---

### F2 — `outcome.correctness` is schema-only — YAGNI — P2 — NEW

**Path:** `agent-core/trace/schema.ts:315`, `agent-core/trace/records.ts:116`

**As-is:** Every task-settled record carries `correctness: string | null`. Production settle writes `correctness: null` always. Non-null values exist only in unit fixtures (`trace-v2`, `trace-runtime`, `cache-experiment`, laziness metrics).

**Should-be:** #123 verify-before-success (the intended writer of correctness) was removed with #124. The live settle fact is `outcome.status` plus `criticalClass` (#237). A field that is always null is not a contract.

**Smallest fix:** Stop emitting `correctness` from `createTaskSettledRecord` and delete the field from `TraceTaskOutcome`. Update fixture readers that still group by it. If measurement scripts need a historical column, they can treat absence as null.

**What NOT to do:** Do not invent a production writer to "fill in" correctness. Do not restore the #123 verify-before-success gate to justify the field.

---

### F3 — Quiet-wins / report aliases for never-written keys — YAGNI — P2 — NEW

**Path:** `agent-core/trace/quiet-wins.ts:26`, `agent-core/trace/quiet-wins.ts:95`, `tests/unit/agent-core/trace-report.ts:673`

**As-is:** `toolName()` reads `toolName ?? name ?? tool`. `collectTaskToolOutcomes` reads `toolOutcomes ?? toolResults`. `trace-report.ts` repeats `toolOutcomes ?? toolResults`. Production attempt records always write `toolName` and `toolOutcomes` (`createAttemptRecord` / `toolOutcomes()`). No in-domain writer emits `name`, `tool`, or `toolResults`. Quiet-wins unit tests use `toolName` only.

**Should-be:** One key per fact. No backwards-compat aliases unless an on-disk format forces them (AGENTS.md). These are speculative shims.

**Smallest fix:** Read `toolName` and `toolOutcomes` only. Delete the fallbacks here and in `trace-report.ts`. Out-of-scope sibling `scripts/laziness-metrics.ts` has the same `toolResults` fallback — migrate it in the same change so the alias does not survive.

**What NOT to do:** Do not add a compatibility matrix or "legacy record" adapter. Do not keep `toolResults` because a measurement script also guessed it.

---

### F4 — `isSuccessClaim` accepts statuses production never sends — YAGNI — P2 — NEW

**Path:** `agent-core/trace/quiet-wins.ts:30-33`, `tests/unit/agent-core/quiet-wins.test.ts:55-58`

**As-is:** Success is `success | succeeded | ok`. The settle loop (caller evidence) only passes `success`, `failure`, or `interrupted`. The extra aliases exist so quiet-wins can match `scripts/laziness-metrics.ts`, and a unit test pins `ok` / `succeeded`.

**Should-be:** The settle gate classifies the host's own status string. Measurement-script synonyms are not a second settle API.

**Smallest fix:** Treat only `success` as a success claim (case-insensitive if desired). Drop the `ok` / `succeeded` test.

**What NOT to do:** Do not add an options bag (`aliases`, `strict`). Do not change production to emit `ok` so the aliases look used.

---

### F5 — `matchingSlashCommands` copies the same picker-head guard four times — KISS — P2 — NEW

**Path:** `agent-core/tui-text.ts:105-138`

**As-is:** `/login|/logout`, `/models|/model`, `/effort`, and `/permissions` each open with the same `if (space < 0 && line !== head) return commands.filter(name.startsWith)` then a picker-row filter. Behavior is correct; the copy is the cost.

**Should-be:** One helper: "partial command name → prefix match on `SLASH_COMMANDS`; exact head → picker rows." Hidden `/new` → `/clear` stays beside it.

**Smallest fix:** Local `function pickerHead(head, line, rows)` in `tui-text.ts`. Replace the four copies. Keep `/model` vs `/models` as one head pair (they already share a branch).

**What NOT to do:** Do not add a command-registry framework, plugin list, or per-command strategy objects. Do not split `tui-text.ts` for this.

---

### F6 — `truncateActive` reimplements `sourceTail` — Clean — P2 — NEW

**Path:** `agent-core/tui/app.ts:451-453`, `agent-core/tui/layout.ts:66-72`

**As-is:** Both do `graphemeSafeTail` then drop a leading partial line (`indexOf("\n")` + slice). `sourceTail` is the owner; `truncateActive` inlines the same rule when capping a live stream.

**Should-be:** One tail-with-newline-align helper. `truncateActive` already imports `graphemeSafeTail` from layout; it should call `sourceTail`.

**Smallest fix:** `const tail = sourceTail(entry.text, budget).text` (or `sourceTail` then prepend `TRUNCATION_MARKER`). Delete the inline newline skip.

**What NOT to do:** Do not merge this with `truncateMiddle` or `trimGraphemesToBytes`. Those are cells vs bytes (see #321). Do not move `sourceTail` into `tui-text.ts`.

---

### F7 — `prospectiveLinkIndex` and `reservationPlan` duplicate placeholder construction — Clean — P2 — NEW

**Path:** `agent-core/trace/runtime.ts:567-645`, `agent-core/trace/runtime.ts:886-973`

**As-is:** Both, for a new attempt or settlement, insert the record, then add unknown parent/retry/attempt-id placeholders (`role: "main"` / `"summary"`, `retained: false`, `unknown: true`) and compute settlement `unknown`. `prospectiveLinkIndex` materializes a frozen index; `reservationPlan` materializes update maps for capacity. The mutation rules are copied.

**Should-be:** One function that returns the planned attempt/settlement updates. `prospectiveLinkIndex` applies them onto a copy; `reservationPlan` returns them for byte accounting.

**Smallest fix:** Extract a private `plannedLinkUpdates(record)` on `TraceRuntime` and call it from both. Leave `indexSummary` / `compactionCandidates` where they are.

**What NOT to do:** Do not split `runtime.ts` on line count. Do not introduce a LinkIndexBuilder type hierarchy. The 800-line trigger is not a split reason here — both paths share the lock/queue lifecycle.

---

### F8 — `buildFrame` is the god render — KISS — P2 — NEW

**Path:** `agent-core/tui/app.ts:1565-1688`

**As-is:** One method packs the title (model/effort/queue truncation), fills the transcript or empty state, windows the composer box, draws slash rows, then applies per-row SGR. Title packing alone is ~40 lines of reserved-suffix arithmetic.

**Should-be:** `buildFrame` stays the frame owner (one paint). Title packing is a distinct reason to change (narrow-terminal status) and already has cell-budget tests via `truncateMiddle`.

**Smallest fix:** Extract a private `titleLine(cols)` (or `statusTitle`) on `AgentTui`. Keep SGR and composer chrome in `buildFrame`.

**What NOT to do:** Do not extract `tui/render.ts` or a widget tree. Do not split `app.ts` because it is 1,689 lines. Input (`handleChar` / `applyCsi`) is a flat key dispatch; do not add a keymap framework.

---

### F9 — `StyleId` 7 is never assigned — YAGNI — P3 — NEW

**Path:** `agent-core/tui/transcript.ts:152`, `agent-core/tui/layout.ts:156-157`

**As-is:** `StyleId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7`. Markdown emits 0–6 (`parseInline` / `parseMarkdown`). `paintRow` treats 6 and 7 as the same dim SGR. Nothing assigns 7.

**Should-be:** The union matches produced styles.

**Smallest fix:** Drop `7` from `StyleId` and the `|| frag.style === 7` branch.

**What NOT to do:** Do not invent a seventh markdown style to justify the id. Do not introduce named style constants unless a third call site needs them.

---

### F10 — `text()` returns `required ? null : null` — KISS — P3 — NEW

**Path:** `agent-core/trace/normalize.ts:39`

**As-is:** After the empty-required throw, `return normalized || (required ? null : null)`. Both branches are `null`. Empty optional strings already become null via `||`.

**Should-be:** `return normalized || null`.

**What NOT to do:** Do not add a comment explaining the ternary. Do not change required vs optional semantics.

---

### F11 — `records.ts` header claims atomic-write ownership — Clean — P3 — NEW

**Path:** `agent-core/trace/records.ts:1-6`

**As-is:** File comment: "Owns attempt/settlement factories, link-index validation, existing-file scanning, **and atomic-write helpers**." `atomicWrite` lives in `runtime.ts:23`. Records owns factories, scan, and link validation only.

**Should-be:** The header matches the owner. Section comments do not replace module boundaries; a wrong owner claim is worse than none.

**Smallest fix:** Delete "and atomic-write helpers" from the comment.

**What NOT to do:** Do not move `atomicWrite` into `records.ts` to make the comment true. Do not expand `shared/fsync.ts` (see #320).

---

### F12 — `acquireLock` duplicates the exclusive-create write — KISS — P3 — NEW

**Path:** `agent-core/trace/runtime.ts:449-498`

**As-is:** The `wx` + write + sync + assign `lockHandle` sequence is copied for the first create and the stale-pid retry. Failure cleanup is copied too.

**Should-be:** One private `tryCreateLock()` called twice.

**Smallest fix:** Local helper returning `{ ok: true } | { ok: false; error }`. Keep stale-pid unlink in `acquireLock`.

**What NOT to do:** Do not extract a generic lock module. Do not share this with sidecar or session writers.

---

## Already ticketed

These were seen in-domain. Do not re-file.

### A1 — Trace `atomicWrite` vs sidecar durable write — ALREADY-TICKETED #320

**Path:** `agent-core/trace/runtime.ts:23-52`

Async temp-file + `handle.sync()` + rename + `syncDirectoryAsync`. Same durable-async shape as sidecar `durableAtomicWrite`. `shared/fsync.ts` is fsync-only and must stay that way. #320 already narrowed this pair.

### A2 — `truncateMiddle` vs byte-cap helpers — ALREADY-TICKETED #321 (closed, not planned)

**Path:** `agent-core/tui-text.ts:279` (cells, display), `agent-core/tui/app.ts:32` (`trimGraphemesToBytes`, draft byte cap)

Different contracts. House rule: `truncateMiddle` is display/cells, not the #321 byte-cap class. Do not reopen #321. Do not "dedupe" these into one helper.

### A3 — Unused / test-only exports in this domain — ALREADY-TICKETED #335

In-domain samples unused outside their defining file (except tests): `PERMISSION_COMMANDS`, `EFFORT_HINTS`, `authCommandRows`, `authRowMatches`, `pickerRowMatches`, `FILE_MENTION_PATH`, `mentionTokenEnd`, `graphemeSegmenter`, `isCombiningCode` (`tui-text.ts`); `emptyStallTracker`, `emptyFailureLoopTracker`, `stallTurnFingerprint`, `stallFailureKey`, `stallFailureKeysForTurn`, `trackStallTurn`, `trackFailureLoopTurn` (`stall.ts` — production uses `emptyToolLoopTracker` / `trackToolLoopTurn`); public `markdownScannedChars` on `AgentTui` (`tui/app.ts:63`) is a test seam.

#335 says review per file, no bulk-delete. Do not open a TUI-specific export ticket.

---

## Hunted, not found

**Dead listed TUI commands.** Every `SLASH_COMMANDS` row (`tui-text.ts:11-23`) is dispatched by the engine: `/help`, `/login`, `/logout`, `/model`, `/models`, `/resume`, `/clear` (`/new` hidden alias), `/compact`, `/effort`, `/permissions`, `/exit`. TUI intercepts bare `/login|/logout|/permissions|/models` to open pickers (`app.ts:993-1007`) then submits the picked line. `/quit` is a live hidden alias of `/exit` (`app.ts:1031`), same pattern as `/new` → `/clear`. `/approve *` is picker `submit` only, not a menu row. No listed command is unwired.

**Duplicate truncate/width owners inside TUI.** `truncateMiddle` (middle ellipsis, cells), `clip` (pad-to-width), `wrapText` / `wrapSpans` (plain vs styled), `graphemeSafeTail` (cluster-safe cut) are different contracts. The only true duplicate is F6 (`sourceTail` vs `truncateActive`). Longest-common-prefix loops in `completeSlashLine` and `completeFileMention` are incidental syntax, not a second owner.

**Unused live trace fields (cache/cost/tools).** `TraceCache`, `TraceCost`, tool `continuation` / `repro` / `stdout` / `stderr` / `cancellationScope`, and reclaim targets are written by the host and cache/rate owners. Nested reclaim fallbacks in `normalize.ts` (`originalType ?? original?.type`) adapt the session receipt shape, not a dead disk format. Do not strip those.

**Speculative quiet-wins options bag.** There is none. The settle gate itself (#237) is live and correctly owned by `trace/quiet-wins.ts`. Findings F3–F4 are alias extras, not a unused options object.

**Comments-as-sections.** No `// =====` / `// --- RENDER ---` banners. Why-comments on markdown ropes, paste batching, lock/reap, and title packing are load-bearing. The only stale owner comment is F11.

**`collectTaskToolOutcomes` vs `inspectExisting`.** Two directory walks, two contracts: sync harvest of `toolOutcomes` for settle vs async schema scan for startup. Do not merge them.

## Line-count review (do not split)

| File | Lines | Distinct lifecycle / test surface? | Split? |
|---|---|---|---|
| `agent-core/tui/app.ts` | 1,689 | One input/render/event lifecycle. Tests drive `AgentTui` as a whole. | No. F8 is a private method, not a module. |
| `agent-core/trace/runtime.ts` | 1,555 | One lock / queue / manifest / index lifecycle. | No. F7 is a private helper, not a module. |
| `tests/unit/agent-core/trace-report.ts` | 1,606 | Test/measurement reader that must tolerate malformed records (`normalize.ts` throws). | No. Keep out of production normalize. |

## Checks

Docs-only change: path check only.

- Report path exists: `docs/audits/2026-09-14/clean-code/agent-tui-trace.md`
- Typecheck / unit / build / e2e: not run (no code changes)
