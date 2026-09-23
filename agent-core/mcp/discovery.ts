/** Deferred MCP schemas. The provider tool prefix stays fixed after connect;
 * only requested definitions enter conversation history as search results. */
import { isRecord } from "../../shared/guards.ts";
import type { McpSession } from "./client.ts";
import { mcpToolDefs, type McpClientTool } from "./tools.ts";

const SEARCH_PAGE_BYTES = 18 * 1024;
const SEARCH_PAGE_TOOLS = 2;

const DISCOVERY_TOOLS: Array<Record<string, unknown>> = [
  {
    name: "search_mcp_tools",
    description: "Find connected MCP tools by keywords, server, or exact tool name. Returns complete input schemas for up to two matches. Use an empty query to browse; pass next_offset with the same query for more. Call a discovered tool with call_mcp_tool, not its name as a standalone tool.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: { query: { type: "string" }, offset: { type: "integer" } },
      required: ["query"],
    },
  },
  {
    name: "call_mcp_tool",
    description: "Call a connected MCP tool using its exact name and arguments matching the input_schema returned by search_mcp_tools. Discover the schema before calling; do not guess arguments. This can perform external actions, not just reads.",
    input_schema: {
      type: "object", additionalProperties: false,
      properties: { name: { type: "string" }, arguments: { type: "object", additionalProperties: true } },
      required: ["name", "arguments"],
    },
  },
];

/** No catalog descriptions or schemas are included in the provider prefix. */
export function mcpClientTools(
  kernel: Array<Record<string, unknown>>,
  catalog: readonly McpClientTool[],
): Array<Record<string, unknown>> {
  return [...kernel, ...(catalog.length ? structuredClone(DISCOVERY_TOOLS) : [])];
}

export function searchMcpTools(catalog: readonly McpClientTool[], input: unknown): string {
  if (!isRecord(input) || typeof input.query !== "string" || input.query.length > 1024) {
    return "error: query must be a string of at most 1024 characters";
  }
  const offset = input.offset ?? 0;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
    return "error: offset must be a non-negative integer";
  }
  const query = input.query.trim().toLowerCase();
  const words = query.split(/\s+/).filter(Boolean);
  const matches = catalog.map((tool, index) => {
    const name = tool.name.toLowerCase();
    const text = `${name} ${tool.server} ${tool.original} ${tool.description}`.toLowerCase();
    const score = name === query ? Number.MAX_SAFE_INTEGER : words.reduce((n, word) => n + Number(text.includes(word)), 0);
    return { tool, index, score };
  }).filter(({ score }) => !query || score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const definitions: Array<Record<string, unknown>> = [];
  let bytes = 0;
  for (const { tool } of matches.slice(offset, offset + SEARCH_PAGE_TOOLS)) {
    const definition = mcpToolDefs([tool])[0]!;
    const size = Buffer.byteLength(JSON.stringify(definition), "utf8");
    // Selection caps each schema at 8 KiB and description at 1024 characters;
    // one complete definition always fits. Never truncate a JSON schema.
    if (bytes + size > SEARCH_PAGE_BYTES) break;
    definitions.push(definition);
    bytes += size;
  }
  const next = offset + definitions.length;
  return JSON.stringify({
    tools: definitions,
    total: matches.length,
    next_offset: next < matches.length ? next : null,
  });
}

/** Preserve the existing session's routing, result budgets and cancellation. */
export async function callDiscoveredMcpTool(
  session: McpSession,
  input: unknown,
  options?: Parameters<McpSession["call"]>[2],
): ReturnType<McpSession["call"]> {
  if (!isRecord(input) || typeof input.name !== "string" || !isRecord(input.arguments)) {
    throw new Error("call_mcp_tool requires a name and an arguments object");
  }
  return session.call(input.name, input.arguments, options);
}
