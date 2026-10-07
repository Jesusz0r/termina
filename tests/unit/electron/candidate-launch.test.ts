import { afterEach, describe, expect, it, vi } from "vitest";
import { CandidateLaunch, type CandidateLaunchHost } from "../../../electron/worldlines/candidate-launch.ts";
import { READY_TIMEOUT_MS } from "../../../electron/worldlines/limits.ts";
import type { CandidateReadyEvent, CandidateState, ComparisonState } from "../../../electron/worldlines/types.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const cand: CandidateState = {
    label: "A", role: "moment", dir: "/worlds/cmp/A", supportDir: "/worlds/cmp/A-support",
    homeDir: "/worlds/cmp/A-support/home", sessionDir: "/worlds/cmp/A-support/sessions",
    eventsDir: "/worlds/cmp/A-support/events", tmpDir: "/worlds/cmp/A-support/tmp",
    cacheDir: "/worlds/cmp/A-support/cache", profilePath: "/worlds/cmp/profiles/A.sb",
    sessionFile: "/worlds/cmp/A-support/sessions/session/current/active.jsonl",
    comparisonBaseStateId: "base", promotionBaseStateId: "base", headStateId: "head",
    headCommit: Promise.resolve(), terminalId: null, pid: null, lstart: null,
    startupControlOpId: "startup-a", state: "creating", version: 1, error: null,
  };
  const cmp: ComparisonState = {
    id: "cmp", dir: "/worlds/cmp", templateDir: "/worlds/cmp/template", sourceRunId: "run",
    sourceGitDir: "/primary/.git", primaryRoot: "/primary", baseCommit: "base", baseStateId: "base",
    model: null, thinkingLevel: null, engine: "core", expectedCandidates: 1,
    uncertainSessionArtifacts: [], manifestWriteFailed: false, teardownPromise: null,
    removeUncertainRequested: false, createdAt: 1, candidates: new Map([["A", cand]]),
    phase: "creating", error: null,
  };
  const spawned = deferred<void>();
  const host: CandidateLaunchHost = {
    comparisons: new Map([[cmp.id, cmp]]), closingComparisons: new Set(),
    comparisonIsLive: (target) => host.comparisons.get(target.id) === target && !host.closingComparisons.has(target.id),
    ensureComparisonLive: (target) => { if (!host.comparisonIsLive(target)) throw new Error("comparison closed"); },
    pushUpdate: vi.fn(), updateManifest: vi.fn(async () => {}),
    candidateLaunch: vi.fn(async () => ({ cmd: "sandbox-exec", args: [], env: {} })),
    writeControl: vi.fn(async () => {}), teardown: vi.fn(async () => {}),
    createCandidate: vi.fn(async (opts) => {
      opts.beforeSpawn?.("term-candidate");
      spawned.resolve();
      return { terminalId: "term-candidate", pid: 0 };
    }),
    createCandidateWorkspace: vi.fn(() => "workspace-candidate"), terminateCandidate: vi.fn(), terminalLive: () => false,
  };
  const launch = new CandidateLaunch(host);
  const ready = (ok = true, event: CandidateReadyEvent = {}) => launch.onSessionReady("term-candidate", ok, ok ? null : "session rejected", {
    opId: "startup-a", bridgeId: "bridge-a", generation: "generation-a", seq: 1, ...event,
  });
  return { cand, cmp, host, launch, spawned, ready };
}

async function drainContinuations() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe("fresh candidate admission and readiness", () => {
  it.each(["session", "control"])("rejects missing %s preparation before registering an attempt", async (missing) => {
    const { cand, cmp, host, launch } = fixture();
    if (missing === "session") cand.sessionFile = null;
    else cand.startupControlOpId = undefined;
    await expect(launch.launchCandidate(cmp, cand, "head")).rejects.toThrow(missing === "session" ? "session fork did not commit" : "startup control is missing");
    expect(host.createCandidate).not.toHaveBeenCalled();
    expect(launch.candidateLaunchAttempts.size).toBe(0);
    expect(launch.pendingCandidateReadies.size).toBe(0);
  });

  it("keeps the exact attempt pending until a delayed valid session confirmation", async () => {
    const { cand, host, launch, spawned, ready } = fixture();
    let finished = false;
    const operation = launch.launchCandidate(host.comparisons.get("cmp")!, cand, "head").then(() => { finished = true; });
    try {
      await spawned.promise;
      await drainContinuations();
      expect(finished).toBe(false);
      expect(cand.state).toBe("creating");
      expect(launch.candidateLaunchAttempts.size).toBe(1);
      for (const event of [{ opId: "old-operation" }, { generation: "" }, { bridgeId: "" }, { seq: 0 }]) ready(true, event);
      await drainContinuations();
      expect(finished).toBe(false);
      ready();
      await operation;
      expect(cand.state).toBe("ready");
      expect(launch.candidateLaunchAttempts.size).toBe(0);
      expect(launch.pendingCandidateReadies.size).toBe(0);
      const version = cand.version;
      const updates = vi.mocked(host.pushUpdate).mock.calls.length;
      ready();
      expect(cand.version).toBe(version);
      expect(host.pushUpdate).toHaveBeenCalledTimes(updates);
    } finally {
      await launch.cancelLaunches("cmp");
      await operation.catch(() => {});
    }
  });

  it("does not publish an immediate confirmation before the manifest is durable", async () => {
    const { cand, cmp, host, launch, ready } = fixture();
    const writing = deferred<void>();
    const manifest = deferred<void>();
    host.updateManifest = vi.fn(async () => { writing.resolve(); await manifest.promise; });
    host.createCandidate = async (opts) => { opts.beforeSpawn?.("term-candidate"); ready(); return { terminalId: "term-candidate", pid: 0 }; };
    const operation = launch.launchCandidate(cmp, cand, "head");
    try {
      await writing.promise;
      expect(cand.state).toBe("creating");
      expect(host.pushUpdate).not.toHaveBeenCalled();
      manifest.resolve();
      await operation;
      expect(cand.state).toBe("ready");
    } finally {
      manifest.resolve();
      await launch.cancelLaunches("cmp");
      await operation.catch(() => {});
    }
  });

  it("cleans up a rejected startup and permits a new exact attempt", async () => {
    const { cand, cmp, host, launch, spawned, ready } = fixture();
    const operation = launch.launchCandidate(cmp, cand, "head");
    const rejected = expect(operation).rejects.toThrow("session rejected");
    await spawned.promise;
    ready(false);
    await rejected;
    expect(host.terminateCandidate).toHaveBeenCalledWith("term-candidate");
    expect(launch.candidateLaunchAttempts.size).toBe(0);
    expect(launch.pendingCandidateReadies.size).toBe(0);
    expect(launch.terminalToComparison.size).toBe(0);
    expect(cand.terminalId).toBeNull();
    cand.startupControlOpId = "startup-retry";
    host.createCandidate = async (opts) => {
      opts.beforeSpawn?.("term-retry");
      ready(true);
      launch.onSessionReady("term-retry", true, null, { opId: "startup-retry", bridgeId: "retry", generation: "retry-generation", seq: 1 });
      return { terminalId: "term-retry", pid: 0 };
    };
    await launch.launchCandidate(cmp, cand, "head");
    expect(cand.state).toBe("ready");
    expect(cand.terminalId).toBe("term-retry");
  });

  it("times out a missing confirmation without retaining the terminal or waiter", async () => {
    vi.useFakeTimers();
    const { cand, cmp, host, launch, spawned } = fixture();
    const operation = launch.launchCandidate(cmp, cand, "head");
    const rejected = expect(operation).rejects.toThrow("did not become ready in time");
    await spawned.promise;
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
    await rejected;
    expect(host.terminateCandidate).toHaveBeenCalledWith("term-candidate");
    expect(launch.candidateLaunchAttempts.size).toBe(0);
    expect(launch.pendingCandidateReadies.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cannot publish readiness after exit during manifest persistence", async () => {
    const { cand, cmp, host, launch, ready } = fixture();
    const writing = deferred<void>();
    const manifest = deferred<void>();
    host.updateManifest = async () => { writing.resolve(); await manifest.promise; };
    host.createCandidate = async (opts) => { opts.beforeSpawn?.("term-candidate"); ready(); return { terminalId: "term-candidate", pid: 0 }; };
    const operation = launch.launchCandidate(cmp, cand, "head");
    const rejected = expect(operation).rejects.toThrow("cancelled");
    await writing.promise;
    expect(launch.consumeTerminalExit(cmp, cand, "term-candidate")).toBe(true);
    manifest.resolve();
    await rejected;
    expect(cand.state).toBe("creating");
    expect(host.pushUpdate).not.toHaveBeenCalled();
    expect(launch.pendingCandidateReadies.size).toBe(0);
  });
});
