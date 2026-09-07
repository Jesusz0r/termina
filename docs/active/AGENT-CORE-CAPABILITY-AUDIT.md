# Agent-core capability and efficiency audit — 2026-09-06

Scope: current working tree, including existing uncommitted provider changes. Read-only application audit; no production code changed, no account credentials read, no paid inference calls made. Current provider documentation was checked during this audit. Earlier live-probe results are historical evidence, not fresh verification.

## Verdict

Nine provider integrations exist and authenticated catalogs load dynamically. Model capabilities do not load dynamically with equivalent completeness. The harness has substantial token/caching controls, but cannot yet be certified for every listed model or for efficient multi-turn operation across providers.

| Provider | Current route | Assessment |
| --- | --- | --- |
| Anthropic | Messages; key or OAuth | Live IDs/context; effort and output limits are not catalog-driven. |
| OpenAI Platform | Responses; API key | Live IDs; unsafe generic context fallback and name-based capability filtering. |
| OpenAI Codex | Codex Responses; OAuth | Live catalog/visibility; advertised reasoning presets and defaults are discarded. |
| GitHub Copilot | Catalog-selected Responses, Completions, or Messages; device auth | Endpoint/context metadata consumed; Completions reasoning models can lose effort controls. |
| xAI | Responses; key/device auth | Grok effort mapping and cache keys exist; summary effort and newer reasoning replay need attention. |
| Google | OpenAI-compatible Completions; API key | Gemini tool-signature replay defect; Gemini 2.5 effort omitted. |
| OpenRouter | Responses; key/OAuth | Broad model access, but generic catalog and a 200-model cap do not establish usable account-specific models. |
| OpenCode Go | Model-family-selected protocol; key | Existing family routing covers documented families; Qwen/MiniMax Messages reasoning has no control in the Claude-only thinking path. |
| OpenCode Zen | Model-family-selected protocol; key | Existing protocol coverage, but future models still depend on family heuristics. |

Native Azure, Bedrock, Vertex, Mistral, DeepSeek, and local-server provider definitions are absent. Some models can be reached through relays or supported base-URL overrides; that does not establish native provider/auth support.

## Findings, ordered by impact

### 1. P1 — Direct Gemini drops required tool-call thought signatures — fixed 2026-09-07

`agent-core/auth/providers/google.ts` selects Completions. `completionResultFromEvents` in `agent-core/openai-compat.ts:942` keeps tool ID/name/arguments but drops `extra_content.google.thought_signature`. `toCompletionsMessages` at line 99 also reconstructs calls without that field. A synthetic signed tool event passed through both functions loses its signature. Subsequent Gemini tool turns can fail validation. Native Google serialization elsewhere does not repair the direct provider's Completions path.

[Google documents exact signature replay, including the OpenAI-compatible tool-call field](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures). Fix the canonical parse → persist/project → serialize path and verify two consecutive tool turns, including parallel calls.

### 2. P1 — Context fallback can be eight times the actual model limit — fixed 2026-09-07 (OpenAI → 128k; output-cap clamping still open)

`agent-core/models/capabilities.ts` returns 1,050,000 for OpenAI models without catalog context. A direct call for `gpt-4o` reproduced that value; [its documented context is 128,000](https://developers.openai.com/api/docs/models/gpt-4o). `main.ts:256` uses this value for admission, reclaim, and summarization thresholds. This delays compaction until well beyond the actual window; the overflow retry cannot make an incorrect capacity correct.

`ModelInfo` also omits output limits, while `main.ts:245`/`:329` use fixed 16,384 or 64,000 output caps for main requests (Codex omits the wire cap). Those values are not clamped to model limits. Preserve input/output metadata, use documented conservative fallbacks where metadata is absent, and handle unknown limits explicitly.

### 3. P2 — Dynamic discovery throws away capability metadata

`agent-core/models.ts:24` and `rowId` retain ID/name/context/endpoints only. A synthetic Anthropic row with output limits and effort support retained only ID/context. [Anthropic's Models API exposes effort capabilities and input/output limits](https://platform.claude.com/docs/en/api/http/models). [Codex's official schema exposes supported reasoning levels and their default](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs). [OpenRouter exposes supported parameters](https://openrouter.ai/docs/guides/overview/models).

Carry this metadata through the existing catalog owner into the existing capability resolver, picker, and serializer. Keep provider/protocol constraints explicit; do not infer every capability of a new model from its name. No second catalog is needed.

### 4. P2 — The effort control can say “off” while provider reasoning remains enabled

Local function probes returned only `["off"]` and no wire effort for Google `gemini-2.5-flash`, OpenRouter `deepseek/deepseek-r1`, and a Copilot GPT reasoning model on Completions. `usesModelEffort` excludes these routes/families. [Google explicitly supports Gemini 2.5 reasoning budgets through `reasoning_effort`](https://ai.google.dev/gemini-api/docs/openai); omitting the field selects provider defaults, not disabled thinking.

The Copilot example is conditional on a catalog advertising Completions, not proof that a particular account currently routes that model there. Qwen/MiniMax on Messages likewise have no non-Claude thinking policy; relay-specific support needs verification before adding fields. Represent unknown/default separately from explicitly disabled and cover effort at the resolved protocol boundary.

### 5. P2 — Summary requests do not consistently request economical effort

`main.ts:5851` constructs Responses summaries without `reasoningEffort`; the Completions summary branch also omits effort. Trace metadata records summary requested/effective effort as off, even where the provider uses a reasoning default. [xAI documents high as the default and disallows disabling reasoning on Grok 4.6](https://docs.x.ai/developers/model-capabilities/text/reasoning). Since xAI's default summary model is also Grok 4.6, an economical summary is not guaranteed. The 2,048 output cap can also leave little room for visible handoff text when reasoning consumes the budget; Codex summaries omit that cap.

Use the lowest supported summary effort and model-aware output budget through the existing capability owner; record the actual wire policy. Validate a nonempty handoff under reasoning load.

### 6. P2 — The picker is not a complete account-capability inventory

`models.ts` caps all lists at 200, filters largely by names, and does not require tool support or compatible modality/endpoints except Copilot routing metadata. OpenRouter uses generic `/models`; [its SDK documents a separate user-filtered list operation](https://openrouter.ai/docs/client-sdks/typescript/api-reference/models/models). Consequently some usable models are omitted, while an authenticated catalog fetch is not proof every displayed entry is usable under account preferences or with this harness's tools.

Preserve bounded fetches but provide explicit truncation/search or paging and use account-aware catalog semantics where supported. Filter capability-incompatible entries before selection. A successful short text response is still weaker evidence than a tool round trip.

## Token efficiency

Existing strengths: stable prompt/cache identities; direct Anthropic prefix/history markers; documented OpenAI/OpenRouter explicit breakpoints; xAI cache keys; bounded cache observations and optional-field rejection fallback; bounded tool outputs; protected recent history; reclaim before summarization; cost-triggered compaction; per-attempt usage/cache/cost traces. These are valuable controls.

Remaining limits: local token estimation uses UTF-8 bytes/4 rather than provider tokenization; fixed output ceilings are not model-aware; summary effort is inconsistent; direct Google never selects the native cached-content path despite helper support. Missing explicit Google cache support does not imply implicit caching is absent. Current xAI docs describe encrypted reasoning support, while `includeEncryptedReasoning` disables it for all Grok models based on earlier rejection evidence; re-probe exact supported models before changing that rule. [Current xAI reasoning documentation](https://docs.x.ai/developers/model-capabilities/text/reasoning).

No fresh cost-per-success benchmark was run. A defensible efficiency result needs the same representative coding tasks per route, recording success, billed input/cache reads/cache writes/reasoning/output, total cost, latency, retries, and compactions. Compare medium/low effort at equivalent success, including cold-cache and warm-cache runs.

## Verification

- `pnpm run typecheck` attempted an automatic dependency reinstall and aborted without a TTY. No dependency purge was approved or forced.
- Equivalent installed TypeScript binary passed: `node node_modules/typescript/bin/tsc --noEmit`.
- Installed Vitest binary: 40/40 tests across provider-configuration, provider-module-refactor, provider-cache-policy, cache, token-calibration, and provider-tool-args passed.
- Separate pure-function probes reproduced signature loss, metadata loss, missing effort controls, and the GPT-4o context fallback. Existing green tests do not cover these defects.
- No fresh live authentication/inference, full harness, build, Electron E2E, or Rust tests: this audit changed documentation only. Historical account coverage and limitations are recorded in `PROVIDER-CONFIGURATION-AUDIT.md` and `OPENCODE-GO-AUDIT.md`.
- Existing uncommitted application/Rust edits were preserved. Follow-up order: signature replay → model limits → catalog capabilities/effort → summary policy → catalog completeness → measured efficiency runs.
