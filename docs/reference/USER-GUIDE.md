# Termina User Guide

> **Status:** current product reference. Advisory. This guide describes
> the product. It does not govern implementation or CI.

Termina is mission control for your coding agent: watch every edit live,
verify in one click, fork any moment, and merge only the winner — your Git
repo stays untouched.

The left side runs Termina's in-house coding agent, in a terminal. The
right side is a Monaco (VS Code) editor that watches the agent work live.

Everything runs locally. The terminal stays the source of truth: Termina
records byte-exact source states in an app-owned snapshot store and never
writes your Git repository.

```
┌──────────────────────────────┬───────────────────────────────┐
│ agent TUI (real terminal, pty) │  Monaco IDE + file explorer   │
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
bundle ships everything: the app, the Rust snapshot core, the in-house
agent, and its own node runtime. Nothing else to install.

Packaged builds check GitHub Releases for updates and install them when you
quit the app.

### First launch

A fresh install starts empty:

1. Click **Open folder** (or press `Cmd/Ctrl+O`) and pick a project folder.
2. In the terminal, run `/login` to configure your model provider.
3. Run `/models` to pick the default model.

The empty editor tells you about `/login` and `/models` when the agent has
no provider configured yet.

Opening a folder adds it to the project rail and starts one agent terminal in
it. Your open projects restore on the next launch — including each terminal's
plan board and last verify verdict. Dispatched worker assignments never
survive a restart; their tasks return to pending.

### Project rail

The persistent left rail lists your folders, each with its own explorer,
editor, terminals, timeline, and worldlines. Switching projects never interrupts
a running agent. Reopening an existing folder reactivates it instead of
creating a duplicate. Folder paths distinguish projects with the same name.

Each project shows separate counts for recorded working agents and unresolved
attention items. These counts come from current work facts, not unseen
notifications; an idle agent is not proof of completion. A failure or outdated
check still counts after inspection. If facts cannot be loaded, the counts say
**unknown** rather than implying there is no work or attention.

Use `Tab` to reach a project button, `↑`/`↓` or `Home`/`End` to browse, and
`Enter` or `Space` to activate. The rail always opens that project's real
workspace. When a live agent has a recorded pending permission, project entry
focuses the one waiting longest; otherwise it returns to the last-used terminal
that is still available, or another available terminal if that session closed.
Explicitly selecting a terminal always opens that exact terminal.
Background notifications never change your project, terminal, or keyboard focus.
If no terminal is available, the workspace offers agent and shell creation;
selecting the project does not create a session.

Drag vertically or use `Alt+↑`/`↓` to reorder projects; the order uses the existing
project preferences. The persistent **Attention** section above **Projects**
shows recorded issues across projects without interrupting background work.

Settling or blocking still plays a short chime and a named toast
(`pi-editor is idle`, or `pi-editor · dispatch needs you` when that project
has more than one agent) unless that terminal already has keyboard focus
in the project you are looking at. Click the toast to jump to that project
and terminal.

---

## 2. The layout

| Area | What lives there |
|---|---|
| Project rail | Direct workspace navigation, factual work/attention counts, Attention, and `＋` to open another folder |
| Explorer | File tree beside the rail, collapsible with `Cmd/Ctrl+B` |
| Terminal pane | Terminal tabs and on-demand Checks, Timeline, Plan Board, Worldlines, and Modified files tools |
| Editor pane | Editor tabs, the Monaco editor, and Change Review |
| Status bar | Current folder, the Verify button, and the Git handoff buttons |

Panes resize by dragging the dividers. Each pane minimizes with its `–`
button:

- `Cmd/Ctrl+B` toggles the explorer.
- `Cmd/Ctrl+Shift+E` toggles the terminal.
- `Cmd/Ctrl+E` toggles the editor.
- `Cmd/Ctrl+Shift+F` makes the terminal fullscreen (the work area shows only the terminal; project navigation remains visible).

Terminal and editor cannot both be minimized. The editor stays minimized
while no file or review is open.

The compact strip below the terminal opens tools on demand: **Checks**,
**Timeline**, **Plan**, **Worldlines**, and **Modified**. Panels start closed,
even when a preferred tab was saved. New content updates count badges without
opening or switching tools.

`Tab` enters the strip as a single stop. `Enter` or `Space` opens its tool;
`←`/`→` (`Home`/`End` for the ends) select and open another. **Close** or
`Escape` within a tool closes the panel, retains its content, and returns
focus to its tab. `Escape` in the terminal remains terminal input.

---

## 3. Working with the agent

### Terminals

Click `＋` (**New agent**) next to the terminal tabs, or press `Cmd/Ctrl+T`,
to create an agent directly in the current project. The new agent reuses the
active agent's model when available; isolated sessions also inherit its effort.
Main retains the existing admission policy: when a live terminal overlaps the
project source, another agent opens in a
separate sandboxed work area. Creation does not submit a prompt or apply changes.

Use the adjacent `▾` (**Open shell menu**) to choose a detected shell
(`zsh`, `bash`, …). The menu supports arrow keys, Home/End and Enter;
Escape cancels and returns focus to its button. Shell tabs show the shell name
as a badge. A refused creation shows the actual error and permits an explicit
retry; it never falls back to a shell or shared-source agent.

Opening a folder starts one **Agent (core)** tab. Agent terminal tabs carry
idle / working / blocked status dots; the project rail shows separate factual
work and attention counts.

Cycle without the mouse: `Ctrl+Tab` / `Ctrl+Shift+Tab` move between terminal
tabs, `Cmd/Ctrl+Shift+[` / `]` move between projects, and scrolling over a
terminal tab strip cycles its tabs. The project rail scrolls vertically without
changing the selected project.

### Talking to the agent

A core tab is a full-screen TUI: `/login`, `/models`, `/clear`, `/compact`,
`/resume`, `/effort`, `/skills`. Every turn starts with a bounded project snapshot (top)
of the tree first), so the agent is oriented without spending tool calls on
discovery — file tools always see live state.

Type `@` to pick a project file; keep typing to filter.
Tab completes, Enter inserts the path, Enter again submits. Esc closes the
picker and keeps what you typed. Ctrl+R searches prompt history. Drag to
select transcript text; Cmd/Ctrl+C copies. Reasoning starts at medium;
`/effort` shows the levels available for the current model, and your last
choice sticks: new tabs reopen on it (clamped to what each model supports). Type `/skills`
to pick a discovered skill (`~/.agents/skills`, then `.agents/skills` in the project);
selecting one starts a turn that reads that skill and follows it. Ctrl+J inserts
a newline; Enter submits. Paste keeps newlines. `/help` lists keys.
Paste a screenshot (Cmd/Ctrl+V) to attach it to the next prompt — up to
four images, about 4 MB each. The composer keeps that count above whatever
you have already typed, and the status line shows it too.
Drop files anywhere on the terminal: onto a tab for that terminal, anywhere
else for the active one. Dropped images attach like pasted screenshots, and a
non-image project file inserts `@path` in the composer. Files outside the
project, or names the composer cannot tag
(spaces, `@`), paste as a quoted path. Extra images past that cap paste as
paths too.

Multi-line input:

- `Shift+Enter`, `Ctrl+Enter`, or `Cmd+Enter` (macOS) inserts a newline.
- `Option+Enter` (macOS) queues a follow-up message while the agent runs.

`Cmd/Ctrl+.` sends Ctrl+C to the selected terminal. `Cmd/Ctrl+Shift+W`
closes that terminal. When work may be affected, these commands ask for
confirmation naming the terminal, project, and current task. Shell command
activity is not inferred from output: closing or natively interrupting a live
shell always asks. Direct Ctrl+C in the terminal and the emergency-stop chord remain immediate.

**Interrupt is not close.** Ctrl+C targets the selected terminal's foreground
work. It does not directly stop background child runs, separate dispatch workers,
or a separate verification command. If the owner exits, its background child
runs are terminated.

**Close is not detach.** Closing ends that terminal session, stops its background
child runs, cancels its verification command, and removes its terminal-local
Change Review state. Other terminal tabs, including separate dispatch workers,
remain open. Running commands are interrupted or terminated; separately detached
processes are not guaranteed to stop. Files already written are not reverted.
Cancel leaves the terminal pane and work intact. If the target or affected work
changes during confirmation, the close is rejected; review it and close again.

Closing a project applies this warning to that project's terminals and candidate
work, while other projects keep running. Quitting or restarting for an update
applies it to all projects. Unsaved editor buffers have their separate
Save / Discard / Cancel gate; a later cancellation does not delete their recovery
copies. On macOS, closing the window is not quitting the app.

### MCP servers (core)

A core tab can call MCP tools listed in the user-owned
`~/.termina/agent/mcp.json`. Project files cannot start MCP processes.

Use the Claude/Cursor `mcpServers` shape with `command`, `args`, and
`env` for local servers, or a `url` with `type: "http"` / `"sse"`
(https only) for remote Streamable HTTP and SSE servers. The kernel
starts those processes when the tab starts and keeps the tool list
frozen until `/clear` or a new tab. MCP is a program you installed. It
is not limited to the project jail.

---

## 4. Watching work live

While the agent works:

- The file watcher pushes every disk change into open editor models. You see
  edits land as the agent writes them.
- Files the agent touches auto-open in a replaceable preview tab mid-run, so
  you can follow along without hunting for paths — a long run never pins a
  tab per file. Edit, double-click, or Keep Open to pin one. Turn this off
  in Settings → General → **Open files the agent edits**.
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
   - **Accept** — mark the change as reviewed (`✓` mark in the list, with the
     review time). The mark drops if the file changes again — it reviewed the
     bytes the file no longer has.
   - **Revert** — restore the pre-run version (`↩` mark in the list).
   - **Open file** — leave the diff and edit the file as a normal tab.
3. Use **Accept all** in the panel header to accept every change at once, or
   **Clear** to forget review state. Clear only hides the list — files stay
   changed on disk, and their review marks are dropped.

`Esc` and the `←` button both leave the diff and return to the editor. `Esc`
stays with the terminal while keyboard focus is in it.

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

A failure on a background terminal tab dots that tab red (amber for timeout)
until you look at it, so an idle terminal's verdict never sits unseen. The
project rail and global attention also show the recorded issue, including for
background projects. Opening a terminal clears only its unseen notification;
it does not clear the failure or its factual attention count.

### Attention across all projects

**Attention** is a non-interactive level-two heading above **Projects** in the
project rail, not a button. Its rows remain visible for every open project while
another project is selected. The heading shows the total current item count,
not just the loaded page; canonical updates refresh that count, and a read
failure makes it **unknown** rather than zero. Choose **View → Attention across
all projects** or press `Cmd/Ctrl+Alt+A` to focus this persistent section.
Starting work opens the terminal/editor directly. There is no Attention
popover to open or close and no dedicated close button.

Items identify their exact project path, task assignment when one is recorded,
agent/model, work area, and reason. Blockers and unavailable workers appear
before failed/incomplete/interrupted attempts, followed by check issues and
**Result pending review**. A separate candidate tree is labelled separately from
shared project files; it is not automatically a sandbox.

**Result pending review** means a task has a recorded completed attempt, not
that an idle agent, a checked task box, or a passing check proves acceptance.
Independent results additionally require an available captured candidate; the
item names that result's root and version, not the source owner's checks.
Inspection does not record human acceptance. A candidate that is explicitly
promoted or discarded leaves this queue; a new attempt replaces its previous
result. Shared-file results are historical completion records and do not claim
that those files remain unapplied. Recording persistent human acceptance is not
yet supported.

In **Attention**, **Inspect terminal**, **Inspect plan**, and **Inspect check**
navigate directly to the exact current owner through main. **Inspect plan**
reveals the owner's Plan Board and **Inspect check** reveals its Checks tool.
A check without a single recorded task opens its terminal's Checks; it is not
attributed to the first task on that Plan Board. Stale, closed, or superseded
targets are rejected rather than opening a different project or terminal.
Inspection never runs or cancels checks, retries a task, accepts changes, or
resolves the item. Historical passing output remains
**Outdated** when it no longer applies to current files.

The section initially shows up to 50 items; **Show more** reveals the next page.
**Refresh** loads current facts. A loading failure is explicit, the count becomes
**unknown**, and retained rows are marked potentially outdated, not replaced
with a false empty-success state.

### Jump to work

Open the **Command palette** with `Cmd/Ctrl+K` to find an open project or an
existing Plan Board task, as well as run commands. Search by project name,
full path, or task text. Words are matched without case sensitivity; results
include the project path and Plan Board owner to distinguish repeated names.
Use `↑` / `↓`, `Home` / `End`, and `Enter`, or click a result. `Escape` cancels
and restores focus to the opener.

A project result activates that project's existing workspace. A task result
opens its exact owner's **Plan Board** in the real workspace and focuses the
existing task row. It does not start the task or automatically open its worker.
Use the existing Plan Board controls for dispatch, retry, or worker navigation.
Previous projects retain their editor buffers and background work when you
switch back.

Navigation never creates tasks or terminals, dispatches or retries work,
answers permissions, or marks anything reviewed. Targets are checked again
before opening. If the project, owner, assigned source, or task changed or
closed, search again to choose its current context. The palette shows at most
50 matching project/task results and asks you to refine broader searches;
commands remain usable if project/task data is unavailable.

### Factual work context

Use the project rail and terminal tabs to select the real workspace, then open
its **Plan**, **Checks**, **Worldlines**, or **Modified** tool as needed. The
persistent **Attention** section identifies recorded issues and their assigned
work areas across projects. Shared project files and a separate candidate tree are labelled
differently; a separate tree alone is not a claim of filesystem sandboxing.

An idle terminal is not proof of task completion. An incomplete, failed, or
interrupted dispatch remains visible on its owner's Plan Board after its worker
closes. Inspection and navigation never retry work automatically; retry remains
an explicit Plan Board action.

Open **Checks** below the terminal, then **Check details**, for the exact
recorded command, tested source, timing, exit outcome, and retained bounded
output. If source validity is lost, the check says **Outdated** even when the
historical execution passed. Loaded reports are invalidated when their terminal,
workspace, generation, or exact evidence changes. Inspecting a report does not
run or cancel tests. The **Modified** tool opens the existing Change Review
controls; its cumulative tracked paths are not proof of a clean tree or
completed human review.

TypeScript projects get background typechecks: after your run settles,
`tsc --noEmit` refreshes silently into the agent's next-turn context when the
tree moved since the last clean run, at most once a minute per workspace.
Other stacks stay manual for now.

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
- **Keyboard**: `Tab` enters the strip once (not once per dot), `←`/`→` move
  the selection a moment at a time, `Home`/`End` go to the oldest and newest
  moment, `Enter` opens the selected moment, and `Cmd/Ctrl+Enter` forks a
  candidate from it. `Esc` stops a running replay.

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

When the agent plans multi-step work — type **`/plan`** or **`/plan <request>`**
in the terminal — the Plan Board (below the timeline) shows the task list
with live progress: `○` pending, `◐` active, `✓` done. Ordinary replies do
not fill the board. A `/plan` turn publishes its reply; if that reply only
asks what to plan, later replies keep publishing until one contains the
list. The list stays until the next `/plan` or `/clear`.

A `/plan` request can read files, search, fetch a URL, and discover available
MCP tools. It cannot edit files, run shell commands, call MCP tools, or spawn
or redirect a worker. Producing a task list
does not unlock those tools during that request. Send an ordinary message
such as “implement this plan” to allow implementation; this works even if a
plan list is still owed. A new ordinary message can also steer an active
planning run at its next safe boundary. `/clear` (or `/new`) resets both the
planning restriction and pending plan publication. This restriction applies
to the agent's tools, not manual editor changes or clicking Dispatch.

### Dispatching tasks

- **Click any pending task** to send it to a parallel worker — a separate
  agent that works on the same project simultaneously. The row updates with
  the worker; failures toast.
- **Pick a worker model** on the row chip. The default is **Inherit** (this
  tab's current `/model`). Recent models and other live agent tabs are
  listed too. A task may also name `@model provider/id`; Inherit still wins
  if you choose it.
- **Schedule a task** with a trailing `@every 30m` / `@every 2h` / `@at 09:30`
  marker: while its terminal stays open and idle, Termina dispatches it to a
  worker on cadence through the same briefing, settle-note, and auto-verify
  loop. Intervals below 5 minutes are ignored. Scheduled workers inherit
  this tab's model unless the task has `@model`.
- **⇉ Dispatch** sends the plan's tasks out, each with its row's model.

Dispatched tasks show their worker and claimed files on the board. Clicking a
dispatched task jumps to that worker's terminal (tabs are named `dispatch`).
Workers receive a mailbox briefing with their task, and settle notes flow back
to siblings so they stay aware of each other's results. When a worker settles
with its task done, the owner is idle, and no sibling worker is still running,
Termina automatically runs Verify once (when the project has a detectable test
command) and reports the verdict to your next turn — cancellable like any
verify run. A failing verify — manual or automatic — re-runs automatically
when your next run settles, up to 3 consecutive failed attempts; then it stops
and asks for attention instead of burning more test runs. Timed-out suites never
auto-retry: a hang would just burn three 10-minute runs.

---

## 9. Worldlines: fork, compare, promote

Worldlines answer one question: *what if the agent had done it differently?*
A completed run can be forked into isolated candidates — full copies of the
project with their own agent sessions — that run side by side with the original.

Requirements: the project must be inside a Git repository, on macOS with
the candidate sandbox helpers available (`sandbox-exec`, `taskpolicy`).
Candidates are not supported on other platforms yet. Otherwise the
feature disables itself with a precise reason.

### Fork Run

When a terminal's last run completes, a **⇉ Fork Run** button appears above
the timeline. It forks the run into two candidates:

- **Candidate A — Reference**: the run's final result, preserved exactly.
- **Candidate B — Alternative**: the project at the run's start, with the
  original prompt loaded. Text prompts arrive editable, so you can change the
  instructions and get a different implementation of the same task.

Both candidates open as real agent terminals (badged `A` and `B`). They are
filesystem-isolated: their own source trees, sessions, homes, and process
groups, with writes denied outside their own tree. Live candidates keep
network access (the model provider must stay reachable); only candidate
Verify and evidence workers run fully offline.

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
| **Export** | Writes a patch bundle (`candidate.patch`, `pr-body.md`, `metadata.json`) with the evidence summary — ready for `git apply` or a PR. |
| **Discard** | Removes both candidates and every app-owned resource. |

Promotion merges source changes only — never commits, branches, or staging
state. It refuses on conflicts before touching anything, journals every step
so a crash recovers cleanly, and opens the merged result in Change Review plus
a fresh terminal continuing the candidate's conversation.

Candidates are temporary. The project-close or quit warning includes candidates
with source changes or session activity. Confirmed closes discard their normal
work areas; recovery files may be retained when cleanup cannot safely finish.
Export anything you need before closing.

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
Rename (`F2`), Delete, and Refresh. The **Filter files** box narrows the tree
as you type; click × or press `Escape` to clear.

### Editor

- Preview tabs: single-click opens a replaceable preview; editing the file or
  double-clicking the tab pins it. Middle-click closes; drag reorders; tab
  context menus offer close and pin actions.
- Unsaved edits show a dot on the tab; **Save** is `Cmd/Ctrl+S`, **Save all** is `Cmd/Ctrl+Alt+S`.
- Word wrap and minimap follow your Settings preferences.

### Unsaved draft recovery

Termina writes asynchronous recovery copies of editable text to its private
application-data directory, not to your project files. Hover the unsaved dot
to see whether the latest copy is saved, pending, or unavailable. A failed
copy also shows a warning; do not rely on recovery while that warning persists.

After a renderer reload or application restart, opening the owning project
restores its available drafts as pinned, **unsaved** tabs. Candidate drafts
can be recovered only while their original candidate workspace still exists;
recovery does not recreate a discarded candidate. Recovered text is marked
for review against the current file. If the file was deleted, saving requires
the explicit restore confirmation. Recovery never applies text automatically.

Recovery retains the last confirmed copy, not edits still pending when the
process dies. It does not restore undo history, selections, or scroll position.
There are at most 64 recovery copies, each limited to 2 MiB of UTF-8 text.
Saving or explicitly discarding a buffer removes its copy; cancelling a close
keeps it. Copies may contain sensitive text and remain in local application
data until saved or discarded.

### File previews

Images open with **− / +**, a zoom percentage, **Fit**, and **100%** controls.
Scroll or drag to move around an enlarged image. Use `Ctrl/Cmd` + scroll or a
trackpad pinch to zoom at the pointer. With the image area focused, `+` / `−`
zoom, `0` restores actual size, and `F` fits the image to the pane. Fit does
not enlarge small images. Pinned image tabs retain their zoom and scroll
position when you switch tabs.

PDFs use the built-in viewer's zoom, fit, rotation, and page-number controls.
They are read-only previews, not editable text.

Code, Markdown, HTML, and other UTF-8 text files open in the text editor;
Markdown and HTML are not rendered. Binary files without a supported preview,
and unsupported text encodings, show an error instead of opening as editable
text. There are no dedicated Office, archive, audio, or video viewers.

### Mine marks

Every editor tab has an `M` marker: click it to mark the file as yours. Mine
marks matter to Worldlines: a candidate that modifies a file marked as yours
is disqualified from automatic challenge ranking, and promotion checks your
current Mine set before merging.

---

## 11. Settings

Open with `Cmd/Ctrl+,` or **Termina → Settings**. It opens on **General**.
Settings has three sections: **General**, **Appearance**, and **Keyboard**.

**General**

| Setting | Options |
|---|---|
| Open files the agent edits | On / off. When on, a file opens as a replaceable preview tab as the agent starts editing it. On by default. |

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
| `Cmd/Ctrl+T` | New agent in the current project |
| `Cmd/Ctrl+Shift+W` | Close terminal |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous terminal tab |
| `Cmd/Ctrl+Shift+[` / `]` | Previous / next project |
| `Cmd/Ctrl+Alt+A` | Attention across all projects |
| `Cmd/Ctrl+.` | Interrupt the active terminal |
| `Cmd/Ctrl+Alt+N` | New file |
| `Cmd/Ctrl+Alt+Shift+N` | New folder |
| `F2` | Rename selected explorer entry |
| `Cmd/Ctrl+S` | Save the active editor file |
| `Cmd/Ctrl+Alt+S` | Save all dirty editors |
| `Cmd/Ctrl+B` | Toggle explorer |
| `Cmd/Ctrl+Shift+E` | Toggle terminal |
| `Cmd/Ctrl+E` | Toggle editor |
| `Cmd/Ctrl+Shift+F` | Terminal fullscreen |
| `Cmd/Ctrl+P` | Quick Open (open a project file by name; in a focused core terminal, Ctrl+P cycles models instead) |
| `Cmd/Ctrl+K` | Command palette |
| `Cmd/Ctrl+Alt+F` | Search file contents |
| `Cmd/Ctrl+Shift+P` | Search sessions |
| `Cmd/Ctrl+,` | Open settings |
| `Shift+Enter` / `Ctrl+Enter` | Newline in the terminal input |
| `Option+Enter` (macOS) | Queue a follow-up while the agent runs |
| `Cmd/Ctrl+Click` / `Cmd/Ctrl+Enter` on a timeline dot | Fork a candidate at that moment |
| `Esc` | Dismiss Change Review, or stop a timeline replay (never while focus is in the terminal) |

### Session Search

`Cmd/Ctrl+Shift+P` opens a full-text search over past agent sessions of the
project. Results list the matching moments; clicking one opens the file it
mentions. Type at least two characters. Closing a core tab keeps that
session on disk. `/clear` in a core tab starts a fresh session and leaves
the previous one searchable.

---

## 13. Privacy and safety model

- **Local first.** Sessions, snapshots, preferences, and events live on your
  machine. The only network traffic is your chosen model provider (and the
  update check in packaged builds).
- **Your Git is read-only to Termina.** Snapshots live in an app-owned store
  outside your repository. Promotion writes files, never Git history.
- **Renderer isolation.** The editor UI never talks to the agent directly; it
  renders state the main process pushes.
- **Clean environments.** Host session variables are stripped before
  the agent starts, so a host session can never attach to a terminal.
- **Primary terminals are unsandboxed.** Your main agent and shell tabs run
  with your normal user access, including network.
- **Candidate sandboxes (macOS only).** Worldline candidates run under
  OS-level profiles that deny writes outside their own tree. Live
  candidates keep network access; candidate Verify and evidence runs
  execute fully offline.
- **External effects are not isolated.** Filesystem isolation does not cover
  remote services: a command inside a sandbox can still affect an allowed
  cloud account or deployed service.

---

## 14. Troubleshooting

**The editor says to run `/login` and `/models`.**
The agent has no provider configured yet. Run `/login` in the terminal, then pick a
model with `/models`.

**Worldlines is unavailable.**
The opened folder must be inside a Git repository, on macOS with the
sandbox helpers available — candidates are not supported on other
platforms yet. Submodules, sparse checkouts, content-transforming Git
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
The paint watchdog reloads it automatically. Terminal views rebuild from
main-owned state and retained events. Unsaved editor text recovers from the
last confirmed draft copy, with the [draft recovery limits](#unsaved-draft-recovery)
above; edits that were still pending can be lost.

**An update is stuck downloading.**
Updates install on quit. If the download stalls, quit and relaunch, then
check again from the menu.
