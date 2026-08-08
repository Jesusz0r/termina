# pi-editor — Breakthrough Feature Vision

> **Status:** brainstorm / roadmap · **Scope:** beyond the current terminal+IDE baseline

## The core insight

Today the app *shows* you what the agent did — prompt, watch, read files.
The missing muscle is a closed working loop:

```
Review  →  Verify  →  Iterate
```

The breakthrough is turning the hybrid from a **viewing tool** into a
**driving tool**: a cockpit where you and the agent converge on green,
working code together.

---

## The feature menu

### 1. Change Review — *the big one* ✅ implemented

The modified-files list becomes a real review surface (click a file → Monaco
diff of the pre-run baseline vs current; Revert restores the original or
deletes created files; Accept marks it reviewed; ↩/✓ markers in the list).

| Capability | Detail |
|---|---|
| Per-file diff | Side-by-side view of exactly what changed this run. Source: the session JSONL already carries old/new text for `edit` tool calls; `write` calls are creations; bash-driven changes diff against a pre-run snapshot |
| Accept / Revert per file | Revert restores the pre-run snapshot (the watcher can keep one per run) |
| Accept all | Turns the list into "approved changes", ready for a commit |
| Review state | Files show A/M/R (added / modified / reverted) with the terminal summary acting as the run narrative |

**Why it matters:** this is the single most missing piece in the agent
workflow — *what did you change, and do I want it?*

### 2. Verify & Iterate — *the loop closer* ✅ implemented

| Capability | Detail |
|---|---|
| Test detection | Reads `package.json` scripts (prefer `test`, then first `test:*`), pytest (pytest.ini / `[tool.pytest` in pyproject.toml), `cargo test`, `go test ./...` |
| One-click verify | `✓ Verify` in the status bar spawns a labeled worker shell terminal, runs the tests, captures pass/fail + output live |
| Auto-feedback | The result (status + tail of output) is written to a context file the bridge extension injects on the agent's next turn via `before_agent_start` → the agent fixes failures itself (verified in the session record) |
| Loop state | Badge on the status bar: running / ✗ failing / ✓ green / ⏰ timed out (10 min watchdog); clicking it jumps to the worker terminal |

### 3. Session Timeline ("time machine") ✅ implemented

| Capability | Detail |
|---|---|
| Scrubbable timeline | A strip under the terminal: every agent action is a colored dot (green = run start, blue = write, amber = edit, purple = disk change, gray = settled) with tooltips |
| Jump to any moment | Clicking a dot opens the file as it looked at that moment in a read-only snapshot tab (snapshots come from the tool's edit regions, or the watcher cache for writes/bash changes) |
| Replay | ▶ steps through the run every 650ms, opening each snapshot — watch the code evolve like a movie |

### 4. Plan Board ✅ implemented

| Capability | Detail |
|---|---|
| Plan → checklist | The bridge extension captures the first assistant message of a run that contains a task list (bullet or numbered lines; text parts of the message content) and logs it to the sidecar. Main parses the lines into tasks (max 20) and extracts the file paths they mention |
| Live progress | Tool events mark tasks "active" when they touch a mentioned path; when the run settles, a task is "done" if every path it mentions was touched (○ pending / ◐ active / ✓ done) |
| Click to jump | Clicking a task opens its first mentioned file in the editor (preview) |

### 5. Your edits reach the agent ✅ implemented

| Capability | Detail |
|---|---|
| Edit → context | A file change with no busy agent terminal belongs to the user. Main records it (first prev + latest content) and writes an `edits-<id>.md` context file with before/after snippets (30 lines / 4 KB caps, 50 files max) |
| Bridge injection | `before_agent_start` merges the edits file with the verify file into one injected session message (display: false) |
| Run consumption | The run clears the context at `agent_start`, so the next run never sees stale edits. Mid-run user changes stay out (busy gate + duplicate-fs-event dedupe) |
| Ownership | Not implemented — "mark files as mine" remains a possible follow-up (the roadmap lists it as "or as context") |

### 6. Dispatch (parallel agents)

| Capability | Detail |
|---|---|
| Split the work | One prompt → independent sub-tasks distributed across idle terminals |
| Reuse infra | Multi-terminal + busy state already exist; each worker is its own pi session |
| Collect | All modified files land in one Change Review |
| Risk guard | Sub-tasks scoped to separate areas / checked for overlap before dispatch |

**Why it matters:** turns N idle terminals into an N-worker swarm.

### 7. Session Search ✅ implemented

| Capability | Detail |
|---|---|
| Full-text | Search over the project's past session files (`~/.pi/agent/sessions/<sanitized project>/`), newest 50 sessions, case-insensitive, bounded (2 MB/file, 50 hits, 400 chars/line) |
| Context | Each hit shows its session time plus the matching line with one line of context before/after |
| Jump | The first token that resolves to a file inside the project becomes the hit's target; clicking opens it in the editor |

Triggered by View → Search Sessions (Cmd+Shift+F): a modal with a debounced input and a clickable result list.

---

## Recommended build order

1. **Change Review** (diff + accept/revert) — the foundation
2. **Verify & Iterate** — closes the loop; together 1+2 form the
   *review-and-iterate cockpit* breakthrough
3. **Session Timeline** — the wow feature
4. Plan Board, edits-to-agent, Dispatch, Session Search — the long tail

## Feasibility notes

| Idea | Data source (already available) | Effort |
|---|---|---|
| Change Review | session JSONL (old/new text), watcher snapshots | Medium |
| Verify & Iterate | shell terminals (pty infra), bridge extension context file | Medium |
| Session Timeline | session JSONL events + per-write snapshots | Medium-High |
| Plan Board | conversation text + tool events | Medium |
| Edits to agent | watcher + bridge extension | Low |
| Dispatch | multi-terminal + busy state | Medium-High |
| Session Search | session JSONL | Low |

## Principles

- **Everything is local.** No cloud, no telemetry — the agent data lives in
  the project's session files; features consume it locally.
- **The terminal stays the source of truth.** These features read and
  enhance the pi session, they never replace the TUI.
- **Review before merge, verify before done.** The loop is the product.
