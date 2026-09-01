import { describe, it, expect } from "vitest";
import * as mcp from "../../../agent-core/mcp.ts";

const {
  MCP_RESULT_BYTES,
  MAX_MCP_TOOL_BYTES,
  MAX_MCP_TOOLS,
  createMcpContinuation,
  mcpToolDefs,
  normalizeMcpCallResult,
  normalizeMcpTools,
  selectMcpTools,
  startMcp,
} = mcp;

function tool({ server, original, description = original, input_schema = { type: "object", properties: {} } }: any) {
  return { name: original, description, input_schema, server, original };
}

function nestedSchema(order: "forward" | "reverse") {
  const nested = order === "forward"
    ? {
        type: "object",
        properties: {
          beta: { type: "number", minimum: 0 },
          alpha: { type: "string" },
        },
        required: ["alpha"],
      }
    : {
        required: ["alpha"],
        properties: {
          alpha: { type: "string" },
          beta: { minimum: 0, type: "number" },
        },
        type: "object",
      };
  if (order === "forward") {
    return {
      type: "object",
      properties: {
        nested,
        first: { type: "string", description: "first" },
      },
      required: ["nested"],
      additionalProperties: false,
    };
  }
  return {
    additionalProperties: false,
    required: ["nested"],
    properties: {
      first: { description: "first", type: "string" },
      nested,
    },
    type: "object",
  };
}

function selectedSignature(rows: any[]) {
  return rows.map((row) => ({
    name: row.name,
    server: row.server,
    original: row.original,
    description: row.description,
    input_schema: row.input_schema,
  }));
}

function serializedSignature(rows: any[]) {
  return JSON.stringify(selectedSignature(rows));
}

describe("Agent Core MCP Protocol, Stability & Bounded Output", () => {
  describe("MCP Normalization & Schema Stability", () => {
    it("orders recursive schema keys canonically without mutating input", () => {
      const schemaForward = tool({
        server: "schema-server",
        original: "schema-tool",
        input_schema: nestedSchema("forward"),
      });
      const schemaReverse = tool({
        server: "schema-server",
        original: "schema-tool",
        input_schema: nestedSchema("reverse"),
      });
      const schemaInputSnapshot = structuredClone(schemaForward);

      const forward = normalizeMcpTools([schemaForward]);
      const reverse = normalizeMcpTools([schemaReverse]);
      expect(forward).toEqual(reverse);
      expect(JSON.stringify(forward)).toBe(JSON.stringify(reverse));
      expect(schemaForward).toEqual(schemaInputSnapshot);
      expect(JSON.stringify(forward)).toContain('"additionalProperties":false');
    });

    it("deduplicates semantically repeated discoveries before count and byte caps", () => {
      const duplicateA = tool({
        server: "dedupe-server",
        original: "same-tool",
        description: "z-description",
        input_schema: { type: "object", properties: { z: { type: "string" }, a: { type: "number" } } },
      });
      const duplicateB = tool({
        server: "dedupe-server",
        original: "same-tool",
        description: "a-description",
        input_schema: { properties: { a: { type: "number" }, z: { type: "string" } }, type: "object" },
      });
      const uniqueTools = Array.from({ length: MAX_MCP_TOOLS + 2 }, (_, index) =>
        tool({ server: "dedupe-server", original: `unique-${String(index).padStart(2, "0")}` }),
      );

      const first = normalizeMcpTools([duplicateA, duplicateB, ...uniqueTools]);
      const second = normalizeMcpTools([...uniqueTools].reverse().concat([duplicateB, duplicateA]));
      expect(first.filter((row: any) => row.server === "dedupe-server" && row.original === "same-tool").length).toBe(1);
      expect(serializedSignature(first)).toBe(serializedSignature(second));

      const selected = selectMcpTools([duplicateA, duplicateB, ...uniqueTools]);
      const selectedReversed = selectMcpTools([...uniqueTools].reverse().concat([duplicateB, duplicateA]));
      expect(serializedSignature(selected)).toBe(serializedSignature(selectedReversed));
      expect(selected.length).toBeLessThanOrEqual(MAX_MCP_TOOLS);
      expect(selected.reduce((bytes: number, row: any) => bytes + Buffer.byteLength(JSON.stringify(row)), 0)).toBeLessThanOrEqual(MAX_MCP_TOOL_BYTES);
    });

    it("keeps truncated MCP names bounded, valid, unique, and arrival-order independent", () => {
      const collisionTools = [
        tool({
          server: `${"s".repeat(24)}-first`,
          original: `${"t".repeat(40)}-first`,
          description: "first collision candidate",
        }),
        tool({
          server: `${"s".repeat(24)}-second`,
          original: `${"t".repeat(40)}-second`,
          description: "second collision candidate",
        }),
      ];

      const first = selectMcpTools(collisionTools);
      const second = selectMcpTools([...collisionTools].reverse());
      expect(serializedSignature(first)).toBe(serializedSignature(second));
      expect(first.length).toBe(collisionTools.length);
      expect(new Set(first.map((row: any) => row.name)).size).toBe(first.length);
      for (const row of first) {
        expect(row.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
        expect(row.name.length).toBeLessThanOrEqual(64);
      }
    });

    it("orders tools by canonical server/original order", () => {
      const sortTools = [
        tool({ server: "z-server", original: "z-tool" }),
        tool({ server: "a-server", original: "z-tool" }),
        tool({ server: "a-server", original: "a-tool" }),
        tool({ server: "m-server", original: "m-tool" }),
      ];
      const normalized = normalizeMcpTools(sortTools);
      expect(normalized.map((row: any) => `${row.server}/${row.original}`)).toEqual([
        "a-server/a-tool",
        "a-server/z-tool",
        "m-server/m-tool",
        "z-server/z-tool",
      ]);
    });

    it("snapshots tool records instead of retaining discovery objects", () => {
      const discovered = [tool({ server: "snapshot-server", original: "snapshot-tool" })];
      const selected = selectMcpTools(discovered);
      discovered[0].name = "late-mutation";
      discovered[0].input_schema.properties.late = { type: "string" };
      expect(selected[0]?.name).toBe("mcp_snapshot-server_snapshot-tool");
      expect(Object.hasOwn(selected[0]?.input_schema ?? {}, "late")).toBe(false);
    });

    it("freezes the selected tool binding in live McpSession", async () => {
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async (_input: any, init: any = {}) => {
        const request = JSON.parse(String(init.body ?? "{}"));
        const result = request.method === "tools/list"
          ? {
              tools: [
                tool({ server: "session-server", original: "session-tool", description: "z-definition" }),
                tool({
                  server: "session-server",
                  original: "session-tool",
                  description: "a-definition",
                  input_schema: { properties: { value: { type: "string" } }, type: "object" },
                }),
              ],
            }
          : request.method === "initialize"
            ? { protocolVersion: mcp.MCP_PROTOCOL, capabilities: {}, serverInfo: { name: "session", version: "1" } }
            : {};
        return new Response(JSON.stringify({ jsonrpc: "2.0", ...(request.id === undefined ? {} : { id: request.id }), result }), {
          status: 200,
          headers: { "content-type": "application/json", "mcp-session-id": "session-test" },
        });
      };
      try {
        const session = await mcp.startMcp(
          [{ name: "session", args: [], env: {}, url: "https://mcp.invalid/session" }],
          { projectRoot: ".", confineCwd: () => "." },
        );
        expect(Object.isFrozen(session.tools)).toBe(true);
        expect(session.tools.every((row: any) => Object.isFrozen(row))).toBe(true);
        expect(session.tools.length).toBe(1);
        expect(session.tools[0]?.description).toBe("a-definition");
        expect(session.notes.some((note: string) => note.includes("mcp tool conflict") && note.includes("2 definitions"))).toBe(true);
        session.shutdown();
      } finally {
        globalThis.fetch = previousFetch;
      }
    });
  });

  describe("MCP Bounded Output & Error Normalization", () => {
    it("accumulates text blocks with UTF-8-safe bounded output", () => {
      const result = normalizeMcpCallResult({
        content: [
          { type: "text", text: "prefix-🙂" },
          { type: "text", text: "-".repeat(MCP_RESULT_BYTES) },
          { type: "text", text: "-suffix" },
        ],
      });
      expect(result.isError).toBe(false);
      expect(result.state).toBe("complete");
      expect(result.truncated).toBe(true);
      expect(result.omittedBytes).toBeGreaterThan(0);
      expect(result.inputBytes).toBeGreaterThan(result.retainedBytes);
      expect(result.outputBytes).toBeLessThanOrEqual(MCP_RESULT_BYTES);
      expect(result.content).not.toContain("\uFFFD");
      expect(result.content).toMatch(/mcp output truncated/);
      expect(result.cancellationScope).toBe("none");
    });

    it("carries argument-free continuation guidance on truncated output", () => {
      const continuation = createMcpContinuation("server", "mcp_tool_name");
      const result = normalizeMcpCallResult({ content: [{ type: "text", text: "x".repeat(MCP_RESULT_BYTES + 1) }] }, continuation);
      expect(result.truncated).toBe(true);
      expect(result.continuation?.server).toBe("server");
      expect(result.continuation?.tool).toBe("mcp_tool_name");
      expect(result.continuation?.guidance ?? "").toMatch(/again/i);
      expect(result.continuation?.guidance ?? "").not.toMatch(/secret|password|token/i);
      expect(result.content).toMatch(/call MCP tool/i);
      expect(result.content).toMatch(/mcp_tool_name/);
    });

    it("serializes structured JSON and resource metadata deterministically", () => {
      const first = normalizeMcpCallResult({
        structuredContent: { z: 1, nested: { b: true, a: false }, a: "value" },
        content: [
          { type: "json", json: { z: 2, a: 1 } },
          { type: "resource", resource: { mimeType: "text/plain", text: "resource text", uri: "file:///tmp/x" } },
          { type: "resource_link", description: "read it", name: "x", uri: "file:///tmp/x" },
        ],
      });
      const second = normalizeMcpCallResult({
        content: [
          { type: "resource_link", uri: "file:///tmp/x", name: "x", description: "read it" },
          { type: "resource", resource: { uri: "file:///tmp/x", text: "resource text", mimeType: "text/plain" } },
          { type: "json", json: { a: 1, z: 2 } },
        ],
        structuredContent: { a: "value", nested: { a: false, b: true }, z: 1 },
      });
      expect(first.content).toBe(second.content);
      expect(first.content).toMatch(/structuredContent/);
      expect(first.content).toMatch(/resource text/);
      expect(first.content).toMatch(/resource_link/);
      expect(first.truncated).toBe(false);
    });

    it("marks unsupported MCP binary and resource payloads explicitly", () => {
      const result = normalizeMcpCallResult({
        content: [
          { type: "image", data: "base64-image", mimeType: "image/png" },
          { type: "audio", data: "base64-audio", mimeType: "audio/wav" },
          { type: "resource", resource: { blob: "base64-resource", mimeType: "application/octet-stream", uri: "urn:x" } },
        ],
      });
      expect(result.content).not.toMatch(/\(no output\)/);
      expect(result.content).toMatch(/mcp image omitted/);
      expect(result.content).toMatch(/mcp audio omitted/);
      expect(result.content).toMatch(/mcp resource payload omitted/);
    });

    it("does not falsely mark MCP output at exact UTF-8 limit", () => {
      const text = "🙂".repeat(Math.floor(MCP_RESULT_BYTES / 4));
      const result = normalizeMcpCallResult({ content: [{ type: "text", text }] });
      expect(result.content).toBe(text);
      expect(result.truncated).toBe(false);
      expect(result.omittedBytes).toBe(0);
      expect(result.outputBytes).toBe(Buffer.byteLength(text, "utf8"));
    });

    it("reports invalid MCP results as explicitly incomplete", () => {
      const result = normalizeMcpCallResult(null);
      expect(result.isError).toBe(true);
      expect(result.state).toBe("failed");
      expect(result.truncated).toBe(true);
      expect(result.content).toMatch(/mcp output incomplete: failed/);
      expect(Object.isFrozen(result)).toBe(true);
    });
  });
});
