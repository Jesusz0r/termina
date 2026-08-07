# pi-editor

A **hybrid terminal/editor** for working with the [pi coding agent](https://github.com/earendil-works/pi).

- **Terminal** (left): an [xterm.js](https://xtermjs.org/) session where you prompt the agent and watch it work — streaming text, thinking, and tool-call cards (bash output streams live).
- **Editor** (right): [Monaco](https://microsoft.github.io/monaco-editor/) — the same editor VS Code uses. Files the agent writes or edits appear here **live**, as they happen on disk.
- **Modified files panel** (below the terminal): when the agent settles, every file it created (`A`) or modified (`M`) is listed. **Click any file to open it in the editor** — and file paths in the terminal are clickable too.

```
┌──────────────────────────────┬─────────────────────────────┐
│ ▸ bash $ npm test           │  hello.txt │ greeting.ts    │
│   ╭─ ◇ write hello.txt      │ ┌─────────────────────────┐ │
│   ╰─ ✓ wrote 15 bytes       │ │ export const greeting  │ │
│   ── Session complete ──    │ │   = "hi there";        │ │
│   ● hello.txt  (created)    │ │                         │ │
│   ● greeting.ts (modified)  │ └─────────────────────────┘ │
├──────────────────────────────┴─────────────────────────────┤
│ ❯ [prompt the agent…]                                       │
└─────────────────────────────────────────────────────────────┘
```

## How it works

| Component | Technology | Role |
|---|---|---|
| Desktop shell | Electron | window, menus, IPC, file dialogs |
| Agent instances | **pi in `--mode rpc`** (one child process per terminal) | JSONL protocol over stdio — no Node-version coupling, uses your existing pi install + `~/.pi/agent` auth |
| Editor | Monaco editor | shared live file viewer, tabs, read-only while any agent streams |
| Terminal panes | xterm.js | multiple isolated terminals — each with its own chat, model and modified files |
| Live sync | `fs.watch` (recursive) + tool events | every disk change pushes new content into the open Monaco model |

### Multiple terminals

- **＋** in the terminal tab bar (or `Cmd+Shift+T`) opens a new terminal — a fully isolated agent instance with its own pi process, chat history, model/thinking selection and modified-files list.
- New terminals land on the currently-open project folder.
- The toolbar's model/thinking dropdowns and the modified-files panel follow the **active** terminal.
- The editor is shared: files any terminal touches open and update live in the same Monaco instance.

### File explorer

- The editor pane has a **file explorer** sidebar showing the project folder structure (directories lazy-load on expand; dotfiles and noise dirs are hidden).
- Click a file to open it in the editor; hover a row for actions: **new file / new folder** (directories), **rename**, **delete** (with confirmation).
- The tree stays in sync with the watcher: files the agents create/delete appear/disappear live; the editor itself supports manual edits with `Cmd+S` (locked while an agent streams).

### The agent loop

1. You type a prompt in the terminal (Enter sends, Shift+Enter newline, **Cmd+Enter steers mid-task**).
2. pi runs in RPC mode. Every event streams to the renderer:
   - `message_update` → streaming text / thinking in the terminal
   - `tool_execution_start` for `write`/`edit` → the file **opens in the editor** immediately
   - `tool_execution_update` → bash output streams inside the tool card
   - `tool_execution_end` → result line (`✓`/`✗`)
3. The file watcher notices disk changes and updates the open Monaco model **live** — you watch the agent edit in real time.
4. On `agent_settled` the terminal prints a **Session complete** summary with created/modified counts, the modified-files panel fills in, and every entry (and every path in the terminal) is **clickable → opens in the editor**.

### Layout & controls

- **Open Folder** (or `Cmd+O`) — pick a project; pi restarts with that cwd.
- **Model / thinking** dropdowns — list every model from your pi config (`get_available_models`), switch live via `set_model` / `set_thinking_level`.
- **New Session** (`Cmd+N`), **Abort** (`Cmd+.`).
- Drag the divider to resize the panes.
- The editor is locked read-only while the agent streams; when idle you can edit and save with `Cmd+S` (writes through to disk).

## Getting started

```bash
npm install
npm run dev        # builds main/preload, starts vite, launches Electron
```

Requires the `pi` binary on your PATH (the global install of `@earendil-works/pi-coding-agent`) and credentials in `~/.pi/agent/auth.json`. Override the binary with `PI_EDITOR_PI_BIN=/path/to/pi`, or pre-open a project with `PI_EDITOR_INITIAL_CWD=/path/to/project` (handy for testing).

### Build & run without the dev server

```bash
npm run build      # esbuild (main/preload) + vite (renderer)
npm start          # electron .
```

### End-to-end tests

With the app running and `--remote-debugging-port=9222`:

```bash
npm run test:e2e    # drives a real agent prompt through the UI (CDP)
node scripts/edge-test.mjs   # edge cases: run-scoped summaries, deletions,
                             # new-session clearing, new-subdir paths, links
```

## Project layout

```
electron/
  main.ts          Electron main: pi child process, watcher, modified tracking, IPC
  preload.ts       contextBridge → window.pi (typed API)
  rpc-client.ts    JSONL RPC client for pi --mode rpc (commands + event stream)
  watcher.ts       recursive fs.watch → live file changes
src/
  main.ts          renderer entry: wires Monaco + xterm + panels to the bridge
  editor.ts        Monaco editor + tabs + live content sync
  terminal.ts      xterm.js session renderer (tool cards, link provider)
  components/      toolbar/statusbar/modified-list, extension-UI modals
shared/types.ts    types shared across main/preload/renderer
```

## Roadmap ideas

- [ ] Editable mode with proper agent/user conflict handling
- [ ] Real shell pty (node-pty) next to the agent session
- [ ] Diff view of agent changes (pi's edit tool already returns `details.diff`/`patch`)
- [ ] Session persistence UI (resume/switch sessions per project)
- [ ] Packaged app (electron-builder) with pi bundled
- [ ] File explorer pane

## Notes

- pi's tool args may be relative or absolute; paths are canonicalized (realpath of the parent dir) so `/tmp` vs `/private/tmp` never breaks file matching.
- The modified-list status (`A`/`M`) comes from the file watcher, which pre-seeds existing files at startup — so edits to existing files read as `M` and brand-new files as `A`.
- The terminal uses the canvas renderer (`@xterm/addon-canvas`) with a render watchdog: the built-in DOM renderer can silently stall under heavy write bursts, and the watchdog force-refreshes if no frame lands within 1.5s.
