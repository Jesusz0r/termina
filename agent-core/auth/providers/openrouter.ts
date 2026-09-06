import type { ProviderDefinition } from "./types.ts";
import { bearerHeaders } from "./shared.ts";

export const openrouter: ProviderDefinition = {
  baseUrl: "https://openrouter.ai/api/v1",
  baseEnv: "OPENROUTER_BASE_URL",
  envKeys: ["OPENROUTER_API_KEY"],
  defaultModels: { main: "openai/gpt-5.6-terra", summary: "openai/gpt-5.6-luna" },
  loginMode: "browser",
  protocol: () => "openai-responses",
  headers: (token) => ({ ...bearerHeaders(token), "http-referer": "https://termina.local", "x-title": "Termina agent-core" }),
  catalog: { acceptsId: (n) => n.includes("/") },
};
