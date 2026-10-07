import { describe, expect, it } from "vitest";
import { cacheInputTokens, cacheWriteSupportedFor } from "../../../agent-core/cache.ts";
import { formatUsageIndicators, UsageIndicators } from "../../../agent-core/main/usage-indicators.ts";

function usage(input: number | null, cacheRead: number | null, output: number | null = 10, cacheWrite: number | null = 0) {
  return { input, cacheRead, cacheWrite, output };
}

function cacheLabels(indicators: UsageIndicators): string {
  return indicators.format(0, 100).split(" · context")[0];
}

describe("canonical nullable cache input accounting", () => {
  it("counts all three disjoint input components", () => {
    expect(cacheInputTokens({ inputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 10 })).toBe(100);
  });

  it("accepts null writes only when the route has no write component", () => {
    const snapshot = { inputTokens: 27, cacheReadTokens: 98, cacheWriteTokens: null };
    expect(cacheInputTokens({ ...snapshot, cacheWriteSupported: cacheWriteSupportedFor("xai", null, "grok-4.6") })).toBe(125);
    expect(cacheWriteSupportedFor("openai-codex", null, "gpt-5.6-sol")).toBeNull();
    expect(cacheInputTokens({ ...snapshot, cacheWriteSupported: cacheWriteSupportedFor("openai-codex", null, "gpt-5.6-sol") })).toBeNull();
    for (const cacheWriteSupported of [undefined, null, true]) {
      expect(cacheInputTokens({ ...snapshot, cacheWriteSupported })).toBeNull();
    }
  });

  it("does not turn missing input/read or invalid components into zero", () => {
    const snapshot = { inputTokens: 27, cacheReadTokens: 98, cacheWriteTokens: null, cacheWriteSupported: false };
    expect(cacheInputTokens({ ...snapshot, inputTokens: null })).toBeNull();
    expect(cacheInputTokens({ ...snapshot, cacheReadTokens: null })).toBeNull();
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(cacheInputTokens({ ...snapshot, inputTokens: invalid })).toBeNull();
      expect(cacheInputTokens({ ...snapshot, cacheReadTokens: invalid })).toBeNull();
      expect(cacheInputTokens({ ...snapshot, cacheWriteTokens: invalid })).toBeNull();
    }
    expect(cacheInputTokens({ inputTokens: Number.MAX_VALUE, cacheReadTokens: Number.MAX_VALUE, cacheWriteTokens: 0 })).toBeNull();
  });
});

describe("UsageIndicators", () => {
  it("distinguishes cold-cold-warm session 41% from last 94%", () => {
    const indicators = new UsageIndicators();
    indicators.record(usage(6_500, 0), "xai", "fixture-model", "main");
    indicators.record(usage(6_500, 0), "xai", "fixture-model", "main");
    indicators.record(usage(600, 9_400), "xai", "fixture-model", "main");
    expect(cacheLabels(indicators)).toBe("tokens 23K in/30 out · cache last 94% · recent10 41% · session 41%");
  });

  it("weights the recent window by tokens and evicts after ten main requests", () => {
    const indicators = new UsageIndicators();
    indicators.record(usage(1_000, 0), "xai", "fixture-model", "main");
    for (let i = 0; i < 9; i++) indicators.record(usage(0, 100), "xai", "fixture-model", "main");
    expect(cacheLabels(indicators)).toContain("cache last 100% · recent10 47% · session 47%");
    indicators.record(usage(0, 100), "xai", "fixture-model", "main");
    expect(cacheLabels(indicators)).toContain("cache last 100% · recent10 100% · session 50%");
  });

  it("keeps summary tokens in cumulative totals without diluting main cache shares", () => {
    const indicators = new UsageIndicators();
    indicators.record(usage(10, 90, 10), "xai", "fixture-model", "main");
    for (let i = 0; i < 12; i++) indicators.record(usage(100, 0, 5), "xai", "fixture-model", "summary");
    expect(cacheLabels(indicators)).toBe("tokens 1.3K in/70 out · cache last 90% · recent10 90% · session 90% · summary 1.2K in/60 out");
  });

  it("normalizes writeless requests before aggregating across providers", () => {
    const indicators = new UsageIndicators();
    indicators.record(usage(3, 128, 624, null), "xai", "fixture-model", "main");
    indicators.record(usage(9, 0, 1, 0), "anthropic", "fixture-model", "main");
    expect(cacheLabels(indicators)).toBe("tokens 140 in/625 out · cache last 0% · recent10 91% · session 91%");
    indicators.record(usage(3, 128, 624, null), "openai-codex", "fixture-model", "main");
    expect(cacheLabels(indicators)).toContain("tokens ? in/1.2K out · cache last -- · recent10 -- · session --");
  });

  it("does not treat missing GPT-5.6+ or relay writes as zero", () => {
    const shaped = usage(3, 128, 624, null);
    const older = new UsageIndicators();
    older.record(shaped, "openai", "gpt-5.4", "main");
    expect(cacheLabels(older)).toContain("cache last 98% · recent10 98% · session 98%");
    // Normalization happens at record time, so a newer model cannot change
    // the older sample. Its missing write count poisons only its own totals.
    older.record(shaped, "openai", "gpt-5.6-sol", "main");
    expect(cacheLabels(older)).toContain("cache last -- · recent10 -- · session --");
    for (const provider of ["opencode-go", "opencode-zen", "openrouter"] as const) {
      const relay = new UsageIndicators();
      relay.record(shaped, provider, "claude-sonnet-5", "main");
      expect(cacheLabels(relay)).toContain("cache last -- · recent10 -- · session --");
    }
  });

  it("keeps unknown requests in the window until eviction, but lifetime totals stay unknown", () => {
    const indicators = new UsageIndicators();
    indicators.record(null, "xai", "fixture-model", "main");
    expect(cacheLabels(indicators)).toBe("tokens ? in/? out · cache last -- · recent10 -- · session --");
    for (let i = 0; i < 9; i++) indicators.record(usage(0, 100), "xai", "fixture-model", "main");
    expect(cacheLabels(indicators)).toContain("cache last 100% · recent10 -- · session --");
    indicators.record(usage(0, 100), "xai", "fixture-model", "main");
    expect(cacheLabels(indicators)).toBe("tokens ? in/? out · cache last 100% · recent10 100% · session --");
  });

  it("keeps unknown summaries separate from known main cache rates", () => {
    const indicators = new UsageIndicators();
    indicators.record(usage(10, 90), "xai", "fixture-model", "main");
    indicators.record(usage(50, null, null, null), "xai", "fixture-model", "summary");
    expect(cacheLabels(indicators)).toBe("tokens ? in/? out · cache last 90% · recent10 90% · session 90% · summary ? in/? out");
    indicators.record(usage(1, 0), "xai", "fixture-model", "summary");
    expect(cacheLabels(indicators)).toContain("summary ? in/? out");
  });

  it("resets continuity without wiping process lifetime totals; full reset clears everything", () => {
    const indicators = new UsageIndicators();
    indicators.record(usage(10, 90), "xai", "fixture-model", "main");
    indicators.record(usage(10, 0), "xai", "fixture-model", "summary");
    indicators.resetRecent();
    expect(cacheLabels(indicators)).toBe("tokens 110 in/20 out · cache last -- · recent10 -- · session 90% · summary 10 in/10 out");
    indicators.record(usage(10, 0), "xai", "fixture-model", "main");
    expect(cacheLabels(indicators)).toContain("cache last 0% · recent10 0% · session 82%");
    indicators.reset();
    expect(cacheLabels(indicators)).toBe("tokens 0 in/0 out · cache last -- · recent10 -- · session --");
  });

  it("does not repair unknown lifetime aggregates on continuity reset, only on explicit clear", () => {
    const indicators = new UsageIndicators();
    indicators.record(usage(null, 100, 10), "xai", "fixture-model", "main");
    indicators.record(null, "xai", "fixture-model", "summary");
    indicators.resetRecent();
    indicators.record(usage(0, 100), "xai", "fixture-model", "main");
    expect(cacheLabels(indicators)).toBe("tokens ? in/? out · cache last 100% · recent10 100% · session -- · summary ? in/? out");
    indicators.reset();
    indicators.record(usage(0, 100), "xai", "fixture-model", "main");
    expect(cacheLabels(indicators)).toBe("tokens 100 in/10 out · cache last 100% · recent10 100% · session 100%");
  });

  it("bounds retained requests and does not retain mutable provider objects", () => {
    const indicators = new UsageIndicators();
    const request = usage(1, 99);
    indicators.record(request, "xai", "fixture-model", "main");
    request.cacheRead = null;
    for (let i = 0; i < 1_000; i++) indicators.record(usage(1, 99), "xai", "fixture-model", "main");
    const retained = Object.values(indicators).filter(Array.isArray);
    expect(retained).toHaveLength(1);
    expect(retained[0]).toHaveLength(10);
    expect(cacheLabels(indicators)).toContain("cache last 99% · recent10 99% · session 99%");
  });

  it("reports zero-input cache as unknown and invalid output as unknown", () => {
    const indicators = new UsageIndicators();
    indicators.record(usage(0, 0, Number.NaN), "xai", "fixture-model", "main");
    expect(cacheLabels(indicators)).toBe("tokens 0 in/? out · cache last -- · recent10 -- · session --");
  });
});

describe("formatUsageIndicators integration contract", () => {
  it("retains the test seam signature with an explicit session cache label", () => {
    expect(formatUsageIndicators(usage(500, 1_000, 250), 20_000, 200_000, 0.0123)).toBe(
      "tokens 1.5K in/250 out · cache session 67% · context ~20K/200K 10% · last $0.0123",
    );
    expect(formatUsageIndicators(usage(3, 128, 624, null), 0, 128_000, null, null, "xai")).toContain("tokens 131 in/624 out · cache session 98%");
    expect(formatUsageIndicators(usage(3, 128, 624, null), 0, 128_000, null, null, "openai-codex")).toContain("tokens ? in/624 out · cache session --");
  });

  it("preserves context, cost and flips on tracker output", () => {
    const indicators = new UsageIndicators();
    indicators.record(usage(500, 1_000, 250), "xai", "fixture-model", "main");
    expect(indicators.format(20_000, 200_000, 0.0123, { evaluations: 14, prefixFlips: 2, workingSetChanges: 9 })).toBe(
      "tokens 1.5K in/250 out · cache last 67% · recent10 67% · session 67% · context ~20K/200K 10% · last $0.0123 · flips 2/14",
    );
    expect(formatUsageIndicators(usage(Number.NaN, Number.POSITIVE_INFINITY, -2, -1), Number.NaN, Number.POSITIVE_INFINITY, Number.NaN)).toBe(
      "tokens ? in/? out · cache session -- · context ~0/1 0%",
    );
  });
});
