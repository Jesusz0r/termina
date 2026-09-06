import type { CatalogPolicy } from "../../models/catalog/types.ts";

export const SUPPORTED_PROVIDERS = [
  "anthropic",
  "openai",
  "openai-codex",
  "github-copilot",
  "xai",
  "google",
  "openrouter",
  "opencode-go",
  "opencode-zen",
] as const;
export type ProviderId = (typeof SUPPORTED_PROVIDERS)[number];
export type ProviderProtocol =
  | "anthropic-messages"
  | "openai-completions"
  | "openai-codex-responses"
  | "openai-responses"
  | "google-generate";
export type LoginMode = "browser" | "code" | "key" | "device";

export interface ProviderDefinition {
  baseUrl: string;
  baseEnv?: string;
  envKeys: string[];
  defaultModels: { main: string; summary: string };
  loginMode: LoginMode;
  protocol: (model: string, supportedEndpoints?: readonly string[]) => ProviderProtocol;
  headers?: (token: string, extra?: Record<string, unknown>) => Record<string, string>;
  protocolHeaders?: (headers: Record<string, string>, protocol: ProviderProtocol) => Record<string, string>;
  catalog: CatalogPolicy;
}
