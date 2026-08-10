# Phase 8 — complete the plan (WORLDLINES §4-§11)

> **Status:** complete — every remaining plan item is implemented and
> verified: isolation hardening, trust hashes, evidence freshness, the
> comparison details, promotion confirmations, lifecycle confirmation,
> budgets, the preflight/capture/isolation test suites, and the latency
> baselines.

## What changed

### Isolation (§6.6)

- The sandbox profile now write-denies the copied Pi resources
  (settings, models-store, skills, prompts, themes, extensions) while the
  auth file stays writable (token refresh changes only that copy). The
  rest of the candidate home stays writable so npm and tooling work.
- Resource limits apply through a `ulimit` preamble in the wrapper shell:
  CPU time, open files, and output file size. The address-space and
  process-count limits are documented omissions: `RLIMIT_AS` fails with
  EINVAL on current macOS and `RLIMIT_NPROC` is per-user (a bound breaks
  npm's forks under load); process groups bound candidates instead.
- Evidence and Verify workers run under a profile variant with a full
  `(deny network*)` (the sandbox language only accepts `*`/`localhost`
  hosts, so a per-provider allowlist is not expressible; candidates keep
  network for the model provider).
- Fork preflight (WORLDLINES §4): repository checks (non-Git folder, Git
  subdirectory, unresolved index, submodule, sparse checkout, partial
  clone, source alternate, content filters, active operations), platform
  checks (sandbox, copy-on-write, recursive watcher), and the 4 GB
  free-space minimum. The capture domain skips submodule gitlinks instead
  of crashing the boot capture.

### Trust hashes (§6.7)

- The trust-sensitive resource set (project `.pi` + `.agents/skills` +
  the pi agent dir's settings, models-store, prompts, skills, themes,
  extensions) is hashed at every preflight and recorded on the run.
- Fork eligibility rejects a run whose trust-sensitive resources changed
  since the run.
- The bridge handles `project_trust`: a candidate inherits one-process
  trust only when the source run was trusted and the hashes matched,
  granted with `remember: false` (the candidate path is never persisted).

### Evidence freshness (§6.8-§6.9)

- Evidence runs use a fresh evidence home (the real Pi resources copied
  per run) — ranking never uses agent-modified home or tool config.
- The dependency evidence measures test-config changes and rejects
  undeclared external packages used by candidate source (node built-ins
  excluded); the fewer-dependencies profile surfaces the reason.
- Evidence becomes stale when a candidate runs again (pushed to the UI).

### Comparison details (§6.9)

- Details add unowned-edit provenance, ignored/generated fingerprint
  metadata, and the merge-conflict status against the current primary
  (captured and merged on demand).
- New `worldline:compare` IPC: base→A, base→B, and A→B metadata lists.

### Promotion and lifecycle (§6.10-§6.11)

- Promotion asks for explicit confirmation once when evidence is absent,
  stale, or failed, and warns about ignored/generated writes that the
  promotion will exclude (the hard checks — Mine, conflicts — reject
  first).
- Folder switches and app quits ask for confirmation when live candidates
  have source changes or session activity.

### Budgets (§9)

- Session (64 MB) and prompt payload (20 MB) caps in the fork eligibility;
  template (2 GB) and candidate (1 GB) caps at materialization; the
  256 MB retained-blob budget pauses recording with the budget recorder
  state; the checkpoint acknowledgement timeout is 5 s per the plan.
- `scripts/perf-baseline.mjs` records the §9 latency baselines: full
  capture p95 ≈ 38 ms (target 200 ms) and incremental p95 ≈ 38 ms
  (target 100 ms) on the 200-file fixture.

### Nested worldlines (§6)

- Candidate workspaces seed their moment chain from the candidate's own
  head (A = settled, B = start, moment = the moment state), so nested
  moments include every ancestor change while the root promotion base (R)
  stays unchanged.
- `worldline:fork-point` works inside candidates: the session forks at
  the dot's entry from the candidate's live session.
- Candidate tool events resolve against the candidate root (the previous
  within-project guard dropped them), and the preflight ack routes to the
  terminal's own events dir (candidates could never see it before).

### Challenge from a candidate (§6.9)

- A candidate can be challenged: its head is snapshotted as the new
  reference A, and the challenger B starts from the recorded base with
  the pre-task session anchor and the original task. An occupied B
  requires a discard confirmation first.

### Test suites (§10)

- `worldline-preflight-test.mjs` — 7 fixtures (plain / non-Git / Git
  subdirectory / unresolved index / submodule / autocrlf / sparse) with
  stable rejection reasons.
- `worldline-capture-test.mjs` — byte-exact moment reproduction, primary
  untouched, snapshot corruption invalidates dependent points.
- `worldline-isolation-test.mjs` — sandbox write boundaries, network
  denial, limits, independent Git/homes, and the full nested worldline
  flow with promotion.
- Preflight hardening: the preflight handler always answers the bridge
  (a failure writes an error ack instead of hanging the run start).

## Verification

- `npx tsc --noEmit`, `node scripts/build.mjs`, `npx vite build` — clean.
- Full matrix (fresh instance per suite): fork-run 27/27, compare 29/29,
  promote 21/21, any-moment 18/18, challenge 19/19, isolation 25/25,
  capture 14/14, recovery 7/7, preflight 7/7, timeline 9/9,
  timeline-replay 3/3, explorer 7/7, review 5/5, mine-ownership 6/6,
  edits-to-agent 9/9, baseline-race 11/11, dispatch 8/8, plan-board 6/6,
  preview 4/4, session-search 6/6, tui-loop 3/3, verify 11/11,
  verify-cancel 5/5.
- `scripts/perf-baseline.mjs`: full capture p95 ≈ 38 ms, incremental
  p95 ≈ 38 ms on the 200-file fixture.

## Known limits (documented in the plan or code)

- The sandbox language cannot express per-provider network allowlists
  (host must be `*`/`localhost`); candidates keep network, evidence and
  Verify workers are fully offline.
- `RLIMIT_AS` fails on current macOS and `RLIMIT_NPROC` is per-user;
  process groups bound candidates instead.
- The API adapter measures normalized declaration content, not a parsed
  signature surface; routes, commands, and wire formats stay unmeasured.
