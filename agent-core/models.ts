/**
 * Live model catalog for an authenticated provider.
 *
 * The provider's own list is the source. This module does not read
 * another product's models-store. Tests point GET at loopback with
 * TERMINA_TEST_MODELS_URL.
 */
import {
  DEFAULT_MODELS,
  isSupportedProvider,
  openaiCodexClientVersion,
  parseModelRef,
  providerProtocol,
  refreshOauth,
  resolveAuth,
  type ProviderId,
} from "./auth.ts";

export { firstAuthenticatedProvider } from "./auth.ts";

export type ModelInfo = { id: string; name?: string };

export const MODEL_LIST_CAP = 200;
const CATALOG_TIMEOUT_MS = 10_000;

const SKIP_CHAT =
  /embedding|whisper|tts|dall-e|dalle|moderation|transcribe|sora|gpt-image|image|omni-moderation|realtime|^ada$|babbage|davinci|computer-use/;

export function modelsUrl(provider: ProviderId, baseUrl: string): string {
  const test = process.env.TERMINA_TEST_MODELS_URL?.trim();
  if (test) return test;
  const base = baseUrl.replace(/\/$/, "");
  if (provider === "anthropic") return `${base}/v1/models?limit=100`;
  if (provider === "openai-codex") {
    let path = `${base}/codex/models`;
    if (base.endsWith("/codex/responses")) path = base.replace(/\/responses$/, "/models");
    else if (base.endsWith("/codex")) path = `${base}/models`;
    const version = encodeURIComponent(openaiCodexClientVersion());
    try {
      const url = new URL(path);
      url.searchParams.set("client_version", openaiCodexClientVersion());
      return url.toString();
    } catch {
      const sep = path.includes("?") ? "&" : "?";
      return `${path}${sep}client_version=${version}`;
    }
  }
  return `${base}/models`;
}

export function isChatModel(id: string, provider: ProviderId): boolean {
  const n = id.toLowerCase();
  if (!n || n.length > 200) return false;
  if (SKIP_CHAT.test(n)) return false;
  if (provider === "anthropic") return n.includes("claude") || n.includes("haiku");
  if (provider === "xai") return n.includes("grok");
  if (provider === "google") return n.includes("gemini") || n.includes("gemma");
  if (provider === "openai-codex") return /^(gpt-|o[0-9]|codex)/.test(n);
  if (provider === "github-copilot") return /^(gpt-|o[0-9]|claude|gemini|copilot)/.test(n);
  if (provider === "openrouter") return n.includes("/");
  return /^(gpt-|o[0-9]|chatgpt|claude|grok|gemini|gemma|deepseek|mistral|llama|qwen|kimi|minimax|command|glm|moonshot)/.test(
    n,
  );
}

function stripModelsPrefix(id: string): string {
  return id.startsWith("models/") ? id.slice("models/".length) : id;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function rowId(row: Record<string, unknown>): { id: string; name?: string } | null {
  const raw =
    typeof row.id === "string"
      ? row.id
      : typeof row.slug === "string"
        ? row.slug
        : typeof row.name === "string"
          ? row.name
          : typeof row.model === "string"
            ? row.model
            : "";
  const id = stripModelsPrefix(raw.trim());
  if (!id) return null;
  const name =
    typeof row.display_name === "string"
      ? row.display_name
      : typeof row.displayName === "string"
        ? row.displayName
        : typeof row.name === "string" && row.name !== raw
          ? row.name
          : undefined;
  return name ? { id, name } : { id };
}

export function parseModelsPayload(payload: unknown, provider: ProviderId): ModelInfo[] {
  const rec = asRecord(payload);
  const rawList = rec
    ? Array.isArray(rec.data)
      ? rec.data
      : Array.isArray(rec.models)
        ? rec.models
        : []
    : Array.isArray(payload)
      ? payload
      : [];
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const item of rawList) {
    const row = asRecord(item);
    if (!row) continue;
    const parsed = rowId(row);
    if (!parsed || seen.has(parsed.id) || !isChatModel(parsed.id, provider)) continue;
    seen.add(parsed.id);
    out.push(parsed);
    if (out.length >= MODEL_LIST_CAP) break;
  }
  return out;
}

export function pickDefaultModel(models: ModelInfo[], preferred?: string): string | null {
  if (models.length === 0) return null;
  if (preferred) {
    const exact = models.find((m) => m.id === preferred);
    if (exact) return exact.id;
    const prefixed = models.find((m) => m.id.startsWith(`${preferred}-`));
    if (prefixed) return prefixed.id;
  }
  return models[0].id;
}

export function formatModelBanner(models: ModelInfo[], current: string): string {
  const names = models.slice(0, 8).map((m) => (m.id === current ? `*${m.id}` : m.id));
  const more = models.length > 8 ? ` +${models.length - 8}` : "";
  const cap = models.length >= MODEL_LIST_CAP ? " (capped)" : "";
  return `models: ${models.length}${cap} · ${names.join(", ")}${more}`;
}

export function formatModelLines(models: ModelInfo[], current: string): string {
  return models
    .map((m) => {
      const mark = m.id === current ? "*" : " ";
      const extra = m.name && m.name !== m.id ? `  ${m.name}` : "";
      return `${mark} ${m.id}${extra}`;
    })
    .join("\n");
}

export type CatalogModel = { provider: ProviderId; id: string; name?: string };

export function formatCatalogLines(
  models: CatalogModel[],
  currentProvider: string,
  currentModel: string,
): string {
  if (models.length === 0) return "";
  const pw = Math.max(...models.map((m) => m.provider.length));
  return models
    .map((m) => {
      const mark = m.provider === currentProvider && m.id === currentModel ? "*" : " ";
      const extra = m.name && m.name !== m.id ? `  ${m.name}` : "";
      return `${mark} ${m.provider.padEnd(pw)}  ${m.id}${extra}`;
    })
    .join("\n");
}

export function parseModelSwitch(
  raw: string,
  current: ProviderId,
): { provider: ProviderId; model: string } {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    const head = trimmed.slice(0, slash);
    const tail = trimmed.slice(slash + 1).trim();
    if (isSupportedProvider(head) && head !== current && current !== "openrouter") {
      return { provider: head, model: tail || DEFAULT_MODELS[head].main };
    }
  }
  return parseModelRef(trimmed, current);
}

export function catalogFetchAllowed(): boolean {
  if (process.env.TERMINA_TEST_MODELS_URL?.trim()) return true;
  return process.env.TERMINA_CORE_TEST !== "1";
}

function catalogSignal(user?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(CATALOG_TIMEOUT_MS);
  return user ? AbortSignal.any([user, timeout]) : timeout;
}

/** Catalog GET is not a Responses call. Drop POST-only Codex headers. */
export function catalogHeaders(authHeaders: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  for (const key of [
    "authorization",
    "chatgpt-account-id",
    "originator",
    "user-agent",
    "x-api-key",
    "anthropic-version",
    "anthropic-beta",
    "x-app",
    "http-referer",
    "x-title",
    "editor-version",
    "editor-plugin-version",
    "copilot-integration-id",
  ]) {
    const value = authHeaders[key];
    if (value) headers[key] = value;
  }
  return headers;
}

export async function loadProviderModels(
  providerId: ProviderId,
  signal?: AbortSignal,
): Promise<{ ok: true; models: ModelInfo[] } | { ok: false; error: string }> {
  if (!catalogFetchAllowed()) return { ok: false, error: "catalog fetch skipped in tests" };
  const combined = catalogSignal(signal);
  let replayed = false;
  try {
    for (;;) {
      const auth = await resolveAuth(providerId);
      if (!auth.ok) return { ok: false, error: auth.error };
      const url = modelsUrl(providerId, auth.baseUrl);
      const headers = catalogHeaders(auth.headers);
      const res = await fetch(url, { method: "GET", headers, signal: combined });
      if (res.status === 401) {
        await res.text();
        if (auth.kind === "oauth" && !replayed) {
          const refreshed = await refreshOauth(providerId);
          if (!refreshed.ok) return { ok: false, error: refreshed.error };
          replayed = true;
          continue;
        }
        return { ok: false, error: auth.kind === "oauth" ? "auth expired — run /login" : "invalid API key" };
      }
      const raw = await res.text();
      if (!res.ok) {
        const detail = raw.replace(/\s+/g, " ").trim().slice(0, 200);
        return { ok: false, error: detail ? `models HTTP ${res.status}: ${detail}` : `models HTTP ${res.status}` };
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return { ok: false, error: "models: invalid JSON" };
      }
      let models = parseModelsPayload(payload, providerId);
      const rec = asRecord(payload);
      const lastId = typeof rec?.last_id === "string" ? rec.last_id : "";
      const paginate =
        !process.env.TERMINA_TEST_MODELS_URL?.trim() &&
        providerProtocol(providerId) === "anthropic-messages" &&
        rec?.has_more === true &&
        lastId &&
        models.length < MODEL_LIST_CAP;
      if (paginate) {
        const more = await loadAnthropicPages(auth.baseUrl, headers, lastId, combined);
        const seen = new Set(models.map((m) => m.id));
        for (const m of more) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          models.push(m);
          if (models.length >= MODEL_LIST_CAP) break;
        }
      }
      return { ok: true, models };
    }
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === "TimeoutError" || name === "AbortError" || combined.aborted) {
      return { ok: false, error: "models request timed out" };
    }
    return { ok: false, error: (err as Error).message || "models request failed" };
  }
}

async function loadAnthropicPages(
  baseUrl: string,
  headers: Record<string, string>,
  afterId: string,
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  const out: ModelInfo[] = [];
  let cursor = afterId;
  for (let i = 0; i < 4 && cursor && out.length < MODEL_LIST_CAP; i++) {
    const url = `${baseUrl.replace(/\/$/, "")}/v1/models?limit=100&after_id=${encodeURIComponent(cursor)}`;
    const test = process.env.TERMINA_TEST_MODELS_URL?.trim();
    const res = await fetch(test || url, { method: "GET", headers, signal });
    if (!res.ok) break;
    const raw = await res.text();
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      break;
    }
    const page = parseModelsPayload(payload, "anthropic");
    out.push(...page);
    const rec = asRecord(payload);
    if (rec?.has_more !== true || typeof rec.last_id !== "string") break;
    cursor = rec.last_id;
  }
  return out;
}

export function fallbackModels(provider: ProviderId): ModelInfo[] {
  const def = DEFAULT_MODELS[provider];
  const ids = def.main === def.summary ? [def.main] : [def.main, def.summary];
  return ids.map((id) => ({ id }));
}
