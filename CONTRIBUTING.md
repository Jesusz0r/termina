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

## Clean-code methodology

Use **KISS and YAGNI by default, selective SOLID at architectural boundaries,
and one owner for each business rule**. These are design and review guidelines,
not new CI gates. The [decision priorities in AGENTS.md](AGENTS.md#decision-priority-when-rules-conflict)
remain authoritative: simplicity never overrides data integrity, process
isolation, or main-process responsiveness.

> Use the simplest complete solution, keep each invariant under one owner,
> and introduce abstractions only when current requirements justify them.

### Defaults: KISS, YAGNI, and selective DRY

- **KISS (keep it simple):** optimize for understanding, not the fewest lines.
  Keep effects, failure paths, transaction ordering, and cleanup explicit.
- **YAGNI (you aren't going to need it):** solve the current requirement.
  Prefer existing code, composition, or a small local change over speculative
  plugin systems, configuration switches, or generic frameworks.
- **DRY (don't repeat yourself):** centralize business rules and invariants.
  Similar syntax alone does not justify an abstraction; unrelated code can
  look alike without sharing a responsibility.

Search for the existing owner before adding behavior. The
[canonical ownership map](AGENTS.md#one-canonical-implementation) identifies
those boundaries: Rust owns Git and snapshots, main owns authoritative state
and orchestration, preload exposes the typed bridge, and the renderer owns
presentation and transient UI state. Do not add parallel implementations.

### Apply SOLID where it helps

Apply these principles to modules and functions as well as classes. They do
not require an object-oriented rewrite or extra architectural layers.

- **Single responsibility:** group code by invariant, lifecycle, or reason to
  change. One responsibility has one owner, which may include private helpers.
- **Open/closed:** extend established extension points when needed. Editing an
  existing function is often simpler than building hypothetical extensibility.
- **Liskov substitution:** implementations sharing a contract must preserve its
  semantics, including errors, lifecycle behavior, and cleanup guarantees.
- **Interface segregation:** keep IPC contracts and host seams focused. Do not
  expose a broad privileged API to a consumer that needs one operation.
- **Dependency inversion:** use dependency injection at meaningful I/O and
  testing seams, not an interface around every helper.

An abstraction should reduce the effort needed to understand and change an
operation, not merely spread it across more files.

### Refactor from evidence

Separate validation and decision logic from filesystem, PTY, Electron, and
subprocess effects when that makes behavior easier to understand and test.
Keep cohesive transaction sequencing visible; do not fragment snapshot,
write-lease, or recovery logic just to make functions smaller or pure.

Extract a module when it has a distinct lifecycle, invariant, test surface,
or reason to change. Do not impose arbitrary function lengths or argument
counts. The existing 800-line file threshold in `AGENTS.md` triggers an
assessment, not a mandatory split or unrelated refactor. Keep comments that
explain invariants, ordering constraints, and non-obvious reasons.

### Review checklist

1. Does the change preserve data integrity, isolation, and responsiveness?
2. Does each business rule or invariant have one owner?
3. Is this the smallest complete solution to a current requirement?
4. Are effects, failure paths, and cleanup explicit?
5. Does each new abstraction make the code easier to understand than a direct
   implementation?
6. Are changed contracts migrated fully, with obsolete paths removed and only
   the on-disk compatibility exceptions permitted by `AGENTS.md` retained?
7. Do the checks cover changed behavior and relevant failure cases, following
   the [verification requirements](AGENTS.md#conventions--verification)?

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
