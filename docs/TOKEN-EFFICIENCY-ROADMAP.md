# Token-efficiency roadmap

> Goal: reduce provider-billed input, output, and reasoning tokens without
> reducing task success, correctness, or recoverability.

This version is grounded in the current `agent-core/` implementation. It is an
evidence-gated implementation plan, not a list of assumed savings. A change
that claims an optimization ships only when the same model completes the same
representative tasks with no quality or data-integrity regression and a measured
reduction in billed tokens or cost. Correctness, privacy, and measurement
prerequisites may land before savings are known, but must pass their own
non-regression gates and must not be presented as token savings. Local byte
reductions and token estimates are useful only when they lead to that result.

## Current implementation status

The deterministic seams below are present in the current `agent-core/` tree.
“Complete” means the implementation boundary and local invariants are present;
it does not mean provider acceptance, measured savings, task quality, or price
benchmarks are complete.

| Area | What `agent-core/` does today | Status / remaining evidence |
|---|---|---|
| Private ownership | `main.ts` is currently 8,103 lines, while the distinct cache, request-projection, reclaim, trace, rates, and bounded-output lifecycles have private modules imported by the integration owner. | **Complete for the named seams.** Keep one behavioral owner; extract further only for a distinct lifecycle/test surface, not to create another path. |
| Traces | `trace.ts` writes schema-v2 attempt and task-settled records with stable run/task/attempt links, retry/fallback fields, nullable usage, cache diagnostics, tool/reclaim evidence, cost provenance, manifests, bounded retention, and a link index. | **Deterministic implementation complete.** Correctness is still caller-supplied/null and the controlled task corpus, quality, price, and long-session benchmark remain pending. |
| Cache identity | `auth.ts` derives a private ASCII key from a process-local session seed, role, provider, protocol, and route domain; it validates the key before emitting OpenRouter or xAI headers. | **Deterministic identity complete.** Provider field acceptance and the OpenAI 50-vs-80 limit conflict remain route/model evidence gates; neither number is hardcoded. |
| Request projection | `request-projection.ts` separates durable prompt/images from a sorted, escaped, UTF-8-bounded overlay; validates complete tool-call/result sequences; main snapshots and appends the overlay once per logical request, including retries. | **Deterministic projection complete.** Legacy replay is narrow and explicit; corpus-level quality and provider-prefix behavior remain pending. |
| Tool output | `tool-output.ts`, `host.ts`, `main.ts`, and `mcp.ts` use bounded UTF-8 accumulation, explicit completion states, omission markers, continuations, independent streams, and glob lookahead. | **Deterministic bounds complete.** Exhaustive stress and task-quality effects remain pending; no provider savings are implied. |
| Reclamation | `reclaim.ts` plans bounded targets with original bytes/chars/hashes and recovery metadata; `session.ts` durably validates/applies receipts, replays source records, and maps recovery across forks before main changes its view. Last-resort truncate still persists only a dropped-count revision. | **Receipt-based prune recovery complete.** Truncate/summarize recovery semantics, reclaim ranking, billed-token savings, p95 recovery calls, and the full resume/fork corpus remain pending. |
| MCP tools | `mcp.ts` canonicalizes schemas, normalizes/deduplicates discoveries before caps, freezes selected tools; main gates `/clear` with `mcpBusy` and a generation token and falls back to built-ins on failure. | **Deterministic ordering/boundary complete.** Real-server reconnect behavior and cache/quality effects remain pending. |
| Provider capabilities | `auth.ts` records route/model-scoped documentation provenance and unknowns; `cache.ts` bounds capability observations; `openai-compat.ts` owns serializers and has a native Gemini `cachedContent` lifecycle seam. Main enables only documented direct-route fields; Gemini native caching is not enabled by default. | **Field gating/trace seam complete; activation remains evidence-gated.** Live provider probes, TTL/price/quality benchmarks, and relay behavior remain pending. |
| Estimates and prices | `reclaim.ts` uses the shared conservative `/4` byte estimate including tool-schema accounting; `rates.ts` validates immutable role/route/model snapshots and main captures bounded catalog provenance. | **Arithmetic/provenance seam complete.** Factors, live price snapshots, storage/TTL billing, and cost savings remain uncalibrated/pending. |

Provider behavior was validated against the primary sources listed at the end
on 2026-08-30. Billing, retention, model support, and field limits remain
external contracts rather than repository facts; preserve their source and
retrieval date in the baseline and re-check them immediately before shipping.

## Metrics and guardrails

Report every metric by provider, protocol, model, role (`main` or `summary`),
task class, session-length bucket, and effective cache policy. Distinguish a
logical task/run from its provider-call attempts: retries and cache-fallback
requests must not become additional successful tasks.

| Metric | Current baseline | Ship gate |
|---|---:|---:|
| Task success and correctness | `task-settled` records now link the attempts and record runtime outcome status; correctness and evaluator criteria remain caller-supplied, with correctness currently null in the main settlement path. | No statistically meaningful regression and zero new correctness or data-integrity failures. |
| Billed input tokens per successful task | Not established. | At least 10% lower median on the same evaluation corpus and model. |
| Cost per successful task | Cost is computed only from an immutable, role/route/model-scoped rate snapshot with source/version/time; unknown rates or counters remain null. | At least 10% lower median using one price snapshot and known costs only. |
| Cached-input share on eligible steady-state calls | Per-attempt usage and cache fields are nullable; display/session accumulation may show zeros for presentation but trace denominators do not coerce absent provider fields. | Improve over a measured route baseline; do not use a universal 95% target. |
| Summary calls and summary tokens | Summary attempts are linked to the parent task and carry usage, cache, cost, and TTFT when available; missing values remain unknown. | Zero on short tasks; no increase on long tasks unless success or recovery improves. |
| Retries, fallbacks, revisions, and overflow | Attempt links, retry counts, fallback reasons, revision kinds, and overflow statuses are trace fields; extra attempts are not successful tasks. | No increase unless task success improves and the added billed work is justified. |
| p50/p95 time to first token and turn time | Main and summary attempt records accept TTFT and turn duration; aggregate p50/p95 baselines are not established. | No material regression. |
| Unknown-data coverage | Nullable usage, cost, capability, retention, write, malformed/partial, omitted, and trace-write failure fields are preserved and counted. | Every unknown field is counted; no optimization is accepted on a biased denominator. |

`cacheRead / (input + cacheRead + cacheWrite)` is a diagnostic, not the primary
goal. First turns, short prompts, revisions, model changes, long idle gaps, and
provider eviction can make a high global target impossible or misleading. The
current 60%/80% values are reclamation hysteresis thresholds, not measured
steady-state context usage. Do not maximize context fill.

Do not claim superiority over another harness without a reproducible benchmark
that controls the model, effort, task inputs, tool access, completion criteria,
retry policy, and price snapshot.

## P0 — correctness and measurement prerequisites

Do not run cache or reclamation experiments until the request projection and
trace truth gates below pass.

### 0. Extract private ownership seams before changing behavior

**Owners:** the relevant sections currently in `agent-core/main.ts`, with
existing canonical owners retained.

At this audit, `main.ts` is an 8,103-line integration file containing several
independent lifecycles. The named behavior-preserving private extractions are
now present; keep the rule below for any remaining lifecycle/test surface:

- `agent-core/cache.ts`: effective-policy and marker diagnostics plus
  miss-classification state, delegating identity derivation to the canonical
  owner in `auth.ts`.
- `agent-core/request-projection.ts`: conversion from persisted messages to
  canonical serializer inputs plus the volatile overlay described in section
  1; provider-specific serialization remains in `openai-compat.ts`.
- `agent-core/reclaim.ts`: estimation, prune planning, revision receipts, and
  recovery planning described in section 6.

These modules remain part of the `agent-core` owner and expose no new public
contract. `trace.ts` owns trace persistence and `rates.ts` owns rate validation
and arithmetic; `tool-output.ts` owns shared UTF-8 bounds. `session.ts` remains
the sole append/replay/fork owner;
`openai-compat.ts` remains the sole OpenAI/Google protocol serializer;
`mcp.ts` remains the MCP owner; and `auth.ts` remains the provider identity and
capability owner. Migrate callers and remove the moved implementation. Do not
add aliases, feature flags, duplicate formatters, a second cache engine, or a
second snapshot store.

The module imports and the current `main.ts` header no longer describe a
single unsplit owner. Keep the boundary behavioral rather than file-based as
further work lands.

**Current status:** The named private seams are implemented and imported by the
single integration owner. Further extraction is not an acceptance requirement
unless a distinct lifecycle/test surface is demonstrated.

**Validation:** For representative messages, images, tools, revisions, and
provider routes, compare the pre-extraction and post-extraction provider
payloads and session records byte-for-byte. Exercise process shutdown during
each lifecycle and verify that the main loop remains responsive.

### 1. Make the working set genuinely request-only

**Owners:** the private projection owner from section 0, `main.ts` orchestration,
and `session.ts` persistence.

`runPrompt` now persists only the submitted prompt and image references through
`projectedUserPromptContent`. It builds `activeRequestOverlay` once from host
context and file inventories; `callModel` projects durable messages with
`projectRequest`, stamps provider-specific reusable content, and appends that
same overlay snapshot exactly once. `request-projection.ts` handles escaping,
ordering, UTF-8 byte caps, complete tool sequences, and narrow legacy context
replay.

Implement this data model:

- Persist the prompt that is actually submitted, including `@` expansion when
  it is part of the submitted prompt, and persist image references once.
- Do not persist generated host context or regenerated inventories in the
  append-only session/history. The existing transient host prompt payload may
  still carry context across the bridge; do not duplicate that transport data
  in the session. Build a bounded overlay for each provider request and hash
  the exact overlay bytes sent. Enforce the cap after escaping and wrapping the
  complete overlay, including inventory and omission-marker bytes. Do not hash
  files that were walked but not sent.
- Keep inventory entries for paths used by `read_file`, `write_file`, and
  `edit`, with a deterministic order, escaping, and an explicit omission
  marker. Keep the existing caps unless measurement justifies a change.
- Place the overlay after the last complete tool-call/tool-result sequence. It
  must never split an assistant tool-use batch from its user tool-result batch.
  If a replayed history is incomplete, resolve it using the existing
  interrupted-result behavior or fail closed; do not inject context into the
  middle of an open sequence.
- For Anthropic requests, stamp the reusable persisted prefix before appending
  the unmarked volatile overlay. Snapshot the overlay for the logical provider
  call so a cache-field fallback or retry cannot regenerate different host
  state in the same attempt group. For Responses/Completions/Google requests,
  preserve the protocol serializer's ordering and leave the volatile tail
  outside the reusable breakpoint. Keep images and missing-image placeholders
  in their original user-turn order.
- Treat an existing persisted `<working-set>` block as legacy historical user
  content during resume/fork: preserve the stored record and replay semantics,
  include each stored legacy block once at its original position, and never
  regenerate it as the new overlay.
  New turns must not create such a block. This is a narrow projection rule,
  not a broad compatibility layer or a rewrite of old session files.

**Validation:** For a new session, assert that the JSONL has no generated
`<working-set>` block while each outgoing request contains the overlay exactly
once. Cover no overlay, host-only context, inventories, `@` expansion, images,
missing images, Unicode paths, resume, fork, compaction, retry, and two
consecutive prompts. Use a legacy session fixture and verify that replay is
unchanged, the legacy block is not duplicated, and the fresh overlay is not
inserted between tool calls and results. Compare Anthropic, Responses,
Completions, and Google projections.

**Current status:** The request-only projection seam and retry-stable overlay
are implemented; a focused TypeScript check passes the overlay byte/hash,
tool-sequence, and final-position invariants. The full legacy/resume/fork/
compaction corpus and provider quality comparison remain pending.

### 2. Make trace data truthful and freeze a reproducible baseline

**Owners:** the existing trace writer in `main.ts` (or its private extraction)
and the trace-file reader/consumer contract at the integration boundary. If no
runtime consumer is in the implementation scope, name or add the smallest
bounded reader needed for the baseline rather than treating the writer
directory as a complete data set.

`trace.ts` now writes schema-v2 attempt and task-settled records through an
atomic, queued runtime. `main.ts` opens one logical task, links provider,
summary, retry, fallback, and overflow attempts, and settles the task after the
run. Usage, reasoning, cache diagnostics, tool outcomes, reclaim evidence, and
cost/rate provenance are nullable and retained as unknown when absent. A
bounded manifest and link index account for retention, malformed/partial
records, omitted records, write failures, and startup state; startup does not
silently reset the prior run.

Add measurement without changing the task contract:

- Give each logical run/task and each provider attempt a stable id. Link main
  calls, summary calls, retries, cache-field fallback calls, overflow retries,
  and the final settled outcome.
- Keep provider, protocol, model, requested and effective effort, task class,
  route, status, retry count, fallback reason, revision count/kinds, tool names,
  timing, and task outcome distinct. Supply task class and success criteria
  from controlled corpus/run metadata rather than heuristically classifying
  raw prompts. If correctness is evaluated outside `agent-core`, join that
  evaluator result by task id instead of inferring it from provider-call
  status. A successful provider call is not a successful task.
- Represent each usage component as an explicit unknown sentinel (use nullable
  numeric fields consistently, or document another single representation) when
  the response did not provide it; do not coerce missing input, cache-read,
  cache-write, output, or reasoning counters to zero. Record provider-reported
  reasoning tokens when available and leave them unknown otherwise.
- Record price source, lookup timestamp/version, and the fields used to compute
  cost. If a rate or cache-write price is unavailable, cost is unknown rather
  than silently using an input-rate fallback.
- Record the effective request policy: cache key namespace, requested fields,
  marker count/positions, TTL, rejection, fallback, and whether the retry sent
  byte-identical prompt content. Keep privacy-preserving hashes rather than raw
  prompt or file content.
- Make retention explicit. A 64-call cap may be useful for a hot path but must
  not masquerade as a complete long-session baseline; export or report the
  omitted count. Do not silently delete the previous run's trace directory at
  startup: namespace a new run, retain a deliberate bounded history, or record
  the reset and omitted count in the baseline artifact.
- Count trace write failures, malformed/partial files, and records omitted by
  retention separately; a best-effort writer must not make an incomplete
  baseline look complete.
- Build a corpus containing short, tool-heavy, long-context, image, MCP,
  resume, compaction, idle-gap, retry, and fallback cases. Record success
  criteria and expected file outcomes, and compare only successful tasks while
  reporting failure rate separately.

**Validation:** Re-running the consumer on the same immutable trace fixture
produces byte-identical JSON. Malformed, oversized, partial, missing-usage,
unknown-cost, failed, and truncated trace records are counted without entering
known-value denominators. A fixture with one logical task and two retries must
report one task, three attempts, and the correct outcome.

**Current status:** The trace schema, writer lifecycle, attempt linkage, and
unknown-value handling are implemented; focused construction checks pass for
nullable usage and task settlement. Runtime retention/failure fixtures,
caller-supplied correctness, and the controlled success corpus remain pending
before any efficiency denominator is trusted.

### 3. Make cache identity valid, stable, private, and role/route scoped

**Owners:** `auth.ts` for the canonical derivation and `main.ts` for run
identity; body/header serialization remains in the existing protocol owners.

`auth.ts` now owns `cacheSessionSeed`, `deriveCacheIdentityKey`,
`cacheIdentityFor`, and `cacheSessionHeaders`. Durable seeds are normalized and
hashed; missing identities receive a process-local seed, invalid control-bearing
identities fail closed, and the provider-facing `tc1_...` key is printable ASCII
and bounded to 256 characters. The derivation includes the session seed, role,
provider, protocol, and route domain. `main.ts` rotates the seed on `/clear` and
uses the same identity owner for main and summary calls; unsupported routes do
not receive a cache key or session header.

Replace the behavior with one deterministic, privacy-preserving, ASCII key
derivation bounded by the strictest route limit that is actually documented.
Do not hash an empty string: when no durable session identity exists, create
one in-memory random id once per logical run/session boundary and reuse it for
that run (regenerate it on `/clear` or another new-session boundary). Include
a stable role (`main` or `summary`) and provider/protocol route domain in the
same derivation so unrelated cache families do not share a bucket. Do not
include per-turn prompts, working-set hashes, effort changes, or other values
that would fragment normal cache affinity. The main and summary namespaces
must use this one algorithm and owner; a separate summary namespace is not a
second cache engine. The OpenAI 50-vs-80 external limit conflict is unresolved
for implementation purposes: do not hardcode either value; use a conservative
bounded representation until the route/model contract is verified.

Reject control characters and never send a raw terminal, session, filesystem,
or credential identifier. Pass the same canonical identity inputs (session/run,
role, provider, protocol, and route domain) to the header and body serializers;
do not let a header silently fall back to a provider-only key. If
provider-native isolation makes a route component redundant, prove that before
removing it.

**Validation:** Cover empty, whitespace, every control-character range,
Unicode, very long, standalone, resumed, forked, `/clear` session boundaries,
and two-concurrent-session identities. Assert the maximum length, allowed
character set, stability within one run, separation across unrelated runs and
roles, route separation, and no raw identifier in the outgoing body or headers.
Verify the same canonical derivation feeds OpenRouter/OpenCode/xAI session
headers and supported cache-key fields, with role and protocol/route supplied
to both header and body derivations. Do not make the OpenAI 50-vs-80 conflict a
test constant; test the route's accepted limit instead.

**Current status:** Deterministic identity derivation, privacy checks, role/
route separation, and `/clear` rotation are implemented; a focused TypeScript
check passes the bounded printable-key invariant. Provider field acceptance,
relay behavior, and the OpenAI 50-vs-80 limit remain live route/model gates.

### 4. Attribute cache misses using effective route policy

**Owners:** the cache diagnostics owner and `main.ts` request lifecycle.

`cache.ts` now owns bounded request diagnostics and route-aware miss
classification. `main.ts` supplies effective/requested policy, route/model,
reusable-prefix and working-set hashes, marker positions, fallback links, and
nullable usage to `classifyCacheMiss`; unknown-retention routes do not receive a
local five-minute expiry claim. Anthropic emits a one-hour marker only on its
documented direct route, and selected supported OpenAI Responses routes request
30-minute explicit mode. External validation on 2026-08-30 documents
Anthropic's 5-minute default and 1-hour option, with model-specific minimum
cacheable lengths; the OpenAI 30-minute option is for supported GPT-5.6+ routes
and usage fields may be nullable; xAI has a stable key but no fixed TTL; and
OpenRouter's 10-minute sticky-session behavior is not prompt-cache evidence.
Zen has no validated cache contract. `messagePrefixHash` remains diagnostic;
miss continuity uses the reusable-prefix hash instead of the whole growing
history hash.

For every attempt, retain the previous effective request metadata and classify
only what the evidence supports:

- Derive idle diagnostics from provider, protocol, model, requested/effective
  cache mode, TTL, fallback state, and the actual gap. For a relay or route
  with undocumented retention, say `possible-idle-expiry` rather than
  `idle-expired`.
- Compare prefix structure, not equality of a whole growing-history hash.
  Distinguish post-revision, cache-key, model/settings, tool-schema,
  stable-prefix, message-prefix, working-set, and backend/unknown causes. A
  provider eviction cannot be inferred from local hashes. Preserve primary and
  contributing causes when more than one local change occurs on the same
  attempt; do not hide a key/settings change behind a generic revision label.
- Trace requested versus effective policy. If a Responses 400 causes
  `stripResponsesBreakpoints` and a second request, link both attempts and
  attribute the result to the fallback policy. Do not call the rejected body
  effective, and do not hide repeated fallback work.
- Do not attribute misses when usage is incomplete; record an unknown cause and
  its missing fields. Keep the existing noise floor, but report how many calls
  fell below or above it.

**Validation:** With a fake clock, exercise the code's five-minute diagnostic,
the 30-minute Responses request only on a supported GPT-5.6+ route, the
Anthropic 5-minute/1-hour policies, and unknown-retention xAI/Zen routes at
4/6, 29/31, and 59/61 minutes. Treat OpenRouter's 10-minute stickiness as a
separate routing signal, never as a prompt-cache hit. These policies and their
acceptance are external route contracts and must be revalidated. Cover model
switches, effort/settings changes, revisions, working-set changes, tool
changes, provider eviction, missing or nullable usage, 429 retries,
explicit-cache rejection, and smaller current prompts. Each miss must have a
route-correct cause or explicit `unknown`.

**Current status:** Deterministic diagnostics, nullable usage handling, and
local miss classification are implemented; focused cache/trace checks pass for
route-scoped metadata and unknown values. Provider eviction, retention, billing,
and route-level savings remain live evidence gates.

### 5. Make bounded tool output honest

**Owners:** the existing tool implementations in `main.ts`, host-context
reading in `host.ts`, and bounded MCP result handling in `mcp.ts`; keep
`openai-compat.ts` as the serializer and do not add a second formatter.

`tool-output.ts` now provides the shared bounded UTF-8 accumulator and explicit
completion states. `collectFiles`, `globFiles`, both grep paths, `readFileResult`,
`fetchUrl`, host-context reads, and `expandFileTags` propagate caps, timeouts,
interruptions, unreadable/failed states, and actionable continuation markers.
`runBash` bounds stdout and stderr independently while reading, preserves exit
status/reproduction metadata, and MCP results use the same bounded machinery.
Glob performs one lookahead beyond its 200-visible-entry cap so an exact 200
match result is distinguishable from an omitted continuation.

Make incompleteness part of each result:

- For `glob`, retain deterministic ordering and collect at most one item beyond
  the visible cap. Emit 199, emit exactly 200 without a truncation marker when
  there is no 201st eligible match, and emit 200 plus an omission marker only
  when a 201st match exists or the walk was capped/interrupted. Include a
  narrower follow-up pattern/path hint.
- Propagate separate `complete`, `visit-cap`, `timeout`, `interrupted`, and
  unreadable/failed states from `collectFiles`, fallback grep, and line scans.
  Never turn a stopped or capped walk into `(no matches)` or a complete result.
- Preserve jail checks, ignored-path behavior, symlink-loop protection,
  deterministic UTF-8 ordering, and event-loop yielding. Keep grep's existing
  grouping and visible-page limits.
- Cut byte-bounded text at a UTF-8 boundary before decoding, and include an
  omission marker with a reproducible continuation. Bound stdout and stderr
  independently while reading (not only after unbounded accumulation), while
  retaining exit status and the reproduction command. Apply the same
  UTF-8-safe, marked truncation rule to MCP tool results; mark attachment
  omission after the eight-file cap.

**Validation:** Cover exactly 199, 200, and 201 glob matches; visit-cap and
timeout exits; user interruption; symlink loops; ignored paths; unreadable
directories/files; Unicode filenames and content; zero matches; long UTF-8
lines; split stream chunks; noisy stdout/stderr; and commands that exit nonzero.
Every incomplete result is bounded, deterministic, and actionable.

**Current status:** Deterministic bounds, state propagation, UTF-8 handling,
and omission continuations are implemented; focused tool-output and projection
checks pass basic split-chunk/marker invariants. Exhaustive filesystem stress,
real command interruption, and task-quality effects remain pending.

## P1 — optimize measured tail dominance

Start these only after P0 identifies the dominant token source and its task
success impact.

### 6. Reclaim repeated tool payloads without losing recovery

**Owners:** `reclaim.ts` for planning and receipts, `session.ts` for durable
records, and existing tools for full reads.

`reclaim.ts` now uses the shared conservative `/4` UTF-8 byte estimate and
includes system, tool-schema, and volatile-overlay tokens in its planning
inputs. It emits bounded prune targets with original character/byte counts,
SHA-256 hashes, stable `sseq`/block addresses, tool/reproduction metadata, and
an explicit full-read recovery source. `session.ts` validates and applies the
receipt durably before changing the replay view, verifies hashes while reading
source records, and maps `sourceSseq` plus child addresses when materializing a
fork. Trace-v2 records per-target reclaim evidence. The last-resort `truncate`
revision still records only a dropped count, and `summarize` has no per-block
recovery receipt; those paths must not be described as recoverable optimizations.

Use trace data to rank repeated payloads by tool and age. Prefer existing
offset/range reads and executable stubs. If a receipt is justified, include the
source `sseq`/block identity, byte length, content hash, revision identity, and
an explicit full-read fallback. Do not return a diff-only result unless the
base content is identified, still available to the model, and verified against
the hash. Do not add a second file snapshot store; repository snapshots remain
owned outside this kernel.

Keep prune, summarize, truncate, resume, and fork semantics explicit. A
revision must be durable before the in-memory view changes, and stale or
missing receipts must fail safely rather than hide content.

**Ship gate:** At least 10% lower median billed input on the affected successful
corpus, no optimization-induced extra tool call at p95 (explicit recovery
fallbacks are measured separately), and successful recovery after resume,
compaction, fork, external file modification, a stale base hash, and a missing
or truncated source record.

**Current status:** Receipt-based prune planning, durable application, hash
verification, and fork mapping are implemented; focused reclaim/session checks
pass the bounded receipt invariants. Ranking repeated payloads, truncate/
summarize recovery, p95 recovery calls, billed-token savings, and the full
resume/fork corpus remain pending.

### 7. Prove tool-schema byte stability and define MCP reconnect semantics

**Owners:** `mcp.ts` for discovery/normalization and `main.ts` orchestration.

Built-in tool order is fixed by `TOOLS`. `mcp.ts` now canonicalizes schema
object keys, sorts by server/original name and a descriptor tie-breaker,
deduplicates repeated discoveries, resolves name collisions, and applies
count/byte caps only after normalization. The selected set is frozen for the
returned session. During `/clear`, main marks `mcpBusy`, invalidates the old
generation, resets to built-ins, and accepts prompts only after the replacement
connection settles; a stale connection is shut down and a failed reconnect
settles on built-ins.

- Capture the exact serialized tool array per protocol and compare it across
  adjacent requests. Normalize MCP tools by stable server/original name and a
  deterministic schema/description tie-break before applying count/byte caps;
  canonicalize schema object-key ordering and deduplicate repeated discoveries
  so semantically identical inputs serialize identically. Resolve
  truncated-name collisions deterministically.
- Freeze the selected tool set for the life of a session. `/clear` must wait
  for `connectMcp` to finish before accepting a prompt; the replacement is part
  of the newly cleared session. A reconnect outside `/clear` must be deferred
  to a new session rather than mutate `mcpSession` or `clientTools` under an
  active run. If reconnect fails, settle the boundary with the built-in tool
  set, surface the failure, and re-enable the prompt; never leave the session
  half-busy or expose a mixed schema.
- Treat a tool-set change at that new-session boundary as a cache-continuity
  reset and trace the boundary. Never keep old and new tool paths in parallel.

**Ship gate:** Semantically identical discoveries in different arrival orders
produce byte-identical serialized tools and the same selected set. A reconnect
cannot produce a request with a mixed old/new schema, and a tool-set change is
visible in the trace.

**Current status:** Deterministic MCP normalization, cap ordering, and the
`/clear` reconnect boundary are implemented; a focused TypeScript check passes
arrival-order invariance. Live-server failure/reconnect behavior and cache or
task-quality effects remain pending.

### 8. Evaluate cache breakpoints from observed block deltas

**Owners:** `auth.ts` and `openai-compat.ts` for provider fields, the cache
diagnostics owner for measurements.

The current code marks the system and last eligible client tool in
`buildCachedPrefix`, stamps one eligible history block for Anthropic within the
20-block walk, and uses `markPrefixThenTail`/`prompt_cache_breakpoint` for
selected Responses routes. `cacheDiagnosticsForRequest` now records marker
counts and positions plus reusable-prefix hashes in trace-v2. It does not yet
record a provider-verified eligible-block delta or prove that a marker was
accepted; Anthropic tool lists may also append provider-executed search after
the client-tool marker.

External validation on 2026-08-30 gives Anthropic-specific bounds of at most
4 breakpoints and a 20-block lookback, alongside its 5-minute/1-hour policies
and model-specific minimum cacheable lengths. OpenAI sources conflict on a
50-vs-80 breakpoint/lookback limit; do not hardcode either number. Content-block
eligibility and whether server/tool markers consume a limit remain
route-specific. Do not apply one provider's rule to another, and keep all of
these facts revalidation-required external contracts.

- Trace marker kind, position, eligible block count, and blocks added since the
  prior request without recording raw prompt content.
- Add another history anchor only if observed requests approach the relevant
  external lookback. A rescue marker must be placed before the old entry leaves
  the provider's lookback window; adding it after a miss cannot repair that
  request. Stay within the route's externally documented breakpoint limit,
  including automatic/server markers; for OpenAI, probe the route/model instead
  of selecting 50 or 80 as a constant.
- Test mixed TTL ordering, provider rejection, images, tool-result sequences,
  and the volatile overlay placement from section 1.

**Ship gate:** Synthetic 19/20/21-block fixtures for Anthropic's documented
20-block lookback (and route-appropriate boundary fixtures elsewhere) plus a
representative corpus show fewer full-prefix misses without more provider
errors or higher median cache-write cost. Do not turn the OpenAI 50-vs-80
conflict into a fixture constant; establish the accepted route/model boundary
with the current contract and live response. The numeric fixtures are not
repository facts.

**Current status:** Deterministic marker placement, four-marker capping, and
trace marker metadata are implemented. Eligible-block effectiveness, provider
acceptance, OpenAI's unresolved 50-vs-80 limit, and cache-write/cost impact
remain live route/model and corpus evidence gates.

### 9. Treat cache thresholds and TTLs as experiments, not constants

**Owners:** `auth.ts`, `openai-compat.ts`, and the cache diagnostics owner.

The code sends a fixed 30-minute explicit Responses option only when the
documented direct GPT-5.6+ capability gate allows it, an Anthropic one-hour
marker on the direct Anthropic route, and no cache marker by default elsewhere.
OpenAI and Google usage mappers preserve an absent cache-write counter as
`null`, which means “not captured,” not “no write charge.” `rates.ts` keeps
cache-write TTL class, billing relation, and missing price fields explicit.

- Maintain threshold/TTL data only for routes where the external API contract
  defines it. Unknown relays must use provider behavior and report unknown,
  not a guessed model-family table.
- Apply the validated external contracts narrowly: Anthropic's 5-minute default,
  1-hour option, and model-specific minimums; OpenAI's 30-minute explicit mode
  only on supported GPT-5.6+ routes with nullable usage preserved and no
  hardcoded 50-vs-80 limit; Gemini's
  named `cachedContent` lifecycle; xAI's stable key with no fixed TTL; and
  OpenRouter's 256-character session header with 10-minute stickiness treated
  separately from prompt caching. Zen is protocol routing only and has no
  validated cache contract.
- Add a minimum-length guard only if traces show billed cache-write tokens or a
  latency/error benefit. A below-threshold marker is not proof of a surcharge
  when write usage is unknown.
- Do not choose Anthropic TTL from the previous inter-turn gap alone. The next
  gap is unknown, TTL changes can fragment entries, and storage/write prices
  differ. Compare fixed policies on observed cadence with a break-even
  calculation that includes reads, writes, storage, and idle misses.
- Do not add deprecated or undocumented fields. Feature-probe optional fields
  at the canonical protocol owner and trace the effective policy after a
  rejection.

**Ship gate:** Lower measured cost on the same successful task corpus after
including cache writes, reads, storage charges where applicable, idle misses,
and unknown-cost exclusions. Revalidate provider fields, prices, thresholds,
and retention immediately before any activation or shipping.

**Current status:** Deterministic route gating, nullable usage mapping, and
rate-provenance plumbing are implemented. TTL acceptance, cache-write/storage
pricing, live price snapshots, and cost reduction remain pending external and
corpus evidence.

## P2 — frontier work only after profiling

### 10. Optimize summarization only if it is material

`summarize` already routes to a cheap summary model with thinking/effort off,
and local `grep`/`glob` do not make classification model calls. The summary
request is different from the main request: `completeText` uses the `summary`
role for cache identity where the route supports it, and `writeSummaryTrace`
links usage, cache diagnostics, cost provenance, and TTFT to the summary
attempt. A shared derivation does not create a hit when the serialized prefix
differs.

- Measure summary input, output, reasoning, latency, success/recovery impact,
  and cache policy as a separate role. Keep summary calls joined to the parent
  task and attempts.
- If repeated summaries demonstrate a cacheable prefix, use the `summary`
  namespace from section 3 through the same canonical derivation. Do not share
  the `main` namespace and do not create a second key algorithm.
- Prefer fewer summaries through reclamation before optimizing summary-cache
  behavior. Preserve structured inventories and prior handoffs without
  duplicating them; sort and escape inventory paths before projection.

**Ship gate:** Summary optimization lowers total cost or improves recovery on
long successful tasks without increasing short-task summaries, failures, or
main-role cache fragmentation.

**Current status:** Summary attempt linkage and role-scoped trace plumbing are
implemented. Repeated summary-prefix hit rate, summary cost, and recovery or
quality impact remain pending corpus/provider evidence.

### 11. Calibrate token estimates before adding a tokenizer

`estimateReclaimTokens` now uses `ceil(UTF-8 bytes / 4)` consistently for
history, reclaim planning, overlays, and tool schemas; image blocks use a fixed
8,000-token local estimate. These remain conservative heuristics, not provider
token counts. Provider usage is authoritative after a request, and `rates.ts`
keeps cost arithmetic separate from the estimate.

- Record estimate versus provider-reported input by model and content class:
  code, English prose, non-English text, JSON, tool schemas, images, and image
  placeholders. Keep unknown usage separate.
- Use one internally consistent conservative estimate for watermarks and
  expose its error bounds. Change a route-specific factor only if error causes
  measured premature reclamation, overflow retries, or avoidable context loss.
- Add a tokenizer dependency only if it materially reduces those failures and
  does not block the agent process or enlarge the desktop hot path. It must not
  become a second provider accounting system.

**Ship gate:** Fewer overflow/reclamation failures at the same or lower billed
input, with no main-process latency regression and no claim of exactness where
the provider tokenizer is unavailable.

**Current status:** Estimate consistency and tool-schema accounting are
implemented. Calibration by model/content class, tokenizer adoption, overflow
reduction, and billed-cost impact remain pending corpus/provider evidence.

### 12. Investigate provider-specific caching separately

**Owners:** `auth.ts`, `openai-compat.ts`, and `main.ts`; no second protocol
mapper or cache engine.

Protocol selection remains heuristic only where the provider contract requires
model routing (notably OpenCode Zen). Cache field selection is now gated by
direct route/model documentation observations in `auth.ts`, bounded in
`cache.ts`, and recorded after the narrow Responses rejection fallback in
`main.ts`; relays remain unknown unless probed. Gemini, OpenRouter, OpenCode
Zen, Codex, Copilot, xAI, and relays are separate contracts even when they
expose the same model name.

Validated external behavior (retrieved 2026-08-30; revalidation required at
implementation) is route-specific: Gemini exposes named `cachedContent`, not a
guaranteed-compatible `prompt_cache_key`; xAI supports a stable key but has no
fixed TTL; OpenRouter documents a 256-character session header and 10-minute
sticky-session behavior, neither of which proves a prompt-cache hit; and Zen
defines protocol routing only, with no validated cache contract. Anthropic's
4/20 breakpoint/lookback and 5-minute/1-hour policies are model- and route-
dependent, while OpenAI's 30-minute explicit mode is limited to supported
GPT-5.6+ routes and its 50-vs-80 limit conflict must not be hardcoded.

`openai-compat.ts` contains a separate native Gemini `cachedContent` request,
parse, update, and delete lifecycle seam. The current main request path does
not create or attach a native cached-content resource, so native Gemini caching
is not enabled; activation remains evidence-gated and must not be inferred from
the serializer seam.

- Feature-probe optional fields at the canonical owner and cache the effective
  result only for a clearly scoped provider/protocol/model route and session.
  Trace rejection, fallback, and capability expiry; never silently reuse a
  stale capability after a model or route change.
- Measure implicit versus explicit caching before adding provider-specific
  object lifecycle, storage, cleanup, or billing assumptions.
- Keep model catalog context values authoritative when present, and label
  default context windows and model-name fallbacks as estimates until a live
  provider response verifies them.

**Ship gate:** Each provider route has a documented, tested effective policy;
unsupported fields do not cause repeated hidden retries; and any savings are
measured on the same successful task corpus.

**Current status:** Direct-route capability provenance, bounded observations,
effective-policy tracing, and fallback handling are implemented. Gemini native
cache activation, relay probes, provider retention/billing, and measured route
savings remain pending external evidence.

## Canonical owners and verification

Keep each responsibility in one `agent-core` owner; the list below is the
implementation map for the remaining work and its deterministic checks.

| Responsibility | Canonical owner | Current deterministic check | Still pending |
|---|---|---|---|
| Cache identity and capability observations | `auth.ts` and `cache.ts` | `cacheSessionSeed`, `deriveCacheIdentityKey`, capability-cache bounds, and nullable miss diagnostics | Live route/model field acceptance, retention, and the OpenAI 50-vs-80 boundary |
| Request projection and provider payloads | `request-projection.ts` and `main.ts`; serializers in `openai-compat.ts` | Overlay escaping/order/byte hash, complete tool sequences, retry reuse, and provider projection invariants | Full resume/fork/compaction corpus and quality comparison |
| Trace and cost provenance | `trace.ts`, `rates.ts`, and `main.ts` | Immutable attempt/task records, nullable usage/cost, atomic writes, link index, and bounded manifests | Evaluator correctness, long-session retention benchmark, live prices, and cost savings |
| Reclaim and recovery | `reclaim.ts` and `session.ts`; orchestration in `main.ts` | Receipt validation, original/stub hashes, durable-before-view application, source-record recovery, and fork mapping | Truncate/summarize recovery, p95 recovery calls, and billed-token impact |
| Bounded tool output | `tool-output.ts`, `host.ts`, `main.ts`, and `mcp.ts` | UTF-8 boundary, cap/state/marker, split-chunk, independent stream, and continuation invariants | Exhaustive filesystem/command stress and task-quality impact |
| MCP discovery and session boundary | `mcp.ts` and `main.ts` | Canonical schema ordering, deduplication, cap selection, generation guard, and built-in fallback | Live-server reconnect and provider cache/quality effects |

Focused module checks currently pass via `npx tsx --eval` harnesses over the
exported projection, bounded-output, cache-identity, MCP, and trace seams.
`npx tsc --noEmit` remains the type-check command, and `node scripts/build.mjs`
is the build smoke check. Neither command establishes provider billing,
retention, TTL acceptance, price accuracy, task quality, or corpus savings.

## Dependency-aware implementation order

Parallel work is safe only across disjoint owners. Use one writer per file and
make the `main.ts` integration owner serialize changes that cross lifecycle
boundaries; never merge concurrent edits to the same hot path by textual
resolution alone.

1. Establish the failing fixtures and record the provider evidence matrix
   (revalidating it in the implementation turn), then land the private seams in
   section 0 through one integration owner.
2. After the seams compile, implement the request overlay, logical-attempt
   trace truth, and `/clear` session boundary in `main.ts`/`session.ts`. Their
   task-success, recovery, unknown-data, and responsiveness gates must pass
   before any cache experiment.
3. Once those gates are green, work independently on `auth.ts` cache identity,
   `openai-compat.ts` usage/projection helpers, `mcp.ts` normalization, and
   `host.ts` plus the disjoint tool-cap helpers in `main.ts`. Keep their
   focused tests disjoint.
4. Integrate reclaim receipts and recovery evidence in dependency order, then
   rerun the complete harness after each integration batch. Run route-specific
   live probes and the controlled corpus only after deterministic fixtures pass;
   keep empirical results separate by provider/protocol/model and do not share
   mutable sessions between probes.
5. Apply P1/P2 optimizations only after P0's gates are green; a subagent may
   prepare evidence while another owns the next disjoint implementation file.

## Validation questions for every change

1. Does this reduce provider-billed tokens or cost, or only local bytes and an
   estimate?
2. Is the comparison on the same model, effort, prompt, tools, task outcome,
   retry policy, route, and price snapshot?
3. Are failed tasks excluded from efficiency denominators while their failure
   rate remains visible?
4. Which values are known, zero, or unknown in the provider response, and does
   the trace preserve that distinction?
5. Is the cache key private, bounded, stable for one run, separated by role and
   route, and derived by one owner?
6. What happens on the first turn, a below-threshold prompt, an idle gap,
   provider eviction, a 429 retry, an overflow retry, and an explicit-cache
   fallback?
7. Are requested and effective cache mode, TTL, markers, and fallback traced?
8. Is the working set absent from new persisted records, present exactly once
   in the request, and handled narrowly for legacy sessions?
9. Can the overlay be inserted only after a complete tool-call/tool-result
   sequence, including after resume, fork, compaction, and interruption?
10. Does every cap distinguish complete, visit-cap, timeout, interruption,
    unreadable, and failed states, including exactly 199/200/201 glob matches?
11. Are UTF-8 boundaries, image order, jail rules, ignored paths, and bounded
    stdout/stderr preserved?
12. Can a pruned payload be recovered after resume, fork, compaction, external
    file modification, and a stale or missing hash receipt?
13. Are MCP tools normalized before caps and frozen while a prompt is running?
    Can `/clear` or reconnect expose a mixed schema?
14. Does the implementation stay in the canonical owner without a compatibility
    shim, duplicate formatter, cache engine, tokenizer accounting layer, or
    snapshot store?
15. Does it keep the main process responsive and avoid larger IPC payloads?
16. Can the trace explain both an improvement and a regression without reading
    raw provider traffic?

If any answer is unknown, add instrumentation or a controlled experiment before
adding the optimization.

## Provider documentation validated 2026-08-30 — revalidate before shipping

The following facts were checked against the listed primary sources on
2026-08-30. They are external contracts, not facts inferred from
`agent-core`; prices, support, limits, and responses can change. Re-check each
route and record the source URL and retrieval time in the implementation
baseline before shipping.

| Route | Validated external fact | Safe roadmap assumption | Still unknown / do not assume |
|---|---|---|---|
| Anthropic Messages | Up to 4 breakpoints; a 20-block lookback; 5-minute default and 1-hour option; minimum cacheable length is model-specific. | Test 4/20 and 5-minute/1-hour behavior only on routes that accept the fields; keep model minimums route-specific. | Billing, eviction, exact model minimums, and relay behavior until live responses and current docs verify them. |
| OpenAI Responses | Sources conflict on a 50-vs-80 breakpoint/lookback number; usage/cache fields may be nullable or absent; explicit 30-minute mode is for supported GPT-5.6+ routes. | Do not hardcode 50 or 80. Preserve nullable usage and send 30-minute explicit mode only when route/model capability says supported. | Which limit applies to a particular route/model; write/storage billing; unsupported-route behavior. |
| Gemini `generateContent` | Named `cachedContent` is the documented cache object; compatibility with `prompt_cache_key` is not established. | Treat `cachedContent` as a separate lifecycle and do not send `prompt_cache_key` without route proof. | TTLs, minimums, implicit behavior, and write billing for this kernel's route. |
| xAI | A stable cache/session key is supported; no fixed TTL was validated. | Keep a stable key if the route accepts it; classify retention as unknown or possible idle expiry. | TTL, marker/breakpoint support, and write/storage billing. |
| OpenRouter | A 256-character session id and 10-minute sticky-session behavior are documented separately from prompt caching. | Bound the session header to 256 characters and never count stickiness as a prompt-cache hit; probe upstream model caching separately. | Upstream model/provider cache limits, TTLs, and billing. |
| OpenCode Zen | The source validates protocol routing by model; no cache contract was validated. | Use Zen for protocol selection only; do not send cache-specific fields or claim cache savings without a route contract. | All cache limits, TTLs, billing, and model support. |

Primary sources (retrieved 2026-08-30):

- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenAI Responses create reference](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [Gemini caching](https://ai.google.dev/gemini-api/docs/generate-content/caching)
- [xAI documentation](https://docs.x.ai)
- [OpenRouter documentation](https://openrouter.ai/docs)
- [OpenCode Zen documentation](https://opencode.ai/docs/zen)
