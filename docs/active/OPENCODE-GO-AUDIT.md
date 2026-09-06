# OpenCode Go routing audit — 2026-09-05

Checked all 35 entries from the [live Go catalog](https://opencode.ai/zen/go/v1/models) using current `providerProtocol` routing and one synthetic “Reply with OK.” request per model, capped at 32 output tokens. No workspace content was sent. DeepSeek V4 Flash timed out at 25 seconds, then returned HTTP 200 on one retry.

31 models accepted requests with HTTP 200. Four catalog entries returned HTTP 400 with upstream unavailable/unsupported-model errors. HTTP 200 establishes endpoint acceptance, not full tool-call, streaming, long-context, or conversation correctness. Several responses exhausted the deliberately small output limit.

The old blanket Chat Completions route disagreed with the current routing for 14 catalog models: five Responses and nine Messages models. All 28 entries in the current [Go endpoint table](https://opencode.ai/docs/go/#endpoints) match the patched routing. Seven additional catalog entries are absent from that table; their family routing was probed but is not independently specified there. [Zen documents different MiniMax routing](https://opencode.ai/docs/zen/#endpoints), which remains unchanged.

| Model | Protocol | Live result |
| --- | --- | --- |
| minimax-m3 | anthropic-messages | HTTP 200 |
| minimax-m2.7 | anthropic-messages | HTTP 200 |
| minimax-m2.5 | anthropic-messages | HTTP 200 |
| kimi-k3 | openai-completions | HTTP 200 |
| kimi-k2.7-code | openai-completions | HTTP 200 |
| kimi-k2.6 | openai-completions | HTTP 200 |
| longcat-2.0 | openai-completions | HTTP 200 |
| kimi-k2.5 | openai-completions | HTTP 400: no permitted upstream provider |
| glm-5.2 | openai-completions | HTTP 200 |
| glm-5.3-flash | openai-completions | HTTP 200 |
| glm-5.3 | openai-completions | HTTP 200 |
| glm-5.1 | openai-completions | HTTP 200 |
| glm-5 | openai-completions | HTTP 200 |
| deepseek-v4-pro | openai-completions | HTTP 200 |
| deepseek-v4-flash | openai-completions | HTTP 200 on retry (initial timeout) |
| deepseek-v4-flash-vision-exp | openai-completions | HTTP 200 |
| qwen3.7-max | anthropic-messages | HTTP 200 |
| qwen3.8-max | anthropic-messages | HTTP 200 |
| qwen3.8-flash | anthropic-messages | HTTP 200 |
| qwen3.7-plus | anthropic-messages | HTTP 200 |
| qwen3.6-plus | anthropic-messages | HTTP 200 |
| qwen3.5-plus | anthropic-messages | HTTP 200 |
| mimo-v2-pro | openai-completions | HTTP 400: unsupported upstream model |
| mimo-v2-omni | openai-completions | HTTP 400: unsupported upstream model |
| mimo-v2.5-pro | openai-completions | HTTP 200 |
| mimo-v2.5 | openai-completions | HTTP 200 |
| hy4-preview | openai-completions | HTTP 200 |
| hy3 | openai-completions | HTTP 200 |
| hy3-preview | openai-completions | HTTP 400: model unavailable |
| gpt-5.6-luna | openai-responses | HTTP 200 |
| grok-4.5 | openai-responses | HTTP 200 |
| grok-4.6 | openai-responses | HTTP 200 |
| muse-spark-1.3-contributor | openai-responses | HTTP 200 |
| muse-spark-1.2-contributor | openai-responses | HTTP 200 |
| omen-alpha | openai-completions | HTTP 200 |

Validation: typecheck, 39 focused unit tests, and build passed. Expanded the endpoint regression test to all 28 documented Go models plus three Zen MiniMax guards. Production code did not need further changes. E2E was not rerun for this test/documentation-only follow-up. The installed app has not been replaced.
