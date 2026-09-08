# Background Subagents Plan — 2026-09-07

> Status: Phase 1 implemented (registry + tool surface, 2026-09-08); Phases 2–5 pending. Sources: [Anthropic Agent SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents) (verified 2026-09-07), OpenAI Agents SDK manager pattern (docs nav; page bodies are JS shells), Qwen-Agent README (no subagent primitive — verified 2026-09-07). Gemini/xAI/Meta are model APIs with no delegation primitives.

## Goal

Let the agent say "spawn a bunch of subagents" in natural language and get parallel headless runs — no new terminals. One main task only: the parent decomposes it into independent subtasks, children run in the same workspace, results fan back in.

Non-goals for v1: subagents spawning subagents, isolated worktrees, a dedicated runs panel, cross-provider child routing rules beyond model override.

## Architecture

Three layers, each with one owner. No second terminal manager, no second sidecar writer, no second approval path.

### 1. `spawn_subagent` tool (agent-core/main.ts, tool surface)

The parent invokes it like any tool. No slash command; the parent agent is the interface.

```
spawn_subagent(task: string, model?: string, effort?: EffortLevel, budget?: { maxTurns?: number })
  → { runId: string }
```

- `task` is the complete subtask brief: goal, relevant file paths, decisions already made, done-criteria. Children start context-fresh (Anthropic rule); nothing is inherited except what is written here.
- `model` accepts a full `provider/id` ref (`openai-codex/gpt-6-astra`, `xai/grok-4.6`, `opencode-go/muse-spark-1.3-contributor`) resolved through the existing `parseModelRef` + `resolveAuth` path, or a bare id resolved against the parent's provider. Default inherits the parent route. An unauthenticated or unknown provider is a spawn-time error (fail closed, suggest `/login`) — never a silent fallback to another model.
- `effort` accepts any `EffortLevel` and is clamped to the child route with the existing `clampEffortLevel` (a `low` request on a route without `low` lands on the nearest supported level; unsupported routes report `provider-default`). Default is the parent's clamped floor, not its level: cheap lane unless asked.
- The tool returns immediately with a run id (background always). Result delivery is via tool-result injection when the run settles, plus timeline/toast (layer 3). Run records carry provider/model/effort for per-run cost attribution.

`message_subagent(run_id: string, text: string)` pushes parent text into a running child (answers, redirects, cancellation reason). Unknown/finished run ids are errors, not silent drops.

### 2. Headless runs (new owner: `electron/subagents.ts`, engine mode in agent-core)

- The host spawns the agent process with `child_process.spawn` (piped stdio, **never node-pty**) under a `bg-N` id namespace. See why the pty must go: every agent-shaped thing today is a terminal (`createTerminal`, dispatch workers, candidates); a pty per background run reintroduces panes, rosters, and terminal lifecycle for something with no screen.
- agent-core gains a headless run mode: prompt in (argv task file), run to settlement with no TUI, sidecar out, exit. Approvals fail closed with no surface — see §4.
- The existing `SidecarTailer` attaches to `bg-N` exactly like `term-N`. Timeline dots and activity flow unchanged. Settlement (`agent_settled`) resolves the run; the parent gets a tool result, never an API error as a result (Anthropic rule: rate limits and crashes report failure).
- Lifecycle: settle / kill / retry with backoff. Caps (Anthropic rule): max parallel runs (default 4), max spawn depth 1 (children never receive the spawn tool), per-run turn budget with partial-result marking and parent-resumable continuation.

### 3. Results (existing surfaces only)

Timeline dots + toast. No new panel in v1; build one only if concurrent runs get noisy in practice.

## Approvals and messaging (inherits, then routes up)

- The child inherits the parent's `permissionMode` at spawn (Anthropic `permissionMode` rule). No silent escalation, ever.
- Child approval/question events route to the parent: they render as `setChoices` pickers in the parent's TUI — the exact path bash approval uses today. Deny is the default on timeout or when the parent has no surface.
- `message_subagent` is the down-channel. The child's first turn lists its run id and the parent's messaging convention (Anthropic `SendMessage` rule: the child knows who it can talk to).

## Coordination: independent subtasks of one main task

- The parent decomposes; siblings never share a subtask and never run different main tasks.
- **Path-scoped claims** extend the plan board's `claimed` paths: a spawn carrying `paths: [...]` reserves them; a second claim on overlapping paths is rejected at spawn time. This is how write leases survive N writers on one tree without a lease rewrite.
- Siblings communicate only through the parent (no child-to-child messaging in v1). The parent merges; conflicting edits surface as a merge task for the parent, not a child negotiation.

## Security: scan child output before the parent reads it

Adopt Anthropic's output-scanning rule at the host boundary, before results enter the parent context:

- Neutralize control-tag imitation (harness-only tags such as `<system-reminder>`) in place.
- Keep, but flag, permission-configuration mentions (`.claude/settings.json`, `bypassPermissions`, `--dangerously-skip-permissions`, our own `always` approval strings).
- Break fake turn boundaries (leading `Human:`/`Assistant:` lines).
- Never remove or reword legitimate child text; flagging is additive markers only.

A subagent telling its parent to widen permissions must never work.

## Phases

1. **Spawn tool + registry**: `spawn_subagent`/`message_subagent` tool definitions, run registry (ids, state, claims), caps. Tests: validation, unknown-run errors, claim overlap rejection.
2. **Headless run mode**: engine entry, host spawner, sidecar tailing under `bg-N`, settle/kill/retry. Tests: settle delivers a tool result; kill terminates the process group; crash reports failure. Every path (settle/kill/crash/rate-limit/`/clear`) resolves through `settleRun` exactly once; run ids are process-local so a forked session messaging them fails closed with unknown-run.
3. **Approvals + messaging**: permissionMode inheritance, choice-picker routing, timeout-deny, `message_subagent` delivery. Tests: approval round-trip, deny-by-default, scanning markers.
4. **Claims + merge**: path-scoped claims at spawn, conflict rejection, parent merge flow. Tests: overlapping claims rejected; disjoint claims run parallel.
5. **Docs + limits review**: update AGENT-CORE-HARNESS ownership notes; revisit depth-1 and panel-need after real usage.

## Validation questions for every phase

1. Can a child widen its own or the parent's permissions through any channel? (Must be no, with a test.)
2. Does every run — settle, kill, crash, rate limit — resolve to exactly one parent-visible outcome?
3. Do two siblings ever write the same path? (Must be no, with a test.)
4. Does the parent context receive only final child results, never intermediate tool streams?
5. Do live-provider probes (where credentials exist) show the same spawn/settle/message contract across at least two providers?
