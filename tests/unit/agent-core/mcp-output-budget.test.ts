import { describe, expect, it } from "vitest";

import {
  MCP_RESULT_BYTES,
  createMcpContinuation,
  normalizeMcpCallResult,
} from "../../../agent-core/mcp.ts";

describe("MCP output budget", () => {
  it("omits a text block that is exactly equivalent to structured content", () => {
    const result = normalizeMcpCallResult({
      structuredContent: { a: 1, b: 2 },
      content: [
        { type: "text", text: " {\"b\":2,\"a\":1} " },
        { type: "text", text: "A distinct human summary" },
      ],
    });

    expect(result.content).toBe(
      '[mcp structuredContent] {"a":1,"b":2}\nA distinct human summary',
    );
    expect(result.content).not.toContain('{"b":2,"a":1}');
    expect(result.truncated).toBe(false);
    expect(result.isError).toBe(false);
  });

  it("keeps a text block that is only similar to structured content", () => {
    const result = normalizeMcpCallResult({
      structuredContent: { a: 1, b: 2 },
      content: [{ type: "text", text: '{"a":1,"b":2,"extra":3}' }],
    });

    expect(result.content).toContain('[mcp structuredContent] {"a":1,"b":2}');
    expect(result.content).toContain('{"a":1,"b":2,"extra":3}');
  });

  it("does not parse transport-sized text just to find a duplicate", () => {
    const result = normalizeMcpCallResult({
      structuredContent: { a: 1 },
      content: [{ type: "text", text: '{"a":1}' + " ".repeat(MCP_RESULT_BYTES + 1) }],
    });

    expect(result.truncated).toBe(true);
    expect(result.content).toContain('[mcp structuredContent] {"a":1}');
    expect(result.content).toMatch(/mcp output truncated/);
  });

  it("bounds oversized structured values before retaining their serialization", () => {
    const continuation = createMcpContinuation("server", "tool");
    const result = normalizeMcpCallResult({
      isError: true,
      structuredContent: { payload: "x".repeat(MCP_RESULT_BYTES * 4) },
      content: [{ type: "text", text: "A distinct human summary" }],
    }, continuation);

    expect(result.content).toContain("mcp structuredContent omitted: too large");
    expect(result.content).toContain("A distinct human summary");
    expect(result.truncated).toBe(true);
    expect(result.outputBytes).toBeLessThanOrEqual(MCP_RESULT_BYTES);
    expect(result.isError).toBe(true);
    expect(result.continuation).toBe(continuation);
  });
});
