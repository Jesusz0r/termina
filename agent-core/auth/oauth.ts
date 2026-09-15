/**
 * OAuth token parse, refresh, exchange, and device flows.
 *
 * Owns token parsing/persistence, refresh flights, PKCE exchanges, and
 * device-code polling. Split from agent-core/auth.ts (issue #38).
 */
import { isRecord } from "../../shared/guards.ts";
import { COPILOT_HEADERS } from "./providers/github-copilot.ts";
import { providerDefinition } from "./providers/index.ts";
import { extractAccountId } from "./providers/openai-codex.ts";
import { type ProviderId } from "./providers/types.ts";
import { ANTHROPIC_CLIENT_ID, GITHUB_ACCESS_TOKEN_URL, GITHUB_COPILOT_CLIENT_ID, GITHUB_COPILOT_TOKEN_URL, GITHUB_DEVICE_GRANT, GITHUB_DEVICE_URL, OPENAI_CODEX_CLIENT_ID, XAI_CLIENT_ID, XAI_DEFAULT_EXPIRES_MS, XAI_DEFAULT_INTERVAL_MS, XAI_DEVICE_GRANT, XAI_MIN_INTERVAL_MS, XAI_POLL_MARGIN_MS, XAI_SCOPE, XAI_SLOW_DOWN_MS, isSupportedProvider, redirectUri, testLoopbackOverride, tokenUrl, validateCopilotApiUrl, xaiDeviceUrl } from "./endpoints.ts";
import { AUTH_REQUEST_CANCELLED, authFetch, authHttpError, isAuthHttpFailure, postForm, postJson } from "./http.ts";
import { modifyProvider, readAuth, refreshFlights, type AuthWriteOpts } from "./store.ts";

const EXPIRE_MARGIN_MS = 300_000;


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


export function persistOauth(
  providerId: ProviderId,
  parsed: { access: string; refresh: string; expires: number },
  extra: Record<string, unknown> = {},
  opts?: AuthWriteOpts,
): { ok: true } | { ok: false; error: string } {
  try {
    modifyProvider(providerId, (current) => {
      const cur = isRecord(current) ? current : {};
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
    }, opts);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return { ok: true };
}


export function persistApiKey(
  providerId: ProviderId,
  key: string,
  opts?: AuthWriteOpts,
): { ok: true } | { ok: false; error: string } {
  try {
    modifyProvider(providerId, (current) => {
      const cur = isRecord(current) ? current : {};
      return { ...cur, type: "api_key", key };
    }, opts);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return { ok: true };
}


type RefreshResult = { ok: true } | { ok: false; error: string };


async function runRefreshOauth(providerId: ProviderId): Promise<RefreshResult> {
  try {
    const got = readAuth();
    if (!got.ok) return { ok: false, error: "auth store unreadable — run /login" };
    const entry = got.data[providerId];
    if (!isRecord(entry) || entry.type !== "oauth" || typeof entry.refresh !== "string") {
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
      parsed = parseOauthToken(res.payload, Date.now(), { requireRefresh: true });
    } else if (providerId === "openai-codex") {
      const res = await postForm(tokenUrl(providerId), {
        grant_type: "refresh_token",
        refresh_token: entry.refresh,
        client_id: OPENAI_CODEX_CLIENT_ID,
      });
      parsed = parseOauthToken(res.payload, Date.now(), { requireRefresh: true });
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
      if (!session.ok) {
        return isAuthHttpFailure(session.error) ? session : { ok: false, error: "auth expired — run /login" };
      }
      parsed = {
        ok: true,
        access: session.access,
        refresh: entry.refresh,
        expires: session.expires,
      };
      extra = { ...entry, apiUrl: session.apiUrl };
    } else {
      return { ok: false, error: "auth expired — run /login" };
    }
    if (!parsed.ok) return { ok: false, error: `auth refresh returned an invalid token response: ${parsed.error}` };
    const stored = persistOauth(providerId, parsed, extra);
    if (!stored.ok) return { ok: false, error: `auth refresh persist failed: ${stored.error}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: authHttpError(error) ?? `auth refresh failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}


function waitForRefresh(flight: Promise<RefreshResult>, signal?: AbortSignal): Promise<RefreshResult> {
  if (!signal) return flight;
  if (signal.aborted) return Promise.resolve({ ok: false, error: AUTH_REQUEST_CANCELLED });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: RefreshResult) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish({ ok: false, error: AUTH_REQUEST_CANCELLED });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    void flight.then(finish, (error) => finish({
      ok: false,
      error: `auth refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    }));
  });
}


/** A caller signal cancels only that wait. The provider-keyed refresh remains
 * internally time-bounded so another caller can safely share the same flight. */
export async function refreshOauth(providerId: string, signal?: AbortSignal): Promise<RefreshResult> {
  if (!isSupportedProvider(providerId)) return { ok: false, error: `unsupported provider: ${providerId}` };
  if (signal?.aborted) return { ok: false, error: AUTH_REQUEST_CANCELLED };
  let flight = refreshFlights.get(providerId);
  if (!flight) {
    flight = runRefreshOauth(providerId);
    refreshFlights.set(providerId, flight);
    const cleanup = () => {
      if (refreshFlights.get(providerId) === flight) refreshFlights.delete(providerId);
    };
    void flight.then(cleanup, cleanup);
  }
  return waitForRefresh(flight, signal);
}


export async function exchangeAnthropic(
  code: string,
  verifier: string,
  port: number,
  signal?: AbortSignal,
  opts?: AuthWriteOpts,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await postJson(
      tokenUrl("anthropic"),
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri("anthropic", port),
        client_id: ANTHROPIC_CLIENT_ID,
        code_verifier: verifier,
      },
      signal,
    );
    const parsed = parseOauthToken(res.payload, Date.now(), { requireRefresh: true });
    if (!parsed.ok) return { ok: false, error: `login failed: ${parsed.error}` };
    if (signal?.aborted) return { ok: false, error: AUTH_REQUEST_CANCELLED };
    return persistOauth("anthropic", parsed, {}, opts);
  } catch (error) {
    return { ok: false, error: authHttpError(error) ?? "login failed: Anthropic token exchange failed" };
  }
}


export async function exchangeCodex(
  code: string,
  verifier: string,
  port: number,
  signal?: AbortSignal,
  opts?: AuthWriteOpts,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await postForm(
      tokenUrl("openai-codex"),
      {
        grant_type: "authorization_code",
        client_id: OPENAI_CODEX_CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri("openai-codex", port),
      },
      signal,
    );
    const parsed = parseOauthToken(res.payload, Date.now(), { requireRefresh: true });
    if (!parsed.ok) return { ok: false, error: `login failed: ${parsed.error}` };
    if (signal?.aborted) return { ok: false, error: AUTH_REQUEST_CANCELLED };
    const rec = isRecord(res.payload) ? res.payload : {};
    const idToken = typeof rec.id_token === "string" ? rec.id_token : "";
    const accountId = extractAccountId(parsed.access) || extractAccountId(idToken) || undefined;
    return persistOauth("openai-codex", parsed, accountId ? { accountId } : {}, opts);
  } catch (error) {
    return { ok: false, error: authHttpError(error) ?? "login failed: OpenAI token exchange failed" };
  }
}


export async function exchangeOpenRouter(
  code: string,
  verifier: string,
  signal?: AbortSignal,
  opts?: AuthWriteOpts,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await postJson(
      tokenUrl("openrouter"),
      { code, code_verifier: verifier, code_challenge_method: "S256" },
      signal,
    );
    const rec = isRecord(res.payload) ? res.payload : {};
    const key = typeof rec.key === "string" ? rec.key : "";
    if (!res.ok || !key) return { ok: false, error: "login failed: OpenRouter key exchange failed" };
    if (signal?.aborted) return { ok: false, error: AUTH_REQUEST_CANCELLED };
    return persistApiKey("openrouter", key, opts);
  } catch (error) {
    return { ok: false, error: authHttpError(error) ?? "login failed: OpenRouter key exchange failed" };
  }
}


function hostAllowed(hostname: string, hosts: readonly string[]): boolean {
  return hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}


function validateHttpsVerificationUri(raw: string, opts: { hosts: readonly string[]; label: string }): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Untrusted verification URI in ${opts.label} OAuth response`);
  }
  const loopback = Boolean(testLoopbackOverride("TERMINA_TEST_DEVICE_URL"));
  if ((url.protocol !== "https:" || !hostAllowed(url.hostname, opts.hosts)) && !loopback) {
    throw new Error(`Untrusted verification URI in ${opts.label} OAuth response`);
  }
  return url.href;
}


type DevicePollParse<T> = (res: { ok: boolean; status: number; payload: unknown }) =>
  | ({ ok: true } & T)
  | { ok: false; error: string }
  | "pending"
  | "slow_down";


async function pollDeviceGrant<T extends object>(
  device: { intervalMs: number; expiresMs: number },
  opts: {
    tokenUrl: string;
    grant: Record<string, string>;
    request: (
      url: string,
      grant: Record<string, string>,
      signal?: AbortSignal,
    ) => Promise<{ ok: boolean; status: number; payload: unknown }>;
    parse: DevicePollParse<T>;
    waitFirst: boolean;
    pollMarginMs: number;
    slowDownMs: number;
    timeoutError: string;
  },
  signal?: AbortSignal,
): Promise<({ ok: true } & T) | { ok: false; error: string }> {
  const deadline = Date.now() + device.expiresMs;
  let interval = device.intervalMs;
  while (Date.now() < deadline) {
    if (opts.waitFirst) {
      const wait = Math.min(interval + opts.pollMarginMs, Math.max(0, deadline - Date.now()));
      if (wait > 0) await sleepAsync(wait, signal);
    }
    const parsed = opts.parse(await opts.request(opts.tokenUrl, opts.grant, signal));
    if (parsed !== "pending" && parsed !== "slow_down") return parsed;
    if (parsed === "slow_down") interval += opts.slowDownMs;
    if (!opts.waitFirst) {
      const wait = Math.min(interval, Math.max(0, deadline - Date.now()));
      if (wait > 0) await sleepAsync(wait, signal);
    }
  }
  return { ok: false, error: opts.timeoutError };
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
    xaiDeviceUrl(),
    { client_id: XAI_CLIENT_ID, scope: XAI_SCOPE, referrer: "termina" },
    signal,
  );
  if (!res.ok || !isRecord(res.payload)) {
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
    verificationUri: validateHttpsVerificationUri(verification, { hosts: ["auth.x.ai"], label: "xAI" }),
    intervalMs: intervalMs(
      res.payload.interval,
      XAI_DEFAULT_INTERVAL_MS,
      testLoopbackOverride("TERMINA_TEST_DEVICE_URL") ? 0 : XAI_MIN_INTERVAL_MS,
    ),
    expiresMs: positiveMs(res.payload.expires_in, XAI_DEFAULT_EXPIRES_MS),
  };
}


export async function pollXaiDeviceToken(
  device: { deviceCode: string; intervalMs: number; expiresMs: number },
  signal?: AbortSignal,
): Promise<{ ok: true; access: string; refresh: string; expires: number } | { ok: false; error: string }> {
  return pollDeviceGrant(device, {
    tokenUrl: tokenUrl("xai"),
    grant: {
      grant_type: XAI_DEVICE_GRANT,
      client_id: XAI_CLIENT_ID,
      device_code: device.deviceCode,
    },
    request: postForm,
    parse: (res) => {
      if (res.ok) {
        const parsed = parseOauthToken(res.payload, Date.now(), { requireRefresh: true, defaultExpiresIn: 3600 });
        if (!parsed.ok) return { ok: false, error: `login failed: ${parsed.error}` };
        return parsed;
      }
      const err = isRecord(res.payload) && typeof res.payload.error === "string" ? res.payload.error : "";
      if (err === "authorization_pending") return "pending";
      if (err === "slow_down") return "slow_down";
      if (err === "access_denied" || err === "authorization_denied") {
        return { ok: false, error: "xAI device authorization was denied" };
      }
      if (err === "expired_token") return { ok: false, error: "xAI device code expired" };
      return { ok: false, error: `xAI device token exchange failed (HTTP ${res.status})` };
    },
    waitFirst: true,
    pollMarginMs: testLoopbackOverride("TERMINA_TEST_DEVICE_URL") ? 0 : XAI_POLL_MARGIN_MS,
    slowDownMs: XAI_SLOW_DOWN_MS,
    timeoutError: "xAI device authorization timed out",
  }, signal);
}


function githubDeviceUrl(): string {
  return testLoopbackOverride("TERMINA_TEST_DEVICE_URL") || GITHUB_DEVICE_URL;
}


function githubAccessUrl(): string {
  return testLoopbackOverride("TERMINA_TEST_TOKEN_URL") || GITHUB_ACCESS_TOKEN_URL;
}


function copilotSessionUrl(): string {
  return testLoopbackOverride("TERMINA_TEST_COPILOT_TOKEN_URL") || GITHUB_COPILOT_TOKEN_URL;
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
  if (!res.ok || !isRecord(res.payload)) {
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
    verificationUri: validateHttpsVerificationUri(verification, { hosts: ["github.com"], label: "GitHub" }),
    intervalMs: intervalMs(res.payload.interval, 5_000, testLoopbackOverride("TERMINA_TEST_DEVICE_URL") ? 0 : 1_000),
    expiresMs: positiveMs(res.payload.expires_in, 15 * 60 * 1000),
  };
}


export async function pollGithubDeviceToken(
  device: { deviceCode: string; intervalMs: number; expiresMs: number },
  signal?: AbortSignal,
): Promise<{ ok: true; githubToken: string } | { ok: false; error: string }> {
  return pollDeviceGrant(device, {
    tokenUrl: githubAccessUrl(),
    grant: {
      client_id: GITHUB_COPILOT_CLIENT_ID,
      device_code: device.deviceCode,
      grant_type: GITHUB_DEVICE_GRANT,
    },
    request: (url, grant, requestSignal) => postJson(url, grant, requestSignal, {
      accept: "application/json",
      "user-agent": COPILOT_HEADERS["user-agent"],
    }),
    parse: (res) => {
      if (isRecord(res.payload) && typeof res.payload.access_token === "string" && res.payload.access_token) {
        return { ok: true, githubToken: res.payload.access_token };
      }
      const err = isRecord(res.payload) && typeof res.payload.error === "string" ? res.payload.error : "";
      if (err === "access_denied") return { ok: false, error: "GitHub device authorization was denied" };
      if (err === "expired_token") return { ok: false, error: "GitHub device code expired" };
      if (err === "slow_down") return "slow_down";
      if (err && err !== "authorization_pending") {
        return { ok: false, error: `GitHub device token exchange failed (HTTP ${res.status})` };
      }
      if (!res.ok && err !== "authorization_pending") {
        return { ok: false, error: `GitHub device token exchange failed (HTTP ${res.status})` };
      }
      return "pending";
    },
    waitFirst: false,
    pollMarginMs: 0,
    slowDownMs: 5_000,
    timeoutError: "GitHub device authorization timed out",
  }, signal);
}


export async function exchangeGithubCopilotToken(
  githubToken: string,
  signal?: AbortSignal,
): Promise<{ ok: true; access: string; expires: number; apiUrl: string } | { ok: false; error: string }> {
  try {
    const res = await authFetch(
      copilotSessionUrl(),
      {
        method: "GET",
        headers: {
          ...COPILOT_HEADERS,
          authorization: `Bearer ${githubToken}`,
        },
      },
      signal,
    );
    const payload = res.payload;
    if (!res.ok || !isRecord(payload) || typeof payload.token !== "string" || !payload.token) {
      return { ok: false, error: `Copilot session token failed (HTTP ${res.status})` };
    }
    if (signal?.aborted) return { ok: false, error: AUTH_REQUEST_CANCELLED };
    const endpoints = isRecord(payload.endpoints) ? payload.endpoints : {};
    const reported = typeof endpoints.api === "string" ? endpoints.api : "";
    const apiUrl = validateCopilotApiUrl(reported) || providerDefinition("github-copilot").baseUrl;
    let expires = Date.now() + 25 * 60 * 1000;
    const expiresAt = payload.expires_at;
    if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0) {
      expires = (expiresAt > 1_000_000_000_000 ? expiresAt : expiresAt * 1000) - EXPIRE_MARGIN_MS;
    } else if (typeof payload.refresh_in === "number" && payload.refresh_in > 0) {
      expires = Date.now() + payload.refresh_in * 1000 - EXPIRE_MARGIN_MS;
    }
    return { ok: true, access: payload.token, expires, apiUrl };
  } catch (error) {
    return { ok: false, error: authHttpError(error) ?? "Copilot session token failed" };
  }
}
