import { describe, expect, it } from "vitest";
import { providerProtocol } from "../../../agent-core/auth.ts";

describe("OpenCode Go documented model endpoints", () => {
  // Complete endpoint table checked on 2026-09-05:
  // https://opencode.ai/docs/go/#endpoints
  it.each([
    ["muse-spark-1.3-contributor", "openai-responses"],
    ["muse-spark-1.2-contributor", "openai-responses"],
    ["gpt-5.6-luna", "openai-responses"],
    ["grok-4.6", "openai-responses"],
    ["qwen3.8-max", "anthropic-messages"],
    ["qwen3.8-flash", "anthropic-messages"],
    ["qwen3.7-max", "anthropic-messages"],
    ["qwen3.7-plus", "anthropic-messages"],
    ["qwen3.6-plus", "anthropic-messages"],
    ["minimax-m3", "anthropic-messages"],
    ["minimax-m2.7", "anthropic-messages"],
    ["minimax-m2.5", "anthropic-messages"],
    ["glm-5.1", "openai-completions"],
    ["glm-5.2", "openai-completions"],
    ["glm-5.3", "openai-completions"],
    ["glm-5.3-flash", "openai-completions"],
    ["kimi-k3", "openai-completions"],
    ["kimi-k2.7-code", "openai-completions"],
    ["kimi-k2.6", "openai-completions"],
    ["longcat-2.0", "openai-completions"],
    ["deepseek-v4-pro", "openai-completions"],
    ["deepseek-v4-flash", "openai-completions"],
    ["deepseek-v4-flash-vision-exp", "openai-completions"],
    ["mimo-v2.5", "openai-completions"],
    ["mimo-v2.5-pro", "openai-completions"],
    ["hy4-preview", "openai-completions"],
    ["hy3", "openai-completions"],
    ["omen-alpha", "openai-completions"],
  ])("routes %s through %s", (model, protocol) => {
    expect(providerProtocol("opencode-go", model)).toBe(protocol);
  });

  it.each(["minimax-m3", "minimax-m2.7", "minimax-m2.5"])("preserves Zen's different endpoint for %s", (model) => {
    // https://opencode.ai/docs/zen/#endpoints
    expect(providerProtocol("opencode-zen", model)).toBe("openai-completions");
  });
});
