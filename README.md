# Termina

**Termina is mission control for your coding agent:** watch every edit
live, verify in one click, fork any moment, and merge only the winner —
your Git repo stays untouched.

The left side runs Termina's in-house agent — the real interactive TUI —
inside a terminal; the right side is a Monaco IDE that watches the agent
work live.

```
┌──────────────────────────────┬───────────────────────────────┐
│ agent TUI (real terminal, pty)│  Monaco IDE + file explorer   │
│  /login /models /plan /skills │   files auto-open mid-run     │
│  or Codex · Claude · Grok…    │   live-synced via fs.watch    │
├──────────────────────────────┴───────────────────────────────┤
│ terminal tabs · status bar                                   │
└──────────────────────────────┴───────────────────────────────┘
```

Everything runs locally. The terminal stays the source of truth; the app
records byte-exact source states in an app-owned snapshot store and never
writes your Git repository.

![Termina — the project rail and Attention, the explorer, the agent
terminal with its Timeline and Fork Run, and the live editor showing the
agent's edit; Verify is green with the Git handoff
buttons](docs/assets/screenshot.png)

![Worldlines — a forked run with candidates A and B in the Worldlines
tool, and Attention flagging the primary's outdated
check](docs/assets/screenshot-worldlines.png)

## User guide

New to Termina? Read **[`docs/reference/USER-GUIDE.md`](docs/reference/USER-GUIDE.md)** — a walkthrough of every feature: Change Review, Verify & Iterate, the Session Timeline, Plan Board dispatch, and Worldlines. The complete maintained-document index is [`docs/README.md`](docs/README.md).

## Features

| Feature | What it does |
|---|---|
| Empty first launch | fresh launches start with no folder until you pick one; later launches restore saved projects; the empty editor tells you to `/login` and `/models` when pi has no provider |
| Project rail & attention | up to 12 projects in a persistent rail, with direct workspace navigation, distinct paths and factual work/attention counts; an always-visible Attention section above Projects shows the total current item count and recorded issues across projects without resolving them by viewing — agents keep running when you switch |
| Terminal chooser | `Cmd/Ctrl+T` opens Termina's agent, an agent CLI found on `PATH` (Codex, Claude, Grok, Gemini via `agy`, Muse), or a detected shell. External CLIs keep their own login; activity comes from their hooks, and restored tabs resume the Claude, Codex, Grok, and Gemini conversation |
| Background sessions | closing the window keeps the app and its terminal sessions alive; reopening reconnects. A new core-agent write waits for **Approve once** after you reconnect. Quitting stops the agents |
| Command palette | `Cmd/Ctrl+K` searches commands, open projects and existing tasks; project results open the real workspace, and task results open the exact owner's Plan Board without starting work |
| File explorer | full tree with create / rename / delete, a VS Code-style context menu, cut / copy / paste, path actions, and Mine marks for files you own |
| Editor tabs | VS Code-style preview tabs, drag reorder, middle-click close, tab context menus, unsaved-edit dots, save all |
| Live editor | the file watcher pushes every disk change into open Monaco models; files the agent touches auto-open mid-run; word wrap and minimap toggle per preference |
| Previews & drafts | images open with zoom / fit / pan and PDFs in the built-in viewer; unsaved buffers keep recovery copies and reopen as unsaved tabs after a restart |
| Change Review | per-terminal modified-files panel with pre-run baselines: side-by-side diffs, Accept / Revert, Accept all. Termina never writes your Git repo; after a green Verify or Accept it offers a commit subject to copy and a shell in the project |
| Verify & Iterate | `✓ Verify` detects your test script, runs it in a background process, and feeds the result back to the agent on its next turn; cancellable mid-run |
| Session Timeline | a dot strip of every agent action with on-demand snapshots, replay, and a recorder state (indexing / paused / degraded); **Restore captured file** brings back one file from a dot without resetting the conversation |
| Multi-line input | Cmd/Ctrl/Shift+Enter inserts a newline in the terminal; Option+Enter (macOS) queues a follow-up while an agent runs; paste or drop screenshots to attach them |
| Plan Board | type `/plan` for a read-only planning turn and a task list with live progress; a task completes only on a current passing Verify. Dispatch starts workers on claimed files, with per-task models and `@every` / `@at` schedules. Add `@review` to a task for a worker restricted to local reads and search, with an optional [review skill](docs/examples/skills/review/SKILL.md). Reports stay in the worker terminal |
| Skills & MCP | `/skills` runs discovered skills; a skill with `paths` front matter attaches to reads and edits of matching files. MCP servers over stdio, HTTP, or SSE from `~/.termina/agent/mcp.json`; `/mcp` shows status and `/doctor` reports load failures |
| Working notes | an optional [notes skill](docs/examples/skills/notes/SKILL.md) saves project context and reads it on request; notes stay out of startup instructions and do not count as verified work |
| Session Search | full-text over past sessions with click-to-jump (`Cmd/Ctrl+Shift+P`) |
| Fork Run | fork any completed run into isolated candidates (A = result, B = start + task) |
| Fork Any Moment | Cmd/Ctrl+Click any timeline dot to fork a candidate at that exact source state |
| Challenge Mode | replay the task against candidates and rank them with deterministic evidence |
| Candidate sandbox | macOS `sandbox-exec` deny-list profiles; evidence and Verify processes run fully offline |
| Promote & Export | three-way merge candidates back with durable journaling and crash recovery, or export a patch bundle with a PR body |
| Layout | terminal left / right / top / bottom, fullscreen terminal, minimizable explorer / terminal / editor panes, remappable shortcuts |
| Auto-update | packaged builds check GitHub Releases and install updates on quit |

## Settings

Dark / Light / High contrast / Atom themes; editor and terminal font size;
font family picker; word wrap; minimap; remappable shortcuts for every
command, including toggle-terminal.

## Install

Packaged releases support **macOS (Apple Silicon) and Linux x64 only**.
Download the `.dmg` (or
`.AppImage`) from the [releases page](https://github.com/Jesusz0r/termina/releases).
The bundle ships the app, the Rust core, the in-house agent, and its own
node runtime — nothing else to install. Release builds are signed and
notarized, so Gatekeeper opens them without warnings.

After launching, run `/login` in the terminal to configure your model
provider.

**From source:** needs git, node ≥ 22.19, pnpm, and Rust/cargo. The installer
uses the lockfile and builds the core from the checked-out source; it never
downloads a standalone executable:

```bash
git clone https://github.com/Jesusz0r/termina.git
cd termina
./scripts/install.sh
pnpm run dev
```

**Contributors:** node + pnpm + cargo (the Rust core builds from `core/`):

```bash
pnpm install
pnpm run dev   # builds the Rust core + main + preload, starts Vite, launches Electron
```

## Development

```bash
pnpm run typecheck                 # tsc --noEmit
pnpm run test:agent-core           # agent-core kernel harness tests (no Electron)
pnpm run build                     # production build (Electron main + renderer)
pnpm run spike -- capture          # one plain-node store spike suite
pnpm run test:spikes               # native spikes + platform
node --experimental-strip-types scripts/perf-baseline.ts    # capture latency baselines
node --experimental-strip-types scripts/perf-compare.ts     # Rust core vs Git CLI on equal work
pnpm run test:e2e                  # the full Electron e2e matrix (fresh instances)
pnpm test                          # typecheck + unit
```

A new folder opens an **Agent (core)** tab. New tabs default to core.

Termina uses the agent configuration in `~/.termina/agent`. Host session
variables are removed before launch so a host session file cannot attach
to a terminal. Run `/login` and set the default provider and model in the
Termina terminal before running model-driven e2e suites.

## Architecture

- `electron/` — the main process: terminals, workspaces, watchers, IPC,
  preferences, the worldline manager, the evidence engine, candidate
  sandboxes, and the auto-updater. The in-house agent host writes sidecar
  JSONL (`agent-core/host.ts`, `logEvent` in `agent-core/main/sidecar.ts`);
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
- `scripts/` — the launcher, build steps, and packaging helpers.
- `tests/e2e/` — the Playwright Electron matrix (`pnpm run test:e2e`).
- The maintained Worldlines design lives in `docs/reference/WORLDLINES.md`.
  Implementation owners: `electron/worldlines/` and
  `electron/terminal-runtime.ts`.

## Contributing

See **`CONTRIBUTING.md`** for the dev setup, the test workflow, and the
code conventions. Ideas and questions go in
[Discussions](https://github.com/Jesusz0r/termina/discussions).

## Releasing

See **`RELEASING.md`** for the full runbook: certificate requirements,
CI secrets, and the release checklist. Short version: bump the
`package.json` version, then `git tag v<version> && git push origin
v<version>` — the workflow signs and notarizes macOS builds and publishes
both supported platform packages together.

## License

[MIT](LICENSE) © Jesus Mendoza
