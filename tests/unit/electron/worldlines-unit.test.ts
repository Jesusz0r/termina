import { describe, it, expect, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldlineManager, disposeWorldlineGitCore, ensurePromotionRoots } from "../../../electron/worldlines/index.ts";
import { MARKER } from "../../../electron/worldlines/limits.ts";
import type { CandidateState, ComparisonState, RunRecord } from "../../../electron/worldlines/types.ts";
import type { ChallengeProfile, TimelineEvent } from "../../../shared/types.ts";

describe("Worldline Manager, Core Client & Retention Performance Unit Suite", () => {

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
      agentCorePath: join(root, "agent-core.mjs"),
      electronExecPath: process.execPath,
      candidateEnv: () => ({}),
      showThinking: () => false,
      getStore: async () => null,
      appReadPaths: () => [],
      forkCoreSession: async () => ({ ok: false, error: "unused" }),
      discardCoreSession: async () => ({ ok: false, error: "unused" }),
      readPromptPayload: async () => ({ ok: false, error: "unused" }),
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
      terminalLive: () => true,
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
    let attachable = false;

    const deps = {
      worldsRoot: join(root, "worlds"),
      primaryRoot: join(root, "worlds"),
      realHome: root,
      userData: root,
      primaryEventsDir: root,
      agentCorePath: join(root, "agent-core.mjs"),
      electronExecPath: process.execPath,
      candidateEnv: () => ({}),
      showThinking: () => false,
      getStore: async () => null,
      appReadPaths: () => [],
      forkCoreSession: async () => ({ ok: false, error: "unused" }),
      discardCoreSession: async () => ({ ok: false, error: "unused" }),
      readPromptPayload: async () => ({ ok: false, error: "unused" }),
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
      terminalLive: () => attachable,
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
      sourceRunId: "run-reopen",
      sourceGitDir: join(root, "worlds"),
      primaryRoot: join(root, "worlds"),
      baseCommit: null,
      baseStateId: null,
      model: null,
      thinkingLevel: null,
      engine: "core",
      expectedCandidates: 1,
      uncertainSessionArtifacts: [],
      manifestWriteFailed: false,
      teardownPromise: null,
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
      expect(result.terminalId).toBe("candidate-1");
      expect(candidate.state).toBe("ready");
      expect(created[0].beforeSpawn).toBe(true);
      expect(mappingObservedBeforeReady).toBe(true);

      attachable = true;
      result = await manager.openTerminal(comparison.id, "A");
      expect(result.ok).toBe(true);
      expect(result.terminalId).toBe("candidate-1");
      expect(created.length).toBe(1);

      candidate.state = "promoting";
      result = await manager.openTerminal(comparison.id, "A");
      expect(result.ok).toBe(true);
      expect(result.terminalId).toBe("candidate-1");
      expect(created.length).toBe(1);

      candidate.state = "settled";
      result = await manager.openTerminal(comparison.id, "A");
      expect(result.ok).toBe(true);
      expect(result.terminalId).toBe("candidate-1");
      expect(created.length).toBe(1);

      attachable = false;
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

  it("constructs comparisons through one helper; callers differ only after", () => {
    const src = readFileSync(new URL("../../../electron/worldlines/manager.ts", import.meta.url), "utf8");
    const methodBody = (signature: string, nextSignature: string): string => {
      const start = src.indexOf(signature);
      if (start < 0) throw new Error(`missing ${signature}`);
      const end = src.indexOf(nextSignature, start + signature.length);
      return src.slice(start, end < 0 ? src.length : end);
    };
    expect(src.match(/private async constructComparison\(/g)?.length).toBe(1);
    expect(src.match(/this\.constructComparison\(/g)?.length).toBe(3);
    expect(src.match(/this\.allocateComparisonDirectory\(/g)?.length).toBe(1);
    expect(src.match(/writeComparisonMarkerBound\(/g)?.length).toBe(1);

    const create = methodBody("private async createComparison(", "  /** The comparison template");
    const challenge = methodBody("async challengeFromCandidate(", "  /** The ignored/generated writes");
    const forkPoint = methodBody("async forkPoint(", "  /** Launch one candidate");
    for (const body of [create, challenge, forkPoint]) {
      expect(body).toContain("this.constructComparison(");
      expect(body).not.toContain("allocateComparisonDirectory");
      expect(body).not.toContain("writeComparisonMarkerBound");
      expect(body).not.toContain("${label}-support");
    }
    expect(create).toContain("run.settledStateId");
    expect(create).toContain("run.startStateId");
    expect(challenge).toContain("wHead.commit");
    expect(challenge).toContain("ncmp.baseStateId");
    expect(forkPoint).toContain("opts.stateId");
    expect(forkPoint).toContain('role: "moment"');
    expect(create).toContain('role: challengeProfile ? "challenge" : "alternative"');
    expect(challenge).toContain('role: "challenge"');
  });

  it("fills marker, manifest, and support paths for pair and moment constructions", async () => {
    const { manager, root } = await makeReadyManager();
    try {
      const pair = await (manager as unknown as {
        createComparison: (run: RunRecord, profile?: ChallengeProfile) => Promise<ComparisonState>;
      }).createComparison(makeUnitRun());
      expect(pair.expectedCandidates).toBe(2);
      expect(pair.sourceGitDir).toBe("");
      expect(existsSync(join(pair.dir, MARKER))).toBe(true);
      const pairManifest = JSON.parse(await readFile(join(pair.dir, "manifest.json"), "utf8")) as {
        expectedCandidates: number;
        sourceRunId: string;
        status: string;
      };
      expect(pairManifest).toMatchObject({ expectedCandidates: 2, sourceRunId: "run-unit", status: "creating" });
      expect(supportPaths(pair.candidates.get("A")!)).toEqual(expectedSupport(pair.dir, "A"));
      expect(supportPaths(pair.candidates.get("B")!)).toEqual(expectedSupport(pair.dir, "B"));
      expect(pair.candidates.get("A")?.role).toBe("reference");
      expect(pair.candidates.get("B")?.role).toBe("alternative");
      expect(pair.candidates.get("A")?.headStateId).toBe("state-settled");
      expect(pair.candidates.get("B")?.headStateId).toBe("state-start");
      expect(pair.candidates.get("A")?.comparisonBaseStateId).toBe("state-start");

      const challenged = await (manager as unknown as {
        createComparison: (run: RunRecord, profile?: ChallengeProfile) => Promise<ComparisonState>;
      }).createComparison(makeUnitRun({ id: "run-challenge-profile" }), "preserve-api");
      expect(challenged.candidates.get("B")?.role).toBe("challenge");
      expect(challenged.candidates.get("B")?.headStateId).toBe("state-start");

      const moment = await (manager as unknown as {
        constructComparison: (spec: {
          sourceRunId: string;
          sourceGitDir: string;
          baseStateId: string | null;
          model: string | null;
          thinkingLevel: string | null;
          expectedCandidates: 1 | 2;
          candidates: Array<{ label: "A" | "B"; role: CandidateState["role"] }>;
        }) => Promise<ComparisonState>;
      }).constructComparison({
        sourceRunId: "run-unit",
        sourceGitDir: join(root, "primary", ".git"),
        baseStateId: "state-start",
        model: "model-x",
        thinkingLevel: "high",
        expectedCandidates: 1,
        candidates: [{ label: "A", role: "moment" }],
      });
      expect(moment.expectedCandidates).toBe(1);
      expect(moment.candidates.size).toBe(1);
      expect(moment.candidates.get("A")?.role).toBe("moment");
      expect(moment.candidates.get("A")?.headStateId).toBeNull();
      expect(supportPaths(moment.candidates.get("A")!)).toEqual(expectedSupport(moment.dir, "A"));
      expect(moment.candidates.get("B")).toBeUndefined();
      const momentManifest = JSON.parse(await readFile(join(moment.dir, "manifest.json"), "utf8")) as {
        expectedCandidates: number;
      };
      expect(momentManifest.expectedCandidates).toBe(1);
    } finally {
      await manager.dispose().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it("challengeFromCandidate and forkPoint use the helper then set their own heads", async () => {
    const { manager, root } = await makeReadyManager();
    const constructed: ComparisonState[] = [];
    const surface = manager as unknown as {
      constructComparison: (spec: unknown) => Promise<ComparisonState>;
      readPromptPayload: (run: unknown) => Promise<unknown>;
      comparisons: Map<string, ComparisonState>;
    };
    const original = surface.constructComparison.bind(manager);
    surface.constructComparison = async (spec) => {
      const cmp = await original(spec);
      constructed.push(cmp);
      return cmp;
    };
    try {
      expect(await manager.forkPoint("term-1", null)).toEqual({ ok: false, error: "timeline moment not found" });
      expect(await manager.forkPoint("term-1", { seq: 1, t: "tool", ts: 1 } as TimelineEvent)).toEqual({
        ok: false,
        error: "this moment is not forkable",
      });
      expect(await manager.forkPoint("term-1", {
        seq: 1,
        t: "tool",
        ts: 1,
        stateId: "s",
        entryId: "e",
        evicted: true,
      } as TimelineEvent)).toEqual({ ok: false, error: "this moment's source state was evicted" });

      const startedAt = Date.now() - 1_000;
      manager.recordRun(makeUnitRun({
        startedAt,
        settledAt: startedAt + 5_000,
        sessionFile: join(root, "session.json"),
      }));
      const forked = await manager.forkPoint("term-1", {
        seq: 2,
        t: "tool",
        ts: startedAt + 10,
        stateId: "moment-state",
        entryId: "seq:2",
        model: "model-x",
      } as TimelineEvent);
      expect(forked.ok).toBe(false);
      const momentCmp = constructed.at(-1);
      expect(momentCmp?.expectedCandidates).toBe(1);
      expect(momentCmp?.candidates.get("A")?.role).toBe("moment");
      expect(momentCmp?.candidates.get("A")?.headStateId).toBe("moment-state");
      expect(supportPaths(momentCmp!.candidates.get("A")!)).toEqual(expectedSupport(momentCmp!.dir, "A"));
      expect(momentCmp?.candidates.get("B")).toBeUndefined();

      surface.readPromptPayload = async () => ({ kind: "ok", payload: { text: "do the task", images: [], context: "" } });
      manager.recordRun(makeUnitRun({
        id: "run-challenge",
        promptPayloadFile: "payload.json",
        promptEventsDir: root,
        promptParentEntryId: "seq:0",
      }));
      surface.comparisons.set("cmp-live", {
        id: "cmp-live",
        phase: "running",
        engine: "core",
        baseStateId: "state-start",
        sourceRunId: "run-challenge",
        model: "model-x",
        thinkingLevel: "high",
        teardownPromise: null,
        manifestWriteFailed: false,
        uncertainSessionArtifacts: [],
        candidates: new Map([
          ["A", {
            label: "A",
            role: "reference",
            dir: join(root, "live-A"),
            sessionFile: join(root, "live-session.json"),
            state: "settled",
            headCommit: Promise.resolve(),
          }],
        ]),
      } as unknown as ComparisonState);
      const challenged = await manager.challengeFromCandidate("cmp-live", "A", "preserve-api");
      expect(challenged.ok).toBe(false);
      const challengeCmp = constructed.at(-1);
      expect(challengeCmp?.expectedCandidates).toBe(2);
      expect(challengeCmp?.candidates.get("A")?.role).toBe("reference");
      expect(challengeCmp?.candidates.get("B")?.role).toBe("challenge");
      expect(challengeCmp?.candidates.get("A")?.headStateId).toBe("captured-head");
      expect(challengeCmp?.candidates.get("B")?.headStateId).toBe("state-start");
      expect(supportPaths(challengeCmp!.candidates.get("A")!)).toEqual(expectedSupport(challengeCmp!.dir, "A"));
      expect(supportPaths(challengeCmp!.candidates.get("B")!)).toEqual(expectedSupport(challengeCmp!.dir, "B"));
    } finally {
      await manager.dispose().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    disposeWorldlineGitCore();
  });
});

function makeUnitRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-unit",
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
    model: "model-x",
    thinkingLevel: "high",
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
    ...overrides,
  };
}

function expectedSupport(dir: string, label: "A" | "B") {
  const supportDir = join(dir, `${label}-support`);
  return {
    dir: join(dir, label),
    supportDir,
    homeDir: join(supportDir, "home"),
    sessionDir: join(supportDir, "sessions"),
    eventsDir: join(supportDir, "events"),
    tmpDir: join(supportDir, "tmp"),
    cacheDir: join(supportDir, "cache"),
    profilePath: join(dir, "profiles", `${label}.sb`),
  };
}

function supportPaths(cand: CandidateState) {
  return {
    dir: cand.dir,
    supportDir: cand.supportDir,
    homeDir: cand.homeDir,
    sessionDir: cand.sessionDir,
    eventsDir: cand.eventsDir,
    tmpDir: cand.tmpDir,
    cacheDir: cand.cacheDir,
    profilePath: cand.profilePath,
  };
}

async function makeReadyManager(): Promise<{ manager: WorldlineManager; root: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "termina-worldline-construct-")));
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
    trustHashes: async () => ({}),
    captureHead: async () => ({ commit: "captured-head", tree: "tree" }),
    capturePrimary: async () => null,
    releaseState: async () => {},
    terminalBusy: () => false,
    terminalLive: () => true,
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
  return { manager, root };
}
