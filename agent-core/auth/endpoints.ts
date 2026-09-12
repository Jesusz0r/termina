/**
 * Provider endpoints, protocols, and request headers.
 *
 * Owns provider identity/order, protocol selection, authorize/token/redirect
 * URLs, auth file path, and request header construction. Split from
 * agent-core/auth.ts (issue #38).
 */
import { providerDefinition } from "./providers/index.ts";
import { OPENAI_CODEX_CLIENT_VERSION } from "./providers/openai-codex.ts";
import { bearerHeaders } from "./providers/shared.ts";
import { SUPPORTED_PROVIDERS, type LoginMode, type ProviderId, type ProviderProtocol } from "./providers/types.ts";
import { homedir } from "node:os";
import { join } from "node:path";


const ANTHROPIC_AUTHORIZE = "https://claude.ai/oauth/authorize";

const ANTHROPIC_TOKEN = "https://platform.claude.com/v1/oauth/token";

export const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export const ANTHROPIC_SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

const ANTHROPIC_REDIRECT_PORT = 53692;


export const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const OPENAI_CODEX_AUTHORIZE = "https://auth.openai.com/oauth/authorize";

const OPENAI_CODEX_TOKEN = "https://auth.openai.com/oauth/token";

export const OPENAI_CODEX_SCOPES = "openid profile email offline_access";

const OPENAI_CODEX_REDIRECT_PORT = 1455;

const OPENAI_CODEX_REDIRECT_PATH = "/auth/callback";


export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

export const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";

const XAI_DEVICE_URL = "https://auth.x.ai/oauth2/device/code";

const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";

export const XAI_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export const XAI_DEFAULT_INTERVAL_MS = 5_000;

export const XAI_MIN_INTERVAL_MS = 1_000;

export const XAI_SLOW_DOWN_MS = 5_000;

export const XAI_DEFAULT_EXPIRES_MS = 5 * 60 * 1000;

export const XAI_POLL_MARGIN_MS = 3_000;


const OPENROUTER_AUTHORIZE = "https://openrouter.ai/auth";

const OPENROUTER_TOKEN = "https://openrouter.ai/api/v1/auth/keys";

const OPENROUTER_REDIRECT_PORT = 53693;


/** Public GitHub Copilot OAuth app for VS Code Copilot clients. */
export const GITHUB_COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";

export const GITHUB_DEVICE_URL = "https://github.com/login/device/code";

export const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

export const GITHUB_COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

export const GITHUB_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";


export function isSupportedProvider(id: string): id is ProviderId {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(id);
}


/** Probe order when no model/provider is pinned. ChatGPT OAuth beats an OpenAI API key. */
export const AUTH_PROVIDER_ORDER: ProviderId[] = [
  "anthropic",
  "openai-codex",
  "github-copilot",
  "openai",
  "xai",
  "google",
  "openrouter",
  "opencode-go",
  "opencode-zen",
];


export function providerProtocol(id: ProviderId, model = "", supportedEndpoints?: readonly string[]): ProviderProtocol {
  return providerDefinition(id).protocol(model, supportedEndpoints);
}


export function usesResponsesApi(id: ProviderId, model = "", supportedEndpoints?: readonly string[]): boolean {
  const proto = providerProtocol(id, model, supportedEndpoints);
  return proto === "openai-codex-responses" || proto === "openai-responses";
}


export function defaultLoginMode(id: ProviderId): LoginMode {
  return providerDefinition(id).loginMode;
}


export function authPath(): string {
  const override = process.env.TERMINA_AUTH_PATH;
  if (override) return override;
  return join(homedir(), ".termina", "agent", "auth.json");
}


function testOverride(name: string): string | undefined {
  if (process.env.TERMINA_CORE_TEST !== "1") return undefined;
  const raw = process.env[name]?.trim();
  return raw || undefined;
}


export function testLoopbackOverride(name: string): string | undefined {
  const raw = testOverride(name);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const octets = host.split(".");
    const loopback = host === "::1" || (
      octets.length === 4 &&
      octets[0] === "127" &&
      octets.slice(1).every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    );
    if (!loopback || (url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.hash) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}


export function authorizeUrl(id: ProviderId): string {
  const test = testLoopbackOverride("TERMINA_TEST_AUTHORIZE_URL");
  if (test) return test;
  if (id === "openai-codex") return OPENAI_CODEX_AUTHORIZE;
  if (id === "openrouter") return OPENROUTER_AUTHORIZE;
  return ANTHROPIC_AUTHORIZE;
}


export function tokenUrl(id: ProviderId): string {
  const test = testLoopbackOverride("TERMINA_TEST_TOKEN_URL");
  if (test) return test;
  if (id === "openai-codex") return OPENAI_CODEX_TOKEN;
  if (id === "xai") return XAI_TOKEN_URL;
  if (id === "openrouter") return OPENROUTER_TOKEN;
  return ANTHROPIC_TOKEN;
}


export function deviceUrl(): string {
  return testLoopbackOverride("TERMINA_TEST_DEVICE_URL") || XAI_DEVICE_URL;
}


export function redirectPort(id: ProviderId = "anthropic"): number {
  const raw = process.env.TERMINA_CORE_TEST === "1" ? process.env.TERMINA_TEST_REDIRECT_PORT : undefined;
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  }
  if (id === "openai-codex") return OPENAI_CODEX_REDIRECT_PORT;
  if (id === "openrouter") return OPENROUTER_REDIRECT_PORT;
  return ANTHROPIC_REDIRECT_PORT;
}


export function redirectPath(id: ProviderId, callbackToken?: string): string {
  const base = id === "openai-codex" ? OPENAI_CODEX_REDIRECT_PATH : "/callback";
  if (id !== "openrouter") return base;
  // Live OpenRouter docs do not document an authorize-URL `state` parameter
  // (https://openrouter.ai/docs/guides/overview/auth/oauth). Bind the
  // loopback listener to a one-time path token so a foreign `code` on the
  // well-known /callback path cannot win.
  if (!callbackToken || !/^[0-9a-f]{32}$/i.test(callbackToken)) {
    throw new Error("OpenRouter OAuth callback requires a one-time path token");
  }
  return `${base}/${callbackToken}`;
}


function redirectHost(id: ProviderId): string {
  return id === "openai-codex" ? "localhost" : "127.0.0.1";
}


export function redirectUri(id: ProviderId, port: number, callbackToken?: string): string {
  return `http://${redirectHost(id)}:${port}${redirectPath(id, callbackToken)}`;
}


export function openaiCodexClientVersion(): string {
  return OPENAI_CODEX_CLIENT_VERSION;
}


export function requestHeaders(providerId: ProviderId, token: string, extra?: Record<string, unknown>): Record<string, string> {
  return providerDefinition(providerId).headers?.(token, extra) ?? bearerHeaders(token);
}


export function providerProtocolHeaders(provider: ProviderId, headers: Record<string, string>, protocol: ProviderProtocol): Record<string, string> {
  const next = providerDefinition(provider).protocolHeaders?.(headers, protocol) ?? headers;
  return protocol === "google-generate" ? googleNativeHeaders(next) : next;
}


/** Zen Gemini generateContent forwards Bearer to Vertex and 401s. Use only the Google key header. */
export function googleNativeHeaders(headers: Record<string, string>): Record<string, string> {
  const token = (headers.authorization?.replace(/^Bearer\s+/i, "") || headers["x-api-key"] || "").trim();
  const next = { ...headers };
  delete next.authorization;
  delete next["x-api-key"];
  delete next["anthropic-version"];
  if (token) next["x-goog-api-key"] = token;
  return next;
}


export function needsRefresh(expires: unknown, now = Date.now()): boolean {
  return typeof expires === "number" && Number.isFinite(expires) && expires <= now;
}


export function maskSecret(token: string): string {
  const t = token.trim();
  if (t.length <= 4) return "…";
  return `…${t.slice(-4)}`;
}


export function validateCopilotApiUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (testLoopbackOverride("TERMINA_TEST_COPILOT_TOKEN_URL")) return `${url.origin}${url.pathname}`.replace(/\/$/, "");
    if (url.protocol !== "https:") return null;
    const host = url.hostname;
    if (host !== "api.githubcopilot.com" && !host.endsWith(".githubcopilot.com")) return null;
    return `${url.origin}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return null;
  }
}


export function baseUrl(id: ProviderId): string {
  const envName = providerDefinition(id).baseEnv;
  if (envName) {
    const raw = process.env[envName]?.trim();
    if (raw) return raw.replace(/\/$/, "");
  }
  return providerDefinition(id).baseUrl;
}
