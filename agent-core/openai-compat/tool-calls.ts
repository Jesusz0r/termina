/**
 * Streaming tool-call decoding shared by protocols.
 *
 * Owns tool-call identity/index/argument validation. Split from
 * agent-core/openai-compat.ts (issue #38).
 */
import { isRecord } from "../../shared/guards.ts";


export const TOOL_CALL_ARGUMENT_ERROR = "provider protocol error: tool call arguments must be a JSON object";

export const TOOL_CALL_IDENTITY_ERROR = "provider protocol error: tool call identity is missing";

export const TOOL_CALL_SHAPE_ERROR = "provider protocol error: malformed tool call";

export const TOOL_CALL_INDEX_ERROR = "provider protocol error: malformed tool call index";

const MAX_TOOL_CALL_INDEX = 10_000;


export function toolCallIdentityError(id: unknown, name: unknown): string | null {
  return typeof id !== "string" || !id.trim() || typeof name !== "string" || !name.trim()
    ? TOOL_CALL_IDENTITY_ERROR
    : null;
}


export function toolCallIndex(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOOL_CALL_INDEX
    ? value
    : null;
}


export function decodeToolCallArguments(
  raw: unknown,
  jsonEncoded: boolean,
): { input: Record<string, unknown>; error?: undefined } | { input?: undefined; error: string } {
  let parsed = raw;
  if (jsonEncoded) {
    if (typeof raw !== "string") return { error: TOOL_CALL_ARGUMENT_ERROR };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { error: TOOL_CALL_ARGUMENT_ERROR };
    }
  }
  return isRecord(parsed) ? { input: parsed } : { error: TOOL_CALL_ARGUMENT_ERROR };
}
