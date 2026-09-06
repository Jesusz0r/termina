import type { ProviderDefinition } from "./types.ts";

export const xai: ProviderDefinition = {
  baseUrl: "https://api.x.ai/v1",
  baseEnv: "XAI_BASE_URL",
  envKeys: ["XAI_API_KEY"],
  defaultModels: { main: "grok-4.6", summary: "grok-4.6" },
  loginMode: "device",
  protocol: () => "openai-responses",
  catalog: { acceptsId: (n) => n.includes("grok") && !n.startsWith("grok-imagine-") },
};
