import { worldlineEventBelongsToProject, type AgentActivityView, type InstanceSummary, type RecorderState, type VerifyInfo, type WorldlineSummary } from "../shared/types";
export { worldlineEventBelongsToProject } from "../shared/types";

interface WorldlineProjectPane {
  projectId: string | null;
}

export type WorldlineLabel = "A" | "B";

interface WorldlineLabeledPane extends WorldlineProjectPane {
  instanceId: string;
  worldlineLabel: WorldlineLabel | null;
}

interface WorldlineCandidateTestPane extends WorldlineLabeledPane {
  testCommand: string | null;
  candidateTestEpoch: number;
}

function isCandidateTestPane(pane: WorldlineLabeledPane): pane is WorldlineCandidateTestPane {
  return "candidateTestEpoch" in pane && "testCommand" in pane;
}

/** Refresh an active pane from the active project's index. Hidden projects
 * retain their own last reconciled label until their authoritative hydration.
 * Losing a candidate label drops that pane's candidate test command so verify
 * cannot keep using the isolated tree after the badge is gone. */
function refreshWorldlinePaneLabel<TPane extends WorldlineLabeledPane>(
  activeProjectId: string | null,
  pane: TPane,
  labelOfTerminal: (instanceId: string) => WorldlineLabel | null,
): WorldlineLabel | null {
  const previous = pane.worldlineLabel;
  if (activeProjectId === null || pane.projectId === activeProjectId) {
    pane.worldlineLabel = labelOfTerminal(pane.instanceId);
  }
  if (previous !== null && pane.worldlineLabel === null && isCandidateTestPane(pane)) {
    pane.candidateTestEpoch++;
    pane.testCommand = null;
  }
  return pane.worldlineLabel;
}

/** Candidate label wins; otherwise the project-tree detect. */
export function resolvePaneTestCommand(
  pane: Pick<WorldlineCandidateTestPane, "testCommand">,
  projectCommand: string | null,
): string | null {
  return pane.testCommand ?? projectCommand;
}

/** Project detect lives on unlabeled panes of that project — one cache field. */
export function projectTestCommandFromPanes<TPane extends WorldlineCandidateTestPane>(
  projectId: string | null,
  panes: Iterable<TPane>,
): string | null {
  if (!projectId) return null;
  for (const pane of panes) {
    if (pane.projectId === projectId && pane.worldlineLabel === null && pane.testCommand) {
      return pane.testCommand;
    }
  }
  return null;
}

/** Prefer the active unlabeled pane so detectTest uses the project tree. */
export function projectTestDetectPane<TPane extends WorldlineCandidateTestPane>(
  projectId: string | null,
  activeId: string | null,
  panes: Iterable<TPane>,
): TPane | undefined {
  if (!projectId) return undefined;
  let fallback: TPane | undefined;
  for (const pane of panes) {
    if (pane.projectId !== projectId || pane.worldlineLabel !== null) continue;
    if (pane.instanceId === activeId) return pane;
    fallback ??= pane;
  }
  return fallback;
}

/** Write project-tree detect onto every unlabeled pane of the project. */
export function applyProjectTestDetect<TPane extends WorldlineCandidateTestPane>(
  projectId: string,
  label: string | null,
  panes: Iterable<TPane>,
): void {
  for (const pane of panes) {
    if (pane.projectId === projectId && pane.worldlineLabel === null) {
      pane.testCommand = label;
    }
  }
}

interface WorldlineCandidateTestBindings<TPane extends WorldlineCandidateTestPane> {
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
  const projectId = bindings.activeProjectId();
  const hydrationEpoch = bindings.hydrationEpoch();
  const label = pane.worldlineLabel;
  // Unlabeled panes are the project-tree cache. Wiping them here used to be
  // safe because renderVerify fell back to a module global; that global is
  // gone, so a reconcile must not empty the only remaining value. Demotion
  // (A/B → none) is handled in refreshWorldlinePaneLabel.
  if (projectId === null || pane.projectId !== projectId) {
    pane.candidateTestEpoch++;
    if (pane.testCommand !== null) {
      pane.testCommand = null;
      bindings.onChanged(pane);
    }
    return;
  }
  if (label === null) return;
  const requestEpoch = ++pane.candidateTestEpoch;

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

interface WorldlineProjectEffects<TPane extends WorldlineProjectPane> {
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

interface WorldlineTabBadge {
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

interface WorldlineBusyPane {
  instanceId: string;
  busy: boolean;
}

interface WorldlineBusyBindings<TPane extends WorldlineBusyPane> {
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
  activity: AgentActivityView;
  type: "agent" | "shell";
  engine?: "core";
  shellName: string | undefined;
  dispatchWorker: boolean;
  dispatchTask: string | undefined;
  modified: import("../shared/types").ModifiedFile[];
  recorderState: RecorderState;
  recorderDetail: string | null;
  verify: VerifyInfo;
  model: string | null;
  thinkingLevel: string | null;
  usage: string | null;
}

interface WorldlineInstancesBindings<TPane extends WorldlineInstancePane> {
  paneById(instanceId: string): TPane | undefined;
  createPane(instanceId: string): TPane;
  updatePaneTab(pane: TPane): void;
  setEngine(pane: TPane, engine: InstanceSummary["engine"]): void;
  onProjectDiscovered?(pane: TPane, summary: InstanceSummary): void;
}

/** Copy main-owned InstanceSummary fields onto a pane. Boot and roster
 *  push share this path so hydration cannot drift. Required fields are
 *  not invented when missing. */
export function applyInstanceSummary<TPane extends WorldlineInstancePane>(
  pane: TPane,
  summary: InstanceSummary,
  bindings: Pick<WorldlineInstancesBindings<TPane>, "setEngine">,
): void {
  pane.cwd = summary.cwd;
  pane.workspaceId = summary.workspaceId;
  pane.projectId = summary.projectId ?? null;
  pane.busy = summary.busy;
  if (summary.activity !== undefined) pane.activity = summary.activity;
  pane.type = summary.type;
  pane.engine = summary.engine;
  bindings.setEngine(pane, summary.engine);
  pane.shellName = summary.shellName;
  pane.dispatchWorker = summary.dispatchWorker === true;
  pane.dispatchTask = summary.dispatchTask;
  pane.modified = summary.modified;
  pane.recorderState = summary.recorderState;
  pane.recorderDetail = summary.recorderDetail ?? null;
  pane.verify = summary.verify ?? { state: "untested", command: null, summary: null };
  pane.model = summary.model ?? null;
  pane.thinkingLevel = summary.thinkingLevel ?? null;
  pane.usage = summary.usage ?? null;
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
    applyInstanceSummary(pane, summary, bindings);
    bindings.onProjectDiscovered?.(pane, summary);
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
      effects.updatePaneTab(pane);
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
    effects.updatePaneTab(pane);
    effects.refreshCandidateTest(pane);
  }
  effects.refreshEditorBadges();
  effects.updateEditorLock();
}
