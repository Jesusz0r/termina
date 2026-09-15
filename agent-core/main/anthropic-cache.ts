/**
 * Anthropic Messages cache_control markers.
 *
 * Pure request-prefix helpers: default ephemeral mark, system/tool
 * breakpoints (max four), and last-stable-history stamp inside the
 * documented 20-block lookback. Does not decide route capability —
 * auth/cache-policy.ts owns that, and main.ts only stamps when the
 * capability gate says so.
 * Extracted from agent-core/main.ts (issue #324).
 *
 * https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 */

export type AnthropicCacheMark = { type: "ephemeral" };

/** Anthropic's default five-minute TTL is sliding and avoids the 1-hour write premium. */
export function anthropicCacheMark(): AnthropicCacheMark {
  return { type: "ephemeral" };
}

export function buildCachedPrefix(
  system: string,
  tools: Array<Record<string, unknown>>,
): {
  system: Array<{ type: "text"; text: string; cache_control: AnthropicCacheMark }>;
  tools: Array<Record<string, unknown> & { cache_control?: AnthropicCacheMark }>;
} {
  const mark = anthropicCacheMark();
  // Anthropic permits at most four explicit breakpoints. The system marker
  // consumes one, leaving three for tools. Preserve existing markers in
  // discovery order and only add the final-tool marker when budget remains.
  let toolMarkers = 0;
  const copied = tools.map((tool, index) => {
    const existing = Object.prototype.hasOwnProperty.call(tool, "cache_control");
    if (existing && toolMarkers < 3) {
      toolMarkers++;
      return { ...tool };
    }
    if (existing) {
      const { cache_control: _cacheControl, ...withoutMarker } = tool;
      return { ...withoutMarker };
    }
    if (index === tools.length - 1 && toolMarkers < 3) {
      toolMarkers++;
      return { ...tool, cache_control: mark };
    }
    return { ...tool };
  });
  return {
    system: [{ type: "text", text: system, cache_control: mark }],
    tools: copied,
  };
}

const HISTORY_CACHE_BLOCKS = new Set(["text", "tool_result", "image"]);

/** Stamp cache_control on the last stable history block. Skip thinking and
 *  tool_use. Only the provider's documented 20-block lookback is eligible. */
export function stampHistoryCache(
  messages: Array<{ role: string; content: unknown }>,
): Array<{ role: string; content: unknown }> {
  const mark = anthropicCacheMark();
  let lookback = 20;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (typeof m.content === "string") {
      if (lookback <= 0) break;
      lookback--;
      if (!m.content) continue;
      const next = messages.slice();
      next[i] = {
        ...m,
        content: [{ type: "text", text: m.content, cache_control: mark }],
      };
      return next;
    }
    if (!Array.isArray(m.content)) continue;
    const blocks = m.content as Array<Record<string, unknown>>;
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j]!;
      const bType = typeof b.type === "string" ? b.type : "";
      // Anthropic merges a run of consecutive tool_use blocks (and likewise
      // tool_result) into one lookback position, so only the run's far edge
      // consumes the budget. See "20-block lookback window" in the prompt
      // caching docs: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
      const prev = j > 0 ? blocks[j - 1] : null;
      const prevType = prev && typeof prev.type === "string" ? prev.type : "";
      const continuesRun = (bType === "tool_use" || bType === "tool_result") && prevType === bType;
      if (!continuesRun) {
        if (lookback <= 0) return messages;
        lookback--;
      }
      if (typeof b.type !== "string" || !HISTORY_CACHE_BLOCKS.has(b.type)) continue;
      if (Object.prototype.hasOwnProperty.call(b, "cache_control")) return messages;
      const next = messages.slice();
      const copied = blocks.slice();
      copied[j] = { ...b, cache_control: mark };
      next[i] = { ...m, content: copied };
      return next;
    }
  }
  return messages;
}
