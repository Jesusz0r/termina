import type { EffortLevelMap } from "../capabilities.ts";
import type { ProviderId } from "../../auth.ts";
import { modelLeaf, oSeriesModel } from "./identity.ts";

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
  if (oSeriesModel(id)) {
    map.off = null;
    map.minimal = null;
    return map;
  }
  // Per-generation rows, each verified against its own live model page
  // (fetched 2026-09-14). Never infer one generation from another:
  // - gpt-5   minimal/low/medium/high, no none
  //           https://developers.openai.com/api/docs/models/gpt-5
  // - gpt-5.1 none/low/medium/high, no minimal, no xhigh
  //           https://developers.openai.com/api/docs/models/gpt-5.1
  // - gpt-5.2 none/low/medium/high/xhigh, no minimal, no max
  //           https://developers.openai.com/api/docs/models/gpt-5.2
  // Codex variants keep the codex branch below: 5.2-codex and 5.3-codex are
  // documented low/medium/high/xhigh with no none, and the 5.0/5.1-codex
  // pages state no effort list at all (undocumented, not inferred).
  if (!id.includes("codex")) {
    if (/gpt-5(?:\.0(?!\d))?(?![\d.])/.test(id)) {
      map.off = null;
      return map;
    }
    if (/gpt-5\.1(?!\d)/.test(id)) {
      map.minimal = null;
      return map;
    }
    if (/gpt-5\.2(?!\d)/.test(id)) {
      map.minimal = null;
      map.xhigh = "xhigh";
      return map;
    }
  }
  // 5.3 has no plain model page (only gpt-5.3-codex, low-high/xhigh, handled
  // by the codex arm); 5.4 and 5.5 (none/low-high/xhigh) match this branch
  // exactly, as do 5.6-sol (+max) and gpt-6-astra (no none, +max). Verified:
  // https://developers.openai.com/api/docs/models/gpt-5.4
  // https://developers.openai.com/api/docs/models/gpt-5.5
  // https://developers.openai.com/api/docs/models/gpt-5.6-sol
  // https://developers.openai.com/api/docs/models/gpt-6-astra
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

/**
 * Shared OpenAI Responses effort defaults plus per-provider wire tweaks.
 */
export function openaiProviderEffortLevelMap(provider: ProviderId, model: string): EffortLevelMap {
  const id = model.toLowerCase();
  const map = openaiEffortLevelMap(model);
  // Preserve provider restrictions after applying the shared model defaults.
  // O-series rules take precedence even if a catalog id contains another family.
  if (!oSeriesModel(id) && /gpt-(?:5\.[3-6]|[6-9])|codex/.test(id)) {
    if (provider === "openai-codex" || provider === "github-copilot") map.minimal = "low";
    if (provider === "github-copilot") map.off = null;
    else if (provider === "openrouter" && id.includes("codex") && !/gpt-[6-9]/.test(id)) delete map.off;
  }
  return map;
}
