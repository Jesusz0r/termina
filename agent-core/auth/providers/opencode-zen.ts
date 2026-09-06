import type { ProviderDefinition, ProviderProtocol } from "./types.ts";
import { openCodeHeaders } from "./shared.ts";
import { modelLeaf } from "../../models/families/identity.ts";
import { modelLooksClaude } from "../../models/families/anthropic.ts";
import { modelLooksGemini } from "../../models/families/google.ts";
import { modelLooksQwen } from "../../models/families/relay.ts";
/**
 * OpenCode Zen picks an existing kernel protocol from the model id.
 * Claude and Qwen use Messages. GPT, Codex, Grok, and Muse Spark use Responses.
 * Gemini uses Google generateContent on /models/{id}.
 */
export function zenWireProtocol(model: string): ProviderProtocol {
  const leaf = modelLeaf(model);
  if (modelLooksClaude(model) || modelLooksQwen(model)) return "anthropic-messages";
  if (modelLooksGemini(model)) return "google-generate";
  if (
    /^(gpt-|o[0-9]|chatgpt)/.test(leaf) ||
    leaf.includes("codex") ||
    leaf.startsWith("grok") ||
    leaf.startsWith("muse-spark")
  ) {
    return "openai-responses";
  }
  return "openai-completions";
}

export const opencodeZen: ProviderDefinition = {
  baseUrl: "https://opencode.ai/zen/v1",
  envKeys: ["OPENCODE_API_KEY"],
  defaultModels: { main: "gpt-5.6-sol", summary: "gpt-5.6-luna" },
  loginMode: "key",
  protocol: zenWireProtocol,
  headers: openCodeHeaders,
  catalog: { acceptsId: (_n) => true },
};
