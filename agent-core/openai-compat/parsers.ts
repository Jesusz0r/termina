/** Provider JSON admission. Stream reducers consume these parsed values only. */
import { isRecord } from "../../shared/guards.ts";
import { TOOL_CALL_ARGUMENT_ERROR, TOOL_CALL_IDENTITY_ERROR, TOOL_CALL_INDEX_ERROR, TOOL_CALL_SHAPE_ERROR, toolCallIndex } from "./tool-calls.ts";

export function decodeToolCallArguments(
  raw: unknown,
  jsonEncoded: boolean,
): { input: Record<string, unknown> } | { error: string } {
  let parsed = raw;
  if (jsonEncoded) {
    if (typeof raw !== "string") return { error: TOOL_CALL_ARGUMENT_ERROR };
    try { parsed = JSON.parse(raw); }
    catch { return { error: TOOL_CALL_ARGUMENT_ERROR }; }
  }
  return isRecord(parsed) ? { input: parsed } : { error: TOOL_CALL_ARGUMENT_ERROR };
}

export type CompletionToolDelta = {
  index: number;
  id?: string | null;
  type?: "function" | null;
  name?: string | null;
  args: string;
  thoughtSignature: string;
};

type ToolDeltaResult = CompletionToolDelta | { error: string };

function parseCompletionToolDelta(value: unknown): ToolDeltaResult {
  if (!isRecord(value)) return { error: TOOL_CALL_SHAPE_ERROR };
  const { index: rawIndex, id, type, function: rawFunction, extra_content: extra } = value;
  const index = toolCallIndex(rawIndex);
  if (index === null) return { error: TOOL_CALL_INDEX_ERROR };
  if (type !== undefined && type !== null && type !== "function") return { error: TOOL_CALL_SHAPE_ERROR };
  if (id !== undefined && id !== null && typeof id !== "string") return { error: TOOL_CALL_IDENTITY_ERROR };
  if (rawFunction !== undefined && !isRecord(rawFunction)) return { error: TOOL_CALL_SHAPE_ERROR };
  const { name, arguments: args } = rawFunction === undefined ? {} : rawFunction;
  if (name !== undefined && name !== null && typeof name !== "string") return { error: TOOL_CALL_IDENTITY_ERROR };
  if (args !== undefined && typeof args !== "string") return { error: TOOL_CALL_ARGUMENT_ERROR };
  const google = isRecord(extra) ? extra.google : undefined;
  const signature = isRecord(google) ? google.thought_signature : undefined;
  return { index, id, type, name, args: args ?? "", thoughtSignature: typeof signature === "string" ? signature : "" };
}

export type CompletionStreamEvent = {
  text: string;
  thinking: string;
  finishReason: string | null;
  usage?: Record<string, unknown>;
  toolCalls: ToolDeltaResult[];
};

export function parseCompletionStreamEvent(value: unknown): CompletionStreamEvent {
  if (!isRecord(value)) throw new Error("provider protocol error: malformed stream event");
  const { choices, usage: rawUsage } = value;
  const choice: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const { delta: rawDelta, finish_reason: finish } = isRecord(choice) ? choice : {};
  const delta = isRecord(rawDelta) ? rawDelta : {};
  const text = typeof delta.content === "string" ? delta.content : "";
  let thinking = "";
  for (const field of ["reasoning_content", "reasoning", "reasoning_text"] as const) {
    const content = delta[field];
    if (typeof content === "string" && content) { thinking = content; break; }
  }
  const rawCalls = delta.tool_calls;
  const toolCalls: ToolDeltaResult[] = Array.isArray(rawCalls) ? rawCalls.map(parseCompletionToolDelta)
    : rawCalls === undefined ? [] : [{ error: TOOL_CALL_SHAPE_ERROR }];
  return {
    text, thinking, finishReason: typeof finish === "string" && finish ? finish : null,
    usage: isRecord(rawUsage) ? rawUsage : undefined, toolCalls,
  };
}

export type GoogleFunctionCall = { name: string; providerId: string; input: Record<string, unknown> };
export type GooglePart = {
  text: string;
  thought: boolean;
  signature: string;
  call?: GoogleFunctionCall | { error: string };
};
export type GoogleStreamEvent = {
  parts: GooglePart[];
  text: string;
  thinking: string;
  finishReason: string | null;
  usage?: Record<string, unknown>;
};

function parseGooglePart(value: unknown): GooglePart | null {
  if (!isRecord(value)) return null;
  const { text: rawText, thought: rawThought, thoughtSignature, functionCall } = value;
  const text = typeof rawText === "string" ? rawText : "";
  const thought = rawThought === true;
  const signature = typeof thoughtSignature === "string" ? thoughtSignature : "";
  const part: GooglePart = { text, thought, signature };
  if (thought || !("functionCall" in value)) return part;
  if (!isRecord(functionCall)) return { ...part, call: { error: TOOL_CALL_SHAPE_ERROR } };
  const { name, id, args } = functionCall;
  if (typeof name !== "string" || !name.trim()) return { ...part, call: { error: TOOL_CALL_IDENTITY_ERROR } };
  const parsed = decodeToolCallArguments(args, false);
  if ("error" in parsed) return { ...part, call: { error: parsed.error } };
  return { ...part, call: { name, providerId: typeof id === "string" && id.trim() ? id : "", input: parsed.input } };
}

export function parseGoogleStreamEvent(value: unknown): GoogleStreamEvent {
  if (!isRecord(value)) throw new Error("provider protocol error: malformed stream event");
  const { candidates, usageMetadata } = value;
  const candidate: unknown = Array.isArray(candidates) ? candidates[0] : undefined;
  const { content, finishReason } = isRecord(candidate) ? candidate : {};
  const rawParts = isRecord(content) ? content.parts : undefined;
  const parts: GooglePart[] = [];
  let text = "";
  let thinking = "";
  for (const raw of Array.isArray(rawParts) ? rawParts : []) {
    const part = parseGooglePart(raw);
    if (!part) continue;
    parts.push(part);
    if (part.thought) thinking += part.text;
    else text += part.text;
  }
  return {
    parts, text, thinking, finishReason: typeof finishReason === "string" && finishReason ? finishReason : null,
    usage: isRecord(usageMetadata) ? usageMetadata : undefined,
  };
}

/** Non-streaming completion text uses the same JSON boundary owner. */
export function parseCompletionTextPayload(value: unknown): { text: string; usage?: Record<string, unknown> } {
  if (!isRecord(value)) return { text: "" };
  const { choices, usage } = value;
  const choice: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const message = isRecord(choice) ? choice.message : undefined;
  const content = isRecord(message) ? message.content : undefined;
  return { text: typeof content === "string" ? content.trim() : "", usage: isRecord(usage) ? usage : undefined };
}
