import { afterAll, describe, it, expect, vi, beforeEach } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../../electron/worldline-git.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../electron/worldline-git.ts")>();
  return {
    ...actual,
    boundPromotionCopyFile: vi.fn((args: Parameters<typeof actual.boundPromotionCopyFile>[0]) => actual.boundPromotionCopyFile(args)),
    boundPromotionCopyTree: vi.fn((args: Parameters<typeof actual.boundPromotionCopyTree>[0]) => actual.boundPromotionCopyTree(args)),
  };
});

import {
  WorldlineManager,
  disposeWorldlineCoreClient,
  ensurePromotionRoots,
  type RunRecord,
} from "../../../electron/worldlines/index.ts";
import { ensureBoundChildDirectory, ensureBoundDirectory } from "../../../electron/worldlines/promotion-recovery/bound-dirs.ts";
import type { CandidateState, ComparisonState } from "../../../electron/worldlines/types.ts";
import { boundPromotionCopyFile, boundPromotionCopyTree } from "../../../electron/worldline-git.ts";

const mockCopyFile = vi.mocked(boundPromotionCopyFile);
const mockCopyTree = vi.mocked(boundPromotionCopyTree);

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-payload",
    terminalId: "term-1",
    workspaceId: "ws-1",
    startStateId: "state-start",
    settledStateId: "state-settled",
    promptPayloadFile: null,
    promptEventsDir: null,
    promptText: null,
    promptEntryId: null,
    promptParentEntryId: null,
    settledEntryId: null,
    sessionFile: null,
    sessionBranchFile: "branch.bundle",
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
    trustHashes: { "agent/settings.json": "aaa" },
    engine: "core",
    ...overrides,
  };
}

async function makeManager(): Promise<{ manager: WorldlineManager; root: string; worldsRoot: string; primaryRoot: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "termina-copy-payload-")));
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
    getStore: async () => ({ sourceRoot: primaryRoot, sourceGitDir: join(primaryRoot, ".git") }) as never,
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
    trustHashes: async () => ({ "agent/settings.json": "aaa" }),
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
  return { manager, root, worldsRoot, primaryRoot };
}

async function boundCandidateHome(
  worldsRoot: string,
  root: string,
): Promise<{ cmp: ComparisonState; homeA: string }> {
  const worldsBinding = await ensureBoundDirectory(worldsRoot, "worlds root");
  const cmpBinding = await ensureBoundChildDirectory(worldsBinding, "cmp-247", true);
  const mkCand = async (label: "A" | "B"): Promise<CandidateState> => {
    const support = await ensureBoundChildDirectory(cmpBinding, `${label}-support`, true);
    const home = await ensureBoundChildDirectory(support, "home", true);
    return {
      label,
      role: label === "A" ? "reference" : "alternative",
      dir: join(cmpBinding.path, label),
      supportDir: support.path,
      homeDir: home.path,
      sessionDir: join(support.path, "sessions"),
      eventsDir: join(support.path, "events"),
      tmpDir: join(support.path, "tmp"),
      cacheDir: join(support.path, "cache"),
      profilePath: join(cmpBinding.path, "profiles", `${label}.sb`),
      sessionFile: join(root, "session.json"),
      comparisonBaseStateId: "base",
      promotionBaseStateId: "base",
      headStateId: null,
      headCommit: Promise.resolve(),
      terminalId: null,
      pid: null,
      lstart: null,
      state: "settled",
      version: 1,
      error: null,
      homeBinding: home,
      supportBinding: support,
    };
  };
  const a = await mkCand("A");
  const b = await mkCand("B");
  const cmp = {
    id: "cmp-247",
    dir: cmpBinding.path,
    rootBinding: cmpBinding,
    candidates: new Map([["A", a], ["B", b]]),
  } as unknown as ComparisonState;
  return { cmp, homeA: a.homeDir };
}

describe("candidate resource copy (issue #247)", () => {
  beforeEach(() => {
    mockCopyFile.mockClear();
    mockCopyTree.mockClear();
  });

  afterAll(() => {
    disposeWorldlineCoreClient();
  });

  it("skips absent auth.json and still completes the copy", async () => {
    const { manager, root, worldsRoot } = await makeManager();
    try {
      const { cmp, homeA } = await boundCandidateHome(worldsRoot, root);
      await (manager as unknown as { copyCoreResources: (c: ComparisonState) => Promise<void> }).copyCoreResources(cmp);
      await expect(readFile(join(homeA, ".termina", "agent", "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("copies a present auth.json into the candidate home", async () => {
    const { manager, root, worldsRoot } = await makeManager();
    try {
      const agentDir = join(root, ".termina", "agent");
      await mkdir(agentDir, { recursive: true });
      const src = join(agentDir, "auth.json");
      await writeFile(src, '{"ok":true}\n', { mode: 0o600 });
      await chmod(src, 0o600);
      const { cmp, homeA } = await boundCandidateHome(worldsRoot, root);
      await (manager as unknown as { copyCoreResources: (c: ComparisonState) => Promise<void> }).copyCoreResources(cmp);
      expect(await readFile(join(homeA, ".termina", "agent", "auth.json"), "utf8")).toBe('{"ok":true}\n');
    } finally {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails the copy when a present auth.json cannot be written", async () => {
    const { manager, root, worldsRoot } = await makeManager();
    mockCopyFile.mockRejectedValueOnce(new Error("bound copy failed: disk full"));
    try {
      const agentDir = join(root, ".termina", "agent");
      await mkdir(agentDir, { recursive: true });
      const src = join(agentDir, "auth.json");
      await writeFile(src, '{"ok":true}\n', { mode: 0o600 });
      await chmod(src, 0o600);
      const { cmp } = await boundCandidateHome(worldsRoot, root);
      await expect(
        (manager as unknown as { copyCoreResources: (c: ComparisonState) => Promise<void> }).copyCoreResources(cmp),
      ).rejects.toThrow(/could not copy auth\.json into candidate A/);
    } finally {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails the copy when present user skills cannot be written", async () => {
    const { manager, root, worldsRoot } = await makeManager();
    mockCopyTree.mockRejectedValueOnce(new Error("bound tree copy failed"));
    try {
      const agents = join(root, ".agents");
      await mkdir(agents, { recursive: true });
      const skill = join(agents, "skill.md");
      await writeFile(skill, "skill\n", { mode: 0o600 });
      await chmod(skill, 0o600);
      const { cmp } = await boundCandidateHome(worldsRoot, root);
      await expect(
        (manager as unknown as { copyCoreResources: (c: ComparisonState) => Promise<void> }).copyCoreResources(cmp),
      ).rejects.toThrow(/could not copy user skills into candidate A/);
    } finally {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("prompt payload gates (issue #248)", () => {
  afterAll(() => {
    disposeWorldlineCoreClient();
  });

  it("treats a missing payload file as absent, not unreadable", async () => {
    const { manager, root } = await makeManager();
    try {
      const read = await (manager as unknown as {
        readPromptPayload: (run: { promptPayloadFile: string | null }) => Promise<{ kind: string }>;
      }).readPromptPayload({ promptPayloadFile: null });
      expect(read).toEqual({ kind: "absent" });
    } finally {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses forkRun and challenge when a captured payload is malformed", async () => {
    const { manager, root } = await makeManager();
    try {
      await writeFile(join(root, "payload.json"), "{oops");
      manager.recordRun(makeRun({ promptPayloadFile: "payload.json", promptEventsDir: root }));
      const forked = await manager.forkRun("run-payload");
      expect(forked).toEqual({ ok: false, error: "the prompt payload is unreadable" });
      const challenged = await manager.challenge("run-payload", "preserve-api");
      expect(challenged).toEqual({ ok: false, error: "the prompt payload is unreadable" });
    } finally {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses challengeFromCandidate before launch when the payload cannot be parsed", async () => {
    const { manager, root } = await makeManager();
    try {
      await writeFile(join(root, "payload.json"), "{oops");
      manager.recordRun(makeRun({ id: "run-challenge", promptPayloadFile: "payload.json", promptEventsDir: root }));
      (manager as unknown as { comparisons: Map<string, ComparisonState> }).comparisons.set("cmp-live", {
        id: "cmp-live",
        phase: "running",
        engine: "core",
        baseStateId: "base",
        sourceRunId: "run-challenge",
        teardownPromise: null,
        candidates: new Map([
          ["A", { label: "A", role: "reference", sessionFile: join(root, "session.json"), state: "settled", headCommit: Promise.resolve() }],
        ]),
      } as unknown as ComparisonState);
      const result = await manager.challengeFromCandidate("cmp-live", "A", "preserve-api");
      expect(result).toEqual({ ok: false, error: "the prompt payload is unreadable" });
    } finally {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets a plain fork treat a missing payload as empty prefill at the gate", async () => {
    const { manager, root } = await makeManager();
    try {
      manager.recordRun(makeRun({ promptPayloadFile: null }));
      const result = await manager.forkRun("run-payload");
      expect(result.ok).toBe(false);
      expect(result.error).not.toBe("the prompt payload is unreadable");
      expect(result.error).not.toBe("the run has no captured task to replay");
    } finally {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("challenge still requires a captured task field", async () => {
    const { manager, root } = await makeManager();
    try {
      manager.recordRun(makeRun({ promptPayloadFile: null }));
      const result = await manager.challenge("run-payload", "preserve-api");
      expect(result).toEqual({ ok: false, error: "the run has no captured task to replay" });
    } finally {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("startup controls use the parsed payload instead of rereading the file", async () => {
    const { manager, root } = await makeManager();
    try {
      const writes: Array<Record<string, unknown>> = [];
      (manager as unknown as { writeControl: (cand: unknown, control: Record<string, unknown>) => Promise<void> }).writeControl =
        async (_cand, control) => {
          writes.push(control);
        };
      const cmp = {
        candidates: new Map([
          ["A", { label: "A" }],
          ["B", { label: "B" }],
        ]),
      } as unknown as ComparisonState;
      await (manager as unknown as {
        writeStartupControls: (c: ComparisonState, payload: { text: string; images: unknown[]; context: string }, profile?: string) => Promise<void>;
      }).writeStartupControls(cmp, { text: "ship it", images: [], context: "" }, "preserve-api");
      expect(writes[1]?.action).toBe("structured");
      const content = writes[1]?.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toContain("ship it");
      expect(content[0]?.text).toContain("Challenge constraint (preserve-api)");
      writes.length = 0;
      await (manager as unknown as {
        writeStartupControls: (c: ComparisonState, payload: { text: string; images: unknown[]; context: string }) => Promise<void>;
      }).writeStartupControls(cmp, { text: "", images: [], context: "" });
      expect(writes[1]).toMatchObject({ action: "prefill", text: "" });
    } finally {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
