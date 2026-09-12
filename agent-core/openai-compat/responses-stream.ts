/**
 * Responses streaming deltas and results.
 *
 * Owns live deltas, terminal results, and payload text. Split from
 * agent-core/openai-compat.ts (issue #38).
 */
import { TOOL_CALL_ARGUMENT_ERROR, TOOL_CALL_IDENTITY_ERROR, TOOL_CALL_INDEX_ERROR, decodeToolCallArguments, toolCallIdentityError, toolCallIndex } from "./tool-calls.ts";
import type { CallResultLike } from "./types.ts";
import { mergeUsageRecords, usageFromOpenAI } from "./usage.ts";


function deltaText(delta: unknown): string {
  if (typeof delta === "string") return delta;
  if (delta && typeof delta === "object" && !Array.isArray(delta)) {
    const rec = delta as { text?: unknown; delta?: unknown };
    if (typeof rec.text === "string") return rec.text;
    if (typeof rec.delta === "string") return rec.delta;
  }
  return "";
}


function errorFromEvent(ev: Record<string, unknown>): string | null {
  const type = typeof ev.type === "string" ? ev.type : "";
  if (type !== "response.failed" && type !== "error") return null;
  const err = ev.error;
  if (err && typeof err === "object" && !Array.isArray(err)) {
    const rec = err as { message?: unknown };
    if (typeof rec.message === "string" && rec.message) return rec.message;
  }
  const response = ev.response;
  if (response && typeof response === "object" && !Array.isArray(response)) {
    const nested = (response as { error?: { message?: unknown } }).error;
    if (nested && typeof nested.message === "string" && nested.message) return nested.message;
  }
  if (typeof ev.message === "string" && ev.message) return ev.message;
  return "provider error";
}


function reasoningSummaryText(item: { summary?: unknown }): string {
  if (!Array.isArray(item.summary)) return "";
  const parts: string[] = [];
  for (const row of item.summary) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const text = (row as { text?: unknown }).text;
    if (typeof text === "string" && text) parts.push(text);
  }
  return parts.join("\n\n");
}


export function responsesLiveDelta(
  event: Record<string, unknown>,
): { kind: "text" | "thinking"; text: string } | null {
  const type = event.type;
  if (type === "response.reasoning_summary_part.done") return { kind: "thinking", text: "\n\n" };
  const kind = type === "response.output_text.delta"
    ? "text"
    : type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta"
      ? "thinking"
      : null;
  if (!kind) return null;
  const text = deltaText(event.delta);
  return text ? { kind, text } : null;
}


export function responsesResultFromEvents(
  events: Array<Record<string, unknown>>,
  onText: (text: string) => void,
  started: number,
): CallResultLike {
  let text = "";
  type ResponseToolCall = {
    id: string;
    itemId: string;
    callId: string;
    name: string;
    args: string;
    outputIndex?: number;
  };
  const byKey = new Map<string, ResponseToolCall>();
  const byIndex = new Map<number, ResponseToolCall>();
  const order: ResponseToolCall[] = [];
  const reasoning = new Map<string, { id: string; thinking: string; signature?: string }>();
  const reasoningOrder: string[] = [];
  let usage: CallResultLike["usage"] = null;
  let rawUsage: Record<string, unknown> | undefined;
  let ttftMs: number | null = null;
  let stopReason: string | null = null;
  let error: string | undefined;
  let toolError: string | undefined;
  const toolProtocolError = (message: string): string => error ? `${message}; provider error: ${error}` : message;
  const optionalText = (value: unknown): string | undefined | null => {
    if (value === undefined) return undefined;
    return typeof value === "string" ? value : null;
  };
  const optionalIndex = (value: unknown): number | undefined | null => {
    if (value === undefined) return undefined;
    return toolCallIndex(value);
  };
  const conflict = (message: string): void => {
    toolError ??= `provider protocol error: ${message}`;
  };
  const bindKey = (key: string, call: ResponseToolCall): boolean => {
    if (!key) return true;
    const existing = byKey.get(key);
    if (existing && existing !== call) {
      conflict("conflicting tool call identity");
      return false;
    }
    byKey.set(key, call);
    return true;
  };
  const resolveCall = (
    callId: string,
    itemId: string,
    outputIndex: number | undefined,
  ): ResponseToolCall | null => {
    const matches = new Set<ResponseToolCall>();
    if (callId) {
      const call = byKey.get(callId);
      if (call) matches.add(call);
    }
    if (itemId) {
      const call = byKey.get(itemId);
      if (call) matches.add(call);
    }
    if (outputIndex !== undefined) {
      const call = byIndex.get(outputIndex);
      if (call) matches.add(call);
    }
    if (matches.size > 1) {
      conflict("tool call identity or output index changed");
      return null;
    }
    let call = matches.values().next().value as ResponseToolCall | undefined;
    if (!call) {
      if (!callId && !itemId) {
        toolError ??= TOOL_CALL_IDENTITY_ERROR;
        return null;
      }
      call = {
        id: callId || itemId,
        itemId,
        callId,
        name: "",
        args: "",
        ...(outputIndex === undefined ? {} : { outputIndex }),
      };
      order.push(call);
    }
    if (outputIndex !== undefined) {
      const existing = byIndex.get(outputIndex);
      if (existing && existing !== call) {
        conflict("tool call output index was reused");
        return null;
      }
      if (call.outputIndex !== undefined && call.outputIndex !== outputIndex) {
        conflict("tool call output index changed");
        return null;
      }
      call.outputIndex = outputIndex;
      byIndex.set(outputIndex, call);
    }
    if (itemId) {
      if (call.itemId && call.itemId !== itemId) {
        conflict("tool call item id changed");
        return null;
      }
      call.itemId = itemId;
      if (!bindKey(itemId, call)) return null;
    }
    if (callId) {
      if (call.callId && call.callId !== callId) {
        conflict("tool call id changed");
        return null;
      }
      call.callId = callId;
      call.id = callId;
      if (!bindKey(callId, call)) return null;
    }
    return call;
  };
  const takeFunctionCall = (item: Record<string, unknown>, outputIndex: number | undefined): void => {
    if (item.type !== "function_call") return;
    const itemId = optionalText(item.id);
    const callId = optionalText(item.call_id);
    const name = optionalText(item.name);
    const args = optionalText(item.arguments);
    if (itemId === null || callId === null) {
      toolError ??= TOOL_CALL_IDENTITY_ERROR;
      return;
    }
    if (name === null) {
      toolError ??= TOOL_CALL_IDENTITY_ERROR;
      return;
    }
    if (args === null) {
      toolError ??= TOOL_CALL_ARGUMENT_ERROR;
      return;
    }
    const call = resolveCall(callId ?? "", itemId ?? "", outputIndex);
    if (!call) return;
    if (name) {
      if (call.name && call.name !== name) {
        conflict("tool call name changed");
        return;
      }
      call.name = name;
    }
    if (args !== undefined) {
      if (!call.args) call.args = args;
      else if (args === call.args || call.args.startsWith(args)) {
        /* The stream already contains this complete or more granular prefix. */
      } else if (args.startsWith(call.args)) {
        call.args = args;
      } else {
        conflict("tool call arguments changed");
      }
    }
  };
  const takeReasoning = (item: {
    type?: string;
    id?: string;
    encrypted_content?: unknown;
    summary?: unknown;
  }): void => {
    if (item.type !== "reasoning") return;
    const id = String(item.id ?? "");
    if (!id && item.encrypted_content == null) return;
    const key = id || "__anon";
    const prev = reasoning.get(key) ?? { id, thinking: "" };
    const summary = reasoningSummaryText(item);
    if (summary) prev.thinking = summary;
    if (typeof item.encrypted_content === "string" && item.encrypted_content) prev.signature = item.encrypted_content;
    if (id) prev.id = id;
    if (!reasoning.has(key)) reasoningOrder.push(key);
    reasoning.set(key, prev);
  };
  for (const ev of events) {
    const failed = errorFromEvent(ev);
    if (failed) error = failed;
    const type = typeof ev.type === "string" ? ev.type : "";
    const live = responsesLiveDelta(ev);
    if (live?.kind === "text") {
      if (ttftMs === null) ttftMs = Date.now() - started;
      text += live.text;
      onText(live.text);
    }
    if (live?.kind === "thinking") {
      if (ttftMs === null) ttftMs = Date.now() - started;
      const id = typeof ev.item_id === "string" ? ev.item_id : "";
      const key = id || "__anon";
      const prev = reasoning.get(key) ?? { id, thinking: "" };
      prev.thinking += live.text;
      if (!reasoning.has(key)) reasoningOrder.push(key);
      reasoning.set(key, prev);
    }
    if (
      (type === "response.output_item.added" || type === "response.output_item.done") &&
      ev.item &&
      typeof ev.item === "object"
    ) {
      const item = ev.item as {
        type?: string;
        call_id?: string;
        id?: string;
        name?: string;
        arguments?: string;
        encrypted_content?: unknown;
        summary?: unknown;
      };
      takeReasoning(item);
      const outputIndex = optionalIndex(ev.output_index);
      if (outputIndex === null) {
        toolError ??= TOOL_CALL_INDEX_ERROR;
      } else {
        takeFunctionCall(item as Record<string, unknown>, outputIndex);
      }
    }
    if (type === "response.function_call_arguments.delta") {
      const callId = optionalText(ev.call_id);
      const itemId = optionalText(ev.item_id);
      const outputIndex = optionalIndex(ev.output_index);
      if (callId === null || itemId === null) {
        toolError ??= TOOL_CALL_IDENTITY_ERROR;
      } else if (outputIndex === null) {
        toolError ??= TOOL_CALL_INDEX_ERROR;
      } else if (typeof ev.delta !== "string") {
        toolError ??= TOOL_CALL_ARGUMENT_ERROR;
      } else {
        const call = resolveCall(callId ?? "", itemId ?? "", outputIndex);
        if (call) call.args += ev.delta;
      }
    }
    if (type === "response.completed" && ev.response && typeof ev.response === "object") {
      const response = ev.response as {
        usage?: Record<string, unknown>;
        status?: string;
        output?: Array<Record<string, unknown>>;
      };
      if (response.usage) {
        rawUsage = mergeUsageRecords(rawUsage, response.usage);
        usage = usageFromOpenAI(rawUsage);
      }
      if (typeof response.status === "string") stopReason = response.status === "completed" ? "stop" : response.status;
      for (const item of response.output ?? []) {
        if (!item || typeof item !== "object") continue;
        const rec = item as {
          type?: string;
          id?: string;
          call_id?: string;
          name?: string;
          arguments?: string;
          encrypted_content?: unknown;
          summary?: unknown;
        };
        takeReasoning(rec);
        takeFunctionCall(rec, undefined);
      }
    }
    if (typeof ev.usage === "object" && ev.usage && !Array.isArray(ev.usage)) {
      rawUsage = mergeUsageRecords(rawUsage, ev.usage as Record<string, unknown>);
      usage = usageFromOpenAI(rawUsage);
    }
  }
  const blocks: Array<Record<string, unknown>> = [];
  for (const key of reasoningOrder) {
    const rec = reasoning.get(key);
    if (!rec || (!rec.thinking && !rec.signature)) continue;
    blocks.push({
      type: "thinking",
      thinking: rec.thinking,
      ...(rec.signature ? { signature: rec.signature } : {}),
      ...(rec.id ? { id: rec.id } : {}),
    });
  }
  if (text) blocks.push({ type: "text", text });
  if (toolError) return { blocks, usage, ttftMs, stopReason, error: toolProtocolError(toolError) };
  const decoded: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  for (const call of order) {
    const identityError = toolCallIdentityError(call.id, call.name);
    if (identityError) return { blocks, usage, ttftMs, stopReason, error: toolProtocolError(identityError) };
    const args = decodeToolCallArguments(call.args, true);
    if ("error" in args) {
      return { blocks, usage, ttftMs, stopReason, error: toolProtocolError(args.error ?? TOOL_CALL_ARGUMENT_ERROR) };
    }
    decoded.push({ id: call.id, name: call.name, input: args.input });
  }
  blocks.push(...decoded.map((call) => ({ type: "tool_use", ...call })));
  return { blocks, usage, ttftMs, stopReason, error };
}


export function textFromResponsesPayload(data: unknown): { text: string; usage?: Record<string, unknown> } {
  if (!data || typeof data !== "object") return { text: "" };
  const rec = data as {
    output_text?: unknown;
    output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
    usage?: Record<string, unknown>;
  };
  if (typeof rec.output_text === "string" && rec.output_text.trim()) return { text: rec.output_text.trim(), usage: rec.usage };
  const parts: string[] = [];
  for (const item of rec.output ?? []) {
    if (!item || typeof item !== "object") continue;
    for (const c of item.content ?? []) {
      if (c && (c.type === "output_text" || c.type === "text") && typeof c.text === "string") parts.push(c.text);
    }
  }
  return { text: parts.join("").trim(), usage: rec.usage };
}
