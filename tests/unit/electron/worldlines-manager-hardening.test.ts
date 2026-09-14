import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldlineManager, ensurePromotionRoots } from "../../../electron/worldlines/index.ts";
import { MARKER } from "../../../electron/worldlines/limits.ts";
import { readProcessStart } from "../../../electron/worldlines/promotion-recovery.js";
import type { ComparisonState, RunRecord } from "../../../electron/worldlines/types.ts";

describe("manager hardening (issue #202)", () => {
  it("(a) keeps the dead admission-lease field deleted", () => {
    const managerSrc = readFileSync(new URL("../../../electron/worldlines/manager.ts", import.meta.url), "utf8");
    const typesSrc = readFileSync(new URL("../../../electron/worldlines/types.ts", import.meta.url), "utf8");
    expect(typesSrc).not.toContain("uncertainAdmissionLease");
    // The createComparison parameter stays (it binds the lease); no stored field remains.
    const fieldStores = managerSrc.split("\n").filter((line) => /^\s+uncertainAdmissionLease[:,]/.test(line));
    expect(fieldStores).toEqual([]);
  });

  it("(d) counts draining comparisons against the live budget", () => {
    const comparisons = new Map<string, ComparisonState>([
      ["live", { phase: "running", teardownPromise: null, candidates: new Map([["A", {}], ["B", {}]]) } as ComparisonState],
      ["draining", { phase: "error", teardownPromise: Promise.resolve(), candidates: new Map([["A", {}]]) } as ComparisonState],
      ["retained", { phase: "error", teardownPromise: null, candidates: new Map([["A", {}], ["B", {}]]) } as ComparisonState],
    ]);
    const count = (WorldlineManager.prototype as unknown as {
      liveWorldlineCount(this: { comparisons: Map<string, ComparisonState> }): number;
    }).liveWorldlineCount.call({ comparisons });
    // Live (2) + draining (1); the finished retained drain frees its slots.
    expect(count).toBe(3);
  });

  it("(e) a budget-exhausted creator fails inside the gate and releases it", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "termina-budget-gate-")));
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
      getStore: async () => ({ sourceRoot: primaryRoot }) as never,
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
    try {
      await (manager as unknown as { ready: Promise<void> }).ready;
      // One live pair occupies 2 of 3 slots; a fork needs 2 more.
      (manager as unknown as { comparisons: Map<string, ComparisonState> }).comparisons.set("cmp-live", {
        id: "cmp-live",
        phase: "running",
        teardownPromise: null,
        manifestWriteFailed: false,
        uncertainSessionArtifacts: [],
        candidates: new Map([
          ["A", { label: "A", role: "reference", headCommit: Promise.resolve() }],
          ["B", { label: "B", role: "alternative", headCommit: Promise.resolve() }],
        ]),
      } as unknown as ComparisonState);
      manager.recordRun({
        id: "run-1",
        terminalId: "term-0",
        workspaceId: "ws",
        startStateId: "base",
        settledStateId: "settled",
        promptPayloadFile: null,
        promptEventsDir: null,
        promptText: null,
        promptEntryId: null,
        promptParentEntryId: null,
        settledEntryId: null,
        sessionFile: null,
        sessionBranchFile: "branch",
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
        trustHashes: {},
        engine: "core",
      } satisfies RunRecord);
      const first = await manager.forkRun("run-1");
      expect(first).toEqual({ ok: false, error: "the live worldline budget is exhausted" });
      // The admission was released, not stuck: a retry fails the same way.
      const second = await manager.forkRun("run-1");
      expect(second).toEqual({ ok: false, error: "the live worldline budget is exhausted" });
      expect((manager as unknown as { comparisons: Map<string, ComparisonState> }).comparisons.size).toBe(1);
    } finally {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it.runIf(process.platform !== "win32")("(f) stale sweep gives orphaned groups a TERM grace", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "termina-stale-sweep-")));
    const worldsRoot = join(root, "worlds");
    const primaryRoot = join(root, "primary");
    await ensurePromotionRoots(worldsRoot, primaryRoot);
    // A TERM-ignoring orphan in its own group: only SIGKILL can reap it, and
    // only after the grace wait proves TERM was tried first.
    const child = spawn("sh", ["-c", 'trap "" TERM; exec sleep 30'], { detached: true, stdio: "ignore" });
    child.unref();
    const pid = child.pid!;
    const groupAlive = (): boolean => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      expect(groupAlive()).toBe(true);
      const lstart = await readProcessStart(pid);
      expect(lstart).not.toBeNull();
      const cmpDir = join(worldsRoot, "cmp-stale");
      await mkdir(cmpDir, { recursive: true });
      await writeFile(join(cmpDir, MARKER), "owned\n");
      await writeFile(
        join(cmpDir, "manifest.json"),
        JSON.stringify({
          id: "cmp-stale",
          sourceRunId: "run-1",
          createdAt: Date.now(),
          status: "complete",
          expectedCandidates: 1,
          candidates: { A: { pid, lstart, paths: [join(cmpDir, "A"), join(cmpDir, "A-support")] } },
          uncertainSessionArtifacts: [],
        }),
      );
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
      try {
        const started = Date.now();
        await (manager as unknown as { ready: Promise<void> }).ready;
        // The sweep waited out the TERM grace instead of killing instantly.
        expect(Date.now() - started).toBeGreaterThanOrEqual(450);
        expect(groupAlive()).toBe(false);
      } finally {
        await manager.dispose();
      }
    } finally {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* Already reaped. */
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
