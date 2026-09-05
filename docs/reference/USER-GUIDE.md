# Termina User Guide

> **Status:** current product reference.

Termina is a hybrid coding cockpit. The left side runs **pi**, the real
interactive coding agent, in a terminal. The right side is a Monaco (VS Code)
editor that watches the agent work live. You review what changed, verify it,
fork runs into isolated candidates, and promote the winner.

Everything runs locally. The terminal stays the source of truth: Termina
records byte-exact source states in an app-owned snapshot store and never
writes your Git repository.

```
┌──────────────────────────────┬───────────────────────────────┐
│ pi TUI (real terminal, pty)  │  Monaco IDE + file explorer   │
├──────────────────────────────┴───────────────────────────────┤
│ terminal tabs · status bar                                   │
└──────────────────────────────────────────────────────────────┘
```

---

## Contents

1. [Getting started](#1-getting-started)
2. [The layout](#2-the-layout)
3. [Working with the agent](#3-working-with-the-agent)
4. [Watching work live](#4-watching-work-live)
5. [Change Review](#5-change-review)
6. [Verify & Iterate](#6-verify--iterate)
7. [Session Timeline](#7-session-timeline)
8. [Plan Board and Dispatch](#8-plan-board-and-dispatch)
9. [Worldlines: fork, compare, promote](#9-worldlines-fork-compare-promote)
10. [Explorer, editor, and Mine marks](#10-explorer-editor-and-mine-marks)
11. [Settings](#11-settings)
12. [Keyboard shortcuts](#12-keyboard-shortcuts)
13. [Privacy and safety model](#13-privacy-and-safety-model)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Getting started

### Install

Download the signed `.dmg` (macOS Apple Silicon) or `.AppImage` (Linux x64)
from the [releases page](https://github.com/Jesusz0r/termina/releases). The
bundle ships everything: the app, the Rust snapshot core, the pinned pi
package, and its own node runtime. Nothing else to install.

Packaged builds check GitHub Releases for updates and install them when you
quit the app.

### First launch

A fresh install starts empty:

1. Click **Open folder** (or press `Cmd/Ctrl+O`) and pick a project folder.
2. In the terminal, run `/login` to configure your model provider.
3. Run `/models` to pick the default model.

The empty editor tells you about `/login` and `/models` when pi has no
provider configured yet.

Opening a folder creates one project tab and starts one pi agent terminal in
it. Your open project tabs restore on the next launch.

### Project tabs

Each tab is one folder with its own explorer, editor, terminals, timeline,
and worldlines. Switching tabs never interrupts a running agent — every
project keeps working in the background. Reopening a folder that already has
a tab reactivates that tab instead of duplicating it.

---

## 2. The layout

| Area | What lives there |
|---|---|
| Project bar | Project tabs and `＋` to open another folder |
| Explorer | File tree (far left, collapsible with `Cmd/Ctrl+B`) |
| Terminal pane | Terminal tabs, the Session Timeline strip, the Plan Board, the Worldlines panel, and the Modified files panel |
| Editor pane | Editor tabs, the Monaco editor, and Change Review |
| Status bar | Current folder, the Verify button, and the Git handoff buttons |

Panes resize by dragging the dividers. Each pane minimizes with its `–`
button:

- `Cmd/Ctrl+B` toggles the explorer.
- `Cmd/Ctrl+Shift+E` toggles the terminal.
- `Cmd/Ctrl+E` toggles the editor.
- `Cmd/Ctrl+Shift+F` makes the terminal fullscreen (only the terminal shows).

Terminal and editor cannot both be minimized. The editor stays minimized
while no file or review is open.

---

## 3. Working with the agent

### Terminals

Click `＋` next to the terminal tabs to open the terminal chooser:

- **Agent (core)** — Termina's in-house coding agent (the default for a new folder).
- **Agent (pi)** — a pi TUI session in your project.
- **Shells** — any shell detected on your system (`zsh`, `bash`, …).

Shell tabs show the shell name as a badge. `Cmd/Ctrl+T` opens the chooser.
Opening a folder starts one **Agent (core)** tab. Existing Pi tabs restore as Pi.

Cycle without the mouse: `Ctrl+Tab` / `Ctrl+Shift+Tab` move between terminal
tabs, `Cmd/Ctrl+Shift+[` / `]` move between project tabs, and scrolling over a
tab strip cycles its tabs.

### Talking to the agent

A core tab is a full-screen TUI: `/login`, `/models`, `/clear`, `/compact`,
`/resume`, `/effort`. Type `@` to pick a project file; keep typing to filter.
Tab completes, Enter inserts the path, Enter again submits. Esc closes the
picker and keeps what you typed. Ctrl+R searches prompt history. Drag to
select transcript text; Cmd/Ctrl+C copies. Reasoning starts at medium;
`/effort` shows the levels available for the current model. Ctrl+J inserts
a newline; Enter submits. Paste keeps newlines. `/help` lists keys.
Paste a screenshot (Cmd/Ctrl+V) to attach it to the next prompt — up to
four images, about 4 MB each. The status line shows how many are waiting.
Pi tabs still run the pi TUI with its own commands. Text paste is
unchanged there; a PNG cannot go through the terminal.

Multi-line input in a Pi tab:

- `Shift+Enter`, `Ctrl+Enter`, or `Cmd+Enter` (macOS) inserts a newline.
- `Option+Enter` (macOS) queues a follow-up message while the agent runs.

`Cmd/Ctrl+.` sends an interrupt to the active terminal. `Cmd/Ctrl+Shift+W`
closes it.

### MCP servers (core)

A core tab can call MCP tools listed in the user-owned
`~/.termina/agent/mcp.json`. Project files cannot start MCP processes.

Use the Claude/Cursor `mcpServers` shape with `command`, `args`, and
`env`. HTTP and SSE servers are ignored. The kernel starts those
processes when the tab starts and keeps the tool list frozen until
`/clear` or a new tab. MCP is a program you installed. It is not limited
to the project jail.

---

## 4. Watching work live

While the agent works:

- The file watcher pushes every disk change into open editor models. You see
  edits land as the agent writes them.
- Files the agent touches auto-open in editor tabs mid-run, so you can follow
  along without hunting for paths.
- The Modified files panel (bottom of the terminal pane) lists every file the
  current run changed, with a badge per file: `A` created, `M` modified,
  `D` deleted.

Files larger than 2 MB cannot be opened in the editor; the terminal stays the
place to inspect them.

---

## 5. Change Review

Every run gets a **baseline**: the content of each file at the moment the run
started. Change Review compares against that baseline, not against Git.

To review a change:

1. Click a file in the Modified files panel. Change Review opens a side-by-side
   diff: baseline on the left, current content on the right.
2. Choose an action:
   - **Accept** — mark the change as kept (`✓` mark in the list).
   - **Revert** — restore the pre-run version (`↩` mark in the list).
   - **Open file** — leave the diff and edit the file as a normal tab.
3. Use **Accept all** in the panel header to accept every change at once, or
   **Clear** to reset the list display.

### Handing off to Git

Termina never writes your Git repository — no staging, no commits, no refs.
After a green Verify or after you Accept changes, the status bar shows two
handoff actions:

- **Copy commit subject** — copies a commit subject derived from the last
  run's prompt.
- **Open shell** — opens a shell in the project so you can commit yourself.

---

## 6. Verify & Iterate

The **Verify** button in the status bar runs your tests in a background
process and feeds the result back to the agent on its next turn. The agent
sees the failure output and can fix it without you relaying anything.

Termina detects the test command automatically from `package.json` scripts,
pytest, cargo, or go. The button's tooltip shows the detected command.

States you will see:

| Badge | Meaning |
|---|---|
| *(none)* | Not tested yet |
| spinner `verifying · …` | Running. Click to cancel. |
| `✓ …` | Passed. The Git handoff buttons appear. |
| `✗ …` | Failed. The summary explains why. |
| `⏰ …` | Timed out. |
| `⏸ …` | Cancelled. |

Candidate terminals (see Worldlines) detect their own test command from their
own copy of the project.

---

## 7. Session Timeline

Below the terminal sits a dot strip: one dot per stable action the agent took,
with a running count. This is the record of what happened, in order.

- **Hover a dot** for the time, the tool, the file, and an on-demand diff of
  what changed at that point.
- **▶ Replay** walks through the run's snapshots step by step.
- **Cmd/Ctrl+Click a forkable dot** to fork a candidate from that exact source
  state — any moment of any run becomes a branch point. See
  [Fork Any Moment](#fork-any-moment).

The recorder label next to the count tells you the recording health:

- *(empty)* — recording normally.
- **indexing** — Termina is indexing the source before moments can fork.
- **paused** — moment forking is paused; no Git recording is happening.
- **degraded** — some moments could not be captured.
- **budget** — the retained-blob budget is full, so old unpinned moments are
  being evicted to make room.

If a dot exists, it is forkable. Termina never shows a dot whose source state
it cannot restore.

---

## 8. Plan Board and Dispatch

When the agent plans multi-step work, the Plan Board (below the timeline)
shows the task list with live progress: `○` pending, `◐` active, `✓` done.

### Dispatching tasks

- **Click any pending task** to send it to a parallel worker — a separate pi
  agent that works on the same project simultaneously. A toast confirms the
  dispatch.
- **⇉ Dispatch** sends the plan's tasks out.

Dispatched tasks show their worker and claimed files on the board. Clicking a
dispatched task jumps to that worker's terminal (tabs are named `dispatch`).
Workers receive a mailbox briefing with their task, and settle notes flow back
to siblings so they stay aware of each other's results.

---

## 9. Worldlines: fork, compare, promote

Worldlines answer one question: *what if the agent had done it differently?*
A completed run can be forked into isolated candidates — full copies of the
project with their own pi sessions — that run side by side with the original.

Requirements: the project must be inside a Git repository, and your platform
must support the candidate sandbox (macOS and Linux x64 do). Otherwise the
feature disables itself with a precise reason.

### Fork Run

When a terminal's last run completes, a **⇉ Fork Run** button appears above
the timeline. It forks the run into two candidates:

- **Candidate A — Reference**: the run's final result, preserved exactly.
- **Candidate B — Alternative**: the project at the run's start, with the
  original prompt loaded. Text prompts arrive editable, so you can change the
  instructions and get a different implementation of the same task.

Both candidates open as real pi terminals (badged `A` and `B`). They are fully
isolated: their own source trees, sessions, homes, and process groups, with
network access denied except the model provider.

The Fork Run button is disabled with the exact reason when a run is not
replayable — for example when you steered mid-run with extra messages, another
writer touched the workspace, or you edited files during the run.

### Fork Any Moment

`Cmd/Ctrl+Click` any forkable timeline dot to fork a candidate from that exact
moment instead of a run boundary. The candidate starts from that source state
with the conversation branched at the matching point.

### Working with candidates

Each comparison gets a card pair in the Worldlines panel:

| Action | What it does |
|---|---|
| **Verify** | Runs the candidate's detected tests inside its sandbox. |
| **Compare** | Diffs the candidate head against the shared base. |
| **A ⇄ B** | Compares the two candidates file by file. |
| **▾** | Details: changed-file statistics, provenance, dependency changes. |
| **Promote** | Three-way merges the candidate back into your project. |
| **Discard** | Removes both candidates and every app-owned resource. |

Promotion merges source changes only — never commits, branches, or staging
state. It refuses on conflicts before touching anything, journals every step
so a crash recovers cleanly, and opens the merged result in Change Review plus
a fresh terminal continuing the candidate's conversation.

Candidates are temporary. Closing the project or quitting asks for
confirmation when candidates hold changes; confirmed closes discard them.

### Challenge Mode

When candidate A has settled, the comparison header offers **Challenge**: it
relaunches candidate B as an automatic challenger that replays the original
task under one fixed constraint:

| Profile | The challenger must… |
|---|---|
| Fewer dependencies | Solve the task adding as few dependencies as possible. |
| Preserve API | Keep the public interface unchanged. |
| Simpler implementation | Produce the smallest direct implementation. |
| Performance-first | Improve measured performance without breaking correctness. |

Ranking never asks a model for opinions. Termina measures deterministic
evidence (tests, dependency counts, API manifests, footprint, benchmark
samples) and labels the result an **evidence winner** — a measurement, not a
claim that one implementation is objectively better. Equal or noisy
measurements report a tie.

---

## 10. Explorer, editor, and Mine marks

### Explorer

Full file tree with VS Code-style interactions: right-click context menu,
New File / New Folder, Cut / Copy / Paste, Copy Path and Copy Relative Path,
Rename (`F2`), Delete, and Refresh.

### Editor

- Preview tabs: single-click opens a replaceable preview; editing the file or
  double-clicking the tab pins it. Middle-click closes; drag reorders; tab
  context menus offer close and pin actions.
- Unsaved edits show a dot on the tab; **Save all** is `Cmd/Ctrl+Alt+S`.
- Word wrap and minimap follow your Settings preferences.

### Mine marks

Every editor tab has an `M` marker: click it to mark the file as yours. Mine
marks matter to Worldlines: a candidate that modifies a file marked as yours
is disqualified from automatic challenge ranking, and promotion checks your
current Mine set before merging.

---

## 11. Settings

Open with `Cmd/Ctrl+,`.

**Appearance**

| Setting | Options |
|---|---|
| Theme | Obsidian (dark), Atom (One Dark), Paper (light), Signal (high contrast) |
| Editor font size | Pixels |
| Terminal font size | Pixels |
| Font family | Curated monospace picker, applies to editor, terminal, and diffs |
| Word wrap | On / off |
| Minimap | On / off |

**Shortcuts** — every command is remappable, including layout toggles and
terminal management. Press Escape while recording to cancel.

Preferences apply immediately and persist across launches.

---

## 12. Keyboard shortcuts

Defaults (all remappable in Settings; most use `Cmd` on macOS, `Ctrl`
elsewhere — `Ctrl+Tab` is literal `Ctrl` on every platform):

| Shortcut | Command |
|---|---|
| `Cmd/Ctrl+O` | Open folder |
| `Cmd/Ctrl+T` | New terminal (chooser: agent or shell) |
| `Cmd/Ctrl+Shift+W` | Close terminal |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous terminal tab |
| `Cmd/Ctrl+Shift+[` / `]` | Previous / next project tab |
| `Cmd/Ctrl+.` | Interrupt the active terminal |
| `Cmd/Ctrl+Alt+N` | New file |
| `Cmd/Ctrl+Alt+Shift+N` | New folder |
| `F2` | Rename selected explorer entry |
| `Cmd/Ctrl+Alt+S` | Save all dirty editors |
| `Cmd/Ctrl+B` | Toggle explorer |
| `Cmd/Ctrl+Shift+E` | Toggle terminal |
| `Cmd/Ctrl+E` | Toggle editor |
| `Cmd/Ctrl+Shift+F` | Terminal fullscreen |
| `Cmd/Ctrl+Shift+P` | Search sessions |
| `Cmd/Ctrl+,` | Open settings |
| `Shift+Enter` / `Ctrl+Enter` | Newline in the terminal input |
| `Option+Enter` (macOS) | Queue a follow-up while the agent runs |
| `Cmd/Ctrl+Click` a timeline dot | Fork a candidate at that moment |

### Session Search

`Cmd/Ctrl+Shift+P` opens a full-text search over past Pi and core sessions
of the project. Results list the matching moments; clicking one opens the
file it mentions. Type at least two characters. Closing a core tab keeps
that session on disk. `/clear` in a core tab starts a fresh session and
leaves the previous one searchable.

---

## 13. Privacy and safety model

- **Local first.** Sessions, snapshots, preferences, and events live on your
  machine. The only network traffic is your chosen model provider (and the
  update check in packaged builds).
- **Your Git is read-only to Termina.** Snapshots live in an app-owned store
  outside your repository. Promotion writes files, never Git history.
- **Renderer isolation.** The editor UI never talks to the agent directly; it
  renders state the main process pushes.
- **Clean environments.** Host `PI_*` session variables are stripped before
  pi starts, so a host session can never attach to a terminal.
- **Candidate sandboxes.** Worldline candidates, Verify, and evidence runs
  execute under OS-level profiles that deny writes outside their own tree and
  deny network except the model provider. Evidence runs are fully offline.
- **External effects are not isolated.** Filesystem isolation does not cover
  remote services: a command inside a sandbox can still affect an allowed
  cloud account or deployed service.

---

## 14. Troubleshooting

**The editor says to run `/login` and `/models`.**
pi has no provider configured yet. Run `/login` in the terminal, then pick a
model with `/models`.

**Worldlines is unavailable.**
The opened folder must be inside a Git repository, and the platform must
support the sandbox. Submodules, sparse checkouts, content-transforming Git
filters, unresolved merge states, or unsupported file types also disable it —
the UI names the specific reason.

**Fork Run is greyed out.**
Hover the button: it states the reason. Most often the run had steering
messages or follow-ups, another writer overlapped the workspace, or the run
was interrupted.

**A timeline dot is missing or marked evicted.**
Recording pauses when the event budget fills, and captures skip themselves
when the filesystem could not settle. The terminal keeps working either way;
only the forkable record is affected.

**Verification says no test command detected.**
Add a `test` script to `package.json`, or use pytest / cargo / go so the
detector finds your suite.

**The window is blank.**
The paint watchdog reloads it automatically. State rebuilds from the recorded
events; nothing is lost.

**An update is stuck downloading.**
Updates install on quit. If the download stalls, quit and relaunch, then
check again from the menu.
