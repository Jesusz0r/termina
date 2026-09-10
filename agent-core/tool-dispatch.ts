/** Local tool admission and batch ordering. No provider or process state. */
import { createHash } from "node:crypto";

type ToolCall = { name: string; input: unknown };
type Schema = Record<string, unknown>;
export type ToolExecutionEntry = { index: number; duplicateOf?: number; reuseResult?: boolean };
const TOOL_CONCURRENCY = 4;
// Only these built-ins are known to be observational. MCP annotations are not
// a trust boundary, and bash can mutate anything regardless of its command name.
const READ_TOOLS = new Set(["read_file", "grep", "glob", "fetch"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate the small schema vocabulary used by our own tool definitions.
 * MCP schemas remain owned by the server; this is not a general JSON Schema engine. */
function inputError(value: unknown, schema: Schema, path: string): string | null {
  const type = schema.type;
  const valid = type === "object" ? record(value)
    : type === "array" ? Array.isArray(value)
    : type === "number" ? typeof value === "number" && Number.isFinite(value)
    : type === "integer" ? typeof value === "number" && Number.isSafeInteger(value)
    : typeof value === type;
  if (!valid) return `${path} must be ${type}`;
  if (type === "object" && record(value)) {
    const properties = record(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === "string" && !Object.hasOwn(value, key)) return `${path}.${key} is required`;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (!Object.hasOwn(properties, key)) {
        if (schema.additionalProperties === false) return `${path}.${key} is not a supported argument`;
        continue;
      }
      const child = properties[key];
      if (!record(child)) continue;
      const error = inputError(entry, child, `${path}.${key}`);
      if (error) return error;
    }
  }
  if (Array.isArray(value) && record(schema.items)) {
    for (let i = 0; i < value.length; i++) {
      const error = inputError(value[i], schema.items, `${path}[${i}]`);
      if (error) return error;
    }
  }
  return null;
}

export function toolInputError(call: ToolCall, definitions: readonly Record<string, unknown>[]): string | null {
  const definition = definitions.find((tool) => tool.name === call.name);
  if (!definition || !record(definition.input_schema)) return null;
  const error = inputError(call.input, definition.input_schema, call.name);
  return error ? `error: invalid tool arguments: ${error}. Use the declared tool schema; nothing was executed.` : null;
}

/** Exact canonical JSON, never the lossy diagnostic hash used by loop heuristics.
 * If an input is not representable, do not deduplicate it at all. */
function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 64) throw new Error("input too deep to deduplicate");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`).join(",")}}`;
  }
  throw new Error("non-JSON tool input");
}

function callKey(call: ToolCall): string | null {
  try {
    return createHash("sha256").update(canonicalJson([call.name, call.input])).digest("hex");
  } catch {
    return null;
  }
}

/** Preserve model order. Consecutive reads can overlap; any possible mutation
 * is a barrier on both sides. Reuse reads only inside an uninterrupted read
 * segment; never reuse a result across an action or across model turns. */
export function toolExecutionWaves(calls: readonly ToolCall[]): ToolExecutionEntry[][] {
  const waves: ToolExecutionEntry[][] = [];
  let reads: ToolExecutionEntry[] = [];
  const readKeys = new Map<string, number>();
  let previousActionKey: string | null = null;
  let previousActionIndex = 0;
  const flushReads = (): void => {
    if (reads.length) waves.push(reads);
    reads = [];
  };
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index]!;
    const key = callKey(call);
    if (READ_TOOLS.has(call.name)) {
      previousActionKey = null;
      const duplicateOf = key === null ? undefined : readKeys.get(key);
      reads.push({ index, ...(duplicateOf === undefined ? {} : { duplicateOf, reuseResult: true }) });
      if (key !== null && duplicateOf === undefined) readKeys.set(key, index);
      if (reads.length === TOOL_CONCURRENCY) flushReads();
    } else {
      flushReads();
      readKeys.clear();
      const duplicateOf: number | undefined = key !== null && key === previousActionKey ? previousActionIndex : undefined;
      waves.push([{ index, ...(duplicateOf === undefined ? {} : { duplicateOf, reuseResult: false }) }]);
      previousActionKey = key;
      previousActionIndex = duplicateOf ?? index;
    }
  }
  flushReads();
  return waves;
}
