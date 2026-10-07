# Termina: product, UI/UX, and developer-experience audit

**Date:** 2026-10-02. **Target:** the current working tree, including its in-progress changes—not a released build. **Deliverable:** an evidence-backed audit and an isolated, interactive design study. Production behavior has not been changed.

## Executive judgment

**Termina has a differentiated foundation, but the current experience is not yet the best way to supervise several projects and agents.** The terminal/editor pairing is valuable. Process ownership, snapshots, candidate comparisons, and incremental updates are substantive assets. The limiting factor is the human's ability to understand and safely direct concurrent work.

Today, users primarily navigate **projects → terminals → panels**. Their actual questions are **outcome → owner → work area → next decision → evidence**. The interface makes the user reconstruct those relationships. Adding more tabs, a terminal grid, or a larger Plan Board would expose more activity without necessarily making it manageable.

The proposed breakthrough is modest in implementation ambition but substantial in interaction: **make attention the organizing principle, and make tasks the unit of context.** Keep the real terminal as the source of truth. Do not build a second agent orchestrator or replace evidence with generated reassurance.

A visual rollout should follow—not precede—fixes to context identity, selected-terminal targeting, incomplete-task recovery, and verification validity.

## Evidence and limits

Reviewed the major product surfaces and their owners: `src/index.html`, `src/main.ts`, editor/explorer, layout, activity tabs/cues, review, timeline, worldlines, search, settings, command registry, computer-control approval, project/workspace orchestration, terminal lifecycle, Plan Board, Verify, restart/reload, setup/build/test scripts, fixtures, contributor/user documentation, and website positioning. Two independent read-only reviews covered concurrency and developer experience.

Evidence classifications below:

- **Source finding:** a concrete implementation path was inspected; its user-visible consequence has not necessarily been reproduced in Electron.
- **Reproduced:** a specific isolated experiment or existing test exhibited the stated result.
- **Design hypothesis:** a proposed improvement that needs user validation. No usability study, measured satisfaction score, or benchmark is invented.

This is broad product coverage, **not an exhaustive security review, provider matrix, accessibility certification, platform certification, or line-by-line audit of the repository**. No real agent task or provider request was intentionally launched for the audit. Electron checks used the existing isolated fixtures with `TERMINA_CORE_TEST=1`.

## What to preserve

1. **The real TUI and live editor.** They provide direct inspection rather than a chat wrapper that conceals execution.
2. **Independent process lifetimes.** Ordinary project switching hides views instead of stopping agents (`src/main.ts:364`, `syncPaneVisibility`). Main owns sessions; the renderer is a viewer.
3. **Explicit project/workspace ownership and stale-event fences.** These already protect many file, activation, and snapshot paths.
4. **Rust-owned snapshots and merges.** Keep capture, hashing, promotion, and recovery behind the canonical core client.
5. **Candidate isolation and honest platform limits.** Do not silently downgrade unsupported candidate execution into unsandboxed execution.
6. **Dirty-buffer protection during normal close.** Save / Discard / Cancel is real, and failed saves can prevent closing.
7. **Attention that normally avoids stealing focus.** Initial hydration is quiet; manually selected activity panels are respected.
8. **Lazy heavy views, bounded lists, and incremental updates.** A workspace overview must not eagerly create Monaco/xterm instances for every task.
9. **One preference store, one command registry, one semantic activity reducer.** Improve those owners rather than adding a parallel configuration or state system.
10. **The honest governor map.** `docs/reference/GOVERNORS.md` distinguishes enforced gates from conventions and release-only checks.

## Highest-priority findings

Priority describes recommended sequencing, not a demonstrated incident rate. None of these findings has been fixed or closed by this audit.

### 1. Cross-project file navigation can leave split authoritative context

**Priority: high. Evidence: source finding.**

`openFileSmartInner` routes absolute paths to the longest matching project prefix, then directly calls `setActiveProject` (`src/main.ts:1497–1552`). A terminal-link path also performs renderer-only selection (`src/main.ts:841`). This is not the full main-owned activation path. `setActiveProject` changes view identity/visibility; the complete explorer, terminal, review, timeline, and worldline activation runs through `applyFolderOpened` (`src/main.ts:2359`). Main's search roots remain main-owned.

**Risk:** the editor/project tab can show B while other surfaces and operations still refer to A. Ownership validation on file saves is a strength, but does not make the overall visible context coherent.

**Correct direction:** one authoritative activation transaction, used by tabs, links, search, review, and attention navigation. Every surface must agree on project and work area before accepting the next privileged operation.

**Validation:** open a parent project and a nested project. Follow an absolute link across them. Check the selected project in main, explorer root, selected terminal, Quick Open, session search, Plan Board, worldlines, and editor owner. Repeat with unrelated roots and slow activation.

### 2. Native interruption/close can target a different terminal from the selected one

**Priority: high. Evidence: source finding.**

`closeActiveTerminal` and `abortActive` select `activeProjectTerminals().at(-1)` (`electron/main.ts:4663–4670`). Renderer selection is maintained separately in `activatePane` / `lastActivePane`. The native actions therefore use stored order rather than the user's selected terminal.

**Risk:** a user focuses one agent and interrupts or closes another. Reordering can change the target. Closing is not a cosmetic operation.

**Correct direction:** main must know the selected terminal identity through the existing lifecycle/bridge boundary. Interrupt and close use an explicit validated target. Name that target in any consequential confirmation.

**Validation:** create two terminals, select the first, invoke native Ctrl+C and Close Terminal, and repeat after reorder and project switching.

### 3. An incomplete dispatch worker can strand its task assignment

**Priority: high. Evidence: source finding.**

On worker settlement, task state becomes done only when file-tool outcomes cover its paths, but the dispatch association is deleted regardless (`electron/main.ts:4947–4981`). Exit recovery resets tasks only while that association exists (`electron/main.ts:3287–3303`). `dispatchUnavailable` rejects assigned/active rows (`electron/plan-board.ts:224`). Clicking an assigned row navigates to its worker.

**Risk:** a worker can settle incomplete, then close, leaving a task assigned to an unavailable worker with no obvious retry path.

**Correct direction:** explicitly settle as completed, incomplete, failed, or interrupted; release execution ownership without discarding the result/history. Retry must be a deliberate action on the existing Plan Board path.

**Validation:** dispatch a two-file task, edit only one, settle, then close the worker. Also settle without a file write or after an error. The task must retain a useful result and recovery action.

### 4. More terminals or project tabs do not imply separate source trees

**Priority: high. Evidence: source finding; conflicting-write harm not reproduced.**

Ordinary agents and dispatch workers can share the primary workspace. `markOverlappingAgents` marks overlapping runs non-replayable rather than rejecting the second run (`electron/main.ts:5529`). Dispatch workers inherit the owner workspace (`electron/main.ts:4021–4040`). App-owned critical operations use write leases; those are not demonstrated exclusive ownership across every agent/shell write for the whole run.

Project opening deduplicates canonical root equality, not ancestor/descendant overlap (`electron/main.ts:6813`). A parent and nested project can therefore reference overlapping bytes through different workspace identities. Dispatch claim selection/briefings are useful coordination, not proof that every possible mutation channel is isolated.

**Correct direction:** visibly distinguish **project files** from a **separate candidate work area**. Independent tasks should use the existing isolated candidate machinery where supported, or be serialized/explicitly coordinated. Do not create another snapshot/worktree manager. Canonical source overlap must be understood before admission; displaying a warning after a write is not a safety solution.

**Validation:** same-file ordinary agents; parent/nested projects; symlink aliases; shell mutations that escape declared paths; candidate promotion while primary work is active. Preserve both sandbox and write-lease invariants.

### 5. A passing Verify result is not evidence for current files

**Priority: high. Evidence: source finding.**

Manual Verify does not use the same sibling-idleness checks as automatic Verify. Settled results store state, command, and summary, without tested source identity (`electron/main.ts:3477`). Results persist in terminal rosters and can be restored (`electron/roster-store.ts:90–103`; `electron/main.ts:2871–2873`). The inspected paths do not invalidate a pass on ordinary source movement. Handoff is offered from `verify.state === "pass"` (`src/main.ts:1414–1419`).

**Risk:** files change after a green result, or during its execution, while the visible result continues to imply readiness. A restart does not prove evidence is fresh.

**Correct direction:** record the tested source identity and actual execution metadata in the canonical Verify owner; invalidate/reclassify when source changes. Keep passing checks, review, and applying changes separate. Existing candidate evidence pinning is a pattern to consult, not a reason to add a second evidence implementation.

**Validation:** pass → agent edit; pass → user edit; pass → external edit; pass → quit → offline edit → restore. Verify during sibling writes. The result must either remain demonstrably tied to the tested source or become stale/unavailable.

### 6. Verify advertises package-manager execution but runs a raw shell body

**Priority: high. Evidence: source finding plus isolated reproduction.**

`detectTestFromPkg` extracts the script body and returns `sh -c <body>`, labeled `npm run test` (`electron/verify-detect.ts:37–55`). That is not npm's local executable lookup, lifecycle hooks, or injected script environment. The inspected Verify environment does not add the project-local executable directory.

**Reproduction:** an isolated fixture declared `"test": "termina-audit-check"` and placed the executable only in `node_modules/.bin`. The canonical detector's command exited **127**, `sh: termina-audit-check: command not found`; `npm test` in the same fixture exited **0**. This proves the command-semantics mismatch in isolation, not the complete Electron/candidate path. The temporary fixture was removed.

**Correct direction:** resolve the detector/executor contract at its owner and make the label truthful. Preserve immutable candidate evidence commands and shell semantics deliberately; do not merely relabel missing execution behavior or weaken tests.

**Validation:** local-only test executable, required `pretest` input, package-manager choice, shell operators, stripped secrets, and candidate checks whose package configuration has changed.

### 7. Recovery claims exceed dirty-editor durability

**Priority: high. Evidence: source finding; data loss not reproduced.**

`reloadPtyDocument` directly reloads the renderer (`electron/main.ts:1219–1226`), including the paint-watchdog path. Dirty text lives in renderer-owned Monaco models. Normal unsaved-close confirmation is a different path. The user guide's “nothing is lost” recovery claim (`docs/reference/USER-GUIDE.md:599`) is broader than these mechanisms justify.

**Correct direction:** preserve/recover drafts before planned renderer reloads, and define crash-time draft durability separately from session/process restoration. Do not claim unsaved draft recovery without evidence. If some state is not recoverable, disclose the exact limit rather than describing all recovery as lossless.

**Validation:** dirty editor during owned reload, crash, failed save, stale disk content, and a reload while confirmation is open. Validate terminal/session, selected project/terminal, dirty drafts, and review state independently.

### 8. Closing and switching have materially different consequences but insufficient disclosure

**Priority: high. Evidence: source finding.**

Project switching preserves background views/processes. Terminal close removes the pane and asks main to terminate it (`src/main.ts:1185`; `electron/main.ts:4577`). Closing an owner also kills its background children. Project close checks dirty buffers and candidate activity, but does not equivalently disclose ordinary busy agents/workers (`electron/main.ts:6740`, `closeProjectOnce`).

**Correct direction:** distinguish **switch**, **stop task**, **close terminal**, and **close project**. Name affected live work before termination. Do not add a “detach” promise unless the lifecycle really supports it. Handle close failure without presenting a still-live session as gone.

**Validation:** close an ordinary busy agent, dispatch worker, long shell command, and subagent owner. Include background project closure, dirty buffers, and a rejected close request.

## Whole-experience review

| Surface | Current strength / friction | Recommended direction and validation |
|---|---|---|
| First launch and onboarding | Fresh users receive the existing TUI login picker; the editor hints at `/login` and `/models`. This splits first-use guidance between two surfaces. | Lead with opening a project. Keep files/shell useful before auth. Confirm that guidance remains findable after opening a file, cancelling login, and using expired credentials. No second credential editor. |
| Project navigation | Per-project editors and terminals survive normal switching. Basename-only labels and tooltip-only paths make same-name roots harder to distinguish. | Persistent project rail with visible short identity, counts/reasons, path disclosure, and canonical overlap handling. Switching is navigation, not cancellation. |
| Agent identity | Ordinary agents share cwd-derived names; workers are commonly called `dispatch` (`src/main.ts:1222`). | Use task outcome as the primary label; keep agent/session identity available. A notification must resolve to one exact project, task, and terminal. |
| Attention | Working/blocked dots, unseen Verify failure dots, chimes, and named toasts already exist. They compress several outstanding items into one signal. | Durable unresolved items with a reason and action. Viewing is not resolving. Avoid announcing every tool event; never automatically navigate away from typing/review. |
| Plan Board | Existing plan parsing and dispatch are useful; successful file-tool coverage is not semantic task acceptance or passing tests. | Task state explains outcome and recovery. Reuse this owner. Separate “execution stopped,” “result available,” “verified,” and “accepted.” Test edits that touch assigned paths without achieving the goal. |
| Terminal interaction | TUI source of truth, interrupts, paste, attachments, and slash commands are valuable. App and TUI shortcuts intentionally differ in places. | Preserve that boundary; show contextual shortcut meaning. Explicit-target stop actions. Do not replace the PTY with a generated transcript. |
| Live files and editor | Dirty watcher pushes become conflicts rather than silent replacement (`src/editor.ts:456–477`). Automatic file previews help observation. | Persistent conflict attribution and an inspectable resolution, not just a transient toast. Validate auto-open while typing, inactive-project return, deletion, large files, and candidate ownership. |
| Change Review | Side-by-side diff, Accept/Revert, and refreshed contents provide direct inspection. | Show source/target work area and freshness. Explain whether an action applies to existing primary files or a candidate. Never use review acceptance as a synonym for commit or test success. |
| Verify | Bounded execution, cancellation, stripped credentials, and agent feedback are useful. Human presentation is mainly a badge/tooltip (`src/main.ts:1375–1411`); settled badge clicks do not reveal output. | Inspect actual command, source relevance, duration, exit, cancellation, output and truncation. Keep the final failure even when logs are capped; current collection keeps the first 200,000 characters. |
| Timeline and replay | On-demand content, sequence updates, bounded events, and forkability states are substantive. | Present history as an advanced task view. Recording unavailable/degraded must remain visible. Validate non-Git, overlapping runs, missing snapshots, pending capture, and unsupported forks. Avoid “every dot is restorable.” |
| Worldlines | Incremental A/B cards, explicit promotion confirmation, stale evidence, comparison and export are differentiated. | Keep the capability, progressively disclose its terminology. Default language can be “Compare alternatives”; retain exact A/result versus B/retry roles. Test unsupported platforms, stale evidence, conflicts, and interrupted promotion. |
| Search and actions | Quick Open has combobox/listbox semantics and stale-result protection. Content Search acknowledges truncation. | Search actions as well as work. Current palette excludes main-scope actions such as Open Folder and Interrupt (`src/quick-open.ts:456–468`). Extend the canonical registry/bridge, not a duplicate action system. |
| Session history | Bounded search protects responsiveness. Oversized/old coverage can be omitted while UI says “No matches.” | Expose searched coverage and truncation. Limits include 50 sessions, 50 hits, 10 MB segments and 10,000 lines (`electron/session-search.ts:18–22`). “Not found in searched history” is not “never happened.” |
| Settings and customization | Shared validation, themes, font size, shortcut overrides, and protected preference-read failure are good foundations. | Keep optional tuning secondary to sensible defaults. Validate larger type, shortcut conflicts, invalid preference files, and reset scope. Do not make safe concurrent work depend on expert settings. |
| Keyboard and accessibility | Explorer has roving focus and type-ahead; activity tabs and Quick Open have semantics. Coverage is uneven. Project tabs/close controls are click-bound div/span elements (`src/main.ts:180–204`); Session Search is less semantically complete than Quick Open. | Make every core workflow keyboard-reachable with clear names, selection, modal focus return, and non-color state labels. Test per-task dispatch/review, project close, screen readers, 200% zoom, and reduced motion—not just palette navigation. |
| Computer-control approval | Explicit window selection, retained-data disclosure, and a persistent Stop control are appropriate. | Show requesting project/agent as well as task/application. State already carries `terminalId` (`shared/computer-control.ts:14–15`), while current visible copy omits requester attribution (`src/computer-control.ts:25–43`). Test background requests, window changes, timeout, refusal and Stop failure. This in-progress capability was not modified. |
| Layout and responsiveness | Pane minimization, split arrangements, stored ratios, and selected-terminal fitting are practical. | Make overview a separate view, not an ever-shrinking terminal mosaic. Existing focused E2E has an empty-project collapse mismatch; investigate onboarding occupancy before changing layout. Validate narrow windows, zoom, split drags, and focus restoration. |
| Restart and restore | Main-owned PTY lifetime and roster restoration are valuable. Selected terminal and unresolved attention are not uniformly durable. | Reconcile history, current source, live processes and stale evidence before calling work running. `restoreInitialProjects` reads active-project preference after opens that can update it (`electron/main.ts:8723–8785`): test timing-dependent focus. Capture intended focus before restoration mutates it. |
| Performance | Heavy snapshots are off the main loop; lazy Monaco/review and list caps are strengths. Large generated Monaco chunks produce a build warning. | Overview consumes small summaries, not full histories/diffs/terminal buffers. Fetch on focus. Benchmark 1/5/20 projects with bounded live agents and busy output before claiming scale; no latency result was measured here. |
| Install and contributor DX | Locked dependencies, build scripts, fixture ownership, and release checks are substantial. | Document actual prerequisites and a fresh-checkout sequence. macOS build invokes Swift (`scripts/build-computer.ts:6–9`), which setup prose/preflight omits. Some unit tests need the built Rust core. Distinguish check prerequisites from test failures. |
| E2E and CI DX | Fixtures isolate project/events/worlds/user-data/HOME and own child cleanup. The governor map honestly scopes CI. | Update obsolete DevToolsActivePort runner prose. Use deterministic synthetic mode explicitly; filesystem isolation alone does not remove ambient credentials or catalog networking. Add focused runtime tests for context/target/recovery, not only source-shape assertions. |
| Website, docs and trust | Positioning around control, verification, and alternatives is distinctive. Claims sometimes broaden beyond actual boundaries. | Clarify local storage versus provider/MCP network use; primary normal-access processes versus sandboxed candidates; working files versus `.git` metadata. `website/index.html` says “isolates everything,” “never writes your repo,” and “any dot”; these need narrower claims. Keep platform limits near capability explanations, not only installation. |

## The mockup: an attention-first workspace

Open [`../mockups/workspace/index.html`](../mockups/workspace/index.html). It uses the production stylesheet's colors and Departure Mono font, with a system sans-serif for outcome text. It adds no theme, dependency, application IPC, provider request, or filesystem capability.

### Information architecture

```text
Workspace
├── All projects: the overview of work and unresolved decisions
├── Project: a filtered view, not a separate process lifetime
│   └── Task: outcome + owner + work area + result/evidence
└── Focus task: its real terminal, files/diff, checks and next action
```

**Persistent left rail:** projects, identity, running count and outstanding attention. Paths are visible in the work overview and selected context. Project count is not agent count.

**Cross-project attention:** actionable items remain visible even while a project is filtered or a task is focused. In the study, overlap/blocked/recovery items precede review. A production priority policy needs evidence and user validation, not an opaque urgency score.

**Task-centered work overview:** concise task cards grouped by project. Each names the goal, state, agent, and work area. This is not a second independent Kanban/issue tracker. It is a view of the existing plan/run/session ownership.

**Focus view:** terminal, changes and inspectable checks in one context, with other decisions still visible. No expectation that users watch six terminals simultaneously.

**Right context panel:** answers “What do I do next?” and “Where is this work happening?” It contains one primary action appropriate to the state, not an unranked toolbar of every capability.

### State distinctions

| State | Meaning and next action |
|---|---|
| Queued | Admission/capacity is pending. Do not imply a live process. |
| Working | A live task is executing. Navigation does not cancel it. |
| Needs a decision | A specific question or permission must be answered. Viewing it does not resolve it. |
| File overlap | Admission/ownership conflict, not a normal background activity. Resolve work area or serialize before writing. |
| Interrupted / incomplete | Execution stopped without an accepted outcome. Inspect checkpoint/result; explicitly retry/resume. |
| Ready for review | A result is available. This is neither an automatic application nor a blanket test-success claim. |
| Check passed / failed / cancelled / stale / unavailable | Evidence state is separate from execution state and refers to an identifiable tested source. |
| Reviewed, not applied | A human decision has been recorded; applying changes is still explicit. |

The study exercises queued, working, blocked, overlap, interrupted, ready-for-review and reviewed states. It illustrates passing, not-run, and stale checks. It **does not implement every production lifecycle/error state in this table**; failed/incomplete admission, real cancellation and promotion are remaining production design/verification work, not hidden functionality in the demo.

### Working interactions

- Select all projects or filter by project; background sample work is retained.
- Select an attention item/task; open its owning Focus view.
- Inspect files and sample diffs/check details.
- Decide between 204 idempotent success and 409 conflict; the sample task resumes.
- Mark a result reviewed without applying/staging/committing anything.
- Queue a new task or sample follow-up; user text is escaped.
- Search projects/tasks with **Cmd/Ctrl+K**, Tab and Enter.
- Exercise **Daily work**, **File overlap**, **After restart**, and **First run** scenarios.
- Reset sample data; dismiss dialogs with Escape and recover keyboard focus.

**All data is simulated.** “Separate work area” is a proposed interaction/default, not proof a directory, lease, sandbox or candidate exists. Real admission must reuse the existing worldline/sandbox ownership and fail closed where unsupported. No refresh persistence is promised; reload/reset intentionally discards the sample.

### Why this instead of the obvious alternatives?

- **Not a terminal mosaic:** six live streams increase scanning load and shrink the editor. Preserve mosaic/fullscreen as optional execution views, not the primary management model.
- **Not a huge Kanban:** a board can show assignments, but alone does not prove source ownership, current evidence, live execution, or a safe next action.
- **Not a second chat supervisor:** asking a model to summarize the other models adds another trust boundary. Derived factual state should link to the terminal and exact result.
- **Not an autonomous agent fleet:** more concurrency is not itself progress. Safe admission, independent work, dependency handling, and finite human review capacity matter more than agent count.
- **Not a separate app per project:** the user should not lose cross-project attention or reconstruct global work from several windows. Focus can be deep without being isolated from decisions elsewhere.

## Validation questions to ask before implementation

### Does the concept reduce the right work?

1. With three projects and six agents, can a user identify the highest-impact pending decision without opening every terminal?
2. Can they distinguish “agent stopped,” “result available,” “check passed,” “check stale,” and “accepted” without reading a tooltip?
3. Does a task title remain useful when the agent revises its plan? Who owns that title and its stable identity?
4. Can someone return after an hour and reconstruct what changed, what requires attention, and what is still running from factual state?
5. Is the overview overhead for a single-project/single-agent user? Keep direct task focus and existing terminal-first use possible.
6. Does adding a second project produce value without requiring a workspace/team setup ritual?

### Does it preserve safety and authority?

7. Do all navigation paths activate the same main-owned context atomically?
8. Can a delayed response or notification ever target a different project/task after the user switches?
9. Is the actual source tree shown, including parent/nested project overlap and candidate roots?
10. Are separate work areas genuinely sandboxed under the existing policy—not merely separate directories?
11. If two tasks depend on the same files, do admission/serialization solve the conflict before editing?
12. Does promotion detect primary source movement and retain recovery? Never solve this with a renderer-only flag.
13. Does closing a view have a clearly distinct meaning from stopping its process? What exactly survives each action?
14. Are computer/browser/MCP permissions attributed to the requesting project/task, and does their expiry survive navigation correctly?

### Does it communicate failure honestly?

15. What happens when a worker exits, settles incomplete, hits a failure loop, or never starts?
16. If auth expires mid-run, does the user retain the task, draft and explicit recovery action?
17. If Verify cannot find a binary or loses required secrets by design, can a human inspect the mismatch directly?
18. Are timeout and cancellation distinct from failed assertions? Are child processes gone before cancellation is called complete?
19. Can a test result stay green after source edits or restart? What precise state makes it stale?
20. What is recovered after renderer failure versus application restart? Are unrecovered drafts called out?
21. Are skipped/truncated search coverage, output and recordings visible rather than represented as complete or empty?
22. Does an unsupported platform offer a useful ordinary workflow without suggesting unavailable isolation/promotion?

### Does it scale without becoming another dashboard?

23. Do all outstanding decisions fit in an understandable queue at 20 projects? Introduce grouping/caps only when measured need warrants them.
24. Do global alerts avoid stealing focus from typing, review and permission dialogs?
25. Can every core path be completed with keyboard, screen reader, large fonts and zoom?
26. Are small summaries pushed incrementally while terminal output/diffs/history are fetched on demand?
27. Is review capacity explicit enough that launching ten more agents does not simply produce ten unreviewed results?
28. Can users pause admission without guessing that “pause all” safely kills work? Such controls need defined main-owned lifecycle semantics first.

**Suggested user exercise, not a fabricated result:** seed the same tasks in the current UI and the study. Ask participants to unblock one background task, inspect another project's failed/stale check, find a source overlap, and return to their original editor. Record time, wrong-context actions, missed decisions and recovery errors. Compare new users and terminal-first users. Let that evidence decide whether the added overview earns its space.

## Implementation sequence

### First: protect trust in the existing loop

Fix authoritative activation, selected-terminal targeting, incomplete dispatch settlement/retry, Verify command semantics/freshness, close disclosure and draft recovery. Add focused runtime tests for the actual paths. Correct unsupported absolute documentation claims. Do not ship a prettier presentation of invalid state.

### Next: make existing state legible

Extend project/task/run summaries through main's typed bridge with exact owner, work-area kind, live/execution state, unresolved attention reason and evidence relevance. Reuse `electron/agent-activity.ts`, Plan Board, worldlines and terminal runtime as owners. A task view must not become another session registry.

Build the project rail and attention view incrementally. Keep existing terminal-first navigation possible. Load terminal/editor/diff/check detail on demand. Make Stop/Close and key workflows keyboard-reachable through the canonical command registry.

### Then: improve independent work admission

Use existing candidate provisioning/sandbox/promotion machinery for separate tasks only after lifecycle semantics are defined. Resolve nested-root overlap and stale source before claiming safe parallelism. Explicitly retain coordinated shared-tree workflows when required; do not advertise universal isolation or invent a parallel worktree stack.

Advanced comparisons, challenges, evidence and export remain available inside the relevant task/result. Do not delete differentiated capabilities merely to make the interface look simpler.

### Finally: validate usability and scale

Run the user exercise, failure matrix and realistic responsiveness measurements. Add bounded grouping/search when actual project counts warrant it. Delay dependency graphs, resource schedulers, spend dashboards, autonomous routing and team administration until an observed product requirement justifies them. None is necessary to make the current loop coherent.

## Checks performed

| Check | Observed result |
|---|---|
| `pnpm run typecheck` | Passed. |
| `pnpm run build` | Passed, including Rust core and macOS Swift helper. Vite reported the existing large-chunk warning; no warning thresholds were changed. |
| `pnpm exec vitest run tests/unit/ui/activity-cue.test.ts tests/unit/ui/activity-tabs.test.ts tests/unit/electron/verify-detect.test.ts` | **36 tests passed** across three files. This does not reproduce or close the high-priority findings. |
| Isolated canonical Verify-detector/local-binary experiment | Expected semantics mismatch reproduced: raw shell exit 127 versus npm exit 0; fixture cleaned up. |
| `TERMINA_CORE_TEST=1 pnpm exec playwright test tests/e2e/multiproj.spec.ts tests/e2e/agent-activity.spec.ts --reporter=line` | **4 passed, 1 failed**, including the configured retry. The empty-project editor-collapse test failed at `tests/e2e/multiproj.spec.ts:64`: expected one `#right-pane.minimized`, received zero. The failure snapshot showed login guidance. Whether the layout or test expectation should change requires deciding onboarding occupancy; no production fix was attempted. |
| `TERMINA_CORE_TEST=1 pnpm exec playwright test tests/e2e/resize.spec.ts --grep 'project tab clicks above the divider' --reporter=line` | **Failed**, including retry, at setup geometry `tests/e2e/resize.spec.ts:195`: expected divider x 120.5625, received 142. The explorer has a 140 px minimum (`src/styles.css:228`). This fails before the click behavior is exercised, so it does **not** prove tab clicks start a resize. |
| `node docs/mockups/workspace/verify.mjs --screenshots` | **13 browser checks passed** on the final study. Exercises interaction/state flows, escaped input, dialogs/focus, keyboard search, no page-level horizontal overflow at 1512/1280/1024/768/390/320 px, basic light/high-contrast token rendering, and reduced motion. No browser/CSP errors or external requests. This is not full accessibility certification or proof of production concurrency. |

An earlier package-script E2E invocation unexpectedly selected the broader suite and returned failure. Its retained failed IDs mapped to the same collapse and resize tests; the targeted commands above supplied diagnostic evidence. No full-suite-green claim is made.

### Subsequent implementation evidence

The table above records the original audit run, not the current implementation branch's final checks. The [implementation milestones](../plans/attention-first-workspace.md#source-tree-admission-milestone) record later source-admission, startup-rejection, and shutdown coverage separately.

The empty-project reproduction was subsequently classified: the failure snapshot's visible login guidance intentionally occupies the editor (`src/main.ts`, `editorPaneOccupied`; `src/main/layout.ts`, `syncEditorMinimizedForProject`). The collapse regression now supplies credentials in its isolated HOME; a separate regression preserves the unauthenticated hint and verifies collapse after credentials are stored. All three multi-project Electron tests passed. No production layout behavior was changed, and the original assertions about collapse and restoration were retained. The separate resize setup failure above has not been fixed or reclassified by this work.

Screenshots are generated from the study, not the production app: [`overview.png`](../mockups/workspace/overview.png), [`focus.png`](../mockups/workspace/focus.png), [`overlap.png`](../mockups/workspace/overlap.png).

**Not run:** a comprehensive Rust test run, release/package validation, Linux/Windows execution, live-provider tasks, crash/draft-loss reproduction, screen-reader testing, user usability study, and multi-project performance benchmarks. No Rust or production application code was edited. Those exclusions are not unfinished mockup features; they limit the audit's claims.

## Bottom line

The best next product step is **not more visible agent activity**. It is a trustworthy answer to: **what needs me, whose work is it, where is it happening, and what evidence makes the next action safe?**

The interactive mockup and source-level audit are complete. Production fixes and user validation are intentionally separate next steps. Existing application test failures remain reported, not hidden or weakened.
