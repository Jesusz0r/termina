# Agent Core — Context Efficiency Principles

Design invariants for a self-owned agent kernel (`agent-core`). Stated as
principles, not implementations: each principle names the invariant, the rule
that follows from it, and how to verify it. Where a number appears it is an
example starting point, never the spec.

Status: implemented in `agent-core/main.ts` and `agent-core/tui.ts` (frozen zones + append-only
storage + `/resume` replay, reclamation hysteresis + summarization with
handoff chaining + emergency overflow + truncate last resort, executable
stubs + structured inventories, waste attribution with models.dev pricing,
two-role routing map, bounded concurrency, cwd jail, grep/glob, web_search, skill
index, prefix `cache_control`, traces, provider auth, live model list,
full-screen TUI). Zone 1 is identity, environment,
user-global `~/.agents/AGENTS.md`, the skill index, then cwd `AGENTS.md`.
Skill bodies load with `read_file`. Skills come from `~/.agents/skills`
then `<cwd>/.agents/skills` (no ancestor walk). Truncated instructions
are overflow-recoverable. The kernel does not call the snapshot store.
`termina-core` stays the snapshot/Git owner. Credentials live in
`~/.termina/agent/auth.json` (`/login`, `/logout`). Providers: Anthropic,
OpenAI, ChatGPT Codex OAuth, xAI, Google, OpenRouter. The implementation plan is
`docs/AGENT-CORE-PLAN.md`. Auth details: `docs/AUTH-PLAN.md`.

## Why this document exists

Wall-clock per agent turn is ~99% network wait. Money and tokens are spent on
exactly one thing: what sits in the context window. Provider prompt caches are
prefix caches — a byte change at position N re-bills everything after N.
Every efficiency property of an agent harness follows from respecting that one
fact. (Evidence: opencode reports 98%+ steady-state hit rates with no provider
tricks; pi ships a subsystem whose only job is attributing cache waste.)

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
- Corrections are new messages, never edits of old ones.
- Revision events (compaction, prune) are the ONLY writes to the visible
  context, and they must be reconstructable: the storage log stays
  append-only (a revision is a new entry, like pi's), or snapshots back the
  replaced bytes (Termina's store does). An implementation that mutates its
  only copy of history forfeits every guarantee below — forks, audits,
  recovery — so it is not an optimization, it is data loss.

Verify: replay two adjacent requests and diff — everything before the last
user turn must be identical bytes.

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

- Per-turn miss = overlap(prev prompt, this prompt) − cached read. Computing
  the exact overlap is unnecessary: min(prev total, current total) is the
  standard cheap upper bound. Ignore misses below breakpoint granularity
  (~1024 tokens); they are measurement noise, not waste.
- Attribute each miss: post-revision (expected), idle-expired (cache TTL
  lapsed between turns), model-switch (full re-bill by definition), or
  unexplained (a bug — chase it). Attribution runs per terminal stream;
  interleaved dispatch workers share no previous prompt.
- Exempt the turn immediately after a revision; new content there is the
  point, not waste.
- Emit per-turn usage records (tokens in/out/cached per role, cost, time to
  first token, revision count) to the sidecar JSONL so Termina's existing
  evidence engine aggregates without change.

Verify: every wasted dollar in a session has exactly one attributed cause.

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
| Cached share of input tokens per task | > 95% | measured across the whole task, so post-revision turns dilute but do not dominate |
| Summarizations | ≤ 1 per 50 turns | scales with session length; short tasks expect zero |
| Unexplained cache-waste dollars | 0 | any occurrence is a bug |
| p50 first-token latency | < 1 s | provider-dependent floor |

## Auth

The kernel owns a full-screen TUI in a tty: status header, scrolling
transcript, input, slash menu, and footer. Typing `/` lists commands;
Tab completes; arrows move the highlight. `/help` prints the same list.
`/login` opens a provider picker. OAuth is the provider name (`OpenAI`);
API key is `OpenAI (key)`. OpenAI OAuth is the ChatGPT Codex subscription;
OpenAI key is the platform API. `/login [provider] [oauth|key]` and
`/logout [provider]` still run when typed in full. Supported ids:
`anthropic`, `openai-codex`, `github-copilot`, `xai`, `openrouter`,
`openai`, `google`.

Agent-core stores credentials in `~/.termina/agent/auth.json` (mode 0600).
A stored credential wins over that provider's env key. OAuth tokens refresh
once on expiry or 401. After login (and on startup when a credential
exists) the kernel loads live model lists for every authenticated
provider. `/models` prints `provider` and `id` on each row; typing
`/models` in the TUI lists them. `/model <id>` or `/model <provider>/<id>`
selects one. The file is not Pi's `auth.json`. See `docs/AUTH-PLAN.md`.

The host owns session resume. `TERMINA_CORE_SESSION_FILE` is the jsonl
path under the app user-data `agent-sessions` directory.
`TERMINA_CORE_RESUME=1` replays it at process start. A failed replay
renames the file aside so the next prompt does not truncate the only
copy. Without the resume flag a new prompt still truncates the stream so
a reused terminal id cannot append a second history.

## Relationship to prior art

Pi demonstrates P5 fully (waste attribution with noise floors and cause
exemption) and structured inventory carry-over (P4). Opencode demonstrates
P2/P3 fully (prune vs compact split, backwards eviction, fractional budgets).
Neither treats eviction as recoverable (P4 upgrade), ties revisions to
fork-coherent boundaries as a product requirement (P3/Termina), or grounds
recovery in an immutable snapshot store (P1/P4 together). Constants in both
codebases informed example values only.
