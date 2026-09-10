/**
 * Loop-guard trackers (extracted from agent-core/main.ts).
 *
 * Single owner for stall detection: exact identical-turn fingerprints plus
 * normalized same-target error/empty failure keys. Pure functions, no process
 * state; the run loop in main.ts owns the live tracker instances.
 *
 * Also owns the empty-search sentinel so producers (grep/glob bodies),
 * display, and the failure tracker share one source without a main↔stall
 * import cycle.
 */
import { hashCacheDiagnostic } from "./cache.ts";

/** Consecutive identical tool turns (same calls, same results) before the run settles stalled. */
export const STALL_TURNS = 3;

/** Consecutive same-target error/empty repeats before the soft nudge fires. */
export const STALL_FAILURE_TURNS = 3;

/** Stable empty-search sentinel emitted by grep/glob; single source for producers and checks. */
export const GREP_NO_MATCHES_PREFIX = "(no matches)";

/** True when tool output is the empty-search sentinel (plain fact; recovery guidance lives in the tool descriptions). */
export function isGrepNoMatches(content: unknown): boolean {
  if (typeof content !== "string") return false;
  return content.trim().toLowerCase().startsWith(GREP_NO_MATCHES_PREFIX.toLowerCase());
}

/** Consecutive identical tool-turn evidence for stall detection. */
export interface StallTracker {
  fingerprint: string | null;
  repeats: number;
}

export function emptyStallTracker(): StallTracker {
  return { fingerprint: null, repeats: 0 };
}

/**
 * Fingerprint one model turn's tool calls plus their results. Tool-call ids
 * differ every turn, so only names, canonical inputs, and result payloads
 * participate. Null when the turn made no tool calls: a text-only turn is
 * different behavior, not a repetition.
 */
export function stallTurnFingerprint(
  calls: ReadonlyArray<{ name: string; input: unknown; result: unknown }>,
): string | null {
  if (calls.length === 0) return null;
  return hashCacheDiagnostic(calls.map((call) => ({ name: call.name, input: call.input, result: call.result })));
}

/** Fold one turn fingerprint into the tracker. Any change (or text-only turn) resets the count. */
export function trackStallTurn(prev: StallTracker, fingerprint: string | null): StallTracker {
  if (fingerprint === null) return emptyStallTracker();
  if (prev.fingerprint !== null && prev.fingerprint === fingerprint) {
    return { fingerprint, repeats: prev.repeats + 1 };
  }
  return { fingerprint, repeats: 1 };
}

/** Consecutive same-target failure evidence (complements exact-match stall detection). */
export interface FailureLoopTracker {
  key: string | null;
  repeats: number;
}

export function emptyFailureLoopTracker(): FailureLoopTracker {
  return { key: null, repeats: 0 };
}

function stallFailureTarget(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const v = input as Record<string, unknown>;
  const pick = (k: string): string => (typeof v[k] === "string" ? (v[k] as string).trim() : "");
  // Stable target only: old_text/new_text are intentionally ignored so edit
  // retries with different snippets on the same file still collide.
  const parts = [pick("path"), pick("pattern"), pick("query"), pick("command"), pick("url")].filter(Boolean);
  return parts.join("|").slice(0, 320);
}

function stallResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return "";
  const v = result as Record<string, unknown>;
  for (const k of ["content", "text", "message", "error"]) {
    if (typeof v[k] === "string" && (v[k] as string).trim()) return v[k] as string;
  }
  try {
    return JSON.stringify(v).slice(0, 512);
  } catch {
    return "";
  }
}

function stallOutcomeKind(text: string, isError: boolean): "error" | "empty" | null {
  const t = text.trim();
  if (isError) return "error";
  if (!t) return "empty";
  if (t === "[]" || t === "{}" || isGrepNoMatches(t)) return "empty";
  return null;
}

/**
 * Normalized failure key for one tool call: tool + stable target + error/empty
 * kind. Null for productive turns so only stuck error/empty loops accumulate.
 */
export function stallFailureKey(call: { name: string; input: unknown; result: unknown; isError?: boolean }): string | null {
  const target = stallFailureTarget(call.input);
  const kind = stallOutcomeKind(stallResultText(call.result), call.isError === true);
  if (!kind) return null;
  const prefix = stallResultText(call.result).trim().split("\n")[0]?.slice(0, 80).toLowerCase().replace(/\d+/g, "#") ?? "";
  return `${call.name}|${target}|${kind}|${prefix}`;
}

/** Failure keys for one turn (nulls dropped). Empty means the turn made progress. */
export function stallFailureKeysForTurn(
  calls: ReadonlyArray<{ name: string; input: unknown; result: unknown; isError?: boolean }>,
): string[] {
  const keys: string[] = [];
  for (const call of calls) {
    const key = stallFailureKey(call);
    if (key) keys.push(key);
  }
  return keys;
}

/**
 * Fold one turn's failure keys into the tracker. A turn with no failure keys
 * (progress or text-only) resets. A mixed-target turn resets to 1 only when it
 * carries a single repeated key; otherwise it resets to avoid conflating
 * parallel independent work with a loop.
 */
export function trackFailureLoopTurn(prev: FailureLoopTracker, keys: readonly string[]): FailureLoopTracker {
  if (keys.length === 0) return emptyFailureLoopTracker();
  const first = keys[0]!;
  if (!keys.every((k) => k === first)) return emptyFailureLoopTracker();
  if (prev.key !== null && prev.key === first) {
    return { key: first, repeats: prev.repeats + keys.length };
  }
  return { key: first, repeats: keys.length };
}
