/**
 * Google generateContent and CachedContent mapping.
 *
 * Owns contents mapping, cached-content CRUD, the generate body, and
 * Google streaming results. Split from agent-core/openai-compat.ts (issue #38).
 */
import { isRecord } from "../../shared/guards.ts";
import { blockText, imageDataUrl } from "./completions.ts";
import { TOOL_CALL_SHAPE_ERROR, decodeToolCallArguments, toolCallIdentityError } from "./tool-calls.ts";
import type { CallResultLike, CompletionsOpts, KernelMessage, ToolDef } from "./types.ts";
import { mergeUsageRecords, tokenCount, uncachedInput } from "./usage.ts";


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
          // Gemini 3 maps each result to its call by id and validates the
          // first functionCall thoughtSignature of the current turn (400s).
          const signature = typeof b.thought_signature === "string" ? b.thought_signature : "";
          parts.push({
            functionCall: {
              name,
              args: b.input && typeof b.input === "object" && !Array.isArray(b.input) ? b.input : {},
              ...(id ? { id } : {}),
            },
            ...(signature ? { thoughtSignature: signature } : {}),
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
            id,
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


function usageFromGoogle(u: Record<string, unknown> | undefined): CallResultLike["usage"] {
  if (!u) return null;
  const prompt = tokenCount(u.promptTokenCount);
  const output = tokenCount(u.candidatesTokenCount);
  const cached = tokenCount(u.cachedContentTokenCount);
  const reasoning = tokenCount(u.thoughtsTokenCount);
  return {
    input: uncachedInput(prompt, cached, null),
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
  const calls: Array<{ id: string; name: string; input: Record<string, unknown>; thought_signature?: string }> = [];
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
      const fn = call as { name?: unknown; args?: unknown; id?: unknown };
      const name = typeof fn.name === "string" ? fn.name : "";
      // functionCall.id is guaranteed only on Gemini 3; older leaves on this
      // route may omit it. A missing id falls back to a generated one, kept
      // consistent through replay, instead of failing the turn — fail-closed
      // here would break tool use on id-less models whose calls still
      // resolve through name matching.
      const providerId = typeof fn.id === "string" && fn.id.trim() ? fn.id : "";
      const id = providerId || `call_${calls.length + 1}`;
      const identityError = toolCallIdentityError(id, name);
      if (identityError) {
        toolError ??= identityError;
        continue;
      }
      const args = decodeToolCallArguments(fn.args, false);
      if ("error" in args) {
        toolError ??= args.error;
        continue;
      }
      // Streaming snapshot repeats resend the full parts list per event; the
      // provider id (not name+args) identifies a repeat. Distinct parallel
      // calls share a name but carry different ids. Id-less calls fall back
      // to the name+args signature so their repeats still collapse.
      const key = providerId ? `id:${providerId}` : `sig:${name}:${JSON.stringify(args.input)}`;
      if (callKeys.has(key)) continue;
      callKeys.add(key);
      const thoughtSignature = typeof part.thoughtSignature === "string" ? part.thoughtSignature : "";
      calls.push({ id, name, input: args.input, ...(thoughtSignature ? { thought_signature: thoughtSignature } : {}) });
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
