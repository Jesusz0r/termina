/**
 * Bounded SSE parsing.
 *
 * Owns incremental SSE framing and JSON event reads. Split from
 * agent-core/openai-compat.ts (issue #38).
 */
import { responsesLiveDelta } from "./responses-stream.ts";


/** Maximum unconsumed decoded SSE text retained between line boundaries. */
export const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;

/** Protect the caller's event array from an endless stream of tiny events. */
export const MAX_SSE_EVENT_COUNT = 32_768;

/** Bound parsed JSON retained by a single provider stream. */
export const MAX_SSE_PAYLOAD_BYTES = 32 * 1024 * 1024;


type SseParseState = {
  events: Array<Record<string, unknown>>;
  eventCount: number;
  payloadBytes: number;
  terminalSeen: boolean;
  terminalAllowsUsage: boolean;
  terminalSummary: string | null;
};


type SseBufferState = {
  buffer: string;
  bytes: number;
};


const SSE_ENCODER = new TextEncoder();


function sseUtf8Bytes(value: string): number {
  return SSE_ENCODER.encode(value).byteLength;
}


function isSseChoiceTerminal(event: Record<string, unknown>): boolean {
  if (
    Array.isArray(event.choices) && event.choices[0] && typeof event.choices[0] === "object"
  ) {
    const finishReason = (event.choices[0] as Record<string, unknown>).finish_reason;
    if (typeof finishReason === "string" && finishReason.trim()) return true;
  }
  const candidates = event.candidates;
  if (Array.isArray(candidates) && candidates[0] && typeof candidates[0] === "object") {
    const finishReason = (candidates[0] as Record<string, unknown>).finishReason;
    if (typeof finishReason === "string" && finishReason.trim()) return true;
  }
  return false;
}


function isSseTerminalEvent(event: Record<string, unknown>): boolean {
  const type = typeof event.type === "string" ? event.type : "";
  if (
    type === "response.completed" ||
    type === "response.failed" ||
    type === "response.incomplete" ||
    type === "response.cancelled" ||
    type === "response.aborted" ||
    type === "response.error" ||
    type === "response.done" ||
    type === "message_stop" ||
    type === "completion.done" ||
    type === "error"
  ) return true;
  return isSseChoiceTerminal(event);
}


function isSseUsageOnlyTrailer(event: Record<string, unknown>): boolean {
  if (typeof event.type === "string" && event.type) return false;
  const choices = event.choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
    return false;
  }
  return Array.isArray(choices) && choices.length === 0 &&
    event.usage !== undefined && event.usage !== null &&
    typeof event.usage === "object" && !Array.isArray(event.usage);
}


function takeSseEvents(
  buffer: string,
  bufferBytes: number,
  state: SseParseState,
  flush: boolean,
  filter?: (event: Record<string, unknown>) => boolean,
): SseBufferState {
  let nl: number;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const rawLine = buffer.slice(0, nl);
    const line = rawLine.trim();
    buffer = buffer.slice(nl + 1);
    bufferBytes -= sseUtf8Bytes(rawLine) + 1;
    pushSseLine(line, state, filter);
  }
  if (flush) {
    const tail = buffer.trim();
    if (tail) {
      if (!tail.startsWith("data:")) throw new Error("provider SSE ended with a nonempty incomplete EOF tail");
      pushSseLine(tail, state, filter);
    }
    return { buffer: "", bytes: 0 };
  }
  return { buffer, bytes: Math.max(0, bufferBytes) };
}


function summarizeSseEvent(event: Record<string, unknown>): string {
  const keys = Object.keys(event).slice(0, 8).join(",");
  const type = typeof event.type === "string" ? event.type : "";
  const extras: string[] = [];
  const choice = Array.isArray(event.choices) ? event.choices[0] : null;
  if (choice && typeof choice === "object") {
    const rec = choice as Record<string, unknown>;
    if (typeof rec.finish_reason === "string" && rec.finish_reason) extras.push(`finish_reason=${rec.finish_reason}`);
    if (rec.delta && typeof rec.delta === "object" && !Array.isArray(rec.delta)) {
      extras.push(`deltaKeys=${Object.keys(rec.delta).slice(0, 6).join("+")}`);
    }
    if (rec.message && typeof rec.message === "object") extras.push("message=yes");
  }
  if (event.usage !== undefined) extras.push("usage=yes");
  return `type=${type || "-"} keys=${keys}${extras.length ? ` ${extras.join(" ")}` : ""}`.slice(0, 220);
}


/** Late stream content after the terminal event (deltas, output items,
 *  tool calls) is rejected: pre-terminal events already hold the result, so
 *  a stray chunk would silently fork the turn. Benign trailers (keepalive
 *  pings, duplicate terminals, usage-only events) are stored for
 *  downstream result parsing. */
function carriesLateStreamContent(event: Record<string, unknown>): boolean {
  const choice = Array.isArray(event.choices) ? event.choices[0] : null;
  if (choice && typeof choice === "object") {
    const rec = choice as Record<string, unknown>;
    const delta = rec.delta;
    if (delta && typeof delta === "object" && !Array.isArray(delta) && Object.keys(delta).length > 0) return true;
    const message = rec.message;
    if (message && typeof message === "object" && !Array.isArray(message)) {
      const content = (message as Record<string, unknown>).content;
      if (typeof content === "string" ? content !== "" : content !== undefined && content !== null) return true;
      if ((message as Record<string, unknown>).tool_calls !== undefined) return true;
    }
  }
  const candidates = event.candidates;
  if (Array.isArray(candidates) && candidates[0] && typeof candidates[0] === "object") {
    const content = (candidates[0] as Record<string, unknown>).content;
    if (content && typeof content === "object" && !Array.isArray(content)) {
      const parts = (content as Record<string, unknown>).parts;
      if (Array.isArray(parts) && parts.length > 0) return true;
    }
  }
  const type = typeof event.type === "string" ? event.type : "";
  if (
    type === "response.output_item.added" ||
    type === "response.output_item.done" ||
    type === "response.content_part.added" ||
    type === "response.content_part.done" ||
    type === "response.output_text.done" ||
    type === "response.function_call_arguments.delta" ||
    type === "response.function_call_arguments.done"
  ) return true;
  return responsesLiveDelta(event) !== null;
}


function pushSseLine(
  line: string,
  state: SseParseState,
  filter?: (event: Record<string, unknown>) => boolean,
): void {
  if (!line.startsWith("data:")) return;
  const payload = line.slice(5).trim();
  if (!payload) return;
  if (payload === "[DONE]") {
    state.terminalSeen = true;
    state.terminalAllowsUsage = false;
    state.terminalSummary = "[DONE]";
    return;
  }
  state.eventCount += 1;
  if (state.eventCount > MAX_SSE_EVENT_COUNT) {
    throw new Error(`provider SSE event count exceeds ${MAX_SSE_EVENT_COUNT}`);
  }
  const payloadBytes = sseUtf8Bytes(payload);
  if (payloadBytes > MAX_SSE_PAYLOAD_BYTES - state.payloadBytes) {
    throw new Error(`provider SSE payload bytes exceed ${MAX_SSE_PAYLOAD_BYTES}`);
  }
  state.payloadBytes += payloadBytes;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    throw new Error("provider SSE malformed JSON event");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("provider SSE event must be a JSON object");
  }
  const event = parsed as Record<string, unknown>;
  const usageTrailer = state.terminalSeen && state.terminalAllowsUsage && isSseUsageOnlyTrailer(event);
  if (state.terminalSeen && !usageTrailer && carriesLateStreamContent(event)) {
    throw new Error("provider SSE event arrived after terminal event");
  }
  if (usageTrailer) state.terminalAllowsUsage = false;
  if (isSseChoiceTerminal(event)) {
    state.terminalSeen = true;
    state.terminalAllowsUsage = true;
    state.terminalSummary = summarizeSseEvent(event);
  } else if (isSseTerminalEvent(event)) {
    state.terminalSeen = true;
    state.terminalAllowsUsage = false;
    state.terminalSummary = summarizeSseEvent(event);
  }
  if (!filter || filter(event)) state.events.push(event);
}


export async function readSseJson(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  filter?: (event: Record<string, unknown>) => boolean,
): Promise<Array<Record<string, unknown>>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bufferBytes = 0;
  const state: SseParseState = {
    events: [],
    eventCount: 0,
    payloadBytes: 0,
    terminalSeen: false,
    terminalAllowsUsage: false,
    terminalSummary: null,
  };
  try {
    for (;;) {
      if (signal?.aborted) {
        await reader.cancel();
        break;
      }
      const { done, value } = await reader.read();
      if (done) {
        const tail = decoder.decode();
        buffer += tail;
        bufferBytes += sseUtf8Bytes(tail);
        if (bufferBytes > MAX_SSE_BUFFER_BYTES) {
          throw new Error(`provider SSE decoded buffer exceeds ${MAX_SSE_BUFFER_BYTES} bytes`);
        }
        const parsed = takeSseEvents(buffer, bufferBytes, state, true, filter);
        buffer = parsed.buffer;
        bufferBytes = parsed.bytes;
        if (!signal?.aborted && !state.terminalSeen) {
          throw new Error("provider SSE ended before a terminal event");
        }
        break;
      }
      if (!(value instanceof Uint8Array)) throw new Error("provider SSE stream chunk is invalid");
      if (value.byteLength > MAX_SSE_BUFFER_BYTES) {
        throw new Error(`provider SSE stream chunk exceeds ${MAX_SSE_BUFFER_BYTES} bytes`);
      }
      const decoded = decoder.decode(value, { stream: true });
      buffer += decoded;
      bufferBytes += sseUtf8Bytes(decoded);
      if (bufferBytes > MAX_SSE_BUFFER_BYTES) {
        throw new Error(`provider SSE decoded buffer exceeds ${MAX_SSE_BUFFER_BYTES} bytes`);
      }
      const parsed = takeSseEvents(buffer, bufferBytes, state, false, filter);
      buffer = parsed.buffer;
      bufferBytes = parsed.bytes;
    }
    return state.events;
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      /* Preserve the original parser failure if cancellation also fails. */
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}
