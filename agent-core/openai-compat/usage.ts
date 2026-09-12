/**
 * Provider usage and cost records.
 *
 * Owns token/usage merging and reported-cost extraction. Split from
 * agent-core/openai-compat.ts (issue #38).
 */
import type { CallResultLike } from "./types.ts";


export function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}


function firstToken(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = tokenCount(value);
    if (parsed !== null) return parsed;
  }
  return null;
}


function mergeDetailRecords(...values: unknown[]): Record<string, unknown> | null {
  let merged: Record<string, unknown> | null = null;
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    merged = { ...(merged ?? {}), ...(value as Record<string, unknown>) };
  }
  return merged;
}


export function uncachedInput(total: number | null, cacheRead: number | null, cacheWrite: number | null): number | null {
  if (total === null) return null;
  // OpenAI defines ordinary input as total input minus both cached reads and
  // cache writes. Preserve an impossible provider report as unknown instead
  // of manufacturing a zero-token miss.
  const accounted = (cacheRead ?? 0) + (cacheWrite ?? 0);
  if (accounted > total) return null;
  return Math.max(0, total - accounted);
}


export function mergeUsageRecords(
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...(previous ?? {}), ...next };
  for (const key of [
    "prompt_tokens_details",
    "input_tokens_details",
    "completion_tokens_details",
    "output_tokens_details",
  ]) {
    const before = previous?.[key];
    const after = next[key];
    if (
      before && typeof before === "object" && !Array.isArray(before) &&
      after && typeof after === "object" && !Array.isArray(after)
    ) {
      merged[key] = { ...(before as Record<string, unknown>), ...(after as Record<string, unknown>) };
    }
  }
  return merged;
}


/** Ticks per USD, per https://docs.x.ai/developers/cost-tracking. */
const USD_TICKS_PER_USD = 10_000_000_000;


/** Exact billed cost from an xAI-style usage payload; null when unreported. */
function reportedCostUsd(u: Record<string, unknown>): number | null {
  const ticks = u.cost_in_usd_ticks;
  if (typeof ticks !== "number" || !Number.isFinite(ticks) || ticks < 0) return null;
  const usd = ticks / USD_TICKS_PER_USD;
  return Number.isFinite(usd) && usd >= 0 ? usd : null;
}


export function usageFromOpenAI(u: Record<string, unknown> | undefined): CallResultLike["usage"] {
  if (!u) return null;
  const prompt = firstToken(u.input_tokens, u.prompt_tokens);
  const output = firstToken(u.output_tokens, u.completion_tokens);
  const promptDetails = mergeDetailRecords(u.prompt_tokens_details, u.input_tokens_details);
  const completionDetails = mergeDetailRecords(u.completion_tokens_details, u.output_tokens_details);
  const cached = firstToken(promptDetails?.cached_tokens, u.cached_tokens);
  const cacheWrite = firstToken(promptDetails?.cache_write_tokens, u.cache_write_tokens);
  const reasoning = firstToken(completionDetails?.reasoning_tokens, u.reasoning_tokens);
  return {
    input: uncachedInput(prompt, cached, cacheWrite),
    cacheRead: cached,
    cacheWrite,
    output,
    reasoning,
    reportedUsd: reportedCostUsd(u),
  };
}
