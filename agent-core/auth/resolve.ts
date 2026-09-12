/**
 * Credential resolution.
 *
 * Owns model-ref parsing, stored/env credential lookup, and auth
 * resolution. Split from agent-core/auth.ts (issue #38).
 */
import { isRecord } from "../../shared/guards.ts";
import { providerDefinition } from "./providers/index.ts";
import { SUPPORTED_PROVIDERS, type ProviderId } from "./providers/types.ts";
import { AUTH_PROVIDER_ORDER, baseUrl, isSupportedProvider, maskSecret, needsRefresh, requestHeaders, validateCopilotApiUrl } from "./endpoints.ts";
import { AUTH_REQUEST_CANCELLED } from "./http.ts";
import { refreshOauth } from "./oauth.ts";
import { readAuth } from "./store.ts";


function extraApiUrl(entry: Record<string, unknown>): string | null {
  const raw = typeof entry.apiUrl === "string" ? entry.apiUrl.trim() : "";
  return raw ? validateCopilotApiUrl(raw) : null;
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


export const DEFAULT_MODELS = Object.fromEntries(
  SUPPORTED_PROVIDERS.map((id) => [id, providerDefinition(id).defaultModels]),
) as Record<ProviderId, { main: string; summary: string }>;


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


function envToken(id: ProviderId): { token: string; envName: string } | null {
  for (const name of providerDefinition(id).envKeys) {
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
  if (!isRecord(entry) || typeof entry.type !== "string") return null;
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
  if (auth.source === "env") return `auth: ${who}env ${auth.envName ?? providerDefinition(auth.providerId).envKeys[0] ?? "API_KEY"}`.replace("  ", " ");
  if (auth.source === "oauth") return `auth: ${who}oauth (${maskSecret(auth.token)})`.replace("  ", " ");
  return `auth: ${who}api_key (auth.json)`.replace("  ", " ");
}


function missingCredentialError(id: ProviderId): string {
  const env = providerDefinition(id).envKeys[0];
  if (env) return `no ${id} credential — run /login ${id} or set ${env}`;
  return `no ${id} credential — run /login ${id}`;
}


/** Resolve stored/env credentials, allowing the caller to stop waiting for a
 * required shared OAuth refresh without cancelling other callers. */
export async function resolveAuth(providerId: string = "anthropic", signal?: AbortSignal): Promise<ResolvedAuth> {
  if (!isSupportedProvider(providerId)) return { ok: false, error: `unsupported provider: ${providerId}` };
  if (signal?.aborted) return { ok: false, error: AUTH_REQUEST_CANCELLED };
  const got = readAuth();
  if (got.ok) {
    const stored = fromStored(providerId, got.data[providerId]);
    if (stored && "needsOauthRefresh" in stored) {
      const refreshed = await refreshOauth(providerId, signal);
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
