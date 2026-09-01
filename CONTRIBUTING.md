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

- Each runner invocation owns a fresh root containing its fixtures,
  events, worlds, Electron user-data profiles, and a HOME with its own
  `.pi/agent` tree. Concurrent runners do not share these paths, and the
  host `~/.pi/agent` tree is not used or modified.
- Electron requests an OS-assigned loopback DevTools port. The runner
  reads `DevToolsActivePort` only from the profile it created, validates
  that port, and passes it to the active suite.
- The runner owns its build, Electron, and suite children. It stops and
  waits for them before removing the run root. Keep process and profile
  cleanup scoped to resources created by that invocation.
- On macOS and Linux, cleanup covers the detached build, Electron, and
  suite process groups. Windows cleanup is limited to the directly spawned
  children.
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
The workflow signs, notarizes, and publishes the supported macOS arm64 and
Linux x64 packages. The full
runbook — certificates, CI secrets, and the failures to avoid — is in
`RELEASING.md`.
