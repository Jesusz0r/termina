/**
 * Background subagents registry (SUBAGENTS-PLAN.md Phase 1).
 *
 * Single owner for subagent run records: ids, state, path claims, caps,
 * spawn/message validation, and child-output scanning. Headless execution
 * (spawning, sidecar tailing, settle/kill/retry) lands in Phase 2 and lives
 * in `electron/subagents.ts`; this module never spawns a process.
 *
 * Approval request/ack and inbox file I/O lives in `./subagents/` (own
 * atomic writer). This entry keeps `SubagentRegistry` and `SUBAGENT_TOOL_DEFS`.
 *
 * Runs start `active` and resolve exactly once via `settleRun`. Phase 1 has
 * no executor, so runs stay active until Phase 2 settles them; the
 * exactly-once invariant is already enforced here and covered by tests.
 */

import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { utf8TextPrefix } from "./tool-output.ts";

export { utf8TextPrefix as truncateUtf8, utf8TextSuffix } from "./tool-output.ts";
import { readBoundedRegularFile } from "./main/files.ts";
import {
  isSupportedProvider,
  parseModelRef,
  providerProtocol as configuredProviderProtocol,
  resolveAuth,
  type ProviderId,
  type ProviderProtocol,
} from "./auth.ts";
import {
  EFFORT_LEVELS,
  clampEffortLevel,
  supportedEffortLevels,
  type EffortLevel,
} from "./models/capabilities.ts";

/** A lone child is overhead: fan out at least two, or do the work on the parent. */
export const MIN_SUBAGENT_RUNS = 2;
/** Anthropic rule adopted by the plan: at most 4 parallel runs. */
export const MAX_SUBAGENT_RUNS = 4;
/** Manual fan-out bound: user explicitly asked for many agents. Still bounded
 * so one prompt cannot fork-bomb the host; concurrency stays safe. */
export const MAX_SUBAGENT_RUNS_USER = 20;
/** Children never receive the spawn tool: max spawn depth 1. */
export const MAX_SUBAGENT_DEPTH = 1;
/** Bound the parent-written subtask brief kept on the run record, in string length. */
export const MAX_SUBAGENT_TASK_CHARS = 8_000;
/** Bound the child-facing brief (task plus sibling-claim section), in string length. */
export const MAX_SUBAGENT_BRIEF_CHARS = 12_000;
/** Bound touched paths carried per run (merge detection, not a full manifest). */
export const MAX_SUBAGENT_TOUCHED = 200;
/** Bound one parent-to-child message, in string length. */
export const MAX_SUBAGENT_MESSAGE_CHARS = 8_000;
/** Bound one child result held for parent fan-in, in UTF-8 bytes on both sides of the host boundary (the host clamps identically; the suffix is historical). */
export const MAX_SUBAGENT_RESULT_CHARS = 32_000;
/** Bound one child failure diagnostic held for parent fan-in, in UTF-8 bytes on both sides of the host boundary (the host clamps identically; the suffix is historical). */
export const MAX_SUBAGENT_ERROR_CHARS = 4_000;
/** Cap claimed paths per spawn so one run cannot reserve the tree. */
export const MAX_SUBAGENT_CLAIM_PATHS = 20;
/** Bound queued parent-to-child messages per run (bounded memory; Phase 2 drains). */
export const MAX_SUBAGENT_INBOX_MSGS = 50;
/**
 * Settled-run retention window (#215). Active runs are always retained; the
 * registry keeps only the N most recently settled records for resume and
 * result excerpts, and evicts older ones on settle. Beyond the window a run
 * id is unknown again: resume/message fail closed and the
 * identical-failed-brief scan no longer sees it. Registry memory stays
 * bounded by active runs plus N settled records.
 */
export const MAX_SETTLED_SUBAGENT_RUNS = 10;

export type SubagentPermissionMode = "always" | "dangerous" | "ask";

export type SubagentRunState = "active" | "settled" | "failed" | "killed";

export interface SubagentParent {
  provider: ProviderId;
  model: string;
  protocol?: ProviderProtocol;
  permissionMode: SubagentPermissionMode;
  /** 0 for a normal session; children run at depth 1 and cannot spawn. */
  depth: number;
}

export interface SubagentSpawnRequest {
  task: string;
  model?: string;
  effort?: string;
  /** Raw provider JSON: validated here so a malformed claim errors instead of silently dropping lease protection. */
  paths?: unknown;
  /**
   * Raw run id (bg-N) of a settled sibling run to continue. The child replays
   * that run's session and treats this task as a follow-up. Must name a
   * non-active run; anything else fails closed.
   */
  resume?: unknown;
  /** Raw user_requested flag: true only when the user explicitly asked for
   * parallel agents this turn. Bypasses the 4-run auto cap. */
  userRequested?: unknown;
  parent: SubagentParent;
}

export interface SubagentRun {
  id: string;
  task: string;
  provider: ProviderId;
  model: string;
  protocol: ProviderProtocol;
  effort: EffortLevel;
  /** Inherited at spawn; the registry offers no API to widen it. */
  permissionMode: SubagentPermissionMode;
  depth: number;
  paths: string[];
  /** Settled sibling run this run continues, if any. */
  resumeRunId: string | null;
  /** True when the user explicitly requested this fan-out (manual bypass). */
  userRequested: boolean;
  state: SubagentRunState;
  /** Parent-to-child texts in arrival order (answers, redirects). */
  inbox: string[];
  /** Scanned final result once settled; never intermediate tool streams. */
  result: string | null;
  /** Failure/kill diagnostic once resolved; null for settled runs. */
  error: string | null;
  /** Additive scan markers on the result (see scanSubagentOutput). */
  flags: string[];
  createdAt: number;
}

export type SubagentAuthCheck = (provider: string) => Promise<{ ok: boolean; error?: string }>;

/** Tool definitions for the agent surface; main.ts spreads these into TOOLS. */
export const SUBAGENT_TOOL_DEFS: Array<Record<string, unknown>> = [
  {
    name: "spawn_subagent",
    description:
      "Spawn a background subagent for one independent subtask. Never spawn a single child: issue at least two spawn_subagent calls in the same turn for parallel work; a lone subtask belongs on this agent. The brief must be complete (goal, file paths, decisions, done-criteria): children start context-fresh. Returns a run id immediately and does not wait: continue this turn, then stop. When the child settles, the host writes a mailbox note; you see that note only on the next user turn — summarize it then and never poll the finished run. Siblings never share a subtask; pass paths to reserve them. Pass resume with a settled sibling run id to continue it: the child replays that run's session and treats the brief as a follow-up. Pass user_requested true only when the user explicitly asked for many/parallel agents in this turn: it bypasses the 4-run auto cap.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        task: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        resume: { type: "string" },
        user_requested: { type: "boolean" },
        paths: { type: "array", items: { type: "string" } },
      },
      required: ["task"],
    },
  },
  {
    name: "message_subagent",
    description:
      "Push text into a running subagent (answers, redirects, cancellation reason). Unknown or finished run ids are errors, not silent drops.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        run_id: { type: "string" },
        text: { type: "string" },
      },
      required: ["run_id", "text"],
    },
  },
];

/** Depth marker for headless children: `TERMINA_CORE_SUBAGENT_DEPTH`. */
export function subagentDepthFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TERMINA_CORE_SUBAGENT_DEPTH?.trim() ?? "";
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return 0;
  return n;
}

/** Marker set by the worldline candidate launch; candidates never spawn subagents. */
export const WORLDLINE_CANDIDATE_ENV = "TERMINA_WORLDLINE_CANDIDATE";

/** True when this core runs inside a sandboxed worldline candidate. */
export function isWorldlineCandidateEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[WORLDLINE_CANDIDATE_ENV] === "1";
}

/** Refuse a turn that would start the only live child. `batchSpawnCount` is
 *  distinct executable spawn_subagent calls in this assistant message (invalid
 *  args and duplicate-action entries do not count). Adding a sibling while
 *  another run is already active is allowed. */
export function admitSubagentFanout(
  activeCount: number,
  batchSpawnCount: number,
): { ok: true } | { ok: false; error: string } {
  if (batchSpawnCount <= 0) return { ok: true };
  if (activeCount + batchSpawnCount >= MIN_SUBAGENT_RUNS) return { ok: true };
  return {
    ok: false,
    error: `spawn at least ${MIN_SUBAGENT_RUNS} subagents in the same turn for parallel work; a single subtask belongs on the main agent`,
  };
}

/** Children never receive `spawn_subagent` (max depth 1); main.ts spreads this into TOOLS. */
export function visibleSubagentTools(depth: number): Array<Record<string, unknown>> {
  // Children own a fresh empty registry: they can neither spawn (depth cap)
  // nor message (no runs exist), so they receive no subagent tools at all.
  if (depth >= MAX_SUBAGENT_DEPTH) return [];
  return SUBAGENT_TOOL_DEFS.slice();
}

// ---- Phase 2 contract: parent → host handoff and host → parent results ----
//
// The spawn tool runs inside the parent core process, but the headless child
// is launched by the Electron host (`electron/subagents.ts`), which never
// sees the subtask brief. The parent therefore writes a task file and emits
// a `subagent_spawn` sidecar record on its own (tailed) stream; the host
// launches the child from the task file and writes one durable result file
// per run, which the parent reconciles on its next turn. Mailbox notes carry
// the human-readable result; result files carry the exact outcome.

/** Sidecar record kind announcing a validated spawn (parsed by `electron/sidecar.ts`). */
export const SUBAGENT_SPAWN_RECORD = "subagent_spawn";
export const SUBAGENT_TASK_VERSION = 1;
export const SUBAGENT_RESULT_VERSION = 1;
/** Bound one handoff/result file: the brief is already capped, this is slack for fields. */
export const MAX_SUBAGENT_FILE_BYTES = 64 * 1024;

function subagentFileName(parentTerminalId: string, runId: string, suffix: "task.json" | "result.json"): string | null {
  // Namespaced by parent terminal: bg-N ids are per-process, and the events
  // dir is shared, so two parents spawning bg-1 must not share files (a
  // parent would otherwise settle with another parent's result).
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(parentTerminalId)) return null;
  if (!/^bg-\d{1,10}$/.test(runId)) return null;
  return `subagent-${parentTerminalId}-${runId}.${suffix}`;
}

export function subagentTaskFileName(parentTerminalId: string, runId: string): string | null {
  return subagentFileName(parentTerminalId, runId, "task.json");
}

export function subagentResultFileName(parentTerminalId: string, runId: string): string | null {
  return subagentFileName(parentTerminalId, runId, "result.json");
}

export interface SubagentTaskFile {
  version: typeof SUBAGENT_TASK_VERSION;
  runId: string;
  task: string;
  /** Child-facing brief: the task plus the sibling-claim section. The child runs this. */
  brief: string;
  /** Settled sibling run to continue, if any. The host resolves this to that
   *  run's session bundle, which the child replays before running the brief
   *  as a follow-up. Null starts a fresh session. */
  resumeRunId: string | null;
  provider: ProviderId;
  model: string;
  protocol: ProviderProtocol;
  effort: EffortLevel;
  paths: string[];
  permissionMode: SubagentPermissionMode;
  parentTerminalId: string;
  cwd: string;
  depth: number;
  /** True when the user explicitly requested this fan-out. Older files omit it (false). */
  userRequested: boolean;
  createdAt: number;
}

/**
 * Append sibling claims to the child-facing brief (mirrors the dispatch
 * briefing's sibling section). The task itself is never truncated; the
 * sibling list caps at 20 entries with a "+N more" marker so the brief
 * always fits MAX_SUBAGENT_BRIEF_CHARS.
 */
export function formatSubagentBrief(task: string, siblingPaths: string[]): string {
  if (task.length >= MAX_SUBAGENT_BRIEF_CHARS) return task;
  const unique = [...new Set(siblingPaths.map((p) => p.trim()).filter(Boolean))].sort();
  if (unique.length === 0) return task;
  const header = "Sibling path claims (do not edit these files; a sibling run owns them):";
  let shown = unique.slice(0, 20);
  const build = (): string => {
    const lines = ["", header, ...shown.map((p) => `- \`${p}\``)];
    const hidden = unique.length - shown.length;
    if (hidden > 0) lines.push(`- (+${hidden} more)`);
    return `${task}\n${lines.join("\n")}`;
  };
  let brief = build();
  while (brief.length > MAX_SUBAGENT_BRIEF_CHARS && shown.length > 0) {
    shown = shown.slice(0, -1);
    brief = build();
  }
  return brief;
}

export function parseSubagentTaskFile(raw: unknown): { ok: true; file: SubagentTaskFile } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "subagent task file is not an object" };
  const v = raw as Record<string, unknown>;
  if (v.version !== SUBAGENT_TASK_VERSION) return { ok: false, error: "subagent task file has an unsupported version" };
  if (typeof v.runId !== "string" || !/^bg-\d{1,10}$/.test(v.runId)) {
    return { ok: false, error: "subagent task file has a bad run id" };
  }
  if (v.resumeRunId !== null && v.resumeRunId !== undefined) {
    if (typeof v.resumeRunId !== "string" || !/^bg-\d{1,10}$/.test(v.resumeRunId)) {
      return { ok: false, error: "subagent task file has a bad resume run id" };
    }
    if (v.resumeRunId === v.runId) return { ok: false, error: "subagent task file resumes itself" };
  }
  const resumeRunId: string | null = typeof v.resumeRunId === "string" ? v.resumeRunId : null;
  if (typeof v.task !== "string" || !v.task.trim() || v.task.length > MAX_SUBAGENT_TASK_CHARS) {
    return { ok: false, error: "subagent task file has a bad task" };
  }
  if (typeof v.brief !== "string" || !v.brief.trim() || v.brief.length > MAX_SUBAGENT_BRIEF_CHARS) {
    return { ok: false, error: "subagent task file has a bad brief" };
  }
  if (typeof v.provider !== "string" || !isSupportedProvider(v.provider)) {
    return { ok: false, error: "subagent task file has a bad provider" };
  }
  if (typeof v.model !== "string" || !v.model) return { ok: false, error: "subagent task file has a bad model" };
  if (typeof v.effort !== "string" || !(EFFORT_LEVELS as readonly string[]).includes(v.effort)) {
    return { ok: false, error: "subagent task file has a bad effort" };
  }
  // Older builds wrote maxTurns. Ignore it: children follow the same stop
  // rules as the parent (user stop, natural finish, provider limits).
  if (!Array.isArray(v.paths) || v.paths.length > MAX_SUBAGENT_CLAIM_PATHS) {
    return { ok: false, error: "subagent task file has bad paths" };
  }
  const paths: string[] = [];
  for (const p of v.paths) {
    const norm = normalizeClaimPath(p);
    if (!norm.ok) return { ok: false, error: `subagent task file has a bad path: ${norm.error}` };
    paths.push(norm.path);
  }
  if (v.permissionMode !== "always" && v.permissionMode !== "dangerous" && v.permissionMode !== "ask") {
    return { ok: false, error: "subagent task file has a bad permission mode" };
  }
  if (typeof v.parentTerminalId !== "string" || !v.parentTerminalId) {
    return { ok: false, error: "subagent task file has a bad parent terminal" };
  }
  if (typeof v.cwd !== "string" || !v.cwd) return { ok: false, error: "subagent task file has a bad cwd" };
  if (!Number.isInteger(v.depth) || (v.depth as number) < 1 || (v.depth as number) > MAX_SUBAGENT_DEPTH) {
    return { ok: false, error: "subagent task file has a bad depth" };
  }
  if (v.userRequested !== undefined && typeof v.userRequested !== "boolean") {
    return { ok: false, error: "subagent task file has a bad userRequested" };
  }
  return {
    ok: true,
    file: {
      version: SUBAGENT_TASK_VERSION,
      runId: v.runId,
      task: v.task,
      brief: v.brief,
      resumeRunId,
      provider: v.provider,
      model: v.model,
      protocol: (typeof v.protocol === "string" ? v.protocol : configuredProviderProtocol(v.provider, v.model)) as ProviderProtocol,
      effort: v.effort as EffortLevel,
      paths,
      permissionMode: v.permissionMode,
      parentTerminalId: v.parentTerminalId,
      cwd: v.cwd,
      depth: v.depth as number,
      userRequested: v.userRequested === true,
      createdAt: typeof v.createdAt === "number" ? v.createdAt : Date.now(),
    },
  };
}

/** Atomic JSON write (tmp + rename) so the host sees a complete task file or none. */
function atomicWriteJsonSync(dir: string, name: string, body: string): boolean {
  try {
    const target = join(dir, name);
    const temp = `${target}.${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}.tmp`;
    writeFileSync(temp, body, { mode: 0o600 });
    renameSync(temp, target);
    return true;
  } catch {
    return false;
  }
}

/** Write the host handoff before emitting the sidecar spawn record (file lands first). */
export function writeSubagentTaskFile(
  eventsDir: string,
  run: SubagentRun,
  opts: { parentTerminalId: string; cwd: string; brief?: string },
): { ok: true; file: string } | { ok: false; error: string } {
  const name = subagentTaskFileName(opts.parentTerminalId, run.id);
  if (!name) return { ok: false, error: `bad subagent handoff identity: ${opts.parentTerminalId}/${run.id}` };
  if (!eventsDir || !opts.parentTerminalId || !opts.cwd) {
    return { ok: false, error: "subagent handoff needs an events dir, parent terminal, and cwd" };
  }
  const brief = opts.brief ?? run.task;
  if (!brief.trim() || brief.length > MAX_SUBAGENT_BRIEF_CHARS) {
    return { ok: false, error: "subagent brief exceeds its budget" };
  }
  const body = JSON.stringify({
    version: SUBAGENT_TASK_VERSION,
    runId: run.id,
    task: run.task,
    brief,
    resumeRunId: run.resumeRunId,
    provider: run.provider,
    model: run.model,
    protocol: run.protocol,
    effort: run.effort,
    paths: run.paths,
    permissionMode: run.permissionMode,
    parentTerminalId: opts.parentTerminalId,
    cwd: opts.cwd,
    depth: run.depth,
    userRequested: run.userRequested,
    createdAt: run.createdAt,
  });
  // Atomic like the approval/inbox writers: the host must see a complete
  // task file or none, never a torn write. Same name, bytes, and mode.
  if (!atomicWriteJsonSync(eventsDir, name, body)) {
    return { ok: false, error: "subagent task file write failed" };
  }
  return { ok: true, file: name };
}

export type SubagentOutcome = Extract<SubagentRunState, "settled" | "failed" | "killed">;

export interface SubagentResultFile {
  version: typeof SUBAGENT_RESULT_VERSION;
  runId: string;
  outcome: SubagentOutcome;
  result: string;
  /** Failure/kill diagnostic; null for settled runs. Older writers omit it. */
  error: string | null;
  flags: string[];
  /** Absolute touched paths (bounded) for sibling merge detection. */
  touched: string[];
  settledAt: number;
}

export function parseSubagentResultFile(
  runId: string,
  raw: unknown,
): { ok: true; file: SubagentResultFile } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "subagent result is not an object" };
  const v = raw as Record<string, unknown>;
  if (v.version !== SUBAGENT_RESULT_VERSION) return { ok: false, error: "subagent result has an unsupported version" };
  if (v.runId !== runId) return { ok: false, error: "subagent result is for another run" };
  if (v.outcome !== "settled" && v.outcome !== "failed" && v.outcome !== "killed") {
    return { ok: false, error: "subagent result has a bad outcome" };
  }
  if (typeof v.result !== "string" || Buffer.byteLength(v.result, "utf8") > MAX_SUBAGENT_RESULT_CHARS) {
    return { ok: false, error: "subagent result has a bad payload" };
  }
  if (!Array.isArray(v.flags) || v.flags.some((f) => typeof f !== "string")) {
    return { ok: false, error: "subagent result has bad flags" };
  }
  // Error is the failure diagnostic: absent/null (older writers, settled
  // runs) means none; malformed means the whole file is untrusted.
  let error: string | null = null;
  if (v.error !== undefined && v.error !== null) {
    if (typeof v.error !== "string" || Buffer.byteLength(v.error, "utf8") > MAX_SUBAGENT_ERROR_CHARS) {
      return { ok: false, error: "subagent result has a bad error" };
    }
    error = v.error;
  }
  // Touched is advisory merge evidence: absent (older writers) means none,
  // malformed means the whole file is untrusted.
  let touched: string[] = [];
  if (v.touched !== undefined) {
    if (!Array.isArray(v.touched) || v.touched.length > MAX_SUBAGENT_TOUCHED || v.touched.some((p) => typeof p !== "string")) {
      return { ok: false, error: "subagent result has bad touched paths" };
    }
    touched = v.touched as string[];
  }
  return {
    ok: true,
    file: {
      version: SUBAGENT_RESULT_VERSION,
      runId,
      outcome: v.outcome,
      result: v.result,
      error,
      flags: v.flags as string[],
      touched,
      settledAt: typeof v.settledAt === "number" ? v.settledAt : Date.now(),
    },
  };
}

type SubagentResultRead =
  | { status: "missing" }
  | { status: "invalid"; error: string }
  | { status: "ok"; file: SubagentResultFile };

/** Read one host-written result. Invalid files never settle a run; the host owns the repair. */
export function readSubagentResultFile(
  eventsDir: string,
  parentTerminalId: string,
  runId: string,
): SubagentResultRead {
  const name = subagentResultFileName(parentTerminalId, runId);
  if (!name || !eventsDir) return { status: "missing" };
  const path = join(eventsDir, name);
  if (!existsSync(path)) return { status: "missing" };
  const bounded = readBoundedRegularFile(path, MAX_SUBAGENT_FILE_BYTES);
  if ("error" in bounded) return { status: "invalid", error: "subagent result is unreadable" };
  if (bounded.truncated) return { status: "invalid", error: "subagent result exceeds its file budget" };
  const raw = bounded.text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "invalid", error: "subagent result is not JSON" };
  }
  const checked = parseSubagentResultFile(runId, parsed);
  if (!checked.ok) return { status: "invalid", error: checked.error };
  return { status: "ok", file: checked.file };
}

/**
 * Settle locally active runs whose host result files landed. The parent
 * calls this at turn start, on each model loop, and from the idle approval
 * poll so slots (and the TUI live-run count) drop when a result file lands
 * without waiting for the next user turn. The human-readable result arrives
 * via the host mailbox note; this only reconciles registry truth. Consumed
 * result files are deleted best-effort:
 * the scanned outcome already lives on the run record, and a crash between
 * settle and delete is harmless (the run is no longer active, so a second
 * read can never re-settle it).
 */
export function reconcileSubagentRuns(
  eventsDir: string,
  parentTerminalId: string,
  registry: SubagentRegistry,
): SubagentRun[] {
  if (!eventsDir || !parentTerminalId) return [];
  const settled: SubagentRun[] = [];
  for (const run of registry.activeRuns()) {
    const read = readSubagentResultFile(eventsDir, parentTerminalId, run.id);
    if (read.status !== "ok") continue;
    const done = registry.settleRun(run.id, read.file.result, read.file.outcome, read.file.error);
    if (!done.ok) continue;
    const name = subagentResultFileName(parentTerminalId, run.id);
    if (name) {
      try {
        rmSync(join(eventsDir, name));
      } catch {
        /* The run record already holds the outcome; a leftover is host evidence. */
      }
    }
    settled.push(done.run);
  }
  return settled;
}

/** Sidecar body announcing a validated spawn; the host launches from the task file.
 * The userRequested flag is informational (manual bypass audit trail). */
export function subagentSpawnSidecarRecord(
  runId: string,
  taskFile: string,
  userRequested = false,
): Record<string, unknown> {
  return { t: SUBAGENT_SPAWN_RECORD, runId, taskFile, userRequested };
}

// ---- Phase 2 slice 2a: child result framing (engine stdout → host) ----
//
// The headless child prints its full transcript on stdout (like `-p`) and,
// last, exactly one framed line. The host takes the LAST framed line, so
// model text can never collide with it: nothing is printed after it unless
// the child crashes, in which case there is no frame and the run fails.

/** stdout sentinel starting the child's final framed line. */
export const SUBAGENT_RESULT_PREFIX = "SUBAGENT_RESULT ";

export interface SubagentResultFrame {
  ok: boolean;
  result?: string;
  error?: string;
}

export function formatSubagentResultFrame(frame: SubagentResultFrame): string {
  return `${SUBAGENT_RESULT_PREFIX}${JSON.stringify(frame)}`;
}

export function parseSubagentResultFrame(line: string): SubagentResultFrame | null {
  if (!line.startsWith(SUBAGENT_RESULT_PREFIX)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line.slice(SUBAGENT_RESULT_PREFIX.length));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.ok !== "boolean") return null;
  if (v.result !== undefined && typeof v.result !== "string") return null;
  if (v.error !== undefined && typeof v.error !== "string") return null;
  return { ok: v.ok, ...(typeof v.result === "string" ? { result: v.result } : {}), ...(typeof v.error === "string" ? { error: v.error } : {}) };
}

function normalizeClaimPath(raw: unknown): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "spawn_subagent paths must be strings" };
  // Control characters would break the brief markdown and overlap matching.
  if (/[\0-\x1f\x7f]/.test(raw)) return { ok: false, error: "claim paths must not contain control characters" };
  // Collapse duplicate slashes and resolve `.` segments so `./x`, `a//b`,
  // and `a/./b` cannot evade overlap detection against `x` / `a/b`.
  const collapsed = raw.trim().replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  if (!collapsed) return { ok: false, error: "claim paths must not be empty" };
  if (collapsed.length > 200) return { ok: false, error: `claim path too long: ${collapsed.slice(0, 60)}` };
  if (collapsed.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(collapsed)) {
    return { ok: false, error: `claim paths must be project-relative: ${collapsed.slice(0, 60)}` };
  }
  const kept: string[] = [];
  for (const segment of collapsed.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") return { ok: false, error: `claim paths must not escape the project: ${collapsed.slice(0, 60)}` };
    kept.push(segment);
  }
  if (kept.length === 0) return { ok: false, error: "claim paths must not be empty" };
  return { ok: true, path: kept.join("/") };
}

/** Overlap = same path or one contains the other at a `/` boundary. */
export function subagentPathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Anchor a cwd-relative claim path at a root (Phase 4 unified claims).
 * Dispatch keys live at the workspace root while claims are cwd-relative;
 * joining a cwd-relative path to the root miskeys whenever cwd is a
 * subdirectory. Returns the root-anchored pair when cwd sits under root,
 * else the original pair (which then matches nothing — fail closed toward
 * no false overlap).
 */
export function anchorClaimPath(cwd: string, relPath: string, root: string): { rel: string; root: string } {
  const abs = join(cwd, relPath);
  const rel = relative(root, abs);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return { rel, root };
  return { rel: relPath, root: cwd };
}

export type SubagentScan = { text: string; flags: string[] };

const CONTROL_TAG_RE = /<\s*\/?\s*system-reminder\s*>/gi;
const PERMISSION_CONFIG_RES = [
  /\.claude\/settings\.json/,
  /bypassPermissions/,
  /--dangerously-skip-permissions/,
  /always\s+approve/i,
];
const TURN_BOUNDARY_RE = /^(Human|Assistant)(\s*:)/;
/** Invisible separator: breaks fake turn prefixes without changing visible text. */
const TURN_BREAK = String.fromCharCode(0x200b);

/**
 * Scan child output at the host boundary before the parent reads it.
 * Neutralizes control-tag imitation in place, breaks fake turn boundaries
 * with an invisible separator (visible text unchanged), and flags
 * permission-configuration mentions without touching the text.
 */
export function scanSubagentOutput(raw: string): SubagentScan {
  const flags: string[] = [];
  let text = raw;
  CONTROL_TAG_RE.lastIndex = 0;
  if (CONTROL_TAG_RE.test(text)) {
    flags.push("control-tag");
    text = text.replace(CONTROL_TAG_RE, (m) => m.replace("<", "&lt;").replace(">", "&gt;"));
  }
  if (PERMISSION_CONFIG_RES.some((re) => re.test(text)) && !flags.includes("permission-config")) {
    flags.push("permission-config");
  }
  const lines = text.split("\n");
  let broke = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (TURN_BOUNDARY_RE.test(line)) {
      lines[i] = line.replace(TURN_BOUNDARY_RE, `$1${TURN_BREAK}$2`);
      broke = true;
    }
  }
  if (broke) {
    flags.push("turn-boundary");
    text = lines.join("\n");
  }
  return { text, flags: [...new Set(flags)] };
}

export class SubagentRegistry {
  private runs = new Map<string, SubagentRun>();
  private nextId = 1;
  private readonly authCheck: SubagentAuthCheck;

  constructor(opts?: { authCheck?: SubagentAuthCheck }) {
    this.authCheck = opts?.authCheck ?? (async (provider) => resolveAuth(provider));
  }

  /** Active (unresolved) runs, oldest first. */
  activeRuns(): SubagentRun[] {
    return [...this.runs.values()].filter((r) => r.state === "active");
  }

  get(runId: string): SubagentRun | undefined {
    return this.runs.get(runId);
  }

  /** Test + Phase 2 lifecycle hook: resolve exactly once. */
  settleRun(
    runId: string,
    result: string,
    outcome: Extract<SubagentRunState, "settled" | "failed" | "killed"> = "settled",
    error: string | null = null,
  ): { ok: true; run: SubagentRun } | { ok: false; error: string } {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, error: `unknown subagent run: ${runId}` };
    if (run.state !== "active") return { ok: false, error: `subagent run ${runId} is already ${run.state}` };
    if (Buffer.byteLength(result, "utf8") > MAX_SUBAGENT_RESULT_CHARS) {
      return { ok: false, error: `subagent result exceeds ${MAX_SUBAGENT_RESULT_CHARS} chars` };
    }
    const scanned = scanSubagentOutput(result);
    run.state = outcome;
    run.result = scanned.text;
    run.flags = scanned.flags;
    run.error = outcome === "settled" || !error?.trim() ? null : utf8TextPrefix(error, MAX_SUBAGENT_ERROR_CHARS);
    // Re-insert so map order is settle order for settled runs; the retention
    // window below trims the least recently settled first. Active relative
    // order is unchanged (the settling run leaves the active set).
    this.runs.delete(runId);
    this.runs.set(runId, run);
    this.evictSettledRuns();
    return { ok: true, run };
  }

  /** Drop settled runs beyond the retention window, least recently settled first. */
  private evictSettledRuns(): void {
    const settled: string[] = [];
    for (const [id, run] of this.runs) {
      if (run.state !== "active") settled.push(id);
    }
    const overflow = settled.length - MAX_SETTLED_SUBAGENT_RUNS;
    for (let i = 0; i < overflow; i++) this.runs.delete(settled[i]!);
  }

  async spawn(req: SubagentSpawnRequest): Promise<{ ok: true; run: SubagentRun } | { ok: false; error: string }> {
    const { parent } = req;
    if (parent.depth >= MAX_SUBAGENT_DEPTH) {
      return { ok: false, error: "subagents cannot spawn subagents (max depth 1)" };
    }
    const task = req.task?.trim() ?? "";
    if (!task) return { ok: false, error: "spawn_subagent task must not be empty" };
    if (req.userRequested !== undefined && typeof req.userRequested !== "boolean") {
      return { ok: false, error: "spawn_subagent user_requested must be a boolean" };
    }
    if (task.length > MAX_SUBAGENT_TASK_CHARS) {
      return { ok: false, error: `spawn_subagent task exceeds ${MAX_SUBAGENT_TASK_CHARS} chars` };
    }
    // Resume target must be a settled sibling run: continuing an active run
    // would fork its session, and an unknown id can never resolve to one.
    // Resuming an empty failed run with an identical brief would repeat it
    // exactly (empty session, same task), so that stays blocked below.
    let resumeRunId: string | null = null;
    if (req.resume !== undefined && req.resume !== null) {
      if (typeof req.resume !== "string") return { ok: false, error: "spawn_subagent resume must be a run id" };
      const resumeRaw = req.resume.trim();
      if (!/^bg-\d{1,10}$/.test(resumeRaw)) return { ok: false, error: "spawn_subagent resume must be a run id" };
      const prior = this.runs.get(resumeRaw);
      if (!prior) return { ok: false, error: `unknown subagent run: ${resumeRaw}` };
      if (prior.state === "active") return { ok: false, error: `subagent run ${resumeRaw} is still active` };
      if (prior.state === "failed" && !prior.result?.trim() && prior.task === task) {
        return { ok: false, error: `identical brief already failed as ${prior.id} with an empty result — rewrite the task instead of respawning it unchanged` };
      }
      resumeRunId = resumeRaw;
    }
    // An identical brief that already failed empty-handed will fail the same
    // way: the child never delivered anything, so there is nothing to iterate
    // on. Fail closed here instead of burning another identical boot. An
    // explicit resume of a run with session content is exempt: it is the
    // sanctioned retry-with-context (resuming an empty failed run with an
    // identical brief stays blocked above).
    if (resumeRunId === null) {
      for (const prior of this.runs.values()) {
        if (prior.state === "failed" && !prior.result?.trim() && prior.task === task) {
          return { ok: false, error: `identical brief already failed as ${prior.id} with an empty result — rewrite the task instead of respawning it unchanged` };
        }
      }
    }
    const paths: string[] = [];
    if (req.paths !== undefined) {
      if (!Array.isArray(req.paths)) return { ok: false, error: "spawn_subagent paths must be an array" };
      if (req.paths.length > MAX_SUBAGENT_CLAIM_PATHS) {
        return { ok: false, error: `spawn_subagent claims at most ${MAX_SUBAGENT_CLAIM_PATHS} paths` };
      }
      for (const raw of req.paths) {
        const norm = normalizeClaimPath(raw);
        if (!norm.ok) return { ok: false, error: norm.error };
        if (!paths.includes(norm.path)) paths.push(norm.path);
      }
    }
    // Resolve the child route: a `provider/id` ref, else a bare id against
    // the parent provider. Unknown prefixes and unrecognized ids fail closed.
    let provider: ProviderId = parent.provider;
    let model = parent.model;
    const modelRaw = req.model?.trim() ?? "";
    if (modelRaw) {
      if (modelRaw.startsWith("/")) return { ok: false, error: "spawn_subagent model must be provider/id or a bare id" };
      const slash = modelRaw.indexOf("/");
      if (slash > 0 && !isSupportedProvider(modelRaw.slice(0, slash))) {
        return { ok: false, error: `unsupported provider: ${modelRaw.slice(0, slash)}` };
      }
      const parsed = slash > 0 ? parseModelRef(modelRaw) : parseModelRef(modelRaw, parent.provider);
      if (!parsed) return { ok: false, error: `unknown model: ${modelRaw}` };
      if (!isSupportedProvider(parsed.provider)) return { ok: false, error: `unsupported provider: ${parsed.provider}` };
      provider = parsed.provider;
      model = parsed.model;
    }
    const protocol: ProviderProtocol =
      parent.provider === provider && parent.protocol ? parent.protocol : configuredProviderProtocol(provider, model);
    const auth = await this.authCheck(provider);
    if (!auth.ok) {
      const err = auth.error ?? `not authenticated: ${provider}`;
      return { ok: false, error: /\/login/.test(err) ? err : `${err} — run /login` };
    }
    let effort: EffortLevel;
    const effortRaw = req.effort?.trim() ?? "";
    if (effortRaw) {
      if (!(EFFORT_LEVELS as readonly string[]).includes(effortRaw)) {
        return { ok: false, error: `unsupported effort: ${effortRaw}` };
      }
      effort = clampEffortLevel(provider, model, effortRaw as EffortLevel, protocol);
    } else {
      // Cheap lane unless asked: the floor of the child route, not the parent level.
      effort = supportedEffortLevels(provider, model, protocol)[0] ?? "off";
    }
    const active = this.activeRuns();
    const userRequested = req.userRequested === true;
    const cap = userRequested ? MAX_SUBAGENT_RUNS_USER : MAX_SUBAGENT_RUNS;
    if (active.length >= cap) {
      return { ok: false, error: userRequested ? `at most ${cap} user-requested subagent runs at once` : `at most ${cap} subagent runs at once` };
    }
    for (const other of active) {
      for (const p of paths) {
        const hit = other.paths.find((q) => subagentPathsOverlap(p, q));
        if (hit) return { ok: false, error: `paths overlap running subagent ${other.id} (${hit})` };
      }
    }
    const run: SubagentRun = {
      id: `bg-${this.nextId++}`,
      task,
      resumeRunId,
      userRequested,
      provider,
      model,
      protocol,
      effort,
      permissionMode: parent.permissionMode,
      depth: parent.depth + 1,
      paths,
      state: "active",
      inbox: [],
      result: null,
      error: null,
      flags: [],
      createdAt: Date.now(),
    };
    this.runs.set(run.id, run);
    return { ok: true, run };
  }

  message(runId: string, text: string): { ok: true } | { ok: false; error: string } {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, error: `unknown subagent run: ${runId}` };
    if (run.state !== "active") {
      // Ground the parent immediately: a nudge sent while the run was dying
      // races settlement, and the bare "already failed" leaves the parent
      // re-asking about a dead run instead of moving on.
      const outcome = `subagent run ${runId} is already ${run.state}`;
      const excerpt = (run.result ?? "").trim().slice(0, 300);
      if (excerpt) return { ok: false, error: `${outcome} with result: ${excerpt}` };
      const errExcerpt = (run.error ?? "").trim().slice(0, 300);
      return { ok: false, error: errExcerpt ? `${outcome} with error: ${errExcerpt}` : `${outcome} with an empty result` };
    }
    const clean = text?.trim() ?? "";
    if (!clean) return { ok: false, error: "message_subagent text must not be empty" };
    if (clean.length > MAX_SUBAGENT_MESSAGE_CHARS) {
      return { ok: false, error: `message_subagent text exceeds ${MAX_SUBAGENT_MESSAGE_CHARS} chars` };
    }
    if (run.inbox.length >= MAX_SUBAGENT_INBOX_MSGS) {
      return { ok: false, error: `subagent run ${runId} inbox is full (${MAX_SUBAGENT_INBOX_MSGS} messages)` };
    }
    run.inbox.push(clean);
    return { ok: true };
  }

  /** Test-only reset; production registries live for the process. */
  clear(): void {
    this.runs.clear();
    this.nextId = 1;
  }
}

const TERMINAL_RE = /^[A-Za-z0-9_-]{1,128}$/;
const RUN_RE = /^bg-\d{1,10}$/;

/** Child sidecar id: `sub-<parent>-<bgN>`. Single owner (host adopts it). */
export function subagentChildTid(parentTerminalId: string, runId: string): string | null {
  if (!TERMINAL_RE.test(parentTerminalId) || !RUN_RE.test(runId)) return null;
  const tid = `sub-${parentTerminalId.slice(0, 64)}-${runId}`;
  return tid.length <= 128 ? tid : null;
}

/** Child sidecar id shape: `sub-<parent>-<bgN>` (see electron/subagents.ts). */
const SUBAGENT_STREAM_RE = /^sub-[A-Za-z0-9_-]{1,64}-bg-\d{1,10}$/;

/**
 * Every file the subagent system may leave in the events dir: namespaced
 * task/result handoffs (plus result-write temps), child sidecar streams,
 * and their cursor/sealed/quarantine companions. The Electron startup sweep
 * removes these orphans; nothing else in the events dir matches.
 */
export function isSubagentManagedFile(name: string): boolean {
  // The sweep deletes matches: reject anything that is not a plain leaf.
  if (!name || name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  if (
    /^subagent-[A-Za-z0-9_-]{1,128}-bg-\d{1,10}\.(task|result)\.json(\..*)?$/.test(name)
  ) return true;
  if (
    /^subagent-[A-Za-z0-9_-]{1,128}-bg-\d{1,10}\.(approval-[A-Za-z0-9_-]{1,64}\.json|inbox\.json)(\..*)?$/.test(name)
  ) return true;
  if (/^ack-sub-[A-Za-z0-9_-]{1,64}-bg-\d{1,10}-appr-[A-Za-z0-9_-]{1,64}\.json(\..*)?$/.test(name)) return true;
  const stream = name.startsWith(".") ? name.slice(1) : name;
  if (stream.startsWith("cursor-")) {
    return SUBAGENT_STREAM_RE.test(stream.slice("cursor-".length).replace(/\.json$/, ""));
  }
  if (stream.startsWith("quarantine-")) return SUBAGENT_STREAM_RE.test(stream.slice("quarantine-".length));
  const dot = stream.indexOf(".jsonl");
  if (dot > 0) {
    const id = stream.slice(0, dot);
    const rest = stream.slice(dot);
    if (!SUBAGENT_STREAM_RE.test(id)) return false;
    return rest === ".jsonl" || rest.startsWith(".jsonl.");
  }
  return false;
}

export {
  SUBAGENT_APPROVAL_POLL_MS,
  SUBAGENT_APPROVAL_TIMEOUT_MS,
  appendSubagentInboxMessage,
  clearSubagentApprovalFiles,
  parseSubagentApprovalName,
  readSubagentApprovalRequest,
  readSubagentInbox,
  subagentApprovalRequestName,
  subagentApprovalTimeoutMs,
  subagentInboxFileName,
  writeSubagentAckFile,
  writeSubagentApprovalRequest,
} from "./subagents/approval.ts";
export type {
  SubagentApprovalKind,
  SubagentApprovalRequest,
  SubagentInboxMessage,
} from "./subagents/approval.ts";
export {
  isApprovalAnswer,
  isLiveSubagentRun,
  resolveSubagentPermissionMode,
} from "./subagents/permission.ts";
