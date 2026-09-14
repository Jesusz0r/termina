import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, realpath, lstat, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

vi.mock("../../../electron/worldline-git.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../electron/worldline-git.ts")>();
  return {
    ...actual,
    boundPromotionWriteFile: vi.fn((args: Parameters<typeof actual.boundPromotionWriteFile>[0]) => actual.boundPromotionWriteFile(args)),
    boundPromotionCopyFile: vi.fn((args: Parameters<typeof actual.boundPromotionCopyFile>[0]) => actual.boundPromotionCopyFile(args)),
  };
});

import { WorldlineManager, ensurePromotionRoots } from "../../../electron/worldlines/index.ts";
import { MARKER } from "../../../electron/worldlines/limits.ts";
import type { ComparisonState, CandidateState } from "../../../electron/worldlines/types.ts";
import { boundPromotionCopyFile, boundPromotionWriteFile, type SnapshotStore } from "../../../electron/worldline-git.ts";
import type { RunRecord } from "../../../electron/worldlines/types.ts";

const mockWriteFile = vi.mocked(boundPromotionWriteFile);
const mockCopyFile = vi.mocked(boundPromotionCopyFile);

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.email=test@termina.local", "-c", "user.name=test", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });
}

interface PromoteFixture {
  root: string;
  worldsRoot: string;
  primaryRoot: string;
  candRoot: string;
  manager: WorldlineManager;
  comparisonId: string;
}

async function makeFixture(opts: {
  changes: Array<{ relPath: string; status: "created" | "modified" | "deleted" }>;
  primaryPaths: string[];
  mergedPaths: string[];
  materialize: (dir: string) => Promise<void>;
}): Promise<PromoteFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "termina-promote-touched-")));
  const worldsRoot = join(root, "worlds");
  const primaryRoot = join(root, "primary");
  const candRoot = join(root, "cand");
  await mkdir(candRoot, { recursive: true });
  // Roots below the trusted parent are binder-created, like production startup.
  await ensurePromotionRoots(worldsRoot, primaryRoot);

  git(primaryRoot, "init", "-q", ".");
  await writeFile(join(primaryRoot, "touched.txt"), "old\n");
  await writeFile(join(primaryRoot, "other.txt"), "other\n");
  git(primaryRoot, "add", ".");
  git(primaryRoot, "commit", "-qm", "init");
  git(candRoot, "init", "-q", ".");
  await writeFile(join(candRoot, "note.txt"), "cand\n");
  git(candRoot, "add", ".");
  git(candRoot, "commit", "-qm", "init");

  const store = {
    sourceRoot: primaryRoot,
    sourceGitDir: join(primaryRoot, ".git"),
    capture: async (_head: string, parent: string | null): Promise<{ commit: string; tree: string }> =>
      parent === "base" ? { commit: "w", tree: "w" } : parent === "p0" ? { commit: "p", tree: "p" } : { commit: "m", tree: "m" },
    diffTree: async (): Promise<Array<{ relPath: string; status: "created" | "modified" | "deleted" }>> => opts.changes,
    treePaths: async (state: string): Promise<Set<string>> =>
      state === "merge-tree" ? new Set(opts.mergedPaths) : new Set(opts.primaryPaths),
    merge3: async (): Promise<{ ok: true; tree: string; conflicts: string[] }> => ({ ok: true, tree: "merge-tree", conflicts: [] }),
    materialize: async (_state: string, targetDir: string): Promise<void> => {
      await mkdir(targetDir, { recursive: true });
      await opts.materialize(targetDir);
    },
    symlinkTarget: async (): Promise<null> => null,
    readBlob: async (): Promise<null> => null,
  } as unknown as SnapshotStore;

  const generations = new Map<string, number>([["ws-primary", 7], ["ws-cand", 3]]);
  const primaryInfo = await lstat(primaryRoot, { bigint: true });
  const manager = new WorldlineManager({
    worldsRoot,
    primaryRoot,
    primaryRootIdentity: { dev: String(primaryInfo.dev), ino: String(primaryInfo.ino) },
    realHome: root,
    userData: root,
    primaryEventsDir: root,
    agentCorePath: join(root, "agent-core.mjs"),
    electronExecPath: process.execPath,
    candidateEnv: () => ({}),
    showThinking: () => false,
    getStore: async () => store,
    appReadPaths: () => [],
    forkCoreSession: async (forkOpts) => {
      await mkdir(dirname(forkOpts.destinationSessionFile), { recursive: true });
      await writeFile(forkOpts.destinationSessionFile, "{}\n");
      return { ok: true, sessionFile: forkOpts.destinationSessionFile, kept: 1 };
    },
    buildExportPatch: async () => "",
    readPromptPayload: async () => ({ ok: false, error: "unused" }),
    discardCoreSession: async () => ({ ok: false, error: "unused" }),
    createCandidate: async () => ({ terminalId: "unused", pid: 0 }),
    createCandidateWorkspace: () => root,
    onUpdate: () => {},
    onCandidateState: () => {},
    onRemoved: () => {},
    preflight: async () => ({ ok: true, reasons: [] }),
    trustHashes: async () => ({}),
    captureHead: async () => ({ commit: "", tree: "" }),
    capturePrimary: async () => null,
    releaseState: async () => {},
    terminalBusy: () => false,
    terminalVerifying: () => false,
    workspaceAt: async (wsRoot: string) => {
      if (wsRoot === primaryRoot) return { id: "ws-primary", generation: 7, lastStateCommit: "p0" };
      if (wsRoot === candRoot) return { id: "ws-cand", generation: 3, lastStateCommit: "c0" };
      return null;
    },
    acquireWriteLease: async (workspaceId: string) => ({ ok: true, generation: generations.get(workspaceId) ?? 0 }),
    releaseWriteLease: () => {},
    flushDirtyModels: async () => ({ ok: true }),
    canonicalPath: async (p: string) => realpath(p),
    mineFiles: () => new Set<string>(),
    drainMineUpdates: async () => {},
    runSandboxedEvidence: async () => ({ code: 0, stdout: "", timedOut: false }),
    sourceFilesOf: async () => [],
    createEvidenceHome: async () => root,
    removeEvidenceHome: async () => true,
    detectTestFromState: async () => null,
    benchmarkConfigFrom: async () => null,
    onEvidenceUpdate: () => {},
    onPromotionApply: () => {},
    primarySessionDir: async (cwd: string) => join(cwd, "sessions"),
    installPromoted: async () => ({ terminalId: "term-promoted" }),
  });

  manager.recordRun({
    id: "run-1",
    terminalId: "term-0",
    workspaceId: "ws-primary",
    startStateId: "base",
    settledStateId: "settled",
    promptPayloadFile: null,
    promptEventsDir: null,
    promptText: null,
    promptEntryId: null,
    promptParentEntryId: null,
    settledEntryId: null,
    sessionFile: null,
    sessionBranchFile: null,
    uncertainSessionFile: null,
    model: null,
    thinkingLevel: null,
    replayable: true,
    reason: null,
    interrupted: false,
    steering: false,
    overlap: false,
    unownedEdits: 0,
    startedAt: Date.now(),
    settledAt: Date.now(),
    trustHashes: null,
    engine: "core",
  } satisfies RunRecord);

  const comparisonId = "cmp-196";
  const cmpDir = join(worldsRoot, comparisonId);
  await mkdir(cmpDir, { recursive: true });
  await writeFile(join(cmpDir, MARKER), "owned\n");
  const cand: CandidateState = {
    label: "A",
    role: "moment",
    dir: candRoot,
    supportDir: join(root, "support"),
    homeDir: join(root, "home"),
    sessionDir: join(root, "sessions"),
    eventsDir: join(root, "events"),
    tmpDir: join(root, "tmp"),
    cacheDir: join(root, "cache"),
    profilePath: join(root, "A.sb"),
    sessionFile: join(root, "candidate-session.jsonl"),
    comparisonBaseStateId: "base",
    promotionBaseStateId: "base",
    headStateId: "w",
    headCommit: Promise.resolve(),
    terminalId: null,
    pid: null,
    lstart: null,
    state: "ready",
    version: 1,
    error: null,
  };
  await writeFile(cand.sessionFile, "{}\n");
  const cmp: ComparisonState = {
    id: comparisonId,
    dir: cmpDir,
    templateDir: join(cmpDir, "template"),
    sourceRunId: "run-1",
    sourceGitDir: join(primaryRoot, ".git"),
    primaryRoot,
    baseCommit: "basecommit",
    baseStateId: "base",
    model: null,
    thinkingLevel: null,
    engine: "core",
    expectedCandidates: 1,
    uncertainSessionArtifacts: [],
    manifestWriteFailed: false,
    teardownPromise: null,
    uncertainAdmissionLease: null,
    removeUncertainRequested: false,
    createdAt: Date.now(),
    candidates: new Map([["A", cand]]),
    phase: "running",
    error: null,
    readyTimer: null,
  };
  (manager as unknown as { comparisons: Map<string, ComparisonState> }).comparisons.set(comparisonId, cmp);
  return { root, worldsRoot, primaryRoot, candRoot, manager, comparisonId };
}

/** Every journal.json payload observed through the native write boundary. */
function journalPathCounts(): number[] {
  const counts: number[] = [];
  for (const call of mockWriteFile.mock.calls) {
    const args = call[0] as { components?: string[]; content?: Buffer };
    if (!args.components?.includes("journal.json") || !args.content) continue;
    const journal = JSON.parse(args.content.toString("utf8")) as { paths?: unknown[] };
    counts.push(journal.paths?.length ?? 0);
  }
  return counts;
}

describe("promote iterates the touched set (issue #196)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records 1 path for a 1-change promotion on a 2001-path tree", async () => {
    const mergedPaths = ["touched.txt", "other.txt", ...Array.from({ length: 1999 }, (_, i) => `pad-${String(i).padStart(4, "0")}.txt`)];
    const fx = await makeFixture({
      changes: [{ relPath: "touched.txt", status: "modified" }],
      primaryPaths: ["touched.txt", "other.txt"],
      mergedPaths,
      materialize: async (dir) => {
        await writeFile(join(dir, "touched.txt"), "new\n");
      },
    });
    try {
      const otherBefore = await stat(join(fx.primaryRoot, "other.txt"));
      const result = await fx.manager.promote(fx.comparisonId, "A", true);
      expect(result).toEqual({ ok: true, terminalId: "term-promoted" });
      // The journal never held more than the single touched path.
      const counts = journalPathCounts();
      expect(counts.length).toBeGreaterThan(0);
      expect(Math.max(...counts)).toBe(1);
      expect(counts[counts.length - 1]).toBe(1);
      // Exactly one before-image copy; untouched files keep their mtime.
      expect(mockCopyFile).toHaveBeenCalledTimes(1);
      expect(await readFile(join(fx.primaryRoot, "touched.txt"), "utf8")).toBe("new\n");
      const otherAfter = await stat(join(fx.primaryRoot, "other.txt"));
      expect(otherAfter.mtimeMs).toBe(otherBefore.mtimeMs);
    } finally {
      await fx.manager.dispose();
      await rm(fx.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("fails a >2000-change promotion before any before-image copy", async () => {
    const changes = Array.from({ length: 2001 }, (_, i) => ({ relPath: `chg-${String(i).padStart(4, "0")}.txt`, status: "modified" as const }));
    const fx = await makeFixture({
      changes,
      primaryPaths: ["touched.txt", "other.txt"],
      mergedPaths: ["touched.txt", "other.txt", ...changes.map((c) => c.relPath)],
      materialize: async (dir) => {
        for (const c of changes) await writeFile(join(dir, c.relPath), "merged\n");
      },
    });
    try {
      for (const c of changes) await writeFile(join(fx.primaryRoot, c.relPath), "x\n");
      const result = await fx.manager.promote(fx.comparisonId, "A", true);
      expect(result.ok).toBe(false);
      expect(result.error ?? "").toMatch(/too many paths/);
      expect(mockCopyFile).not.toHaveBeenCalled();
      // The retained journal holds no before-image inputs at all.
      const journals = await readdir(join(fx.worldsRoot, "promotion-journal"));
      expect(journals.length).toBe(1);
      const entries = await readdir(join(fx.worldsRoot, "promotion-journal", journals[0]!));
      expect(entries).not.toContain("before");
      // The pair stays usable.
      const cmp = (fx.manager as unknown as { comparisons: Map<string, ComparisonState> }).comparisons.get(fx.comparisonId)!;
      expect(cmp.candidates.get("A")!.state).toBe("ready");
    } finally {
      await fx.manager.dispose();
      await rm(fx.root, { recursive: true, force: true });
    }
  }, 60_000);
});
