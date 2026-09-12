/**
 * MCP call-result normalization.
 *
 * Owns bounded result rendering and call-result shaping. Split from
 * agent-core/mcp.ts (issue #38).
 */
import { BoundedTextAccumulator, type BoundedToolResult, type CompletionState } from "../tool-output.ts";
import { MCP_RESULT_BYTES, SCHEMA_MAX_DEPTH } from "./config.ts";
import { sanitizeMcpIdent } from "./tools.ts";


export type McpCancellationScope = "none" | "connection";


export type McpContinuation = Readonly<{
  server: string;
  tool: string;
  guidance: string;
}>;


export type McpCallResult = BoundedToolResult & Readonly<{
  /** "connection" means sibling in-flight calls were aborted with this one. */
  cancellationScope: McpCancellationScope;
  /** Present when output was truncated or a structured payload was omitted. */
  continuation: McpContinuation | null;
}>;


/** Build a bounded, argument-free continuation descriptor for MCP output. */
export function createMcpContinuation(server: string, tool: string): McpContinuation {
  const safeServer = sanitizeMcpIdent(server, 32);
  const safeTool = sanitizeMcpIdent(tool, 64);
  return Object.freeze({
    server: safeServer,
    tool: safeTool,
    guidance: `Call MCP tool ${JSON.stringify(safeTool)} on server ${JSON.stringify(safeServer)} again to retrieve the complete output; arguments are intentionally omitted.`,
  });
}


function mcpOutputMarker(details: { state: CompletionState }, continuation: McpContinuation | null): string {
  const guidance = continuation ? ` — ${continuation.guidance}` : " — call again for complete output";
  return details.state === "complete"
    ? `[mcp output truncated${guidance}]`
    : `[mcp output incomplete: ${details.state}${guidance}]`;
}


function mcpOmissionMarker(kind: string, reason: string, continuation: McpContinuation | null): string {
  const guidance = continuation ? `; ${continuation.guidance}` : "; call the MCP tool again for the omitted payload";
  return `[mcp ${kind} omitted: ${reason}${guidance}]`;
}


type StableOutputJson = Readonly<{
  encoded: string | null;
  reason: "too-large" | "not-json-serializable" | null;
}>;


const OUTPUT_JSON_TOO_LARGE = Symbol("mcp output JSON too large");


/**
 * Canonically encode an MCP result value without doing work beyond the
 * provider-visible result budget. This intentionally does not reuse schema
 * canonicalization: result values can be server-controlled and much larger
 * than tool schemas.
 */
function stableOutputJson(raw: unknown, maxBytes = MCP_RESULT_BYTES): StableOutputJson {
  const chunks: string[] = [];
  let bytes = 0;
  const push = (part: string): void => {
    const partBytes = Buffer.byteLength(part, "utf8");
    if (bytes + partBytes > maxBytes) throw OUTPUT_JSON_TOO_LARGE;
    chunks.push(part);
    bytes += partBytes;
  };
  const pushString = (value: string): void => {
    // JSON encoding cannot be shorter than the UTF-8 input, so avoid creating
    // an escaped copy of a string that cannot fit before the final check.
    if (Buffer.byteLength(value, "utf8") > maxBytes - bytes) throw OUTPUT_JSON_TOO_LARGE;
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string") throw new Error("mcp output is not JSON-serializable");
    push(encoded);
  };
  const visit = (value: unknown, seen: WeakSet<object>, depth: number): void => {
    if (value === null) {
      push("null");
      return;
    }
    switch (typeof value) {
      case "string":
        pushString(value);
        return;
      case "boolean":
        push(value ? "true" : "false");
        return;
      case "number":
        if (!Number.isFinite(value)) throw new Error("mcp output contains a non-finite number");
        push(JSON.stringify(value));
        return;
      case "object":
        break;
      default:
        throw new Error("mcp output is not JSON-serializable");
    }
    if (depth > SCHEMA_MAX_DEPTH || seen.has(value)) throw new Error("mcp output is too deep or cyclic");
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        push("[");
        for (let index = 0; index < value.length; index += 1) {
          if (index > 0) push(",");
          visit(value[index], seen, depth + 1);
        }
        push("]");
      } else {
        push("{");
        const keys: string[] = [];
        for (const key in value as Record<string, unknown>) {
          if (!Object.hasOwn(value, key)) continue;
          keys.push(key);
          if (keys.length > maxBytes) throw OUTPUT_JSON_TOO_LARGE;
        }
        keys.sort();
        for (let index = 0; index < keys.length; index += 1) {
          if (index > 0) push(",");
          const key = keys[index]!;
          pushString(key);
          push(":");
          visit((value as Record<string, unknown>)[key], seen, depth + 1);
        }
        push("}");
      }
    } finally {
      seen.delete(value);
    }
  };

  try {
    visit(raw, new WeakSet<object>(), 0);
    return Object.freeze({ encoded: chunks.join(""), reason: null });
  } catch (err) {
    return Object.freeze({
      encoded: null,
      reason: err === OUTPUT_JSON_TOO_LARGE ? "too-large" : "not-json-serializable",
    });
  }
}


function stableOutputFailure(result: StableOutputJson): string {
  return result.reason === "too-large" ? "too large" : "not JSON-serializable";
}


function outputTypeLabel(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "unknown";
  const label = raw.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 32);
  return label || "unknown";
}


function resourceMetadata(raw: unknown): { metadata: Record<string, unknown>; hasBlob: boolean } {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const metadata: Record<string, unknown> = {};
  for (const key of ["uri", "mimeType", "name", "title", "description", "text"]) {
    if (typeof source[key] === "string") metadata[key] = source[key];
  }
  return { metadata, hasBlob: Object.hasOwn(source, "blob") };
}


function finishMcpOutput(
  accumulator: BoundedTextAccumulator,
  isError: boolean,
  state: CompletionState = "complete",
  cancellationScope: McpCancellationScope = "none",
  continuation: McpContinuation | null = null,
  omitted = false,
): McpCallResult {
  const bounded = accumulator.finish(state);
  const hasOmission = omitted || bounded.truncated;
  return Object.freeze({
    ...bounded,
    content: bounded.text,
    isError,
    cancellationScope,
    truncated: hasOmission,
    continuation: hasOmission ? continuation : null,
  });
}


export function mcpErrorResult(
  content: string,
  state: CompletionState = "failed",
  cancellationScope: McpCancellationScope = "none",
  continuation: McpContinuation | null = null,
): McpCallResult {
  const marker = (details: { state: CompletionState }): string => mcpOutputMarker(details, continuation);
  const accumulator = new BoundedTextAccumulator({
    maxBytes: MCP_RESULT_BYTES,
    direction: "head",
    marker,
  });
  accumulator.push(content);
  return finishMcpOutput(accumulator, true, state, cancellationScope, continuation);
}


/** Normalize MCP text content through the shared bounded UTF-8 accumulator. */
export function normalizeMcpCallResult(result: unknown, continuation: McpContinuation | null = null): McpCallResult {
  const marker = (details: { state: CompletionState }): string => mcpOutputMarker(details, continuation);
  const accumulator = new BoundedTextAccumulator({
    maxBytes: MCP_RESULT_BYTES,
    direction: "head",
    marker,
  });
  if (!result || typeof result !== "object") {
    accumulator.push("(no output)");
    return finishMcpOutput(accumulator, true, "failed", "none", continuation);
  }

  const rec = result as { content?: unknown; isError?: unknown; structuredContent?: unknown };
  const isError = rec.isError === true;
  let structuredPart: string | null = null;
  let structuredCanonical: string | null = null;
  const jsonParts: string[] = [];
  const resourceParts: string[] = [];
  const resourceLinkParts: string[] = [];
  const omittedParts: string[] = [];
  let omitted = false;
  const textParts: string[] = [];

  if (Object.hasOwn(rec, "structuredContent") && rec.structuredContent !== undefined) {
    const encoded = stableOutputJson(rec.structuredContent);
    if (encoded.encoded === null) {
      omitted = true;
      omittedParts.push(mcpOmissionMarker("structuredContent", stableOutputFailure(encoded), continuation));
    }
    else {
      structuredCanonical = encoded.encoded;
      structuredPart = `[mcp structuredContent] ${encoded.encoded}`;
    }
  }

  if (Array.isArray(rec.content)) {
    for (const block of rec.content) {
      if (!block || typeof block !== "object") continue;
      const b = block as {
        type?: unknown;
        text?: unknown;
        json?: unknown;
        resource?: unknown;
        uri?: unknown;
        mimeType?: unknown;
        name?: unknown;
        title?: unknown;
        description?: unknown;
      };
      if (b.type === "text" && typeof b.text === "string") {
        textParts.push(b.text);
      } else if (b.type === "json") {
        const encoded = stableOutputJson(b.json);
        if (encoded.encoded === null) {
          omitted = true;
          jsonParts.push(mcpOmissionMarker("json", stableOutputFailure(encoded), continuation));
        } else {
          jsonParts.push(
            `[mcp json] ${encoded.encoded}`,
          );
        }
      } else if (b.type === "resource") {
        const resource = resourceMetadata(b.resource ?? b);
        const encoded = stableOutputJson(resource.metadata);
        if (encoded.encoded === null) {
          omitted = true;
          resourceParts.push(mcpOmissionMarker("resource", encoded.reason === "too-large" ? "too large" : "metadata unavailable", continuation));
        } else {
          resourceParts.push(`[mcp resource] ${encoded.encoded}`);
        }
        if (resource.hasBlob) {
          omitted = true;
          resourceParts.push(mcpOmissionMarker("resource payload", "binary blob", continuation));
        }
      } else if (b.type === "resource_link") {
        const link = resourceMetadata(b);
        const encoded = stableOutputJson(link.metadata);
        if (encoded.encoded === null) {
          omitted = true;
          resourceLinkParts.push(mcpOmissionMarker("resource_link", encoded.reason === "too-large" ? "too large" : "metadata unavailable", continuation));
        } else {
          resourceLinkParts.push(`[mcp resource_link] ${encoded.encoded}`);
        }
      } else if (b.type === "image" || b.type === "audio") {
        const kind = outputTypeLabel(b.type);
        const mime = typeof b.mimeType === "string"
          ? ` (${b.mimeType.slice(0, 96).replace(/[\x00-\x1f\x7f]/g, " ")})`
          : "";
        omitted = true;
        omittedParts.push(mcpOmissionMarker(kind, `binary payload${mime}`, continuation));
      } else {
        omitted = true;
        omittedParts.push(mcpOmissionMarker(outputTypeLabel(b.type), "unsupported content", continuation));
      }
    }
  } else if (typeof rec.content === "string") {
    textParts.push(rec.content);
  }

  let outputParts = 0;
  const pushPart = (text: string): void => {
    if (outputParts > 0) accumulator.push("\n");
    accumulator.push(text);
    outputParts += 1;
  };
  if (structuredPart !== null) pushPart(structuredPart);
  const equivalentTextIndexes = new Set<number>();
  if (structuredCanonical !== null) {
    for (let index = 0; index < textParts.length; index += 1) {
      const text = textParts[index]!;
      if (!text.trim()) continue;
      // A giant textual block cannot be a useful duplicate after the
      // provider-visible result cap. Avoid reparsing transport-sized text;
      // preserving it as a distinct summary is safer than guessing.
      if (Buffer.byteLength(text, "utf8") > MCP_RESULT_BYTES) continue;
      try {
        const parsed = JSON.parse(text) as unknown;
        const canonical = stableOutputJson(parsed);
        if (canonical.encoded === structuredCanonical) equivalentTextIndexes.add(index);
      } catch {
        // A textual summary that merely contains JSON remains meaningful.
      }
    }
  }
  for (let index = 0; index < textParts.length; index += 1) {
    const text = textParts[index]!;
    if (text.length > 0 && !equivalentTextIndexes.has(index)) pushPart(text);
  }
  for (const text of [...jsonParts].sort()) pushPart(text);
  for (const text of [...resourceParts].sort()) pushPart(text);
  for (const text of [...resourceLinkParts].sort()) pushPart(text);
  for (const text of [...omittedParts].sort()) pushPart(text);
  if (outputParts === 0) pushPart(isError ? "error: mcp tool failed" : "(no output)");
  return finishMcpOutput(accumulator, isError, "complete", "none", continuation, omitted);
}
