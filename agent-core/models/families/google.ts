import type { EffortLevel, EffortLevelMap } from "../capabilities.ts";
import { modelLeaf } from "./identity.ts";
export function modelLooksGemini(model: string): boolean {
  const leaf = modelLeaf(model);
  const n = model.toLowerCase();
  return leaf.startsWith("gemini") || n.includes("/gemini");
}

export function gemini3Model(model: string): boolean {
  return /gemini-[3-9]/.test(model.toLowerCase());
}

/**
 * Gemini 2.5 supports reasoning budgets through `reasoning_effort` on the
 * OpenAI-compatible endpoint, like generation 3+.
 * https://ai.google.dev/gemini-api/docs/openai
 */
export function gemini25Model(model: string): boolean {
  return /gemini-2\.5/.test(model.toLowerCase());
}

/**
 * Per-model Gemini level rejections observed as provider 400s. Newer
 * generations (live Zen docs already list up to 3.8 Flash) get the full
 * range unless a row below proves otherwise — rows only hide levels, so a
 * missing row fails loud (400) instead of hiding a working level.
 */
type GeminiEffortQuirk = {
  match: RegExp;
  unless?: RegExp;
  hide: readonly EffortLevel[];
};

const GEMINI_EFFORT_QUIRKS: readonly GeminiEffortQuirk[] = [
  // gemini-3-pro (no minor) rejects minimal; 3.1 Pro and later accept medium.
  { match: /gemini-3(?:\.\d+)?-pro/, hide: ["minimal"] },
  { match: /gemini-3-pro/, unless: /gemini-3\.\d+-pro/, hide: ["medium"] },
  // Gemini 3.7 Flash returns 400 on thinking_level minimal.
  { match: /gemini-3\.7.*flash/, unless: /lite/, hide: ["minimal"] },
];

export function geminiEffortLevelMap(model: string): EffortLevelMap {
  const id = model.toLowerCase();
  const map: EffortLevelMap = {};
  map.off = null;
  for (const quirk of GEMINI_EFFORT_QUIRKS) {
    if (quirk.match.test(id) && !(quirk.unless && quirk.unless.test(id))) {
      for (const level of quirk.hide) map[level] = null;
    }
  }
  return map;
}
