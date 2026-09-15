# Clean Code / YAGNI / KISS — agent runtime

Audit only. 2026-09-14 (filed 2026-09-15). No production or test edits.

Domain: agent-core runtime, tools, and session host. Other cloud agents own
`auth*`, `models*`, `openai-compat*`, `cache.ts`, `rates.ts`, `mcp*`, `tui*`,
`trace*`, and `stall.ts`. Those modules appear here only as callers.

House rules (override Clean Code purism): integrity > security > task > perf
> contracts > architecture > simplicity. One owner. Tool surface stays in
`agent-core/main.ts`; helpers stay in `agent-core/main/`. 800-line trigger is
a review, not an automatic split. Incidental syntax duplication is allowed;
duplicated responsibility is not.

## Method

Walked the exclusive path list (33 production files). Counted lines and
`export` names (including `export { … }` / `export type { … }`). Classified
each export by word-boundary use outside its defining file: live (production
importer), test-only, or dead. Read `main.ts` section map and the public
entries for host / subagents / session. Compared tool-result, truncate, and
atomic-write helpers against #320 / #321 / #324 / #335. Skipped
`node_modules`, `dist`, and `docs/audits/2026-09-13`.

Export scan is identifier-based. It does not prove a type is unused as a
return annotation inside the defining file. #335 already requires per-file
review before deletion.

## Inventory

33 production files, **18,894** lines, **568** export names.

| Path | Lines | Role |
|---|---:|---|
| `agent-core/main.ts` | 6557 | Tool surface + request/cache/compaction/permission/loop. 57 named exports + `ReplayMessage` re-export (**58**). 240 `//` comments (3.7%). |
| `agent-core/main/file-ops.ts` | 931 | Read/write/edit + sync `atomicWrite`. |
| `agent-core/main/files.ts` | 670 | Cwd jail, walk, glob, `@` tags. |
| `agent-core/main/grep.ts` | 608 | Grep tool. |
| `agent-core/main/sidecar.ts` | 485 | Sidecar writer (`logEvent`). |
| `agent-core/main/tools.ts` | 256 | Result envelopes + transcript formatters. |
| `agent-core/main/url.ts` | 218 | Outbound URL / DNS jail. |
| `agent-core/main/policy-fetch.ts` | 166 | Policy HTTP. |
| `agent-core/main/history-view.ts` | 156 | Transcript render. |
| `agent-core/main/front-matter.ts` | 143 | Frozen system prompt. |
| `agent-core/main/env.ts` | 153 | PATH / environment text. |
| `agent-core/main/skills.ts` | 133 | Skill walk + instruction wrappers. |
| `agent-core/main/login-hint.ts` | 30 | Auto-login hint. |
| `agent-core/host.ts` | 15 | Public re-export (`#38`). |
| `agent-core/host/images.ts` | 652 | Pending-image lock / names. |
| `agent-core/host/context.ts` | 507 | Ack, overlay files, startup, plan text. |
| `agent-core/host/image-queue.ts` | 204 | Claim / ack queue. |
| `agent-core/host/image-store.ts` | 164 | Persist / load session images. |
| `agent-core/subagents.ts` | 1119 | Registry + handoff/result/approval/inbox contract. |
| `agent-core/tool-output.ts` | 619 | Bounded UTF-8 tool text. |
| `agent-core/tool-dispatch.ts` | 113 | Admission + read/mutate waves. |
| `agent-core/session.ts` | 25 | Public re-export (`#38`). |
| `agent-core/session/replay.ts` | 798 | Replay / recover. |
| `agent-core/session/bundles.ts` | 738 | Bundle listing / open / admission. |
| `agent-core/session/primitives.ts` | 600 | Caps, hashes, receipt types. |
| `agent-core/session/temp-bundles.ts` | 544 | Temp bundle + image copy. |
| `agent-core/session/lifecycle.ts` | 521 | Ensure / clear / `SessionWriter`. |
| `agent-core/session/fork.ts` | 361 | Fork materialize. |
| `agent-core/session/descriptors.ts` | 252 | Descriptor-bound fsync. |
| `agent-core/reclaim.ts` | 377 | Prune planner. |
| `agent-core/request-projection.ts` | 311 | Request overlay + persist view. |
| `agent-core/skill-index.ts` | 261 | Compact skill XML. |
| `agent-core/compaction.ts` | 207 | Hysteresis / summarize / truncate plan. |

Matching tests in scope (48 files, **16,293** lines): `main-*`, `file-*`,
`tool-*`, `subagent*`, `session-*`, `compaction`, `reclaim`, `projection`,
`skill-*`, plus `host-context-files`, `host-output`, `read-*`,
`edit-validation`, `run-guardrails`, `context-overflow`,
`context-compaction`, `resume-quarantine`, `quiet-wins`, and
`harness-kernel.test.ts` (5,427 lines — pins most `main.ts` exports).

Export classification (defining-file excluded): **412 live**, **89 test-only**,
**67 dead**. Domain-heavy dead/test-only lists sit under #335.

## Owners

| Concern | Owner |
|---|---|
| Tool surface (`TOOLS`, `executeTool`, slash/loop) | `agent-core/main.ts` |
| File / grep / env / sidecar / skill walk / formatters | `agent-core/main/*` |
| Sidecar writer | `agent-core/main/sidecar.ts` (`logEvent`); parser stays `electron/sidecar.ts` |
| Host protocol (ack, overlay, images) | `agent-core/host.ts` → `host/` |
| Subagent registry + handoff formats | `agent-core/subagents.ts` (headless spawn: `electron/subagents.ts`) |
| Session bundles | `agent-core/session.ts` → `session/` |
| Compaction / reclaim / projection / skill XML | dedicated modules above |

`host.ts` and `session.ts` are thin `#38` façades. Keep them as the public
entry; do not add a second import path.

## `main.ts` structure

Section banners (comments, not modules):

| Banner | Line | Contents |
|---|---:|---|
| (imports / route / cache / trace helpers) | 1–1228 | Auth, cache, trace wiring mixed with CLI flags |
| `trace runtime integration` | 1229 | Trace task/attempt writes |
| `append-only session storage` | 1325 | Writer, persist, bash, fetch, approvals |
| `history` | 2492 | In-memory view, `projectMainRequest`, reclaim/summarize |
| `provider call` | 2945 | `providerPost`, `completeTextBody`, `callModel` (~596 lines, 3569–4164) |
| `waste attribution` | 4166 | Rates / cost / `formatUsageIndicators` |
| `agent loop` | 4627 | `runPrompt` (578 lines, 4753–5330), tool waves |
| `session resume` | 5332 | Replay / quarantine / test seams |
| `terminal surface` | 5507 | Shutdown, slash router `dispatchLine` (222 lines, 6155–6376), `main` |

Tool surface that must stay here: `TOOLS` (2157–2242) +
`visibleSubagentTools` merge (2251–2256), `executeTool` (2013–2155),
`builtinClientTools` (2259), the `toolExecutionWaves` loop (5150–5212).

Mixed in the same file (the #324 split target): cache capability,
trace records, session persist, compaction apply, provider HTTP/SSE,
cost, slash commands, TUI wiring, `--subagent-task` child entry.

## Counts

| Class | Count |
|---|---:|
| NEW findings | 10 |
| ALREADY-TICKETED clusters | 4 (#324, #335, #320, #321 closed) |
| P1 NEW | 0 |
| P2 NEW | 5 |
| P3 NEW | 5 |
| Out of domain (do not reticket) | #333 (`electron/agent-activity.ts`) |

---

## ALREADY-TICKETED

### AT-1 — Split `agent-core/main.ts`

- **Path:** `agent-core/main.ts:1` (6557 lines, 58 exports)
- **Class:** Clean / god-module
- **Priority:** P1
- **Ticket:** #324
- **Status:** ALREADY-TICKETED
- **As-is:** Tool surface, request/cache/compaction/permission, provider
  stream, cost, slash router, and `--subagent-task` share one file.
  Largest functions: `callModel` 3569–4164 (~596), `runPrompt` 4753–5330
  (578), `dispatchLine` 6155 (222), `completeTextBody` 3342 (173),
  `executeTool` 2013 (143).
- **Should-be:** Split by responsibility. Keep `TOOLS` / `executeTool` /
  slash dispatch in `main.ts`.
- **Smallest fix:** Follow #324. Extract cache/trace/cost/provider-call
  helpers first; do not move the tool table.
- **What NOT to do:** Do not move the tool surface out of `main.ts`. Do
  not split on line count alone. Do not open follow-ups for
  `tui/app.ts` / `trace/runtime.ts` from this audit.

### AT-2 — Dead and test-only exports

- **Path:** domain-wide (see samples)
- **Class:** YAGNI
- **Priority:** P2
- **Ticket:** #335 (supersedes #329)
- **Status:** ALREADY-TICKETED
- **As-is:** This tree matches the #335 comment: `main.ts` dead exports
  include `parseSubagentTaskFlag` (422; used at 6499, export unused),
  `hashSystem` (1024; used in-file), `cancelPendingApproval` (1739; used
  at 5599), `cacheFlipStats` (4182; used at 4636), `AnthropicCacheMark`
  (2305), `TraceCacheDiagnostics` (636), `RevisionKind` (2544),
  `ShutdownOptions` / `ShutdownResult` (5514–5519).
  `tool-dispatch.ts:6` `ToolExecutionEntry` has no external identifier
  use. `subagents.ts` still exposes many caps/types unused outside the
  file (`MAX_SUBAGENT_TASK_CHARS`, `MAX_SUBAGENT_BRIEF_CHARS`,
  `WORLDLINE_CANDIDATE_ENV`, `SUBAGENT_TASK_VERSION`,
  `SubagentRun`, …). Other dead values: `escapeXml`
  (`main/files.ts:664`; only `xmlSafe` calls it), `decodeHttpBody`
  (`main/policy-fetch.ts:67`; used in-file), `validatedLookup`
  (`main/url.ts:213`; zero importers — tests use
  `createValidatedLookup`), `REQUEST_OVERLAY_BYTES`
  (`request-projection.ts:311`), `DEFAULT_SKILL_TRIGGER_CHARS`
  (`skill-index.ts:32`), `CACHE_MISS_COMPACT_SHARE`
  (`compaction.ts:35`).
- **Should-be:** Per-file triage. Keep contract types and seams
  (`SidecarWriter` is the live `createSidecarWriter` return type;
  `ShutdownOptions` annotates `shutdownAgentCore`; subagent file
  versions are the host contract even when only this file reads them).
- **Smallest fix:** Work #335 per file. Start with unused *values*
  (`validatedLookup`, `escapeXml` export, `REQUEST_OVERLAY_BYTES`)
  before types.
- **What NOT to do:** Bulk-delete. Do not drop `testOnly*` seams that
  session tests pin. Do not treat `SidecarWriter` as dead.

### AT-3 — Atomic writes (different contracts)

- **Path:** `agent-core/main/file-ops.ts:685` `atomicWrite`;
  `agent-core/subagents.ts:934` `atomicWriteJsonSync`;
  `agent-core/main/sidecar.ts:208` `writeDurableMarker`
- **Class:** YAGNI (false merge)
- **Priority:** P2
- **Ticket:** #320
- **Status:** ALREADY-TICKETED
- **As-is:** #320 already lists the file-ops (sync, no fsync — agent
  tool write) and subagents (sync JSON) writers and says leave them
  alone. Sidecar `writeDurableMarker` is a third contract: sync +
  `syncParentDir` from `shared/fsync.ts` (crash-durable markers).
  Remaining #320 work is the durable *async* pair in
  `electron/sidecar/tailer.ts` and `agent-core/trace/runtime.ts`
  (out of this domain).
- **Should-be:** Keep each writer. Record the contract if anyone
  re-files a merge.
- **Smallest fix:** None in this domain. Close any new “dedupe atomic
  write” ticket that cites these three as one responsibility.
- **What NOT to do:** Do not add rename to `shared/fsync.ts`. Do not
  fsync agent tool writes. Do not expand #320 to this tree.

### AT-4 — Truncate helpers (different contracts)

- **Path:** `agent-core/compaction.ts:123` `truncateCut`;
  `agent-core/request-projection.ts:107` `truncateHostOverlayBytes`;
  `agent-core/tool-output.ts:121` / `:128` `utf8TextPrefix` /
  `utf8TextSuffix`; `agent-core/main/tools.ts:188` `capDisplay`
  (suffix wrapper); `agent-core/subagents.ts:18` `truncateUtf8`
  (re-export of `utf8TextPrefix`)
- **Class:** YAGNI (false merge)
- **Priority:** P3
- **Ticket:** #321
- **Status:** ALREADY-TICKETED (closed, not planned)
- **As-is:** Owner closed #321: prefix vs tail vs grapheme vs cell
  width vs compaction vs overlay Buffer are not one responsibility.
  This domain’s helpers match that ruling. `electron/subagents.ts:194`
  `truncateUtf8Tail` is a different (tail) contract from the prefix
  re-export.
- **Should-be:** Leave them. One UTF-8 *boundary* primitive already
  exists (`utf8BytePrefix`); callers compose it.
- **Smallest fix:** None.
- **What NOT to do:** Do not reopen #321. Do not invent
  `shared/truncate.ts`.

---

## NEW findings

### AR-01 — MCP tool results bypass `done()`

- **Path:** `agent-core/main.ts:2134`
- **Class:** Clean (parallel result formatter)
- **Priority:** P2
- **Status:** NEW
- **As-is:** Built-in tools go through `done()` → `toolResult()` +
  bounded metadata (`main/tools.ts:87`). The MCP branch hand-builds
  `ToolOutcome` (`result`, `isError`, `bounded`, `cancellationScope`,
  `continuation`, `repro`) and skips `done()`.
- **Should-be:** One constructor. `done()` already forwards bounded /
  continuation / repro / stdout / stderr. The only extra MCP field is
  `cancellationScope`.
- **Smallest fix:** Add optional `cancellationScope` (and pass-through
  bounded) to `done()` or a single `doneFromToolText()` helper next to
  it. Use it from the MCP branch. Delete the object literal.
- **What NOT to do:** Do not add a third `ToolOutcome` factory. Do not
  move MCP call dispatch out of `executeTool`.

### AR-02 — Skill-index wrapper drops `roots`

- **Path:** `agent-core/main/skills.ts:105`; production caller
  `agent-core/main/front-matter.ts:99`
- **Class:** YAGNI / Clean (parallel formatter)
- **Priority:** P2
- **Status:** NEW
- **As-is:** Canonical renderer is `skill-index.ts:237`
  `formatSkillIndex(skills, opts)` with `roots` / `capBytes` /
  `capped`. `front-matter.ts` calls that directly and passes `roots:
  skillDirs`. `skills.ts` re-exports a second `formatSkillIndex` that
  only forwards `{ capBytes: SKILL_XML_CAP, capped }` — no roots.
  Production never uses the wrapper. `harness-kernel.test.ts:1205`
  does, so the test path cannot see root grouping.
- **Should-be:** One call path. The wrapper is either deleted or it
  forwards `roots`.
- **Smallest fix:** Delete `skills.ts` `formatSkillIndex` and point
  the harness import at `skill-index.ts` (or pass `roots` through).
  Keep `scanSkills` / instruction wrappers in `skills.ts`.
- **What NOT to do:** Do not add a third formatter. Do not move
  discovery into `skill-index.ts` (that module is render-only).

### AR-03 — `subagents.ts` Phase banners mark extra lifecycles

- **Path:** `agent-core/subagents.ts:189`, `:527`, `:898` (file is
  1119 lines)
- **Class:** Clean (comments replacing modules)
- **Priority:** P2
- **Status:** NEW
- **As-is:** AGENTS.md names this file as the registry + host-contract
  owner. Inside it, Phase comments split: spawn/result files (189),
  stdout framing (527), approvals + inbox (898), plus
  `SubagentRegistry` (652, 211 lines). Distinct tests already exist
  (`subagents.test.ts`, `subagent-approval*.test.ts`).
- **Should-be:** Same public entry. Private helpers may live under
  `agent-core/subagents/` (approval files, inbox, task/result parse)
  if those slices change independently.
- **Smallest fix:** Extract approval + inbox I/O first (own tests,
  own `atomicWriteJsonSync`). Keep `SubagentRegistry` and
  `SUBAGENT_TOOL_DEFS` on the entry. Tool surface stays in `main.ts`.
- **What NOT to do:** Do not treat 1119 lines as an automatic split.
  Do not create a second registry. Do not move spawn validation into
  Electron. Do not invent `subagents-v2`.

### AR-04 — Duplicated stored-image name regex

- **Path:** `agent-core/host/images.ts:23`;
  `agent-core/session/primitives.ts:73`
- **Class:** YAGNI (duplicated responsibility)
- **Priority:** P2
- **Status:** NEW
- **As-is:** Byte-identical
  `/^[A-Za-z0-9._-]+-img-[1-9][0-9]{0,3}\.(png|jpe?g|webp|gif)$/`
  lives in both owners. `isSafeImageName` is **not** the same
  function: host (`images.ts:97`) accepts pending *or* stored;
  session (`primitives.ts:540`) accepts stored only and also
  rejects `/`, `\`, NUL, `..`.
- **Should-be:** One `STORED_IMAGE_NAME`. Session owns stored bundle
  image names; host imports that constant and keeps `PENDING_IMAGE_NAME`
  + the OR predicate.
- **Smallest fix:** Export the regex from `session/primitives.ts`
  (via `session.ts`). Host imports it. Leave both predicates.
- **What NOT to do:** Do not merge the two `isSafeImageName`
  functions (pending vs stored). Do not put session primitives in
  `host/`. Do not add `shared/image-name.ts`.

### AR-05 — `providerPost` takes eight positional arguments

- **Path:** `agent-core/main.ts:3085`
- **Class:** Clean (4+ arg function)
- **Priority:** P2
- **Status:** NEW
- **As-is:**
  `(providerId, body, signal, model, stream, codexAffinity, cacheIdentity, onRetry?)`.
  Call sites in `completeTextBody` / `callModel` repeat the same
  boolean soup. Easy to swap `stream` and `codexAffinity`.
- **Should-be:** One options object after the required
  provider/body/signal (or a single `ProviderPostOptions`).
- **Smallest fix:** Fold trailing flags into an options bag. No
  behavior change. Fits the #324 provider-call extract.
- **What NOT to do:** Do not add a HTTP client class. Do not change
  retry/auth semantics while renaming.

### AR-06 — `buildRequestOverlay` voids `messages`

- **Path:** `agent-core/request-projection.ts:41`, `:126`
- **Class:** YAGNI (unused option)
- **Priority:** P3
- **Status:** NEW
- **As-is:** `BuildRequestOverlayOptions.messages` is required.
  `buildRequestOverlay` does `void opts.messages` and only reads
  `hostContext` / `maxBytes`. `projectMainRequest` (`main.ts:2524`)
  still passes `messages`.
- **Should-be:** Overlay options are `{ hostContext?, maxBytes? }`.
  Comment already says tool history is not duplicated into the
  overlay.
- **Smallest fix:** Drop `messages` from the options type and the
  one call site.
- **What NOT to do:** Do not start putting file inventories back
  into the overlay (that path was removed on purpose).

### AR-07 — `readContextFiles` is a leftover string façade

- **Path:** `agent-core/host/context.ts:334`
- **Class:** YAGNI
- **Priority:** P3
- **Status:** NEW
- **As-is:** Production (`main.ts:4887`) calls
  `readContextFilesResult`. `readContextFiles` is `.text` only.
  Importers: harness-kernel and `host-output.test.ts` (the latter
  asserts it matches `.text`).
- **Should-be:** One function. Tests read `.text` from the result.
- **Smallest fix:** Delete `readContextFiles` and the host.ts
  re-export; update the two tests.
- **What NOT to do:** Do not keep a “bridge contract” string API
  with no production caller. Do not change `readContextFilesResult`
  bounds.

### AR-08 — Host-context read ignores the run interrupt hook

- **Path:** `agent-core/main.ts:4887`; option at
  `agent-core/host/context.ts:29`
- **Class:** YAGNI (unused option on the hot path) / KISS
- **Priority:** P3
- **Status:** NEW
- **As-is:** `ReadContextFilesOptions.shouldStop` is implemented and
  pinned by `host-output.test.ts`. `runPrompt` never passes it.
  Grep/glob/bash/fetch in the same run pass `{ shouldStop: () =>
  interrupted }`.
- **Should-be:** Same interrupt hook, or drop the option if overlay
  reads are always short enough that cancel is YAGNI.
- **Smallest fix:** Pass `{ shouldStop: () => interrupted }` at
  4887, **or** delete the option if a keep-reason says the overlay
  must finish.
- **What NOT to do:** Do not add a second cancel mechanism. Do not
  make the overlay async just to plumb abort.

### AR-09 — Tool announce and transcript detail duplicate the name switch

- **Path:** `agent-core/main/tools.ts:166` `formatToolAnnounce`;
  `:217` `toolTranscriptDetail`
- **Class:** Clean
- **Priority:** P3
- **Status:** NEW
- **As-is:** Same path/pattern/url/`N paths` mapping. Announce adds
  `$ ` for bash, spawn brief + `user-requested`, and
  `message_subagent`. The wave loop (`main.ts:5161–5162`) uses
  detail for the TUI and announce for the non-TUI path.
- **Should-be:** `formatToolAnnounce` composes
  `toolTranscriptDetail` and only adds the extra prefixes.
- **Smallest fix:** One helper for the shared cases; announce wraps
  it. Incidental — do this when touching `tools.ts`.
- **What NOT to do:** Do not unify announce with
  `formatToolFollowup` (follow-up is outcome text, different job).

### AR-10 — More 4+ argument functions (options bags)

- **Path:** `agent-core/main.ts:3011` `formatUsageIndicators` (6);
  `agent-core/session/fork.ts:98` `materializeVisibleFork` (8);
  `agent-core/compaction.ts:67` `shouldCompactForCacheCost` (5);
  `agent-core/compaction.ts:123` `truncateCut` (5);
  `agent-core/main/file-ops.ts:801` `editProjectFile` (5)
- **Class:** Clean
- **Priority:** P3
- **Status:** NEW
- **As-is:** Positional lists. Fork’s eight args sit on a
  crash-durable path (`source`, `dest`, `sourceState`, `messages`,
  `throughSeq`, `imageNames`, `sourceFingerprint`, `options?`).
- **Should-be:** Options objects where a swap is silent (usage
  indicators, fork). `editProjectFile(cwd, path, old, new,
  replaceAll)` is a stable tool-shaped tuple — keep it.
- **Smallest fix:** Fold `formatUsageIndicators` extras (`usd`,
  `flips`, `provider`) into one options object. Fork: one
  `MaterializeForkArgs` next to `SessionOperationOptions`. Leave
  compaction planners (pure, local, #321-adjacent).
- **What NOT to do:** Do not change fork argument *meaning* or
  receipt order. Integrity beats the rename. Do not “fix” every 4-arg
  helper in this tree in one pass.

---

## Review triggers (not findings)

These trip the 800-line comment. They already have an owner. Do not
open split tickets from this audit.

| Path | Lines | Keep-reason |
|---|---:|---|
| `agent-core/main.ts` | 6557 | #324 |
| `agent-core/subagents.ts` | 1119 | AR-03 is the comment-boundary note, not a blank split |
| `agent-core/main/file-ops.ts` | 931 | One mutation owner (read pages + write/edit + lock). No section banners. Extract write/edit only if that slice is already changing. |
| `agent-core/session/replay.ts` | 798 | Already split (`#38`). At the trigger; leave it. |
| `agent-core/session/bundles.ts` | 738 | Same |
| `agent-core/main/sidecar.ts` `createSidecarWriter` | 294 | One writer per process; state lives in the factory closure on purpose |
| `agent-core/session/lifecycle.ts` `SessionWriter` | 192 | Single writer class |

`session/replay.ts` at 798 is not a new god-file.

## Not findings

- **#333** — `electron/agent-activity.ts`. Other domain.
- **`xmlSafe` vs `skillIndexXmlSafe` vs `stripXmlControls`** —
  different control-character sets and destinations (file tags vs
  skill XML vs overlay). Same class as closed #321.
- **`yieldEventLoop` (`main/files.ts:58`) vs `yieldToEventLoop`
  (`session/primitives.ts:585`)** — one-line `setImmediate` each.
  Incidental. Session yields are tied to bundle budgets.
- **`genericToolText` vs `logicalToolText` vs `capDisplay`** —
  model-bound result vs forced continuation marker vs 2 KB
  transcript tail. One owner (`tool-output` + `tools`).
- **`formatSubagentResultFrame` vs `toolResult`** — stdout frame for
  the host vs provider `tool_result`. Two contracts, two owners.
- **`MAX_PAUSE_TURN_CONTINUATIONS = 5` (`main.ts:352`)** — specified
  in `docs/reference/AGENT-CORE.md`. Not a speculative loop-breaker.
  Stall detection stays in `stall.ts` (out of scope).
- **`truncateUtf8` alias** — live Electron import
  (`electron/subagents.ts:35`). Keep until #335 triage says otherwise.
- **`readContextFilesResult` + digest fields** — production needs
  the bounded accounting; not optional complexity.
- **Two-role cache / `prompt_cache_key`** — live provider behavior
  owned with `cache.ts` / `auth.ts`. Do not “simplify” from this
  audit.

## Checks

Docs-only. Observed: `wc -l` on the 33 production files (18,894) and
48 matching tests (16,293); export enumeration (568 names); identifier
use scan; `git` path existence for cited files. No typecheck, unit,
or e2e (no code change).
