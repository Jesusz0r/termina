import { describe, expect, it } from "vitest";
import { salvageAssistantBlocks } from "../../../agent-core/main/stream-salvage.ts";

describe("failed-stream salvage", () => {
  it("keeps assistant text and complete tool calls", () => {
    expect(salvageAssistantBlocks([
      { type: "text", text: "PLAN: edit cache.ts" },
      { type: "thinking", thinking: "scratch" },
      { type: "tool_use", id: "call-1", name: "read_file", input: { path: "cache.ts" } },
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "x" } },
      { type: "tool_use", id: "", name: "bash", input: { command: "ls" } },
      { type: "tool_use", id: "call-2", name: "bash", input: "not-an-object" },
    ])).toEqual([
      { type: "text", text: "PLAN: edit cache.ts" },
      { type: "tool_use", id: "call-1", name: "read_file", input: { path: "cache.ts" } },
    ]);
  });

  it("keeps signed thinking and drops empty text", () => {
    expect(salvageAssistantBlocks([
      { type: "text", text: "" },
      { type: "thinking", thinking: "secret", signature: "sig" },
    ])).toEqual([{ type: "thinking", thinking: "secret", signature: "sig" }]);
  });
});
