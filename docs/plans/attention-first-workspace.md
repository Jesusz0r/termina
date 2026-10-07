# Attention-first workspace: product and UX proposal

**Status:** staged implementation in `feature/attention-first-workspace`. Correctness and factual-context milestones are recorded below. Phase 3 is implemented. Phase 4 admission, preparation feedback, explicit startup retry and the strict candidate Bash write-back probe have scoped passing typechecks, units, build and Electron evidence under the approved native resource contract. Phase 5 technical validation now covers the bounded output workload, native-zoom keyboard inspection and six concurrently executing agents in admitted work areas. Loaded latency and cross-project candidate cleanup defects were corrected and verified. Actual VoiceOver use, participant evaluation and larger-scale acceptance remain unproven. Remaining proposed slices are not production claims.

This document records the recommendation behind the [interactive workspace mockup](../mockups/workspace/index.html). The [dated product, UI/UX, and developer-experience audit](../reference/WORKSPACE-EXPERIENCE-AUDIT.md) retains the original findings. The rollout sections below distinguish implemented slices, observed checks, and pending validation from the remaining proposal.

## Release boundary: v0.1.63

This release contains the implemented project rail, global attention inspection, factual work context, navigation and recovery fixes, source admission, candidate startup/retry, and scoped automated validation. It preserves the direct terminal/editor workflow.

It does not reproduce the mockup's complete presentation. All projects currently opens the optional attention panel, not a task-card overview. The central project/task overview, integrated attention section, selected-task inspector, and matching visual hierarchy remain follow-up work. The mockup stays a simulated design reference, not a second application or evidence of implemented task execution.

Merge and release this functional slice before starting the visual follow-up. Live-provider, VoiceOver, participant, native other-platform, and longer-soak validation remain outside the automated evidence recorded here.

## Recommendation

**Organize Termina around the user's decisions and task outcomes, rather than around the number of terminal tabs.**

Termina's real terminal, live editor, snapshots, and candidate comparisons are strong foundations. The difficulty is supervising concurrent work: understanding which project needs attention, which agent owns a task, where it is writing, and whether its result is safe to accept.

The proposed experience should answer five questions without requiring users to inspect every terminal:

1. What needs my decision?
2. Which project, task, and agent does it belong to?
3. Where is that agent actually writing?
4. What changed, and what evidence applies to those changes?
5. What is the next safe action?

**Confidence:** high that the audit identifies concrete context and trust issues; medium that this interface is the best way to address the human supervision problem. The design needs usability validation. No adoption, satisfaction, or productivity improvement has been measured.

## The problem to solve

The current interaction is primarily:

```text
Choose project → choose terminal → choose panel → reconstruct context
```

The proposed interaction is:

```text
See outstanding decisions → choose a task → inspect its context → act
```

This is a change in presentation, not permission to introduce another agent orchestrator. A task view should connect existing plan, run, terminal, workspace, and evidence ownership. It should not become a second source of application state.

More visible activity is not necessarily more useful information. A terminal grid exposes execution, but asks the user to monitor several streams at once. A larger board exposes assignments, but does not by itself establish source ownership, evidence freshness, or a safe next action.

## Proposed workspace

### 1. Persistent project rail

Keep project navigation visible, with:

- A distinguishable project name and accessible path disclosure.
- Separate counts for active work and unresolved attention.
- A way to return to all projects.
- Navigation that does not stop background work.

Project count, agent count, and independent source-tree count are different things. The UI must not imply that opening another project or terminal creates isolation. Same-name projects and parent/nested roots need clear identity.

### 2. Cross-project attention queue

Show unresolved decisions across all projects, even while one project is filtered or a task is focused.

Each item should identify its project, task, requesting agent, reason, and action. Examples include a permission request, a task question, a source overlap, an interrupted task, a failed or stale check, and a result awaiting review.

Viewing an item is not resolving it. Do not erase outstanding work simply because the user opened its terminal. Avoid announcing every tool event or stealing focus from typing, review, or approval dialogs.

The mockup places overlap, blockers, and recovery before ordinary review. A production ordering policy still needs validation; no opaque urgency score is proposed.

### 3. Task-centered overview

Group concise task cards by project. Each card should communicate:

- The intended outcome, rather than only a cwd or generic worker label.
- The responsible agent/session.
- Execution state and the reason for waiting, if any.
- Whether it is using project files or a separate candidate work area.
- Whether there is a result or evidence to inspect.

Reuse Plan Board and existing run/session relationships. Do not introduce a separate issue tracker or a mandatory workspace setup ceremony.

### 4. Focused task view

When a task needs deeper inspection, show its terminal, changed files, diff, verification evidence, and next action together.

Keep other projects' outstanding decisions available without forcing the user to watch all agents simultaneously. The real terminal remains the source of truth; a generated activity summary cannot substitute for execution history.

A user with one project and one agent should still be able to work directly in the terminal/editor view. The overview must not become an extra required step for the simple case.

### 5. Context and evidence panel

Give the selected task one clear primary action appropriate to its state. Show:

- Project, task, agent, and actual work area.
- The current question or result.
- Changed files and inspectable checks.
- What the proposed action will affect.

Passing checks, human review, applying changes, staging, and committing must remain distinct. A green result is meaningful only when it applies to the source state being reviewed.

## State semantics

Execution, evidence, and acceptance describe different facts. Their presentation should compose existing authoritative data, not create a parallel state machine.

| Dimension | Required distinctions |
|---|---|
| Execution | Queued, working, waiting for a decision, interrupted, failed/incomplete, result available. |
| Work area | Shared project files versus a separate candidate tree; actual supported isolation must be truthful. |
| Evidence | Not run, running, passed, failed, cancelled, timed out, stale, unavailable. |
| Human acceptance | Awaiting review, reviewed but not applied, explicitly applied where supported. |

“Idle” does not mean successful. “Paths touched” does not prove the goal was achieved. “Reviewed” does not mean applied. A prior passing check must not remain a readiness signal after relevant source changes.

## Core workflows

### Start independent work

Choose the project and describe the outcome. Show queued status until actual admission and process startup succeed. Resolve source overlap before competing writes occur.

For independent tasks, prefer the existing isolated candidate machinery where supported. If safe isolation is unavailable, use an explicitly coordinated or serialized workflow rather than silently presenting ordinary terminals as isolated.

### Handle a background decision

Surface the requesting project, task, and agent in the global queue. Navigate through one authoritative activation path. Let the user inspect the context, answer the question or permission request, and return without losing their previous work.

### Review a result

Open the owning task. Inspect its changes and the exact command, source relevance, output, and outcome of its checks. Record human review separately from any action that changes primary files.

Candidate promotion must retain the existing source-movement checks, conflict handling, and recovery. A renderer-only readiness flag cannot authorize it.

### Recover interrupted work

Retain the task and its result/history even if its worker is gone. Offer an explicit retry or resume path, and distinguish recovered session history from a currently running process.

After restart, reconcile current files and evidence before presenting old results as fresh. State exactly what can be recovered, including the limits on unsaved editor drafts.

### Stop or close

Switching projects is navigation. Stopping a task interrupts execution. Closing a terminal or project can terminate processes and dependent work.

Name the affected target and disclose the consequences. Do not promise detach/background preservation unless the lifecycle actually implements it.

## Fix trust issues before a visual rollout

The audit records the following priorities. Most are source findings whose full user-visible consequences still need runtime reproduction; the Verify command mismatch also has an isolated reproduction.

| Priority area | Required direction |
|---|---|
| Cross-project activation | Make tabs, links, search, review, and attention navigation use one main-owned activation path. |
| Selected-terminal targeting | Interrupt and close the explicitly selected, validated terminal—not the last item in stored order. |
| Incomplete dispatch recovery | Release stale execution ownership while retaining the task, result/history, and a usable retry action. |
| Source-tree overlap | Distinguish shared files from separate candidates and coordinate admission before writing. |
| Verification validity | Record actual execution semantics and tested source identity; make outdated evidence stale. |
| Draft and session recovery | Separate process/session restoration from unsaved draft durability; substantiate recovery claims. |
| Close disclosure | Explain termination of ordinary active agents, workers, and children, not only candidate activity. |

Do not ship a clearer-looking presentation of misleading state. The detailed failure paths and validation tests belong to the [audit](../reference/WORKSPACE-EXPERIENCE-AUDIT.md), not a duplicated implementation backlog here.

## What to preserve, simplify, and defer

**Preserve:** the real TUI, live editor, dirty-buffer protection, main-owned process lifetime, explicit ownership, Rust snapshots/merges, candidate isolation, evidence, comparison, promotion, and export.

**Simplify:** project/agent attribution, attention, navigation, task recovery, check inspection, and the common review loop. Keep advanced timeline, challenge, and comparison controls available in context rather than making every user learn them upfront.

**Defer:** another chat supervisor, autonomous fleet management, dependency graphs, resource schedulers, spend dashboards, team administration, and elaborate priority configuration. They are not necessary to make the current loop coherent. This proposal does not recommend destructive feature removal without usage and migration evidence.

**Tradeoff:** an overview adds a management surface and requires trustworthy summaries. It earns its place only if it reduces missed decisions and wrong-context actions without slowing single-agent use or main-process responsiveness.

## Architectural boundaries

- Main remains authoritative for project/workspace identity, process lifecycle, admission, and privileged operations.
- Renderer owns presentation and transient selection; privileged actions use the typed preload bridge.
- Extend the canonical activity, Plan Board, terminal-runtime, worldline, evidence, command, and preference owners. Do not duplicate them.
- Rust remains responsible for Git/snapshot capture, hashing, and merge operations.
- Separate directories are not sandboxes. Preserve existing isolation and write-lease requirements.
- Overview updates should contain small factual summaries. Load terminal buffers, editors, diffs, and history on demand, with bounded lists and caches.
- Reuse existing theme tokens and accessibility patterns rather than introducing a new theme or configuration system.

## Rollout sequence

1. **Protect the existing loop.** Reproduce and fix the trust issues; add focused runtime coverage and correct unsupported documentation claims.
2. **Make current state legible.** Add project/task summaries, exact attribution, unresolved attention, and inspectable evidence through existing owners.
3. **Introduce the rail and attention view.** Preserve direct terminal-first use and make core actions keyboard-accessible.
4. **Improve independent-task admission.** Reuse candidate provisioning, sandboxing, and promotion only after ownership and recovery semantics are defined.
5. **Validate usability and scale.** Measure the design before adding grouping, automation, or management features.

No duration or effort estimate is asserted here. Scope and sequencing should be refined after the first runtime reproductions.

## Initial implementation work

Work has started in the isolated local branch `feature/attention-first-workspace`, based on commit `049a12c0`. This does not approve or implement the proposed visual redesign.

The first correctness change addresses cross-project file navigation:

- An Electron reproduction confirmed that a terminal file link selected the target project's visible tab while main still selected the source project.
- Main now returns the same authoritative folder context in the activation reply that it publishes in `folder:opened`.
- Project tabs, keyboard project selection, activity cues, and cross-project file navigation use the same renderer activation helper. The reply and push share the existing context application, with generation fencing and duplicate suppression.
- A file open waits for the owning project context to be applied. Explorer and terminal ownership change synchronously; heavy panel data retains its existing asynchronous loading and stale-response fences.
- File routing retains longest-root matching for primary project links and does not replace an explicit candidate owner with a primary workspace.

Implementation owners: [`src/main/project-activation.ts`](../../src/main/project-activation.ts), [`src/main/file-navigation.ts`](../../src/main/file-navigation.ts), [`src/main.ts`](../../src/main.ts), [`electron/main.ts`](../../electron/main.ts), and [`shared/types.ts`](../../shared/types.ts).

Regression coverage: [`project-activation.test.ts`](../../tests/unit/ui/project-activation.test.ts), [`file-navigation.test.ts`](../../tests/unit/ui/file-navigation.test.ts), and [`project-file-navigation.spec.ts`](../../tests/e2e/project-file-navigation.spec.ts). The Electron regressions invoke the real terminal's registered file-link callback; parser and modifier-key behavior are covered separately by the terminal-link unit tests. They check unrelated and nested project activation, explorer and editor ownership, terminal selection, active-project file search, and a background terminal's relative link.

Observed checks passed: application and test typechecks, 70 focused unit tests, the production build, and 12 focused Electron tests covering the new regressions, file/content search, ordinary project switching, and IPC navigation isolation. This is not a claim that the full Electron matrix is green: an earlier broad run timed out and showed the previously documented empty-project editor-collapse failure. Neither that layout issue nor Verify command semantics is changed in this step.

## Recovery and close-safety milestone

Durable editor-draft recovery is implemented separately from the proposed rail and attention view. Drafts stay in app-private storage and are scoped to authorized project/workspace/file ownership; recovery does not silently overwrite a changed or unsafe disk replacement.

Consequence-aware terminal, project, and application close now uses main-owned lifecycle facts:

- Native Ctrl+C and terminal close name the target and disclose active agent or dispatch work, background child runs, verification, and terminal-local Change Review state. Shell command activity is treated as unknown, not guessed idle.
- Ctrl+C remains distinct from closing: it does not directly stop separate workers, background children, or verification. Direct terminal Ctrl+C and the emergency-stop chord remain immediate.
- Project close warns only about the affected project; quit/update warns about all projects, including candidate source changes or session activity. Switching projects does not use this teardown gate.
- Cancel preserves the pane and work. Renderer cleanup waits for main's acknowledgement; stale targets, changed work, inspection failures, and unavailable confirmations fail closed.
- A later close cancellation leaves dirty editor text and its recovery copies intact. Closing an owner also denies new background-child admission during teardown.

Implementation owners: [`electron/main/close-confirm.ts`](../../electron/main/close-confirm.ts), [`electron/main.ts`](../../electron/main.ts), [`electron/agent-activity.ts`](../../electron/agent-activity.ts), [`electron/subagents.ts`](../../electron/subagents.ts), [`src/main.ts`](../../src/main.ts), and [`shared/types.ts`](../../shared/types.ts). Coverage includes [`close-confirm.test.ts`](../../tests/unit/electron/close-confirm.test.ts), [`terminal-close.test.ts`](../../tests/unit/ui/terminal-close.test.ts), and [`lifecycle-close.spec.ts`](../../tests/e2e/lifecycle-close.spec.ts).

This does **not** complete rollout step 3 or implement the production rail/attention view. Source-tree admission is implemented separately below.

## Source-tree admission milestone

Independent agent starts now reserve canonical physical source scopes before preparation, rather than relying only on a workspace's short-lived snapshot/write lease. Equal roots, aliases, and parent/nested roots conflict; sibling name prefixes do not. Projects with nested roots remain openable for navigation.

- Reservations span preparation and the active run. Background subagents retain their owner's scope until the last child has actually been removed from the host registry.
- Prompt-named MCP processes start only after successful preflight. Their tools are installed before the first model request, while updates during an established turn retain the existing deferral. A real-process regression proves source denial prevents startup and an admitted retry starts the configured server. Admission is not a filesystem sandbox for arbitrary or persistent service writes.
- Plan Board workers use their existing owner coordination and file-claim path. Ordinary terminals cannot opt into that group.
- A live shell reserves its initial physical source scope as unknown activity. Shells on that same scope can coexist, but an independent agent cannot start there until they close. This does not sandbox arbitrary shell writes or track every background shell descendant.
- Critical file operations also compare canonical source scopes across workspace IDs, so two overlapping workspaces cannot independently hold write leases.
- Failed preflight releases the preparation reservation and the dispatch assignment. Startup that never confirms is interrupted while its source scope remains held until settlement or PTY exit; a previously live run is not released by failed re-preparation.
- Primary folder identity is checked again before admission. Replaced folders or retargeted aliases require reopening rather than silently adopting different source files.

Implementation owners: [`electron/main/source-admission.ts`](../../electron/main/source-admission.ts), [`electron/main.ts`](../../electron/main.ts), [`electron/terminal-runtime.ts`](../../electron/terminal-runtime.ts), and [`electron/subagents.ts`](../../electron/subagents.ts). Focused coverage includes [`source-admission.test.ts`](../../tests/unit/electron/source-admission.test.ts), [`source-admission-main.test.ts`](../../tests/unit/electron/source-admission-main.test.ts), [`flush-save-lease.test.ts`](../../tests/unit/electron/flush-save-lease.test.ts), and the real provider-backed admission/dispatch paths in [`plan-board.spec.ts`](../../tests/e2e/plan-board.spec.ts).

Validation is scoped, not a full-matrix success claim. Application/test typechecks and the production build passed. The serialized Electron/UI unit run passed 1,310 tests with one skip; the combined lifecycle, Plan Board, and native-target Electron run passed all 13 tests without retries. That run covers same-tree rejection, nested navigation and rejection, coordinated dispatch, and incomplete-worker retry.

A follow-up closes rejection before preflight: `abortPromptStart` publishes `agent_start_rejected`, rather than inventing a run settlement. Main releases the dispatch assignment, retains its failed result, and includes the reason in the existing sibling mailbox notice. The dedicated Electron regression withdraws the configured model from the loopback catalog, proves no preflight/start/settlement occurred, and successfully retries with a new worker. Startup/steering, subagent-resume, sidecar, activity, and admission unit checks also passed.

Test-mode quit bypasses only interactive confirmation and still runs canonical disposal. The process-cleanup Electron tests prove that an ordinary fixture shell has stopped at `will-quit`, before the fixture process reaper runs. Follow-up verification and native startup/teardown diagnosis are recorded below.

The empty-project collapse failure was an authentication-fixture mismatch, not a reason to remove onboarding occupancy. Signed-in empty projects collapse; a visible first-run login hint remains expanded until credentials are stored. The multi-project suite now exercises both real authentication states and passed all three tests, with no production layout change.

An earlier expanded run passed 36 of 37 Electron tests. The remaining launch stayed alive with `ready:false` and no window; that run also emitted a native `Napi::Error` during teardown. Subsequent sampling of owned test processes distinguished the two causes: AppKit was waiting in a macOS window-recovery modal before Electron readiness, while the teardown stack passed through the PTY addon's `ThreadSafeFunction::CallJS`. No host sessions or external crash reports were needed.

The fixture now disables macOS window restoration interference, captures owned startup diagnostics on timeout, surfaces native teardown errors, and waits for owned Electron lifetime closure before deleting its roots. Terminal runtime retains native PTY ownership until native exit and safely cancels late output after egress disposal. These are lifecycle fixes, not added launch retries or longer timeouts.

The pending focused verification is now green: application/test typechecks, 13 agent tool-loop tests (including MCP), 24 terminal-runtime tests, the production build, and all 12 process-cleanup, close-lifecycle, and native-target Electron tests passed. Teardown still emits bounded output-drain warnings in these fixtures; this is not a claim of warning-free logs or a passing full Electron matrix.

## Phase 2: factual work context

The factual project/task summary slice is implemented. A collapsed **Project work** disclosure sits beside the terminal, so one-project/one-agent use does not require a new overview or setup flow.

- Main projects the existing activity, Plan Board, terminal/workspace, and Verify owners through one producer: [`electron/main/work-summary.ts`](../../electron/main/work-summary.ts). The typed on-demand bridge carries small facts, not terminal buffers, diffs, or another session registry.
- Attribution includes the exact project path, terminal generation and model, owned Plan Board tasks, live same-source worker assignments, and the assigned project or separate candidate root. A separate tree is not presented as proof of filesystem sandboxing.
- Execution, the last dispatch outcome, tracked Change Review paths, current Verify validity, and factual attention remain distinct. Idle does not complete a task; a closed worker does not erase an incomplete/failed/interrupted attempt. Unseen notification state does not clear a still-valid failure.
- Verify details load on request through the canonical report formatter. They expose command, tested source, timing, exit outcome and retained bounded output, including historical passes whose current verdict is stale. Report requests and renderer updates fence project activation and terminal generations.
- Next actions only inspect the existing terminal, Plan Board, Change Review or check report. They do not run tests, retry work, accept changes, promote candidates, stage or commit automatically. Retry remains the existing Plan Board action.
- Human review completion is not inferred or stored in a new main state: per-file review marks remain with their current renderer owner, and tracked paths are not a clean-tree or unread-change claim.

Renderer owner: [`src/main/work-summary.ts`](../../src/main/work-summary.ts). Coverage: [`work-summary.test.ts`](../../tests/unit/electron/work-summary.test.ts), [`work-summary-main.test.ts`](../../tests/unit/electron/work-summary-main.test.ts), [`work-summary.test.ts`](../../tests/unit/ui/work-summary.test.ts), [`work-summary.spec.ts`](../../tests/e2e/work-summary.spec.ts), and the incomplete-worker path in [`plan-board.spec.ts`](../../tests/e2e/plan-board.spec.ts).

Observed validation: the serialized full unit suite passed 2,759 tests with one skip before the final renderer adjustments. After those adjustments, both typechecks, all 67 focused summary tests, and build passed again. The full suite was not repeated for the renderer-only adjustments; focused tests cover ignored background-project updates and canonical task-row ordering while preserving unchanged focused controls. All 21 summary, Plan Board/admission, Verify execution/source-validity, and authoritative file-navigation Electron tests passed again without retries. Candidate-versus-project mapping is covered by producer and actual-main-method unit tests; this run did not provision a live candidate. Keyboard disclosure and a 200% zoom screenshot were exercised, not a full screen-reader or usability/scale audit. Existing fixture logs still include output-drain and snapshot-disposal/capture warnings.

This records the factual summary slice of rollout step 2, not the whole visual redesign. The rail and global attention view follow in Phase 3 below. New acceptance semantics and `computer-use.md` remain outside this work.

## Phase 3: global attention, exact inspection, and persistent rail

Implementation followed this order: global attention projection/view, exact owner inspection without resolution, then the persistent project rail. The code and scoped runtime validation are complete.

- [`electron/main/work-summary.ts`](../../electron/main/work-summary.ts) composes existing per-project summaries into one deterministic global overview. Blockers/unavailable workers precede failed/incomplete/interrupted attempts, followed by failed/timed-out/cancelled/outdated checks. Counts are facts, not unseen-notification state, and ambiguous task ownership remains unknown rather than guessed.
- The typed `work:overview` and `work:inspect` bridge stays main-owned. Inspection recomputes opaque item identities and revalidates project object identity, lifecycle, selection ownership, activation generation, terminal generation, assigned source area and action. Changed or closed targets fail without substituting another owner.
- [`src/main/attention-view.ts`](../../src/main/attention-view.ts) displays all open projects' attention while another project is selected. Project paths, task attribution, agent/model and actual work area remain explicit. Opening the view or inspecting a terminal, plan or exact check report never resolves attention, reruns verification, retries work, or accepts changes.
- The optional view is reached from **Attention**, **All projects**, the View menu, command palette or `Cmd/Ctrl+Alt+A`. It restores focus on close, preserves unchanged controls, paginates the first 50 items, and retains previous rows with an explicit potentially-outdated warning when refresh fails.
- [`src/main/project-rail.ts`](../../src/main/project-rail.ts) owns persistent navigation and renders working-agent/attention counts only from that overview. Native project/close buttons disclose paths for same-name roots. Arrow/Home/End browsing, Enter/Space activation, vertical dragging and Alt+Up/Down reordering reuse canonical project activation and order preferences. A failed order save reloads main's order rather than presenting the failed permutation as authoritative.
- [`src/main/tab-reorder.ts`](../../src/main/tab-reorder.ts) remains the single pointer-reorder path, now supporting the vertical rail and existing horizontal terminal tabs. Explorer resize coordinates are measured from the explorer after the rail, not the old window origin. Terminal/editor remain the initial work surface; there is no new session registry, attention-resolution store, sandbox, or acceptance state machine.

Observed validation: application/test typechecks, all 216 focused tests and production build passed again. The serialized full unit suite previously passed 2,891 tests with one skip before the final unavailable-state accessible-label adjustment; it was not repeated for that adjustment or this E2E-only follow-up. The original Electron attempt was blocked at fixture setup because `/bin/ps` returned `Operation not permitted`. Process identities are readable in the follow-up environment, and the process-identity/cleanup protection has not been removed or bypassed.

The first executable attention run exposed two test-setup errors. Creating a nested project during Verify changed source observation and correctly produced stale historical failure, not a current failure; the nested tree is now prepared before Verify, while navigation still occurs during the gated run. The unsaved-buffer test edited the initial empty Monaco model before the asynchronous file open completed; it now waits for the active file and its original content, then checks the edited text as well as the dirty marker. Production behavior, source-validity fences and assertion timeouts were not changed.

The broader regression also exposed obsolete geometry assumptions: the custom-resize test now requires more than 10% growth relative to the initial split instead of the pre-rail 620px window-width threshold, while retaining exact restoration checks. Reverse tab dragging now scrolls the last tab into view, remeasures coordinates and asserts that the gesture actually lifts the tab. All Escape/blur/capture-loss, order, selection and close assertions remain. The two reorder cases additionally passed three executions each without retries.

Final runtime acceptance: all **53 Electron tests passed**, including all nine [`attention-view.spec.ts`](../../tests/e2e/attention-view.spec.ts) cases and the factual summary, multiproject, authoritative file-navigation, Verify, Plan Board, lifecycle/cleanup, horizontal/vertical reorder and resize regressions. The final command was:

```bash
pnpm run test:e2e \
  tests/e2e/attention-view.spec.ts \
  tests/e2e/work-summary.spec.ts \
  tests/e2e/multiproj.spec.ts \
  tests/e2e/project-file-navigation.spec.ts \
  tests/e2e/verify-execution.spec.ts \
  tests/e2e/plan-board.spec.ts \
  tests/e2e/lifecycle-close.spec.ts \
  tests/e2e/process-cleanup.spec.ts \
  tests/e2e/tab-reorder.spec.ts \
  tests/e2e/resize.spec.ts \
  --workers=1 --retries=0 --reporter=dot
```

The attention cases exercise real Verify failure/outdated evidence, background same-name project attribution, invalidated IDs, unsaved buffers, native menu/keyboard access, vertical order, resize geometry and a compact 200% zoom capture. Candidate/unavailable-source facts and pagination remain unit-covered, not a new live-candidate runtime proof or a screen-reader/usability/scale study. Fixture logs still include output-drain, snapshot-disposal/capture and GPU warnings; this pass is not a claim that those warnings were fixed.

## Phase 4: independent candidate admission — implementation and verification

The implementation reuses the existing worldline manager, session worker, source admissions and sandbox. The renderer only adds transient initiating-control feedback, not another admission path or task orchestrator. Candidate admission is implemented and verified by the scoped checks below. The former child-process execution blocker is resolved through the explicitly approved native resource contract; the strict candidate-to-primary Bash write-back E2E now passes without relaxing its denial assertion.

- Fresh launches and reopens use the same exact startup handshake in [`candidate-launch.ts`](../../electron/worldlines/candidate-launch.ts). An attempt stays pending until its own session confirmation, process-identity lookup and manifest persistence succeed. Immediate confirmation cannot publish ready ahead of persistence; late valid confirmation is not discarded when spawning finishes. Replayed confirmations cannot publish twice. Rejection, timeout, cancellation and exit clean up the exact attempt and its waiter, preserving existing retry paths.
- Readiness timeout belongs to that handshake. The old comparison timer, which could be armed after readiness had already arrived, and its unused state fields are removed. No timeout was increased.
- Preparation summaries are published immediately after comparison registration. Fork Run/Challenge and timeline-point controls show pending feedback, suppress duplicate requests for the same source, and remain retryable. Requests are scoped by pane identity, terminal generation and project identity/generation; stale failures cannot warn against or clear another source's pending request. The run-control feedback has a small private renderer owner, [`run-fork-feedback.ts`](../../src/main/run-fork-feedback.ts), alongside the existing timeline owner. Moment forks render one actual candidate, not a fictitious alternative card; candidate Open is disabled while creating.
- The canonical control writer reconciles a consumed startup-control leaf before publishing the next operation. Previously, reopening a candidate tried to replace a file that the agent had already claimed and removed. Only a missing leaf is retired, including consumption followed by exit without confirmation; a changed existing file still fails its native identity/content check. Missing controls are created without replacement. A native regression uses the actual producer's consume path without delivering its acknowledgement and rejects a planted replacement. A real Electron regression closes a candidate, interrupts its reopened process before confirmation, observes the error and enabled retry, and confirms a third process with a distinct control operation; the retained session is not corrupted and no changes are promoted.
- Historical result and timeline forks share platform/repository/trust preflight through [`bootstrap.ts`](../../electron/worldlines/bootstrap.ts), before comparison allocation. Missing trust baselines, changed repository roots and failed resource hashing fail closed. Existing source-scope admissions and write leases remain authoritative.
- Result forks create natively bound support directories before the session worker opens its destinations. The first prompt's explicitly declared empty-session parent is recorded as sequence 0, which the core already supports. An omitted or malformed parent is not converted to that root; actual timeline and settled-session entries must still be positive.
- [`electron/main.ts`](../../electron/main.ts) stamps a settled timeline point with its run's actual end, not the later completion of session-copy publication. Candidate checkpoints use the candidate's own Git directory, rather than pairing its tree with primary Git metadata. Snapshot capture and session copies remain off the main event loop.
- [`sandbox.ts`](../../electron/sandbox.ts) permits only literal metadata access to the worlds directory and the current comparison directory, so canonical paths remain usable when worlds are outside HOME/user-data. This does not permit listing those directories, reading their contents, accessing sibling/template/other candidate metadata, or reading/writing primary source. The active security gate exercises those boundaries explicitly.

Coverage includes [`candidate-launch.test.ts`](../../tests/unit/electron/candidate-launch.test.ts), [`candidate-recording-main.test.ts`](../../tests/unit/electron/candidate-recording-main.test.ts), [`worldline-fork-admission.test.ts`](../../tests/unit/electron/worldline-fork-admission.test.ts), [`worldlines-unit.test.ts`](../../tests/unit/electron/worldlines-unit.test.ts), [`run-fork-feedback.test.ts`](../../tests/unit/ui/run-fork-feedback.test.ts), [`timeline-fork-pending.test.ts`](../../tests/unit/ui/timeline-fork-pending.test.ts), existing native runtime/retention/promotion regressions, and [`worldline-admission.spec.ts`](../../tests/e2e/worldline-admission.spec.ts). The new Electron cases use a loopback provider, synthetic credentials and isolated fixture roots. They obtain real session confirmations, create both result-based candidates from a first prompt, submit the alternative's editable prefill explicitly, run and checkpoint candidate-only writes while primary remains working, preserve explicit review/promotion, and reject changed project skills before allowing a new-baseline retry. Producer events and sandbox launch are not substituted.

Latest observed validation after the approved resource-contract change: both typechecks and production build passed; **51 focused unit tests across seven files passed**, including the previously skipped npm lifecycle regression, sandbox policy/signal/orphan checks, candidate environment, subagent escape, startup handshake and terminal lifecycle checks. No UID-count skip remains. Earlier unchanged renderer/admission validation passed 152 focused tests across 17 files, including 14 run-control and 11 timeline feedback tests; those are earlier evidence, not a rerun of that matrix for this change. **113/113 required-live sandbox checks passed** with 439 user processes, including actual Node-to-Bash execution through the canonical wrapper, memory enforcement, timeout/group cleanup, external-world path resolution and denied directory listings, metadata and primary writes. The obsolete numerical process-ceiling check was removed with the approved guarantee; its absence does not stand for hard fork containment.

**14 serialized Electron tests passed without retries**, covering all five real admission cases, including the strict Bash write-back probe, and the complete existing Worldlines and Plan Board/source-admission suites. The user had 398 processes before this invocation. No case is excluded:

```bash
pnpm exec playwright test \
  tests/e2e/worldline-admission.spec.ts \
  tests/e2e/worldlines.spec.ts \
  tests/e2e/plan-board.spec.ts \
  --workers=1 --retries=0
```

Before this change, the strict Bash probe failed with **`spawn /bin/bash EAGAIN`**, before executing the write. The 256-process setting counted the whole UID, so unrelated desktop processes consumed the candidate's headroom. That failure was never treated as filesystem-denial evidence. The user explicitly approved removing Termina's own numerical UID ceiling without adding a new supervisor; the canonical wrapper now preserves the existing other limits and sandbox without setting `RLIMIT_NPROC`. Bash now reaches the permission boundary, and the unchanged E2E requires an actual denial while confirming the primary file remains unchanged and the primary agent stays working. Busy-account process headroom below 256 is no longer a prerequisite.

A broad E2E invocation reached the tool's time limit; it is not evidence of a passing full matrix. Its remaining isolated fixture Electron and captured descendants were terminated with process-birth/fixture-identity checks, and its root was removed only after confirmed exit; unrelated applications were not closed. The direct, explicitly listed 14-case Playwright invocation above subsequently passed. Full application/Rust test matrices were not completed for this slice; Rust source is unchanged. The passing checks emitted terminal output-drain/GPU and disposed-core teardown warnings, plus build chunk-size warnings. Phase 4 candidate admission, preparation feedback, explicit retry and strict child-process isolation have scoped positive runtime evidence; this is not a claim that the entire workspace plan or application matrix is complete. `computer-use.md` and pre-existing editor-draft work remain outside this slice.

### Native macOS process-budget investigation

The investigation informed the user-approved native process contract now implemented in [Worldlines §6.6](../reference/WORLDLINES.md#66-candidate-materialization-and-isolation). Termina no longer imposes a numerical UID ceiling and has no hard per-candidate descendant budget. No candidate UID, privileged service, virtual machine, dependency, new supervisor or second sandbox path was added. The write-back assertion remains strict.

**Confirmed behavior.** Apple's [published `getrlimit(2)` manual](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/man/man2/getrlimit.2) defines `RLIMIT_NPROC` as the maximum simultaneous processes for the user ID. Its [kernel creation path](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/kern/kern_fork.c) increments the UID counter and compares it against the creating process's inherited limit; an over-limit non-root UID receives `EAGAIN`. The former candidate setting did not lower unrelated applications' own limits or kill them, but their processes consumed its available headroom. It was not an independent 256-descendant counter.

A second isolated diagnostic used separate sessions/process groups with an empty temporary HOME, no filesystem sandbox and no provider. With 386 user processes, the unrestricted Node child executed Bash successfully; the same child under the then-current resource preamble received `EAGAIN`. Both children had the same real UID and distinct process-group leaders. The temporary HOME was removed after the children exited. That diagnostic confirmed that a new process group does not change the resource counter; it was not itself a passing write-back E2E.

**Other macOS mechanisms inspected.** The installed `launchd.plist(5)` manual describes `NumberOfProcesses` as a UID-wide limit, not a job-wide one. `taskpolicy(8)` offers scheduling and memory policies but no numerical descendant-count policy. `kqueue(2)` exposes `NOTE_FORK` as a notification after creation, not fork admission control. Apple's [coalition syscall implementation](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/kern/sys_coalition.c) requires a privileged coalition for creation/control; it also explicitly notes that existing members can still fork after coalition termination. The inspected interfaces expose accounting and other policies, not a supported unprivileged configurable process-count ceiling per candidate. Apple's [persona interface](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/sys/persona.h) is private and identifies a private management entitlement; it is not a suitable public drop-in API.

**Prior art, not equivalent guarantees.** The inspected [Anthropic sandbox-runtime macOS implementation](https://raw.githubusercontent.com/anthropic-experimental/sandbox-runtime/232db177034e986bc771b5551c05acc4641e70a9/src/sandbox/macos-sandbox-utils.ts) permits `process-exec` and `process-fork`; neither that implementation nor the inspected CLI contains `RLIMIT_NPROC`/`ulimit`. Its access restrictions inherit through the process tree, which is distinct from limiting tree size. The inspected [Codex Seatbelt base policy](https://raw.githubusercontent.com/openai/codex/80e0b51c9e44853471fae105032fa000c77d3e4a/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl) likewise allows process creation. Its [64-entry unified-exec limit](https://raw.githubusercontent.com/openai/codex/80e0b51c9e44853471fae105032fa000c77d3e4a/codex-rs/core/src/unified_exec/mod.rs) bounds managed command sessions, not arbitrary descendants. Its [process-group cleanup](https://raw.githubusercontent.com/openai/codex/80e0b51c9e44853471fae105032fa000c77d3e4a/codex-rs/utils/pty/src/process_group.rs) is explicitly best-effort. These source inspections do not certify those products or establish an equivalent substitute for Termina's former numerical ceiling.

**Existing Termina controls.** [`electron/sandbox.ts`](../../electron/sandbox.ts) remains the canonical profile/resource-wrapper owner. [`electron/terminal-runtime.ts`](../../electron/terminal-runtime.ts) owns terminal lifecycle and [`agent-core/main/bash.ts`](../../agent-core/main/bash.ts) owns interruptible command lifecycle. Bash already has a wall timeout, capped output, stop handling and process-group cleanup, but creates a detached process group. A count of only the terminal's group would miss those commands. The existing helpers are not a complete descendant-budget supervisor, and must not be described as one. No new monitor was introduced.

**Approved decision and implementation.** No small equivalent supported native macOS replacement was found. The user explicitly approved the operational native contract: existing bounded managed work, timeouts/cancellation and tracked-group cleanup, without Termina's numerical UID ceiling or a new supervisor. [`electron/sandbox.ts`](../../electron/sandbox.ts) removes `ulimit -u`, the process-limit constant, option and validator; its preflight still verifies the canonical CPU/file-descriptor/file-size preamble and required helpers. Candidate, evidence and Verify callers continue using that single launch wrapper. The tests no longer assert prevention of process fanout or skip npm lifecycle work based on UID occupancy; instead they require actual child-command execution while preserving isolation.

Filesystem/source/sibling isolation, environment sanitization, write leases, process-identity-safe cleanup and the other resource controls are unchanged. The approved model does **not** guarantee prevention of rapid process creation or resource exhaustion. It neither raises the old ceiling nor silently bypasses it on busy hosts: the obsolete guarantee and API are removed explicitly, and acceptance is supported by the positive runtime checks above.

## Phase 5: coverage inventory and initial technical validation

This slice inventories all twelve questions below and adds measured Electron probes to the existing attention suite. It does not implement another overview, orchestrator, benchmark subsystem or release gate. Completion for this slice means an inspectable coverage matrix, repeatable bounded scale/accessibility probes, recorded results and explicit gaps—not acceptance of Phase 5 as a whole.

The matrix distinguishes application integration from producer/unit logic and human evaluation. Referenced tests describe assertions present in source; they are not all newly executed. Fresh verification for each slice is listed separately below. Sidecar injection, loopback providers and fake DOM fixtures are not live-provider, screen-reader or usability evidence.

**Current code status:** the pending scoped implementation and automated coverage items now include real terminal modifier-clicks, additional complete accessibility workflows, sustained descendant-inclusive memory observations and the canonical unsupported-capability refusal/retry path. These code follow-ups are implemented and have positive isolated macOS runtime evidence below. They do not close Phase 5's external acceptance: actual VoiceOver use, participant observations, commercial-provider behavior, native other-platform validation and longer soak workloads are not established by these fixtures.

| Validation question | Existing evidence and initial probe | Remaining proof or supported limit |
|---|---|---|
| Three projects, six agents; find decisions without opening every terminal | [`attention-view.spec.ts`](../../tests/e2e/attention-view.spec.ts) covers attribution and bounded shell load with six **idle agent terminals**. [`worldline-admission.spec.ts`](../../tests/e2e/worldline-admission.spec.ts) now runs six real agents/tools across three primary and three sandboxed candidate trees; all six are working while three globally attributed stale checks can be inspected through one background owner. | The model responses are synthetic loopback fixtures. Other decision categories, commercial-provider variability and human decision-discovery accuracy remain unproven. The idle-terminal and actual-run probes are distinct. |
| Same-name folders, nested roots and aliases | [`work-summary.spec.ts`](../../tests/e2e/work-summary.spec.ts), attention and [`plan-board.spec.ts`](../../tests/e2e/plan-board.spec.ts) exercise exact roots and nested admission. The new Electron alias case opens an actual symlink, retains the same project and visible root, compares physical roots and rejects another writer before an agent run starts. | This scoped macOS alias case does not establish every path-rebinding, reparse-point or platform variation. |
| Cross-project links and delayed activation | [`project-file-navigation.spec.ts`](../../tests/e2e/project-file-navigation.spec.ts) retains the callback/activation-race controls and adds four real shell-output, xterm-parser and trusted native modifier-click cases for soft-wrapped absolute references and OSC 8 labels, across unrelated and nested project roots. They check line/column and main, rail, explorer, editor, terminal, search and summary ownership. | Callback-only checks remain separate from the four gesture cases. The activation delay wraps the real handler; it is not an uncontrolled network race. Cmd-click is observed on macOS; native other-platform Ctrl-click and arbitrary filesystem aliases are not established. |
| Ordinary-agent overlap and shell writes | Plan Board Electron tests reject equal/nested independent writers before startup and prompt-named MCP startup. A new runtime handoff rejects shell creation during agent work and agent startup while a shell is live, executes a real shell write, observes native shell exit, then retries the retained prompt and reads the source with the agent. | Admission does not intercept arbitrary external writes. Same-root agent/shell concurrency is refused because shell activity is unknown; this does not introduce or certify a separate concurrent-coordination interface. |
| Incomplete settlement, startup/authentication failure and worker exit | Plan Board now exercises HTTP 401 after a successful worker tool, failed attention, actual TUI key login in the isolated HOME and explicit retry using the new synthetic key. A separate actual producer SIGKILL has no settlement record, retains interruption and admits retry. Its new persistence cases replace an active session segment and block final Rust capture only in fixture-owned storage; they preserve work, task/result distinctions, evidence uncertainty and explicit recovery. [`dispatch-settlement-main.test.ts`](../../tests/unit/electron/dispatch-settlement-main.test.ts) executes canonical settlement; [`checkpoint-failure.test.ts`](../../tests/unit/electron/checkpoint-failure.test.ts) additionally covers unavailable recording, rejected store setup, denied lease and capture timeout without premature lease release. | Credentials and responses are loopback fixtures, not commercial OAuth expiry/refresh or an exhaustive disk/power failure matrix. macOS native PTY reported code 0 for the signaled exit; the existing contract records interruption, not a known nonzero-exit failure. Other abrupt settlement failures remain partially covered. |
| Passing checks become stale after edits | [`verify-execution.spec.ts`](../../tests/e2e/verify-execution.spec.ts) independently exercises an actual Monaco save and a Bash write; [`worldline-admission.spec.ts`](../../tests/e2e/worldline-admission.spec.ts) executes an actual agent write tool and checkpoint. Each preserves the passing execution as historical, marks it outdated and opens its exact evidence through Attention without rerunning Verify. [`verify-observation.spec.ts`](../../tests/e2e/verify-observation.spec.ts) closes the real native observer, injects an error on it, and withholds actual notifications for external writes, atomic replacements and deletion during Verify. | The new cases cover declared observation loss and end-of-run Rust validation despite missing notifications, not immediate detection of a completely silent loss after certification, every external writer or platform. |
| Consequence-aware close and exact targeting | [`lifecycle-close.spec.ts`](../../tests/e2e/lifecycle-close.spec.ts) covers agent/shell/project/app targeting. Plan Board closes a genuinely executing Bash dispatch, retains interruption and retries. [`subagent-lifecycle.spec.ts`](../../tests/e2e/subagent-lifecycle.spec.ts) additionally spawns a real headless child through its parent, approves its Bash through the parent TUI, checks child disclosure and Cancel, then closes the terminal/project/app and proves all four owned process identities disappear before fixture cleanup. Targeted closes preserve an unrelated project's actual agent; terminal/project closes publish killed results and remove task files/path claims. | Native-dialog answers are mocked, not a native-dialog usability test. This is isolated macOS/loopback evidence for ordinary owned command descendants, not a guarantee for separately detached processes, every platform or commercial-provider behavior. |
| Dirty drafts through reload/restart | [`editor-draft-recovery.spec.ts`](../../tests/e2e/editor-draft-recovery.spec.ts) exercises confirmed copies, changed/deleted source, corrupt copies and isolated application restart; lifecycle tests preserve copies after cancelled close. | Confirmed recovery copies are not a guarantee for every uncheckpointed keystroke, power loss or every user-facing loss explanation. |
| History/log caps, missing snapshots and unsupported platforms | [`session-search.spec.ts`](../../tests/e2e/session-search.spec.ts) exposes unreadable-session uncertainty; listing-limit units remain separate. [`incomplete-history.spec.ts`](../../tests/e2e/incomplete-history.spec.ts) uses real write/edit tools: oversized/memory-evicted file content explains its absence without replacing the live editor; 106 edits yield 100 retained moments with a persistent limited-history label and keyboard inspection. A real moment fork retains historical source and paired results. Temporarily withholding an owned immutable commit object refuses a fork, preserves live source and permits explicit retry after restoration. Real Verify output exposes a bounded tail; loss of only its saved output preserves execution facts across isolated restart. | These are macOS loopback-producer and reversible owned-store fault cases, not all storage-corruption or session/search/context truncation variants. The canonical unsupported-capability branch now refuses a fork and admits an explicit retry in Electron when the isolated main process's platform input is changed to Linux and restored. This controlled capability input is not a native Linux/Windows runtime validation. In-memory file content and the immutable source tree are distinct evidence. |
| Keyboard, screen readers, zoom, fonts, motion and narrow windows | Earlier focused probes remain distinct. [`workspace-accessibility.spec.ts`](../../tests/e2e/workspace-accessibility.spec.ts) adds eight keyboard-owner, settings, Monaco save, stale-evidence and inspection/return flows: all four themes with Departure Mono and Menlo, real editor/terminal font preferences at 20px, native zoom 2, 900×700 window and reduced motion. It checks accessible descriptions, sampled visible-text contrast, focus outlines, geometry, hidden terminal inputs and preserved historical execution. | This covers these complete flows and sampled surfaces, not every app control/state or full-app accessibility certification. Fixed chrome sizes are enlarged by native zoom, not by the editor/terminal preference. Actual VoiceOver speech and participant success remain unobserved. |
| More projects and busy output; bounded/lazy overview | Electron now measures 12 projects, 24 idle agent terminals and six bounded output shells, with 300 busy and 100 minimized samples, main/renderer memory samples and ten view open/close cycles. Sixty valid saved historical task results exercise real roster loading, initial 50-row pagination, exact targeting and keyboard focus. An invoke observer preserves canonical main handlers and proves opening/refreshing Attention does not request the watched heavy reports/files/diffs/snapshots; inspection fetches the exact check. | Saved results are fixtures, not sixty executed workers. Idle-agent scale is separate from six actually working agents. The new sustained six-agent profile also samples birth-validated owned-process RSS and proves inclusion of all twelve persistent command/grandchild identities while navigating under output. It records main and renderer memory separately and verifies descendant exit before fixture cleanup. RSS sums count shared pages per process; this bounded observation is not leak certification or proof of every short-lived/detached process. Longer soak workloads, commercial providers and populations beyond these scopes remain unproven. |
| Single-project/single-agent use | Summary and attention Electron cases retain the terminal-first surface, closed optional disclosure and no mandatory overview navigation. | Comparative navigation cost, satisfaction and unnecessary-step judgments need people, not selector assertions. |

### Scale baseline and interpretation

[`attention-view.spec.ts`](../../tests/e2e/attention-view.spec.ts) now records renderer-to-main-to-renderer `work:overview` elapsed times, serialized UTF-8 payload size, exact project/item counts and bounded output progress. It preserves the existing focused inspection control while output arrives, closes the view by keyboard and confirms all producers finish. No application timeout or performance threshold was changed.

The workload has three independent fixture repositories, six idle agent PTYs and three Bash PTYs. Each shell prints a 4,096-character line with a 50ms pause, stops on a fixture-private control leaf outside every source tree, and has a maximum 20-second producer duration. The fixture keeps canonical process ownership/cleanup; subscribers and the main measurement timer are removed in `finally`. There are no model requests, live-provider charges, source writes by the load producers or unmanaged infinite jobs.

The initial isolated macOS Electron observation was **202.8ms median / 212.7ms p95** under output, versus **0.7ms / 1.2ms** for the same three-project overview at rest. The main-process pulse still advanced, so those round trips did not establish expensive main projection as the cause.

A temporary Chromium CPU profile then measured **9,194.5ms of 9,591.9ms** in xterm's DOM `WidthCache._measure`, reached through row/selection rendering. The dependency only caches positive glyph widths; `display:none` on background terminal ancestors supplied zero widths and forced repeated layout for output. The app's canonical pane visibility now retains measurable, absolutely positioned panes with `visibility:hidden` and `inert` for background panes. The minimized terminal also remains measurable but hidden. `PtyView.fit` excludes inactive/CSS-hidden views, so this does not introduce background PTY resizes. No dependency internals, output acknowledgement, sandbox or application timeout was changed. Temporary profiling hooks were removed.

Isolated post-correction observation (same software-rendered hidden Electron fixture and producer command, no concurrent unit runner):

| Workload | Samples | Median reply | Observed p95 reply | Serialized reply |
|---|---:|---:|---:|---:|
| 1 project, 2 idle agent terminals, 1 attention item | 10 | 0.4ms | 0.5ms | 684 bytes |
| 2 projects, 4 idle agent terminals, 2 attention items | 10 | 0.4ms | 0.5ms | 1,360 bytes |
| 3 projects, 6 idle agent terminals, 3 attention items | 10 | 0.4ms | 0.6ms | 2,036 bytes |
| Same 3-project overview during output from 3 shells | 20 | 0.3ms | 0.4ms | 2,036 bytes |
| Same output with the terminal work pane minimized | 10 | 0.4ms | 0.5ms | 2,036 bytes |

The main-process 10ms pulse advanced **150 times**, with a maximum interval of **13.1ms**. All three output streams progressed during sampling and finished with their completion marker. There is one visible terminal; background panes are inert and all retain positive dimensions. The minimized state has no visible terminal. Sampling now finishes sooner, so total delivered output is smaller; producer rate/line width are unchanged, and this is not an equal-total-byte benchmark. Small sample percentiles and hidden/software-rendered fixtures are not a statistically robust user-device benchmark or an acceptance threshold.

The first executable probes exposed test-setup mistakes: non-repository secondary roots correctly yielded stale rather than current Verify failure, and the expected inspection label differed from the canonical label. The fixtures now clone their isolated repository and use the real accessible name. A subsequent finite-output attempt ended before sampling completed; the control-leaf handshake now keeps the bounded producers active through measurement instead of treating cooldown as load. Assertions and application timeouts were not relaxed.

### Accessibility evidence and limits

The new native-zoom case enters Attention through All projects using Enter, traverses Close → Refresh → Inspect with Tab, verifies a visible focus outline, and uses Escape to restore the opener. It then reopens and inspects the exact canonical check by keyboard. The report remains failed, the original attention item remains unresolved, and Verify has executed only once. The attention region fits within the effective viewport without horizontal overflow; reduced-motion media is active and the attention subtree has no running animations. Geometry, accessibility-tree text and a screenshot are attached to the Playwright result.

This adds browser-semantic and keyboard evidence, not a screen-reader test. It does not establish accessible announcements during every refresh, all narrow-window layouts, font settings across Monaco/TUI, contrast compliance or human success at recovering context.

### Six concurrently executing agents and cross-project recovery

The new Worldline admission case establishes three independent fixture repositories, runs a settled source moment for each and forks one sandboxed candidate through the existing confirmed admission path. It then starts all six agents. Each writes its own distinct result and executes a source-local Bash producer/check with a 100ms output pause, a test-owned release gate and a maximum 45-second deadline. All six remain active until overlap and background inspection are established. The test releases every gate both before successful tool-end assertions and in `finally`; reaching the deadline without release fails the command. Gate/PID leaves are ignored by snapshots. This replaces the earlier twelve-second timing assumption, which could finish the earliest producer during later UI assertions on a slower runner. Ordinary agents remain in `ask` mode and receive Approve once through the real TUI; candidate auto-approval remains inside the existing sandbox. The six PID leaves and existence probes establish six actual concurrent Bash processes, not merely six busy flags or held provider streams.

While all six are working, the overview reports two working agents per project and three correctly attributed stale checks. The user-facing test opens Attention, reads every project/root/terminal attribution, and inspects one background report without visiting the other five terminals. Actual successful tool ends precede six confirmed checkpoints. Distinct result contents, source-workspace identity, unchanged greeting files and absence of promotion establish independent source-local work. Completion waits account for the finite workload; no application timeout or approval policy is relaxed. The provider is a deterministic loopback server, not a commercial-model or human-usability test.

This case exposed a separate data-integrity defect: constructing a later project manager swept the shared worlds root again, terminating/removing already admitted candidates. Main now owns a single startup recovery promise. Every manager delegates its existing sweep through that barrier before candidate admission; failure remains rejected for all later managers. The global directory, root-scoped budgets, journal formats, leases and sandbox stay unchanged. A dedicated Electron regression confirms that opening a second project preserves the first live candidate and allocates a distinct comparison. Native orphan TERM-grace/recovery unit checks still pass. This is startup orchestration, not a new supervisor or per-project compatibility path.

### Observed verification and findings closed in this technical slice

Both application/test typechecks and production build passed on the final production edits. The two obsolete text assertions were migrated rather than weakened: trust-path addition/deletion now fails before allocation for both run and moment forks in [`worldline-fork-admission.test.ts`](../../tests/unit/electron/worldline-fork-admission.test.ts); result/retry captions and real A/B cards are tested through rendered fake DOM in [`worldline-caps.test.ts`](../../tests/unit/ui/worldline-caps.test.ts), alongside the existing one-candidate moment case.

A final regression initially exposed a sequencing race: `closeAllTabs()` discarded its underlying promise, so an awaited caller could reopen a file before the old close completed. The canonical editor API now returns the existing close promise; its unit verifies real completion and the resize case passes without added sleeps/retries.

An earlier validation cycle passed all **333 then-configured unit files / 2,956 tests** in domain-sized runs: UI/shared **611**, Electron **1,095**, agent-core **1,073**, docs/e2e/scripts/security/website/preferences **154**, and build **23**. One monolithic serialized attempt exceeded the tool's ten-minute bound without a final summary; it is not counted as a passing run. Splitting the same configured files changed neither assertions nor their timeouts. After the editor completion change, UI/shared was repeated; unchanged domains were not rerun.

In that earlier cycle, **40 relevant Electron regressions passed on its final production edits**, one worker and no retries:

```bash
pnpm run test:e2e \
  tests/e2e/attention-view.spec.ts \
  tests/e2e/work-summary.spec.ts \
  tests/e2e/keyboard-panes.spec.ts \
  tests/e2e/resize.spec.ts \
  tests/e2e/multiproj.spec.ts \
  tests/e2e/project-file-navigation.spec.ts \
  tests/e2e/terminal-reload-attach.spec.ts \
  tests/e2e/worldline-admission.spec.ts \
  --workers=1 --retries=0
```

The latency table uses the isolated post-correction probe, not samples collected alongside another test runner. Rust source is unchanged and Rust tests were not run; the complete Electron matrix, packaged release matrix and commercial-provider smoke tests were not run. Build chunk-size and existing fixture GPU/output-drain warnings remain. The initial setup/approval/finite-producer wait mistakes were corrected at their test or API producer, not hidden behind retries.

### Additional technical validation (2026-10-06)

This follow-up excludes real-user evaluation. It continues the matrix above without treating provider fixtures, keyboard automation or accessible DOM as human/VoiceOver evidence.

Three production findings were reproduced and corrected at their owners:

- An explicitly interrupted dispatch arrived with the engine's canonical `error: "interrupted"` but main retained it as failed. Main now records interruption; genuine authentication/storage errors still take failure precedence even when an interruption timestamp exists. The actual settlement branch has focused unit coverage, and closing a real executing dispatch now preserves Cancel, stops the command and admits retry.
- Main labelled every run error as session-storage failure, including a rejected API key. Run evidence now says `run failed: <error>` or `run interrupted`, preserving the actual reason and non-replayability. The isolated authentication case reads that evidence before real TUI reauthentication and retry. A no-change retry remains incomplete, not completed or passing.
- Keyboard Show more retained focus on its old control, including when the final page hid it. The canonical view now focuses the first newly revealed Inspect action. Unit pagination and sixty saved-result Electron coverage verify that behavior.

The independent static review found no further production defects in these slices. It identified the six-agent test's fixed-duration overlap assumption; the source-local gates described above remove that timing dependency. Two consecutive gated runs passed with no retries. This is test synchronization, not an admission, sandbox, lease or timeout relaxation.

The expanded output probe records the same canonical overview response and producer progress, not a mock projection. Latest isolated observation from the final regression run:

| Workload | Samples | Median reply | Observed p95 reply | Serialized reply |
|---|---:|---:|---:|---:|
| 12 projects, 24 idle agent terminals, 12 check items, output from 6 shells | 300 | 0.4ms | 2.3ms | 8,165 bytes |
| Same workload with the terminal pane minimized | 100 | 0.4ms | 2.0ms | 8,165 bytes |

All six producers advanced during both measurement windows and finished on release. Total delivered output was **8,980,614 characters**. The main-process 10ms pulse had a maximum observed interval of **15.8ms**. No acceptance threshold is inferred from these measurements. These are bounded fixture observations with a 45-second producer deadline, not general latency or sustained-operation guarantees.

Memory samples from the same run, rounded to MiB:

| Phase | Main RSS | Main JavaScript heap | Renderer working set | Renderer JavaScript heap |
|---|---:|---:|---:|---:|
| Idle before output | 189.5 | 15.2 | 295.0 | 27.9 |
| During busy sampling | 209.0 | 9.7 | 433.5 | 40.6 |
| During minimized sampling | 209.3 | 11.4 | 431.4 | 32.6 |
| Output finished | 209.4 | 11.6 | 437.2 | 40.3 |
| After ten ordinary open/close cycles | 209.4 | 11.8 | 441.0 | 51.5 |

Main memory uses Node's byte counters; renderer working-set values use Electron's KiB counters converted to MiB, and renderer heap uses Chromium performance metrics. No garbage collection was forced. The samples show resource use, not a monotonic leak test or a claim that memory did not grow. They exclude the separate agent/shell/headless processes and do not certify long-term memory behavior.

The lazy-view test wraps the test-owned main invoke registry while preserving every original guarded handler/result, then restores it in `finally`. Opening and explicit Refresh request only the watched summary channel; the observed heavy report/file/diff/snapshot channels are untouched until inspection. Inspect fetches the matching terminal/generation's original failed report and does not rerun Verify or resolve attention. A first regression exposed a test sequencing mistake: opening cached rows and immediately refreshing could legitimately coalesce into one request. The final test observes the first actual summary invocation before demanding a distinct Refresh, without adding sleeps or weakening the heavy-fetch assertion.

Observed checks for this follow-up:

- Application and test typechecks and production build passed after the production fixes. The previously pending actual-agent-write invalidation case passed again after the fresh build.
- The preceding validation cycle passed all **334 then-configured unit files / 2,966 tests** in five domain runs: Electron **122 files / 1,105 tests**, UI/shared **66 / 611**, agent-core **117 / 1,073**, docs/e2e/scripts/security/website/preferences **21 / 154**, and build **8 / 23**. Their exact file union matches `pnpm exec vitest list --filesOnly --json`, with no omitted or duplicate domain files. A separate focused replay passed **7 files / 185 tests**; those tests are already included in the domain counts. The earlier monolithic timeout remains a non-passing attempt; no assertions or timeouts were weakened to split the runs.
- Final Electron regression: **70 passed, zero retries, zero skips** across attention, Plan Board, Worldline admission, file navigation, Verify execution, work summary, keyboard panes, lifecycle close, resize and terminal reload/attach. That run preceded the test-only six-agent gate change; the changed scenario then passed twice with the gates. Other cases were not invalidated by that fixture-only change.
- The matrix records the added alias, delayed-activation, agent/shell handoff, mid-run key rejection/login/retry, abrupt exit, actual writer, executing-worker close, saved-result pagination, memory and lazy-fetch evidence at their appropriate scopes. At that point, none established commercial OAuth expiry, modifier-click parsing, background-subagent close, every missing-snapshot/truncated-history/platform workflow, all-theme contrast, indefinite scale or VoiceOver. The next follow-up adds scoped child-close and incomplete-history evidence; it does not retroactively expand this earlier run.

Phase 5 remains partial. Commercial-provider runs require an authorized provider/model and spending limit; activating VoiceOver on the host requires separate permission and assistive-technology evaluation. Real-user evaluation is deferred by request, not silently completed.

### Local child-close and incomplete-history follow-up (2026-10-06)

This follow-up addresses the two local priorities without adding human evaluation, VoiceOver or commercial-provider requests. Its authoritative reports are `test-results/phase5-local-gap-checks/history-e2e.json` (four passing cases) and `test-results/phase5-local-gap-checks/subagent-e2e.json` (three passing cases). Both report zero retries, unexpected failures, flaky tests and skips. The evidence README names the earlier unsuccessful development probes and subsequent regressions separately.

The real-child lifecycle test keeps the parent's ordinary `ask` policy. A child runs Bash, a Node command and its own Node descendant, with a 45-second failure deadline rather than an indefinite producer. It captures process identities for the headless child and all three command-tree processes. Cancel preserves them and the owner's pane; acceptance stops all four before fixture orphan cleanup runs. Terminal/project closure additionally leaves an unrelated agent alive, persists a killed outcome and releases the task file and claims. App quit is checked against actual process death, not a result file presumed to survive the host's exit.

The history tests reproduced three production defects and correct their canonical owners:

- Tool events never received a persisted session address, so source capture alone could not make their dots visible/forkable. The engine now emits ordinary `tool_end` records after the complete tool-result message is persisted, with its exact storage sequence. Main attaches that address to the captured tool moment and uses the existing captured-moment publisher. No address is guessed from a pending assistant call. A real-kernel unit resolves every emitted address to its paired result; Electron forks a tool moment and reads both the historical tree and paired branch messages.
- Capture completion replaced the retention-limit state with `ready`, concealing discarded moments. The existing recorder-state owner now preserves that limitation while evicted moments remain. The UI says **Recent moments only** and explains that it is not the full session history. Capture failure still takes precedence, and clearing history removes the old limitation.
- Every lightweight tool event falsely said **no snapshot**, because content is deliberately omitted from timeline IPC. The lazy metadata label no longer makes that inference. Actual missing content is still explained after one canonical content request, without replacing the editor or substituting today's file.

An oversized file and snapshots removed by the 4 MiB content budget remain distinct from an unavailable immutable source state. The latter test temporarily renames one commit object only in this test's private snapshot store, restores it in `finally`, observes honest fork refusal, then explicitly retries and reads historical rather than current source. It neither deletes source-repository objects nor bypasses leases/sandboxes. This is one reversible missing-object case, not general disk-corruption recovery certification. The Verify case executes a real bounded-output command, removes only the stopped application's persisted output field, restarts in the same isolated roots, and retains the original exit/timing/source metadata while disclosing unretained output and rejecting another terminal generation.

Observed verification on these edits:

- Application/test typechecks and production build passed. Relevant unit domains passed **306 files / 2,797 tests**: agent-core **117 / 1,074**, Electron **123 / 1,110**, UI/shared **66 / 613**. Focused runs are subsets, not additional tests in that total. The documentation suite also passed **1 file / 7 tests**, making **307 files / 2,804 tests** across these disjoint runs. The remaining 28 other/build unit files were not rerun; the preceding complete-suite report remains historical evidence rather than a new full-suite claim.
- **47 distinct relevant Electron cases passed**, one worker and no retries: the four incomplete-history cases, three real-child closes, seven existing lifecycle cases, and 33 Plan Board/Verify/Worldline/work-summary regressions. The regression run includes the gated six-agent scenario and real-agent Verify invalidation after the producer change. Repeated development/final runs are not added to that distinct-case count.
- Development probes initially confused read-tool traces with mutation timeline points, queried before the captured settlement was visible, used a noncanonical macOS roster key, and sampled an editor before its async open completed. They were corrected at setup/ownership/completion boundaries, not by retries or relaxed assertions. The missing-address defect was then fixed at the engine/main contract; the final cases exercise real producers rather than injected tool addresses.
- Rust source is unchanged; Rust tests and packaged release checks were not run. Existing build chunk-size and fixture GPU/output-drain warnings remain. The missing-object probe intentionally logs the native lookup failure; that diagnostic is retained beside the JSON report.

Phase 5 stays **partial**. Unsupported-platform refusal/recovery, other storage/session loss modes, broader accessibility and sustained-load evidence remain separate from these scoped local results; human evaluation, VoiceOver and commercial-provider evidence remain deferred/excluded as previously stated.

### Source observation and external-write follow-up

This local slice addresses Verify validity when filesystem observation closes or reports failure, and when a real external mutation's notifications are withheld during verification. It does not add periodic source polling, another watcher, a provider request or a new summary producer.

A failing unit reproduced one production defect: `ProjectWatcher` handled native `error` but not native `close`, leaving its observation healthy after the handle closed without an error. The canonical owner now clears the matching observer and invalidates continuity on close. Generation/handle fencing ignores a late close from an old observer. The error path clears ownership before closing, so a synchronous close notification cannot publish the loss twice. This small lifecycle change stays with the existing watcher owner; its file length does not justify an unrelated extraction.

[`verify-observation.spec.ts`](../../tests/e2e/verify-observation.spec.ts) adds five isolated Electron cases:

- A real `FSWatcher.close()` without an error, and a separately injected error on a real observer, retain the original passing command/source/result as outdated. Attention opens that exact historical execution without running tests again. An explicit retry while observation is unavailable executes but remains outdated with unavailable source. Closing/reopening the project restores observation without resurrecting a pass; a fresh explicit Verify certifies the changed source.
- External write, atomic replacement and deletion occur while a bounded real npm verification command is gated. The fixture retains the native watcher but withholds notifications only for its own root; it observes that the native input notifications were actually dropped. The existing final Rust capture still detects changed source, preserves successful execution as historical, and requires an explicit new Verify to certify the current tree.

The test restores the Node built-in watcher function in `finally`, preserves canonical IPC and source capture, releases each bounded command gate, and uses the existing owned Electron cleanup. No source address, verdict or snapshot is fabricated. These are macOS offline fixture results, not an uncontrolled native error, commercial-provider or cross-platform test.

Observed verification: both typechecks and production build passed; **9 focused unit files / 125 tests** passed. **Five new Electron cases** passed without retries or skips, recorded in `test-results/phase5-observation/verify-observation.json`. A separate regression report, `test-results/phase5-observation/regressions.json`, records **19 passing cases** across Verify execution, external Quick Open invalidation and Worldline admission, including six concurrently executing admitted agents. The reports are distinct runs, not a repeated full-suite claim. Build chunk-size and fixture GPU/output-drain warnings remain; deliberate observation failures retain their diagnostic logs. Rust source is unchanged; Rust, packaged-release and complete application matrices were not rerun.

**Limit:** a completely silent notification loss after an already certified result, with neither a subsequent signal nor source capture, is not immediately observable through this event-driven watcher. The cases prove declared loss and final capture validation; they do not establish uninterrupted observation or detection of every change-and-restore sequence. Phase 5 remains partial, with the other matrix limits and external evaluations unchanged.

### Persistence and final-checkpoint follow-up

This slice adds two owned-storage faults after a real dispatched file write and a successful Bash check, plus a separate normal-dispatch control. The loopback provider waits at the final reply while the fixture preserves and reversibly replaces either the active session file or the private snapshot store's objects directory. Source files, source Git objects, leases, producer events and verdicts are not fabricated or bypassed.

New failing units and the real Electron path identified three producers of misleading state:

1. A failed final capture returned a negative acknowledgement but left `currentRun` open and replayable. Canonical `handleCheckpointRequest` now closes a failed settled run as non-replayable, retains the actual failure reason and session address, and marks recording degraded without inventing a captured state. Store/lease failures use that same path. A capture timeout still keeps the lease until the in-flight capture actually ends. A successful, tested task stays completed when only its recording fails; the Electron case checks the degraded Timeline detail, denied fork and a new explicit run after store restoration.
2. `SessionWriter` could acknowledge durable appends on a descriptor whose active pathname had been replaced. It now reuses the canonical descriptor inspector before append/rollover and after fsync. Replacement or symlink detection poisons that writer without advancing its sequence; a post-fsync replacement uses the existing descriptor-bound rollback and does not alter the competitor. Units verify the durable prefix and an explicit reopened writer. Electron verifies the actual engine storage failure, pending/failed task, retained Attention, unchanged previously persisted session, conserved source and a newly admitted worker after restoration.
3. Workspace-overlap classification could count a dispatched worker's own ledger entry as another writer, falsely denying eligibility to its recovered run. The canonical check now excludes only that worker's own dispatch entry at run start and finalization. Other dispatched workers and **all** active Verify commands still count as overlaps. A separate normal-worker Electron control and focused units prove that distinction; source admission and write leases are unchanged.

The checkpoint orchestration stays in its existing main-process owner, and the small writer proof stays in the existing session owner. No parallel settlement reducer, session writer, retry interface or compatibility path was introduced. The large main file was reviewed for extraction; these changes extend its existing checkpoint/run seams rather than moving unrelated orchestration.

The final typechecks and production build passed. The final focused unit run passed **23 files / 227 tests**, recorded in `test-results/phase5-persistence/units.json`, covering source observation, checkpoints, dispatch, session binding, segmented sessions, crash tails, tool-result addresses, Timeline and existing recording/architecture controls. The segmented-session harness also passed all **114** internal checks. Dedicated Playwright reports independently record successful session failure/recovery (`test-results/phase5-persistence/session-verified.json`), checkpoint failure/recovery (`test-results/phase5-persistence/checkpoint-verified.json`) and the normal-dispatch control (`test-results/phase5-persistence/overlap-verified.json`). These are distinct verify invocations. A separate final regression report, `test-results/phase5-persistence/regressions.json`, records **42 passing cases** across six suites, with no retries or skips, including all four incomplete-history cases from the earlier pending work. This is not a full-application or packaged-release run.

**Limits:** these reversible macOS fixtures prove replaced-file/storage failure handling, not arbitrary `ENOSPC`, power failure, every failure timing, fully adversarial pathname races, detached process cleanup or other platforms. Build chunk-size and fixture GPU/output-drain warnings remain. Rust source is unchanged; Rust unit and packaged-release matrices were not rerun. At this slice's completion, modifier-click, accessibility/font/contrast and descendant-inclusive memory follow-ups were still open; their completed code and scoped runtime evidence are recorded below. External human/provider evaluations remain separate. Phase 5 acceptance is not implied by the persistence evidence.

### Terminal parsing and real modifier-click follow-up

[`project-file-navigation.spec.ts`](../../tests/e2e/project-file-navigation.spec.ts) now has four gesture cases in addition to its four callback/activation controls. A real fixture-owned Bash prints absolute file references or OSC 8 labeled links; output passes through the normal PTY ledger and xterm parser. The test locates cells through xterm's public buffer API, observes a trusted mouse-up with the native Cmd modifier, and does not invoke the link callback. A plain click does not change the owner. Cmd-click selects unrelated and longest-matching nested roots, opens line 2/column 3, and keeps main, rail, explorer, editor, terminal, search and summary coherent.

These cases reproduced two implementation defects. The terminal provider read physical rows rather than complete soft-wrapped lines, losing a path prefix or reclassifying a URL tail as a file. It now joins the logical line and maps string offsets across terminal cells/rows, retaining wide/combining-character handling. Hover scanning is bounded at 16,384 cells/string units; a truncated or over-limit logical line is declined rather than used as a partial target. File navigation also compared a canonical `/private/var` target with an unnormalized `/var` visible root; it now uses the existing shared macOS path normalizer for both sides and measures longest-root matching in that same spelling. No second filesystem resolver, permissive read path or ownership bypass was introduced.

Observed evidence: **8 Electron cases passed**, without retries/skips, in `test-results/phase5-links/final.json`. The exact native modifier observed here is Cmd on macOS. Plaintext URL parsing/wrapping remains covered by units; this run did not launch an external browser or establish native Ctrl-click on another operating system.

### Complete keyboard, font, contrast and reflow follow-up

[`workspace-accessibility.spec.ts`](../../tests/e2e/workspace-accessibility.spec.ts) records **8 distinct Electron flows**, each passing twice without retries/skips (**16 executions**) in `test-results/phase5-accessibility/current-workflows.json`: all four shipped themes with Departure Mono and Menlo. Each creates same-name project contexts and real failed npm checks, changes real editor/terminal font preferences to 20px through labeled Settings controls, uses keyboard project navigation and a real Monaco save, and retains the original failed execution as outdated evidence. Native zoom 2, a 900×700 window and reduced-motion media are then used to open, close, return to, and inspect the exact background owner by keyboard. The test checks context descriptions, visible-text contrast samples, focus outlines, reflow/overflow, one accessible foreground terminal input and no implicit Verify rerun. JSON measurements and screenshots are attached to each result.

Units and these flows identified missing context on repeated inspection controls, unlabeled font controls, insufficient contrast in Light/Atom surfaces, and residual CSS transitions under reduced motion. Canonical Attention now connects its existing owner/work-area/detail paragraphs with `aria-describedby`; Settings associates existing labels with their controls. The affected tokens are corrected in `src/styles.css`, and the normal build regenerates `src/theme-tokens.gen.ts`. The existing reduced-motion rule disables animations/transitions instead of shortening them to 0.01ms; no application lifecycle depends on their end events. Text-token tests require at least 4.5:1 on the normal/hover surfaces, matching the live [WCAG contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html). Programmatic names/descriptions follow the [name, role, value guidance](https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html).

A broader UI invocation initially recorded two focus failures: the test tabbed into a cached failed-check control before the current stale projection arrived. Opaque attention identity includes the reason; replacing the obsolete item correctly returns focus to Refresh. Focus telemetry observed that identity replacement, and a new unit explicitly reproduces cached-failure invalidation. The flow now waits for the current outdated heading and checks each native Tab step rather than asserting against an obsolete control or changing the product to retain it. The subsequent repeated flows and complete 45-case UI invocation passed without retries; the original failed report remains `test-results/phase5-completion/ui.json`.

This is positive evidence for the specified flows and sampled states, not every control/state, actual spoken output or a full-app accessibility certification. Native zoom enlarges fixed chrome sizes; the real font-size preferences enlarge the terminal/editor rather than all fixed-size UI text. VoiceOver and participant observations remain separate.

### Sustained process-inclusive workload and unsupported-capability follow-up

[`worldline-admission.spec.ts`](../../tests/e2e/worldline-admission.spec.ts) retains the earlier six-agent control and adds a separate sustained variant. Six real admitted agents, in three primary and three sandboxed candidate trees, write distinct results and execute bounded Node commands through the canonical Bash tool. Each command holds a real grandchild and emits 2,048-character output bursts every 50ms. Commands expire unsuccessfully after 90s if the fixture release never arrives; grandchildren also have a finite deadline. The test samples before work, at live admission, through 36 navigation cycles, after tool completion and after renderer garbage collection. Each live sample includes the twelve persistent command/grandchild birth identities, all six agents remain working, the three attention rows/six mounted panes stay bounded with one visible pane, and historical checks remain inspectable. All twelve command/grandchild identities disappear before fixture cleanup.

The existing fixture-owned `OwnedProcessTree` now supplies RSS samples through the same birth-validated registry used for cleanup; it is not a new application monitor or descendant-budget supervisor. Units check reparenting and foreign PID reuse during the memory census. Electron main memory and renderer heap are recorded separately from the owned-process RSS sum. RSS counts shared pages in each process and is **not unique physical footprint**; census/ownership tracking is not proof of every short-lived or independently detached descendant.

The dedicated run `test-results/phase5-load/sustained-verified.json` passed without retries/skips and recorded **40 samples, 36 live navigation samples, 50,765ms live duration, 146ms P95 navigation**, peak owned RSS **4,664,864 KiB** and peak renderer heap **32,168,148 bytes**. Owned RSS was **1,707,376 KiB** after tools and **1,668,944 KiB** after renderer collection. These are observations from a bounded loopback workload, not a leak-free soak certificate, a commercial-provider result or a new release gate.

A separate Electron case exercises canonical preflight with the isolated main process's platform input temporarily set to Linux. It publishes the actual missing sandbox/recursive-watcher reasons, creates no candidate, preserves source and replayable history, restores the platform input in `finally`, and admits an explicit retry through the same UI control. `test-results/phase5-platform/refusal.json` records one passing case. Neither preflight/verdicts nor source/store data are fabricated. This proves the refusal/recovery path with a controlled capability input on macOS, not native Linux or Windows operation.

Final focused verification includes both typechecks, production build and **33 unit files / 366 passing tests**, with no failures/pending tests (`test-results/phase5-completion/units.json`). A fresh regression invocation across Plan Board, incomplete history, watcher observation, Verify execution, Worldline admission and Worldlines recorded **46 passing Electron cases**, without retries/skips. The earlier 42-case persistence report remains distinct evidence; it is not reused as this invocation. `test-results/phase5-completion/regressions.json` records those 46 integration cases; a separate `test-results/phase5-completion/ui-final.json` records 45 passing Attention, summary, keyboard, draft-recovery and accessibility cases without retries/skips. Together with the eight link cases, these are 99 cases across three distinct final invocations, not a full-application run. Build chunk-size and fixture GPU/output-drain warnings remain. Rust source is unchanged; the Rust unit, packaged-release and full-application matrices were not rerun.

### Human evaluation deferred by request; assistive-technology evidence still required

Use equivalent scripted tasks and data for the previous terminal-tab workflow and implemented proposal: unblock a background task, inspect a different project's failed/outdated check, identify source overlap, and return to the original editor. Preserve canonical source admission; the six-live-agent scenario must use actually admitted, separate work areas rather than ordinary competing primary writers. Record participant count, task outcome, time, missed decisions, wrong-context actions, recovery errors and the device/assistive-technology configuration. Report individual observations before claiming improvement; this plan specifies no invented pass threshold or study result.

The mockup may help explain or rehearse the design, but its simulated agents and evidence cannot replace the implemented runtime in this evaluation. Actual screen-reader testing needs a person using the target assistive technology; it was not enabled on the host by this test run. The measured latency defect is now diagnosed and corrected; Phase 5 remains open for actual VoiceOver use, participant observations and the larger-scale gaps in the matrix. Grouping, automation and additional management features remain deferred.

#### Visible, isolated manual session

After `pnpm run build`, a facilitator can launch the existing app with a fresh project/profile/HOME. This intentionally opens a visible window; it is a manual command, not executed by this agent. An empty credential environment avoids reusing host provider keys or `PI_*` variables. It does not seed a six-running-agent study condition: that condition needs a facilitator-controlled fixture provider or separately approved live-provider credentials/budget.

```bash
RUN_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/termina-attention-manual.XXXXXX")"
mkdir -p "$RUN_ROOT/home" "$RUN_ROOT/user-data" "$RUN_ROOT/events" "$RUN_ROOT/worlds" "$RUN_ROOT/tmp" "$RUN_ROOT/project"
printf 'export const greeting = "manual fixture";\n' > "$RUN_ROOT/project/greeting.ts"
printf '{"private":true,"scripts":{"test":"node -e \\"process.exit(7)\\""}}\n' > "$RUN_ROOT/project/package.json"
git -C "$RUN_ROOT/project" init -q
git -C "$RUN_ROOT/project" add .
git -C "$RUN_ROOT/project" -c user.name=termina -c user.email=dev@termina.local commit -qm "manual fixture"
env -i PATH="$PATH" HOME="$RUN_ROOT/home" USERPROFILE="$RUN_ROOT/home" \
  TMPDIR="$RUN_ROOT/tmp" TERM=xterm-256color SHELL=/bin/zsh NODE_ENV=test \
  TERMINA_USER_DATA_DIR="$RUN_ROOT/user-data" \
  TERMINA_EVENTS_DIR="$RUN_ROOT/events" TERMINA_WORLDS_DIR="$RUN_ROOT/worlds" \
  TERMINA_INITIAL_CWD="$RUN_ROOT/project" \
  pnpm exec electron . --user-data-dir="$RUN_ROOT/user-data"
```

Keep `RUN_ROOT` until the evaluator confirms app/owned children exited and any notes have been exported. Cleanup must target only that generated root, never host agent/session/preferences data. For multi-project conditions create independent fixture repositories with the same leaf name, plus a single-project control. Establish current failed checks through Verify, then save a source edit to produce stale history; do not write sidecar attention state. Admit candidate work through the UI, not by bypassing source claims. Record the exact baseline/proposal revisions and use separate fresh profiles/data for them.

#### VoiceOver session procedure — not yet performed

Record macOS/Electron/app versions, language, VoiceOver settings, input method, display/window size, zoom and theme. The evaluator enables VoiceOver using their normal macOS accessibility controls and returns those settings to their previous state afterward. Apple guide retrieval in this turn did not establish current VoiceOver-specific keyboard commands: the VoiceOver welcome URL returned 404 and the Mac-help fallback redirected to the general guide. Do not assume a shortcut/control binding from those responses. The live [WCAG keyboard reference](https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html) is guidance, not a certification claim.

Evaluate the implemented app, not screenshots or the HTML mockup:

1. Locate project navigation, distinguish same-name projects by their roots and identify the selected project without visual assistance.
2. Enter Attention from each opener. Navigate its heading, list, item context and actions with normal VoiceOver navigation and the rotor. Record the **actual spoken output** for an inspection control, especially whether its project/root/terminal context is discoverable when multiple controls share the same label.
3. Trigger a background Verify failure/staleness while another project is selected. Record whether changed counts/status are discoverable, whether an announcement interrupts current work, and whether focus/cursor context stays usable. Do not infer speech from an ARIA snapshot.
4. Inspect one item; read historical execution versus current source validity, confirm the exact owner and return to the original editor. Check that hidden/background terminal inputs are not exposed as active navigation targets.
5. Close/reopen Attention using the keyboard, then repeat with native zoom 200%, enlarged text, a narrow window and reduced motion. Record focus restoration, clipping and any inaccessible action.
6. Test terminal/editor entry, approval controls and an ordinary-agent/candidate transition. Distinguish problems inside xterm/Monaco from chrome problems and record the producer, rather than relabeling a failed workflow as successful.

For each task record outcome, assistance required, spoken output, focus/cursor transitions, wrong-context actions and a reproducible issue if it fails. No actual speech observations or VoiceOver pass result have been collected.

#### Participant session procedure — not yet performed

Recruit actual coding-tool users; include assistive-technology users for that condition. Obtain consent before any recording and keep fixtures free of real credentials/customer source. Let participants use their normal input method. Give neutral task goals without naming Attention or coaching the navigation route; counterbalance baseline/proposal order and reset equivalent fixture states between tasks.

Use the four tasks above plus identifying pending checks in the three-project/six-admitted-run condition, recovering an incomplete task, cancelling a consequence-aware close, and resuming a dirty draft after reload. Include the single-project control so added navigation cost is visible. Record elapsed time, correctness, missed decisions, wrong-context actions, recovery errors, help given and the participant's explanation of source ownership/evidence validity. If the baseline or a participant cannot complete setup/task, record that outcome rather than inventing comparable timing.

Report the actual participant count and per-task observations, not an invented success percentage, improvement threshold or accessibility score. The smallest unblocking action is an available evaluator running the visible isolated app with VoiceOver and participants providing observed task results. Protocol preparation and the automated six-agent runtime proof do **not** close these human evaluation items.

## Validation questions and edge cases

Before approving a production implementation, test:

- Three projects and six agents: can users identify each pending decision without opening every terminal?
- Same-name folders, nested roots, and symlink aliases: do visible identity and actual source ownership agree?
- Cross-project file links and delayed activation: do explorer, terminal, editor, search, and main all select the same context?
- Concurrent ordinary agents and shell writes: is source overlap prevented, serialized, or explicitly coordinated?
- Incomplete settlement, failed startup, authentication expiry, and worker exit: is there a truthful state and usable recovery action?
- Passing checks followed by user, agent, or external edits: does evidence become stale?
- Close while agents, shell commands, dispatch workers, or subagents are active: are consequences disclosed and targeting correct?
- Renderer reload and application restart with dirty drafts: what survives, and what is explicitly unrecoverable?
- Truncated logs/search history, missing snapshots, and unsupported platforms: are limits visible rather than disguised as success or empty results?
- Keyboard, screen readers, 200% zoom, large fonts, reduced motion, and narrow windows: can users complete the whole workflow?
- Increasing project counts and busy terminal output: does the overview remain responsive without eager heavy-view creation?
- A single project and agent: does the proposed structure avoid adding unnecessary navigation?

For usability evaluation, seed the same work in the current UI and mockup. Ask users to unblock a background task, inspect another project's stale/failed check, find an overlap, and return to their original editor. Compare time, missed decisions, wrong-context actions, and recovery errors. No study results are available yet.

## Mockup and evidence boundaries

The [mockup](../mockups/workspace/index.html) demonstrates project filtering, task focus, decisions, review, task queuing, keyboard search, overlap, restart, and first-run scenarios. See its [README](../mockups/workspace/README.md) for opening and verification instructions.

All data and checks in the mockup are simulated. It does not launch agents, invoke Electron, access providers or the network, create sandboxes, or apply changes. Reload/reset discards sample state. It does not implement every production lifecycle and failure state described here.

The audit records passing typecheck/build, 36 focused unit tests, and 13 mockup browser checks, alongside two failed existing Electron tests across targeted runs. Those are prior observed results, not checks rerun for this document and not proof of production concurrency or usability.

## Bottom line

**The next breakthrough should be trustworthy supervision, not simply more agents on screen.**

Keep execution powerful and inspectable. Make ownership, work areas, decisions, evidence, and recovery understandable. Let users focus deeply on one task without losing what needs them elsewhere.
