import { describe, expect, it } from "vitest";
import * as compat from "../../../agent-core/openai-compat.ts";
import { projectPersistedMessages } from "../../../agent-core/request-projection.ts";

// Refs #268: serializers must fail closed on unmatched calls instead of
// synthesizing "(interrupted)" tool outputs. Projector remains the pairing
// validator. OpenAI function_call_output is paired by call_id:
// https://developers.openai.com/api/docs/guides/function-calling
// Anthropic server_tool_use is not an OpenAI function_call:
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools

const UNMATCHED = /provider protocol error: unmatched tool call/;

function toolUse(id: string, name = "bash") {
  return { type: "tool_use", id, name, input: { command: "ls" } };
}

function toolResult(id: string, content = "ok") {
  return { type: "tool_result", tool_use_id: id, content };
}

describe("openai-compat unmatched tool calls (refs #268)", () => {
  it("toResponsesInput throws instead of synthesizing function_call_output", () => {
    expect(() =>
      compat.toResponsesInput([
        { role: "assistant", content: [toolUse("call_orphan")] },
        { role: "user", content: "next prompt" },
      ]),
    ).toThrow(UNMATCHED);

    expect(() =>
      compat.toResponsesInput([
        { role: "assistant", content: [toolUse("call_A"), toolUse("call_B")] },
        { role: "user", content: [toolResult("call_A", "file.txt")] },
      ]),
    ).toThrow(/unmatched tool call: call_B/);

    const paired = compat.toResponsesInput([
      { role: "assistant", content: [toolUse("call_1")] },
      { role: "user", content: [toolResult("call_1")] },
    ]);
    expect(JSON.stringify(paired)).not.toContain("(interrupted)");
    expect(paired).toEqual([
      expect.objectContaining({ type: "function_call", call_id: "call_1" }),
      expect.objectContaining({ type: "function_call_output", call_id: "call_1" }),
    ]);
  });

  it("toCompletionsMessages throws instead of synthesizing tool role content", () => {
    expect(() =>
      compat.toCompletionsMessages("sys", [
        { role: "assistant", content: [toolUse("call_orphan")] },
        { role: "user", content: "next prompt" },
      ]),
    ).toThrow(UNMATCHED);

    expect(() =>
      compat.toCompletionsMessages("", [
        { role: "assistant", content: [toolUse("call_A"), toolUse("call_B")] },
        { role: "user", content: [toolResult("call_A")] },
      ]),
    ).toThrow(/unmatched tool call: call_B/);

    const paired = compat.toCompletionsMessages("sys", [
      { role: "assistant", content: [toolUse("call_1")] },
      { role: "user", content: [toolResult("call_1")] },
    ]);
    expect(JSON.stringify(paired)).not.toContain("(interrupted)");
    expect(paired.map((m) => m.role)).toEqual(["system", "assistant", "tool"]);
    expect(paired[2]).toMatchObject({ role: "tool", tool_call_id: "call_1", content: "ok" });
  });

  it("fails closed on Anthropic server_tool_use without inventing OpenAI output", () => {
    const server = {
      type: "server_tool_use",
      id: "srvtoolu_1",
      name: "web_search",
      input: { query: "x" },
    };
    expect(() => compat.toResponsesInput([{ role: "assistant", content: [server] }])).toThrow(
      /unmatched tool call: srvtoolu_1/,
    );
    expect(() => compat.toCompletionsMessages("", [{ role: "assistant", content: [server] }])).toThrow(
      /unmatched tool call: srvtoolu_1/,
    );
  });

  it("leaves pairing validation on the projector", () => {
    const unpaired = projectPersistedMessages({
      messages: [{ role: "assistant", content: [toolUse("open-call")], sseq: 1, tokens: 0 }],
    });
    expect(unpaired).toEqual({ ok: false, error: "incomplete tool-call sequence: open-call" });

    const serverPaired = projectPersistedMessages({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "x" } },
            { type: "web_search_tool_result", tool_use_id: "s1", content: [] },
          ],
          sseq: 1,
          tokens: 0,
        },
      ],
    });
    expect(serverPaired.ok).toBe(true);
  });
});
