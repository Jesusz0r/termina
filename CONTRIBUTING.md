# Contributing to Termina

Thanks for helping out. This guide covers setup and workflow.
The text below is convention and advisory. It does not add CI gates.
See `docs/reference/GOVERNORS.md` for what actually fails a change.

## Development setup

Requirements: node >= 22.19, pnpm, and cargo (the Rust snapshot core
builds from `core/`). No git CLI is needed to run the app — every Git
operation runs inside the Rust core.

```bash
pnpm install
pnpm run dev   # builds the Rust core + main + preload, starts Vite, launches Electron
```

## First run

Termina runs its in-house agent. Run `/login` in the app's terminal and set
your default provider and model before testing anything model-driven.
Termina uses the agent configuration in `~/.termina/agent`.

## Project layout

| Path | What lives there |
|---|---|
| `electron/` | the main process: terminals, workspaces, watchers, IPC, worldlines, evidence |
| `core/` | `termina-core`, the Rust snapshot core — all Git operations |
| `src/` | the renderer: panes, Monaco editor, timeline, Change Review, explorer |
| `shared/` | types shared between main, preload, and renderer |
| `scripts/` | the launcher, build steps, and packaging helpers |
| `tests/e2e/` | Playwright Electron matrix (`pnpm run test:e2e`) |

The renderer never talks to the agent. It only renders what the main
process pushes. The terminal stays the source of truth.

## Running the tests

```bash
pnpm exec tsc --noEmit        # typecheck
pnpm run build                # production build
pnpm run test:spikes          # plain-node spike suites (capture, merge, platform)
pnpm run test:e2e              # the full Electron e2e matrix
pnpm run test:e2e -- tests/e2e/worldlines.spec.ts  # one Playwright spec
pnpm run test:electron-focused  # area suites (also test:agent-core-focused, test:build-focused)
pnpm exec vitest run <path>     # any single file or directory; one-off specs need no alias
```

E2e isolation convention (`tests/e2e/fixtures.ts`). The full Playwright
matrix is not in pull-request CI:

- Each runner invocation owns a fresh root containing its fixtures,
  events, worlds, Electron user-data profiles, and a HOME with its own
  `.termina/agent` tree. Concurrent runners do not share these paths, and the
  host `~/.termina/agent` tree is not used or modified.
- Electron requests an OS-assigned loopback DevTools port. The runner
  reads `DevToolsActivePort` only from the profile it created, validates
  that port, and passes it to the active suite.
- The runner owns its build, Electron, and suite children. It stops and
  waits for them before removing the run root. Keep process and profile
  cleanup scoped to resources created by that invocation.
- On macOS and Linux, cleanup covers the detached build, Electron, and
  suite process groups. Windows cleanup is limited to the directly spawned
  children.
- Model-driven suites need a configured agent provider/model.

## Code conventions

- Convention: comments use Simplified Technical English (STE): short
  active sentences, no abbreviations, no slang. `AGENTS.md` states the
  same convention. No CI job checks comment wording.
- IPC channels use the `area:action` pattern (`verify:run`,
  `timeline:get`).
- Terminal ids use the `term-N` pattern.
- Convention: keep the main process off slow work. Captures, merges,
  and hashing run in the Rust core. Unchecked in CI.
- Convention: do not keep backwards-compat shims. Remove dead code
  and update callers. See `AGENTS.md`. Unchecked in CI.

## Changing the Rust core

`core/` speaks a JSON-lines protocol over stdio; `electron/worldline-git.ts`
is its sole public TypeScript client. Process and protocol plumbing is private
under `electron/worldline-git/`. When you add an op:

1. Implement it in `core/src/main.rs` and register it in `dispatch`.
2. Add the typed operation or `SnapshotStore` method in
   `electron/worldline-git.ts`.
3. Run the spike suites (`pnpm run test:spikes`) — they exercise the
   store byte-for-byte through the real binary.
4. Convention (unchecked in CI): keep `cargo clippy` and
   `cargo fmt --check` clean when you touch `core/`.

## Submitting changes

1. Branch off `main`, keep changes focused.
2. Run `pnpm exec tsc --noEmit`, `pnpm run build`, the spike suites, and the
   e2e suites that touch your change.
3. Convention: app-created snapshot commits use
   `termina <dev@termina.local>` (`AGENTS.md`). Contributor commit
   identity is not gated.
4. Open a pull request; describe what changed and what you verified.

## Releasing

Releases are tag-driven: bump `package.json`, tag `v<version>`, push.
The workflow signs, notarizes, and publishes the supported macOS arm64 and
Linux x64 packages. The full
runbook — certificates, CI secrets, and the failures to avoid — is in
`RELEASING.md`.
