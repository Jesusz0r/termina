/**
 * Renderer entry — terminal-first architecture.
 *
 * Left: multiple terminal panes, each running the real agent TUI in a pty.
 * Right: per-project Monaco editor + file explorer, live-synced via the watcher.
 * The agent's sidecar events drive auto-open and the modified list.
 */
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import jsonWorker from "monaco-editor/language/json/json.worker?worker";
import cssWorker from "monaco-editor/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/language/html/html.worker?worker";

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

import "./styles.css";
import "@xterm/xterm/css/xterm.css";
import { PtyView } from "./pty-view";
import { createTerminalMenu } from "./main/terminal-menu";
import { createTimelinePane } from "./main/timeline-pane";
import { createActivityPane } from "./main/activity-pane";
import { createPreferences, applyEditorPreferences, applyReviewPreferences } from "./main/preferences";
import { createLayout } from "./main/layout";
import { createTerminalFind } from "./main/terminal-find";
import { SessionSearch } from "./session-search";
import { QuickOpen } from "./quick-open";
import { ActivityTabs } from "./activity-tabs";
import { WorldlinesView } from "./worldlines";
import { Explorer } from "./components/explorer";
import { projectChangedPaths } from "./explorer-file";
import { showUnsavedConfirm, toast } from "./components/modals";
import { decideUnsavedClose, unsavedCloseMessage } from "../shared/unsaved-close";
import { showContextMenu, type ContextMenuItem } from "./components/context-menu";
import { applyEmptyStateShortcutHints, isMacPlatform, shortcutForEvent } from "./settings-shortcuts";
import { CommandDispatcher } from "./commands";
import { PtySequenceLedger } from "./pty-sequence-ledger";
import {
  applyInstanceSummary,
  applyProjectTestDetect,
  applyWorldlineHydration,
  applyWorldlineRemoval,
  beginWorldlineHydration,
  clearWorldlineProjectUi,
  handleWorldlineBusy,
  handleWorldlineInstances,
  projectTestCommandFromPanes,
  projectTestDetectPane,
  refreshWorldlineCandidateTest,
  resolvePaneTestCommand,
  updateWorldlinePaneTab,
  worldlineEventBelongsToProject,
} from "./worldline-project-state";
import { asKnownState, KNOWN_ACTIVITY_STATES, KNOWN_VERIFY_BADGE_STATES, presentBlockedLabel } from "./known-state";
import { CHALLENGE_PROFILES, isTuiOwnedShortcut, pathBasename } from "../shared/types";
import type { AgentActivityView, AppUpdateState, ChallengeProfile, CommandId, FolderOpenedPayload, ModifiedFile, InstanceSummary, ProjectWorkspaceRef, RecorderState, VerifyInfo, TimelineEvent, TimelinePrefix, PlanTask, RunSummary } from "../shared/types";

type EditorManagerInstance = import("./editor").EditorManager;
type ReviewViewInstance = import("./review").ReviewView;
type EditorModule = typeof import("./editor");
let editorModule: EditorModule | null = null;
let editorModulePromise: Promise<EditorModule> | null = null;
function ensureEditorModule(): Promise<EditorModule> {
  if (editorModule) return Promise.resolve(editorModule);
  editorModulePromise ??= import("./editor").then((module) => {
    editorModule = module;
    return module;
  });
  return editorModulePromise;
}

/** One open project tab: its editor view and its tab element. */
interface ProjectView {
  id: string;
  cwd: string;
  workspaceId: string;
  tabEl: HTMLElement;
  editorMgr: EditorManagerInstance | null;
  editorEl: HTMLElement;
  tabsEl: HTMLElement;
  containerEl: HTMLElement;
  emptyEl: HTMLElement;
  needsLogin: boolean;
  activePaneId: string | null;
}

const projectViews = new Map<string, ProjectView>();
(window as unknown as Record<string, unknown>).__projectViews = projectViews;
let activeProjectId: string | null = null;
let activeProjectGeneration = 0;
/** Highest activation epoch observed from main; stale folder pushes are inert. */
let latestProjectActivationGeneration = 0;
const emptyTemplate = document.getElementById("editor-empty-template") as HTMLTemplateElement;
const rightPaneEl = document.getElementById("right-pane")!;
// The base editor fills the pane before any project tab exists (the
// no-project boot). Project views take over once a folder opens.
const baseEmptyEl = emptyTemplate.content.firstElementChild!.cloneNode(true) as HTMLElement;
applyEmptyStateShortcutHints(baseEmptyEl);
rightPaneEl.appendChild(baseEmptyEl);

let baseEditorInstance: EditorManagerInstance | null = null;
function getBaseEditor(): EditorManagerInstance {
  if (!baseEditorInstance) {
    if (!editorModule) throw new Error("editor module is not loaded");
    baseEditorInstance = new editorModule.EditorManager(
      document.getElementById("editor-container")!,
      document.getElementById("editor-tabs")!,
      baseEmptyEl,
    );
    baseEditorInstance.onConflict = (path) => {
      toast(`${pathBasename(path)} changed on disk — you have unsaved edits`, "warning");
    };
    applySharedEditorHooks(baseEditorInstance, null);
    baseEditorInstance.projectRootProvider = () => projectCwd;
    applyEditorPreferences(baseEditorInstance, prefs.current);
  }
  return baseEditorInstance;
}

// The e2e suites drive the active editor through this hook.
Object.defineProperty(window, "__editorMgr", {
  get: () => activeEditor(),
  configurable: true,
});
const projectTabsEl = document.getElementById("project-tabs")!;
const btnNewProject = document.getElementById("btn-new-project") as HTMLButtonElement;

function createProjectView(project: { id: string; cwd: string; workspaceId: string; needsLogin?: boolean }): ProjectView {
  const existing = projectViews.get(project.id);
  if (existing) return existing;
  // The editor wrapper: its own tab bar, container, and empty state.
  const editorEl = document.createElement("div");
  editorEl.className = "project-editor";
  editorEl.dataset.project = project.id;
  const tabsEl = document.createElement("div");
  tabsEl.className = "editor-tabs";
  const chromeEl = document.createElement("div");
  chromeEl.className = "pane-chrome";
  chromeEl.appendChild(tabsEl);
  const containerEl = document.createElement("div");
  containerEl.className = "editor-container";
  const emptyEl = emptyTemplate.content.firstElementChild!.cloneNode(true) as HTMLElement;
  applyEmptyStateShortcutHints(emptyEl);
  editorEl.append(chromeEl, containerEl, emptyEl);
  editorEl.style.display = "none";
  rightPaneEl.insertBefore(editorEl, rightPaneEl.firstElementChild);

  const tabEl = document.createElement("div");
  tabEl.className = "project-tab";
  const nameEl = document.createElement("span");
  nameEl.className = "tab-name";
  nameEl.textContent = pathBasename(project.cwd);
  nameEl.title = project.cwd;
  const closeEl = document.createElement("span");
  closeEl.className = "tab-close";
  closeEl.textContent = "×";
  closeEl.title = "Close this project";
  const statusEl = document.createElement("span");
  statusEl.className = "tab-status";
  statusEl.title = "unseen verify failure";
  tabEl.append(statusEl, nameEl, closeEl);
  tabEl.addEventListener("click", () => {
    void window.termina.projectActivate(project.id).catch((err) => {
      toast(`could not switch projects: ${(err as Error).message}`, "warning");
    });
  });
  closeEl.addEventListener("click", (e) => {
    e.stopPropagation();
    void window.termina.projectClose(project.id).then((res) => {
      if (res.ok) removeProjectView(project.id);
      else if (!res.cancelled) toast(res.error ?? "could not close the project", "warning");
    }).catch((err) => toast(`could not close the project: ${(err as Error).message}`, "warning"));
  });
  projectTabsEl.appendChild(tabEl);

  const view: ProjectView = {
    id: project.id,
    cwd: project.cwd,
    workspaceId: project.workspaceId,
    tabEl,
    editorMgr: null,
    editorEl,
    tabsEl,
    containerEl,
    emptyEl,
    needsLogin: project.needsLogin === true,
    activePaneId: null,
  };
  projectViews.set(project.id, view);
  return view;
}

/** Create Monaco only when a project becomes active or receives an open-file request. */
function ensureProjectEditor(view: ProjectView): EditorManagerInstance {
  if (view.editorMgr) return view.editorMgr;
  if (!editorModule) throw new Error("editor module is not loaded");
  const editorMgr = new editorModule.EditorManager(view.containerEl, view.tabsEl, view.emptyEl, true, view.needsLogin);
  editorMgr.onConflict = (path) => {
    toast(`${pathBasename(path)} changed on disk — you have unsaved edits`, "warning");
  };
  applySharedEditorHooks(editorMgr, view.id);
  editorMgr.projectRootProvider = () => view.cwd;
  editorMgr.ownerProvider = () => {
    const current = projectViews.get(view.id);
    return current?.workspaceId ? { projectId: current.id, workspaceId: current.workspaceId } : null;
  };
  applyEditorPreferences(editorMgr, prefs.current);
  view.editorMgr = editorMgr;
  return editorMgr;
}

/** The editor hooks shared by every project view (mine toggle, badges). */
function applySharedEditorHooks(editor: EditorManagerInstance, projectId: string | null): void {
  editor.onToggleMine = (path, owner) => {
    const mine = !editor.isMine(path);
    editor.setMine(path, mine);
    void window.termina.setMineFile(path, mine, owner).catch(() => {
      editor.setMine(path, !mine); // the main side failed: revert the mark
    });
  };
  editor.tabBadge = (path) => worldlinesView.labelOfPath(path);
  editor.onFileOpened = () => {
    if (projectId !== null && activeProjectId !== projectId) return;
    layout.revealEditor();
  };
  editor.onBecameEmpty = () => layout.collapseEditorIfIdle();
}

/** Remove a closed project's tab, editor view, and panes. */
function removeProjectView(projectId: string): void {
  const view = projectViews.get(projectId);
  if (!view) return;
  const editorToggle = document.getElementById("btn-min-editor");
  if (editorToggle && view.editorEl.contains(editorToggle)) placeEditorToggle(null);
  view.editorMgr?.dispose();
  view.tabEl.remove();
  view.editorEl.remove();
  const projectIds = [...projectViews.keys()];
  const closingIndex = projectIds.indexOf(projectId);
  projectViews.delete(projectId);
  lastActivePane.delete(projectId);
  pendingToolTargets.delete(projectId);
  if (activeProjectId === projectId) {
    activeProjectId = null;
    const remaining = [...projectViews.keys()];
    const next = closingIndex > 0 ? (remaining[closingIndex - 1] ?? remaining[0]) : remaining[0];
    setActiveProject(next ?? null);
    hydrateWorldlines(next ?? null);
  }
  for (const pane of [...panes.values()]) {
    if (pane.projectId === projectId) void closePane(pane.instanceId);
  }
}

/** The active project's editor manager (the tab in front). */
function activeEditor(): EditorManagerInstance {
  const view = activeProjectId ? projectViews.get(activeProjectId) : null;
  // Never open files in a hidden project editor. The first map entry can
  // be display:none while the base pane is what the user sees.
  return view ? ensureProjectEditor(view) : getBaseEditor();
}

function placeEditorToggle(projectId: string | null): void {
  const button = document.getElementById("btn-min-editor");
  if (!(button instanceof HTMLButtonElement)) return;
  if (projectId === null) {
    document.getElementById("editor-chrome")?.appendChild(button);
    return;
  }
  projectViews.get(projectId)?.editorEl.querySelector(".pane-chrome")?.appendChild(button);
}

function setActiveProject(projectId: string | null): void {
  const view = projectId ? projectViews.get(projectId) : undefined;
  activeProjectId = view ? projectId : null;
  if (view) ensureProjectEditor(view);
  activeProjectGeneration++;
  const baseChrome = document.getElementById("editor-chrome")!;
  const baseContainer = document.getElementById("editor-container")!;
  const noProject = !view;
  baseChrome.style.display = noProject ? "" : "none";
  baseContainer.style.display = noProject ? "" : "none";
  // The base overlay sits on #right-pane. Hide it while a project view is shown.
  if (!noProject) {
    baseEditorInstance?.setProjectOpen(true);
    baseEmptyEl.hidden = true;
  } else {
    getBaseEditor().setProjectOpen(false);
  }
  for (const item of projectViews.values()) {
    const active = item.id === activeProjectId;
    item.tabEl.classList.toggle("active", active);
    item.editorEl.style.display = active ? "" : "none";
    updateProjectAttention(item.id);
  }
  placeEditorToggle(activeProjectId);
  syncPaneVisibility();
  syncExplorerChanged();
  layout.syncEditorMinimizedForProject();
  drainPendingToolTargets(activeProjectId);
  layout.fitPanes();
  timelinePane.invalidateJumps();
  updateEditorLock();
}

/** Open queued agent auto-opens for a project that just became active. */
function drainPendingToolTargets(projectId: string | null): void {
  if (!projectId) return;
  const queued = pendingToolTargets.get(projectId);
  if (!queued || queued.length === 0) return;
  pendingToolTargets.delete(projectId);
  if (!prefs.current.autoOpenAgentFiles) return;
  const view = projectViews.get(projectId);
  if (!view) return;
  for (const target of queued) {
    if (view.workspaceId !== target.workspaceId) continue;
    const owner: ProjectWorkspaceRef = { projectId, workspaceId: target.workspaceId };
    void ensureProjectEditor(view).openFile(target.path, { preview: true, owner }).catch((err) => {
      toast(`could not open ${pathBasename(target.path)}: ${(err as Error).message}`, "error");
    });
  }
}

/** Show only the active project's terminals. Other project panes stay alive. */
function syncPaneVisibility(): void {
  for (const pane of panes.values()) {
    const on = pane.projectId === activeProjectId;
    pane.tabEl.style.display = on ? "" : "none";
    pane.container.style.display = on ? "" : "none";
    pane.view.setVisible(on && pane.instanceId === activeId);
  }
}

/** Activate a terminal that belongs to the active project, then fit it. */
function activateProjectPane(): void {
  const current = activeId ? panes.get(activeId) : undefined;
  if (current && current.projectId === activeProjectId) {
    activatePane(current.instanceId);
    return;
  }
  // Restore the terminal that was active when this project was last in front.
  const rememberedId = activeProjectId ? lastActivePane.get(activeProjectId) : undefined;
  const remembered = rememberedId ? panes.get(rememberedId) : undefined;
  if (remembered && remembered.projectId === activeProjectId) {
    activatePane(remembered.instanceId);
    return;
  }
  const next = [...panes.values()].find((p) => p.projectId === activeProjectId);
  if (next) activatePane(next.instanceId);
  else {
    activeId = null;
    renderChrome();
  }
}

let reviewView: ReviewViewInstance | null = null;
let reviewModulePromise: Promise<typeof import("./review")> | null = null;
function ensureReviewView(): Promise<ReviewViewInstance> {
  if (reviewView) return Promise.resolve(reviewView);
  reviewModulePromise ??= import("./review");
  return reviewModulePromise.then(({ ReviewView }) => {
    if (reviewView) return reviewView;
    const view = new ReviewView();
    view.bind({
      onOpenFile: (path, owner) => {
        view.hide();
        void openFileSmart(path, false, owner);
      },
      onAccepted: (path) => {
        const pane = activeId ? panes.get(activeId) : undefined;
        if (!pane) return;
        pane.accepted.set(path, Date.now());
        pane.reverted.delete(path);
        activityPane.renderModified(pane);
        renderHandoff(pane);
      },
      onReverted: (path) => {
        const pane = activeId ? panes.get(activeId) : undefined;
        if (!pane) return;
        pane.reverted.add(path);
        pane.accepted.delete(path);
        activityPane.renderModified(pane);
      },
      onHidden: () => layout.collapseEditorIfIdle(),
      onShown: () => layout.revealEditor(),
    });
    reviewView = view;
    applyReviewPreferences(view, prefs.current);
    return view;
  });
}
const explorer = new Explorer(document.getElementById("explorer")!);
const sessionSearch = new SessionSearch();
sessionSearch.bind({ onOpenFile: (path) => void openFileSmart(path, true).then(() => activeEditor().focusEditor()) });
(window as unknown as Record<string, unknown>).__sessionSearch = sessionSearch;
const quickOpen = new QuickOpen();

// ---- Mine (file ownership) ----
let mineRequestToken = 0;
function refreshMine(projectId: string | null = activeProjectId): void {
  if (!projectId) return;
  const view = projectViews.get(projectId);
  if (!view || !view.workspaceId) return;
  const owner: ProjectWorkspaceRef = { projectId, workspaceId: view.workspaceId };
  const requestToken = ++mineRequestToken;
  const requestedGeneration = activeProjectGeneration;
  const editor = ensureProjectEditor(view);
  editor.clearMine();
  void window.termina.getMineFiles(owner).then((paths) => {
    if (
      requestToken !== mineRequestToken ||
      requestedGeneration !== activeProjectGeneration ||
      activeProjectId !== projectId ||
      projectViews.get(projectId) !== view
    ) return;
    for (const p of paths) editor.setMine(p, true);
  }).catch((err) => {
    if (requestToken === mineRequestToken && requestedGeneration === activeProjectGeneration && activeProjectId === projectId) {
      toast(`could not load mine marks: ${(err as Error).message}`, "error");
    }
  });
}
(window as unknown as Record<string, unknown>).__refreshMine = refreshMine;
void refreshMine();
const explorerEl = document.getElementById("explorer")!;
explorer.bind({
  onOpenFile: (path, preview) => void openFileSmart(path, preview ?? true),
  onContentHit: (relPath, line, column) => openContentHit(relPath, line, column),
});

/** Jump to a content-search hit: open at the match, then take editor focus
 *  (a direct gesture, like a Quick Open pick). */
function openContentHit(relPath: string, line: number, column: number): void {
  void openFileSmart(relPath, true, undefined, line, column).then(() => activeEditor().focusEditor());
}

const leftPane = document.getElementById("left-pane")!;
const termTabsList = document.getElementById("terminal-tabs-list")!;
const termContainer = document.getElementById("terminal-container")!;
const btnNewTerminal = document.getElementById("btn-new-terminal") as HTMLButtonElement;
const btnVerify = document.getElementById("btn-verify") as HTMLButtonElement;
const verifyBadge = document.getElementById("verify-badge")!;
const statusCwd = document.getElementById("status-cwd")!;
const statusState = document.getElementById("status-state")!;
const statusUsage = document.getElementById("status-usage")!;
const btnAppUpdate = document.getElementById("btn-app-update") as HTMLButtonElement;
const btnSettings = document.getElementById("btn-settings") as HTMLButtonElement;
const modifiedList = document.getElementById("modified-list")!;
const modifiedPanel = document.getElementById("modified-panel")!;
const modifiedCount = document.getElementById("modified-count")!;
const btnClearModified = document.getElementById("btn-clear-modified") as HTMLButtonElement;
const btnAcceptAll = document.getElementById("btn-accept-all") as HTMLButtonElement;
const btnCopySubject = document.getElementById("btn-copy-subject") as HTMLButtonElement;
const btnOpenShell = document.getElementById("btn-open-shell") as HTMLButtonElement;
const planPanel = document.getElementById("plan-panel")!;
const planList = document.getElementById("plan-list")!;
const planCount = document.getElementById("plan-count")!;
const btnDispatch = document.getElementById("btn-dispatch") as HTMLButtonElement;
const timelinePane = createTimelinePane({
  container: document.getElementById("timeline-strip")!,
  getActivePane: () => (activeId ? panes.get(activeId) : undefined),
  getActivePaneId: () => activeId,
  getPaneById: (id) => panes.get(id),
  getActiveProject: () => ({ id: activeProjectId, generation: activeProjectGeneration }),
  getEditor: () => activeEditor(),
  onContent: (has, count) => activityTabs.syncContent("timeline", has, count),
  onAgentSettled: (pane) => {
    pane.runs = null;
    loadRuns(pane);
  },
  onTimelineCleared: (pane) => {
    pane.plan = [];
    pane.planVersion++;
    if (activeId === pane.instanceId) activityPane.renderPlan(pane);
  },
});
(window as unknown as Record<string, unknown>).__timelineView = timelinePane.view;
const activityPane = createActivityPane({
  elements: {
    planPanel,
    planList,
    planCount,
    btnDispatch,
    modifiedList,
    modifiedPanel,
    modifiedCount,
    btnClearModified,
    btnAcceptAll,
  },
  getActivePane: () => (activeId ? panes.get(activeId) : undefined),
  getActivePaneId: () => activeId,
  getPaneById: (id) => panes.get(id),
  getAllPanes: () => panes.values(),
  onPlanContent: (has, count, announce) => {
    if (announce) activityTabs.setHasContent("plan", has, count);
    else activityTabs.syncContent("plan", has, count);
  },
  onModifiedContent: (has, count, announce) => {
    if (announce) activityTabs.setHasContent("modified", has, count);
    else activityTabs.syncContent("modified", has, count);
  },
  onReviewChanged: (pane) => renderHandoff(pane),
  onModifiedListChanged: (pane) => {
    if (pane.projectId === activeProjectId) syncExplorerChanged();
  },
  onShowWorker: (workerId) => activatePane(workerId),
  openReview: (pane, path, relPath) => {
    const projectId = pane.projectId;
    const workspaceId = pane.workspaceId;
    if (!projectId || !workspaceId) return;
    const owner = { projectId, workspaceId };
    void ensureReviewView().then((view) => view.show(pane.instanceId, path, relPath, owner));
  },
});
const worldlinesView = new WorldlinesView(document.getElementById("worldline-panel")!);
const activityTabs = new ActivityTabs({
  bar: document.getElementById("activity-tabbar")!,
  panels: {
    timeline: document.getElementById("timeline-strip")!,
    plan: planPanel,
    worldlines: document.getElementById("worldline-panel")!,
    modified: modifiedPanel,
  },
  counts: {
    timeline: null,
    plan: planCount,
    worldlines: document.getElementById("worldline-count"),
    modified: modifiedCount,
  },
  storage: localStorage,
});
let worldlineHydrationEpoch = 0;
let worldlineHydrationTombstones: Set<string> | null = null;

function worldlineProjectEffects() {
  return {
    resetView: () => worldlinesView.resetForProject(),
    clearTombstones: () => {
      worldlineHydrationTombstones = null;
    },
    addTombstone: (comparisonId: string) => worldlineHydrationTombstones?.add(comparisonId),
    removeComparison: (comparisonId: string) => worldlinesView.remove(comparisonId),
    upsert: (summary: Parameters<WorldlinesView["upsert"]>[0]) => worldlinesView.upsert(summary),
    updatePaneTab: (pane: Pane) => updatePaneTab(pane),
    refreshCandidateTest: (pane: Pane) => refreshCandidateTestCommand(pane),
    refreshEditorBadges: () => activeEditor().refreshBadges(),
    updateEditorLock: () => updateEditorLock(),
  };
}

/** Rebuild the active project's worldline panel without letting a prior
 * project's delayed list overwrite the newer UI. Content arrivals stay
 * quiet during the replay; the badge syncs once at the end. */
function hydrateWorldlines(projectId: string | null): void {
  const epoch = ++worldlineHydrationEpoch;
  worldlinesView.setQuiet(true);
  const finish = (): void => {
    if (epoch !== worldlineHydrationEpoch) return;
    worldlinesView.setQuiet(false);
    activityTabs.syncContent("worldlines", worldlinesView.size > 0, worldlinesView.size);
  };
  if (!projectId) {
    clearWorldlineProjectUi(panes.values(), worldlineProjectEffects());
    finish();
    return;
  }
  const tombstones = new Set<string>();
  worldlineHydrationTombstones = tombstones;
  const effects = worldlineProjectEffects();
  beginWorldlineHydration(projectId, panes.values(), effects);
  void window.termina.getWorldlines(projectId).then((list) => {
    if (epoch !== worldlineHydrationEpoch) return;
    const evidence = new Map<string, import("../shared/types").EvidenceSummary>();
    const summaries = list.map((summary) => {
      if (summary.evidence) evidence.set(summary.evidence.comparisonId, summary.evidence);
      const { evidence: _evidence, ...withoutEvidence } = summary;
      return withoutEvidence;
    });
    if (!applyWorldlineHydration(activeProjectId, projectId, summaries, tombstones, panes.values(), effects)) {
      finish();
      return;
    }
    for (const summary of evidence.values()) worldlinesView.upsertEvidence(summary);
    if (worldlineHydrationTombstones === tombstones) worldlineHydrationTombstones = null;
    finish();
  }).catch((err) => {
    if (worldlineHydrationTombstones === tombstones) worldlineHydrationTombstones = null;
    if (epoch === worldlineHydrationEpoch && activeProjectId === projectId) {
      toast(`could not load worldlines: ${(err as Error).message}`, "error");
    }
    finish();
  });
}

worldlinesView.bind({
  onCompareBase: (comparisonId, label, relPath, absPath) => {
    void ensureReviewView().then((view) => view.showCandidateDiff(comparisonId, label, relPath, absPath))
      .catch((err) => toast(`could not open Change Review: ${(err as Error).message}`, "error"));
  },
  onCompareAB: (comparisonId, relPath) => {
    void ensureReviewView().then((view) => view.showABDiff(comparisonId, relPath, worldlinesView.rootOf(comparisonId, "A")))
      .catch((err) => toast(`could not open Change Review: ${(err as Error).message}`, "error"));
  },
  onOpenFile: (absPath) => void openFileSmart(absPath, false),
  onOpenTerminal: (terminalId) => activatePaneWhenReady(terminalId),
  isLiveTerminal: (terminalId) => {
    const pane = panes.get(terminalId);
    return !!pane && !pane.error && !pane.exited;
  },
  onContent: (has, count) => {
    // Hydration replays stay quiet in the view and sync once at the end,
    // so every report that reaches here is a live arrival worth announcing.
    activityTabs.setHasContent("worldlines", has, count);
  },
});
const btnForkRun = document.getElementById("btn-fork-run") as HTMLButtonElement;
const challengeRunLabels: Record<ChallengeProfile, string> = {
  "fewer-dependencies": "Deps",
  "preserve-api": "API",
  "simpler-implementation": "Simple",
  "performance-first": "Perf",
};
let challengeRunAnchor: HTMLElement = btnForkRun;
const challengeRunButtons = CHALLENGE_PROFILES.map((profile) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cmp-challenge";
  button.textContent = challengeRunLabels[profile];
  button.dataset.profile = profile;
  button.hidden = true;
  challengeRunAnchor.after(button);
  challengeRunAnchor = button;
  return button;
});

// ---------------------------------------------------------------- panes -----

interface Pane {
  instanceId: string;
  /** Live PTY generation used to fence data, acks, and close requests. */
  generation: number;
  workspaceId: string;
  projectId: string | null;
  view: PtyView;
  container: HTMLElement;
  tabEl: HTMLElement;
  nameEl: HTMLElement;
  statusEl: HTMLElement;
  cwd: string | null;
  busy: boolean;
  activity: AgentActivityView;
  type: "agent" | "shell";
  engine?: "core";
  shellName: string | undefined;
  model: string | null;
  thinkingLevel: string | null;
  usage: string | null;
  error: boolean;
  /** True after pty:exit. The pane remains until the user closes the tab. */
  exited: boolean;
  modified: ModifiedFile[];
  /** Reviewed-at timestamp per path. A later disk change drops the entry, so
   *  the ✓ never survives a rewrite of the file it marked. */
  accepted: Map<string, number>;
  reverted: Set<string>;
  verify: VerifyInfo;
  /** True while a failed/timed-out verify awaits its first view. Cleared on
   *  activate and on every non-fail verify state. Transient UI state. */
  verifyAttention: boolean;
  timeline: TimelineEvent[];
  timelineLoaded: boolean;
  /** Monotonic token for the current timeline/prefix load. */
  timelineRequestToken: number;
  timelinePrefix: Pick<TimelinePrefix, "ok" | "error" | "open" | "activity"> | null;
  recorderState: RecorderState;
  recorderDetail: string | null;
  /** True when this pane was created from the authoritative roster. */
  fromRoster: boolean;
  plan: PlanTask[];
  planLoaded: boolean;
  planLoadAttempts: number;
  /** Bumped on every plan:update push (fetch race guard). */
  planVersion: number;
  dispatchWorker: boolean;
  dispatchTask: string | undefined;
  /** The recorded runs of this terminal (Fork Run button). */
  runs: RunSummary[] | null;
  /** The candidate-local test command label, when this is a candidate. */
  testCommand: string | null;
  /** Invalidates candidate test detection across labels/hydrations. */
  candidateTestEpoch: number;
  /** Last label reconciled from this pane's owning project. */
  worldlineLabel: "A" | "B" | null;
  /** Bounded PTY sequence admission for this pane/document generation. */
  ptySequenceLedger: PtySequenceLedger;
}

const panes = new Map<string, Pane>();
/** Last active terminal per project. Returning to a project restores it. */
const lastActivePane = new Map<string, string>();
/** Agent auto-opens that arrived while their project was in the background.
 *  Drained as replaceable preview tabs when the project becomes active
 *  again, so a long run never pins a tab per file it touched. */
const pendingToolTargets = new Map<string, Array<{ path: string; workspaceId: string }>>();
const MAX_PENDING_TOOL_TARGETS = 20;
(window as unknown as Record<string, unknown>).__panes = panes;
/** Close fence keyed by the PTY generation that was closed. A later
 *  roster entry with a higher generation is a new life, not a stale push. */
const closingPanes = new Map<string, { generation: number }>();
let activeId: string | null = null;
let projectCwd: string | null = null;
const prefs = await createPreferences({
  getBaseEditor: () => baseEditorInstance,
  forEachProjectEditor: (fn) => {
    for (const view of projectViews.values()) {
      if (view.editorMgr) fn(view.editorMgr);
    }
  },
  getReviewView: () => reviewView,
  forEachTerminal: (fn) => {
    for (const pane of panes.values()) fn(pane.view);
  },
});
// The e2e suite opens settings through this hook (the menu owns the
// visible entry).
(window as unknown as Record<string, unknown>).__openSettings = () => prefs.openSettings();
let layout!: ReturnType<typeof createLayout>;
let terminalFind!: ReturnType<typeof createTerminalFind>;

function applyTerminalGeneration(pane: Pane, generation: number): void {
  if (pane.generation === generation) return;
  pane.generation = generation;
  pane.ptySequenceLedger.reset();
  // A reused terminal id gets a fresh lifecycle even when its old tab shell
  // is still present in the renderer.
  pane.exited = false;
  pane.error = false;
}

function signalTerminalHydrated(pane: Pane): void {
  if (!pane.error && pane.generation > 0) window.termina.readyTerminal(pane.instanceId, pane.generation);
}

function createPaneShell(instanceId: string): Pane {
  const container = document.createElement("div");
  container.className = "term-pane";
  termContainer.appendChild(container);

  const tabEl = document.createElement("div");
  tabEl.className = "terminal-tab";
  const statusEl = document.createElement("span");
  statusEl.className = "tab-status";
  const typeEl = document.createElement("span");
  typeEl.className = "tab-type";
  const wlineEl = document.createElement("span");
  wlineEl.className = "tab-worldline";
  wlineEl.style.display = "none";
  const nameEl = document.createElement("span");
  nameEl.className = "tab-name";
  nameEl.textContent = "terminal";
  const closeEl = document.createElement("span");
  closeEl.className = "tab-close";
  closeEl.textContent = "×";
  closeEl.title = "Close terminal";
  closeEl.addEventListener("click", (e) => {
    e.stopPropagation();
    void closePane(instanceId);
  });
  tabEl.append(statusEl, nameEl, wlineEl, closeEl);
  tabEl.addEventListener("click", () => activatePane(instanceId));
  setupTabDrag(tabEl);
  termTabsList.appendChild(tabEl);

  const view = new PtyView(
    container,
    // Per-keystroke fire-and-forget: failures stay silent (a toast per keystroke
    // would spam), but the rejection must still be caught, never unhandled.
    (data) => void window.termina.writeTerminal(instanceId, data).catch(() => undefined),
    (cols, rows) => void window.termina.resizeTerminal(instanceId, cols, rows).catch(() => undefined),
    (text) => void window.termina.writeClipboard(text).catch(() => undefined),
    () => window.termina.pasteTerminal(instanceId),
    (message) => toast(message, "error"),
    (files) => window.termina.dropTerminalFiles(instanceId, files),
    {
      theme: prefs.current.theme,
      fontSize: prefs.current.terminalFontSize,
      fontFamily: prefs.current.fontFamily,
    },
    (filePath, line, column) => {
      const targetProjectId = pane.projectId ?? activeProjectId;
      if (targetProjectId && targetProjectId !== activeProjectId) {
        setActiveProject(targetProjectId);
      }
      const owner = targetProjectId && pane.workspaceId
        ? { projectId: targetProjectId, workspaceId: pane.workspaceId }
        : undefined;
      void openFileSmart(filePath, false, owner, line, column);
    },
  );
  view.setEngine("core");

  const pane: Pane = {
    instanceId,
    generation: 0,
    workspaceId: "",
    projectId: null,
    view,
    container,
    tabEl,
    nameEl,
    statusEl,
    cwd: null,
    busy: false,
    activity: { state: "idle", reason: null },
    type: "agent",
    engine: "core",
    shellName: undefined,
    model: null,
    thinkingLevel: null,
    usage: null,
    error: false,
    exited: false,
    modified: [],
    accepted: new Map(),
    reverted: new Set(),
    verify: { state: "untested", command: null, summary: null },
    verifyAttention: false,
    timeline: [],
    timelineLoaded: false,
    timelineRequestToken: 0,
    timelinePrefix: null,
    recorderState: "paused",
    recorderDetail: null,
    fromRoster: true,
    plan: [],
    planLoaded: false,
    planLoadAttempts: 0,
    planVersion: 0,
    dispatchWorker: false,
    dispatchTask: undefined,
    runs: null,
    testCommand: null,
    candidateTestEpoch: 0,
    worldlineLabel: null,
    ptySequenceLedger: new PtySequenceLedger(),
  };
  panes.set(instanceId, pane);
  pane.tabEl.prepend(typeEl);
  container.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const items: ContextMenuItem[] = [
      { label: "Copy", action: () => { view.copySelection(); } },
      { label: "Paste", action: () => { void view.pasteClipboard(); } },
    ];
    if (pane.engine === "core" && prefs.committed) {
      items.push({ separator: true });
      items.push({
        label: prefs.committed.showThinking ? "Hide Thinking" : "Show Thinking",
        action: () => commands.execute("toggle-thinking"),
      });
    }
    showContextMenu(items, event.clientX, event.clientY);
  });
  return pane;
}

/** A terminal tab that shows a message instead of a live pty (agent failed to start). */
let errorSeq = 0;
function createErrorPane(message: string): void {
  const id = `term-error-${++errorSeq}`;
  const pane = createPaneShell(id);
  pane.fromRoster = false;
  pane.error = true;
  pane.nameEl.textContent = "error";
  pane.tabEl.title = "terminal failed to start";
  pane.statusEl.style.display = "none";
  pane.view.write(`\r\n\x1b[1;31m✗ ${message.split("\n").join("\r\n  ")}${"\r\n"}\x1b[0m\r\n`);
  activatePane(id);
}

function applyTypeBadge(pane: Pane): void {
  const badge = pane.tabEl.querySelector(".tab-type") as HTMLElement;
  if (pane.type === "shell" && pane.shellName) {
    badge.textContent = pane.shellName;
    badge.style.display = "";
  } else {
    badge.textContent = "";
    badge.style.display = "none";
  }
}

/** Focus a terminal once its pane exists (Open / Promote can race instances).
 *  Deliberately last-wins: rapid Open/Promote activations end on the newest
 *  intent, and queueing would only flicker through superseded panes first. */
let pendingActivateId: string | null = null;
function activatePaneWhenReady(instanceId: string): void {
  pendingActivateId = instanceId;
  const pane = panes.get(instanceId);
  if (pane && !pane.exited) activatePane(instanceId);
}

/** Mirror unseen verify failures onto the project tab so background
 *  projects nudge too. The active project shows its own terminal dots. */
function updateProjectAttention(projectId: string | null): void {
  if (!projectId) return;
  const view = projectViews.get(projectId);
  const dot = view?.tabEl.querySelector(".tab-status") as HTMLElement | null;
  if (!view || !dot) return;
  let fail = false;
  for (const pane of panes.values()) {
    if (pane.projectId !== projectId || !pane.verifyAttention) continue;
    if (pane.verify.state === "fail" || pane.verify.state === "timeout") {
      fail = true;
      break;
    }
  }
  dot.classList.toggle("verify-fail", fail && projectId !== activeProjectId);
}

function activatePane(instanceId: string): void {
  const pane = panes.get(instanceId);
  if (!pane) return;
  removeSplash();
  activeId = instanceId;
  // Viewing clears the unseen-failure nudge.
  if (pane.verifyAttention) {
    pane.verifyAttention = false;
    updatePaneTab(pane);
  }
  updateProjectAttention(pane.projectId);
  if (pane.projectId) lastActivePane.set(pane.projectId, instanceId);
  // Scope to this project: background projects keep their own active tab so
  // returning to them shows a pane instead of a blank frame (flicker).
  for (const p of panes.values()) {
    if (p.projectId !== pane.projectId) continue;
    const on = p.instanceId === instanceId;
    p.container.classList.toggle("active", on);
    p.tabEl.classList.toggle("active", on);
    p.container.style.display = on ? "" : "none";
    p.view.setVisible(on);
  }
  if (pendingActivateId === instanceId) pendingActivateId = null;
  // Measure after layout: fitting synchronously here reads the pre-toggle
  // size, resizes the pty, then the ResizeObserver resizes again — that
  // double SIGWINCH is the tab-switch flicker/size jump.
  pane.view.focus();
  requestAnimationFrame(() => {
    if (activeId === instanceId) pane.view.fit();
  });
  renderChrome();
  timelinePane.renderTimeline();
  loadRuns(pane);
  refreshCandidateTestCommand(pane);
}

// ------------------------------------------------------------ fork run -----

/** Fetch the recorded runs of a pane once, then keep them fresh. */
function loadRuns(pane: Pane): void {
  if (pane.runs) {
    updateForkRunButton(pane);
    return;
  }
  void window.termina.getRuns(pane.instanceId).then((runs) => {
    const p = panes.get(pane.instanceId);
    if (!p) return;
    p.runs = runs;
    if (activeId === pane.instanceId) updateForkRunButton(p);
  }).catch((err) => toast(`could not load runs: ${(err as Error).message}`, "error"));
}

/** The newest completed run of the pane, or null. */
function lastCompletedRun(pane: Pane): RunSummary | null {
  if (!pane.runs) return null;
  const settled = pane.runs.filter((r) => r.settledAt !== null);
  return settled.length ? settled[settled.length - 1] : null;
}

/** Fork Run is enabled only for an eligible completed run; otherwise the
 *  button shows the exact ineligibility reason. */
function updateForkRunButton(pane: Pane): void {
  const run = lastCompletedRun(pane);
  if (!run) {
    btnForkRun.hidden = true;
    for (const button of challengeRunButtons) button.hidden = true;
    return;
  }
  btnForkRun.hidden = false;
  btnForkRun.disabled = !run.replayable;
  btnForkRun.title = run.replayable
    ? `Fork ${run.id} into candidates A (settled) and B (start) — ${run.promptText ?? ""}`.slice(0, 140)
    : `Fork Run unavailable: ${run.reason ?? "the run is not replayable"}`;
  for (const button of challengeRunButtons) {
    button.hidden = false;
    button.disabled = !run.replayable;
    button.title = run.replayable
      ? `Challenge ${run.id} with ${button.dataset.profile}`
      : `Challenge unavailable: ${run.reason ?? "the run is not replayable"}`;
  }
}

btnForkRun.addEventListener("click", () => {
  const pane = activeId ? panes.get(activeId) : undefined;
  const run = pane ? lastCompletedRun(pane) : null;
  if (!run) return;
  if (!run.replayable) {
    toast(`Fork Run unavailable: ${run.reason ?? "the run is not replayable"}`, "warning");
    return;
  }
  void window.termina.forkRun(run.id).then((res) => {
    // Success needs no toast: the new candidate cards are the confirmation.
    if (!res.ok) toast(`Fork Run failed: ${res.error ?? "unknown error"}`, "warning");
  }).catch((err) => toast(`Fork Run failed: ${(err as Error).message}`, "warning"));
});

for (const button of challengeRunButtons) {
  button.addEventListener("click", () => {
    const pane = activeId ? panes.get(activeId) : undefined;
    const run = pane ? lastCompletedRun(pane) : null;
    const profile = button.dataset.profile as ChallengeProfile | undefined;
    if (!run || !profile) return;
    if (!run.replayable) {
      toast(`Challenge unavailable: ${run.reason ?? "the run is not replayable"}`, "warning");
      return;
    }
    void window.termina.challengeRun(run.id, profile).then((res) => {
      // Success needs no toast: the challenger cards are the confirmation.
      if (!res.ok) toast(`Challenge failed: ${res.error ?? "unknown error"}`, "warning");
    }).catch((err) => toast(`Challenge failed: ${(err as Error).message}`, "warning"));
  });
}

/** Candidate terminals detect tests from their own isolated tree. */
function refreshCandidateTestCommand(pane: Pane): void {
  refreshWorldlineCandidateTest(pane, {
    activeProjectId: () => activeProjectId,
    hydrationEpoch: () => worldlineHydrationEpoch,
    isActivePane: (instanceId) => activeId === instanceId,
    paneById: (instanceId) => panes.get(instanceId),
    detectTest: (instanceId) => window.termina.detectTest(instanceId),
    onChanged: (current) => {
      if (activeId === current.instanceId) renderStatus(current);
    },
    onError: (err) => toast(`could not detect tests: ${(err as Error).message}`, "error"),
  });
  // Unlabeled panes own the project-tree cache. Candidate refresh clears them;
  // coalesce one project detect after a burst of those clears.
  if (pane.worldlineLabel === null) scheduleProjectTestCommandRefresh(pane.projectId);
}

async function closePane(instanceId: string): Promise<void> {
  const pane = panes.get(instanceId);
  if (!pane) return;
  const terminalGeneration = pane.generation;
  closingPanes.set(instanceId, { generation: terminalGeneration });
  panes.delete(instanceId);
  for (const [projectId, activeInstanceId] of lastActivePane) {
    if (activeInstanceId === instanceId) lastActivePane.delete(projectId);
  }
  // This pane's changed files leave with it; recompute so no dot outlives it.
  syncExplorerChanged();
  pane.view.dispose();
  pane.container.remove();
  pane.tabEl.remove();
  try {
    await window.termina.closeTerminal(instanceId, terminalGeneration);
  } catch (err) {
    closingPanes.delete(instanceId);
    toast(`could not close the terminal: ${(err as Error).message}`, "warning");
  }
  if (activeId === instanceId) {
    // Prefer another terminal of the same project. Never surface a
    // background project's terminal: its view is not in front.
    const candidates =
      pane.projectId !== null
        ? [...panes.values()].filter((p) => p.projectId === pane.projectId)
        : [...panes.values()];
    const next = candidates[candidates.length - 1];
    if (next) activatePane(next.instanceId);
    else {
      activeId = null;
      renderChrome();
    }
  }
}

function updatePaneTab(pane: Pane): void {
  pane.nameEl.textContent = pane.dispatchWorker ? "dispatch" : pane.cwd ? pathBasename(pane.cwd) : "terminal";
  pane.tabEl.title = pane.dispatchWorker
    ? `dispatch worker — ${pane.dispatchTask ?? "plan task"}`
    : `${pane.cwd ?? "?"}${
        pane.type === "shell" && pane.shellName
          ? ` · ${pane.shellName} shell`
          : " · core agent"
      }`;
  const presented = presentActivity(pane);
  pane.statusEl.classList.toggle("busy", presented.working && !presented.blocked);
  pane.statusEl.classList.toggle("blocked", presented.blocked);
  pane.statusEl.title = presented.blocked ? presented.blockedLabel : "unseen verify failure";
  // Unseen verify failures hold the tab dot until first view; any newer
  // verify state clears them.
  const failDot = pane.verifyAttention && pane.verify.state === "fail";
  const timeoutDot = pane.verifyAttention && pane.verify.state === "timeout";
  pane.statusEl.classList.toggle("verify-fail", failDot);
  pane.statusEl.classList.toggle("verify-timeout", timeoutDot);
  applyTypeBadge(pane);
  // Worldline candidates carry the A/B badge on their tab.
  const wlineEl = pane.tabEl.querySelector(".tab-worldline") as HTMLElement;
  updateWorldlinePaneTab(
    activeProjectId,
    pane,
    (instanceId) => worldlinesView.labelOfTerminal(instanceId),
    wlineEl,
  );
}

function renderChrome(): void {
  const pane = activeId ? panes.get(activeId) : undefined;
  if (!pane) {
    statusState.textContent = "no terminal";
    statusCwd.textContent = "";
    statusUsage.hidden = true;
    btnVerify.disabled = true;
    verifyBadge.textContent = "";
    verifyBadge.hidden = true;
    activityPane.clear();
    btnCopySubject.hidden = true;
    btnOpenShell.hidden = true;
    timelinePane.renderTimeline();
    return;
  }
  renderStatus(pane);
  activityPane.renderPlan(pane, false);
  activityPane.renderModified(pane, false);
}

function presentActivity(pane: Pane): { blocked: boolean; working: boolean; blockedLabel: string } {
  const state = asKnownState(pane.activity?.state, KNOWN_ACTIVITY_STATES);
  return {
    blocked: state === "blocked",
    // Explicit idle/working/blocked win. `busy` is only a fallback when
    // activity is missing or hostile so a settle fold cannot flash "working".
    working: state === "working" || (state === "unknown" && pane.busy),
    blockedLabel: presentBlockedLabel(pane.activity?.reason),
  };
}

/** Status bar and Verify only. Busy ticks must not rebuild the plan or modified lists. */
function renderStatus(pane: Pane): void {
  const presented = presentActivity(pane);
  statusState.textContent = presented.blocked
    ? `● ${presented.blockedLabel}`
    : presented.working
      ? "● agent working"
      : "idle";
  statusState.classList.toggle("busy", presented.working);
  statusState.classList.toggle("blocked", presented.blocked);
  statusCwd.textContent = pane.cwd ?? "";
  renderAgentStatus(pane);
  renderVerify(pane);
  renderHandoff(pane);
}

/** Status bar trailing: usage for the active agent. Model and effort live in the terminal footer. */
function renderAgentStatus(pane: Pane): void {
  const isAgent = pane.type === "agent" && !pane.error;
  statusUsage.hidden = !isAgent || !pane.usage;
  if (!isAgent) return;
  if (pane.usage) {
    statusUsage.textContent = pane.usage;
    statusUsage.title = pane.usage;
  } else {
    statusUsage.textContent = "";
    statusUsage.title = "";
  }
}

/** Verify & Iterate: badge + button for the active terminal. */
let projectTestRefreshQueued: string | null | false = false;
function scheduleProjectTestCommandRefresh(projectId: string | null): void {
  const pending = projectTestRefreshQueued !== false;
  projectTestRefreshQueued = projectId;
  if (pending) return;
  queueMicrotask(() => {
    const id = projectTestRefreshQueued;
    projectTestRefreshQueued = false;
    if (id === false) return;
    void refreshTestCommand(id);
  });
}

async function refreshTestCommand(projectId: string | null = activeProjectId): Promise<void> {
  const requestedGeneration = activeProjectGeneration;
  const requestedProjectId = projectId;
  const detectPane = projectTestDetectPane(requestedProjectId, activeId, panes.values());
  if (!requestedProjectId || !detectPane) return;
  const requestEpoch = ++detectPane.candidateTestEpoch;
  try {
    const t = await window.termina.detectTest(detectPane.instanceId);
    if (
      detectPane.candidateTestEpoch !== requestEpoch
      || requestedGeneration !== activeProjectGeneration
      || activeProjectId !== requestedProjectId
      || detectPane.worldlineLabel !== null
      || panes.get(detectPane.instanceId) !== detectPane
    ) return;
    applyProjectTestDetect(requestedProjectId, t?.label ?? null, panes.values());
  } catch {
    if (
      detectPane.candidateTestEpoch !== requestEpoch
      || requestedGeneration !== activeProjectGeneration
      || activeProjectId !== requestedProjectId
      || detectPane.worldlineLabel !== null
    ) return;
    applyProjectTestDetect(requestedProjectId, null, panes.values());
  }
  const pane = activeId ? panes.get(activeId) : undefined;
  if (pane) renderStatus(pane);
}
(window as unknown as Record<string, unknown>).__refreshTestCommand = refreshTestCommand;
(window as unknown as Record<string, unknown>).__getTestCommand = () => {
  const pane = activeId ? panes.get(activeId) : undefined;
  if (!pane) return null;
  return resolvePaneTestCommand(pane, projectTestCommandFromPanes(pane.projectId, panes.values()));
};

function renderVerify(pane: Pane): void {
  const v = pane.verify;
  const isAgent = pane.type === "agent" && !pane.error;
  if (!isAgent) {
    btnVerify.disabled = true;
    verifyBadge.textContent = "";
    verifyBadge.hidden = true;
    return;
  }
  // Candidate terminals use their own tree's test command.
  const command = resolvePaneTestCommand(pane, projectTestCommandFromPanes(pane.projectId, panes.values()));
  btnVerify.disabled = v.state === "running" || !command;
  btnVerify.title = command ? `Run ${command}` : "No test command detected (package.json, pytest, cargo, go)";
  if (v.state === "untested") {
    verifyBadge.textContent = "";
    verifyBadge.hidden = true;
    return;
  }
  verifyBadge.hidden = false;
  const badgeState = asKnownState(v.state, KNOWN_VERIFY_BADGE_STATES);
  verifyBadge.className = `verify-badge state-${badgeState}`;
  verifyBadge.replaceChildren();
  if (v.state === "running") {
    // Loader: a spinner and a label show that the run is running.
    const spin = document.createElement("span");
    spin.className = "verify-spinner";
    verifyBadge.appendChild(spin);
    verifyBadge.appendChild(document.createTextNode(` verifying · ${v.command ?? ""}`));
  } else if (badgeState === "unknown") {
    verifyBadge.textContent = "unknown";
  } else {
    verifyBadge.textContent =
      v.state === "pass" ? `✓ ${v.summary ?? "green"}` : v.state === "timeout" ? `⏰ ${v.summary ?? "timed out"}` : v.state === "cancelled" ? `⏸ ${v.summary ?? "cancelled"}` : `✗ ${v.summary ?? "failing"}`;
  }
  verifyBadge.title =
    v.state === "running" ? "Click to cancel verification" : v.state === "fail" && v.summary ? v.summary : v.command ?? "";
}

/** Show the Git handoff after a green Verify or an Accept. Termina never writes Git. */
function renderHandoff(pane: Pane): void {
  const accepted = pane.modified.some((f) => pane.accepted.has(f.path));
  const show = pane.verify.state === "pass" || accepted;
  btnCopySubject.hidden = !show;
  btnOpenShell.hidden = !show;
}

function commitSubjectFromPrompt(text: string | null | undefined): string {
  const line = (text ?? "").split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0) ?? "";
  const subject = line.replace(/\s+/g, " ").slice(0, 72);
  return subject || "Apply review changes";
}

async function copyCommitSubject(): Promise<void> {
  const pane = activeId ? panes.get(activeId) : undefined;
  if (!pane) return;
  try {
    if (!pane.runs) pane.runs = await window.termina.getRuns(pane.instanceId);
    const subject = commitSubjectFromPrompt(lastCompletedRun(pane)?.promptText);
    const res = await window.termina.writeClipboard(subject);
    if (res.ok) toast("Copied commit subject — Termina does not write Git", "info");
    else toast(res.error ?? "could not copy", "warning");
  } catch (err) {
    toast(`could not copy: ${(err as Error).message}`, "warning");
  }
}

async function focusProjectShell(): Promise<void> {
  const pane = activeId ? panes.get(activeId) : undefined;
  const projectId = pane?.projectId ?? activeProjectId;
  layout.revealTerminal();
  const existing = [...panes.values()].find((p) => p.projectId === projectId && p.type === "shell" && !p.error);
  if (existing) {
    activatePane(existing.instanceId);
    return;
  }
  try {
    const res = await window.termina.createTerminal({ type: "shell", projectId: projectId ?? undefined });
    if (!res.ok) toast(res.error ?? "could not open a shell", "warning");
    else if (res.id && panes.has(res.id)) activatePane(res.id);
  } catch (err) {
    toast(`could not open a shell: ${(err as Error).message}`, "warning");
  }
}

// ---------------------------------------------------------------- commands --

function normalizePath(inputPath: string): string {
  const isAbs = inputPath.startsWith("/");
  const segments = inputPath.split("/");
  const resolved: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (resolved.length > 0 && resolved[resolved.length - 1] !== "..") {
        resolved.pop();
      } else if (!isAbs) {
        resolved.push("..");
      }
    } else {
      resolved.push(seg);
    }
  }
  return (isAbs ? "/" : "") + resolved.join("/");
}

async function openFileSmart(
  path: string,
  preview = true,
  requestedOwner?: ProjectWorkspaceRef,
  line?: number,
  column?: number,
): Promise<void> {
  // Every caller floats this call: nothing inside may ever reject. The inner
  // function reports its own failures; this wrapper catches sync surprises
  // (routing, reveal) so a bad open toasts instead of going unhandled.
  try {
    await openFileSmartInner(path, preview, requestedOwner, line, column);
  } catch (err) {
    toast(`could not open ${pathBasename(path)}: ${(err as Error).message}`, "error");
  }
}

async function openFileSmartInner(
  path: string,
  preview: boolean,
  requestedOwner: ProjectWorkspaceRef | undefined,
  line: number | undefined,
  column: number | undefined,
): Promise<void> {
  if (reviewView?.isVisible) reviewView.hide();
  let owner = requestedOwner ?? (() => {
    const view = activeProjectId ? projectViews.get(activeProjectId) : null;
    return view?.workspaceId ? { projectId: view.id, workspaceId: view.workspaceId } : null;
  })();

  let cleanPath = path;
  if (cleanPath.startsWith("file://")) {
    cleanPath = cleanPath.slice("file://".length);
    if (cleanPath.startsWith("localhost/")) {
      cleanPath = cleanPath.slice("localhost".length);
    }
  }
  try {
    cleanPath = decodeURIComponent(cleanPath);
  } catch {
    // Keep raw string if URI decoding fails
  }
  cleanPath = normalizePath(cleanPath);

  // If path is absolute, route to the project that owns it. Nested projects
  // match by longest prefix: first-match would route a nested file to its
  // parent project whenever the parent sorts first.
  if (cleanPath.startsWith("/")) {
    let best: { projId: string; view: ProjectView } | null = null;
    for (const [projId, projView] of projectViews.entries()) {
      if (cleanPath === projView.cwd || cleanPath.startsWith(projView.cwd + "/")) {
        if (!best || projView.cwd.length > best.view.cwd.length) best = { projId, view: projView };
      }
    }
    if (best) {
      owner = { projectId: best.projId, workspaceId: best.view.workspaceId };
      if (activeProjectId !== best.projId) {
        setActiveProject(best.projId);
      }
    }
  }

  const view = owner ? projectViews.get(owner.projectId) : null;
  if (!owner || !view) {
    toast(`could not open ${pathBasename(path)}: file owner is unavailable`, "error");
    return;
  }
  const abs = cleanPath.startsWith("/") ? cleanPath : normalizePath(`${view.cwd}/${cleanPath}`);
  // Expand the editor only once the target project is known and in front:
  // revealing before routing resizes the terminal twice on cross-project opens.
  layout.revealEditor();
  try {
    await ensureProjectEditor(view).openFile(abs, { preview, owner, line, column });
    // A successful open is the recency signal, whatever path led here.
    const rel = abs.startsWith(`${view.cwd}/`) ? abs.slice(view.cwd.length + 1) : null;
    if (rel) void window.termina.recordRecentFile(owner.projectId, rel).catch(() => undefined);
  } catch (err) {
    toast(`could not open ${pathBasename(abs)}: ${(err as Error).message}`, "error");
  }
}

// ---------------------------------------------------------------- panels ----

const terminalMenu = createTerminalMenu({
  anchor: btnNewTerminal,
  getActivePane: () => (activeId ? panes.get(activeId) : undefined),
  hasPane: (instanceId) => panes.has(instanceId),
  getActiveProjectId: () => activeProjectId,
  activatePane,
  createErrorPane,
  refocusActivePane: () => {
    if (activeId && panes.has(activeId)) panes.get(activeId)?.view.focus();
  },
});
window.termina.onProjectClosed(({ projectId, activationGeneration }) => {
  if (Number.isSafeInteger(activationGeneration) && activationGeneration > latestProjectActivationGeneration) {
    latestProjectActivationGeneration = activationGeneration;
  }
  removeProjectView(projectId);
  if (projectViews.size === 0) {
    projectCwd = null;
    explorer.setProject(null, null);
    getBaseEditor().setProjectOpen(false);
  }
});
btnNewProject.addEventListener("click", () => {
  void window.termina.projectOpen().catch((err) => {
    toast(`could not open a project: ${(err as Error).message}`, "warning");
  });
});
document.getElementById("right-pane")!.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.closest(".empty-open-folder")) return;
  void window.termina.projectOpen().catch((err) => {
    toast(`could not open a project: ${(err as Error).message}`, "warning");
  });
});
// Double-click on the empty bar area opens a new project tab.
projectTabsEl.addEventListener("dblclick", (e) => {
  if ((e.target as HTMLElement).closest(".project-tab, #btn-new-project")) return;
  void window.termina.projectOpen().catch((err) => {
    toast(`could not open a project: ${(err as Error).message}`, "warning");
  });
});

btnCopySubject.addEventListener("click", () => void copyCommitSubject());
btnOpenShell.addEventListener("click", () => void focusProjectShell());
btnVerify.addEventListener("click", () => {
  const id = activeId;
  if (!id) return;
  void window.termina.runVerify(id).then((res) => {
    if (!res.ok) toast(res.error ?? "verify failed to start", "warning");
  }).catch((err) => toast(`verify failed to start: ${(err as Error).message}`, "warning"));
});
verifyBadge.addEventListener("click", () => {
  const pane = activeId ? panes.get(activeId) : undefined;
  // The badge already shows the verdict summary; a click only cancels a run.
  if (!pane || pane.verify.state !== "running") return;
  void window.termina.cancelVerify(pane.instanceId).then((res) => {
    if (!res.ok) toast(res.error ?? "verify could not be cancelled", "warning");
  }).catch((err) => toast(`verify could not be cancelled: ${(err as Error).message}`, "warning"));
});

// ---------------------------------------------------------------- layout ---
// Occupancy policy stays at the entry: it reads project tabs, review, and
// the base editor. The layout owner consumes the boolean.
function editorPaneOccupied(): boolean {
  if (reviewView?.isVisible === true) return true;
  if (activeProjectId) {
    const view = projectViews.get(activeProjectId);
    if (view?.editorMgr?.hasOpenTabs() === true) return true;
    // Same gate as EditorManager.syncEmptyState: keep the empty pane so
    // `.empty-login` is not auto-collapsed after Open folder.
    return view?.needsLogin === true;
  }
  return baseEditorInstance?.hasOpenTabs() === true;
}

layout = createLayout({
  elements: {
    splitEl: document.getElementById("main-split")!,
    leftPane,
    rightPaneEl,
    explorerEl,
    explorerDividerEl: document.getElementById("explorer-divider")!,
    modifiedPanelEl: document.getElementById("modified-panel")!,
    modifiedList,
    modifiedResizeEl: document.getElementById("modified-resize")!,
    termContainer,
    divider: document.getElementById("divider")!,
    btnMinExplorer: document.getElementById("btn-min-explorer") as HTMLButtonElement,
    btnMinTerminal: document.getElementById("btn-min-terminal") as HTMLButtonElement,
    btnMinEditor: document.getElementById("btn-min-editor") as HTMLButtonElement,
    mainEl: document.getElementById("main")!,
  },
  editorOccupied: editorPaneOccupied,
  layoutEditors: () => {
    if (editorModule) activeEditor().layout();
  },
  layoutActiveTerminal: () => {
    const active = activeId ? panes.get(activeId) : undefined;
    if (active && active.projectId === activeProjectId) active.view.fit();
  },
  setModifiedTabVisible: (visible) => activityTabs.setTabVisible("modified", visible),
});

// File-menu commands + layout/toggle commands
/**
 * Route a menu edit command to the focused surface. The editor runs its own
 * action. A focused terminal selects its whole buffer. Any other input uses
 * the browser command.
 */
function runMenuEdit(kind: "undo" | "redo" | "select-all"): void {
  if (activeEditor().runMenuEdit(kind)) return;
  const pane = activeId ? panes.get(activeId) : undefined;
  // NOTE: document.execCommand is deprecated but has no replacement for
  // undo/redo/select-all on unfocused surfaces (navigator.clipboard only
  // covers copy/cut/paste, already used on the clipboard path). Keep until
  // browsers ship an equivalent; the calls below are the only three left.
  if (pane && !pane.error) {
    const term = pane.view.getTerminal();
    if (term.textarea && document.activeElement === term.textarea) {
      if (kind === "select-all") term.selectAll();
      else document.execCommand(kind);
      return;
    }
  }
  if (kind === "select-all") document.execCommand("selectAll");
  else document.execCommand(kind);
}

function runClipboardCommand(command: "copy" | "cut" | "paste"): void {
  // The Electron menu eats the keystroke before Monaco sees it, so route
  // the focused editor through its clipboard actions first.
  if (activeEditor().runMenuEdit(command)) return;
  const pane = activeId ? panes.get(activeId) : undefined;
  const term = pane?.view.getTerminal();
  if (pane && term?.textarea && document.activeElement === term.textarea) {
    if (command === "copy" || command === "cut") {
      // A terminal has no cuttable text: cutting copies the selection.
      if (pane.view.copySelection()) return;
      if (command === "copy") void window.termina.writeTerminal(pane.instanceId, "\x03").catch(() => undefined);
      return;
    }
    void pane.view.pasteClipboard();
    return;
  }
  void window.termina.editClipboard(command).catch(() => toast("could not access the clipboard", "warning"));
}

const commands = new CommandDispatcher();

// File & Explorer commands
commands.register("new-file", () => explorer.handleCommand("new-file"));
commands.register("new-folder", () => explorer.handleCommand("new-folder"));
commands.register("rename", () => explorer.handleCommand("rename"));
commands.register("delete", () => explorer.handleCommand("delete"));
commands.register("refresh", () => explorer.handleCommand("refresh"));
commands.register("save-all", () => {
  void activeEditor().flushAll().then((res) => {
    if (!res.ok) toast(`could not save: ${res.failed.map((p) => pathBasename(p)).join(", ")}`, "warning");
  });
});

// Edit commands
commands.register("undo", () => runMenuEdit("undo"));
commands.register("redo", () => runMenuEdit("redo"));
commands.register("cut", () => runClipboardCommand("cut"));
commands.register("copy", () => runClipboardCommand("copy"));
commands.register("paste", () => runClipboardCommand("paste"));
commands.register("select-all", () => runMenuEdit("select-all"));

// Terminal commands
commands.register("new-terminal", () => {
  terminalMenu.toggle();
});
commands.register("next-terminal", () => cycleTerminals(1));
commands.register("previous-terminal", () => cycleTerminals(-1));
commands.register("toggle-thinking", () => {
  if (!prefs.committed) {
    toast("Could not load settings", "error");
    return;
  }
  const next = !prefs.committed.showThinking;
  void window.termina.updatePreferences({ patch: { showThinking: next }, activateShortcuts: false }).then((saved) => {
    prefs.apply(saved, false, false);
  }).catch(() => toast("Could not save settings", "error"));
});
commands.register("next-project", () => cycleProjects(1));
commands.register("previous-project", () => cycleProjects(-1));
commands.register("terminal-find", () => {
  if (activeEditor().runMenuEdit("find")) return;
  terminalFind.open();
});

// ---- terminal find ----
terminalFind = createTerminalFind({
  termContainer,
  getActivePane: () => (activeId ? panes.get(activeId) : undefined),
  getPaneById: (id) => panes.get(id),
});

// ---- tab cycling ----
// Tab order is DOM order: drag reorder moves nodes without touching the
// maps, so both cycles read the strips and match elements back to ids.

function orderedProjectPanes(): Pane[] {
  const byTab = new Map<HTMLElement, Pane>();
  for (const p of panes.values()) byTab.set(p.tabEl, p);
  const out: Pane[] = [];
  for (const el of termTabsList.children) {
    const pane = byTab.get(el as HTMLElement);
    if (pane && pane.projectId === activeProjectId) out.push(pane);
  }
  return out;
}

function cycleTerminals(delta: 1 | -1): void {
  const list = orderedProjectPanes();
  if (list.length < 2) return;
  const index = list.findIndex((p) => p.instanceId === activeId);
  const next = list[(index + delta + list.length) % list.length];
  if (next) activatePane(next.instanceId);
}

/** Project ids in tab-strip order. Drag reorder moves nodes, not maps. */
function orderedProjectIds(): string[] {
  const byTab = new Map<HTMLElement, string>();
  for (const view of projectViews.values()) byTab.set(view.tabEl, view.id);
  const ids: string[] = [];
  for (const el of projectTabsEl.children) {
    const id = byTab.get(el as HTMLElement);
    if (id) ids.push(id);
  }
  return ids;
}

function cycleProjects(delta: 1 | -1): void {
  const ids = orderedProjectIds();
  if (ids.length < 2) return;
  const index = activeProjectId ? ids.indexOf(activeProjectId) : -1;
  const next = ids[(index + delta + ids.length) % ids.length];
  if (next) {
    void window.termina.projectActivate(next).catch((err) => {
      toast(`could not switch projects: ${(err as Error).message}`, "warning");
    });
  }
}

function activateProjectByIndex(index: number): void {
  const id = orderedProjectIds()[index];
  if (id) {
    void window.termina.projectActivate(id).catch((err) => {
      toast(`could not switch projects: ${(err as Error).message}`, "warning");
    });
  }
}

for (let i = 1; i <= 9; i++) {
  commands.register(`project-${i}` as CommandId, () => activateProjectByIndex(i - 1));
}

// ---- keyboard shortcuts ----
// Menu accelerators cannot capture Tab keys. The renderer matches keydown
// events against the same shortcut map the menu uses. Working menu
// accelerators consume their keys first, so this path never double-fires.
// While settings is open its shortcut recorder owns the keys, and the menu
// accelerators are blank; the bridge must not fire behind the modal.
function normalizeShortcut(value: string): string {
  return value.replace("CmdOrCtrl", isMacPlatform() ? "Cmd" : "Ctrl");
}

/** True when a live core TUI owns keyboard focus: its textarea is the focused element of the active core pane. Shells and exited panes keep menu behavior. */
function isCoreTerminalFocused(): boolean {
  const pane = activeId ? panes.get(activeId) : undefined;
  if (!pane || pane.error || pane.exited || pane.engine !== "core") return false;
  const textarea = pane.view.getTerminal().textarea;
  return !!textarea && document.activeElement === textarea;
}

/** Push menu-accelerator scope to main when terminal focus changes. The menu blanks the TUI-owned chords while a core terminal is focused so they reach the pty; reports only on change. */
let lastReportedTerminalFocus = false;
function syncTerminalFocusScope(): void {
  const focused = isCoreTerminalFocused();
  if (focused === lastReportedTerminalFocus) return;
  lastReportedTerminalFocus = focused;
  void window.termina.setTerminalFocus(focused).catch(() => undefined);
}
document.addEventListener("focusin", syncTerminalFocusScope);
document.addEventListener("focusout", syncTerminalFocusScope);
// The e2e suites poll the last scope reported to main: menu scoping crosses
// async IPC, so suites settle it before pressing TUI chords.
(window as unknown as Record<string, unknown>).__terminalFocusScope = () => lastReportedTerminalFocus;

window.addEventListener(
  "keydown",
  (e) => {
    if (prefs.settingsView.isOpen) return;
    const computed = shortcutForEvent(e);
    if (!computed) return;
    const target = normalizeShortcut(computed);
    // A focused core TUI owns Ctrl+P (next model) and Ctrl+R (history
    // search): let those chords fall through to the pty instead of running
    // their bound command. The menu blanks the same chords (see
    // syncTerminalFocusScope), so neither layer steals them on Windows/Linux.
    if (isTuiOwnedShortcut(target) && isCoreTerminalFocused()) return;
    const entries = Object.entries(prefs.current.shortcuts) as [CommandId, string][];
    const command = entries.find(([, bound]) => bound && normalizeShortcut(bound) === target)?.[0];
    if (!command || !commands.has(command)) return;
    e.preventDefault();
    e.stopPropagation();
    commands.execute(command);
  },
  true,
);

// Scroll over a tab strip cycles its tabs (iTerm-style). The accumulator
// turns one trackpad gesture into one switch; the idle timer drops stale
// scroll so a slow rub never fires late.
function setupWheelCycling(el: HTMLElement, cycle: (delta: 1 | -1) => void): void {
  let acc = 0;
  let idle: number | null = null;
  el.addEventListener(
    "wheel",
    (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      acc += e.deltaY;
      if (idle !== null) window.clearTimeout(idle);
      idle = window.setTimeout(() => {
        acc = 0;
        idle = null;
      }, 300);
      if (Math.abs(acc) < 50) return;
      const delta = acc > 0 ? 1 : -1;
      acc = 0;
      cycle(delta);
    },
    { passive: true },
  );
}
setupWheelCycling(projectTabsEl, cycleProjects);
setupWheelCycling(termTabsList, cycleTerminals);

// View & Layout commands
commands.register("fullscreen", () => layout.applyLayout("terminal-fullscreen"));
commands.register("layout-terminal-left", () => layout.applyLayout("terminal-left"));
commands.register("layout-terminal-right", () => layout.applyLayout("terminal-right"));
commands.register("layout-terminal-top", () => layout.applyLayout("terminal-top"));
commands.register("layout-terminal-bottom", () => layout.applyLayout("terminal-bottom"));
commands.register("toggle-explorer", () => layout.toggleExplorer());
commands.register("toggle-terminal", () => layout.requestMinimize("terminal"));
commands.register("toggle-editor", () => layout.requestMinimize("editor"));
commands.register("toggle-modified", () => layout.toggleModified());
commands.register("session-search", () => sessionSearch.open());
quickOpen.bind({
  // An explicit modal pick is a direct gesture: take editor focus so the
  // keyboard flow (Cmd+P, Enter, type) works without an extra click.
  onOpenFile: (relPath) =>
    void openFileSmart(relPath, true).then(() => {
      activeEditor().focusEditor();
      void explorer.reveal(relPath);
    }),
  onOpenContentHit: (relPath, line, column) => openContentHit(relPath, line, column),
  onContentResults: (pattern, hits, truncated) => explorer.showContentResults(pattern, hits, truncated),
  onExecuteCommand: (command) => commands.execute(command),
  getShortcut: (command) => prefs.current.shortcuts[command] ?? "",
});
commands.register("quick-open", () => quickOpen.open("files"));
commands.register("content-search", () => quickOpen.open("content"));
commands.register("command-palette", () => quickOpen.open("actions"));

// Settings
btnSettings.addEventListener("click", () => prefs.openSettings());
commands.register("open-settings", () => prefs.openSettings());

window.termina.onMenuCommand((cmd) => {
  commands.execute(cmd.command);
});

// drag to reorder terminal tabs
let dragTabEl: HTMLElement | null = null;
function setupTabDrag(tabEl: HTMLElement): void {
  tabEl.draggable = true;
  tabEl.addEventListener("dragstart", () => {
    dragTabEl = tabEl;
    tabEl.classList.add("dragging");
  });
  tabEl.addEventListener("dragend", () => {
    dragTabEl = null;
    tabEl.classList.remove("dragging");
  });
  tabEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!dragTabEl || dragTabEl === tabEl) return;
    const list = termTabsList;
    const rect = tabEl.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    list.insertBefore(dragTabEl, before ? tabEl : tabEl.nextSibling);
  });
}

// -------------------------------------------------------- agent events ----

function renderAcceptedPtyRecords(
  pane: Pane,
  records: Array<{ kind: "data"; sequence: number; data: string } | { kind: "exit"; sequence: number; code: number }>,
  id: string,
  generation: number,
  windowGeneration: number,
  rendererGeneration: number,
): void {
  for (const record of records) {
    if (record.kind === "data") {
      pane.view.write(record.data, () => {
        window.termina.acknowledgePtyData({
          id,
          generation,
          windowGeneration,
          rendererGeneration,
          sequence: record.sequence,
        });
      });
      continue;
    }
    pane.exited = true;
    // The TUI is gone: un-scope the menu so Ctrl+P / Ctrl+R run their bound commands again while this pane stays focused.
    syncTerminalFocusScope();
    pane.view.write("\r\n\x1b[90m[agent exited]\x1b[0m\r\n", () => {
      window.termina.acknowledgePtyData({
        id,
        generation,
        windowGeneration,
        rendererGeneration,
        sequence: record.sequence,
      });
    });
  }
}

window.termina.onPtyModes(({ id, generation, bracketedPasteMode }) => {
  const pane = panes.get(id);
  if (!pane || pane.error || pane.generation !== generation) return;
  pane.view.setBracketedPasteMode(bracketedPasteMode);
});

window.termina.onPtyData(({ id, generation, windowGeneration, rendererGeneration, sequence, data }) => {
  const pane = panes.get(id);
  if (!pane || pane.error || pane.generation !== generation) return;
  const result = pane.ptySequenceLedger.accept({ kind: "data", sequence, data });
  if (result.kind === "duplicate") {
    // A replay can race a duplicate delivery in the same renderer document;
    // acknowledge it without writing the terminal bytes twice.
    window.termina.acknowledgePtyData({ id, generation, windowGeneration, rendererGeneration, sequence });
    return;
  }
  if (result.kind !== "accepted") return;
  renderAcceptedPtyRecords(pane, result.records, id, generation, windowGeneration, rendererGeneration);
});

window.termina.onPtyExit(({ id, generation, windowGeneration, rendererGeneration, sequence, code }) => {
  const pane = panes.get(id);
  if (!pane || pane.generation !== generation) return;
  const result = pane.ptySequenceLedger.accept({ kind: "exit", sequence, code });
  if (result.kind === "duplicate") {
    // A duplicate marker in one document is already rendered; retire the
    // retained ledger record without writing the status line twice.
    window.termina.acknowledgePtyData({ id, generation, windowGeneration, rendererGeneration, sequence });
    return;
  }
  if (result.kind !== "accepted") return;
  renderAcceptedPtyRecords(pane, result.records, id, generation, windowGeneration, rendererGeneration);
});

/** Lock the editor while a busy agent is bound to the project's primary
 *  workspace. Candidate trees have their own workspaceId from main. */
function updateEditorLock(): void {
  if (!editorModule) return;
  const view = activeProjectId ? projectViews.get(activeProjectId) : undefined;
  if (!view) {
    activeEditor().setLocked(false);
    return;
  }
  const locked = [...panes.values()].some(
    (p) => p.busy && p.type === "agent" && !p.error && p.projectId === activeProjectId && p.workspaceId === view.workspaceId,
  );
  activeEditor().setLocked(locked);
}

window.termina.onFlushRequest(({ requestId, writerId, projectId, workspaceId }) => {
  const view = projectViews.get(projectId);
  if (!view || view.workspaceId !== workspaceId) {
    void window.termina.reportFlush(requestId, { ok: false, failed: ["project editor is unavailable"] }).catch(() => undefined);
    return;
  }
  if (!view.editorMgr) {
    void window.termina.reportFlush(requestId, { ok: true, failed: [] }).catch(() => undefined);
    return;
  }
  // Main awaits this report: a flush throw reports failure instead of withholding it.
  void view.editorMgr.flushAll(writerId).then(
    (result) => {
      void window.termina.reportFlush(requestId, result).catch(() => undefined);
    },
    () => {
      void window.termina.reportFlush(requestId, { ok: false, failed: ["could not save editor changes"] }).catch(() => undefined);
    },
  );
});

/** Editors that can hold dirty buffers for one project, or every project on quit. */
function editorsForUnsavedConfirm(projectId: string | null): EditorManagerInstance[] {
  if (projectId) {
    const view = projectViews.get(projectId);
    return view?.editorMgr ? [view.editorMgr] : [];
  }
  const editors: EditorManagerInstance[] = [];
  for (const view of projectViews.values()) {
    if (view.editorMgr) editors.push(view.editorMgr);
  }
  if (baseEditorInstance) editors.push(baseEditorInstance);
  return editors;
}

/** Save / Discard / Cancel for dirty buffers. Save reuses flushAll → file:save. */
async function confirmUnsavedEditors(projectId: string | null): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> {
  const editors = editorsForUnsavedConfirm(projectId);
  const dirty = editors.filter((editor) => editor.hasDirtyModels());
  const count = dirty.reduce((n, editor) => n + editor.dirtyCount(), 0);
  const decision = decideUnsavedClose(
    count > 0,
    count > 0 ? await showUnsavedConfirm("Unsaved changes", unsavedCloseMessage(count)) : null,
  );
  if (decision === "abort") return { ok: false, cancelled: true };
  if (decision === "save") {
    // Flush every editor, not just the prompt-time dirties: an editor
    // dirtied while the prompt was open must still be saved. Clean editors
    // are a no-op flush.
    const results = await Promise.all(editors.map((editor) => editor.flushAll()));
    const failed = results.flatMap((result) => result.failed);
    if (failed.length > 0) {
      toast(`could not save: ${failed.map((p) => pathBasename(p)).join(", ")}`, "error");
      return { ok: false, error: "could not save editor changes" };
    }
  }
  return { ok: true };
}

window.termina.onUnsavedConfirm(({ requestId, projectId }) => {
  // Main awaits this report: a confirm throw reports failure instead of withholding it.
  void confirmUnsavedEditors(projectId).then(
    (result) => {
      void window.termina.reportUnsavedConfirm(requestId, result).catch(() => undefined);
    },
    () => {
      void window.termina.reportUnsavedConfirm(requestId, { ok: false, error: "could not confirm unsaved changes" }).catch(() => undefined);
    },
  );
});

function applyAppUpdateState(state: AppUpdateState): void {
  const show = state.status === "available" || state.status === "downloading" || state.status === "ready" || state.status === "error";
  btnAppUpdate.hidden = !show;
  btnAppUpdate.classList.toggle("ready", state.status === "ready");
  btnAppUpdate.classList.toggle("error", state.status === "error");
  if (!show) return;
  const label = appUpdateButtonLabel(state);
  btnAppUpdate.textContent = label.text;
  btnAppUpdate.title = label.title;
  btnAppUpdate.setAttribute("aria-label", label.title);
}

function appUpdateButtonLabel(
  state: Extract<AppUpdateState, { status: "available" | "downloading" | "ready" | "error" }>,
): { text: string; title: string } {
  switch (state.status) {
    case "available":
      return { text: "↑", title: `Termina ${state.version} is available (downloading…)` };
    case "downloading":
      return { text: `${state.percent}%`, title: `Downloading Termina ${state.version} (${state.percent}%)` };
    case "ready":
      return { text: "↑", title: `Restart to install Termina ${state.version}` };
    case "error":
      return { text: "!", title: `Could not check for updates: ${state.message}` };
  }
}

btnAppUpdate.addEventListener("click", () => {
  void window.termina.getUpdateState().then((state) => {
    if (state.status === "error") {
      void window.termina.checkUpdate().catch(() => undefined);
      return;
    }
    if (state.status === "ready") {
      void window.termina.installUpdate().then((res) => {
        if (!res.ok) toast(res.error ?? "could not install the update", "warning");
      }).catch((err) => toast(`could not install the update: ${(err as Error).message}`, "warning"));
      return;
    }
    if (state.status === "downloading" || state.status === "available") {
      toast(`Downloading Termina ${state.version}…`, "info");
      return;
    }
  }).catch(() => undefined);
});
window.termina.onUpdateState(applyAppUpdateState);
void window.termina.getUpdateState().then(applyAppUpdateState).catch(() => undefined);

window.termina.onBusy(({ instanceId, busy }) => {
  handleWorldlineBusy(
    { instanceId, busy },
    {
      paneById: (id) => panes.get(id),
      updatePaneTab,
      updateEditorLock,
      activePaneId: () => activeId,
      renderStatus,
    },
  );
});

window.termina.onAgentStatus(({ terminalId, model, thinkingLevel, usage }) => {
  const pane = panes.get(terminalId);
  if (!pane) return;
  pane.model = model;
  pane.thinkingLevel = thinkingLevel;
  pane.usage = usage;
  if (activeId === terminalId) renderStatus(pane);
});

window.termina.onVerifyState(({ terminalId, verify }) => {
  const pane = panes.get(terminalId);
  if (!pane) return;
  pane.verify = verify;
  // Nudge only for failures the user hasn't seen: a fail/timeout that lands
  // while another pane is in front dots this tab until first view.
  if (verify.state === "fail" || verify.state === "timeout") {
    pane.verifyAttention = activeId !== terminalId;
  } else {
    pane.verifyAttention = false;
  }
  updatePaneTab(pane);
  updateProjectAttention(pane.projectId);
  if (activeId === terminalId) renderStatus(pane);
});

window.termina.onToolTarget((p) => {
  const view = projectViews.get(p.projectId);
  if (!view || view.workspaceId !== p.workspaceId) return;
  if (!prefs.current.autoOpenAgentFiles) return;
  const owner: ProjectWorkspaceRef = { projectId: p.projectId, workspaceId: p.workspaceId };
  // Boot race: before the editor chunk resolves, active-project targets queue
  // exactly like background ones — boot's post-import activation drains them.
  if (activeProjectId !== p.projectId || !editorModule) {
    // Background agent's file: queue it and open on return instead of dropping it.
    const queued = pendingToolTargets.get(p.projectId) ?? [];
    const at = queued.findIndex((t) => t.path === p.path);
    if (at !== -1) queued.splice(at, 1);
    queued.push({ path: p.path, workspaceId: p.workspaceId });
    while (queued.length > MAX_PENDING_TOOL_TARGETS) queued.shift();
    pendingToolTargets.set(p.projectId, queued);
    return;
  }
  void ensureProjectEditor(view).openFile(p.path, { preview: true, owner }).catch((err) => {
    toast(`could not open ${pathBasename(p.path)}: ${(err as Error).message}`, "error");
  });
});

const lastChangePush = new Map<string, { at: number; changedLines?: number[] }>();
/** In-flight large-change fetch epoch per path. A newer onFileChanged
 *  starts another fetch; stale results drop when the epoch no longer matches. */
const largeChangeEpoch = new Map<string, number>();
const MAX_LAST_CHANGE_PUSH = 500;
let changeEpochSeq = 0;
const changeKey = (owner: ProjectWorkspaceRef, path: string): string => `${owner.projectId}\u0000${owner.workspaceId}\u0000${path}`;

function fetchLargeChange(path: string, owner: ProjectWorkspaceRef, editor: EditorManagerInstance): void {
  const key = changeKey(owner, path);
  const at = lastChangePush.get(key)?.at;
  const epoch = ++changeEpochSeq;
  largeChangeEpoch.set(key, epoch);
  void window.termina.openFile(path, owner).then((res) => {
    if (largeChangeEpoch.get(key) !== epoch) return;
    largeChangeEpoch.delete(key);
    const latest = lastChangePush.get(key);
    if (latest !== undefined && latest.at !== at) {
      fetchLargeChange(path, owner, editor);
      return;
    }
    if (res.ok && projectViews.get(owner.projectId)?.editorMgr === editor) {
      editor.updateContent(path, res.content, res.changedLines ?? latest?.changedLines);
    }
  }).catch((err) => {
    if (largeChangeEpoch.get(key) !== epoch) return;
    largeChangeEpoch.delete(key);
    toast(`could not refresh ${pathBasename(path)}: ${(err as Error).message}`, "warning");
  });
}

window.termina.onFileChanged((p) => {
  const view = projectViews.get(p.projectId);
  if (!view || view.workspaceId !== p.workspaceId) return;
  const owner: ProjectWorkspaceRef = { projectId: p.projectId, workspaceId: p.workspaceId };
  const key = changeKey(owner, p.path);
  const at = Date.now();
  lastChangePush.delete(key);
  lastChangePush.set(key, { at, changedLines: p.changedLines });
  while (lastChangePush.size > MAX_LAST_CHANGE_PUSH) {
    const oldestKey = lastChangePush.keys().next().value;
    if (oldestKey === undefined) break;
    lastChangePush.delete(oldestKey);
  }
  activityPane.dropStaleAcceptMarks(p.path);
  if (p.content !== undefined) {
    largeChangeEpoch.delete(key);
    if (view.editorMgr) view.editorMgr.updateContent(p.path, p.content, p.changedLines);
  } else {
    // Main omitted the bytes. A newer change bumps the fetch epoch so a
    // hung read cannot block the next push.
    if (view.editorMgr) fetchLargeChange(p.path, owner, view.editorMgr);
  }
  if (activeProjectId !== p.projectId) return;
  explorer.handleDiskChange(p.path);
  // The open review stays in sync with the agent's writes.
  if (reviewView?.isVisible && reviewView.matchesPath(p.path) && reviewView.matchesOwner(owner)) void reviewView.refreshCurrent(p.content);
});

window.termina.onFileDeleted((p) => {
  const view = projectViews.get(p.projectId);
  if (!view || view.workspaceId !== p.workspaceId) return;
  const owner: ProjectWorkspaceRef = { projectId: p.projectId, workspaceId: p.workspaceId };
  const key = changeKey(owner, p.path);
  lastChangePush.delete(key);
  largeChangeEpoch.delete(key);
  view.editorMgr?.closeIfOpen(p.path);
  activityPane.dropStaleAcceptMarks(p.path);
  if (activeProjectId !== p.projectId) return;
  explorer.handleDiskChange(p.path);
});

/**
 * The explorer marks agent-changed files. Main owns the modified list, so the
 * dot is derived from the same pushes that drive the Modified panel and can
 * never disagree with it. Only panes in the project's primary workspace count:
 * a worldline candidate has its own tree, so its relative paths would mark
 * files the project tree never changed.
 */
function syncExplorerChanged(): void {
  const view = activeProjectId ? projectViews.get(activeProjectId) : undefined;
  if (!view) {
    explorer.setModifiedFiles([]);
    return;
  }
  explorer.setModifiedFiles(projectChangedPaths(panes.values(), activeProjectId, view.workspaceId));
}

window.termina.onFolderOpened((e) => {
  if (!editorModule) {
    // Boot race: the editor chunk hasn't resolved yet, and activation builds
    // the project editor. Defer until it has — the generation guard inside
    // still drops pushes that went stale meanwhile.
    void ensureEditorModule().then(() => applyFolderOpened(e)).catch(() => undefined);
    return;
  }
  applyFolderOpened(e);
});

/** Apply a folder:opened push (activation, view, explorer, worldlines). */
function applyFolderOpened(e: FolderOpenedPayload): void {
  if (
    !Number.isSafeInteger(e.activationGeneration)
    || e.activationGeneration < 1
    || e.activationGeneration < latestProjectActivationGeneration
  ) return;
  latestProjectActivationGeneration = e.activationGeneration;
  projectCwd = e.cwd;
  const projectId = e.projectId;
  let view = projectViews.get(projectId);
  if (!view) {
    view = createProjectView({ id: projectId, cwd: e.cwd, workspaceId: e.workspaceId, needsLogin: e.needsLogin });
  } else {
    view.cwd = e.cwd;
    view.workspaceId = e.workspaceId;
    view.needsLogin = e.needsLogin === true;
    view.editorMgr?.setProjectOpen(true, e.needsLogin);
  }
  baseEditorInstance?.setProjectOpen(true);
  setActiveProject(view.id);
  explorer.setProject(projectId, e.cwd);
  // setProject clears change marks (they are project-relative), and it runs
  // after setActiveProject, so the marks must be re-pushed here.
  syncExplorerChanged();
  reviewView?.resetForProject();
  refreshMine(projectId);
  activateProjectPane();
  timelinePane.resetForProject();
  timelinePane.renderTimeline();
  hydrateWorldlines(projectId);
  scheduleProjectTestCommandRefresh(projectId);
}

window.termina.onLoginHint((e) => {
  for (const view of projectViews.values()) {
    view.needsLogin = e.needsLogin === true;
    view.editorMgr?.setProjectOpen(true, e.needsLogin);
  }
  layout.syncEditorMinimizedForProject();
});

// ---------------------------------------------------------- worldlines ----

window.termina.onWorldlineRunsChanged(({ terminalId }) => {
  const pane = panes.get(terminalId);
  if (!pane) return;
  pane.runs = null;
  loadRuns(pane);
});

// A promotion opens its primary terminal: bring it to the front.
window.termina.onPromotionOpened(({ terminalId }) => {
  activatePaneWhenReady(terminalId);
});

window.termina.onWorldlineUpdate((event) => {
  if (!worldlineEventBelongsToProject(activeProjectId, event)) return;
  const { summary } = event;
  worldlinesView.upsert(summary);
  // Badges: the terminal tab and every editor tab under the candidate root.
  if (summary.terminalId) {
    const pane = panes.get(summary.terminalId);
    if (pane) updatePaneTab(pane);
  }
  activeEditor().refreshBadges();
  updateEditorLock();
});

window.termina.onWorldlineRemoved((event) => {
  applyWorldlineRemoval(activeProjectId, event, panes.values(), worldlineProjectEffects());
});

window.termina.onEvidenceUpdate((event) => {
  if (!worldlineEventBelongsToProject(activeProjectId, event)) return;
  worldlinesView.upsertEvidence(event.summary);
});

window.termina.onInstances((list: InstanceSummary[]) => {
  // Fence a queued roster push for a generation that is already closing.
  // A higher generation is a new life of the same id.
  const incoming = list;
  list = incoming.filter((instance) => {
    const fence = closingPanes.get(instance.id);
    if (!fence) return true;
    if (instance.generation > fence.generation) {
      closingPanes.delete(instance.id);
      return true;
    }
    return false;
  });
  for (const [id] of [...closingPanes]) {
    if (!incoming.some((instance) => instance.id === id)) closingPanes.delete(id);
  }
  const liveIds = new Set(list.map((inst) => inst.id));

  let prunedPane = false;
  for (const [id, pane] of [...panes.entries()]) {
    if (liveIds.has(id) || !pane.fromRoster) continue;
    panes.delete(id);
    prunedPane = true;
    for (const [projId, activeInstId] of lastActivePane) {
      if (activeInstId === id) lastActivePane.delete(projId);
    }
    pane.view.dispose();
    pane.container.remove();
    pane.tabEl.remove();
    if (activeId === id) activeId = null;
  }
  // A pruned pane takes its changed-file contributions with it.
  if (prunedPane) syncExplorerChanged();

  handleWorldlineInstances(list, {
    paneById: (instanceId) => panes.get(instanceId),
    createPane: (instanceId) => createPaneShell(instanceId),
    updatePaneTab,
    setEngine: (pane, engine) => pane.view.setEngine(engine),
    onProjectDiscovered: (pane, summary) => {
      const projectId = pane.projectId;
      if (projectId && !projectViews.has(projectId) && summary.cwd) {
        // The project view is created lazily; projectList resolves it. The next
        // sync retries when this one fails, so the rejection stays silent.
        void window.termina.projectList().then((list) => {
          const project = list.find((p) => p.id === projectId);
          if (project && !projectViews.has(project.id)) createProjectView(project);
        }).catch(() => undefined);
      }
    },
  });
  for (const inst of list) {
    const pane = panes.get(inst.id);
    if (pane) applyTerminalGeneration(pane, inst.generation);
  }
  syncPaneVisibility();
  if (pendingActivateId) {
    const pane = panes.get(pendingActivateId);
    if (pane && !pane.exited && (pane.projectId === activeProjectId || pane.projectId === null)) {
      activatePane(pendingActivateId);
    }
  } else {
    const current = activeId ? panes.get(activeId) : undefined;
    if (!current || current.projectId !== activeProjectId) activateProjectPane();
  }
  const activePane = activeId ? panes.get(activeId) : undefined;
  if (activePane) renderStatus(activePane);
  updateEditorLock();
  // The pane shells, xterm instances, tabs, and project bindings now exist;
  // only this explicit per-terminal handshake opens main's egress gate.
  for (const inst of list) {
    const pane = panes.get(inst.id);
    if (pane) signalTerminalHydrated(pane);
  }
});

// ---------------------------------------------------------------- startup --

function removeSplash(): void {
  document.getElementById("splash")?.remove();
}

// Remove the splash. Do not leave the user on it when the terminal never appears.
setTimeout(removeSplash, 10000);

async function boot(attempt = 0): Promise<void> {
  layout.restore();

  try {
    // Build the project tab bar; the active project owns the initial view.
    const projects = await window.termina.projectList();
    for (const project of projects) {
      if (Number.isSafeInteger(project.activationGeneration)) {
        latestProjectActivationGeneration = Math.max(latestProjectActivationGeneration, project.activationGeneration);
      }
      createProjectView(project);
      if (project.active) activeProjectId = project.id;
    }
    await ensureEditorModule();
    setActiveProject(activeProjectId);
    const bootView = activeProjectId ? projectViews.get(activeProjectId) : undefined;
    if (bootView) {
      projectCwd = bootView.cwd;
      explorer.setProject(bootView.id, bootView.cwd);
    }

    const instances = await window.termina.getInstances();
    // Zero terminals is valid: the user may have closed the project's last
    // tab before quitting. Keep the project UI usable so they can add one.
    for (const inst of instances) {
      if (!panes.has(inst.id)) createPaneShell(inst.id);
      const pane = panes.get(inst.id);
      if (pane) {
        applyTerminalGeneration(pane, inst.generation);
        applyInstanceSummary(pane, inst, { setEngine: (target, engine) => target.view.setEngine(engine) });
        updatePaneTab(pane);
      }
    }
    // Panes are created visible; hide other projects' panes now that
    // every projectId is assigned (setActiveProject ran while empty).
    syncPaneVisibility();
    // setActiveProject ran before the instance list arrived, so the panes had
    // no modified state yet. Recompute now that each pane carries its list.
    syncExplorerChanged();
    activateProjectPane();
    updateEditorLock();
    // Hydrate every pane only after all terminal shells and their project
    // bindings have been constructed for this renderer document.
    for (const inst of instances) {
      const pane = panes.get(inst.id);
      if (pane) signalTerminalHydrated(pane);
    }
    if (instances.length === 0) {
      window.termina.readyTerminal("renderer", 1);
    }
    removeSplash();
    // Keep the project that was active before quit (from projectList.active),
    // not the first instance's project — that second override was the
    // "reopens on second tab" bug.
    const bootProjectId = activeProjectId ?? instances[0]?.projectId;
    if (bootProjectId && projectViews.has(bootProjectId) && bootProjectId !== activeProjectId) {
      setActiveProject(bootProjectId);
      activateProjectPane();
    }
    // Worldlines: rebuild the panel from the live list (push events keep it
    // current after this). Project-tree test detect follows hydration so
    // unlabeled pane clears do not wipe the one cache.
    hydrateWorldlines(activeProjectId);
    scheduleProjectTestCommandRefresh(activeProjectId);
  } catch (err) {
    if (attempt < 2) {
      setTimeout(() => void boot(attempt + 1), 250 * (2 ** attempt));
      return;
    }
    toast(`could not start: ${(err as Error).message}`, "error");
    removeSplash();
  }
}

void boot();
