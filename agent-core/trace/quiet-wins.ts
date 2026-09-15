/**
 * No Quiet Wins critical class (#237).
 *
 * A success claim after file edits with no observed check fails closed.
 * An observed check is a succeeding bash tool outcome already on the run
 * (no error, exit code 0 or absent). That is the same check fact #125
 * measures; this module is the settle gate, not the measurement report.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import { NO_QUIET_WINS_CLASS, TRACE_FILE_PATTERN } from "./schema.ts";

const EDIT_TOOLS = new Set(["edit", "write_file"]);
const CHECK_TOOL = "bash";

interface QuietWinsSettle {
  readonly status: string;
  readonly criticalClass: string | null;
}

function toolName(entry: Record<string, unknown>): string | null {
  return typeof entry.toolName === "string" ? entry.toolName : null;
}

/** Same success mapping as the laziness-metrics outcome classifier. */
function isSuccessClaim(status: string): boolean {
  return status.toLowerCase() === "success";
}

/** True when a succeeding bash outcome is already on the run. */
export function hasObservedCheck(outcomes: readonly unknown[]): boolean {
  for (const entry of outcomes) {
    if (!isRecord(entry)) continue;
    if (toolName(entry) !== CHECK_TOOL) continue;
    if (entry.isError === true) continue;
    const exitCode = entry.exitCode;
    if (exitCode === 0 || exitCode === null || exitCode === undefined) return true;
  }
  return false;
}

/** True when the run recorded an edit or write_file outcome. */
export function hasFileEdits(outcomes: readonly unknown[]): boolean {
  for (const entry of outcomes) {
    if (!isRecord(entry)) continue;
    const name = toolName(entry);
    if (name !== null && EDIT_TOOLS.has(name)) return true;
  }
  return false;
}

/**
 * Fail closed when a success claim follows file edits and no observed check.
 * `outcomes === null` means the trace directory could not be read: a success
 * claim then fails closed because the check fact is unobserved.
 * Non-success statuses and read-only successes pass through unchanged.
 */
export function applyNoQuietWins(status: string, outcomes: readonly unknown[] | null): QuietWinsSettle {
  if (!isSuccessClaim(status)) return { status, criticalClass: null };
  if (outcomes === null) return { status: "failure", criticalClass: NO_QUIET_WINS_CLASS };
  if (hasObservedCheck(outcomes)) return { status, criticalClass: null };
  if (!hasFileEdits(outcomes)) return { status, criticalClass: null };
  return { status: "failure", criticalClass: NO_QUIET_WINS_CLASS };
}

interface CollectedTaskOutcomes {
  readonly readable: boolean;
  readonly outcomes: readonly unknown[];
}

/** Collect tool outcomes already written for one task in a trace directory. */
export function collectTaskToolOutcomes(directory: string, runId: string, taskId: string): CollectedTaskOutcomes {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return { readable: false, outcomes: [] };
  }
  const outcomes: unknown[] = [];
  for (const name of names) {
    if (!TRACE_FILE_PATTERN.test(name)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(directory, name), "utf8"));
    } catch {
      // A turn file we cannot read is an unobserved check fact, not an empty run.
      return { readable: false, outcomes: [] };
    }
    if (!isRecord(parsed)) return { readable: false, outcomes: [] };
    if (parsed.recordType !== "attempt") continue;
    if (parsed.runId !== runId || parsed.taskId !== taskId) continue;
    const raw = parsed.toolOutcomes;
    if (Array.isArray(raw)) outcomes.push(...raw);
  }
  return { readable: true, outcomes };
}
