/**
 * Loop-guard trackers (extracted from agent-core/main.ts).
 *
 * Single owner for stall detection: opencode-parity exact repeats (same tool
 * + same input, three turns) plus normalized same-target error/empty failure
 * keys. Pure functions, no process state; the run loop in main.ts owns the
 * live tracker instances. Recovery is autonomous (model-visible guidance once,
 * then stop): the core loop has no human permission gate, so there is no
 * permission.ask equivalent here. Truncated responses fail their tool
 * calls via isTruncatedStopReason in main.ts, not here.
 *
 * Also owns the empty-search sentinel so producers (grep/glob bodies),
 * display, and the failure tracker share one source without a main↔stall
 * import cycle.
 */
import { hashCacheDiagnostic } from "./cache.ts";

/** Consecutive identical tool turns before recovery guidance (then a stop if ignored). */
export const STALL_TURNS = 3;

/** Consecutive same-target error/empty repeats before recovery guidance (then a stop if ignored). */
export const STALL_FAILURE_TURNS = 3;

/** Final run fuses: compaction must not make a malfunctioning run unbounded. */
export const MAX_RUN_MODEL_TURNS = 500;
export const MAX_RUN_TOOL_CALLS = 2_500;

/** Called only for responses requesting continuation, not a natural final answer. */
export function toolRunLimitReason(modelTurns: number, requestedToolCalls: number): string | null {
  if (modelTurns >= MAX_RUN_MODEL_TURNS) return `run limit reached after ${MAX_RUN_MODEL_TURNS} model turns`;
  if (requestedToolCalls > MAX_RUN_TOOL_CALLS) return `run would exceed ${MAX_RUN_TOOL_CALLS} tool calls`;
  return null;
}

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

type ToolTurnCall = { name: string; input: unknown; result: unknown; isError?: boolean };

/**
 * Fingerprint tool calls by identity (opencode doom-loop parity: same tool +
 * same input JSON, completed calls only). Results are deliberately excluded:
 * repeating the same action is not progress even when output text varies.
 * Null for a text-only turn: different behavior, not a repetition.
 */
export function stallTurnFingerprint(calls: readonly ToolTurnCall[]): string | null {
  if (calls.length === 0) return null;
  return hashCacheDiagnostic(calls.map((call) => ({
    name: call.name,
    input: call.input,
  })));
}

function stallResultPayload(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const block = result as Record<string, unknown>;
  if (block.type !== "tool_result") return result;
  // Only remove the envelope's correlation id, never ids in actual tool output.
  const { tool_use_id: _callId, ...payload } = block;
  return payload;
}

/**
 * Observed single-call fingerprint for cycle detection: identity plus semantic
 * result. New observations break cycles; merely re-reading unchanged text or
 * re-emitting the same output does not.
 */
function stallObservedFingerprint(call: ToolTurnCall): string {
  return hashCacheDiagnostic({
    name: call.name,
    input: call.input,
    result: stallResultPayload(call.result),
    isError: call.isError === true,
  });
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

function stallFailureTarget(name: string, input: unknown): string {
  if (input && typeof input === "object" && !Array.isArray(input) && (name === "edit" || name === "write_file")) {
    // Changing a guessed snippet or body is not a new target after a failure.
    return hashCacheDiagnostic({ path: (input as Record<string, unknown>).path });
  }
  // Keep search scopes, read ranges, and MCP-specific arguments. Dropping
  // those conflates independent work with retries of the same failed call.
  return hashCacheDiagnostic(input);
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
  const target = stallFailureTarget(call.name, call.input);
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

const MAX_CYCLE_TURNS = 8;
const RECENT_TURN_LIMIT = MAX_CYCLE_TURNS * STALL_TURNS;

export interface ToolLoopTracker {
  exact: StallTracker;
  failure: FailureLoopTracker;
  recoveryOffered: boolean;
  /** Bounded hashes only; never retain tool payloads across turns. */
  recentTurns: string[];
  warnedCycle: { key: string; turns: readonly string[] } | null;
}

export function emptyToolLoopTracker(): ToolLoopTracker {
  return {
    exact: emptyStallTracker(), failure: emptyFailureLoopTracker(), recoveryOffered: false,
    recentTurns: [], warnedCycle: null,
  };
}

function normalizedTurnFingerprint(calls: readonly ToolTurnCall[]): string {
  return hashCacheDiagnostic(calls.map((call) => stallFailureKey(call) ?? stallObservedFingerprint(call)).sort());
}

/** Find three repetitions of a short cycle, including reordered failure batches. */
function repeatedCycle(turns: readonly string[]): ToolLoopTracker["warnedCycle"] {
  for (let size = 1; size <= MAX_CYCLE_TURNS && size * STALL_TURNS <= turns.length; size++) {
    const start = turns.length - size * STALL_TURNS;
    if (!turns.slice(start).every((value, index) => value === turns[start + index % size])) continue;
    const cycle = turns.slice(-size);
    // A→B and B→A are the same cycle. Bound is eight, independent of run length.
    const rotations = cycle.map((_, i) => [...cycle.slice(i), ...cycle.slice(0, i)].join(":"));
    return { key: hashCacheDiagnostic(rotations.sort()[0]), turns: cycle };
  }
  return null;
}

function recoveryGuidance(calls: readonly ToolTurnCall[]): string {
  const editFailed = calls.some((call) => call.name === "edit" && call.isError);
  const steps = editFailed
    ? "Use read_file on the failed path before another edit. Copy a small, unique old_text from the current file, " +
      "without the N| line-number prefixes; preserve its whitespace. Do not guess another snippet or overwrite " +
      "the whole file to bypass an edit miss."
    : "Inspect the failed tool's inputs and current state, then change approach using the tool's recovery steps. " +
      "For empty searches, broaden the pattern or scope, or list files before searching again.";
  return "Tool loop detected: repeated calls are not making progress. Recover autonomously; do not repeat the failing approach. " +
    steps + " Continue the original task after recovery. If recovery is not possible, explain the concrete blocker instead of retrying.";
}

/**
 * Offer model-visible recovery, then stop if the same loop resumes. Remember
 * short cycles across reads: repeatedly re-reading unchanged text is not
 * recovery from a failed edit. New observations clear cycle escalation; merely
 * oscillating between already-observed successful edits does not.
 */
export function trackToolLoopTurn(
  prev: ToolLoopTracker,
  calls: readonly ToolTurnCall[],
): { tracker: ToolLoopTracker; recovery: string | null; stalled: boolean } {
  if (calls.length === 0) return { tracker: emptyToolLoopTracker(), recovery: null, stalled: false };
  const exact = trackStallTurn(prev.exact, stallTurnFingerprint(calls));
  const failure = trackFailureLoopTurn(prev.failure, stallFailureKeysForTurn(calls));
  const sameLoop = (exact.fingerprint !== null && exact.fingerprint === prev.exact.fingerprint) ||
    (failure.key !== null && failure.key === prev.failure.key);
  const turn = normalizedTurnFingerprint(calls);
  const recentTurns = [...prev.recentTurns, turn].slice(-RECENT_TURN_LIMIT);
  const cycle = repeatedCycle(recentTurns);
  const warnedCycle = prev.warnedCycle?.turns.includes(turn) ? prev.warnedCycle : null;
  const tracker: ToolLoopTracker = {
    exact, failure, recoveryOffered: sameLoop && prev.recoveryOffered, recentTurns, warnedCycle,
  };
  if (exact.repeats < STALL_TURNS && failure.repeats < STALL_FAILURE_TURNS && !cycle) {
    return { tracker, recovery: null, stalled: false };
  }
  if (tracker.recoveryOffered || (cycle !== null && cycle.key === warnedCycle?.key)) {
    return { tracker, recovery: null, stalled: true };
  }
  return {
    tracker: {
      exact: { ...exact, repeats: 0 }, failure: { ...failure, repeats: 0 },
      recoveryOffered: true, recentTurns: [], warnedCycle: cycle,
    },
    recovery: recoveryGuidance(calls),
    stalled: false,
  };
}
