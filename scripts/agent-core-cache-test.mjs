/** Focused tests for the canonical cache identity and miss diagnostics. */
const auth = await import("../agent-core/auth.ts");
const cache = await import("../agent-core/cache.ts");

const failures = [];
function check(name, condition, detail = "") {
  if (!condition) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

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
  role: "main",
  provider: "openrouter",
  protocol: "openai-responses",
  route: "openrouter.ai",
};

check("durable seed is stable", cacheSessionSeed(" terminal-1 ") === base.sessionSeed);
check("whitespace-only seed is ephemeral", cacheSessionSeed(" ") !== cacheSessionSeed(" "));
check("invalid control seed is rejected", cacheSessionSeed("terminal-1\n") === "");
check(
  "all C0/C1 controls are rejected",
  [...Array.from({ length: 32 }, (_, i) => i), ...Array.from({ length: 33 }, (_, i) => i + 127)].every(
    (code) => cacheSessionSeed(`terminal-${String.fromCodePoint(code)}`) === "",
  ),
);

const mainKey = deriveCacheIdentityKey(base);
check("identity key is present", typeof mainKey === "string" && mainKey.length > 0);
check("identity key is bounded", typeof mainKey === "string" && mainKey.length <= CACHE_KEY_MAX_LENGTH);
check("identity key is ASCII", typeof mainKey === "string" && /^[\x21-\x7e]+$/.test(mainKey));
check("identity key is stable", mainKey === deriveCacheIdentityKey(base));
check("long identifiers stay bounded", deriveCacheIdentityKey({ ...base, sessionSeed: cacheSessionSeed("x".repeat(100_000)) })?.length <= CACHE_KEY_MAX_LENGTH);
check("role namespaces are separated", mainKey !== deriveCacheIdentityKey({ ...base, role: "summary" }));
check("provider namespaces are separated", mainKey !== deriveCacheIdentityKey({ ...base, provider: "xai" }));
check("protocol namespaces are separated", mainKey !== deriveCacheIdentityKey({ ...base, protocol: "openai-completions" }));
check("route namespaces are separated", mainKey !== deriveCacheIdentityKey({ ...base, route: "api.openrouter.ai" }));
check("control characters fail closed", deriveCacheIdentityKey({ ...base, route: "api\u0000.openrouter.ai" }) === null);
check("unicode identifiers never leak", !JSON.stringify(cacheIdentityFor({ ...base, sessionSeed: cacheSessionSeed("秘密/terminal") })).includes("秘密"));
check("Anthropic markers are direct-route only", usesAnthropicCacheMarkers("anthropic", "claude-sonnet-5", "api.anthropic.com") && !usesAnthropicCacheMarkers("openrouter", "anthropic/claude-sonnet-5", "api.openrouter.ai") && !usesAnthropicCacheMarkers("opencode-zen", "claude-sonnet-5", "zen"));
check("prompt cache keys are direct-route only", usesPromptCacheKey("openai", "gpt-5.6", "api.openai.com") && usesPromptCacheKey("xai", "grok-4.6", "api.x.ai") && !usesPromptCacheKey("openrouter", "openai/gpt-5.6", "api.openrouter.ai") && !usesPromptCacheKey("opencode-zen", "gpt-5.6", "zen") && !usesPromptCacheKey("openai-codex", "gpt-5.6", "chatgpt.com"));
check("explicit OpenAI cache is direct OpenAI only", usesOpenAIExplicitCache("gpt-5.6", "openai", "api.openai.com") && !usesOpenAIExplicitCache("gpt-5.6", "openrouter", "api.openrouter.ai") && !usesOpenAIExplicitCache("gpt-5.6", "opencode-zen", "zen") && !usesOpenAIExplicitCache("gpt-5.6", "xai", "api.x.ai") && !usesOpenAIExplicitCache("gpt-5.6", "openai"));
check("explicit cache options share direct route guard", usesPromptCacheOptions("openai", "gpt-5.6", "api.openai.com") && !usesPromptCacheOptions("openrouter", "gpt-5.6", "api.openrouter.ai"));

const identity = cacheIdentityFor(base);
check("identity carries the canonical key", identity?.key === mainKey);
check("OpenRouter header uses only the derived key", identity && cacheSessionHeaders(identity)["x-session-id"] === mainKey);
check("OpenCode has no undocumented session header", Object.keys(cacheSessionHeaders(identity && { ...identity, provider: "opencode-zen" })).length === 0);
check("xAI Responses has no Chat-only session header", Object.keys(cacheSessionHeaders(identity && { ...identity, provider: "xai", protocol: "openai-responses" })).length === 0);
const xaiChatIdentity = cacheIdentityFor({ ...base, provider: "xai", protocol: "openai-completions", route: "api.x.ai" });
check("xAI Chat header uses the derived key", xaiChatIdentity && cacheSessionHeaders(xaiChatIdentity)["x-grok-conv-id"] === xaiChatIdentity.key);
check("tampered identity cannot reuse a key", Object.keys(cacheSessionHeaders(identity && { ...identity, provider: "xai", protocol: "openai-completions", route: "api.x.ai" })).length === 0);
check("OpenAI has no unsupported session header", Object.keys(cacheSessionHeaders(identity && { ...identity, provider: "openai" })).length === 0);

const directOpenAiScope = {
  provider: "openai",
  protocol: "openai-responses",
  route: "https://api.openai.com/v1",
  model: "gpt-5.6",
  feature: CACHE_CAPABILITY_FEATURE.promptCacheKey,
};
const directOpenAiCapability = documentedCacheCapability(directOpenAiScope);
check("documented direct capability is supported", directOpenAiCapability.supported === true && directOpenAiCapability.status === "supported");
check("documented capability includes provenance", directOpenAiCapability.provenance?.url === CACHE_POLICY_PROVENANCE.openaiPromptCaching.url && typeof directOpenAiCapability.provenance?.retrievedAt === "string");
check("OpenRouter model names do not infer capability", documentedCacheCapability({ ...directOpenAiScope, provider: "openrouter", route: "api.openrouter.ai", model: "openai/gpt-5.6" }).supported === null);
check("Zen model names do not infer capability", documentedCacheCapability({ ...directOpenAiScope, provider: "opencode-zen", route: "zen", model: "gpt-5.6" }).supported === null);
check("Gemini compatibility remains unknown", documentedCacheCapability({ ...directOpenAiScope, provider: "opencode-zen", protocol: "google-generate", route: "zen", model: "gemini-3.7-flash", feature: CACHE_CAPABILITY_FEATURE.googleCachedContent }).supported === null);
check("xAI TTL remains unknown", documentedCacheCapability({ ...directOpenAiScope, provider: "xai", protocol: "openai-responses", route: "api.x.ai", model: "grok-4.6", feature: CACHE_CAPABILITY_FEATURE.ttl }).supported === null);
check("xAI direct cache key is documented", documentedCacheCapability({ ...directOpenAiScope, provider: "xai", protocol: "openai-responses", route: "api.x.ai", model: "grok-4.6", feature: CACHE_CAPABILITY_FEATURE.promptCacheKey }).supported === true);
check("direct OpenAI TTL is known without a hardcoded value", documentedCacheCapability({ ...directOpenAiScope, feature: CACHE_CAPABILITY_FEATURE.ttl }).supported === true);
check("direct Gemini cache lifecycle is documented", documentedCacheCapability({ ...directOpenAiScope, provider: "google", protocol: "google-generate", route: "generativelanguage.googleapis.com", model: "gemini-3.7-flash", feature: CACHE_CAPABILITY_FEATURE.googleCachedContent }).supported === true);

const capabilityCache = createCapabilityCache(2);
check("capability cache uses a bounded key", typeof capabilityCacheKey(directOpenAiScope) === "string" && capabilityCacheKey(directOpenAiScope).length <= 80);
const cacheMiss = queryCapability(capabilityCache, directOpenAiScope, 1_000);
check("unobserved capability is nullable unknown", cacheMiss.supported === null && cacheMiss.status === "unknown");
const observed = recordCapability(capabilityCache, {
  scope: directOpenAiScope,
  supported: true,
  source: "probe",
  observedAtMs: "100",
  expiresAtMs: "2000",
});
check("capability observation records supported", observed?.supported === true && observed?.status === "supported");
check("capability query is stable before expiry", queryCapability(capabilityCache, directOpenAiScope, 1_999).supported === true);
check("capability expiry uses caller clock", queryCapability(capabilityCache, directOpenAiScope, 2_000).supported === null && queryCapability(capabilityCache, directOpenAiScope, 2_000).reason === "expired");
const rejected = recordCapability(capabilityCache, {
  scope: directOpenAiScope,
  status: "rejected",
  source: "probe",
  reason: "unsupported optional field",
  observedAtMs: 3_000,
  expiresAtMs: null,
});
check("rejected capability remains distinct", rejected?.supported === false && rejected?.status === "rejected" && queryCapability(capabilityCache, directOpenAiScope, 4_000).reason === "unsupported optional field");
check("capability invalidation removes one route", invalidateCapability(capabilityCache, directOpenAiScope) === true && queryCapability(capabilityCache, directOpenAiScope, 4_000).supported === null);
recordCapability(capabilityCache, { scope: directOpenAiScope, supported: true, source: "probe", observedAtMs: 5_000, expiresAtMs: null });
recordCapability(capabilityCache, { scope: { ...directOpenAiScope, model: "gpt-5.6-mini" }, supported: true, source: "probe", observedAtMs: 5_000, expiresAtMs: null });
recordCapability(capabilityCache, { scope: { ...directOpenAiScope, feature: CACHE_CAPABILITY_FEATURE.promptCacheOptions }, supported: true, source: "probe", observedAtMs: 5_000, expiresAtMs: null });
check("capability cache evicts oldest entry at bound", capabilityCache.entries.size === 2 && queryCapability(capabilityCache, directOpenAiScope, 6_000).supported === null);
check("capability key separates model and feature", capabilityCacheKey({ ...directOpenAiScope, model: "gpt-5.6-mini" }) !== capabilityCacheKey(directOpenAiScope) && capabilityCacheKey({ ...directOpenAiScope, feature: CACHE_CAPABILITY_FEATURE.promptCacheOptions }) !== capabilityCacheKey(directOpenAiScope));
check("capability bound is explicit", CAPABILITY_CACHE_MAX_ENTRIES >= 1);

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
const exactArrayOrder = cache.cacheRequestDiagnostics({
  identity,
  policy: diagnostics().policy,
  tools: toolsArrayOrder,
  serializedTools: toolsArrayOrder,
});
check("exact serialized tool hash changes with object key order", exactA.serializedToolsHash !== exactKeyOrder.serializedToolsHash);
check("semantic tool hash ignores object key order", exactA.toolsHash === exactKeyOrder.toolsHash);
check("exact serialized tool hash changes with array order", exactA.serializedToolsHash !== cache.cacheRequestDiagnostics({ identity, policy: diagnostics().policy, tools: toolsArrayOrder.slice().reverse(), serializedTools: toolsArrayOrder.slice().reverse() }).serializedToolsHash);
check("serialized tool byte count is exact UTF-8 JSON size", exactA.serializedToolsBytes === Buffer.byteLength(JSON.stringify(toolsA), "utf8"));
const absentSerializedTools = cache.cacheRequestDiagnostics({ identity, policy: diagnostics().policy, tools: toolsA });
const unsupportedSerializedTools = cache.cacheRequestDiagnostics({ identity, policy: diagnostics().policy, tools: toolsA, serializedTools: { tools: toolsA } });
check("serialized tool diagnostics are null when absent", absentSerializedTools.serializedToolsHash === null && absentSerializedTools.serializedToolsBytes === null);
check("serialized tool diagnostics are null when unsupported", unsupportedSerializedTools.serializedToolsHash === null && unsupportedSerializedTools.serializedToolsBytes === null);

const hit = cache.classifyCacheMiss({
  previous: prior,
  current: { ...prior, atMs: 60_000, usage: { inputTokens: 1_000, cacheReadTokens: 9_000, cacheWriteTokens: 0 } },
  noiseFloorTokens: 1_024,
});
check("cache hit is not a miss", hit.primary === null && hit.attributed === false);

const keyMiss = cache.classifyCacheMiss({
  previous: prior,
  current: {
    ...prior,
    atMs: 60_000,
    usage: { inputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    diagnostics: diagnostics({ identity: cacheIdentityFor({ ...base, sessionSeed: cacheSessionSeed("terminal-2") }) }),
  },
});
check("key miss is attributed", keyMiss.primary === "cache-key-changed" && keyMiss.missedTokens === 10_000);

const revisionAndSettings = cache.classifyCacheMiss({
  previous: prior,
  current: {
    ...prior,
    atMs: 60_000,
    postRevision: true,
    usage: { inputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    diagnostics: diagnostics({ policy: { ...diagnostics().policy, fallbackReason: "unsupported-cache-field" }, modelSettings: { effort: "off" } }),
  },
});
check("multi-cause miss preserves causes", revisionAndSettings.primary === "cache-policy-fallback" && revisionAndSettings.contributing.includes("model-settings-changed") && revisionAndSettings.contributing.includes("post-revision"));

const growingHistoryOnly = cache.classifyCacheMiss({
  previous: prior,
  current: {
    ...prior,
    atMs: 60_000,
    usage: { inputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    diagnostics: diagnostics({ messagePrefix: "a-longer-growing-history" }),
  },
});
check("growing history hash is not a reusable-prefix cause", growingHistoryOnly.primary === "backend-or-unknown" && !growingHistoryOnly.contributing.includes("message-prefix-changed"));

const reusablePrefixChanged = cache.classifyCacheMiss({
  previous: prior,
  current: {
    ...prior,
    atMs: 60_000,
    usage: { inputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    diagnostics: diagnostics({ reusablePrefix: "reusable-prefix-v2" }),
  },
});
check("reusable-prefix metadata is compared", reusablePrefixChanged.primary === "stable-prefix-changed");

const idle = cache.classifyCacheMiss({
  previous: prior,
  current: { ...prior, atMs: 31 * 60 * 1000, usage: { inputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0 } },
});
check("known TTL miss is idle-expired", idle.primary === "idle-expired");

const unknownIdle = cache.classifyCacheMiss({
  previous: prior,
  current: {
    ...prior,
    atMs: 31 * 60 * 1000,
    usage: { inputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    diagnostics: diagnostics({ policy: { ...diagnostics().policy, effectiveTtlMs: null, retentionKnown: null } }),
  },
});
check("unknown retention is not called eviction", unknownIdle.primary === "possible-idle-expiry");

const requestedOnlyIdle = cache.classifyCacheMiss({
  previous: prior,
  current: {
    ...prior,
    atMs: 31 * 60 * 1000,
    usage: { inputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    diagnostics: diagnostics({ policy: { ...diagnostics().policy, effectiveTtlMs: null, retentionKnown: true } }),
  },
});
check("requested TTL alone is only possible idle expiry", requestedOnlyIdle.primary === "possible-idle-expiry");

const policyBecameUnknown = cache.classifyCacheMiss({
  previous: prior,
  current: {
    ...prior,
    atMs: 60_000,
    usage: { inputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    diagnostics: diagnostics({ policy: { ...diagnostics().policy, effectiveTtlMs: null, retentionKnown: null } }),
  },
});
check("known-to-unknown policy transition is retained", policyBecameUnknown.primary === "cache-policy-changed");

const numericStrings = cache.classifyCacheMiss({
  previous: prior,
  current: {
    ...prior,
    atMs: 60_000,
    usage: { inputTokens: "5000", cacheReadTokens: "0", cacheWriteTokens: "0" },
    diagnostics: diagnostics({ policy: { ...diagnostics().policy, requestedTtlMs: "1800000", effectiveTtlMs: "1800000" } }),
  },
});
check("numeric strings are normalized before arithmetic", numericStrings.missedTokens === 5_000 && numericStrings.primary === "backend-or-unknown");

const incomplete = cache.classifyCacheMiss({
  previous: prior,
  current: { ...prior, atMs: 60_000, usage: { inputTokens: null, cacheReadTokens: 0, cacheWriteTokens: null } },
});
check("incomplete usage is unknown", incomplete.primary === "unknown" && incomplete.attributed === false && incomplete.missingFields.includes("current.inputTokens"));

if (failures.length) {
  console.error(`\n${failures.length} focused cache test(s) failed`);
  process.exitCode = 1;
} else {
  console.log("\nall focused cache tests passed");
}
