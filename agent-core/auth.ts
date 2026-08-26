/**
 * Agent-core provider credentials.
 *
 * Own file: ~/.termina/agent/auth.json. This engine does not read or write
 * another product's credential store.
 *
 * Login shapes match the public flows Pi and OpenCode use for the same
 * providers (Claude Code PKCE, Codex CLI PKCE, xAI Grok-CLI device code,
 * OpenRouter PKCE-minted key). This file is the only credential owner.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

export const SUPPORTED_PROVIDERS = [
  "anthropic",
  "openai",
  "openai-codex",
  "github-copilot",
  "xai",
  "google",
  "openrouter",
] as const;
export type ProviderId = (typeof SUPPORTED_PROVIDERS)[number];
export type ProviderProtocol = "anthropic-messages" | "openai-completions" | "openai-codex-responses";
export type LoginMode = "browser" | "code" | "key" | "device";

const ANTHROPIC_AUTHORIZE = "https://claude.ai/oauth/authorize";
const ANTHROPIC_TOKEN = "https://platform.claude.com/v1/oauth/token";
const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const ANTHROPIC_REDIRECT_PORT = 53692;

const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_AUTHORIZE = "https://auth.openai.com/oauth/authorize";
const OPENAI_CODEX_TOKEN = "https://auth.openai.com/oauth/token";
const OPENAI_CODEX_SCOPES = "openid profile email offline_access";
const OPENAI_CODEX_REDIRECT_PORT = 1455;
const OPENAI_CODEX_REDIRECT_PATH = "/auth/callback";
/** ChatGPT's Codex backend gates on this originator. */
const OPENAI_CODEX_ORIGINATOR = "codex_cli_rs";
const OPENAI_CODEX_CLIENT_VERSION = "1.0.0";
const OPENAI_JWT_AUTH = "https://api.openai.com/auth";

const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_DEVICE_URL = "https://auth.x.ai/oauth2/device/code";
const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const XAI_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const XAI_DEFAULT_INTERVAL_MS = 5_000;
const XAI_MIN_INTERVAL_MS = 1_000;
const XAI_SLOW_DOWN_MS = 5_000;
const XAI_DEFAULT_EXPIRES_MS = 5 * 60 * 1000;
const XAI_POLL_MARGIN_MS = 3_000;

const OPENROUTER_AUTHORIZE = "https://openrouter.ai/auth";
const OPENROUTER_TOKEN = "https://openrouter.ai/api/v1/auth/keys";
const OPENROUTER_REDIRECT_PORT = 53693;

/** Same GitHub Copilot OAuth app Pi and OpenCode use (VS Code Copilot). */
const GITHUB_COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const GITHUB_DEVICE_URL = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const GITHUB_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const COPILOT_HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
  "user-agent": "GitHubCopilotChat/0.35.0",
  "editor-version": "vscode/1.107.0",
  "editor-plugin-version": "copilot-chat/0.35.0",
  "copilot-integration-id": "vscode-chat",
} as const;

const EXPIRE_MARGIN_MS = 300_000;
const OAT_MARK = "sk-ant-oat";
const DEFAULT_ANTHROPIC_BASE = "https://api.anthropic.com";

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
];

export type LoginKind = "oauth" | "key";

/** One row per login method. `/login openai oauth` is Codex; `/login openai key` is the API key. */
export const LOGIN_METHODS: {
  group: string;
  id: ProviderId;
  kind: LoginKind;
  mode: LoginMode;
  name: string;
  hint: string;
}[] = [
  { group: "anthropic", id: "anthropic", kind: "oauth", mode: "browser", name: "Anthropic", hint: "Claude Pro/Max" },
  { group: "anthropic", id: "anthropic", kind: "key", mode: "key", name: "Anthropic", hint: "API key" },
  { group: "openai", id: "openai-codex", kind: "oauth", mode: "browser", name: "OpenAI", hint: "ChatGPT Plus/Pro (Codex)" },
  { group: "openai", id: "openai", kind: "key", mode: "key", name: "OpenAI", hint: "API key" },
  { group: "github-copilot", id: "github-copilot", kind: "oauth", mode: "device", name: "GitHub Copilot", hint: "Copilot subscription" },
  { group: "github-copilot", id: "github-copilot", kind: "key", mode: "key", name: "GitHub Copilot", hint: "GitHub token" },
  { group: "xai", id: "xai", kind: "oauth", mode: "device", name: "xAI", hint: "Grok/X subscription" },
  { group: "xai", id: "xai", kind: "key", mode: "key", name: "xAI", hint: "API key" },
  { group: "openrouter", id: "openrouter", kind: "oauth", mode: "browser", name: "OpenRouter", hint: "sign-in mints an API key" },
  { group: "openrouter", id: "openrouter", kind: "key", mode: "key", name: "OpenRouter", hint: "API key" },
  { group: "google", id: "google", kind: "key", mode: "key", name: "Google Gemini", hint: "API key" },
];

/** OAuth rows use the provider name. API-key rows add (key). */
export function loginPickerLabel(method: { name: string; kind: LoginKind }): string {
  return method.kind === "key" ? `${method.name} (key)` : method.name;
}

export type LoginPickerItem = {
  label: string;
  hint: string;
  command: string;
};

export function loginPickerItems(cmd: "/login" | "/logout"): LoginPickerItem[] {
  return LOGIN_METHODS.map((m) => ({
    label: loginPickerLabel(m),
    hint: m.hint,
    command: `${cmd} ${m.group} ${m.kind}`,
  }));
}

const LOGIN_KIND_WORDS = new Set(["key", "oauth", "code", "device", "browser"]);

function loginKindFromWord(word: string): LoginKind | null {
  if (word === "key") return "key";
  if (word === "oauth" || word === "code" || word === "device" || word === "browser") return "oauth";
  return null;
}

export function resolveLoginPick(
  groupOrId: string,
  kindWord?: string,
): { provider: ProviderId; mode: LoginMode } | { error: string } {
  const byId = LOGIN_METHODS.filter((m) => m.id === groupOrId);
  const byGroup = LOGIN_METHODS.filter((m) => m.group === groupOrId);
  const methods = kindWord ? (byGroup.length > 0 ? byGroup : byId) : byId.length > 0 ? byId : byGroup;
  if (methods.length === 0) {
    if (!isSupportedProvider(groupOrId)) {
      return { error: `unsupported provider: ${groupOrId} (supported: ${[...new Set(LOGIN_METHODS.map((m) => m.group))].join(", ")})` };
    }
    const mode =
      kindWord && loginKindFromWord(kindWord) === "key"
        ? "key"
        : kindWord === "code"
          ? "code"
          : kindWord === "device"
            ? "device"
            : kindWord === "browser" || kindWord === "oauth"
              ? "browser"
              : defaultLoginMode(groupOrId);
    return { provider: groupOrId, mode };
  }
  const kind = kindWord ? loginKindFromWord(kindWord) : null;
  const picked =
    kind != null
      ? methods.find((m) => m.kind === kind)
      : methods.find((m) => m.mode === defaultLoginMode(m.id)) ?? methods[0];
  if (!picked) return { error: `${groupOrId} has no ${kindWord} login` };
  if (kindWord === "code") return { provider: picked.id, mode: "code" };
  if (kindWord === "device") return { provider: picked.id, mode: "device" };
  if (kindWord === "browser") return { provider: picked.id, mode: "browser" };
  return { provider: picked.id, mode: picked.mode };
}

export function providerProtocol(id: ProviderId): ProviderProtocol {
  if (id === "anthropic") return "anthropic-messages";
  if (id === "openai-codex") return "openai-codex-responses";
  return "openai-completions";
}

export function defaultLoginMode(id: ProviderId): LoginMode {
  if (id === "xai" || id === "github-copilot") return "device";
  if (id === "openai" || id === "google") return "key";
  return "browser";
}

export function authPath(): string {
  const override = process.env.TERMINA_AUTH_PATH;
  if (override) return override;
  return join(homedir(), ".termina", "agent", "auth.json");
}

function testOverride(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw || undefined;
}

function authorizeUrl(id: ProviderId): string {
  const test = testOverride("TERMINA_TEST_AUTHORIZE_URL");
  if (test) return test;
  if (id === "openai-codex") return OPENAI_CODEX_AUTHORIZE;
  if (id === "openrouter") return OPENROUTER_AUTHORIZE;
  return ANTHROPIC_AUTHORIZE;
}

function tokenUrl(id: ProviderId): string {
  const test = testOverride("TERMINA_TEST_TOKEN_URL");
  if (test) return test;
  if (id === "openai-codex") return OPENAI_CODEX_TOKEN;
  if (id === "xai") return XAI_TOKEN_URL;
  if (id === "openrouter") return OPENROUTER_TOKEN;
  return ANTHROPIC_TOKEN;
}

function deviceUrl(): string {
  return testOverride("TERMINA_TEST_DEVICE_URL") || XAI_DEVICE_URL;
}

export function redirectPort(id: ProviderId = "anthropic"): number {
  const raw = process.env.TERMINA_TEST_REDIRECT_PORT;
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  }
  if (id === "openai-codex") return OPENAI_CODEX_REDIRECT_PORT;
  if (id === "openrouter") return OPENROUTER_REDIRECT_PORT;
  return ANTHROPIC_REDIRECT_PORT;
}

function redirectPath(id: ProviderId): string {
  return id === "openai-codex" ? OPENAI_CODEX_REDIRECT_PATH : "/callback";
}

function redirectHost(id: ProviderId): string {
  return id === "openai-codex" ? "localhost" : "127.0.0.1";
}

function redirectUri(id: ProviderId, port: number): string {
  return `http://${redirectHost(id)}:${port}${redirectPath(id)}`;
}

export function isOAuthToken(token: string): boolean {
  return token.includes(OAT_MARK);
}

export function pickHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (isOAuthToken(token)) {
    headers.authorization = `Bearer ${token}`;
    headers["anthropic-beta"] = "claude-code-20250219,oauth-2025-04-20";
    headers["user-agent"] = "termina-agent-core/1";
    headers["x-app"] = "cli";
  } else {
    headers["x-api-key"] = token;
  }
  return headers;
}

export function openaiCodexClientVersion(): string {
  return OPENAI_CODEX_CLIENT_VERSION;
}

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

export function requestHeaders(
  providerId: ProviderId,
  token: string,
  extra?: Record<string, unknown>,
): Record<string, string> {
  if (providerId === "anthropic") return pickHeaders(token);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    "user-agent": "termina-agent-core/1",
  };
  if (providerId === "openai-codex") {
    const account =
      (typeof extra?.accountId === "string" && extra.accountId) || extractAccountId(token) || "";
    if (account) headers["chatgpt-account-id"] = account;
    headers.originator = OPENAI_CODEX_ORIGINATOR;
    headers["user-agent"] = `codex_cli_rs/${OPENAI_CODEX_CLIENT_VERSION}`;
    headers["openai-beta"] = "responses=experimental";
  }
  if (providerId === "openrouter") {
    headers["http-referer"] = "https://termina.local";
    headers["x-title"] = "Termina agent-core";
  }
  if (providerId === "github-copilot") {
    headers["editor-version"] = COPILOT_HEADERS["editor-version"];
    headers["editor-plugin-version"] = COPILOT_HEADERS["editor-plugin-version"];
    headers["copilot-integration-id"] = COPILOT_HEADERS["copilot-integration-id"];
    headers["user-agent"] = COPILOT_HEADERS["user-agent"];
  }
  return headers;
}

export function needsRefresh(expires: unknown, now = Date.now()): boolean {
  return typeof expires === "number" && Number.isFinite(expires) && expires <= now;
}

export function maskSecret(token: string): string {
  const t = token.trim();
  if (t.length <= 4) return "…";
  return `…${t.slice(-4)}`;
}

export function parseOauthToken(
  payload: unknown,
  now = Date.now(),
  opts: { requireRefresh?: boolean; previousRefresh?: string; defaultExpiresIn?: number } = {},
): { ok: true; access: string; refresh: string; expires: number } | { ok: false; error: string } {
  if (!payload || typeof payload !== "object") return { ok: false, error: "invalid token response" };
  const rec = payload as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  if (typeof rec.access_token !== "string" || !rec.access_token) return { ok: false, error: "token response missing access_token" };
  const refresh =
    typeof rec.refresh_token === "string" && rec.refresh_token
      ? rec.refresh_token
      : opts.previousRefresh ?? "";
  if (!refresh && opts.requireRefresh !== false) return { ok: false, error: "token response missing refresh_token" };
  let expiresIn = typeof rec.expires_in === "number" ? rec.expires_in : Number(rec.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    if (opts.defaultExpiresIn && opts.defaultExpiresIn > 0) expiresIn = opts.defaultExpiresIn;
    else return { ok: false, error: "token response missing expires_in" };
  }
  return {
    ok: true,
    access: rec.access_token,
    refresh,
    expires: now + expiresIn * 1000 - EXPIRE_MARGIN_MS,
  };
}

export function parseTokenResponse(
  payload: unknown,
  now = Date.now(),
): { ok: true; access: string; refresh: string; expires: number } | { ok: false; error: string } {
  return parseOauthToken(payload, now, { requireRefresh: true });
}

type AuthFile = Record<string, unknown>;

let cached: { path: string; mtimeMs: number; data: AuthFile } | null = null;
const refreshFlights = new Map<string, Promise<{ ok: true } | { ok: false; error: string }>>();

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function extraApiUrl(entry: Record<string, unknown>): string | null {
  const raw = typeof entry.apiUrl === "string" ? entry.apiUrl.trim() : "";
  return raw ? validateCopilotApiUrl(raw) : null;
}

export function validateCopilotApiUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (testOverride("TERMINA_TEST_COPILOT_TOKEN_URL")) return `${url.origin}${url.pathname}`.replace(/\/$/, "");
    if (url.protocol !== "https:") return null;
    const host = url.hostname;
    if (host !== "api.githubcopilot.com" && !host.endsWith(".githubcopilot.com")) return null;
    return `${url.origin}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sleepAsync(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("login cancelled"));
      return;
    }
    const onDone = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const t = setTimeout(onDone, ms);
    const onAbort = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("login cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function withLock<T>(fn: () => T): T {
  const lock = `${authPath()}.lock`;
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      try {
        writeSync(fd, String(process.pid));
        return fn();
      } finally {
        closeSync(fd);
        try {
          unlinkSync(lock);
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      if (Date.now() - start > 4000) {
        try {
          unlinkSync(lock);
        } catch {
          /* ignore */
        }
      }
      if (Date.now() - start > 6000) throw new Error("auth file busy");
      sleep(50);
    }
  }
}

export function readAuth(): { ok: true; data: AuthFile } | { ok: false; reason: "missing" | "corrupt" } {
  const path = authPath();
  if (!existsSync(path)) {
    cached = null;
    return { ok: false, reason: "missing" };
  }
  try {
    const st = statSync(path);
    if (cached && cached.path === path && cached.mtimeMs === st.mtimeMs) return { ok: true, data: cached.data };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isObject(parsed)) {
      cached = null;
      return { ok: false, reason: "corrupt" };
    }
    cached = { path, mtimeMs: st.mtimeMs, data: parsed };
    return { ok: true, data: parsed };
  } catch {
    cached = null;
    return { ok: false, reason: "corrupt" };
  }
}

function writeAuth(data: AuthFile): void {
  const path = authPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    const st = statSync(path);
    cached = { path, mtimeMs: st.mtimeMs, data };
  } catch {
    cached = { path, mtimeMs: Date.now(), data };
  }
}

export function modifyProvider(id: string, fn: (current: unknown) => unknown | null): void {
  withLock(() => {
    const got = readAuth();
    if (!got.ok && got.reason === "corrupt") {
      throw new Error("auth.json is unreadable — refusing to write");
    }
    const data: AuthFile = got.ok ? { ...got.data } : {};
    const next = fn(data[id]);
    if (next === null) delete data[id];
    else data[id] = next;
    writeAuth(data);
  });
}

export type ResolvedAuth =
  | {
      ok: true;
      providerId: ProviderId;
      token: string;
      kind: "oauth" | "api_key";
      source: "oauth" | "api_key" | "env";
      envName?: string;
      baseUrl: string;
      headers: Record<string, string>;
    }
  | { ok: false; error: string };

const DEFAULT_BASE: Record<ProviderId, string> = {
  anthropic: DEFAULT_ANTHROPIC_BASE,
  openai: "https://api.openai.com/v1",
  "openai-codex": "https://chatgpt.com/backend-api",
  "github-copilot": "https://api.individual.githubcopilot.com",
  xai: "https://api.x.ai/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  openrouter: "https://openrouter.ai/api/v1",
};

const BASE_ENV: Partial<Record<ProviderId, string>> = {
  anthropic: "ANTHROPIC_BASE_URL",
  openai: "OPENAI_BASE_URL",
  xai: "XAI_BASE_URL",
  openrouter: "OPENROUTER_BASE_URL",
};

const ENV_KEYS: Record<ProviderId, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  openai: ["OPENAI_API_KEY"],
  "openai-codex": [],
  "github-copilot": [],
  xai: ["XAI_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
};

export const DEFAULT_MODELS: Record<ProviderId, { main: string; summary: string }> = {
  anthropic: { main: "claude-sonnet-4-5", summary: "claude-haiku-4-5" },
  openai: { main: "gpt-5", summary: "gpt-4.1-mini" },
  "openai-codex": { main: "gpt-5.4", summary: "gpt-5.4-mini" },
  "github-copilot": { main: "gpt-4.1", summary: "gpt-4.1-mini" },
  xai: { main: "grok-4.3", summary: "grok-4.3" },
  google: { main: "gemini-2.5-flash", summary: "gemini-2.5-flash" },
  openrouter: { main: "openai/gpt-4o-mini", summary: "openai/gpt-4o-mini" },
};

export function parseModelRef(
  raw: string,
  override?: string,
): { provider: ProviderId; model: string } {
  const trimmed = raw.trim();
  if (override && isSupportedProvider(override)) {
    const prefix = `${override}/`;
    const model = trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
    return { provider: override, model: model || DEFAULT_MODELS[override].main };
  }
  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    const head = trimmed.slice(0, slash);
    if (isSupportedProvider(head)) {
      return { provider: head, model: trimmed.slice(slash + 1) };
    }
  }
  if (trimmed.startsWith("claude") || trimmed.startsWith("haiku")) return { provider: "anthropic", model: trimmed };
  if (trimmed.startsWith("grok")) return { provider: "xai", model: trimmed };
  if (trimmed.startsWith("gemini") || trimmed.startsWith("gemma")) return { provider: "google", model: trimmed };
  if (/^(gpt-|o1|o3|o4|chatgpt)/.test(trimmed)) return { provider: "openai", model: trimmed };
  return { provider: "anthropic", model: trimmed || DEFAULT_MODELS.anthropic.main };
}

function baseUrl(id: ProviderId): string {
  const envName = BASE_ENV[id];
  if (envName) {
    const raw = process.env[envName]?.trim();
    if (raw) return raw.replace(/\/$/, "");
  }
  return DEFAULT_BASE[id];
}

function envToken(id: ProviderId): { token: string; envName: string } | null {
  for (const name of ENV_KEYS[id]) {
    const value = process.env[name]?.trim();
    if (value) return { token: value, envName: name };
  }
  return null;
}

/** Stored entry exists. Does not refresh and does not consult env. */
export function hasStoredCredential(id: string): boolean {
  if (!isSupportedProvider(id)) return false;
  const got = readAuth();
  if (!got.ok) return false;
  const stored = fromStored(id, got.data[id]);
  if (!stored) return false;
  if ("needsOauthRefresh" in stored) return true;
  return stored.ok;
}

export function hasEnvCredential(id: string): boolean {
  if (!isSupportedProvider(id)) return false;
  return envToken(id) !== null;
}

/** Stored credentials win over ambient env so a leftover ANTHROPIC_API_KEY
 *  does not hide a stored xAI or OpenAI login. */
export function firstAuthenticatedProvider(): ProviderId | null {
  for (const id of AUTH_PROVIDER_ORDER) {
    if (hasStoredCredential(id)) return id;
  }
  for (const id of AUTH_PROVIDER_ORDER) {
    if (hasEnvCredential(id)) return id;
  }
  return null;
}

function fromStored(
  id: ProviderId,
  entry: unknown,
): ResolvedAuth | { needsOauthRefresh: true; refresh: string; extra: Record<string, unknown> } | null {
  if (!isObject(entry) || typeof entry.type !== "string") return null;
  if (entry.type === "api_key") {
    const key = typeof entry.key === "string" ? entry.key.trim() : "";
    if (!key) return null;
    return {
      ok: true,
      providerId: id,
      token: key,
      kind: "api_key",
      source: "api_key",
      baseUrl: baseUrl(id),
      headers: requestHeaders(id, key, entry),
    };
  }
  if (entry.type === "oauth") {
    const access = typeof entry.access === "string" ? entry.access : "";
    const refresh = typeof entry.refresh === "string" ? entry.refresh : "";
    if (!access || !refresh) return null;
    if (needsRefresh(entry.expires)) return { needsOauthRefresh: true, refresh, extra: entry };
    const storedBase = extraApiUrl(entry);
    return {
      ok: true,
      providerId: id,
      token: access,
      kind: "oauth",
      source: "oauth",
      baseUrl: storedBase || baseUrl(id),
      headers: requestHeaders(id, access, entry),
    };
  }
  return null;
}

export function authBanner(auth: ResolvedAuth): string {
  if (!auth.ok) return "auth: none";
  const who = auth.providerId === "anthropic" ? "" : `${auth.providerId} `;
  if (auth.source === "env") return `auth: ${who}env ${auth.envName ?? ENV_KEYS[auth.providerId][0] ?? "API_KEY"}`.replace("  ", " ");
  if (auth.source === "oauth") return `auth: ${who}oauth (${maskSecret(auth.token)})`.replace("  ", " ");
  return `auth: ${who}api_key (auth.json)`.replace("  ", " ");
}

function missingCredentialError(id: ProviderId): string {
  const env = ENV_KEYS[id][0];
  if (env) return `no ${id} credential — run /login ${id} or set ${env}`;
  return `no ${id} credential — run /login ${id}`;
}

async function postJson(
  url: string,
  body: unknown,
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>,
): Promise<{ ok: boolean; status: number; payload: unknown; raw: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...extraHeaders },
    body: JSON.stringify(body),
    signal,
  });
  const raw = await res.text();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }
  return { ok: res.ok, status: res.status, payload, raw };
}

async function postForm(url: string, fields: Record<string, string>, signal?: AbortSignal): Promise<{ ok: boolean; status: number; payload: unknown; raw: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields).toString(),
    signal,
  });
  const raw = await res.text();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }
  return { ok: res.ok, status: res.status, payload, raw };
}

function persistOauth(
  providerId: ProviderId,
  parsed: { access: string; refresh: string; expires: number },
  extra: Record<string, unknown> = {},
): { ok: true } | { ok: false; error: string } {
  try {
    modifyProvider(providerId, (current) => {
      const cur = isObject(current) ? current : {};
      const accountId =
        providerId === "openai-codex"
          ? extractAccountId(parsed.access) ?? (typeof extra.accountId === "string" ? extra.accountId : undefined)
          : undefined;
      return {
        ...cur,
        ...extra,
        type: "oauth",
        access: parsed.access,
        refresh: parsed.refresh,
        expires: parsed.expires,
        ...(accountId ? { accountId } : {}),
      };
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return { ok: true };
}

function persistApiKey(providerId: ProviderId, key: string): { ok: true } | { ok: false; error: string } {
  try {
    modifyProvider(providerId, (current) => {
      const cur = isObject(current) ? current : {};
      return { ...cur, type: "api_key", key };
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return { ok: true };
}

export async function refreshOauth(providerId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isSupportedProvider(providerId)) return { ok: false, error: `unsupported provider: ${providerId}` };
  const inflight = refreshFlights.get(providerId);
  if (inflight) return inflight;
  const run: Promise<{ ok: true } | { ok: false; error: string }> = (async () => {
    try {
      try {
        const got = readAuth();
        if (!got.ok) return { ok: false, error: "auth expired — run /login" };
        const entry = got.data[providerId];
        if (!isObject(entry) || entry.type !== "oauth" || typeof entry.refresh !== "string") {
          return { ok: false, error: "auth expired — run /login" };
        }
        let parsed: ReturnType<typeof parseOauthToken>;
        let extra: Record<string, unknown> = entry;
        if (providerId === "anthropic") {
          const res = await postJson(tokenUrl(providerId), {
            grant_type: "refresh_token",
            refresh_token: entry.refresh,
            client_id: ANTHROPIC_CLIENT_ID,
          });
          parsed = parseTokenResponse(res.payload);
        } else if (providerId === "openai-codex") {
          const res = await postForm(tokenUrl(providerId), {
            grant_type: "refresh_token",
            refresh_token: entry.refresh,
            client_id: OPENAI_CODEX_CLIENT_ID,
          });
          parsed = parseTokenResponse(res.payload);
        } else if (providerId === "xai") {
          const res = await postForm(tokenUrl(providerId), {
            grant_type: "refresh_token",
            refresh_token: entry.refresh,
            client_id: XAI_CLIENT_ID,
          });
          parsed = parseOauthToken(res.payload, Date.now(), {
            requireRefresh: false,
            previousRefresh: entry.refresh,
            defaultExpiresIn: 3600,
          });
        } else if (providerId === "github-copilot") {
          const session = await exchangeGithubCopilotToken(entry.refresh);
          if (!session.ok) return { ok: false, error: "auth expired — run /login" };
          parsed = {
            ok: true,
            access: session.access,
            refresh: entry.refresh,
            expires: session.expires,
          };
          extra = { ...(isObject(entry) ? entry : {}), apiUrl: session.apiUrl };
        } else {
          return { ok: true };
        }
        if (!parsed.ok) return { ok: false, error: "auth expired — run /login" };
        const stored = persistOauth(providerId, parsed, extra);
        if (!stored.ok) return { ok: false, error: "auth expired — run /login" };
        return { ok: true };
      } catch {
        return { ok: false, error: "auth expired — run /login" };
      }
    } finally {
      refreshFlights.delete(providerId);
    }
  })();
  refreshFlights.set(providerId, run);
  return run;
}

export async function resolveAuth(providerId: string = "anthropic"): Promise<ResolvedAuth> {
  if (!isSupportedProvider(providerId)) return { ok: false, error: `unsupported provider: ${providerId}` };
  const got = readAuth();
  if (got.ok) {
    const stored = fromStored(providerId, got.data[providerId]);
    if (stored && "needsOauthRefresh" in stored) {
      const refreshed = await refreshOauth(providerId);
      if (!refreshed.ok) return { ok: false, error: refreshed.error };
      const again = readAuth();
      if (again.ok) {
        const next = fromStored(providerId, again.data[providerId]);
        if (next && !("needsOauthRefresh" in next) && next.ok) return next;
      }
      return { ok: false, error: "auth expired — run /login" };
    }
    if (stored && stored.ok) return stored;
  } else if (got.reason === "corrupt") {
    process.stderr.write("agent-core: auth.json is unreadable — using env only\n");
  }
  const env = envToken(providerId);
  if (env) {
    return {
      ok: true,
      providerId,
      token: env.token,
      kind: "api_key",
      source: "env",
      envName: env.envName,
      baseUrl: baseUrl(providerId),
      headers: requestHeaders(providerId, env.token),
    };
  }
  return { ok: false, error: missingCredentialError(providerId) };
}

function pkce(): { verifier: string; challenge: string; state: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");
  return { verifier, challenge, state };
}

function buildAnthropicAuthorizeUrl(challenge: string, state: string, port: number): string {
  const u = new URL(authorizeUrl("anthropic"));
  u.searchParams.set("client_id", ANTHROPIC_CLIENT_ID);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", redirectUri("anthropic", port));
  u.searchParams.set("scope", ANTHROPIC_SCOPES);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

function buildCodexAuthorizeUrl(challenge: string, state: string, port: number): string {
  const u = new URL(authorizeUrl("openai-codex"));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", OPENAI_CODEX_CLIENT_ID);
  u.searchParams.set("redirect_uri", redirectUri("openai-codex", port));
  u.searchParams.set("scope", OPENAI_CODEX_SCOPES);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  u.searchParams.set("id_token_add_organizations", "true");
  u.searchParams.set("codex_cli_simplified_flow", "true");
  u.searchParams.set("originator", OPENAI_CODEX_ORIGINATOR);
  return u.toString();
}

function buildOpenRouterAuthorizeUrl(challenge: string, callback: string): string {
  const u = new URL(authorizeUrl("openrouter"));
  u.searchParams.set("callback_url", callback);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

async function exchangeAnthropic(code: string, verifier: string, port: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await postJson(tokenUrl("anthropic"), {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri("anthropic", port),
    client_id: ANTHROPIC_CLIENT_ID,
    code_verifier: verifier,
  });
  const parsed = parseTokenResponse(res.payload);
  if (!parsed.ok) return { ok: false, error: `login failed: ${parsed.error}` };
  return persistOauth("anthropic", parsed);
}

async function exchangeCodex(code: string, verifier: string, port: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await postForm(tokenUrl("openai-codex"), {
    grant_type: "authorization_code",
    client_id: OPENAI_CODEX_CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri("openai-codex", port),
  });
  const parsed = parseTokenResponse(res.payload);
  if (!parsed.ok) return { ok: false, error: `login failed: ${parsed.error}` };
  const rec = isObject(res.payload) ? res.payload : {};
  const idToken = typeof rec.id_token === "string" ? rec.id_token : "";
  const accountId = extractAccountId(parsed.access) || extractAccountId(idToken) || undefined;
  return persistOauth("openai-codex", parsed, accountId ? { accountId } : {});
}

async function exchangeOpenRouter(code: string, verifier: string, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await postJson(
    tokenUrl("openrouter"),
    { code, code_verifier: verifier, code_challenge_method: "S256" },
    signal,
  );
  const rec = isObject(res.payload) ? res.payload : {};
  const key = typeof rec.key === "string" ? rec.key : "";
  if (!res.ok || !key) return { ok: false, error: "login failed: OpenRouter key exchange failed" };
  return persistApiKey("openrouter", key);
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    /* not a URL */
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
  }
  return { code: value };
}

function isOauthCancelError(err: string): boolean {
  return err === "access_denied" || err === "login_cancelled" || err === "user_cancelled";
}

function loginCallbackTimeoutMs(): number | null {
  const raw = process.env.TERMINA_TEST_LOGIN_TIMEOUT_MS?.trim();
  if (raw === "0") return null;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (process.env.TERMINA_CORE_TEST === "1") return null;
  return 3 * 60 * 1000;
}

function waitForCallback(
  port: number,
  path: string,
  expectedState: string | null,
  signal?: AbortSignal,
): Promise<{ code: string } | { error: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: { code: string } | { error: string }) => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", onAbort);
      server.close();
      resolve(result);
    };
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== path) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const err = url.searchParams.get("error");
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (err) {
        const cancelled = isOauthCancelError(err);
        res.end(cancelled ? "<p>Login cancelled. You can close this tab.</p>" : "<p>Login failed. You can close this tab.</p>");
        finish({ error: cancelled ? "login cancelled" : `login failed: ${err}` });
        return;
      }
      if (expectedState && state !== expectedState) {
        res.end("<p>Login failed (state mismatch). You can close this tab.</p>");
        finish({ error: "login failed: state mismatch" });
        return;
      }
      if (!code) {
        res.end("<p>Login failed (missing code). You can close this tab.</p>");
        finish({ error: "login failed: missing code" });
        return;
      }
      res.end("<p>Termina agent-core is signed in. You can close this tab.</p>");
      finish({ code });
    });
    const onAbort = () => finish({ error: "login cancelled" });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    server.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") finish({ error: `port ${port} busy — another login may be running` });
      else finish({ error: `login failed: ${(err as Error).message}` });
    });
    server.listen(port, "127.0.0.1", () => {
      if (done) server.close();
    });
  });
}

export function canOpenBrowser(): boolean {
  if (process.platform === "darwin") return true;
  if (process.platform === "linux") {
    if (process.env.SSH_CONNECTION) return false;
    return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  }
  return false;
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* ignore */
  }
}

export type LoginIo = {
  write: (text: string) => void;
  waitForCode?: () => Promise<string>;
  openUrl?: (url: string) => void;
  signal?: AbortSignal;
};

function openAuthorize(url: string, io: LoginIo): void {
  if (io.openUrl) io.openUrl(url);
  else if (canOpenBrowser()) openBrowser(url);
}

async function collectCode(
  providerId: ProviderId,
  mode: LoginMode,
  url: string,
  state: string,
  io: LoginIo,
): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  const port = redirectPort(providerId);
  io.write(`authorize: ${url}\n`);
  if (mode === "code") {
    if (!io.waitForCode) return { ok: false, error: "login failed: no code input" };
    io.write("paste the authorization code or redirect URL, then press enter\n");
    const parsed = parseAuthorizationInput(await io.waitForCode());
    if (parsed.state && parsed.state !== state) return { ok: false, error: "login failed: state mismatch" };
    if (!parsed.code) return { ok: false, error: "login failed: empty code" };
    return { ok: true, code: parsed.code };
  }
  if (!io.openUrl && !canOpenBrowser()) return { ok: false, error: "no browser — use /login code" };
  if (io.signal?.aborted) return { ok: false, error: "login cancelled" };
  openAuthorize(url, io);
  io.write("waiting for browser — finish sign-in or Ctrl+C to cancel\n");
  const timeoutMs = loginCallbackTimeoutMs();
  const ac = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onUserAbort = () => ac.abort();
  if (timeoutMs) {
    timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, timeoutMs);
  }
  io.signal?.addEventListener("abort", onUserAbort, { once: true });
  if (io.signal?.aborted) ac.abort();
  try {
    const expectedState = providerId === "openrouter" ? null : state;
    const waited = await waitForCallback(port, redirectPath(providerId), expectedState, ac.signal);
    if ("error" in waited) {
      if (timedOut && !io.signal?.aborted) {
        return { ok: false, error: "login cancelled — browser closed or timed out" };
      }
      return { ok: false, error: waited.error };
    }
    return { ok: true, code: waited.code };
  } finally {
    if (timer) clearTimeout(timer);
    io.signal?.removeEventListener("abort", onUserAbort);
  }
}

function validateVerificationUri(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Untrusted verification URI in xAI OAuth response");
  }
  if (url.protocol !== "https:" && !testOverride("TERMINA_TEST_DEVICE_URL")) {
    throw new Error("Untrusted verification URI in xAI OAuth response");
  }
  return url.href;
}

function intervalMs(value: unknown, fallback: number, min: number): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return Math.max(fallback, min);
  return Math.max(seconds * 1000, min);
}

function positiveMs(value: unknown, fallback: number): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallback;
}

export async function requestXaiDeviceCode(signal?: AbortSignal): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  expiresMs: number;
}> {
  const res = await postForm(
    deviceUrl(),
    { client_id: XAI_CLIENT_ID, scope: XAI_SCOPE, referrer: "termina" },
    signal,
  );
  if (!res.ok || !isObject(res.payload)) {
    throw new Error(`xAI device authorization failed (HTTP ${res.status})`);
  }
  const deviceCode = typeof res.payload.device_code === "string" ? res.payload.device_code : "";
  const userCode = typeof res.payload.user_code === "string" ? res.payload.user_code : "";
  const verification =
    typeof res.payload.verification_uri_complete === "string" && res.payload.verification_uri_complete
      ? res.payload.verification_uri_complete
      : typeof res.payload.verification_uri === "string"
        ? res.payload.verification_uri
        : "";
  if (!deviceCode || !userCode || !verification) {
    throw new Error("xAI device code response is missing fields");
  }
  return {
    deviceCode,
    userCode,
    verificationUri: validateVerificationUri(verification),
    intervalMs: intervalMs(
      res.payload.interval,
      XAI_DEFAULT_INTERVAL_MS,
      testOverride("TERMINA_TEST_DEVICE_URL") ? 0 : XAI_MIN_INTERVAL_MS,
    ),
    expiresMs: positiveMs(res.payload.expires_in, XAI_DEFAULT_EXPIRES_MS),
  };
}

export async function pollXaiDeviceToken(
  device: { deviceCode: string; intervalMs: number; expiresMs: number },
  signal?: AbortSignal,
): Promise<{ ok: true; access: string; refresh: string; expires: number } | { ok: false; error: string }> {
  const deadline = Date.now() + device.expiresMs;
  let intervalMs = device.intervalMs;
  while (Date.now() < deadline) {
    const wait = Math.min(intervalMs + (testOverride("TERMINA_TEST_DEVICE_URL") ? 0 : XAI_POLL_MARGIN_MS), Math.max(0, deadline - Date.now()));
    if (wait > 0) await sleepAsync(wait, signal);
    const res = await postForm(
      tokenUrl("xai"),
      {
        grant_type: XAI_DEVICE_GRANT,
        client_id: XAI_CLIENT_ID,
        device_code: device.deviceCode,
      },
      signal,
    );
    if (res.ok) {
      const parsed = parseOauthToken(res.payload, Date.now(), { requireRefresh: true, defaultExpiresIn: 3600 });
      if (!parsed.ok) return { ok: false, error: `login failed: ${parsed.error}` };
      return parsed;
    }
    const err = isObject(res.payload) && typeof res.payload.error === "string" ? res.payload.error : "";
    if (err === "authorization_pending") continue;
    if (err === "slow_down") {
      intervalMs += XAI_SLOW_DOWN_MS;
      continue;
    }
    if (err === "access_denied" || err === "authorization_denied") return { ok: false, error: "xAI device authorization was denied" };
    if (err === "expired_token") return { ok: false, error: "xAI device code expired" };
    return { ok: false, error: `xAI device token exchange failed (HTTP ${res.status})` };
  }
  return { ok: false, error: "xAI device authorization timed out" };
}

async function loginKey(providerId: ProviderId, io: LoginIo): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!io.waitForCode) return { ok: false, error: "login failed: no key input" };
  const env = ENV_KEYS[providerId][0] ?? "API_KEY";
  io.write(`paste the ${providerId} API key (${env}), then press enter\n`);
  const key = (await io.waitForCode()).trim();
  if (!key) return { ok: false, error: "login failed: empty key" };
  return persistApiKey(providerId, key);
}

async function loginXaiDevice(io: LoginIo): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const device = await requestXaiDeviceCode(io.signal);
    io.write(`Open ${device.verificationUri} and enter code: ${device.userCode}\n`);
    openAuthorize(device.verificationUri, io);
    const tokens = await pollXaiDeviceToken(device, io.signal);
    if (!tokens.ok) return tokens;
    return persistOauth("xai", tokens);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function githubDeviceUrl(): string {
  return testOverride("TERMINA_TEST_DEVICE_URL") || GITHUB_DEVICE_URL;
}

function githubAccessUrl(): string {
  return testOverride("TERMINA_TEST_TOKEN_URL") || GITHUB_ACCESS_TOKEN_URL;
}

function copilotSessionUrl(): string {
  return testOverride("TERMINA_TEST_COPILOT_TOKEN_URL") || GITHUB_COPILOT_TOKEN_URL;
}

function validateGithubVerificationUri(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Untrusted verification URI in GitHub OAuth response");
  }
  if (url.protocol !== "https:" && !testOverride("TERMINA_TEST_DEVICE_URL")) {
    throw new Error("Untrusted verification URI in GitHub OAuth response");
  }
  if (!testOverride("TERMINA_TEST_DEVICE_URL") && url.hostname !== "github.com" && !url.hostname.endsWith(".github.com")) {
    throw new Error("Untrusted verification URI in GitHub OAuth response");
  }
  return url.href;
}

export async function requestGithubDeviceCode(signal?: AbortSignal): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  expiresMs: number;
}> {
  const res = await postJson(
    githubDeviceUrl(),
    { client_id: GITHUB_COPILOT_CLIENT_ID, scope: "read:user" },
    signal,
    { accept: "application/json", "user-agent": COPILOT_HEADERS["user-agent"] },
  );
  if (!res.ok || !isObject(res.payload)) {
    throw new Error(`GitHub device authorization failed (HTTP ${res.status})`);
  }
  const deviceCode = typeof res.payload.device_code === "string" ? res.payload.device_code : "";
  const userCode = typeof res.payload.user_code === "string" ? res.payload.user_code : "";
  const verification = typeof res.payload.verification_uri === "string" ? res.payload.verification_uri : "";
  if (!deviceCode || !userCode || !verification) {
    throw new Error("GitHub device code response is missing fields");
  }
  return {
    deviceCode,
    userCode,
    verificationUri: validateGithubVerificationUri(verification),
    intervalMs: intervalMs(res.payload.interval, 5_000, testOverride("TERMINA_TEST_DEVICE_URL") ? 0 : 1_000),
    expiresMs: positiveMs(res.payload.expires_in, 15 * 60 * 1000),
  };
}

export async function pollGithubDeviceToken(
  device: { deviceCode: string; intervalMs: number; expiresMs: number },
  signal?: AbortSignal,
): Promise<{ ok: true; githubToken: string } | { ok: false; error: string }> {
  const deadline = Date.now() + device.expiresMs;
  let waitMs = device.intervalMs;
  while (Date.now() < deadline) {
    const res = await postJson(
      githubAccessUrl(),
      {
        client_id: GITHUB_COPILOT_CLIENT_ID,
        device_code: device.deviceCode,
        grant_type: GITHUB_DEVICE_GRANT,
      },
      signal,
      { accept: "application/json", "user-agent": COPILOT_HEADERS["user-agent"] },
    );
    if (isObject(res.payload) && typeof res.payload.access_token === "string" && res.payload.access_token) {
      return { ok: true, githubToken: res.payload.access_token };
    }
    const err = isObject(res.payload) && typeof res.payload.error === "string" ? res.payload.error : "";
    if (err === "access_denied") return { ok: false, error: "GitHub device authorization was denied" };
    if (err === "expired_token") return { ok: false, error: "GitHub device code expired" };
    if (err === "slow_down") waitMs += 5_000;
    else if (err && err !== "authorization_pending") {
      return { ok: false, error: `GitHub device token exchange failed (HTTP ${res.status})` };
    } else if (!res.ok && err !== "authorization_pending") {
      return { ok: false, error: `GitHub device token exchange failed (HTTP ${res.status})` };
    }
    const wait = Math.min(waitMs, Math.max(0, deadline - Date.now()));
    if (wait > 0) await sleepAsync(wait, signal);
  }
  return { ok: false, error: "GitHub device authorization timed out" };
}

export async function exchangeGithubCopilotToken(
  githubToken: string,
  signal?: AbortSignal,
): Promise<{ ok: true; access: string; expires: number; apiUrl: string } | { ok: false; error: string }> {
  const res = await fetch(copilotSessionUrl(), {
    method: "GET",
    headers: {
      ...COPILOT_HEADERS,
      authorization: `Bearer ${githubToken}`,
    },
    signal,
  });
  const raw = await res.text();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }
  if (!res.ok || !isObject(payload) || typeof payload.token !== "string" || !payload.token) {
    return { ok: false, error: `Copilot session token failed (HTTP ${res.status})` };
  }
  const endpoints = isObject(payload.endpoints) ? payload.endpoints : {};
  const reported = typeof endpoints.api === "string" ? endpoints.api : "";
  const apiUrl = validateCopilotApiUrl(reported) || DEFAULT_BASE["github-copilot"];
  let expires = Date.now() + 25 * 60 * 1000;
  const expiresAt = payload.expires_at;
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0) {
    expires = (expiresAt > 1_000_000_000_000 ? expiresAt : expiresAt * 1000) - EXPIRE_MARGIN_MS;
  } else if (typeof payload.refresh_in === "number" && payload.refresh_in > 0) {
    expires = Date.now() + payload.refresh_in * 1000 - EXPIRE_MARGIN_MS;
  }
  return { ok: true, access: payload.token, expires, apiUrl };
}

async function loginGithubCopilot(io: LoginIo): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const device = await requestGithubDeviceCode(io.signal);
    io.write(`Open ${device.verificationUri} and enter code: ${device.userCode}\n`);
    openAuthorize(device.verificationUri, io);
    const github = await pollGithubDeviceToken(device, io.signal);
    if (!github.ok) return github;
    const session = await exchangeGithubCopilotToken(github.githubToken, io.signal);
    if (!session.ok) return session;
    return persistOauth(
      "github-copilot",
      { access: session.access, refresh: github.githubToken, expires: session.expires },
      { apiUrl: session.apiUrl },
    );
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function loginGithubCopilotKey(io: LoginIo): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!io.waitForCode) return { ok: false, error: "login failed: no token input" };
  io.write("paste a GitHub token with Copilot access, then press enter\n");
  const githubToken = (await io.waitForCode()).trim();
  if (!githubToken) return { ok: false, error: "login failed: empty token" };
  const session = await exchangeGithubCopilotToken(githubToken, io.signal);
  if (!session.ok) return session;
  return persistOauth(
    "github-copilot",
    { access: session.access, refresh: githubToken, expires: session.expires },
    { apiUrl: session.apiUrl },
  );
}

async function finishResolved(
  providerId: ProviderId,
): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  const resolved = await resolveAuth(providerId);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  return { ok: true, summary: authBanner(resolved) };
}

export async function runLogin(
  providerId: string,
  mode: LoginMode,
  io: LoginIo,
): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  if (!isSupportedProvider(providerId)) {
    return { ok: false, error: `unsupported provider: ${providerId} (supported: ${SUPPORTED_PROVIDERS.join(", ")})` };
  }
  const chosen = mode;
  if (providerId === "github-copilot") {
    const stored = chosen === "key" ? await loginGithubCopilotKey(io) : await loginGithubCopilot(io);
    if (!stored.ok) return stored;
    return finishResolved(providerId);
  }
  if (chosen === "key" || (chosen === "browser" && defaultLoginMode(providerId) === "key")) {
    const stored = await loginKey(providerId, io);
    if (!stored.ok) return stored;
    return finishResolved(providerId);
  }
  if (providerId === "xai") {
    const stored = await loginXaiDevice(io);
    if (!stored.ok) return stored;
    return finishResolved(providerId);
  }
  if (providerId === "openai" || providerId === "google") {
    const stored = await loginKey(providerId, io);
    if (!stored.ok) return stored;
    return finishResolved(providerId);
  }
  const port = redirectPort(providerId);
  const { verifier, challenge, state } = pkce();
  if (providerId === "openrouter") {
    const url = buildOpenRouterAuthorizeUrl(challenge, redirectUri(providerId, port));
    const code = await collectCode(providerId, chosen === "code" ? "code" : "browser", url, state, io);
    if (!code.ok) return code;
    const exchanged = await exchangeOpenRouter(code.code, verifier, io.signal);
    if (!exchanged.ok) return exchanged;
    return finishResolved(providerId);
  }
  if (providerId === "openai-codex") {
    const url = buildCodexAuthorizeUrl(challenge, state, port);
    const code = await collectCode(providerId, chosen === "code" ? "code" : "browser", url, state, io);
    if (!code.ok) return code;
    const exchanged = await exchangeCodex(code.code, verifier, port);
    if (!exchanged.ok) return exchanged;
    return finishResolved(providerId);
  }
  const url = buildAnthropicAuthorizeUrl(challenge, state, port);
  const code = await collectCode("anthropic", chosen === "code" ? "code" : "browser", url, state, io);
  if (!code.ok) return code;
  const exchanged = await exchangeAnthropic(code.code, verifier, port);
  if (!exchanged.ok) return exchanged;
  return finishResolved(providerId);
}

export function runLogout(providerId: string): { ok: true; summary: string } | { ok: false; error: string } {
  if (!isSupportedProvider(providerId)) {
    return { ok: false, error: `unsupported provider: ${providerId} (supported: ${SUPPORTED_PROVIDERS.join(", ")})` };
  }
  try {
    modifyProvider(providerId, () => null);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return { ok: true, summary: `logged out ${providerId}` };
}

export function parseAuthCommand(line: string):
  | { cmd: "login"; mode: LoginMode; provider: string }
  | { cmd: "logout"; provider: string }
  | { error: string } {
  const parts = line.trim().split(/\s+/);
  const cmd = parts[0];
  const first = parts[1]?.toLowerCase();
  const second = parts[2]?.toLowerCase();
  if (cmd === "/logout") {
    if (!first) return { error: "pick a provider" };
    let picked: ReturnType<typeof resolveLoginPick>;
    if (LOGIN_KIND_WORDS.has(first) && second) picked = resolveLoginPick(second, first);
    else if (second && LOGIN_KIND_WORDS.has(second)) picked = resolveLoginPick(first, second);
    else if (isSupportedProvider(first)) return { cmd: "logout", provider: first };
    else picked = resolveLoginPick(first);
    if ("error" in picked) return picked;
    return { cmd: "logout", provider: picked.provider };
  }
  if (cmd === "/login") {
    if (!first) return { error: "pick a provider" };
    let picked: ReturnType<typeof resolveLoginPick>;
    if (LOGIN_KIND_WORDS.has(first)) picked = resolveLoginPick(second ?? "anthropic", first);
    else picked = resolveLoginPick(first, second);
    if ("error" in picked) return picked;
    return { cmd: "login", mode: picked.mode, provider: picked.provider };
  }
  return { error: `unknown command: ${line}` };
}

/** Test helper: drop the in-memory file cache. */
export function resetAuthCache(): void {
  cached = null;
  refreshFlights.clear();
}
