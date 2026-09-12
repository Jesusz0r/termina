/**
 * OpenAI-compat shared shapes.
 *
 * Owns kernel/protocol message, tool, options, and result types.
 * Split from agent-core/openai-compat.ts (issue #38).
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
  /**
   * Exact billed USD as reported by the provider (xAI `cost_in_usd_ticks`).
   * Absent when the provider reports no cost.
   */
  reportedUsd?: number | null;
};


export type CallResultLike = {
  blocks: Array<Record<string, unknown>>;
  usage: ProviderUsage | null;
  ttftMs: number | null;
  stopReason: string | null;
  error?: string;
};


export type CompletionMessage = {
  role: string;
  content?: string | null | Array<Record<string, unknown>>;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    extra_content?: { google: { thought_signature: string } };
  }>;
  tool_call_id?: string;
};


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
