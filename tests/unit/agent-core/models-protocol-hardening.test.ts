import { describe, it, expect } from "vitest";
import * as compat from "../../../agent-core/openai-compat.ts";
import * as capabilities from "../../../agent-core/models/capabilities.ts";
import { claudeThinkingApi } from "../../../agent-core/models/families/anthropic.ts";
import { CACHE_CAPABILITY_FEATURE, documentedCacheCapability } from "../../../agent-core/auth.ts";
import { computeTraceCost } from "../../../agent-core/rates.ts";

// Refs #203: models/protocol hardening batch.

function streamFromString(value: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("unwired surface removed, live cache surface kept (refs #203 item 1)", () => {
  it("drops the dead helpers from the public surface", () => {
    for (const name of [
      "textFromResponsesPayload",
      "textFromGooglePayload",
      "googleCachedContentCreateRequest",
      "googleCachedContentGetRequest",
      "googleCachedContentUpdateRequest",
      "googleCachedContentDeleteRequest",
      "parseGoogleCachedContent",
      "parseGoogleCachedContentDeleteResponse",
      "isGoogleCacheTtl",
      "GOOGLE_CACHED_CONTENT_MAX_BYTES",
    ]) {
      expect(name in compat, name).toBe(false);
    }
    expect("catalogReasoningLevels" in capabilities).toBe(false);
  });

  it("keeps the wired text helper and the cachedContent serializer field", () => {
    expect("textFromCompletionPayload" in compat).toBe(true);
    const native = compat.googleGenerateBody(
      "sys",
      [{ role: "user", content: "hi" }],
      [],
      { provider: "google", cachedContent: "cachedContents/cache-1" },
    );
    expect(native.cachedContent).toBe("cachedContents/cache-1");
    expect(() =>
      compat.googleGenerateBody("sys", [{ role: "user", content: "hi" }], [], { provider: "google", cachedContent: "cache-1" }),
    ).toThrow(/cached content name/i);
  });

  it("does not claim native Gemini cache on unreachable google-generate scopes (refs #216)", () => {
    expect(CACHE_CAPABILITY_FEATURE.googleCachedContent).toBe("google-cached-content");
    const native = { provider: "google", protocol: "google-generate", route: "generativelanguage.googleapis.com", model: "gemini-3.7-flash", feature: CACHE_CAPABILITY_FEATURE.googleCachedContent } as const;
    expect(documentedCacheCapability(native).supported).toBeNull();
    expect(documentedCacheCapability({ ...native, protocol: "openai-completions" }).supported).toBeNull();
  });
});

describe("google tool-result id fallback (refs #203 item 2)", () => {
  for (const alias of ["tool_use_id", "toolUseId", "call_id", "id"] as const) {
    it(`resolves tool results by ${alias}`, () => {
      const body = compat.googleGenerateBody(
        "",
        [
          { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "lookup", input: { q: "x" } }] },
          { role: "user", content: [{ type: "tool_result", [alias]: "call-1", content: "found" }] },
        ],
        [],
      );
      const contents = body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
      const responses = contents.flatMap((c) => c.parts).filter((p) => "functionResponse" in p);
      expect(responses).toHaveLength(1);
      expect((responses[0]!.functionResponse as Record<string, unknown>).name).toBe("lookup");
    });
  }
});

describe("rates storage opt-in requires non-null (refs #203 item 3)", () => {
  const scope = { provider: "p", protocol: "q", model: "m", route: "r" };
  const units = {
    input: "usd_per_token",
    cacheRead: "usd_per_token",
    cacheWrite: "usd_per_token",
    output: "usd_per_token",
    reasoning: "usd_per_token",
    storage: "usd_per_gib_second",
  } as const;
  const snapshot = {
    scope: { ...scope, role: "main" },
    source: "fixture",
    version: "v1",
    lookedUpAt: "2026-08-30T12:00:00.000Z",
    units,
    cacheWriteTtlClass: "5m",
    reasoningBilling: "separate",
    rates: { input: 1, cacheRead: 1, cacheWrite: 1, output: 1, reasoning: 1, storage: 1 },
  } as const;

  it("ignores an explicit null storage field instead of nulling the total", () => {
    const usage = { input: 2, cacheRead: 0, cacheWrite: 0, output: 3, reasoning: 0, storage: null };
    const cost = computeTraceCost({ role: "main", scope, usage, snapshot });
    expect(cost.unknownFields).toEqual([]);
    expect(cost.usd).toBe(5);
    expect(cost.knownFields).not.toContain("storage");
  });

  it("still bills a present storage record", () => {
    const usage = {
      input: 2,
      cacheRead: 0,
      cacheWrite: 0,
      output: 3,
      reasoning: 0,
      storage: { quantity: 1, unit: "gib", durationSeconds: 4 },
    } as const;
    const cost = computeTraceCost({ role: "main", scope, usage, snapshot });
    expect(cost.unknownFields).toEqual([]);
    expect(cost.usd).toBe(9);
    expect(cost.knownFields).toContain("storage");
  });
});

describe("gemini 2.5 thinking control (refs #203 item 4)", () => {
  it("sends reasoning_effort (not thinking_level) for 2.5 on the compat endpoint", () => {
    const body = compat.completionsBody(
      "gemini-2.5-flash",
      "sys",
      [{ role: "user", content: "hi" }],
      [],
      "max_tokens",
      { provider: "google", reasoningEffort: "low", googleThinking: true },
    );
    expect(body.reasoning_effort).toBe("low");
    expect(body.extra_body).toBeUndefined();
  });

  it("keeps thinking_level for gemini 3+", () => {
    const body = compat.completionsBody(
      "gemini-3.7-flash",
      "sys",
      [{ role: "user", content: "hi" }],
      [],
      "max_tokens",
      { provider: "google", reasoningEffort: "low", googleThinking: true },
    );
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.extra_body).toEqual({ google: { thinking_config: { thinking_level: "low", include_thoughts: true } } });
  });
});

describe("unknown claude ids default to adaptive (refs #203 item 5)", () => {
  it("keeps extended-thinking-only generations on budget", () => {
    for (const model of ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4.5", "claude-sonnet-4-1"]) {
      expect(claudeThinkingApi(model), model).toBe("budget");
    }
  });

  it("sends unknown and future ids to adaptive instead of deprecated budget", () => {
    for (const model of ["claude-haiku-5", "claude-opus-4-9", "claude-sonnet-6", "claude-sonnet", "claude-mythos-preview"]) {
      expect(claudeThinkingApi(model), model).toBe("adaptive");
    }
  });

  it("keeps known adaptive generations and pre-thinking models", () => {
    for (const model of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-5", "claude-opus-5"]) {
      expect(claudeThinkingApi(model), model).toBe("adaptive");
    }
    expect(claudeThinkingApi("claude-3-7-sonnet")).toBe("none");
    expect(claudeThinkingApi("gpt-5.6-sol")).toBe("none");
  });
});

describe("openrouter usage.cost feeds reportedUsd (refs #203 item 6)", () => {
  it("reads usage.cost like xai ticks", () => {
    const cost = compat.usageFromOpenAI({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, cost: 0.00014 });
    expect(cost?.reportedUsd).toBe(0.00014);
    const ticks = compat.usageFromOpenAI({ prompt_tokens: 10, completion_tokens: 4, cost_in_usd_ticks: 14_000_000 });
    expect(ticks?.reportedUsd).toBeCloseTo(0.0014, 10);
  });

  it("prefers exact ticks and rejects malformed cost", () => {
    const both = compat.usageFromOpenAI({ prompt_tokens: 1, completion_tokens: 1, cost_in_usd_ticks: 10_000_000_000, cost: 0.5 });
    expect(both?.reportedUsd).toBe(1);
    expect(compat.usageFromOpenAI({ prompt_tokens: 1, completion_tokens: 1, cost: -2 })?.reportedUsd).toBeNull();
    expect(compat.usageFromOpenAI({ prompt_tokens: 1, completion_tokens: 1, cost: "0.5" })?.reportedUsd).toBeNull();
    expect(compat.usageFromOpenAI({ prompt_tokens: 1, completion_tokens: 1 })?.reportedUsd).toBeNull();
  });
});

describe("glm effort gated on protocol (refs #203 item 7)", () => {
  it("offers no levels where the wire value is dropped", () => {
    expect(capabilities.usesModelEffort("opencode-zen", "glm-5.2", "anthropic-messages")).toBe(false);
    expect(capabilities.supportedEffortLevels("opencode-zen", "glm-5.2", "anthropic-messages")).toEqual(["off"]);
    expect(capabilities.reasoningEffortFor("opencode-zen", "glm-5.2", "high", "anthropic-messages")).toBeUndefined();
    expect(capabilities.usesModelEffort("opencode-zen", "glm-5.2", "google-generate")).toBe(false);
  });

  it("keeps the completions and responses rows", () => {
    expect(capabilities.supportedEffortLevels("opencode-zen", "glm-5.2", "openai-completions")).toEqual(["high", "max"]);
    expect(capabilities.supportedEffortLevels("openrouter", "z-ai/glm-5.2", "openai-responses")).toEqual(["high", "xhigh"]);
    expect(capabilities.reasoningEffortFor("opencode-zen", "glm-5.2", "high", "openai-completions")).toBe("high");
  });
});

describe("non-gemini google ids take the context floor (refs #203 item 8)", () => {
  it("floors gemma while gemini keeps 2^20", () => {
    expect(capabilities.defaultContextWindow("google", "gemma-3-27b")).toBe(128_000);
    expect(capabilities.defaultContextWindow("google", "gemini-3.7-flash")).toBe(1_048_576);
    expect(capabilities.defaultContextWindow("google", "google/gemini-2.5-flash")).toBe(1_048_576);
  });
});

describe("empty finish reasons ignored (refs #203 item 9)", () => {
  it("ignores empty completions finish_reason like null", () => {
    const empty = compat.completionResultFromEvents([{ choices: [{ delta: {}, finish_reason: "" }] }], () => {}, 0);
    expect(empty.stopReason).toBeNull();
    const missing = compat.completionResultFromEvents([{ choices: [{ delta: {}, finish_reason: null }] }], () => {}, 0);
    expect(missing.stopReason).toBeNull();
    const stop = compat.completionResultFromEvents([{ choices: [{ delta: {}, finish_reason: "stop" }] }], () => {}, 0);
    expect(stop.stopReason).toBe("stop");
  });

  it("ignores empty google finishReason", () => {
    const empty = compat.googleResultFromEvents([{ candidates: [{ finishReason: "" }] }], () => {}, 0);
    expect(empty.stopReason).toBeNull();
    const stop = compat.googleResultFromEvents([{ candidates: [{ finishReason: "STOP" }] }], () => {}, 0);
    expect(stop.stopReason).toBe("STOP");
  });
});

describe("sse eof tails (refs #203 item 10)", () => {
  it("still requires a terminal event when only garbage arrives", async () => {
    await expect(compat.readSseJson(streamFromString("event: unfinished\n"))).rejects.toThrow(/terminal/i);
  });
});

describe("opus 4.5 composes effort with budget (refs #203 item 11)", () => {
  it("sends both budget and effort for opus 4.5", () => {
    expect(capabilities.thinkingRequestFor("anthropic", "claude-opus-4-5", "high", "anthropic-messages"))
      .toEqual({ type: "enabled", budget_tokens: 16384 });
    expect(capabilities.adaptiveEffortFor("anthropic", "claude-opus-4-5", "high", "anthropic-messages")).toBe("high");
    expect(capabilities.adaptiveEffortFor("anthropic", "claude-opus-4-5", "minimal", "anthropic-messages")).toBe("low");
    expect(capabilities.adaptiveEffortFor("anthropic", "claude-opus-4-5", "off", "anthropic-messages")).toBeUndefined();
  });

  it("keeps other budget models on budget alone", () => {
    expect(capabilities.adaptiveEffortFor("anthropic", "claude-sonnet-4-5", "high", "anthropic-messages")).toBeUndefined();
    expect(capabilities.adaptiveEffortFor("anthropic", "claude-haiku-4-5", "high", "anthropic-messages")).toBeUndefined();
  });
});

describe("google result calls onText (refs #203 item 12)", () => {
  it("streams text through the callback", () => {
    const seen: string[] = [];
    const result = compat.googleResultFromEvents(
      [{ candidates: [{ content: { parts: [{ text: "hel" }, { text: "lo" }] } }] }],
      (text) => seen.push(text),
      0,
    );
    expect(seen).toEqual(["hello"]);
    expect(result.blocks).toContainEqual({ type: "text", text: "hello" });
  });
});
