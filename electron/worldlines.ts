/**
 * Worldline manager (WORLDLINES §6.5, §6.6).
 *
 * Fork Run creates two isolated candidates from a completed run:
 * Candidate A preserves the settled source state and session; Candidate B
 * restores the run-start source state and the effective task. Pair
 * creation is all-or-nothing: any failure cancels both candidates and
 * removes every app-owned resource.
 */
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { writeSandboxProfile, sandboxShellPreamble, type SandboxPaths } from "./sandbox.js";
import { runGitIn } from "./worldline-git.js";
import type { SnapshotStore } from "./worldline-git.js";
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
  comparisonBaseStateId: string;
  promotionBaseStateId: string;
  headStateId: string;
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
  /** When the pair was created (ms epoch). */
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
    applyState(opts: { store: SnapshotStore; stateId: string; targetDir: string }): Promise<void>;
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
  createCandidateWorkspace(root: string, baseStateId: string | null): string;
  onUpdate(summary: WorldlineSummary): void;
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
  sourceRunOf(runId: string): { promptPayloadFile: string | null; promptParentEntryId: string | null; sessionFile: string | null } | null;
  /** Capture the current primary state (details conflict status). */
  capturePrimary(): Promise<string | null>;
}

const RUNTIME_ALLOWLIST = ["node_modules", ".venv", "venv"];
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_PROMPT_BYTES = 20 * 1024 * 1024;
const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CANDIDATE_BYTES = 1024 * 1024 * 1024;
const READY_TIMEOUT_MS = 90000;
const MAX_PI_RESOURCE_BYTES = 200 * 1024 * 1024;

/** The app-owned marker that proves a worlds dir belongs to the app. */
const MARKER = ".pi-ditor-world";

/** The logical size of a directory tree (du, off the main-thread sync path). */
async function dirBytes(dir: string): Promise<number> {
  return new Promise((resolvePromise) => {
    const child = spawn("du", ["-sk", dir], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.on("error", () => resolvePromise(0));
    child.on("close", () => {
      const m = /^(\d+)/.exec(out.trim());
      resolvePromise(m ? Number(m[1]) * 1024 : 0);
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
  private terminalToComparison = new Map<string, { comparisonId: string; label: "A" | "B" }>();

  constructor(private deps: WorldlineDeps) {
    mkdirSync(this.deps.worldsRoot, { recursive: true });
    this.sweepStale();
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
      comparisonBaseStateId: cmp.sourceRunId,
      promotionBaseStateId: cmp.sourceRunId,
      headStateId: cmp.sourceRunId,
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

  /**
   * The three comparison diffs (WORLDLINES §8 `worldline:compare`):
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
    this.comparisons.set(id, ncmp);
    try {
      // The template is the SHARED BASE (R), not the reference head: the
      // challenger starts from the recorded base.
      mkdirSync(ncmp.templateDir, { recursive: true });
      await this.deps.snapshot.template({
        store,
        stateId: cmp.baseStateId,
        targetDir: ncmp.templateDir,
        sourceObjectsDir: join(ncmp.sourceGitDir, "objects"),
      });
      const head = await runGitIn(ncmp.templateDir, ["rev-parse", "HEAD"]);
      ncmp.baseCommit = head.code === 0 ? head.stdout.toString().trim() : null;
      for (const name of RUNTIME_ALLOWLIST) {
        const src = join(this.deps.primaryRoot, name);
        if (!existsSync(src)) continue;
        await this.cloneTree(src, join(ncmp.templateDir, name));
      }
      await this.cloneTree(ncmp.templateDir, nA.dir);
      await this.cloneTree(ncmp.templateDir, nB.dir);
      // The reference A receives the candidate head state.
      await this.deps.snapshot.applyState({ store, stateId: wHead.commit, targetDir: nA.dir });
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
          contextText: this.readPromptPayload(run).context || undefined,
        }),
      ]);
      if (!forkA.ok || !forkA.sessionFile) throw new Error("could not fork the reference session");
      if (!forkB.ok || !forkB.sessionFile) throw new Error("could not fork the challenger session");
      nA.sessionFile = forkA.sessionFile;
      nB.sessionFile = forkB.sessionFile;
      this.createSupportDirs(ncmp);
      this.copyPiResources(ncmp);
      // B replays the original task automatically (structured control).
      this.writeControl(nA, { opId: randomUUID(), action: "none" });
      const payload = this.readPromptPayload(run);
      this.writeControl(nB, {
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
      return { ok: false, error: message };
    }
  }

  /** The ignored/generated writes a promotion would exclude (metadata). */
  async ignoredWrites(comparisonId: string, label: "A" | "B"): Promise<{ count: number; bytes: number }> {
    const cmp = this.comparisons.get(comparisonId);
    const cand = cmp?.candidates.get(label);
    if (!cmp || !cand) return { count: 0, bytes: 0 };
    try {
      const res = await runGitIn(cand.dir, ["ls-files", "-z", "-o", "-i", "--exclude-standard"]);
      let count = 0;
      let bytes = 0;
      for (const p of res.stdout.toString("utf8").split("\0")) {
        if (!p || count > 5000) continue;
        count++;
        try {
          bytes += statSync(join(cand.dir, p)).size;
        } catch {
          /* deleted between list and stat */
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
          const res = await runGitIn(cand.dir, ["status", "--porcelain"]);
          if (res.stdout.toString("utf8").trim().length > 0) {
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
        if (cand.sessionFile && statSync(cand.sessionFile).size > 1024) active++;
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
    try {
      const changedFiles = await this.changedFiles(cmp, cand);
      // Provenance: the unowned edits of the source run (§6.9).
      const unownedEdits = this.deps.unownedEditsOf(cmp.sourceRunId);
      // Ignored/generated runtime fingerprints: metadata only, bounded.
      const ignored = await this.ignoredWrites(comparisonId, label);
      // Conflict status against the current primary source: capture P and
      // merge the candidate head against it (on demand, WORLDLINES §6.9).
      let conflicts: string[] = [];
      const primaryCommit = await this.deps.capturePrimary();
      if (primaryCommit && cmp.baseStateId) {
        try {
          const store = await this.deps.getStore();
          if (store) {
            const wHead = await this.deps.captureHead(cand.dir, join(cand.dir, ".git"), cmp.baseStateId);
            const merged = await store.merge3(wHead.commit, primaryCommit);
            if (!merged.ok && merged.tree) conflicts = merged.conflicts;
            else if (!merged.ok && !merged.tree) conflicts = [merged.reason ?? "merge failed"];
          }
        } catch {
          /* conflict status is best-effort */
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
          comparisonBaseStateId: cmp.sourceRunId,
          headStateId: cmp.sourceRunId,
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
    }
  }

  /** Read one file from a candidate tree (no path traversal). */
  async fileOf(comparisonId: string, label: "A" | "B", relPath: string): Promise<{ ok: boolean; content?: string; error?: string }> {
    const cmp = this.comparisons.get(comparisonId);
    const cand = cmp?.candidates.get(label);
    if (!cmp || !cand) return { ok: false, error: "candidate not found" };
    const target = resolve(cand.dir, relPath);
    if (!isInside(resolve(cand.dir), target)) return { ok: false, error: "path escapes the candidate tree" };
    try {
      const content = readFileSync(target, "utf8");
      return { ok: true, content };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Read one file from the shared comparison base commit. */
  async baseFileOf(comparisonId: string, relPath: string): Promise<{ ok: boolean; content?: string; error?: string }> {
    const cmp = this.comparisons.get(comparisonId);
    if (!cmp || !cmp.baseCommit) return { ok: false, error: "the comparison base is missing" };
    const anyCand = cmp.candidates.get("A") ?? cmp.candidates.get("B");
    if (!anyCand) return { ok: false, error: "candidate not found" };
    const res = await runGitIn(anyCand.dir, ["show", `${cmp.baseCommit}:${relPath}`]);
    if (res.code !== 0) return { ok: false, error: res.stderr.trim() || "file not in the base" };
    return { ok: true, content: res.stdout.toString() };
  }

  /** Files differing from the base plus head-tree source statistics. */
  private async changedFiles(cmp: ComparisonState, cand: CandidateState): Promise<{ files: WorldlineChangedFile[]; sourceFiles: number; sourceBytes: number }> {
    // Working tree vs HEAD: staged, unstaged, and untracked changes.
    const status = await runGitIn(cand.dir, ["status", "--porcelain"]);
    // Committed changes since the shared base (A's settled apply and any
    // agent commits; B usually has none).
    const committed = await runGitIn(cand.dir, ["diff", "--name-status", cmp.baseCommit!, "HEAD"]);
    const tree = await runGitIn(cand.dir, ["ls-tree", "-r", "--long", "HEAD"]);
    const byPath = new Map<string, WorldlineChangedFile>();
    const set = (relPath: string, status: "created" | "modified" | "deleted"): void => {
      const prev = byPath.get(relPath);
      // A later state wins: deleted beats modified, created beats deleted.
      if (!prev || (status === "deleted" && prev.status !== "deleted") || (status === "created" && prev.status !== "deleted")) {
        byPath.set(relPath, { relPath, status });
      }
    };
    for (const line of status.stdout.toString().split("\n")) {
      if (!line) continue;
      const x = line[0];
      const y = line[1];
      const path = line.slice(3);
      if (x === "?" && y === "?") set(path, "created");
      else if (x === "D" || y === "D") set(path, "deleted");
      else if (x === "A") set(path, "created");
      else set(path, "modified");
    }
    for (const line of committed.stdout.toString().split("\n")) {
      if (!line) continue;
      const [kind, ...rest] = line.split("\t");
      const path = rest.join("\t");
      if (!path) continue;
      if (kind.startsWith("D")) set(path, "deleted");
      else if (kind.startsWith("A")) set(path, "created");
      else if (kind.startsWith("R")) {
        // Rename: the new name is created, the old one gone.
        const [oldPath, newPath] = path.split("\t");
        if (newPath) {
          set(newPath, "created");
          set(oldPath, "deleted");
        } else set(path, "modified");
      } else set(path, "modified");
    }
    let sourceFiles = 0;
    let sourceBytes = 0;
    for (const line of tree.stdout.toString().split("\n")) {
      if (!line) continue;
      // <mode> <type> <sha> <size>\t<path> — the size is right-padded.
      const match = /^\S+ \S+ \S+ +(\d+)\t/.exec(line);
      if (!match) continue;
      sourceFiles++;
      sourceBytes += Number(match[1]);
    }
    const files = [...byPath.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
    return { files, sourceFiles, sourceBytes };
  }

  /** Declared dependency differences between base and head. */
  private async dependencyChanges(cmp: ComparisonState, cand: CandidateState): Promise<DependencyChange[]> {
    const out: DependencyChange[] = [];
    for (const file of ["package.json", "pyproject.toml"]) {
      try {
        const base = await runGitIn(cand.dir, ["show", `${cmp.baseCommit}:${file}`]);
        const head = readFileSync(join(cand.dir, file), "utf8");
        if (base.code !== 0) continue;
        const diff = this.dependencyChangeOf(file, base.stdout.toString(), head);
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
  } | null {
    const cmp = this.comparisons.get(comparisonId);
    const cand = cmp?.candidates.get(label);
    if (!cmp || !cand) return null;
    return { root: cand.dir, profilePath: cand.profilePath, homeDir: cand.homeDir, tmpDir: cand.tmpDir, state: cand.state };
  }

  // ------------------------------------------------------------ fork-run ----

  async forkRun(run: ForkableRun, opts: { challenge?: boolean } = {}): Promise<{ ok: boolean; comparisonId?: string; error?: string }> {
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
        if (statSync(run.sessionBranchFile).size > MAX_SESSION_BYTES) {
          return { ok: false, error: "the session branch exceeds the 64 MB budget" };
        }
      } catch {
        /* unreadable — the eligibility checks above already cover it */
      }
    }
    if (run.promptPayloadFile) {
      try {
        const payloadPath = join(this.deps.primaryEventsDir, run.promptPayloadFile);
        if (statSync(payloadPath).size > MAX_PROMPT_BYTES) {
          return { ok: false, error: "the prompt payload exceeds the 20 MB budget" };
        }
      } catch {
        /* the payload file is gone — the prefill path handles it */
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
      this.copyPiResources(cmp);
      this.writeStartupControls(cmp, run, opts.challenge ?? false);
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
        terminalId: null,
        pid: null,
        lstart: null,
        state: "creating",
        version: 1,
        error: null,
      });
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
    // The template repo has exactly one commit ("pi-ditor base"). Its SHA
    // is the shared comparison base for both candidates.
    const head = await runGitIn(cmp.templateDir, ["rev-parse", "HEAD"]);
    cmp.baseCommit = head.code === 0 ? head.stdout.toString().trim() : null;
    // Copy the fixed runtime allowlist with copy-on-write clones.
    for (const name of RUNTIME_ALLOWLIST) {
      const src = join(this.deps.primaryRoot, name);
      if (!existsSync(src)) continue;
      await this.cloneTree(src, join(cmp.templateDir, name));
    }
  }

  /** Copy-on-write clone a directory tree. */
  private async cloneTree(src: string, dst: string): Promise<void> {
    const res = await new Promise<number>((resolvePromise) => {
      const child = spawn("cp", ["-c", "-R", src, dst], { stdio: "ignore" });
      child.on("error", () => resolvePromise(-1));
      child.on("close", (code) => resolvePromise(code ?? -1));
    });
    if (res !== 0) throw new Error(`copy-on-write clone failed for ${src}`);
  }

  /** CoW clone the template into A and B. */
  private async cloneCandidates(cmp: ComparisonState): Promise<void> {
    for (const cand of cmp.candidates.values()) {
      await this.cloneTree(cmp.templateDir, cand.dir);
    }
  }

  /** Candidate A receives the settled source state. */
  private async applySettledToA(cmp: ComparisonState, store: SnapshotStore, run: ForkableRun): Promise<void> {
    const a = cmp.candidates.get("A")!;
    await this.deps.snapshot.applyState({ store, stateId: run.settledStateId!, targetDir: a.dir });
  }

  /** Fork both Pi sessions in the session worker. */
  private async forkSessions(cmp: ComparisonState, run: ForkableRun): Promise<void> {
    const payload = this.readPromptPayload(run);
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

  /** Read the prompt payload file (text, images, injected context). */
  private readPromptPayload(run: { promptPayloadFile: string | null }): { text: string; images: unknown[]; context: string } {
    if (!run.promptPayloadFile) return { text: "", images: [], context: "" };
    try {
      const raw = readFileSync(join(this.deps.primaryEventsDir, run.promptPayloadFile), "utf8");
      const payload = JSON.parse(raw) as { prompt?: unknown; images?: unknown; context?: unknown };
      return {
        text: String(payload.prompt ?? ""),
        images: Array.isArray(payload.images) ? payload.images : [],
        context: String(payload.context ?? ""),
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
  private copyPiResources(cmp: ComparisonState): void {
    const agentSrc = join(this.deps.realHome, ".pi", "agent");
    for (const cand of cmp.candidates.values()) {
      const agentDst = join(cand.homeDir, ".pi", "agent");
      mkdirSync(agentDst, { recursive: true });
      for (const name of ["auth.json", "settings.json", "models-store.json"]) {
        const src = join(agentSrc, name);
        if (existsSync(src)) {
          try {
            writeFileSync(join(agentDst, name), readFileSync(src), { mode: 0o600 });
          } catch {
            /* keep the candidate without this file */
          }
        }
      }
      for (const name of ["skills", "prompts", "themes", "extensions"]) {
        const src = join(agentSrc, name);
        if (existsSync(src)) {
          try {
            this.copyResourceTree(src, join(agentDst, name));
          } catch {
            /* keep the candidate without this resource */
          }
        }
      }
    }
  }

  /** Copy a Pi resource tree with a byte budget. */
  private copyResourceTree(src: string, dst: string): void {
    let total = 0;
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else total += st.size;
      }
    };
    walk(src);
    if (total > MAX_PI_RESOURCE_BYTES) return;
    cpSync(src, dst, { recursive: true, mode: 0o600 });
  }

  /** The startup control files: what the bridge does on session start. */
  private writeStartupControls(cmp: ComparisonState, run: ForkableRun, challenge: boolean): void {
    const payload = this.readPromptPayload(run);
    const a = cmp.candidates.get("A")!;
    const b = cmp.candidates.get("B")!;
    this.writeControl(a, { opId: randomUUID(), action: "none" });
    // A challenge replays the original task unchanged with one click; a
    // plain fork prefills it as editable text.
    if (payload.images.length > 0 || challenge) {
      // Structured prompt: replay the original content blocks unchanged.
      this.writeControl(b, {
        opId: randomUUID(),
        action: "structured",
        content: [{ type: "text", text: payload.text }, ...payload.images],
      });
    } else {
      // Text-only prompt: prefilled and editable in the Pi editor.
      this.writeControl(b, { opId: randomUUID(), action: "prefill", text: payload.text });
    }
  }

  private writeControl(cand: CandidateState, control: Record<string, unknown>): void {
    writeFileSync(join(cand.eventsDir, "startup-control.json"), JSON.stringify(control), { mode: 0o600 });
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
      args: ["-f", cand.profilePath, "/bin/zsh", "-c", `${sandboxShellPreamble()} exec ${this.deps.piBin} ${piArgs.map(quoteArg).join(" ")}`],
      env: {
        ...this.deps.baseEnv,
        HOME: cand.homeDir,
        TMPDIR: cand.tmpDir,
        PI_EDITOR_EVENTS_DIR: cand.eventsDir,
        ...(cmp.inheritTrust ? { PI_EDITOR_INHERIT_TRUST: "1" } : {}),
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
      /* manifest is best-effort */
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
      terminalId: null,
      pid: null,
      lstart: null,
      state: "creating",
      version: 1,
      error: null,
    };
    cmp.candidates.set("A", cand);
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
      const head = await runGitIn(cmp.templateDir, ["rev-parse", "HEAD"]);
      cmp.baseCommit = head.code === 0 ? head.stdout.toString().trim() : null;
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
      this.copyPiResources(cmp);
      // A moment candidate starts with no prompt: the user continues it.
      // Replay the captured model and thinking level of that moment.
      this.writeControl(cand, { opId: randomUUID(), action: "none" });
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
    const workspaceId = this.deps.createCandidateWorkspace(cand.dir, headStateId ?? cmp.baseStateId ?? null);
    const { terminalId, pid } = await this.deps.createCandidate({
      root: cand.dir,
      workspaceId,
      launch: { cmd, args, env },
    });
    cand.terminalId = terminalId;
    cand.pid = pid;
    cand.lstart = readProcessStart(pid);
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
      // The template is no longer needed.
      rmSync(cmp.templateDir, { recursive: true, force: true });
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
  async cancel(comparisonId: string): Promise<{ ok: boolean; error?: string }> {    const cmp = this.comparisons.get(comparisonId);
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
    const workspaceId = this.deps.createCandidateWorkspace(cand.dir, cmp.baseStateId ?? null);
    try {
      const { terminalId, pid } = await this.deps.createCandidate({
        root: cand.dir,
        workspaceId,
        launch: { cmd, args, env },
      });
      cand.terminalId = terminalId;
      cand.pid = pid;
      cand.lstart = readProcessStart(pid);
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
      if (cand.pid && cand.lstart && processStartMatches(cand.pid, cand.lstart)) {
        try {
          process.kill(-cand.pid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
    }
    await new Promise((r) => setTimeout(r, 500));
    for (const cand of cmp.candidates.values()) {
      if (cand.pid && cand.lstart && processStartMatches(cand.pid, cand.lstart)) {
        try {
          process.kill(-cand.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
    // 3. Remove the app-owned files (marker + canonical path required).
    this.removeOwnedDir(cmp.dir);
    // 4. Release the bookkeeping.
    for (const [terminalId, hit] of [...this.terminalToComparison]) {
      if (hit.comparisonId === comparisonId) this.terminalToComparison.delete(terminalId);
    }
    this.comparisons.delete(comparisonId);
    this.deps.onRemoved(comparisonId);
  }

  /** Remove a worlds dir only when it is app-owned and canonical. */
  private removeOwnedDir(dir: string): void {
    const worldsRoot = resolve(this.deps.worldsRoot);
    const target = resolve(dir);
    if (!isInside(worldsRoot, target)) return;
    if (!existsSync(join(target, MARKER))) return;
    rmSync(target, { recursive: true, force: true });
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

  /** After a crash: kill stale candidate groups, remove their dirs. */
  private sweepStale(): void {
    const worldsRoot = resolve(this.deps.worldsRoot);
    let entries: string[] = [];
    try {
      entries = readdirSync(worldsRoot);
    } catch {
      return;
    }
    for (const name of entries) {
      const dir = join(worldsRoot, name);
      if (!existsSync(join(dir, MARKER))) continue;
      try {
        const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
          candidates?: Record<string, { pid?: number; lstart?: string }>;
        };
        for (const cand of Object.values(manifest.candidates ?? {})) {
          if (cand.pid && cand.lstart && processStartMatches(cand.pid, cand.lstart)) {
            try {
              process.kill(-cand.pid, "SIGKILL");
            } catch {
              /* already gone */
            }
          }
        }
      } catch {
        /* no manifest — still remove the owned dir */
      }
      this.removeOwnedDir(dir);
    }
  }

  dispose(): void {
    for (const cmp of [...this.comparisons.values()]) {
      void this.teardown(cmp.id, "discarded", null);
    }
  }
}

/** Read the process start time as reported by ps. */
function readProcessStart(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** True when a pid still names the same process start time. */
function processStartMatches(pid: number, lstart: string): boolean {
  const now = readProcessStart(pid);
  return now !== null && now === lstart;
}
