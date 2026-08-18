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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, cp, lstat as lstatPath, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { writeSandboxProfile, sandboxShellPreamble, type SandboxPaths } from "./sandbox.js";
import { coreClient } from "./core-client.js";
import { gitHead, platformHasCopyOnWrite, type SnapshotStore } from "./worldline-git.js";
import { dependencyDiff } from "./evidence.js";
import type { DependencyChange, WorldlineChangedFile, WorldlineDetails } from "../shared/types.js";

/** Quote one shell argument for the ulimit wrapper command. */
function quoteArg(a: string): string {
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
  /** When the pair started (ms epoch). */
  createdAt: number;
  candidates: Map<"A" | "B", CandidateState>;
  phase: "creating" | "running" | "error";
  error: string | null;
  readyTimer: ReturnType<typeof setTimeout> | null;
}

/** One recorded run handed to the manager (main-side shape). */
export interface ForkableRun {
  id: string;
  terminalId: string;
  startStateId: string | null;
  settledStateId: string | null;
  promptPayloadFile: string | null;
  promptEventsDir: string | null;
  promptEntryId: string | null;
  promptParentEntryId: string | null;
  settledEntryId: string | null;
  sessionBranchFile: string | null;
  replayable: boolean;
  reason: string | null;
  model: string | null;
  thinkingLevel: string | null;
  startedAt: number;
  /** The trust-sensitive resource hashes captured at run start (§6.7). */
  trustHashes: Record<string, string> | null;
  /** Whether the source session was project-trusted. */
  trusted: boolean | null;
}

export interface WorldlineDeps {
  worldsRoot: string;
  primaryRoot: string;
  realHome: string;
  userData: string;
  primaryEventsDir: string;
  bridgePath: string;
  piBin: string;
  baseEnv: Record<string, string | undefined>;
  getStore(): Promise<SnapshotStore | null>;
  /** Read-only load paths for the sandboxed pi (app package + node). */
  appReadPaths(): string[];
  snapshot: {
    template(opts: { store: SnapshotStore; stateId: string; targetDir: string; sourceObjectsDir: string }): Promise<void>;
    applyState(opts: { store: SnapshotStore; stateId: string; targetDir: string; preserveTopLevel?: string[] }): Promise<void>;
  };
  session: {
    fork(opts: {
      sourceSessionFile: string;
      entryId: string | null;
      sessionWorkspaceDir: string;
      candidateRoot: string;
      candidateSessionDir: string;
      relocationNote?: string;
      contextText?: string;
    }): Promise<{ ok: boolean; sessionFile: string | null; entryCount: number; leafId: string | null }>;
  };
  createCandidate(opts: {
    root: string;
    workspaceId: string;
    launch: { cmd: string; args: string[]; env: Record<string, string | undefined> };
  }): Promise<{ terminalId: string; pid: number }>;
  createCandidateWorkspace(root: string, baseStateId: string | null, comparisonId: string): string;
  onUpdate(summary: WorldlineSummary): void;
  onCandidateState(root: string, stateId: string): void;
  onRemoved(comparisonId: string): void;
  /** The fork preflight (WORLDLINES §4): repo, platform, disk. */
  preflight(): Promise<{ ok: boolean; reasons: string[] }>;
  /** The trust-sensitive resource hashes of the project + pi agent dir. */
  trustHashes(): Promise<Record<string, string>>;
  /** Capture a candidate head off the main thread. */
  captureHead(root: string, gitDir: string, parent: string | null): Promise<{ commit: string; tree: string }>;
  /** The unowned-edit count of a run (comparison provenance). */
  unownedEditsOf(runId: string): number;
  /** The source run of a comparison (challenge anchors). */
  sourceRunOf(runId: string): {
    promptPayloadFile: string | null;
    promptEventsDir: string | null;
    promptParentEntryId: string | null;
    sessionFile: string | null;
  } | null;
  /** Capture the current primary state (details conflict status). */
  capturePrimary(): Promise<string | null>;
  /** Release a temporary state reference after a comparison operation. */
  releaseState(stateId: string): Promise<void>;
}

const RUNTIME_ALLOWLIST = ["node_modules", ".venv", "venv"];
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_PROMPT_BYTES = 20 * 1024 * 1024;
const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CANDIDATE_BYTES = 1024 * 1024 * 1024;
const READY_TIMEOUT_MS = 90000;
const MAX_PI_RESOURCE_BYTES = 200 * 1024 * 1024;
const MAX_WORLDLINE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_IGNORED_FILES = 5000;
const MAX_IGNORED_BYTES = 200 * 1024 * 1024;

/** The app-owned marker that proves a worlds dir belongs to the app. */
const MARKER = ".termina-world";

/** The logical size of a directory tree (du, off the main-thread sync path). */
async function dirBytes(dir: string): Promise<number> {
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

function isInside(parent: string, child: string): boolean {
  const rel = child.startsWith(parent) ? child.slice(parent.length) : null;
  return rel !== null && (rel.startsWith("/") || rel === "");
}

export class WorldlineManager {
  private comparisons = new Map<string, ComparisonState>();
  private seq = 0;
  private ready: Promise<void>;
  private terminalToComparison = new Map<string, { comparisonId: string; label: "A" | "B" }>();

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
      eventsDir: cand.eventsDir,
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
  updateHeadState(terminalId: string, stateId: string): void {
    const hit = this.terminalToComparison.get(terminalId);
    if (hit) this.setCandidateHead(hit.comparisonId, hit.label, stateId);
  }

  /** Record a captured candidate state from an on-demand operation. */
  setCandidateHead(comparisonId: string, label: "A" | "B", stateId: string): void {
    const cmp = this.comparisons.get(comparisonId);
    const cand = cmp?.candidates.get(label);
    if (!cmp || !cand || cand.headStateId === stateId) return;
    const previousStateId = cand.headStateId;
    cand.headStateId = stateId;
    this.deps.onCandidateState(cand.dir, stateId);
    if (previousStateId) void this.deps.releaseState(previousStateId);
    cand.version++;
    this.pushUpdate(cmp, cand);
  }

  /**
   * Return the candidate version and head state used to validate evidence.
   */
  evidenceVersion(comparisonId: string, label: "A" | "B"): { version: number; headStateId: string | null } | null {
    const cand = this.comparisons.get(comparisonId)?.candidates.get(label);
    return cand ? { version: cand.version, headStateId: cand.headStateId } : null;
  }

  /** The three comparison diffs (WORLDLINES §8 `worldline:compare`):
   * metadata only — base→A, base→B, and A→B changed paths.
   */
  async compare(comparisonId: string): Promise<{
    ok: boolean;
    baseToA?: WorldlineChangedFile[];
    baseToB?: WorldlineChangedFile[];
    aToB?: WorldlineChangedFile[];
    error?: string;
  }> {
    const cmp = this.comparisons.get(comparisonId);
    const a = cmp?.candidates.get("A");
    const b = cmp?.candidates.get("B");
    if (!cmp || !a || !b) return { ok: false, error: "the comparison has no A/B pair" };
    if (!cmp.baseStateId) return { ok: false, error: "the comparison base is missing" };
    const store = await this.deps.getStore();
    if (!store) return { ok: false, error: "recording is not available" };
    try {
      const [wA, wB] = await Promise.all([
        this.deps.captureHead(a.dir, join(a.dir, ".git"), cmp.baseStateId),
        this.deps.captureHead(b.dir, join(b.dir, ".git"), cmp.baseStateId),
      ]);
      this.setCandidateHead(cmp.id, "A", wA.commit);
      this.setCandidateHead(cmp.id, "B", wB.commit);
      const [baseToA, baseToB, aToB] = await Promise.all([
        store.diffTree(cmp.baseStateId, wA.commit),
        store.diffTree(cmp.baseStateId, wB.commit),
        store.diffTree(wA.commit, wB.commit),
      ]);
      return {
        ok: true,
        baseToA: baseToA.map((c) => ({ relPath: c.relPath, status: c.status })),
        baseToB: baseToB.map((c) => ({ relPath: c.relPath, status: c.status })),
        aToB: aToB.map((c) => ({ relPath: c.relPath, status: c.status })),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Challenge an existing candidate (WORLDLINES §6.9): the candidate is
   * snapshotted as the new reference A; the challenger B starts from the
   * recorded comparison base and the pre-task session anchor with the
   * original task. The root promotion base stays unchanged.
   */
  async challengeFromCandidate(comparisonId: string, label: "A" | "B"): Promise<{ ok: boolean; comparisonId?: string; error?: string; requiresDiscard?: boolean }> {
    await this.ready;
    const cmp = this.comparisons.get(comparisonId);
    const cand = cmp?.candidates.get(label);
    if (!cmp || !cand) return { ok: false, error: "candidate not found" };
    if (!cand.sessionFile) return { ok: false, error: "the candidate has no session" };
    const store = await this.deps.getStore();
    if (!store) return { ok: false, error: "recording is not available" };
    if (!cmp.baseStateId) return { ok: false, error: "the comparison base is missing" };
    const run = this.deps.sourceRunOf(cmp.sourceRunId);
    if (!run?.promptPayloadFile || !run.promptParentEntryId) {
      return { ok: false, error: "the run has no captured task or pre-task anchor" };
    }
    if (this.liveWorldlineCount() + 2 > 3) return { ok: false, error: "the live worldline budget is exhausted" };
    // If another alternative occupies B, require discard confirmation.
    const other = cmp.candidates.get(label === "A" ? "B" : "A");
    if (other && other.state !== "discarded" && other.state !== "error") {
      return { ok: false, error: "candidate B is occupied — discard it first", requiresDiscard: true };
    }
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
      // The template is the SHARED BASE (R), not the reference head: the
      // challenger starts from the recorded base.
      mkdirSync(ncmp.templateDir, { recursive: true });
      await this.deps.snapshot.template({
        store,
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
      await this.deps.snapshot.applyState({ store, stateId: wHead.commit, targetDir: nA.dir, preserveTopLevel: RUNTIME_ALLOWLIST });
      // A's session continues from the candidate leaf; B's session branches
      // at the pre-task anchor (the original run's prompt parent).
      const [forkA, forkB] = await Promise.all([
        this.deps.session.fork({
          sourceSessionFile: cand.sessionFile,
          entryId: null,
          sessionWorkspaceDir: ncmp.sessionWorkspaceDir,
          candidateRoot: nA.dir,
          candidateSessionDir: nA.sessionDir,
          relocationNote: `The source project lived at ${this.deps.primaryRoot}. In this candidate, that path maps to ${nA.dir}.`,
        }),
        this.deps.session.fork({
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
      this.createSupportDirs(ncmp);
      await this.copyPiResources(ncmp);
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
      return { ok: true, comparisonId: id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.teardown(ncmp.id, "error", message);
      await this.deps.releaseState(wHead.commit);
      return { ok: false, error: message };
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
      const unownedEdits = this.deps.unownedEditsOf(cmp.sourceRunId);
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
            this.setCandidateHead(cmp.id, label, wHead.commit);
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
      version: cand.version,
      headStateId: cand.headStateId,
    };
  }

  // ------------------------------------------------------------ fork-run ----

  async forkRun(run: ForkableRun, opts: { challenge?: boolean } = {}): Promise<{ ok: boolean; comparisonId?: string; error?: string }> {
    await this.ready;
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
      await this.copyPiResources(cmp);
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

  private createComparison(run: ForkableRun): ComparisonState {
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
  private async buildTemplate(cmp: ComparisonState, store: SnapshotStore, run: ForkableRun): Promise<void> {
    mkdirSync(cmp.templateDir, { recursive: true });
    await this.deps.snapshot.template({
      store,
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
  private async applySettledToA(cmp: ComparisonState, store: SnapshotStore, run: ForkableRun): Promise<void> {
    const a = cmp.candidates.get("A")!;
    await this.deps.snapshot.applyState({ store, stateId: run.settledStateId!, targetDir: a.dir, preserveTopLevel: RUNTIME_ALLOWLIST });
  }

  /** Fork both Pi sessions in the session worker. */
  private async forkSessions(cmp: ComparisonState, run: ForkableRun): Promise<void> {
    const payload = await this.readPromptPayload(run);
    const a = cmp.candidates.get("A")!;
    const b = cmp.candidates.get("B")!;
    const [forkA, forkB] = await Promise.all([
      this.deps.session.fork({
        sourceSessionFile: run.sessionBranchFile!,
        entryId: run.settledEntryId,
        sessionWorkspaceDir: cmp.sessionWorkspaceDir,
        candidateRoot: a.dir,
        candidateSessionDir: a.sessionDir,
        relocationNote: `The source project lived at ${this.deps.primaryRoot}. In this candidate, that path maps to ${a.dir}.`,
      }),
      this.deps.session.fork({
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
  private async writeStartupControls(cmp: ComparisonState, run: ForkableRun, challenge: boolean): Promise<void> {
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
  private async launchCandidates(cmp: ComparisonState, run: ForkableRun): Promise<void> {
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

  /** The sandboxed launch command for one candidate. */
  private candidateLaunch(
    cmp: ComparisonState,
    cand: CandidateState,
    extraPiArgs: string[],
  ): { cmd: string; args: string[]; env: Record<string, string | undefined> } {
    // A moment comparison has a single candidate: no sibling to deny (the
    // worlds-root deny covers its tree anyway).
    const sibling = cmp.candidates.get(cand.label === "A" ? "B" : "A");
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
      agentHomeDir: join(cand.homeDir, ".pi", "agent"),
      denyNetwork: false,
    };
    cand.profilePath = writeSandboxProfile(cand.supportDir, paths);
    const piArgs = ["--session", cand.sessionFile!, "-e", this.deps.bridgePath, ...extraPiArgs];
    return {
      cmd: "sandbox-exec",
      args: ["-f", cand.profilePath, "/bin/zsh", "-c", `${sandboxShellPreamble()} exec ${quoteArg(this.deps.piBin)} ${piArgs.map(quoteArg).join(" ")}`],
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

  // ------------------------------------------------------- fork any moment ----

  /**
   * Fork ONE candidate from a timeline moment (WORLDLINES §6): the exact
   * captured source state and the session branched at the dot's entry.
   * Nested worldlines (forking inside a candidate) stay disabled until the
   * attribution and cleanup tests pass.
   */
  async forkPoint(opts: {
    terminalId: string;
    stateId: string;
    entryId: string;
    model: string | null;
    thinkingLevel: string | null;
    sessionFile: string;
    sourceRunId: string;
    /** The store-side lineage base (R): the root run start for nested. */
    baseStateId: string | null;
    /** Inherit one-process trust (run trusted + hashes matched). */
    inheritTrust: boolean | null;
  }): Promise<{ ok: boolean; comparisonId?: string; error?: string }> {
    await this.ready;
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
      await this.deps.snapshot.template({
        store,
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
      const fork = await this.deps.session.fork({
        sourceSessionFile: opts.sessionFile,
        entryId: opts.entryId,
        sessionWorkspaceDir: cmp.sessionWorkspaceDir,
        candidateRoot: cand.dir,
        candidateSessionDir: cand.sessionDir,
        relocationNote: `The source project lived at ${this.deps.primaryRoot}. In this candidate, that path maps to ${cand.dir}.`,
      });
      if (!fork.ok || !fork.sessionFile) throw new Error("could not fork the moment session");
      cand.sessionFile = fork.sessionFile;
      this.createSupportDirs(cmp);
      await this.copyPiResources(cmp);
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
    await this.teardown(comparisonId, "cancelled", null);
    return { ok: true };
  }

  /** Discard a live comparison and remove every app-owned resource. */
  async discard(comparisonId: string): Promise<{ ok: boolean; error?: string }> {
    const cmp = this.comparisons.get(comparisonId);
    if (!cmp) return { ok: false, error: "comparison not found" };
    await this.teardown(comparisonId, "discarded", null);
    return { ok: true };
  }

  /** Open a new terminal for an existing candidate (reopen). */
  async openTerminal(comparisonId: string, label: "A" | "B"): Promise<{ ok: boolean; error?: string }> {
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
        launch: { cmd, args, env },
      });
      cand.terminalId = terminalId;
      cand.pid = pid;
      cand.lstart = await readProcessStart(pid);
      cand.state = "ready";
      cand.version++;
      this.terminalToComparison.set(terminalId, { comparisonId: cmp.id, label });
      this.pushUpdate(cmp, cand);
      return { ok: true };
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
