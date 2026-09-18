/**
 * Compaction planning owned by agent-core.
 *
 * Pure policy for fitting history into the provider window: protected-span
 * eviction, last-resort truncation, cost-driven compaction, and summary
 * serialization. No history, session, or provider access — the agent loop
 * applies these decisions (persist, splice, summarize calls).
 */

/** Minimal message shape planners need; the loop's Message is assignable. */
interface CompactionBlock {
  type: string;
  text?: unknown;
  thinking?: unknown;
  name?: unknown;
  input?: unknown;
  content?: unknown;
  source?: unknown;
  stubbed?: unknown;
}

interface CompactionMessage {
  role: "user" | "assistant";
  content: string | CompactionBlock[];
  tokens: number;
}

/** Shared hysteresis for pruning, summarization and truncation. */
export const HIGH_WATER = 0.8;
export const LOW_WATER = 0.6;
/** Newest user turns whose messages are never touched. */
export const PROTECT_TURNS = 2;

/** Compact an expensive miss before the request reaches the context limit. */
export const CACHE_MISS_COMPACT_TOKENS = 100_000;
const CACHE_MISS_COMPACT_SHARE = 0.5;
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
  if (!Array.isArray(m.content)) return false;
  // A tool-turn message stays a tool-turn message even when the harness
  // appends sibling text (e.g. stall-recovery guidance): cutting there would
  // evict the preceding tool_use while keeping its orphan result, which
  // request projection rejects on every later turn.
  let sawPromptBlock = false;
  for (const b of m.content) {
    if (!b || typeof b !== "object") continue;
    const type = (b as { type?: unknown }).type;
    if (type === "tool_result" || type === "web_search_tool_result") return false;
    if (type === "text" || type === "image") sawPromptBlock = true;
  }
  return sawPromptBlock;
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
 * byte-heuristic estimate with billed truth (see truncate()). protectTurns
 * keeps the newest user prompts (and the messages after them) in the suffix.
 * Returns the cut index, or 0 when nothing should be cut.
 */
export function truncateCut(
  messages: readonly CompactionMessage[],
  total: number,
  usableTokens: number,
  lowWaterTokens: number,
  tokenScale = 1,
  protectTurns: number = PROTECT_TURNS,
): number {
  if (total < usableTokens) return 0;
  const keptTurns = Math.max(1, protectTurns);
  let seen = 0;
  let protectStart = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isUserPrompt(messages[i]!)) continue;
    seen++;
    protectStart = i;
    if (seen >= keptTurns) break;
  }
  let cut = 0;
  let remaining = total;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (isUserPrompt(m)) {
      cut = i <= protectStart ? i : protectStart;
      remaining -= m.tokens * tokenScale;
      if (remaining < lowWaterTokens || i >= protectStart) break;
      continue;
    }
    remaining -= m.tokens * tokenScale;
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

function wrappedHandoff(body: string): string {
  return `<context-handoff>\n${body}\n</context-handoff>`;
}

/** Overflow may drop back to the current prompt only when a summarize
 *  handoff already exists to keep continuity. Otherwise keep PROTECT_TURNS. */
export function overflowProtectTurns(lastHandoffBody: string | null): number {
  return lastHandoffBody === null ? PROTECT_TURNS : 1;
}

/** Re-insert the existing summarize handoff after a cut that dropped it.
 *  Returns null when there was no summary, or when the kept suffix still has
 *  it. Does not invent an extract of the dropped span. */
export function restoreHandoffAfterCut(
  lastHandoffBody: string | null,
  kept: readonly Pick<CompactionMessage, "content">[],
): string | null {
  if (lastHandoffBody === null) return null;
  const wrapped = wrappedHandoff(lastHandoffBody);
  if (kept.some((message) => message.content === wrapped)) return null;
  return wrapped;
}

/** Remove the previous handoff from the next eviction input. The handoff is
 *  sent once in the explicit `<previous-handoff>` section of the prompt. */
export function messagesForSummary(
  messages: readonly CompactionMessage[],
  lastHandoffBody: string | null,
): CompactionMessage[] {
  const prior = lastHandoffBody === null ? null : wrappedHandoff(lastHandoffBody);
  return messages.filter((message) => message.content !== prior);
}

/** Batch automatic summaries across the hysteresis band instead of rewriting
 * the prefix for tiny evictions. A prior handoff alone is never new evidence.
 * Required fitting and explicit /compact use a zero minimum, but keep the
 * same protected-turn boundary. */
export function planSummary(
  messages: readonly CompactionMessage[],
  options: { lastHandoffBody: string | null; guardTokens: number; minimumReclaimTokens: number },
): { boundary: number; evicted: CompactionMessage[] } | null {
  const boundary = evictionBoundary(messages, options.guardTokens);
  if (boundary <= 0) return null;
  const evicted = messagesForSummary(messages.slice(0, boundary), options.lastHandoffBody);
  if (!evicted.length || evicted.reduce((sum, message) => sum + message.tokens, 0) < options.minimumReclaimTokens) return null;
  return { boundary, evicted };
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
      else if (b.type === "thinking" || b.type === "redacted_thinking") {
        const text = String(b.thinking ?? "").slice(0, 2_000);
        if (text) parts.push(`[${role} reasoning]: ${text}`);
      } else if (b.type === "tool_use" || b.type === "server_tool_use") {
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

/** Provider window-overflow shapes across Anthropic/OpenAI/Gemini/xAI. Tested
 * only against provider-thrown request errors, never user text. Generic nouns
 * stay verb-guarded so benign messages (e.g. "context window info") cannot
 * trigger a destructive summarize/truncate. */
export function isContextOverflowMessage(message: string): boolean {
  return /prompt is too long|maximum context|maximum prompt|context_length|request_too_large|request too large|too many tokens|tokens?\s+(exceed|exceeds|exceeded)|exceed.*tokens?|tokens?.*exceed|request contains .*tokens|input.*too long|prompt.*too (long|large|big)|context.*too (long|large|big)|context.*exceed|exceed.*context|token limit|context limit/i.test(message);
}

/** Build the cheap-lane summarization prompt: prior handoff plus the evicted span. */
export function summaryPrompt(priorHandoffBody: string | null, serialized: string): string {
  const prior = priorHandoffBody ? `<previous-handoff>\n${priorHandoffBody}\n</previous-handoff>\n\n` : "";
  return `${prior}<session-to-compress>\n${serialized}\n</session-to-compress>\n\nProduce the context handoff for continuing this session: task state, decisions made, files touched, open threads, and a compact evidence inventory of tool outcomes and search references. Only output the handoff.`;
}
