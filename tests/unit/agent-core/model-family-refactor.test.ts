import { describe, expect, it } from "vitest";
import { zenWireProtocol } from "../../../agent-core/auth/providers/opencode-zen.ts";
import {
  adaptiveEffortFor,
  clampEffortLevel,
  effortControlFor,
  reasoningEffortFor,
  supportedEffortLevels,
  thinkingRequestFor,
  usesModelEffort,
} from "../../../agent-core/models/capabilities.ts";
import { modelLooksClaude } from "../../../agent-core/models/families/anthropic.ts";
import { modelLooksGemma, modelLooksGemini } from "../../../agent-core/models/families/google.ts";
import { museSparkReasoningFamily } from "../../../agent-core/models/families/muse-spark.ts";
import { gpt56ReasoningContext, modelLooksCodex, modelLooksOpenAI, openaiResponsesReasoningFamily } from "../../../agent-core/models/families/openai.ts";
import { modelLooksGrok } from "../../../agent-core/models/families/xai.ts";

describe("family helpers are the only model-family identity", () => {
  it("keeps Claude / Gemini / Gemma / Grok / OpenAI identity in families/", () => {
    expect(modelLooksClaude("anthropic/claude-sonnet-5")).toBe(true);
    expect(modelLooksClaude("claude-haiku-4-5")).toBe(true);
    expect(modelLooksClaude("gpt-5.6-sol")).toBe(false);
    expect(modelLooksGemini("gemini-3.7-flash")).toBe(true);
    expect(modelLooksGemma("gemma-3-27b-it")).toBe(true);
    expect(modelLooksGemma("google/gemma-4-31b-it")).toBe(true);
    expect(modelLooksGrok("grok-4.6")).toBe(true);
    expect(modelLooksGrok("x-ai/grok-4.6")).toBe(true);
    expect(modelLooksOpenAI("gpt-5.6-sol")).toBe(true);
    expect(modelLooksOpenAI("o3-mini")).toBe(true);
    expect(modelLooksOpenAI("o2-mini")).toBe(true);
    expect(modelLooksOpenAI("chatgpt-4o-latest")).toBe(true);
    expect(modelLooksOpenAI("claude-sonnet-5")).toBe(false);
    expect(modelLooksOpenAI("grok-4.6")).toBe(false);
    expect(modelLooksCodex("gpt-5.3-codex")).toBe(true);
    expect(modelLooksCodex("codex-mini-latest")).toBe(true);
  });

  it("drops the redundant gpt-5.6 includes clause", () => {
    expect(gpt56ReasoningContext("gpt-5.6-sol")).toBe("all_turns");
    expect(gpt56ReasoningContext("openai/gpt-5.6-sol")).toBe("all_turns");
    expect(gpt56ReasoningContext("not-gpt-5.6-sol")).toBeUndefined();
    expect(gpt56ReasoningContext("grok-4.6")).toBeUndefined();
  });

  it("routes Zen wire protocols through family helpers", () => {
    expect(zenWireProtocol("claude-sonnet-4-5")).toBe("anthropic-messages");
    expect(zenWireProtocol("gpt-5.6-sol")).toBe("openai-responses");
    expect(zenWireProtocol("codex-mini-latest")).toBe("openai-responses");
    expect(zenWireProtocol("grok-4.6")).toBe("openai-responses");
    expect(zenWireProtocol("muse-spark-1.2")).toBe("openai-responses");
    expect(museSparkReasoningFamily("muse-spark-1.2")).toBe(true);
    expect(zenWireProtocol("gemini-3.7-flash")).toBe("google-generate");
    expect(zenWireProtocol("glm-5.1")).toBe("openai-completions");
  });
});

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

  it("exposes documented Grok effort, including xhigh after 4.6", () => {
    expect(supportedEffortLevels("xai", "grok-4.7", "openai-responses"))
      .toEqual(["low", "medium", "high", "xhigh"]);
    expect(supportedEffortLevels("xai", "grok-4.6", "openai-responses"))
      .toEqual(["low", "medium", "high", "xhigh"]);
    expect(supportedEffortLevels("openrouter", "x-ai/grok-4.7", "openai-responses"))
      .toEqual(["low", "medium", "high", "xhigh"]);
    expect(reasoningEffortFor("xai", "grok-4.7", "xhigh", "openai-responses")).toBe("xhigh");
    expect(clampEffortLevel("xai", "grok-4.7", "max", "openai-responses")).toBe("xhigh");
    // Model page lists xhigh; the reasoning guide says it is treated as high.
    expect(supportedEffortLevels("xai", "grok-4.5", "openai-responses"))
      .toEqual(["low", "medium", "high"]);
    expect(supportedEffortLevels("xai", "grok-4.3", "openai-responses"))
      .toEqual(["off", "low", "medium", "high", "xhigh"]);
    expect(reasoningEffortFor("xai", "grok-4.3", "off", "openai-responses")).toBe("none");
    expect(supportedEffortLevels("xai", "grok-4.20-multi-agent", "openai-responses"))
      .toEqual(["low", "medium", "high", "xhigh"]);
    expect(effortControlFor("xai", "grok-4.20-0309-reasoning", "openai-responses")).toBe("provider-default");
    expect(effortControlFor("xai", "grok-5", "openai-responses")).toBe("provider-default");
    expect(supportedEffortLevels("xai", "grok-5", "openai-responses", ["low", "medium", "high", "xhigh"]))
      .toEqual(["low", "medium", "high", "xhigh"]);
    expect(supportedEffortLevels("anthropic", "claude-opus-9", "anthropic-messages", ["low", "high", "max"]))
      .toEqual(["low", "high", "max"]);
    expect(adaptiveEffortFor("anthropic", "claude-opus-9", "max", "anthropic-messages", ["low", "high", "max"]))
      .toBe("max");
  });

  it("shares Gemini effort exclusions on native and relay Google protocols", () => {
    for (const provider of ["google", "opencode-zen", "opencode-go"] as const) {
      expect(supportedEffortLevels(provider, "gemini-3-pro", "google-generate"))
        .toEqual(["low", "high"]);
    }
  });

  it("derives usesModelEffort from map rules or catalog reasoningLevels", () => {
    expect(usesModelEffort("openai", "gpt-5.6-sol", "openai-responses")).toBe(true);
    expect(usesModelEffort("openai", "gpt-4o", "openai-responses")).toBe(false);
    expect(openaiResponsesReasoningFamily("gpt-5.6-sol")).toBe(true);
    expect(openaiResponsesReasoningFamily("gpt-oss-20b")).toBe(true);
    expect(openaiResponsesReasoningFamily("gpt-4o")).toBe(false);
    expect(usesModelEffort("openai", "gpt-5.6-sol", "openai-completions")).toBe(false);
    expect(usesModelEffort("xai", "grok-4.6", "openai-responses")).toBe(true);
    expect(usesModelEffort("xai", "x-ai/grok-4-fast-non-reasoning", "openai-responses")).toBe(false);
    expect(usesModelEffort("opencode-zen", "muse-spark-1.3", "openai-responses")).toBe(true);
    expect(usesModelEffort("opencode-zen", "muse-spark-1.3", "openai-completions")).toBe(false);
    expect(usesModelEffort("opencode-zen", "glm-5.2", "anthropic-messages")).toBe(false);
    expect(usesModelEffort("anthropic", "claude-haiku-4-5", "anthropic-messages")).toBe(true);
    expect(usesModelEffort("openai-codex", "gpt-5.6-sol", "openai-codex-responses", ["low"])).toBe(true);
    expect(usesModelEffort("openai-codex", "mystery", "anthropic-messages", ["low"])).toBe(false);
  });

  it("keeps OpenAI provider restrictions explicit", () => {
    expect(reasoningEffortFor("openai", "gpt-5.6-sol", "off", "openai-responses")).toBe("none");
    expect(reasoningEffortFor("github-copilot", "gpt-5.6-sol", "off", "openai-responses")).toBe("low");
    expect(reasoningEffortFor("openai-codex", "gpt-5.6-sol", "minimal", "openai-codex-responses")).toBe("low");
  });

  it("floors Muse Spark at minimal because the model rejects reasoning none", () => {
    expect(reasoningEffortFor("opencode-zen", "muse-spark-1.3-contributor", "off", "openai-responses")).toBe("minimal");
    expect(supportedEffortLevels("opencode-zen", "muse-spark-1.3-contributor", "openai-responses"))
      .toEqual(["minimal", "low", "medium", "high", "xhigh"]);
  });

  it("hides Muse Spark max on Contributor-marker ids and clamps max to xhigh", () => {
    for (const model of [
      "muse-spark-1.3-contributor",
      "muse-spark-1.3-contributor-free",
      "muse-spark-1.2-contributor",
      "opencode-zen/muse-spark-1.3-contributor-free",
    ]) {
      expect(supportedEffortLevels("opencode-zen", model, "openai-responses"))
        .toEqual(["minimal", "low", "medium", "high", "xhigh"]);
      expect(clampEffortLevel("opencode-zen", model, "max", "openai-responses")).toBe("xhigh");
      expect(reasoningEffortFor("opencode-zen", model, "max", "openai-responses")).toBe("xhigh");
    }
  });

  it("offers Muse Spark max on bare Standard-tier ids with the max wire value", () => {
    expect(supportedEffortLevels("opencode-zen", "muse-spark-1.3", "openai-responses"))
      .toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(clampEffortLevel("opencode-zen", "muse-spark-1.3", "max", "openai-responses")).toBe("max");
    expect(reasoningEffortFor("opencode-zen", "muse-spark-1.3", "max", "openai-responses")).toBe("max");
  });

  it("clamps Muse Spark off to minimal on Contributor and Standard ids", () => {
    for (const model of ["muse-spark-1.3-contributor", "muse-spark-1.3"]) {
      expect(clampEffortLevel("opencode-zen", model, "off", "openai-responses")).toBe("minimal");
      expect(reasoningEffortFor("opencode-zen", model, "off", "openai-responses")).toBe("minimal");
    }
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
