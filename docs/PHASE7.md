# Phase 7 — Challenge Mode (Worldlines Release 3)

> **Status:** complete — one click launches the challenger (B replays the
> original task automatically) and Pi/ditor ranks only current measured
> evidence without a model judging another model's work (the Release 3
> gate, proven by `scripts/worldline-challenge-test.mjs`, 19/19).

## What changed

### Challenge launch (WORLDLINES §6.9)

- New `electron/challenge`-free flow in `WorldlineManager.forkRun(run,
  { challenge: true })`: the pair is A = the preserved settled reference,
  B = the challenger. B's startup control is always `structured`: the
  bridge replays the original task's content blocks unchanged through
  `sendUserMessage` — one click, no editor prefill. The challenger
  matches the run's model and thinking level by default.
- New IPC `worldline:challenge` (runId) with validation: the run must
  exist and carry a captured prompt payload. `worldline:evidence`
  (comparisonId) computes the evidence for both candidates.

### Evidence engine (WORLDLINES §6.8, §6.9)

- New `electron/evidence.ts`: `EvidenceEngine.measure` runs one
  candidate's evidence serially (A then B — no port, cache, CPU, or
  fixture contention):
  - **Verify**: the base test command detected from the shared base's
    package manifest (npm script, or pytest/cargo/go from the workspace),
    run inside the candidate sandbox with the candidate HOME/TMPDIR.
    A result is current only when the source state is unchanged after the
    run (tree equality; commit hashes differ by parent and timestamp).
  - **Dependencies**: added/removed/changed declarations vs the base
    (shared `dependencyDiff` now also powers the details view).
  - **API**: the public roots of the base package (`exports`/`main`),
    resolved to `.d.ts` siblings, normalized (comments stripped, blanks
    dropped) into a signature manifest; removed or changed signatures
    fail the gate.
  - **Footprint**: changed source files, changed executable lines, and
    changed bytes vs the base.
  - **Benchmark**: an immutable harness declared as
    `pi-ditor.benchmark` in the base package (command, unit, direction,
    samples, threshold). Warm-up, then interleaved samples parsed from
    `name value unit` lines; the profile reports medians and quartiles.
    Disabled with the exact reason when the base declares no harness.
- Every record carries the candidate head state and the base state:
  evidence is bound to the state it measured.

### Deterministic ranking (WORLDLINES §6.9 "for all profiles")

- `rankProfiles` computes the four fixed verdicts from current evidence
  only. A candidate is ineligible when its verify evidence is missing or
  failed, or when its changes touch a current Mine path (the reason names
  the file). Unavailable adapters produce `unavailable` with the adapter's
  exact reason.
- **Fewer dependencies**: fewer added declarations wins; zero beats one;
  equal stays a tie.
- **Preserve API**: removed or changed measured signatures fail the
  challenger.
- **Simpler implementation**: added declarations, then changed files,
  then changed lines — labeled the smallest verified footprint.
- **Performance-first**: the effect must exceed the 5% threshold with
  variability inside the 20% interquartile bound; otherwise a tie.
- Every verdict carries per-candidate eligibility reasons.

### Renderer

- The pair header gains **⚔ Challenge** (launches the challenger) and
  **⚖ Evidence** (runs the contract when both candidates are usable).
  Verdict chips render under the header (fewer deps / api / footprint /
  perf with the winner and the exact reason as tooltip).
- Candidate details gain an Evidence section: one line per kind with the
  measured detail, plus an `evidence winner` label when a profile names
  the candidate.

## Verification

- `npx tsc --noEmit`, `node scripts/build.mjs`, `npx vite build` — clean.
- New e2e `scripts/worldline-challenge-test.mjs` — 19/19: the challenger
  auto-submits the task and solves it; verify passes on both candidates;
  fewer-dependencies ties at zero added; preserve-api and
  performance-first are unavailable with their exact reasons; the
  footprint ties; the verdict chips render; a Mine change makes the
  candidate ineligible with the owned path; evidence re-runs fresh;
  primary HEAD/refs/index untouched; discard cleans up.
- Full regression matrix (fresh instance per suite): fork-run 27/27,
  compare 29/29, promote 20/20, any-moment 18/18, timeline 9/9,
  edits-to-agent 9/9, baseline-race 11/11, verify 11/11, verify-cancel
  5/5, timeline-replay 3/3, mine-ownership 6/6, explorer 7/7, review 5/5,
  dispatch 8/8, recovery 7/7.

## Release 3 gate

One click launches the selected adversarial alternative, and Pi/ditor
ranks only current measured evidence without a model judging another
model's work. With this phase, the Worldlines plan (WORLDLINES §7,
phases 0-7) is complete: Fork Run, Verify, comparison, recoverable
promotion, Fork Any Moment, and Challenge Mode.

## Known limits

- The API adapter measures normalized declaration content, not a parsed
  signature surface; routes, commands, and wire formats stay unmeasured
  until a dedicated adapter exists.
- The benchmark adapter requires the declared `pi-ditor.benchmark`
  harness; projects without one get the unavailable verdict with the
  reason.
- Nested worldlines and challenge-from-candidate use the candidate head as
  the reference. Both challenge paths are supported.
