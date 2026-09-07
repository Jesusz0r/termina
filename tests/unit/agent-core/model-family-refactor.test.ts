import { describe, expect, it } from "vitest";
import {
  adaptiveEffortFor,
  effortControlFor,
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

  it("controls Gemini 2.5 effort on the direct provider and marks unverified routes provider-default", () => {
    expect(supportedEffortLevels("google", "gemini-2.5-flash", "openai-completions"))
      .toEqual(["minimal", "low", "medium", "high"]);
    expect(effortControlFor("google", "gemini-2.5-flash", "openai-completions")).toBe("explicit");
    expect(effortControlFor("openrouter", "deepseek/deepseek-r1", "openai-completions"))
      .toBe("provider-default");
    expect(supportedEffortLevels("openrouter", "deepseek/deepseek-r1", "openai-completions"))
      .toEqual(["off"]);
  });

  it("keeps relay effort scoped to Completions while Go MiniMax uses Messages", () => {    expect(supportedEffortLevels("opencode-zen", "minimax-m2.5", "openai-completions"))
      .toEqual(["off", "low", "medium", "high", "max"]);
    expect(supportedEffortLevels("opencode-go", "minimax-m2.5", "anthropic-messages"))
      .toEqual(["off"]);
  });

  it("gives reasoning summaries room while keeping non-reasoning summaries small", async () => {    const { summaryRequestPolicy } = await import("../../../agent-core/main.ts");
    const grok = summaryRequestPolicy("xai", "grok-4.6");
    expect(grok.effort).toBe("low");
    expect(grok.reasoning).toBe("low");
    expect(grok.maxTokens).toBe(64_000);
    const plain = summaryRequestPolicy("openai", "gpt-4o");
    expect(plain.effort).toBe("off");
    expect(plain.maxTokens).toBe(2048);
    const unknown = summaryRequestPolicy("openrouter", "deepseek/deepseek-r1");
    expect(unknown.reasoning).toBeUndefined();
    expect(unknown.maxTokens).toBe(2048);
  });

  it("drops explicitly toolless catalog entries while keeping silent ones", async () => {
    const { toSelectableCatalog } = await import("../../../agent-core/main.ts");
    const listed = toSelectableCatalog("openrouter", [
      { id: "with-tools", supportedParameters: ["tools", "temperature"] },
      { id: "no-tools", supportedParameters: ["temperature"] },
      { id: "silent" },
    ]);
    expect(listed.map((m) => m.id)).toEqual(["with-tools", "silent"]);
    expect(listed.find((m) => m.id === "with-tools")?.supportsTools).toBe(true);
    expect(listed.find((m) => m.id === "silent")?.supportsTools).toBeNull();
  });
});
