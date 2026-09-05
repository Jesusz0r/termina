# Phase 2 — Record exact run boundaries (Worldlines Release 1)

> **Status:** complete — every run offered by Fork Run reconstructs start and
> settled source bytes and session branches exactly inside the declared
> boundary (the Phase 2 acceptance gate, proven by
> `scripts/worldline-run-boundary-test.mjs`, 20/20).

## What changed

### Bridge (WORLDLINES §6.3)

- Every sidecar event now carries a random bridge-instance id and a
  monotonic sequence.
- **Run-start preflight (three hooks):**
  1. `input` (idle, interactive, non-empty) writes a `preflight_request`
     with a random request id and polls for the app's acknowledgement.
  2. On failure the bridge restores the raw text in the editor, notifies
     the user, and returns `handled` — the agent does not start.
  3. On success it stores the one-use token and returns `continue`.
  - `before_agent_start` writes the effective expanded prompt + images to
    an app-private payload file and logs a `prompt` event, then injects
    the existing context files.
  - `agent_start` reports the preflight token, session file + id, prompt
    entry id and its parent, and project-trust state.
  - Steering and queued follow-ups (input while not idle) log
    `steer_input`; the open run becomes non-replayable.
- **Settled checkpoint:** `agent_settled` logs the settle, then emits a
  `checkpoint_request` (kind settled, entry id) and waits for the app's
  acknowledgement up to 20 s.

### Main (WORLDLINES §6.3, §6.5)

- `handlePreflightRequest`: workspace write lease (waiting, bounded),
  renderer dirty-model flush (`editor:flush-request` push +
  `editor:flush-report` invoke; flush saves go through `file:flush-save`
  checked against the lease holder), start-state capture, one-use token.
  The lease stays held until `agent_start` couples the run; a 60 s TTL
  releases stranded preflights.
- `coupleRunStart`: consumes the token, verifies the workspace generation
  did not move, records the run (start state, prompt, entry ids, session
  file, trust). A token-less `agent_start` is a retry/compaction of the
  open run. A run without a token is recorded but not replayable.
- `handleCheckpointRequest` / `captureStable`: quiet window (100 ms),
  capture, generation check, one bounded retry; atomic ack; attaches the
  settled state and entry, copies the session branch into
  `<events>/session-workspace/<run>.jsonl`, and evaluates eligibility
  (interruption, overlap with verify/dispatch, missing checkpoints).
- Run records are capped at 20 per terminal; evicted runs delete their
  prompt payload files. Folder switch tears down the store, worker,
  pending preflights, and stale ack files.
- IPC: `worldline:runs` (metadata only), `worldline:export-state`
  (materialize a state for inspection).

### Snapshot worker (WORLDLINES §9)

- New `electron/snapshot-worker.ts` runs captures on a worker thread
  (serialized). Bundled by `build.mjs` and `dev.mjs`.
- Blob writing now writes loose objects directly (zlib(header+bytes),
  sha1/sha256) — one git spawn per file is gone; the capture spike still
  verifies byte-exactness (21/21).
- The initial index capture runs at folder open; run boundaries chain from
  it. Non-Git folders record nothing (preflight passes through with a
  null token).

### Sidecar tailer

- Event-driven: `fs.watch` on the events directory triggers immediate
  tails (debounced); the interval poll (300 ms) remains as recovery.

## Verification

- `npx tsc --noEmit`, `node scripts/build.mjs`, `npx vite build` — clean.
- Phase 0 spikes: 72/72 (loose-object blob writes included).
- New e2e `scripts/worldline-run-boundary-test.mjs` — 20/20:
  clean run replayable; start/settled states materialize byte-for-byte
  (pre-run "hello", post-run "hi there"); prompt, entry ids, session
  branch copy present; HEAD/refs/index untouched; steering marks the next
  run non-replayable with the reason recorded.
- Existing suites green (fresh instance each): timeline 9/9,
  edits-to-agent 9/9, mine-ownership 6/6, baseline-race 11/11,
  plan-board 6/6, tui-loop 3/3, review 5/5, explorer 7/7, preview 4/4,
  session-search 6/6, dispatch 8/8, verify 11/11, verify-cancel 5/5,
  timeline-replay 3/3.

## Known limits for the next phase

- Trust-sensitive resource hashes are not yet computed; the run records
  the trust flag only. Candidate trust inheritance (Phase 3) needs the
  full hash set.
- Mine-path enforcement during promotion is Phase 5.
- The run-start capture is a full reconcile; the incremental
  watcher-hint + index reconcile is Release 2 work.
- A preflight waits for the write lease instead of failing immediately
  (keeps parallel dispatch workers starting); the doc's "abort on busy"
  is implemented as a bounded wait.
