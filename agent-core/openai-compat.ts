/**
 * OpenAI Chat Completions and Codex Responses conversion.
 *
 * The kernel stores Anthropic-shaped messages. This module is the only
 * translator for OpenAI Responses (openai, xai, github-copilot, openrouter,
 * openai-codex), Chat Completions (google login), and Google generateContent
 * (OpenCode Zen Gemini).
 */

// Split into ./openai-compat/ modules (issue #38). This entry re-exports the public surface.
export type { CompletionsOpts, KernelMessage, ProviderUsage, ToolDef } from "./openai-compat/types.ts";
export { completionsBody, toCompletionsMessages } from "./openai-compat/completions.ts";
export { isTruncatedStopReason, responsesBody, stripResponsesBreakpoints, toResponsesInput, toResponsesTools } from "./openai-compat/responses.ts";
export { mergeProviderUsage, normalizeProviderUsage, providerReportedUsd, usageFromOpenAI } from "./openai-compat/usage.ts";
export { completionLiveDelta, completionResultFromEvents, textFromCompletionPayload } from "./openai-compat/completions-stream.ts";
export { responsesLiveDelta, responsesResultFromEvents } from "./openai-compat/responses-stream.ts";
export { MAX_SSE_BUFFER_BYTES, MAX_SSE_PAYLOAD_BYTES, readSseJson } from "./openai-compat/sse.ts";
export { googleGenerateBody, googleLiveDelta, googleResultFromEvents } from "./openai-compat/google.ts";
