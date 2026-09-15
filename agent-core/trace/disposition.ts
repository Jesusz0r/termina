/**
 * Trace write/retry predicates.
 *
 * Owns whether a write persisted, whether a storage range is real, and
 * which attempt statuses or provider terminations are terminal vs retryable.
 * Extracted from agent-core/main.ts (issue #324). The runtime still owns
 * record construction; this is the integration glue next to it.
 */
import type { TraceWriteOutcome } from "./schema.ts";

/** Decide whether a trace write actually persisted and whether a retry is
 * meaningful.  A failed write must not be mistaken for a durable attempt. */
export function traceWriteDisposition(
  outcome: TraceWriteOutcome,
): { persisted: boolean; retry: boolean; terminal: boolean } {
  const persisted = outcome.ok || outcome.persisted;
  const retryable = outcome.ok ? false : outcome.retryable;
  return {
    persisted,
    retry: !persisted && retryable,
    terminal: persisted || !retryable,
  };
}

/** Return a storage range only when this operation actually appended records. */
export function storageSeqRange(
  seqBefore: number,
  seqAfter: number,
): readonly [number, number] | null {
  if (!Number.isSafeInteger(seqBefore) || !Number.isSafeInteger(seqAfter)) return null;
  if (seqAfter < seqBefore + 1) return null;
  return [seqBefore + 1, seqAfter];
}

/** Intermediate provider records must not become the task's final attempt. */
export function isTerminalTraceAttemptStatus(status: string): boolean {
  return status !== "retrying" && status !== "fallback" && status !== "overflow";
}

/**
 * Bare provider stream terminations (observed as `response.failed` with the
 * message `terminated`, e.g. on the Codex relay) carry no actionable detail
 * and are worth exactly one immediate retry with identical bytes.
 */
export function isRetriableProviderTermination(message: string): boolean {
  return /^terminated$/i.test(message.trim());
}
