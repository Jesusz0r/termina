import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  done,
  formatToolAnnounce,
  toolOutcomeTraceFields,
  toolResult,
  toolTranscriptDetail,
} from "../../../agent-core/main/tools.ts";
import {
  MCP_RESULT_BYTES,
  createMcpContinuation,
  normalizeMcpCallResult,
} from "../../../agent-core/mcp.ts";

const mcpUse = { id: "call-1", name: "mcp_echo_echo", input: { text: "hi" } };

describe("done() tool outcomes (#373)", () => {
  it("builds a tool_result envelope from a string without inventing cancellationScope", () => {
    const use = { id: "1", name: "bash", input: { command: "true" } };
    const outcome = done(use, "ok");
    expect(outcome.result).toEqual(toolResult(use, "ok"));
    expect(outcome.isError).toBe(false);
    expect(outcome.bounded).toMatchObject({
      state: "complete",
      direction: "head",
      truncated: false,
    });
    expect(outcome.cancellationScope).toBeUndefined();
    expect(outcome.repro).toBe("bash 'true'");
  });

  it("forwards bounded metadata, continuation, and cancellationScope from MCP tool text", () => {
    const continuation = createMcpContinuation("echo", "echo");
    const got = normalizeMcpCallResult(
      { content: [{ type: "text", text: "x".repeat(MCP_RESULT_BYTES + 1) }] },
      continuation,
    );
    const outcome = done(mcpUse, got);
    expect(outcome.result).toEqual(toolResult(mcpUse, got.content));
    expect(outcome.isError).toBe(got.isError);
    expect(outcome.bounded).toEqual({
      state: got.state,
      direction: got.direction,
      limitBytes: got.limitBytes,
      inputBytes: got.inputBytes,
      retainedBytes: got.retainedBytes,
      omittedBytes: got.omittedBytes,
      outputBytes: got.outputBytes,
      truncated: got.truncated,
    });
    expect(outcome.cancellationScope).toBe("none");
    expect(outcome.continuation).toEqual(got.continuation);
    expect(outcome.repro).toBeNull();
    expect(got.truncated).toBe(true);
  });

  it("preserves connection cancellationScope through the constructor", () => {
    const got = normalizeMcpCallResult({
      isError: true,
      content: [{ type: "text", text: "error: mcp echo: interrupted" }],
    });
    const outcome = done(mcpUse, { ...got, cancellationScope: "connection" });
    expect(outcome.isError).toBe(true);
    expect(outcome.cancellationScope).toBe("connection");
    expect(outcome.bounded).toMatchObject({
      state: got.state,
      direction: got.direction,
      truncated: got.truncated,
    });
    expect(toolOutcomeTraceFields(outcome).cancellationScope).toBe("connection");
  });

  it("MCP executeTool branch uses done() instead of a ToolOutcome literal", () => {
    const main = readFileSync(new URL("../../../agent-core/main.ts", import.meta.url), "utf8");
    const start = main.indexOf("if (mcpSession?.tools.some");
    const end = main.indexOf("const TOOLS:");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const branch = main.slice(start, end);
    expect(branch).toContain("return done(use, got);");
    expect(branch).not.toContain("toolResult(");
    expect(branch).not.toContain("cancellationScope:");
  });
});

describe("formatToolAnnounce (#377)", () => {
  it("wraps toolTranscriptDetail for path/pattern/url tools", () => {
    const edit = { id: "1", name: "edit", input: { path: "a.ts" } };
    expect(formatToolAnnounce(edit)).toBe(`◆ Tool · edit\n  ${toolTranscriptDetail(edit)}`);
    const grep = { id: "2", name: "grep", input: { pattern: "foo" } };
    expect(formatToolAnnounce(grep)).toBe(`◆ Tool · grep\n  ${toolTranscriptDetail(grep)}`);
    const fetch = { id: "3", name: "fetch", input: { url: "https://ex.test" } };
    expect(formatToolAnnounce(fetch)).toBe(`◆ Tool · fetch\n  ${toolTranscriptDetail(fetch)}`);
  });

  it("prefixes bash detail with $ and keeps spawn announce-only extras", () => {
    const bash = { id: "1", name: "bash", input: { command: "ls" } };
    expect(toolTranscriptDetail(bash)).toBe("ls");
    expect(formatToolAnnounce(bash)).toBe("◆ Tool · bash\n  $ ls");
    const spawn = { id: "2", name: "spawn_subagent", input: { task: "do things", user_requested: true } };
    expect(toolTranscriptDetail(spawn)).toBe("");
    expect(formatToolAnnounce(spawn)).toContain("user-requested");
  });
});
