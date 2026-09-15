import type { ProviderDefinition } from "./types.ts";
import { modelLooksOpenAI } from "../../models/families/openai.ts";

export const openai: ProviderDefinition = {
  baseUrl: "https://api.openai.com/v1",
  baseEnv: "OPENAI_BASE_URL",
  envKeys: ["OPENAI_API_KEY"],
  defaultModels: { main: "gpt-5.6-sol", summary: "gpt-5.6-luna" },
  loginMode: "key",
  protocol: () => "openai-responses",
  catalog: { acceptsId: (n) => modelLooksOpenAI(n) },
};
