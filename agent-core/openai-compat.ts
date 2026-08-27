/**
 * OpenAI Chat Completions and Codex Responses conversion.
 *
 * The kernel stores Anthropic-shaped messages. This module is the only
 * translator for OpenAI Responses (openai, xai, github-copilot, openrouter,
 * openai-codex) and Chat Completions (google).
 */

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type KernelMessage = {
  role: "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
};

const MAX_SSE_BUFFER_CHARS = 8 * 1024 * 1024;

export type CallResultLike = {
  blocks: Array<Record<string, unknown>>;
  usage: { input: number; cacheRead: number; cacheWrite: number; output: number } | null;
  ttftMs: number | null;
  stopReason: string | null;
  error?: string;
};

type CompletionMessage = {
  role: string;
  content?: string | null | Array<Record<string, unknown>>;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

function imageDataUrl(b: Record<string, unknown>): string | null {
  const source = b.source;
  if (!source || typeof source !== "object") return null;
  const src = source as { type?: unknown; media_type?: unknown; data?: unknown };
  if (src.type !== "base64" || typeof src.media_type !== "string" || typeof src.data !== "string" || !src.data) return null;
  return `data:${src.media_type};base64,${src.data}`;
}

export function toCompletionsTools(tools: ToolDef[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

export function toResponsesTools(tools: ToolDef[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
    strict: false,
  }));
}

function blockText(b: Record<string, unknown>): string {
  if (typeof b.text === "string") return b.text;
  if (typeof b.content === "string") return b.content;
  if (b.content != null) return JSON.stringify(b.content);
  return "";
}

export function toCompletionsMessages(system: string, messages: KernelMessage[]): CompletionMessage[] {
  const out: CompletionMessage[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      let text = "";
      const toolCalls: NonNullable<CompletionMessage["tool_calls"]> = [];
      for (const b of m.content) {
        if (b.type === "text") text += blockText(b);
        if (b.type === "tool_use") {
          const id = String(b.id ?? "");
          if (!id) continue;
          toolCalls.push({
            id,
            type: "function",
            function: { name: String(b.name ?? ""), arguments: JSON.stringify(b.input ?? {}) },
          });
        }
      }
      const msg: CompletionMessage = { role: "assistant", content: text || (toolCalls.length ? null : "") };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
      continue;
    }
    const texts: string[] = [];
    const parts: Array<Record<string, unknown>> = [];
    for (const b of m.content) {
      if (b.type === "tool_result") {
        out.push({
          role: "tool",
          tool_call_id: String(b.tool_use_id ?? ""),
          content: blockText(b),
        });
      } else if (b.type === "text") {
        const text = blockText(b);
        texts.push(text);
        parts.push({ type: "text", text });
      } else if (b.type === "image") {
        const url = imageDataUrl(b);
        if (url) parts.push({ type: "image_url", image_url: { url } });
      }
    }
    if (parts.some((p) => p.type === "image_url")) out.push({ role: "user", content: parts });
    else if (texts.length) out.push({ role: "user", content: texts.join("\n") });
  }
  return out;
}

export function toResponsesInput(messages: KernelMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }] });
      continue;
    }
    if (m.role === "assistant") {
      let text = "";
      const flushText = (): void => {
        if (!text) return;
        out.push({ role: "assistant", content: [{ type: "output_text", text }] });
        text = "";
      };
      for (const b of m.content) {
        if (b.type === "thinking") {
          flushText();
          const id = typeof b.id === "string" ? b.id : "";
          const sig = typeof b.signature === "string" ? b.signature : "";
          if (!sig) continue;
          const item: Record<string, unknown> = { type: "reasoning", encrypted_content: sig };
          if (id) item.id = id;
          out.push(item);
          continue;
        }
        if (b.type === "text") {
          text += blockText(b);
          continue;
        }
        if (b.type === "tool_use") {
          flushText();
          const callId = String(b.id ?? "");
          if (!callId) continue;
          out.push({
            type: "function_call",
            call_id: callId,
            name: String(b.name ?? ""),
            arguments: JSON.stringify(b.input ?? {}),
          });
        }
      }
      flushText();
      continue;
    }
    const parts: Array<Record<string, unknown>> = [];
    for (const b of m.content) {
      if (b.type === "tool_result") {
        out.push({
          type: "function_call_output",
          call_id: String(b.tool_use_id ?? ""),
          output: blockText(b),
        });
      } else if (b.type === "text") {
        parts.push({ type: "input_text", text: blockText(b) });
      } else if (b.type === "image") {
        const url = imageDataUrl(b);
        if (url) parts.push({ type: "input_image", image_url: url });
      }
    }
    if (parts.length) out.push({ role: "user", content: parts });
  }
  return out;
}

export type CompletionsOpts = {
  cacheKey?: string;
  maxTokens?: number;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  includeEncryptedReasoning?: boolean;
};

export function completionsBody(
  model: string,
  system: string,
  messages: KernelMessage[],
  tools: ToolDef[],
  limitKey: "max_tokens" | "max_completion_tokens" = "max_tokens",
  opts?: CompletionsOpts,
): Record<string, unknown> {
  const maxTokens = opts?.maxTokens ?? 16_384;
  const body: Record<string, unknown> = {
    model,
    stream: true,
    stream_options: { include_usage: true },
    [limitKey]: maxTokens,
    messages: toCompletionsMessages(system, messages),
    tools: toCompletionsTools(tools),
  };
  if (opts?.cacheKey) body.prompt_cache_key = opts.cacheKey;
  return body;
}

export function responsesBody(
  model: string,
  system: string,
  messages: KernelMessage[],
  tools: ToolDef[],
  opts?: CompletionsOpts,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    store: false,
    stream: true,
    instructions: system || "You are a coding agent.",
    input: toResponsesInput(messages),
    tools: toResponsesTools(tools),
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
  if (opts?.maxTokens !== undefined) body.max_output_tokens = opts.maxTokens;
  if (opts?.includeEncryptedReasoning !== false) body.include = ["reasoning.encrypted_content"];
  if (opts?.cacheKey) body.prompt_cache_key = opts.cacheKey;
  if (opts?.reasoningEffort) body.reasoning = { effort: opts.reasoningEffort };
  return body;
}

function usageFromOpenAI(u: Record<string, unknown> | undefined): CallResultLike["usage"] {
  if (!u) return null;
  const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
  const output = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
  const details = (u.prompt_tokens_details ?? u.input_tokens_details ?? {}) as Record<string, unknown>;
  const cached = Number(details.cached_tokens ?? 0) || 0;
  return {
    input: Math.max(0, prompt - cached),
    cacheRead: cached,
    cacheWrite: 0,
    output,
  };
}

export function completionResultFromEvents(
  events: Array<Record<string, unknown>>,
  onText: (text: string) => void,
  started: number,
): CallResultLike {
  let text = "";
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let usage: CallResultLike["usage"] = null;
  let ttftMs: number | null = null;
  let stopReason: string | null = null;
  for (const ev of events) {
    if (ev.usage && typeof ev.usage === "object") usage = usageFromOpenAI(ev.usage as Record<string, unknown>);
    const choices = ev.choices;
    if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") continue;
    const choice = choices[0] as { delta?: Record<string, unknown>; finish_reason?: unknown };
    if (typeof choice.finish_reason === "string") stopReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      if (ttftMs === null) ttftMs = Date.now() - started;
      text += delta.content;
      onText(delta.content);
    }
    const toolCalls = delta.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const raw of toolCalls) {
        if (!raw || typeof raw !== "object") continue;
        const tc = raw as { index?: number; id?: string; function?: { name?: string; arguments?: string } };
        const idx = typeof tc.index === "number" ? tc.index : 0;
        const cur = calls.get(idx) ?? { id: "", name: "", args: "" };
        if (typeof tc.id === "string" && tc.id) cur.id = tc.id;
        if (typeof tc.function?.name === "string" && tc.function.name) cur.name = tc.function.name;
        if (typeof tc.function?.arguments === "string") cur.args += tc.function.arguments;
        calls.set(idx, cur);
      }
    }
  }
  const blocks: Array<Record<string, unknown>> = [];
  if (text) blocks.push({ type: "text", text });
  const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, call] of ordered) {
    let input: unknown = {};
    try {
      input = JSON.parse(call.args || "{}");
    } catch {
      input = {};
    }
    blocks.push({ type: "tool_use", id: call.id, name: call.name, input });
  }
  return { blocks, usage, ttftMs, stopReason };
}

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
  return parts.join("");
}

export function responsesResultFromEvents(
  events: Array<Record<string, unknown>>,
  onText: (text: string) => void,
  started: number,
): CallResultLike {
  let text = "";
  const byKey = new Map<string, { id: string; name: string; args: string }>();
  const order: Array<{ id: string; name: string; args: string }> = [];
  const reasoning = new Map<string, { id: string; thinking: string; signature?: string }>();
  const reasoningOrder: string[] = [];
  let usage: CallResultLike["usage"] = null;
  let ttftMs: number | null = null;
  let stopReason: string | null = null;
  let error: string | undefined;
  const lookup = (ev: Record<string, unknown>): { id: string; name: string; args: string } | undefined => {
    const callId = typeof ev.call_id === "string" ? ev.call_id : "";
    const itemId = typeof ev.item_id === "string" ? ev.item_id : "";
    return (callId && byKey.get(callId)) || (itemId && byKey.get(itemId)) || undefined;
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
  const takeFunctionCall = (item: {
    type?: string;
    call_id?: string;
    id?: string;
    name?: string;
    arguments?: string;
  }): void => {
    if (item.type !== "function_call") return;
    const id = String(item.call_id ?? item.id ?? "");
    if (!id) return;
    let call = (item.call_id ? byKey.get(item.call_id) : undefined) || (item.id ? byKey.get(item.id) : undefined) || byKey.get(id);
    if (!call) {
      call = { id, name: String(item.name ?? ""), args: typeof item.arguments === "string" ? item.arguments : "" };
      order.push(call);
      if (item.call_id) byKey.set(item.call_id, call);
      if (item.id) byKey.set(item.id, call);
      if (!byKey.has(id)) byKey.set(id, call);
      return;
    }
    if (item.name) call.name = String(item.name);
    if (typeof item.arguments === "string" && item.arguments.length >= call.args.length) call.args = item.arguments;
  };
  for (const ev of events) {
    const failed = errorFromEvent(ev);
    if (failed) error = failed;
    const type = typeof ev.type === "string" ? ev.type : "";
    const chunk = type === "response.output_text.delta" ? deltaText(ev.delta) : "";
    if (chunk) {
      if (ttftMs === null) ttftMs = Date.now() - started;
      text += chunk;
      onText(chunk);
    }
    if (type === "response.reasoning_summary_text.delta") {
      const id = typeof ev.item_id === "string" ? ev.item_id : "";
      const key = id || "__anon";
      const prev = reasoning.get(key) ?? { id, thinking: "" };
      prev.thinking += deltaText(ev.delta);
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
      takeFunctionCall(item);
    }
    if (type === "response.function_call_arguments.delta") {
      let call = lookup(ev);
      if (!call) {
        const id = String(ev.call_id ?? ev.item_id ?? "");
        call = { id, name: "", args: "" };
        order.push(call);
        if (typeof ev.call_id === "string") byKey.set(ev.call_id, call);
        if (typeof ev.item_id === "string") byKey.set(ev.item_id, call);
      }
      call.args += deltaText(ev.delta);
    }
    if (type === "response.completed" && ev.response && typeof ev.response === "object") {
      const response = ev.response as {
        usage?: Record<string, unknown>;
        status?: string;
        output?: Array<Record<string, unknown>>;
      };
      usage = usageFromOpenAI(response.usage);
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
        takeFunctionCall(rec);
      }
    }
    if (typeof ev.usage === "object" && ev.usage) usage = usageFromOpenAI(ev.usage as Record<string, unknown>);
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
  const seen = new Set<{ id: string; name: string; args: string }>();
  for (const call of order) {
    if (seen.has(call)) continue;
    seen.add(call);
    let input: unknown = {};
    try {
      input = JSON.parse(call.args || "{}");
    } catch {
      input = {};
    }
    blocks.push({ type: "tool_use", id: call.id, name: call.name, input });
  }
  return { blocks, usage, ttftMs, stopReason, error };
}

export function textFromCompletionPayload(data: unknown): { text: string; usage?: Record<string, number> } {
  if (!data || typeof data !== "object") return { text: "" };
  const rec = data as { choices?: Array<{ message?: { content?: unknown } }>; usage?: Record<string, number> };
  const content = rec.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : "";
  return { text: text.trim(), usage: rec.usage };
}

export function textFromResponsesPayload(data: unknown): { text: string; usage?: Record<string, number> } {
  if (!data || typeof data !== "object") return { text: "" };
  const rec = data as {
    output_text?: unknown;
    output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
    usage?: Record<string, number>;
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

function takeSseEvents(
  buffer: string,
  events: Array<Record<string, unknown>>,
  flush: boolean,
  filter?: (event: Record<string, unknown>) => boolean,
): string {
  let nl: number;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    pushSseLine(line, events, filter);
  }
  if (flush) {
    pushSseLine(buffer.trim(), events, filter);
    return "";
  }
  return buffer;
}

function pushSseLine(
  line: string,
  events: Array<Record<string, unknown>>,
  filter?: (event: Record<string, unknown>) => boolean,
): void {
  if (!line.startsWith("data:")) return;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return;
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const event = parsed as Record<string, unknown>;
    if (!filter || filter(event)) events.push(event);
  } catch {
    /* ignore truncated JSON */
  }
}

export async function readSseJson(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  filter?: (event: Record<string, unknown>) => boolean,
): Promise<Array<Record<string, unknown>>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Array<Record<string, unknown>> = [];
  try {
    for (;;) {
      if (signal?.aborted) {
        await reader.cancel();
        break;
      }
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        takeSseEvents(buffer, events, true, filter);
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_SSE_BUFFER_CHARS) throw new Error("provider stream line is too large");
      buffer = takeSseEvents(buffer, events, false, filter);
    }
    return events;
  } finally {
    reader.releaseLock();
  }
}
