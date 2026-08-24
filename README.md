# Termina

**Termina** is a hybrid coding cockpit: the left side runs **pi** — the real
interactive TUI — inside a terminal; the right side is a Monaco IDE that
watches the agent work live. Review what changed, verify it, fork runs into
isolated candidates, and converge on green code together.

```
┌──────────────────────────────┬───────────────────────────────┐
│ pi TUI (real terminal, pty)  │  Monaco IDE + file explorer   │
│  /settings /login /models    │   files auto-open mid-run     │
│  plan mode, completions…     │   live-synced via fs.watch    │
├──────────────────────────────┴───────────────────────────────┤
│ terminal tabs · status bar                                   │
└──────────────────────────────┴───────────────────────────────┘
```

Everything runs locally. The terminal stays the source of truth; the app
records byte-exact source states in an app-owned snapshot store and never
writes your Git repository.

![Termina — the pi TUI on the left, the live Monaco editor with the
modified list and session timeline on the right](docs/screenshot.png)

![Worldlines — a forked run with candidates A and B, and the plan
board showing the completed tasks](docs/screenshot-worldlines.png)

Screenshots are from an earlier 0.1.x build. Settings now include Atom,
terminal font, and word wrap; first launch is empty until you open a
folder; the Plan Board shows Dispatch assignments.

## User guide

New to Termina? Read **[`docs/USER-GUIDE.md`](docs/USER-GUIDE.md)** — a walkthrough of every feature: Change Review, Verify & Iterate, the Session Timeline, Plan Board dispatch, and Worldlines.

## Features

| Feature | What it does |
|---|---|
| Empty first launch | fresh launches start with no folder until you pick one; later launches restore saved project tabs; the empty editor tells you to `/login` and `/models` when pi has no provider |
| Project tabs | up to 12 projects side by side: one tab per folder, each with its own explorer, editor, terminals, and worldlines — agents keep running when you switch |
| File explorer | full tree with create / rename / delete, a VS Code-style context menu, cut / copy / paste, path actions, and Mine marks for files you own |
| Editor tabs | VS Code-style preview tabs, drag reorder, middle-click close, tab context menus, unsaved-edit dots, save all |
| Live editor | the file watcher pushes every disk change into open Monaco models; files the agent touches auto-open mid-run; word wrap and minimap toggle per preference |
| Change Review | per-terminal modified-files panel with pre-run baselines: side-by-side diffs, Accept / Revert, Accept all. Termina never writes your Git repo; after a green Verify or Accept it offers a commit subject to copy and a shell in the project |
| Verify & Iterate | `✓ Verify` detects your test script, runs it in a background process, and feeds the result back to the agent on its next turn; cancellable mid-run |
| Session Timeline | a dot strip of every agent action with on-demand snapshots, replay, and a recorder state (indexing / paused / degraded) |
| Multi-line input | Cmd/Ctrl/Shift+Enter inserts a newline in the terminal; Option+Enter (macOS) queues a follow-up while an agent runs |
| Plan Board | the agent's task list with live progress; Dispatch starts parallel workers and shows each assignment (claimed files, settled) on the board. Workers receive a mailbox briefing |
| Session Search | full-text over past sessions with click-to-jump (`Cmd/Ctrl+Shift+P`) |
| Fork Run | fork any completed run into isolated candidates (A = result, B = start + task) |
| Fork Any Moment | Cmd/Ctrl+Click any timeline dot to fork a candidate at that exact source state |
| Challenge Mode | replay the task against candidates and rank them with deterministic evidence |
| Candidate sandbox | macOS `sandbox-exec` deny-list profiles; evidence and Verify processes run fully offline |
| Promote | three-way merge candidates back with durable journaling and crash recovery |
| Layout | terminal left / right / top / bottom, fullscreen terminal, minimizable explorer / terminal / editor panes, remappable shortcuts |
| Auto-update | packaged builds check GitHub Releases and install updates on quit |

## Settings

Dark / Light / High contrast / Atom themes; editor and terminal font size;
font family picker; word wrap; minimap; remappable shortcuts for every
command, including toggle-terminal.

## Install

**macOS (Apple Silicon) / Linux x64 users:** download the `.dmg` (or
`.AppImage`) from the [releases page](https://github.com/Jesusz0r/termina/releases).
The bundle ships the app, the Rust core, the pinned pi package, and its own
node runtime — nothing else to install. Release builds are signed and
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
npm run typecheck                   # tsc --noEmit
npm run build                       # production build (Electron main + renderer)
npm run spike -- capture            # one plain-node store spike suite
npm run test:spikes                 # capture · merge · session-fork · platform · tree-delta
node scripts/perf-baseline.mjs      # capture latency baselines
node scripts/perf-compare.mjs       # compare a run against a baseline
npm run test:e2e                    # the full Electron e2e matrix (fresh instances)
npm test                            # typecheck + build + spikes
```

Termina uses the pi configuration in `~/.pi/agent`. Host `PI_*` session
variables are removed before launch so a host session file cannot attach
to a terminal. Run `/login` and set the default provider and model in the
Termina terminal before running model-driven e2e suites.

## Architecture

- `electron/` — the main process: terminals, workspaces, watchers, IPC,
  preferences, the worldline manager, the evidence engine, candidate
  sandboxes, and the auto-updater. The bridge extension (app-owned, loaded
  by pi through the CLI option) is the only writer of sidecar JSONL;
  `sidecar.ts` is the only parser. Session forks run off the main thread
  in a worker (`session-fork.ts` → `session-worker.ts`).
- `core/` — `termina-core`, the Rust snapshot core: captures,
  materialization, merges, preflight, diff-tree, tree queries, and trust
  hashes. Every Git operation runs in this binary via a JSON-lines
  protocol; the app never spawns Git.
- `src/` — the renderer: panes, Monaco editor and tabs, timeline, Change
  Review, explorer, worldlines panel, session search, settings window.
- `shared/` — types, commands, and the preferences validator shared by
  main, preload, and renderer.
- `scripts/` — the e2e suites, the launcher, and the build steps.
- The detailed design lives in `docs/WORLDLINES.md` with per-phase
  records in `docs/PHASE0.md` … `PHASE8.md`.

## Contributing

See **`CONTRIBUTING.md`** for the dev setup, the test workflow, and the
code conventions. Ideas and questions go in
[Discussions](https://github.com/Jesusz0r/termina/discussions).

## Releasing

See **`RELEASING.md`** for the full runbook: certificate requirements,
CI secrets, and the release checklist. Short version: bump the
`package.json` version, then `git tag v<version> && git push origin
v<version>` — the workflow signs and notarizes macOS builds and
publishes every platform automatically.

## License

[MIT](LICENSE) © Jesus Mendoza
