import type { EffortLevelMap } from "../capabilities.ts";
import { modelLeaf } from "./identity.ts";

export function gpt56ReasoningContext(model: string): "all_turns" | undefined {
  const leaf = modelLeaf(model);
  if (!(leaf.startsWith("gpt-5.6") || leaf.includes("gpt-5.6"))) return undefined;
  return "all_turns";
}

/** GPT-5 coding requests keep short answers. Pro and Codex keep provider defaults. */
export function gpt5TextVerbosity(model: string): "low" | undefined {
  const leaf = modelLeaf(model);
  if (!leaf.startsWith("gpt-5")) return undefined;
  if (leaf.includes("pro") || leaf.includes("codex")) return undefined;
  return "low";
}

export function openaiEffortLevelMap(model: string): EffortLevelMap {
  const id = model.toLowerCase();
  const map: EffortLevelMap = {};
  if (/(?:^|\/)o[0-9]/.test(id)) {
    map.off = null;
    map.minimal = null;
    return map;
  }
  if (/gpt-(?:5\.[3-6]|[6-9])|codex/.test(id)) {
    map.minimal = null;
    if (
      // GPT-6 Astra rejects reasoning none with HTTP 400 (live model page).
      /gpt-[6-9]/.test(id) ||
      (id.includes("codex") && !id.includes("5.6"))
    ) {
      map.off = null;
    }
    map.xhigh = "xhigh";
  }
  if (id.includes("5.6") || /gpt-[6-9]/.test(id)) map.max = "max";
  return map;
}
