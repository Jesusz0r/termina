/**
 * Baseline consumer for trace-v2 directories (roadmap P0 §2).
 *
 * Reads `turn-N.json` records plus `trace-manifest.json` from one trace
 * directory and prints a single JSON baseline document to stdout. The
 * document is a pure function of the directory contents: no timestamps,
 * no absolute paths, sorted keys — re-running on an immutable fixture
 * yields byte-identical output.
 *
 * Unknown stays unknown: nullable usage/cost counters are summed over
 * known values only, with explicit known/unknown/explicit-zero counts so
 * no efficiency denominator silently coerces a missing field to zero.
 * Correctness is never inferred; it comes only from `task-settled`
 * records. Malformed, oversized, partial, and scan-omitted inputs are
 * counted in `integrity`, never merged into the denominators.
 *
 * Read-only: only readdir/readFileSync. Bounds keep a hostile directory
 * from exhausting the caller; everything over a bound lands in
 * `integrity` counters.
 *
 *   node --experimental-strip-types --no-warnings scripts/trace-baseline.ts <trace-dir>
 */
import { TRACE_SCHEMA_VERSION } from "../agent-core/trace/schema.ts";
import { nullableNumber } from "../agent-core/trace/normalize.ts";
import { isRecord } from "../shared/guards.ts";

export interface BaselineOptions {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxRecords: number;
}

export const DEFAULT_BASELINE_OPTIONS: BaselineOptions = {
  maxFiles: 10_000,
  maxFileBytes: 8 * 1024 * 1024,
  maxRecords: 100_000,
};

const TURN_FILE_PATTERN = /^turn-(\d+)\.json$/;
const MANIFEST_FILE = "trace-manifest.json";

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return nullableNumber(value);
}

/** A present-but-invalid counter (negative or non-finite number) fails the record. */
function hasInvalidCounter(values: readonly unknown[]): boolean {
  return values.some((value) => typeof value === "number" && nullableNumber(value) === null);
}

/**
 * Minimal fs surface for bounded reads, injectable so growth races are
 * unit-testable without a concurrent writer.
 */
export interface BaselineFs {
  readonly constants: { readonly O_RDONLY: number; readonly O_NOFOLLOW?: number };
  openSync(path: string, flags: number): number;
  fstatSync(fd: number): { isFile(): boolean; size: number };
  readFileSync(fd: number): Buffer;
  closeSync(fd: number): void;
}

export type BoundedRead = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: "malformed" | "oversized" };

/**
 * Read one JSON file through an unlinked-safe descriptor: no symlink
 * following, regular files only, and the byte bound enforced on the bytes
 * actually consumed — not just on an earlier stat — so concurrent growth
 * or special files cannot slip an unbounded read past the check.
 */
export function readBoundedJsonFile(fsMod: BaselineFs, filePath: string, maxBytes: number): BoundedRead {
  const noFollow = typeof fsMod.constants.O_NOFOLLOW === "number" ? fsMod.constants.O_NOFOLLOW : 0;
  let fd: number | null = null;
  try {
    fd = fsMod.openSync(filePath, fsMod.constants.O_RDONLY | noFollow);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  try {
    let isFile = false;
    let size = 0;
    try {
      const stat = fsMod.fstatSync(fd);
      isFile = stat.isFile();
      size = stat.size;
    } catch {
      return { ok: false, reason: "malformed" };
    }
    if (!isFile) return { ok: false, reason: "malformed" };
    if (size > maxBytes) return { ok: false, reason: "oversized" };
    let bytes: Buffer;
    try {
      bytes = fsMod.readFileSync(fd);
    } catch {
      return { ok: false, reason: "malformed" };
    }
    if (bytes.byteLength > maxBytes) return { ok: false, reason: "oversized" };
    try {
      return { ok: true, value: JSON.parse(bytes.toString("utf8")) };
    } catch {
      return { ok: false, reason: "malformed" };
    }
  } finally {
    if (fd !== null) {
      try {
        fsMod.closeSync(fd);
      } catch {
        /* best effort; the read already settled */
      }
    }
  }
}

function countKey(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedObject(map: Map<string, number>): { [key: string]: number } {
  const out: { [key: string]: number } = {};
  for (const key of [...map.keys()].sort()) out[key] = map.get(key) ?? 0;
  return out;
}

interface UsageTally {
  known: number;
  explicitZero: number;
  unknown: number;
  sum: number;
}

function newUsageTally(): UsageTally {
  return { known: 0, explicitZero: 0, unknown: 0, sum: 0 };
}

function tallyUsage(tally: UsageTally, value: unknown): void {
  const n = asNumber(value);
  if (n === null) {
    tally.unknown += 1;
    return;
  }
  if (n === 0) tally.explicitZero += 1;
  else tally.known += 1;
  tally.sum += n;
}

interface TaskAcc {
  attempts: string[];
  retries: number;
  roles: Map<string, number>;
  settled: boolean;
  outcomeStatus: string | null;
  correctness: string | null;
  taskClass: string | null;
}

export interface BaselineReport {
  readonly version: 1;
  readonly records: { readonly attempts: number; readonly settlements: number };
  readonly tasks: {
    readonly count: number;
    readonly settled: number;
    readonly open: number;
    readonly byOutcome: { [key: string]: number };
    readonly byCorrectness: { [key: string]: number };
    readonly byTaskClass: { [key: string]: number };
  };
  readonly attempts: {
    readonly byRole: { [key: string]: number };
    readonly byProvider: { [key: string]: number };
    readonly byProtocol: { [key: string]: number };
    readonly byModel: { [key: string]: number };
    readonly byStatus: { [key: string]: number };
    readonly retries: number;
    readonly fallbacks: number;
  };
  readonly usage: {
    readonly input: UsageTally;
    readonly cacheRead: UsageTally;
    readonly cacheWrite: UsageTally;
    readonly output: UsageTally;
    readonly reasoning: UsageTally;
  };
  readonly cache: {
    readonly hits: number;
    readonly explicitZeroRead: number;
    readonly unknownRead: number;
    readonly requestedVsEffectiveMismatch: number;
    readonly byMissCause: { [key: string]: number };
    readonly unattributedWithRead: number;
  };
  readonly cost: { readonly knownCount: number; readonly knownUsd: number; readonly unknownCount: number };
  readonly integrity: {
    readonly filesScanned: number;
    readonly malformedFiles: number;
    readonly oversizedFiles: number;
    readonly partialRecords: number;
    readonly scanOmittedFiles: number;
    readonly recordCapOmitted: number;
    readonly writerRetainedRecords: number | null;
    readonly writerOmittedRecords: number | null;
    readonly writerWriteFailures: number | null;
    readonly writerMalformedRecords: number | null;
    readonly writerPartialRecords: number | null;
  };
}

function emptyReport(): BaselineReport {
  const usage = {
    input: newUsageTally(),
    cacheRead: newUsageTally(),
    cacheWrite: newUsageTally(),
    output: newUsageTally(),
    reasoning: newUsageTally(),
  };
  return {
    version: 1,
    records: { attempts: 0, settlements: 0 },
    tasks: { count: 0, settled: 0, open: 0, byOutcome: {}, byCorrectness: {}, byTaskClass: {} },
    attempts: { byRole: {}, byProvider: {}, byProtocol: {}, byModel: {}, byStatus: {}, retries: 0, fallbacks: 0 },
    usage,
    cache: {
      hits: 0,
      explicitZeroRead: 0,
      unknownRead: 0,
      requestedVsEffectiveMismatch: 0,
      byMissCause: {},
      unattributedWithRead: 0,
    },
    cost: { knownCount: 0, knownUsd: 0, unknownCount: 0 },
    integrity: {
      filesScanned: 0,
      malformedFiles: 0,
      oversizedFiles: 0,
      partialRecords: 0,
      scanOmittedFiles: 0,
      recordCapOmitted: 0,
      writerRetainedRecords: null,
      writerOmittedRecords: null,
      writerWriteFailures: null,
      writerMalformedRecords: null,
      writerPartialRecords: null,
    },
  };
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

function taskKey(runId: string, taskId: string): string {
  return `${runId}\u0000${taskId}`;
}

/** Dynamic import keeps the module importable without node builtins at type level. */
async function readBaseline(dir: string, options: BaselineOptions): Promise<BaselineReport> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const report = emptyReport();
  const r = report as unknown as {
    records: { attempts: number; settlements: number };
    integrity: Record<string, number>;
  };

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

  if (turnFiles.length > options.maxFiles) {
    (report.integrity as unknown as Record<string, number>)["scanOmittedFiles"] = turnFiles.length - options.maxFiles;
    turnFiles.length = options.maxFiles;
  }

  const manifestPath = path.join(dir, MANIFEST_FILE);
  const manifestRead = readBoundedJsonFile(fs, manifestPath, options.maxFileBytes);
  if (manifestRead.ok && isRecord(manifestRead.value)) {
    const manifest = manifestRead.value;
    const w = report.integrity as unknown as Record<string, number | null>;
    for (const key of [
      "retainedRecords",
      "omittedRecords",
      "writeFailures",
      "malformedRecords",
      "partialRecords",
    ] as const) {
      const n = asNumber(manifest[key]);
      if (n !== null) w[`writer${key[0].toUpperCase()}${key.slice(1)}`] = n;
    }
  } else if (!manifestRead.ok && manifestRead.reason === "oversized") {
    // An over-bound manifest is untrustworthy input, not an absent one.
    (report.integrity as unknown as Record<string, number>)["malformedFiles"] += 1;
  }
  // An absent or malformed manifest is a valid state for a bare fixture
  // directory; only an oversized one is counted.

  const byRole = new Map<string, number>();
  const byProvider = new Map<string, number>();
  const byProtocol = new Map<string, number>();
  const byModel = new Map<string, number>();
  const byStatus = new Map<string, number>();
  const byOutcome = new Map<string, number>();
  const byCorrectness = new Map<string, number>();
  const byTaskClass = new Map<string, number>();
  const byMissCause = new Map<string, number>();
  const tasks = new Map<string, TaskAcc>();
  let recordsSeen = 0;

  const getTask = (runId: string, taskId: string): TaskAcc => {
    const key = taskKey(runId, taskId);
    let acc = tasks.get(key);
    if (!acc) {
      acc = { attempts: [], retries: 0, roles: new Map(), settled: false, outcomeStatus: null, correctness: null, taskClass: null };
      tasks.set(key, acc);
    }
    return acc;
  };

  for (const file of turnFiles) {
    const filePath = path.join(dir, file.name);
    const bounded = readBoundedJsonFile(fs, filePath, options.maxFileBytes);
    if (!bounded.ok) {
      (report.integrity as unknown as Record<string, number>)[bounded.reason === "oversized" ? "oversizedFiles" : "malformedFiles"] += 1;
      continue;
    }
    const parsed: unknown = bounded.value;
    (report.integrity as unknown as Record<string, number>)["filesScanned"] += 1;
    if (recordsSeen >= options.maxRecords) {
      (report.integrity as unknown as Record<string, number>)["recordCapOmitted"] += 1;
      continue;
    }
    if (!isRecord(parsed) || (!isAttemptRecord(parsed) && !isSettlementRecord(parsed))) {
      (report.integrity as unknown as Record<string, number>)["partialRecords"] += 1;
      continue;
    }
    if (parsed["recordType"] === "attempt") {
      // Negative or non-finite counters fail the record: corrupt evidence
      // must land in integrity, never in the totals. Missing or mistyped
      // fields stay unknown and are preserved downstream, not zeroed.
      const usageCheck = isRecord(parsed["usage"]) ? parsed["usage"] : {};
      const costCheck = isRecord(parsed["cost"]) ? parsed["cost"] : {};
      if (
        hasInvalidCounter([
          usageCheck["input"],
          usageCheck["cacheRead"],
          usageCheck["cacheWrite"],
          usageCheck["output"],
          usageCheck["reasoning"],
          costCheck["usd"],
        ])
      ) {
        (report.integrity as unknown as Record<string, number>)["partialRecords"] += 1;
        continue;
      }
    }
    recordsSeen += 1;
    const runId = asString(parsed["runId"]) ?? "";
    const taskId = asString(parsed["taskId"]) ?? "";
    const task = getTask(runId, taskId);

    if (parsed["recordType"] === "attempt") {
      r.records.attempts += 1;
      const attemptId = asString(parsed["attemptId"]) ?? "";
      task.attempts.push(attemptId);
      if (asString(parsed["retryOfAttemptId"]) !== null) {
        task.retries += 1;
        (report.attempts as unknown as Record<string, number>)["retries"] += 1;
      }
      if (asString(parsed["fallbackReason"]) !== null) {
        (report.attempts as unknown as Record<string, number>)["fallbacks"] += 1;
      }
      const role = asString(parsed["role"]) ?? "unknown";
      countKey(byRole, role);
      countKey(task.roles, role);
      countKey(byProvider, asString(parsed["provider"]) ?? "unknown");
      countKey(byProtocol, asString(parsed["protocol"]) ?? "unknown");
      countKey(byModel, asString(parsed["model"]) ?? "unknown");
      countKey(byStatus, asString(parsed["status"]) ?? "unknown");

      const usage = isRecord(parsed["usage"]) ? parsed["usage"] : {};
      const u = report.usage;
      tallyUsage(u.input, usage["input"]);
      tallyUsage(u.cacheRead, usage["cacheRead"]);
      tallyUsage(u.cacheWrite, usage["cacheWrite"]);
      tallyUsage(u.output, usage["output"]);
      tallyUsage(u.reasoning, usage["reasoning"]);

      const cacheRead = asNumber(usage["cacheRead"]);
      const c = report.cache as unknown as Record<string, number>;
      if (cacheRead === null) c["unknownRead"] += 1;
      else if (cacheRead > 0) c["hits"] += 1;
      else c["explicitZeroRead"] += 1;

      const cache = isRecord(parsed["cache"]) ? parsed["cache"] : {};
      const requested = isRecord(cache["requested"]) ? (cache["requested"] as Record<string, unknown>) : {};
      const effective = isRecord(cache["effective"]) ? (cache["effective"] as Record<string, unknown>) : {};
      if (asString(requested["mode"]) !== asString(effective["mode"])) c["requestedVsEffectiveMismatch"] += 1;
      const miss = isRecord(cache["missAttribution"]) ? (cache["missAttribution"] as Record<string, unknown>) : {};
      const primary = asString(miss["primary"]);
      if (primary !== null) countKey(byMissCause, primary);
      else if (cacheRead !== null && cacheRead === 0) c["unattributedWithRead"] += 1;

      const cost = isRecord(parsed["cost"]) ? parsed["cost"] : {};
      const usd = asNumber(cost["usd"]);
      const co = report.cost as unknown as Record<string, number>;
      if (usd === null) co["unknownCount"] += 1;
      else {
        co["knownCount"] += 1;
        co["knownUsd"] += usd;
      }

      const cls = asString(parsed["taskClass"]);
      if (cls !== null && task.taskClass === null) task.taskClass = cls;
    } else {
      r.records.settlements += 1;
      task.settled = true;
      const outcome = isRecord(parsed["outcome"]) ? (parsed["outcome"] as Record<string, unknown>) : {};
      const status = asString(outcome["status"]);
      const correctness = asString(outcome["correctness"]);
      if (status !== null) task.outcomeStatus = status;
      if (correctness !== null) task.correctness = correctness;
      const cls = asString(parsed["taskClass"]);
      if (cls !== null && task.taskClass === null) task.taskClass = cls;
    }
  }

  const settledTasks = [...tasks.values()].filter((t) => t.settled);
  const t = report.tasks as unknown as Record<string, number | Record<string, number>>;
  t["count"] = tasks.size;
  t["settled"] = settledTasks.length;
  t["open"] = tasks.size - settledTasks.length;
  for (const task of settledTasks) {
    countKey(byOutcome, task.outcomeStatus ?? "unknown");
    countKey(byCorrectness, task.correctness ?? "unknown");
    if (task.taskClass !== null) countKey(byTaskClass, task.taskClass);
  }

  const a = report.attempts as unknown as Record<string, number | Record<string, number>>;
  a["byRole"] = sortedObject(byRole);
  a["byProvider"] = sortedObject(byProvider);
  a["byProtocol"] = sortedObject(byProtocol);
  a["byModel"] = sortedObject(byModel);
  a["byStatus"] = sortedObject(byStatus);
  t["byOutcome"] = sortedObject(byOutcome);
  t["byCorrectness"] = sortedObject(byCorrectness);
  t["byTaskClass"] = sortedObject(byTaskClass);
  (report.cache as unknown as Record<string, number | Record<string, number>>)["byMissCause"] = sortedObject(byMissCause);
  // Deterministic float addition order comes from sorted turn order; round display only.
  (report.cost as unknown as Record<string, number>)["knownUsd"] = Math.round(report.cost.knownUsd * 1e8) / 1e8;
  return report;
}

function isMain(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("trace-baseline.ts");
}

if (isMain()) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: trace-baseline.ts <trace-dir>");
    process.exit(1);
  }
  readBaseline(dir, DEFAULT_BASELINE_OPTIONS)
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
    })
    .catch((error) => {
      console.error(`trace-baseline: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}

export { readBaseline };
