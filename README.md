# Pi-ditor

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
| Bridge extension | auto-installed into `<project>/.pi/extensions/`; streams agent events (tool calls, busy state) to sidecar files |
| Live editor | the file watcher pushes every disk change into open Monaco models; `tool:target` events from the sidecar auto-open files the agent is editing, mid-run |
| Modified-files panel | per-terminal list built from the sidecar tool events + watcher; click to open |
| File explorer | project tree, create/rename/delete (File menu + hover actions), preview tabs (click = preview, edit/double-click = pin) |

## Getting started

```bash
npm install          # includes @lydell/node-pty (native, prebuilt for Electron)
npm run dev
```

Open a folder (`Cmd+O`), click a terminal tab, and run pi as you normally
would — `/commands`, skills, `!bash`, plan mode, everything the TUI has.
The right side follows along: files the agent writes or edits open and
update live.

## Notes

- The bridge extension is written to `.pi/extensions/pi-ditor-bridge.ts`
  when a folder opens — pi picks it up on the next terminal spawn.
- pi owns authentication (`~/.pi/agent/auth.json`); use `/login` inside
  the terminal.
- Editor is always editable; agent writes update open tabs live.
