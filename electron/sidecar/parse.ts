/**
 * Sidecar JSONL record parsing.
 *
 * Owns record parsing and envelope/body decoding into SidecarEvents.
 * Split from electron/sidecar.ts (issue #38).
 */
import type { SidecarEvent, SidecarMeta, ToolEdits } from "./events.js";


const SIDECAR_KINDS = new Set<SidecarEvent["t"]>([
  "preflight_request",
  "preflight_cancel",
  "prompt",
  "steer_input",
  "checkpoint_request",
  "checkpoint_result",
  "session_ready",
  "agent_start",
  "agent_settled",
  "agent_settings",
  "plan",
  "tool",
  "tool_end",
  "subagent_spawn",
]);


/** One JSONL object. Arrays, primitives, and malformed JSON are not records. */
export function parseSidecarRecord(line: string): Record<string, unknown> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}


/** bridgeId plus a monotonic seq. Unknown kinds still occupy this slot. */
export function sidecarEnvelope(rec: Record<string, unknown>): SidecarMeta | null {
  const bridgeId = rec.bridgeId;
  const seq = rec.seq;
  const generation = rec.generation;
  if (typeof bridgeId !== "string" || bridgeId.length === 0) return null;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) return null;
  return {
    bridgeId,
    seq,
    ...(typeof rec.producerPid === "number" && Number.isSafeInteger(rec.producerPid) && rec.producerPid > 0
      ? { producerPid: rec.producerPid } : {}),
    ...(typeof generation === "string" && generation.length > 0 && generation.length <= 256 ? { generation } : {}),
  };
}


export function sidecarEventFromRecord(rec: Record<string, unknown>): SidecarEvent | null {
  const envelope = sidecarEnvelope(rec);
  if (!envelope) return null;
  return sidecarEventBody(envelope, rec);
}


function isSidecarKind(t: string): t is SidecarEvent["t"] {
  return SIDECAR_KINDS.has(t as SidecarEvent["t"]);
}


export function sidecarEventBody(meta: SidecarMeta, rec: Record<string, unknown>): SidecarEvent | null {
  const t = rec.t;
  if (typeof t !== "string" || !isSidecarKind(t)) return null;
  switch (t) {
    case "preflight_request":
      return {
        ...meta,
        t: "preflight_request",
        requestId: optionalString(rec.requestId),
        hasImages: optionalBoolean(rec.hasImages),
        deadlineAt: optionalSafeInteger(rec.deadlineAt),
      };
    case "preflight_cancel":
      return { ...meta, t: "preflight_cancel", requestId: optionalString(rec.requestId) };
    case "prompt":
      return { ...meta, t: "prompt", file: optionalString(rec.file), hasPreflight: optionalBoolean(rec.hasPreflight) };
    case "steer_input":
      return { ...meta, t: "steer_input", behavior: optionalString(rec.behavior) };
    case "checkpoint_request":
      return {
        ...meta,
        t: "checkpoint_request",
        requestId: optionalString(rec.requestId),
        kind: optionalString(rec.kind),
        entryId: optionalStringOrNull(rec.entryId),
      };
    case "checkpoint_result":
      return {
        ...meta,
        t: "checkpoint_result",
        requestId: optionalString(rec.requestId),
        ok: optionalBoolean(rec.ok),
        error: optionalStringOrNull(rec.error),
      };
    case "session_ready":
      return {
        ...meta,
        t: "session_ready",
        opId: optionalString(rec.opId),
        ok: optionalBoolean(rec.ok),
        error: optionalStringOrNull(rec.error),
      };
    case "agent_start":
      return {
        ...meta,
        t: "agent_start",
        preflightRequestId: optionalStringOrNull(rec.preflightRequestId),
        preflightToken: optionalStringOrNull(rec.preflightToken),
        sessionFile: optionalStringOrNull(rec.sessionFile),
        sessionId: optionalStringOrNull(rec.sessionId),
        entryId: optionalStringOrNull(rec.entryId),
        parentEntryId: optionalStringOrNull(rec.parentEntryId),
        model: optionalStringOrNull(rec.model),
        thinkingLevel: optionalStringOrNull(rec.thinkingLevel),
      };
    case "agent_settled":
      return { ...meta, t: "agent_settled", error: optionalStringOrNull(rec.error) };
    case "agent_settings":
      return {
        ...meta,
        t: "agent_settings",
        model: optionalStringOrNull(rec.model),
        thinkingLevel: optionalStringOrNull(rec.thinkingLevel),
        usage: optionalStringOrNull(rec.usage),
      };
    case "plan":
      return { ...meta, t: "plan", text: optionalString(rec.text) };
    case "tool":
      return {
        ...meta,
        t: "tool",
        toolName: optionalString(rec.toolName),
        path: optionalString(rec.path),
        edits: optionalEdits(rec.edits),
        editsTruncated: optionalBoolean(rec.editsTruncated),
        editsBytes: optionalSafeInteger(rec.editsBytes),
        editsCount: optionalSafeInteger(rec.editsCount),
        editsSha256: optionalString(rec.editsSha256),
        toolCallId: optionalString(rec.toolCallId),
        entryId: optionalStringOrNull(rec.entryId),
      };
    case "tool_end":
      return { ...meta, t: "tool_end", toolCallId: optionalString(rec.toolCallId), isError: optionalBoolean(rec.isError) };
    case "subagent_spawn":
      return { ...meta, t: "subagent_spawn", runId: optionalString(rec.runId), taskFile: optionalString(rec.taskFile), userRequested: optionalBoolean(rec.userRequested) };
  }
}


function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}


function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}


function optionalSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}


function optionalStringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}


function optionalEdits(value: unknown): ToolEdits | undefined {
  if (!Array.isArray(value)) return undefined;
  const edits: ToolEdits = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const oldText = optionalString(rec.oldText);
    const newText = optionalString(rec.newText);
    if (oldText === undefined && newText === undefined) continue;
    edits.push({ ...(oldText !== undefined ? { oldText } : {}), ...(newText !== undefined ? { newText } : {}) });
  }
  return edits;
}
