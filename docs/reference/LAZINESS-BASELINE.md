# Laziness baseline (issue #125)

> **Status:** measurement baseline. Corpus is a checked-in synthetic
> fixture; numbers below are the repeatable fixture baseline, not
> production diligence data.

## Command

```bash
node --experimental-strip-types --no-warnings scripts/laziness-metrics.ts <trace-dir>
```

Input is one trace-v2 directory (`turn-N.json` records, the same shape
`scripts/trace-baseline.ts` reads). Output is deterministic JSON: sorted
keys, no timestamps or paths. `scripts/laziness-metrics.ts` is
measurement-only; it changes no runtime behavior.

## Corpus

`tests/fixtures/traces/laziness-baseline/` — 19 turn files, 9 tasks across
5 runs, hand-built to exercise every signal once:

- `run-a/task-1`: diligent success (edit + passing checks), followed
  immediately by `task-2` (edit without check).
- `run-b/task-1`: success with zero tool calls, followed immediately by a
  zero-call question-class task (execution/question contrast).
- `run-c/task-1`: failed task (excluded from settled-success signals).
- `run-c/task-2`: check without edits (neither signal 1 nor 2).
- `run-d/task-1` + `run-e/task-1` + `run-d/task-2`: a late follow-up (gap
  4 > 3) exercising the follow-up denominator without the numerator.

## Recorded baseline (2026-09-14)

Corpus: 9 tasks, 9 settled, 8 settled-success.

| Signal | Count | Total | Rate |
|---|---|---|---|
| edits without check | 1 | 8 | 0.125 |
| zero tool calls | 2 | 8 | 0.25 |
| follow-up after settle | 2 | 3 | 0.666667 |

Breakdowns (settled-success tasks):

- By task class: `implement` 6 tasks (1 zero-call, 1 edits-without-check),
  `question` 2 tasks (1 zero-call, 0 edits-without-check).
- By session-length bucket: `long` 3 tasks (1 lazy), `short` 5 tasks
  (3 lazy).
- By model: `m1` 4 tasks (2 lazy), `m2` 4 tasks (2 lazy).
- By effective effort: `high` 5 tasks (2 lazy), `low` 3 tasks (2 lazy).

Turns by outcome: success 8 tasks / 9 turns (p50 1, max 2); failure 1
task / 1 turn (p50 1, max 1).

`tests/unit/scripts/laziness-metrics.test.ts` re-runs the script on this
corpus and pins every number above; a script change that moves the
baseline fails loudly instead of drifting silently.

## Operational definitions and known approximations

- **Check** = a `bash` tool outcome with no error and a zero (or absent)
  exit code. Tool outcomes carry no command text in the current schema, so
  "the agent ran the test command" is approximated by "the agent ran bash
  successfully". A succeeding non-test shell command counts as a check
  (deflates signal 1); a check run outside bash is missed (inflates it).
- **Execution task** is not hardcoded: `taskClass` is free-form, so signal
  2 is reported over all settled-success tasks plus a by-task-class
  breakdown. Scope "execution" from the breakdown of the real corpus.
- **Follow-up** = a later task in the same run starting within 3 turns of
  the settle turn (configurable via `followupTurns`). Records carry no
  message text, so the correction-phrase refinement ("you didn't
  actually…") genuinely needs a schema addition; the structural proxy is
  documented as a proxy.
- Only schema version 2 `attempt` / `task-settled` records with run, task
  (and attempt) ids enter the denominators; anything else lands in
  `integrity`.

## Turn-budget recommendation

The fixture (n=9) cannot settle budgets; it validates the method. Grounded
reading of this data plus the decision rule for a real corpus:

1. **Nothing here justifies raising turn budgets.** Every success settled
   in ≤2 turns (p50 1); the only failure settled in 1 turn — it failed
   fast rather than exhausting a budget. If a real corpus (target: ≥100
   settled tasks) reproduces this shape — success concentrated in few
   turns, failures fast — keep budgets tight; the diligence lever is
   effort/prompt, not more turns.
2. **Decision rule for the real baseline:** plot success rate and the
   three laziness rates against turns-per-task. Over-tight budgets show up
   as rising signal 1/2 with falling turns; over-loose budgets show up as
   flat quality with rising turns. Set the budget just past the knee where
   marginal success plateaus and laziness stops falling.
3. **Effort lever first:** low-effort fixture tasks show the higher lazy
   share (2/3 vs 2/5 high). Treat as a hypothesis, not a finding: on the
   real corpus, compare an effort bump on hard tasks against prompt and
   budget changes in this same frame before spending quota on longer runs.

## Re-running on a real corpus

Point the script at any trace-v2 directory (agent harness output with
`turn-N.json` records). Compare its `signals` block against the table
above; every later diligence change (settle gate, critic pass, prompt
edits, budget moves) gets a before/after number from this command.

## Follow-ups

- Collect a real corpus (≥100 settled tasks) and record the production
  baseline beside this fixture baseline.
- If the follow-up proxy proves too noisy, add settled-then-prompt text
  (or a correction classifier bit) to the trace schema so signal 3 can
  match actual corrections; do not stretch the turn-gap proxy to cover it.
- If bash-without-command-text misclassifies checks on real data, record
  the check command (or a check-command flag) in tool outcomes.
