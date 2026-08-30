# Agent Core — Inner Harness

What belongs in Termina's `agent-core` kernel, what does not, and the next
ACI work that would actually raise coding-agent quality.

Status: living. Principles stay in `docs/AGENT-CORE.md`. The original kernel
change set is `docs/AGENT-CORE-PLAN.md`. This file is the next kernel
track: inner-harness mechanics only.

## Three layers (do not mix)

| Layer | Job | Owner |
|---|---|---|
| **Kernel** (`agent-core`) | Frozen prefix, tools, cache, stubs, traces, the agent loop | This file |
| **Repo harness** | Project `AGENTS.md`, tests, Verify commands, skills | The opened project + Termina host |
| **Outer-loop searcher** | Rewrite harness *source* from scores and traces | Out of the kernel. Never in-process |

Keep the kernel small. A 100-line scaffold with the right primitives can
match a huge agent framework on SWE-bench. Feature count is not the
metric. Interface design is.

## Why the kernel forbids outer-loop searchers

Meta-Harness (and the later hill-climb papers) treat the harness as
searchable code: propose an edit to the engine, run an eval, keep or
revert. That is a **second product**. It does not belong in the process
that is already the user's coding engine.

Concrete reasons, not sequencing:

1. **Product boundary.** The proposer rewrites harness source. `agent-core`
   is the engine the user selected. Combining them makes one process both
   the tool and the thing that mutates the tool.
2. **P1 forbids it.** Zone 1 (system, tools, skill index) is frozen so the
   provider prefix cache stays hot. A loop that edits `agent-core/main.ts`
   mid-session invalidates that prefix from byte zero.
3. **It mutates the engine while the user is coding.** That is not an
   inner-harness upgrade. If cwd is this repo, editing `agent-core/main.ts`
   is ordinary coding. A kernel feature that rewrites itself is a searcher.
4. **The paper's discovered policies are the wrong domain.** Pareto search,
   BM25 math routes, ACE/MCE banks, draft-verify classifiers were found
   for classification and olympiad math. Copying them into zone 1 stuffs
   the wrong procedure. Coding retrieve-don't-stuff is already the skill
   index plus `grep` / `glob` / `read_file`.
5. **Traces are the handoff, not the searcher.** Turn JSON exists so a
   later *offline* searcher can read what happened. The kernel does not
   run that search.
6. **Isolation already exists.** Dispatch workers and worldlines are the
   isolate layer. A kernel `spawn_agent` / self-rewrite loop duplicates
   that and couples it to the prompt cache.
7. **Unconstrained search overfits and often hurts.** Harbor's Codex
   case: extra self-eval / Reflexion / observation compression *dropped*
   Terminal-Bench. LangChain's hill-climb recipe exists because agents
   cheat the evals they can see. A searcher inside the product engine
   would fit whatever happened to be in cwd, then ship that policy
   everywhere.

Allowed later, **outside** the kernel: a worldline, CI job, or separate
repo that reads traces, proposes a patch, runs `npm run test:agent-core`
(and any holdout), and keeps or reverts. That loop must not run inside
`runPrompt()`.

What this kernel *does* take from Meta-Harness: freeze and cache the
prefix, retrieve instead of stuffing, keep stubs and traces recoverable.

## What the kernel already is

Do not rebuild these. They are the inner harness.

| Mechanism | Where | Why it moves scores |
|---|---|---|
| Frozen zone 1 | `buildFrozenSystem` | Prefix cache; same inputs → same bytes |
| Environment snapshot | `formatEnvironment` | Skip 2–4 exploratory `ls` / `uname` turns |
| Skill index, bodies on demand | `scanSkills` + `read_file` | Retrieve, don't stuff |
| Overflow-recoverable `AGENTS.md` | `formatProjectInstructions` / `formatUserInstructions` | Truncation is SELECT-able |
| ACI tools | `read_file`, `write_file`, unique `edit`, `grep` (rg), `glob`, `bash`, `fetch`, provider `web_search` | Fitted surface, not raw bash |
| Cwd jail + allow set | `confinePath` | Reads stay in project (plus frozen skills) |
| Reclaim then summarize | P2 / P3 | Cheap eviction before expensive handoff |
| Executable stubs | `formatStub` / `reproFor` | Lossy bytes, lossless structure |
| File inventories + host working set | `formatWorkingSet` | Append-only user-turn context; verify / edits / mailbox |
| Concurrent tools, stream always | `runPrompt` | P7 |
| Traces | `<terminalId>.traces/turn-N.json` | Diagnostics for a later outer loop |
| Host Verify, Plan Board, worldlines | Electron, not kernel | Isolation and done-criteria stay out of zone 1 |

Identity in zone 1 is short: terse, use tools, work in the project, and
do clear reversible local work in the current turn instead of asking in
chat. Follow an explicit host instruction not to touch a file (Mine,
sibling path claims). Prefer `edit` on existing files, `grep`/`glob`
over bash search, and read before edit. Tool schemas carry the rest of
the procedure. Do not tell the model that every host working-set note is a
non-stop: Mine and dispatch mailbox are stops.

## Ranked next kernel moves

Only ACI and observation quality. No new subsystems. Harbor's lesson:
a small class-specific subset of features is net-positive; stacking
published tricks is negative.

### 1. Numbered file view — implemented

`read_file` prefixes each line with a 1-based number and a pipe. Optional
`start_line` / `end_line` (inclusive). Byte `offset` remains the
truncation hatch; do not combine it with `start_line`. Cap is still
`READ_CAP_BYTES` of file bytes. Truncation drops a trailing incomplete
line when possible so `start_line` continuation does not repeat; a
single line longer than the cap continues with `offset` only. Line
prefixes are a view: they must not appear in `edit` `old_text`.

### 2. Directory read is a listing — implemented

`read_file` on a directory returns a bounded, bytewise-sorted listing
(same ignore / symlink rules as glob). No separate `ls` tool. `glob`
stays the recursive finder.

### 3. `edit` miss diagnostics — implemented

Miss errors include occurrence count and up to three nearby lines. No
fourth write path.

### 4. Structured bash outcomes — implemented

Every bash result ends with `[exit N]` (including 0), after the UTF-8
tail cap and repro marker. No kernel test runner.

### 5. Same-shape write receipts — implemented

`write_file` receipts use the same project-relative path spelling as
`edit`.

### 6. Measure cache-read share before touching caps

Do not lower the 24,576-character project `AGENTS.md` cap, and do not
grow zone 1, until traces show cache-read vs miss on real Agent (core)
sessions. P5 is the gate: dollars above the cache-read rate, attributed.

#### Offline trace report

Use the trace report for real Agent (core) sessions:

```bash
npm run report:agent-core
npm run --silent report:agent-core -- --json
npm run report:agent-core -- /path/to/baseline.traces /path/to/candidate.traces
```

With no path, the report uses
`$TERMINA_EVENTS_DIR/$TERMINA_TERMINAL_ID.traces`. If the terminal ID is
not set, it reports every trace directory in the events directory. The
report includes main and summary turns, status counts, p50 and p95 TTFT and
turn duration, token usage, cached-input share, measured cost, waste by
cause, tool calls, revisions, and frozen-system hash count.

Cached-input share is `cacheRead / (input + cacheRead + cacheWrite)`. A zero
value means that the provider reported no cache reads. It does not prove
that a provider-internal cache was disabled when that provider does not
report cached-token usage.

Each main-turn trace also records provider and protocol plus hashed cache
inputs: cache key, rendered request settings, provider tool schema, stable
prefix, message prefix, and working set. The report prints cache share per
turn and groups it by provider, protocol, working-set change, cache-key
change, settings change, tool change, and stable-prefix change. Hashes expose
request shape changes without storing prompt or tool-schema content in
traces. Diagnostic hashes use a process-local salt, so compare stability
within one run rather than hash values across app launches.

The working set is a hidden context block in the persisted user turn. The
provider receives it as text, but the transcript shows only the user's
prompt. Later tool and assistant messages append after it. The kernel does
not replace context on each model call. This keeps same-turn conversation
history append-only.

When a request reaches 100,000 tokens with less than 50% cache reuse, the
kernel summarizes before the context-window high-water mark. Cache hits do
not trigger this cost-based compaction. The kernel makes one cost-based
attempt per user turn and waits one measured request after a revision. This
prevents repeated compaction misses.

For a controlled cache check, run ten turns in one session in less than five
minutes. Keep provider, model, effort, system prompt, tools, host context,
and working set unchanged. Do not compact or revise history. Use the JSON
report to confirm stable cache-key, settings, tool, and stable-prefix hashes;
then compare per-turn cache share. A changing message-prefix hash is normal
because turns append. A changing stable-prefix hash is not.

Codex receives `prompt_cache_key` and uses `x-codex-turn-state` affinity for
follow-up model calls in one user turn. Codex rejects
`prompt_cache_options` and explicit `prompt_cache_breakpoint`, so the kernel
does not send those fields to `openai-codex`. Affinity improves routing but
does not guarantee a hit; backend misses can remain with stable hashes.

If more than 95% reuse is a hard requirement, repeat the same ten-turn run
through direct OpenAI. Keep the model, prompts, tools, effort, and timing the
same. Write each run to a separate trace directory and pass both directories
to the report command. Compare resolution first, then cache share, input
cost, and time to first token. Do not infer direct OpenAI behavior from a
Codex run.

Trace metrics do not measure task quality. Compare harness changes on the
same fixed tasks, model, effort, environment, and concurrency. Grade each
task with deterministic tests. Run each task at least three times. Reject a
latency or cost improvement if resolution rate decreases. Report resolution
rate first, then cost per successful task, completion time, tokens, cache
share, tool calls, revisions, and waste.

### 7. Tiny frozen tool procedure — implemented

Zone 1 identity includes a short ACI frame: do clear reversible local
work in the current turn instead of asking permission in chat; follow
an explicit host instruction not to touch a file; prefer `edit` on
existing files, `grep`/`glob` over bash search, and read before edit.
Cap it. This is interface framing, not a completion checklist.
Done-criteria stay in the project's `AGENTS.md`. The kernel still has
no file-permission tool; chat was the accidental substitute. Host edit
notes must stay informational (partial working-tree facts), not a stop.
Mine and dispatch mailbox stay do-not-touch rules.

### 8. Real bash approval (host + kernel)

`/permissions` is policy, not a sandbox. A deny-list is bypassable
(`python -c`, `bash -c`). A real gate needs UI and IPC. Do not add
theater in the kernel alone.

## Stay out (still)

- Outer-loop proposer / Pareto search over `agent-core` source
- In-process self-rewrite of the harness
- Plugin / hook / extension loader
- `spawn_agent`, LangGraph, extra roles (P6: routing changes cost, never behavior)
- Kernel completion checklists or "don't stop" state machines
- Kernel test runner, `init.sh`, `progress.md`, `feature_list.json`
- Stuffed skill bodies in zone 1
- A second write/edit tool
- Mid-session environment deltas in zone 1
- Calling `worldline-git` / the snapshot store from the kernel
- Importing another agent engine into `agent-core`
- OpenTelemetry (trace files are enough)

## How to tell a kernel change is worth it

A change belongs here if it:

1. Improves the **interface** the frozen model sees (view, error, receipt), or
2. Protects the **prefix cache** / recoverable stubs / traces,

and it does **not**:

- Add a second owner for SELECT / WRITE / COMPRESS / ISOLATE,
- Encode a benchmark's done-criteria,
- Grow zone 1 without a measured cache miss.

Ship one move at a time. Flag-gate nothing in the kernel: Harbor's
stacked flags were the failure mode. The harness test
(`npm run test:agent-core`) is the regression gate for every ACI change.
