import { describe, expect, it } from "vitest";
import { decodeToolCallArguments, parseCompletionStreamEvent, parseGoogleStreamEvent } from "../../../agent-core/openai-compat/parsers.ts";
import { completionResultFromEvents, googleResultFromEvents } from "../../../agent-core/openai-compat.ts";

describe("provider JSON parsers", () => {
  it("rejects array stream chunks before a reducer reads them", () => {
    expect(() => parseCompletionStreamEvent([])).toThrow("malformed stream event");
    expect(() => parseGoogleStreamEvent([])).toThrow("malformed stream event");
  });

  it("rejects non-object tool functions inside the stream parser", () => {
    for (const fn of [null, [], "function", 42]) {
      const parsed = parseCompletionStreamEvent({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: fn }] } }] });
      expect(parsed.toolCalls).toEqual([{ error: "provider protocol error: malformed tool call" }]);
      const google = parseGoogleStreamEvent({ candidates: [{ content: { parts: [{ functionCall: fn }] } }] });
      expect(google.parts[0]?.call).toEqual({ error: "provider protocol error: malformed tool call" });
    }
  });

  it("treats a null tool_calls delta as absent and rejects other non-array shapes", () => {
    // opencode-go/deepseek-v4.1-flash relay shape on reasoning/text deltas.
    const nullCalls = { choices: [{ index: 0, finish_reason: null, delta: { role: null, content: "", reasoning_content: "We", tool_calls: null } }] };
    expect(parseCompletionStreamEvent(nullCalls).toolCalls).toEqual([]);
    for (const calls of [{}, "call", 0, false]) {
      const parsed = parseCompletionStreamEvent({ choices: [{ delta: { tool_calls: calls } }] });
      expect(parsed.toolCalls).toEqual([{ error: "provider protocol error: malformed tool call" }]);
    }
    const result = completionResultFromEvents([
      nullCalls,
      { choices: [{ delta: { content: "", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "bash", arguments: "" } }] } }] },
      { choices: [{ delta: { content: "", tool_calls: [{ index: 0, function: { arguments: "{\"command\":\"ls\"}" } }] } }] },
      { choices: [{ finish_reason: "tool_calls", delta: { content: "", reasoning_content: null, tool_calls: null } }] },
    ], () => {}, 0);
    expect(result.error).toBeUndefined();
    expect(result.blocks).toEqual([
      { type: "thinking", thinking: "We" },
      { type: "tool_use", id: "call-1", name: "bash", input: { command: "ls" } },
    ]);
  });

  it("rejects malformed JSON and non-object arguments in the argument parser", () => {
    for (const raw of ["{", "[]", "null", '"text"', "42"]) {
      expect(decodeToolCallArguments(raw, true)).toEqual({ error: "provider protocol error: tool call arguments must be a JSON object" });
    }
    expect(decodeToolCallArguments('{"path":"a.ts"}', true)).toEqual({ input: { path: "a.ts" } });
    expect(decodeToolCallArguments([], false)).toEqual({ error: "provider protocol error: tool call arguments must be a JSON object" });
  });

  it("preserves text while refusing malformed executable calls atomically", () => {
    const completion = completionResultFromEvents([
      { choices: [{ delta: { content: "partial", tool_calls: [{ index: 0, id: "call-1", function: [] }] } }] },
    ], () => {}, 0);
    expect(completion.blocks).toEqual([{ type: "text", text: "partial" }]);
    expect(completion.error).toMatch(/malformed tool call/);
    const google = googleResultFromEvents([
      { candidates: [{ content: { parts: [{ text: "partial" }, { functionCall: [] }] } }] },
    ], () => {}, 0);
    expect(google.blocks).toEqual([{ type: "text", text: "partial" }]);
    expect(google.error).toMatch(/malformed tool call/);
  });
});
