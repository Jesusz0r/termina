# Agent-core caching strategy — deep audit (2026-05-11)

> Live doc check in this turn: Anthropic prompt caching, OpenAI prompt caching, Gemini implicit caching. All claims below cite those pages or the kernel source itself (`agent-core/auth.ts`, `agent-core/openai-compat.ts`, `agent-core/main.ts`).

---

## 1. What the kernel does today

### 1.1 Anthropic Messages path (`providerProtocol === anthropic-messages`)

- **Prefix** `buildCachedPrefix(system, tools, provider)` stamps one `cache_control` marker on the single `system` block and one on the **last** `tools` entry (`type: ephemeral`, `ttl: 1h` on direct `anthropic`, ephemeral otherwise) — `main.ts:2997`.
- **History tail** `stampHistoryCache(requestMessages, provider)` walks backward and stamps `cache_control` on the last eligible block (`text | tool_result | image`, skipping `thinking`/`tool_use`) — `main.ts:3013`. That marks the current append-only prefix: `tools → system → messages` hierarchy per Anthropic docs.
- **Budget** ≤3 breakpoints per turn (system, last tool, history tail) → stays under the Anthropic limit of 4, leaves one slot free. No top-level `cache_control` automatic caching that would fight the explicit markers.

### 1.2 OpenAI Responses / Completions path (GPT, Grok, Qwen, Codex, OpenRouter, Zen)

- **Session pin** `cacheSessionKey(sessionId)` (sanitized `TERMINA_TERMINAL_ID`) is sent as `prompt_cache_key` on every Completions/Responses request when `usesPromptCacheKey(provider, model)` is true, and as `x-session-id` / `x-opencode-session` / `x-grok-conv-id` header where the host expects it — `auth.ts:291, auth.ts:298, main.ts:3951`.
- **Explicit prefix** for GPT-5.6 Sol/Terra/Luna only: `prompt_cache_breakpoint: {mode: explicit}` on the prefix input, skipping the volatile tail via `markPrefixThenTail` (all but last input), plus `prompt_cache_options: {mode: explicit, ttl: 30m}` when `usesPromptCacheOptions` is true (`openai` + `openrouter` only) — `openai-compat.ts:488, main.ts:4097`. Falls back with `stripResponsesBreakpoints` on 400 `prompt_cache_breakpoint is not supported`.
- **Fallback implicit marker** for hosts that relay Anthropic caching (OpenRouter + Claude/Qwen): `cache_control: {type: ephemeral}` on the prefix via `cacheControl: true` — `openai-compat.ts:495`.

### 1.3 Google `generateContent` path (Gemini via direct Google or Zen)

- No `prompt_cache_key`, no `prompt_cache_breakpoint`. Body is `contents + systemInstruction + tools` with `thinkingConfig` only — `openai-compat.ts:336`. Relies entirely on Gemini **implicit** caching; bearer is stripped and re-sent as `x-goog-api-key` per `googleNativeHeaders`.

### 1.4 Observability

- `cacheDiagnosticsForRequest` hashes `cacheKey`, `modelSettings`, `tools`, `stablePrefix {system, tools}`, `messagePrefix`, and the live `workingSetHash` — `main.ts:2249`.
- `reportUsage` computes waste as `min(prevTotal, curTotal) - cacheRead` when `> NOISE_FLOOR_TOKENS` and classifies cause (`idle-expired`, `cache-key-changed`, `model-settings-changed`, `tool-schema-changed`, `stable-prefix-changed`, `working-set-changed`, `backend-or-prefix-miss`) — `main.ts:4411`.
- Expensive miss triggers compaction before the context limit: `billedTokens ≥100k && contextTokens ≥100k && cacheReadShare <0.5` — `main.ts:3524`.

---

## 2. What we do well

| Area | Why it is good |
|---|---|
| **Correct breakpoint placement** | Anthropic tail marker is on the **last stable** history block, not on the new user prompt. Docs explicitly warn: putting the breakpoint on the varying block (timestamp / new user message) creates a new hash every turn and never hits. Our backward walk + `HISTORY_CACHE_BLOCKS` skip does the right thing. |
| **Hierarchy respected** | `tools → system → messages` order matches Anthropic's prefix order. Changing `tools` invalidates everything after, so pinning the last tool is cheaper than pinning the first. |
| **Budget discipline** | 3 explicit markers vs 4 max → no 400 `no slots left`. Single history tail vs per-message markers → the 20-block lookback window stays useful (docs: lookback is 20 positions per breakpoint). |
| **TTL choice** | Direct Anthropic uses the sliding 5-minute default, avoiding the 1-hour write premium during rapid interactive sessions. Trace reports bucket observed idle gaps so production data can show whether 5–60 minute resumptions justify moving to 1 hour. |
| **Session pin** | `prompt_cache_key = sessionId` stabilizes routing for OpenAI-family hosts (docs: key influences shard hash, mitigates overflow misses at >15 rpm). Same key also drives `x-session-id` / `x-opencode-session` / `x-grok-conv-id` headers per host contract. |
| **Explicit-only for GPT-5.6** | Uses the provider's newest knob (`prompt_cache_options.mode: explicit` + manual breakpoint) only where docs say it exists (GPT-5.6 Sol/Terra/Luna). Avoids implicit breakpoint pollution and extra 1.25× write charge on stable prefixes. Correctly skips `prompt_cache_options` on Codex/Zen that return 400 `Unsupported parameter`. |
| **Prefix-vs-tail split** (`markPrefixThenTail`) | Keeps the volatile last input out of the cached prefix, so the previous turn's prefix can hit. Mirrors OpenAI guidance: stable instructions first, dynamic suffix after the breakpoint. |
| **Graceful fallback** | `stripResponsesBreakpoints` on 400 removes both `prompt_cache_breakpoint` and `prompt_cache_options` and retries once — verified in `main.ts:4129`. Prevents hard failure when a model/host unexpectedly rejects explicit caching. |
| **Attribution** | Hashing `tools`, `stablePrefix`, `workingSet` separately makes `stable-prefix-changed` vs `working-set-changed` actionable in traces, not just `backend-or-prefix-miss`. |
| **Cost-aware compaction** | Compact on an expensive miss (`100k` + `<50% hit`) is rare in well-cached sessions but saves a future OOM truncation — the right tradeoff vs compacting on every miss. |

---

## 3. What is weak, risky, or wrong

### 3.1 High-signal

1. **Single history breakpoint is fragile on long gaps.** Docs: each breakpoint has a 20-block lookback. Our history tail is the *only* lookup into the growing conversation. In turn 3 example from docs, a 25-block gap pushes the prior write one slot outside the window → miss even though the prefix is stable. With two breakpoints (e.g., after the system/tools block **and** at the history tail) the window doubles. For sessions that accumulate 20+ tool results between turns, a second anchor would pay for itself.
2. **No minimum-length guard.** Anthropic minimum is 1,024 tokens (Sonnet 5 / 4.6) to 4,096 tokens (Opus 4.5/4.6) depending on model/platform; OpenAI minimum is 1,024 (GPT-5.6) / 2,048 (older). We still pay the 25% (Anthropic) / 1.25× (OpenAI explicit) write surcharge even when `cache_creation_input_tokens == 0` — a pure loss on short sessions. The trace already records `cacheWrite == 0` but does not suppress the *next* write. A `tokenEstimate < 1_024` guard should skip stamping.
3. **`prompt_cache_key` can be empty or unstable.** `cacheSessionKey` returns `""` for missing `TERMINA_TERMINAL_ID` → `sendCacheKey === false` → every turn is ungrouped and spills across machines under load. Idempotent sessions must still hash to one stable key; an empty key defeats routing at exactly the high-traffic moment it is meant to help.

### 3.2 Medium-signal

4. **Working-set hash churn is opaque.** `currentWorkingSetHash` is set from the file walk but `reportUsage` only labels `working-set-changed` after the fact. A single untracked file (`@` attach, `write_file` outside the walk) can invalidate the cache while the bill shows `backend-or-prefix-miss`.
5. **Tool changes always invalidate, even when they should not.** Adding `_uses` to `web_search` vs reordering tools differently: reordering still changes the prefix hash on Anthropic, but `additional_tools` (Responses) intended for stable `requestTools` history is not yet fully wired for tool-count growth.
6. **Google summarization cost is hidden.** The cheap lane (`summaryRoute` = `haiku-4-5` / `luna` etc.) is not cached against the main session key. Summaries run once per turn today, but if reclamation triggers twice in a long session the summary model pays full input price each time with no pin.
7. **OpenRouter relay double-marks are wasteful.** On OpenRouter + Claude we send both `cache_control` (via `cacheControl`) **and** the usual Anthropic markers through the relay — docs say OpenRouter strips/forwards, but we still occupy two of our 4 slots for one logical breakpoint.

### 3.3 Low-signal / polish

8. **TTL should follow observed idle gaps.** The 5-minute default is cheapest for bursts, while 1 hour only helps resumptions after 5–60 minutes and doubles write cost. Trace reports now expose those idle-gap windows; change the default only when production evidence supports it.
9. **No cache-hit rate dashboard.** Data exists in `usage.cacheRead / total` per turn and `lastCacheReadShare` but the TUI only shows `tokens in/out · cache 42%`. A sparkline or `hit < 80%` warning would surface regressions faster than scanning `traces.ndjson`.
10. **Tests cover prefix shape, not cost.** `reportUsage`, `retryAfter`, etc. have unit coverage; the 20-block lookback + TTL + minimum-length interaction does not.

---

## 4. Provider-by-provider alignment with official docs

### Anthropic (`api.anthropic.com` — live doc: `platform.claude.com/docs/en/build-with-claude/prompt-caching`)

- **Limit 4 breakpoints** — we use 3. Correct. Recommends: keep explicit breakpoints on *stable* prefix.
- **Order `tools → system → messages`** — we follow it. Docs stress changing `tools` invalidates later layers; we pay one `cache_write` for tools each time tools change — expected.
- **Lookback 20 per breakpoint** — see §3.1.1. With one history marker we have one 20-wide window. Docs example with a 25-block gap misses at 20; a second marker fixes it.
- **TTL** `ephemeral` defaults to 5m; `ephemeral + ttl: 1h` costs more. `anthropicCacheMark` intentionally omits `ttl`, using the sliding 5-minute lifetime. Reports separate cold/warm shares and bucket idle gaps into ≤5m, 5–60m, and >1h windows before any future TTL decision.
- **Auto caching** exists on every platform except legacy Bedrock (uses explicit only). We use explicit — fine, avoids Bedrock 400 `top-level cache_control` error docs call out.
- **Pricing note** — if both `cache_creation` and `cache_read` are 0, prompt was below minimum. We do not yet suppress stamping in that case.

### OpenAI (`api.openai.com` — live doc: `developers.openai.com/api/docs/guides/prompt-caching`)

- **Minimum** 1,024 (GPT-5.6+) / 2,048 (older). We do not gate on it — gap.
- **Breakpoints** placed *after* eligible content; first request writes, later reads the longest matching prefix. We correctly use `markPrefixThenTail` so the breakpoint ends before the volatile tail.
- **Explicit vs implicit** GPT-5.6+ supports both; earlier models implicit only. Our `usesOpenAIExplicitCache` (leaf starts with `gpt-5.6` + provider in `openai|openrouter|opencode-zen`) and `usesPromptCacheOptions` (subset `openai|openrouter`) match docs: `prompt_cache_options.mode: explicit` only on GPT-5.6+ and rejected by Codex/Zen. Correct.
- **Slots** Up to 4 writes per request; reads consider up to 50 breakpoints. We use 1 explicit write (prefix) + `prompt_cache_key` routing; within limit.
- **Routing** `prompt_cache_key` is the documented grouping knob against overflow routing. Our session-id key is exactly the `stable user/workspace/session/thread` pattern docs recommend. Gap: we should document the key as `termina:${sessionId}:${route.model}` versioning so prompt version changes do not falsely share a prefix.
- **Retention** GPT-5.6 explicit TTL `30m` is our default; older implicit uses `prompt_cache_retention: 24h`. We use `30m` only when explicit — correct. Not yet exposing `24h` for GPT-5.5/Codex where docs say it is the only retention.

### Google Gemini (`ai.google.dev/gemini-api/docs/caching` + Interactions API note)

- **Implicit caching** enabled by default for Gemini 2.5+ on the Interactions API; **explicit cachedContent** only on `generateContent` API, not on Interactions. Our `google-generate` path correctly does *no* manual caching work and pays no breakpoint — aligns with `Note: Interactions API only supports implicit caching`. No action needed besides monitoring `usage.total_cached_tokens`.
- **Future opportunity** If the harness ever moves to long-lived `cachedContent` objects (explicit Gemini), it would need a separate lifecycle (create/refresh TTL up to 1h–48h per model). Not warranted for an append-only chat that already hits implicit cache.

### xAI Grok (`docs.x.ai` — live doc not fully fetched in this turn)

- Kernel routes Grok via `openai-responses` with `prompt_cache_key` (= session) and no explicit breakpoint (`usesOpenAIExplicitCache` returns false for `grok*`) — consistent with xAI's current OpenAI-compatible surface. If Grok adopts GPT-5.6-style explicit breakpoints later, extending `usesOpenAIExplicitCache` to `grok-4.x` with a feature probe is the narrow change.

### OpenRouter / OpenCode Zen (relays)

- Both hosts multiplex models behind one credential (`zenWireProtocol` picks protocol from `model` leaf). Our `usesAnthropicCacheMarkers` (relay + `claude|qwen` leaf) and `usesPromptCacheKey` correctly follow the model, not the login. Side invariant: `providerProtocol(opencode-zen, model)` must stay the source of truth for every cache branch — it does.
- OpenRouter docs confirm `prompt` relay: `cache_control` blocks are forwarded to Anthropic. Stripping logic already exists for the opposite direction (`stripResponsesBreakpoints`). No change needed, but see double-mark note in §3.2.7.

---

## 5. Verdict

**Good:** The strategy is model-aware, not provider-naive. Prefix vs tail split, explicit-only on GPT-5.6, session-key routing, and waste attribution are all aligned with the live vendor guides. For the canonical session (long-lived TUI, Claude Sonnet/Opus or GPT-5.6 Sol, tools stable) hit rates will be high.

**Bad:** The single-tail 20-block window + no minimum-length guard are the two places we pay without learning. Everything else is medium/low polish. Fix those two and the remaining gaps are observability, not dollars.

---

## 6. Concrete next steps (in priority order)

1. **Guard short prompts.** Add `if (tokenEstimate(prefix) < minCacheableFor(model)) return messages` before stamping. `minCacheableFor` = mapping from live docs table (512 Opus 5/Fable, 1,024 Sonnet 5/4.6, 2,048 Haiku 3.5 / Opus 4.7, 4,096 Haiku 4.5 / Opus 4.5/4.6 on Anthropic; 1,024 GPT-5.6 / 2,048 older on OpenAI). Saves 25% on every short turn.
2. **Add a second history anchor.** Stamp `cache_control` at the *old* tail (previous turn's marker) in addition to the new tail when `history.length - lastMarkerDistance > 15`. Keeps the 20-block window overlapping across turns; one extra `cache_write` every ~15 tool blocks.
3. **Stabilize `prompt_cache_key`.** Ensure `TERMINA_TERMINAL_ID` is always set (fallback to `sessionId` hash) and key it as `${promptVersion}:${sessionId}` where promptVersion changes only when `systemPrompt` or `clientTools` change. Prevents empty-key routing spills.
4. **Tune TTL by gap.** Record `interTurnGapMs`; use `ttl: 1h` only when `gap > 4m` or `expectedIdle > 10m`, else 5m. Halves write cost for bursty sessions.
5. **Expose `prompt_cache_retention: 24h` for GPT-5.5/Codex.** Minor retention knob where docs say `in_memory` is the ZDR default.
6. **Dashboard the hit rate.** TUI line already has `cache 42%`; add a `hit < 50% for 3 turns → hint` and a `traces` sparkline. No protocol change.

---

## 7. References checked in this audit

- Anthropic prompt caching — `https://platform.claude.com/docs/en/build-with-claude/prompt-caching` (4-block limit, 20-block lookback, `cache_control` hierarchy, TTL `1h` beta, minimums table).
- OpenAI prompt caching — `https://developers.openai.com/api/docs/guides/prompt-caching` (minimum 1,024/2,048, `prompt_cache_key`, `prompt_cache_options.mode` explicit/implicit, `prompt_cache_breakpoint`, 4 writes / 50 read breakpoints, shard routing).
- Google Gemini caching overview — `https://ai.google.dev/gemini-api/docs/caching` (implicit default on 2.5+, explicit via `cachedContent` only on `generateContent`, `total_cached_tokens`).
- In-repo: `agent-core/auth.ts: usesAnthropicCacheMarkers, usesPromptCacheKey, usesOpenAIExplicitCache, usesPromptCacheOptions, cacheSessionKey, cacheSessionHeaders, providerProtocol`
- In-repo: `agent-core/openai-compat.ts: responsesBody, completionsBody, googleGenerateBody, markPrefixThenTail, stripResponsesBreakpoints`
- In-repo: `agent-core/main.ts: buildCachedPrefix, stampHistoryCache, cacheDiagnosticsForRequest, reportUsage, providerPost, callModel, CACHE_TTL_MS`

