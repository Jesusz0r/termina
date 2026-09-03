import { describe, it, expect } from "vitest";
import * as auth from "../../../agent-core/auth.ts";
import * as cache from "../../../agent-core/cache.ts";

const {
  CACHE_KEY_MAX_LENGTH,
  cacheSessionSeed,
  deriveCacheIdentityKey,
  cacheIdentityFor,
  cacheSessionHeaders,
  usesAnthropicCacheMarkers,
  usesPromptCacheKey,
  usesOpenAIExplicitCache,
  usesPromptCacheOptions,
  CACHE_CAPABILITY_FEATURE,
  CACHE_POLICY_PROVENANCE,
  documentedCacheCapability,
} = auth;

const {
  CAPABILITY_CACHE_MAX_ENTRIES,
  capabilityCacheKey,
  createCapabilityCache,
  invalidateCapability,
  queryCapability,
  recordCapability,
} = cache;

const base = {
  sessionSeed: cacheSessionSeed("terminal-1"),
  role: "main" as const,
  provider: "openrouter",
  protocol: "openai-responses",
  route: "openrouter.ai",
};

describe("Agent Core Cache", () => {
  describe("Cache Session Seed & Derivation", () => {
    it("handles seeds stably and sanitizes controls", () => {
      expect(cacheSessionSeed(" terminal-1 ")).toBe(base.sessionSeed);
      expect(cacheSessionSeed(" ")).not.toBe(cacheSessionSeed(" "));
      expect(cacheSessionSeed("terminal-1\n")).toBe("");

      const invalidControls = [
        ...Array.from({ length: 32 }, (_, i) => i),
        ...Array.from({ length: 33 }, (_, i) => i + 127),
      ];
      expect(
        invalidControls.every((code) => cacheSessionSeed(`terminal-${String.fromCodePoint(code)}`) === ""),
      ).toBe(true);
    });

    it("derives bounded, ASCII, stable identity keys", () => {
      const mainKey = deriveCacheIdentityKey(base);
      expect(typeof mainKey).toBe("string");
      expect(CACHE_KEY_MAX_LENGTH).toBe(64);
      expect(mainKey).toHaveLength(64);
      expect(/^[\x21-\x7e]+$/.test(mainKey!)).toBe(true);
      expect(mainKey).toBe(deriveCacheIdentityKey(base));

      const longKey = deriveCacheIdentityKey({
        ...base,
        sessionSeed: cacheSessionSeed("x".repeat(100_000)),
      });
      expect(longKey!.length).toBeLessThanOrEqual(CACHE_KEY_MAX_LENGTH);

      expect(mainKey).not.toBe(deriveCacheIdentityKey({ ...base, role: "summary" as any }));
      expect(mainKey).not.toBe(deriveCacheIdentityKey({ ...base, provider: "xai" }));
      expect(mainKey).not.toBe(deriveCacheIdentityKey({ ...base, protocol: "openai-completions" }));
      expect(mainKey).not.toBe(deriveCacheIdentityKey({ ...base, route: "api.openrouter.ai" }));
      expect(deriveCacheIdentityKey({ ...base, route: "api\u0000.openrouter.ai" })).toBeNull();

      const secretIdentity = cacheIdentityFor({ ...base, sessionSeed: cacheSessionSeed("秘密/terminal") });
      expect(JSON.stringify(secretIdentity)).not.toContain("秘密");
    });
  });

  describe("Provider Route Guards", () => {
    it("guards direct-route features correctly", () => {
      expect(usesAnthropicCacheMarkers("anthropic", "claude-sonnet-5", "api.anthropic.com")).toBe(true);
      expect(usesAnthropicCacheMarkers("openrouter", "anthropic/claude-sonnet-5", "api.openrouter.ai")).toBe(false);
      expect(usesAnthropicCacheMarkers("opencode-zen", "claude-sonnet-5", "zen")).toBe(false);

      expect(usesPromptCacheKey("openai", "gpt-5.6", "api.openai.com")).toBe(true);
      expect(usesPromptCacheKey("xai", "grok-4.6", "api.x.ai")).toBe(true);
      expect(usesPromptCacheKey("openrouter", "openai/gpt-5.6", "api.openrouter.ai")).toBe(false);
      expect(usesPromptCacheKey("opencode-zen", "gpt-5.6", "zen")).toBe(false);
      expect(usesPromptCacheKey("openai-codex", "gpt-5.6", "chatgpt.com")).toBe(false);

      expect(usesOpenAIExplicitCache("gpt-5.6", "openai", "api.openai.com")).toBe(true);
      expect(usesOpenAIExplicitCache("gpt-5.6", "openrouter", "api.openrouter.ai")).toBe(false);
      expect(usesOpenAIExplicitCache("gpt-5.6", "opencode-zen", "zen")).toBe(false);
      expect(usesOpenAIExplicitCache("gpt-5.6", "xai", "api.x.ai")).toBe(false);
      expect(usesOpenAIExplicitCache("gpt-5.6", "openai")).toBe(false);

      expect(usesPromptCacheOptions("openai", "gpt-5.6", "api.openai.com")).toBe(true);
      expect(usesPromptCacheOptions("openrouter", "gpt-5.6", "api.openrouter.ai")).toBe(false);
    });

    it("verifies session headers and tamper resistance", () => {
      const mainKey = deriveCacheIdentityKey(base)!;
      const identity = cacheIdentityFor(base)!;
      expect(identity.key).toBe(mainKey);
      expect(cacheSessionHeaders(identity)["x-session-id"]).toBe(mainKey);
      expect(Object.keys(cacheSessionHeaders({ ...identity, provider: "opencode-zen" })).length).toBe(0);
      expect(Object.keys(cacheSessionHeaders({ ...identity, provider: "xai", protocol: "openai-responses" })).length).toBe(0);

      const xaiChatIdentity = cacheIdentityFor({ ...base, provider: "xai", protocol: "openai-completions", route: "api.x.ai" })!;
      expect(cacheSessionHeaders(xaiChatIdentity)["x-grok-conv-id"]).toBe(xaiChatIdentity.key);
      expect(Object.keys(cacheSessionHeaders({ ...identity, provider: "xai", protocol: "openai-completions", route: "api.x.ai" })).length).toBe(0);
      expect(Object.keys(cacheSessionHeaders({ ...identity, provider: "openai" })).length).toBe(0);
    });
  });

  describe("Documented Capabilities", () => {
    const directOpenAiScope = {
      provider: "openai",
      protocol: "openai-responses",
      route: "https://api.openai.com/v1",
      model: "gpt-5.6",
      feature: CACHE_CAPABILITY_FEATURE.promptCacheKey,
    };

    it("returns correct capabilities for providers", () => {
      const cap = documentedCacheCapability(directOpenAiScope);
      expect(cap.supported).toBe(true);
      expect(cap.status).toBe("supported");
      expect(cap.provenance?.url).toBe(CACHE_POLICY_PROVENANCE.openaiPromptCaching.url);
      expect(typeof cap.provenance?.retrievedAt).toBe("string");

      expect(documentedCacheCapability({ ...directOpenAiScope, provider: "openrouter", route: "api.openrouter.ai", model: "openai/gpt-5.6" }).supported).toBeNull();
      expect(documentedCacheCapability({ ...directOpenAiScope, provider: "opencode-zen", route: "zen", model: "gpt-5.6" }).supported).toBeNull();
      expect(documentedCacheCapability({ ...directOpenAiScope, provider: "opencode-zen", protocol: "google-generate", route: "zen", model: "gemini-3.7-flash", feature: CACHE_CAPABILITY_FEATURE.googleCachedContent }).supported).toBeNull();
      expect(documentedCacheCapability({ ...directOpenAiScope, provider: "xai", protocol: "openai-responses", route: "api.x.ai", model: "grok-4.6", feature: CACHE_CAPABILITY_FEATURE.ttl }).supported).toBeNull();
      expect(documentedCacheCapability({ ...directOpenAiScope, provider: "xai", protocol: "openai-responses", route: "api.x.ai", model: "grok-4.6", feature: CACHE_CAPABILITY_FEATURE.promptCacheKey }).supported).toBe(true);
      expect(documentedCacheCapability({ ...directOpenAiScope, feature: CACHE_CAPABILITY_FEATURE.ttl }).supported).toBe(true);
      expect(documentedCacheCapability({ ...directOpenAiScope, provider: "google", protocol: "google-generate", route: "generativelanguage.googleapis.com", model: "gemini-3.7-flash", feature: CACHE_CAPABILITY_FEATURE.googleCachedContent }).supported).toBe(true);
    });

    it("manages LRU capability cache correctly", () => {
      const capabilityCache = createCapabilityCache(2);
      expect(typeof capabilityCacheKey(directOpenAiScope)).toBe("string");
      expect(capabilityCacheKey(directOpenAiScope).length).toBeLessThanOrEqual(80);

      const cacheMiss = queryCapability(capabilityCache, directOpenAiScope, 1_000);
      expect(cacheMiss.supported).toBeNull();
      expect(cacheMiss.status).toBe("unknown");

      const observed = recordCapability(capabilityCache, {
        scope: directOpenAiScope,
        supported: true,
        source: "probe",
        observedAtMs: "100" as any,
        expiresAtMs: "2000" as any,
      });
      expect(observed?.supported).toBe(true);
      expect(queryCapability(capabilityCache, directOpenAiScope, 1_999).supported).toBe(true);
      expect(queryCapability(capabilityCache, directOpenAiScope, 2_000).supported).toBeNull();
      expect(queryCapability(capabilityCache, directOpenAiScope, 2_000).reason).toBe("expired");

      const rejected = recordCapability(capabilityCache, {
        scope: directOpenAiScope,
        status: "rejected",
        source: "probe",
        reason: "unsupported optional field",
        observedAtMs: 3_000,
        expiresAtMs: null,
      });
      expect(rejected?.supported).toBe(false);
      expect(queryCapability(capabilityCache, directOpenAiScope, 4_000).reason).toBe("unsupported optional field");

      expect(invalidateCapability(capabilityCache, directOpenAiScope)).toBe(true);
      expect(queryCapability(capabilityCache, directOpenAiScope, 4_000).supported).toBeNull();

      recordCapability(capabilityCache, { scope: directOpenAiScope, supported: true, source: "probe", observedAtMs: 5_000, expiresAtMs: null });
      recordCapability(capabilityCache, { scope: { ...directOpenAiScope, model: "gpt-5.6-mini" }, supported: true, source: "probe", observedAtMs: 5_000, expiresAtMs: null });
      recordCapability(capabilityCache, { scope: { ...directOpenAiScope, feature: CACHE_CAPABILITY_FEATURE.promptCacheOptions }, supported: true, source: "probe", observedAtMs: 5_000, expiresAtMs: null });

      expect(capabilityCache.entries.size).toBe(2);
      expect(queryCapability(capabilityCache, directOpenAiScope, 6_000).supported).toBeNull();
      expect(CAPABILITY_CACHE_MAX_ENTRIES).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Request Diagnostics and Miss Classification", () => {
    const identity = cacheIdentityFor(base)!;
    const diagnostics = (overrides = {}) =>
      cache.cacheRequestDiagnostics({
        identity,
        policy: {
          provider: "openrouter",
          protocol: "openai-responses",
          model: "openai/gpt-5.6",
          requestedMode: "explicit",
          effectiveMode: "explicit",
          requestedTtlMs: 30 * 60 * 1000,
          effectiveTtlMs: 30 * 60 * 1000,
          retentionKnown: true,
          fallbackReason: null,
        },
        modelSettings: { effort: "high" },
        tools: [{ name: "read_file" }],
        stablePrefix: "stable-prefix",
        reusablePrefix: "reusable-prefix",
        messagePrefix: "message-prefix",
        workingSet: "working-set",
        ...overrides,
      });

    const prior = {
      atMs: 0,
      usage: { inputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      diagnostics: diagnostics(),
      postRevision: false,
    };

    it("evaluates serialized tool hashing", () => {
      const toolsA = [{ name: "read_file", description: "lee 🔧", input_schema: { type: "object", properties: {} } }];
      const toolsKeyOrder = [{ input_schema: { properties: {}, type: "object" }, description: "lee 🔧", name: "read_file" }];
      const toolsArrayOrder = [
        { name: "write_file", input_schema: { type: "object" } },
        { name: "read_file", input_schema: { type: "object" } },
      ];

      const exactA = cache.cacheRequestDiagnostics({
        identity,
        policy: diagnostics().policy,
        tools: toolsA,
        serializedTools: toolsA,
      });
      const exactKeyOrder = cache.cacheRequestDiagnostics({
        identity,
        policy: diagnostics().policy,
        tools: toolsKeyOrder,
        serializedTools: toolsKeyOrder,
      });

      expect(exactA.serializedToolsHash).not.toBe(exactKeyOrder.serializedToolsHash);
      expect(exactA.toolsHash).toBe(exactKeyOrder.toolsHash);
      expect(exactA.serializedToolsBytes).toBe(Buffer.byteLength(JSON.stringify(toolsA), "utf8"));

      const absent = cache.cacheRequestDiagnostics({ identity, policy: diagnostics().policy, tools: toolsA });
      expect(absent.serializedToolsHash).toBeNull();
      expect(absent.serializedToolsBytes).toBeNull();
    });

    it("classifies cache misses accurately across all causes", () => {
      const hit = cache.classifyCacheMiss({
        previous: prior,
        current: { ...prior, atMs: 60_000, usage: { inputTokens: 1_000, cacheReadTokens: 9_000, cacheWriteTokens: 0 } },
        noiseFloorTokens: 1_024,
      });
      expect(hit.primary).toBeNull();
      expect(hit.attributed).toBe(false);

      const keyMiss = cache.classifyCacheMiss({
        previous: prior,
        current: {
          ...prior,
          atMs: 60_000,
          usage: { inputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
          diagnostics: diagnostics({ identity: cacheIdentityFor({ ...base, sessionSeed: cacheSessionSeed("terminal-2") }) }),
        },
      });
      expect(keyMiss.primary).toBe("cache-key-changed");
      expect(keyMiss.missedTokens).toBe(10_000);

      const multiCause = cache.classifyCacheMiss({
        previous: prior,
        current: {
          ...prior,
          atMs: 60_000,
          postRevision: true,
          usage: { inputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
          diagnostics: diagnostics({ policy: { ...diagnostics().policy, fallbackReason: "unsupported-cache-field" }, modelSettings: { effort: "off" } }),
        },
      });
      expect(multiCause.primary).toBe("cache-policy-fallback");
      expect(multiCause.contributing).toContain("model-settings-changed");
      expect(multiCause.contributing).toContain("post-revision");

      const idle = cache.classifyCacheMiss({
        previous: prior,
        current: { ...prior, atMs: 31 * 60 * 1000, usage: { inputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      });
      expect(idle.primary).toBe("idle-expired");
    });
  });
});
