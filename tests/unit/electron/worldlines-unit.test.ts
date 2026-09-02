import { describe, it, expect, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join } from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { WorldlineManager, disposeWorldlineCoreClient } from "../../../electron/worldlines.ts";

const execFileAsync = promisify(execFile);

describe("Worldline Manager, Core Client & Retention Performance Unit Suite", () => {
  async function runScript(scriptName: string, timeout = 90_000) {
    const scriptPath = resolve("scripts", scriptName);
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", scriptPath],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TERMINA_CORE_TEST: "1",
          TERMINA_CORE_BIN: resolve("core", "target", "release", "termina-core"),
        },
        timeout,
      },
    );
    return { stdout, stderr };
  }

  it("passes worldline ready failure checks natively", async () => {
    const root = await mkdtemp(join(tmpdir(), "termina-worldline-ready-"));
    const worldsRoot = join(root, "worlds");
    const primaryRoot = join(root, "primary");
    await mkdir(worldsRoot);
    await mkdir(primaryRoot);

    const deps = {
      worldsRoot,
      primaryRoot,
      realHome: root,
      userData: root,
      primaryEventsDir: root,
      bridgePath: join(root, "bridge.js"),
      piBin: process.execPath,
      agentCorePath: join(root, "agent-core.mjs"),
      electronExecPath: process.execPath,
      candidateEnv: () => ({}),
      showThinking: () => false,
      getStore: async () => null,
      appReadPaths: () => [],
      forkSession: async () => ({ ok: false, error: "unused" }),
      forkCoreSession: async () => ({ ok: false, error: "unused" }),
      discardCoreSession: async () => ({ ok: false, error: "unused" }),
      createCandidate: async () => ({ terminalId: "unused", pid: 0 }),
      createCandidateWorkspace: () => root,
      onUpdate: () => {},
      onCandidateState: () => {},
      onRemoved: () => {},
      preflight: async () => ({ ok: false, reasons: ["unused"] }),
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

    let unhandled: any = null;
    const onUnhandled = (reason: any) => { unhandled = reason; };
    process.on("unhandledRejection", onUnhandled);
    try {
      const manager = new WorldlineManager(deps as any);
      const listed = await manager.list();
      expect(listed).toEqual([]);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toBeNull();
      await manager.dispose().catch(() => {});
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes worldline reopen flow contracts natively", async () => {
    const root = await mkdtemp(join(tmpdir(), "termina-worldline-reopen-"));
    let manager: any;
    let mode = "immediate";
    let sequence = 0;
    const controls: any[] = [];
    const terminated: string[] = [];
    const created: any[] = [];
    let mappingObservedBeforeReady = false;
    let staleKeptPending = false;

    const deps = {
      worldsRoot: join(root, "worlds"),
      primaryRoot: join(root, "worlds"),
      realHome: root,
      userData: root,
      primaryEventsDir: root,
      bridgePath: join(root, "bridge.js"),
      piBin: process.execPath,
      agentCorePath: join(root, "agent-core.mjs"),
      electronExecPath: process.execPath,
      candidateEnv: () => ({}),
      showThinking: () => false,
      getStore: async () => null,
      appReadPaths: () => [],
      forkSession: async () => ({ ok: false, error: "unused" }),
      forkCoreSession: async () => ({ ok: false, error: "unused" }),
      discardCoreSession: async () => ({ ok: false, error: "unused" }),
      discardPiSession: async () => ({ ok: false, error: "unused" }),
      createCandidate: async (opts: any) => {
        const terminalId = `candidate-${++sequence}`;
        const useRouting = mode !== "mapping-failure";
        created.push({ terminalId, beforeSpawn: useRouting });
        if (useRouting) {
          opts.beforeSpawn?.(terminalId);
          mappingObservedBeforeReady = manager.terminalToComparison.get(terminalId)?.label === "A" && manager.list().at(-1)?.state === "creating";
        }
        if (mode === "mapping-failure") return { terminalId, pid: 0 };
        const opId = controls.at(-1)?.opId;
        if (mode === "immediate" || mode === "restart") {
          manager.onSessionReady(terminalId, true, null, {
            bridgeId: `bridge-${terminalId}`,
            generation: `generation-${terminalId}`,
            seq: 1,
            opId,
          });
        } else if (mode === "stale-delayed") {
          manager.onSessionReady(terminalId, true, null, {
            bridgeId: `old-bridge-${terminalId}`,
            generation: `old-generation-${terminalId}`,
            seq: 1,
            opId: "stale-operation",
          });
          staleKeptPending = manager.list().at(-1)?.state === "creating";
          setTimeout(() => manager.onSessionReady(terminalId, true, null, {
            bridgeId: `bridge-${terminalId}`,
            generation: `generation-${terminalId}`,
            seq: 1,
            opId,
          }), 0);
        } else if (mode === "crash") {
          manager.terminalExited(terminalId);
        }
        return { terminalId, pid: 0 };
      },
      terminateCandidate: (terminalId: string) => terminated.push(terminalId),
      createCandidateWorkspace: () => root,
      onUpdate: () => {},
      onCandidateState: () => {},
      onRemoved: () => {},
      preflight: async () => ({ ok: false, reasons: ["unused"] }),
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

    const candidate: any = {
      label: "A",
      role: "moment",
      dir: join(root, "candidate"),
      supportDir: join(root, "candidate-support"),
      homeDir: join(root, "candidate-support", "home"),
      sessionDir: join(root, "candidate-support", "sessions"),
      eventsDir: join(root, "candidate-support", "events"),
      tmpDir: join(root, "candidate-support", "tmp"),
      cacheDir: join(root, "candidate-support", "cache"),
      profilePath: join(root, "candidate.sb"),
      sessionFile: join(root, "session.json"),
      comparisonBaseStateId: null,
      promotionBaseStateId: null,
      headStateId: null,
      headCommit: Promise.resolve(),
      terminalId: null,
      pid: null,
      lstart: null,
      state: "settled",
      version: 1,
      error: null,
    };
    const comparison: any = {
      id: "comparison-reopen",
      dir: join(root, "comparison"),
      templateDir: join(root, "template"),
      sessionWorkspaceDir: join(root, "session-workspace"),
      sourceRunId: "run-reopen",
      sourceGitDir: join(root, "worlds"),
      primaryRoot: join(root, "worlds"),
      baseCommit: null,
      baseStateId: null,
      inheritTrust: false,
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
      candidates: new Map([["A", candidate]]),
      phase: "running",
      error: null,
      readyTimer: null,
    };

    try {
      manager = new WorldlineManager(deps as any);
      await manager.ready;
      manager.comparisons.set(comparison.id, comparison);
      manager.candidateLaunch = async () => ({ cmd: process.execPath, args: [], env: {} });
      manager.writeControl = async (_cand: any, control: any) => { controls.push(control); };
      manager.updateManifest = async () => {};

      mode = "immediate";
      let result = await manager.openTerminal(comparison.id, "A");
      expect(result.ok).toBe(true);
      expect(candidate.state).toBe("ready");
      expect(created[0].beforeSpawn).toBe(true);
      expect(mappingObservedBeforeReady).toBe(true);

      candidate.state = "settled";
      candidate.error = null;
      mode = "stale-delayed";
      result = await manager.openTerminal(comparison.id, "A");
      expect(result.ok).toBe(true);
      expect(candidate.state).toBe("ready");
      expect(staleKeptPending).toBe(true);

      candidate.state = "settled";
      candidate.error = null;
      mode = "mapping-failure";
      result = await manager.openTerminal(comparison.id, "A");
      expect(result.ok).toBe(false);
      expect(candidate.state).toBe("error");
      expect(candidate.terminalId).toBeNull();
      expect(terminated.at(-1)).toBe("candidate-3");

      candidate.state = "settled";
      candidate.error = null;
      mode = "crash";
      result = await manager.openTerminal(comparison.id, "A");
      expect(result.ok).toBe(false);
      expect(candidate.state).toBe("error");
      expect(terminated.at(-1)).toBe("candidate-4");
      const failedTerminal = "candidate-4";
      candidate.state = "settled";
      candidate.error = null;
      mode = "restart";
      result = await manager.openTerminal(comparison.id, "A");
      expect(result.ok).toBe(true);
      manager.onSessionReady(failedTerminal, true, null, {
        bridgeId: "old-bridge",
        generation: "old-generation",
        seq: 1,
        opId: "old-operation",
      });
      expect(candidate.state).toBe("ready");

      candidate.state = "settled";
      candidate.error = null;
      mode = "cancel";
      const pendingOpen = manager.openTerminal(comparison.id, "A");
      await new Promise((resolve) => setImmediate(resolve));
      expect(manager.pendingCandidateReadies.size).toBe(1);
      await manager.cancel(comparison.id);
      const cancelled = await pendingOpen;
      expect(cancelled.ok).toBe(false);
      expect(manager.pendingCandidateReadies.size).toBe(0);
      expect(manager.terminalToComparison.has("candidate-6")).toBe(false);
      expect(candidate.state).not.toBe("ready");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    disposeWorldlineCoreClient();
  });

  it("passes ipc/project flow probes", async () => {
    const { stdout } = await runScript("ipc-project-flow-test.mjs");
    expect(stdout).toContain("22/22 passed");
  });

  it("passes core client read budget gate", async () => {
    const { stdout } = await runScript("core-client-read-budget-test.mjs");
    expect(stdout).toContain("PASS");
  });

  it("passes retention ledger focused performance regressions", async () => {
    const { stdout } = await runScript("session-retention-performance-test.mjs", 120_000);
    expect(stdout).toContain("PASS retention-ledger focused regressions");
  }, 120_000);

  it("passes worldline runtime teardown & candidate flow", async () => {
    const { stdout } = await runScript("worldline-runtime-flow-test.mjs", 120_000);
    expect(stdout).toContain("freshCancel");
  }, 120_000);
});
