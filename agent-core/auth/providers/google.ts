import type { ProviderDefinition } from "./types.ts";

export const google: ProviderDefinition = {
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  defaultModels: { main: "gemini-3.7-flash", summary: "gemini-3.5-flash-lite" },
  loginMode: "key",
  protocol: () => "openai-completions",
  catalog: { acceptsId: (n) => n.includes("gemini") || n.includes("gemma") },
};
