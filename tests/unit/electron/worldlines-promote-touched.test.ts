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
  workspaceAt?: (wsRoot: string) => Promise<{ id: string; generation: number; lastStateCommit: string | null } | null>;
  captureImpl?: (head: string, parent: string | null) => Promise<{ commit: string; tree: string }>;
  installPromoted?: () => Promise<{ terminalId: string }>;
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
    capture: opts.captureImpl ?? (async (_head: string, parent: string | null): Promise<{ commit: string; tree: string }> =>
      parent === "base" ? { commit: "w", tree: "w" } : parent === "p0" ? { commit: "p", tree: "p" } : { commit: "m", tree: "m" }),
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
    workspaceAt: opts.workspaceAt ?? (async (wsRoot: string) => {
      if (wsRoot === primaryRoot) return { id: "ws-primary", generation: 7, lastStateCommit: "p0" };
      if (wsRoot === candRoot) return { id: "ws-cand", generation: 3, lastStateCommit: "c0" };
      return null;
    }),
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
    installPromoted: opts.installPromoted ?? (async () => ({ terminalId: "term-promoted" })),
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
  await writeFile(cand.sessionFile!, "{}\n");
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
  return journalPayloads().map((journal) => journal.paths?.length ?? 0);
}

function journalPayloads(): Array<{ paths?: Array<{ rel?: string; beforeState?: { type?: string }; beforeImageIdentity?: unknown; beforeImageSize?: unknown }> }> {
  const payloads: Array<{ paths?: Array<{ rel?: string; beforeState?: { type?: string }; beforeImageIdentity?: unknown; beforeImageSize?: unknown }> }> = [];
  for (const call of mockWriteFile.mock.calls) {
    const args = call[0] as { components?: string[]; content?: Buffer };
    if (!args.components?.includes("journal.json") || !args.content) continue;
    payloads.push(JSON.parse(args.content.toString("utf8")) as { paths?: Array<{ rel?: string; beforeState?: { type?: string }; beforeImageIdentity?: unknown; beforeImageSize?: unknown }> });
  }
  return payloads;
}

/** Every checkpoint must carry complete crash-rollback inputs. */
function expectCompletePayloads(): void {
  for (const journal of journalPayloads()) {
    for (const p of journal.paths ?? []) {
      if (p.beforeState?.type === "file") {
        expect(p.beforeImageIdentity, `missing before-image identity for ${p.rel}`).toBeDefined();
        expect(p.beforeImageSize, `missing before-image size for ${p.rel}`).toBeDefined();
      }
    }
  }
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

describe("bounded journal checkpoints (issue #178)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists a 250-path promotion in bounded checkpoint writes", async () => {
    const changes = Array.from({ length: 250 }, (_, i) => ({ relPath: `f-${String(i).padStart(3, "0")}.txt`, status: "modified" as const }));
    const fx = await makeFixture({
      changes,
      primaryPaths: ["touched.txt", "other.txt", ...changes.map((c) => c.relPath)],
      mergedPaths: ["touched.txt", "other.txt", ...changes.map((c) => c.relPath)],
      materialize: async (dir) => {
        await writeFile(join(dir, "touched.txt"), "new\n");
        for (const c of changes) await writeFile(join(dir, c.relPath), "merged\n");
      },
    });
    try {
      for (const c of changes) await writeFile(join(fx.primaryRoot, c.relPath), "old\n");
      const result = await fx.manager.promote(fx.comparisonId, "A", true);
      expect(result).toEqual({ ok: true, terminalId: "term-promoted" });
      // Initial, two periodic checkpoints, the gather tail, then transitions.
      const counts = journalPathCounts();
      expect(counts.slice(0, 4)).toEqual([0, 100, 200, 250]);
      expect(counts.slice(4).every((n) => n === 250)).toBe(true);
      expect(counts.length).toBeLessThanOrEqual(15);
      expectCompletePayloads();
      expect(mockCopyFile).toHaveBeenCalledTimes(250);
      expect(await readFile(join(fx.primaryRoot, "f-000.txt"), "utf8")).toBe("merged\n");
    } finally {
      await fx.manager.dispose();
      await rm(fx.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("interrupted gather checkpoints the complete prefix and leaves primary intact", async () => {
    const changes = Array.from({ length: 150 }, (_, i) => ({ relPath: `g-${String(i).padStart(3, "0")}.txt`, status: "modified" as const }));
    const missing = changes[changes.length - 1]!.relPath;
    const fx = await makeFixture({
      changes,
      primaryPaths: ["touched.txt", "other.txt", ...changes.map((c) => c.relPath)],
      mergedPaths: ["touched.txt", "other.txt", ...changes.map((c) => c.relPath)],
      materialize: async (dir) => {
        for (const c of changes) {
          if (c.relPath === missing) continue;
          await writeFile(join(dir, c.relPath), "merged\n");
        }
      },
    });
    try {
      for (const c of changes) await writeFile(join(fx.primaryRoot, c.relPath), "old\n");
      const result = await fx.manager.promote(fx.comparisonId, "A", true);
      expect(result.ok).toBe(false);
      expect(result.error ?? "").toMatch(/unsupported filesystem object/);
      // The periodic checkpoint plus the on-error checkpoint of the complete prefix.
      expect(journalPathCounts().slice(0, 3)).toEqual([0, 100, 149]);
      expectCompletePayloads();
      expect(mockCopyFile).toHaveBeenCalledTimes(149);
      // Nothing was ever applied: every primary file keeps its bytes.
      for (const c of changes) {
        expect(await readFile(join(fx.primaryRoot, c.relPath), "utf8")).toBe("old\n");
      }
      const cmp = (fx.manager as unknown as { comparisons: Map<string, ComparisonState> }).comparisons.get(fx.comparisonId)!;
      expect(cmp.candidates.get("A")!.state).toBe("ready");
    } finally {
      await fx.manager.dispose();
      await rm(fx.root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("candidate apply fence (issue #199)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails closed when the candidate moves after capture, before any apply", async () => {
    let candidateMoved = false;
    const fx = await makeFixture({
      changes: [{ relPath: "touched.txt", status: "modified" }],
      primaryPaths: ["touched.txt", "other.txt"],
      mergedPaths: ["touched.txt", "other.txt"],
      materialize: async (dir) => {
        await writeFile(join(dir, "touched.txt"), "new\n");
      },
      workspaceAt: async (wsRoot: string) => {
        if (wsRoot === fx.primaryRoot) return { id: "ws-primary", generation: 7, lastStateCommit: "p0" };
        if (wsRoot === fx.candRoot) return { id: "ws-cand", generation: candidateMoved ? 4 : 3, lastStateCommit: "c0" };
        return null;
      },
    });
    // Flip the candidate generation once gather completes (phase-anchored:
    // the first journal write carrying the path), so entry and preflight
    // still see the pinned generation.
    const baseImpl = mockWriteFile.getMockImplementation()!;
    mockWriteFile.mockImplementation(async (args) => {
      const result = await baseImpl(args);
      const components = (args as { components?: string[] }).components ?? [];
      const content = (args as { content?: Buffer }).content;
      if (components.includes("journal.json") && content) {
        const journal = JSON.parse(content.toString("utf8")) as { paths?: unknown[] };
        if ((journal.paths?.length ?? 0) >= 1) candidateMoved = true;
      }
      return result;
    });
    try {
      const result = await fx.manager.promote(fx.comparisonId, "A", true);
      expect(result.ok).toBe(false);
      expect(result.error ?? "").toBe("the candidate changed during promotion apply");
      // Nothing applied: the primary keeps its bytes and the pair stays usable.
      expect(await readFile(join(fx.primaryRoot, "touched.txt"), "utf8")).toBe("old\n");
      const cmp = (fx.manager as unknown as { comparisons: Map<string, ComparisonState> }).comparisons.get(fx.comparisonId)!;
      expect(cmp.candidates.get("A")!.state).toBe("ready");
    } finally {
      mockWriteFile.mockImplementation(baseImpl);
      await fx.manager.dispose();
      await rm(fx.root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("promotion journal cleanup paths (issue #202)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function journalsOf(fx: PromoteFixture): Promise<string[]> {
    try {
      return await readdir(join(fx.worldsRoot, "promotion-journal"));
    } catch {
      return [];
    }
  }

  it("askConfirm removes its journal and leaves the pair usable", async () => {
    const fx = await makeFixture({
      changes: [{ relPath: "touched.txt", status: "modified" }],
      primaryPaths: ["touched.txt", "other.txt"],
      mergedPaths: ["touched.txt", "other.txt"],
      materialize: async (dir) => {
        await writeFile(join(dir, "touched.txt"), "new\n");
      },
    });
    try {
      const result = await fx.manager.promote(fx.comparisonId, "A");
      expect(result.ok).toBe(false);
      expect(result.confirm ?? "").toMatch(/without current passing evidence/);
      expect(await journalsOf(fx)).toEqual([]);
      const cmp = (fx.manager as unknown as { comparisons: Map<string, ComparisonState> }).comparisons.get(fx.comparisonId)!;
      expect(cmp.candidates.get("A")!.state).toBe("ready");
    } finally {
      await fx.manager.dispose();
      await rm(fx.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("a failed snapshot refresh removes its journal and reports the terminal", async () => {
    const fx = await makeFixture({
      changes: [{ relPath: "touched.txt", status: "modified" }],
      primaryPaths: ["touched.txt", "other.txt"],
      mergedPaths: ["touched.txt", "other.txt"],
      materialize: async (dir) => {
        await writeFile(join(dir, "touched.txt"), "new\n");
      },
      captureImpl: async (_head: string, parent: string | null) => {
        if (parent === "p") throw new Error("snapshot store unavailable");
        return parent === "base" ? { commit: "w", tree: "w" } : { commit: "p", tree: "p" };
      },
    });
    try {
      const result = await fx.manager.promote(fx.comparisonId, "A", true);
      expect(result.ok).toBe(false);
      expect(result.error ?? "").toMatch(/snapshot was not refreshed/);
      expect(result.terminalId).toBe("term-promoted");
      expect(await readFile(join(fx.primaryRoot, "touched.txt"), "utf8")).toBe("new\n");
      expect(await journalsOf(fx)).toEqual([]);
    } finally {
      await fx.manager.dispose();
      await rm(fx.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("a failed session open removes its journal through the done-phase catch", async () => {
    const fx = await makeFixture({
      changes: [{ relPath: "touched.txt", status: "modified" }],
      primaryPaths: ["touched.txt", "other.txt"],
      mergedPaths: ["touched.txt", "other.txt"],
      materialize: async (dir) => {
        await writeFile(join(dir, "touched.txt"), "new\n");
      },
      installPromoted: async () => {
        throw new Error("no terminal available");
      },
    });
    try {
      const result = await fx.manager.promote(fx.comparisonId, "A", true);
      expect(result.ok).toBe(false);
      expect(result.error ?? "").toMatch(/the new session did not open/);
      expect(await readFile(join(fx.primaryRoot, "touched.txt"), "utf8")).toBe("new\n");
      expect(await journalsOf(fx)).toEqual([]);
    } finally {
      await fx.manager.dispose();
      await rm(fx.root, { recursive: true, force: true });
    }
  }, 60_000);
});
