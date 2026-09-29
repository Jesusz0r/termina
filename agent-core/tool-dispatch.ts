/** Local tool admission and batch ordering. No provider or process state. */
import { createHash } from "node:crypto";
import { isRecord } from "../shared/guards.ts";

type ToolCall = { name: string; input: unknown };
/** Trusted built-in definitions, not server-owned JSON Schema. */
type Schema = {
  type?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  additionalProperties?: boolean;
  required?: readonly string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  [key: string]: unknown;
};
type ToolExecutionEntry = { index: number; duplicateOf?: number; reuseResult?: boolean };
const TOOL_CONCURRENCY = 4;
// Only these built-ins are known to be observational. MCP annotations are not
// a trust boundary, and bash can mutate anything regardless of its command name.
export const READ_TOOLS = new Set(["read_file", "read_files", "grep", "glob", "fetch"]);

/** Validate the small schema vocabulary used by our own tool definitions.
 * MCP schemas remain owned by the server; this is not a general JSON Schema engine. */
function inputError(value: unknown, schema: Schema, path: string): string | null {
  const type = schema.type;
  const object = type === "object" && isRecord(value) ? value : null;
  const valid = type === "object" ? object !== null
    : type === "array" ? Array.isArray(value)
    : type === "number" ? typeof value === "number" && Number.isFinite(value)
    : type === "integer" ? typeof value === "number" && Number.isSafeInteger(value)
    : typeof value === type;
  if (!valid) return `${path} must be ${type}`;
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path} must be at least ${schema.minimum}`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path} must be at most ${schema.maximum}`;
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${path} must contain at least ${schema.minLength} characters`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${path} must contain at most ${schema.maxLength} characters`;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path} must contain at least ${schema.minItems} items`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path} must contain at most ${schema.maxItems} items`;
    if (schema.uniqueItems === true && schema.items?.type === "string" && new Set(value).size !== value.length) return `${path} must contain distinct items`;
  }
  if (object) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(object, key)) return `${path}.${key} is required`;
    }
    for (const [key, entry] of Object.entries(object)) {
      if (!Object.hasOwn(properties, key)) {
        if (schema.additionalProperties === false) return `${path}.${key} is not a supported argument`;
        continue;
      }
      const error = inputError(entry, properties[key]!, `${path}.${key}`);
      if (error) return error;
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const error = inputError(value[i], schema.items, `${path}[${i}]`);
      if (error) return error;
    }
  }
  return null;
}

/** Final provider-to-kernel admission invariant. Provider decoders should
 * reject first; this backstop prevents malformed executable calls from being
 * made durable if a decoder regresses. */
export function providerToolAdmissionError(blocks: readonly Record<string, unknown>[]): string | null {
  const ids = new Set<string>();
  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    if (
      typeof block.id !== "string" || !block.id.trim() ||
      typeof block.name !== "string" || !block.name.trim()
    ) {
      return "provider protocol error: tool call identity is missing";
    }
    if (ids.has(block.id)) return "provider protocol error: duplicate tool call identity";
    ids.add(block.id);
    if (!block.input || typeof block.input !== "object" || Array.isArray(block.input)) {
      return "provider protocol error: tool call arguments must be an object";
    }
  }
  return null;
}

export function toolInputError(call: ToolCall, definitions: readonly { name?: string; input_schema?: Schema }[]): string | null {
  const definition = definitions.find((tool) => tool.name === call.name);
  if (!definition?.input_schema) return null;
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
  if (isRecord(value)) {
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
