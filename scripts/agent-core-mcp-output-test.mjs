/**
 * MCP bounded-output contract tests.
 *
 * Run with:
 *   node --experimental-strip-types --no-warnings scripts/agent-core-mcp-output-test.mjs
 */
import assert from "node:assert/strict";

const mcp = await import("../agent-core/mcp.ts");
const {
  MCP_RESULT_BYTES,
  MAX_MCP_TOOL_BYTES,
  createMcpContinuation,
  mcpToolDefs,
  normalizeMcpCallResult,
  selectMcpTools,
  startMcp,
} = mcp;

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

check("MCP call normalization exposes the bounded result helper", () => {
  assert.equal(typeof normalizeMcpCallResult, "function");
});

check("MCP text blocks are accumulated with a UTF-8-safe bounded result", () => {
  const result = normalizeMcpCallResult({
    content: [
      { type: "text", text: "prefix-🙂" },
      { type: "text", text: "-".repeat(MCP_RESULT_BYTES) },
      { type: "text", text: "-suffix" },
    ],
  });
  assert.equal(result.isError, false);
  assert.equal(result.state, "complete");
  assert.equal(result.truncated, true);
  assert.ok(result.omittedBytes > 0);
  assert.ok(result.inputBytes > result.retainedBytes);
  assert.ok(result.outputBytes <= MCP_RESULT_BYTES);
  assert.ok(!result.content.includes("\uFFFD"));
  assert.match(result.content, /mcp output truncated/);
  assert.equal(result.cancellationScope, "none");
});

check("truncated MCP output carries bounded argument-free continuation guidance", () => {
  const continuation = createMcpContinuation("server", "mcp_tool_name");
  const result = normalizeMcpCallResult({ content: [{ type: "text", text: "x".repeat(MCP_RESULT_BYTES + 1) }] }, continuation);
  assert.equal(result.truncated, true);
  assert.equal(result.continuation?.server, "server");
  assert.equal(result.continuation?.tool, "mcp_tool_name");
  assert.match(result.continuation?.guidance ?? "", /again/i);
  assert.doesNotMatch(result.continuation?.guidance ?? "", /secret|password|token/i);
  assert.match(result.content, /call MCP tool/i);
  assert.match(result.content, /mcp_tool_name/);
});

check("structured JSON and resource metadata serialize deterministically", () => {
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
  assert.equal(first.content, second.content);
  assert.match(first.content, /structuredContent/);
  assert.match(first.content, /resource text/);
  assert.match(first.content, /resource_link/);
  assert.equal(first.truncated, false);
});

check("unsupported MCP binary/resource payloads are explicitly marked", () => {
  const result = normalizeMcpCallResult({
    content: [
      { type: "image", data: "base64-image", mimeType: "image/png" },
      { type: "audio", data: "base64-audio", mimeType: "audio/wav" },
      { type: "resource", resource: { blob: "base64-resource", mimeType: "application/octet-stream", uri: "urn:x" } },
    ],
  });
  assert.doesNotMatch(result.content, /\(no output\)/);
  assert.match(result.content, /mcp image omitted/);
  assert.match(result.content, /mcp audio omitted/);
  assert.match(result.content, /mcp resource payload omitted/);
});

check("omitted structured payloads carry continuation guidance", () => {
  const continuation = createMcpContinuation("server", "tool");
  const result = normalizeMcpCallResult({ structuredContent: 1n }, continuation);
  assert.equal(result.truncated, true);
  assert.equal(result.continuation?.server, "server");
  assert.match(result.content, /call MCP tool/i);
  assert.match(result.content, /structuredContent omitted/);
});

check("MCP output at the exact UTF-8 limit is not falsely marked", () => {
  const text = "🙂".repeat(Math.floor(MCP_RESULT_BYTES / 4));
  const result = normalizeMcpCallResult({ content: [{ type: "text", text }] });
  assert.equal(result.content, text);
  assert.equal(result.truncated, false);
  assert.equal(result.omittedBytes, 0);
  assert.equal(result.outputBytes, Buffer.byteLength(text, "utf8"));
});

check("empty MCP text preserves the no-output fallback", () => {
  const result = normalizeMcpCallResult({ content: [{ type: "text", text: "" }] });
  assert.equal(result.content, "(no output)");
  assert.equal(result.state, "complete");
  assert.equal(result.truncated, false);
});

check("collision names are reserved only after a row fits the aggregate cap", () => {
  const largeSchema = { type: "object", description: "y".repeat(7100) };
  const collisionSchema = { type: "object", description: "z".repeat(8000) };
  const fillers = Array.from({ length: 7 }, (_, index) => ({
    name: `filler-${index}`,
    description: "x".repeat(1024),
    input_schema: largeSchema,
    server: "a-filler",
    original: `filler-${index}`,
  }));
  const collisionRows = [
    {
      name: `${"t".repeat(40)}-first`,
      description: "large collision candidate",
      input_schema: collisionSchema,
      server: `${"s".repeat(24)}-first`,
      original: `${"t".repeat(40)}-first`,
    },
    {
      name: `${"t".repeat(40)}-second`,
      description: "small collision candidate",
      input_schema: { type: "object", properties: {} },
      server: `${"s".repeat(24)}-second`,
      original: `${"t".repeat(40)}-second`,
    },
  ];
  const selected = selectMcpTools([...fillers, ...collisionRows]);
  const accepted = selected.find((row) => row.original.endsWith("-second"));
  assert.ok(accepted, `expected the small colliding row to fit under ${MAX_MCP_TOOL_BYTES} bytes`);
  assert.equal(accepted?.name, mcp.mcpToolName(collisionRows[0].server, collisionRows[0].original));
});

check("MCP selection measures the exact provider tool definitions", () => {
  const schema = { type: "object", description: "y".repeat(6900) };
  const discovered = Array.from({ length: 8 }, (_, index) => ({
    name: `tool-${index}`,
    description: "x".repeat(1024),
    input_schema: schema,
    server: `${"server".repeat(20)}-${index}`,
    original: `${"original".repeat(8)}-${index}`,
  }));
  const selected = selectMcpTools(discovered);
  const providerDefs = mcpToolDefs(selected);
  const providerBytes = providerDefs.reduce((total, tool) => total + Buffer.byteLength(JSON.stringify(tool), "utf8"), 0);
  assert.equal(selected.length, 8, "all provider-fitting rows should survive internal metadata overhead");
  assert.ok(providerBytes <= MAX_MCP_TOOL_BYTES);
  assert.ok(selected.every((tool) => !Object.hasOwn(mcpToolDefs([tool])[0], "server")));
});

check("invalid MCP results are explicitly incomplete", () => {
  const result = normalizeMcpCallResult(null);
  assert.equal(result.isError, true);
  assert.equal(result.state, "failed");
  assert.equal(result.truncated, true);
  assert.match(result.content, /mcp output incomplete: failed/);
  assert.ok(Object.isFrozen(result));
});

// A fetch implementation without a streaming body must be provably empty;
// Content-Length alone cannot make an allocating body convenience method safe.
try {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init = {}) => {
    const request = JSON.parse(String(init.body ?? "{}"));
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: null,
      arrayBuffer: async () => Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }), "utf8"),
    };
  };
  try {
    const session = await startMcp(
      [{ name: "unbounded", args: [], env: {}, url: "https://mcp.invalid/session" }],
      { projectRoot: ".", confineCwd: () => "." },
    );
    assert.equal(session.tools.length, 0);
    assert.ok(session.notes.some((note) => /body cannot be bounded/i.test(note)));
    session.shutdown();
  } finally {
    globalThis.fetch = previousFetch;
  }
  console.log("PASS  bodyless MCP responses fail closed without a declared bound");
} catch (error) {
  failures.push({ name: "bodyless MCP responses fail closed without a declared bound", error });
  console.log(`FAIL  bodyless MCP responses fail closed without a declared bound — ${error instanceof Error ? error.message : String(error)}`);
}

try {
  const previousFetch = globalThis.fetch;
  let convenienceRead = false;
  globalThis.fetch = async (_input, init = {}) => {
    const request = JSON.parse(String(init.body ?? "{}"));
    const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }), "utf8");
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json", "content-length": String(bytes.length) }),
      body: null,
      arrayBuffer: async () => {
        convenienceRead = true;
        return bytes;
      },
    };
  };
  try {
    const session = await startMcp(
      [{ name: "bodyless", args: [], env: {}, url: "https://mcp.invalid/session" }],
      { projectRoot: ".", confineCwd: () => "." },
    );
    assert.equal(session.tools.length, 0);
    assert.equal(convenienceRead, false);
    assert.ok(session.notes.some((note) => /body cannot be bounded/i.test(note)));
    session.shutdown();
  } finally {
    globalThis.fetch = previousFetch;
  }
  console.log("PASS  declared bodyless MCP responses never use allocating body helpers");
} catch (error) {
  failures.push({ name: "declared bodyless MCP responses never use allocating body helpers", error });
  console.log(`FAIL  declared bodyless MCP responses never use allocating body helpers — ${error instanceof Error ? error.message : String(error)}`);
}

try {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(Uint8Array.from([0x7b, 0x22, 0x80, 0x22, 0x7d]), {
    status: 200,
    headers: { "content-type": "application/json", "content-length": "5" },
  });
  try {
    const session = await startMcp(
      [{ name: "invalid-utf8", args: [], env: {}, url: "https://mcp.invalid/session" }],
      { projectRoot: ".", confineCwd: () => "." },
    );
    assert.equal(session.tools.length, 0);
    assert.ok(session.notes.some((note) => /not valid UTF-8/i.test(note)));
    session.shutdown();
  } finally {
    globalThis.fetch = previousFetch;
  }
  console.log("PASS  MCP HTTP responses reject malformed UTF-8 without replacement bytes");
} catch (error) {
  failures.push({ name: "MCP HTTP responses reject malformed UTF-8 without replacement bytes", error });
  console.log(`FAIL  MCP HTTP responses reject malformed UTF-8 without replacement bytes — ${error instanceof Error ? error.message : String(error)}`);
}

try {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init = {}) => {
    const request = JSON.parse(String(init.body ?? "{}"));
    if (request.method === "tools/call") {
      await new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }
    const result = request.method === "tools/list"
      ? { tools: [{ name: "hang", description: "hang", inputSchema: { type: "object" } }] }
      : request.method === "initialize"
        ? { protocolVersion: mcp.MCP_PROTOCOL, capabilities: {}, serverInfo: { name: "hang" } }
        : {};
    return new Response(JSON.stringify({ jsonrpc: "2.0", ...(request.id === undefined ? {} : { id: request.id }), result }), {
      status: 200,
      headers: { "content-type": "application/json", "mcp-session-id": "session-cancel" },
    });
  };
  try {
    const session = await startMcp(
      [{ name: "cancel", args: [], env: {}, url: "https://mcp.invalid/session" }],
      { projectRoot: ".", confineCwd: () => "." },
    );
    const siblingPromise = session.call("mcp_cancel_hang", {}, { shouldStop: () => false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await session.call("mcp_cancel_hang", {}, { shouldStop: () => true });
    const sibling = await siblingPromise;
    assert.equal(result.state, "interrupted");
    assert.equal(result.cancellationScope, "connection");
    assert.equal(sibling.state, "interrupted");
    assert.equal(sibling.cancellationScope, "connection");
    session.shutdown();
  } finally {
    globalThis.fetch = previousFetch;
  }
  console.log("PASS  MCP cancellation reports connection-wide sibling impact");
} catch (error) {
  failures.push({ name: "MCP cancellation reports connection-wide sibling impact", error });
  console.log(`FAIL  MCP cancellation reports connection-wide sibling impact — ${error instanceof Error ? error.message : String(error)}`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} MCP output contract test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("\nMCP output contract tests passed.");
}
