import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const listMocks = vi.hoisted(() => ({
  gitIgnoredFiles: vi.fn(async (): Promise<string[]> => {
    throw new Error("ignored list failed");
  }),
  gitCommitFile: vi.fn(async () => null),
  changedFiles: vi.fn(async () => ({
    files: [],
    sourceFiles: 0,
    sourceBytes: 0,
    truncated: false,
    total: 0,
  })),
}));

vi.mock("../../../electron/worldline-git.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../electron/worldline-git.ts")>();
  return {
    ...actual,
    gitIgnoredFiles: listMocks.gitIgnoredFiles,
    gitCommitFile: listMocks.gitCommitFile,
  };
});

vi.mock("../../../electron/worldlines/candidate-files.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../electron/worldlines/candidate-files.ts")>();
  return {
    ...actual,
    changedFiles: listMocks.changedFiles,
  };
});

import { WorldlineManager } from "../../../electron/worldlines/index.ts";
import type { CandidateState, ComparisonState, RunRecord } from "../../../electron/worldlines/types.ts";

const managerSrc = readFileSync(new URL("../../../electron/worldlines/manager.ts", import.meta.url), "utf8");

async function makeManager(opts?: {
  capturePrimary?: () => Promise<string | null>;
  getStore?: () => Promise<{ merge3: (a: string, b: string) => Promise<{ ok: boolean; tree?: string; conflicts?: string[]; reason?: string }> } | null>;
}): Promise<{ manager: WorldlineManager; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "termina-honest-details-"));
  const worldsRoot = join(root, "worlds");
  const primaryRoot = join(root, "primary");
  await mkdir(worldsRoot, { recursive: true });
  await mkdir(primaryRoot, { recursive: true });
  const manager = new WorldlineManager({
    worldsRoot,
    primaryRoot,
    primaryRootIdentity: { dev: "1", ino: "1" },
    realHome: root,
    userData: root,
    primaryEventsDir: root,
    agentCorePath: join(root, "agent-core.mjs"),
    electronExecPath: process.execPath,
    candidateEnv: () => ({}),
    showThinking: () => false,
    getStore: opts?.getStore ?? (async () => null),
    appReadPaths: () => [],
    forkCoreSession: async () => ({ ok: false, sessionFile: "", commit: "uncertain", error: "unused" }),
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
    captureHead: async () => ({ commit: "head", tree: "tree" }),
    capturePrimary: opts?.capturePrimary ?? (async () => null),
    releaseState: async () => {},
    terminalBusy: () => false,
    terminalVerifying: () => false,
    workspaceAt: async () => null,
    acquireWriteLease: async () => ({ ok: false, error: "unused" }),
    releaseWriteLease: () => {},
    flushDirtyModels: async () => ({ ok: false }),
    canonicalPath: async (p: string) => p,
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
    installPromoted: async () => ({ terminalId: "unused" }),
  } as never);
  (manager as unknown as { ready: Promise<void> }).ready = Promise.resolve();
  return { manager, root };
}

function injectComparison(manager: WorldlineManager, root: string, version = 4): ComparisonState {
  const cand = {
    label: "A",
    role: "reference",
    dir: join(root, "A"),
    supportDir: join(root, "A-support"),
    homeDir: join(root, "A-home"),
    sessionDir: join(root, "sessions"),
    eventsDir: join(root, "events"),
    tmpDir: join(root, "tmp"),
    cacheDir: join(root, "cache"),
    profilePath: join(root, "A.sb"),
    sessionFile: join(root, "session.json"),
    comparisonBaseStateId: "base",
    promotionBaseStateId: "base",
    headStateId: "head",
    headCommit: Promise.resolve(),
    terminalId: null,
    pid: null,
    lstart: null,
    state: "settled",
    version,
    error: null,
  } as CandidateState;
  const cmp = {
    id: "cmp-1",
    dir: root,
    sourceRunId: "run-1",
    baseCommit: "base-commit",
    baseStateId: "base-state",
    createdAt: Date.now(),
    model: null,
    thinkingLevel: null,
    candidates: new Map([["A", cand]]),
  } as unknown as ComparisonState;
  (manager as unknown as { comparisons: Map<string, ComparisonState> }).comparisons.set("cmp-1", cmp);
  return cmp;
}

describe("worldline honest details / silent degradation (issues #246 #257 #269)", () => {
  afterEach(() => {
    listMocks.gitIgnoredFiles.mockReset();
    listMocks.gitIgnoredFiles.mockRejectedValue(new Error("ignored list failed"));
    listMocks.gitCommitFile.mockReset();
    listMocks.gitCommitFile.mockResolvedValue(null);
    listMocks.changedFiles.mockClear();
  });

  it("keeps the manager contracts fail-closed and regex-free", () => {
    expect(managerSrc).not.toContain("/* Conflict status can be incomplete. */");
    expect(managerSrc).not.toContain("/already exists/i");
    expect(managerSrc).not.toContain("parseStorageSeq(run.promptParentEntryId) ?? 0");
    expect(managerSrc).toContain("isComparisonDirectoryCollision(error)");
    expect(managerSrc).toContain("requireStorageSeq(run.promptParentEntryId");
    expect(managerSrc).toContain("version: cand.version");
    expect(managerSrc).toContain("could not enumerate excluded files — promote anyway?");
    expect(managerSrc).toMatch(/if \(!manifestInfo\.isFile\(\)[\s\S]*?continue;/);
    expect(managerSrc).not.toMatch(
      /if \(!manifestInfo\.isFile\(\) \|\| manifestInfo\.isSymbolicLink\(\) \|\| manifestInfo\.size > BigInt\(MAX_WORLDLINE_FILE_BYTES\)\) return;/,
    );
  });

  it("returns null ignored writes when the list fails", async () => {
    const { manager, root } = await makeManager();
    try {
      expect(await manager.ignoredWrites("missing", "A")).toEqual({ count: 0, bytes: 0 });
      injectComparison(manager, root);
      expect(await manager.ignoredWrites("cmp-1", "A")).toBeNull();
    } finally {
      await manager.dispose().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("versions details and leaves merge failures unknown, not clean", async () => {
    const { manager, root } = await makeManager({ capturePrimary: async () => null });
    try {
      injectComparison(manager, root, 7);
      const res = await manager.details("cmp-1", "A");
      expect(res.ok).toBe(true);
      expect(res.details?.version).toBe(7);
      expect(res.details?.primaryConflicts).toBeNull();
      expect(res.details?.conflictError).toBe("could not capture the primary");
      expect(res.details?.ignoredFiles).toBeNull();
      expect(res.details?.ignoredBytes).toBeNull();
    } finally {
      await manager.dispose().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records a merge-probe exception instead of an empty conflict list", async () => {
    const { manager, root } = await makeManager({
      capturePrimary: async () => "primary",
      getStore: async () => ({
        merge3: async () => {
          throw new Error("merge3 exploded");
        },
      }),
    });
    try {
      injectComparison(manager, root, 3);
      const res = await manager.details("cmp-1", "A");
      expect(res.ok).toBe(true);
      expect(res.details?.primaryConflicts).toBeNull();
      expect(res.details?.conflictError).toBe("merge3 exploded");
      expect(res.details?.version).toBe(3);
    } finally {
      await manager.dispose().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the alternative session address is missing or zero", async () => {
    const { manager, root } = await makeManager();
    try {
      const cmp = {
        engine: "core",
        candidates: new Map([
          ["A", { sessionDir: join(root, "A") }],
          ["B", { sessionDir: join(root, "B") }],
        ]),
      };
      const run = {
        sessionBranchFile: "branch",
        settledEntryId: "12",
        promptParentEntryId: null,
      } as RunRecord;
      await expect(
        (manager as unknown as { forkCoreSessions: (c: unknown, r: RunRecord) => Promise<void> })
          .forkCoreSessions(cmp, run),
      ).rejects.toThrow(/alternative session address is missing/);
      await expect(
        (manager as unknown as { forkCoreSessions: (c: unknown, r: RunRecord) => Promise<void> })
          .forkCoreSessions(cmp, { ...run, promptParentEntryId: "0" }),
      ).rejects.toThrow(/alternative session address is missing/);
    } finally {
      await manager.dispose().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});
