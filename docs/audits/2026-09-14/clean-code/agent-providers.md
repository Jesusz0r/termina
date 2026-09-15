# Clean Code / YAGNI / KISS — agent-core providers

**Date:** 2026-09-14 (written 2026-09-15)  
**Scope:** exclusive — provider / auth / protocol / catalog.  
**Mode:** AUDIT ONLY. No production or test edits. No tickets opened.

Owners (AGENTS.md): `agent-core/auth.ts` is the only auth/provider policy owner; `agent-core/models.ts` the only live catalog; `agent-core/main.ts` / `openai-compat.ts` own requests; `agent-core/cache.ts` owns cache diagnostics. This report does **not** recommend a second catalog, cache, or protocol mapper.

This audit is about **code shape**. Live provider field names below are cited only as they already appear in-tree; no provider docs were fetched this turn and no protocol bugs are claimed.

Already ticketed unused-export sweep: [#335](https://github.com/Jesusz0r/termina/issues/335) (`rates.ts` types, capabilities types, test-only exports). Adjacent but **out of this domain:** [#326](https://github.com/Jesusz0r/termina/issues/326) (4+ arg functions in session-search / worldlines / prefs), [#325](https://github.com/Jesusz0r/termina/issues/325) (`scripts/` provider probes).

Skipped: `agent-core/main.ts` tool surface, TUI, trace, host, subagents, session; `node_modules`, `dist`, `docs/audits/2026-09-13`.

---

## Inventory

### Production (51 files, 9736 lines)

| Area | Files | Lines | Largest |
|---|---:|---:|---|
| `agent-core/auth.ts` + `auth/` | 23 | 4523 | `auth/lock.ts` 816, `auth/login.ts` 612, `auth/oauth.ts` 551 |
| `agent-core/models.ts` + `models/` | 11 | 1258 | `models.ts` 508, `models/capabilities.ts` 401 |
| `agent-core/openai-compat.ts` + `openai-compat/` | 10 | 1842 | `responses-stream.ts` 363, `google.ts` 295, `sse.ts` 289 |
| `agent-core/cache.ts` | 1 | 698 | — |
| `agent-core/rates.ts` | 1 | 606 | — |
| `agent-core/mcp.ts` + `mcp/` | 5 | 1508 | `mcp/client.ts` 640, `mcp/results.ts` 359 |

Entry files (`auth.ts`, `openai-compat.ts`, `mcp.ts`) are re-export barrels from the #38 split. That is the intended single public surface, not a second owner.

### Matching tests

Strict name globs from the brief (`auth-*`, `models-*`, `openai-*`, `cache-*`, `rates-*`, `mcp-*`, `provider-*`, `catalog-*`, `token-calibration*`, `protocol*`): **24 files, 9345 lines**.

Also read (same domain; names do not match the hyphen globs): `cache.test.ts` (486), `rates.test.ts` (395), `mcp.test.ts` (366). Adjacent, not counted: `model-family-refactor.test.ts`, `model-security.test.ts`, `opencode-protocol.test.ts`.

Largest matching fixtures: `cache-experiment.ts` 2061, `provider-probe.ts` 1282, `provider-cache-policy.test.ts` 932. Those pin current cache/protocol shape; they are not a second catalog.

---

## Counts

| | NEW | ALREADY-TICKETED | Total |
|---|---:|---:|---:|
| **P1** | 2 | 0 | 2 |
| **P2** | 9 | 2 | 11 |
| **P3** | 5 | 2 | 7 |
| **Total** | **16** | **4** | **20** |

---

## Findings

### F1 — Serializers re-decide cache fields after the policy owner already gated them

- **path:line:** `agent-core/openai-compat/completions.ts:130`, `agent-core/openai-compat/responses.ts:223`
- **principle:** YAGNI / one owner
- **priority:** P1
- **NEW vs ALREADY-TICKETED:** NEW
- **as-is:** `documentedCacheCapability` in `auth/cache-policy.ts` is the documented capability matrix. The request owner (`main.ts`, out of edit scope) already consults it and only passes `cacheKey` / `sessionId` / `explicitCacheBreakpoint` / `promptCacheMode` when supported. `applyCacheOpts` then re-filters with `modelLooksGemini` / `opencode-zen` / `openrouter`, and `responsesBody` builds a second `explicitRoute` (`openai` \| `openrouter`, not Gemini) before emitting `prompt_cache_options` / `prompt_cache_breakpoint`. `cacheControl` is a third OpenRouter-only arm.
- **should-be:** Serializers emit the fields the caller asked for. Cache-route policy stays in `auth/cache-policy.ts`. One consult site.
- **smallest fix:** Delete the gemini/zen/`explicitRoute` re-gates. Keep Codex `max_output_tokens` omission (that is a wire-shape rule, not a cache matrix).
- **what NOT to do:** Do not add a third capability table inside `openai-compat/`. Do not move catalog or request construction into `cache.ts`.

### F2 — Family identity is encoded in five places

- **path:line:** `agent-core/auth/resolve.ts:61`, `agent-core/auth/providers/opencode-zen.ts:12`, `agent-core/models/capabilities.ts:28`, `agent-core/auth/providers/openai.ts:10`, `agent-core/models/capabilities.ts:293`
- **principle:** KISS / one owner
- **priority:** P1
- **NEW vs ALREADY-TICKETED:** NEW
- **as-is:** `models/families/*` already owns leaf identity (`modelLooksClaude`, `modelLooksGemini`, `modelLooksQwen`, `museSparkReasoningFamily`, `isGpt56OrLaterModel`, `oSeriesModel`). Parallel copies:
  - `parseModelRef` uses `startsWith("claude"|"haiku"|"grok"|"gemini"|"gemma")` and `/^(gpt-|o1|o3|o4|chatgpt)/` (no `o2`, no family helpers).
  - `zenWireProtocol` re-tests Claude/Qwen/Gemini plus a GPT/codex/grok/muse-spark regex.
  - `RESPONSES_REASONING_FAMILIES` is another `/gpt-[5-9]/|/codex/|/grok/|/muse-spark/` list.
  - Official OpenAI `catalog.acceptsId` accepts `claude|grok|gemini|gemma|deepseek|…` as if `api.openai.com` listed those ids.
  - `includeEncryptedReasoning` / `defaultContextWindow` use `leaf.startsWith("grok")` instead of the xAI family helper.
- **should-be:** Family predicates in `models/families/` are the only identity tests. Catalog `acceptsId`, `zenWireProtocol`, `parseModelRef`, and effort-family membership call those helpers (or a one-line composition next to them).
- **smallest fix:** Replace the ad-hoc regexes with the existing family helpers. Narrow OpenAI `acceptsId` to OpenAI ids (`gpt-`, `o[0-9]`, `chatgpt`) unless a checked-in `OPENAI_BASE_URL` fixture requires the wide net.
- **what NOT to do:** Do not add a new identity module or a second catalog parser. Do not invent model-id rules from memory.

### F3 — `CompletionsOpts` is a three-protocol kitchen sink with a dead native-Google cache field

- **path:line:** `agent-core/openai-compat/types.ts:59`, `agent-core/openai-compat/google.ts:156`
- **principle:** YAGNI
- **priority:** P2
- **NEW vs ALREADY-TICKETED:** NEW (tests from #203/#216 *keep* the dead field; they do not ticket removing it)
- **as-is:** One options bag feeds Completions, Responses, and `generateContent`. It carries Completions-only (`googleThinking`, `sessionId`), Responses-only (`promptCacheMode`, `explicitCacheBreakpoint`, `explicitCacheSkipTail`, `includeEncryptedReasoning`, `reasoningContext`, `textVerbosity`), and a native `cachedContent` that `googleGenerateBody` emits only when `opts.provider === "google"`. The `google` provider’s `protocol()` is always `openai-completions`. Production `googleGenerateBody` calls (Zen Gemini) never pass `cachedContent`. `promptCacheMode: "implicit"` has no writer.
- **should-be:** Shared fields stay on a small opts object (`provider`, `maxTokens`, `reasoningEffort`, `cacheKey`). Protocol-specific fields live next to that protocol’s body builder, or are omitted until a caller exists.
- **smallest fix:** Drop `cachedContent` / `isGoogleCachedContentName` / `promptCacheMode: "implicit"` and the tests that only assert the unused serializer field. Keep Zen `google-generate` as the live native path (no `cachedContent`).
- **what NOT to do:** Do not implement Google context-cache CRUD. Do not claim `google-cached-content` as supported. Do not add a second cache mapper.

### F4 — Capability-feature enum lists arms the matrix never supports

- **path:line:** `agent-core/auth/cache-policy.ts:21`
- **principle:** YAGNI
- **priority:** P2
- **NEW vs ALREADY-TICKETED:** NEW (the *export* of the const is live; the unused *keys* are not in #335)
- **as-is:** `CACHE_CAPABILITY_FEATURE` includes `xaiConversationHeader`, `googleCachedContent`, and `lookback`. `documentedCacheCapability` never returns `supported === true` for any of them (`lookback` is not even switched). Comments already say production xAI is `openai-responses` (prompt_cache_key) and that the google provider never selects `google-generate`. `CacheCapabilityFeature` is typed as `string`, so the const is not a closed set.
- **should-be:** The feature list is exactly the keys `documentedCacheCapability` can affirm. Type = `typeof CACHE_CAPABILITY_FEATURE[keyof typeof CACHE_CAPABILITY_FEATURE]`.
- **smallest fix:** Delete `lookback` and `googleCachedContent`. Keep `xaiConversationHeader` only if `cacheSessionHeaders` still emits `x-grok-conv-id` for a live `openai-completions` xAI route; otherwise delete both.
- **what NOT to do:** Do not document those features as supported. Do not add a lookback/TTL probe path.

### F5 — `catalogHeaders` is a second header allowlist

- **path:line:** `agent-core/models.ts:375`
- **principle:** KISS / one owner
- **priority:** P2
- **NEW vs ALREADY-TICKETED:** NEW
- **as-is:** Providers already assemble request headers (`pickHeaders`, `codexHeaders`, `copilotHeaders`, OpenRouter referer/title, `openCodeHeaders`). Catalog GET then copies a hardcoded key list (`authorization`, `chatgpt-account-id`, `originator`, `x-api-key`, `anthropic-beta`, `http-referer`, Copilot editor headers, …) and drops everything else (including Codex `openai-beta`, which is intentional for GET). A new provider header is silent-dropped until this list is edited.
- **should-be:** One denylist for POST-only headers (`openai-beta`, maybe `content-type`) applied to `auth.headers`. New auth headers flow to catalog GET automatically.
- **smallest fix:** Replace the allowlist with a small denylist next to `catalogHeaders`. Keep the “not a Responses call” comment.
- **what NOT to do:** Do not move header construction out of `auth/`. Do not share this list with `cacheSessionHeaders`.

### F6 — OAuth URL helpers default to Anthropic for every other provider

- **path:line:** `agent-core/auth/endpoints.ts:152`, `agent-core/auth/endpoints.ts:161`
- **principle:** YAGNI / KISS
- **priority:** P2
- **NEW vs ALREADY-TICKETED:** NEW
- **as-is:** `authorizeUrl` returns Anthropic’s authorize URL unless the id is `openai-codex` or `openrouter`. `tokenUrl` returns Anthropic’s token URL unless the id is `openai-codex`, `xai`, or `openrouter`. `deviceUrl()` is xAI-only despite the generic name; GitHub has parallel `githubDeviceUrl` / `githubAccessUrl` in `oauth.ts`. A wrong `authorizeUrl("google")` would hit claude.ai.
- **should-be:** Explicit per-provider URLs (or `undefined` + throw) on `ProviderDefinition` / a map keyed by `ProviderId`. No implicit Anthropic fallback.
- **smallest fix:** Switch on the three browser OAuth ids and throw for the rest. Rename `deviceUrl` to `xaiDeviceUrl`.
- **what NOT to do:** Do not add authorize URLs for key-only providers. Do not invent OAuth endpoints.

### F7 — Effort “does this model reason?” is a second family list

- **path:line:** `agent-core/models/capabilities.ts:28`, `agent-core/models/capabilities.ts:108`
- **principle:** KISS / one owner
- **priority:** P2
- **NEW vs ALREADY-TICKETED:** NEW
- **as-is:** Family maps in `models/families/` plus `EFFORT_MAP_RULES` are the intended composition (one row per family — keep that). `RESPONSES_REASONING_FAMILIES` + `responsesReasoningModel` independently re-list gpt/codex/grok/muse-spark/Claude/Gemini so `usesModelEffort` can answer “has effort?” before the map table runs. Grok is matched with `includes("grok")` in the rule table and again via the regex list.
- **should-be:** `usesModelEffort` is “a map rule matched, or catalog `reasoningLevels` present.” Delete `RESPONSES_REASONING_FAMILIES`.
- **smallest fix:** Derive “has effort” from `EFFORT_MAP_RULES` / catalog levels. Leave each family’s map in `families/`.
- **what NOT to do:** Do not merge Claude/OpenAI/Gemini maps into one file. Do not add a second effort catalog.

### F8 — Request / effort / OAuth builders take 4–6 positional args

- **path:line:** `agent-core/openai-compat/completions.ts:146`, `agent-core/models.ts:466`, `agent-core/models/capabilities.ts:198`, `agent-core/auth/oauth.ts:225`
- **principle:** Clean Code (long parameter lists)
- **priority:** P2
- **NEW vs ALREADY-TICKETED:** NEW vs #326 (that ticket lists session-search / worldlines / prefs sites only)
- **as-is:** `completionsBody(model, system, messages, tools, limitKey, opts)` is 6 args; production always passes `"max_tokens"` as `limitKey`. `responsesBody` is 5. `loadAnthropicPages` is 6. `clampEffortLevel` / `reasoningEffortFor` / `effectiveEffortFor` / `thinkingEnabledFor` are 5. `exchangeAnthropic` / `exchangeCodex` are 5. `persistOauth` / `postJson` / `mcpErrorResult` are 4.
- **should-be:** Callers pass one object (`{ model, system, messages, tools, opts }`). Drop `limitKey` if only one value is live. Effort helpers can share a `{ provider, model, protocol, effort, reasoningLevels }` param.
- **smallest fix:** Object-param the three body builders and drop `limitKey`. Leave effort helpers until a caller migration; do not rename for style alone.
- **what NOT to do:** Do not invent a request-builder framework. Do not fold Anthropic Messages construction (in `main.ts`) into `openai-compat`.

### F9 — Copy-pasted device-code flows

- **path:line:** `agent-core/auth/oauth.ts:309`, `agent-core/auth/oauth.ts:431`, `agent-core/auth/oauth.ts:379`, `agent-core/auth/oauth.ts:480`
- **principle:** KISS (duplicated responsibility, not incidental syntax)
- **priority:** P2
- **NEW vs ALREADY-TICKETED:** NEW
- **as-is:** `validateVerificationUri` and `validateGithubVerificationUri` are the same HTTPS + hostname allowlist with different error strings. `requestXaiDeviceCode` / `requestGithubDeviceCode` parse the same four fields. `pollXaiDeviceToken` / `pollGithubDeviceToken` share deadline / pending / slow_down / denied / expired. `loginXaiDevice` and `loginGithubCopilot` in `login.ts:429` repeat the same “print URI, open browser, poll, persist” script.
- **should-be:** One `validateHttpsVerificationUri(raw, { hosts, label })` and one poll loop parameterized by token URL / grant / parse. Host allowlists stay per provider.
- **smallest fix:** Extract the URI validator and the pending/slow_down loop inside `oauth.ts` only.
- **what NOT to do:** Do not merge xAI and GitHub into one OAuth provider. Do not move this into `http.ts`.

### F10 — Catalog GET reimplements bounded HTTP read

- **path:line:** `agent-core/models.ts:326`, `agent-core/auth/http.ts:107`
- **principle:** KISS
- **priority:** P2
- **NEW vs ALREADY-TICKETED:** NEW
- **as-is:** `readCatalogBody` and `readAuthResponse` both: honor `content-length`, cap bytes, cancel the reader, assemble chunks, `TextDecoder({ fatal: true })`. Catalog also walks redirects; auth refuses them. Caps differ (1 MiB vs 256 KiB) for good reasons.
- **should-be:** One bounded-body reader (byte cap + fatal UTF-8) used by both. Redirect vs `redirect: "error"` stays at the call site.
- **smallest fix:** Extract a private `readBoundedUtf8(res, maxBytes)` next to `auth/http.ts` (or a tiny helper both import). Catalog keeps origin-locked redirects.
- **what NOT to do:** Do not send catalog GETs through `authFetch` (different timeout, redirect, and error types). Do not add a generic HTTP client.

### F11 — `runRefreshOauth` succeeds for providers with no refresh arm

- **path:line:** `agent-core/auth/oauth.ts:172`
- **principle:** YAGNI / KISS
- **priority:** P2
- **NEW vs ALREADY-TICKETED:** NEW
- **as-is:** Anthropic / Codex / xAI / Copilot refresh. The `else` returns `{ ok: true }` with no persist. OpenRouter stores an API key (no refresh). A stored `type: "oauth"` on google/zen/go (or a future id) would report a successful refresh and keep the expired token.
- **should-be:** Refresh is exhaustive on oauth-capable ids; anything else returns `{ ok: false, error: "…" }` or is unreachable because those ids never persist `type: "oauth"`.
- **smallest fix:** `else return { ok: false, error: "auth expired — run /login" }`.
- **what NOT to do:** Do not add no-op refresh implementations for key-only providers.

### F12 — Hardcoded Responses cache TTL

- **path:line:** `agent-core/openai-compat/responses.ts:226`
- **principle:** YAGNI
- **priority:** P2
- **NEW vs ALREADY-TICKETED:** NEW
- **as-is:** When `promptCacheMode === "explicit"`, the serializer always writes `{ mode: "explicit", ttl: "30m" }`. Callers cannot choose a TTL; `CACHE_CAPABILITY_FEATURE.ttl` is documented as “value remains policy data” and is not read here.
- **should-be:** Either emit `{ mode: "explicit" }` only, or take TTL from the single cache-policy owner when one value is actually configured.
- **smallest fix:** Drop the hardcoded `ttl` until a caller supplies one.
- **what NOT to do:** Do not add a TTL config surface or a second TTL table.

### F13 — Four boolean wrappers over `documentedCacheCapability` (test-only in production)

- **path:line:** `agent-core/auth/cache-policy.ts:213`
- **principle:** YAGNI / KISS
- **priority:** P2
- **NEW vs ALREADY-TICKETED:** NEW as a parallel API; the *export* triage is ALREADY-TICKETED #335 (test-only)
- **as-is:** `usesAnthropicCacheMarkers`, `usesPromptCacheKey`, `usesOpenAIExplicitCache`, `usesPromptCacheOptions` are one-line `.supported === true` wrappers. Production request code uses `documentedCacheCapability` / `cacheCapabilitySupported`. Tests (`cache.test.ts`, `harness-kernel.test.ts`, `provider-cache-policy.test.ts`) are the only callers. Argument order is inconsistent (`usesOpenAIExplicitCache(model, provider, route)`).
- **should-be:** Tests call `documentedCacheCapability` directly. No boolean façade.
- **smallest fix:** Inline the wrappers at the test call sites; delete the four functions from the `auth.ts` barrel.
- **what NOT to do:** Do not add more `uses*` helpers. Do not bulk-delete under #335 without migrating those tests.

### F14 — `effectiveEffortFor` is an alias of `clampEffortLevel`

- **path:line:** `agent-core/models/capabilities.ts:283`
- **principle:** KISS
- **priority:** P3
- **NEW vs ALREADY-TICKETED:** NEW
- **as-is:** `effectiveEffortFor` forwards all five args to `clampEffortLevel`. Production (`main.ts`) calls the alias many times; tests call both.
- **should-be:** One name.
- **smallest fix:** Make `effectiveEffortFor` a re-export or delete it and point callers at `clampEffortLevel`.
- **what NOT to do:** Do not keep both “for API stability.” No backwards-compat aliases (AGENTS.md).

### F15 — `parseTokenResponse` / `normalizeMcpTools` are one-line shims

- **path:line:** `agent-core/auth/oauth.ts:46`, `agent-core/mcp/tools.ts:185`
- **principle:** YAGNI
- **priority:** P3
- **NEW vs ALREADY-TICKETED:** NEW
- **as-is:** `parseTokenResponse` is `parseOauthToken(..., { requireRefresh: true })`. `normalizeMcpTools` returns `normalizeMcpDiscovery(...).tools`. Both are used (production + tests), so they are not #335-dead; they are extra names.
- **should-be:** Callers pass the option / take `.tools`.
- **smallest fix:** Inline at the few call sites.
- **what NOT to do:** Do not add more `parseX` aliases.

### F16 — Redundant predicates inside the family owner

- **path:line:** `agent-core/models/families/anthropic.ts:3`, `agent-core/models/families/openai.ts:5`
- **principle:** KISS
- **priority:** P3
- **NEW vs ALREADY-TICKETED:** NEW
- **as-is:** `modelLooksClaude` is `modelLeaf(model).includes("claude") || n.includes("claude")` — the leaf test is implied by the full-string test. `gpt56ReasoningContext` is `leaf.startsWith("gpt-5.6") || leaf.includes("gpt-5.6")`. `thinkingLockedOn` is exported but only called from `claudeEffortLevelMap` in the same file.
- **should-be:** One test each. `thinkingLockedOn` stays file-private.
- **smallest fix:** Drop the redundant clause; unexport `thinkingLockedOn`.
- **what NOT to do:** Do not expand these helpers into a new identity layer (see F2).

### F17 — `firstAuthenticatedProvider` re-exported from the catalog entry

- **path:line:** `agent-core/models.ts:24`
- **principle:** one owner
- **priority:** P3
- **NEW vs ALREADY-TICKETED:** NEW
- **as-is:** `firstAuthenticatedProvider` is defined in `auth/resolve.ts` and re-exported from `models.ts`. Catalog code does not own auth probing.
- **should-be:** Callers import it from `auth.ts`.
- **smallest fix:** Delete the re-export; fix the few imports.
- **what NOT to do:** Do not move resolve logic into `models.ts`.

### F18 — Twin catalog caps set to the same number

- **path:line:** `agent-core/models.ts:39`
- **principle:** YAGNI
- **priority:** P3
- **NEW vs ALREADY-TICKETED:** NEW
- **as-is:** `MODEL_LIST_CAP` and `MODELS_DISPLAY_CAP` are both 200. One bounds fetch/parse; one bounds `/models` display. Two names, one value, easy to drift.
- **should-be:** One cap, or two names with a one-line comment that display may someday be smaller — not a second magic 200.
- **smallest fix:** `export const MODELS_DISPLAY_CAP = MODEL_LIST_CAP` or drop the display constant.
- **what NOT to do:** Do not add more catalog caps.

### F19 — `rates.ts` unused type / const exports — ALREADY-TICKETED

- **path:line:** `agent-core/rates.ts:12`
- **principle:** YAGNI
- **priority:** P2
- **NEW vs ALREADY-TICKETED:** ALREADY-TICKETED [#335](https://github.com/Jesusz0r/termina/issues/335) (comment: “spot-check … `rates.ts` 19”)
- **as-is:** The module is the only cost-provenance owner (keep it). Many exported types/consts (`StorageUsage`, `CostRole`, `TOKEN_RATE_UNITS`, `CACHE_WRITE_TTL_CLASSES`, `RateSnapshotValidation`, …) are unused outside the file. `RateSnapshotInput` / `normalizeRateSnapshot` / `computeTraceCost` *are* live (`main.ts`).
- **should-be:** Unexport types that are only referenced inside `rates.ts`. Keep the validate / compute / serialize functions.
- **smallest fix:** Per-file #335 pass; do not bulk-delete.
- **what NOT to do:** Do not add a rates catalog loader. Do not merge this into `cache.ts` or `models.ts`.

### F20 — Capabilities / cache-policy test-only exports — ALREADY-TICKETED

- **path:line:** `agent-core/models/capabilities.ts:217`, `agent-core/models/families/anthropic.ts:29`
- **principle:** YAGNI
- **priority:** P3
- **NEW vs ALREADY-TICKETED:** ALREADY-TICKETED [#335](https://github.com/Jesusz0r/termina/issues/335)
- **as-is:** `thinkingEnabledFor` is only called from `harness-kernel.test.ts` (`clampEffortLevel(...) !== "off"`). `thinkingLockedOn` is unused outside its file. Several capability types are file-local in practice. #335 already covers test-only / unused exports; F13 is the shape issue for the cache wrappers.
- **should-be:** Unexport or delete after the #335 per-file review.
- **smallest fix:** Follow #335; do not open a second ticket for the same names.
- **what NOT to do:** Do not treat #335 as permission to delete `documentedCacheCapability` or the family maps.

---

## Hunt notes (no extra finding)

| Hunt | Result |
|---|---|
| Parallel effort maps | F7. Family maps + `EFFORT_MAP_RULES` is the *intended* one-row-per-family table — do not flatten. The extra `RESPONSES_REASONING_FAMILIES` list is the smell. |
| Dead provider arms | F3 (native Google `cachedContent`), F4 (feature keys), F6 (Anthropic URL default), F11 (refresh `else`). Copilot `anthropic-messages` / Zen `google-generate` are live. |
| Unused protocol shims | F13–F15, F20. `textFromCompletionPayload` and `usesResponsesApi` are live (`main.ts`). |
| Duplicate identity predicates | F2, F16. |
| Speculative cache options | F1, F3, F4, F12. `cache.ts` diagnostics (`messagePrefixHash` optional, `cacheWriteSupported`) are the diagnostics owner — not a second mapper; leave them. |
| 4+ arg builders | F8. Not covered by #326’s site list. |
| Copy-pasted header/auth assembly | F5, F9, F10. Per-provider `headers()` functions are the intended owner — do not merge `pickHeaders` / `codexHeaders` / `copilotHeaders` into one switch. |

`auth/lock.ts` is 816 lines (over the 800-line review trigger). It is one lock state machine; this audit does not recommend splitting it.

---

## What this audit did not do

- No production or test edits.
- No GitHub issues filed.
- No live provider-doc fetch (shape audit only).
- Did not treat #335’s unused-export inventory as new work.
- Did not recommend a second catalog, cache, or protocol mapper.
