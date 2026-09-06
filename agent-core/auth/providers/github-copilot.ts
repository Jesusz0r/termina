import type { ProviderDefinition, ProviderProtocol } from "./types.ts";
import { bearerHeaders } from "./shared.ts";
import { copilotCatalogContext, copilotCatalogEndpoints } from "../../models/catalog/copilot.ts";
export const COPILOT_HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
  "user-agent": "GitHubCopilotChat/0.35.0",
  "editor-version": "vscode/1.107.0",
  "editor-plugin-version": "copilot-chat/0.35.0",
  "copilot-integration-id": "vscode-chat",
} as const;

function copilotProtocol(_model: string, endpoints?: readonly string[]): ProviderProtocol {
  if (endpoints?.includes("/responses")) return "openai-responses";
  if (endpoints?.includes("/chat/completions")) return "openai-completions";
  if (endpoints?.includes("/v1/messages")) return "anthropic-messages";
  return "openai-completions";
}
function copilotHeaders(token: string): Record<string, string> {
  return { ...bearerHeaders(token), "editor-version": COPILOT_HEADERS["editor-version"], "editor-plugin-version": COPILOT_HEADERS["editor-plugin-version"], "copilot-integration-id": COPILOT_HEADERS["copilot-integration-id"], "user-agent": COPILOT_HEADERS["user-agent"] };
}

export const githubCopilot: ProviderDefinition = {
  baseUrl: "https://api.individual.githubcopilot.com",
  envKeys: [],
  defaultModels: { main: "gpt-5.6-terra", summary: "gpt-5.6-luna" },
  loginMode: "device",
  protocol: copilotProtocol,
  headers: copilotHeaders,
  protocolHeaders: (headers, protocol) => protocol === "anthropic-messages"
    ? { ...headers, "anthropic-version": "2023-06-01" }
    : headers,
  catalog: { acceptsId: (n) => /^(gpt-|o[0-9]|claude|gemini|copilot)/.test(n), contextFallback: copilotCatalogContext, supportedEndpoints: copilotCatalogEndpoints },
};
