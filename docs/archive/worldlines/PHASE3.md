# Phase 3 — create the isolated Fork Run pair (Worldlines Release 1)

> **Status:** complete — an eligible completed run forks into two isolated
> candidates whose source bytes, sessions, and sandbox boundaries match the
> declared contract (the Phase 3 acceptance gate, proven by
> `scripts/worldline-fork-run-test.mjs`, 27/27).

## What changed

### Worldline manager (WORLDLINES §6.5, §6.6)

- New `electron/worldlines.ts`: `WorldlineManager` owns every comparison.
  A comparison is one pair: Candidate A (reference, keeps the settled
  source state and session) and Candidate B (alternative, restores the
  run-start source state and the effective task).
- Eligibility (WORLDLINES §6.5): the run must be replayable, carry both
  source checkpoints, carry a session branch copy, and fit the live
  budget (at most 3 live candidates). The source repository identity is
  re-checked at fork time (`resolve` comparison against the store root).
- Pair creation is all-or-nothing. One ordered pipeline builds the pair:
  comparison dir + ownership marker + manifest, base template, CoW clones,
  settled-state apply to A, session forks, support dirs, Pi resource
  copies, startup controls, sandboxed launches. Any failure tears down
  the whole comparison and removes every app-owned resource.
- Candidate lifecycle: `creating → ready → running → settled`, with
  `error`, `cancelled`, and `discarded` terminal states. A 90 s timer
  fails the pair when the bridge never reports both candidates ready.
- The template (base source bytes plus an independent Git directory) is
  removed once both candidates are ready. Runtime allowlists
  (`node_modules`, `.venv`, `venv`) ride along as copy-on-write clones.
- Cleanup is ownership-checked: a worlds dir is removed only when it sits
  inside the worlds root and carries the `.termina-world` marker.
  Process kills verify identity via `ps lstart` before SIGTERM/SIGKILL.
- `sweepStale` runs at boot: after a crash it kills surviving candidate
  process groups (manifest pids + lstart) and removes the owned dirs.
- A per-comparison `manifest.json` records candidate pids, lstart, and
  paths for crash recovery.

### Candidate sandbox (WORLDLINES §6.6)

- New `electron/sandbox.ts`: builds the macOS `sandbox-exec` deny-list
  profile. The candidate may write only inside its own tree and support
  dirs (home, sessions, events, tmp, cache).
- The profile denies reads and writes of the primary project (except the
  read-only source Git object directory), the real home (except the app's
  own load paths: the pinned pi package and the node binary), the app
  snapshot store, the sibling candidate, and the template.
- The profile is defense in depth for file-tool paths; the operating
  system policy is the actual write boundary. Process-inspection denial
  is a documented gap: it breaks the pi TUI bootstrap.

### Session fork (WORLDLINES §6.7)

- New `electron/session-worker.ts` (worker thread): forks candidate
  sessions off the main thread. It copies the source session to an
  app-private workspace, opens the copy, verifies the entry chain,
  branches at the given entry, and forks into the candidate session dir.
- Candidate A branches at the settled entry and carries a hidden
  relocation note (`termina-relocation`, display false) that maps the
  primary path to the candidate tree.
- Candidate B branches at the prompt parent; when the branch has no
  assistant message the session file is deferred to the first append
  (root-prompt case). B also carries the run's injected context as a
  hidden one-shot message (`termina-context`).
- B's launch replays the run's model and thinking level (provider-
  qualified model ids only; a bare id is ambiguous across providers).

### Startup controls (WORLDLINES §6.7)

- The bridge's `session_start` hook reads a one-shot
  `startup-control.json` from the candidate events dir and consumes it
  exactly once (the file is removed before use, so a reload cannot apply
  it twice).
- Candidate A starts with `action: none`. Candidate B starts with
  `prefill` (editable text in the Pi editor) for text-only prompts, or
  `structured` for image-bearing prompts: a marker entry plus a
  `sendUserMessage` replay of the original content blocks, guarded by a
  one-shot marker so a reload cannot submit it twice.
- The bridge logs `session_ready` with the control op id; main couples it
  to the candidate and advances the lifecycle.

### Main process (WORLDLINES §6.5)

- IPC: `worldline:runs` (metadata only), `worldline:list`,
  `worldline:fork-run`, `worldline:cancel`, `worldline:discard`,
  `worldline:open-terminal` (reopen a candidate), and
  `worldline:export-state` (materialize a run state for inspection).
- Candidate terminals launch through `sandbox-exec -f <profile> <pi>
  --session <file> -e <bridge>`, with a sanitized env, an isolated
  `HOME`, `TMPDIR`, and their own events dir. Each candidate gets its own
  sidecar tailer and its own (non-recording) workspace with a watcher.
- A candidate terminal exit advances the candidate to `settled`; the
  comparison and all bookkeeping survive until discard.

## Verification

- `npx tsc --noEmit` — clean.
- `node scripts/build.mjs` — clean (main, preload, snapshot worker,
  session worker).
- Phase 0 spikes: 72/72 (capture 21, merge 17, session-fork 19,
  platform 15).
- New e2e `scripts/worldline-fork-run-test.mjs` — 27/27:
  replayable run forks; A holds the settled bytes and B holds the start
  bytes; candidates live under the worlds root in distinct dirs; sessions
  fork into app-owned candidate dirs; A carries the relocation note; B's
  startup control is consumed exactly once and emits `session_ready`;
  the profile denies the primary, the real home, and the sibling while
  allowing the candidate tree (proven with live `sandbox-exec` probes);
  both candidate pi processes run sandboxed; primary HEAD/refs/index
  untouched; discard removes the comparison dir and empties the list.

## Known limits for the next phase

- The renderer has no Fork Run surface yet: Phase 4 adds the button,
  ineligibility reasons, A/B badges, candidate cards, Verify, and
  A-to-B comparison.
- Trust-sensitive resource hashes are not yet computed; the run records
  the trust flag only. Candidate trust inheritance (Phase 3 delivery in
  §6.7) needs the full hash set.
- Mine-path enforcement during promotion is Phase 5.
- The run-start capture is a full reconcile; the incremental
  watcher-hint + index reconcile is Release 2 work.
- Candidate B's empty session materializes on the first append (the
  deferred-write contract), not at fork time.
