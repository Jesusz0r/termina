# Provider configuration audit — 2026-09-05

Scope: all eight Core providers other than OpenCode Go, whose all-model results are in [OPENCODE-GO-AUDIT.md](OPENCODE-GO-AUDIT.md). Reviewed authentication headers, catalog parsing, protocol selection, request serialization, and reasoning settings against current primary sources. Live probes used short synthetic prompts, without workspace content. This is not an exhaustive live test of every model or OAuth lifecycle.

## Findings and fixes

- **GitHub Copilot:** Core previously assumed Responses for every model. It now consumes the catalog's `supported_endpoints`, chooses an advertised protocol, and uses Chat Completions when metadata is absent. Messages requests receive the version header. Nested catalog context limits are now consumed. Local child-process tests verify real Core request URLs, bodies, and headers for all three protocols. No Copilot credentials were available for a live probe. Sources: Microsoft's [endpoint implementation](https://raw.githubusercontent.com/microsoft/vscode/main/extensions/copilot/src/platform/endpoint/node/chatEndpoint.ts) and [catalog types](https://raw.githubusercontent.com/microsoft/vscode/main/extensions/copilot/src/platform/endpoint/common/endpointProvider.ts).
- **xAI:** tool-free Responses requests included `tool_choice`, producing HTTP 400. Omitting it when there are no tools returned HTTP 200/completed. Explicitly non-reasoning Grok models also rejected `reasoning.effort`; removing that setting returned HTTP 200/completed. Both paths have regression coverage. The chat picker now excludes Grok Imagine video models found in the live catalog. Sources: [text generation](https://docs.x.ai/developers/model-capabilities/text/generate-text), [models API](https://docs.x.ai/developers/rest-api-reference/inference/models), and [video model](https://docs.x.ai/developers/models/grok-imagine-video-1.5).
- **OpenAI Codex:** hidden catalog entries were exposed in the model picker. Core now respects `visibility: hide` while retaining ChatGPT-only models with `supported_in_api: false`. Source: [official catalog schema](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs).

## Provider results

| Provider | Evidence and result |
| --- | --- |
| Anthropic | Messages endpoint, API-key/version headers and model/thinking policy reviewed against [API docs](https://platform.claude.com/docs/en/api/overview) and [thinking guidance](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost). No additional confirmed mismatch; no credentials for live verification. |
| OpenAI Platform | Responses configuration reviewed against [Responses guidance](https://developers.openai.com/api/docs/guides/migrate-to-responses). No additional confirmed mismatch; no Platform credentials for live verification. |
| OpenAI Codex | Live catalog loaded; `gpt-5.6-sol`, `gpt-5.6-luna`, and `gpt-6-astra` each returned HTTP 200 and `response.completed`. Catalog visibility corrected as above. [Authentication docs](https://learn.chatgpt.com/docs/auth). |
| GitHub Copilot | Routing/context defects corrected as above; mocked catalog-to-request integration tests pass. Live authentication and account-specific capabilities remain unverified. |
| xAI | Live catalog loaded. `grok-4.6` and `grok-4.20-0309-non-reasoning` returned HTTP 200/completed with corrected fields. Grok 4.6 also completed a request containing tool declarations. This does not prove a full tool execution/replay cycle. |
| Google | Chat Completions compatibility endpoint, bearer auth, and Google-specific request fields reviewed against [Google's compatibility docs](https://ai.google.dev/gemini-api/docs/openai). No additional confirmed mismatch; no credentials for live verification. |
| OpenRouter | Stateless Responses configuration (`store: false`) and OAuth flow reviewed against [Responses docs](https://openrouter.ai/docs/api_reference/responses/overview) and [OAuth docs](https://openrouter.ai/docs/guides/overview/auth/oauth). No additional confirmed mismatch; no credentials for live verification. |
| OpenCode Zen | Live catalog loaded. Free Muse contributor model returned HTTP 200/completed. Eight paid model probes across GPT, Claude, Gemini, MiniMax, Qwen, GLM and Grok returned HTTP 401 `CreditsError: Insufficient balance`. Paid inference cannot be verified until the account has balance. Family routing matches [documented endpoints](https://opencode.ai/docs/zen/#endpoints). |

## Verification and limits

- Typecheck passed using the installed TypeScript binary.
- 107 targeted tests across 10 files passed: provider configuration, actual Core routing, Go protocols, model security, auth HTTP, cache policy, tool arguments, failure tracing, and Anthropic terminal handling. The monolithic harness/full unit suite was not completed; earlier attempts stalled.
- Build result is recorded in PROGRESS.md. Existing binaries were used directly because `pnpm exec` attempted a dependency reinstall and aborted without a TTY; no dependency replacement was performed for this audit.
- New tests use temporary HOME/auth fixtures and do not modify the host Pi configuration.
- Five providers lacked credentials: Anthropic, OpenAI Platform, Copilot, Google, and OpenRouter. Documentation and fixtures cannot establish live account access.
- Long conversations, every catalog model, fresh OAuth login/token expiry, and all tool/reasoning replay combinations were not exercised. Some capabilities still use model-name heuristics and context fallbacks; the audit does not certify every future catalog entry.
- Changes are in the workspace. The installed `/Applications/Termina.app` was not replaced.
