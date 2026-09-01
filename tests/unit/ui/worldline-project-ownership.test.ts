import { describe, it, expect, beforeEach } from "vitest";
import {
  applyWorldlineHydration,
  applyWorldlineRemoval,
  beginWorldlineHydration,
  clearWorldlineProjectUi,
  handleWorldlineBusy,
  handleWorldlineInstances,
  refreshWorldlineCandidateTest,
  refreshWorldlinePaneLabel,
  updateWorldlinePaneTab,
  worldlineEventBelongsToProject,
} from "../../../src/worldline-project-state.ts";

describe("Worldline Multi-Project Ownership & UI Reconciliation", () => {
  let panes: any[];
  let visible: Map<string, any>;
  let labelsByTerminal: Map<string, string>;
  let paneBadges: Map<string, string | null>;
  let tabBadges: Map<string, any>;
  let tombstones: Set<string> | null;
  let editorBadgeRefreshes: number;
  let candidateTestRefreshes: number;
  let editorLockRefreshes: number;
  let panesById: Map<string, any>;
  let selectedProjectId: string | null;
  let selectedHydrationEpoch: number;
  let pendingDetections: Map<string, any>;
  let detectCalls: string[];
  let candidateChanges: any[];
  let candidateErrors: string[];
  let candidateRefreshesByPane: Map<string, number>;
  let activePaneId: string;
  let activeCandidateUiRenders: any[];
  let candidateBindings: any;
  let rendererBindings: any;
  let effects: any;

  function badge() {
    return {
      textContent: "",
      style: { display: "none" },
      title: "",
      classList: { toggle() {} },
    };
  }

  function deferred() {
    let resolve: any;
    let reject: any;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  async function flushPromises() {
    await new Promise((resolve) => setImmediate(resolve));
  }

  beforeEach(() => {
    panes = [
      { id: "terminal-a", instanceId: "terminal-a", projectId: "project-a", worldlineLabel: "A", testCommand: null, candidateTestEpoch: 0, cwd: "/project-a", workspaceId: "workspace-a", busy: false, type: "agent", engine: "core", shellName: undefined, dispatchWorker: false, dispatchTask: undefined, verify: { state: "untested", command: null, summary: null } },
      { id: "terminal-b1", instanceId: "terminal-b1", projectId: "project-b", worldlineLabel: "B", testCommand: "stale candidate command", candidateTestEpoch: 0, cwd: "/project-b/b1", workspaceId: "workspace-b", busy: false, type: "agent", engine: "core", shellName: undefined, dispatchWorker: false, dispatchTask: undefined, verify: { state: "untested", command: null, summary: null } },
      { id: "terminal-b2", instanceId: "terminal-b2", projectId: "project-b", worldlineLabel: "B", testCommand: null, candidateTestEpoch: 0, cwd: "/project-b/b2", workspaceId: "workspace-b", busy: false, type: "agent", engine: "core", shellName: undefined, dispatchWorker: false, dispatchTask: undefined, verify: { state: "untested", command: null, summary: null } },
    ];
    visible = new Map();
    labelsByTerminal = new Map();
    paneBadges = new Map([
      ["terminal-a", "A"],
      ["terminal-b1", "B"],
      ["terminal-b2", "B"],
    ]);
    tabBadges = new Map(panes.map((pane) => [pane.id, badge()]));
    tombstones = new Set();
    editorBadgeRefreshes = 0;
    candidateTestRefreshes = 0;
    editorLockRefreshes = 0;
    panesById = new Map(panes.map((pane) => [pane.instanceId, pane]));
    selectedProjectId = "project-b";
    selectedHydrationEpoch = 10;
    pendingDetections = new Map();
    detectCalls = [];
    candidateChanges = [];
    candidateErrors = [];
    candidateRefreshesByPane = new Map();
    activePaneId = "terminal-b1";
    activeCandidateUiRenders = [];

    candidateBindings = {
      activeProjectId: () => selectedProjectId,
      hydrationEpoch: () => selectedHydrationEpoch,
      isActivePane: (instanceId: string) => instanceId === activePaneId,
      paneById: (instanceId: string) => panesById.get(instanceId),
      detectTest: (instanceId: string) => {
        detectCalls.push(instanceId);
        const pending = pendingDetections.get(instanceId);
        return pending ? pending.promise : Promise.resolve({ label: "npm test" });
      },
      onChanged: (pane: any) => {
        candidateChanges.push([pane.instanceId, pane.testCommand]);
        if (pane.instanceId === activePaneId) activeCandidateUiRenders.push([pane.instanceId, pane.testCommand]);
      },
      onError: (error: any) => candidateErrors.push(String(error)),
    };

    const updateTab = (pane: any) => {
      updateWorldlinePaneTab(
        selectedProjectId,
        pane,
        (instanceId: string) => labelsByTerminal.get(instanceId) ?? null,
        tabBadges.get(pane.id) ?? null,
      );
      paneBadges.set(pane.id, pane.worldlineLabel);
    };

    rendererBindings = {
      resetView() {
        visible.clear();
        labelsByTerminal.clear();
      },
      clearTombstones() {
        tombstones = null;
      },
      addTombstone(comparisonId: string) {
        tombstones?.add(comparisonId);
      },
      removeComparison(comparisonId: string) {
        const terminalId = visible.get(comparisonId)?.terminalId;
        visible.delete(comparisonId);
        if (terminalId) labelsByTerminal.delete(terminalId);
      },
      upsert(summary: any) {
        visible.set(summary.comparisonId, summary);
        if (summary.terminalId) labelsByTerminal.set(summary.terminalId, summary.label);
      },
      updatePaneTab: updateTab,
      refreshCandidateTest(pane: any) {
        candidateTestRefreshes++;
        candidateRefreshesByPane.set(pane.instanceId, (candidateRefreshesByPane.get(pane.instanceId) ?? 0) + 1);
        refreshWorldlineCandidateTest(pane, candidateBindings);
      },
      refreshEditorBadges() {
        editorBadgeRefreshes++;
      },
      updateEditorLock() {
        editorLockRefreshes++;
      },
    };
    effects = rendererBindings;
  });

  it("reconciles removed candidates without leaking changes to background projects", async () => {
    visible.set("comparison-b1", { comparisonId: "comparison-b1", terminalId: "terminal-b1", label: "B" });
    visible.set("comparison-b2", { comparisonId: "comparison-b2", terminalId: "terminal-b2", label: "B" });
    labelsByTerminal.set("terminal-b1", "B");
    labelsByTerminal.set("terminal-b2", "B");
    const pendingB1Removal = deferred();
    pendingDetections.set("terminal-b1", pendingB1Removal);
    effects.refreshCandidateTest(panes[1]);
    const b1RefreshesBeforeRemoval = candidateRefreshesByPane.get("terminal-b1") ?? 0;
    const b2RefreshesBeforeRemoval = candidateRefreshesByPane.get("terminal-b2") ?? 0;
    activePaneId = "terminal-b2";

    const removed = applyWorldlineRemoval(
      "project-b",
      { projectId: "project-b", comparisonId: "comparison-b1" },
      panes,
      effects,
    );
    expect(removed).toBe(true);
    expect(visible.has("comparison-b1")).toBe(false);
    expect(paneBadges.get("terminal-b1")).toBeNull();
    expect(tabBadges.get("terminal-b1").textContent).toBe("");
    expect(tabBadges.get("terminal-b1").style.display).toBe("none");
    expect(panes[1].testCommand).toBeNull();
    expect(paneBadges.get("terminal-a")).toBe("A");
    expect(candidateRefreshesByPane.get("terminal-b1")).toBe(b1RefreshesBeforeRemoval + 1);
    expect(candidateRefreshesByPane.get("terminal-b2")).toBe(b2RefreshesBeforeRemoval + 1);
    expect(activePaneId).not.toBe(panes[1].instanceId);
    expect(activeCandidateUiRenders.some(([instanceId]) => instanceId === "terminal-b1")).toBe(false);
    expect([...tombstones!]).toEqual(["comparison-b1"]);

    pendingB1Removal.resolve({ label: "late after non-active removal" });
    await flushPromises();
    expect(panes[1].testCommand).toBeNull();
  });

  it("handles busy routing and preserves background project badges", () => {
    selectedProjectId = "project-a";
    activePaneId = "terminal-a";
    const busyRenders: string[] = [];
    const busyHandled = handleWorldlineBusy(
      { instanceId: "terminal-b2", busy: true },
      {
        paneById: (instanceId: string) => panesById.get(instanceId),
        updatePaneTab: (pane: any) => {
          updateWorldlinePaneTab(
            selectedProjectId,
            pane,
            (instanceId: string) => labelsByTerminal.get(instanceId) ?? null,
            tabBadges.get(pane.id) ?? null,
          );
          paneBadges.set(pane.id, pane.worldlineLabel);
        },
        updateEditorLock: () => editorLockRefreshes++,
        activePaneId: () => activePaneId,
        renderStatus: (pane: any) => busyRenders.push(pane.instanceId),
      },
    );
    expect(busyHandled).toBe(true);
    expect(panes[2].busy).toBe(true);
    expect(busyRenders).toEqual([]);
    expect(panes[2].worldlineLabel).toBe("B");
    expect(tabBadges.get("terminal-b2").textContent).toBe("B");
    expect(tabBadges.get("terminal-b2").style.display).toBe("");
  });

  it("manages candidate test detection and rejects late results after switch or close", async () => {
    selectedProjectId = "project-b";
    activePaneId = "terminal-b2";
    const paneB = panes[2];
    const pendingB2Current = deferred();
    pendingDetections.set("terminal-b2", pendingB2Current);
    effects.refreshCandidateTest(paneB);
    pendingB2Current.resolve({ label: "npm test" });
    await flushPromises();
    expect(paneB.testCommand).toBe("npm test");

    // Clear stale candidate on non-active refresh
    panes[1].worldlineLabel = "B";
    panes[1].testCommand = "stale hidden command";
    effects.refreshCandidateTest(panes[1]);
    expect(panes[1].testCommand).toBeNull();

    // Clear on label removal
    const pendingB2Removal = deferred();
    pendingDetections.set("terminal-b2", pendingB2Removal);
    paneB.worldlineLabel = "B";
    effects.refreshCandidateTest(paneB);
    paneB.worldlineLabel = null;
    paneB.testCommand = "stale candidate command";
    effects.refreshCandidateTest(paneB);
    expect(paneB.testCommand).toBeNull();
    pendingB2Removal.resolve({ label: "late after removal" });
    await flushPromises();
    expect(paneB.testCommand).toBeNull();

    // Reject late result after project switch
    const pendingB2Switch = deferred();
    pendingDetections.set("terminal-b2", pendingB2Switch);
    paneB.worldlineLabel = "B";
    effects.refreshCandidateTest(paneB);
    paneB.testCommand = null;
    selectedProjectId = "project-a";
    selectedHydrationEpoch++;
    pendingB2Switch.resolve({ label: "late after project switch" });
    await flushPromises();
    expect(paneB.testCommand).toBeNull();
    expect(candidateErrors).toEqual([]);
  });

  it("hydrates new project state and clears closed project state cleanly", () => {
    tombstones = new Set();
    paneBadges.set("terminal-a", "A");
    paneBadges.set("terminal-b1", "stale");
    paneBadges.set("terminal-b2", "stale");
    beginWorldlineHydration("project-b", panes, effects);
    expect(visible.size).toBe(0);
    expect(paneBadges.get("terminal-a")).toBe("A");
    expect(paneBadges.get("terminal-b1")).toBeNull();
    expect(paneBadges.get("terminal-b2")).toBeNull();

    const hydrated = applyWorldlineHydration(
      "project-b",
      "project-b",
      [{ comparisonId: "comparison-b-current", terminalId: "terminal-b2", label: "B" }],
      tombstones,
      panes,
      effects,
    );
    expect(hydrated).toBe(true);
    expect(paneBadges.get("terminal-a")).toBe("A");
    expect(paneBadges.get("terminal-b1")).toBeNull();
    expect(paneBadges.get("terminal-b2")).toBe("B");
    expect(visible.has("comparison-b-current")).toBe(true);

    // Stale project hydration is ignored
    expect(
      applyWorldlineHydration(
        "project-b",
        "project-a",
        [{ comparisonId: "comparison-a-late", terminalId: "terminal-a", label: "A" }],
        new Set(),
        panes,
        effects,
      ),
    ).toBe(false);

    // Clearing UI on project close
    tombstones = new Set(["comparison-b-current"]);
    selectedProjectId = null;
    selectedHydrationEpoch++;
    clearWorldlineProjectUi(panes, effects);
    expect(visible.size).toBe(0);
    expect(tombstones).toBeNull();
    expect(panes.every((pane) => pane.worldlineLabel === null)).toBe(true);
    expect(worldlineEventBelongsToProject(null, { projectId: "project-b" })).toBe(false);
    expect(worldlineEventBelongsToProject("project-a", { projectId: "project-b" })).toBe(false);
    expect(worldlineEventBelongsToProject("project-b", { projectId: "project-b" })).toBe(true);
  });
});
