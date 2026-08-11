# Termina

A **hybrid terminal + IDE**: the left side runs **real pi** — the actual
interactive TUI — in a pty. The right side is a Monaco IDE that watches the
agent work live.

```
┌──────────────────────────────┬───────────────────────────────┐
│ pi TUI (real terminal, pty)  │  Monaco IDE + file explorer    │
│  /settings /login /models     │  files auto-open mid-run       │
│  plan mode, completions…      │  live-synced via fs.watch      │
├──────────────────────────────┴───────────────────────────────┤
│ terminal tabs · status bar                                    │
└───────────────────────────────────────────────────────────────┘
```

## How it works

| Component | Role |
|---|---|
| Terminal panes | each runs `pi` (the real TUI) in a pty via node-pty — multi-terminal, each lands on the project folder |
| Bridge extension | app-owned, loaded with pi's CLI `-e` option from the app user-data directory (never installed into the project); streams agent events to sidecar files |
| Live editor | the file watcher pushes every disk change into open Monaco models; `tool:target` events auto-open files the agent is editing, mid-run |
| Change Review | per-terminal modified-files panel with pre-run baselines: side-by-side diffs, Accept / Revert, Accept all |
| Verify & Iterate | `✓ Verify` runs the detected tests in a background process and feeds the result back to the agent on its next turn |
| Session Timeline | a dot strip of every agent action with on-demand snapshots, replay, and the recorder state (indexing / ready / paused / degraded / budget) |
| Plan Board | the agent's task list with live progress and one-click parallel Dispatch |
| Session Search | full-text over past sessions with click-to-jump |
| File explorer | project tree, create/rename/delete, preview tabs |
| Settings | themes, editor font and minimap options, and remappable keyboard shortcuts |

## Worldlines (Fork Run, Fork Any Moment, Challenge)

The review-iterate loop becomes a driving cockpit. Every completed run can be
forked into isolated candidates; every timeline dot captures its exact source
state; and Challenge Mode ranks candidates with deterministic evidence.

| Feature | What it does |
|---|---|
| Fork Run | an eligible run forks Candidate A (the settled result) and Candidate B (the start + the original task) into sandboxed, app-owned trees |
| Candidate sandbox | macOS `sandbox-exec` deny-list profiles: candidates cannot write the primary, the real home, the sibling, or the snapshot store; evidence and background Verify processes run fully offline |
| Verify in candidates | each candidate runs the detected tests inside its own sandbox (A green, B red is a common first look) |
| Compare | base → A, base → B, and A ⇄ B diffs in Change Review, with source statistics, provenance, dependency changes, and conflict status vs the primary |
| Promote | a three-way merge with the run start as the base, Mine-path enforcement, durable journaling, crash recovery, and a promoted terminal that continues the candidate's session |
| Fork Any Moment | every tool dot is a forkable moment: Cmd/Ctrl+Click forks a candidate with that exact source state and the session branched at that entry |
| Nested worldlines | moments inside candidates fork and promote with the root base unchanged |
| Challenge Mode | ⚔ launches the challenger (the original task replayed automatically); ⚖ Evidence computes the base Verify command, dependency declarations, the public API manifest, footprint, and the declared benchmark; four fixed profiles rank only current evidence with exact reasons |
| Trust | trust-sensitive resource hashes gate forks; candidates inherit one-process trust only from a trusted matching base, and candidate paths never persist in the user trust store |

Everything is local. The terminal stays the source of truth; the app records
byte-exact source states in an app-owned snapshot store and never writes the
user's Git repository. Termina preferences are stored in the app user-data
directory, separate from Pi `/settings` and project files.

## Getting started

## Install

**Packaged app (recommended):** download the `.dmg` from
https://github.com/Jesusz0r/termina/releases. The bundle ships the app,
the Rust core, the pinned pi package, and its own node runtime. Nothing
else needs installing; run `/login` in the terminal to configure your
model provider. Release builds are signed with the Apple Distribution
identity; notarization activates when the Apple credentials exist (see
below), which removes the Gatekeeper warning for downloaded apps.

**From source (script):** needs node >= 22.19 and npm, no cargo and no
git (the Rust core downloads as a prebuilt binary):

```bash
curl -fsSL https://raw.githubusercontent.com/Jesusz0r/termina/master/scripts/install.sh | sh
TERMINA_SKIP_CORE_BUILD=1 npm run dev
```

**Contributors:** node + npm + cargo (the core builds from `core/`):

```bash
npm install          # includes @lydell/node-pty (native, prebuilt for Electron)
npm run dev          # builds the Rust core + main + preload, starts Vite, launches Electron
```

Packaged builds: `npm run dist` (electron-builder; `dist:mac`, `dist:dir`).
The CI workflow builds macOS arm64/x64 and Linux x64 bundles and attaches
the raw core binaries to every release tag.

## Releasing

- The icon comes from `build/icon.svg`; regenerate the icns with
  `scripts/make-icon.sh`.
- Signed macOS builds select the identity with `CSC_NAME`:
  `CSC_NAME="Apple Distribution" npm run dist:mac`.
- Notarization (removes the Gatekeeper warning): set `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD` (an app-specific password from
  https://appleid.apple.com), and `APPLE_TEAM_ID` (UWK965RX2N), then
  build with `-c.mac.notarize=true`.
- CI signs and notarizes when these GitHub secrets exist: `CSC_LINK`
  (base64 of the exported `.p12`), `CSC_KEY_PASSWORD`, `CSC_NAME`,
  `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. Without
  them the CI builds stay unsigned.

- `npx tsc --noEmit` — typecheck
- `npm run build` — production build for Electron and the renderer
- `node scripts/perf-baseline.mjs` — capture latency baselines (§9 targets)
- `npm run test:e2e` — build and run the complete Electron e2e matrix. The
  launcher resets the fixture, events, worlds, and app-data directories for
  every suite and starts a fresh instance on port 9222. Run one suite with
  `npm run test:e2e -- --skip-build worldline-capture-test.mjs`.

Termina uses the Pi configuration in `~/.pi/agent`. Host `PI_*` session
variables are removed before launch so a host session file cannot attach to a
terminal. Run `/login` and set the default provider and model in the Termina
terminal before running model-driven e2e suites.

## Layout

`electron/` holds the main process, the pty wrapper, the sidecar tailer, the
watcher, the snapshot store client (`worldline-git.ts`), the worldline
manager (`worldlines.ts`), the evidence engine (`evidence.ts`), and the
sandbox profiles (`sandbox.ts`). `core/` holds the Rust snapshot core
(`termina-core`): captures, materialization, template creation, state
application, and trust hashes run in that binary, never on the Electron
main thread. `src/` holds the renderer (panes, editor, timeline,
review, explorer, worldlines panel). The detailed plan lives in
`docs/WORLDLINES.md` with per-phase records in `docs/PHASE0.md` … `PHASE8.md`.
