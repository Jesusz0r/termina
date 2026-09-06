# Provider and model-family refactor — 2026-09-06

Provider policy now lives in one module per provider under `agent-core/auth/providers/`: Anthropic, OpenAI, OpenAI Codex, GitHub Copilot, xAI, Google, OpenRouter, OpenCode Go, and OpenCode Zen. `auth.ts` remains the public authentication owner and retains credential persistence and login/refresh orchestration. The provider modules own route defaults, headers, catalog policy, and protocol selection; their shared endpoint helper replaces the request path mapper formerly in `main.ts`.

`agent-core/models/families/` holds shared Anthropic, OpenAI, Google, xAI, relay-family, and model-identity rules. `models/capabilities.ts` combines family rules with the resolved protocol and narrow provider restrictions. Its callers supply the selected protocol, including Copilot catalog metadata, so Claude thinking fields are shared on Messages while remaining absent from Chat Completions. OpenAI family rules are provider-neutral; Copilot/Codex/OpenRouter overrides remain in composition. Existing serializers in `main.ts` and `openai-compat.ts` remain canonical.

`models.ts` remains the catalog fetch/parser owner, preserving redirect checks, response bounds, cancellation, pagination, and filtering. Copilot metadata parsing has a private owner in `models/catalog/copilot.ts`. No parallel catalog, serializer, compatibility alias, new dependency, or plugin framework was added. Existing Go MiniMax versus Zen routing differences remain covered.

## Verification

Run in order against the integrated changes:

1. `node_modules/.bin/tsc --noEmit` — passed.
2. `node_modules/.bin/vitest run` with the 13 files below — **113 tests passed**, 13 files passed (25.63 seconds).
3. `node --experimental-strip-types scripts/build.ts` — passed; Electron bundles and Core up-to-date check succeeded.
4. `node_modules/.bin/vite build` — passed (40.41 seconds), with the existing chunk-size warning.

Targeted files under `tests/unit/agent-core/`: `provider-configuration.test.ts`, `main-provider-routing.test.ts`, `opencode-protocol.test.ts`, `model-security.test.ts`, `auth-http.test.ts`, `provider-cache-policy.test.ts`, `provider-tool-args.test.ts`, `main-failure-trace.test.ts`, `main-anthropic-terminal.test.ts`, `main-anthropic-stream.test.ts`, `model-family-refactor.test.ts`, `provider-module-refactor.test.ts`, and `catalog-refactor.test.ts`.

The initial sandbox run failed because auth/catalog fixture servers could not bind `127.0.0.1` (`listen EPERM`). The identical suite passed outside that restriction. Tests use isolated temporary authentication fixtures; the host Pi configuration was not modified. Existing installed binaries were used without reinstalling dependencies. Independent review found a provider override in an OpenAI family helper; it was moved to composition, and final review reported no remaining actionable findings.

No live paid-provider probes, full monolithic harness, Electron E2E, or Rust test suite were run for this agent-only extraction. Existing prior live-audit limitations remain in [PROVIDER-CONFIGURATION-AUDIT.md](PROVIDER-CONFIGURATION-AUDIT.md). The installed `/Applications/Termina.app` was not replaced. Unrelated working-tree changes were preserved.

## Primary sources checked during implementation

- Anthropic: [authentication](https://platform.claude.com/docs/en/manage-claude/authentication), [extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking), [adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking), [effort](https://platform.claude.com/docs/en/build-with-claude/effort).
- OpenAI: [reasoning](https://developers.openai.com/api/docs/guides/reasoning), [GPT-5](https://developers.openai.com/api/docs/models/gpt-5).
- Google: [OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai), [thinking](https://ai.google.dev/gemini-api/docs/thinking).
- xAI: [text generation](https://docs.x.ai/developers/model-capabilities/text/generate-text), [reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning).
- OpenCode: [Go endpoints](https://opencode.ai/docs/go/#endpoints), [Zen endpoints](https://opencode.ai/docs/zen/#endpoints).
- OpenRouter: [Responses API](https://openrouter.ai/docs/api_reference/responses/overview).
- Copilot: [Microsoft endpoint implementation](https://raw.githubusercontent.com/microsoft/vscode/main/extensions/copilot/src/platform/endpoint/node/chatEndpoint.ts).
