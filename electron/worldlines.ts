/**
 * Worldline manager (WORLDLINES §6.5, §6.6).
 *
 * Fork Run creates two isolated candidates from a completed run:
 * Candidate A preserves the settled source state and session; Candidate B
 * restores the run-start source state and the effective task. Pair
 * creation is all-or-nothing: any failure cancels both candidates and
 * removes every app-owned resource.
 */
import { execFile, spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { chmod, cp, lstat as lstatPath, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { writeSandboxProfile, sandboxShellPreamble, type SandboxPaths } from "./sandbox.js";
import { coreClient } from "./core-client.js";
import { captureRootInRepo, gitCommonDir, gitHead, gitTopLevel, platformHasCopyOnWrite, type SnapshotStore } from "./worldline-git.js";
import { EvidenceEngine, dependencyDiff, mineChangeReason, rankProfiles, type EvidenceDeps, type EvidenceRecord, type EvidenceSummary } from "./evidence.js";
import type { SessionForkOpts, SessionForkResult } from "./session-fork.js";
import type { DependencyChange, RunSummary, TimelineEvent, WorldlineChangedFile, WorldlineDetails } from "../shared/types.js";
import { copySessionImageFiles, writeForkedSession } from "../agent-core/session.js";
import { MAX_MCP_JSON_BYTES } from "../agent-core/mcp.js";
import { thinkingStartupArgs } from "../shared/terminal-control.js";

/** Quote one shell argument: the resolved base commands carry scripts that
 * must survive as one argument through the wrapper shell. */
export function quoteShellArg(a: string): string {
  return `'${a.replace(/'/g, `'\\''`)}'`;
}

/** The lifecycle of one candidate (WORLDLINES §6.1). */
export type WorldlineState =
  | "creating"
  | "ready"
  | "running"
  | "settled"
  | "verifying"
  | "promoting"
  | "conflict"
  | "cancelled"
  | "error"
  | "discarding"
  | "discarded"
  | "promoted";

export interface WorldlineSummary {
  id: string;
  comparisonId: string;
  label: "A" | "B";
  role: "reference" | "alternative" | "challenge" | "moment";
  comparisonBaseStateId: string | null;
  promotionBaseStateId: string | null;
  headStateId: string | null;
  sourceRunId: string;
  terminalId: string | null;
  version: number;
  state: WorldlineState;
  error: string | null;
  root: string;
  sessionFile: string | null;
  model: string | null;
  thinkingLevel: string | null;
  createdAt: number;
}

interface CandidateState {
  label: "A" | "B";
  role: "reference" | "alternative" | "moment";
  dir: string;
  supportDir: string;
  homeDir: string;
  sessionDir: string;
  eventsDir: string;
  tmpDir: string;
  cacheDir: string;
  profilePath: string;
  sessionFile: string | null;
  /** The shared base state for this comparison. */
  comparisonBaseStateId: string | null;
  /** The root state used for promotion. */
  promotionBaseStateId: string | null;
  /** The latest captured state of this candidate. */
  headStateId: string | null;
  /** Serializes head updates with the matching workspace state. */
  headCommit: Promise<void>;
  terminalId: string | null;
  pid: number | null;
  lstart: string | null;
  state: WorldlineState;
  version: number;
  error: string | null;
}

interface ComparisonState {
  id: string;
  dir: string;
  templateDir: string;
  sessionWorkspaceDir: string;
  sourceRunId: string;
  /** The source Git common dir, resolved at fork time. */
  sourceGitDir: string;
  /** The primary project root, resolved at fork time. */
  primaryRoot: string;
  /** The shared comparison base commit inside the candidate repos. */
  baseCommit: string | null;
  /** The store-side shared base (R) of the lineage. */
  baseStateId: string | null;
  /** Candidates inherit one-process trust when the source was trusted. */
  inheritTrust: boolean;
  /** The model and thinking level of the source run. */
  model: string | null;
  thinkingLevel: string | null;
  /** Which engine produced the source run. */
  engine: "pi" | "core";
  /** When the pair started (ms epoch). */
  createdAt: number;
  candidates: Map<"A" | "B", CandidateState>;
  phase: "creating" | "running" | "error";
  error: string | null;
  readyTimer: ReturnType<typeof setTimeout> | null;
}

/** One recorded run (WORLDLINES §6.5). */
export interface RunRecord {
  id: string;
  terminalId: string;
  workspaceId: string;
  startStateId: string | null;
  settledStateId: string | null;
  promptPayloadFile: string | null;
  promptEventsDir: string | null;
  promptText: string | null;
  promptEntryId: string | null;
  promptParentEntryId: string | null;
  settledEntryId: string | null;
  sessionFile: string | null;
  sessionBranchFile: string | null;
  trusted: boolean | null;
  model: string | null;
  thinkingLevel: string | null;
  replayable: boolean;
  reason: string | null;
  interrupted: boolean;
  steering: boolean;
  overlap: boolean;
  unownedEdits: number;
  startedAt: number;
  settledAt: number | null;
  trustHashes: Record<string, string> | null;
  engine?: "pi" | "core";
}

function runEngine(run: { engine?: "pi" | "core" }): "pi" | "core" {
  return run.engine === "core" ? "core" : "pi";
}

function parseStorageSeq(value: string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function isInside(parent: string, child: string): boolean {
  const rel = child.startsWith(parent) ? child.slice(parent.length) : null;
  return rel !== null && (rel.startsWith("/") || rel === "");
}

export interface PromoteSeed {
  paths: Array<{ rel: string; kind: "write" | "delete"; beforeExists: boolean }>;
  beforeDir: string;
  installedSession: string;
  primaryRoot: string;
  primaryWorkspaceId: string;
  comparisonId: string;
  label: "A" | "B";
  engine: "pi" | "core";
}

export interface WorldlineDeps {
  worldsRoot: string;
  primaryRoot: string;
  realHome: string;
  userData: string;
  primaryEventsDir: string;
  bridgePath: string;
  piBin: string;
  agentCorePath: string;
  electronExecPath: string;
  baseEnv: Record<string, string | undefined>;
  showThinking(): boolean;
  getStore(): Promise<SnapshotStore | null>;
  /** Read-only load paths for the sandboxed pi (app package + node). */
  appReadPaths(): string[];
  forkSession(opts: SessionForkOpts): Promise<SessionForkResult>;
  createCandidate(opts: {
    root: string;
    workspaceId: string;
    engine?: "pi" | "core";
    launch: { cmd: string; args: string[]; env: Record<string, string | undefined> };
  }): Promise<{ terminalId: string; pid: number }>;
  createCandidateWorkspace(root: string, baseStateId: string | null, comparisonId: string): string;
  onUpdate(summary: WorldlineSummary): void;
  onCandidateState(root: string, stateId: string): void | Promise<void>;
  onRemoved(comparisonId: string): void;
  /** The fork preflight (WORLDLINES §4): repo, platform, disk. */
  preflight(): Promise<{ ok: boolean; reasons: string[] }>;
  /** The trust-sensitive resource hashes of the project + pi agent dir. */
  trustHashes(): Promise<Record<string, string>>;
  /** Capture a candidate head off the main thread. */
  captureHead(root: string, gitDir: string, parent: string | null): Promise<{ commit: string; tree: string }>;
  /** Capture the current primary state (details conflict status). */
  capturePrimary(): Promise<string | null>;
  /** Release a temporary state reference after a comparison operation. */
  releaseState(stateId: string): Promise<void>;
  terminalBusy(terminalId: string): boolean;
  terminalVerifying(terminalId: string): boolean;
  workspaceAt(root: string): Promise<{ id: string; generation: number; lastStateCommit: string | null } | null>;
  acquireWriteLease(workspaceId: string, requester: string, timeoutMs: number): Promise<{ ok: boolean; error?: string; generation?: number }>;
  releaseWriteLease(workspaceId: string, requester: string): void;
  flushDirtyModels(requester: string, workspaceId: string, timeoutMs?: number): Promise<{ ok: boolean }>;
  canonicalPath(absPath: string): Promise<string>;
  mineFiles(): ReadonlySet<string>;
  runSandboxedEvidence(
    cand: { root: string; profilePath: string; homeDir: string; tmpDir: string },
    command: string[],
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string; timedOut: boolean }>;
  sourceFilesOf(root: string): Promise<Array<{ relPath: string; content: string }>>;
  createEvidenceHome(): Promise<string>;
  detectTestFromState(store: SnapshotStore, stateId: string): Promise<{ command: string; args: string[]; label: string } | null>;
  benchmarkConfigFrom(store: SnapshotStore, stateId: string): Promise<{
    command: string[];
    unit: string;
    direction: "lower" | "higher";
    samples: number;
    thresholdPct: number;
  } | null>;
  onEvidenceUpdate(summary: EvidenceSummary): void;
  onPromotionApply(relPaths: string[] | null): void;
  primarySessionDir(cwd: string): string;
  installPromoted(seed: PromoteSeed): Promise<{ terminalId: string }>;
}

const RUNTIME_ALLOWLIST = ["node_modules", ".venv", "venv"];
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_PROMPT_BYTES = 20 * 1024 * 1024;
const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CANDIDATE_BYTES = 1024 * 1024 * 1024;
const READY_TIMEOUT_MS = 90000;
const MAX_PI_RESOURCE_BYTES = 200 * 1024 * 1024;
const MAX_WORLDLINE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_RUNS_PER_TERMINAL = 20;
const MAX_RETAINED_RUNS = 200;
const MAX_IGNORED_FILES = 5000;
const MAX_IGNORED_BYTES = 200 * 1024 * 1024;

/** The app-owned marker that proves a worlds dir belongs to the app. */
const MARKER = ".termina-world";

/** The logical size of a directory tree (`du`, in a child process). */
export async function dirBytes(dir: string): Promise<number> {
  return new Promise((resolvePromise) => {
    const child = spawn("du", ["-sk", dir], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    let overflow = false;
    child.stdout.on("data", (data: Buffer) => {
      if (out.length < 128) out += data.toString("utf8").slice(0, 128 - out.length);
      else overflow = true;
    });
    child.on("error", () => resolvePromise(Number.POSITIVE_INFINITY));
    child.on("close", (code) => {
      const m = /^(\d+)/.exec(out.trim());
      resolvePromise(code === 0 && !overflow && m ? Number(m[1]) * 1024 : Number.POSITIVE_INFINITY);
    });
  });
}

export class WorldlineManager {
  private comparisons = new Map<string, ComparisonState>();
  private seq = 0;
  private ready: Promise<void>;
  private terminalToComparison = new Map<string, { comparisonId: string; label: "A" | "B" }>();
  /** Source comparison ids with a challenge launch in flight. */
  private challengeInFlight = new Set<string>();
  private evidenceByComparison = new Map<string, EvidenceSummary>();
  private evidenceQueue: Promise<unknown> = Promise.resolve();
  private runsByTerminal = new Map<string, RunRecord[]>();
  private runsById = new Map<string, RunRecord>();

  constructor(private deps: WorldlineDeps) {
    mkdirSync(this.deps.worldsRoot, { recursive: true });
    this.ready = this.sweepStale();
  }

  // ------------------------------------------------------------ listing ----

  list(): WorldlineSummary[] {
    const out: WorldlineSummary[] = [];
    for (const cmp of this.comparisons.values()) {
      for (const cand of cmp.candidates.values()) {
        out.push(this.summaryOf(cmp, cand));
      }
    }
    return out;
  }

  /** Add the run to the project catalog. */
  recordRun(run: RunRecord): void {
    this.runsById.set(run.id, run);
    let list = this.runsByTerminal.get(run.terminalId);
    if (!list) {
      list = [];
      this.runsByTerminal.set(run.terminalId, list);
    }
    list.push(run);
    this.evictOverflow(run.terminalId);
  }

  runOf(runId: string): RunRecord | null {
    return this.runsById.get(runId) ?? null;
  }

  private runsOf(terminalId?: string): RunRecord[] {
    if (terminalId) return [...(this.runsByTerminal.get(terminalId) ?? [])];
    const out: RunRecord[] = [];
    for (const list of this.runsByTerminal.values()) out.push(...list);
    return out;
  }

  runSummaries(terminalId?: string): RunSummary[] {
    return this.runsOf(terminalId).map((r) => ({
      id: r.id,
      terminalId: r.terminalId,
      workspaceId: r.workspaceId,
      startStateId: r.startStateId,
      settledStateId: r.settledStateId,
      promptText: r.promptText,
      promptEntryId: r.promptEntryId,
      promptParentEntryId: r.promptParentEntryId,
      settledEntryId: r.settledEntryId,
      sessionFile: r.sessionFile,
      sessionBranchFile: r.sessionBranchFile,
      replayable: r.replayable,
      reason: r.reason,
      interrupted: r.interrupted,
      steering: r.steering,
      overlap: r.overlap,
      unownedEdits: r.unownedEdits,
      trusted: r.trusted,
      model: r.model,
      thinkingLevel: r.thinkingLevel,
      startedAt: r.startedAt,
      settledAt: r.settledAt,
    }));
  }

  runCovering(terminalId: string, ts: number): RunRecord | null {
    const runs = this.runsByTerminal.get(terminalId) ?? [];
    for (let i = runs.length - 1; i >= 0; i--) {
      const run = runs[i];
      if (ts < run.startedAt) continue;
      if (run.settledAt !== null && ts > run.settledAt) continue;
      return run;
    }
    return null;
  }

  holdsRunState(stateId: string): boolean {
    for (const run of this.runsById.values()) {
      if (run.startStateId === stateId || run.settledStateId === stateId) return true;
    }
    return false;
  }

  promptPayloadsOf(terminalId: string): Set<string> {
    const keep = new Set<string>();
    for (const run of this.runsByTerminal.get(terminalId) ?? []) {
      if (run.promptPayloadFile) keep.add(run.promptPayloadFile);
    }
    return keep;
  }

  /** Run ids that a live comparison still needs (promote, evidence, nested fork). */
  private pinnedRunIds(): Set<string> {
    const pinned = new Set<string>();
    for (const cmp of this.comparisons.values()) {
      if (cmp.sourceRunId) pinned.add(cmp.sourceRunId);
    }
    return pinned;
  }

  private canDiscard(run: RunRecord, pinned: Set<string>): boolean {
    return run.settledAt !== null && !pinned.has(run.id);
  }

  private oldestDiscardable(pinned: Set<string>): RunRecord | null {
    let oldest: RunRecord | null = null;
    for (const records of this.runsByTerminal.values()) {
      for (const run of records) {
        if (!this.canDiscard(run, pinned)) continue;
        if (!oldest || run.startedAt < oldest.startedAt) oldest = run;
      }
    }
    return oldest;
  }

  /**
   * Drop the oldest disposable records. Never drop an open run or the
   * source of a live comparison.
   */
  private evictOverflow(terminalId: string): void {
    const pinned = this.pinnedRunIds();
    const list = this.runsByTerminal.get(terminalId);
    if (list) {
      while (list.length > MAX_RUNS_PER_TERMINAL) {
        const idx = list.findIndex((run) => this.canDiscard(run, pinned));
        if (idx < 0) break;
        this.discardRun(list.splice(idx, 1)[0]);
      }
    }
    while (this.runsById.size > MAX_RETAINED_RUNS) {
      const victim = this.oldestDiscardable(pinned);
      if (!victim) break;
      const records = this.runsByTerminal.get(victim.terminalId);
      if (!records) break;
      const idx = records.indexOf(victim);
      if (idx >= 0) records.splice(idx, 1);
      if (records.length === 0) this.runsByTerminal.delete(victim.terminalId);
      this.discardRun(victim);
    }
  }

  private discardRun(run: RunRecord | undefined): void {
    if (!run) return;
    this.runsById.delete(run.id);
    if (run.startStateId) void this.deps.releaseState(run.startStateId);
    if (run.settledStateId && run.settledStateId !== run.startStateId) void this.deps.releaseState(run.settledStateId);
    if (run.promptPayloadFile && run.promptEventsDir) {
      void rm(join(run.promptEventsDir, run.promptPayloadFile), { force: true }).catch(() => undefined);
    }
    if (run.sessionBranchFile) void rm(run.sessionBranchFile, { force: true }).catch(() => undefined);
  }

  private clearRuns(): void {
    for (const list of this.runsByTerminal.values()) {
      for (const run of list) this.discardRun(run);
    }
    this.runsByTerminal.clear();
    this.runsById.clear();
  }

  private summaryOf(cmp: ComparisonState, cand: CandidateState): WorldlineSummary {
    return {
      id: `${cmp.id}-${cand.label.toLowerCase()}`,
      comparisonId: cmp.id,
      label: cand.label,
      role: cand.role,
      comparisonBaseStateId: cand.comparisonBaseStateId,
      promotionBaseStateId: cand.promotionBaseStateId,
      headStateId: cand.headStateId,
      sourceRunId: cmp.sourceRunId,
      terminalId: cand.terminalId,
      version: cand.version,
      state: cand.state,
      error: cand.error,
      root: cand.dir,
      sessionFile: cand.sessionFile,
      model: cmp.model,
      thinkingLevel: cmp.thinkingLevel,
      createdAt: cmp.createdAt,
    };
  }

  /** The candidate events dir of a terminal, or null. */
  eventsDirOf(terminalId: string): string | null {
    const hit = this.terminalToComparison.get(terminalId);
    if (!hit) return null;
    return this.comparisons.get(hit.comparisonId)?.candidates.get(hit.label)?.eventsDir ?? null;
  }

  /** Update the latest captured state of a candidate. */
  async updateHeadState(terminalId: string, stateId: string): Promise<void> {
    const hit = this.terminalToComparison.get(terminalId);
    if (hit) await this.setCandidateHead(hit.comparisonId, hit.label, stateId);
  }

  /** Record a captured candidate state from an on-demand operation. */
  setCandidateHead(comparisonId: string, label: "A" | "B", stateId: string): Promise<void> {
    const cmp = this.comparisons.get(comparisonId);
    const cand = cmp?.candidates.get(label);
    if (!cmp || !cand) return Promise.resolve();
    const commit = cand.headCommit.catch(() => undefined).then(async () => {
      if (this.comparisons.get(comparisonId)?.candidates.get(label) !== cand || cand.headStateId === stateId) return;
      const previousStateId = cand.headStateId;
      await this.deps.onCandidateState(cand.dir, stateId);
      if (this.comparisons.get(comparisonId)?.candidates.get(label) !== cand) return;
      cand.headStateId = stateId;
      if (previousStateId) void this.deps.releaseState(previousStateId);
      cand.version++;
      this.pushUpdate(cmp, cand);
    });
    cand.headCommit = commit;
    return commit;
  }

  /**
   * Return the candidate version and head state used to validate evidence.
   */
  evidenceVersion(comparisonId: string, label: "A" | "B"): { version: number; headStateId: string | null } | null {
    const cand = this.comparisons.get(comparisonId)?.candidates.get(label);
    return cand ? { version: cand.version, headStateId: cand.headStateId } : null;
  }

  /**
   * Challenge an existing candidate (WORLDLINES §6.9): the candidate is
   * snapshotted as the new reference A; the challenger B starts from the
   * recorded comparison base and the pre-task session anchor with the
   * original task. The root promotion base stays unchanged.
   */
  async challengeFromCandidate(comparisonId: string, label: "A" | "B"): Promise<{ ok: boolean; comparisonId?: string; error?: string }> {
    await this.ready;
    const cmp = this.comparisons.get(comparisonId);
    const cand = cmp?.candidates.get(label);
    if (!cmp || !cand) return { ok: false, error: "candidate not found" };
    if (cmp.phase !== "running" && cmp.phase !== "creating") {
      return { ok: false, error: "this comparison is no longer live" };
    }
    if (this.challengeInFlight.has(comparisonId)) return { ok: false, error: "a challenge is already launching" };
    if (!cand.sessionFile) return { ok: false, error: "the candidate has no session" };
    if (cand.state === "running" || cand.state === "creating" || cand.state === "promoting") {
      return { ok: false, error: "wait for the candidate to settle before Challenge" };
    }
    const store = await this.deps.getStore();
    if (!store) return { ok: false, error: "recording is not available" };
    if (!cmp.baseStateId) return { ok: false, error: "the comparison base is missing" };
    const run = this.runOf(cmp.sourceRunId);
    if (!run?.promptPayloadFile) {
      return { ok: false, error: "the run has no captured task or pre-task anchor" };
    }
    if (cmp.engine !== "core" && !run.promptParentEntryId) {
      return { ok: false, error: "the run has no captured task or pre-task anchor" };
    }
    // This comparison is replaced by the challenge pair, so its live
    // candidates free their budget slots.
    if (this.liveWorldlineCount() - cmp.candidates.size + 2 > 3) {
      return { ok: false, error: "the live worldline budget is exhausted" };
    }
    this.challengeInFlight.add(comparisonId);
    try {
    // Snapshot the candidate head as the new reference A.
    const wHead = await this.deps.captureHead(cand.dir, join(cand.dir, ".git"), cmp.baseStateId);
    const id = `cmp-${++this.seq}`;
    const dir = join(this.deps.worldsRoot, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, MARKER), randomUUID(), "utf8");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id, sourceRunId: cmp.sourceRunId, createdAt: Date.now(), candidates: {} }), "utf8");
    const ncmp: ComparisonState = {
      id,
      dir,
      templateDir: join(dir, "template"),
      sessionWorkspaceDir: join(dir, "session-workspace"),
      sourceRunId: cmp.sourceRunId,
      sourceGitDir: store.sourceGitDir,
      primaryRoot: this.deps.primaryRoot,
      baseCommit: null,
      baseStateId: cmp.baseStateId,
      inheritTrust: cmp.inheritTrust,
      model: cmp.model,
      thinkingLevel: cmp.thinkingLevel,
      engine: cmp.engine,
      createdAt: Date.now(),
      candidates: new Map(),
      phase: "creating",
      error: null,
      readyTimer: null,
    };
    const mk = (l: "A" | "B", role: "reference" | "alternative"): CandidateState => ({
      label: l,
      role,
      dir: join(dir, l),
      supportDir: join(dir, `${l}-support`),
      homeDir: join(dir, `${l}-support`, "home"),
      sessionDir: join(dir, `${l}-support`, "sessions"),
      eventsDir: join(dir, `${l}-support`, "events"),
      tmpDir: join(dir, `${l}-support`, "tmp"),
      cacheDir: join(dir, `${l}-support`, "cache"),
      profilePath: join(dir, `${l}-support`, "sandbox.sb"),
      sessionFile: null,
      comparisonBaseStateId: null,
      promotionBaseStateId: null,
      headStateId: null,
      headCommit: Promise.resolve(),
      terminalId: null,
      pid: null,
      lstart: null,
      state: "creating",
      version: 1,
      error: null,
    });
    const nA = mk("A", "reference");
    const nB = mk("B", "alternative");
    ncmp.candidates.set("A", nA);
    ncmp.candidates.set("B", nB);
    for (const candidate of ncmp.candidates.values()) {
      candidate.comparisonBaseStateId = ncmp.baseStateId;
      candidate.promotionBaseStateId = ncmp.baseStateId;
    }
    nA.headStateId = wHead.commit;
    nB.headStateId = ncmp.baseStateId;
    this.comparisons.set(id, ncmp);
    try {
      const payload = await this.readPromptPayload(run);
      this.createSupportDirs(ncmp);
      // The template is the SHARED BASE (R), not the reference head: the
      // challenger starts from the recorded base.
      mkdirSync(ncmp.templateDir, { recursive: true });
      await store.template({
        stateId: cmp.baseStateId,
        targetDir: ncmp.templateDir,
        sourceObjectsDir: join(ncmp.sourceGitDir, "objects"),
      });
      ncmp.baseCommit = await gitHead(ncmp.templateDir);
      for (const name of RUNTIME_ALLOWLIST) {
        const src = join(this.deps.primaryRoot, name);
        if (!existsSync(src)) continue;
        await this.cloneTree(src, join(ncmp.templateDir, name));
      }
      await this.cloneTree(ncmp.templateDir, nA.dir);
      await this.cloneTree(ncmp.templateDir, nB.dir);
      // The reference A receives the candidate head state.
      await store.applyState({ stateId: wHead.commit, targetDir: nA.dir, preserveTopLevel: RUNTIME_ALLOWLIST });
      // A's session continues from the candidate leaf; B's session branches
      // at the pre-task anchor (the original run's prompt parent).
      if (ncmp.engine === "core") {
        if (!cand.sessionFile) throw new Error("could not fork the reference session");
        const destA = join(nA.sessionDir, "session.jsonl");
        const destB = join(nB.sessionDir, "session.jsonl");
        await writeFile(destA, await readFile(cand.sessionFile), { mode: 0o600 });
        await copySessionImageFiles(cand.sessionFile, destA);
        const throughB = parseStorageSeq(run.promptParentEntryId) ?? 0;
        const sourceB = run.sessionBranchFile ?? run.sessionFile ?? cand.sessionFile;
        const forkB = await writeForkedSession(sourceB, destB, throughB);
        if (!forkB.ok) throw new Error(`could not fork the challenger session: ${forkB.error}`);
        nA.sessionFile = destA;
        nB.sessionFile = destB;
        await this.copyCoreResources(ncmp);
      } else {
        const [forkA, forkB] = await Promise.all([
          this.deps.forkSession({
            sourceSessionFile: cand.sessionFile,
            entryId: null,
            sessionWorkspaceDir: ncmp.sessionWorkspaceDir,
            candidateRoot: nA.dir,
            candidateSessionDir: nA.sessionDir,
            relocationNote: `The source project lived at ${this.deps.primaryRoot}. In this candidate, that path maps to ${nA.dir}.`,
          }),
          this.deps.forkSession({
            sourceSessionFile: run.sessionFile ?? cand.sessionFile,
            entryId: run.promptParentEntryId,
            sessionWorkspaceDir: ncmp.sessionWorkspaceDir,
            candidateRoot: nB.dir,
            candidateSessionDir: nB.sessionDir,
            contextText: payload.context || undefined,
          }),
        ]);
        if (!forkA.ok || !forkA.sessionFile) throw new Error("could not fork the reference session");
        if (!forkB.ok || !forkB.sessionFile) throw new Error("could not fork the challenger session");
        nA.sessionFile = forkA.sessionFile;
        nB.sessionFile = forkB.sessionFile;
        await this.copyPiResources(ncmp);
      }
      // B replays the original task automatically (structured control).
      await this.writeControl(nA, { opId: randomUUID(), action: "none" });
      await this.writeControl(nB, {
        opId: randomUUID(),
        action: "structured",
        content: [{ type: "text", text: payload.text }, ...payload.images],
      });
      await this.launchCandidate(ncmp, nA, [], wHead.commit);
      await this.launchCandidate(ncmp, nB, cmp.model && cmp.model.includes("/") ? ["--model", cmp.model] : [], ncmp.baseStateId);
      ncmp.phase = "running";
      ncmp.readyTimer = setTimeout(() => {
        if (ncmp.phase !== "running") return;
        void this.teardown(ncmp.id, "error", "the candidates did not become ready in time");
      }, READY_TIMEOUT_MS);
      // Drop the source from the live budget immediately. Teardown waits
      // on process group signals; do not hold the IPC handler for that.
      cmp.phase = "error";
      void this.teardown(comparisonId, "discarded", null);
      return { ok: true, comparisonId: id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.teardown(ncmp.id, "error", message);
      await this.deps.releaseState(wHead.commit);
      return { ok: false, error: message };
    }
    } finally {
      this.challengeInFlight.delete(comparisonId);
    }
  }

  /** The ignored/generated writes a promotion would exclude (metadata).
   *  The runtime allowlist (node_modules, .venv, venv) is a template input,
   *  not a candidate write: it never counts. */
  async ignoredWrites(comparisonId: string, label: "A" | "B"): Promise<{ count: number; bytes: number }> {
    const cmp = this.comparisons.get(comparisonId);
    const cand = cmp?.candidates.get(label);
    if (!cmp || !cand) return { count: 0, bytes: 0 };
    try {
      const ignored = await coreClient.lsIgnored(cand.dir);
      let count = 0;
      let bytes = 0;
      for (const p of ignored) {
        if (!p || count >= MAX_IGNORED_FILES || bytes >= MAX_IGNORED_BYTES) continue;
        if (RUNTIME_ALLOWLIST.includes(p.split(/[\\/]/)[0])) continue;
        count++;
        try {
          bytes = Math.min(MAX_IGNORED_BYTES, bytes + (await lstatPath(join(cand.dir, p))).size);
        } catch {
          /* The file can disappear before it is measured. */
        }
      }
      return { count, bytes };
    } catch {
      return { count: 0, bytes: 0 };
    }
  }

  /** True when a candidate has source changes or session activity (§6.11). */
  async activeCandidates(): Promise<number> {
    let active = 0;
    for (const cmp of this.comparisons.values()) {
      for (const cand of cmp.candidates.values()) {
        if (cand.state === "discarded" || cand.state === "error" || cand.state === "promoted") continue;
        try {
          const changes = await coreClient.repoStatus(cand.dir);
          if (changes.length > 0) {
            active++;
            continue;
          }
        } catch {
          /* unreachable — count as active */
          active++;
          continue;
        }
        // Session activity beyond the fork: the session file has entries
        // past the initial control marker.
        try {
          if (cand.sessionFile && (await stat(cand.sessionFile)).size > 1024) active++;
        } catch {
          active++;
        }
      }
    }
    return active;
  }

  /** The comparison and candidate behind one terminal, or null. */
  candidateContextOf(terminalId: string): { sourceRunId: string; sessionFile: string | null } | null {
    const hit = this.terminalToComparison.get(terminalId);
    if (!hit) return null;
    const cmp = this.comparisons.get(hit.comparisonId);
    const cand = cmp?.candidates.get(hit.label);
    if (!cmp || !cand) return null;
    return { sourceRunId: cmp.sourceRunId, sessionFile: cand.sessionFile };
  }

  /** The sandbox launch facts of a candidate terminal, or null. */
  candidateSandboxOf(terminalId: string): {
    root: string;
    profilePath: string;
    homeDir: string;
    tmpDir: string;
    eventsDir: string;
  } | null {
    const hit = this.terminalToComparison.get(terminalId);
    if (!hit) return null;
    const cand = this.comparisons.get(hit.comparisonId)?.candidates.get(hit.label);
    if (!cand) return null;
    return { root: cand.dir, profilePath: cand.profilePath, homeDir: cand.homeDir, tmpDir: cand.tmpDir, eventsDir: cand.eventsDir };
  }

  // ------------------------------------------------------ details on demand ----

  /** Compute one candidate's comparison details (WORLDLINES §6.9). */
  async details(comparisonId: string, label: "A" | "B"): Promise<{ ok: boolean; details?: WorldlineDetails; error?: string }> {
    const cmp = this.comparisons.get(comparisonId);
    const cand = cmp?.candidates.get(label);
    if (!cmp || !cand) return { ok: false, error: "candidate not found" };
    if (!cmp.baseCommit) return { ok: false, error: "the comparison base is missing" };
    let primaryCommit: string | null = null;
    try {
      const changedFiles = await this.changedFiles(cmp, cand);
      // Provenance: the unowned edits of the source run (§6.9).
      const unownedEdits = this.runOf(cmp.sourceRunId)?.unownedEdits ?? 0;
      // Ignored/generated runtime fingerprints: metadata only, bounded.
      const ignored = await this.ignoredWrites(comparisonId, label);
      // Conflict status against the current primary source: capture P and
      // merge the candidate head against it (on demand, WORLDLINES §6.9).
      let conflicts: string[] = [];
      primaryCommit = await this.deps.capturePrimary();
      if (primaryCommit && cmp.baseStateId) {
        try {
          const store = await this.deps.getStore();
          if (store) {
            const wHead = await this.deps.captureHead(cand.dir, join(cand.dir, ".git"), cmp.baseStateId);
            await this.setCandidateHead(cmp.id, label, wHead.commit);
            const merged = await store.merge3(wHead.commit, primaryCommit);
            if (!merged.ok && merged.tree) conflicts = merged.conflicts;
            else if (!merged.ok && !merged.tree) conflicts = [merged.reason ?? "merge failed"];
          }
        } catch {
          /* Conflict status can be incomplete. */
        }
      }
      return {
        ok: true,
        details: {
          id: `${cmp.id}-${label.toLowerCase()}`,
          comparisonId: cmp.id,
          label,
          state: cand.state,
          error: cand.error,
          sourceRunId: cmp.sourceRunId,
          comparisonBaseStateId: cand.comparisonBaseStateId,
          promotionBaseStateId: cand.promotionBaseStateId,
          headStateId: cand.headStateId,
          model: cmp.model,
          thinkingLevel: cmp.thinkingLevel,
          createdAt: cmp.createdAt,
          sourceFiles: changedFiles.sourceFiles,
          sourceBytes: changedFiles.sourceBytes,
          changedFiles: changedFiles.files,
          dependencies: await this.dependencyChanges(cmp, cand),
          unownedEdits,
          ignoredFiles: ignored.count,
          ignoredBytes: ignored.bytes,
          primaryConflicts: conflicts,
          ageMs: Date.now() - cmp.createdAt,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (primaryCommit) await this.deps.releaseState(primaryCommit);
    }
  }

  /** Read one file from a candidate tree. */
  async fileOf(comparisonId: string, label: "A" | "B", relPath: string): Promise<{ ok: boolean; content?: string; error?: string }> {
    const cmp = this.comparisons.get(comparisonId);
    const cand = cmp?.candidates.get(label);
    if (!cmp || !cand) return { ok: false, error: "candidate not found" };
    if (!this.isSafeRelativePath(relPath)) return { ok: false, error: "invalid candidate path" };
    const root = resolve(cand.dir);
    const target = resolve(root, relPath);
    if (!isInside(root, target)) return { ok: false, error: "path escapes the candidate tree" };
    try {
      const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(root), realpath(target)]);
      if (!isInside(canonicalRoot, canonicalTarget)) return { ok: false, error: "path escapes the candidate tree" };
      const info = await stat(canonicalTarget);
      if (!info.isFile()) return { ok: false, error: "the candidate path is not a file" };
      if (info.size > MAX_WORLDLINE_FILE_BYTES) return { ok: false, error: "the candidate file is too large" };
      return { ok: true, content: await readFile(canonicalTarget, "utf8") };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Read one file from the shared comparison base commit. */
  async baseFileOf(comparisonId: string, relPath: string): Promise<{ ok: boolean; content?: string; error?: string }> {
    const cmp = this.comparisons.get(comparisonId);
    if (!cmp || !cmp.baseCommit) return { ok: false, error: "the comparison base is missing" };
    if (!this.isSafeRelativePath(relPath)) return { ok: false, error: "invalid base path" };
    const anyCand = cmp.candidates.get("A") ?? cmp.candidates.get("B");
    if (!anyCand) return { ok: false, error: "candidate not found" };
    const res = await coreClient.repoFile(anyCand.dir, cmp.baseCommit!, relPath);
    if (res === null) return { ok: false, error: "file not in the base" };
    if (res.byteLength > MAX_WORLDLINE_FILE_BYTES) return { ok: false, error: "the base file is too large" };
    return { ok: true, content: res.toString() };
  }

  private isSafeRelativePath(relPath: string): boolean {
    return relPath.length > 0 && relPath !== "." && relPath.indexOf("\0") === -1 && !isAbsolute(relPath) && !relPath.startsWith("/") && !relPath.split(/[\\/]/).includes("..");
  }

  /** Files differing from the base plus head-tree source statistics. */
  private async changedFiles(cmp: ComparisonState, cand: CandidateState): Promise<{ files: WorldlineChangedFile[]; sourceFiles: number; sourceBytes: number }> {
    // Working tree vs HEAD: staged, unstaged, and untracked changes.
    const status = await coreClient.repoStatus(cand.dir);
    // Committed changes since the shared base (A's settled apply and any
    // agent commits; B usually has none).
    const committed = await coreClient.repoDiff(cand.dir, cmp.baseCommit!, "HEAD");
    const tree = await coreClient.repoTree(cand.dir, "HEAD");
    const byPath = new Map<string, WorldlineChangedFile>();
    const set = (relPath: string, status: "created" | "modified" | "deleted"): void => {
      const prev = byPath.get(relPath);
      // A later state wins: deleted beats modified, created beats deleted.
      if (!prev || (status === "deleted" && prev.status !== "deleted") || (status === "created" && prev.status !== "deleted")) {
        byPath.set(relPath, { relPath, status });
      }
    };
    for (const change of status) {
      set(change.relPath, change.status);
    }
    for (const change of committed) {
      set(change.relPath, change.status);
    }
    let sourceFiles = tree.length;
    let sourceBytes = 0;
    for (const entry of tree) {
      sourceBytes += entry.size;
    }
    const files = [...byPath.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
    return { files, sourceFiles, sourceBytes };
  }

  /** Declared dependency differences between base and head. */
  private async dependencyChanges(cmp: ComparisonState, cand: CandidateState): Promise<DependencyChange[]> {
    const out: DependencyChange[] = [];
    for (const file of ["package.json", "pyproject.toml"]) {
      try {
        const base = await coreClient.repoFile(cand.dir, cmp.baseCommit!, file);
        const head = await this.fileOf(cmp.id, cand.label, file);
        if (base === null || !head.ok || head.content === undefined) continue;
        const diff = this.dependencyChangeOf(file, base.toString(), head.content);
        if (diff) out.push(diff);
      } catch {
        /* the file is not comparable */
      }
    }
    return out;
  }

  /** One dependency difference record, or null when nothing changed. */
  private dependencyChangeOf(file: string, baseText: string, headText: string): DependencyChange | null {
    try {
      const diff = dependencyDiff(baseText, headText);
      if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) return null;
      return { file, added: diff.added, removed: diff.removed, changed: diff.changed };
    } catch {
      return null;
    }
  }

  /** The sandbox facts the evidence engine needs for one candidate. */
  evidenceTarget(comparisonId: string, label: "A" | "B"): {
    root: string;
    profilePath: string;
    homeDir: string;
    tmpDir: string;
    state: WorldlineState;
    terminalId: string | null;
    eventsDir: string;
    version: number;
    headStateId: string | null;
  } | null {
    const cmp = this.comparisons.get(comparisonId);
    const cand = cmp?.candidates.get(label);
    if (!cmp || !cand) return null;
    return {
      root: cand.dir,
      profilePath: cand.profilePath,
      homeDir: cand.homeDir,
      tmpDir: cand.tmpDir,
      state: cand.state,
      terminalId: cand.terminalId,
      eventsDir: cand.eventsDir,
      version: cand.version,
      headStateId: cand.headStateId,
    };
  }

  // ------------------------------------------------------------ fork-run ----

  async challenge(runId: string): Promise<{ ok: boolean; comparisonId?: string; error?: string }> {
    const run = this.runOf(runId);
    if (!run) return { ok: false, error: "run not found" };
    if (!run.promptPayloadFile) return { ok: false, error: "the run has no captured task to replay" };
    return this.forkRun(runId, { challenge: true });
  }

  async forkRun(runId: string, opts: { challenge?: boolean } = {}): Promise<{ ok: boolean; comparisonId?: string; error?: string }> {
    await this.ready;
    const run = this.runOf(runId);
    if (!run) return { ok: false, error: "run not found" };
    // Eligibility (WORLDLINES §6.5): replayable run with complete states.
    if (!run.replayable) return { ok: false, error: run.reason ?? "the run is not replayable" };
    if (!run.startStateId || !run.settledStateId) return { ok: false, error: "the run has no complete source checkpoints" };
    if (!run.sessionBranchFile) return { ok: false, error: "the run has no session branch copy" };
    if (this.liveWorldlineCount() + 2 > 3) return { ok: false, error: "the live worldline budget is exhausted" };
    // The fork preflight (WORLDLINES §4): repository, platform, disk.
    const pre = await this.deps.preflight();
    if (!pre.ok) return { ok: false, error: pre.reasons.join("; ") };
    const store = await this.deps.getStore();
    if (!store) return { ok: false, error: "recording is not available" };
    if (resolve(store.sourceRoot) !== resolve(this.deps.primaryRoot)) {
      return { ok: false, error: "the source repository identity changed since the run" };
    }
    // Trust-sensitive resources must still match the run's capture (§6.5).
    if (run.trustHashes) {
      const now = await this.deps.trustHashes();
      const changed = Object.keys(run.trustHashes).filter((k) => now[k] !== run.trustHashes![k]);
      if (changed.length > 0) {
        return { ok: false, error: `trust-sensitive resources changed since the run: ${changed.slice(0, 3).join(", ")}` };
      }
    }
    // Budgets (WORLDLINES §9): session and prompt payload caps.
    if (run.sessionBranchFile) {
      try {
        if ((await stat(run.sessionBranchFile)).size > MAX_SESSION_BYTES) {
          return { ok: false, error: "the session branch exceeds the 64 MB budget" };
        }
      } catch {
        /* unreadable — the eligibility checks above already cover it */
      }
    }
    if (run.promptPayloadFile) {
      if (run.promptPayloadFile.includes("/") || run.promptPayloadFile.includes("\\")) {
        return { ok: false, error: "the prompt payload path is invalid" };
      }
      const payloadPath = await this.safePromptPayloadPath(run);
      if (!payloadPath) return { ok: false, error: "the prompt payload is unavailable" };
      try {
        if ((await stat(payloadPath)).size > MAX_PROMPT_BYTES) {
          return { ok: false, error: "the prompt payload exceeds the 20 MB budget" };
        }
      } catch {
        return { ok: false, error: "the prompt payload is unavailable" };
      }
    }

    const cmp = this.createComparison(run);
    try {
      cmp.sourceGitDir = store.sourceGitDir;
      cmp.primaryRoot = store.sourceRoot;
      await this.buildTemplate(cmp, store, run);
      const templateBytes = await dirBytes(cmp.templateDir);
      if (templateBytes > MAX_TEMPLATE_BYTES) {
        throw new Error(`the comparison template exceeds the 2 GB budget (${(templateBytes / 1e9).toFixed(1)} GB)`);
      }
      await this.cloneCandidates(cmp);
      await this.applySettledToA(cmp, store, run);
      const aBytes = await dirBytes(cmp.candidates.get("A")!.dir);
      if (aBytes > MAX_CANDIDATE_BYTES) {
        throw new Error(`candidate A exceeds the 1 GB budget (${(aBytes / 1e9).toFixed(1)} GB)`);
      }
      await this.forkSessions(cmp, run);
      this.createSupportDirs(cmp);
      if (cmp.engine === "core") await this.copyCoreResources(cmp);
      else await this.copyPiResources(cmp);
      await this.writeStartupControls(cmp, run, opts.challenge ?? false);
      await this.launchCandidates(cmp, run);
      cmp.phase = "running";
      // Readiness arrives through the bridge session_ready events.
      cmp.readyTimer = setTimeout(() => {
        if (cmp.phase !== "running") return;
        void this.teardown(cmp.id, "error", "the candidates did not become ready in time");
      }, READY_TIMEOUT_MS);
      return { ok: true, comparisonId: cmp.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.teardown(cmp.id, "error", message);
      return { ok: false, error: message };
    }
  }

  private createComparison(run: RunRecord): ComparisonState {
    const id = `cmp-${++this.seq}`;
    const dir = join(this.deps.worldsRoot, id);
    mkdirSync(dir, { recursive: true });
    // The marker proves ownership before any cleanup deletes the dir.
    writeFileSync(join(dir, MARKER), randomUUID(), "utf8");
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ id, sourceRunId: run.id, createdAt: Date.now(), candidates: {} }),
      "utf8",
    );
    const cmp: ComparisonState = {
      id,
      dir,
      templateDir: join(dir, "template"),
      sessionWorkspaceDir: join(dir, "session-workspace"),
      sourceRunId: run.id,
      sourceGitDir: "",
      primaryRoot: this.deps.primaryRoot,
      baseCommit: null,
      baseStateId: run.startStateId,
      inheritTrust: run.trusted === true && run.trustHashes !== null,
      model: run.model,
      thinkingLevel: run.thinkingLevel,
      engine: runEngine(run),
      createdAt: Date.now(),
      candidates: new Map(),
      phase: "creating",
      error: null,
      readyTimer: null,
    };
    for (const label of ["A", "B"] as const) {
      cmp.candidates.set(label, {
        label,
        role: label === "A" ? "reference" : "alternative",
        dir: join(dir, label),
        supportDir: join(dir, `${label}-support`),
        homeDir: join(dir, `${label}-support`, "home"),
        sessionDir: join(dir, `${label}-support`, "sessions"),
        eventsDir: join(dir, `${label}-support`, "events"),
        tmpDir: join(dir, `${label}-support`, "tmp"),
        cacheDir: join(dir, `${label}-support`, "cache"),
        profilePath: join(dir, `${label}-support`, "sandbox.sb"),
        sessionFile: null,
        comparisonBaseStateId: null,
        promotionBaseStateId: null,
        headStateId: null,
        headCommit: Promise.resolve(),
        terminalId: null,
        pid: null,
        lstart: null,
        state: "creating",
        version: 1,
        error: null,
      });
    }
    for (const cand of cmp.candidates.values()) {
      cand.comparisonBaseStateId = cmp.baseStateId;
      cand.promotionBaseStateId = cmp.baseStateId;
      cand.headStateId = cand.label === "A" ? run.settledStateId : run.startStateId;
    }
    this.comparisons.set(id, cmp);
    return cmp;
  }

  /** The comparison template: base source bytes plus independent git. */
  private async buildTemplate(cmp: ComparisonState, store: SnapshotStore, run: RunRecord): Promise<void> {
    mkdirSync(cmp.templateDir, { recursive: true });
    await store.template({
      stateId: run.startStateId!,
      targetDir: cmp.templateDir,
      sourceObjectsDir: join(cmp.sourceGitDir, "objects"),
    });
    // The template repo has exactly one commit ("termina base"). Its SHA
    // is the shared comparison base for both candidates.
    cmp.baseCommit = await gitHead(cmp.templateDir);
    // Copy the fixed runtime allowlist into the template.
    for (const name of RUNTIME_ALLOWLIST) {
      const src = join(this.deps.primaryRoot, name);
      if (!existsSync(src)) continue;
      await this.cloneTree(src, join(cmp.templateDir, name));
    }
  }

  /** Clone a directory tree. Prefer copy-on-write (`cp -c`) when the volume supports it. */
  private async cloneTree(src: string, dst: string): Promise<void> {
    const runCp = (args: string[]) =>
      new Promise<number>((resolvePromise) => {
        const child = spawn("cp", args, { stdio: "ignore" });
        child.on("error", () => resolvePromise(-1));
        child.on("close", (code) => resolvePromise(code ?? -1));
      });
    if (platformHasCopyOnWrite()) {
      const coW = await runCp(["-c", "-R", src, dst]);
      if (coW === 0) return;
      await rm(dst, { recursive: true, force: true }).catch(() => undefined);
    }
    const copied = await runCp(["-R", src, dst]);
    if (copied === 0) return;
    await rm(dst, { recursive: true, force: true }).catch(() => undefined);
    try {
      await cp(src, dst, { recursive: true });
    } catch {
      await rm(dst, { recursive: true, force: true }).catch(() => undefined);
      throw new Error(`directory clone failed for ${src}`);
    }
  }

  /** CoW clone the template into A and B when the volume supports it. */
  private async cloneCandidates(cmp: ComparisonState): Promise<void> {
    for (const cand of cmp.candidates.values()) {
      await this.cloneTree(cmp.templateDir, cand.dir);
    }
  }

  /** Candidate A receives the settled source state. */
  private async applySettledToA(cmp: ComparisonState, store: SnapshotStore, run: RunRecord): Promise<void> {
    const a = cmp.candidates.get("A")!;
    await store.applyState({ stateId: run.settledStateId!, targetDir: a.dir, preserveTopLevel: RUNTIME_ALLOWLIST });
  }

  /** Fork both sessions. Pi uses SessionManager; core slices JSONL. */
  private async forkSessions(cmp: ComparisonState, run: RunRecord): Promise<void> {
    if (cmp.engine === "core") {
      await this.forkCoreSessions(cmp, run);
      return;
    }
    const payload = await this.readPromptPayload(run);
    const a = cmp.candidates.get("A")!;
    const b = cmp.candidates.get("B")!;
    const [forkA, forkB] = await Promise.all([
      this.deps.forkSession({
        sourceSessionFile: run.sessionBranchFile!,
        entryId: run.settledEntryId,
        sessionWorkspaceDir: cmp.sessionWorkspaceDir,
        candidateRoot: a.dir,
        candidateSessionDir: a.sessionDir,
        relocationNote: `The source project lived at ${this.deps.primaryRoot}. In this candidate, that path maps to ${a.dir}.`,
      }),
      this.deps.forkSession({
        sourceSessionFile: run.sessionBranchFile!,
        entryId: run.promptParentEntryId,
        sessionWorkspaceDir: cmp.sessionWorkspaceDir,
        candidateRoot: b.dir,
        candidateSessionDir: b.sessionDir,
        contextText: payload.context || undefined,
      }),
    ]);
    if (!forkA.ok || !forkA.sessionFile) throw new Error("could not fork the reference session");
    if (!forkB.ok || !forkB.sessionFile) throw new Error("could not fork the alternative session");
    a.sessionFile = forkA.sessionFile;
    b.sessionFile = forkB.sessionFile;
  }

  private async forkCoreSessions(cmp: ComparisonState, run: RunRecord): Promise<void> {
    const source = run.sessionBranchFile!;
    const a = cmp.candidates.get("A")!;
    const b = cmp.candidates.get("B")!;
    const destA = join(a.sessionDir, "session.jsonl");
    const destB = join(b.sessionDir, "session.jsonl");
    const throughA = parseStorageSeq(run.settledEntryId);
    if (throughA === null || throughA < 1) throw new Error("the settled session address is missing");
    const throughB = parseStorageSeq(run.promptParentEntryId) ?? 0;
    const [forkA, forkB] = await Promise.all([
      writeForkedSession(source, destA, throughA),
      writeForkedSession(source, destB, throughB),
    ]);
    if (!forkA.ok) throw new Error(`could not fork the reference session: ${forkA.error}`);
    if (!forkB.ok) throw new Error(`could not fork the alternative session: ${forkB.error}`);
    a.sessionFile = destA;
    b.sessionFile = destB;
  }

  private async safePromptPayloadPath(run: { promptPayloadFile: string | null; promptEventsDir?: string | null }): Promise<string | null> {
    const file = run.promptPayloadFile;
    if (!file || file.includes("/") || file.includes("\\")) return null;
    try {
      const dir = run.promptEventsDir ?? this.deps.primaryEventsDir;
      const [canonicalDir, canonicalFile] = await Promise.all([realpath(dir), realpath(join(dir, file))]);
      const rel = relative(canonicalDir, canonicalFile);
      return rel && !rel.startsWith("..") && !isAbsolute(rel) ? canonicalFile : null;
    } catch {
      return null;
    }
  }

  /** Read the prompt payload file (text, images, injected context). */
  private async readPromptPayload(run: { promptPayloadFile: string | null; promptEventsDir?: string | null }): Promise<{ text: string; images: unknown[]; context: string }> {
    const path = await this.safePromptPayloadPath(run);
    if (!path) return { text: "", images: [], context: "" };
    try {
      const info = await stat(path);
      if (info.size > MAX_PROMPT_BYTES) return { text: "", images: [], context: "" };
      const raw = await readFile(path, "utf8");
      const payload = JSON.parse(raw) as { prompt?: unknown; images?: unknown; context?: unknown };
      return {
        text: String(payload.prompt ?? "").slice(0, 64000),
        images: Array.isArray(payload.images) ? payload.images : [],
        context: String(payload.context ?? "").slice(0, 16000),
      };
    } catch {
      return { text: "", images: [], context: "" };
    }
  }

  /** Support directories: home, sessions, events, tmp, cache. */
  private createSupportDirs(cmp: ComparisonState): void {
    for (const cand of cmp.candidates.values()) {
      for (const dir of [cand.supportDir, cand.homeDir, cand.sessionDir, cand.eventsDir, cand.tmpDir, cand.cacheDir]) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
    }
  }

  /** Copy agent-core auth and user skills into each candidate home. */
  private async copyCoreResources(cmp: ComparisonState): Promise<void> {
    const authSrc = join(this.deps.realHome, ".termina", "agent", "auth.json");
    const mcpSrc = join(this.deps.realHome, ".termina", "agent", "mcp.json");
    const agentsSrc = join(this.deps.realHome, ".agents");
    for (const cand of cmp.candidates.values()) {
      const authDstDir = join(cand.homeDir, ".termina", "agent");
      await mkdir(authDstDir, { recursive: true, mode: 0o700 });
      if (existsSync(authSrc)) {
        try {
          const info = await stat(authSrc);
          if (info.isFile() && info.size <= MAX_PI_RESOURCE_BYTES) {
            const target = join(authDstDir, "auth.json");
            await cp(authSrc, target, { force: true });
            await chmod(target, 0o600);
          }
        } catch {
          /* Keep the candidate without this file. */
        }
      }
      if (existsSync(mcpSrc)) {
        try {
          const info = await stat(mcpSrc);
          if (info.isFile() && info.size <= MAX_MCP_JSON_BYTES) {
            const target = join(authDstDir, "mcp.json");
            await cp(mcpSrc, target, { force: true });
            await chmod(target, 0o600);
          }
        } catch {
          /* Keep the candidate without this file. */
        }
      }
      if (existsSync(agentsSrc)) {
        try {
          await this.copyResourceTree(agentsSrc, join(cand.homeDir, ".agents"));
        } catch {
          /* Keep the candidate without user skills. */
        }
      }
    }
  }

  /** Copy the resolved Pi resources into each candidate home. */
  private async copyPiResources(cmp: ComparisonState): Promise<void> {
    const agentSrc = join(this.deps.realHome, ".pi", "agent");
    for (const cand of cmp.candidates.values()) {
      const agentDst = join(cand.homeDir, ".pi", "agent");
      await mkdir(agentDst, { recursive: true, mode: 0o700 });
      for (const name of ["auth.json", "settings.json", "models.json", "models-store.json"]) {
        const src = join(agentSrc, name);
        if (!existsSync(src)) continue;
        try {
          const info = await stat(src);
          if (!info.isFile() || info.size > MAX_PI_RESOURCE_BYTES) continue;
          const target = join(agentDst, name);
          await cp(src, target, { force: true });
          await chmod(target, 0o600);
        } catch {
          /* Keep the candidate without this file. */
        }
      }
      for (const name of ["skills", "prompts", "themes", "extensions"]) {
        const src = join(agentSrc, name);
        if (!existsSync(src)) continue;
        try {
          await this.copyResourceTree(src, join(agentDst, name));
        } catch {
          /* Keep the candidate without this resource. */
        }
      }
    }
  }

  /** Copy a Pi resource tree with a byte budget. */
  private async copyResourceTree(src: string, dst: string): Promise<void> {
    if ((await dirBytes(src)) > MAX_PI_RESOURCE_BYTES) return;
    await cp(src, dst, { recursive: true, force: true });
  }

  /** The startup control files: what the bridge does on session start. */
  private async writeStartupControls(cmp: ComparisonState, run: RunRecord, challenge: boolean): Promise<void> {
    const payload = await this.readPromptPayload(run);
    const a = cmp.candidates.get("A")!;
    const b = cmp.candidates.get("B")!;
    await this.writeControl(a, { opId: randomUUID(), action: "none" });
    // A challenge replays the original task with one action; a
    // plain fork prefills it as editable text.
    if (payload.images.length > 0 || challenge) {
      // Structured prompt: replay the original content blocks unchanged.
      await this.writeControl(b, {
        opId: randomUUID(),
        action: "structured",
        content: [{ type: "text", text: payload.text }, ...payload.images],
      });
    } else {
      // Text-only prompt: prefilled and editable in the Pi editor.
      await this.writeControl(b, { opId: randomUUID(), action: "prefill", text: payload.text });
    }
  }

  private async writeControl(cand: CandidateState, control: Record<string, unknown>): Promise<void> {
    const target = join(cand.eventsDir, "startup-control.json");
    const temporary = `${target}.tmp-${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(control), { mode: 0o600 });
    await rename(temporary, target);
  }

  /** Launch both candidate Pi terminals inside their sandboxes. */
  private async launchCandidates(cmp: ComparisonState, run: RunRecord): Promise<void> {
    for (const cand of cmp.candidates.values()) {
      // Candidate B replays with the captured model and thinking level.
      // A bare model id is ambiguous across providers; pass only the
      // provider-qualified form.
      const extra: string[] = [];
      if (cand.label === "B" && run.model && run.model.includes("/")) extra.push("--model", run.model);
      if (cand.label === "B" && run.thinkingLevel) extra.push("--thinking", run.thinkingLevel);
      // The moment chain of each candidate seeds from its own head: A is
      // the settled state, B is the run start.
      const head = cand.label === "A" ? run.settledStateId : run.startStateId;
      await this.launchCandidate(cmp, cand, extra, head);
    }
  }

  private sessionHasContent(path: string | null): boolean {
    if (!path) return false;
    try {
      return existsSync(path) && statSync(path).size > 0;
    } catch {
      return false;
    }
  }

  /** The sandboxed launch command for one candidate. */
  private candidateLaunch(
    cmp: ComparisonState,
    cand: CandidateState,
    extraPiArgs: string[],
  ): { cmd: string; args: string[]; env: Record<string, string | undefined> } {
    // A moment comparison has a single candidate: no sibling to deny (the
    // worlds-root deny covers its tree anyway).
    const sibling = cmp.candidates.get(cand.label === "A" ? "B" : "A");
    const core = cmp.engine === "core";
    const paths: SandboxPaths = {
      candidateRoot: cand.dir,
      candidateSupport: cand.supportDir,
      siblingDir: sibling?.dir ?? join(this.deps.worldsRoot, "__none__"),
      templateDir: cmp.templateDir,
      worldsRoot: this.deps.worldsRoot,
      primaryRoot: cmp.primaryRoot,
      sourceObjectsDir: join(cmp.sourceGitDir, "objects"),
      realHome: this.deps.realHome,
      storeDir: join(this.deps.userData, "worldlines"),
      primaryEventsDir: this.deps.primaryEventsDir,
      userData: this.deps.userData,
      appReadPaths: this.deps.appReadPaths(),
      agentHomeDir: join(cand.homeDir, core ? ".termina" : ".pi", "agent"),
      denyNetwork: false,
    };
    cand.profilePath = writeSandboxProfile(cand.supportDir, paths);
    if (core) {
      const model = cmp.model && cmp.model.includes("/") ? cmp.model : null;
      const cut = model ? model.indexOf("/") : -1;
      const env: Record<string, string | undefined> = {
        ...this.deps.baseEnv,
        HOME: cand.homeDir,
        TMPDIR: cand.tmpDir,
        TERMINA_EVENTS_DIR: cand.eventsDir,
        ELECTRON_RUN_AS_NODE: "1",
        TERMINA_CORE_SESSION_FILE: cand.sessionFile ?? undefined,
        TERMINA_CORE_APPROVE: "all",
        ...(this.sessionHasContent(cand.sessionFile) ? { TERMINA_CORE_RESUME: "1" } : {}),
        ...(model && cut > 0
          ? { TERMINA_CORE_PROVIDER: model.slice(0, cut), TERMINA_CORE_MODEL: model.slice(cut + 1) }
          : {}),
        ...(cmp.inheritTrust ? { TERMINA_INHERIT_TRUST: "1" } : {}),
      };
      return {
        cmd: "sandbox-exec",
        args: [
          "-f",
          cand.profilePath,
          "/bin/zsh",
          "-c",
          `${sandboxShellPreamble()} exec ${quoteShellArg(this.deps.electronExecPath)} ${quoteShellArg(this.deps.agentCorePath)}${thinkingStartupArgs(this.deps.showThinking()).map((arg) => ` ${quoteShellArg(arg)}`).join("")}`,
        ],
        env,
      };
    }
    const piArgs = ["--session", cand.sessionFile!, "-e", this.deps.bridgePath, ...extraPiArgs];
    return {
      cmd: "sandbox-exec",
      args: ["-f", cand.profilePath, "/bin/zsh", "-c", `${sandboxShellPreamble()} exec ${quoteShellArg(this.deps.piBin)} ${piArgs.map(quoteShellArg).join(" ")}`],
      env: {
        ...this.deps.baseEnv,
        HOME: cand.homeDir,
        TMPDIR: cand.tmpDir,
        TERMINA_EVENTS_DIR: cand.eventsDir,
        ...(cmp.inheritTrust ? { TERMINA_INHERIT_TRUST: "1" } : {}),
      },
    };
  }

  private updateManifest(cmp: ComparisonState, cand: CandidateState): void {
    try {
      const raw = readFileSync(join(cmp.dir, "manifest.json"), "utf8");
      const manifest = JSON.parse(raw) as { candidates?: Record<string, unknown> };
      manifest.candidates = manifest.candidates ?? {};
      manifest.candidates[cand.label] = { pid: cand.pid, lstart: cand.lstart, paths: [cand.dir, cand.supportDir] };
      writeFileSync(join(cmp.dir, "manifest.json"), JSON.stringify(manifest), "utf8");
    } catch {
      /* The manifest update is optional. */
    }
  }

  /** The comparison and candidate behind one terminal, or null. */
  promotionTarget(comparisonId: string, label: "A" | "B"): {
    root: string;
    sessionFile: string | null;
    terminalId: string | null;
    eventsDir: string;
    sourceRunId: string;
    state: WorldlineState;
  } | null {
    const cmp = this.comparisons.get(comparisonId);
    const cand = cmp?.candidates.get(label);
    if (!cmp || !cand) return null;
    return {
      root: cand.dir,
      sessionFile: cand.sessionFile,
      terminalId: cand.terminalId,
      eventsDir: cand.eventsDir,
      sourceRunId: cmp.sourceRunId,
      state: cand.state,
    };
  }

  /** The pair enters the promoting lifecycle state. */
  markPromoting(comparisonId: string, label: "A" | "B"): void {
    const cmp = this.comparisons.get(comparisonId);
    const cand = cmp?.candidates.get(label);
    if (!cmp || !cand) return;
    cand.state = "promoting";
    cand.version++;
    this.pushUpdate(cmp, cand);
  }

  private isPromoting(cmp: ComparisonState): boolean {
    for (const cand of cmp.candidates.values()) {
      if (cand.state === "promoting") return true;
    }
    return false;
  }

  /** Promotion finished: tear the pair down ("promoted") or release. */
  async finishPromotion(comparisonId: string, ok: boolean, error: string | null): Promise<void> {
    if (ok) {
      await this.teardown(comparisonId, "promoted", null);
    } else {
      // A rejected promotion leaves the pair usable (promote the other
      // candidate, verify, or discard); the error shows on the card.
      const cmp = this.comparisons.get(comparisonId);
      if (!cmp) return;
      for (const cand of cmp.candidates.values()) {
        if (cand.state !== "promoting") continue;
        cand.state = "ready";
        cand.error = error;
        cand.version++;
        this.pushUpdate(cmp, cand);
      }
    }
  }

  // ---------------------------------------------------------- evidence ----

  markEvidenceStale(comparisonId: string | undefined): EvidenceSummary | null {
    if (!comparisonId) return null;
    const summary = this.evidenceByComparison.get(comparisonId);
    if (!summary || summary.stale) return null;
    summary.stale = true;
    this.deps.onEvidenceUpdate(summary);
    return summary;
  }

  holdsEvidenceState(stateId: string): boolean {
    for (const summary of this.evidenceByComparison.values()) {
      for (const records of Object.values(summary.byCandidate)) {
        if (records.some((record) => record.stateId === stateId)) return true;
      }
    }
    return false;
  }

  measureEvidence(comparisonId: string): Promise<{ ok: boolean; error?: string }> {
    const run = this.evidenceQueue.then(() => this.runEvidence(comparisonId));
    this.evidenceQueue = run.catch(() => undefined);
    return run;
  }

  async drainEvidence(): Promise<void> {
    await this.evidenceQueue.catch(() => undefined);
  }

  private async dropEvidence(comparisonId: string): Promise<void> {
    const summary = this.evidenceByComparison.get(comparisonId);
    this.evidenceByComparison.delete(comparisonId);
    if (summary) await this.releaseSummaryStates(summary);
  }

  private async releaseSummaryStates(summary: EvidenceSummary): Promise<void> {
    const states = new Set<string>();
    for (const records of Object.values(summary.byCandidate)) {
      for (const record of records) states.add(record.stateId);
    }
    for (const stateId of states) await this.deps.releaseState(stateId);
  }

  private async runEvidence(comparisonId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.comparisons.has(comparisonId)) return { ok: false, error: "comparison not found" };
    const store = await this.deps.getStore();
    const cmp = this.comparisons.get(comparisonId);
    const baseStateId = this.runOf(cmp?.sourceRunId ?? "")?.startStateId ?? null;
    if (!cmp || !store || !baseStateId) return { ok: false, error: !cmp ? "comparison not found" : "recording is not available" };
    const targets = new Map<"A" | "B", NonNullable<ReturnType<WorldlineManager["evidenceTarget"]>>>();
    const generations = new Map<"A" | "B", number>();
    const leases: Array<{ workspaceId: string; requesterId: string }> = [];
    const releaseLeases = (): void => {
      for (const lease of leases) this.deps.releaseWriteLease(lease.workspaceId, lease.requesterId);
    };
    for (const label of ["A", "B"] as const) {
      const target = this.evidenceTarget(comparisonId, label);
      if (!target) {
        releaseLeases();
        return { ok: false, error: "candidate not found" };
      }
      if ((target.terminalId && this.deps.terminalBusy(target.terminalId)) || target.state === "running" || target.state === "verifying") {
        releaseLeases();
        return { ok: false, error: `candidate ${label} is active` };
      }
      const workspace = await this.deps.workspaceAt(target.root);
      if (!workspace) {
        releaseLeases();
        return { ok: false, error: "candidate workspace not found" };
      }
      const requesterId = `evidence:${comparisonId}:${label}`;
      const lease = await this.deps.acquireWriteLease(workspace.id, requesterId, 2000);
      if (!lease.ok) {
        releaseLeases();
        return { ok: false, error: lease.error ?? "a candidate workspace is busy" };
      }
      leases.push({ workspaceId: workspace.id, requesterId });
      targets.set(label, target);
      generations.set(label, workspace.generation);
    }
    let tc: { command: string; args: string[]; label: string } | null;
    let bm: { command: string[]; unit: string; direction: "lower" | "higher"; samples: number; thresholdPct: number } | null;
    let evidenceHome: string | null = null;
    try {
      tc = await this.deps.detectTestFromState(store, baseStateId);
      bm = await this.deps.benchmarkConfigFrom(store, baseStateId);
      evidenceHome = await this.deps.createEvidenceHome();
    } catch (err) {
      releaseLeases();
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!evidenceHome) {
      releaseLeases();
      return { ok: false, error: "evidence home is unavailable" };
    }
    const evidenceRoot = evidenceHome;
    const capturedStates = new Set<string>();
    const capturedTrees = new Map<string, string>();
    const deps: EvidenceDeps = {
      store,
      baseStateId,
      primaryRoot: this.deps.primaryRoot,
      mineFiles: new Set(this.deps.mineFiles()),
      captureHead: async (root, gitDir, parent) => {
        const state = await this.deps.captureHead(root, gitDir, parent);
        capturedStates.add(state.commit);
        capturedTrees.set(state.commit, state.tree);
        return state;
      },
      runSandboxed: (cand, command, timeoutMs) => this.deps.runSandboxedEvidence(cand, command, timeoutMs),
      baseTestCommand: () => tc,
      benchmarkConfig: () => bm,
      sourceFilesOf: (root) => this.deps.sourceFilesOf(root),
    };
    const engine = new EvidenceEngine(deps);
    const byCandidate: Record<"A" | "B", EvidenceRecord[]> = { A: [], B: [] };
    const mineReason: Record<"A" | "B", string | null> = { A: null, B: null };
    const retainedStates = new Set<string>();
    const expectedVersions = new Map<"A" | "B", number>();
    const cands: Record<"A" | "B", { root: string; profilePath: string; homeDir: string; tmpDir: string; shell: string; eventsDir: string; terminalId: string | null }> = {
      A: { root: targets.get("A")!.root, profilePath: targets.get("A")!.profilePath, homeDir: evidenceRoot, tmpDir: join(evidenceRoot, "tmp", "A"), shell: "", eventsDir: targets.get("A")!.eventsDir, terminalId: targets.get("A")!.terminalId },
      B: { root: targets.get("B")!.root, profilePath: targets.get("B")!.profilePath, homeDir: evidenceRoot, tmpDir: join(evidenceRoot, "tmp", "B"), shell: "", eventsDir: targets.get("B")!.eventsDir, terminalId: targets.get("B")!.terminalId },
    };
    let result: { ok: boolean; error?: string };
    try {
      result = { ok: true };
      for (const label of ["A", "B"] as const) {
        const target = targets.get(label)!;
        byCandidate[label] = await engine.measure(label, cands[label]);
        const finalState = await deps.captureHead(target.root, join(target.root, ".git"), null);
        const workspace = await this.deps.workspaceAt(target.root);
        const current = this.evidenceVersion(comparisonId, label);
        if (!workspace || workspace.generation !== generations.get(label) || !current || current.version !== target.version) {
          result = { ok: false, error: `candidate ${label} changed during evidence` };
          break;
        }
        const head = byCandidate[label].find((record) => record.kind === "verify") ?? byCandidate[label][0];
        if (head && capturedTrees.get(head.stateId) !== finalState.tree) {
          result = { ok: false, error: `candidate ${label} changed during evidence` };
          break;
        }
        if (head) {
          retainedStates.add(head.stateId);
          await this.setCandidateHead(comparisonId, label, head.stateId);
          expectedVersions.set(label, this.evidenceVersion(comparisonId, label)?.version ?? target.version);
          mineReason[label] = await mineChangeReason(store, baseStateId, head.stateId, deps.primaryRoot, deps.mineFiles, (p) => realpath(p));
        } else {
          expectedVersions.set(label, target.version);
        }
      }
      if (result.ok) {
        const benches = await engine.measureBenchmarks(cands, {
          A: byCandidate.A.find((r) => r.kind === "verify")?.stateId ?? byCandidate.A[0]?.stateId ?? "",
          B: byCandidate.B.find((r) => r.kind === "verify")?.stateId ?? byCandidate.B[0]?.stateId ?? "",
        });
        byCandidate.A.push(benches.A);
        byCandidate.B.push(benches.B);
      }
      if (result.ok) {
        for (const label of ["A", "B"] as const) {
          const target = targets.get(label)!;
          const workspace = await this.deps.workspaceAt(target.root);
          const current = this.evidenceVersion(comparisonId, label);
          if (!workspace || workspace.generation !== generations.get(label) || !current || current.version !== expectedVersions.get(label)) {
            result = { ok: false, error: `candidate ${label} changed during evidence` };
            break;
          }
        }
      }
      if (!result.ok) return result;
      const summary: EvidenceSummary = {
        comparisonId,
        ts: Date.now(),
        byCandidate,
        profiles: rankProfiles(byCandidate, mineReason, bm?.thresholdPct ?? 0.05),
        error: null,
        stale: false,
      };
      const previous = this.evidenceByComparison.get(comparisonId);
      this.evidenceByComparison.set(comparisonId, summary);
      if (previous) await this.releaseSummaryStates(previous);
      this.deps.onEvidenceUpdate(summary);
      return result;
    } finally {
      for (const stateId of capturedStates) {
        if (!retainedStates.has(stateId)) await this.deps.releaseState(stateId);
      }
      releaseLeases();
      if (evidenceHome) await rm(evidenceHome, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------- promote ----

  async promote(comparisonId: string, label: "A" | "B", force = false): Promise<{ ok: boolean; error?: string; confirm?: string; terminalId?: string }> {
    const target = this.promotionTarget(comparisonId, label);
    if (!target) return { ok: false, error: "candidate not found" };
    if (!target.sessionFile) return { ok: false, error: "the candidate has no session" };
    if (!["ready", "running", "settled"].includes(target.state)) {
      return { ok: false, error: `cannot promote from state ${target.state}` };
    }
    if (target.terminalId && this.deps.terminalBusy(target.terminalId)) return { ok: false, error: "the candidate agent is busy" };
    if (target.terminalId && this.deps.terminalVerifying(target.terminalId)) {
      return { ok: false, error: "the candidate is verifying" };
    }
    const store = await this.deps.getStore();
    if (!store) return { ok: false, error: "recording is not available" };
    const primary = await this.deps.workspaceAt(this.deps.primaryRoot);
    if (!primary) return { ok: false, error: "no primary workspace" };
    const baseState = this.runOf(target.sourceRunId)?.startStateId ?? null;
    if (!baseState) return { ok: false, error: "the source run base is missing" };
    const candWs = await this.deps.workspaceAt(target.root);
    const candGen = candWs?.generation ?? 0;

    const opId = `promote-${randomUUID()}`;
    const requester = `promote:${opId}`;
    const journalDir = join(this.deps.worldsRoot, "promotion-journal", opId);
    const journal: Record<string, unknown> = {
      opId,
      comparisonId,
      label,
      stateR: baseState,
      primaryRoot: this.deps.primaryRoot,
      phase: "prepared",
      createdAt: Date.now(),
      paths: [],
      stagedSession: null,
      installedSession: null,
    };

    const leaseP = await this.deps.acquireWriteLease(primary.id, requester, 12000);
    if (!leaseP.ok) return { ok: false, error: leaseP.error ?? "the primary workspace is busy" };
    let candLease = true;
    if (candWs) {
      const l = await this.deps.acquireWriteLease(candWs.id, requester, 8000);
      candLease = l.ok;
    }
    if (!candLease) {
      this.deps.releaseWriteLease(primary.id, requester);
      return { ok: false, error: "the candidate workspace is busy" };
    }
    const releaseLeases = (): void => {
      this.deps.releaseWriteLease(primary.id, requester);
      if (candWs) this.deps.releaseWriteLease(candWs.id, requester);
    };
    const fail = async (message: string): Promise<{ ok: false; error: string }> => {
      releaseLeases();
      await rm(journalDir, { recursive: true, force: true }).catch(() => undefined);
      await this.finishPromotion(comparisonId, false, message);
      return { ok: false, error: message };
    };
    const askConfirm = async (message: string): Promise<{ ok: false; confirm: string }> => {
      releaseLeases();
      await rm(journalDir, { recursive: true, force: true }).catch(() => undefined);
      await this.finishPromotion(comparisonId, false, null);
      return { ok: false, confirm: message };
    };

    try {
      const flush = await this.deps.flushDirtyModels(requester, primary.id, 8000);
      if (!flush.ok) return fail("could not save editor changes");
      this.markPromoting(comparisonId, label);
      const candGitDir = await gitCommonDir(target.root);
      const [wState, pState] = await Promise.all([
        store.capture(await gitHead(target.root), baseState, {}, {}, { root: target.root, gitDir: candGitDir ?? target.root }),
        store.capture(await gitHead(this.deps.primaryRoot), primary.lastStateCommit ?? null),
      ]);
      await this.deps.onCandidateState(this.deps.primaryRoot, pState.commit);
      const primaryNow = await this.deps.workspaceAt(this.deps.primaryRoot);
      if (!primaryNow || primaryNow.generation !== leaseP.generation) return fail("the primary changed during promotion preflight");
      if (candWs && (await this.deps.workspaceAt(target.root))?.generation !== candGen) return fail("the candidate changed during promotion preflight");
      const top = await gitTopLevel(this.deps.primaryRoot);
      if (!top || !captureRootInRepo(await this.deps.canonicalPath(store.sourceRoot), await this.deps.canonicalPath(top))) {
        return fail("the source repository identity changed");
      }

      const changed = await store.diffTree(baseState, wState.commit);
      for (const c of changed) {
        const abs = join(this.deps.primaryRoot, c.relPath);
        if (this.deps.mineFiles().has(await this.deps.canonicalPath(abs))) {
          return fail(`the candidate changes a file you own: ${c.relPath}`);
        }
        const link = await store.symlinkTarget(wState.commit, c.relPath);
        if (link) {
          try {
            if (this.deps.mineFiles().has(realpathSync(join(dirname(abs), link)))) {
              return fail(`the candidate aliases a file you own through a symlink: ${c.relPath}`);
            }
          } catch {
            /* A broken symlink cannot alias a Mine path. */
          }
        }
      }

      const merge = await store.merge3(wState.commit, pState.commit);
      if (!merge.ok || !merge.tree) {
        const reason = merge.reason ?? `the merge conflicts on: ${merge.conflicts.join(", ")}`;
        return fail(reason);
      }
      if (!force) {
        const summary = this.evidenceByComparison.get(comparisonId);
        const recs = summary?.byCandidate[label] ?? [];
        const verify = recs.find((r) => r.kind === "verify");
        const evidenceOk = verify?.status === "pass" && summary?.stale !== true;
        const ignored = await this.ignoredWrites(comparisonId, label);
        if (!evidenceOk) {
          const why = !verify ? "no evidence has been computed for this candidate" : summary?.stale ? "the evidence is stale (the candidate ran again)" : `the evidence is ${verify?.status}`;
          return askConfirm(`promote without current passing evidence? (${why})`);
        }
        if ((ignored?.count ?? 0) > 0) {
          return askConfirm(`${ignored!.count} ignored/generated file(s) (${((ignored!.bytes ?? 0) / 1024).toFixed(0)} kB) will be excluded from the promotion`);
        }
      }

      const mergedDir = join(journalDir, "merged");
      await store.materialize(merge.tree, mergedDir);
      const pPaths = await store.treePaths(pState.commit);
      const mergedPaths = await store.treePaths(merge.tree);
      const beforeDir = join(journalDir, "before");
      const paths: Array<{ rel: string; kind: "write" | "delete"; beforeHash: string; afterHash: string; beforeExists: boolean }> = [];
      for (const rel of [...mergedPaths].sort()) {
        const abs = join(this.deps.primaryRoot, rel);
        const beforeExists = existsSync(abs);
        const before = beforeExists ? await readFile(abs) : Buffer.alloc(0);
        const after = await readFile(join(mergedDir, rel));
        paths.push({ rel, kind: "write", beforeHash: sha256Hex(before), afterHash: sha256Hex(after), beforeExists });
        if (beforeExists) {
          const dest = join(beforeDir, rel);
          await mkdir(dirname(dest), { recursive: true });
          await writeFile(dest, before);
        }
      }
      for (const rel of [...pPaths].filter((p) => !mergedPaths.has(p)).sort()) {
        const abs = join(this.deps.primaryRoot, rel);
        const beforeExists = existsSync(abs);
        const before = beforeExists ? await readFile(abs) : Buffer.alloc(0);
        paths.push({ rel, kind: "delete", beforeHash: sha256Hex(before), afterHash: sha256Hex(Buffer.alloc(0)), beforeExists });
        if (beforeExists) {
          const dest = join(beforeDir, rel);
          await mkdir(dirname(dest), { recursive: true });
          await writeFile(dest, before);
        }
      }
      if (paths.length > 2000) throw new Error("the promotion touches too many paths");
      journal.paths = paths;

      const sessionDir = join(journalDir, "session");
      const comparison = this.comparisons.get(comparisonId);
      const promoteEngine = comparison?.engine === "core" ? "core" : "pi";
      if (promoteEngine === "core") {
        if (!target.sessionFile) throw new Error("the candidate has no session");
        mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
        const staged = join(sessionDir, "session.jsonl");
        await writeFile(staged, await readFile(target.sessionFile), { mode: 0o600 });
        await copySessionImageFiles(target.sessionFile, staged);
        journal.stagedSession = staged;
      } else {
        const fork = await this.deps.forkSession({
          sourceSessionFile: target.sessionFile,
          entryId: null,
          sessionWorkspaceDir: sessionDir,
          candidateRoot: this.deps.primaryRoot,
          candidateSessionDir: sessionDir,
          relocationNote: `The candidate project lived at ${target.root}. In this promoted session, that path maps to ${this.deps.primaryRoot}.`,
        });
        if (!fork.sessionFile) throw new Error("the promoted session fork produced no file");
        journal.stagedSession = fork.sessionFile;
      }
      writePromotionJournal(journalDir, journal);

      for (const p of paths) {
        const abs = join(this.deps.primaryRoot, p.rel);
        const now = existsSync(abs) ? await readFile(abs) : Buffer.alloc(0);
        if (sha256Hex(now) !== p.beforeHash) return fail(`the primary changed at ${p.rel} during promotion`);
      }
      if ((await this.deps.workspaceAt(this.deps.primaryRoot))?.generation !== leaseP.generation) {
        return fail("the primary changed during promotion apply");
      }

      this.deps.onPromotionApply(paths.map((p) => p.rel));
      try {
        for (const p of paths) {
          const abs = join(this.deps.primaryRoot, p.rel);
          if (p.kind === "delete") {
            await rm(abs, { force: true });
          } else {
            await mkdir(dirname(abs), { recursive: true });
            await rename(join(mergedDir, p.rel), abs);
          }
        }
      } finally {
        this.deps.onPromotionApply(null);
      }
      journal.phase = "applied";
      writePromotionJournal(journalDir, journal);

      const installDir = this.deps.primarySessionDir(this.deps.primaryRoot);
      await mkdir(installDir, { recursive: true });
      const sessionName = `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID()}.jsonl`;
      const installed = join(installDir, sessionName);
      const tmp = join(installDir, `.${sessionName}.tmp`);
      await writeFile(tmp, await readFile(String(journal.stagedSession)));
      await rename(tmp, installed);
      journal.installedSession = installed;
      journal.phase = "done";
      writePromotionJournal(journalDir, journal);

      const opened = await this.deps.installPromoted({
        paths,
        beforeDir,
        installedSession: installed,
        primaryRoot: this.deps.primaryRoot,
        primaryWorkspaceId: primary.id,
        comparisonId,
        label,
        engine: promoteEngine,
      });
      await this.finishPromotion(comparisonId, true, null);
      releaseLeases();
      await rm(journalDir, { recursive: true, force: true });
      return { ok: true, terminalId: opened.terminalId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (String(journal.phase) === "done") {
        // The primary already has the merged bytes and the session file.
        releaseLeases();
        await this.finishPromotion(comparisonId, true, null);
        await rm(journalDir, { recursive: true, force: true }).catch(() => undefined);
        return { ok: false, error: `the source was promoted, but the new session did not open: ${message}` };
      }
      await rollbackPromotion(journalDir, journal, this.deps.primaryRoot);
      if (journal.installedSession) await rm(String(journal.installedSession), { force: true });
      releaseLeases();
      await this.finishPromotion(comparisonId, false, message);
      return { ok: false, error: message };
    }
  }

  // ------------------------------------------------------- fork any moment ----

  /**
   * Fork one candidate from a timeline moment (WORLDLINES §6): the exact
   * captured source state and the session branched at the dot's entry.
   * A nested moment uses the candidate session and the root run start as
   * the promotion lineage base.
   */
  async forkPoint(terminalId: string, moment: TimelineEvent | null): Promise<{ ok: boolean; comparisonId?: string; error?: string }> {
    await this.ready;
    if (!moment) return { ok: false, error: "timeline moment not found" };
    if (!moment.stateId || !moment.entryId || moment.evicted) {
      return { ok: false, error: moment.evicted ? "this moment's source state was evicted" : "this moment is not forkable" };
    }
    const nested = this.candidateContextOf(terminalId);
    const covering = this.runCovering(terminalId, moment.ts);
    const rootRun = nested ? this.runOf(nested.sourceRunId) : covering;
    const sessionFile = nested?.sessionFile ?? covering?.sessionFile;
    if (!rootRun) return { ok: false, error: "the source run is unavailable" };
    if (!sessionFile) return { ok: false, error: "the run session is unavailable" };
    const opts = {
      terminalId,
      stateId: moment.stateId,
      entryId: moment.entryId,
      model: moment.model ?? rootRun.model,
      thinkingLevel: rootRun.thinkingLevel,
      sessionFile,
      sourceRunId: rootRun.id,
      baseStateId: rootRun.startStateId,
      inheritTrust: rootRun.trusted === true,
    };
    if (this.liveWorldlineCount() + 1 > 3) return { ok: false, error: "the live worldline budget is exhausted" };
    const store = await this.deps.getStore();
    if (!store) return { ok: false, error: "recording is not available" };
    const id = `cmp-${++this.seq}`;
    const dir = join(this.deps.worldsRoot, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, MARKER), randomUUID(), "utf8");
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ id, sourceRunId: opts.sourceRunId, createdAt: Date.now(), candidates: {} }),
      "utf8",
    );
    const cmp: ComparisonState = {
      id,
      dir,
      templateDir: join(dir, "template"),
      sessionWorkspaceDir: join(dir, "session-workspace"),
      sourceRunId: opts.sourceRunId,
      sourceGitDir: store.sourceGitDir,
      primaryRoot: this.deps.primaryRoot,
      baseCommit: null,
      baseStateId: opts.baseStateId ?? null,
      inheritTrust: opts.inheritTrust ?? false,
      model: opts.model,
      thinkingLevel: opts.thinkingLevel,
      engine: runEngine(rootRun),
      createdAt: Date.now(),
      candidates: new Map(),
      phase: "creating",
      error: null,
      readyTimer: null,
    };
    const cand: CandidateState = {
      label: "A",
      role: "moment",
      dir: join(dir, "A"),
      supportDir: join(dir, "A-support"),
      homeDir: join(dir, "A-support", "home"),
      sessionDir: join(dir, "A-support", "sessions"),
      eventsDir: join(dir, "A-support", "events"),
      tmpDir: join(dir, "A-support", "tmp"),
      cacheDir: join(dir, "A-support", "cache"),
      profilePath: join(dir, "A-support", "sandbox.sb"),
      sessionFile: null,
      comparisonBaseStateId: null,
      promotionBaseStateId: null,
      headStateId: null,
      headCommit: Promise.resolve(),
      terminalId: null,
      pid: null,
      lstart: null,
      state: "creating",
      version: 1,
      error: null,
    };
    cmp.candidates.set("A", cand);
    cand.comparisonBaseStateId = cmp.baseStateId;
    cand.promotionBaseStateId = cmp.baseStateId;
    cand.headStateId = opts.stateId;
    this.comparisons.set(id, cmp);
    try {
      // The template IS the moment state: build it, then clone one candidate.
      mkdirSync(cmp.templateDir, { recursive: true });
      await store.template({
        stateId: opts.stateId,
        targetDir: cmp.templateDir,
        sourceObjectsDir: join(cmp.sourceGitDir, "objects"),
      });
      cmp.baseCommit = await gitHead(cmp.templateDir);
      for (const name of RUNTIME_ALLOWLIST) {
        const src = join(this.deps.primaryRoot, name);
        if (!existsSync(src)) continue;
        await this.cloneTree(src, join(cmp.templateDir, name));
      }
      await this.cloneTree(cmp.templateDir, cand.dir);
      // The session branches at the dot's entry: later entries stay out.
      this.createSupportDirs(cmp);
      if (cmp.engine === "core") {
        const through = parseStorageSeq(opts.entryId);
        if (through === null) throw new Error("this moment has no session address");
        const dest = join(cand.sessionDir, "session.jsonl");
        const fork = await writeForkedSession(opts.sessionFile, dest, through);
        if (!fork.ok) throw new Error(`could not fork the moment session: ${fork.error}`);
        cand.sessionFile = dest;
        await this.copyCoreResources(cmp);
      } else {
        const fork = await this.deps.forkSession({
          sourceSessionFile: opts.sessionFile,
          entryId: opts.entryId,
          sessionWorkspaceDir: cmp.sessionWorkspaceDir,
          candidateRoot: cand.dir,
          candidateSessionDir: cand.sessionDir,
          relocationNote: `The source project lived at ${this.deps.primaryRoot}. In this candidate, that path maps to ${cand.dir}.`,
        });
        if (!fork.ok || !fork.sessionFile) throw new Error("could not fork the moment session");
        cand.sessionFile = fork.sessionFile;
        await this.copyPiResources(cmp);
      }
      // A moment candidate starts with no prompt: the user continues it.
      // Replay the captured model and thinking level of that moment.
      await this.writeControl(cand, { opId: randomUUID(), action: "none" });
      const extra: string[] = [];
      if (opts.model && opts.model.includes("/")) extra.push("--model", opts.model);
      if (opts.thinkingLevel) extra.push("--thinking", opts.thinkingLevel);
      await this.launchCandidate(cmp, cand, extra, opts.stateId);
      cmp.phase = "running";
      cmp.readyTimer = setTimeout(() => {
        if (cmp.phase !== "running") return;
        void this.teardown(cmp.id, "error", "the candidate did not become ready in time");
      }, READY_TIMEOUT_MS);
      return { ok: true, comparisonId: id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[worldlines] fork-point pipeline failed: ${(err as Error).stack ?? message}`);
      await this.teardown(cmp.id, "error", message);
      return { ok: false, error: message };
    }
  }

  /** Launch one candidate inside its sandbox (A or a moment candidate). */
  private async launchCandidate(cmp: ComparisonState, cand: CandidateState, extraPiArgs: string[], headStateId: string | null): Promise<void> {
    const { cmd, args, env } = this.candidateLaunch(cmp, cand, extraPiArgs);
    cand.headStateId = headStateId ?? cand.headStateId ?? cmp.baseStateId;
    const workspaceId = this.deps.createCandidateWorkspace(cand.dir, cand.headStateId, cmp.id);
    const { terminalId, pid } = await this.deps.createCandidate({
      root: cand.dir,
      workspaceId,
      engine: cmp.engine,
      launch: { cmd, args, env },
    });
    cand.terminalId = terminalId;
    cand.pid = pid;
    cand.lstart = await readProcessStart(pid);
    this.terminalToComparison.set(terminalId, { comparisonId: cmp.id, label: cand.label });
    this.updateManifest(cmp, cand);
    this.pushUpdate(cmp, cand);
  }

  // ------------------------------------------------------- session ready ----

  /** The bridge consumed its startup control. */
  onSessionReady(terminalId: string, ok: boolean, error: string | null): void {
    const hit = this.terminalToComparison.get(terminalId);
    if (!hit) return;
    const cmp = this.comparisons.get(hit.comparisonId);
    const cand = cmp?.candidates.get(hit.label);
    if (!cmp || !cand) return;
    if (!ok) {
      void this.teardown(cmp.id, "error", `the candidate session failed to start: ${error ?? "unknown"}`);
      return;
    }
    cand.state = "ready";
    cand.version++;
    this.pushUpdate(cmp, cand);
    // Both ready: the pair is complete.
    if ([...cmp.candidates.values()].every((c) => c.state === "ready")) {
      if (cmp.readyTimer) clearTimeout(cmp.readyTimer);
      void rm(cmp.templateDir, { recursive: true, force: true }).catch(() => undefined);
      cmp.phase = "running";
    }
  }

  /** A candidate terminal exited. */
  terminalExited(terminalId: string): void {
    const hit = this.terminalToComparison.get(terminalId);
    if (!hit) return;
    const cmp = this.comparisons.get(hit.comparisonId);
    const cand = cmp?.candidates.get(hit.label);
    if (!cmp || !cand) return;
    if (cand.state === "ready" || cand.state === "running") {
      cand.state = "settled";
      cand.version++;
      this.pushUpdate(cmp, cand);
    }
  }

  // ------------------------------------------------------------- control ----

  /** Abort pair creation; all-or-nothing cleanup. */
  async cancel(comparisonId: string): Promise<{ ok: boolean; error?: string }> {
    const cmp = this.comparisons.get(comparisonId);
    if (!cmp) return { ok: false, error: "comparison not found" };
    if (this.isPromoting(cmp)) return { ok: false, error: "a promotion is in progress" };
    await this.teardown(comparisonId, "cancelled", null);
    return { ok: true };
  }

  /** Discard a live comparison and remove every app-owned resource. */
  async discard(comparisonId: string): Promise<{ ok: boolean; error?: string }> {
    const cmp = this.comparisons.get(comparisonId);
    if (!cmp) return { ok: false, error: "comparison not found" };
    if (this.isPromoting(cmp)) return { ok: false, error: "a promotion is in progress" };
    await this.teardown(comparisonId, "discarded", null);
    return { ok: true };
  }

  /** Open a new terminal for an existing candidate (reopen). */
  async openTerminal(comparisonId: string, label: "A" | "B"): Promise<{ ok: boolean; error?: string; terminalId?: string }> {
    const cmp = this.comparisons.get(comparisonId);
    const cand = cmp?.candidates.get(label);
    if (!cmp || !cand) return { ok: false, error: "candidate not found" };
    if (!cand.sessionFile) return { ok: false, error: "the candidate has no session" };
    const { cmd, args, env } = this.candidateLaunch(cmp, cand, []);
    const workspaceId = this.deps.createCandidateWorkspace(cand.dir, cand.headStateId ?? cmp.baseStateId ?? null, cmp.id);
    try {
      const { terminalId, pid } = await this.deps.createCandidate({
        root: cand.dir,
        workspaceId,
        engine: cmp.engine,
        launch: { cmd, args, env },
      });
      cand.terminalId = terminalId;
      cand.pid = pid;
      cand.lstart = await readProcessStart(pid);
      cand.state = "ready";
      cand.version++;
      this.terminalToComparison.set(terminalId, { comparisonId: cmp.id, label });
      this.pushUpdate(cmp, cand);
      return { ok: true, terminalId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Mark the whole comparison failed and clean up. */
  private async teardown(comparisonId: string, state: WorldlineState, error: string | null): Promise<void> {
    const cmp = this.comparisons.get(comparisonId);
    if (!cmp) return;
    if (cmp.readyTimer) clearTimeout(cmp.readyTimer);
    cmp.phase = "error";
    // 1. Mark both candidates and push the final update.
    for (const cand of cmp.candidates.values()) {
      if (cand.state === "discarded") continue;
      cand.state = state;
      cand.error = error;
      cand.version++;
      this.pushUpdate(cmp, cand);
    }
    // 2. Terminate the candidate process groups (verified by identity).
    for (const cand of cmp.candidates.values()) {
      if (cand.pid && cand.lstart && (await processStartMatches(cand.pid, cand.lstart))) {
        try {
          process.kill(-cand.pid, "SIGTERM");
        } catch {
          /* The process can exit before the signal. */
        }
      }
    }
    await new Promise((r) => setTimeout(r, 500));
    for (const cand of cmp.candidates.values()) {
      if (cand.pid && cand.lstart && (await processStartMatches(cand.pid, cand.lstart))) {
        try {
          process.kill(-cand.pid, "SIGKILL");
        } catch {
          /* The process can exit before the signal. */
        }
      }
    }
    // 3. Remove the app-owned files (marker + canonical path required).
    await this.removeOwnedDir(cmp.dir).catch(() => undefined);
    // 4. Release the bookkeeping.
    for (const [terminalId, hit] of [...this.terminalToComparison]) {
      if (hit.comparisonId === comparisonId) this.terminalToComparison.delete(terminalId);
    }
    this.comparisons.delete(comparisonId);
    await this.dropEvidence(comparisonId);
    this.deps.onRemoved(comparisonId);
  }

  /** Remove a worlds dir only when it is app-owned and canonical. */
  private async removeOwnedDir(dir: string): Promise<void> {
    const worldsRoot = resolve(this.deps.worldsRoot);
    const target = resolve(dir);
    let canonicalRoot: string;
    let canonicalTarget: string;
    try {
      [canonicalRoot, canonicalTarget] = await Promise.all([realpath(worldsRoot), realpath(target)]);
    } catch {
      return;
    }
    if (!isInside(canonicalRoot, canonicalTarget)) return;
    if (!existsSync(join(canonicalTarget, MARKER))) return;
    await rm(canonicalTarget, { recursive: true, force: true });
  }

  private pushUpdate(cmp: ComparisonState, cand: CandidateState): void {
    this.deps.onUpdate(this.summaryOf(cmp, cand));
  }

  private liveWorldlineCount(): number {
    let n = 0;
    for (const cmp of this.comparisons.values()) {
      if (cmp.phase === "running" || cmp.phase === "creating") n += cmp.candidates.size;
    }
    return n;
  }

  // ------------------------------------------------------- stale sweep ----

  /** After a crash, terminate stale candidate groups and remove their dirs. */
  private async sweepStale(): Promise<void> {
    const worldsRoot = resolve(this.deps.worldsRoot);
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(worldsRoot);
    } catch {
      return;
    }
    let entries: string[];
    try {
      entries = await readdir(worldsRoot);
    } catch {
      return;
    }
    for (const name of entries) {
      const dir = join(worldsRoot, name);
      let canonicalDir: string;
      try {
        canonicalDir = await realpath(dir);
      } catch {
        continue;
      }
      if (!isInside(canonicalRoot, canonicalDir) || !existsSync(join(canonicalDir, MARKER))) continue;
      try {
        const manifest = JSON.parse(await readFile(join(canonicalDir, "manifest.json"), "utf8")) as {
          candidates?: Record<string, { pid?: number; lstart?: string }>;
        };
        for (const candidate of Object.values(manifest.candidates ?? {})) {
          if (candidate.pid && candidate.lstart && (await processStartMatches(candidate.pid, candidate.lstart))) {
            try {
              process.kill(-candidate.pid, "SIGKILL");
            } catch {
              /* The process can exit before the signal. */
            }
          }
        }
      } catch {
        /* Remove an owned directory when its manifest is unreadable. */
      }
      await this.removeOwnedDir(canonicalDir).catch(() => undefined);
    }
  }

  /** Discard every live comparison. */
  async dispose(): Promise<void> {
    await this.ready;
    await Promise.all([...this.comparisons.values()].map((cmp) => this.teardown(cmp.id, "discarded", null)));
    this.clearRuns();
  }
}

/** Read the process start time without blocking the main process. */
function readProcessStart(pid: number): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolvePromise(error ? null : stdout.trim() || null);
    });
  });
}

/** Check that a pid still names the same process start time. */
async function processStartMatches(pid: number, lstart: string): Promise<boolean> {
  const current = await readProcessStart(pid);
  return current !== null && current === lstart;
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function writePromotionJournal(journalDir: string, journal: Record<string, unknown>): void {
  mkdirSync(journalDir, { recursive: true, mode: 0o700 });
  const file = join(journalDir, "journal.json");
  const fd = openSync(file, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(journal, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function rollbackPromotion(journalDir: string, journal: Record<string, unknown>, primaryRoot: string): Promise<void> {
  const phase = String(journal.phase ?? "prepared");
  if (phase !== "applied") {
    await rm(journalDir, { recursive: true, force: true });
    return;
  }
  const sha = sha256Hex;
  let conflicted = false;
  for (const p of (journal.paths ?? []) as Array<{ rel: string; beforeHash: string; afterHash: string; beforeExists: boolean }>) {
    const abs = join(primaryRoot, p.rel);
    const now = existsSync(abs) ? await readFile(abs) : Buffer.alloc(0);
    if (sha(now) !== p.afterHash) {
      if (sha(now) !== p.beforeHash) conflicted = true;
      continue;
    }
    const before = join(journalDir, "before", p.rel);
    if (p.beforeExists && existsSync(before)) {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, await readFile(before));
    } else {
      await rm(abs, { force: true });
    }
  }
  journal.phase = conflicted ? "conflict" : "rolled-back";
  writePromotionJournal(journalDir, journal);
  if (!conflicted) await rm(journalDir, { recursive: true, force: true });
}

/** Startup recovery: finish or roll back every pending promotion journal. */
export async function recoverPromotionJournals(worldsRoot: string): Promise<void> {
  const root = join(worldsRoot, "promotion-journal");
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  const sha = sha256Hex;
  for (const name of names) {
    const dir = join(root, name);
    let journal: Record<string, unknown> | null = null;
    try {
      journal = JSON.parse(await readFile(join(dir, "journal.json"), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const phase = String(journal.phase ?? "prepared");
    const primaryRoot = String(journal.primaryRoot ?? "");
    const paths = (journal.paths ?? []) as Array<{ rel: string; beforeHash: string; afterHash: string; beforeExists: boolean }>;
    if (phase !== "applied") {
      await rm(dir, { recursive: true, force: true });
      continue;
    }
    for (const p of paths) {
      const abs = join(primaryRoot, p.rel);
      const now = existsSync(abs) ? await readFile(abs) : Buffer.alloc(0);
      if (sha(now) !== p.afterHash) continue;
      const before = join(dir, "before", p.rel);
      if (p.beforeExists && existsSync(before)) {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, await readFile(before));
      } else {
        await rm(abs, { force: true });
      }
    }
    let conflicted = false;
    for (const p of paths) {
      const abs = join(primaryRoot, p.rel);
      const now = existsSync(abs) ? await readFile(abs) : Buffer.alloc(0);
      const h = sha(now);
      if (h !== p.beforeHash && h !== p.afterHash) {
        conflicted = true;
        break;
      }
    }
    if (!conflicted) {
      await rm(dir, { recursive: true, force: true });
    } else {
      await writeFile(join(dir, "conflict.json"), JSON.stringify({ at: Date.now(), paths: paths.map((p) => p.rel) }));
      console.warn(`[worldline] promotion recovery conflict: ${dir} — kept every version`);
    }
  }
}
