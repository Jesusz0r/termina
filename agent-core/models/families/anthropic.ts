import type { EffortLevelMap } from "../capabilities.ts";
import { modelLeaf } from "./identity.ts";
export function modelLooksClaude(model: string): boolean {
  const n = model.toLowerCase();
  return modelLeaf(model).includes("claude") || n.includes("claude");
}

/** Prefer adaptive thinking on newer Claude models; 4.6 still accepts deprecated budgets. */
export function claudeThinkingApi(model: string): "adaptive" | "budget" | "none" {
  const id = model.toLowerCase();
  if (!id.includes("claude") || /claude-[1-3](?:-|$)/.test(id)) return "none";
  if (/(?:sonnet|opus|fable|mythos)-5(?:$|[^0-9])/.test(id)) return "adaptive";
  if (/4[.-][6-8]/.test(id)) return "adaptive";
  return "budget";
}

export function thinkingLockedOn(model: string): boolean {
  const id = model.toLowerCase();
  return id.includes("fable") || id.includes("mythos");
}

export function claudeEffortLevelMap(model: string): EffortLevelMap {
  const id = model.toLowerCase();
  const map: EffortLevelMap = {};
  map.minimal = "low";
  map.max = "max";
  if (/(?:opus-4[.-][78]|(?:sonnet|opus|fable)-5)(?:$|[^0-9])/.test(id)) map.xhigh = "xhigh";
  if (thinkingLockedOn(model)) map.off = null;
  return map;
}
