/**
 * OpenAI Chat Completions and Codex Responses conversion.
 *
 * The kernel stores Anthropic-shaped messages. This module is the only
 * translator for OpenAI Responses (openai, xai, github-copilot, openrouter,
 * openai-codex), Chat Completions (google login), and Google generateContent
 * (OpenCode Zen Gemini).
 */

// Split into ./openai-compat/ modules (issue #38). This entry re-exports the public surface.
export type { CallResultLike, CompletionsOpts, KernelMessage, ProviderUsage, ToolDef } from "./openai-compat/types.ts";
export { completionsBody, toCompletionsMessages, toCompletionsTools } from "./openai-compat/completions.ts";
export { isTruncatedStopReason, responsesBody, stripResponsesBreakpoints, toResponsesInput, toResponsesTools } from "./openai-compat/responses.ts";
export { usageFromOpenAI } from "./openai-compat/usage.ts";
export { completionLiveDelta, completionResultFromEvents, textFromCompletionPayload } from "./openai-compat/completions-stream.ts";
export { responsesLiveDelta, responsesResultFromEvents, textFromResponsesPayload } from "./openai-compat/responses-stream.ts";
export { MAX_SSE_BUFFER_BYTES, MAX_SSE_EVENT_COUNT, MAX_SSE_PAYLOAD_BYTES, readSseJson } from "./openai-compat/sse.ts";
export { GOOGLE_CACHED_CONTENT_MAX_BYTES, googleCachedContentCreateRequest, googleCachedContentDeleteRequest, googleCachedContentGetRequest, googleCachedContentUpdateRequest, googleGenerateBody, googleLiveDelta, googleResultFromEvents, isGoogleCacheTtl, isGoogleCachedContentName, parseGoogleCachedContent, parseGoogleCachedContentDeleteResponse, textFromGooglePayload } from "./openai-compat/google.ts";
export type { GoogleCachedContent, GoogleCachedContentCreateInput, GoogleCachedContentRequest } from "./openai-compat/google.ts";
