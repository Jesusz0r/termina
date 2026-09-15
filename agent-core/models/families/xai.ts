import type { EffortLevelMap } from "../capabilities.ts";
import { modelLeaf } from "./identity.ts";

/** xAI Grok ids (`grok-4.6`, `x-ai/grok-4.6`). https://docs.x.ai/docs/models */
export function modelLooksGrok(model: string): boolean {
  const leaf = modelLeaf(model);
  const n = model.toLowerCase();
  return leaf.startsWith("grok") || n.includes("/grok");
}

export function nonReasoningGrok(model: string): boolean {
  return modelLeaf(model).startsWith("grok-") && model.toLowerCase().includes("non-reasoning");
}

export function grokEffortLevelMap(model: string): EffortLevelMap {
  const id = model.toLowerCase();
  const map: EffortLevelMap = {};
  if (!id.includes("4.3")) map.off = null;
  map.minimal = null;
  if (id.includes("4.6")) map.xhigh = "xhigh";
  map.max = null;
  return map;
}
