# Phase 6 — Fork Any Moment (Worldlines Release 2)

> **Status:** complete — every visible tool dot becomes a forkable moment
> with that exact captured source state and the persisted Pi context of the
> moment (the Release 2 gate, proven by
> `scripts/worldline-any-moment-test.mjs`, 18/18).

## What changed

### Stable forkable events

- The bridge logs the tool call id and the session leaf id with every
  `tool` event (`toolCallId`, `entryId`). Parallel sibling tools share the
  leaf id: the batch anchor. A new `tool_end` event marks the moment the
  tool's disk effects are done.
- Tool and change dots carry `stateId` (the captured source state),
  `entryId`, `toolCallId`, and the run's model. A dot with a state is
  forkable: it renders with the forkable ring, and its tooltip says
  Cmd/Ctrl+Click to fork.
- The moment capture is debounced after the last `tool_end` or watcher
  change (200 ms): sibling tools coalesce into one state; sequential tools
  stay separate because the agent's next tool is far slower than the quiet
  window.

### Incremental capture (WORLDLINES §6.4)

- New `SnapshotStore.captureIncremental`: seeds a temp index from the
  parent tree (`read-tree`), applies the hinted delta (`update-index` for
  writes, `--force-remove` for deletions), writes the tree, commits with
  the parent, and verifies every changed entry. No full reconcile per
  event.
- Reconciliation for missed watcher events: the watcher's content cache is
  hashed against the parent tree in one path-limited `ls-tree` (bounded to
  2000 entries); a cached path whose git blob differs joins the capture
  set.
- The run-boundary captures (start/settled) and the moment captures chain
  through the workspace's last state commit, so the lineage stays a single
  chain.

### Fork at a moment (WORLDLINES §6)

- New IPC `worldline:fork-point` (terminalId, seq) with expected-version
  checks: the dot must exist with its state and entry, and the state must
  not have been evicted. Nested worldlines stay disabled: a candidate
  terminal rejects with "nested worldlines are not supported yet".
- `WorldlineManager.forkPoint` builds a single-candidate comparison
  (role `moment`): the template IS the moment state, the session forks at
  the dot's entry (later entries stay out), and the candidate launches
  with the captured model and no prompt — the user continues it.
- The run lookup for a dot uses the dot's timestamp, so moments from
  earlier runs resolve after later runs settled.

### Budget, eviction, and recorder states

- At most 100 forkable points per terminal. Eviction removes the oldest
  dots, unrefs their store states together, and pushes `timeline:evict`
  so the renderer drops the dots.
- The timeline header shows the recorder state outside the dot strip:
  `indexing` (initial capture pending), `ready`, `paused` (no Git
  recording), `degraded` (a capture failed), `budget` (eviction active).

### Renderer

- `TimelineView` fixes: `setEvents` copies the list (the pane's timeline
  aliased the view's events, so pushes mutated the view without creating
  dots — a latent bug that made the strip stay empty), and `push` appends
  new events to the list before creating the dot.
- Forkable dots render with the accent ring; Cmd/Ctrl+Click forks at the
  moment; plain click still opens the snapshot tab.
- The recorder label, eviction handling, and the fork callback wire the
  pushes.

## Verification

- `npx tsc --noEmit`, `node scripts/build.mjs`, `npx vite build` — clean.
- Phase 0 spikes: capture 21/21 (re-run).
- New e2e `scripts/worldline-any-moment-test.mjs` — 18/18: run 1's
  greeting dot captures its state; the dot renders forkable and the
  recorder shows ready; run 2's hello dot captures its state; forking at
  run 1's dot reproduces the source AT THAT MOMENT (the later hello edit
  stays out) and the session branch excludes the later context; forking
  at run 2's dot includes the earlier greeting change (the lineage);
  a candidate terminal rejects nested forking; discards clean up; the
  primary repo holds exactly the two runs' edits.
- Full regression matrix (fresh instance per suite): timeline 9/9
  (including the strip-render fix), timeline-replay 3/3, fork-run 27/27,
  compare 29/29, promote 20/20, recovery 7/7, baseline-race 11/11,
  edits-to-agent 9/9, explorer 7/7, review 5/5, mine-ownership 6/6,
  dispatch 8/8, plan-board 6/6, preview 4/4, session-search 6/6,
  tui-loop 3/3, verify 11/11, verify-cancel 5/5.

## Known limits for the next phase

- Nested worldlines are disabled by design (fork-point rejects candidate
  terminals) until attribution and cleanup tests pass; the root promotion
  base therefore stays unchanged.
- The watcher-cache reconcile is bounded; a change missed by both the
  hints and the bounded cache degrades the recorder state rather than
  capturing stale bytes.
- Phase 7 adds Challenge Mode: evidence contracts, deterministic
  profiles, and ranking.
