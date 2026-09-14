import { modelLeaf } from "./identity.ts";
import type { EffortLevelMap } from "../capabilities.ts";
import type { ProviderProtocol } from "../../auth.ts";
export function modelLooksQwen(model: string): boolean {
  const leaf = modelLeaf(model);
  const n = model.toLowerCase();
  return leaf.startsWith("qwen") || n.includes("/qwen");
}

/**
 * Zhipu GLM reasoning lineage (live Zen docs list 5, 5.1, 5.2; Go also
 * serves 5.3). Members share one contract — restricted level subset, xhigh
 * on Responses / max on Completions — so a new generation is one row here,
 * not a new predicate.
 */
const GLM_REASONING_FAMILIES: readonly RegExp[] = [/glm-5/];

export function glmReasoningFamily(model: string): boolean {
  const id = model.toLowerCase();
  return GLM_REASONING_FAMILIES.some((family) => family.test(id));
}

/** Families with existing relay effort rules when routed through Chat Completions.
 * The provider and resolved protocol decide whether these rules apply.
 */
const RELAY_COMPLETIONS_FAMILIES = [
  "big-pickle",
  "deepseek",
  "glm",
  "kimi",
  "ling",
  "longcat",
  "mimo",
  "minimax",
  "muse-spark",
  "nemotron",
  "qwen",
] as const;

export function relayCompletionsFamily(leaf: string): boolean {
  if (RELAY_COMPLETIONS_FAMILIES.some((family) => leaf.startsWith(family))) return true;
  return /^hy[34](?:[.-]|$)/.test(leaf);
}

/**
 * Relay Chat Completions effort subset: the relay publishes no per-model
 * metadata, so minimal and xhigh stay hidden rather than risking a
 * provider 400, and max is enabled.
 */
export function relayCompletionsEffortLevelMap(): EffortLevelMap {
  return { minimal: null, xhigh: null, max: "max" };
}

/** GLM effort: restricted subset, xhigh on Responses, max otherwise. */
export function glmEffortLevelMap(protocol: ProviderProtocol): EffortLevelMap {
  const map: EffortLevelMap = { off: null, minimal: null, low: null, medium: null };
  if (protocol === "openai-responses" || protocol === "openai-codex-responses") map.xhigh = "xhigh";
  else map.max = "max";
  return map;
}
