/**
 * Google generateContent mapping.
 *
 * Owns contents mapping, the generate body, and Google streaming results.
 * Split from agent-core/openai-compat.ts (issue #38).
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
        // Mirror the Completions/Responses id fallback: validators accept
        // every alias, so the mapper must too.
        const id = String(b.tool_use_id ?? b.toolUseId ?? b.call_id ?? b.id ?? "");
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

/** Resource-name validation for the native `cachedContent` request field. */
const GOOGLE_CACHE_NAME_RE = /^cachedContents\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

const GOOGLE_RESOURCE_MAX_CHARS = 512;


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
  onText: (text: string) => void,
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
      if (typeof finish === "string" && finish) stopReason = finish;
    }
    const live = googleLiveDelta(ev);
    if (live?.text) {
      if (ttftMs === null) ttftMs = Date.now() - started;
      text += live.text;
      onText(live.text);
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
