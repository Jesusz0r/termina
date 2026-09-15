# Confidence calibration (issue #240)

> **Status:** policy. This file is the owner. The checker
> `scripts/handoff-check.ts` rejects a handoff that does not meet the
> contract. This is not a settle gate and not an activity reducer.

Session handoffs and audit notes must state confidence. A reader must
not infer it from tone ("looks good") or absorb a bare claim by
osmosis.

## Session routine

AGENTS.md Session routine already says: **Done = checkable + proven by facts.**
This file does not replace that sentence. It states the format a claim
must use so the sentence can be checked.

This file does not edit AGENTS.md. Sister issue #237 owns the
No-Quiet-Wins fail-closed settle rule.

## Claim format

Every finding or fix claim must state all three:

| Part | Meaning |
|---|---|
| **Evidence** | The check, path, command, or measurement that supports the claim. |
| **Confidence** | A calibrated level and why that level applies. |
| **Change-condition** | The new fact that would revise or withdraw the claim. |

Uncertain claims escalate. They do not settle as success.

### Confidence levels

| Level | When to use | Action |
|---|---|---|
| **high** | Observed checks match the claim. No open contradiction. | The claim may stand. |
| **medium** | Evidence exists. A named gap remains. | State the gap. Do not call the work done. |
| **low** | Evidence is missing, incomplete, or conflicting. | Escalate. Do not settle. |

"Looks good", "should be fine", and implied certainty are not levels.
If the level is not stated, the claim is not calibrated.

## Handoff contract

A conforming handoff must state every field below. A missing or empty
field is a reject. The checker does not fill defaults.

| Field | What it must say |
|---|---|
| **as-is** | The current state before the claim. |
| **should-be** | The intended state. |
| **checks-observed** | Checks that actually ran, with outcomes. Not checks that "would pass". |
| **open-risks** | Named residual risks, or an explicit `none` if there are none. |
| **evidence** | The facts that support the claim (paths, commands, measurements). |
| **confidence** | `high`, `medium`, or `low`, plus why. |
| **change-condition** | What new fact would change the claim. |

Write those fields as Markdown headings (`## As-is`) or as labels
(`as-is:`). JSON with the same keys is also valid. Heading aliases
(`Checks observed`, `observed-checks`, `what would change the claim`)
map to the canonical names. Unknown sections are ignored. They do not
satisfy a required field.

### Command

```bash
node --experimental-strip-types --no-warnings scripts/handoff-check.ts <handoff-file>
```

Exit 0 if the file meets the contract. Exit 1 if any required field is
missing or empty. The process prints the missing names and stops. It
does not complete the note.

### Example (conforming)

```markdown
## As-is
Handoffs omit evidence and confidence. Readers absorb the claim.

## Should-be
Every handoff states as-is, should-be, checks observed, open risks,
evidence, confidence, and a change-condition.

## Checks observed
- `pnpm run typecheck` (pass)
- `pnpm exec vitest run tests/unit/scripts/handoff-check.test.ts` (pass)

## Open risks
none

## Evidence
`docs/reference/CALIBRATION.md` and `scripts/handoff-check.ts`.
The checker rejects a note that omits any required field.

## Confidence
high — the contract is in this file and the checker fails closed on
a missing field.

## Change-condition
A required field with no name in the checker, or a checker that fills
a default, would withdraw the "high" claim.
```

### Example (reject)

```markdown
Looks good. Checks should pass. Ready to hand off.
```

That note has no required fields. The checker rejects it. A reader
must not treat it as a successful handoff.

## What this file does not own

- **Not a settle gate.** Do not add a second settle path in
  `agent-core` or a terminal-less runner. Issue #237 owns
  No-Quiet-Wins fail-closed.
- **#123 and #124 are gone.** The verify-before-success and
  critic-before-settle gates shipped and were later removed
  (`f77883c`). Do not restore them here.
- **#125 is measurement-only.** Rates live in
  `docs/reference/LAZINESS-BASELINE.md` and
  `scripts/laziness-metrics.ts`. Those files do not settle a run and
  do not copy this policy.
- **No IPC. No activity reducer.** The owner is this document plus
  `scripts/handoff-check.ts`.
