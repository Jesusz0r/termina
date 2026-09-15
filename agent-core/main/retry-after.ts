/**
 * Provider HTTP Retry-After wait.
 *
 * Pure: status + header + attempt → milliseconds or null. Used by the
 * live providerPost loop; not an auth-flow helper.
 * Extracted from agent-core/main.ts (issue #324).
 */

const RETRY_STATUSES = new Set([429, 529, 500, 502, 503]);
const RETRY_AFTER_CAP_S = 10;

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
