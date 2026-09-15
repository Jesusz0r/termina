import type { EffortLevelMap } from "../capabilities.ts";
export function modelLooksClaude(model: string): boolean {
  return model.toLowerCase().includes("claude");
}

/** Prefer adaptive thinking on newer Claude models; 4.6 still accepts deprecated budgets. */
export function claudeThinkingApi(model: string): "adaptive" | "budget" | "none" {
  const id = model.toLowerCase();
  if (!id.includes("claude") || /claude-[1-3](?:-|$)/.test(id)) return "none";
  // Extended-thinking-only generations (4.5 and earlier): adaptive 400s here.
  // Unknown ids default to adaptive — budget thinking 400s on 4.7+.
  // https://platform.claude.com/docs/en/build-with-claude/extended-thinking
  if (/4[.-][0-5](?![0-9])/.test(id)) return "budget";
  return "adaptive";
}

/**
 * Opus 4.5 is the only extended-thinking-only model where output effort
 * composes with budget thinking: effort shapes the response while
 * budget_tokens sets thinking depth, so callers set both.
 * https://platform.claude.com/docs/en/build-with-claude/extended-thinking
 */
export function opus45ComposesEffort(model: string): boolean {
  return claudeThinkingApi(model) === "budget" && /opus-4[.-]5(?![0-9])/.test(model.toLowerCase());
}

function thinkingLockedOn(model: string): boolean {
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
