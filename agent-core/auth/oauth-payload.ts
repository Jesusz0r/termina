/** Pure OAuth payload parsers shared by the flows and the credential store. */
import { isRecord } from "../../shared/guards.ts";

const EXPIRE_MARGIN_MS = 300_000;

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
  let expiresIn = typeof rawExpires === "number" ? rawExpires : Number(rawExpires);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    if (opts.defaultExpiresIn && opts.defaultExpiresIn > 0) expiresIn = opts.defaultExpiresIn;
    else return { ok: false, error: "token response missing expires_in" };
  }
  return {
    ok: true, access, refresh, expires: now + expiresIn * 1000 - EXPIRE_MARGIN_MS,
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
  return {
    deviceCode, userCode, verificationUri: typeof verificationUri === "string" ? verificationUri : "",
    verificationUriComplete: typeof complete === "string" && complete ? complete : null,
    interval: Number(interval),
    expiresIn: Number(expires),
  };
}

export function parseOpenRouterKey(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const key = payload.key;
  return typeof key === "string" && key ? key : null;
}

export function parseCopilotSession(payload: unknown): {
  access: string; apiUrl: string | null; expiresAt: number | null; refreshIn: number | null;
} | null {
  if (!isRecord(payload)) return null;
  const { token, endpoints, expires_at: expiresAt, refresh_in: refreshIn } = payload;
  if (typeof token !== "string" || !token) return null;
  const api = isRecord(endpoints) ? endpoints.api : null;
  return {
    access: token, apiUrl: typeof api === "string" ? api : null,
    expiresAt: typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null,
    refreshIn: typeof refreshIn === "number" && refreshIn > 0 ? refreshIn : null,
  };
}
