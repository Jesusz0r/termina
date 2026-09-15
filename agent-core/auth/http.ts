/**
 * Authenticated HTTP primitives for auth flows.
 *
 * Owns bounded auth fetch, form/JSON posts, and response reading.
 * `readBoundedUtf8` is the shared byte-capped UTF-8 body reader (catalog + auth).
 * Split from agent-core/auth.ts (issue #38).
 */
import { TextDecoder } from "node:util";


/** Token responses are normally only a few KiB; 256 KiB leaves ample room
 * for provider metadata and error details without permitting unbounded reads. */
const AUTH_HTTP_MAX_RESPONSE_BYTES = 256 * 1024;

const AUTH_HTTP_TIMEOUT_MS = 30_000;

export const AUTH_REQUEST_CANCELLED = "auth request cancelled";

const AUTH_REQUEST_TIMED_OUT = "auth request timed out";

const AUTH_RESPONSE_TOO_LARGE = "auth response too large";

const AUTH_RESPONSE_INVALID_UTF8 = "auth response is not valid UTF-8";


class AuthHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthHttpError";
  }
}


export class BoundedUtf8Error extends Error {
  readonly kind: "too-large" | "invalid-utf8";
  constructor(kind: "too-large" | "invalid-utf8") {
    super(kind === "too-large" ? "response too large" : "response is not valid UTF-8");
    this.name = "BoundedUtf8Error";
    this.kind = kind;
  }
}


/** Byte-capped Response body as fatal UTF-8. Redirect policy stays at the call site. */
export async function readBoundedUtf8(res: Response, maxBytes: number): Promise<string> {
  const declaredRaw = res.headers.get("content-length")?.trim() ?? "";
  if (/^\d+$/.test(declaredRaw) && BigInt(declaredRaw) > BigInt(maxBytes)) {
    try {
      await res.body?.cancel("too-large");
    } catch {
      /* The request may already have closed while cancellation was delivered. */
    }
    throw new BoundedUtf8Error("too-large");
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          try {
            await reader.cancel("too-large");
          } catch {
            /* The stream may already have closed while cancellation was delivered. */
          }
          throw new BoundedUtf8Error("too-large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BoundedUtf8Error("invalid-utf8");
  }
}


export function authHttpError(error: unknown): string | null {
  return error instanceof AuthHttpError ? error.message : null;
}


export function isAuthHttpFailure(message: string): boolean {
  return (
    message === AUTH_REQUEST_CANCELLED ||
    message === AUTH_REQUEST_TIMED_OUT ||
    message === AUTH_RESPONSE_TOO_LARGE ||
    message === AUTH_RESPONSE_INVALID_UTF8
  );
}


function authHttpTimeoutMs(): number {
  if (process.env.TERMINA_CORE_TEST === "1") {
    const raw = process.env.TERMINA_TEST_AUTH_HTTP_TIMEOUT_MS?.trim();
    const parsed = raw ? Number(raw) : Number.NaN;
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return AUTH_HTTP_TIMEOUT_MS;
}


type AuthRequestSignal = {
  signal: AbortSignal;
  abortError: () => AuthHttpError | null;
  cleanup: () => void;
};


function authRequestSignal(callerSignal?: AbortSignal): AuthRequestSignal {
  const controller = new AbortController();
  let reason: "cancelled" | "timed-out" | null = null;
  const abortForCaller = () => {
    if (reason !== null) return;
    reason = "cancelled";
    controller.abort();
  };
  if (callerSignal?.aborted) abortForCaller();
  else callerSignal?.addEventListener("abort", abortForCaller, { once: true });
  const timer = setTimeout(() => {
    if (reason !== null) return;
    reason = "timed-out";
    controller.abort();
  }, authHttpTimeoutMs());
  timer.unref?.();
  return {
    signal: controller.signal,
    abortError: () =>
      reason === "cancelled"
        ? new AuthHttpError(AUTH_REQUEST_CANCELLED)
        : reason === "timed-out"
          ? new AuthHttpError(AUTH_REQUEST_TIMED_OUT)
          : null,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortForCaller);
    },
  };
}


async function readAuthResponse(
  response: Response,
): Promise<{ ok: boolean; status: number; payload: unknown; raw: string }> {
  let raw: string;
  try {
    raw = await readBoundedUtf8(response, AUTH_HTTP_MAX_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof BoundedUtf8Error) {
      throw new AuthHttpError(error.kind === "too-large" ? AUTH_RESPONSE_TOO_LARGE : AUTH_RESPONSE_INVALID_UTF8);
    }
    throw error;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }
  return { ok: response.ok, status: response.status, payload, raw };
}


export async function authFetch(
  url: string,
  init: Omit<RequestInit, "signal">,
  callerSignal?: AbortSignal,
): Promise<{ ok: boolean; status: number; payload: unknown; raw: string }> {
  const request = authRequestSignal(callerSignal);
  try {
    // Never follow redirects: a 307/308 from a token endpoint would resend
    // refresh codes and tokens to the redirect target.
    const response = await fetch(url, { ...init, redirect: "error", signal: request.signal });
    const result = await readAuthResponse(response);
    const aborted = request.abortError();
    if (aborted) throw aborted;
    return result;
  } catch (error) {
    const aborted = request.abortError();
    if (aborted) throw aborted;
    throw error;
  } finally {
    request.cleanup();
  }
}


export async function postJson(
  url: string,
  body: unknown,
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>,
): Promise<{ ok: boolean; status: number; payload: unknown; raw: string }> {
  return authFetch(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...extraHeaders },
      body: JSON.stringify(body),
    },
    signal,
  );
}


export async function postForm(
  url: string,
  fields: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; payload: unknown; raw: string }> {
  return authFetch(
    url,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields).toString(),
    },
    signal,
  );
}
