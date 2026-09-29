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
