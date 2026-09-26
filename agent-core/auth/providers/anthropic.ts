import type { ProviderDefinition } from "./types.ts";

/** Claude subscription OAuth is for Claude Code, not this app.
 *  https://code.claude.com/docs/en/legal-and-compliance */
export const ANTHROPIC_SUBSCRIPTION_LOGIN_REMOVED =
  "anthropic subscription login is not supported — run /login anthropic key or set ANTHROPIC_API_KEY";

export function pickHeaders(token: string, extra?: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  // API keys use x-api-key. ANTHROPIC_AUTH_TOKEN is a gateway bearer, not a
  // Claude subscription login.
  // https://platform.claude.com/docs/en/manage-claude/authentication
  // https://code.claude.com/docs/en/iam
  const envName = typeof extra?.envName === "string" ? extra.envName : "";
  if (envName === "ANTHROPIC_AUTH_TOKEN") {
    headers.authorization = `Bearer ${token}`;
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
  loginMode: "key",
  protocol: () => "anthropic-messages",
  headers: pickHeaders,
  catalog: { acceptsId: (n) => n.includes("claude") || n.includes("haiku") },
};
