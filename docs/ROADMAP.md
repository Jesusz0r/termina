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

### 3. Session Timeline ("time machine")

The session JSONL is an ordered record of every action.

| Capability | Detail |
|---|---|
| Scrubbable timeline | Every tool call with a timestamp, rendered as a strip beside the terminal |
| Jump to any moment | Snapshots of file contents taken on each write event; clicking a point restores that version in the editor |
| Replay | Step through the run to understand *why* a decision was made |

**Why it matters:** the wow feature — "show me what `src/auth.ts`
looked like mid-refactor".

### 4. Plan Board

| Capability | Detail |
|---|---|
| Plan → checklist | Parse the agent's plan (markdown) and render it as tasks beside the editor |
| Live progress | Tool events map to tasks and tick them off automatically |
| Click to jump | A task links to the file/region it touches |

**Why it matters:** plans stop being prose and become a progress UI.

### 5. Your edits reach the agent

| Capability | Detail |
|---|---|
| Edit → context | When you save a file while the agent is idle, the app writes your diff into a context file |
| Bridge injection | The bridge extension feeds it into the agent's next turn |
| Ownership | Files you mark "mine" are surfaced to the agent as off-limits (or as context) |

**Why it matters:** the agent *knows* you changed `config.ts` and adapts
instead of overwriting it.

### 6. Dispatch (parallel agents)

| Capability | Detail |
|---|---|
| Split the work | One prompt → independent sub-tasks distributed across idle terminals |
| Reuse infra | Multi-terminal + busy state already exist; each worker is its own pi session |
| Collect | All modified files land in one Change Review |
| Risk guard | Sub-tasks scoped to separate areas / checked for overlap before dispatch |

**Why it matters:** turns N idle terminals into an N-worker swarm.

### 7. Session Search

| Capability | Detail |
|---|---|
| Full-text | Search every past session JSONL in the project |
| Context | Results shown with surrounding conversation |
| Jump | Click a hit → open the file it touched |

**Why it matters:** "when did we touch the auth flow?" — the project's
agent memory becomes searchable.

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
