# Contributing to Termina

Thanks for helping out. This guide covers the setup, the workflow, and
the rules the project lives by.

## Development setup

Requirements: node >= 22.19, npm, and cargo (the Rust snapshot core
builds from `core/`). No git CLI is needed to run the app — every Git
operation runs inside the Rust core.

```bash
npm install
npm run dev   # builds the Rust core + main + preload, starts Vite, launches Electron
```

## First run

Termina is a client for pi. Run `/login` in the app's terminal and set
your default provider and model before testing anything model-driven.
Termina uses the pi configuration in `~/.pi/agent`.

## Project layout

| Path | What lives there |
|---|---|
| `electron/` | the main process: terminals, workspaces, watchers, IPC, worldlines, evidence |
| `core/` | `termina-core`, the Rust snapshot core — all Git operations |
| `src/` | the renderer: panes, Monaco editor, timeline, Change Review, explorer |
| `shared/` | types shared between main, preload, and renderer |
| `scripts/` | the e2e suites, the launcher, and the build steps |

The renderer never talks to the agent. It only renders what the main
process pushes. The terminal stays the source of truth.

## Running the tests

```bash
npx tsc --noEmit              # typecheck
npm run build                 # production build
npm run test:spikes           # plain-node spike suites (capture, merge, session-fork, platform)
npm run test:e2e              # the full Electron e2e matrix
node scripts/e2e.mjs --skip-build worldline-capture-test.mjs   # one suite
```

E2e rules that matter:

- Every suite runs against a **fresh Electron instance** on port 9222.
  Kill leftovers first (`pkill -9 -f "pi-editor/node_modules/electron"`).
- Suites share the app instance and the events directory — never run
  two suites against one instance.
- Test pollution persists on disk: reset the fixture after a suite that
  modifies it.
- Model-driven suites need a configured pi provider/model.

## Code conventions

- Comments are written in Simplified Technical English (STE): short
  active sentences, no abbreviations, no slang. Read `AGENTS.md` for
  the full rules — they apply to every comment in the repo.
- IPC channels use the `area:action` pattern (`verify:run`,
  `timeline:get`).
- Terminal ids use the `term-N` pattern.
- Performance over everything: the main process must never block on
  slow work — that is why captures, merges, and hashing run in the Rust
  core.
- No backwards compatibility: remove dead code immediately, and update
  every place that depends on a changed feature.

## Changing the Rust core

`core/` speaks a JSON-lines protocol over stdio; `electron/core-client.ts`
is the client. When you add an op:

1. Implement it in `core/src/main.rs` and register it in `dispatch`.
2. Add the typed client method in `electron/core-client.ts` (or a
   `SnapshotStore` method in `electron/worldline-git.ts`).
3. Run the spike suites (`npm run test:spikes`) — they exercise the
   store byte-for-byte through the real binary.
4. Keep `cargo clippy` and `cargo fmt --check` clean.

## Submitting changes

1. Branch off `master`, keep changes focused.
2. Run `npx tsc --noEmit`, `npm run build`, the spike suites, and the
   e2e suites that touch your change.
3. Commit with the repo identity: `termina <dev@termina.local>`.
4. Open a pull request; describe what changed and what you verified.

## Releasing

Releases are tag-driven: bump `package.json`, tag `v<version>`, push.
The workflow signs, notarizes, and publishes every platform. The full
runbook — certificates, CI secrets, and the failures to avoid — is in
`RELEASING.md`.
