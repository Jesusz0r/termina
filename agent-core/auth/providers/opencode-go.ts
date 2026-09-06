import type { ProviderDefinition } from "./types.ts";
import { openCodeHeaders } from "./shared.ts";
import { modelLeaf } from "../../models/families/identity.ts";
import { zenWireProtocol } from "./opencode-zen.ts";

export const opencodeGo: ProviderDefinition = {
  baseUrl: "https://opencode.ai/zen/go/v1",
  envKeys: ["OPENCODE_GO_API_KEY"],
  defaultModels: { main: "glm-5.1", summary: "glm-5.1" },
  loginMode: "key",
  protocol: (model) => modelLeaf(model).startsWith("minimax-") ? "anthropic-messages" : zenWireProtocol(model),
  headers: openCodeHeaders,
  catalog: { acceptsId: (_n) => true },
};
