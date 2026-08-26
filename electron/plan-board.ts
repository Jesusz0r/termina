/**
 * Plan Board: what a task is, how it progresses, and which tasks Dispatch
 * may send to workers.
 *
 * The bridge only logs assistant text. This module is the only place that
 * decides whether that text is a plan and how Dispatch claims rows.
 */
import { isAbsolute, relative } from "node:path";
import { HAS_UNCHECKED_PLAN_TASK, PLAN_TASK_MARKER } from "../shared/plan-task.js";
import type { PlanTask } from "../shared/types.js";

export { HAS_UNCHECKED_PLAN_TASK, PLAN_TASK_MARKER };

const UNCHECKED_PLAN_LINE = new RegExp("^" + PLAN_TASK_MARKER + String.raw`\s*(.+)$`);
const MAX_PLAN_TASKS = 20;
const MAX_PATHS_PER_TASK = 5;

export const MAX_DISPATCH_WORKERS = 3;

export type CanonicalizePath = (absPath: string) => string;

export function parsePlanTasks(text: string, cwd: string | null, canonicalize: CanonicalizePath): PlanTask[] {
  const tasks: PlanTask[] = [];
  for (const raw of text.split("\n")) {
    const body = uncheckedPlanTaskBody(raw);
    if (!body) continue;
    tasks.push({ text: body, paths: planTaskPaths(body, cwd, canonicalize), state: "pending" });
    if (tasks.length >= MAX_PLAN_TASKS) break;
  }
  return tasks;
}

export function markPlanProgress(plan: PlanTask[], relPath: string): boolean {
  if (plan.length === 0 || !relPath) return false;
  let changed = false;
  for (const task of plan) {
    if (task.state === "done") continue;
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

export function finalizePlanTasks(
  plan: PlanTask[],
  touched: ReadonlySet<string>,
  outcomes: ReadonlyMap<string, "ok" | "error">,
): void {
  for (const task of plan) {
    if (taskIsComplete(task.paths, touched, outcomes)) task.state = "done";
  }
}

export function findTaskByText(plan: PlanTask[], taskText: string): PlanTask | undefined {
  return plan.find((t) => t.text === taskText);
}

export function reattachDispatchAssignments(
  plan: PlanTask[],
  assignments: Iterable<{ workerId: string; taskText: string }>,
): void {
  for (const entry of assignments) {
    const task = findTaskByText(plan, entry.taskText);
    if (!task) continue;
    task.workerId = entry.workerId;
    task.claimed = [...task.paths];
    if (task.state === "pending") task.state = "active";
  }
}

export function pickDispatchTasks(opts: {
  plan: PlanTask[];
  remainingSlots: number;
  inFlightPathKeys: ReadonlySet<string>;
  pathKey: (relPath: string) => string;
  taskText?: string;
}): { tasks: PlanTask[]; error?: string } {
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
    "You are one of several Pi workers on the same project. Do not edit files claimed by a sibling.",
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

function pickNamedDispatchTask(
  plan: PlanTask[],
  taskText: string,
  used: Set<string>,
  pathKey: (relPath: string) => string,
): { tasks: PlanTask[]; error?: string } {
  const task = findTaskByText(plan, taskText);
  if (!task) return { tasks: [], error: "that task is not on the plan board" };
  if (dispatchUnavailable(task)) return { tasks: [], error: "that task is already dispatched" };
  if (pathKeysOf(task, pathKey).some((k) => used.has(k))) {
    return { tasks: [], error: "that task overlaps a running dispatch" };
  }
  return { tasks: [task] };
}

function pickScopedDispatchTasks(
  plan: PlanTask[],
  remainingSlots: number,
  used: Set<string>,
  pathKey: (relPath: string) => string,
): { tasks: PlanTask[]; error?: string } {
  const chosen: PlanTask[] = [];
  for (const task of plan) {
    if (chosen.length >= remainingSlots) break;
    if (dispatchUnavailable(task) || task.paths.length === 0) continue;
    const keys = pathKeysOf(task, pathKey);
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

function pathKeysOf(task: PlanTask, pathKey: (relPath: string) => string): string[] {
  return task.paths.map(pathKey);
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

function uncheckedPlanTaskBody(line: string): string | null {
  const match = line.trim().match(UNCHECKED_PLAN_LINE);
  const body = match?.[1]?.trim();
  return body || null;
}

function planTaskPaths(body: string, cwd: string | null, canonicalize: CanonicalizePath): string[] {
  const paths: string[] = [];
  for (const token of body.split(/\s+/)) {
    const clean = cleanPlanPathToken(token, cwd, canonicalize);
    if (looksLikePath(clean)) paths.push(clean);
  }
  return [...new Set(paths)].slice(0, MAX_PATHS_PER_TASK);
}

export function cleanPlanPathToken(token: string, cwd: string | null, canonicalize: CanonicalizePath): string {
  const isItalicPair = /_$/.test(token);
  // Strip punctuation and markdown emphasis. A leading underscore is a
  // filename (_test.py) unless the token also ends with one (_italic_).
  let clean = token.replace(/[`.,;:!?)"'*_]+$/g, "").replace(/^[`("'*]+/g, "");
  if (isItalicPair) clean = clean.replace(/^_+/, "");
  clean = clean.replace(/\/+$/, "");
  if (isAbsolute(clean) && cwd) {
    const rel = relative(canonicalize(cwd), canonicalize(clean));
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
