/**
 * Plan Board: what a task is, how it progresses, and which tasks Dispatch
 * may send to workers.
 *
 * A `/plan` turn logs assistant text on the sidecar. Heading and task-line
 * scan lives in `shared/plan-task.ts`. This module turns those lines into
 * task objects and decides how Dispatch claims rows.
 */
import { isAbsolute, relative } from "node:path";
import { planListEntries } from "../shared/plan-task.ts";
import { isRecord } from "../shared/guards.ts";
import type { CanonicalizePath, DispatchOutcome, PlanTask } from "../shared/types.ts";

export function parsePlanTaskCandidate(value: unknown): PlanTask["candidate"] | undefined {
  if (!isRecord(value) || typeof value.comparisonId !== "string" || value.comparisonId.length > 64
    || !/^cmp-[1-9][0-9]*$/.test(value.comparisonId) || (value.label !== "A" && value.label !== "B")) return undefined;
  return { comparisonId: value.comparisonId, label: value.label };
}

const MAX_PLAN_TASKS = 20;
const MAX_PATHS_PER_TASK = 5;

export const MAX_DISPATCH_WORKERS = 3;

/** Minimum schedule interval: background ticks must not hot-loop workers. */
export const MIN_SCHEDULE_INTERVAL_MS = 5 * 60_000;
/** Scheduler tick: due schedules are checked this often. */
export const SCHEDULE_TICK_MS = 60_000;

const SCHEDULE_EVERY = /@every\s+(\d+)\s*([smhd])\b/i;
const SCHEDULE_AT = /@at\s+(\d{1,2}):(\d{2})\b/;
const PLAN_MODEL_MARKER = /@model\s+(\S+)/i;

export type ScheduleSpec = { kind: "every"; intervalMs: number } | { kind: "at"; hour: number; minute: number };

/**
 * A trailing `@every 30m` / `@at 09:30` marker makes a plan task recurring.
 * First marker wins. Intervals below the minimum are rejected.
 */
export function parseScheduleMarker(text: string): ScheduleSpec | null {
  const every = SCHEDULE_EVERY.exec(text);
  if (every) {
    const amount = Number(every[1]);
    const unit = (every[2] ?? "m").toLowerCase();
    const factor = unit === "s" ? 1000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 60_000;
    const intervalMs = amount * factor;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_SCHEDULE_INTERVAL_MS) return null;
    return { kind: "every", intervalMs };
  }
  const at = SCHEDULE_AT.exec(text);
  if (at) {
    const hour = Number(at[1]);
    const minute = Number(at[2]);
    if (hour > 23 || minute > 59) return null;
    return { kind: "at", hour, minute };
  }
  return null;
}

/**
 * A trailing `@model provider/id` marker pins that task's dispatch worker.
 * First marker wins. Malformed refs are ignored (inherit the owner tab).
 */
export function parsePlanModelMarker(text: string): string | null {
  const match = PLAN_MODEL_MARKER.exec(text);
  if (!match) return null;
  const raw = match[1]!.trim();
  if (raw.length < 3 || raw.length > 256) return null;
  if (raw.startsWith("/") || raw.endsWith("/")) return null;
  const cut = raw.indexOf("/");
  if (cut < 1) return null;
  if (/[\x00-\x1f]/.test(raw)) return null;
  return raw;
}

/** Model pin for a dispatch worker. `inherit` copies the owner tab. */
export function dispatchWorkerModel(task: PlanTask, ipcModel?: string): string | undefined {
  const raw = ipcModel?.trim() ?? "";
  if (raw === "inherit") return undefined;
  if (raw) return raw;
  return task.model;
}

/** Next run after `fromMs` for a schedule (first `@every` fires immediately). */
export function nextScheduleRun(spec: ScheduleSpec, fromMs: number, first: boolean): number {
  if (spec.kind === "every") return first ? fromMs : fromMs + spec.intervalMs;
  const date = new Date(fromMs);
  const next = new Date(date);
  next.setHours(spec.hour, spec.minute, 0, 0);
  if (next.getTime() <= fromMs) next.setDate(next.getDate() + 1);
  return next.getTime();
}

export async function parsePlanTasks(text: string, cwd: string | null, canonicalize: CanonicalizePath): Promise<PlanTask[]> {
  const tasks: PlanTask[] = [];
  for (const line of planListEntries(text, MAX_PLAN_TASKS)) {
    const model = parsePlanModelMarker(line.body);
    tasks.push({
      text: line.body,
      paths: await planTaskPaths(line.body, cwd, canonicalize),
      state: line.checked ? "done" : "pending",
      ...(model ? { model } : {}),
    });
  }
  return tasks;
}

export interface PlanOwnerFacts {
  available: boolean; primary: boolean; persistent: boolean; agent: boolean;
  dispatchWorker: boolean; busy: boolean;
}

/** Shared owner admission, independent of creation capacity. */
export function planOwnerError(facts: PlanOwnerFacts): string | null {
  if (!facts.available) return "The Plan Board owner is unavailable.";
  if (!facts.agent || !facts.persistent || !facts.primary || facts.dispatchWorker) {
    return "Choose a persistent primary agent Plan Board.";
  }
  if (facts.busy) return "The Plan Board owner is busy.";
  return null;
}

/** Admission is shared by the authoritative overview and the create handler. */
export function planCreationError(facts: PlanOwnerFacts & { taskCount: number }): string | null {
  return planOwnerError(facts) ?? planCapacityError(facts.taskCount);
}

/** Initial Start only: historical attempts must use the Plan Board's Retry. */
export function planStartError(ownerError: string | null, plan: readonly PlanTask[], task: PlanTask): string | null {
  if (ownerError) return ownerError;
  const matches = plan.filter((entry) => entry.text === task.text);
  if (matches.length !== 1 || matches[0] !== task) return "The task is not uniquely on the Plan Board.";
  if (task.state !== "pending" || task.workerId !== undefined || task.dispatchResult !== undefined || task.candidate !== undefined) {
    return "Only an initial pending task can be started here. Use the Plan Board for retries.";
  }
  return null;
}

/** Compare all execution-relevant fields, not merely the named row. */
export function samePlanTaskSnapshot(task: PlanTask, snapshot: PlanTask): boolean {
  return task.text === snapshot.text && task.state === snapshot.state && task.model === snapshot.model
    && JSON.stringify(task.candidate) === JSON.stringify(snapshot.candidate)
    && task.workerId === snapshot.workerId
    && JSON.stringify(task.paths) === JSON.stringify(snapshot.paths)
    && JSON.stringify(task.claimed) === JSON.stringify(snapshot.claimed)
    && task.dispatchResult?.workerId === snapshot.dispatchResult?.workerId
    && task.dispatchResult?.outcome === snapshot.dispatchResult?.outcome;
}

function planCapacityError(taskCount: number): string | null {
  return taskCount >= MAX_PLAN_TASKS ? `The Plan Board is full (${MAX_PLAN_TASKS} tasks).` : null;
}

export function planTaskTextError(text: string, plan: readonly PlanTask[]): string | null {
  if (!text.trim()) return "Enter a task.";
  if (text.length > 500) return "Task text must be at most 500 characters.";
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(text)) return "Task text must be one line without control characters.";
  if (/@(every|at)\b/i.test(text)) return "New tasks cannot include automatic schedule markers.";
  if (plan.some((task) => task.text === text)) return "That task is already on the Plan Board.";
  return planCapacityError(plan.length);
}

/** Derive paths/model with the same parser as agent-authored plans; never dispatch. */
export async function createPendingPlanTask(text: string, cwd: string, canonicalize: CanonicalizePath): Promise<PlanTask> {
  const model = parsePlanModelMarker(text);
  return { text, paths: await planTaskPaths(text, cwd, canonicalize), state: "pending", ...(model ? { model } : {}) };
}

export function markPlanProgress(plan: PlanTask[], relPath: string): boolean {
  if (plan.length === 0 || !relPath) return false;
  let changed = false;
  for (const task of plan) {
    if (task.state === "done" || task.candidate) continue;
    if (!taskMentionsPath(task, relPath)) continue;
    if (task.state === "active") continue;
    task.state = "active";
    changed = true;
  }
  return changed;
}

export function taskIsComplete(
  paths: string[],
  touched: ReadonlySet<string>,
  outcomes: ReadonlyMap<string, "ok" | "error">,
): boolean {
  if (paths.length === 0) return false;
  return paths.every((p) => touched.has(p) && outcomes.get(p) === "ok");
}

/** Finish one attempt without discarding its edits, provenance, or retryability. */
export function settleDispatchTask(
  task: PlanTask,
  worker: { id: string; touched: ReadonlySet<string>; toolOutcomes: ReadonlyMap<string, "ok" | "error"> },
  end: "settled" | "failed" | "interrupted",
): DispatchOutcome {
  const outcome: DispatchOutcome = end !== "settled" ? end
    : taskIsComplete(task.paths, worker.touched, worker.toolOutcomes) ? "completed"
    : task.paths.some((path) => worker.toolOutcomes.get(path) === "error") ? "failed" : "incomplete";
  task.state = outcome === "completed" ? "done" : "pending";
  task.dispatchResult = { workerId: worker.id, outcome };
  delete task.workerId;
  delete task.claimed;
  return outcome;
}

export function finalizePlanTasks(
  plan: PlanTask[],
  touched: ReadonlySet<string>,
  outcomes: ReadonlyMap<string, "ok" | "error">,
): void {
  for (const task of plan) {
    if (!task.candidate && taskIsComplete(task.paths, touched, outcomes)) task.state = "done";
  }
}

export function findTaskByText(plan: PlanTask[], taskText: string): PlanTask | undefined {
  return plan.find((t) => t.text === taskText);
}

export function reattachDispatchAssignments(
  plan: PlanTask[],
  assignments: Iterable<{ workerId: string; taskText: string }>,
  previousPlan: PlanTask[],
): void {
  for (const task of plan) {
    const previous = findTaskByText(previousPlan, task.text);
    if (previous?.dispatchResult) task.dispatchResult = previous.dispatchResult;
    if (previous?.candidate) task.candidate = { ...previous.candidate };
  }
  for (const entry of assignments) {
    const task = findTaskByText(plan, entry.taskText);
    if (!task) continue;
    task.workerId = entry.workerId;
    task.claimed = task.candidate ? [] : [...task.paths];
    if (task.state === "pending") task.state = "active";
  }
}

export async function pickDispatchTasks(opts: {
  plan: PlanTask[];
  remainingSlots: number;
  inFlightPathKeys: ReadonlySet<string>;
  pathKey: (relPath: string) => string | Promise<string>;
  taskText?: string;
}): Promise<{ tasks: PlanTask[]; error?: string }> {
  const { plan, remainingSlots, inFlightPathKeys, pathKey, taskText } = opts;
  if (remainingSlots <= 0) {
    return { tasks: [], error: `at most ${MAX_DISPATCH_WORKERS} dispatch workers run at once` };
  }
  const used = new Set(inFlightPathKeys);
  if (taskText !== undefined) return pickNamedDispatchTask(plan, taskText, used, pathKey);
  return pickScopedDispatchTasks(plan, remainingSlots, used, pathKey);
}

export function formatDispatchBriefing(
  workerId: string,
  assigned: PlanTask,
  jobs: Array<{ task: PlanTask; id: string }>,
): string {
  const lines: string[] = [
    "## Dispatch briefing",
    "",
    "You are one of several agent workers on the same project. Do not edit files claimed by a sibling.",
    "",
    "### Your assignment",
    assigned.text,
  ];
  if (assigned.paths.length > 0) lines.push(`Paths: ${assigned.paths.map((p) => `\`${p}\``).join(", ")}`);
  lines.push("", "### Plan");
  for (const job of jobs) lines.push(`- ${job.task.text}`);
  const siblingClaims = siblingClaimPaths(workerId, jobs);
  if (siblingClaims.length > 0) {
    lines.push("", "### Sibling path claims");
    for (const path of siblingClaims) lines.push(`- \`${path}\``);
  }
  return lines.join("\n");
}

async function pickNamedDispatchTask(
  plan: PlanTask[],
  taskText: string,
  used: Set<string>,
  pathKey: (relPath: string) => string | Promise<string>,
): Promise<{ tasks: PlanTask[]; error?: string }> {
  const task = findTaskByText(plan, taskText);
  if (!task) return { tasks: [], error: "that task is not on the plan board" };
  if (dispatchUnavailable(task)) return { tasks: [], error: "that task is already dispatched" };
  if ((await pathKeysOf(task, pathKey)).some((k) => used.has(k))) {
    return { tasks: [], error: "that task overlaps a running dispatch" };
  }
  return { tasks: [task] };
}

async function pickScopedDispatchTasks(
  plan: PlanTask[],
  remainingSlots: number,
  used: Set<string>,
  pathKey: (relPath: string) => string | Promise<string>,
): Promise<{ tasks: PlanTask[]; error?: string }> {
  const chosen: PlanTask[] = [];
  for (const task of plan) {
    if (chosen.length >= remainingSlots) break;
    if (dispatchUnavailable(task) || task.paths.length === 0) continue;
    const keys = await pathKeysOf(task, pathKey);
    if (keys.some((k) => used.has(k))) continue;
    for (const k of keys) used.add(k);
    chosen.push(task);
  }
  if (chosen.length === 0) return { tasks: [], error: "no task mentions a file to scope it" };
  return { tasks: chosen };
}

function dispatchUnavailable(task: PlanTask): boolean {
  return Boolean(task.workerId) || task.state === "active" || task.state === "done";
}

async function pathKeysOf(task: PlanTask, pathKey: (relPath: string) => string | Promise<string>): Promise<string[]> {
  return Promise.all(task.paths.map(pathKey));
}

function siblingClaimPaths(workerId: string, jobs: Array<{ task: PlanTask; id: string }>): string[] {
  const claims: string[] = [];
  const seen = new Set<string>();
  for (const job of jobs) {
    if (job.id === workerId) continue;
    for (const path of job.task.paths) {
      if (seen.has(path)) continue;
      seen.add(path);
      claims.push(path);
    }
  }
  return claims;
}

function taskMentionsPath(task: PlanTask, relPath: string): boolean {
  return task.paths.some((p) => relPath === p || relPath.endsWith("/" + p));
}

async function planTaskPaths(body: string, cwd: string | null, canonicalize: CanonicalizePath): Promise<string[]> {
  const paths: string[] = [];
  const stripped = body.replace(PLAN_MODEL_MARKER, " ");
  for (const token of stripped.split(/\s+/)) {
    if (!token || token.startsWith("@model")) continue;
    const clean = await cleanPlanPathToken(token, cwd, canonicalize);
    if (looksLikePath(clean)) paths.push(clean);
  }
  return [...new Set(paths)].slice(0, MAX_PATHS_PER_TASK);
}

export async function cleanPlanPathToken(token: string, cwd: string | null, canonicalize: CanonicalizePath): Promise<string> {
  const isItalicPair = /_$/.test(token);
  // Strip punctuation and markdown emphasis. A leading underscore is a
  // filename (_test.py) unless the token also ends with one (_italic_).
  let clean = token.replace(/[`.,;:!?)"'*_]+$/g, "").replace(/^[`("'*]+/g, "");
  if (isItalicPair) clean = clean.replace(/^_+/, "");
  clean = clean.replace(/\/+$/, "");
  if (isAbsolute(clean) && cwd) {
    const rel = relative(await canonicalize(cwd), await canonicalize(clean));
    if (rel && !rel.startsWith("..")) return rel;
  }
  return clean;
}

/** A token is a file path when it has a slash or a code extension.
 *  Version numbers (0.1.5) and latin abbreviations (e.g.) are not paths. */
export function looksLikePath(token: string): boolean {
  if (!token || token.length > 200) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return false;
  if (/^v?\d+(?:\.\d+)+$/.test(token)) return false;
  if (/^(?:e\.g|i\.e|vs|etc)\.?$/i.test(token)) return false;
  if (token.includes("/")) return !token.endsWith(":");
  return /\.[a-zA-Z][a-zA-Z0-9]{0,4}$/.test(token);
}
