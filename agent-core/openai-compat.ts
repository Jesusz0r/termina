/**
 * OpenAI Chat Completions and Codex Responses conversion.
 *
 * The kernel stores Anthropic-shaped messages. This module is the only
 * translator for OpenAI Responses (openai, xai, github-copilot, openrouter,
 * openai-codex), Chat Completions (google login), and Google generateContent
 * (OpenCode Zen Gemini).
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
  if (Array.isArray(b.content)) {
    return b.content
      .map((c) => (typeof c === "string" ? c : typeof c === "object" && c && "text" in c ? String((c as { text: unknown }).text) : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (b.content != null) return JSON.stringify(b.content);
  return "";
}

export function toCompletionsMessages(system: string, messages: KernelMessage[]): CompletionMessage[] {
  const out: CompletionMessage[] = [];
  if (system) out.push({ role: "system", content: system });
  const openToolCalls: string[] = [];

  const flushOpenToolCalls = (): void => {
    while (openToolCalls.length > 0) {
      const toolCallId = openToolCalls.shift()!;
      out.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: "(interrupted)",
      });
    }
  };

  for (const m of messages) {
    if (typeof m.content === "string") {
      flushOpenToolCalls();
      out.push({ role: m.role as CompletionMessage["role"], content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      flushOpenToolCalls();
      let text = "";
      const toolCalls: NonNullable<CompletionMessage["tool_calls"]> = [];
      for (const b of m.content) {
        if (b.type === "text") text += blockText(b);
        if (b.type === "tool_use") {
          const id = String(b.id ?? "");
          if (!id) continue;
          openToolCalls.push(id);
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
        const callId = String(b.tool_use_id ?? b.toolUseId ?? b.call_id ?? b.id ?? "");
        if (!callId) continue;
        const at = openToolCalls.indexOf(callId);
        if (at >= 0) openToolCalls.splice(at, 1);
        out.push({
          role: "tool",
          tool_call_id: callId,
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
    flushOpenToolCalls();
    if (parts.some((p) => p.type === "image_url")) {
      out.push({ role: "user", content: parts });
    } else if (texts.length) {
      out.push({ role: "user", content: texts.join("\n") });
    }
  }
  return out;
}

/** Stamp the last input_text part. Assistant output_text is not a valid OpenAI breakpoint. */
export function markLastInputText(
  input: Array<Record<string, unknown>>,
  extra: Record<string, unknown>,
): Array<Record<string, unknown>> {
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i]!;
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const part = content[j] as Record<string, unknown>;
      if (!part || part.type !== "input_text" || typeof part.text !== "string") continue;
      const next = input.slice();
      const parts = content.slice() as Array<Record<string, unknown>>;
      parts[j] = { ...part, ...extra };
      next[i] = { ...item, content: parts };
      return next;
    }
  }
  return input;
}

/** Mark the last user input_text. Used before a volatile overlay. */
export function markResponsesPrefixBreakpoint(
  input: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return markLastInputText(input, { prompt_cache_breakpoint: { mode: "explicit" as const } });
}

function markPrefixThenTail(
  input: Array<Record<string, unknown>>,
  extra: Record<string, unknown>,
): Array<Record<string, unknown>> {
  if (input.length < 2) return input;
  return [...markLastInputText(input.slice(0, -1), extra), input[input.length - 1]!];
}

/** Strip prompt_cache_breakpoint and prompt_cache_options when a model rejects explicit caching. */
export function stripResponsesBreakpoints(body: Record<string, unknown>): Record<string, unknown> {
  const next = { ...body };
  delete next.prompt_cache_options;
  if (Array.isArray(next.input)) {
    next.input = next.input.map((item) => {
      if (!item || typeof item !== "object" || !Array.isArray((item as Record<string, unknown>).content)) return item;
      const rec = item as Record<string, unknown>;
      return {
        ...rec,
        content: (rec.content as Array<Record<string, unknown>>).map((part) => {
          if (!part || typeof part !== "object" || !("prompt_cache_breakpoint" in part)) return part;
          const { prompt_cache_breakpoint: _, ...rest } = part;
          return rest;
        }),
      };
    });
  }
  return next;
}

export function toResponsesInput(messages: KernelMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const openCalls: string[] = [];

  const flushOpenCalls = (): void => {
    while (openCalls.length > 0) {
      const callId = openCalls.shift()!;
      out.push({
        type: "function_call_output",
        call_id: callId,
        output: "(interrupted)",
      });
    }
  };

  for (const m of messages) {
    if (typeof m.content === "string") {
      flushOpenCalls();
      out.push({ role: m.role, content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }] });
      continue;
    }
    if (m.role === "assistant") {
      flushOpenCalls();
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
          const thinking = typeof b.thinking === "string" ? b.thinking : "";
          const item: Record<string, unknown> = {
            type: "reasoning",
            encrypted_content: sig,
            summary: thinking ? [{ type: "summary_text", text: thinking }] : [],
          };
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
          openCalls.push(callId);
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
        const callId = String(b.tool_use_id ?? b.toolUseId ?? b.call_id ?? b.id ?? "");
        if (!callId) continue;
        const at = openCalls.indexOf(callId);
        if (at >= 0) openCalls.splice(at, 1);
        out.push({
          type: "function_call_output",
          call_id: callId,
          output: blockText(b),
        });
      } else if (b.type === "text") {
        parts.push({ type: "input_text", text: blockText(b) });
      } else if (b.type === "image") {
        const url = imageDataUrl(b);
        if (url) parts.push({ type: "input_image", image_url: url });
      }
    }
    flushOpenCalls();
    if (parts.length) {
      out.push({ role: "user", content: parts });
    }
  }
  return out;
}

export type CompletionsOpts = {
  cacheKey?: string;
  sessionId?: string;
  cacheControl?: boolean;
  explicitCacheBreakpoint?: boolean;
  maxTokens?: number;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  reasoningContext?: "all_turns" | "current_turn";
  textVerbosity?: "low" | "medium" | "high";
  googleThinking?: boolean;
  includeEncryptedReasoning?: boolean;
  promptCacheMode?: "implicit" | "explicit";
  explicitCacheSkipTail?: boolean;
};

function applyCacheOpts(body: Record<string, unknown>, opts?: CompletionsOpts): void {
  if (opts?.cacheKey) body.prompt_cache_key = opts.cacheKey;
  if (opts?.sessionId) body.session_id = opts.sessionId;
}

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
  applyCacheOpts(body, opts);
  if (opts?.googleThinking && opts.reasoningEffort && opts.reasoningEffort !== "none") {
    body.extra_body = {
      google: {
        thinking_config: {
          thinking_level: opts.reasoningEffort,
          include_thoughts: true,
        },
      },
    };
  } else if (opts?.reasoningEffort) {
    body.reasoning_effort = opts.reasoningEffort;
  }
  return body;
}

function pushGoogleContent(
  out: Array<Record<string, unknown>>,
  role: "user" | "model",
  parts: Array<Record<string, unknown>>,
): void {
  if (!parts.length) return;
  const last = out[out.length - 1];
  if (last && last.role === role && Array.isArray(last.parts)) {
    last.parts = [...last.parts, ...parts];
    return;
  }
  out.push({ role, parts });
}

function toGoogleContents(messages: KernelMessage[]): Array<Record<string, unknown>> {
  const names = new Map<string, string>();
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      if (m.content) {
        pushGoogleContent(out, m.role === "assistant" ? "model" : "user", [{ text: m.content }]);
      }
      continue;
    }
    if (m.role === "assistant") {
      const parts: Array<Record<string, unknown>> = [];
      for (const b of m.content) {
        if (b.type === "thinking") {
          // Gemini 3 rejects replayed thought parts without a thoughtSignature.
          const sig = typeof b.signature === "string" ? b.signature : "";
          if (!sig) continue;
          const text = typeof b.thinking === "string" ? b.thinking : "";
          parts.push({ text, thought: true, thoughtSignature: sig });
          continue;
        }
        if (b.type === "text") {
          const text = blockText(b);
          if (text) parts.push({ text });
          continue;
        }
        if (b.type === "tool_use") {
          const id = String(b.id ?? "");
          const name = String(b.name ?? "");
          if (id && name) names.set(id, name);
          if (!name) continue;
          parts.push({
            functionCall: { name, args: b.input && typeof b.input === "object" && !Array.isArray(b.input) ? b.input : {} },
          });
        }
      }
      pushGoogleContent(out, "model", parts);
      continue;
    }
    const parts: Array<Record<string, unknown>> = [];
    for (const b of m.content) {
      if (b.type === "tool_result") {
        const id = String(b.tool_use_id ?? "");
        const name = names.get(id);
        if (!name) continue;
        parts.push({
          functionResponse: {
            name,
            response: { output: blockText(b) },
          },
        });
      } else if (b.type === "text") {
        const text = blockText(b);
        if (text) parts.push({ text });
      } else if (b.type === "image") {
        const url = imageDataUrl(b);
        const match = url?.match(/^data:([^;]+);base64,(.+)$/);
        if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
      }
    }
    pushGoogleContent(out, "user", parts);
  }
  return out;
}

/** Zen Gemini generateContent. Model id lives in the URL, not the body. */
export function googleGenerateBody(
  system: string,
  messages: KernelMessage[],
  tools: ToolDef[],
  opts?: CompletionsOpts,
): Record<string, unknown> {
  const body: Record<string, unknown> = { contents: toGoogleContents(messages) };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools.length) {
    body.tools = [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        })),
      },
    ];
  }
  const gen: Record<string, unknown> = {};
  if (opts?.maxTokens !== undefined) gen.maxOutputTokens = Math.min(opts.maxTokens, 65_536);
  if (opts?.googleThinking && opts.reasoningEffort && opts.reasoningEffort !== "none") {
    gen.thinkingConfig = { thinkingLevel: opts.reasoningEffort, includeThoughts: true };
  }
  if (Object.keys(gen).length) body.generationConfig = gen;
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
  applyCacheOpts(body, opts);
  if (opts?.promptCacheMode === "explicit") {
    body.prompt_cache_options = { mode: "explicit", ttl: "30m" };
  }
  const input = body.input as Array<Record<string, unknown>>;
  if (opts?.explicitCacheBreakpoint) {
    const extra = { prompt_cache_breakpoint: { mode: "explicit" as const } };
    body.input =
      opts.explicitCacheSkipTail === false ? markLastInputText(input, extra) : markPrefixThenTail(input, extra);
  } else if (opts?.cacheControl) {
    // OpenRouter converts a block cache_control onto Anthropic. Do not put
    // cache_control on the Responses root: that field is a chat-completions shape.
    body.input = markPrefixThenTail(input, { cache_control: { type: "ephemeral" as const } });
  }
  if (opts?.reasoningEffort || opts?.reasoningContext) {
    body.reasoning = {
      ...(opts.reasoningEffort ? { effort: opts.reasoningEffort, summary: "auto" } : {}),
      ...(opts.reasoningContext ? { context: opts.reasoningContext } : {}),
    };
  }
  if (opts?.textVerbosity) body.text = { verbosity: opts.textVerbosity };
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
  if (thinking) blocks.push({ type: "thinking", thinking });
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

function usageFromGoogle(u: Record<string, unknown> | undefined): CallResultLike["usage"] {
  if (!u) return null;
  const prompt = Number(u.promptTokenCount ?? 0) || 0;
  const output = Number(u.candidatesTokenCount ?? 0) || 0;
  const cached = Number(u.cachedContentTokenCount ?? 0) || 0;
  return {
    input: Math.max(0, prompt - cached),
    cacheRead: cached,
    cacheWrite: 0,
    output,
  };
}

function googleParts(event: Record<string, unknown>): Array<Record<string, unknown>> {
  const candidates = event.candidates;
  if (!Array.isArray(candidates) || !candidates[0] || typeof candidates[0] !== "object") return [];
  const content = (candidates[0] as { content?: { parts?: unknown } }).content;
  const parts = content && typeof content === "object" ? content.parts : undefined;
  return Array.isArray(parts) ? (parts.filter((p) => p && typeof p === "object") as Array<Record<string, unknown>>) : [];
}

export function googleLiveDelta(
  event: Record<string, unknown>,
): { text: string; thinking: string } | null {
  let text = "";
  let thinking = "";
  for (const part of googleParts(event)) {
    const value = typeof part.text === "string" ? part.text : "";
    if (!value) continue;
    if (part.thought === true) thinking += value;
    else text += value;
  }
  return text || thinking ? { text, thinking } : null;
}

export function googleResultFromEvents(
  events: Array<Record<string, unknown>>,
  _onText: (text: string) => void,
  started: number,
): CallResultLike {
  let text = "";
  const thoughts: Array<{ thinking: string; signature: string }> = [];
  const thoughtKeys = new Set<string>();
  const calls: Array<{ id: string; name: string; args: string }> = [];
  const callKeys = new Set<string>();
  let usage: CallResultLike["usage"] = null;
  let ttftMs: number | null = null;
  let stopReason: string | null = null;
  for (const ev of events) {
    if (ev.usageMetadata && typeof ev.usageMetadata === "object") {
      usage = usageFromGoogle(ev.usageMetadata as Record<string, unknown>);
    }
    const candidates = ev.candidates;
    if (Array.isArray(candidates) && candidates[0] && typeof candidates[0] === "object") {
      const finish = (candidates[0] as { finishReason?: unknown }).finishReason;
      if (typeof finish === "string") stopReason = finish;
    }
    const live = googleLiveDelta(ev);
    if (live?.text) {
      if (ttftMs === null) ttftMs = Date.now() - started;
      text += live.text;
    }
    if (live?.thinking && ttftMs === null) ttftMs = Date.now() - started;
    for (const part of googleParts(ev)) {
      if (part.thought === true) {
        const signature = typeof part.thoughtSignature === "string" ? part.thoughtSignature : "";
        const thinking = typeof part.text === "string" ? part.text : "";
        if (!signature) continue;
        if (thoughtKeys.has(signature)) continue;
        thoughtKeys.add(signature);
        thoughts.push({ thinking, signature });
        continue;
      }
      const call = part.functionCall;
      if (!call || typeof call !== "object") continue;
      const fn = call as { name?: unknown; args?: unknown };
      const name = typeof fn.name === "string" ? fn.name : "";
      if (!name) continue;
      const args = JSON.stringify(fn.args ?? {});
      const key = `${name}:${args}`;
      if (callKeys.has(key)) continue;
      callKeys.add(key);
      calls.push({ id: `call_${calls.length + 1}`, name, args });
    }
  }
  const blocks: Array<Record<string, unknown>> = [];
  for (const thought of thoughts) {
    blocks.push({ type: "thinking", thinking: thought.thinking, signature: thought.signature });
  }
  if (text) blocks.push({ type: "text", text });
  for (const call of calls) {
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

export function textFromGooglePayload(data: unknown): { text: string; usage: CallResultLike["usage"] } {
  const rec = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const parts = googleParts(rec);
  const text = parts
    .filter((p) => p.thought !== true && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("")
    .trim();
  const usage = rec.usageMetadata && typeof rec.usageMetadata === "object"
    ? usageFromGoogle(rec.usageMetadata as Record<string, unknown>)
    : null;
  return { text, usage };
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
    const realCallId = typeof item.call_id === "string" && item.call_id ? item.call_id : "";
    const id = realCallId || String(item.id ?? "");
    if (!id) return;
    let call = (realCallId ? byKey.get(realCallId) : undefined) || (item.id ? byKey.get(item.id) : undefined) || byKey.get(id);
    if (!call) {
      call = { id, name: String(item.name ?? ""), args: typeof item.arguments === "string" ? item.arguments : "" };
      order.push(call);
      if (realCallId) byKey.set(realCallId, call);
      if (item.id) byKey.set(item.id, call);
      if (!byKey.has(id)) byKey.set(id, call);
      return;
    }
    if (realCallId && call.id !== realCallId) {
      call.id = realCallId;
      byKey.set(realCallId, call);
    }
    if (item.id && !byKey.has(item.id)) byKey.set(item.id, call);
    if (item.name) call.name = String(item.name);
    if (typeof item.arguments === "string" && item.arguments.length >= call.args.length) call.args = item.arguments;
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
      takeFunctionCall(item);
    }
    if (type === "response.function_call_arguments.delta") {
      let call = lookup(ev);
      const callId = typeof ev.call_id === "string" && ev.call_id ? ev.call_id : "";
      const itemId = typeof ev.item_id === "string" && ev.item_id ? ev.item_id : "";
      if (!call) {
        const id = callId || itemId || "";
        call = { id, name: "", args: "" };
        order.push(call);
        if (callId) byKey.set(callId, call);
        if (itemId) byKey.set(itemId, call);
      } else {
        if (callId && call.id !== callId) {
          call.id = callId;
          byKey.set(callId, call);
        }
        if (itemId && !byKey.has(itemId)) byKey.set(itemId, call);
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
