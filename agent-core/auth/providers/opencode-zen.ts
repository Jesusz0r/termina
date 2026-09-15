import type { ProviderDefinition, ProviderProtocol } from "./types.ts";
import { openCodeHeaders } from "./shared.ts";
import { modelLooksClaude } from "../../models/families/anthropic.ts";
import { modelLooksGemini } from "../../models/families/google.ts";
import { museSparkReasoningFamily } from "../../models/families/muse-spark.ts";
import { modelLooksCodex, modelLooksOpenAI } from "../../models/families/openai.ts";
import { modelLooksQwen } from "../../models/families/relay.ts";
import { modelLooksGrok } from "../../models/families/xai.ts";
/**
 * OpenCode Zen picks an existing kernel protocol from the model id.
 * Claude and Qwen use Messages. GPT, Codex, Grok, and Muse Spark use Responses.
 * Gemini uses Google generateContent on /models/{id}.
 * Endpoint map: https://opencode.ai/docs/zen
 */
export function zenWireProtocol(model: string): ProviderProtocol {
  if (modelLooksClaude(model) || modelLooksQwen(model)) return "anthropic-messages";
  if (modelLooksGemini(model)) return "google-generate";
  if (
    modelLooksOpenAI(model) ||
    modelLooksCodex(model) ||
    modelLooksGrok(model) ||
    museSparkReasoningFamily(model)
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
