/**
 * Authenticated HTTP primitives for auth flows.
 *
 * Owns bounded auth fetch, form/JSON posts, and response reading.
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


async function cancelAuthBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  try {
    await body.cancel(AUTH_RESPONSE_TOO_LARGE);
  } catch {
    /* The request may already have closed while cancellation was delivered. */
  }
}


async function readAuthResponse(
  response: Response,
): Promise<{ ok: boolean; status: number; payload: unknown; raw: string }> {
  const declaredRaw = response.headers.get("content-length")?.trim() ?? "";
  const declared = /^\d+$/.test(declaredRaw) ? Number(declaredRaw) : Number.NaN;
  if (Number.isSafeInteger(declared) && declared > AUTH_HTTP_MAX_RESPONSE_BYTES) {
    await cancelAuthBody(response.body);
    throw new AuthHttpError(AUTH_RESPONSE_TOO_LARGE);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > AUTH_HTTP_MAX_RESPONSE_BYTES) {
          try {
            await reader.cancel(AUTH_RESPONSE_TOO_LARGE);
          } catch {
            /* The stream may already have closed while cancellation was delivered. */
          }
          throw new AuthHttpError(AUTH_RESPONSE_TOO_LARGE);
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
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AuthHttpError(AUTH_RESPONSE_INVALID_UTF8);
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
    const response = await fetch(url, { ...init, signal: request.signal });
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
