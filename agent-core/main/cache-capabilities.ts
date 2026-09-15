/**
 * Process cache-capability gate.
 *
 * Owns one bounded capability cache for this process and forwards observe /
 * reject / identity decisions to cache.ts and auth/cache-policy.ts. It is
 * not a second catalog, cache, or protocol mapper: protocol and session
 * seed come from the caller.
 * Extracted from agent-core/main.ts (issue #324).
 */
import {
  CACHE_CAPABILITY_FEATURE,
  cacheIdentityFor,
  cacheRouteDomain,
  documentedCacheCapability,
  documentedCacheRoute,
  type CacheCapabilityScope,
  type CacheIdentity,
  type ProviderId,
  type ProviderProtocol,
} from "../auth.ts";
import { providerDefinition } from "../auth/providers/index.ts";
import {
  createCapabilityCache,
  queryCapability,
  recordCapability,
  type CapabilityCacheRecord,
} from "../cache.ts";

/** Route origin used for documented capability gates. Custom relay origins
 * remain unknown because a model name alone cannot establish their fields. */
export function cacheRouteForProvider(
  provider: ProviderId,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const definition = providerDefinition(provider);
  if (definition.baseEnv) {
    const configured = env[definition.baseEnv]?.trim();
    if (configured) return configured;
  }
  return documentedCacheRoute(provider);
}

export interface CacheCapabilityGate {
  observe(provider: ProviderId, model: string, feature: string): CapabilityCacheRecord;
  supported(provider: ProviderId, model: string, feature: string): boolean;
  recordRejected(provider: ProviderId, model: string, feature: string, reason: string): void;
  recordRejectedFields(
    provider: ProviderId,
    model: string,
    present: {
      promptCacheOptions: boolean;
      promptCacheBreakpoint: boolean;
      promptCacheKey: boolean;
    },
    detail: string,
  ): void;
  identityForRole(
    role: "main" | "summary",
    provider: ProviderId,
    model: string,
  ): CacheIdentity | null;
}

export function createCacheCapabilityGate(opts: {
  protocolFor: (provider: ProviderId, model: string) => ProviderProtocol;
  sessionSeed: () => string;
}): CacheCapabilityGate {
  /** One bounded, route/model/feature-scoped cache capability cache for this
   * process.  Documentation-backed observations are seeded lazily; relay and
   * compatibility routes stay explicitly unknown and therefore disabled. */
  const cacheCapabilities = createCapabilityCache();

  function cacheCapabilityScope(
    provider: ProviderId,
    model: string,
    feature: string,
  ): CacheCapabilityScope {
    return {
      provider,
      protocol: opts.protocolFor(provider, model),
      route: cacheRouteDomain(cacheRouteForProvider(provider)),
      model,
      feature,
    };
  }

  function observe(
    provider: ProviderId,
    model: string,
    feature: string,
  ): CapabilityCacheRecord {
    const scope = cacheCapabilityScope(provider, model, feature);
    const now = Date.now();
    const cached = queryCapability(cacheCapabilities, scope, now);
    if (cached.reason !== "not-observed" && cached.reason !== "expired") return cached;
    const documented = documentedCacheCapability(scope);
    const recorded = recordCapability(cacheCapabilities, {
      scope,
      supported: documented.supported,
      status: documented.status,
      source: documented.source,
      reason: documented.reason,
      provenance: documented.provenance,
      observedAtMs: now,
      // No provider-independent expiry is assumed.  A live rejection can be
      // invalidated by a process restart or a future route-specific probe.
      expiresAtMs: null,
    });
    return recorded ?? cached;
  }

  function supported(provider: ProviderId, model: string, feature: string): boolean {
    return observe(provider, model, feature).supported === true;
  }

  function recordRejected(
    provider: ProviderId,
    model: string,
    feature: string,
    reason: string,
  ): void {
    const scope = cacheCapabilityScope(provider, model, feature);
    recordCapability(cacheCapabilities, {
      scope,
      supported: false,
      status: "rejected",
      source: "probe",
      reason: reason.slice(0, 512),
      provenance: null,
      observedAtMs: Date.now(),
      // Retention/expiry is route-specific and unknown; do not invent a TTL.
      expiresAtMs: null,
    });
  }

  function recordRejectedFields(
    provider: ProviderId,
    model: string,
    present: {
      promptCacheOptions: boolean;
      promptCacheBreakpoint: boolean;
      promptCacheKey: boolean;
    },
    detail: string,
  ): void {
    const lower = detail.toLowerCase();
    const candidates: Array<{ feature: string; present: boolean; words: string[] }> = [
      {
        feature: CACHE_CAPABILITY_FEATURE.promptCacheOptions,
        present: present.promptCacheOptions,
        words: ["prompt_cache_options", "cache options"],
      },
      {
        feature: CACHE_CAPABILITY_FEATURE.promptCacheBreakpoint,
        present: present.promptCacheBreakpoint,
        words: ["prompt_cache_breakpoint", "cache breakpoint"],
      },
      {
        feature: CACHE_CAPABILITY_FEATURE.promptCacheKey,
        present: present.promptCacheKey,
        words: ["prompt_cache_key", "cache key"],
      },
    ];
    for (const candidate of candidates) {
      if (candidate.present && candidate.words.some((word) => lower.includes(word))) {
        recordRejected(provider, model, candidate.feature, detail);
      }
    }
  }

  function identityForRole(
    role: "main" | "summary",
    provider: ProviderId,
    model: string,
  ): CacheIdentity | null {
    const protocol = opts.protocolFor(provider, model);
    const identity = cacheIdentityFor({
      sessionSeed: opts.sessionSeed(),
      role,
      provider,
      protocol,
      route: cacheRouteForProvider(provider),
    });
    if (!identity) return null;
    // xAI documents different identities for Responses and Chat. A relay must
    // not receive the Chat header (or a diagnostic hash) merely because the
    // selected model happens to be a Grok model.
    // https://docs.x.ai/developers/advanced-api-usage/prompt-caching
    if (
      provider === "xai" &&
      !supported(provider, model, CACHE_CAPABILITY_FEATURE.promptCacheKey)
    ) {
      return null;
    }
    return identity;
  }

  return { observe, supported, recordRejected, recordRejectedFields, identityForRole };
}
