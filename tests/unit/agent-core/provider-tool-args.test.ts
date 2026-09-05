import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as compat from "../../../agent-core/openai-compat.ts";
import * as core from "../../../agent-core/main.ts";

function completion(id: any, name: any, args: any) {
  return compat.completionResultFromEvents([
    {
      choices: [{
        delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] },
        finish_reason: "tool_calls",
      }],
    },
  ], () => {}, 0);
}

function responses(id: any, name: any, args: any) {
  return compat.responsesResultFromEvents([
    {
      type: "response.output_item.done",
      item: { type: "function_call", id: id ? "item-1" : "", call_id: id, name, arguments: args },
    },
  ], () => {}, 0);
}

function google(name: any, args: any) {
  return compat.googleResultFromEvents([
    { candidates: [{ content: { parts: [{ functionCall: { name, args } }] }, finishReason: "STOP" }] },
  ], () => {}, 0);
}

function malformedCompletionCall(raw: any) {
  return compat.completionResultFromEvents([
    { choices: [{ delta: { tool_calls: [raw] }, finish_reason: "tool_calls" }] },
  ], () => {}, 0);
}

function malformedGoogleCall(raw: any) {
  return compat.googleResultFromEvents([
    { candidates: [{ content: { parts: [{ functionCall: raw }] }, finishReason: "STOP" }] },
  ], () => {}, 0);
}

function atomicCompletion(secondArgs: any) {
  return compat.completionResultFromEvents([
    { choices: [{ delta: { tool_calls: [
      { index: 0, id: "call-valid", function: { name: "read_file", arguments: "{}" } },
      { index: 1, id: "call-invalid", function: { name: "bash", arguments: secondArgs } },
    ] }, finish_reason: "tool_calls" }] },
  ], () => {}, 0);
}

function atomicResponses(secondArgs: any) {
  return compat.responsesResultFromEvents([
    { type: "response.output_item.done", item: { type: "function_call", id: "item-valid", call_id: "call-valid", name: "read_file", arguments: "{}" } },
    { type: "response.output_item.done", item: { type: "function_call", id: "item-invalid", call_id: "call-invalid", name: "bash", arguments: secondArgs } },
  ], () => {}, 0);
}

function sseStream(lines: any[]) {
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        const payload = line === "[DONE]" ? line : JSON.stringify(line);
        controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`));
      }
      controller.close();
    },
  });
}

function atomicGoogle(secondArgs: any) {
  return compat.googleResultFromEvents([
    { candidates: [{ content: { parts: [
      { functionCall: { name: "read_file", args: {} } },
      { functionCall: { name: "bash", args: secondArgs } },
    ] }, finishReason: "STOP" }] },
  ], () => {}, 0);
}

function assertRejected(result: any, reason: RegExp) {
  expect(result.error ?? "").toMatch(reason);
  expect(result.blocks.some((block: any) => block.type === "tool_use")).toBe(false);
}

describe("Agent Core Provider Tool Arguments Contract", () => {
  const originalEnv = process.env.TERMINA_CORE_TEST;

  beforeAll(() => {
    process.env.TERMINA_CORE_TEST = "1";
  });

  afterAll(() => {
    if (originalEnv === undefined) delete process.env.TERMINA_CORE_TEST;
    else process.env.TERMINA_CORE_TEST = originalEnv;
  });

  describe("Chat Completions and Responses tool argument validation", () => {
    for (const [label, make] of [
      ["Chat Completions", completion],
      ["Responses", responses],
    ] as const) {
      it(`${label} rejects malformed JSON and non-object inputs`, () => {
        assertRejected(make("call-1", "bash", "{"), /tool call arguments.*JSON object/i);
        for (const raw of ["null", "[]", '"text"', "1", "true"]) {
          assertRejected(make("call-1", "bash", raw), /tool call arguments.*JSON object/i);
        }
        assertRejected(make("", "bash", "{}"), /tool call identity/i);
        assertRejected(make("call-1", "", "{}"), /tool call identity/i);
        assertRejected(make("   ", "bash", "{}"), /tool call identity/i);
        assertRejected(make("call-1", " \t ", "{}"), /tool call identity/i);
        assertRejected(make("call-1", "bash", undefined), /tool call arguments.*JSON object/i);

        const valid = make("call-1", "bash", "{}");
        expect(valid.error).toBeUndefined();
        expect(valid.blocks.find((block: any) => block.type === "tool_use")?.input).toEqual({});
      });
    }
  });

  describe("Google tool argument validation", () => {
    it("validates Google function calls", () => {
      for (const value of [null, [], "text", 1, true]) {
        assertRejected(google("bash", value), /tool call arguments.*JSON object/i);
      }
      assertRejected(google("", {}), /tool call identity/i);
      assertRejected(google(" \t ", {}), /tool call identity/i);
      assertRejected(google("bash", undefined), /tool call arguments.*JSON object/i);

      const validGoogle = google("bash", {});
      expect(validGoogle.error).toBeUndefined();
      expect(validGoogle.blocks.find((block: any) => block.type === "tool_use")?.input).toEqual({});
    });
  });

  describe("Atomic rejections and protocol conflicts", () => {
    it("rejects malformed entries atomically", () => {
      assertRejected(malformedCompletionCall(null), /malformed tool call/i);
      assertRejected(malformedGoogleCall(null), /malformed tool call/i);
      assertRejected(responses(undefined, undefined, undefined), /tool call identity/i);
      assertRejected(atomicCompletion("null"), /tool call arguments.*JSON object/i);
      assertRejected(atomicResponses("null"), /tool call arguments.*JSON object/i);
      assertRejected(atomicGoogle(null), /tool call arguments.*JSON object/i);
    });

    it("rejects streaming index conflicts and invalid deltas", () => {
      const missingIndex = compat.completionResultFromEvents([
        { choices: [{ delta: { tool_calls: [{ id: "call-1", function: { name: "read_file", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
      ] as any, () => {}, 0);
      assertRejected(missingIndex, /tool call|index|conflict/i);

      const conflictingId = compat.completionResultFromEvents([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "read_file", arguments: "{}" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-2", function: { name: "read_file", arguments: "" } }] }, finish_reason: "tool_calls" }] },
      ] as any, () => {}, 0);
      assertRejected(conflictingId, /tool call|index|conflict/i);
    });

    it("handles official null continuation deltas properly", () => {
      const chatOfficialNullContinuation = compat.completionResultFromEvents([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call-null-continuation",
                type: "function",
                function: { name: "read_file", arguments: "{\"path\":" },
              }],
            },
          }],
        },
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: null,
                type: null,
                function: { name: null, arguments: "\"package.json\"}" },
              }],
            },
            finish_reason: "tool_calls",
          }],
        },
      ] as any, () => {}, 0);

      expect(chatOfficialNullContinuation.error).toBeUndefined();
      expect(
        chatOfficialNullContinuation.blocks.find((block: any) => block.type === "tool_use")?.input,
      ).toEqual({ path: "package.json" });
    });

    it("rejects events arriving after terminal completion in SSE streams", async () => {
      const terminalEvents = [
        ["Responses", { type: "response.completed", response: { status: "completed", output: [] } }, { type: "response.output_item.added", item: { type: "function_call", id: "item-2", call_id: "call-2", name: "write_file", arguments: "{}" } }],
        ["Chat", { choices: [{ finish_reason: "stop" }] }, { choices: [{ delta: { tool_calls: [{ index: 0, id: "late", function: { name: "write_file", arguments: "{}" } }] } }] }],
        ["Google", { candidates: [{ finishReason: "STOP" }] }, { candidates: [{ content: { parts: [{ functionCall: { name: "write_file", args: {} } }] } }] }],
      ] as const;

      for (const [, terminal, late] of terminalEvents) {
        await expect(
          compat.readSseJson(sseStream([terminal, late])),
        ).rejects.toThrow(/terminal|after|complete/i);
      }
    });

    it("tolerates benign keepalive and duplicate trailers after terminal completion", async () => {
      const completed = {
        type: "response.completed",
        sequence_number: 3,
        response: { status: "completed", output: [] },
      };
      const events = await compat.readSseJson(sseStream([
        completed,
        { type: "ping", cost: 1 },
        completed,
      ]));
      expect(events.length).toBe(3);
      const parsed = compat.responsesResultFromEvents(events as any, () => {}, 0);
      expect(parsed.error).toBeUndefined();
      expect(parsed.stopReason).toBe("stop");
      const chatTerminal = { choices: [{ finish_reason: "stop" }] };
      const chat = await compat.readSseJson(sseStream([
        chatTerminal,
        { choices: [], usage: { prompt_tokens: 1 } },
        { type: "ping" },
      ]));
      expect(chat.length).toBe(3);
      await expect(
        compat.readSseJson(sseStream([
          completed,
          { type: "response.output_text.delta", delta: "late" },
        ])),
      ).rejects.toThrow(/after terminal/);
      await expect(
        compat.readSseJson(sseStream([
          chatTerminal,
          { choices: [{ delta: { content: "late" } }] },
        ])),
      ).rejects.toThrow(/after terminal/);
    });

    it("exposes core provider tool admission invariant", () => {
      expect(typeof core.providerToolAdmissionError).toBe("function");
      expect(
        core.providerToolAdmissionError([{ type: "tool_use", id: "call-1", name: "bash", input: [] }] as any) ?? "",
      ).toMatch(/tool call arguments.*object/i);
      expect(
        core.providerToolAdmissionError([{ type: "tool_use", id: "", name: "bash", input: {} }] as any) ?? "",
      ).toMatch(/tool call identity/i);
      expect(
        core.providerToolAdmissionError([{ type: "tool_use", id: "call-1", name: "bash", input: {} }] as any),
      ).toBeNull();
    });
  });
});
