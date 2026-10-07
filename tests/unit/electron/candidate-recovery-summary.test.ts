import { describe, expect, it, vi } from "vitest";
import { WorldlineManager } from "../../../electron/worldlines/manager.ts";
import { CandidateLaunch, type CandidateLaunchHost } from "../../../electron/worldlines/candidate-launch.ts";
import type { CandidateState, ComparisonState } from "../../../electron/worldlines/types.ts";
import type { WorldlineState } from "../../../shared/types.ts";

function fixture() {
  const candidate: CandidateState = {
    label: "A", role: "moment", dir: "/worlds/comparison/A", supportDir: "/worlds/comparison/A-support",
    homeDir: "/worlds/comparison/A-support/home", sessionDir: "/worlds/comparison/A-support/sessions",
    eventsDir: "/worlds/comparison/A-support/events", tmpDir: "/worlds/comparison/A-support/tmp",
    cacheDir: "/worlds/comparison/A-support/cache", profilePath: "/worlds/comparison/profiles/A.sb",
    sessionFile: "/worlds/comparison/A-support/sessions/current/active.jsonl",
    comparisonBaseStateId: "base", promotionBaseStateId: "base", headStateId: "head",
    headCommit: Promise.resolve(), terminalId: null, pid: null, lstart: null,
    state: "error", version: 4, error: "the candidate session failed to start: rejected",
  };
  const comparison: ComparisonState = {
    id: "comparison", dir: "/worlds/comparison", templateDir: "/worlds/comparison/template",
    sourceRunId: "run", sourceGitDir: "/primary/.git", primaryRoot: "/primary",
    baseCommit: "base-commit", baseStateId: "base", model: null, thinkingLevel: null, engine: "core",
    expectedCandidates: 1, uncertainSessionArtifacts: [], manifestWriteFailed: false,
    teardownPromise: null, removeUncertainRequested: false, createdAt: 1,
    candidates: new Map([["A", candidate]]), phase: "running", error: null,
  };
  // Like worldline-fork-admission: isolate the synchronous projection from native startup I/O.
  const state = {
    comparisons: new Map([[comparison.id, comparison]]), closingComparisons: new Set<string>(),
    sessionForkClosing: false, readyError: null as Error | null,
  };
  const manager: WorldlineManager = Object.assign(Object.create(WorldlineManager.prototype), state);
  return { manager, state, comparison, candidate };
}

describe("retained candidate recovery summaries", () => {
  it("projects the authoritative retained session, error and version without mutating state", () => {
    const f = fixture();
    const [summary] = f.manager.recoverySummaries();
    expect(summary).toEqual({
      comparisonId: "comparison", label: "A", root: f.candidate.dir, version: 4,
      error: f.candidate.error, recovery: "open",
    });
    summary.error = "renderer-local change";
    expect(f.candidate.error).toBe("the candidate session failed to start: rejected");
    f.candidate.version++;
    f.candidate.error = "a later reopen failed";
    expect(f.manager.recoverySummaries()[0]).toMatchObject({ version: 5, error: "a later reopen failed" });
  });

  it.each(["phase", "comparison admission", "manager admission"] as const)(
    "makes retained failures discard-only when %s closes",
    (closure) => {
      const f = fixture();
      if (closure === "phase") f.comparison.phase = "error";
      else if (closure === "comparison admission") f.state.closingComparisons.add(f.comparison.id);
      else (f.manager as unknown as { sessionForkClosing: boolean }).sessionForkClosing = true;
      expect(f.manager.recoverySummaries()).toEqual([{
        comparisonId: "comparison", label: "A", root: f.candidate.dir, version: 4,
        error: f.candidate.error, recovery: "discard",
      }]);
    },
  );

  it("includes comparison-level retained failures even when session fork never committed", () => {
    const f = fixture();
    f.comparison.phase = "error";
    f.state.closingComparisons.add(f.comparison.id);
    f.comparison.uncertainSessionArtifacts.push({ path: "/uncertain/session", error: "commit uncertain" });
    f.candidate.sessionFile = null;
    expect(f.manager.recoverySummaries()[0]?.recovery).toBe("discard");
  });

  it("projects canonical teardown-retained errors as discard-only", async () => {
    const f = fixture();
    f.comparison.phase = "creating";
    f.candidate.state = "creating";
    f.candidate.error = null;
    f.candidate.sessionFile = null;
    f.comparison.uncertainSessionArtifacts.push({ path: "/uncertain/session", error: "commit uncertain" });
    const removed = vi.fn();
    const removeOwnedDir = vi.fn();
    Object.assign(f.manager, {
      launch: {
        cancelPending: vi.fn(), cancelLaunches: async () => {}, terminateCandidateProcess: async () => {},
      },
      cancelEvidence: async () => {}, cancelSessionForks: async () => {},
      pushUpdate: vi.fn(), removeOwnedDir, deps: { onRemoved: removed },
    });
    const lifecycle = f.manager as unknown as {
      teardown(id: string, state: WorldlineState, error: string | null): Promise<void>;
    };
    await lifecycle.teardown(f.comparison.id, "error", "session fork commit uncertain");
    expect(f.state.comparisons.get(f.comparison.id)).toBe(f.comparison);
    expect(f.state.closingComparisons.has(f.comparison.id)).toBe(true);
    expect(f.manager.recoverySummaries()).toEqual([{
      comparisonId: "comparison", label: "A", root: f.candidate.dir, version: 5,
      error: "session fork commit uncertain", recovery: "discard",
    }]);
    expect(removeOwnedDir).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
  });

  it("does not offer reopening a live comparison candidate without a retained session", () => {
    const f = fixture();
    f.candidate.sessionFile = null;
    expect(f.manager.recoverySummaries()).toEqual([]);
  });

  it.each(["creating", "ready", "running", "settled", "promoting", "promoted", "cancelled", "discarding", "discarded", "conflict"] satisfies WorldlineState[])(
    "excludes candidate state %s",
    (state) => {
      const f = fixture();
      f.candidate.state = state;
      expect(f.manager.recoverySummaries()).toEqual([]);
    },
  );

  it("excludes comparison preparation, removed comparisons and failed manager startup", () => {
    const f = fixture();
    f.comparison.phase = "creating";
    expect(f.manager.recoverySummaries()).toEqual([]);
    f.comparison.phase = "running";
    f.state.comparisons.delete(f.comparison.id);
    expect(f.manager.recoverySummaries()).toEqual([]);
    f.state.comparisons.set(f.comparison.id, f.comparison);
    (f.manager as unknown as { readyError: Error | null }).readyError = new Error("startup failed");
    expect(f.manager.recoverySummaries()).toEqual([]);
  });

  it.each(["terminal", "process", "startup attempt"] as const)("excludes a retained %s identity", (identity) => {
    const f = fixture();
    if (identity === "terminal") f.candidate.terminalId = "term-2";
    else if (identity === "process") f.candidate.pid = 123;
    else f.candidate.startupAttemptId = "pending-attempt";
    expect(f.manager.recoverySummaries()).toEqual([]);
  });

  it("projects each real candidate label rather than inventing a terminal or task", () => {
    const f = fixture();
    f.comparison.expectedCandidates = 2;
    f.comparison.candidates.set("B", { ...f.candidate, label: "B", role: "alternative", dir: "/worlds/comparison/B" });
    expect(f.manager.recoverySummaries().map(({ label, root }) => ({ label, root }))).toEqual([
      { label: "A", root: "/worlds/comparison/A" }, { label: "B", root: "/worlds/comparison/B" },
    ]);
  });

  it("exposes a canonical failed reopen and removes recovery after retry reaches ready", async () => {
    const f = fixture();
    f.candidate.state = "settled";
    f.candidate.error = null;
    const lifecycle = f.manager as unknown as {
      comparisonIsLive(cmp: ComparisonState): boolean;
      ensureComparisonLive(cmp: ComparisonState): void;
      launch: CandidateLaunch;
    };
    let controlOpId = "";
    const host: CandidateLaunchHost = {
      comparisons: f.state.comparisons, closingComparisons: f.state.closingComparisons,
      comparisonIsLive: (cmp) => lifecycle.comparisonIsLive(cmp),
      ensureComparisonLive: (cmp) => lifecycle.ensureComparisonLive(cmp),
      pushUpdate: vi.fn(), updateManifest: async () => {},
      candidateLaunch: vi.fn()
        .mockRejectedValueOnce(new Error("sandbox launch unavailable"))
        .mockResolvedValue({ cmd: "unused", args: [], env: {} }),
      writeControl: async (_cand, control) => { controlOpId = String(control.opId); },
      teardown: async () => { throw new Error("reopen must not tear down the comparison"); },
      createCandidate: async (opts) => {
        opts.beforeSpawn?.("term-retry");
        lifecycle.launch.onSessionReady("term-retry", true, null, {
          opId: controlOpId, bridgeId: "bridge", generation: "generation", seq: 1,
        });
        return { terminalId: "term-retry", pid: 0 };
      },
      createCandidateWorkspace: () => "candidate-workspace", terminalLive: () => false,
      terminateCandidate: vi.fn(),
    };
    lifecycle.launch = new CandidateLaunch(host);
    expect(await f.manager.openTerminal(f.comparison.id, "A")).toEqual({ ok: false, error: "sandbox launch unavailable" });
    expect(f.candidate).toMatchObject({ state: "error", terminalId: null, pid: null, lstart: null });
    expect(f.manager.recoverySummaries()[0]).toMatchObject({ recovery: "open", error: "sandbox launch unavailable" });
    expect(await f.manager.openTerminal(f.comparison.id, "A")).toEqual({ ok: true, terminalId: "term-retry" });
    expect(f.candidate.state).toBe("ready");
    expect(f.manager.recoverySummaries()).toEqual([]);
    expect(host.pushUpdate).toHaveBeenCalledTimes(4);
  });
});
