import { grokEffortLevelMap, nonReasoningGrok } from "./families/xai.ts";
import { openaiEffortLevelMap } from "./families/openai.ts";
import type { ProviderId, ProviderProtocol } from "../auth.ts";
import type { ModelInfo } from "../models.ts";
import { modelLeaf } from "./families/identity.ts";
import { claudeThinkingApi, claudeEffortLevelMap } from "./families/anthropic.ts";
import { gemini25Model, gemini3Model, geminiEffortLevelMap } from "./families/google.ts";
import { glmReasoningFamily, relayCompletionsFamily } from "./families/relay.ts";

export const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export type EffortLevelMap = Partial<Record<EffortLevel, string | null>>;
type ReasoningEffort = "none" | Exclude<EffortLevel, "off">;
const FIXED_THINK_BUDGET = 16_384;
export type ThinkingRequest =
  | { type: "disabled" }
  | { type: "adaptive"; display: "summarized" }
  | { type: "enabled"; budget_tokens: number };

/**
 * Model families with a known Responses `reasoning.effort` contract, matched
 * against the lowercased id (prefix included, so `openai/o3` still matches).
 * A new family is one row here — not a new predicate. Anchored entries
 * (gpt-[5-9], o-series) stay regexes so older or foreign models can't
 * smuggle in on a substring.
 */
const RESPONSES_REASONING_FAMILIES: readonly RegExp[] = [
  /gpt-[5-9]/,
  /gpt-oss/,
  /codex/,
  /grok/,
  /muse-spark/,
  /(?:^|\/)o[0-9]/,
];

function responsesReasoningFamily(model: string): boolean {
  const id = model.toLowerCase();
  return RESPONSES_REASONING_FAMILIES.some((family) => family.test(id));
}

function responsesReasoningModel(model: string): boolean {
  const id = model.toLowerCase();
  // xAI's explicitly non-reasoning Grok variants reject reasoning.effort.
  if (nonReasoningGrok(model)) return false;
  return responsesReasoningFamily(model) || claudeThinkingApi(model) !== "none" || /gemini-[3-9]/.test(id);
}

/** Relay chat/completions models with a known reasoning contract. */
export function usesRelayCompletionsEffort(provider: ProviderId, model: string, protocol: ProviderProtocol): boolean {
  if (provider !== "opencode-zen" && provider !== "opencode-go") return false;
  if (protocol !== "openai-completions") return false;
  return relayCompletionsFamily(modelLeaf(model));
}

/** Anthropic thinking fields belong on Messages + a Claude model, not on the login id. */
export function usesAnthropicThinking(_provider: ProviderId, model: string, protocol: ProviderProtocol): boolean {
  return protocol === "anthropic-messages" && claudeThinkingApi(model) !== "none";
}

/** Effort that this protocol actually sends. Login id is not enough. */
export function usesModelEffort(provider: ProviderId, model: string, protocol: ProviderProtocol): boolean {
  if (usesAnthropicThinking(provider, model, protocol)) return true;
  if ((protocol === "openai-responses" || protocol === "openai-codex-responses") && responsesReasoningModel(model)) return true;
  if ((gemini3Model(model) || gemini25Model(model)) && (provider === "google" || protocol === "google-generate")) {
    return true;
  }
  if (usesRelayCompletionsEffort(provider, model, protocol)) return true;
  return glmReasoningFamily(model);
}

/**
 * Whether the harness controls reasoning on this route ("explicit") or the
 * provider applies its own default with no wire control ("provider-default").
 * Never presented as disabled: unknown is not off.
 */
export function effortControlFor(provider: ProviderId, model: string, protocol: ProviderProtocol): "explicit" | "provider-default" {
  return usesModelEffort(provider, model, protocol) ? "explicit" : "provider-default";
}

function effortLevelMap(provider: ProviderId, model: string, protocol: ProviderProtocol): EffortLevelMap {
  const id = model.toLowerCase();
  const map: EffortLevelMap = {};
  if ((gemini3Model(model) || gemini25Model(model)) && (provider === "google" || protocol === "google-generate")) {
    return geminiEffortLevelMap(model);
  }

  if (claudeThinkingApi(model) === "adaptive") {
    return claudeEffortLevelMap(model);
  }

  if (glmReasoningFamily(model)) {
    map.off = null;
    map.minimal = null;
    map.low = null;
    map.medium = null;
    if (protocol === "openai-responses" || protocol === "openai-codex-responses") map.xhigh = "xhigh";
    else map.max = "max";
    return map;
  }
  if (usesRelayCompletionsEffort(provider, model, protocol)) {
    // Core subset only: the relay publishes no per-model metadata, so
    // minimal and xhigh stay hidden rather than risking a provider 400.
    map.minimal = null;
    map.xhigh = null;
    map.max = "max";
    return map;
  }
  if (!responsesReasoningFamily(model)) return map;
  if (id.includes("grok")) return grokEffortLevelMap(model);
  const openaiMap = openaiEffortLevelMap(model);
  // Preserve provider restrictions after applying the shared model defaults.
  // O-series rules take precedence even if a catalog id contains another family.
  if (!/(?:^|\/)o[0-9]/.test(id) && /gpt-(?:5\.[3-6]|[6-9])|codex/.test(id)) {
    if (provider === "openai-codex" || provider === "github-copilot") openaiMap.minimal = "low";
    if (provider === "github-copilot") openaiMap.off = null;
    else if (provider === "openrouter" && id.includes("codex") && !/gpt-[6-9]/.test(id)) delete openaiMap.off;
  }
  return openaiMap;
}

export function supportedEffortLevels(provider: ProviderId, model: string, protocol: ProviderProtocol): EffortLevel[] {
  if (!usesModelEffort(provider, model, protocol)) return ["off"];
  const map = effortLevelMap(provider, model, protocol);
  return EFFORT_LEVELS.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export function clampEffortLevel(provider: ProviderId, model: string, effort: EffortLevel, protocol: ProviderProtocol): EffortLevel {
  const available = supportedEffortLevels(provider, model, protocol);
  if (available.includes(effort)) return effort;
  const requested = EFFORT_LEVELS.indexOf(effort);
  for (let i = requested; i < EFFORT_LEVELS.length; i++) {
    if (available.includes(EFFORT_LEVELS[i]!)) return EFFORT_LEVELS[i]!;
  }
  for (let i = requested - 1; i >= 0; i--) {
    if (available.includes(EFFORT_LEVELS[i]!)) return EFFORT_LEVELS[i]!;
  }
  return "off";
}

export function thinkingEnabledFor(provider: ProviderId, model: string, effort: EffortLevel, protocol: ProviderProtocol): boolean {
  return clampEffortLevel(provider, model, effort, protocol) !== "off";
}

export function reasoningEffortFor(
  provider: ProviderId,
  model: string,
  effort: EffortLevel,
  protocol: ProviderProtocol,
): ReasoningEffort | undefined {
  if (usesAnthropicThinking(provider, model, protocol) || !usesModelEffort(provider, model, protocol)) return undefined;
  const actual = clampEffortLevel(provider, model, effort, protocol);
  const mapped = effortLevelMap(provider, model, protocol)[actual];
  if (typeof mapped === "string") return mapped as ReasoningEffort;
  return actual === "off" ? "none" : actual;
}

export function thinkingRequestFor(
  provider: ProviderId,
  model: string,
  effort: EffortLevel,
  protocol: ProviderProtocol,
): ThinkingRequest | undefined {
  if (!usesAnthropicThinking(provider, model, protocol)) return undefined;
  const api = claudeThinkingApi(model);
  if (api === "none") return undefined;
  const actual = clampEffortLevel(provider, model, effort, protocol);
  if (api === "adaptive") {
    if (actual === "off") return { type: "disabled" };
    return { type: "adaptive", display: "summarized" };
  }
  if (actual === "off") return undefined;
  const budgets: Record<Exclude<EffortLevel, "off">, number> = {
    minimal: 1_024,
    low: 2_048,
    medium: 8_192,
    high: FIXED_THINK_BUDGET,
    xhigh: FIXED_THINK_BUDGET,
    max: FIXED_THINK_BUDGET,
  };
  return { type: "enabled", budget_tokens: budgets[actual] };
}

export function adaptiveEffortFor(
  provider: ProviderId,
  model: string,
  effort: EffortLevel,
  protocol: ProviderProtocol,
): ReasoningEffort | undefined {
  if (!usesAnthropicThinking(provider, model, protocol) || claudeThinkingApi(model) !== "adaptive") return undefined;
  const actual = clampEffortLevel(provider, model, effort, protocol);
  if (actual === "off") return undefined;
  const mapped = effortLevelMap(provider, model, protocol)[actual];
  return (typeof mapped === "string" ? mapped : actual) as ReasoningEffort;
}

export function effectiveEffortFor(provider: ProviderId, model: string, effort: EffortLevel, protocol: ProviderProtocol): EffortLevel {
  return clampEffortLevel(provider, model, effort, protocol);
}

/** Grok rejects OpenAI encrypted-reasoning include, including on Zen and OpenRouter. */
export function includeEncryptedReasoning(provider: ProviderId, model: string): boolean {
  if (provider === "xai") return false;
  if (modelLeaf(model).startsWith("grok")) return false;
  return true;
}

/** Catalog-reported max completion tokens, or null when the catalog is silent. */
export function catalogOutputLimit(entry: ModelInfo | undefined): number | null {
  if (!entry || typeof entry.outputLimit !== "number" || !Number.isFinite(entry.outputLimit) || entry.outputLimit < 1_000) {
    return null;
  }
  return Math.floor(entry.outputLimit);
}

/** Catalog-reported wire reasoning levels, or null when the catalog is silent. */
export function catalogReasoningLevels(entry: ModelInfo | undefined): string[] | null {
  if (!entry || !Array.isArray(entry.reasoningLevels) || entry.reasoningLevels.length === 0) return null;
  return [...entry.reasoningLevels];
}

/** Catalog-reported tool support, or null when the catalog is silent. */
export function catalogSupportsTools(entry: ModelInfo | undefined): boolean | null {
  if (!entry || !Array.isArray(entry.supportedParameters)) return null;
  return entry.supportedParameters.includes("tools");
}

export function defaultContextWindow(provider: ProviderId, model: string): number {
  const id = model.toLowerCase();
  if (id.includes("haiku")) return 200_000;
  if (provider === "xai" || modelLeaf(model).startsWith("grok")) return 500_000;
  if (provider === "anthropic" || provider === "google") return 1_000_000;
  // Conservative documented floor for OpenAI models without catalog context
  // (gpt-4o/gpt-4o-mini are 128k; larger-context models report real metadata).
  // https://developers.openai.com/api/docs/models/gpt-4o
  if (provider === "openai") return 128_000;
  return 1_050_000;
}
