/**
 * Chat Completions streaming deltas and results.
 *
 * Owns live deltas, terminal results, and payload text. Split from
 * agent-core/openai-compat.ts (issue #38).
 */
import { TOOL_CALL_IDENTITY_ERROR, TOOL_CALL_INDEX_ERROR, TOOL_CALL_SHAPE_ERROR, toolCallIdentityError } from "./tool-calls.ts";
import { decodeToolCallArguments, parseCompletionStreamEvent, parseCompletionTextPayload } from "./parsers.ts";
import type { CallResultLike } from "./types.ts";
import { mergeUsageRecords, usageFromOpenAI } from "./usage.ts";


export function completionLiveDelta(
  event: unknown,
): { text: string; thinking: string } | null {
  const { text, thinking } = parseCompletionStreamEvent(event);
  return text || thinking ? { text, thinking } : null;
}


export function completionResultFromEvents(
  events: readonly unknown[],
  onText: (text: string) => void,
  started: number,
): CallResultLike {
  let text = "";
  let thinking = "";
  const calls = new Map<number, { id: string; name: string; type?: "function"; args: string; thoughtSignature?: string }>();
  const indicesById = new Map<string, number>();
  let usage: CallResultLike["usage"] = null;
  let rawUsage: Record<string, unknown> | undefined;
  let ttftMs: number | null = null;
  let stopReason: string | null = null;
  let toolError: string | undefined;
  for (const raw of events) {
    const ev = parseCompletionStreamEvent(raw);
    if (ev.usage) {
      rawUsage = mergeUsageRecords(rawUsage, ev.usage);
      usage = usageFromOpenAI(rawUsage);
    }
    if (ev.finishReason) stopReason = ev.finishReason;
    const live = ev;
    if (live?.text) {
      if (ttftMs === null) ttftMs = Date.now() - started;
      text += live.text;
      onText(live.text);
    }
    if (live?.thinking) {
      if (ttftMs === null) ttftMs = Date.now() - started;
      thinking += live.thinking;
    }
    const toolCalls = ev.toolCalls;
    if (toolCalls.length) {
      const indicesInEvent = new Set<number>();
      for (const tc of toolCalls) {
        if ("error" in tc) {
          toolError ??= tc.error;
          continue;
        }
        const idx = tc.index;
        if (indicesInEvent.has(idx)) {
          toolError ??= `${TOOL_CALL_INDEX_ERROR}: duplicate index in one delta`;
          continue;
        }
        indicesInEvent.add(idx);
        const cur = calls.get(idx);
        if (tc.type === null && (!cur || cur.type === undefined)) {
          toolError ??= TOOL_CALL_SHAPE_ERROR;
          continue;
        }
        if (tc.id === null && !cur) {
          toolError ??= TOOL_CALL_IDENTITY_ERROR;
          continue;
        }
        if (tc.name === null && (!cur || !cur.name)) {
          toolError ??= TOOL_CALL_IDENTITY_ERROR;
          continue;
        }
        const id = tc.id ?? "";
        const name = tc.name ?? "";
        const type = tc.type ?? undefined;
        const { args, thoughtSignature } = tc;
        if (!cur) {
          if (!id || !name) {
            toolError ??= TOOL_CALL_IDENTITY_ERROR;
            continue;
          }
          const priorIndex = indicesById.get(id);
          if (priorIndex !== undefined && priorIndex !== idx) {
            toolError ??= `${TOOL_CALL_IDENTITY_ERROR}: call id changed index`;
            continue;
          }
          calls.set(idx, { id, name, ...(type ? { type } : {}), args, ...(thoughtSignature ? { thoughtSignature } : {}) });
          indicesById.set(id, idx);
          continue;
        }
        if ((id && id !== cur.id) || (name && name !== cur.name)) {
          toolError ??= `${TOOL_CALL_IDENTITY_ERROR}: call identity changed`;
          continue;
        }
        if (thoughtSignature && cur.thoughtSignature && cur.thoughtSignature !== thoughtSignature) {
          toolError ??= `${TOOL_CALL_IDENTITY_ERROR}: call signature changed`;
          continue;
        }
        if (thoughtSignature) cur.thoughtSignature = thoughtSignature;
        if (type && cur.type && type !== cur.type) {
          toolError ??= `${TOOL_CALL_SHAPE_ERROR}: call type changed`;
          continue;
        }
        if (type) cur.type = type;
        if (id) {
          const priorIndex = indicesById.get(id);
          if (priorIndex !== undefined && priorIndex !== idx) {
            toolError ??= `${TOOL_CALL_IDENTITY_ERROR}: call id changed index`;
            continue;
          }
          indicesById.set(id, idx);
        }
        cur.args += args;
      }
    }
  }
  const blocks: Array<Record<string, unknown>> = [];
  if (thinking) blocks.push({ type: "thinking", thinking });
  if (text) blocks.push({ type: "text", text });
  if (toolError) return { blocks, usage, ttftMs, stopReason, error: toolError };
  const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]);
  const decoded: Array<{ id: string; name: string; input: Record<string, unknown>; thoughtSignature?: string }> = [];
  for (const [, call] of ordered) {
    const identityError = toolCallIdentityError(call.id, call.name);
    if (identityError) return { blocks, usage, ttftMs, stopReason, error: identityError };
    const args = decodeToolCallArguments(call.args, true);
    if ("error" in args) return { blocks, usage, ttftMs, stopReason, error: args.error };
    decoded.push({
      id: call.id,
      name: call.name,
      input: args.input,
      ...(call.thoughtSignature ? { thought_signature: call.thoughtSignature } : {}),
    });
  }
  blocks.push(...decoded.map((call) => ({ type: "tool_use", ...call })));
  return { blocks, usage, ttftMs, stopReason };
}


export function textFromCompletionPayload(data: unknown): { text: string; usage?: Record<string, unknown> } {
  return parseCompletionTextPayload(data);
}
