# Documentation

Current reference describes the product and architecture as they exist today. It is not an implementation backlog. Plans are proposed work. Do not cite a plan as shipped behavior.

## Current reference

- [`reference/USER-GUIDE.md`](reference/USER-GUIDE.md) — user-facing feature guide
- [`reference/WORLDLINES.md`](reference/WORLDLINES.md) — maintained Worldlines design and invariants
- [`reference/AGENT-CORE.md`](reference/AGENT-CORE.md) — agent-core principles and current behavior
- [`reference/GOVERNORS.md`](reference/GOVERNORS.md) — what actually fails a change (advisory map)
- [`reference/TOOLING-WATCH.md`](reference/TOOLING-WATCH.md) — fixture pins, third-party versions, retained deviations
- [`reference/PINNED-CONTEXT.md`](reference/PINNED-CONTEXT.md) — source-state and run-context pin owner map
- [`reference/CALIBRATION.md`](reference/CALIBRATION.md) — handoff confidence policy
- [`reference/AUDIT-LEDGER.md`](reference/AUDIT-LEDGER.md) — standing audit ledger rule
- [`reference/LAZINESS-BASELINE.md`](reference/LAZINESS-BASELINE.md) — measurement write-up for issue #125
- [`reference/MODULE-TEST-MATRIX.md`](reference/MODULE-TEST-MATRIX.md) — heuristic production module → unit-test inventory (issue #331)

Images used by the repository README are kept in [`assets/`](assets/).

## Audits and design studies

Dated findings and exploratory designs, not guarantees of current behavior.

- [`reference/WORKSPACE-EXPERIENCE-AUDIT.md`](reference/WORKSPACE-EXPERIENCE-AUDIT.md) — product, UI/UX, and developer-experience audit with evidence and validation limits
- [`reference/TOOL-AVAILABILITY-AUDIT.md`](reference/TOOL-AVAILABILITY-AUDIT.md) — dated audit of tool selection, execution authorization, and proposed improvements
- [`reference/EXTERNAL-AGENT-CLI-EVENTS.md`](reference/EXTERNAL-AGENT-CLI-EVENTS.md) — external CLI event comparison; Codex, Claude Code, Grok, Gemini CLI, and Muse Code launch their original TUIs with observational hooks
- [`mockups/workspace/README.md`](mockups/workspace/README.md) — interactive, simulated attention-first workspace study

## Plans

Not current behavior.

- [`plans/attention-first-workspace.md`](plans/attention-first-workspace.md) — historical proposal and staged implementation record; the All projects overview and its inspector/composer were subsequently removed, while Attention remains a persistent section above Projects in the rail alongside direct workspace navigation
- [`plans/terminal-first-workspace.md`](plans/terminal-first-workspace.md) — dated interaction audit and local implementation history, including the later removal of the global overview; historical findings and checks are not current UI guarantees
- [`plans/computer-use.md`](plans/computer-use.md) — proposed Termina-owned browser tool. Not implemented.
