import type { EffortLevelMap } from "../capabilities.ts";
import { modelLeaf } from "./identity.ts";

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
