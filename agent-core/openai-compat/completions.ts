/**
 * Chat Completions request mappers.
 *
 * Owns tool/message mapping and the Completions request body.
 * Split from agent-core/openai-compat.ts (issue #38).
 */
import type { CompletionMessage, CompletionsOpts, KernelMessage, ToolDef } from "./types.ts";


export function imageDataUrl(b: Record<string, unknown>): string | null {
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


export function blockText(b: Record<string, unknown>): string {
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
          const signature = typeof b.thought_signature === "string" ? b.thought_signature : "";
          toolCalls.push({
            id,
            type: "function",
            function: { name: String(b.name ?? ""), arguments: JSON.stringify(b.input ?? {}) },
            ...(signature ? { extra_content: { google: { thought_signature: signature } } } : {}),
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


export function isGeminiModel(model: string): boolean {
  return /(?:^|\/)gemini(?:[-/:]|$)/i.test(model.trim());
}


export function applyCacheOpts(body: Record<string, unknown>, opts?: CompletionsOpts, model = ""): void {
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
