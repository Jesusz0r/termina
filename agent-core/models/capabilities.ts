import { grokEffortLevelMap, nonReasoningGrok } from "./families/xai.ts";
import { openaiProviderEffortLevelMap } from "./families/openai.ts";
import type { ProviderId, ProviderProtocol } from "../auth.ts";
import type { ModelInfo } from "../models.ts";
import { modelLeaf } from "./families/identity.ts";
import { claudeThinkingApi, claudeEffortLevelMap, opus45ComposesEffort } from "./families/anthropic.ts";
import { gemini25Model, gemini3Model, geminiEffortLevelMap, modelLooksGemini } from "./families/google.ts";
import { glmEffortLevelMap, glmReasoningFamily, relayCompletionsEffortLevelMap, relayCompletionsFamily } from "./families/relay.ts";
import { museSparkEffortLevelMap, museSparkReasoningFamily } from "./families/muse-spark.ts";

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
  // GLM effort is only sent on the Responses/Completions wire shapes; on
  // Messages the value is dropped, so the level must not be offered there.
  if (!glmReasoningFamily(model)) return false;
  return protocol === "openai-responses" || protocol === "openai-codex-responses" || protocol === "openai-completions";
}

/**
 * Whether the harness controls reasoning on this route ("explicit") or the
 * provider applies its own default with no wire control ("provider-default").
 * Never presented as disabled: unknown is not off.
 */
export function effortControlFor(provider: ProviderId, model: string, protocol: ProviderProtocol): "explicit" | "provider-default" {
  return usesModelEffort(provider, model, protocol) ? "explicit" : "provider-default";
}

type EffortMapRule = {
  match: (provider: ProviderId, model: string, protocol: ProviderProtocol) => boolean;
  map: (provider: ProviderId, model: string, protocol: ProviderProtocol) => EffortLevelMap;
};

/**
 * First match wins. A new family is one row here — predicate and map live
 * in families/, next to the live-doc URLs they were verified against.
 * Unknown routes fall through to {} (provider default).
 */
const EFFORT_MAP_RULES: readonly EffortMapRule[] = [
  {
    match: (provider, model, protocol) =>
      (gemini3Model(model) || gemini25Model(model)) && (provider === "google" || protocol === "google-generate"),
    map: (_provider, model) => geminiEffortLevelMap(model),
  },
  {
    match: (_provider, model) => claudeThinkingApi(model) === "adaptive",
    map: (_provider, model) => claudeEffortLevelMap(model),
  },
  {
    // Minimal has no documented effort wire value, so it rides low like the
    // adaptive map; the level list itself is unchanged.
    match: (_provider, model) => opus45ComposesEffort(model),
    map: () => ({ minimal: "low" }),
  },
  {
    match: (_provider, model) => glmReasoningFamily(model),
    map: (_provider, _model, protocol) => glmEffortLevelMap(protocol),
  },
  {
    match: (provider, model, protocol) => usesRelayCompletionsEffort(provider, model, protocol),
    map: () => relayCompletionsEffortLevelMap(),
  },
  {
    match: (_provider, model) => responsesReasoningFamily(model) && model.toLowerCase().includes("grok"),
    map: (_provider, model) => grokEffortLevelMap(model),
  },
  {
    match: (_provider, model) => responsesReasoningFamily(model) && museSparkReasoningFamily(model),
    map: () => museSparkEffortLevelMap(),
  },
  {
    match: (_provider, model) => responsesReasoningFamily(model),
    map: (provider, model) => openaiProviderEffortLevelMap(provider, model),
  },
];

function effortLevelMap(provider: ProviderId, model: string, protocol: ProviderProtocol): EffortLevelMap {
  for (const rule of EFFORT_MAP_RULES) {
    if (rule.match(provider, model, protocol)) return rule.map(provider, model, protocol);
  }
  return {};
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
  if (!usesAnthropicThinking(provider, model, protocol)) return undefined;
  // Opus 4.5 composes output effort with budget thinking; every other
  // budget model takes depth from budget_tokens alone.
  if (claudeThinkingApi(model) !== "adaptive" && !opus45ComposesEffort(model)) return undefined;
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

/** Catalog-reported tool support, or null when the catalog is silent. */
export function catalogSupportsTools(entry: ModelInfo | undefined): boolean | null {
  if (!entry || !Array.isArray(entry.supportedParameters)) return null;
  return entry.supportedParameters.includes("tools");
}

/**
 * Documented context windows for the OpenAI families, largest generation first.
 *
 * The openai catalog does not report these — `/v1/models` carries no context
 * field — so this table *is* the window for that route, and the same model name
 * served by a relay gets the same value.
 *
 * Sources (all fetched 2026-09-10; verified against the models.dev catalog):
 * - gpt-6-astra        1,050,000  https://developers.openai.com/api/docs/models/gpt-6-astra
 * - gpt-5.6 (sol/terra/luna), gpt-5.5*, gpt-5.4* main tiers
 *                      1,050,000  https://developers.openai.com/api/docs/models/gpt-5.6-sol
 * - gpt-5.0 - 5.3, and the 5.4 mini/nano tiers
 *                        400,000  https://developers.openai.com/api/docs/models/gpt-5
 * - o-series            200,000  https://developers.openai.com/api/docs/models/o3
 * - gpt-4o              128,000  https://developers.openai.com/api/docs/models/gpt-4o
 *
 * The generation boundary is real, not cosmetic: 5.0-5.3 are 400k while 5.4 and
 * later are 1.05M, and the mini/nano tiers stayed at 400k when their main tier
 * moved. `/models` returns no metadata to distinguish them, so these tiers are
 * named explicitly rather than approximated.
 */
function openaiContextWindow(leaf: string): number | null {
  // Dated chat aliases and the codex "spark" tier are capped at 128k even
  // though their generation is larger.
  if (leaf.endsWith("-chat-latest") || leaf === "gpt-5.3-codex-spark") return 128_000;
  // Only the documented gpt-6 id: one data point is not a generation trend, and
  // a future gpt-6 tier must not inherit the flagship's window by accident.
  if (leaf.startsWith("gpt-6-astra")) return 1_050_000;
  // 5.4 through 5.9 are all documented at 1.05M, so the range generalizes.
  if (/^gpt-5\.[4-9]/.test(leaf) && !/-(?:mini|nano)$/.test(leaf)) return 1_050_000;
  if (/^gpt-5/.test(leaf)) return 400_000;
  if (/^o[0-9]/.test(leaf)) return 200_000;
  if (/^gpt-4o/.test(leaf)) return 128_000;
  // An undocumented id (a future generation) falls through to the floor rather
  // than inheriting a window it was never documented to have.
  return null;
}

/**
 * Conservative floor for a route whose window cannot be established.
 *
 * A relay catalog accepts any model id (`acceptsId: () => true`), so an
 * unrecognized id may be any size. The coding families these relays serve span
 * that whole range on their own — measured across the models.dev catalog, qwen
 * runs 4k-10M, deepseek 4k-1.3M, kimi 32k-1M, glm 12k-1.3M — so the family name
 * cannot pick a window either. The catalog is the only reliable source:
 * `contextWindow()` prefers a catalog-reported value and falls back here only
 * for ids the catalog did not describe.
 *
 * This is the same documented floor used for older OpenAI models:
 * https://developers.openai.com/api/docs/models/gpt-4o
 *
 * The direction matters. Over-estimating costs a failed request plus a forced
 * truncate; under-estimating only compacts a little sooner. So an unknown route
 * takes the conservative value rather than the largest one seen anywhere.
 */
const UNKNOWN_CONTEXT_FLOOR = 128_000;

export function defaultContextWindow(provider: ProviderId, model: string): number {
  const id = model.toLowerCase();
  const leaf = modelLeaf(model);
  if (id.includes("haiku")) return 200_000;
  if (provider === "xai" || leaf.startsWith("grok")) return 500_000;
  // Gemini's documented input window is 2^20, not a round 1M. Non-Gemini
  // ids on the Google provider (Gemma, image tiers) take the floor.
  if (provider === "google") return modelLooksGemini(model) ? 1_048_576 : UNKNOWN_CONTEXT_FLOOR;
  if (provider === "anthropic") return 1_000_000;
  // A named OpenAI family carries a documented window; anything else — every
  // relay id the catalog did not describe — takes the conservative floor.
  return openaiContextWindow(leaf) ?? UNKNOWN_CONTEXT_FLOOR;
}
