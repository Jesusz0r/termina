import { describe, it, expect, vi } from "vitest";
import { lstat, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

vi.mock("../../../electron/sandbox.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../electron/sandbox.ts")>();
  return {
    ...actual,
    // The spawn tail is darwin-only; the env under test is built before it.
    candidateSandboxLaunch: vi.fn(() => ({ cmd: "stub", args: ["stub"] })),
  };
});
import { WorldlineManager, ensurePromotionRoots } from "../../../electron/worldlines/index.ts";
import { ensureBoundChildDirectory, ensureBoundDirectory } from "../../../electron/worldlines/promotion-recovery/bound-dirs.ts";
import type { CandidateState, ComparisonState } from "../../../electron/worldlines/types.ts";

type LaunchResult = { cmd: string; args: string[]; env: Record<string, string | undefined> };

async function setup(model: string | null, thinkingLevel: string | null): Promise<{
  manager: WorldlineManager;
  cmp: ComparisonState;
  cand: CandidateState;
  root: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "termina-candidate-env-")));
  const worldsRoot = join(root, "worlds");
  const primaryRoot = join(root, "primary");
  await ensurePromotionRoots(worldsRoot, primaryRoot);
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
    getStore: async () => null,
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
    captureHead: async () => ({ commit: "", tree: "" }),
    capturePrimary: async () => null,
    releaseState: async () => {},
    terminalBusy: () => false,
    terminalVerifying: () => false,
    workspaceAt: async () => null,
    acquireWriteLease: async () => ({ ok: false, error: "unused" }),
    releaseWriteLease: () => {},
    flushDirtyModels: async () => ({ ok: false }),
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
    installPromoted: async () => ({ terminalId: "unused" }),
  });
  await (manager as unknown as { ready: Promise<void> }).ready;

  const worldsBinding = await ensureBoundDirectory(worldsRoot, "worlds root");
  const profilesBinding = await ensureBoundChildDirectory(worldsBinding, "profiles", true);
  const sessionFile = join(root, "sessions", "core-test1", "current", "session.jsonl");
  await mkdir(dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, "{}\n");

  const cmpDir = join(worldsRoot, "cmp-197");
  await mkdir(cmpDir, { recursive: true });
  const cand = {
    label: "B",
    dir: join(cmpDir, "B"),
    supportDir: join(cmpDir, "B-support"),
    homeDir: join(cmpDir, "B-support", "home"),
    sessionDir: join(cmpDir, "B-support", "sessions"),
    eventsDir: join(cmpDir, "B-support", "events"),
    tmpDir: join(cmpDir, "B-support", "tmp"),
    cacheDir: join(cmpDir, "B-support", "cache"),
    profilePath: join(cmpDir, "profiles", "B.sb"),
    sessionFile,
  } as CandidateState;
  const sibling = { label: "A", dir: join(cmpDir, "A") } as CandidateState;
  const cmp = {
    model,
    thinkingLevel,
    engine: "core",
    candidates: new Map([["A", sibling], ["B", cand]]),
    profilesBinding,
    templateDir: join(root, "template"),
    primaryRoot,
    sourceGitDir: join(primaryRoot, ".git"),
  } as unknown as ComparisonState;
  return { manager, cmp, cand, root };
}

describe("candidate launch env (issue #197)", () => {
  it("sets TERMINA_CORE_EFFORT from the recorded thinking level", async () => {
    const { manager, cmp, cand, root } = await setup("test/model", "high");
    try {
      const launch = await (manager as unknown as { candidateLaunch: (c: ComparisonState, d: CandidateState) => Promise<LaunchResult> })
        .candidateLaunch(cmp, cand);
      expect(launch.env.TERMINA_CORE_EFFORT).toBe("high");
      expect(launch.env.TERMINA_CORE_PROVIDER).toBe("test");
      expect(launch.env.TERMINA_CORE_MODEL).toBe("model");
      expect(launch.env.TERMINA_WORLDLINE_CANDIDATE).toBe("1");
      expect(launch.args).not.toContain("--thinking");
      expect(launch.args).not.toContain("--model");
    } finally {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("omits effort and provider-qualified model when unrecorded", async () => {
    const { manager, cmp, cand, root } = await setup("bare", null);
    try {
      const launch = await (manager as unknown as { candidateLaunch: (c: ComparisonState, d: CandidateState) => Promise<LaunchResult> })
        .candidateLaunch(cmp, cand);
      expect("TERMINA_CORE_EFFORT" in launch.env).toBe(false);
      expect("TERMINA_CORE_PROVIDER" in launch.env).toBe(false);
      expect("TERMINA_CORE_MODEL" in launch.env).toBe(false);
    } finally {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports git modes from fileOf (issue #193)", async () => {
    const { manager, root } = await setup(null, null);
    try {
      const candDir = join(root, "files");
      await mkdir(candDir, { recursive: true });
      await writeFile(join(candDir, "tool.sh"), "x\n", { mode: 0o755 });
      await writeFile(join(candDir, "plain.txt"), "x\n", { mode: 0o644 });
      (manager as unknown as { comparisons: Map<string, ComparisonState> }).comparisons.set("cmp-mode", {
        candidates: new Map([["A", { dir: candDir }]]),
      } as unknown as ComparisonState);
      expect(await manager.fileOf("cmp-mode", "A", "tool.sh")).toMatchObject({ ok: true, mode: "100755" });
      expect(await manager.fileOf("cmp-mode", "A", "plain.txt")).toMatchObject({ ok: true, mode: "100644" });
    } finally {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
