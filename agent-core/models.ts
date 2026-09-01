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

export type ModelInfo = { id: string; name?: string; context?: number };

export const MODEL_LIST_CAP = 200;
const CATALOG_TIMEOUT_MS = 10_000;
const CATALOG_BODY_LIMIT = 1_048_576;
const CATALOG_REDIRECT_LIMIT = 3;
/** Bound follow-up work; unfinished pagination at this cap fails atomically. */
const ANTHROPIC_PAGE_CAP = 4;

const SKIP_CHAT =
  /embedding|whisper|tts|dall-e|dalle|moderation|transcribe|sora|gpt-image|image|omni-moderation|realtime|^ada$|babbage|davinci|computer-use/;

function testModelsUrl(): string | null {
  if (process.env.TERMINA_CORE_TEST !== "1") return null;
  const raw = process.env.TERMINA_TEST_MODELS_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const loopback = host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
    if (!loopback || (url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function modelsUrl(provider: ProviderId, baseUrl: string): string {
  const test = testModelsUrl();
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
  if (provider === "opencode-go" || provider === "opencode-zen") return true;
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

function requireAnthropicModelsEnvelope(payload: unknown): Record<string, unknown> {
  const rec = asRecord(payload);
  if (!rec || !Array.isArray(rec.data) || typeof rec.has_more !== "boolean") {
    throw new Error("models: invalid response");
  }
  return rec;
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
  const contextRaw = Number(row.context_length ?? row.context_window ?? row.max_input_tokens ?? row.context);
  const context = Number.isFinite(contextRaw) && contextRaw >= 8_000 ? Math.floor(contextRaw) : undefined;
  return { id, ...(name ? { name } : {}), ...(context ? { context } : {}) };
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
  return process.env.TERMINA_CORE_TEST === "1" ? testModelsUrl() !== null : true;
}

function catalogSignal(user?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(CATALOG_TIMEOUT_MS);
  return user ? AbortSignal.any([user, timeout]) : timeout;
}

function catalogUrl(raw: string): URL {
  const url = new URL(raw);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("models URL is not HTTP(S)");
  }
  return url;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function cancelResponse(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* The body may already be closed by the transport. */
  }
}

async function fetchCatalog(
  rawUrl: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  let url = catalogUrl(rawUrl);
  const origin = url.origin;
  for (let redirects = 0; ; redirects += 1) {
    const res = await fetch(url, { method: "GET", headers, signal, redirect: "manual" });
    if (!isRedirect(res.status)) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    if (redirects >= CATALOG_REDIRECT_LIMIT) {
      await cancelResponse(res);
      throw new Error("models redirect limit exceeded");
    }
    let next: URL;
    try {
      next = catalogUrl(new URL(location, url).toString());
    } catch {
      await cancelResponse(res);
      throw new Error("models redirect is invalid");
    }
    if (next.origin !== origin) {
      await cancelResponse(res);
      throw new Error("models redirect changed origin");
    }
    await cancelResponse(res);
    url = next;
  }
}

async function readCatalogBody(res: Response): Promise<string> {
  const declared = res.headers.get("content-length")?.trim();
  if (declared && /^\d+$/.test(declared) && BigInt(declared) > BigInt(CATALOG_BODY_LIMIT)) {
    await cancelResponse(res);
    throw new Error("models response too large");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > CATALOG_BODY_LIMIT) {
      try {
        await reader.cancel();
      } catch {
        /* The transport can close while cancellation is being delivered. */
      }
      throw new Error("models response too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("models response is not valid UTF-8");
  }
}

function modelsHttpError(status: number, raw: string): string {
  const detail = raw.replace(/\s+/g, " ").trim().slice(0, 200);
  return detail ? `models HTTP ${status}: ${detail}` : `models HTTP ${status}`;
}

function catalogAbortError(caller: AbortSignal | undefined, combined: AbortSignal): string | null {
  if (caller?.aborted) return "models request cancelled";
  if (combined.aborted) return "models request timed out";
  return null;
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
      const auth = await resolveAuth(providerId, combined);
      if (!auth.ok) return { ok: false, error: catalogAbortError(signal, combined) ?? auth.error };
      const url = modelsUrl(providerId, auth.baseUrl);
      const headers = catalogHeaders(auth.headers);
      const res = await fetchCatalog(url, headers, combined);
      if (res.status === 401) {
        await readCatalogBody(res);
        if (auth.kind === "oauth" && !replayed) {
          const refreshed = await refreshOauth(providerId, combined);
          if (!refreshed.ok) return { ok: false, error: catalogAbortError(signal, combined) ?? refreshed.error };
          replayed = true;
          continue;
        }
        return { ok: false, error: auth.kind === "oauth" ? "auth expired — run /login" : "invalid API key" };
      }
      const raw = await readCatalogBody(res);
      if (!res.ok) {
        return { ok: false, error: modelsHttpError(res.status, raw) };
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return { ok: false, error: "models: invalid JSON" };
      }
      const anthropic = providerProtocol(providerId) === "anthropic-messages";
      const rec = anthropic ? requireAnthropicModelsEnvelope(payload) : asRecord(payload);
      let models = parseModelsPayload(payload, providerId);
      const lastId = typeof rec?.last_id === "string" ? rec.last_id.trim() : "";
      if (anthropic && rec?.has_more === true && !lastId) {
        return { ok: false, error: "models: invalid pagination" };
      }
      const needsMore = anthropic && rec?.has_more === true && models.length < MODEL_LIST_CAP;
      if (needsMore && testModelsUrl() === null) {
        const seen = new Set(models.map((model) => model.id));
        const more = await loadAnthropicPages(
          auth.baseUrl,
          headers,
          lastId,
          seen,
          MODEL_LIST_CAP - models.length,
          combined,
        );
        models.push(...more);
      }
      return { ok: true, models };
    }
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (signal?.aborted) return { ok: false, error: "models request cancelled" };
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
  initialSeenModelIds: ReadonlySet<string>,
  remainingCapacity: number,
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  const out: ModelInfo[] = [];
  const seenModelIds = new Set(initialSeenModelIds);
  const seenCursors = new Set([afterId]);
  let cursor = afterId;
  for (let i = 0; i < ANTHROPIC_PAGE_CAP; i++) {
    const url = `${baseUrl.replace(/\/$/, "")}/v1/models?limit=100&after_id=${encodeURIComponent(cursor)}`;
    const res = await fetchCatalog(url, headers, signal);
    const raw = await readCatalogBody(res);
    if (!res.ok) throw new Error(modelsHttpError(res.status, raw));
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error("models: invalid JSON");
    }
    const rec = requireAnthropicModelsEnvelope(payload);
    const hasMore = rec.has_more === true;
    const next = typeof rec.last_id === "string" ? rec.last_id.trim() : "";
    if (hasMore && (!next || seenCursors.has(next))) {
      throw new Error("models: invalid pagination");
    }
    const page = parseModelsPayload(payload, "anthropic");
    for (const model of page) {
      if (seenModelIds.has(model.id)) continue;
      seenModelIds.add(model.id);
      out.push(model);
      if (out.length >= remainingCapacity) return out;
    }
    if (!hasMore) return out;
    if (i + 1 >= ANTHROPIC_PAGE_CAP) throw new Error("models: pagination limit exceeded");
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error("models: pagination limit exceeded");
}
