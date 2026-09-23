/**
 * MCP tool normalization and selection.
 *
 * Owns tool identity, schema normalization, dedupe, selection, and
 * provider defs. Split from agent-core/mcp.ts (issue #38).
 */
import { MAX_MCP_TOOLS, MAX_MCP_TOOL_BYTES, SCHEMA_CAP, SCHEMA_MAX_DEPTH } from "./config.ts";


export const KERNEL_TOOL_NAMES = new Set([
  "read_file",
  "write_file",
  "edit",
  "grep",
  "glob",
  "bash",
  "web_search",
  "fetch",
]);


const IDENT = /[^A-Za-z0-9_-]+/g;

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;


export type McpClientTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  server: string;
  original: string;
};


export function sanitizeMcpIdent(raw: string, max = 32): string {
  const s = raw.replace(IDENT, "_").replace(/^_+|_+$/g, "").slice(0, max);
  return s || "s";
}


/** Prefix mcp_<server>_<tool> and keep the Anthropic 64-char name cap. */
export function mcpToolName(server: string, tool: string): string {
  const s = sanitizeMcpIdent(server, 24);
  const t = sanitizeMcpIdent(tool, 32);
  const name = `mcp_${s}_${t}`;
  if (name.length <= 64 && TOOL_NAME.test(name)) return name;
  const budget = 64 - "mcp_".length - 1;
  let serverPart = s;
  let toolPart = t;
  if (serverPart.length + toolPart.length > budget) {
    const keepServer = Math.min(serverPart.length, Math.max(4, Math.floor(budget / 3)));
    serverPart = serverPart.slice(0, keepServer);
    toolPart = toolPart.slice(0, budget - serverPart.length);
  }
  const out = `mcp_${serverPart}_${toolPart}`.slice(0, 64);
  return TOOL_NAME.test(out) ? out : "mcp_tool";
}


function canonicalizeJsonValue(raw: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (raw === null || typeof raw !== "object") {
    if (raw === undefined || typeof raw === "function" || typeof raw === "symbol") {
      throw new Error("mcp schema contains a non-JSON value");
    }
    if (typeof raw === "number" && !Number.isFinite(raw)) {
      throw new Error("mcp schema contains a non-finite number");
    }
    return raw;
  }
  if (depth > SCHEMA_MAX_DEPTH || seen.has(raw)) throw new Error("mcp schema is too deep or cyclic");
  seen.add(raw);
  try {
    if (Array.isArray(raw)) {
      return raw.map((value) => canonicalizeJsonValue(value, seen, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(raw).sort()) {
      const value = canonicalizeJsonValue((raw as Record<string, unknown>)[key], seen, depth + 1);
      Object.defineProperty(out, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    }
    return out;
  } finally {
    seen.delete(raw);
  }
}


type NormalizedInputSchema =
  | { ok: true; schema: Record<string, unknown> }
  | { ok: false; error: string };

export function normalizeInputSchema(raw: unknown): NormalizedInputSchema {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "mcp schema must be a JSON object" };
  }
  const schema = raw as Record<string, unknown>;
  if (schema.type !== undefined && schema.type !== "object") {
    return { ok: false, error: `mcp schema type must be object, got ${String(schema.type)}` };
  }
  try {
    const source = { ...schema, type: "object" };
    const out = canonicalizeJsonValue(source, new WeakSet<object>(), 0);
    if (!out || typeof out !== "object" || Array.isArray(out)) {
      return { ok: false, error: "mcp schema must canonicalize to an object" };
    }
    const encoded = JSON.stringify(out);
    if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > SCHEMA_CAP) {
      return { ok: false, error: "mcp schema exceeds the byte cap" };
    }
    return { ok: true, schema: out as Record<string, unknown> };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "mcp schema is invalid" };
  }
}


function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}


function toolIdentity(tool: McpClientTool): string {
  return JSON.stringify([tool.server, tool.original]);
}


function toolTieBreakKey(tool: McpClientTool): string {
  return JSON.stringify([tool.description, tool.input_schema]);
}


function compareMcpTools(a: McpClientTool, b: McpClientTool): number {
  return (
    compareStrings(a.server, b.server) ||
    compareStrings(a.original, b.original) ||
    compareStrings(toolTieBreakKey(a), toolTieBreakKey(b))
  );
}


function mcpConflictNote(tool: McpClientTool, variants: number): string {
  const server = JSON.stringify(tool.server.slice(0, 96));
  const original = JSON.stringify(tool.original.slice(0, 128));
  return `mcp tool conflict for ${server}/${original}: ${variants} definitions; using the deterministic canonical definition`;
}


function cloneMcpTool(tool: McpClientTool): { tool: McpClientTool } | { error: string } | null {
  if (!tool || typeof tool !== "object") return null;
  const server = typeof tool.server === "string" ? tool.server : "";
  const original = typeof tool.original === "string"
    ? tool.original
    : typeof tool.name === "string" ? tool.name : "";
  if (!server || !original) return null;
  const schema = normalizeInputSchema(tool.input_schema);
  if (!schema.ok) {
    const label = JSON.stringify(`${server.slice(0, 96)}/${original.slice(0, 128)}`);
    return { error: `mcp schema invalid for ${label}: ${schema.error}` };
  }
  return {
    tool: {
      name: original,
      description: typeof tool.description === "string" ? tool.description.slice(0, 1024) : original,
      input_schema: schema.schema,
      server,
      original,
    },
  };
}


/**
 * Copy and canonically order MCP discovery results before applying any caps.
 * A server can repeat a tool across pages, and different servers can return
 * the same page in different orders. Identity is server + original name; a
 * deterministic descriptor tie-breaker chooses the same winner in either
 * case.
 */
export function normalizeMcpDiscovery(discovered: readonly McpClientTool[]): {
  tools: McpClientTool[];
  conflicts: string[];
} {
  const candidates: McpClientTool[] = [];
  const conflicts: string[] = [];
  for (const raw of discovered) {
    const copy = cloneMcpTool(raw);
    if (!copy) continue;
    if ("error" in copy) {
      conflicts.push(copy.error);
      continue;
    }
    candidates.push(copy.tool);
  }
  candidates.sort(compareMcpTools);

  const tools: McpClientTool[] = [];
  for (let i = 0; i < candidates.length;) {
    const first = candidates[i]!;
    const identity = toolIdentity(first);
    let end = i + 1;
    while (end < candidates.length && toolIdentity(candidates[end]!) === identity) end++;
    const variants = new Set<string>();
    for (let index = i; index < end; index++) variants.add(toolTieBreakKey(candidates[index]!));
    if (variants.size > 1) conflicts.push(mcpConflictNote(first, variants.size));
    tools.push(first);
    i = end;
  }
  return { tools, conflicts };
}


function addMcpNameSuffix(base: string, suffix: number): string {
  if (suffix <= 1) return base;
  const marker = `_${suffix}`;
  const prefix = base.slice(0, Math.max(1, 64 - marker.length));
  const out = `${prefix}${marker}`.slice(0, 64);
  return TOOL_NAME.test(out) ? out : "mcp_tool";
}


function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item, seen);
  } else {
    for (const item of Object.values(value as Record<string, unknown>)) freezeDeep(item, seen);
  }
  return Object.freeze(value);
}


function providerMcpToolDef(tool: McpClientTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  };
}


function providerMcpToolBytes(tool: McpClientTool): number {
  return Buffer.byteLength(JSON.stringify(providerMcpToolDef(tool)), "utf8");
}


// Freeze the capped server catalog for a session. discovery.ts exposes schemas
// on demand; selection does not add these definitions to the provider prefix.
export function selectMcpTools(
  discovered: McpClientTool[],
  kernelNames: ReadonlySet<string> = KERNEL_TOOL_NAMES,
): McpClientTool[] {
  const normalized = normalizeMcpDiscovery(discovered).tools;
  const out: McpClientTool[] = [];
  const used = new Set<string>(kernelNames);
  let bytes = 0;
  for (const tool of normalized) {
    if (out.length >= MAX_MCP_TOOLS) break;
    const base = mcpToolName(tool.server, tool.original);
    let suffix = 1;
    let name = base;
    while (used.has(name)) name = addMcpNameSuffix(base, ++suffix);
    const schema = normalizeInputSchema(tool.input_schema);
    if (!schema.ok) continue;
    const next = {
      name,
      description: tool.description,
      input_schema: schema.schema,
      server: tool.server,
      original: tool.original,
    } satisfies McpClientTool;
    freezeDeep(next);
    const nextBytes = providerMcpToolBytes(next);
    if (bytes + nextBytes > MAX_MCP_TOOL_BYTES) continue;
    used.add(name);
    out.push(next);
    bytes += nextBytes;
  }
  return Object.freeze(out) as unknown as McpClientTool[];
}


export function mcpToolDefs(tools: McpClientTool[]): Array<Record<string, unknown>> {
  return tools.map(providerMcpToolDef);
}
