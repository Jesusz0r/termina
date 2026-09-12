/**
 * Documented cache-capability policy.
 *
 * Owns cache capability provenance and the documented per-route
 * capability matrix. Split from agent-core/auth.ts (issue #38).
 */
import { type ProviderId, type ProviderProtocol } from "./providers/types.ts";
import { modelLooksClaude } from "../models/families/anthropic.ts";
import { modelLooksGemini } from "../models/families/google.ts";
import { modelLeaf } from "../models/families/identity.ts";
import { cacheRouteDomain } from "./cache-identity.ts";
import { providerProtocol } from "./endpoints.ts";


export const CACHE_CAPABILITY_FEATURE = {
  anthropicCacheControl: "anthropic-cache-control",
  promptCacheKey: "prompt_cache_key",
  promptCacheOptions: "prompt_cache_options",
  promptCacheBreakpoint: "prompt_cache_breakpoint",
  xaiConversationHeader: "x-grok-conv-id",
  googleCachedContent: "google-cached-content",
  ttl: "cache-ttl",
  lookback: "cache-lookback",
} as const;


export type CacheCapabilityFeature = string;


export interface CacheCapabilityScope {
  provider: ProviderId;
  protocol: ProviderProtocol;
  route: string;
  model: string;
  feature: CacheCapabilityFeature;
}


export type CacheCapabilityStatus = "supported" | "rejected" | "unknown";

export type CacheCapabilitySource = "provider-docs" | "probe" | "unknown";


export interface CacheCapabilityProvenance {
  url: string;
  /** Retrieval date supplied by the implementation/audit, not provider data. */
  retrievedAt: string;
}


export interface CacheCapabilityObservation {
  supported: boolean | null;
  status: CacheCapabilityStatus;
  source: CacheCapabilitySource;
  reason: string | null;
  provenance: CacheCapabilityProvenance | null;
}


/** Primary documentation used for direct-route capability defaults. */
export const CACHE_POLICY_PROVENANCE = {
  anthropicPromptCaching: {
    url: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
    retrievedAt: "2026-08-30",
  },
  openaiPromptCaching: {
    url: "https://developers.openai.com/api/docs/guides/prompt-caching",
    retrievedAt: "2026-08-30",
  },
  openaiResponses: {
    url: "https://developers.openai.com/api/reference/cli/resources/responses/methods/create",
    retrievedAt: "2026-08-30",
  },
  xaiPromptCaching: {
    url: "https://docs.x.ai/developers/advanced-api-usage/prompt-caching",
    retrievedAt: "2026-08-30",
  },
  googleContextCaching: {
    url: "https://ai.google.dev/gemini-api/docs/generate-content/caching",
    retrievedAt: "2026-08-30",
  },
  openrouterPromptCaching: {
    url: "https://openrouter.ai/docs/guides/best-practices/prompt-caching",
    retrievedAt: "2026-09-04",
  },
} as const;


function unknownCapability(reason: string, provenance: CacheCapabilityProvenance | null = null): CacheCapabilityObservation {
  return { supported: null, status: "unknown", source: provenance ? "provider-docs" : "unknown", reason, provenance };
}


function documentedCapability(provenance: CacheCapabilityProvenance, reason: string): CacheCapabilityObservation {
  return {
    supported: true,
    status: "supported",
    source: "provider-docs",
    reason,
    provenance: { ...provenance },
  };
}


function documentedUnknown(provenance: CacheCapabilityProvenance, reason: string): CacheCapabilityObservation {
  return unknownCapability(reason, { ...provenance });
}


function isDirectDocumentedRoute(provider: ProviderId, route: string): boolean {
  const domain = cacheRouteDomain(route);
  if (provider === "anthropic") return domain === "api.anthropic.com";
  if (provider === "openai") return domain === "api.openai.com";
  if (provider === "openrouter") return domain === "openrouter.ai";
  if (provider === "xai") return domain === "api.x.ai";
  if (provider === "google") return domain === "generativelanguage.googleapis.com";
  return false;
}


function isGpt56OrLaterModel(model: string): boolean {
  if (typeof model !== "string") return false;
  const leaf = modelLeaf(model);
  const match = /^gpt-(\d+)(?:\.(\d+))?(?:[.-]|$)/.exec(leaf);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = match[2] === undefined ? 0 : Number(match[2]);
  return major > 5 || (major === 5 && minor >= 6);
}


function openrouterBreakpointModel(model: string): boolean {
  return isGpt56OrLaterModel(model) || modelLooksClaude(model) || modelLooksGemini(model);
}


/**
 * Return only documentation-backed defaults. Custom relay, Zen, and
 * compatibility routes intentionally remain unknown regardless of model name.
 */
export function documentedCacheCapability(scope: CacheCapabilityScope): CacheCapabilityObservation {
  if (!scope || typeof scope !== "object") return unknownCapability("invalid-capability-scope");
  if (!isDirectDocumentedRoute(scope.provider, scope.route)) return unknownCapability("route-not-directly-documented");
  const feature = scope.feature;
  if (scope.provider === "anthropic" && scope.protocol === "anthropic-messages") {
    if (feature === CACHE_CAPABILITY_FEATURE.anthropicCacheControl) {
      return documentedCapability(CACHE_POLICY_PROVENANCE.anthropicPromptCaching, "Anthropic Messages cache_control is documented");
    }
    if (feature === CACHE_CAPABILITY_FEATURE.ttl) {
      return documentedCapability(CACHE_POLICY_PROVENANCE.anthropicPromptCaching, "Anthropic cache duration field is documented; value remains policy data");
    }
  }
  if (scope.provider === "openai" && scope.protocol === "openai-responses") {
    if (feature === CACHE_CAPABILITY_FEATURE.promptCacheKey && typeof scope.model === "string" && scope.model.trim()) {
      return documentedCapability(CACHE_POLICY_PROVENANCE.openaiPromptCaching, "OpenAI Responses prompt_cache_key is documented");
    }
    if (
      (feature === CACHE_CAPABILITY_FEATURE.promptCacheBreakpoint || feature === CACHE_CAPABILITY_FEATURE.promptCacheOptions) &&
      isGpt56OrLaterModel(scope.model)
    ) {
      return documentedCapability(CACHE_POLICY_PROVENANCE.openaiPromptCaching, "OpenAI GPT-5.6 and later explicit cache field is documented");
    }
    if (feature === CACHE_CAPABILITY_FEATURE.ttl && isGpt56OrLaterModel(scope.model)) {
      return documentedCapability(CACHE_POLICY_PROVENANCE.openaiPromptCaching, "OpenAI GPT-5.6 and later cache TTL field is documented; value remains policy data");
    }
    if (feature === CACHE_CAPABILITY_FEATURE.promptCacheKey || feature === CACHE_CAPABILITY_FEATURE.promptCacheBreakpoint || feature === CACHE_CAPABILITY_FEATURE.promptCacheOptions) {
      return documentedUnknown(CACHE_POLICY_PROVENANCE.openaiPromptCaching, "model-specific support is not established");
    }
  }
  if (scope.provider === "openrouter" && scope.protocol === "openai-responses") {
    if (feature === CACHE_CAPABILITY_FEATURE.promptCacheKey && typeof scope.model === "string" && scope.model.trim()) {
      return documentedCapability(CACHE_POLICY_PROVENANCE.openrouterPromptCaching, "OpenRouter Responses accepts prompt_cache_key for sticky routing");
    }
    if (feature === CACHE_CAPABILITY_FEATURE.promptCacheBreakpoint && openrouterBreakpointModel(scope.model)) {
      return documentedCapability(CACHE_POLICY_PROVENANCE.openrouterPromptCaching, "OpenRouter Responses prompt_cache_breakpoint is documented and translates to supported provider breakpoints");
    }
    if (feature === CACHE_CAPABILITY_FEATURE.promptCacheOptions && isGpt56OrLaterModel(scope.model)) {
      return documentedCapability(CACHE_POLICY_PROVENANCE.openrouterPromptCaching, "OpenRouter documents prompt_cache_options for OpenAI GPT-5.6 and later");
    }
    if (feature === CACHE_CAPABILITY_FEATURE.ttl && isGpt56OrLaterModel(scope.model)) {
      return documentedCapability(CACHE_POLICY_PROVENANCE.openrouterPromptCaching, "OpenRouter documents the OpenAI Responses cache TTL option for GPT-5.6 and later; value remains policy data");
    }
    if (feature === CACHE_CAPABILITY_FEATURE.promptCacheBreakpoint) {
      return documentedUnknown(CACHE_POLICY_PROVENANCE.openrouterPromptCaching, "OpenRouter breakpoint translation is documented for GPT-5.6+ and Anthropic/Gemini model families");
    }
    if (feature === CACHE_CAPABILITY_FEATURE.promptCacheOptions || feature === CACHE_CAPABILITY_FEATURE.ttl) {
      return documentedUnknown(CACHE_POLICY_PROVENANCE.openrouterPromptCaching, "OpenRouter prompt_cache_options support is documented only for OpenAI GPT-5.6 and later");
    }
  }
  if (scope.provider === "xai") {
    if (scope.protocol === "openai-responses" && feature === CACHE_CAPABILITY_FEATURE.promptCacheKey) {
      return documentedCapability(CACHE_POLICY_PROVENANCE.xaiPromptCaching, "xAI Responses prompt_cache_key is documented");
    }
    if (scope.protocol === "openai-completions" && feature === CACHE_CAPABILITY_FEATURE.xaiConversationHeader) {
      return documentedCapability(CACHE_POLICY_PROVENANCE.xaiPromptCaching, "xAI Chat conversation header is documented");
    }
  }
  if (scope.provider === "google" && scope.protocol === "google-generate" && feature === CACHE_CAPABILITY_FEATURE.googleCachedContent) {
    return documentedCapability(CACHE_POLICY_PROVENANCE.googleContextCaching, "Gemini native cached content is documented");
  }
  if (scope.provider === "google" && scope.protocol === "google-generate" && feature === CACHE_CAPABILITY_FEATURE.ttl) {
    return documentedCapability(CACHE_POLICY_PROVENANCE.googleContextCaching, "Gemini native cache duration is documented; value remains policy data");
  }
  return unknownCapability("feature-not-documented-for-route");
}


/** Direct Anthropic Messages only; relays must prove marker support first. */
export function usesAnthropicCacheMarkers(provider: ProviderId, model: string, route: string): boolean {
  return documentedCacheCapability({ provider, protocol: providerProtocol(provider, model), route, model, feature: CACHE_CAPABILITY_FEATURE.anthropicCacheControl }).supported === true;
}


/** Direct documented OpenAI, OpenRouter, and xAI Responses routes only. */
export function usesPromptCacheKey(provider: ProviderId, model: string, route: string): boolean {
  return documentedCacheCapability({ provider, protocol: providerProtocol(provider, model), route, model, feature: CACHE_CAPABILITY_FEATURE.promptCacheKey }).supported === true;
}


/**
 * Direct OpenAI GPT-5.6+ and the documented OpenRouter Responses route accept
 * explicit prompt_cache_breakpoint. Copilot and Codex do not support it.
 */
export function usesOpenAIExplicitCache(model: string, provider: ProviderId, route: string): boolean {
  return documentedCacheCapability({ provider, protocol: providerProtocol(provider, model), route, model, feature: CACHE_CAPABILITY_FEATURE.promptCacheBreakpoint }).supported === true;
}


/**
 * Top-level prompt_cache_options on direct OpenAI Responses and the
 * documented OpenRouter Responses route. Other relays must feature-probe.
 */
export function usesPromptCacheOptions(provider: ProviderId, model: string, route: string): boolean {
  return documentedCacheCapability({ provider, protocol: providerProtocol(provider, model), route, model, feature: CACHE_CAPABILITY_FEATURE.promptCacheOptions }).supported === true;
}
