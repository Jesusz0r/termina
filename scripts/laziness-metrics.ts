/**
 * Laziness metrics over a trace-v2 corpus (issue #125).
 *
 * Reads `turn-N.json` records from one trace directory and reports three
 * settled-success laziness signals, each as count/total/rate:
 *
 * - editsWithoutCheck: the task settled successfully with at least one
 *   edit/write outcome and no succeeding bash outcome. Tool outcomes carry
 *   no command text in the current schema, so a "check" is approximated by
 *   tool name: bash with no error and a zero (or absent) exit code. An
 *   absent exit code counts as a check; see the corpus doc for the bias.
 * - zeroToolCalls: the task settled successfully with no tool outcomes at
 *   all. taskClass is free-form, so the report also breaks this signal
 *   down by task class instead of guessing an "execution" vocabulary.
 * - followupAfterSettle: a later task in the same run starts within a few
 *   turns of the settle turn — a structural proxy for "the user came right
 *   back". Records carry no message text, so the correction-phrase
 *   refinement ("you didn't actually...") is not derivable without a
 *   schema addition; the gap is documented, not papered over.
 *
 * Also emitted for budget/effort tuning: laziness by session-length
 * bucket, model, and effective effort, plus turns-per-task by outcome.
 *
 * Deterministic: sorted keys, no timestamps or paths. Read-only with the
 * same file bounds as trace-baseline; over-bound inputs land in
 * `integrity`, never in the denominators.
 *
 *   node --experimental-strip-types --no-warnings scripts/laziness-metrics.ts <trace-dir>
 */

import { isRecord } from "../shared/guards.ts";

export interface LazinessOptions {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxRecords: number;
  readonly followupTurns: number;
}

export const DEFAULT_LAZINESS_OPTIONS: LazinessOptions = {
  maxFiles: 10_000,
  maxFileBytes: 8 * 1024 * 1024,
  maxRecords: 100_000,
  followupTurns: 3,
};

const TURN_FILE_PATTERN = /^turn-(\d+)\.json$/;
const TRACE_SCHEMA_VERSION = 2;
const EDIT_TOOLS = new Set(["edit", "write_file"]);
const CHECK_TOOL = "bash";

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function rate(count: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((count / total) * 1e6) / 1e6;
}

/** Same success mapping as the trace report's outcome classifier. */
function isSuccessOutcome(status: string | null): boolean {
  if (status === null) return false;
  const normalized = status.toLowerCase();
  return normalized === "success" || normalized === "succeeded" || normalized === "ok";
}

function isAttemptRecord(value: Record<string, unknown>): boolean {
  return (
    value["recordType"] === "attempt" &&
    value["schemaVersion"] === TRACE_SCHEMA_VERSION &&
    asString(value["runId"]) !== null &&
    asString(value["taskId"]) !== null &&
    asString(value["attemptId"]) !== null
  );
}

function isSettlementRecord(value: Record<string, unknown>): boolean {
  return (
    value["recordType"] === "task-settled" &&
    value["schemaVersion"] === TRACE_SCHEMA_VERSION &&
    asString(value["runId"]) !== null &&
    asString(value["taskId"]) !== null
  );
}

interface ToolSignal {
  readonly edits: number;
  readonly checks: number;
  readonly calls: number;
}

function toolSignals(outcomes: unknown): ToolSignal {
  const list = Array.isArray(outcomes) ? outcomes : [];
  let edits = 0;
  let checks = 0;
  let calls = 0;
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    calls += 1;
    const name = asString(entry["toolName"] ?? entry["name"] ?? entry["tool"]);
    if (name !== null && EDIT_TOOLS.has(name)) edits += 1;
    if (name === CHECK_TOOL && entry["isError"] !== true) {
      const exitCode = entry["exitCode"];
      if (exitCode === 0 || exitCode === null || exitCode === undefined) checks += 1;
    }
  }
  return { edits, checks, calls };
}

interface TaskAcc {
  runId: string;
  taskId: string;
  attempts: number;
  firstTurn: number;
  settleTurn: number | null;
  settled: boolean;
  outcomeStatus: string | null;
  taskClass: string | null;
  model: string | null;
  effort: string | null;
  bucket: string | null;
  edits: number;
  checks: number;
  toolCalls: number;
}

export interface LazinessSignal {
  readonly count: number;
  readonly total: number;
  readonly rate: number;
}

export interface LazinessReport {
  readonly version: 1;
  readonly corpus: { readonly tasks: number; readonly settled: number; readonly settledSuccess: number };
  readonly signals: {
    readonly editsWithoutCheck: LazinessSignal;
    readonly zeroToolCalls: LazinessSignal;
    readonly followupAfterSettle: LazinessSignal;
  };
  readonly byTaskClass: { [key: string]: { readonly tasks: number; readonly zeroToolCalls: number; readonly editsWithoutCheck: number } };
  readonly bySessionLengthBucket: { [key: string]: { readonly tasks: number; readonly lazy: number } };
  readonly byModel: { [key: string]: { readonly tasks: number; readonly lazy: number } };
  readonly byEffort: { [key: string]: { readonly tasks: number; readonly lazy: number } };
  readonly turns: { [key: string]: { readonly tasks: number; readonly totalTurns: number; readonly p50Turns: number; readonly maxTurns: number } };
  readonly integrity: {
    readonly filesScanned: number;
    readonly malformedFiles: number;
    readonly oversizedFiles: number;
    readonly partialRecords: number;
    readonly scanOmittedFiles: number;
    readonly recordCapOmitted: number;
  };
}

function taskKey(runId: string, taskId: string): string {
  return `${runId}\u0000${taskId}`;
}

/** Dynamic import keeps the module importable without node builtins at type level. */
async function readLaziness(dir: string, options: LazinessOptions): Promise<LazinessReport> {
  const fs = await import("node:fs");
  const path = await import("node:path");

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    throw new Error(`cannot read trace directory: ${dir}`);
  }

  const turnFiles = entries
    .map((name) => ({ name, match: TURN_FILE_PATTERN.exec(name) }))
    .filter((entry) => entry.match !== null)
    .map((entry) => ({ name: entry.name, turn: Number(entry.match?.[1]) }))
    .filter((entry) => Number.isInteger(entry.turn) && entry.turn >= 0)
    .sort((a, b) => a.turn - b.turn);

  const integrity = {
    filesScanned: 0,
    malformedFiles: 0,
    oversizedFiles: 0,
    partialRecords: 0,
    scanOmittedFiles: 0,
    recordCapOmitted: 0,
  };
  if (turnFiles.length > options.maxFiles) {
    integrity.scanOmittedFiles = turnFiles.length - options.maxFiles;
    turnFiles.length = options.maxFiles;
  }

  const tasks = new Map<string, TaskAcc>();
  let recordsSeen = 0;

  const getTask = (runId: string, taskId: string, turn: number): TaskAcc => {
    const key = taskKey(runId, taskId);
    let acc = tasks.get(key);
    if (!acc) {
      acc = {
        runId,
        taskId,
        attempts: 0,
        firstTurn: turn,
        settleTurn: null,
        settled: false,
        outcomeStatus: null,
        taskClass: null,
        model: null,
        effort: null,
        bucket: null,
        edits: 0,
        checks: 0,
        toolCalls: 0,
      };
      tasks.set(key, acc);
    }
    if (turn < acc.firstTurn) acc.firstTurn = turn;
    return acc;
  };

  for (const file of turnFiles) {
    const filePath = path.join(dir, file.name);
    let statSize: number;
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        integrity.malformedFiles += 1;
        continue;
      }
      statSize = stat.size;
    } catch {
      integrity.malformedFiles += 1;
      continue;
    }
    if (statSize > options.maxFileBytes) {
      integrity.oversizedFiles += 1;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      integrity.malformedFiles += 1;
      continue;
    }
    integrity.filesScanned += 1;
    if (recordsSeen >= options.maxRecords) {
      integrity.recordCapOmitted += 1;
      continue;
    }
    if (!isRecord(parsed) || (!isAttemptRecord(parsed) && !isSettlementRecord(parsed))) {
      integrity.partialRecords += 1;
      continue;
    }
    recordsSeen += 1;
    const runId = asString(parsed["runId"]) ?? "";
    const taskId = asString(parsed["taskId"]) ?? "";
    const task = getTask(runId, taskId, file.turn);

    if (parsed["recordType"] === "attempt") {
      task.attempts += 1;
      const outcomes = parsed["toolOutcomes"] ?? parsed["toolResults"];
      const signals = toolSignals(outcomes);
      task.edits += signals.edits;
      task.checks += signals.checks;
      task.toolCalls += signals.calls;
      const cls = asString(parsed["taskClass"]);
      if (cls !== null && task.taskClass === null) task.taskClass = cls;
      const model = asString(parsed["model"]);
      if (model !== null && task.model === null) task.model = model;
      const effort = asString(parsed["effectiveEffort"]) ?? asString(parsed["requestedEffort"]);
      if (effort !== null && task.effort === null) task.effort = effort;
      const bucket = asString(parsed["sessionLengthBucket"]);
      if (bucket !== null && task.bucket === null) task.bucket = bucket;
    } else {
      task.settled = true;
      if (task.settleTurn === null) task.settleTurn = file.turn;
      const outcome = isRecord(parsed["outcome"]) ? parsed["outcome"] : {};
      const status = asString(outcome["status"]);
      if (status !== null) task.outcomeStatus = status;
      const cls = asString(parsed["taskClass"]);
      if (cls !== null && task.taskClass === null) task.taskClass = cls;
    }
  }

  const settled = [...tasks.values()].filter((task) => task.settled);
  const success = settled.filter((task) => isSuccessOutcome(task.outcomeStatus));

  const editsWithoutCheck = success.filter((task) => task.edits > 0 && task.checks === 0);
  const zeroToolCalls = success.filter((task) => task.toolCalls === 0);

  // Follow-ups need run order: group success tasks by run, ordered by first turn.
  const byRun = new Map<string, TaskAcc[]>();
  for (const task of success) {
    const group = byRun.get(task.runId) ?? [];
    group.push(task);
    byRun.set(task.runId, group);
  }
  for (const group of byRun.values()) group.sort((a, b) => a.firstTurn - b.firstTurn || (a.taskId < b.taskId ? -1 : 1));
  let followupTotal = 0;
  let followupCount = 0;
  for (const group of byRun.values()) {
    for (let index = 0; index < group.length; index++) {
      const task = group[index]!;
      if (task.settleTurn === null || index === group.length - 1) continue;
      const next = group[index + 1]!;
      followupTotal += 1;
      if (next.firstTurn - task.settleTurn <= options.followupTurns) followupCount += 1;
    }
  }

  const lazyKeys = new Set<string>();
  for (const task of [...editsWithoutCheck, ...zeroToolCalls]) lazyKeys.add(taskKey(task.runId, task.taskId));
  for (const group of byRun.values()) {
    for (let index = 0; index < group.length - 1; index++) {
      const task = group[index]!;
      const next = group[index + 1]!;
      if (task.settleTurn !== null && next.firstTurn - task.settleTurn <= options.followupTurns) {
        lazyKeys.add(taskKey(task.runId, task.taskId));
      }
    }
  }

  const byTaskClass: Record<string, { tasks: number; zeroToolCalls: number; editsWithoutCheck: number }> = {};
  const classOf = (task: TaskAcc): string => task.taskClass ?? "unknown";
  for (const task of success) {
    const key = classOf(task);
    const entry = byTaskClass[key] ?? { tasks: 0, zeroToolCalls: 0, editsWithoutCheck: 0 };
    entry.tasks += 1;
    if (task.toolCalls === 0) entry.zeroToolCalls += 1;
    if (task.edits > 0 && task.checks === 0) entry.editsWithoutCheck += 1;
    byTaskClass[key] = entry;
  }

  const breakdown = (keyOf: (task: TaskAcc) => string): Record<string, { tasks: number; lazy: number }> => {
    const out: Record<string, { tasks: number; lazy: number }> = {};
    for (const task of success) {
      const key = keyOf(task);
      const entry = out[key] ?? { tasks: 0, lazy: 0 };
      entry.tasks += 1;
      if (lazyKeys.has(taskKey(task.runId, task.taskId))) entry.lazy += 1;
      out[key] = entry;
    }
    return Object.fromEntries([...Object.entries(out)].sort(([a], [b]) => (a < b ? -1 : 1)));
  };

  const turnsByOutcome = new Map<string, number[]>();
  for (const task of tasks.values()) {
    const outcome = !task.settled ? "unsettled" : (task.outcomeStatus ?? "unknown").toLowerCase();
    const list = turnsByOutcome.get(outcome) ?? [];
    list.push(task.attempts);
    turnsByOutcome.set(outcome, list);
  }
  const turns: Record<string, { tasks: number; totalTurns: number; p50Turns: number; maxTurns: number }> = {};
  for (const [outcome, list] of [...turnsByOutcome.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const sorted = [...list].sort((a, b) => a - b);
    turns[outcome] = {
      tasks: sorted.length,
      totalTurns: sorted.reduce((sum, value) => sum + value, 0),
      p50Turns: sorted[Math.floor((sorted.length - 1) / 2)] ?? 0,
      maxTurns: sorted[sorted.length - 1] ?? 0,
    };
  }

  return {
    version: 1,
    corpus: { tasks: tasks.size, settled: settled.length, settledSuccess: success.length },
    signals: {
      editsWithoutCheck: { count: editsWithoutCheck.length, total: success.length, rate: rate(editsWithoutCheck.length, success.length) },
      zeroToolCalls: { count: zeroToolCalls.length, total: success.length, rate: rate(zeroToolCalls.length, success.length) },
      followupAfterSettle: { count: followupCount, total: followupTotal, rate: rate(followupCount, followupTotal) },
    },
    byTaskClass: Object.fromEntries([...Object.entries(byTaskClass)].sort(([a], [b]) => (a < b ? -1 : 1))),
    bySessionLengthBucket: breakdown((task) => task.bucket ?? "unknown"),
    byModel: breakdown((task) => task.model ?? "unknown"),
    byEffort: breakdown((task) => task.effort ?? "unknown"),
    turns,
    integrity,
  };
}

function isMain(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("laziness-metrics.ts");
}

if (isMain()) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: laziness-metrics.ts <trace-dir>");
    process.exit(1);
  }
  readLaziness(dir, DEFAULT_LAZINESS_OPTIONS)
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
    })
    .catch((error) => {
      console.error(`laziness-metrics: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}

export { readLaziness };
