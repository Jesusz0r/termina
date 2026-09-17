/**
 * Provider HTTP Retry-After wait.
 *
 * Pure: status + header + attempt → milliseconds or null. Used by the
 * live providerPost loop; not an auth-flow helper.
 * Extracted from agent-core/main.ts (issue #324).
 *
 * Network throws (Node undici `TypeError: fetch failed` and connect/socket
 * codes) share the same attempt budget as 503 without Retry-After.
 */
import { errorCode } from "../../shared/guards.ts";

const RETRY_STATUSES = new Set([429, 529, 500, 502, 503]);
const RETRY_AFTER_CAP_S = 10;

const NETWORK_RETRY_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT",
]);

const NETWORK_RETRY_NAMES = new Set([
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
  "SocketError",
  "ConnectError",
]);

/** Milliseconds to wait, or null when this status/attempt must not retry. */
export function retryAfter(
  status: number,
  headers: { get(name: string): string | null },
  attempt: number,
): number | null {
  if (attempt >= 2) return null;
  if (!RETRY_STATUSES.has(status)) return null;
  const raw = headers.get("retry-after");
  if (raw !== null && raw !== "") {
    const secs = Number(raw);
    if (Number.isInteger(secs) && secs >= 0 && secs <= RETRY_AFTER_CAP_S) return secs * 1000;
  }
  return attempt === 0 ? 1_000 : 2_000;
}

function errorChain(error: unknown): unknown[] {
  const out: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current != null; depth++) {
    if (out.includes(current)) break;
    out.push(current);
    current = current && typeof current === "object" && "cause" in current
      ? (current as { cause: unknown }).cause
      : undefined;
  }
  return out;
}

function errorName(error: unknown): string {
  return error && typeof error === "object" && "name" in error && typeof error.name === "string"
    ? error.name
    : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "";
}

function isAbortError(error: unknown): boolean {
  for (const item of errorChain(error)) {
    if (errorName(item) === "AbortError") return true;
    const message = errorMessage(item);
    if (message === "aborted" || message === "This operation was aborted") return true;
  }
  return false;
}

/**
 * True for a dropped provider dial/stream that is worth the same bounded
 * retry as HTTP 503. User abort is never retryable.
 */
export function isRetryableNetworkError(error: unknown): boolean {
  if (error == null || isAbortError(error)) return false;
  for (const item of errorChain(error)) {
    const code = errorCode(item);
    if (code && NETWORK_RETRY_CODES.has(code)) return true;
    if (NETWORK_RETRY_NAMES.has(errorName(item))) return true;
    if (errorName(item) === "TypeError" && errorMessage(item) === "fetch failed") return true;
  }
  return false;
}

/** Same wait budget as a 503 without Retry-After, or null when not retryable. */
export function retryNetworkAfter(error: unknown, attempt: number): number | null {
  if (!isRetryableNetworkError(error)) return null;
  return retryAfter(503, { get: () => null }, attempt);
}

/** Stable terminal/trace text; prefer errno over undici's bare "fetch failed". */
export function formatNetworkError(error: unknown): string {
  for (const item of errorChain(error)) {
    const code = errorCode(item);
    if (code && NETWORK_RETRY_CODES.has(code)) return `fetch failed: ${code}`;
  }
  for (const item of errorChain(error)) {
    const message = errorMessage(item);
    if (message && message !== "fetch failed") return `fetch failed: ${message}`;
  }
  return "fetch failed";
}
