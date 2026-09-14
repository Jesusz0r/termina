import type { ProviderDefinition } from "./types.ts";
const OAT_MARK = "sk-ant-oat";
export function isOAuthToken(token: string): boolean {
  return token.includes(OAT_MARK);
}

export function pickHeaders(token: string, extra?: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  // The credential source decides the header, not the token substring:
  // ANTHROPIC_AUTH_TOKEN is always a bearer token (live CLI docs), and a
  // stored oauth entry is bearer too. The marker remains only for unsourced
  // callers that pass a bare token.
  // https://code.claude.com/docs/en/env-vars
  const storedType = typeof extra?.type === "string" ? extra.type : "";
  const envName = typeof extra?.envName === "string" ? extra.envName : "";
  const oauth = storedType === "oauth" || envName === "ANTHROPIC_AUTH_TOKEN" ||
    (!storedType && !envName && isOAuthToken(token));
  if (oauth) {
    headers.authorization = `Bearer ${token}`;
    headers["anthropic-beta"] = "claude-code-20250219,oauth-2025-04-20";
    headers["user-agent"] = "termina-agent-core/1";
    headers["x-app"] = "cli";
  } else {
    headers["x-api-key"] = token;
  }
  return headers;
}

export const anthropic: ProviderDefinition = {
  baseUrl: "https://api.anthropic.com",
  baseEnv: "ANTHROPIC_BASE_URL",
  envKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  defaultModels: { main: "claude-sonnet-5", summary: "claude-haiku-4-5" },
  loginMode: "browser",
  protocol: () => "anthropic-messages",
  headers: pickHeaders,
  catalog: { acceptsId: (n) => n.includes("claude") || n.includes("haiku") },
};
