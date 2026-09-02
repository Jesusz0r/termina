import { describe, it, expect } from "vitest";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build, stop } from "esbuild";

describe("Worldline Runtime Flow Suite", () => {
  it("passes worldline runtime teardown & candidate flow natively", async () => {
    
    // Deterministic unit probes for the two R3 teardown seams. The fake candidate
    // creator still invokes the production beforeSpawn callback, while a delayed
    // ps wrapper makes the process-start identity arrive after cancellation.
    const root = await mkdtemp(join(tmpdir(), "termina-worldline-runtime-flow-"));
    const worldlineBundle = join(root, "worldlines.mjs");
    const sandboxBundle = join(root, "sandbox.mjs");
    await build({ entryPoints: ["electron/worldlines.ts"], bundle: true, platform: "node", format: "esm", target: "node22", outfile: worldlineBundle, logLevel: "silent" });
    await build({ entryPoints: ["electron/sandbox.ts"], bundle: true, platform: "node", format: "esm", target: "node22", outfile: sandboxBundle, logLevel: "silent" });
    const { WorldlineManager, disposeWorldlineCoreClient, ensurePromotionRoots } = await import(`${pathToFileURL(worldlineBundle).href}?${Date.now()}`);
    const { terminateSandboxProcessGroup } = await import(`${pathToFileURL(sandboxBundle).href}?${Date.now()}`);
    
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
    const alive = (pid) => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    
    const makeCandidate = (rootPath, label = "A") => ({
      label,
      role: "moment",
      dir: join(rootPath, `${label}-candidate`),
      supportDir: join(rootPath, `${label}-support`),
      homeDir: join(rootPath, `${label}-support`, "home"),
      sessionDir: join(rootPath, `${label}-support`, "sessions"),
      eventsDir: join(rootPath, `${label}-support`, "events"),
      tmpDir: join(rootPath, `${label}-support`, "tmp"),
      cacheDir: join(rootPath, `${label}-support`, "cache"),
      profilePath: join(rootPath, `${label}.sb`),
      sessionFile: join(rootPath, `${label}.session`),
      comparisonBaseStateId: null,
      promotionBaseStateId: null,
      headStateId: null,
      headCommit: Promise.resolve(),
      terminalId: null,
      pid: null,
      lstart: null,
      state: "creating",
      version: 1,
      error: null,
    });
    
    const makeComparison = (rootPath, id, candidate) => ({
      id,
      dir: join(rootPath, id),
      templateDir: join(rootPath, `${id}-template`),
      sessionWorkspaceDir: join(rootPath, `${id}-sessions`),
      sourceRunId: `run-${id}`,
      sourceGitDir: rootPath,
      primaryRoot: rootPath,
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
      candidates: new Map([[candidate.label, candidate]]),
      phase: "creating",
      error: null,
      readyTimer: null,
    });
    
    const fakeBin = join(root, "fake-bin");
    await mkdir(fakeBin, { recursive: true, mode: 0o700 });
    const realPath = process.env.PATH ?? "/usr/bin:/bin";
    await writeFile(join(fakeBin, "ps"), `#!/bin/sh\nsleep 0.35\nprintf 'Mon Jan 01 00:00:00 2024\\n'\n`, { mode: 0o700 });
    await chmod(join(fakeBin, "ps"), 0o700);
    process.env.PATH = `${fakeBin}:${realPath}`;
    
    const worldsRoot = join(root, "worlds");
    const primaryRoot = join(root, "primary");
    await ensurePromotionRoots(worldsRoot, primaryRoot);
    
    const terminated = [];
    const updates = [];
    let removed = false;
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
      discardPiSession: async () => ({ ok: false, error: "unused" }),
      createCandidate: async () => ({ terminalId: "unused", pid: 0 }),
      terminateCandidate: (terminalId) => terminated.push(terminalId),
      createCandidateWorkspace: () => root,
      onUpdate: (summary) => updates.push({ summary, afterRemoved: removed }),
      onCandidateState: () => {},
      onRemoved: () => { removed = true; },
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
      canonicalPath: async (path) => path,
      mineFiles: () => new Set(),
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
    
    let manager;
    let spawnedResolve;
    const spawned = new Promise((resolve) => { spawnedResolve = resolve; });
    deps.createCandidate = async (opts) => {
      const terminalId = "candidate-fresh-1";
      opts.beforeSpawn?.(terminalId);
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 30000)"], { detached: true, stdio: "ignore" });
      spawnedResolve({ terminalId, pid: child.pid });
      // Fresh startup readiness is immediate, before the launch continuation's
      // delayed process identity lookup.
      manager.onSessionReady(terminalId, true, null, { bridgeId: "fresh-bridge", generation: "fresh-generation", seq: 1 });
      return { terminalId, pid: child.pid };
    };
    
    try {
      manager = new WorldlineManager(deps);
      await manager.ready;
      manager.candidateLaunch = async () => ({ cmd: process.execPath, args: [], env: {} });
      manager.updateManifest = async () => {};
      manager.removeOwnedDir = async () => true;
    
      const candidate = makeCandidate(root);
      const comparison = makeComparison(root, "fresh-teardown", candidate);
      manager.comparisons.set(comparison.id, comparison);
      const launch = manager.launchCandidate(comparison, candidate, [], null).catch((error) => error);
      const created = await spawned;
      await nextTurn();
      const oldAttempt = [...manager.candidateLaunchAttempts.values()][0];
      const cancel = await manager.cancel(comparison.id);
      const launchResult = await launch;
      assert.equal(cancel.ok, true, "cancel completes while readProcessStart is delayed");
      assert.equal(launchResult instanceof Error, true, "cancelled launch cannot resume as success");
      assert.equal(removed, true, "worldline removal is published after teardown");
      assert.equal(updates.some((update) => update.afterRemoved), false, "no stale candidate update follows worldline:removed");
      assert.equal(terminated.includes(created.terminalId), true, "late startup cleanup closes the exact terminal");
      const replacement = spawn(process.execPath, ["-e", "setInterval(() => {}, 30000)"], { detached: true, stdio: "ignore" });
      candidate.pid = replacement.pid;
      candidate.startupAttemptId = "replacement-attempt";
      await sleep(2200);
      assert.equal(alive(created.pid), false, "late process-start identity cleanup removes the detached group");
      assert.equal(alive(replacement.pid), true, "late cleanup cannot kill a replacement pid");
      try { process.kill(-replacement.pid, "SIGKILL"); } catch {}
      assert.ok(oldAttempt, "the cancelled attempt remained identifiable through teardown");
    
      // The attempt fence is source-visible and replacement-safe: cleanup uses the
      // captured attempt identity/start time, never a later CandidateState pid.
      const worldlinesSource = await (await import("node:fs/promises")).readFile("electron/worldlines.ts", "utf8");
      assert.match(worldlinesSource, /candidateLaunchAttempts/);
      assert.match(worldlinesSource, /awaitAbortable\(identity, attempt\.controller\.signal\)/);
      assert.match(worldlinesSource, /terminateCandidateGroup\(attempt\.pid, lstart\)/);
    
      // Evidence cancellation is owned by the comparison, not the global queue.
      const evidenceCandidate = makeCandidate(root, "A");
      evidenceCandidate.state = "settled";
      const evidenceComparison = makeComparison(root, "evidence-discard", evidenceCandidate);
      evidenceComparison.phase = "running";
      manager.comparisons.set(evidenceComparison.id, evidenceComparison);
      let evidenceAttempt;
      manager.runEvidence = (_comparisonId, attempt) => new Promise((resolve) => {
        evidenceAttempt = attempt;
        attempt.controller.signal.addEventListener("abort", () => resolve({ ok: false, error: "evidence was cancelled" }), { once: true });
      });
      const evidencePromise = manager.measureEvidence(evidenceComparison.id);
      await nextTurn();
      assert.ok(evidenceAttempt, "evidence worker is registered before it starts");
      const discarded = await manager.discard(evidenceComparison.id);
      const evidenceResult = await evidencePromise;
      assert.equal(discarded.ok, true, "direct discard drains its evidence worker");
      assert.equal(evidenceAttempt.controller.signal.aborted, true, "discard aborts the exact evidence attempt");
      assert.equal(evidenceResult.ok, false, "cancelled evidence cannot publish a result");
    
      const cancelEvidenceCandidate = makeCandidate(root, "A");
      cancelEvidenceCandidate.state = "settled";
      const cancelEvidenceComparison = makeComparison(root, "evidence-cancel", cancelEvidenceCandidate);
      cancelEvidenceComparison.phase = "running";
      manager.comparisons.set(cancelEvidenceComparison.id, cancelEvidenceComparison);
      let cancelEvidenceAttempt;
      manager.runEvidence = (_comparisonId, attempt) => new Promise((resolve) => {
        cancelEvidenceAttempt = attempt;
        attempt.controller.signal.addEventListener("abort", () => resolve({ ok: false, error: "evidence was cancelled" }), { once: true });
      });
      const cancelEvidencePromise = manager.measureEvidence(cancelEvidenceComparison.id);
      await nextTurn();
      const cancelledEvidence = await manager.cancel(cancelEvidenceComparison.id);
      const cancelledEvidenceResult = await cancelEvidencePromise;
      assert.equal(cancelledEvidence.ok, true, "direct cancel drains its evidence worker");
      assert.equal(cancelEvidenceAttempt.controller.signal.aborted, true, "cancel aborts the exact evidence attempt");
      assert.equal(cancelledEvidenceResult.ok, false, "cancelled evidence cannot publish a result");
    
      // A crashed worker is still removed from the owned registry and cannot
      // strand the queue or produce a post-discard update.
      const crashCandidate = makeCandidate(root, "A");
      crashCandidate.state = "settled";
      const crashComparison = makeComparison(root, "evidence-crash", crashCandidate);
      crashComparison.phase = "running";
      manager.comparisons.set(crashComparison.id, crashComparison);
      manager.runEvidence = async () => { throw new Error("worker crashed"); };
      await manager.measureEvidence(crashComparison.id).catch(() => undefined);
      assert.equal(manager.evidenceAttempts.size, 0, "crashed evidence worker is retired");
    
      // Exercise the canonical descendant/group termination API directly. This is
      // the same API used by main.runSandboxedEvidence on timeout or abort.
      const group = spawn("/bin/sh", ["-c", "sleep 30 & wait"], { detached: true, stdio: "ignore" });
      const groupPid = group.pid;
      assert.ok(groupPid && groupPid > 0);
      const stopped = await terminateSandboxProcessGroup(group, "SIGTERM", 250);
      assert.equal(stopped, true, "canonical sandbox cleanup waits for the process group");
      await sleep(50);
      assert.equal(alive(groupPid), false, "sandbox cleanup removes descendants with the group");
    
      console.log(JSON.stringify({ freshCancel: "drained", lateIdentity: "cleaned", staleUpdates: "suppressed", evidenceDiscard: "drained", evidenceCancel: "drained", evidenceCrash: "retired", descendants: "cleaned" }));
    } finally {
      process.env.PATH = realPath;
      await manager?.dispose().catch(() => {});
      disposeWorldlineCoreClient();
      await rm(root, { recursive: true, force: true });
      await stop();
    }
    
  }, 120_000);
});
