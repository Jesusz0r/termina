import type { ProviderDefinition } from "./types.ts";
import { bearerHeaders } from "./shared.ts";
export const OPENAI_CODEX_ORIGINATOR = "codex_cli_rs";
export const OPENAI_CODEX_CLIENT_VERSION = "1.0.0";
const OPENAI_JWT_AUTH = "https://api.openai.com/auth";
export function extractAccountId(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
    const nested = payload[OPENAI_JWT_AUTH];
    const fromNested =
      nested && typeof nested === "object" && !Array.isArray(nested)
        ? (nested as { chatgpt_account_id?: unknown }).chatgpt_account_id
        : undefined;
    const raw = fromNested ?? payload.chatgpt_account_id;
    return typeof raw === "string" && raw ? raw : null;
  } catch {
    return null;
  }
}

function codexHeaders(token: string, extra?: Record<string, unknown>): Record<string, string> {
  const headers = bearerHeaders(token);
  const account = (typeof extra?.accountId === "string" && extra.accountId) || extractAccountId(token) || "";
  if (account) headers["chatgpt-account-id"] = account;
  return { ...headers, originator: OPENAI_CODEX_ORIGINATOR, "user-agent": `codex_cli_rs/${OPENAI_CODEX_CLIENT_VERSION}`, "openai-beta": "responses=experimental" };
}

export const openaiCodex: ProviderDefinition = {
  baseUrl: "https://chatgpt.com/backend-api",
  envKeys: [],
  defaultModels: { main: "gpt-5.6-sol", summary: "gpt-5.6-luna" },
  loginMode: "browser",
  protocol: () => "openai-codex-responses",
  headers: codexHeaders,
  catalog: { acceptsId: (n) => /^(gpt-|o[0-9]|codex)/.test(n), acceptsRow: (row) => row.visibility !== "hide" },
};
