# Phase 4 — ship comparison and Verify (Worldlines Release 1)

> **Status:** complete — both candidates can Verify and compare without
> primary writes (the Phase 4 acceptance gate, proven by
> `scripts/worldline-compare-test.mjs`, 29/29).

## What changed

### Fork Run in the UI (WORLDLINES §6.5)

- The timeline header gains **⇉ Fork Run**. It enables for the newest
  completed run of the active terminal and shows the exact ineligibility
  reason as the disabled tooltip (interruption, missing checkpoints,
  overlap, steering, session-branch failure).
- The renderer caches per-pane run records; main pushes
  `worldline:runs-changed` when `finalizeRun` completes a record, so the
  button refreshes after the settle checkpoint (the settle timeline event
  arrives earlier and is not a reliable signal).

### Candidate cards (WORLDLINES §6.9)

- New `src/worldlines.ts`: the Worldlines panel below the Plan Board, one
  card per candidate pair. DOM updates are incremental: an update push
  touches only its card.
- Each card shows the A/B badge, role (reference / alternative),
  lifecycle state, model and thinking level, and actions: **✓ Verify**
  (runs the tests inside the candidate sandbox), **Compare** (base →
  candidate file list), **Open** (reopen the candidate Pi terminal).
  The pair header carries **A ⇄ B** (union file list) and **Discard**
  (confirmed, all-or-nothing cleanup).
- Details load lazily per card (WORLDLINES §6.9 "on demand"):
  source statistics (tracked files and bytes at the head tree), provenance
  (source run, states, model, created at), runtime age, dependency
  declaration changes (package.json, pyproject.toml; added/removed/changed
  names), and the changed-files list vs the shared base.

### A/B badges

- Candidate terminal tabs carry the A/B badge (label from the worldline
  map; the primary tab stays unbadged).
- Editor tabs whose path sits under a candidate root carry the badge too;
  `EditorManager.refreshBadges()` re-applies them on worldline pushes.
- Candidate agent terminals no longer lock the primary editor: the busy
  lock scopes to primary-workspace agents only.

### Candidate Verify without primary writes (WORLDLINES §6.8)

- `runVerify` detects the test command from the owner terminal's own tree
  (the candidate root) and spawns the worker shell **under the candidate's
  sandbox profile** with the candidate HOME, TMPDIR, and events dir.
  The worker inherits the candidate workspace, so its writes stay inside
  the candidate tree and cannot reach the primary project.
- The result context file lands in the candidate's events dir, so the
  candidate agent reads it on its next turn.
- `verify:detect` accepts an optional terminal id; the renderer queries
  the candidate tree when a candidate pane is active.

### Comparison in Change Review (WORLDLINES §6.9)

- `ReviewView` gains two modes: **base → candidate** (shared base from the
  comparison commit, candidate head from its tree) and **A ⇄ B** (A as
  original, B as modified). Accept/Revert hide in candidate modes.
- All comparison reads go through the candidate repos (independent Git
  with read-only alternates); the primary project and its metadata are
  never touched.

### Main process

- `WorldlineManager` records the comparison base commit (`rev-parse HEAD`
  of the one-commit template), carries model / thinking level / created at
  in every summary, pushes an update when a candidate terminal launches,
  and exposes `candidateSandboxOf` for Verify.
- New IPC: `worldline:details`, `worldline:file`, `worldline:base-file`,
  `verify:detect(terminalId?)`, and the `worldline:runs-changed` push.
- Details are computed in the candidate repo: `status --porcelain` +
  `diff --name-status base..HEAD` for changed files (deduped with
  precedence created > deleted > modified), `ls-tree -r --long` for head
  statistics, and a JSON section compare for dependencies.

## Verification

- `npx tsc --noEmit`, `node scripts/build.mjs`, `npx vite build` — clean.
- Phase 0 spikes: 72/72.
- New e2e `scripts/worldline-compare-test.mjs` — 29/29: Fork Run button
  forks from the UI; both candidates ready with model + provenance; A/B
  tab badges shown; details report the changed file, statistics, and age;
  A verifies green and B verifies red inside their sandboxes (context
  files carry PASSED / FAILED); base/A/B file reads match the run states;
  the base → A and A ⇄ B diffs open in Change Review with the right
  sides; primary HEAD/refs/index untouched; discard empties the list.
- Full regression matrix (fresh instance per suite):
  fork-run 27/27, verify 11/11, verify-cancel 5/5, timeline 9/9,
  timeline-replay 3/3, explorer 7/7, review 5/5, mine-ownership 6/6,
  edits-to-agent 9/9, baseline-race 11/11, plan-board 6/6, dispatch 8/8,
  preview 4/4, tui-loop 3/3, session-search 6/6.
- Manual smoke: candidate Verify workers run under `sandbox-exec`; the
  worker tabs label as verify; editor stays editable while a candidate
  agent works.

## Known limits for the next phase

- No promotion yet: Phase 5 adds conflict preflight, Mine enforcement,
  the durable journal, staged apply, rollback, and startup recovery.
- No Challenge ranking: evidence contracts and deterministic comparison
  profiles are Phase 7. Verify builds the command from the candidate
  root; the shared-base command contract (WORLDLINES §6.8) is not yet
  enforced, and test-config changes are shown, not re-pinned.
- Trust-sensitive resource hashes are not yet computed; the run records
  the trust flag only.
- The run-start capture is a full reconcile; the incremental
  watcher-hint + index reconcile is Release 2 work.
- Candidate sessions persist only for the app session; a confirmed close
  discards live candidates (WORLDLINES §6.11).
