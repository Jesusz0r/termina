import { worldlineEventBelongsToProject, type InstanceSummary, type VerifyInfo, type WorldlineSummary } from "../shared/types";
export { worldlineEventBelongsToProject } from "../shared/types";

export interface WorldlineProjectPane {
  projectId: string | null;
}

export type WorldlineLabel = "A" | "B";

export interface WorldlineLabeledPane extends WorldlineProjectPane {
  instanceId: string;
  worldlineLabel: WorldlineLabel | null;
}

/** Refresh an active pane from the active project's index. Hidden projects
 * retain their own last reconciled label until their authoritative hydration. */
export function refreshWorldlinePaneLabel<TPane extends WorldlineLabeledPane>(
  activeProjectId: string | null,
  pane: TPane,
  labelOfTerminal: (instanceId: string) => WorldlineLabel | null,
): WorldlineLabel | null {
  if (activeProjectId === null || pane.projectId === activeProjectId) {
    pane.worldlineLabel = labelOfTerminal(pane.instanceId);
  }
  return pane.worldlineLabel;
}

export interface WorldlineCandidateTestPane extends WorldlineLabeledPane {
  testCommand: string | null;
  candidateTestEpoch: number;
}

export interface WorldlineCandidateTestBindings<TPane extends WorldlineCandidateTestPane> {
  activeProjectId(): string | null;
  hydrationEpoch(): number;
  isActivePane(instanceId: string): boolean;
  paneById(instanceId: string): TPane | undefined;
  detectTest(instanceId: string): Promise<{ label: string } | null>;
  onChanged(pane: TPane): void;
  onError(error: unknown): void;
}

/** Detect a candidate's test command without allowing a response from an old
 * project, hydration, label, or pane generation to repopulate current state. */
export function refreshWorldlineCandidateTest<TPane extends WorldlineCandidateTestPane>(
  pane: TPane,
  bindings: WorldlineCandidateTestBindings<TPane>,
): void {
  const requestEpoch = ++pane.candidateTestEpoch;
  const projectId = bindings.activeProjectId();
  const hydrationEpoch = bindings.hydrationEpoch();
  const label = pane.worldlineLabel;
  if (projectId === null || pane.projectId !== projectId || label === null) {
    if (pane.testCommand !== null) {
      pane.testCommand = null;
      bindings.onChanged(pane);
    }
    return;
  }

  // Reconciliation visits every pane so a removed/changed candidate cannot
  // retain stale state, but only the visible pane needs a fresh IPC detect.
  if (!bindings.isActivePane(pane.instanceId)) {
    if (pane.testCommand !== null) {
      pane.testCommand = null;
      bindings.onChanged(pane);
    }
    return;
  }

  const isCurrent = (): TPane | null => {
    const current = bindings.paneById(pane.instanceId);
    if (
      current !== pane ||
      current.candidateTestEpoch !== requestEpoch ||
      current.projectId !== projectId ||
      current.worldlineLabel !== label ||
      bindings.activeProjectId() !== projectId ||
      bindings.hydrationEpoch() !== hydrationEpoch ||
      !bindings.isActivePane(current.instanceId)
    ) {
      return null;
    }
    return current;
  };

  void bindings.detectTest(pane.instanceId).then((detected) => {
    const current = isCurrent();
    if (!current) return;
    current.testCommand = detected?.label ?? null;
    bindings.onChanged(current);
  }).catch((error) => {
    if (isCurrent()) bindings.onError(error);
  });
}

export interface WorldlineProjectEffects<TPane extends WorldlineProjectPane> {
  resetView(): void;
  clearTombstones(): void;
  addTombstone(comparisonId: string): void;
  removeComparison(comparisonId: string): void;
  upsert(summary: WorldlineSummary): void;
  updatePane(pane: TPane): void;
  refreshCandidateTest(pane: TPane): void;
  refreshEditorBadges(): void;
  updateEditorLock(): void;
}

/** Renderer-side adapters used by worldline reconciliation. Keeping this
 * composition in the DOM-free owner lets focused tests exercise the exact
 * production effect object without importing the Electron entrypoint. */
export interface WorldlineProjectEffectBindings<TPane extends WorldlineProjectPane> {
  resetView(): void;
  clearTombstones(): void;
  addTombstone(comparisonId: string): void;
  removeComparison(comparisonId: string): void;
  upsert(summary: WorldlineSummary): void;
  updatePaneTab(pane: TPane): void;
  refreshCandidateTest(pane: TPane): void;
  refreshEditorBadges(): void;
  updateEditorLock(): void;
}

/** Compose the renderer's concrete panel/tab/editor effects once. */
export function worldlineProjectEffects<TPane extends WorldlineProjectPane>(
  bindings: WorldlineProjectEffectBindings<TPane>,
): WorldlineProjectEffects<TPane> {
  return {
    resetView: () => bindings.resetView(),
    clearTombstones: () => bindings.clearTombstones(),
    addTombstone: (comparisonId) => bindings.addTombstone(comparisonId),
    removeComparison: (comparisonId) => bindings.removeComparison(comparisonId),
    upsert: (summary) => bindings.upsert(summary),
    updatePane: (pane) => bindings.updatePaneTab(pane),
    refreshCandidateTest: (pane) => bindings.refreshCandidateTest(pane),
    refreshEditorBadges: () => bindings.refreshEditorBadges(),
    updateEditorLock: () => bindings.updateEditorLock(),
  };
}

export interface WorldlineTabBadge {
  textContent: string | null;
  style: { display: string };
  title: string;
  classList: { toggle(className: string, force?: boolean): unknown };
}

/** Apply the worldline portion of updatePaneTab, including project-owned
 * retention for hidden panes and the visible A/B badge. */
export function updateWorldlinePaneTab<TPane extends WorldlineLabeledPane>(
  activeProjectId: string | null,
  pane: TPane,
  labelOfTerminal: (instanceId: string) => WorldlineLabel | null,
  badge: WorldlineTabBadge | null,
): WorldlineLabel | null {
  const label = refreshWorldlinePaneLabel(activeProjectId, pane, labelOfTerminal);
  if (!badge) return label;
  badge.textContent = label ?? "";
  badge.style.display = label ? "" : "none";
  badge.title = label ? `worldline candidate ${label}` : "";
  badge.classList.toggle("a", label === "A");
  badge.classList.toggle("b", label === "B");
  return label;
}

export function handleWorldlineRemoved<TPane extends WorldlineProjectPane>(
  activeProjectId: string | null,
  event: { projectId: string; comparisonId: string },
  panes: Iterable<TPane>,
  effects: WorldlineProjectEffects<TPane>,
): boolean {
  return applyWorldlineRemoval(activeProjectId, event, panes, effects);
}

export interface WorldlineBusyPane {
  instanceId: string;
  busy: boolean;
}

export interface WorldlineBusyBindings<TPane extends WorldlineBusyPane> {
  paneById(instanceId: string): TPane | undefined;
  updatePaneTab(pane: TPane): void;
  updateEditorLock(): void;
  activePaneId(): string | null;
  renderStatus(pane: TPane): void;
}

/** Route the shared busy push through the same updatePaneTab effect used by
 * production onBusy, while keeping hidden panes out of status rendering. */
export function handleWorldlineBusy<TPane extends WorldlineBusyPane>(
  event: { instanceId: string; busy: boolean },
  bindings: WorldlineBusyBindings<TPane>,
): boolean {
  const pane = bindings.paneById(event.instanceId);
  if (!pane) return false;
  pane.busy = event.busy;
  bindings.updatePaneTab(pane);
  bindings.updateEditorLock();
  if (bindings.activePaneId() === event.instanceId) bindings.renderStatus(pane);
  return true;
}

export interface WorldlineInstancePane extends WorldlineCandidateTestPane {
  cwd: string | null;
  workspaceId: string;
  busy: boolean;
  type: "agent" | "shell";
  engine?: "pi" | "core";
  shellName: string | undefined;
  dispatchWorker: boolean;
  dispatchTask: string | undefined;
  modified: import("../shared/types").ModifiedFile[];
  recorderState: string;
  verify: VerifyInfo;
}

export interface WorldlineInstancesBindings<TPane extends WorldlineInstancePane> {
  paneById(instanceId: string): TPane | undefined;
  createPane(instanceId: string): TPane;
  updatePaneTab(pane: TPane): void;
  setEngine(pane: TPane, engine: InstanceSummary["engine"]): void;
  onProjectDiscovered?(pane: TPane, summary: InstanceSummary): void;
}

/** Apply instance roster pushes before the generic visibility/activation
 * logic. The main renderer delegates this exact field/update ordering here. */
export function handleWorldlineInstances<TPane extends WorldlineInstancePane>(
  list: InstanceSummary[],
  bindings: WorldlineInstancesBindings<TPane>,
): number {
  let handled = 0;
  for (const summary of list) {
    let pane = bindings.paneById(summary.id);
    if (!pane) pane = bindings.createPane(summary.id);
    pane.cwd = summary.cwd;
    pane.workspaceId = summary.workspaceId ?? "";
    pane.projectId = summary.projectId ?? null;
    bindings.onProjectDiscovered?.(pane, summary);
    pane.busy = summary.busy;
    pane.type = summary.type;
    const engine = summary.engine ?? (summary.type === "agent" ? "core" : undefined);
    pane.engine = engine;
    bindings.setEngine(pane, engine);
    pane.shellName = summary.shellName;
    pane.dispatchWorker = summary.dispatchWorker ?? false;
    pane.dispatchTask = summary.dispatchTask;
    pane.modified = summary.modified ?? [];
    pane.recorderState = summary.recorderState ?? "paused";
    pane.verify = summary.verify ?? { state: "untested", command: null, summary: null };
    bindings.updatePaneTab(pane);
    handled++;
  }
  return handled;
}

function reconcileProject<TPane extends WorldlineProjectPane>(
  projectId: string,
  panes: Iterable<TPane>,
  effects: WorldlineProjectEffects<TPane>,
): void {
  for (const pane of panes) {
    if (pane.projectId === projectId) {
      effects.updatePane(pane);
      effects.refreshCandidateTest(pane);
    }
  }
  effects.refreshEditorBadges();
  effects.updateEditorLock();
}

export function applyWorldlineRemoval<TPane extends WorldlineProjectPane>(
  activeProjectId: string | null,
  event: { projectId: string; comparisonId: string },
  panes: Iterable<TPane>,
  effects: WorldlineProjectEffects<TPane>,
): boolean {
  if (!worldlineEventBelongsToProject(activeProjectId, event)) return false;
  effects.addTombstone(event.comparisonId);
  effects.removeComparison(event.comparisonId);
  reconcileProject(event.projectId, panes, effects);
  return true;
}

export function beginWorldlineHydration<TPane extends WorldlineProjectPane>(
  projectId: string,
  panes: Iterable<TPane>,
  effects: WorldlineProjectEffects<TPane>,
): void {
  effects.resetView();
  reconcileProject(projectId, panes, effects);
}

export function applyWorldlineHydration<TPane extends WorldlineProjectPane>(
  activeProjectId: string | null,
  projectId: string,
  list: WorldlineSummary[],
  tombstones: ReadonlySet<string>,
  panes: Iterable<TPane>,
  effects: WorldlineProjectEffects<TPane>,
): boolean {
  if (!worldlineEventBelongsToProject(activeProjectId, { projectId })) return false;
  for (const summary of list) {
    if (!tombstones.has(summary.comparisonId)) effects.upsert(summary);
  }
  reconcileProject(projectId, panes, effects);
  return true;
}

export function clearWorldlineProjectUi<TPane extends WorldlineProjectPane>(
  panes: Iterable<TPane>,
  effects: WorldlineProjectEffects<TPane>,
): void {
  effects.resetView();
  effects.clearTombstones();
  for (const pane of panes) {
    effects.updatePane(pane);
    effects.refreshCandidateTest(pane);
  }
  effects.refreshEditorBadges();
  effects.updateEditorLock();
}
