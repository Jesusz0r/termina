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

function google(name: any, args: any, id: any = "call-1") {
  return compat.googleResultFromEvents([
    { candidates: [{ content: { parts: [{ functionCall: { name, args, id } }] }, finishReason: "STOP" }] },
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
      { functionCall: { name: "read_file", args: {}, id: "call-valid" } },
      { functionCall: { name: "bash", args: secondArgs, id: "call-invalid" } },
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
      assertRejected(google("bash", {}, ""), /tool call identity/i);
      assertRejected(google("bash", {}, "   "), /tool call identity/i);
      assertRejected(google("bash", undefined), /tool call arguments.*JSON object/i);

      const validGoogle = google("bash", {});
      expect(validGoogle.error).toBeUndefined();
      expect(validGoogle.blocks.find((block: any) => block.type === "tool_use")?.input).toEqual({});
    });
  });

  describe("Google functionCall identity and thought signatures", () => {
    function googleParts(parts: any[]) {
      return compat.googleResultFromEvents([
        { candidates: [{ content: { parts }, finishReason: "STOP" }] },
      ], () => {}, 0);
    }

    it("persists provider functionCall ids through decode", () => {
      const result = googleParts([
        { functionCall: { name: "read_file", args: { path: "a.ts" }, id: "provider-call-1" } },
        { functionCall: { name: "read_file", args: { path: "b.ts" }, id: "provider-call-2" } },
      ]);
      expect(result.error).toBeUndefined();
      const calls = result.blocks.filter((block: any) => block.type === "tool_use");
      expect(calls.map((call: any) => [call.id, call.name, call.input])).toEqual([
        ["provider-call-1", "read_file", { path: "a.ts" }],
        ["provider-call-2", "read_file", { path: "b.ts" }],
      ]);
    });

    it("rejects Google function calls without a provider id instead of inventing one", () => {
      assertRejected(googleParts([{ functionCall: { name: "read_file", args: {} } }]), /tool call identity/i);
      assertRejected(
        googleParts([{ functionCall: { name: "read_file", args: {}, id: 7 } }]),
        /tool call identity/i,
      );
    });

    it("keeps same-name parallel calls distinct while deduping snapshot repeats by id", () => {
      const parallel = googleParts([
        { functionCall: { name: "read_file", args: { path: "same.ts" }, id: "provider-call-1" } },
        { functionCall: { name: "read_file", args: { path: "same.ts" }, id: "provider-call-2" } },
      ]);
      expect(parallel.error).toBeUndefined();
      expect(
        parallel.blocks.filter((block: any) => block.type === "tool_use").map((call: any) => call.id),
      ).toEqual(["provider-call-1", "provider-call-2"]);

      const repeats = compat.googleResultFromEvents(
        [
          { candidates: [{ content: { parts: [{ functionCall: { name: "read_file", args: { path: "a.ts" }, id: "provider-call-1" } }] } }] },
          { candidates: [{ content: { parts: [{ functionCall: { name: "read_file", args: { path: "a.ts" }, id: "provider-call-1" } }] }, finishReason: "STOP" }] },
        ],
        () => {},
        0,
      );
      expect(repeats.error).toBeUndefined();
      expect(repeats.blocks.filter((block: any) => block.type === "tool_use")).toHaveLength(1);
    });

    it("round-trips provider ids and the first-call thoughtSignature on replay", () => {
      const decoded = googleParts([
        { functionCall: { name: "read_file", args: { path: "a.ts" }, id: "provider-call-1" }, thoughtSignature: "sig-1" },
        { functionCall: { name: "read_file", args: { path: "b.ts" }, id: "provider-call-2" } },
      ]);
      expect(decoded.error).toBeUndefined();
      expect(
        decoded.blocks.filter((block: any) => block.type === "tool_use").map((call: any) => [call.id, call.thought_signature]),
      ).toEqual([
        ["provider-call-1", "sig-1"],
        ["provider-call-2", undefined],
      ]);

      const body = compat.googleGenerateBody("", [
        { role: "assistant", content: decoded.blocks },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "provider-call-1", content: "contents-a" },
            { type: "tool_result", tool_use_id: "provider-call-2", content: "contents-b" },
          ],
        },
      ], []);
      const contents = body.contents as any[];
      expect(contents.map((item: any) => item.role)).toEqual(["model", "user"]);
      expect(contents[0].parts).toEqual([
        {
          functionCall: { name: "read_file", args: { path: "a.ts" }, id: "provider-call-1" },
          thoughtSignature: "sig-1",
        },
        { functionCall: { name: "read_file", args: { path: "b.ts" }, id: "provider-call-2" } },
      ]);
      expect(contents[1].parts).toEqual([
        { functionResponse: { name: "read_file", response: { output: "contents-a" }, id: "provider-call-1" } },
        { functionResponse: { name: "read_file", response: { output: "contents-b" }, id: "provider-call-2" } },
      ]);
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

    it("round-trips Gemini thought signatures across two tool turns", () => {
      const turn1 = compat.completionResultFromEvents([
        { choices: [{ delta: { tool_calls: [
          { index: 0, id: "call-1", type: "function", function: { name: "read_file", arguments: "{\"path\":" }, extra_content: { google: { thought_signature: "sig-1" } } },
          { index: 1, id: "call-2", type: "function", function: { name: "bash", arguments: "{}" } },
        ] } }] },
        { choices: [{ delta: { tool_calls: [
          { index: 0, id: null, type: null, function: { name: null, arguments: "\"a.txt\"}" } },
          { index: 1, id: null, type: null, function: { name: null, arguments: "" }, extra_content: { google: { thought_signature: "sig-2" } } },
        ] }, finish_reason: "tool_calls" }] },
      ] as any, () => {}, 0);
      expect(turn1.error).toBeUndefined();
      const calls = turn1.blocks.filter((block: any) => block.type === "tool_use");
      expect(calls.map((call: any) => [call.id, call.thought_signature])).toEqual([
        ["call-1", "sig-1"],
        ["call-2", "sig-2"],
      ]);

      const turn2 = compat.toCompletionsMessages("", [
        { role: "assistant", content: turn1.blocks },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", output: "contents" }] },
      ]);
      const replayed = turn2.find((message: any) => message.role === "assistant")?.tool_calls;
      expect(replayed?.[0]?.extra_content).toEqual({ google: { thought_signature: "sig-1" } });
      expect(replayed?.[1]?.extra_content).toEqual({ google: { thought_signature: "sig-2" } });

      const plain = compat.toCompletionsMessages("", [
        { role: "assistant", content: [{ type: "tool_use", id: "call-3", name: "bash", input: {} }] },
      ]);
      expect(plain.find((message: any) => message.role === "assistant")?.tool_calls?.[0]).not.toHaveProperty("extra_content");

      const changed = compat.completionResultFromEvents([
        { choices: [{ delta: { tool_calls: [
          { index: 0, id: "call-1", type: "function", function: { name: "bash", arguments: "{}" }, extra_content: { google: { thought_signature: "sig-1" } } },
        ] } }] },
        { choices: [{ delta: { tool_calls: [
          { index: 0, id: null, type: null, function: { name: null, arguments: "" }, extra_content: { google: { thought_signature: "sig-other" } } },
        ] }, finish_reason: "tool_calls" }] },
      ] as any, () => {}, 0);
      expect(changed.error ?? "").toMatch(/signature changed/i);
    });

    it("exposes core provider tool admission invariant", () => {      expect(typeof core.providerToolAdmissionError).toBe("function");
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

    it("rejects duplicate call IDs before execution or persistence", () => {
      expect(core.providerToolAdmissionError([
        { type: "tool_use", id: "same", name: "bash", input: { command: "first" } },
        { type: "tool_use", id: "same", name: "bash", input: { command: "second" } },
      ])).toMatch(/duplicate tool call identity/);
    });

    it("keeps recovery model-visible without ending an unresolved server-tool turn", () => {
      const results = [
        { type: "tool_result", tool_use_id: "local-1", content: "original output" },
        { type: "tool_result", tool_use_id: "local-2", content: "second output", is_error: true },
      ];
      const server = { type: "server_tool_use", id: "search-1", name: "web_search", input: {} };
      const mixed = core.toolResultsWithRecovery(results, [server], "change approach");
      expect(mixed.map((block) => block.type)).toEqual(["tool_result", "tool_result"]);
      expect(mixed[0]?.content).toEqual([
        { type: "text", text: "original output" },
        { type: "text", text: "[Harness recovery guidance]\nchange approach" },
      ]);
      expect(results[0]?.content).toBe("original output");
      expect(mixed[1]).toEqual(results[1]);
      const finished = core.toolResultsWithRecovery(results, [server,
        { type: "web_search_tool_result", tool_use_id: "search-1", content: [] },
      ], "change approach");
      expect(finished.at(-1)).toEqual({ type: "text", text: "change approach" });
      expect(core.toolResultsWithRecovery(results, [], "change approach")).toEqual(finished);
    });

    it("flags output-limit stop reasons as truncated", () => {
      expect(compat.isTruncatedStopReason("length")).toBe(true);
      expect(compat.isTruncatedStopReason("max_tokens")).toBe(true);
      expect(compat.isTruncatedStopReason("MAX_TOKENS")).toBe(true);
      expect(compat.isTruncatedStopReason("stop")).toBe(false);
      expect(compat.isTruncatedStopReason("tool_calls")).toBe(false);
      expect(compat.isTruncatedStopReason("end_turn")).toBe(false);
      expect(compat.isTruncatedStopReason(null)).toBe(false);
      expect(compat.isTruncatedStopReason(undefined)).toBe(false);
    });
  });
});
