# Termina

**Termina** is a hybrid coding cockpit: the left side runs **pi** — the real
interactive TUI — inside a terminal; the right side is a Monaco IDE that
watches the agent work live. Review what changed, verify it, fork runs into
isolated candidates, and converge on green code together.

```
┌──────────────────────────────┬───────────────────────────────┐
│ pi TUI (real terminal, pty)  │  Monaco IDE + file explorer    │
│  /settings /login /models     │  files auto-open mid-run       │
│  plan mode, completions…      │  live-synced via fs.watch      │
├──────────────────────────────┴───────────────────────────────┤
│ terminal tabs · status bar                                    │
└───────────────────────────────────────────────────────────────┘
```

Everything runs locally. The terminal stays the source of truth; the app
records byte-exact source states in an app-owned snapshot store and never
writes your Git repository.

![Termina — the pi TUI on the left, the live Monaco editor with the
modified list and session timeline on the right](docs/screenshot.png)

## Features

| Feature | What it does |
|---|---|
| Live editor | the file watcher pushes every disk change into open Monaco models; files the agent touches auto-open mid-run |
| Change Review | per-terminal modified-files panel with pre-run baselines: side-by-side diffs, Accept / Revert, Accept all |
| Verify & Iterate | `✓ Verify` runs the detected tests in a background process and feeds the result back to the agent on its next turn |
| Session Timeline | a dot strip of every agent action with on-demand snapshots, replay, and a recorder state |
| Plan Board | the agent's task list with live progress and one-click parallel Dispatch |
| Session Search | full-text over past sessions with click-to-jump |
| Fork Run | fork any completed run into isolated candidates (A = result, B = start + task) |
| Fork Any Moment | Cmd/Ctrl+Click any timeline dot to fork a candidate at that exact source state |
| Challenge Mode | replay the task against candidates and rank them with deterministic evidence |
| Candidate sandbox | macOS `sandbox-exec` deny-list profiles; evidence and Verify processes run fully offline |
| Promote | three-way merge candidates back with durable journaling and crash recovery |
| Settings | themes, editor font and minimap options, and remappable keyboard shortcuts |

## Install

**macOS / Linux users:** download the `.dmg` (or `.AppImage`) from the
[releases page](https://github.com/Jesusz0r/termina/releases). The bundle
ships the app, the Rust core, the pinned pi package, and its own node
runtime — nothing else to install. Release builds are signed and
notarized, so Gatekeeper opens them without warnings.

After launching, run `/login` in the terminal to configure your model
provider.

**From source (script):** needs node ≥ 22.19 and npm — no cargo, no git:

```bash
curl -fsSL https://raw.githubusercontent.com/Jesusz0r/termina/master/scripts/install.sh | sh
TERMINA_SKIP_CORE_BUILD=1 npm run dev
```

**Contributors:** node + npm + cargo (the Rust core builds from `core/`):

```bash
npm install
npm run dev   # builds the Rust core + main + preload, starts Vite, launches Electron
```

## Development

```bash
npx tsc --noEmit                    # typecheck
npm run build                       # production build (Electron + renderer)
node scripts/perf-baseline.mjs      # capture latency baselines
npm run test:e2e                    # the full Electron e2e matrix (fresh instances)
npm run test:spikes                 # plain-node store spike suites
```

Termina uses the pi configuration in `~/.pi/agent`. Host `PI_*` session
variables are removed before launch so a host session file cannot attach
to a terminal. Run `/login` and set the default provider and model in the
Termina terminal before running model-driven e2e suites.

## Architecture

- `electron/` — the main process: terminals, workspaces, watchers, IPC,
  the worldline manager, and the evidence engine.
- `core/` — `termina-core`, the Rust snapshot core: captures,
  materialization, merges, preflight, and trust hashes. Every Git
  operation runs in this binary via a JSON-lines protocol; the app never
  spawns Git.
- `src/` — the renderer: panes, Monaco editor, timeline, Change Review,
  explorer, worldlines panel.
- `scripts/` — the e2e suites, the launcher, and the build steps.
- The detailed design lives in `docs/WORLDLINES.md` with per-phase
  records in `docs/PHASE0.md` … `PHASE8.md`.

## Releasing

See **`RELEASING.md`** for the full runbook: certificate requirements,
CI secrets, and the release checklist. Short version: bump the
`package.json` version, then `git tag v<version> && git push origin
v<version>` — the workflow signs and notarizes macOS builds and
publishes every platform automatically.

## License

[MIT](LICENSE) © Jesus Mendoza
