# Token-efficiency roadmap

> Goal: reduce billed input, output, and reasoning tokens without reducing task
> success, correctness, or recoverability. This roadmap derives from
> `docs/AGENT-CORE.md` P1-P7, `docs/CACHE-AUDIT.md`, the current kernel, and
> official provider documentation checked on 2026-08-30.

This is an evidence-gated roadmap, not a list of assumed savings. A change does
not ship because it reduces bytes in one request. It ships only when the same
model completes the same representative tasks with no quality regression and a
measured reduction in median cost or billed tokens.

## Success metrics and guardrails

Report every metric by provider, protocol, model, task class, and session-length
bucket. Do not combine routes with different cache rules into one percentage.
Exclude turns with missing usage from token and cost denominators, but report
their count.

| Metric | Baseline | Ship gate |
|---|---:|---:|
| Task success | Not established | No statistically meaningful regression; zero new correctness or data-integrity failures |
| Billed input tokens per successful task | Not established | At least 10% lower median on the evaluation corpus |
| Cost per successful task | Not established | At least 10% lower median on the same model and price snapshot |
| Cached-input share on eligible steady-state turns | Trace report available; corpus baseline missing | Improve over baseline; do not use a universal 95% target |
| Summary calls | Trace report available; corpus baseline missing | Zero on short tasks; no increase on long tasks |
| Revisions and overflow retries | Trace report available; corpus baseline missing | No increase unless task success improves |
| p50 and p95 time to first token / turn time | Trace report available; corpus baseline missing | No material regression |
| Waste attribution coverage | Partial heuristic | Every miss above the noise floor has a route-correct cause or an explicit `unknown` cause |

`cacheRead / (input + cacheRead + cacheWrite)` is a diagnostic, not the primary
goal. First turns, short prompts, revisions, model changes, long idle gaps, and
provider-side eviction can all make a high global cache target impossible or
misleading. Context fill is also a safety signal, not something to maximize:
the current 60%-80% values are reclamation hysteresis thresholds, not measured
steady-state context usage.

Do not claim superiority over another harness without a reproducible public
benchmark that controls the model, effort, task inputs, tool access, completion
criteria, retries, and price snapshot.

## P0 - establish truth and fix correctness gaps

### 1. Freeze a reproducible baseline

**Owners:** `scripts/agent-core-trace-report.mjs`,
`scripts/agent-core-trace-report-test.mjs`, and a checked-in evaluation manifest.

- Define short, tool-heavy, long-context, image, MCP, resume, compaction, and
  idle-gap cases. Include success criteria and expected file outcomes.
- Require `npm run test:agent-core` and `npm run test:agent-core-report` to be
  green before recording a baseline and after every experiment. Record and fix
  existing failures before attributing a regression or improvement.
- Run each case multiple times on the same pinned model and effort. Record the
  provider-reported usage, task success, retries, time to first token, total
  time, revisions, and tool calls.
- Record the price-catalog timestamp and the number of turns with unknown cost.
  Never compare a known-cost run with a partially priced run.
- Add per-provider, per-model, and per-session-length output to
  `npm run report:agent-core`. Keep raw traces so an aggregate can be audited.
- Compare only successful tasks. Also report failure rate separately so a
  cheaper failed run cannot look efficient.

**Validation:** Running the reporter twice over the same trace directory must
produce byte-identical JSON. Malformed, oversized, partial, and missing-usage
trace files must be counted without corrupting the denominator.

### 2. Make cache keys valid, stable, private, and route-scoped

**Owners:** `agent-core/auth.ts`, `agent-core/main.ts`, and
`scripts/agent-core-harness-test.mjs`.

The current `cacheSessionKey` permits 256 characters. The OpenAI Responses API
documents a 64-character maximum. An empty terminal id also disables the cache
key unless `TERMINA_CORE_SESSION_ID` is set.

- Produce a deterministic, privacy-preserving key of at most 64 characters
  from the canonical run/session identity. Do not hash the empty string: that
  would make unrelated standalone sessions share one bucket.
- When no durable session identity exists, generate one process-scoped random
  id once and reuse it for the life of the run.
- Include a short route or prompt-schema version only if an evaluation shows
  cross-family routing collisions. Prefix matching already protects content;
  speculative version churn fragments cache affinity.
- Keep host-specific session headers and body `prompt_cache_key` derived from
  the same canonical key.
- Reject control characters before hashing or sending any raw identifier.

**Validation:** Cover empty, whitespace, control-character, Unicode, very long,
standalone, resumed, forked, and two-concurrent-session cases. Assert a maximum
of 64 characters, stability within one run, separation across unrelated runs,
and no raw terminal or filesystem identifier in the outgoing key.

### 3. Attribute cache misses using the effective route policy

**Owner:** `agent-core/main.ts`; report changes stay in the existing trace
reporter.

`reportUsage` currently labels every gap above five minutes as `idle-expired`.
That is not valid for direct Anthropic requests marked with a one-hour TTL or
GPT-5.6 requests using a 30-minute TTL.

- Derive the diagnostic expiry from the request actually sent: provider,
  protocol, model, cache mode, TTL, and fallback state.
- When retention is implicit or undocumented for a relay, report
  `possible-idle-expiry`, not a definite expiry.
- Preserve the existing `post-revision`, key, model-settings, tool-schema,
  stable-prefix, message-prefix, and working-set diagnostics. Add
  `message-prefix-changed` before falling back to `backend-or-prefix-miss`.
- If an explicit-cache request falls back after a provider rejection, trace the
  effective fallback policy, not the rejected request body.

**Validation:** Use a fake clock at 4, 6, 29, 31, 59, and 61 minutes for 5-minute,
30-minute, one-hour, and unknown-retention routes. Test model switches,
revisions, fallback retries, missing usage, and a smaller current prompt.

### 4. Make the working set genuinely request-only

**Owner:** `agent-core/main.ts`.

The design says the working-set overlay is request-only, but the current path
passes it to `pushUserPrompt`, which persists it in session history. This grows
the append-only log with regenerated host context and makes later cache and
replay behavior harder to reason about.

- Persist the user prompt and user-selected images once. Build file inventories
  and host context only in the provider request projection.
- Hash the exact outgoing overlay bytes for diagnostics. Do not hash the whole
  repository walk: files that were not sent cannot invalidate a provider
  prefix.
- Keep `@` expansion in the persisted user prompt when it is part of what the
  user submitted to the model. Its effect belongs to `messagePrefixHash`.
- Keep paths from `read_file`, `write_file`, and `edit` in the deterministic
  inventory. Preserve the existing cap and omission marker.
- On Anthropic, stamp the reusable history before appending the volatile
  overlay. On OpenAI-family requests, keep the volatile tail after any explicit
  breakpoint. Images and missing-image placeholders must remain in the same
  user turn and in their original order.

**Validation:** Assert that the session JSONL contains no generated
`<working-set>` block, while the outgoing request contains it exactly once.
Cover no overlay, host-only context, inventories only, images, missing images,
`@` expansion, resume, fork, compaction, retry, and two consecutive user turns.
Replay must reconstruct the same persisted conversation without requiring the
old host-context file.

### 5. Make bounded tool output honest

**Owner:** the existing tool implementations in `agent-core/main.ts`.

`read_file`, `grep`, and `bash` already have caps and recovery information.
`grep` already groups results by file and limits the visible page. Do not
replace it with a second formatter. The concrete gap is `glob`: it stops at 200
matches without saying that results were omitted.

- Make `glob` return a deterministic omission marker and a narrower follow-up
  pattern suggestion when it hits the match, visit, or time budget.
- Preserve UTF-8 boundaries, deterministic ordering, jail checks, ignored-path
  behavior, and the existing event-loop yielding in walks.
- Keep bash's exit status and reproduction command. Any future stdout/stderr
  split must remain bounded independently so a noisy stream cannot evict the
  only useful error text.

**Validation:** Cover exactly 199, 200, and 201 glob matches; visit-cap and
timeout exits; symlink loops; ignored paths; unreadable directories; Unicode
paths; interrupted walks; and zero matches. Output must remain bounded and
deterministic.

## P1 - optimize measured tail dominance

Start these only after P0 produces a baseline that identifies the dominant
token source.

### 6. Reclaim repeated tool payloads without losing recovery

- Use trace data to rank tool-output bytes by tool and age at reclamation.
- Prefer existing range/offset reads and executable stubs before adding a new
  representation.
- Do not assume the model still has an earlier file body after resume,
  compaction, fork, or reclamation. A diff-only `read_file` response is invalid
  unless the base content is identified and still present in the visible
  context.
- Do not add a second file snapshot store in `agent-core`; `core/` remains the
  canonical snapshot owner. If repeated full-file reads dominate, first test an
  unchanged receipt keyed by a content hash with an automatic full-read
  fallback.

**Ship gate:** At least 10% lower median billed input on the affected corpus,
with no extra tool call at p95 and successful recovery after resume,
compaction, external file modification, and a stale base hash.

### 7. Prove and preserve tool-schema byte stability

JavaScript object order is deterministic for a fixed construction path;
`JSON.stringify` does not randomly reorder keys. Hashing a sorted copy would
not help if the provider still receives different bytes.

- Capture the exact serialized tool array sent to each protocol and compare it
  across adjacent requests.
- Keep built-in tools in their canonical order. Freeze MCP tools at process
  start as the kernel already intends. If MCP discovery order is unstable,
  normalize it once before both request construction and diagnostic hashing.
- A mid-session MCP reconnect that changes the tool set is a prompt revision;
  trace it explicitly or start a new session. Do not maintain old and new tool
  paths together.

**Ship gate:** A deterministic test must produce byte-identical tool payloads
from semantically identical MCP discovery results with different arrival
orders.

### 8. Evaluate cache breakpoints from observed block deltas

Anthropic checks at most 20 block positions per explicit breakpoint. OpenAI
GPT-5.6 currently considers up to 80 recent breakpoints and documents no
content-block lookback limit. Do not apply one provider's rule to another.

- Trace the number of eligible Anthropic content blocks added between adjacent
  requests and the position of each marker.
- Add a second Anthropic history anchor only if real requests approach the
  20-block window. A rescue marker must be written before the old entry leaves
  the lookback window; adding it after a miss cannot recover that request.
- Stay within the four-breakpoint limit, including automatic or server-tool
  markers. Test mixed TTL ordering and provider rejection.

**Ship gate:** The synthetic 19/20/21-block cases and a representative live
corpus must show fewer full-prefix misses without more provider errors or higher
median cache-write cost.

### 9. Treat cache thresholds and TTLs as experiments, not constants

- Maintain provider/model threshold data only for routes where the official
  API defines it. Unknown relay models must default to provider behavior, not a
  guessed family table.
- A below-threshold marker is not proven to incur a cache-write surcharge when
  provider usage reports zero write tokens. Add a minimum-length guard only if
  traces show billed cache-write tokens or a latency/error benefit.
- Do not switch Anthropic TTL from the previous inter-turn gap alone. The prior
  gap does not predict the next one, TTL changes can fragment entries, and a
  one-hour write has a different price. Compare fixed 5-minute and one-hour
  policies on observed cadence with a break-even calculation.
- Do not add `prompt_cache_retention`; OpenAI marks it deprecated. Use only
  current `prompt_cache_options` fields supported by the selected model and
  protocol.

**Ship gate:** Lower measured cost on the same task corpus after including
cache writes, reads, storage charges where applicable, and idle misses.

## P2 - frontier work, only after profiling

### 10. Optimize summarization only if it is material

The summary lane already asks for thinking/reasoning off. Local `grep` and
`glob` do not make model classification calls. Reusing the main session cache
key cannot create a hit when the summary request has a different prefix.

- Measure summary input, output, reasoning, latency, and task-success impact as
  a separate role.
- If repeated summaries share a cacheable prefix, give the summary role its own
  stable key and verify a real hit. Do not share the main role's key.
- Prefer fewer summaries through reclamation before optimizing summary-call
  caching.

### 11. Calibrate token estimates before adding a tokenizer

The current `ceil(chars / 3)` estimate is intentionally conservative and
provider usage is authoritative after a request. Exact tokenization differs by
provider and model; adding two tokenizer dependencies does not make every route
exact.

- Record estimated versus provider-reported input by model and content class
  (code, English prose, non-English text, JSON, and image placeholders).
- Adjust a small route-specific conservative factor only if estimation error
  causes measured premature reclamation or overflow retries.
- Add a tokenizer dependency only if it materially improves those failures and
  does not block the agent process or enlarge the desktop hot path.

### 12. Investigate provider-specific caching separately

- Gemini implicit caching is automatic only on supported model families and
  has model-specific minimums. Benchmark it before introducing explicit cache
  object lifecycle, storage charges, or cleanup state.
- OpenRouter, OpenCode Zen, Codex, Copilot, and xAI are separate contracts.
  Feature-probe optional fields and trace fallbacks. Do not infer support from
  an underlying model name alone.
- Never create a second protocol mapper or cache engine. Extend the canonical
  owners in `agent-core/auth.ts`, `agent-core/openai-compat.ts`, and
  `agent-core/main.ts`.

## Validation questions for every change

1. Does this reduce provider-billed tokens or cost, or only local bytes and an
   estimate?
2. Is the comparison on the same model, effort, prompt, tools, task outcome,
   retry policy, and price snapshot?
3. Does the metric exclude failed tasks or make their higher failure rate
   visible?
4. Which exact provider and protocol document the field, TTL, threshold, and
   breakpoint behavior?
5. What happens on the first turn, a below-threshold prompt, an idle gap, a
   provider eviction, a 429 retry, and an explicit-cache fallback?
6. What happens after resume, fork, compaction, truncation, model change, MCP
   reconnect, and external file modification?
7. Can an optimization hide data the model can no longer recover from the
   visible context or an executable tool call?
8. Does it keep the session log append-only and keep request-only data out of
   persisted history?
9. Does it preserve image order, tool-call/result pairing, UTF-8 boundaries,
   jail rules, and bounded memory?
10. Is the implementation in the canonical owner, with no compatibility path,
    duplicate formatter, cache engine, tokenizer layer, or snapshot store?
11. Does it keep the main process responsive and avoid larger IPC payloads?
12. Can the trace explain both an improvement and a regression without reading
    raw provider traffic?

If any answer is unknown, add instrumentation or a controlled experiment
before adding the optimization.

## Official sources checked on 2026-08-30

- Anthropic prompt caching:
  `https://platform.claude.com/docs/en/build-with-claude/prompt-caching`
- OpenAI prompt caching and Responses fields:
  `https://developers.openai.com/api/docs/guides/prompt-caching`
  and `https://developers.openai.com/api/reference/resources/responses/methods/create`
- OpenAI GPT-5.6 guidance:
  `https://developers.openai.com/api/docs/guides/latest-model`
- Gemini context caching:
  `https://ai.google.dev/gemini-api/docs/generate-content/caching`

Re-check these sources in the implementation turn. Model support, limits,
field names, prices, and retention rules are not stable repository facts.
