import type { ProviderDefinition } from "./types.ts";

export const openai: ProviderDefinition = {
  baseUrl: "https://api.openai.com/v1",
  baseEnv: "OPENAI_BASE_URL",
  envKeys: ["OPENAI_API_KEY"],
  defaultModels: { main: "gpt-5.6-sol", summary: "gpt-5.6-luna" },
  loginMode: "key",
  protocol: () => "openai-responses",
  catalog: { acceptsId: (n) => /^(gpt-|o[0-9]|chatgpt|claude|grok|gemini|gemma|deepseek|mistral|llama|qwen|kimi|minimax|command|glm|moonshot)/.test(n) },
};
