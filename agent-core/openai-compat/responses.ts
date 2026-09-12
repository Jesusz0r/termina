/**
 * Responses request mappers and cache breakpoints.
 *
 * Owns input mapping, explicit breakpoints, and the Responses body.
 * Split from agent-core/openai-compat.ts (issue #38).
 */
import { applyCacheOpts, blockText, imageDataUrl, isGeminiModel } from "./completions.ts";
import type { CompletionsOpts, KernelMessage, ToolDef } from "./types.ts";


export function toResponsesTools(tools: ToolDef[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
    strict: false,
  }));
}


const OPENAI_MAX_EXPLICIT_BREAKPOINTS = 4;


/**
 * Stamp the latest eligible message boundaries. Preserving historical markers
 * lets an append-only conversation read the longest prefix written by a prior
 * turn instead of rewriting the entire growing prompt on every request.
 */
function markLatestInputTexts(
  input: Array<Record<string, unknown>>,
  extra: Record<string, unknown>,
  limit: number,
): Array<Record<string, unknown>> {
  const next = input.slice();
  let marked = 0;
  for (let i = next.length - 1; i >= 0 && marked < limit; i--) {
    const item = next[i]!;
    for (const field of ["content", "output"] as const) {
      const partsValue = item[field];
      if (!Array.isArray(partsValue)) continue;
      for (let j = partsValue.length - 1; j >= 0; j--) {
        const part = partsValue[j] as Record<string, unknown>;
        if (!part || part.type !== "input_text" || typeof part.text !== "string") continue;
        const parts = partsValue.slice() as Array<Record<string, unknown>>;
        parts[j] = { ...part, ...extra };
        next[i] = { ...item, [field]: parts };
        marked += 1;
        break;
      }
      if (marked > 0 && next[i] !== item) break;
    }
  }
  return marked > 0 ? next : input;
}


function markPrefixThenTail(
  input: Array<Record<string, unknown>>,
  extra: Record<string, unknown>,
  limit = 1,
): Array<Record<string, unknown>> {
  if (input.length < 2) return input;
  if (input[input.length - 1]?.type === "function_call_output") {
    return markLatestInputTexts(input, extra, limit);
  }
  return [...markLatestInputTexts(input.slice(0, -1), extra, limit), input[input.length - 1]!];
}


/** Strip prompt_cache_breakpoint and prompt_cache_options when a model rejects explicit caching. */
/**
 * Provider stop reasons that mean the turn was cut by the output limit:
 * OpenAI "length", Anthropic "max_tokens", Google "MAX_TOKENS". Tool calls
 * from such a turn may carry truncated arguments that still parse.
 */
export function isTruncatedStopReason(reason: string | null | undefined): boolean {
  return reason === "length" || reason === "max_tokens" || reason === "MAX_TOKENS";
}


export function stripResponsesBreakpoints(body: Record<string, unknown>): Record<string, unknown> {  const next = { ...body };
  delete next.prompt_cache_options;
  if (Array.isArray(next.input)) {
    next.input = next.input.map((item) => {
      if (!item || typeof item !== "object") return item;
      const rec = item as Record<string, unknown>;
      const strip = (value: unknown): unknown => {
        if (!Array.isArray(value)) return value;
        return value.map((part) => {
          if (!part || typeof part !== "object" || !("prompt_cache_breakpoint" in part)) return part;
          const { prompt_cache_breakpoint: _, ...rest } = part as Record<string, unknown>;
          return rest;
        });
      };
      const stripped = { ...rec };
      if (Array.isArray(rec.content)) stripped.content = strip(rec.content);
      if (Array.isArray(rec.output)) stripped.output = strip(rec.output);
      return stripped;
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
        output: [{ type: "input_text", text: "(interrupted)" }],
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
          output: [{ type: "input_text", text: blockText(b) }],
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
    ...(tools.length > 0 ? { tool_choice: "auto" } : {}),
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
      opts.explicitCacheSkipTail === false
        ? markLatestInputTexts(input, extra, OPENAI_MAX_EXPLICIT_BREAKPOINTS)
        : markPrefixThenTail(input, extra, OPENAI_MAX_EXPLICIT_BREAKPOINTS);
  } else if (opts?.cacheControl && opts.provider === "openrouter") {
    // OpenRouter's Responses API exposes prompt_cache_breakpoint and
    // translates it to a provider-specific breakpoint when needed. The
    // Anthropic cache_control shape is not exposed inside Responses input.
    body.input = markPrefixThenTail(input, { prompt_cache_breakpoint: { mode: "explicit" as const } });
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
