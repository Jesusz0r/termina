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

export type ProviderUsage = {
  /** Uncached input tokens. `null` means the provider did not report enough data. */
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  reasoning: number | null;
};

/** Maximum unconsumed decoded SSE text retained between line boundaries. */
export const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;
/** Protect the caller's event array from an endless stream of tiny events. */
export const MAX_SSE_EVENT_COUNT = 32_768;
/** Bound parsed JSON retained by a single provider stream. */
export const MAX_SSE_PAYLOAD_BYTES = 32 * 1024 * 1024;

export type CallResultLike = {
  blocks: Array<Record<string, unknown>>;
  usage: ProviderUsage | null;
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
  /** Provider id for route-specific optional-field safety. */
  provider?: string;
  cacheControl?: boolean;
  explicitCacheBreakpoint?: boolean;
  maxTokens?: number;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  reasoningContext?: "all_turns" | "current_turn";
  textVerbosity?: "low" | "medium" | "high";
  googleThinking?: boolean;
  /** Native Google cachedContent only; OpenAI-compatible serializers ignore it. */
  cachedContent?: string | null;
  includeEncryptedReasoning?: boolean;
  promptCacheMode?: "implicit" | "explicit";
  explicitCacheSkipTail?: boolean;
};

function isGeminiModel(model: string): boolean {
  return /(?:^|\/)gemini(?:[-/:]|$)/i.test(model.trim());
}

function applyCacheOpts(body: Record<string, unknown>, opts?: CompletionsOpts, model = ""): void {
  // Gemini's OpenAI-compatible endpoint does not document prompt_cache_key.
  // Callers may still use this generic serializer for another route, so use
  // both the explicit provider and the model route hint supplied by the
  // caller rather than guessing from arbitrary provider metadata.
  const geminiRoute = opts?.provider === "google" || isGeminiModel(model);
  const zenRoute = opts?.provider === "opencode-zen";
  if (opts?.cacheKey && !geminiRoute && !zenRoute) body.prompt_cache_key = opts.cacheKey;
  // OpenRouter documents session_id for sticky routing. Do not leak that
  // OpenRouter-specific field to Google/Gemini or undocumented relay routes.
  if (opts?.sessionId && !geminiRoute && (opts.provider === undefined || opts.provider === "openrouter")) {
    body.session_id = opts.sessionId;
  }
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
  applyCacheOpts(body, opts, model);
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

/**
 * Native Gemini context caching is deliberately separate from the OpenAI
 * compatibility serializers. The caller must select the direct Google route
 * before passing `provider: "google"` to these builders.
 */
export type GoogleCachedContentRequest = {
  method: "POST" | "GET" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
};

export type GoogleCachedContentCreateInput = {
  model: string;
  contents?: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  systemInstruction?: Record<string, unknown> | string;
  toolConfig?: Record<string, unknown>;
  ttl?: string;
  displayName?: string;
};

export type GoogleCachedContent = {
  name: string;
  model?: string;
  contents?: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  systemInstruction?: Record<string, unknown>;
  toolConfig?: Record<string, unknown>;
  createTime?: string;
  updateTime?: string;
  expireTime?: string;
  ttl?: string;
  displayName?: string;
  usageMetadata: Record<string, unknown> | null;
};

/** Local serialization bound; it is not a Gemini service limit. */
export const GOOGLE_CACHED_CONTENT_MAX_BYTES = 8 * 1024 * 1024;

const GOOGLE_CACHED_CONTENT_PATH = "/v1beta/cachedContents";
const GOOGLE_CACHE_NAME_RE = /^cachedContents\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GOOGLE_MODEL_RE = /^models\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const GOOGLE_TTL_RE = /^(?:0|[1-9]\d*)(?:\.\d{1,9})?s$/;
const GOOGLE_DISPLAY_NAME_MAX_CHARS = 128;
const GOOGLE_RESOURCE_MAX_CHARS = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonByteLength(value: unknown): number | null {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return null;
  }
  if (typeof json !== "string") return null;
  return new TextEncoder().encode(json).byteLength;
}

function requireBoundedJson(value: unknown, label: string): void {
  const bytes = jsonByteLength(value);
  if (bytes === null) throw new TypeError(`${label} must be JSON-serializable`);
  if (bytes > GOOGLE_CACHED_CONTENT_MAX_BYTES) {
    throw new RangeError(`${label} exceeds ${GOOGLE_CACHED_CONTENT_MAX_BYTES} bytes`);
  }
}

export function isGoogleCachedContentName(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= GOOGLE_RESOURCE_MAX_CHARS &&
    GOOGLE_CACHE_NAME_RE.test(value);
}

function requireGoogleCachedContentName(value: unknown): string {
  if (!isGoogleCachedContentName(value)) {
    throw new TypeError("invalid Google cached content name");
  }
  return value;
}

function googleModelResource(model: unknown): string {
  if (typeof model !== "string") throw new TypeError("Google cached content model is required");
  const trimmed = model.trim();
  const normalized = trimmed.startsWith("models/") ? trimmed : `models/${trimmed}`;
  if (normalized.length > GOOGLE_RESOURCE_MAX_CHARS || !GOOGLE_MODEL_RE.test(normalized)) {
    throw new TypeError("invalid Google cached content model");
  }
  return normalized;
}

function isGoogleModelResource(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= GOOGLE_RESOURCE_MAX_CHARS &&
    GOOGLE_MODEL_RE.test(value);
}

export function isGoogleCacheTtl(value: unknown): value is string {
  return typeof value === "string" && GOOGLE_TTL_RE.test(value);
}

function requireGoogleCacheTtl(value: unknown): string {
  if (!isGoogleCacheTtl(value)) {
    throw new TypeError("invalid Google cache TTL; expected seconds ending in 's'");
  }
  return value;
}

function requireGoogleDisplayName(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Google cache display name must be a string");
  if ([...value].length > GOOGLE_DISPLAY_NAME_MAX_CHARS) {
    throw new RangeError(`Google cache display name exceeds ${GOOGLE_DISPLAY_NAME_MAX_CHARS} characters`);
  }
  return value;
}

function requireGoogleRecordArray(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new TypeError(`${label} must be an array of objects`);
  }
  return value as Array<Record<string, unknown>>;
}

function googleCachedContentResourcePath(name: string): string {
  return `/v1beta/${requireGoogleCachedContentName(name)}`;
}

export function googleCachedContentCreateRequest(
  input: GoogleCachedContentCreateInput,
): GoogleCachedContentRequest {
  if (!isRecord(input)) throw new TypeError("Google cached content create input is required");
  const body: Record<string, unknown> = { model: googleModelResource(input.model) };
  if (input.contents !== undefined) body.contents = requireGoogleRecordArray(input.contents, "Google cached content contents");
  if (input.tools !== undefined) body.tools = requireGoogleRecordArray(input.tools, "Google cached content tools");
  if (input.systemInstruction !== undefined) {
    body.systemInstruction = typeof input.systemInstruction === "string"
      ? { parts: [{ text: input.systemInstruction }] }
      : (() => {
          if (!isRecord(input.systemInstruction)) throw new TypeError("Google cache system instruction must be an object or string");
          return input.systemInstruction;
        })();
  }
  if (input.toolConfig !== undefined) {
    if (!isRecord(input.toolConfig)) throw new TypeError("Google cache tool config must be an object");
    body.toolConfig = input.toolConfig;
  }
  if (input.ttl !== undefined) body.ttl = requireGoogleCacheTtl(input.ttl);
  if (input.displayName !== undefined) body.displayName = requireGoogleDisplayName(input.displayName);
  requireBoundedJson(body, "Google cached content request");
  return { method: "POST", path: GOOGLE_CACHED_CONTENT_PATH, body };
}

export function googleCachedContentGetRequest(name: string): GoogleCachedContentRequest {
  return { method: "GET", path: googleCachedContentResourcePath(name) };
}

export function googleCachedContentUpdateRequest(name: string, ttl: string): GoogleCachedContentRequest {
  return {
    method: "PATCH",
    path: googleCachedContentResourcePath(name),
    query: { updateMask: "ttl" },
    body: { ttl: requireGoogleCacheTtl(ttl) },
  };
}

export function googleCachedContentDeleteRequest(name: string): GoogleCachedContentRequest {
  return { method: "DELETE", path: googleCachedContentResourcePath(name) };
}

function optionalRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined | null {
  if (!(key in record)) return undefined;
  return isRecord(record[key]) ? record[key] : null;
}

function optionalRecordArray(
  record: Record<string, unknown>,
  key: string,
): Array<Record<string, unknown>> | undefined | null {
  if (!(key in record)) return undefined;
  return Array.isArray(record[key]) && record[key].every(isRecord)
    ? record[key] as Array<Record<string, unknown>>
    : null;
}

/** Parse the common CachedContent response without making any service calls. */
export function parseGoogleCachedContent(data: unknown): GoogleCachedContent | null {
  if (!isRecord(data) || !isGoogleCachedContentName(data.name)) return null;
  const bytes = jsonByteLength(data);
  if (bytes === null || bytes > GOOGLE_CACHED_CONTENT_MAX_BYTES) return null;

  const model = data.model;
  if (model !== undefined && !isGoogleModelResource(model)) return null;
  const ttl = data.ttl;
  if (ttl !== undefined && !isGoogleCacheTtl(ttl)) return null;
  const displayName = data.displayName;
  if (displayName !== undefined && (typeof displayName !== "string" || [...displayName].length > GOOGLE_DISPLAY_NAME_MAX_CHARS)) return null;

  const contents = optionalRecordArray(data, "contents");
  const tools = optionalRecordArray(data, "tools");
  const systemInstruction = optionalRecord(data, "systemInstruction");
  const toolConfig = optionalRecord(data, "toolConfig");
  if (contents === null || tools === null || systemInstruction === null || toolConfig === null) return null;

  const out: GoogleCachedContent = { name: data.name, usageMetadata: null };
  if (model !== undefined) out.model = model;
  if (contents !== undefined) out.contents = contents;
  if (tools !== undefined) out.tools = tools;
  if (systemInstruction !== undefined) out.systemInstruction = systemInstruction;
  if (toolConfig !== undefined) out.toolConfig = toolConfig;
  if (typeof data.createTime === "string") out.createTime = data.createTime;
  else if (data.createTime !== undefined) return null;
  if (typeof data.updateTime === "string") out.updateTime = data.updateTime;
  else if (data.updateTime !== undefined) return null;
  if (typeof data.expireTime === "string") out.expireTime = data.expireTime;
  else if (data.expireTime !== undefined) return null;
  if (ttl !== undefined) out.ttl = ttl;
  if (displayName !== undefined) out.displayName = displayName;
  if (data.usageMetadata !== undefined) {
    if (!isRecord(data.usageMetadata)) return null;
    out.usageMetadata = data.usageMetadata;
  }
  return out;
}

/** Gemini documents an empty JSON object; tolerate a 204/empty response too. */
export function parseGoogleCachedContentDeleteResponse(data: unknown): boolean {
  return data == null || (isRecord(data) && Object.keys(data).length === 0);
}

/** Native Gemini generateContent. Model id lives in the URL, not the body. */
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
  // `cachedContent` is a native Google field. Require the direct provider
  // marker so the same generateContent serializer cannot accidentally enable
  // undocumented caching for OpenCode Zen's Gemini relay.
  if (opts?.provider === "google" && opts.cachedContent !== undefined && opts.cachedContent !== null) {
    body.cachedContent = requireGoogleCachedContentName(opts.cachedContent);
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
  applyCacheOpts(body, opts, model);
  const geminiRoute = opts?.provider === "google" || isGeminiModel(model);
  const explicitRoute = !geminiRoute && (opts?.provider === undefined || opts.provider === "openai" || opts.provider === "openrouter");
  if (opts?.promptCacheMode === "explicit" && explicitRoute) {
    body.prompt_cache_options = { mode: "explicit", ttl: "30m" };
  }
  const input = body.input as Array<Record<string, unknown>>;
  if (opts?.explicitCacheBreakpoint && explicitRoute) {
    const extra = { prompt_cache_breakpoint: { mode: "explicit" as const } };
    body.input =
      opts.explicitCacheSkipTail === false ? markLastInputText(input, extra) : markPrefixThenTail(input, extra);
  } else if (opts?.cacheControl && !geminiRoute && (opts.provider === undefined || opts.provider === "openrouter")) {
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

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function firstToken(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = tokenCount(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function mergeDetailRecords(...values: unknown[]): Record<string, unknown> | null {
  let merged: Record<string, unknown> | null = null;
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    merged = { ...(merged ?? {}), ...(value as Record<string, unknown>) };
  }
  return merged;
}

function uncachedInput(total: number | null, cacheRead: number | null): number | null {
  if (total === null) return null;
  // A provider-reported cache read cannot exceed its total input. Preserve an
  // explicit anomaly as unknown instead of manufacturing a zero-token miss.
  if (cacheRead !== null && cacheRead > total) return null;
  return cacheRead === null ? total : Math.max(0, total - cacheRead);
}

function mergeUsageRecords(
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...(previous ?? {}), ...next };
  for (const key of [
    "prompt_tokens_details",
    "input_tokens_details",
    "completion_tokens_details",
    "output_tokens_details",
  ]) {
    const before = previous?.[key];
    const after = next[key];
    if (
      before && typeof before === "object" && !Array.isArray(before) &&
      after && typeof after === "object" && !Array.isArray(after)
    ) {
      merged[key] = { ...(before as Record<string, unknown>), ...(after as Record<string, unknown>) };
    }
  }
  return merged;
}

function usageFromOpenAI(u: Record<string, unknown> | undefined): CallResultLike["usage"] {
  if (!u) return null;
  const prompt = firstToken(u.input_tokens, u.prompt_tokens);
  const output = firstToken(u.output_tokens, u.completion_tokens);
  const promptDetails = mergeDetailRecords(u.prompt_tokens_details, u.input_tokens_details);
  const completionDetails = mergeDetailRecords(u.completion_tokens_details, u.output_tokens_details);
  const cached = firstToken(promptDetails?.cached_tokens, u.cached_tokens);
  const cacheWrite = firstToken(promptDetails?.cache_write_tokens, u.cache_write_tokens);
  const reasoning = firstToken(completionDetails?.reasoning_tokens, u.reasoning_tokens);
  return {
    input: uncachedInput(prompt, cached),
    cacheRead: cached,
    cacheWrite,
    output,
    reasoning,
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

const TOOL_CALL_ARGUMENT_ERROR = "provider protocol error: tool call arguments must be a JSON object";
const TOOL_CALL_IDENTITY_ERROR = "provider protocol error: tool call identity is missing";
const TOOL_CALL_SHAPE_ERROR = "provider protocol error: malformed tool call";
const TOOL_CALL_INDEX_ERROR = "provider protocol error: malformed tool call index";
const MAX_TOOL_CALL_INDEX = 10_000;

function toolCallIdentityError(id: unknown, name: unknown): string | null {
  return typeof id !== "string" || !id.trim() || typeof name !== "string" || !name.trim()
    ? TOOL_CALL_IDENTITY_ERROR
    : null;
}

function toolCallIndex(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOOL_CALL_INDEX
    ? value
    : null;
}

function decodeToolCallArguments(
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

export function completionResultFromEvents(
  events: Array<Record<string, unknown>>,
  onText: (text: string) => void,
  started: number,
): CallResultLike {
  let text = "";
  let thinking = "";
  const calls = new Map<number, { id: string; name: string; type?: "function"; args: string }>();
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
        const tc = raw as { index?: unknown; id?: unknown; type?: unknown; function?: unknown };
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
          calls.set(idx, { id, name, ...(type ? { type } : {}), args });
          indicesById.set(id, idx);
          continue;
        }
        if ((id && id !== cur.id) || (name && name !== cur.name)) {
          toolError ??= `${TOOL_CALL_IDENTITY_ERROR}: call identity changed`;
          continue;
        }
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
  const decoded: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  for (const [, call] of ordered) {
    const identityError = toolCallIdentityError(call.id, call.name);
    if (identityError) return { blocks, usage, ttftMs, stopReason, error: identityError };
    const args = decodeToolCallArguments(call.args, true);
    if ("error" in args) return { blocks, usage, ttftMs, stopReason, error: args.error };
    decoded.push({ id: call.id, name: call.name, input: args.input });
  }
  blocks.push(...decoded.map((call) => ({ type: "tool_use", ...call })));
  return { blocks, usage, ttftMs, stopReason };
}

function usageFromGoogle(u: Record<string, unknown> | undefined): CallResultLike["usage"] {
  if (!u) return null;
  const prompt = tokenCount(u.promptTokenCount);
  const output = tokenCount(u.candidatesTokenCount);
  const cached = tokenCount(u.cachedContentTokenCount);
  const reasoning = tokenCount(u.thoughtsTokenCount);
  return {
    input: uncachedInput(prompt, cached),
    cacheRead: cached,
    cacheWrite: null,
    output,
    reasoning,
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
  const calls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  const callKeys = new Set<string>();
  let toolError: string | undefined;
  let usage: CallResultLike["usage"] = null;
  let rawUsage: Record<string, unknown> | undefined;
  let ttftMs: number | null = null;
  let stopReason: string | null = null;
  for (const ev of events) {
    if (ev.usageMetadata && typeof ev.usageMetadata === "object" && !Array.isArray(ev.usageMetadata)) {
      rawUsage = mergeUsageRecords(rawUsage, ev.usageMetadata as Record<string, unknown>);
      usage = usageFromGoogle(rawUsage);
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
      if (!("functionCall" in part)) continue;
      const call = part.functionCall;
      if (!isRecord(call)) {
        toolError ??= TOOL_CALL_SHAPE_ERROR;
        continue;
      }
      const fn = call as { name?: unknown; args?: unknown };
      const name = typeof fn.name === "string" ? fn.name : "";
      const identityError = toolCallIdentityError(`call_${calls.length + 1}`, name);
      if (identityError) {
        toolError ??= identityError;
        continue;
      }
      const args = decodeToolCallArguments(fn.args, false);
      if ("error" in args) {
        toolError ??= args.error;
        continue;
      }
      const key = `${name}:${JSON.stringify(args.input)}`;
      if (callKeys.has(key)) continue;
      callKeys.add(key);
      calls.push({ id: `call_${calls.length + 1}`, name, input: args.input });
    }
  }
  const blocks: Array<Record<string, unknown>> = [];
  for (const thought of thoughts) {
    blocks.push({ type: "thinking", thinking: thought.thinking, signature: thought.signature });
  }
  if (text) blocks.push({ type: "text", text });
  if (toolError) return { blocks, usage, ttftMs, stopReason, error: toolError };
  blocks.push(...calls.map((call) => ({ type: "tool_use", ...call })));
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

type SseParseState = {
  events: Array<Record<string, unknown>>;
  eventCount: number;
  payloadBytes: number;
  terminalSeen: boolean;
  terminalAllowsUsage: boolean;
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
  if (state.terminalSeen && !usageTrailer) {
    throw new Error("provider SSE event arrived after terminal event");
  }
  if (usageTrailer) state.terminalAllowsUsage = false;
  if (isSseChoiceTerminal(event)) {
    state.terminalSeen = true;
    state.terminalAllowsUsage = true;
  } else if (isSseTerminalEvent(event)) {
    state.terminalSeen = true;
    state.terminalAllowsUsage = false;
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
