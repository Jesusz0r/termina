/**
 * Chat Completions streaming deltas and results.
 *
 * Owns live deltas, terminal results, and payload text. Split from
 * agent-core/openai-compat.ts (issue #38).
 */
import { isRecord } from "../../shared/guards.ts";
import { TOOL_CALL_ARGUMENT_ERROR, TOOL_CALL_IDENTITY_ERROR, TOOL_CALL_INDEX_ERROR, TOOL_CALL_SHAPE_ERROR, decodeToolCallArguments, toolCallIdentityError, toolCallIndex } from "./tool-calls.ts";
import type { CallResultLike } from "./types.ts";
import { mergeUsageRecords, usageFromOpenAI } from "./usage.ts";


export function completionLiveDelta(
  event: Record<string, unknown>,
): { text: string; thinking: string } | null {
  const choices = event.choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return null;
  const delta = (choices[0] as { delta?: Record<string, unknown> }).delta;
  if (!delta) return null;
  let thinking = "";
  for (const field of ["reasoning_content", "reasoning", "reasoning_text"] as const) {
    const value = delta[field];
    if (typeof value === "string" && value) {
      thinking = value;
      break;
    }
  }
  const text = typeof delta.content === "string" ? delta.content : "";
  return text || thinking ? { text, thinking } : null;
}


export function completionResultFromEvents(
  events: Array<Record<string, unknown>>,
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
  for (const ev of events) {
    if (ev.usage && typeof ev.usage === "object" && !Array.isArray(ev.usage)) {
      rawUsage = mergeUsageRecords(rawUsage, ev.usage as Record<string, unknown>);
      usage = usageFromOpenAI(rawUsage);
    }
    const choices = ev.choices;
    if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") continue;
    const choice = choices[0] as { delta?: Record<string, unknown>; finish_reason?: unknown };
    if (typeof choice.finish_reason === "string") stopReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    const live = completionLiveDelta(ev);
    if (live?.text) {
      if (ttftMs === null) ttftMs = Date.now() - started;
      text += live.text;
      onText(live.text);
    }
    if (live?.thinking) {
      if (ttftMs === null) ttftMs = Date.now() - started;
      thinking += live.thinking;
    }
    const toolCalls = delta.tool_calls;
    if (toolCalls !== undefined && !Array.isArray(toolCalls)) toolError ??= TOOL_CALL_SHAPE_ERROR;
    if (Array.isArray(toolCalls)) {
      const indicesInEvent = new Set<number>();
      for (const raw of toolCalls) {
        if (!isRecord(raw)) {
          toolError ??= TOOL_CALL_SHAPE_ERROR;
          continue;
        }
        const tc = raw as { index?: unknown; id?: unknown; type?: unknown; function?: unknown; extra_content?: unknown };
        if (!("index" in tc)) {
          toolError ??= TOOL_CALL_INDEX_ERROR;
          continue;
        }
        const idx = toolCallIndex(tc.index);
        if (idx === null) {
          toolError ??= TOOL_CALL_INDEX_ERROR;
          continue;
        }
        if (indicesInEvent.has(idx)) {
          toolError ??= `${TOOL_CALL_INDEX_ERROR}: duplicate index in one delta`;
          continue;
        }
        indicesInEvent.add(idx);
        const cur = calls.get(idx);
        if (tc.type !== undefined && tc.type !== null && tc.type !== "function") {
          toolError ??= TOOL_CALL_SHAPE_ERROR;
          continue;
        }
        if (tc.type === null && (!cur || cur.type === undefined)) {
          toolError ??= TOOL_CALL_SHAPE_ERROR;
          continue;
        }
        if (tc.id !== undefined && tc.id !== null && typeof tc.id !== "string") {
          toolError ??= TOOL_CALL_IDENTITY_ERROR;
          continue;
        }
        if (tc.id === null && !cur) {
          toolError ??= TOOL_CALL_IDENTITY_ERROR;
          continue;
        }
        if (tc.function !== undefined && !isRecord(tc.function)) {
          toolError ??= TOOL_CALL_SHAPE_ERROR;
          continue;
        }
        const fn = isRecord(tc.function) ? tc.function : {};
        if (fn.name !== undefined && fn.name !== null && typeof fn.name !== "string") {
          toolError ??= TOOL_CALL_IDENTITY_ERROR;
          continue;
        }
        if (fn.name === null && (!cur || !cur.name)) {
          toolError ??= TOOL_CALL_IDENTITY_ERROR;
          continue;
        }
        if (fn.arguments !== undefined && typeof fn.arguments !== "string") {
          toolError ??= TOOL_CALL_ARGUMENT_ERROR;
          continue;
        }
        const id = typeof tc.id === "string" ? tc.id : "";
        const name = typeof fn.name === "string" ? fn.name : "";
        const type = tc.type === "function" ? tc.type : undefined;
        const args = typeof fn.arguments === "string" ? fn.arguments : "";
        const extra = isRecord(tc.extra_content) ? (tc.extra_content as Record<string, unknown>) : null;
        const googleExtra = extra && isRecord(extra.google) ? (extra.google as Record<string, unknown>) : null;
        const thoughtSignature =
          googleExtra && typeof googleExtra.thought_signature === "string" ? googleExtra.thought_signature : "";
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
  if (!data || typeof data !== "object") return { text: "" };
  const rec = data as { choices?: Array<{ message?: { content?: unknown } }>; usage?: Record<string, unknown> };
  const content = rec.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : "";
  return { text: text.trim(), usage: rec.usage };
}
