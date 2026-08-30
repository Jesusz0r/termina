/**
 * MCP contract tests for discovery normalization and session freezing.
 *
 * This file intentionally targets the public agent-core MCP helpers only. It
 * is kept separate from the existing harness so the implementation can make
 * the normalization contract executable without making the broad harness a
 * merge-conflict hotspot.
 *
 * Run with:
 *   node --experimental-strip-types --no-warnings scripts/agent-core-mcp-stability-test.mjs
 */
import assert from "node:assert/strict";

process.env.TERMINA_CORE_TEST = "1";

const mcp = await import("../agent-core/mcp.ts");
const { MAX_MCP_TOOL_BYTES, MAX_MCP_TOOLS, selectMcpTools } = mcp;
const normalizeMcpTools = mcp.normalizeMcpTools;

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

function tool({ server, original, description = original, input_schema = { type: "object", properties: {} } }) {
  return { name: original, description, input_schema, server, original };
}

function nestedSchema(order) {
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

function selectedSignature(rows) {
  return rows.map((row) => ({
    name: row.name,
    server: row.server,
    original: row.original,
    description: row.description,
    input_schema: row.input_schema,
  }));
}

function serializedSignature(rows) {
  return JSON.stringify(selectedSignature(rows));
}

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

check("normalizeMcpTools is an exported public helper", () => {
  assert.equal(typeof normalizeMcpTools, "function");
});

check("recursive schema key ordering is canonical and input is not mutated", () => {
  assert.equal(typeof normalizeMcpTools, "function");
  const forward = normalizeMcpTools([schemaForward]);
  const reverse = normalizeMcpTools([schemaReverse]);
  assert.deepEqual(forward, reverse);
  assert.equal(JSON.stringify(forward), JSON.stringify(reverse));
  assert.deepEqual(schemaForward, schemaInputSnapshot);
  assert.match(JSON.stringify(forward), /"additionalProperties":false/);
});

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

check("semantically repeated discoveries dedupe before count and byte caps", () => {
  assert.equal(typeof normalizeMcpTools, "function");
  const first = normalizeMcpTools([duplicateA, duplicateB, ...uniqueTools]);
  const second = normalizeMcpTools([...uniqueTools].reverse().concat([duplicateB, duplicateA]));
  assert.equal(first.filter((row) => row.server === "dedupe-server" && row.original === "same-tool").length, 1);
  assert.equal(serializedSignature(first), serializedSignature(second));

  const selected = selectMcpTools([duplicateA, duplicateB, ...uniqueTools]);
  const selectedReversed = selectMcpTools([...uniqueTools].reverse().concat([duplicateB, duplicateA]));
  assert.equal(serializedSignature(selected), serializedSignature(selectedReversed));
  assert.ok(selected.length <= MAX_MCP_TOOLS);
  assert.ok(selected.reduce((bytes, row) => bytes + Buffer.byteLength(JSON.stringify(row)), 0) <= MAX_MCP_TOOL_BYTES);
});

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

check("truncated MCP names remain bounded, valid, unique, and arrival-order independent", () => {
  const first = selectMcpTools(collisionTools);
  const second = selectMcpTools([...collisionTools].reverse());
  assert.equal(serializedSignature(first), serializedSignature(second));
  assert.equal(first.length, collisionTools.length);
  assert.equal(new Set(first.map((row) => row.name)).size, first.length);
  for (const row of first) {
    assert.match(row.name, /^[A-Za-z0-9_-]{1,64}$/);
    assert.ok(row.name.length <= 64);
  }
});

const sortTools = [
  tool({ server: "z-server", original: "z-tool" }),
  tool({ server: "a-server", original: "z-tool" }),
  tool({ server: "a-server", original: "a-tool" }),
  tool({ server: "m-server", original: "m-tool" }),
];

check("normalized MCP tools use a canonical server/original order", () => {
  assert.equal(typeof normalizeMcpTools, "function");
  const normalized = normalizeMcpTools(sortTools);
  assert.deepEqual(
    normalized.map((row) => `${row.server}/${row.original}`),
    ["a-server/a-tool", "a-server/z-tool", "m-server/m-tool", "z-server/z-tool"],
  );
});

check("selection snapshots tool records instead of retaining discovery objects", () => {
  const discovered = [tool({ server: "snapshot-server", original: "snapshot-tool" })];
  const selected = selectMcpTools(discovered);
  discovered[0].name = "late-mutation";
  discovered[0].input_schema.properties.late = { type: "string" };
  assert.equal(selected[0]?.name, "mcp_snapshot-server_snapshot-tool");
  assert.equal(Object.hasOwn(selected[0]?.input_schema ?? {}, "late"), false);
});

// The frozen contract applies immutability to the live McpSession binding,
// not to the pure selection helper. Use a fetch stub so this remains a
// deterministic unit check and does not require a listening test server.
try {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init = {}) => {
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
    assert.ok(Object.isFrozen(session.tools), "McpSession tools must be frozen");
    assert.ok(session.tools.every((row) => Object.isFrozen(row)), "McpSession tool records must be frozen");
    assert.equal(session.tools.length, 1, "conflicting duplicate definitions must dedupe");
    assert.equal(session.tools[0]?.description, "a-definition", "canonical conflict winner must be deterministic");
    assert.ok(
      session.notes.some((note) => note.includes("mcp tool conflict") && note.includes("2 definitions")),
      "conflicting definitions must be surfaced through McpSession notes",
    );
    session.shutdown();
  } finally {
    globalThis.fetch = previousFetch;
  }
  console.log("PASS  McpSession freezes the selected tool binding");
} catch (error) {
  failures.push({ name: "McpSession freezes the selected tool binding", error });
  console.log(`FAIL  McpSession freezes the selected tool binding — ${error instanceof Error ? error.message : String(error)}`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} MCP stability contract test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("\nMCP stability contract tests passed.");
}
