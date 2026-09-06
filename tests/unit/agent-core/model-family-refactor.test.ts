import { describe, expect, it } from "vitest";
import {
  adaptiveEffortFor,
  reasoningEffortFor,
  supportedEffortLevels,
  thinkingRequestFor,
} from "../../../agent-core/models/capabilities.ts";

describe("shared model capabilities across provider protocols", () => {
  it("shares Claude Messages parameters between native and Copilot", () => {
    for (const provider of ["anthropic", "github-copilot", "opencode-zen"] as const) {
      expect(thinkingRequestFor(provider, "claude-opus-4.7", "minimal", "anthropic-messages"))
        .toEqual({ type: "adaptive", display: "summarized" });
      expect(adaptiveEffortFor(provider, "claude-opus-4.7", "minimal", "anthropic-messages"))
        .toBe("low");
    }
  });

  it("uses the resolved Copilot protocol rather than the provider id", () => {
    expect(thinkingRequestFor("github-copilot", "claude-opus-4.7", "high", "openai-responses"))
      .toBeUndefined();
    expect(reasoningEffortFor("github-copilot", "claude-opus-4.7", "high", "openai-responses"))
      .toBe("high");
    expect(reasoningEffortFor("github-copilot", "claude-opus-4.7", "high", "anthropic-messages"))
      .toBeUndefined();
  });

  it("keeps explicit non-reasoning Grok variants disabled across relays", () => {
    for (const provider of ["xai", "openrouter", "opencode-zen"] as const) {
      expect(supportedEffortLevels(provider, "x-ai/grok-4-fast-non-reasoning", "openai-responses"))
        .toEqual(["off"]);
      expect(reasoningEffortFor(provider, "x-ai/grok-4-fast-non-reasoning", "high", "openai-responses"))
        .toBeUndefined();
    }
  });

  it("shares Gemini effort exclusions on native and relay Google protocols", () => {
    for (const provider of ["google", "opencode-zen", "opencode-go"] as const) {
      expect(supportedEffortLevels(provider, "gemini-3-pro", "google-generate"))
        .toEqual(["low", "high"]);
    }
  });

  it("keeps OpenAI provider restrictions explicit", () => {
    expect(reasoningEffortFor("openai", "gpt-5.6-sol", "off", "openai-responses")).toBe("none");
    expect(reasoningEffortFor("github-copilot", "gpt-5.6-sol", "off", "openai-responses")).toBe("low");
    expect(reasoningEffortFor("openai-codex", "gpt-5.6-sol", "minimal", "openai-codex-responses")).toBe("low");
  });

  it("keeps relay effort scoped to Completions while Go MiniMax uses Messages", () => {
    expect(supportedEffortLevels("opencode-zen", "minimax-m2.5", "openai-completions"))
      .toEqual(["off", "low", "medium", "high", "max"]);
    expect(supportedEffortLevels("opencode-go", "minimax-m2.5", "anthropic-messages"))
      .toEqual(["off"]);
  });
});
