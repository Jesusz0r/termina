# PROGRESS.md — Termina session state

> Clock in: read Next Steps. Clock out: update this file. Detail lives in `HARNESS-BACKLOG.md`.

## In progress

- Uncommitted working tree (2026-09-05): `agent-core/main.ts`, `agent-core/tui.ts`, `electron/main.ts`, `shared/types.ts`, `src/editor.ts`, `tests/unit/agent-core/harness-kernel.test.ts` — reconcile on clock-in.

## Next

- `HARNESS-BACKLOG.md` #3 (only unimplemented item): worldline compare buried — one-line header summary when a comparison is active. Touches `electron/worldlines.ts`.
- Verify from scratch: fresh clone → `pnpm run dev`, `pnpm run test:unit` (init acceptance).

## Done (recent)

- Activity tabs below terminal (`828d96f`); backlog #1 implemented.
- Quick open + command palette (`c1536d0`); backlog #2 implemented.
- Terminal fit coalesce behind explicit font load (`c0cafdd`); backlog #4 implemented.
- Host-gated bash approval for agent-core (`13158e5`).
- Model resume pin; boot loads all catalogs (`01da0c4`).
