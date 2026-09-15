import { afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const copyMocks = vi.hoisted(() => ({
  copyBoundPrivateFile: vi.fn(async () => {}),
  ensureBoundChildDirectory: vi.fn(async (parent: { path: string; dev: string; ino: string; capability?: string }, name: string) => ({
    path: join(parent.path, name),
    dev: parent.dev,
    ino: parent.ino,
    capability: parent.capability,
  })),
  boundPromotionOpenDirectory: vi.fn(async (): Promise<{ dev: string; ino: string; capability?: string }> => {
    const error = new Error("ENOENT") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  }),
  boundPromotionCopyTree: vi.fn(async () => {}),
}));

vi.mock("../../../electron/worldlines/promotion-recovery.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../electron/worldlines/promotion-recovery.ts")>();
  return {
    ...actual,
    copyBoundPrivateFile: copyMocks.copyBoundPrivateFile,
    ensureBoundChildDirectory: copyMocks.ensureBoundChildDirectory,
  };
});

vi.mock("../../../electron/worldline-git.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../electron/worldline-git.ts")>();
  return {
    ...actual,
    boundPromotionOpenDirectory: copyMocks.boundPromotionOpenDirectory,
    boundPromotionCopyTree: copyMocks.boundPromotionCopyTree,
  };
});

import {
  WorldlineManager,
  disposeWorldlineGitCore,
  type RunRecord,
} from "../../../electron/worldlines/index.ts";
import type { BoundPromotionDirectory, CandidateState, ComparisonState } from "../../../electron/worldlines/types.ts";

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

async function makeManager(): Promise<{ manager: WorldlineManager; root: string; ready: Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "termina-copy-payload-"));
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
    terminalLive: () => true,
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
  const ready = (manager as unknown as { ready: Promise<void> }).ready;
  ready.catch(() => undefined);
  (manager as unknown as { ready: Promise<void> }).ready = Promise.resolve();
  return { manager, root, ready };
}

function fakeBinding(path: string): BoundPromotionDirectory {
  return { path, dev: "1", ino: "1" };
}

function comparisonWithHome(root: string): ComparisonState {
  const home = fakeBinding(join(root, "A-home"));
  const cand = {
    label: "A",
    role: "reference",
    dir: join(root, "A"),
    supportDir: join(root, "A-support"),
    homeDir: home.path,
    sessionDir: join(root, "sessions"),
    eventsDir: join(root, "events"),
    tmpDir: join(root, "tmp"),
    cacheDir: join(root, "cache"),
    profilePath: join(root, "A.sb"),
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
  } as CandidateState;
  return {
    id: "cmp-247",
    dir: root,
    candidates: new Map([["A", cand]]),
  } as unknown as ComparisonState;
}

describe("candidate resource copy (issue #247)", () => {
  beforeEach(() => {
    copyMocks.copyBoundPrivateFile.mockReset();
    copyMocks.copyBoundPrivateFile.mockResolvedValue(undefined);
    copyMocks.ensureBoundChildDirectory.mockClear();
    copyMocks.boundPromotionCopyTree.mockReset();
    copyMocks.boundPromotionCopyTree.mockResolvedValue(undefined);
    copyMocks.boundPromotionOpenDirectory.mockReset();
    copyMocks.boundPromotionOpenDirectory.mockImplementation(async (): Promise<{ dev: string; ino: string; capability?: string }> => {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    });
  });

  it("skips absent auth.json and does not copy", async () => {
    const { manager, root, ready } = await makeManager();
    try {
      await (manager as unknown as { copyCoreResources: (c: ComparisonState) => Promise<void> })
        .copyCoreResources(comparisonWithHome(root));
      expect(copyMocks.copyBoundPrivateFile).not.toHaveBeenCalled();
    } finally {
      await ready.catch(() => {});
      await manager.dispose().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it("copies a present auth.json through the bound writer", async () => {
    const { manager, root, ready } = await makeManager();
    try {
      const agentDir = join(root, ".termina", "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "auth.json"), '{"ok":true}\n', { mode: 0o600 });
      await (manager as unknown as { copyCoreResources: (c: ComparisonState) => Promise<void> })
        .copyCoreResources(comparisonWithHome(root));
      expect(copyMocks.copyBoundPrivateFile).toHaveBeenCalledWith(
        join(root, ".termina", "agent", "auth.json"),
        expect.objectContaining({ path: expect.stringContaining(".termina/agent") }),
        "auth.json",
      );
    } finally {
      await ready.catch(() => {});
      await manager.dispose().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails the copy when a present auth.json cannot be written", async () => {
    const { manager, root, ready } = await makeManager();
    copyMocks.copyBoundPrivateFile.mockRejectedValue(new Error("bound copy failed: disk full"));
    try {
      const agentDir = join(root, ".termina", "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "auth.json"), '{"ok":true}\n', { mode: 0o600 });
      await expect(
        (manager as unknown as { copyCoreResources: (c: ComparisonState) => Promise<void> })
          .copyCoreResources(comparisonWithHome(root)),
      ).rejects.toThrow(/could not copy auth\.json into candidate A/);
    } finally {
      await ready.catch(() => {});
      await manager.dispose().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails the copy when present user skills cannot be written", async () => {
    const { manager, root, ready } = await makeManager();
    copyMocks.boundPromotionOpenDirectory.mockResolvedValue({ dev: "1", ino: "2", capability: "cap" });
    copyMocks.boundPromotionCopyTree.mockRejectedValue(new Error("bound tree copy failed"));
    try {
      await mkdir(join(root, ".agents"), { recursive: true });
      await expect(
        (manager as unknown as { copyCoreResources: (c: ComparisonState) => Promise<void> })
          .copyCoreResources(comparisonWithHome(root)),
      ).rejects.toThrow(/could not copy user skills into candidate A/);
    } finally {
      await ready.catch(() => {});
      await manager.dispose().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("prompt payload gates (issue #248)", () => {
  afterAll(() => {
    disposeWorldlineGitCore();
  });

  it("treats a missing payload file as absent, not unreadable", async () => {
    const { manager, root, ready } = await makeManager();
    try {
      const read = await (manager as unknown as {
        readPromptPayload: (run: { promptPayloadFile: string | null }) => Promise<{ kind: string }>;
      }).readPromptPayload({ promptPayloadFile: null });
      expect(read).toEqual({ kind: "absent" });
    } finally {
      await ready.catch(() => {});
      await manager.dispose().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses forkRun and challenge when a captured payload is malformed", async () => {
    const { manager, root, ready } = await makeManager();
    try {
      await writeFile(join(root, "payload.json"), "{oops");
      manager.recordRun(makeRun({ promptPayloadFile: "payload.json", promptEventsDir: root }));
      const forked = await manager.forkRun("run-payload");
      expect(forked).toEqual({ ok: false, error: "the prompt payload is unreadable" });
      const challenged = await manager.challenge("run-payload", "preserve-api");
      expect(challenged).toEqual({ ok: false, error: "the prompt payload is unreadable" });
    } finally {
      await ready.catch(() => {});
      await manager.dispose().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses challengeFromCandidate before launch when the payload cannot be parsed", async () => {
    const { manager, root, ready } = await makeManager();
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
      await ready.catch(() => {});
      await manager.dispose().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets a plain fork treat a missing payload as empty prefill at the gate", async () => {
    const { manager, root, ready } = await makeManager();
    try {
      manager.recordRun(makeRun({ promptPayloadFile: null }));
      const result = await manager.forkRun("run-payload");
      expect(result.ok).toBe(false);
      expect(result.error).not.toBe("the prompt payload is unreadable");
      expect(result.error).not.toBe("the run has no captured task to replay");
    } finally {
      await ready.catch(() => {});
      await manager.dispose().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it("challenge still requires a captured task field", async () => {
    const { manager, root, ready } = await makeManager();
    try {
      manager.recordRun(makeRun({ promptPayloadFile: null }));
      const result = await manager.challenge("run-payload", "preserve-api");
      expect(result).toEqual({ ok: false, error: "the run has no captured task to replay" });
    } finally {
      await ready.catch(() => {});
      await manager.dispose().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it("startup controls use the parsed payload instead of rereading the file", async () => {
    const { manager, root, ready } = await makeManager();
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
      await ready.catch(() => {});
      await manager.dispose().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });
});
