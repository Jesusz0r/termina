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
      "Spawn one background subagent for an independent subtask of the current task. The brief must be complete (goal, file paths, decisions, done-criteria): children start context-fresh. Returns a run id immediately; the final result arrives as a tool result when the run settles. Siblings never share a subtask; pass paths to reserve them.",
    input_schema: {
      type: "object",
      properties: {
        task: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        budget: {
          type: "object",
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

function normalizeClaimPath(raw: unknown): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "spawn_subagent paths must be strings" };
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
    if (run.state !== "active") return { ok: false, error: `subagent run ${runId} is already ${run.state}` };
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
