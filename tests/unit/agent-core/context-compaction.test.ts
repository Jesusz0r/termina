import { describe, expect, it } from "vitest";
import {
  estimateReclaimTokens,
  planPruneStubs,
} from "../../../agent-core/reclaim.ts";

describe("Agent Core context and compaction estimates", () => {
  it("keeps the reclaim-space estimate deterministic and UTF-8 aware", () => {
    const text = "x".repeat(12);

    expect(estimateReclaimTokens(text)).toBe(3);
    expect(estimateReclaimTokens("ééé")).toBe(2);
    expect(estimateReclaimTokens("日本語")).toBe(3);
  });

  it("uses caller-supplied message tokens for the planner high-water decision", () => {
    const content = [{
      type: "tool_result",
      tool_use_id: "old-read",
      tool: "read_file",
      repro: "read_file src/old.ts",
      content: "x".repeat(3_000),
    }];
    const messages = [
      {
        role: "assistant",
        sseq: 1,
        content,
        // This value stands in for a provider-calibrated context estimate.
        // The planner must honor it rather than silently replacing it with
        // a byte heuristic.
        tokens: 1_024,
      },
      { role: "user", sseq: 2, content: "recent one" },
      { role: "user", sseq: 3, content: "recent two" },
    ];

    const plan = planPruneStubs(messages, {
      systemTokens: 0,
      usable: 1_000,
      protectTokens: 0,
    });
    expect(plan.map((pick) => pick.sseq)).toEqual([1]);
  });
});
