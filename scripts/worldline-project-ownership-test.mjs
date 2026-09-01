import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const bundleDir = mkdtempSync(join(tmpdir(), "termina-worldline-ownership-"));
const bundlePath = join(bundleDir, "worldline-project-state.mjs");
process.once("exit", () => rmSync(bundleDir, { recursive: true, force: true }));
await build({
  entryPoints: [new URL("../src/worldline-project-state.ts", import.meta.url).pathname],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: bundlePath,
  logLevel: "silent",
});
const production = await import(pathToFileURL(bundlePath).href);

const {
  applyWorldlineHydration,
  applyWorldlineRemoval,
  beginWorldlineHydration,
  clearWorldlineProjectUi,
  handleWorldlineBusy,
  handleWorldlineInstances,
  handleWorldlineRemoved,
  refreshWorldlineCandidateTest,
  refreshWorldlinePaneLabel,
  updateWorldlinePaneTab,
  worldlineEventBelongsToProject,
  worldlineProjectEffects,
} = production;

for (const [name, value] of Object.entries({
  applyWorldlineHydration,
  applyWorldlineRemoval,
  beginWorldlineHydration,
  clearWorldlineProjectUi,
  handleWorldlineBusy,
  handleWorldlineInstances,
  handleWorldlineRemoved,
  refreshWorldlineCandidateTest,
  refreshWorldlinePaneLabel,
  updateWorldlinePaneTab,
  worldlineEventBelongsToProject,
  worldlineProjectEffects,
})) {
  assert.equal(typeof value, "function", `${name} must be a production-owned function`);
}

const panes = [
  { id: "terminal-a", instanceId: "terminal-a", projectId: "project-a", worldlineLabel: "A", testCommand: null, candidateTestEpoch: 0, cwd: "/project-a", workspaceId: "workspace-a", busy: false, type: "agent", engine: "core", shellName: undefined, dispatchWorker: false, dispatchTask: undefined, verify: { state: "untested", command: null, summary: null } },
  { id: "terminal-b1", instanceId: "terminal-b1", projectId: "project-b", worldlineLabel: "B", testCommand: "stale candidate command", candidateTestEpoch: 0, cwd: "/project-b/b1", workspaceId: "workspace-b", busy: false, type: "agent", engine: "core", shellName: undefined, dispatchWorker: false, dispatchTask: undefined, verify: { state: "untested", command: null, summary: null } },
  { id: "terminal-b2", instanceId: "terminal-b2", projectId: "project-b", worldlineLabel: "B", testCommand: null, candidateTestEpoch: 0, cwd: "/project-b/b2", workspaceId: "workspace-b", busy: false, type: "agent", engine: "core", shellName: undefined, dispatchWorker: false, dispatchTask: undefined, verify: { state: "untested", command: null, summary: null } },
];
const visible = new Map();
const labelsByTerminal = new Map();
const paneBadges = new Map([
  ["terminal-a", "A"],
  ["terminal-b1", "B"],
  ["terminal-b2", "B"],
]);
function badge() {
  return {
    textContent: "",
    style: { display: "none" },
    title: "",
    classList: { toggle() {} },
  };
}
const tabBadges = new Map(panes.map((pane) => [pane.id, badge()]));
let tombstones = new Set();
let editorBadgeRefreshes = 0;
let candidateTestRefreshes = 0;
let editorLockRefreshes = 0;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await new Promise((resolve) => setImmediate(resolve));
}

const panesById = new Map(panes.map((pane) => [pane.instanceId, pane]));
let selectedProjectId = "project-b";
let selectedHydrationEpoch = 10;
const pendingDetections = new Map();
const detectCalls = [];
const candidateChanges = [];
const candidateErrors = [];
const candidateRefreshesByPane = new Map();
let activePaneId = "terminal-b1";
const activeCandidateUiRenders = [];
const candidateBindings = {
  activeProjectId: () => selectedProjectId,
  hydrationEpoch: () => selectedHydrationEpoch,
  isActivePane: (instanceId) => instanceId === activePaneId,
  paneById: (instanceId) => panesById.get(instanceId),
  detectTest: (instanceId) => {
    detectCalls.push(instanceId);
    const pending = pendingDetections.get(instanceId);
    return pending ? pending.promise : Promise.resolve({ label: "npm test" });
  },
  onChanged: (pane) => {
    candidateChanges.push([pane.instanceId, pane.testCommand]);
    if (pane.instanceId === activePaneId) activeCandidateUiRenders.push([pane.instanceId, pane.testCommand]);
  },
  onError: (error) => candidateErrors.push(String(error)),
};

const updateTab = (pane) => {
  updateWorldlinePaneTab(
    selectedProjectId,
    pane,
    (instanceId) => labelsByTerminal.get(instanceId) ?? null,
    tabBadges.get(pane.id) ?? null,
  );
  paneBadges.set(pane.id, pane.worldlineLabel);
};
const rendererBindings = {
  resetView() {
    visible.clear();
    labelsByTerminal.clear();
  },
  clearTombstones() {
    tombstones = null;
  },
  addTombstone(comparisonId) {
    tombstones?.add(comparisonId);
  },
  removeComparison(comparisonId) {
    const terminalId = visible.get(comparisonId)?.terminalId;
    visible.delete(comparisonId);
    if (terminalId) labelsByTerminal.delete(terminalId);
  },
  upsert(summary) {
    visible.set(summary.comparisonId, summary);
    if (summary.terminalId) labelsByTerminal.set(summary.terminalId, summary.label);
  },
  updatePaneTab: updateTab,
  refreshCandidateTest(pane) {
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
const effects = worldlineProjectEffects(rendererBindings);

// A valid removal must reconcile every pane in the owning project, including
// a non-active candidate pane, without touching hidden A's retained badge.
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
const removed = handleWorldlineRemoved(
  "project-b",
  { projectId: "project-b", comparisonId: "comparison-b1" },
  panes,
  effects,
);
assert.equal(removed, true);
assert.equal(visible.has("comparison-b1"), false);
assert.equal(paneBadges.get("terminal-b1"), null);
assert.equal(tabBadges.get("terminal-b1").textContent, "");
assert.equal(tabBadges.get("terminal-b1").style.display, "none");
assert.equal(panes[1].testCommand, null, "removal must clear a non-active pane's stale candidate test command");
assert.equal(paneBadges.get("terminal-a"), "A", "B removal must preserve hidden A's badge");
assert.equal(candidateRefreshesByPane.get("terminal-b1"), b1RefreshesBeforeRemoval + 1, "reconciliation must refresh the removed non-active pane");
assert.equal(candidateRefreshesByPane.get("terminal-b2"), b2RefreshesBeforeRemoval + 1, "reconciliation must refresh the other same-project pane");
assert.notEqual(activePaneId, panes[1].instanceId, "the removed pane is not the active pane during removal");
assert.equal(activeCandidateUiRenders.some(([instanceId]) => instanceId === "terminal-b1"), false, "hidden-pane cleanup must not render through the active pane");
assert.deepEqual([...tombstones], ["comparison-b1"]);
pendingB1Removal.resolve({ label: "late after non-active removal" });
await flushPromises();
assert.equal(panes[1].testCommand, null, "a removed non-active pane cannot accept a late detect result");

// Generic busy/instances refreshes use this production helper. They may
// update ordinary tab metadata, but cannot resolve a hidden pane through the
// active project's label index or clear its retained badge.
selectedProjectId = "project-a";
activePaneId = "terminal-a";
const busyRenders = [];
const busyHandled = handleWorldlineBusy(
  { instanceId: "terminal-b2", busy: true },
  {
    paneById: (instanceId) => panesById.get(instanceId),
    updatePaneTab: updateTab,
    updateEditorLock: () => editorLockRefreshes++,
    activePaneId: () => activePaneId,
    renderStatus: (pane) => busyRenders.push(pane.instanceId),
  },
);
assert.equal(busyHandled, true);
assert.equal(panes[2].busy, true, "busy routing must update the hidden pane through production routing");
assert.deepEqual(busyRenders, [], "hidden busy routing must not render the inactive pane");
assert.equal(panes[2].worldlineLabel, "B", "background B busy must preserve B's hidden badge while A is active");
assert.equal(tabBadges.get("terminal-b2").textContent, "B");
assert.equal(tabBadges.get("terminal-b2").style.display, "");
const instancesHandled = handleWorldlineInstances(
  [{ id: "terminal-b2", cwd: "/project-b/b2", busy: false, type: "agent", engine: "core", workspaceId: "workspace-b", projectId: "project-b" }],
  {
    paneById: (instanceId) => panesById.get(instanceId),
    createPane: (instanceId) => { throw new Error(`unexpected pane creation: ${instanceId}`); },
    updatePaneTab: updateTab,
    setEngine: () => {},
  },
);
assert.equal(instancesHandled, 1);
assert.equal(panes[2].worldlineLabel, "B", "global instances refresh must preserve B's hidden badge while A is active");
assert.equal(tabBadges.get("terminal-b2").textContent, "B");
labelsByTerminal.delete("terminal-a");
handleWorldlineInstances(
  [{ id: "terminal-a", cwd: "/project-a", busy: false, type: "agent", engine: "core", workspaceId: "workspace-a", projectId: "project-a" }],
  {
    paneById: (instanceId) => panesById.get(instanceId),
    createPane: (instanceId) => { throw new Error(`unexpected pane creation: ${instanceId}`); },
    updatePaneTab: updateTab,
    setEngine: () => {},
  },
);
assert.equal(panes[0].worldlineLabel, null, "the active project's reconciliation must still clear a removed label");
assert.equal(tabBadges.get("terminal-a").textContent, "");
assert.equal(tabBadges.get("terminal-a").style.display, "none");

// Candidate test detection is also production-owned state logic. A current
// result applies, losing candidate identity clears the command immediately,
// and every late response is rejected by project/epoch/label ownership.
selectedProjectId = "project-b";
activePaneId = "terminal-b2";
const paneB = panes[2];
const pendingB2Current = deferred();
pendingDetections.set("terminal-b2", pendingB2Current);
effects.refreshCandidateTest(paneB);
pendingB2Current.resolve({ label: "npm test" });
await flushPromises();
assert.equal(paneB.testCommand, "npm test", "the current selected candidate accepts its detected test command");

// A hidden candidate is invalidated but detection stays lazy until it is
// activated; this also rejects any pending result from its prior activation.
const b1DetectsBeforeHiddenRefresh = detectCalls.filter((id) => id === "terminal-b1").length;
panes[1].worldlineLabel = "B";
panes[1].testCommand = "stale hidden command";
effects.refreshCandidateTest(panes[1]);
assert.equal(panes[1].testCommand, null, "a non-active candidate refresh must clear stale state");
assert.equal(detectCalls.filter((id) => id === "terminal-b1").length, b1DetectsBeforeHiddenRefresh, "non-active candidate refresh must remain lazy");

const pendingB2Removal = deferred();
pendingDetections.set("terminal-b2", pendingB2Removal);
paneB.worldlineLabel = "B";
effects.refreshCandidateTest(paneB);
paneB.worldlineLabel = null;
paneB.testCommand = "stale candidate command";
effects.refreshCandidateTest(paneB);
assert.equal(paneB.testCommand, null, "label removal must clear the candidate-local test command immediately");
pendingB2Removal.resolve({ label: "late after removal" });
await flushPromises();
assert.equal(paneB.testCommand, null, "a pre-removal detect result cannot repopulate the cleared command");

const pendingB2Switch = deferred();
pendingDetections.set("terminal-b2", pendingB2Switch);
paneB.worldlineLabel = "B";
effects.refreshCandidateTest(paneB);
paneB.testCommand = null;
selectedProjectId = "project-a";
selectedHydrationEpoch++;
pendingB2Switch.resolve({ label: "late after project switch" });
await flushPromises();
assert.equal(paneB.testCommand, null, "a hidden project's late detect result cannot overwrite its successor");

selectedProjectId = "project-b";
selectedHydrationEpoch++;
const pendingB2Null = deferred();
pendingDetections.set("terminal-b2", pendingB2Null);
paneB.worldlineLabel = "B";
effects.refreshCandidateTest(paneB);
paneB.testCommand = null;
selectedProjectId = null;
selectedHydrationEpoch++;
pendingB2Null.resolve({ label: "late after null close" });
await flushPromises();
assert.equal(paneB.testCommand, null, "a late detect result cannot repopulate state after the last project closes");
assert.equal(detectCalls.filter((id) => id === "terminal-b1").length, 1, "removed non-active pane detection must not restart");
assert.ok(detectCalls.includes("terminal-b2"), "the active candidate must refresh its test command");
assert.deepEqual(candidateErrors, []);

// An inactive push must be completely side-effect free; later hydration owns repair.
selectedProjectId = "project-b";
selectedHydrationEpoch++;
const beforeIgnored = {
  visible: [...visible],
  paneBadges: [...paneBadges],
  tombstones: [...tombstones],
  editorBadgeRefreshes,
  candidateTestRefreshes,
  editorLockRefreshes,
};
assert.equal(
  handleWorldlineRemoved(
    "project-a",
    { projectId: "project-b", comparisonId: "comparison-b-removed" },
    panes,
    effects,
  ),
  false,
);
assert.deepEqual(
  {
    visible: [...visible],
    paneBadges: [...paneBadges],
    tombstones: [...tombstones],
    editorBadgeRefreshes,
    candidateTestRefreshes,
    editorLockRefreshes,
  },
  beforeIgnored,
);

// Switching to B clears stale active UI immediately, then successful hydration
// repairs B from its authoritative list without modifying hidden A.
tombstones = new Set();
paneBadges.set("terminal-a", "A");
paneBadges.set("terminal-b1", "stale");
paneBadges.set("terminal-b2", "stale");
beginWorldlineHydration("project-b", panes, effects);
assert.equal(visible.size, 0);
assert.equal(paneBadges.get("terminal-a"), "A", "B switch must not mutate hidden A");
assert.equal(paneBadges.get("terminal-b1"), null, "B switch must clear removed B1's stale badge during the async gap");
assert.equal(paneBadges.get("terminal-b2"), null, "B switch must clear B2's stale badge during the async gap");
assert.equal(tabBadges.get("terminal-b1").textContent, "");
assert.equal(tabBadges.get("terminal-b2").textContent, "");
const beforeHydrated = { editorBadgeRefreshes, candidateTestRefreshes, editorLockRefreshes };

const hydrated = applyWorldlineHydration(
  "project-b",
  "project-b",
  [{ comparisonId: "comparison-b-current", terminalId: "terminal-b2", label: "B" }],
  tombstones,
  panes,
  effects,
);
assert.equal(hydrated, true);
assert.equal(paneBadges.get("terminal-a"), "A");
assert.equal(paneBadges.get("terminal-b1"), null, "B hydration must keep removed B1 clear");
assert.equal(paneBadges.get("terminal-b2"), "B", "B hydration must restore B2's current badge");
assert.equal(tabBadges.get("terminal-b2").textContent, "B");
assert.equal(visible.has("comparison-b1"), false, "later hydration must not resurrect removed B1");
assert.equal(visible.has("comparison-b-current"), true);
assert.equal(editorBadgeRefreshes, beforeHydrated.editorBadgeRefreshes + 1);
assert.equal(candidateTestRefreshes, beforeHydrated.candidateTestRefreshes + 2);
assert.equal(editorLockRefreshes, beforeHydrated.editorLockRefreshes + 1);

// A stale list for A is ignored while B is active.
const beforeStaleHydration = {
  visible: [...visible],
  paneBadges: [...paneBadges],
  editorBadgeRefreshes,
  candidateTestRefreshes,
  editorLockRefreshes,
};
assert.equal(
  applyWorldlineHydration(
    "project-b",
    "project-a",
    [{ comparisonId: "comparison-a-late", terminalId: "terminal-a", label: "A" }],
    new Set(),
    panes,
    effects,
  ),
  false,
);
assert.deepEqual(
  {
    visible: [...visible],
    paneBadges: [...paneBadges],
    editorBadgeRefreshes,
    candidateTestRefreshes,
    editorLockRefreshes,
  },
  beforeStaleHydration,
);

// Closing the last project clears panel/tombstones and reconciles cleared UI now.
tombstones = new Set(["comparison-b-current"]);
selectedProjectId = null;
selectedHydrationEpoch++;
const beforeNull = { editorBadgeRefreshes, candidateTestRefreshes, editorLockRefreshes };
clearWorldlineProjectUi(panes, effects);
assert.equal(visible.size, 0);
assert.equal(tombstones, null);
assert.equal(panes.every((pane) => pane.worldlineLabel === null), true, "closing the project must clear every pane label");
assert.equal(tabBadges.get("terminal-a").textContent, "");
assert.equal(tabBadges.get("terminal-b1").textContent, "");
assert.equal(tabBadges.get("terminal-b2").textContent, "");
assert.equal(editorBadgeRefreshes, beforeNull.editorBadgeRefreshes + 1);
assert.equal(candidateTestRefreshes, beforeNull.candidateTestRefreshes + 3);
assert.equal(editorLockRefreshes, beforeNull.editorLockRefreshes + 1);

assert.equal(worldlineEventBelongsToProject(null, { projectId: "project-b" }), false);
assert.equal(worldlineEventBelongsToProject("project-a", { projectId: "project-b" }), false);
assert.equal(worldlineEventBelongsToProject("project-b", { projectId: "project-b" }), true);

console.log("PASS Worldline project-owned reconciliation and hydration");
