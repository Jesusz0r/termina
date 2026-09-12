import { describe, it, expect } from "vitest";
import {
  CACHE_MISS_COMPACT_TOKENS,
  COMPACT_COST_REFERENCE_WINDOW,
  compactCostTokenThreshold,
  PROTECT_TURNS,
  evictionBoundary,
  isUserPrompt,
  messagesForSummary,
  planSummary,
  serializeForSummary,
  shouldCompactForCacheCost,
  summaryPrompt,
  truncateCut,
  type CompactionMessage,
} from "../../../agent-core/compaction.ts";

function msg(role: "user" | "assistant", text: string, tokens: number): CompactionMessage {
  return { role, content: [{ type: "text", text }], tokens };
}

function prompt(text: string, tokens: number): CompactionMessage {
  return { role: "user", content: text, tokens };
}

describe("compaction planning", () => {
  it("detects user prompts", () => {
    expect(isUserPrompt({ role: "user", content: "hi" })).toBe(true);
    expect(isUserPrompt({ role: "assistant", content: "hi" })).toBe(false);
    expect(isUserPrompt({ role: "user", content: [{ type: "tool_result", content: "x" }] })).toBe(false);
    expect(isUserPrompt({ role: "user", content: [{ type: "image", source: "x" }] })).toBe(true);
  });

  it("never treats a tool-result message as a prompt, even with sibling text", () => {
    // toolResultsWithRecovery appends harness guidance as a sibling text block
    // on the user tool_result message. It must stay a tool-turn message:
    // cutting there would evict the tool_use while keeping its orphan result,
    // which request projection rejects on every later turn.
    const mixed = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "done" },
        { type: "text", text: "(recovery guidance)" },
      ],
    };
    expect(isUserPrompt(mixed)).toBe(false);
    expect(isUserPrompt({
      role: "user",
      content: [
        { type: "web_search_tool_result", tool_use_id: "s1", content: "hits" },
        { type: "text", text: "(recovery guidance)" },
      ],
    })).toBe(false);
    // Genuine mixed user content (no result blocks) is still a prompt.
    expect(isUserPrompt({
      role: "user",
      content: [{ type: "image", source: "x" }, { type: "text", text: "look" }],
    })).toBe(true);
  });

  it("never splits a tool pair across the eviction boundary", () => {
    const toolUse: CompactionMessage = {
      role: "assistant",
      content: [{ type: "tool_use", name: "edit", input: {} }],
      tokens: 100,
    };
    const mixedResult: CompactionMessage = {
      role: "user",
      content: [
        { type: "tool_result", content: "ok" },
        { type: "text", text: "(recovery guidance)" },
      ],
      tokens: 100,
    };
    const history = [
      prompt("oldest", 100),
      prompt("old", 100),
      toolUse,
      mixedResult,
      msg("assistant", "ack", 100),
      prompt("new", 100),
    ];
    const boundary = evictionBoundary(history, 0);
    // The boundary must not land on the mixed result: that would evict the
    // tool_use while keeping its orphan result (projection failure).
    expect(boundary).not.toBe(3);
    const tail = history.slice(boundary);
    const keepsUse = tail.includes(toolUse);
    const keepsResult = tail.includes(mixedResult);
    expect(keepsUse).toBe(keepsResult);
  });

  it("never cuts truncation on a tool-result message", () => {
    const history = [
      prompt("one", 500),
      { role: "assistant", content: [{ type: "tool_use", name: "edit", input: {} }], tokens: 100 } as CompactionMessage,
      {
        role: "user",
        content: [{ type: "tool_result", content: "ok" }, { type: "text", text: "(recovery)" }],
        tokens: 500,
      } as CompactionMessage,
      msg("assistant", "ack", 100),
      prompt("two", 500),
    ];
    // total 1700 >= usable 1500; low-water 900 is first reachable past "one"
    // only when the mixed result is not a cut point.
    expect(truncateCut(history, 1700, 1500, 900)).toBe(4);
  });

  it("protects recent turns and lands on a prompt boundary", () => {
    const history = [
      prompt("old", 100),
      msg("assistant", "old reply", 100),
      prompt("mid", 100),
      msg("assistant", "mid reply", 100),
      prompt("new", 100),
      msg("assistant", "new reply", 100),
    ];
    // Guard budget only covers the tail: eviction ends at "mid".
    expect(evictionBoundary(history, 250)).toBe(2);
    // Nothing guarded yet: boundary 0 means evict nothing.
    expect(evictionBoundary(history.slice(4), 10_000)).toBe(0);
    expect(PROTECT_TURNS).toBe(2);
  });

  it("cuts truncation at prompts under the low-water mark", () => {
    const history = [
      prompt("one", 500),
      msg("assistant", "r1", 500),
      prompt("two", 500),
      msg("assistant", "r2", 500),
    ];
    expect(truncateCut(history, 500, 2000, 1000)).toBe(0);
    expect(truncateCut(history, 2000, 2000, 1000)).toBe(2);
    expect(truncateCut(history, 2000, 2000, 1000, 2)).toBe(2);
  });

  it("dedups the prior handoff and serializes evidence", () => {
    const handoff = "prior state";
    const prior = { role: "user", content: `<context-handoff>\n${handoff}\n</context-handoff>`, tokens: 10 } as CompactionMessage;
    const kept = prompt("next", 10);
    expect(messagesForSummary([prior, kept], handoff)).toEqual([kept]);
    const text = serializeForSummary([
      kept,
      msg("assistant", "did it", 10),
      { role: "assistant", content: [{ type: "tool_use", name: "bash", input: { command: "ls" } }], tokens: 10 },
    ]);
    expect(text).toContain("[User]: next");
    expect(text).toContain("[Assistant tool call]: bash(");
  });

  it("defers tiny evictions until enough new history can be reclaimed", () => {
    const tail = [prompt("recent one", 200), msg("assistant", "one", 200), prompt("recent two", 200)];
    const options = { lastHandoffBody: "prior", guardTokens: 0, minimumReclaimTokens: 1_000 };
    const handoff = { role: "user", content: "<context-handoff>\nprior\n</context-handoff>", tokens: 2_000 } as CompactionMessage;
    const tiny = [handoff, prompt("old but tiny", 40), msg("assistant", "reply", 40), ...tail];
    expect(planSummary(tiny, options)).toBeNull();
    // Explicit /compact and emergency fitting may reclaim a smaller span.
    expect(planSummary(tiny, { ...options, minimumReclaimTokens: 0 })?.boundary).toBe(3);
    const ready = [handoff, prompt("old and large", 800), msg("assistant", "reply", 300), ...tail];
    const snapshot = JSON.stringify(ready);
    const plan = planSummary(ready, options);
    expect(plan?.boundary).toBe(3);
    expect(plan?.evicted).toEqual(ready.slice(1, 3));
    expect(JSON.stringify(ready)).toBe(snapshot);
    expect(ready.slice(plan!.boundary)).toEqual(tail);
  });

  it("never calls a summarizer to fold only its own handoff again", () => {
    const handoff = { role: "user", content: "<context-handoff>\nprior\n</context-handoff>", tokens: 5_000 } as CompactionMessage;
    const tail = [prompt("recent one", 5_000), prompt("recent two", 5_000)];
    for (let turn = 0; turn < 10; turn++) {
      expect(planSummary([handoff, ...tail], {
        lastHandoffBody: "prior", guardTokens: 0, minimumReclaimTokens: 0,
      })).toBeNull();
    }
  });

  it("builds the handoff prompt with the prior folded in", () => {
    expect(summaryPrompt(null, "body")).toContain("<session-to-compress>\nbody\n</session-to-compress>");
    expect(summaryPrompt(null, "body")).not.toContain("previous-handoff");
    expect(summaryPrompt("old", "body")).toContain("<previous-handoff>\nold\n</previous-handoff>");
  });

  it("gates cost-driven compaction on expensive misses", () => {
    expect(shouldCompactForCacheCost(120_000, 0.1, 120_000, false)).toBe(true);
    expect(shouldCompactForCacheCost(120_000, 0.8, 120_000, false)).toBe(false);
    expect(shouldCompactForCacheCost(120_000, 0.1, 120_000, true)).toBe(false);
    expect(shouldCompactForCacheCost(null, 0.1, 120_000, false)).toBe(false);
  });

  it("derives the cost threshold from the context window with a floor", () => {
    expect(COMPACT_COST_REFERENCE_WINDOW).toBe(2 * CACHE_MISS_COMPACT_TOKENS);
    expect(compactCostTokenThreshold()).toBe(CACHE_MISS_COMPACT_TOKENS);
    expect(compactCostTokenThreshold(null)).toBe(CACHE_MISS_COMPACT_TOKENS);
    expect(compactCostTokenThreshold(NaN)).toBe(CACHE_MISS_COMPACT_TOKENS);
    // Small windows never compact more eagerly than the tuned default.
    expect(compactCostTokenThreshold(32_000)).toBe(CACHE_MISS_COMPACT_TOKENS);
    expect(compactCostTokenThreshold(200_000)).toBe(CACHE_MISS_COMPACT_TOKENS);
    // Large windows scale the trigger instead of firing at a fixed 100k.
    expect(compactCostTokenThreshold(1_000_000)).toBe(500_000);
  });

  it("keeps default behavior without a window and scales with one", () => {
    // Omitted window preserves the historical trigger.
    expect(shouldCompactForCacheCost(120_000, 0.1, 120_000, false)).toBe(true);
    // 1M window needs 500k billed/context before cost compaction fires.
    expect(shouldCompactForCacheCost(120_000, 0.1, 120_000, false, 1_000_000)).toBe(false);
    expect(shouldCompactForCacheCost(600_000, 0.1, 600_000, false, 1_000_000)).toBe(true);
    // 32k window stays floored at the default trigger.
    expect(shouldCompactForCacheCost(120_000, 0.1, 120_000, false, 32_000)).toBe(true);
  });
});
