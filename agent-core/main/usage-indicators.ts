import type { ProviderId } from "../auth.ts";
import { cacheInputTokens, cacheWriteSupportedFor, type CacheFlipTally } from "../cache.ts";
import type { ProviderUsage } from "../openai-compat.ts";

type Usage = Pick<ProviderUsage, "input" | "cacheRead" | "cacheWrite" | "output">;
type RequestRole = "main" | "summary";

interface UsageTotals {
  input: number | null;
  cacheRead: number | null;
  output: number | null;
}

const RECENT_MAIN_REQUESTS = 10;
const COMPACT_TOKEN_FORMAT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function knownCount(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function requestTotals(usage: Usage | null, provider: ProviderId | null, model: string | null): UsageTotals {
  return {
    input: cacheInputTokens({
      inputTokens: usage?.input ?? null,
      cacheReadTokens: usage?.cacheRead ?? null,
      cacheWriteTokens: usage?.cacheWrite ?? null,
      cacheWriteSupported: provider === null ? null : cacheWriteSupportedFor(provider, usage?.cacheWrite ?? null, model),
    }),
    cacheRead: knownCount(usage?.cacheRead),
    output: knownCount(usage?.output),
  };
}

function emptyTotals(): UsageTotals {
  return { input: 0, cacheRead: 0, output: 0 };
}

function addKnown(previous: number | null, next: number | null): number | null {
  return previous === null || next === null ? null : knownCount(previous + next);
}

function addTotals(previous: UsageTotals, next: UsageTotals): UsageTotals {
  return {
    input: addKnown(previous.input, next.input),
    cacheRead: addKnown(previous.cacheRead, next.cacheRead),
    output: addKnown(previous.output, next.output),
  };
}

function cacheShare(totals: UsageTotals | undefined): string {
  if (!totals || totals.input === null || totals.input <= 0 || totals.cacheRead === null) return "--";
  return `${Math.round((totals.cacheRead / totals.input) * 100)}%`;
}

function compactTokenCount(value: number): string {
  return COMPACT_TOKEN_FORMAT.format(Math.round(value));
}

function tokenDisplay(value: number | null): string {
  return value === null ? "?" : compactTokenCount(value);
}

function renderIndicators(
  totals: UsageTotals,
  cacheLabel: string,
  contextTokens: number,
  maxContext: number,
  usd: number | null,
  flips: CacheFlipTally | null,
): string {
  const context = Math.round(knownCount(contextTokens) ?? 0);
  const limit = Math.max(1, Math.round(knownCount(maxContext) ?? 0));
  const contextPct = Math.round((context / limit) * 100);
  const cost = usd !== null && Number.isFinite(usd) && usd >= 0 ? ` · last $${usd.toFixed(4)}` : "";
  const flipCount = flips && Number.isInteger(flips.evaluations) && flips.evaluations > 0
    && Number.isInteger(flips.prefixFlips) && flips.prefixFlips >= 0
    ? ` · flips ${flips.prefixFlips}/${flips.evaluations}` : "";
  return `tokens ${tokenDisplay(totals.input)} in/${tokenDisplay(totals.output)} out · ${cacheLabel} · context ~${compactTokenCount(context)}/${compactTokenCount(limit)} ${contextPct}%${cost}${flipCount}`;
}

/** Stateless session-total formatter, also exposed by main for its test seam. */
export function formatUsageIndicators(
  usage: Usage,
  contextTokens: number,
  maxContext: number,
  usd: number | null = null,
  flips: CacheFlipTally | null = null,
  provider: ProviderId | null = null,
  model: string | null = null,
): string {
  const totals = requestTotals(usage, provider, model);
  return renderIndicators(totals, `cache session ${cacheShare(totals)}`, contextTokens, maxContext, usd, flips);
}

/** Process-lifetime accounting with a bounded main-request continuity window.
 * Normalize each request with its own provider and model before aggregation
 * so switches cannot reinterpret an earlier unknown write count as zero. */
export class UsageIndicators {
  private mainTotals = emptyTotals();
  private summaryTotals = emptyTotals();
  private recentMain: UsageTotals[] = [];

  record(usage: Usage | null, provider: ProviderId, model: string, role: RequestRole): void {
    const totals = requestTotals(usage, provider, model);
    if (role === "summary") {
      this.summaryTotals = addTotals(this.summaryTotals, totals);
      return;
    }
    this.mainTotals = addTotals(this.mainTotals, totals);
    this.recentMain.push(totals);
    if (this.recentMain.length > RECENT_MAIN_REQUESTS) this.recentMain.shift();
  }

  /** Model/provider continuity changed; lifetime totals remain untouched. */
  resetRecent(): void {
    this.recentMain = [];
  }

  /** Explicit clear starts fresh accounting for both request roles. */
  reset(): void {
    this.mainTotals = emptyTotals();
    this.summaryTotals = emptyTotals();
    this.resetRecent();
  }

  format(
    contextTokens: number,
    maxContext: number,
    usd: number | null = null,
    flips: CacheFlipTally | null = null,
  ): string {
    const recent = this.recentMain.reduce(addTotals, emptyTotals());
    const last = this.recentMain.at(-1);
    let cacheLabel = `cache last ${cacheShare(last)} · recent10 ${cacheShare(recent)} · session ${cacheShare(this.mainTotals)}`;
    const summary = this.summaryTotals;
    if (summary.input === null || summary.output === null || summary.input > 0 || summary.output > 0) {
      cacheLabel += ` · summary ${tokenDisplay(summary.input)} in/${tokenDisplay(summary.output)} out`;
    }
    return renderIndicators(addTotals(this.mainTotals, summary), cacheLabel, contextTokens, maxContext, usd, flips);
  }
}
