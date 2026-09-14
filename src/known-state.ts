/**
 * One owner for renderer IPC-state allowlists. Unknown values render as
 * "unknown", never as a meaningful neighboring state.
 */
export const UNKNOWN_STATE = "unknown" as const;
export type UnknownState = typeof UNKNOWN_STATE;

export function asKnownState<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T> | readonly T[],
): T | UnknownState {
  if (typeof value !== "string") return UNKNOWN_STATE;
  if (allowed instanceof Set) return allowed.has(value as T) ? (value as T) : UNKNOWN_STATE;
  return (allowed as readonly string[]).includes(value) ? (value as T) : UNKNOWN_STATE;
}

export const KNOWN_CANDIDATE_STATES = [
  "creating", "ready", "running", "settled", "verifying", "promoting",
  "conflict", "cancelled", "error", "discarding", "discarded", "promoted",
] as const;

export const KNOWN_PROFILE_WINNERS = ["A", "B", "tie", "unavailable"] as const;
export const KNOWN_EVIDENCE_STATUSES = ["pass", "fail", "unavailable"] as const;
export const KNOWN_FILE_STATUSES = ["created", "modified", "deleted"] as const;
export const KNOWN_PLAN_STATES = ["pending", "active", "done"] as const;
export const KNOWN_VERIFY_BADGE_STATES = ["pass", "fail", "timeout", "running", "cancelled"] as const;
export const KNOWN_RECORDER_STATES = ["indexing", "ready", "paused", "degraded", "budget"] as const;
