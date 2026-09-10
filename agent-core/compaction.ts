/**
 * Compaction planning owned by agent-core.
 *
 * Pure policy for fitting history into the provider window: protected-span
 * eviction, last-resort truncation, cost-driven compaction, and summary
 * serialization. No history, session, or provider access — the agent loop
 * applies these decisions (persist, splice, summarize calls).
 */

/** Minimal message shape planners need; the loop's Message is assignable. */
export interface CompactionBlock {
  type: string;
  text?: unknown;
  name?: unknown;
  input?: unknown;
  content?: unknown;
  source?: unknown;
  stubbed?: unknown;
}

export interface CompactionMessage {
  role: "user" | "assistant";
  content: string | CompactionBlock[];
  tokens: number;
}

/** Newest user turns whose messages are never touched. */
export const PROTECT_TURNS = 2;

/** Compact an expensive miss before the request reaches the context limit. */
export const CACHE_MISS_COMPACT_TOKENS = 100_000;
export const CACHE_MISS_COMPACT_SHARE = 0.5;
/** Default window the floor constants were tuned against (2 × the floor). */
export const COMPACT_COST_REFERENCE_WINDOW = 2 * CACHE_MISS_COMPACT_TOKENS;

/** Cost-compaction token threshold for a context window. Half the window keeps
 * the historical trigger ratio, floored so small windows never compact more
 * eagerly than the tuned default. */
export function compactCostTokenThreshold(contextWindow?: number | null): number {
  const window = typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
    ? contextWindow
    : COMPACT_COST_REFERENCE_WINDOW;
  return Math.max(CACHE_MISS_COMPACT_TOKENS, Math.floor(window / 2));
}

export function isUserPrompt(m: { role: string; content: unknown }): boolean {
  if (m.role !== "user") return false;
  if (typeof m.content === "string") return true;
  return Array.isArray(m.content) && m.content.some((b) => {
    if (!b || typeof b !== "object") return false;
    const type = (b as { type?: unknown }).type;
    return type === "text" || type === "image";
  });
}

export function shouldCompactForCacheCost(
  billedTokens: number | null,
  cacheReadShare: number | null,
  contextTokens: number,
  followedRevision: boolean,
  contextWindow?: number | null,
): boolean {
  const threshold = compactCostTokenThreshold(contextWindow);
  return (
    !followedRevision &&
    billedTokens !== null &&
    cacheReadShare !== null &&
    billedTokens >= threshold &&
    contextTokens >= threshold &&
    cacheReadShare < CACHE_MISS_COMPACT_SHARE
  );
}

/**
 * Newest-first protected span, mirroring the planner's window. Returns the
 * index where the evicted span ends, adjusted back to a prompt boundary so
 * the surviving tail starts a clean turn. guardTokens is the protected byte
 * budget (e.g. min(protectTokens(), usableTokens() / 4)).
 */
export function evictionBoundary(
  messages: readonly CompactionMessage[],
  guardTokens: number,
  protectTurns: number = PROTECT_TURNS,
): number {
  let guarded = 0;
  let seen = 0;
  let boundary = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    boundary = i;
    guarded += messages[i]!.tokens;
    if (isUserPrompt(messages[i]!)) {
      seen++;
      if (seen >= protectTurns && guarded >= guardTokens) break;
    }
  }
  // The tail must start at a real prompt; walk forward past orphan results.
  while (
    boundary < messages.length &&
    !isUserPrompt(messages[boundary]!)
  ) {
    boundary++;
  }
  return boundary;
}

/**
 * Last-resort truncation cut: drop whole old turns at real prompts until the
 * total falls clearly below the low-water mark. tokenScale reconciles the
 * byte-heuristic estimate with billed truth (see truncate()). Returns the cut
 * index, or 0 when nothing should be cut.
 */
export function truncateCut(
  messages: readonly CompactionMessage[],
  total: number,
  usableTokens: number,
  lowWaterTokens: number,
  tokenScale = 1,
): number {
  if (total < usableTokens) return 0;
  let cut = 0;
  let remaining = total;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (isUserPrompt(m)) cut = i;
    remaining -= m.tokens * tokenScale;
    if (i === cut && remaining < lowWaterTokens) break;
  }
  return cut;
}

function summaryValue(value: unknown, maxChars: number): string {
  if (typeof value === "string") return value.slice(0, maxChars);
  try {
    const encoded = JSON.stringify(value);
    return (typeof encoded === "string" ? encoded : String(value)).slice(0, maxChars);
  } catch {
    return String(value).slice(0, maxChars);
  }
}

/** Remove the previous handoff from the next eviction input. The handoff is
 *  sent once in the explicit `<previous-handoff>` section of the prompt. */
export function messagesForSummary(
  messages: readonly CompactionMessage[],
  lastHandoffBody: string | null,
): CompactionMessage[] {
  const prior = lastHandoffBody === null
    ? null
    : `<context-handoff>\n${lastHandoffBody}\n</context-handoff>`;
  return messages.filter((message) => message.content !== prior);
}

export function serializeForSummary(messages: readonly CompactionMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "Assistant" : "User";
    if (typeof m.content === "string") {
      parts.push(`[${role}]: ${m.content.slice(0, 2_000)}`);
      continue;
    }
    for (const b of m.content) {
      if (b.type === "text") parts.push(`[${role}]: ${String(b.text ?? "").slice(0, 2_000)}`);
      else if (b.type === "tool_use" || b.type === "server_tool_use") {
        parts.push(`[${role} tool call]: ${b.name}(${summaryValue(b.input, 300)})`);
      } else if (b.type === "tool_result" && !b.stubbed) {
        parts.push(`[Tool result]: ${summaryValue(b.content, 500)}`);
      } else if (b.type === "web_search_tool_result") {
        parts.push(`[Search evidence]: ${summaryValue(b.content, 800)}`);
      } else if (b.type === "image") {
        parts.push(`[${role} image]: ${summaryValue(b.source, 160)}`);
      }
    }
  }
  return parts.join("\n").slice(0, 60_000);
}

/** Build the cheap-lane summarization prompt: prior handoff plus the evicted span. */
export function summaryPrompt(priorHandoffBody: string | null, serialized: string): string {
  const prior = priorHandoffBody ? `<previous-handoff>\n${priorHandoffBody}\n</previous-handoff>\n\n` : "";
  return `${prior}<session-to-compress>\n${serialized}\n</session-to-compress>\n\nProduce the context handoff for continuing this session: task state, decisions made, files touched, open threads, and a compact evidence inventory of tool outcomes and search references. Only output the handoff.`;
}
