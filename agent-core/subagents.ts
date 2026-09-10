/**
 * Background subagents registry (SUBAGENTS-PLAN.md Phase 1).
 *
 * Single owner for subagent run records: ids, state, path claims, caps,
 * spawn/message validation, and child-output scanning. Headless execution
 * (spawning, sidecar tailing, settle/kill/retry) lands in Phase 2 and lives
 * in `electron/subagents.ts`; this module never spawns a process.
 *
 * Runs start `active` and resolve exactly once via `settleRun`. Phase 1 has
 * no executor, so runs stay active until Phase 2 settles them; the
 * exactly-once invariant is already enforced here and covered by tests.
 */

import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
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

/** Anthropic rule adopted by the plan: at most 4 parallel runs. */
export const MAX_SUBAGENT_RUNS = 4;
/** Children never receive the spawn tool: max spawn depth 1. */
export const MAX_SUBAGENT_DEPTH = 1;
/** Bound the parent-written subtask brief kept on the run record. */
export const MAX_SUBAGENT_TASK_CHARS = 8_000;
/** Bound the child-facing brief (task plus sibling-claim section). */
export const MAX_SUBAGENT_BRIEF_CHARS = 12_000;
/** Bound touched paths carried per run (merge detection, not a full manifest). */
export const MAX_SUBAGENT_TOUCHED = 200;
/** Bound one parent-to-child message. */
export const MAX_SUBAGENT_MESSAGE_CHARS = 8_000;
/** Bound one child result held for parent fan-in. */
export const MAX_SUBAGENT_RESULT_CHARS = 32_000;
/** Per-run turn budget must fit in 1..MAX_SUBAGENT_TURNS. */
export const MAX_SUBAGENT_TURNS = 200;
/** Cap claimed paths per spawn so one run cannot reserve the tree. */
export const MAX_SUBAGENT_CLAIM_PATHS = 20;
/** Bound queued parent-to-child messages per run (bounded memory; Phase 2 drains). */
export const MAX_SUBAGENT_INBOX_MSGS = 50;

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
  /** Raw provider JSON: validated here so malformed input fails closed instead of silently defaulting. */
  budget?: unknown;
  /** Raw provider JSON: validated here so a malformed claim errors instead of silently dropping lease protection. */
  paths?: unknown;
  /**
   * Raw run id (bg-N) of a settled sibling run to continue. The child replays
   * that run's session and treats this task as a follow-up. Must name a
   * non-active run; anything else fails closed.
   */
  resume?: unknown;
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
  maxTurns: number;
  /** Settled sibling run this run continues, if any. */
  resumeRunId: string | null;
  state: SubagentRunState;
  /** Parent-to-child texts in arrival order (answers, redirects). */
  inbox: string[];
  /** Scanned final result once settled; never intermediate tool streams. */
  result: string | null;
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
      "Spawn one background subagent for an independent subtask of the current task. The brief must be complete (goal, file paths, decisions, done-criteria): children start context-fresh. Returns a run id immediately; the final result arrives as a tool result when the run settles. Siblings never share a subtask; pass paths to reserve them. Pass resume with a settled sibling run id to continue it: the child replays that run's session and treats the brief as a follow-up.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        task: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        resume: { type: "string" },
        budget: {
          type: "object",
          additionalProperties: false,
          properties: { maxTurns: { type: "number" } },
        },
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

/** Children never receive `spawn_subagent` (max depth 1); main.ts spreads this into TOOLS. */
export function visibleSubagentTools(depth: number): Array<Record<string, unknown>> {
  if (depth >= MAX_SUBAGENT_DEPTH) return SUBAGENT_TOOL_DEFS.filter((d) => d.name !== "spawn_subagent");
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
const MAX_SUBAGENT_FILE_BYTES = 64 * 1024;

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
  maxTurns: number;
  paths: string[];
  permissionMode: SubagentPermissionMode;
  parentTerminalId: string;
  cwd: string;
  depth: number;
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
  if (!Number.isInteger(v.maxTurns) || (v.maxTurns as number) < 1 || (v.maxTurns as number) > MAX_SUBAGENT_TURNS) {
    return { ok: false, error: "subagent task file has a bad turn budget" };
  }
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
      maxTurns: v.maxTurns as number,
      paths,
      permissionMode: v.permissionMode,
      parentTerminalId: v.parentTerminalId,
      cwd: v.cwd,
      depth: v.depth as number,
      createdAt: typeof v.createdAt === "number" ? v.createdAt : Date.now(),
    },
  };
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
    maxTurns: run.maxTurns,
    paths: run.paths,
    permissionMode: run.permissionMode,
    parentTerminalId: opts.parentTerminalId,
    cwd: opts.cwd,
    depth: run.depth,
    createdAt: run.createdAt,
  });
  try {
    writeFileSync(join(eventsDir, name), body, { mode: 0o600 });
  } catch (err) {
    return { ok: false, error: `subagent task file write failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, file: name };
}

export type SubagentOutcome = Extract<SubagentRunState, "settled" | "failed" | "killed">;

export interface SubagentResultFile {
  version: typeof SUBAGENT_RESULT_VERSION;
  runId: string;
  outcome: SubagentOutcome;
  result: string;
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
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { status: "invalid", error: "subagent result is unreadable" };
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_SUBAGENT_FILE_BYTES) {
    return { status: "invalid", error: "subagent result exceeds its file budget" };
  }
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
 * Settle locally active runs whose host result files landed. Runs once per
 * parent turn next to the mailbox read; frees slots and claim holds. The
 * human-readable result arrives via the host mailbox note; this only
 * reconciles registry truth. Consumed result files are deleted best-effort:
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
    const done = registry.settleRun(run.id, read.file.result, read.file.outcome);
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

/** Sidecar body announcing a validated spawn; the host launches from the task file. */
export function subagentSpawnSidecarRecord(runId: string, taskFile: string): Record<string, unknown> {
  return { t: SUBAGENT_SPAWN_RECORD, runId, taskFile };
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

/** Cut text at a UTF-8 boundary so byte caps never split a character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // Back over continuation bytes to the lead byte of the cut character.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  if (end > 0 && (buf[end]! & 0x80) !== 0) {
    // Drop the cut character unless its full encoding fits the budget.
    const lead = buf[end]!;
    const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
    if (end + width > maxBytes) {
      // end already excludes it: [0, end) holds only complete characters.
    } else {
      end += width;
    }
  }
  return buf.toString("utf8", 0, end);
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
    return { ok: true, run };
  }

  async spawn(req: SubagentSpawnRequest): Promise<{ ok: true; run: SubagentRun } | { ok: false; error: string }> {
    const { parent } = req;
    if (parent.depth >= MAX_SUBAGENT_DEPTH) {
      return { ok: false, error: "subagents cannot spawn subagents (max depth 1)" };
    }
    const task = req.task?.trim() ?? "";
    if (!task) return { ok: false, error: "spawn_subagent task must not be empty" };
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
    let maxTurns = 50;
    if (req.budget !== undefined) {
      if (typeof req.budget !== "object" || req.budget === null || Array.isArray(req.budget)) {
        return { ok: false, error: "spawn_subagent budget must be an object" };
      }
      const n = (req.budget as { maxTurns?: unknown }).maxTurns;
      if (n !== undefined) {
        if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > MAX_SUBAGENT_TURNS) {
          return { ok: false, error: `spawn_subagent budget.maxTurns must be an integer in 1..${MAX_SUBAGENT_TURNS}` };
        }
        maxTurns = n as number;
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
    // the parent provider. An unknown provider prefix fails closed here so
    // parseModelRef's anthropic fallback can never silently reroute a child.
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
    if (active.length >= MAX_SUBAGENT_RUNS) {
      return { ok: false, error: `at most ${MAX_SUBAGENT_RUNS} subagent runs at once` };
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
      provider,
      model,
      protocol,
      effort,
      permissionMode: parent.permissionMode,
      depth: parent.depth + 1,
      paths,
      maxTurns,
      state: "active",
      inbox: [],
      result: null,
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
      return { ok: false, error: excerpt ? `${outcome} with result: ${excerpt}` : `${outcome} with an empty result` };
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

// ---- Phase 3: approvals + messaging transport ----
//
// The headless child cannot show a picker, so bash approvals round-trip
// through files: the child writes an approval request and waits on the ack
// channel (waitForAck); the parent surfaces pending requests in its own
// choice picker (Deny / Approve once — never Always) and writes the ack.
// No ack, a stale request, or no parent surface all mean deny.
// Parent-to-child messages ride a per-run inbox file the child drains on
// every model turn.

/** How long a child waits for a parent approval before denying. */
export const SUBAGENT_APPROVAL_TIMEOUT_MS = 120_000;

/** Operator/test override; clamps to 1s..1h, else the default. */
export function subagentApprovalTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.TERMINA_SUBAGENT_APPROVAL_TIMEOUT_MS ?? "");
  if (Number.isFinite(raw) && raw >= 1000 && raw <= 3600_000) return raw;
  return SUBAGENT_APPROVAL_TIMEOUT_MS;
}

const TERMINAL_RE = /^[A-Za-z0-9_-]{1,128}$/;
const RUN_RE = /^bg-\d{1,10}$/;
const REQ_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Child sidecar id: `sub-<parent>-<bgN>`. Single owner (host adopts it). */
export function subagentChildTid(parentTerminalId: string, runId: string): string | null {
  if (!TERMINAL_RE.test(parentTerminalId) || !RUN_RE.test(runId)) return null;
  const tid = `sub-${parentTerminalId.slice(0, 64)}-${runId}`;
  return tid.length <= 128 ? tid : null;
}

/** Atomic JSON write (tmp + rename) so waiters see complete files or none. */
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

export type SubagentApprovalKind = "bash" | "protected";

export interface SubagentApprovalRequest {
  version: 1;
  runId: string;
  kind: SubagentApprovalKind;
  /** Command for bash, project-relative path for protected. */
  text: string;
  createdAt: number;
}

export function subagentApprovalRequestName(parentTerminalId: string, runId: string, reqId: string): string | null {
  if (!TERMINAL_RE.test(parentTerminalId) || !RUN_RE.test(runId) || !REQ_RE.test(reqId)) return null;
  return `subagent-${parentTerminalId}-${runId}.approval-${reqId}.json`;
}

/**
 * Delete one terminal's approval request files (called on `/clear` so a new
 * session never re-offers approvals for killed children). Returns the count
 * removed. Runs themselves stay for reconcile to settle via killed results.
 */
export function clearSubagentApprovalFiles(dir: string, terminalId: string): number {
  if (!dir || !TERMINAL_RE.test(terminalId)) return 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  const prefix = `subagent-${terminalId}-`;
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.includes(".approval-")) continue;
    if (!parseSubagentApprovalName(terminalId, name)) continue;
    try {
      rmSync(join(dir, name));
      removed += 1;
    } catch {
      /* Dead letter stays for the startup sweep. */
    }
  }
  return removed;
}

/** Parse one approval request filename. Pure and unit-tested. */
export function parseSubagentApprovalName(
  terminalId: string,
  name: string,
): { runId: string; reqId: string } | null {
  const prefix = `subagent-${terminalId}-`;
  if (!name.startsWith(prefix)) return null;
  const match = /^(bg-\d{1,10})\.approval-([A-Za-z0-9_-]{1,64})\.json$/.exec(name.slice(prefix.length));
  if (!match) return null;
  return { runId: match[1]!, reqId: match[2]! };
}

export function writeSubagentApprovalRequest(
  eventsDir: string,
  parentTerminalId: string,
  runId: string,
  req: { reqId: string; kind: SubagentApprovalKind; text: string },
): { ok: true; file: string } | { ok: false; error: string } {
  const name = subagentApprovalRequestName(parentTerminalId, runId, req.reqId);
  if (!name || !eventsDir) return { ok: false, error: "bad subagent approval identity" };
  if (!req.text.trim()) return { ok: false, error: "empty approval text" };
  const ok = atomicWriteJsonSync(
    eventsDir,
    name,
    JSON.stringify({ version: 1, runId, kind: req.kind, text: req.text.slice(0, 1000), createdAt: Date.now() }),
  );
  return ok ? { ok: true, file: name } : { ok: false, error: "approval request write failed" };
}

export function readSubagentApprovalRequest(
  path: string,
): { ok: true; file: SubagentApprovalRequest } | { ok: false; error: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: false, error: "unreadable" };
  }
  if (Buffer.byteLength(raw, "utf8") > 8192) return { ok: false, error: "oversize" };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { ok: false, error: "not JSON" };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "not an object" };
  const r = v as Record<string, unknown>;
  if (r.version !== 1 || typeof r.runId !== "string" || !RUN_RE.test(r.runId)) return { ok: false, error: "bad run" };
  if ((r.kind !== "bash" && r.kind !== "protected") || typeof r.text !== "string" || !r.text.trim()) {
    return { ok: false, error: "bad kind" };
  }
  if (typeof r.createdAt !== "number" || !Number.isFinite(r.createdAt)) return { ok: false, error: "bad time" };
  return { ok: true, file: { version: 1, runId: r.runId, kind: r.kind, text: r.text, createdAt: r.createdAt } };
}

/** Parent answer to a child approval wait. Atomic: the waiter claims complete files or nothing. */
export function writeSubagentAckFile(
  eventsDir: string,
  waiterTid: string,
  reqId: string,
  payload: { ok: boolean },
): boolean {
  if (!eventsDir || !TERMINAL_RE.test(waiterTid) || !REQ_RE.test(reqId)) return false;
  return atomicWriteJsonSync(eventsDir, `ack-${waiterTid}-${reqId}.json`, JSON.stringify(payload));
}

export interface SubagentInboxMessage {
  seq: number;
  text: string;
  at: number;
}

export function subagentInboxFileName(parentTerminalId: string, runId: string): string | null {
  if (!TERMINAL_RE.test(parentTerminalId) || !RUN_RE.test(runId)) return null;
  return `subagent-${parentTerminalId}-${runId}.inbox.json`;
}

/** Append a parent message to the run inbox file (transport the child drains). */
export function appendSubagentInboxMessage(
  eventsDir: string,
  parentTerminalId: string,
  runId: string,
  text: string,
): { ok: true; seq: number } | { ok: false; error: string } {
  const name = subagentInboxFileName(parentTerminalId, runId);
  if (!name || !eventsDir) return { ok: false, error: "bad subagent inbox identity" };
  const clean = text.trim();
  if (!clean) return { ok: false, error: "empty message" };
  if (clean.length > MAX_SUBAGENT_MESSAGE_CHARS) {
    return { ok: false, error: `message exceeds ${MAX_SUBAGENT_MESSAGE_CHARS} chars` };
  }
  let messages: SubagentInboxMessage[] = [];
  try {
    const existing = readSubagentInbox(eventsDir, parentTerminalId, runId);
    if (existing) messages = existing.messages;
  } catch {
    messages = [];
  }
  const seq = (messages.at(-1)?.seq ?? 0) + 1;
  messages.push({ seq, text: clean, at: Date.now() });
  while (messages.length > MAX_SUBAGENT_INBOX_MSGS) messages.shift();
  const ok = atomicWriteJsonSync(eventsDir, name, JSON.stringify({ version: 1, runId, messages }));
  return ok ? { ok: true, seq } : { ok: false, error: "inbox write failed" };
}

export function readSubagentInbox(
  eventsDir: string,
  parentTerminalId: string,
  runId: string,
): { version: 1; runId: string; messages: SubagentInboxMessage[] } | null {
  const name = subagentInboxFileName(parentTerminalId, runId);
  if (!name || !eventsDir) return null;
  let raw: string;
  try {
    raw = readFileSync(join(eventsDir, name), "utf8");
  } catch {
    return null;
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_SUBAGENT_FILE_BYTES) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (r.version !== 1 || r.runId !== runId || !Array.isArray(r.messages)) return null;
  const messages: SubagentInboxMessage[] = [];
  for (const m of r.messages) {
    if (!m || typeof m !== "object" || Array.isArray(m)) return null;
    const e = m as Record<string, unknown>;
    if (typeof e.seq !== "number" || !Number.isInteger(e.seq) || typeof e.text !== "string") return null;
    messages.push({ seq: e.seq, text: e.text, at: typeof e.at === "number" ? e.at : 0 });
  }
  return { version: 1, runId, messages };
}
