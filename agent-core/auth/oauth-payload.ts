/** Pure OAuth payload parsers shared by the flows and the credential store. */
import { isRecord } from "../../shared/guards.ts";

const EXPIRE_MARGIN_MS = 300_000;

function timingSeconds(value: unknown): number {
  return typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
}

export type StoredOauthEntry = {
  type: "oauth";
  access: string | null;
  refresh: string | null;
  expires: number | null;
  apiUrl: string | null;
  /** Keep the exact stored shape for refresh-race comparisons and metadata. */
  extra: Record<string, unknown>;
};

export function parseStoredOauth(value: unknown): StoredOauthEntry | null {
  if (!isRecord(value) || value.type !== "oauth") return null;
  const { access, refresh, expires, apiUrl } = value;
  return {
    type: "oauth",
    access: typeof access === "string" ? access : null,
    refresh: typeof refresh === "string" ? refresh : null,
    expires: typeof expires === "number" && Number.isFinite(expires) ? expires : null,
    apiUrl: typeof apiUrl === "string" ? apiUrl : null,
    extra: value,
  };
}

export function parseOauthToken(
  payload: unknown,
  now = Date.now(),
  opts: { requireRefresh?: boolean; previousRefresh?: string; defaultExpiresIn?: number } = {},
): { ok: true; access: string; refresh: string; expires: number; idToken?: string } | { ok: false; error: string } {
  if (!isRecord(payload)) return { ok: false, error: "invalid token response" };
  const { access_token: access, refresh_token: rawRefresh, expires_in: rawExpires, id_token: idToken } = payload;
  if (typeof access !== "string" || !access) return { ok: false, error: "token response missing access_token" };
  const refresh = typeof rawRefresh === "string" && rawRefresh ? rawRefresh : opts.previousRefresh ?? "";
  if (!refresh && opts.requireRefresh !== false) return { ok: false, error: "token response missing refresh_token" };
  const expiresIn = rawExpires === undefined ? opts.defaultExpiresIn : timingSeconds(rawExpires);
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return { ok: false, error: "token response missing expires_in" };
  }
  const expires = now + expiresIn * 1000 - EXPIRE_MARGIN_MS;
  if (!Number.isFinite(expires)) return { ok: false, error: "token response invalid expires_in" };
  return {
    ok: true, access, refresh, expires,
    ...(typeof idToken === "string" ? { idToken } : {}),
  };
}

/** Device polls share the same token/error fields, not the same polling policy. */
export function parseDeviceToken(payload: unknown): { accessToken: string | null; error: string | null } | null {
  if (!isRecord(payload)) return null;
  const { access_token: accessToken, error } = payload;
  return {
    accessToken: typeof accessToken === "string" && accessToken ? accessToken : null,
    error: typeof error === "string" ? error : null,
  };
}

export function parseDeviceCode(payload: unknown): {
  deviceCode: string; userCode: string; verificationUri: string; verificationUriComplete: string | null;
  interval: number; expiresIn: number;
} | "invalid" | "missing-fields" {
  if (!isRecord(payload)) return "invalid";
  const { device_code: deviceCode, user_code: userCode, verification_uri: verificationUri,
    verification_uri_complete: complete, interval, expires_in: expires } = payload;
  if (typeof deviceCode !== "string" || !deviceCode || typeof userCode !== "string" || !userCode) return "missing-fields";
  const intervalSeconds = timingSeconds(interval);
  const expiresIn = timingSeconds(expires);
  if ((interval !== undefined && !Number.isFinite(intervalSeconds * 1000))
    || (expires !== undefined && !Number.isFinite(expiresIn * 1000))) return "invalid";
  return {
    deviceCode, userCode, verificationUri: typeof verificationUri === "string" ? verificationUri : "",
    verificationUriComplete: typeof complete === "string" && complete ? complete : null,
    interval: intervalSeconds,
    expiresIn,
  };
}

export function parseOpenRouterKey(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const key = payload.key;
  return typeof key === "string" && key ? key : null;
}

export function parseCopilotSession(payload: unknown, now = Date.now()): {
  access: string; apiUrl: string | null; expires: number;
} | null {
  if (!isRecord(payload)) return null;
  const { token, endpoints, expires_at: expiresAt, refresh_in: refreshIn } = payload;
  if (typeof token !== "string" || !token) return null;
  let expires = now + 25 * 60 * 1000;
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0) {
    expires = (expiresAt > 1_000_000_000_000 ? expiresAt : expiresAt * 1000) - EXPIRE_MARGIN_MS;
  } else if (typeof refreshIn === "number" && refreshIn > 0) {
    expires = now + refreshIn * 1000 - EXPIRE_MARGIN_MS;
  }
  if (!Number.isFinite(expires)) return null;
  const api = isRecord(endpoints) ? endpoints.api : null;
  return { access: token, apiUrl: typeof api === "string" ? api : null, expires };
}
