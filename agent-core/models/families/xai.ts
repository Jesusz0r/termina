import type { EffortLevelMap } from "../capabilities.ts";
import { modelLeaf } from "./identity.ts";

/** xAI Grok ids (`grok-4.7`, `x-ai/grok-4.6`). https://docs.x.ai/developers/models */
export function modelLooksGrok(model: string): boolean {
  const leaf = modelLeaf(model);
  const n = model.toLowerCase();
  return leaf.startsWith("grok") || n.includes("/grok");
}

export function nonReasoningGrok(model: string): boolean {
  return modelLeaf(model).startsWith("grok-") && model.toLowerCase().includes("non-reasoning");
}

/** `grok-4.6` → {4, 6}. */
function grokRelease(model: string): { major: number; minor: number } | null {
  const match = /^grok-(\d+)\.(\d+)/.exec(modelLeaf(model));
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return { major, minor };
}

/**
 * Catalog-silent fallback. Live `/v1/models` `capabilities.reasoning_effort`
 * is the set for a new generation, including grok-5. This table does not
 * extend itself to an undocumented id.
 *
 * `none` is only documented on grok-4.3. grok-4.5's model page lists
 * `xhigh`, but the reasoning guide says that value is treated as `high`.
 * https://docs.x.ai/developers/rest-api-reference/inference/models
 * https://docs.x.ai/developers/model-capabilities/text/reasoning
 * https://docs.x.ai/developers/models/grok-4.3
 * https://docs.x.ai/developers/models/grok-4.7
 * https://docs.x.ai/developers/model-capabilities/text/multi-agent
 */
function documentedGrokEffort(model: string): { off: boolean; xhigh: boolean } | null {
  const leaf = modelLeaf(model);
  if (leaf.includes("multi-agent")) return { off: false, xhigh: true };
  const release = grokRelease(model);
  if (!release || release.major !== 4) return null;
  if (release.minor === 3) return { off: true, xhigh: true };
  if (release.minor === 5) return { off: false, xhigh: false };
  if (release.minor === 6 || release.minor === 7) return { off: false, xhigh: true };
  return null;
}

export function grokHasDocumentedEffort(model: string): boolean {
  return documentedGrokEffort(model) !== null;
}

export function grokEffortLevelMap(model: string): EffortLevelMap {
  const documented = documentedGrokEffort(model);
  const map: EffortLevelMap = { minimal: null, max: null };
  if (!documented?.off) map.off = null;
  if (documented?.xhigh) map.xhigh = "xhigh";
  return map;
}
