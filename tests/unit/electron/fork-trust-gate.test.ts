import { describe, it, expect, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { WorldlineManager, disposeWorldlineCoreClient, type RunRecord } from "../../../electron/worldlines/index.ts";
import { decodeTrustHashes } from "../../../electron/worldline-git/core-process.ts";

const BASELINE: Record<string, string> = {
  "agent/settings.json": "aaa",
  "agent/skills/review.md": "bbb",
};

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-trust",
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
    trustHashes: { ...BASELINE },
    engine: "core",
    ...overrides,
  };
}

async function makeManager(trustHashes: () => Promise<Record<string, string>>) {
  const root = await mkdtemp(join(tmpdir(), "termina-fork-trust-"));
  const worldsRoot = join(root, "worlds");
  const primaryRoot = join(root, "primary");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(worldsRoot, { recursive: true });
  await mkdir(primaryRoot, { recursive: true });
  const deps = {
    worldsRoot,
    primaryRoot,
    realHome: root,
    userData: root,
    primaryEventsDir: root,
    agentCorePath: join(root, "agent-core.mjs"),
    electronExecPath: process.execPath,
    candidateEnv: () => ({}),
    showThinking: () => false,
    getStore: async () => ({ sourceRoot: primaryRoot, sourceGitDir: join(primaryRoot, ".git") }),
    appReadPaths: () => [],
    forkCoreSession: async () => ({ ok: false, error: "unused" }),
    discardCoreSession: async () => ({ ok: false, error: "unused" }),
    createCandidate: async () => ({ terminalId: "unused", pid: 0 }),
    createCandidateWorkspace: () => root,
    onUpdate: () => {},
    onCandidateState: () => {},
    onRemoved: () => {},
    preflight: async () => ({ ok: true, reasons: [] as string[] }),
    trustHashes,
    captureHead: async () => ({ commit: "", tree: "" }),
    capturePrimary: async () => null,
    releaseState: async () => {},
    terminalBusy: () => false,
    terminalVerifying: () => false,
    workspaceAt: async () => null,
    acquireWriteLease: async () => ({ ok: false, error: "unused" }),
    releaseWriteLease: () => {},
    flushDirtyModels: async () => ({ ok: false }),
    canonicalPath: async (path: string) => path,
    mineFiles: () => new Set<string>(),
    drainMineUpdates: async () => {},
    runSandboxedEvidence: async () => ({ code: 0, stdout: "", timedOut: false }),
    sourceFilesOf: async () => [],
    createEvidenceHome: async () => root,
    removeEvidenceHome: async () => false,
    detectTestFromState: async () => null,
    benchmarkConfigFrom: async () => null,
    onEvidenceUpdate: () => {},
    onPromotionApply: () => {},
    primarySessionDir: async () => root,
    installPromoted: async () => ({ terminalId: "unused" }),
  };
  const manager = new WorldlineManager(deps as any);
  // The trust gate sits past root binding but never touches it: keep the
  // suite hermetic (no core binary) by marking construction settled. The
  // original ready still rejects in the background without a binary, so
  // observe it to avoid an unhandled rejection.
  ((manager as unknown as { ready: Promise<void> }).ready as Promise<void>).catch(() => undefined);
  (manager as unknown as { ready: Promise<void> }).ready = Promise.resolve();
  return { manager, root };
}

describe("fork trust gate (issue #47)", () => {
  afterAll(() => {
    disposeWorldlineCoreClient();
  });

  it("refuses when a new trust-sensitive path appears after the run", async () => {
    const { manager, root } = await makeManager(async () => ({
      ...BASELINE,
      "agent/skills/added-after-run.md": "ccc",
    }));
    try {
      manager.recordRun(makeRun());
      const result = await manager.forkRun("run-trust");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("trust-sensitive resources changed since the run");
      expect(result.error).toContain("agent/skills/added-after-run.md");
    } finally {
      await manager.dispose().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses when a trust-sensitive path disappears after the run", async () => {
    const { manager, root } = await makeManager(async () => ({
      "agent/settings.json": "aaa",
    }));
    try {
      manager.recordRun(makeRun());
      const result = await manager.forkRun("run-trust");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("trust-sensitive resources changed since the run");
      expect(result.error).toContain("agent/skills/review.md");
    } finally {
      await manager.dispose().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses when the run has no trust baseline", async () => {
    const { manager, root } = await makeManager(async () => ({ ...BASELINE }));
    try {
      manager.recordRun(makeRun({ trustHashes: null }));
      const result = await manager.forkRun("run-trust");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("the run has no complete trust-sensitive baseline");
    } finally {
      await manager.dispose().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses cleanly when the fork-time re-hash fails", async () => {
    const { manager, root } = await makeManager(async () => {
      throw new Error("trust hash walk exceeded its file budget: agent/skills/z.txt");
    });
    try {
      manager.recordRun(makeRun());
      const result = await manager.forkRun("run-trust");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("trust-sensitive resources could not be verified");
      expect(result.error).toContain("file budget");
    } finally {
      await manager.dispose().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes the trust gate when hashes match", async () => {
    const { manager, root } = await makeManager(async () => ({ ...BASELINE }));
    try {
      // An invalid payload path fails the check after the trust gate,
      // proving the gate passed without building a comparison.
      manager.recordRun(makeRun({ promptPayloadFile: "evil/path" }));
      const result = await manager.forkRun("run-trust");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("the prompt payload path is invalid");
    } finally {
      await manager.dispose().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("decodeTrustHashes", () => {
  it("accepts a complete string-map response", () => {
    expect(decodeTrustHashes({
      op: "trust-hashes-result",
      requestId: "cap-1",
      ok: true,
      hashes: { ...BASELINE },
      complete: true,
    })).toEqual(BASELINE);
  });

  it("rejects an incomplete walk", () => {
    expect(() => decodeTrustHashes({ hashes: { ...BASELINE }, complete: false }))
      .toThrow("trust hashes returned an incomplete walk");
    expect(() => decodeTrustHashes({ hashes: { ...BASELINE } }))
      .toThrow("trust hashes returned an incomplete walk");
  });

  it("rejects a malformed response", () => {
    expect(() => decodeTrustHashes(null)).toThrow("trust hashes returned an invalid response");
    expect(() => decodeTrustHashes({ hashes: null, complete: true }))
      .toThrow("trust hashes returned an invalid response");
    expect(() => decodeTrustHashes({ hashes: { "agent/skills/a.md": 42 }, complete: true }))
      .toThrow("trust hashes returned an invalid response");
  });
});
