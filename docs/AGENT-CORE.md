# Agent Core — Context Efficiency Principles

Design invariants for a self-owned agent kernel (`agent-core`). Stated as
principles, not implementations: each principle names the invariant, the rule
that follows from it, and how to verify it. Where a number appears it is an
example starting point, never the spec.

Status: implemented in `agent-core/main.ts` and `agent-core/tui.ts` (frozen zones + append-only
storage + `/resume` replay, reclamation hysteresis + summarization with
handoff chaining + emergency overflow + truncate last resort, executable
stubs + structured inventories, waste attribution with models.dev pricing,
two-role routing map, bounded concurrency, cwd jail, grep/glob, unique first-occurrence
edit (replace_all), interruptible bash, web_search, fetch, skill
index, prefix `cache_control`, last `tool_result` cache pin, OpenAI/Codex `prompt_cache_key`,
429 retry, model-aware `/effort`, live provider reasoning, request-only working-set overlay,
traces, provider auth, live model list, full-screen TUI, Termina sidecar host contract, core worldline session slice,
selectable bash approval policies, `/permissions`, /clear /compact, -p print, token/cache/context status, stdio MCP). Zone 1 is identity, environment,
user-global `~/.agents/AGENTS.md`, the skill index, then cwd `AGENTS.md`.
Skill bodies load with `read_file`. Skills come from `~/.agents/skills`
then `<cwd>/.agents/skills` (no ancestor walk). Truncated instructions
are overflow-recoverable. The kernel does not call the snapshot store.
`termina-core` stays the snapshot/Git owner. Credentials live in
`~/.termina/agent/auth.json` (`/login`, `/logout`). Providers: Anthropic,
OpenAI, ChatGPT Codex OAuth, xAI, Google, OpenRouter. The implementation plan is
`docs/AGENT-CORE-PLAN.md`. The remaining segmented-session work is in
`docs/AGENT-CORE-SESSION-STORAGE-PLAN.md`. Auth details: `docs/AUTH-PLAN.md`.

## Why this document exists

Wall-clock per agent turn is ~99% network wait. Money and tokens are spent on
exactly one thing: what sits in the context window. Provider prompt caches are
prefix caches — a byte change at position N re-bills everything after N.
Every efficiency property of an agent harness follows from respecting that one
fact.

## P1 — Context is an append-only log with explicit revisions

**Invariant**: between revision events, the request payload is byte-stable
except for its tail.

Rules:

- Order zones by volatility, freeze the front: system prompt, tool schemas,
  and the skill index never mutate mid-session. Skill bodies are not in
  zone 1; the model loads `SKILL.md` with `read_file`, so they sit in the
  transcript tail. If the tool set must change, start a new session rather
  than mutating zone 1–2.
- Dynamic front matter enters deterministically: environment, user-global
  `AGENTS.md`, the skill index, and project `AGENTS.md` are read once, at
  process start, in a fixed order. Two sessions with the same inputs must
  produce byte-identical frozen zones — any divergence makes the cache cold
  from byte zero.
- Corrections are new messages, never edits of old ones. A request may stamp
  `cache_control` on a copy of the last `tool_result`. That copy is not stored.
  The request suffix after that breakpoint (file inventories and host context)
  may be rebuilt every call. It is not stored in the session log.
- Revision events (compaction, prune) are the ONLY writes to the visible
  context, and they must be reconstructable: the storage log stays
  append-only (a revision is a new entry), or snapshots back the
  replaced bytes (Termina's store does). An implementation that mutates its
  only copy of history forfeits every guarantee below — forks, audits,
  recovery — so it is not an optimization, it is data loss.

Verify: replay two adjacent requests and diff — everything before the last
user turn must be identical bytes.

Context water marks use `ceil(stringLength / 3)` as a conservative estimate.
This is not a tokenizer. The prune planner uses `ceil(chars / 4)` only to
estimate reclaimed space. Provider usage is authoritative after a request.
The fallback context window is 1,000,000 tokens for Anthropic and Google,
500,000 for xAI, and 1,050,000 for other providers. Anthropic Haiku uses
200,000. A live model catalog can provide another value. There is no
1,000,000-token run cap. `MAX_TURNS` defaults to 80 model calls per prompt.

## P2 — Separate reclamation from summarization

**Invariant**: clearing bulk and compressing meaning have different costs,
different invalidation sizes, and different failure modes. One mechanism for
both couples them badly.

- **Reclamation** (cheap): drop or stub bulky payloads — old tool outputs,
  file bodies. Structure stays: the call, its arguments, its outcome status.
  The model keeps the plot and loses the footage.
- **Summarization** (expensive): collapse whole spans into a synthesized
  handoff. Run rarely; every run re-ingests the summarized span at full input
  price plus output price, then re-bills the tail once.

Rule: reclaim first, summarize only when reclamation cannot keep the window
under budget. Most sessions should never summarize.

Verify: count summarizations per run — target near zero on short tasks;
reclamations may be frequent but must touch only content outside the
protected window (P3).

## P3 — Evict backwards, protect recency

**Invariant**: the probability the next turn references content decays with
age. All eviction walks newest→oldest behind a protected window.

Rules:

- Never evict inside the protected window, regardless of pressure.
- Hysteresis lives on the fill level, not on batch size: revise only when
  context crosses a high-water mark (e.g. 80% of usable window); when
  revising, reclaim enough to fall clearly below a low-water mark (e.g.
  60%). A context hovering between the marks revises nothing. Without the
  low-water rule a session near the threshold revises every turn and pays
  full price every turn.
- Budgets are fractions of the model's window, clamped to sane absolutes —
  fixed token constants break across 8k and 1M-window models.
- Revisions happen at turn boundaries (between user→assistant pairs), never
  mid-turn — with one sanctioned exception: a provider context-overflow
  rejection mid-turn authorizes an emergency revision of the failing turn,
  stubbing the offending payload in place. Forbidding revisions there
  deadlocks the session: it can neither resend nor revise.
- Turn-boundary revisions keep every historical state coherent, which
  matters twice: for provider caches, and because Termina forks sessions
  from moments. A fork replays that moment's own frozen zones, not the
  current ones.

Verify: no revision event ever alters a part inside the protected window;
forking from any pre-revision moment still materializes a coherent session.

## P4 — Lossy where bulky, lossless where structural

**Invariant**: what the model needs long-term is decisions, file inventory,
and outcomes — not raw bytes. Raw bytes are recoverable from disk anyway.

Rules:

- Stubbed content says what was lost and how to get it back, and the "how"
  must be executable by the model: a stub carries the command that
  reproduces the output (`[cleared: test run, 18k tokens — re-run 'npm
  test' to reproduce]`). A pointer alone is not recovery: Termina's
  timeline garbage-collects old moments too, so a seq reference may dangle;
  the reproducing command is the durable half, the pointer the convenience.
- Carry structured state across revisions as data, not prose: file-read /
  file-modified inventories extracted deterministically from tool calls,
  attached to each handoff. Do not trust a summarizer model to preserve
  inventories it was not asked to keep.
- Tool outputs carry caps with escape hatches: truncation markers name the cap
  and the command to fetch more. Nothing is silently dropped.

Stubs recover through the reproducing command and the append-only session
JSONL, which keeps originals. The kernel does not call the snapshot store
and does not put a timeline sequence in the stub.

## P5 — Measure waste as money, attribute it to causes

**Invariant**: cache hit rate alone is vanity. The number that matters is
dollars billed above the cache-read rate, and *why* they were billed.

Rules:

- Per-turn miss uses `min(previous total, current total) − cached read`.
  This is a cheap upper-bound heuristic, not an exact prefix comparison.
  Misses at or below the 1,024-token noise floor are ignored.
- Attribute each measured miss as `post-revision`, `idle-expired`, or
  `unexplained`. Model changes reset the previous-prompt baseline instead of
  creating a separate cause. Attribution runs per terminal stream.
- Traces are JSON files, not sidecar events. They record usage, estimated
  cost when the local price catalog has a match, measured waste tokens and
  cause, revision count and kinds, and overflow attempts.

Verify: every measured miss has one recorded cause or is below the noise floor.

## P6 — Routing changes cost, never behavior

**Invariant**: model choice per role is configuration; correctness may not
depend on it.

Rules:

- Fixed role→model map: frontier for the main loop; cheap models for
  mechanical work (summarization, classification, search hits).
- No silent escalation or downgrade logic in v1. A cheap-model failure
  surfaces as an error; humans adjust the map.
- Sub-sessions apply the same principles locally: their own frozen zones,
  their own stable prefixes. Do not promise cache sharing between parent and
  child — worker briefings differ byte-for-byte, so no shared prefix exists.

## P7 — Latency comes from scheduling, not language

Streaming always on (first-token latency is the metric). Independent tool
calls run concurrently behind a small bound; dependent calls stay sequential.
No speculative prefetch — reads are on demand. The loop language contributes
milliseconds to a seconds-scale path; Rust buys packaging, startup, and
footprint, not these numbers.

## Targets

| Metric | Target | Notes |
|---|---|---|
| Cached share of input tokens per task | > 95% | provider-dependent; xAI receives no app-supplied `prompt_cache_key` |
| Summarizations | ≤ 1 per 50 turns | scales with session length; short tasks expect zero |
| Unexplained cache-waste tokens | 0 | investigate every occurrence |
| p50 first-token latency | < 1 s | provider-dependent floor |

## Auth

The kernel owns a full-screen TUI in a tty: a two-row model and usage
header, scrolling transcript, input, slash menu, and footer. The model row
shows the effective reasoning effort. New engines start at `medium` and clamp
that choice to the current model. `/effort` lists only supported levels:
`off`, `minimal`, `low`, `medium`, `high`, `xhigh`,
and `max`. The extra-high level is `xhigh`; there is no `ultra` level. The
usage row shows cumulative input/output tokens, cumulative
cache-read share, estimated current context-window use, and the last priced
main-model call. Typing `/` lists commands;
Tab completes; arrows move the highlight. `/help` prints the same list.
`/login` opens a provider picker. OAuth is the provider name (`OpenAI`);
API key is `OpenAI (key)`. OpenAI OAuth is the ChatGPT Codex subscription;
OpenAI key is the platform API. `/login [provider] [oauth|key]` and
`/logout [provider]` still run when typed in full. Supported ids:
`anthropic`, `openai-codex`, `github-copilot`, `xai`, `openrouter`,
`openai`, `google`.

Agent-core stores credentials in `~/.termina/agent/auth.json` (mode 0600).
A stored credential wins over that provider's env key. OAuth tokens refresh
once on expiry or 401. After login the kernel loads that provider's live
model list. Startup loads only the active provider. `/models` loads every
authenticated provider on demand and prints `provider` and `id`; typing
`/models` in the TUI lists them. `/model <id>` or `/model <provider>/<id>`
selects one. `/permissions` opens a picker for `Always approve`, `Ask on dangerous requests`,
or `Always ask`. Bash approval prompts also use arrow-key selection instead of typed letters.
The dangerous mode recognizes destructive command patterns; it is not a shell sandbox.
The file is not Pi's `auth.json`. See `docs/AUTH-PLAN.md`.

The host owns session resume. `TERMINA_CORE_SESSION_FILE` is the jsonl
path under the app user-data `agent-sessions/<project>/` directory.
`TERMINA_CORE_RESUME=1` replays it at process start. A failed replay
renames the file aside so the next prompt does not truncate the only
copy. Without the resume flag a new prompt still truncates the stream so
a reused terminal id cannot append a second history. `/clear` rotates a
non-empty file aside (`core-<id>-<stamp>.jsonl`) and starts a fresh file
at the same path so Session Search can still read the previous
conversation. Closing a tab keeps a non-empty persist session.

Clipboard and Finder image drops never enter the pty. The host writes
validated PNG, JPEG, WebP, and GIF files next to the sidecar as
`image-<terminal>-<id>.<ext>` and a pending list `images-<terminal>.json`.
A core terminal accepts at most four pending images, each at most 4 MiB.
If the agent is already running, the batch stays queued for the next
prompt. On submit the kernel claims that list, copies persisted files
next to the session (`<session>-img-N.png`), and only then acknowledges
the claim. A crash before persistence leaves the claim in place so the
next prompt recovers the bytes. The prompt payload keeps refs, not bytes.
Pi and shell terminals do not attach image bytes; a drop inserts
POSIX-quoted absolute paths through xterm paste and does not submit them.

The TUI transcript keeps assistant, thinking, tool, and error entries.
Provider-visible thinking is shown by default. `CmdOrCtrl+Shift+H` toggles
it. Encrypted reasoning is never shown. Tools render one status box.
Resume paints stored messages into that transcript. Scroll position and
pending tool widgets are not restored from session JSONL.

MCP is a stdio client, not a plugin surface. Servers come from the user-owned
`~/.termina/agent/mcp.json`. The kernel does not execute project-owned MCP
configuration. It spawns user servers at process start, lists tools once,
prefixes names `mcp_<server>_<tool>`, and freezes that list in zone 1.
`/clear` reconnects. HTTP/SSE MCP is out of scope.
