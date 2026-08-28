/**
 * Renderer entry — terminal-first architecture.
 *
 * Left: multiple terminal panes, each running real pi TUI in a pty.
 * Right: per-project Monaco editor + file explorer, live-synced via the watcher.
 * The bridge extension's sidecar events drive auto-open and the modified list.
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
import { TimelineView } from "./timeline";
import { SessionSearch } from "./session-search";
import { WorldlinesView } from "./worldlines";
import { Explorer } from "./components/explorer";
import { toast } from "./components/modals";
import { showContextMenu, type ContextMenuItem } from "./components/context-menu";
import { SettingsView } from "./settings";
import { emptyShortcuts, isMacPlatform, shortcutForEvent } from "./settings-shortcuts";
import { CommandDispatcher } from "./commands";
import { defaultAppPreferences, pathBasename } from "../shared/types";
import { normalizeAppPreferences } from "../shared/preferences";
import type { AppPreferences, AppUpdateState, CommandId, ModifiedFile, InstanceSummary, VerifyInfo, TimelineEvent, TimelinePrefix, PlanTask, RunSummary } from "../shared/types";

const { EditorManager } = await import("./editor");
const { ReviewView } = await import("./review");

/** One open project tab: its editor view and its tab element. */
interface ProjectView {
  id: string;
  cwd: string;
  tabEl: HTMLElement;
  editorMgr: InstanceType<typeof EditorManager>;
  editorEl: HTMLElement;
  activePaneId: string | null;
}

const projectViews = new Map<string, ProjectView>();
let activeProjectId: string | null = null;
const emptyTemplate = document.getElementById("editor-empty-template") as HTMLTemplateElement;
const rightPaneEl = document.getElementById("right-pane")!;
// The base editor fills the pane before any project tab exists (the
// no-project boot). Project views take over once a folder opens.
const baseEmptyEl = emptyTemplate.content.firstElementChild!.cloneNode(true) as HTMLElement;
rightPaneEl.appendChild(baseEmptyEl);
const baseEditor = new EditorManager(
  document.getElementById("editor-container")!,
  document.getElementById("editor-tabs")!,
  baseEmptyEl,
);
baseEditor.onConflict = (path) => {
  toast(`${pathBasename(path)} changed on disk — you have unsaved edits`, "warning");
};
applySharedEditorHooks(baseEditor);
// The pre-project editor computes relative paths against the opened folder.
baseEditor.projectRootProvider = () => projectCwd;
// The e2e suites drive the active editor through this hook.
(window as unknown as Record<string, unknown>).__editorMgr = baseEditor;
const projectTabsEl = document.getElementById("project-tabs")!;
const btnNewProject = document.getElementById("btn-new-project") as HTMLButtonElement;

function createProjectView(project: { id: string; cwd: string; needsLogin?: boolean }): ProjectView {
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
  editorEl.append(chromeEl, containerEl, emptyEl);
  editorEl.style.display = "none";
  rightPaneEl.insertBefore(editorEl, rightPaneEl.firstElementChild);

  const editorMgr = new EditorManager(containerEl, tabsEl, emptyEl, true, project.needsLogin === true);
  // A disk write reached a model with unsaved edits: never replace silently.
  editorMgr.onConflict = (path) => {
    toast(`${pathBasename(path)} changed on disk — you have unsaved edits`, "warning");
  };
  applySharedEditorHooks(editorMgr);
  // Relative paths must resolve against THIS project, not the active one.
  editorMgr.projectRootProvider = () => project.cwd;
  applyEditorPreferences(editorMgr, preferences);
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
  tabEl.append(nameEl, closeEl);
  tabEl.addEventListener("click", () => void window.pi.projectActivate(project.id));
  closeEl.addEventListener("click", (e) => {
    e.stopPropagation();
    void window.pi.projectClose(project.id).then((res) => {
      if (res.ok) removeProjectView(project.id);
      else if (!res.cancelled) toast(res.error ?? "could not close the project", "warning");
    });
  });
  projectTabsEl.appendChild(tabEl);

  const view: ProjectView = { id: project.id, cwd: project.cwd, tabEl, editorMgr, editorEl, activePaneId: null };
  projectViews.set(project.id, view);
  return view;
}

/** The editor hooks shared by every project view (mine toggle, badges). */
function applySharedEditorHooks(editor: InstanceType<typeof EditorManager>): void {
  editor.onToggleMine = (path) => {
    const mine = !editor.isMine(path);
    editor.setMine(path, mine);
    void window.pi.setMineFile(path, mine).catch(() => {
      editor.setMine(path, !mine); // the main side failed: revert the mark
    });
  };
  editor.tabBadge = (path) => worldlinesView.labelOfPath(path);
  editor.onFileOpened = () => revealEditor();
  editor.onBecameEmpty = () => collapseEditorIfIdle();
}

/** Remove a closed project's tab, editor view, and panes. */
function removeProjectView(projectId: string): void {
  const view = projectViews.get(projectId);
  if (!view) return;
  const editorToggle = document.getElementById("btn-min-editor");
  if (editorToggle && view.editorEl.contains(editorToggle)) placeEditorToggle(null);
  view.editorMgr.dispose();
  view.tabEl.remove();
  view.editorEl.remove();
  projectViews.delete(projectId);
  lastActivePane.delete(projectId);
  if (activeProjectId === projectId) {
    activeProjectId = null;
    const next = projectViews.keys().next().value;
    setActiveProject(next ?? null);
  }
  for (const pane of [...panes.values()]) {
    if (pane.projectId === projectId) void closePane(pane.instanceId);
  }
}

/** The active project's editor manager (the tab in front). */
function activeEditor(): InstanceType<typeof EditorManager> {
  const view = activeProjectId ? projectViews.get(activeProjectId) : null;
  // Never open files in a hidden project editor. The first map entry can
  // be display:none while the base pane is what the user sees.
  const editor = view?.editorMgr ?? baseEditor;
  (window as unknown as Record<string, unknown>).__editorMgr = editor;
  return editor;
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
  const baseChrome = document.getElementById("editor-chrome")!;
  const baseContainer = document.getElementById("editor-container")!;
  const noProject = !view;
  baseChrome.style.display = noProject ? "" : "none";
  baseContainer.style.display = noProject ? "" : "none";
  // The base overlay sits on #right-pane. Hide it while a project view is shown.
  if (!noProject) {
    baseEditor.setProjectOpen(true);
    baseEmptyEl.hidden = true;
  } else {
    baseEditor.setProjectOpen(false);
  }
  for (const item of projectViews.values()) {
    const active = item.id === activeProjectId;
    item.tabEl.classList.toggle("active", active);
    item.editorEl.style.display = active ? "" : "none";
  }
  placeEditorToggle(activeProjectId);
  syncPaneVisibility();
  collapseEditorIfIdle();
  fitPanes();
}

/** Show only the active project's terminals. Other project panes stay alive. */
function syncPaneVisibility(): void {
  for (const pane of panes.values()) {
    const on = pane.projectId === activeProjectId;
    pane.tabEl.style.display = on ? "" : "none";
    pane.container.style.display = on ? "" : "none";
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

const reviewView = new ReviewView();

void reviewView;
reviewView.bind({
  onOpenFile: (path) => {
    reviewView.hide();
    void openFileSmart(path, false);
  },
  onAccepted: (path) => {
    const pane = activeId ? panes.get(activeId) : undefined;
    if (!pane) return;
    pane.accepted.add(path);
    pane.reverted.delete(path);
    renderModified(pane);
    renderHandoff(pane);
  },
  onReverted: (path) => {
    const pane = activeId ? panes.get(activeId) : undefined;
    if (!pane) return;
    pane.reverted.add(path);
    pane.accepted.delete(path);
    renderModified(pane);
  },
  onHidden: () => collapseEditorIfIdle(),
  onShown: () => revealEditor(),
});
const explorer = new Explorer(document.getElementById("explorer")!);
const sessionSearch = new SessionSearch();
sessionSearch.bind({ onOpenFile: (path) => void openFileSmart(path, true) });
(window as unknown as Record<string, unknown>).__sessionSearch = sessionSearch;

// ---- Mine (file ownership) ----
function refreshMine(): void {
  activeEditor().clearMine();
  void window.pi.getMineFiles().then((paths) => {
    for (const p of paths) activeEditor().setMine(p, true);
  }).catch((err) => toast(`could not load mine marks: ${(err as Error).message}`, "error"));
}
void refreshMine();
const explorerEl = document.getElementById("explorer")!;
explorer.bind({ onOpenFile: (path, preview) => void openFileSmart(path, preview ?? true) });

const leftPane = document.getElementById("left-pane")!;
const termTabsList = document.getElementById("terminal-tabs-list")!;
const termContainer = document.getElementById("terminal-container")!;
const btnNewTerminal = document.getElementById("btn-new-terminal") as HTMLButtonElement;
const btnVerify = document.getElementById("btn-verify") as HTMLButtonElement;
const verifyBadge = document.getElementById("verify-badge")!;
const statusCwd = document.getElementById("status-cwd")!;
const statusState = document.getElementById("status-state")!;
const btnAppUpdate = document.getElementById("btn-app-update") as HTMLButtonElement;
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
const timelineView = new TimelineView(document.getElementById("timeline-strip")!);
(window as unknown as Record<string, unknown>).__timelineView = timelineView;
const worldlinesView = new WorldlinesView(document.getElementById("worldline-panel")!);
worldlinesView.bind({
  onCompareBase: (comparisonId, label, relPath, absPath) => {
    void reviewView.showCandidateDiff(comparisonId, label, relPath, absPath);
  },
  onCompareAB: (comparisonId, relPath) => {
    void reviewView.showABDiff(comparisonId, relPath, worldlinesView.rootOf(comparisonId, "A"));
  },
  onOpenFile: (absPath) => void openFileSmart(absPath, false),
  onOpenTerminal: (terminalId) => activatePaneWhenReady(terminalId),
  isLiveTerminal: (terminalId) => {
    const pane = panes.get(terminalId);
    return !!pane && !pane.error && !pane.exited;
  },
});
const btnForkRun = document.getElementById("btn-fork-run") as HTMLButtonElement;

// ---------------------------------------------------------------- panes -----

interface Pane {
  instanceId: string;
  workspaceId: string;
  projectId: string | null;
  view: PtyView;
  container: HTMLElement;
  tabEl: HTMLElement;
  nameEl: HTMLElement;
  statusEl: HTMLElement;
  cwd: string | null;
  busy: boolean;
  type: "agent" | "shell";
  engine?: "pi" | "core";
  shellName: string | undefined;
  error: boolean;
  /** True after pty:exit. The pane remains until the user closes the tab. */
  exited: boolean;
  modified: ModifiedFile[];
  accepted: Set<string>;
  reverted: Set<string>;
  verify: VerifyInfo;
  timeline: TimelineEvent[];
  timelineLoaded: boolean;
  timelinePrefix: Pick<TimelinePrefix, "ok" | "error" | "open"> | null;
  recorderState: string;
  plan: PlanTask[];
  planLoaded: boolean;
  /** Bumped on every plan:update push (fetch race guard). */
  planVersion: number;
  dispatchWorker: boolean;
  dispatchTask: string | undefined;
  /** The recorded runs of this terminal (Fork Run button). */
  runs: RunSummary[] | null;
  /** The candidate-local test command label, when this is a candidate. */
  testCommand: string | null;
}

const panes = new Map<string, Pane>();
/** Last active terminal per project. Returning to a project restores it. */
const lastActivePane = new Map<string, string>();
(window as unknown as Record<string, unknown>).__panes = panes;
const closingPanes = new Set<string>();
let activeId: string | null = null;
let projectCwd: string | null = null;
let preferences: AppPreferences = normalizeAppPreferences(await window.pi.getPreferences().catch(() => defaultAppPreferences()));
let committedPreferences: AppPreferences = preferences;
let preferenceGeneration = 0;

function userPatch(prev: AppPreferences, next: AppPreferences): import("../shared/types").UserPreferencePatch {
  const patch: import("../shared/types").UserPreferencePatch = {};
  if (prev.theme !== next.theme) patch.theme = next.theme;
  if (prev.editorFontSize !== next.editorFontSize) patch.editorFontSize = next.editorFontSize;
  if (prev.terminalFontSize !== next.terminalFontSize) patch.terminalFontSize = next.terminalFontSize;
  if (prev.fontFamily !== next.fontFamily) patch.fontFamily = next.fontFamily;
  if (prev.wordWrap !== next.wordWrap) patch.wordWrap = next.wordWrap;
  if (prev.minimap !== next.minimap) patch.minimap = next.minimap;
  if (JSON.stringify(prev.shortcuts) !== JSON.stringify(next.shortcuts)) patch.shortcuts = next.shortcuts;
  if (prev.showThinking !== next.showThinking) patch.showThinking = next.showThinking;
  return patch;
}

function paintPreferences(prefs: AppPreferences): void {
  document.documentElement.dataset.theme = prefs.theme;
  applyEditorPreferences(baseEditor, prefs);
  for (const view of projectViews.values()) applyEditorPreferences(view.editorMgr, prefs);
  reviewView.setTheme(prefs.theme);
  reviewView.setFontSize(prefs.editorFontSize);
  reviewView.setFontFamily(prefs.fontFamily);
  reviewView.setWordWrap(prefs.wordWrap);
  for (const pane of panes.values()) applyTerminalPreferences(pane.view, prefs);
}

function applyPreferences(next: AppPreferences, persist: boolean, activateShortcuts: boolean): void {
  const generation = ++preferenceGeneration;
  const preview = normalizeAppPreferences(next);
  preferences = preview;
  paintPreferences(preferences);
  if (persist) {
    const patch = userPatch(committedPreferences, preview);
    if (Object.keys(patch).length > 0) {
      void window.pi.updatePreferences({ patch, activateShortcuts }).then((saved) => {
        const normalized = normalizeAppPreferences(saved);
        committedPreferences = normalized;
        if (generation !== preferenceGeneration) return;
        preferences = normalized;
        paintPreferences(preferences);
      }).catch(() => {
        if (generation !== preferenceGeneration) return;
        preferences = committedPreferences;
        paintPreferences(preferences);
        toast("Could not save settings", "error");
      });
    } else if (activateShortcuts) {
      void window.pi.setKeyboardShortcuts(committedPreferences.shortcuts).catch(() => undefined);
    }
  } else {
    committedPreferences = preview;
    if (activateShortcuts) {
      void window.pi.setKeyboardShortcuts(preferences.shortcuts).catch(() => undefined);
    }
  }
}

function applyEditorPreferences(editor: InstanceType<typeof EditorManager>, prefs: AppPreferences): void {
  editor.setTheme(prefs.theme);
  editor.setFontSize(prefs.editorFontSize);
  editor.setFontFamily(prefs.fontFamily);
  editor.setWordWrap(prefs.wordWrap);
  editor.setMinimap(prefs.minimap);
}

function applyTerminalPreferences(view: PtyView, prefs: AppPreferences): void {
  view.setTheme(prefs.theme);
  view.setFontSize(prefs.terminalFontSize);
  view.setFontFamily(prefs.fontFamily);
}

const settingsView = new SettingsView({
  onChange: (next) => applyPreferences(next, true, false),
  onOpen: () => void window.pi.setKeyboardShortcuts(emptyShortcuts()),
  onClose: (next) => applyPreferences(next, true, true),
});

applyPreferences(preferences, false, true);
// The e2e suite opens settings through this hook (the menu owns the
// visible entry).
(window as unknown as Record<string, unknown>).__openSettings = () => settingsView.open(preferences);

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
    (data) => void window.pi.writeTerminal(instanceId, data),
    (cols, rows) => void window.pi.resizeTerminal(instanceId, cols, rows),
    (text) => void window.pi.writeClipboard(text).catch(() => undefined),
    () => window.pi.pasteTerminal(instanceId),
    (message) => toast(message, "error"),
    (files) => window.pi.dropTerminalFiles(instanceId, files),
    {
      theme: preferences.theme,
      fontSize: preferences.terminalFontSize,
      fontFamily: preferences.fontFamily,
    },
  );

  const pane: Pane = {
    instanceId,
    workspaceId: "",
    projectId: null,
    view,
    container,
    tabEl,
    nameEl,
    statusEl,
    cwd: null,
    busy: false,
    type: "agent",
    shellName: undefined,
    error: false,
    exited: false,
    modified: [],
    accepted: new Set(),
    reverted: new Set(),
    verify: { state: "untested", command: null, summary: null },
    timeline: [],
    timelineLoaded: false,
    timelinePrefix: null,
    recorderState: "paused",
    plan: [],
    planLoaded: false,
    planVersion: 0,
    dispatchWorker: false,
    dispatchTask: undefined,
    runs: null,
    testCommand: null,
  };
  panes.set(instanceId, pane);
  pane.tabEl.prepend(typeEl);
  container.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const items: ContextMenuItem[] = [
      { label: "Copy", action: () => { view.copySelection(); } },
      { label: "Paste", action: () => { void view.pasteClipboard(); } },
    ];
    if (pane.engine === "core") {
      items.push({ separator: true });
      items.push({
        label: committedPreferences.showThinking ? "Hide Thinking" : "Show Thinking",
        action: () => commands.execute("toggle-thinking"),
      });
    }
    showContextMenu(items, event.clientX, event.clientY);
  });
  return pane;
}

/** A terminal tab that shows a message instead of a live pty (pi missing). */
let errorSeq = 0;
function createErrorPane(message: string): void {
  const id = `term-error-${++errorSeq}`;
  const pane = createPaneShell(id);
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

/** Focus a terminal once its pane exists (Open / Promote can race instances). */
let pendingActivateId: string | null = null;
function activatePaneWhenReady(instanceId: string): void {
  pendingActivateId = instanceId;
  const pane = panes.get(instanceId);
  if (pane && !pane.exited) activatePane(instanceId);
}

function activatePane(instanceId: string): void {
  const pane = panes.get(instanceId);
  if (!pane) return;
  removeSplash();
  activeId = instanceId;
  if (pane.projectId) lastActivePane.set(pane.projectId, instanceId);
  for (const p of panes.values()) {
    const on = p.instanceId === instanceId;
    p.container.classList.toggle("active", on);
    p.tabEl.classList.toggle("active", on);
    if (on) p.container.style.display = "";
  }
  if (pendingActivateId === instanceId) pendingActivateId = null;
  pane.view.fit();
  pane.view.focus();
  renderChrome();
  renderTimeline();
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
  void window.pi.getRuns(pane.instanceId).then((runs) => {
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
    return;
  }
  btnForkRun.hidden = false;
  btnForkRun.disabled = !run.replayable;
  btnForkRun.title = run.replayable
    ? `Fork ${run.id} into candidates A (settled) and B (start) — ${run.promptText ?? ""}`.slice(0, 140)
    : `Fork Run unavailable: ${run.reason ?? "the run is not replayable"}`;
}

btnForkRun.addEventListener("click", () => {
  const pane = activeId ? panes.get(activeId) : undefined;
  const run = pane ? lastCompletedRun(pane) : null;
  if (!run) return;
  if (!run.replayable) {
    toast(`Fork Run unavailable: ${run.reason ?? "the run is not replayable"}`, "warning");
    return;
  }
  void window.pi.forkRun(run.id).then((res) => {
    if (!res.ok) toast(`Fork Run failed: ${res.error ?? "unknown error"}`, "warning");
    else toast(`forked ${run.id} — candidates ${res.comparisonId ?? ""} are starting`, "info");
  });
});

/** Candidate terminals detect tests from their own isolated tree. */
function refreshCandidateTestCommand(pane: Pane): void {
  if (!worldlinesView.labelOfTerminal(pane.instanceId)) return;
  void window.pi.detectTest(pane.instanceId).then((t) => {
    const p = panes.get(pane.instanceId);
    if (!p) return;
    p.testCommand = t?.label ?? null;
    if (activeId === pane.instanceId) renderStatus(p);
  }).catch((err) => toast(`could not detect tests: ${(err as Error).message}`, "error"));
}

/** Session Timeline: show the active pane's points, fetch once per pane. */
function renderTimeline(): void {
  const pane = activeId ? panes.get(activeId) : undefined;
  if (!pane) {
    timelineView.setEvents([]);
    return;
  }
  timelineView.setRecorder(pane.recorderState as Parameters<typeof timelineView.setRecorder>[0]);
  timelineView.setPrefix(pane.timelinePrefix);
  if (!pane.timelineLoaded) {
    const id = pane.instanceId;
    pane.timelineLoaded = true;
    void window.pi.getTimeline(id).then((events) => {
      const p = panes.get(id);
      if (!p) return;
      const maxSeq = events.length ? Math.max(...events.map((e) => e.seq)) : 0;
      p.timeline = events.concat(p.timeline.filter((e) => e.seq > maxSeq)).slice(-MAX_TIMELINE_EVENTS);
      if (activeId === id) timelineView.setEvents(p.timeline);
    }).catch((err) => {
      const p = panes.get(id);
      if (p) p.timelineLoaded = false;
      toast(`could not load timeline: ${(err as Error).message}`, "error");
    });
    void window.pi.getTimelinePrefix(id).then((prefix) => {
      const p = panes.get(id);
      if (!p) return;
      p.timelinePrefix = prefix;
      if (activeId === id) timelineView.setPrefix(prefix);
    }).catch((err) => toast(`could not load timeline counts: ${(err as Error).message}`, "error"));
    return;
  }
  timelineView.setEvents(pane.timeline);
}

timelineView.bind({
  onJump: async (ev, opts) => {
    const pane = activeId ? panes.get(activeId) : undefined;
    if (!pane) return;
    // Snapshots are fetched on demand — the strip/IPC never carries content.
    let res = await window.pi.getTimelineContent(pane.instanceId, ev.seq);
    // A write snapshot may still be filling in (the delayed fill takes
    // 400 milliseconds) — retry
    // briefly before giving up.
    for (let i = 0; i < 5 && !res.ok; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      res = await window.pi.getTimelineContent(pane.instanceId, ev.seq);
    }
    if (!res.ok) {
      const what = ev.t === "change" ? "change" : ev.toolName ?? "event";
      toast(`${what} ${res.relPath ?? ev.relPath ?? ""} — no snapshot for this moment`, "info");
      return;
    }
    const label = `${new Date(res.ts ?? ev.ts).toLocaleTimeString()} · ${res.toolName ?? ev.toolName ?? "on disk"}`;
    activeEditor().openSnapshot(pane.instanceId, String(ev.seq), res.relPath ?? res.path ?? "", res.content ?? "", label, opts?.replay ?? false);
  },
  onFork: (ev) => {
    const pane = activeId ? panes.get(activeId) : undefined;
    if (!pane) return;
    if (!ev.stateId) {
      toast("this moment is not forkable yet", "warning");
      return;
    }
    void window.pi.forkPoint(pane.instanceId, ev.seq).then((res) => {
      if (!res.ok) toast(`fork at this moment failed: ${res.error ?? "unknown error"}`, "warning");
      else toast(`forked this moment — candidate ${res.comparisonId ?? ""} is starting`, "info");
    });
  },
  onProgress: (seq) => {
    const pane = activeId ? panes.get(activeId) : undefined;
    if (!pane) return Promise.resolve({ ok: false, seq });
    return window.pi.getTimelineProgress(pane.instanceId, seq);
  },
});

async function closePane(instanceId: string): Promise<void> {
  const pane = panes.get(instanceId);
  if (!pane) return;
  closingPanes.add(instanceId);
  panes.delete(instanceId);
  for (const [projectId, activeInstanceId] of lastActivePane) {
    if (activeInstanceId === instanceId) lastActivePane.delete(projectId);
  }
  pane.view.dispose();
  pane.container.remove();
  pane.tabEl.remove();
  await window.pi.closeTerminal(instanceId);
  setTimeout(() => closingPanes.delete(instanceId), 3000);
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
          : pane.engine === "core"
            ? " · core agent"
            : " · pi agent"
      }`;
  pane.statusEl.classList.toggle("busy", pane.busy);
  applyTypeBadge(pane);
  // Worldline candidates carry the A/B badge on their tab.
  const label = worldlinesView.labelOfTerminal(pane.instanceId);
  const wlineEl = pane.tabEl.querySelector(".tab-worldline") as HTMLElement;
  if (wlineEl) {
    wlineEl.textContent = label ?? "";
    wlineEl.style.display = label ? "" : "none";
    wlineEl.title = label ? `worldline candidate ${label}` : "";
    wlineEl.classList.toggle("a", label === "A");
    wlineEl.classList.toggle("b", label === "B");
  }
}

function renderChrome(): void {
  const pane = activeId ? panes.get(activeId) : undefined;
  if (!pane) {
    statusState.textContent = "no terminal";
    statusCwd.textContent = "";
    btnVerify.disabled = true;
    verifyBadge.textContent = "";
    verifyBadge.hidden = true;
    planList.replaceChildren();
    planPanel.classList.add("collapsed");
    modifiedList.replaceChildren();
    btnCopySubject.hidden = true;
    btnOpenShell.hidden = true;
    return;
  }
  renderStatus(pane);
  renderPlan(pane);
  renderModified(pane);
}

/** Status bar and Verify only. Busy ticks must not rebuild the plan or modified lists. */
function renderStatus(pane: Pane): void {
  statusState.textContent = pane.busy ? "● agent working" : "idle";
  statusState.classList.toggle("busy", pane.busy);
  statusCwd.textContent = pane.cwd ?? "";
  renderVerify(pane);
  renderHandoff(pane);
}

/** Plan Board: the current run's tasks with live progress. */
function renderPlan(pane: Pane): void {
  if (!pane.planLoaded) {
    pane.planLoaded = true;
    const versionAtStart = pane.planVersion;
    void window.pi.getPlan(pane.instanceId).then((tasks) => {
      const p = panes.get(pane.instanceId);
      if (!p) return;
      if (p.planVersion !== versionAtStart) return; // a push won the race
      p.plan = tasks;
      if (activeId === pane.instanceId) renderPlan(p);
    });
  }
  planCount.textContent = pane.plan.length ? `(${pane.plan.length})` : "";
  planList.replaceChildren();
  for (const task of pane.plan) {
    const li = document.createElement("li");
    li.className = `plan-task state-${task.state}`;
    const mark = document.createElement("span");
    mark.className = "plan-mark";
    mark.textContent = task.state === "done" ? "✓" : task.state === "active" ? "◐" : "○";
    const text = document.createElement("span");
    text.className = "plan-text";
    text.textContent = task.text;
    li.append(mark, text);
    if (task.workerId || (task.claimed && task.claimed.length > 0)) {
      const meta = document.createElement("span");
      meta.className = "plan-meta";
      const claim = (task.claimed ?? task.paths).join(", ");
      const status = task.state === "done" ? "settled" : task.workerId ?? "dispatch";
      meta.textContent = claim ? `${status} · ${claim}` : status;
      li.appendChild(meta);
    }
    if (task.state !== "done") {
      li.classList.add("dispatchable");
      li.title = task.workerId ? "show dispatch worker" : "dispatch this task";
      li.addEventListener("click", (e) => {
        e.stopPropagation();
        if (task.workerId) {
          activatePane(task.workerId);
          return;
        }
        void window.pi.dispatchRun(pane.instanceId, task.text).then((res) => {
          if (!res.ok) toast(res.error ?? "dispatch failed", "warning");
          else toast("dispatched 1 task to a parallel agent", "info");
        });
      });
    }
    planList.appendChild(li);
  }
  planPanel.classList.toggle("collapsed", pane.plan.length === 0);
  // Dispatch is possible when the plan has tasks. The button label shows
  // whether a dispatch is running (main re-sends the plan on settle).
  btnDispatch.hidden = pane.plan.length === 0;
}

/** Verify & Iterate: badge + button for the active terminal. */
let testCommand: string | null = null;

async function refreshTestCommand(): Promise<void> {
  try {
    const t = await window.pi.detectTest();
    testCommand = t?.label ?? null;
  } catch {
    testCommand = null;
  }
  const pane = activeId ? panes.get(activeId) : undefined;
  if (pane) renderStatus(pane);
}

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
  const command = pane.testCommand ?? testCommand;
  btnVerify.disabled = v.state === "running" || !command;
  btnVerify.title = command ? `Run ${command}` : "No test command detected (package.json, pytest, cargo, go)";
  if (v.state === "untested") {
    verifyBadge.textContent = "";
    verifyBadge.hidden = true;
    return;
  }
  verifyBadge.hidden = false;
  verifyBadge.className = `verify-badge state-${v.state}`;
  verifyBadge.replaceChildren();
  if (v.state === "running") {
    // Loader: a spinner and a label show that the run is running.
    const spin = document.createElement("span");
    spin.className = "verify-spinner";
    verifyBadge.appendChild(spin);
    verifyBadge.appendChild(document.createTextNode(` verifying · ${v.command ?? ""}`));
  } else {
    verifyBadge.textContent =
      v.state === "pass" ? `✓ ${v.summary ?? "green"}` : v.state === "timeout" ? `⏰ ${v.summary ?? "timed out"}` : v.state === "cancelled" ? `⏸ ${v.summary ?? "cancelled"}` : `✗ ${v.summary ?? "failing"}`;
  }
  verifyBadge.title =
    v.state === "running" ? "Click to cancel verification" : v.state === "fail" && v.summary ? v.summary : v.command ?? "";
}

function renderModified(pane: Pane): void {
  modifiedCount.textContent = pane.modified.length ? `(${pane.modified.length})` : "";
  modifiedList.replaceChildren();
  for (const f of pane.modified) {
    const li = document.createElement("li");
    const badge = document.createElement("span");
    badge.className = `status-badge ${f.status}`;
    badge.textContent = f.status === "created" ? "A" : f.status === "deleted" ? "D" : "M";
    const path = document.createElement("span");
    path.className = "path";
    path.textContent = f.relPath;
    path.title = f.path;
    li.append(badge, path);
    li.addEventListener("click", () => {
      // The modified list is the review surface: clicking opens the diff.
      void reviewView.show(activeId ?? "", f.path, f.relPath);
    });
    if (pane.accepted.has(f.path)) {
      const mark = document.createElement("span");
      mark.className = "review-mark accepted";
      mark.textContent = "✓";
      li.appendChild(mark);
    } else if (pane.reverted.has(f.path)) {
      const mark = document.createElement("span");
      mark.className = "review-mark reverted";
      mark.textContent = "↩";
      li.appendChild(mark);
    }
    modifiedList.appendChild(li);
  }
  modifiedPanel.classList.toggle("collapsed", pane.modified.length === 0);
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
  if (!pane.runs) pane.runs = await window.pi.getRuns(pane.instanceId);
  const subject = commitSubjectFromPrompt(lastCompletedRun(pane)?.promptText);
  const res = await window.pi.writeClipboard(subject);
  if (res.ok) toast("Copied commit subject — Termina does not write Git", "info");
  else toast(res.error ?? "could not copy", "warning");
}

async function focusProjectShell(): Promise<void> {
  const pane = activeId ? panes.get(activeId) : undefined;
  const projectId = pane?.projectId ?? activeProjectId;
  revealTerminal();
  const existing = [...panes.values()].find((p) => p.projectId === projectId && p.type === "shell" && !p.error);
  if (existing) {
    activatePane(existing.instanceId);
    return;
  }
  const res = await window.pi.createTerminal({ type: "shell" });
  if (!res.ok) toast(res.error ?? "could not open a shell", "warning");
  else if (res.id && panes.has(res.id)) activatePane(res.id);
}

// ---------------------------------------------------------------- commands --

async function openFileSmart(path: string, preview = true): Promise<void> {
  if (reviewView.isVisible) reviewView.hide();
  if (!activeProjectId && projectCwd) {
    const match = [...projectViews.values()].find((view) => view.cwd === projectCwd);
    if (match) setActiveProject(match.id);
  }
  const abs = path.startsWith("/") ? path : projectCwd ? `${projectCwd}/${path}` : path;
  try {
    await activeEditor().openFile(abs, { preview });
  } catch (err) {
    toast(`could not open ${pathBasename(abs)}: ${(err as Error).message}`, "error");
  }
}

// ---------------------------------------------------------------- panels ----

// Terminal-type chooser: ＋ opens a menu (agent vs shells).
let terminalMenu: HTMLElement | null = null;
let terminalMenuCleanups: Array<() => void> = [];
let shellsCache: { name: string; path: string }[] | null = null;
let shellsPromise: Promise<{ name: string; path: string }[]> | null = null;

async function getAvailableShells(): Promise<{ name: string; path: string }[]> {
  if (shellsCache) return shellsCache;
  if (!shellsPromise) {
    shellsPromise = window.pi.getShells().catch(() => []);
  }
  shellsCache = await shellsPromise;
  return shellsCache;
}

async function openTerminalMenu(): Promise<void> {
  if (terminalMenu) {
    closeTerminalMenu();
    return;
  }
  const shells = await getAvailableShells();
  if (terminalMenu) {
    closeTerminalMenu();
    return;
  }
  const menu = document.createElement("div");
  menu.className = "terminal-menu";
  menu.tabIndex = -1;
  menu.addEventListener("click", (e) => e.stopPropagation());

  const items: Array<{ row: HTMLElement; run: () => void }> = [];
  let selectedIndex = 0;

  const updateSelection = (index: number): void => {
    if (items.length === 0) return;
    selectedIndex = (index + items.length) % items.length;
    for (let i = 0; i < items.length; i++) {
      items[i].row.classList.toggle("selected", i === selectedIndex);
    }
    items[selectedIndex]?.row.scrollIntoView({ block: "nearest" });
  };

  const makeTerminal = (opts?: { type?: "agent" | "shell"; shell?: string; engine?: "pi" | "core" }) => {
    const source = activeId ? panes.get(activeId) : undefined;
    const fromTerminalId = source && !source.error && !source.exited ? source.instanceId : undefined;
    const inherit = Boolean(fromTerminalId) && opts?.type !== "shell";
    void window.pi.createTerminal(inherit ? { ...opts, fromTerminalId } : opts).then((res) => {
      if (!res.ok) {
        createErrorPane(res.error ?? "could not create terminal");
        return;
      }
      if (res.id && panes.has(res.id)) activatePane(res.id);
    });
  };

  const addItem = (label: string, desc: string, run: () => void) => {
    const row = document.createElement("div");
    row.className = "terminal-menu-item";
    const name = document.createElement("span");
    name.className = "terminal-menu-name";
    name.textContent = label;
    const d = document.createElement("span");
    d.className = "terminal-menu-desc";
    d.textContent = desc;
    row.append(name, d);
    const itemIndex = items.length;
    row.addEventListener("mouseenter", () => updateSelection(itemIndex));
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTerminalMenu();
      run();
    });
    menu.appendChild(row);
    items.push({ row, run });
  };

  addItem("Agent (core)", "Termina's in-house coding agent", () => makeTerminal({ type: "agent" }));
  addItem("Agent (pi)", "the pi coding agent terminal", () => makeTerminal({ type: "agent", engine: "pi" }));
  for (const shell of shells) {
    addItem(shell.name, `interactive ${shell.name} shell`, () => makeTerminal({ type: "shell", shell: shell.path }));
  }

  updateSelection(0);

  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      updateSelection(selectedIndex + 1);
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      updateSelection(selectedIndex - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      e.stopPropagation();
      updateSelection(0);
    } else if (e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      updateSelection(items.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      const chosen = items[selectedIndex];
      closeTerminalMenu();
      chosen?.run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeTerminalMenu();
    }
  };

  window.addEventListener("keydown", onKeydown, true);
  terminalMenuCleanups.push(() => {
    window.removeEventListener("keydown", onKeydown, true);
  });

  document.body.appendChild(menu);
  const rect = btnNewTerminal.getBoundingClientRect();
  const pad = 8;
  const left = Math.max(pad, Math.min(rect.left, window.innerWidth - 240 - pad));
  const top = Math.max(pad, Math.min(rect.bottom + 6, window.innerHeight - 100));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  terminalMenu = menu;
  menu.focus();
}

function closeTerminalMenu(): void {
  for (const cleanup of terminalMenuCleanups) cleanup();
  terminalMenuCleanups = [];
  const menu = terminalMenu;
  terminalMenu?.remove();
  terminalMenu = null;
  // Focus returns to the terminal only when a menu was open. Every window
  // click routes here; stealing focus on each one breaks editor typing.
  if (menu && activeId && panes.has(activeId)) {
    panes.get(activeId)?.view.focus();
  }
}

btnNewTerminal.addEventListener("click", (e) => {
  e.stopPropagation();
  if (terminalMenu) closeTerminalMenu();
  else void openTerminalMenu();
});
window.pi.onProjectClosed(({ projectId }) => {
  removeProjectView(projectId);
  if (projectViews.size === 0) {
    projectCwd = null;
    explorer.setProject(null);
    baseEditor.setProjectOpen(false);
  }
});
btnNewProject.addEventListener("click", () => void window.pi.projectOpen());
document.getElementById("right-pane")!.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.closest(".empty-open-folder")) return;
  void window.pi.projectOpen();
});
// Double-click on the empty bar area opens a new project tab.
projectTabsEl.addEventListener("dblclick", (e) => {
  if ((e.target as HTMLElement).closest(".project-tab, #btn-new-project")) return;
  void window.pi.projectOpen();
});

window.addEventListener("click", () => closeTerminalMenu());
window.addEventListener("blur", () => closeTerminalMenu());
btnCopySubject.addEventListener("click", () => void copyCommitSubject());
btnOpenShell.addEventListener("click", () => void focusProjectShell());
btnVerify.addEventListener("click", () => {
  const id = activeId;
  if (!id) return;
  void window.pi.runVerify(id).then((res) => {
    if (!res.ok) toast(res.error ?? "verify failed to start", "warning");
  });
});
verifyBadge.addEventListener("click", () => {
  const pane = activeId ? panes.get(activeId) : undefined;
  if (!pane) return;
  if (pane.verify.state === "running") {
    void window.pi.cancelVerify(pane.instanceId).then((res) => {
      if (!res.ok) toast(res.error ?? "verify could not be cancelled", "warning");
    });
    return;
  }
  toast(pane.verify.summary ?? "", "info");
});
btnClearModified.addEventListener("click", (e) => {
  e.stopPropagation();
  const pane = activeId ? panes.get(activeId) : undefined;
  if (!pane) return;
  // Main owns the list: clear it there or the next push resurrects it.
  void window.pi.clearModified(pane.instanceId).then((res) => {
    if (!res.ok) toast(res.error ?? "could not clear the list", "warning");
  });
});
btnAcceptAll.addEventListener("click", (e) => {
  e.stopPropagation();
  const pane = activeId ? panes.get(activeId) : undefined;
  if (!pane || pane.modified.length === 0) return;
  // Accept every file: the list becomes the approved changes for a commit.
  for (const f of pane.modified) {
    pane.accepted.add(f.path);
    pane.reverted.delete(f.path);
  }
  renderModified(pane);
  renderHandoff(pane);
  toast(`${pane.modified.length} file(s) accepted — Termina does not write Git`, "info");
});
modifiedPanel.querySelector(".panel-header")?.addEventListener("click", () => {
  modifiedPanel.classList.toggle("collapsed");
});
planPanel.querySelector(".panel-header")?.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("#btn-dispatch")) return;
  planPanel.classList.toggle("collapsed");
});
btnDispatch.addEventListener("click", () => {
  const id = activeId;
  if (!id) return;
  void window.pi.dispatchRun(id).then((res) => {
    if (!res.ok) toast(res.error ?? "dispatch failed", "warning");
    else toast(`dispatched ${res.dispatched ?? 0} task(s) to parallel agents`, "info");
  });
});

// ---------------------------------------------------------------- layout ---

type Layout = "terminal-left" | "terminal-right" | "terminal-top" | "terminal-bottom" | "terminal-fullscreen";
type WorkPane = "terminal" | "editor";
const SPLIT_LAYOUTS = ["terminal-left", "terminal-right", "terminal-top", "terminal-bottom"] as const;
const DEFAULT_LAYOUT: Layout = "terminal-left";
const LAYOUT_KEY = "termina.layout";
const EXPLORER_KEY = "termina.explorer";
const MODIFIED_KEY = "termina.modified";
const MODIFIED_HEIGHT_KEY = "termina.modifiedHeight";
const WORKPANE_KEY = "termina.workpane";
const PANE_MIN_ICON = "–";
const PANE_MAX_ICON = "□";
const MAX_TIMELINE_EVENTS = 400;

const splitEl = document.getElementById("main-split")!;
const modifiedPanelEl = document.getElementById("modified-panel")!;
const explorerDividerEl = document.getElementById("explorer-divider")!;
const modifiedResizeEl = document.getElementById("modified-resize")!;
const btnMinExplorer = document.getElementById("btn-min-explorer") as HTMLButtonElement;
const btnMinTerminal = document.getElementById("btn-min-terminal") as HTMLButtonElement;
const btnMinEditor = document.getElementById("btn-min-editor") as HTMLButtonElement;

let explorerMinimized = false;
let minimizedWork: WorkPane | null = null;
let lastSplitLayout: Layout = DEFAULT_LAYOUT;

function isSplitLayout(value: string | null): value is (typeof SPLIT_LAYOUTS)[number] {
  return SPLIT_LAYOUTS.includes(value as (typeof SPLIT_LAYOUTS)[number]);
}

function parseLayout(raw: string | null): Layout {
  if (raw === "terminal-fullscreen" || isSplitLayout(raw)) return raw;
  return DEFAULT_LAYOUT;
}

function isFullscreenLayout(): boolean {
  return splitEl.classList.contains("layout-terminal-fullscreen");
}

function exitFullscreen(): void {
  if (isFullscreenLayout()) applyLayout(lastSplitLayout);
}

function applyLayout(layout: Layout): void {
  if (isSplitLayout(layout)) lastSplitLayout = layout;
  for (const l of ["terminal-left", "terminal-right", "terminal-top", "terminal-bottom", "terminal-fullscreen"] as const) {
    splitEl.classList.toggle(`layout-${l}`, l === layout);
  }
  // Fullscreen hides the editor and explorer so the TUI owns the window.
  // Minimize bars stay in the persisted state and return when fullscreen ends.
  if (layout === "terminal-fullscreen") {
    setExplorerHidden(true);
    rightPaneEl.style.display = "none";
  } else {
    setExplorerHidden(false);
    rightPaneEl.style.display = "";
    applyExplorerMinimized();
    applyWorkMinimized();
  }
  clearSplitSizes();
  localStorage.setItem(LAYOUT_KEY, layout);
  fitPanes();
}

function clearSplitSizes(): void {
  leftPane.style.width = "";
  leftPane.style.height = "";
  leftPane.style.flexBasis = "";
}

function fitPanes(): void {
  // Flush the new flex sizes before measuring. A delayed fit paints one
  // frame at the old cell grid, then snaps — that is the occupancy flicker.
  void splitEl.getBoundingClientRect();
  activeEditor().layout();
  for (const p of panes.values()) p.view.fit();
}

function setExplorerHidden(hidden: boolean): void {
  explorerEl.style.display = hidden ? "none" : "";
  explorerDividerEl.style.display = hidden || explorerMinimized ? "none" : "";
}

function applyExplorerMinimized(): void {
  explorerEl.classList.toggle("minimized", explorerMinimized);
  if (!isFullscreenLayout()) {
    explorerEl.style.display = "";
    explorerDividerEl.style.display = explorerMinimized ? "none" : "";
  }
  syncPaneToggle(btnMinExplorer, explorerMinimized, "explorer");
}

function setExplorerMinimized(minimized: boolean): void {
  explorerMinimized = minimized;
  localStorage.setItem(EXPLORER_KEY, minimized ? "0" : "1");
  applyExplorerMinimized();
  fitPanes();
}

function applyWorkMinimized(): void {
  leftPane.classList.toggle("minimized", minimizedWork === "terminal");
  rightPaneEl.classList.toggle("minimized", minimizedWork === "editor");
  syncPaneToggle(btnMinTerminal, minimizedWork === "terminal", "terminal");
  syncPaneToggle(btnMinEditor, minimizedWork === "editor", "editor");
}

function setMinimizedWork(pane: WorkPane | null): void {
  minimizedWork = pane;
  if (pane) localStorage.setItem(WORKPANE_KEY, pane);
  else localStorage.removeItem(WORKPANE_KEY);
  applyWorkMinimized();
  clearSplitSizes();
  fitPanes();
}

function editorPaneOccupied(): boolean {
  return reviewView.isVisible || activeEditor().hasOpenTabs();
}

function collapseEditorIfIdle(): void {
  if (editorPaneOccupied()) return;
  if (minimizedWork !== "editor") setMinimizedWork("editor");
}

function revealEditor(): void {
  exitFullscreen();
  if (minimizedWork === "editor") setMinimizedWork(null);
}

function revealTerminal(): void {
  exitFullscreen();
  if (minimizedWork === "terminal") setMinimizedWork(null);
}

function requestMinimize(pane: WorkPane): void {
  if (isFullscreenLayout()) {
    exitFullscreen();
    if (minimizedWork === pane) {
      if (pane === "editor" && !editorPaneOccupied()) return;
      setMinimizedWork(null);
    }
    return;
  }
  // Restore when this pane is already the thin bar.
  if (minimizedWork === pane) {
    // Keep the editor closed until a file or review occupies it.
    if (pane === "editor" && !editorPaneOccupied()) return;
    setMinimizedWork(null);
    return;
  }
  // An idle editor is already a bar. Compacting the terminal would expand
  // the empty editor, which the occupancy rule forbids.
  if (pane === "terminal" && !editorPaneOccupied()) return;
  // Terminal and editor cannot both be bars. Minimizing the expanded pane
  // swaps which one is compacted.
  setMinimizedWork(pane);
}

function syncPaneToggle(button: HTMLButtonElement, minimized: boolean, label: string): void {
  button.textContent = minimized ? PANE_MAX_ICON : PANE_MIN_ICON;
  const action = minimized ? "Restore" : "Minimize";
  button.title = `${action} ${label}`;
  button.setAttribute("aria-label", `${action} ${label}`);
}

function setModifiedVisible(visible: boolean): void {
  modifiedPanelEl.style.display = visible ? "" : "none";
  localStorage.setItem(MODIFIED_KEY, visible ? "1" : "0");
}

btnMinExplorer.addEventListener("click", (event) => {
  event.stopPropagation();
  if (isFullscreenLayout()) {
    exitFullscreen();
    return;
  }
  setExplorerMinimized(!explorerMinimized);
});
btnMinTerminal.addEventListener("click", (event) => {
  event.stopPropagation();
  requestMinimize("terminal");
});
btnMinEditor.addEventListener("click", (event) => {
  event.stopPropagation();
  requestMinimize("editor");
});

function isColumnLayout(): boolean {
  return splitEl.classList.contains("layout-terminal-top") || splitEl.classList.contains("layout-terminal-bottom");
}

function workPaneCollapsed(): boolean {
  return minimizedWork !== null;
}

// File-menu commands + layout/toggle commands
/**
 * Route a menu edit command to the focused surface. The editor runs its own
 * action. A focused terminal selects its whole buffer. Any other input uses
 * the browser command.
 */
function runMenuEdit(kind: "undo" | "redo" | "select-all"): void {
  if (activeEditor().runMenuEdit(kind)) return;
  const pane = activeId ? panes.get(activeId) : undefined;
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

function runClipboardCommand(command: "copy" | "paste"): void {
  const pane = activeId ? panes.get(activeId) : undefined;
  const term = pane?.view.getTerminal();
  if (term?.textarea && document.activeElement === term.textarea) {
    if (command === "copy") pane?.view.copySelection();
    else void pane?.view.pasteClipboard();
    return;
  }
  void window.pi.editClipboard(command);
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
commands.register("copy", () => runClipboardCommand("copy"));
commands.register("paste", () => runClipboardCommand("paste"));
commands.register("select-all", () => runMenuEdit("select-all"));

// Terminal commands
commands.register("new-terminal", () => {
  if (terminalMenu) closeTerminalMenu();
  else void openTerminalMenu();
});
commands.register("next-terminal", () => cycleTerminals(1));
commands.register("previous-terminal", () => cycleTerminals(-1));
commands.register("toggle-thinking", () => {
  const next = !committedPreferences.showThinking;
  void window.pi.updatePreferences({ patch: { showThinking: next }, activateShortcuts: false }).then((saved) => {
    applyPreferences(saved, false, false);
  }).catch(() => toast("Could not save settings", "error"));
});
commands.register("next-project", () => cycleProjects(1));
commands.register("previous-project", () => cycleProjects(-1));

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
  if (next) void window.pi.projectActivate(next);
}

function activateProjectByIndex(index: number): void {
  const id = orderedProjectIds()[index];
  if (id) void window.pi.projectActivate(id);
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

window.addEventListener(
  "keydown",
  (e) => {
    if (settingsView.isOpen) return;
    const computed = shortcutForEvent(e);
    if (!computed) return;
    const target = normalizeShortcut(computed);
    const entries = Object.entries(preferences.shortcuts) as [CommandId, string][];
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
commands.register("fullscreen", () => applyLayout("terminal-fullscreen"));
commands.register("layout-terminal-left", () => applyLayout("terminal-left"));
commands.register("layout-terminal-right", () => applyLayout("terminal-right"));
commands.register("layout-terminal-top", () => applyLayout("terminal-top"));
commands.register("layout-terminal-bottom", () => applyLayout("terminal-bottom"));
commands.register("toggle-explorer", () => {
  if (isFullscreenLayout()) exitFullscreen();
  else setExplorerMinimized(!explorerMinimized);
});
commands.register("toggle-terminal", () => requestMinimize("terminal"));
commands.register("toggle-editor", () => requestMinimize("editor"));
commands.register("toggle-modified", () => setModifiedVisible(modifiedPanelEl.style.display === "none"));
commands.register("session-search", () => sessionSearch.open());

// Settings
commands.register("open-settings", () => settingsView.open(preferences));

window.pi.onMenuCommand((cmd) => {
  commands.execute(cmd.command);
});

// ------------------------------------------------------------ split pane ----

const divider = document.getElementById("divider")!;
let dragging = false;
divider.addEventListener("mousedown", () => {
  if (workPaneCollapsed()) return;
  dragging = true;
  document.body.style.cursor = isColumnLayout() ? "row-resize" : "col-resize";
});
window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const rect = splitEl.getBoundingClientRect();
  if (isColumnLayout()) {
    const pct = ((e.clientY - rect.top) / rect.height) * 100;
    leftPane.style.flexBasis = `${Math.min(75, Math.max(25, pct))}%`;
  } else {
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    leftPane.style.width = `${Math.min(70, Math.max(30, pct))}%`;
  }
});
window.addEventListener("mouseup", () => {
  dragging = false;
  document.body.style.cursor = "";
});

// explorer ↔ editor divider
let exploring = false;
explorerDividerEl.addEventListener("mousedown", () => {
  if (explorerMinimized) return;
  exploring = true;
  document.body.style.cursor = "col-resize";
});
window.addEventListener("mousemove", (e) => {
  if (!exploring) return;
  const rect = document.getElementById("main")!.getBoundingClientRect();
  const w = Math.min(420, Math.max(140, e.clientX - rect.left));
  explorerEl.style.width = `${w}px`;
});
window.addEventListener("mouseup", () => {
  exploring = false;
  document.body.style.cursor = "";
});

const MODIFIED_LIST_MIN = 72;
const MODIFIED_LIST_DEFAULT = 160;
const TERMINAL_MIN_PX = 128;

function modifiedPanelIsOpen(): boolean {
  return modifiedPanel.style.display !== "none" && !modifiedPanel.classList.contains("collapsed");
}

function modifiedListMaxHeight(): number {
  const paneH = leftPane.clientHeight;
  if (paneH <= 0) return Number.POSITIVE_INFINITY;
  const listH = modifiedList.getBoundingClientRect().height;
  const termH = termContainer.getBoundingClientRect().height;
  return Math.max(MODIFIED_LIST_MIN, Math.round(listH + termH - TERMINAL_MIN_PX));
}

function clampModifiedListHeight(px: number, max = modifiedListMaxHeight()): number {
  const cap = Number.isFinite(max) ? max : Math.max(MODIFIED_LIST_MIN, Math.round(px));
  return Math.min(cap, Math.max(MODIFIED_LIST_MIN, Math.round(px)));
}

function applyModifiedListHeight(px: number, max?: number): void {
  modifiedList.style.height = `${clampModifiedListHeight(px, max)}px`;
}

function restoreModifiedListHeight(): void {
  const raw = Number(localStorage.getItem(MODIFIED_HEIGHT_KEY));
  const h = Number.isFinite(raw) && raw > 0 ? raw : MODIFIED_LIST_DEFAULT;
  modifiedList.style.height = `${Math.max(MODIFIED_LIST_MIN, Math.round(h))}px`;
  requestAnimationFrame(() => applyModifiedListHeight(h));
}

let resizingModified = false;
let modifiedDragStartY = 0;
let modifiedDragStartH = 0;
let modifiedDragMax = MODIFIED_LIST_MIN;
let modifiedClampRaf = 0;

function finishModifiedResize(): void {
  if (!resizingModified) return;
  resizingModified = false;
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  localStorage.setItem(MODIFIED_HEIGHT_KEY, String(Math.round(modifiedList.getBoundingClientRect().height)));
  fitPanes();
}
modifiedResizeEl.addEventListener("mousedown", (e) => {
  if (!modifiedPanelIsOpen()) return;
  e.preventDefault();
  resizingModified = true;
  modifiedDragStartY = e.clientY;
  modifiedDragStartH = modifiedList.getBoundingClientRect().height;
  modifiedDragMax = modifiedListMaxHeight();
  document.body.style.cursor = "row-resize";
  document.body.style.userSelect = "none";
});
window.addEventListener("mousemove", (e) => {
  if (!resizingModified) return;
  if (e.buttons === 0) {
    finishModifiedResize();
    return;
  }
  applyModifiedListHeight(modifiedDragStartH + (modifiedDragStartY - e.clientY), modifiedDragMax);
});
window.addEventListener("mouseup", () => {
  if (resizingModified) finishModifiedResize();
});

new ResizeObserver(() => {
  if (resizingModified || modifiedClampRaf) return;
  modifiedClampRaf = requestAnimationFrame(() => {
    modifiedClampRaf = 0;
    if (!modifiedPanelIsOpen()) return;
    applyModifiedListHeight(modifiedList.getBoundingClientRect().height);
  });
}).observe(leftPane);

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

// ------------------------------------------------------------ pi events ----

window.pi.onPtyData(({ id, data }) => {
  const pane = panes.get(id);
  if (pane) pane.view.write(data);
});

window.pi.onPtyExit(({ id }) => {
  const pane = panes.get(id);
  if (!pane) return;
  pane.exited = true;
  pane.view.write("\r\n\x1b[90m[pi exited]\x1b[0m\r\n");
});

/** Lock the editor while a primary agent terminal of the workspace is busy.
 *  Candidate agents stay isolated: their writes cannot reach the primary. */
function updateEditorLock(): void {
  const busy = [...panes.values()].some(
    (p) => p.busy && p.type === "agent" && !p.error && worldlinesView.labelOfTerminal(p.instanceId) === null,
  );
  activeEditor().setLocked(busy);
}

window.pi.onFlushRequest(({ requestId, writerId }) => {
  void activeEditor().flushAll(writerId).then((result) => void window.pi.reportFlush(requestId, result));
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
      return { text: "↑", title: `Termina ${state.version} is available` };
    case "downloading":
      return { text: `${state.percent}%`, title: `Downloading Termina ${state.version} (${state.percent}%)` };
    case "ready":
      return { text: "↑", title: `Restart to install Termina ${state.version}` };
    case "error":
      return { text: "!", title: `Could not check for updates: ${state.message}` };
  }
}

btnAppUpdate.addEventListener("click", () => {
  void window.pi.getUpdateState().then((state) => {
    if (state.status === "error") {
      void window.pi.checkUpdate();
      return;
    }
    void window.pi.installUpdate().then((res) => {
      if (!res.ok) toast(res.error ?? "could not install the update", "warning");
    });
  });
});
window.pi.onUpdateState(applyAppUpdateState);
void window.pi.getUpdateState().then(applyAppUpdateState);

window.pi.onBusy(({ instanceId, busy }) => {
  const pane = panes.get(instanceId);
  if (!pane) return;
  pane.busy = busy;
  updatePaneTab(pane);
  updateEditorLock();
  if (activeId === instanceId) renderStatus(pane);
});

window.pi.onVerifyState(({ terminalId, verify }) => {
  const pane = panes.get(terminalId);
  if (!pane) return;
  pane.verify = verify;
  if (activeId === terminalId) renderStatus(pane);
});

window.pi.onTimelineEvent(({ terminalId, event }) => {
  const pane = panes.get(terminalId);
  if (!pane) return;
  // Updates from main re-use the seq — replace in place, never duplicate.
  const idx = pane.timeline.findIndex((e) => e.seq === event.seq);
  if (idx === -1) pane.timeline.push(event);
  else pane.timeline[idx] = event;
  if (pane.timeline.length > MAX_TIMELINE_EVENTS) pane.timeline.splice(0, pane.timeline.length - MAX_TIMELINE_EVENTS);
  if (activeId === terminalId) timelineView.push(event);
  // A settled run may have become forkable: refresh the Fork Run button.
  if (event.t === "agent_settled") {
    pane.runs = null;
    loadRuns(pane);
  }
});

window.pi.onTimelineEvict(({ terminalId, seqs }) => {
  const pane = panes.get(terminalId);
  if (!pane) return;
  pane.timeline = pane.timeline.filter((e) => !seqs.includes(e.seq));
  if (activeId === terminalId) timelineView.evict(seqs);
});

window.pi.onTimelineClear(({ terminalId }) => {
  const pane = panes.get(terminalId);
  if (!pane) return;
  pane.timeline = [];
  pane.timelinePrefix = null;
  pane.plan = [];
  pane.planVersion++;
  if (activeId === terminalId) {
    timelineView.setEvents([]);
    timelineView.setPrefix(null);
    renderPlan(pane);
  }
});

window.pi.onTimelinePrefix((p) => {
  const pane = panes.get(p.terminalId);
  if (!pane) return;
  pane.timelinePrefix = p;
  if (activeId === p.terminalId) timelineView.setPrefix(p);
});

window.pi.onRecorderState(({ terminalId, state }) => {
  const pane = panes.get(terminalId);
  if (!pane) return;
  pane.recorderState = state;
  if (activeId === terminalId) timelineView.setRecorder(state);
});

window.pi.onPlanUpdate(({ instanceId, tasks }) => {
  const pane = panes.get(instanceId);
  if (!pane) return;
  pane.planVersion++;
  pane.plan = tasks;
  if (activeId === instanceId) renderPlan(pane);
});

window.pi.onToolTarget((p) => {
  void activeEditor().openFile(p.path, { preview: false }).catch((err) => {
    toast(`could not open ${pathBasename(p.path)}: ${(err as Error).message}`, "error");
  });
});

const lastChangePush = new Map<string, { at: number; changedLines?: number[] }>();
const largeChangeFetch = new Set<string>();
const MAX_LAST_CHANGE_PUSH = 500;

function fetchLargeChange(path: string): void {
  if (largeChangeFetch.has(path)) return;
  largeChangeFetch.add(path);
  const at = lastChangePush.get(path)?.at;
  void window.pi.openFile(path).then((res) => {
    largeChangeFetch.delete(path);
    const latest = lastChangePush.get(path);
    if (latest !== undefined && latest.at !== at) {
      fetchLargeChange(path);
      return;
    }
    if (res.ok) activeEditor().updateContent(path, res.content, res.changedLines ?? latest?.changedLines);
  }).catch(() => {
    largeChangeFetch.delete(path);
  });
}

window.pi.onFileChanged((p) => {
  const at = Date.now();
  lastChangePush.delete(p.path);
  lastChangePush.set(p.path, { at, changedLines: p.changedLines });
  while (lastChangePush.size > MAX_LAST_CHANGE_PUSH) {
    const oldestKey = lastChangePush.keys().next().value;
    if (oldestKey === undefined) break;
    lastChangePush.delete(oldestKey);
  }
  if (p.content !== undefined) {
    activeEditor().updateContent(p.path, p.content, p.changedLines);
  } else {
    // The main process caps large pushes. Fetch once per path; a newer
    // change while a fetch is in flight starts one follow-up fetch.
    fetchLargeChange(p.path);
  }
  explorer.handleDiskChange();
  // The open review stays in sync with the agent's writes.
  if (reviewView.isVisible && reviewView.matchesPath(p.path)) void reviewView.refreshCurrent();
});

window.pi.onFileDeleted((p) => {
  lastChangePush.delete(p.path);
  activeEditor().closeIfOpen(p.path);
  explorer.handleDiskChange();
});

window.pi.onModifiedList((p) => {
  const pane = panes.get(p.instanceId);
  if (!pane) return;
  pane.modified = p.files;
  if (activeId === pane.instanceId) renderModified(pane);
});

window.pi.onFolderOpened((e) => {
  projectCwd = e.cwd;
  const projectId = e.projectId;
  let view = projectViews.get(projectId);
  if (!view) {
    view = createProjectView({ id: projectId, cwd: e.cwd, needsLogin: e.needsLogin });
  } else {
    view.editorMgr.setProjectOpen(true, e.needsLogin);
  }
  baseEditor.setProjectOpen(true);
  setActiveProject(view.id);
  explorer.setProject(e.cwd);
  reviewView.resetForProject();
  worldlinesView.resetForProject();
  refreshMine();
  void refreshTestCommand();
  setActiveProject(view.id);
  activateProjectPane();
  timelineView.resetForProject();
  renderTimeline();
  // Rebuild the worldline panel for this project (pushes are per-project).
  void window.pi.getWorldlines().then((list) => {
    worldlinesView.resetForProject();
    for (const summary of list) worldlinesView.upsert(summary);
  }).catch((err) => toast(`could not load worldlines: ${(err as Error).message}`, "error"));
});

// ---------------------------------------------------------- worldlines ----

window.pi.onWorldlineRunsChanged(({ terminalId }) => {
  const pane = panes.get(terminalId);
  if (!pane) return;
  pane.runs = null;
  loadRuns(pane);
});

// A promotion opens its primary terminal: bring it to the front.
window.pi.onPromotionOpened(({ terminalId }) => {
  activatePaneWhenReady(terminalId);
});

window.pi.onWorldlineUpdate((summary) => {
  worldlinesView.upsert(summary);
  // Badges: the terminal tab and every editor tab under the candidate root.
  if (summary.terminalId) {
    const pane = panes.get(summary.terminalId);
    if (pane) updatePaneTab(pane);
  }
  activeEditor().refreshBadges();
});

window.pi.onWorldlineRemoved(({ comparisonId }) => {
  worldlinesView.remove(comparisonId);
  for (const p of panes.values()) updatePaneTab(p);
  activeEditor().refreshBadges();
  if (activeId) {
    const pane = panes.get(activeId);
    if (pane) refreshCandidateTestCommand(pane);
  }
});

window.pi.onEvidenceUpdate((summary) => {
  worldlinesView.upsertEvidence(summary);
});

window.pi.onInstances((list: InstanceSummary[]) => {
  for (const summary of list) {
    let pane = panes.get(summary.id);
    if (!pane) pane = createPaneShell(summary.id); // terminal spawned after boot
    pane.cwd = summary.cwd;
    pane.workspaceId = summary.workspaceId ?? "";
    pane.projectId = summary.projectId ?? null;
    if (pane.projectId && !projectViews.has(pane.projectId) && summary.cwd) {
      // The project view is created lazily; projectList resolves it.
      void window.pi.projectList().then((list) => {
        const project = list.find((p) => p.id === pane.projectId);
        if (project && !projectViews.has(project.id)) createProjectView(project);
      });
    }
    pane.busy = summary.busy;
    pane.type = summary.type;
    pane.engine = summary.engine;
    pane.view.setEngine(summary.engine);
    pane.shellName = summary.shellName;
    pane.dispatchWorker = summary.dispatchWorker ?? false;
    pane.dispatchTask = summary.dispatchTask;
    if (summary.verify) pane.verify = summary.verify;
    updatePaneTab(pane);
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
  updateEditorLock();
});

// ---------------------------------------------------------------- startup --

function removeSplash(): void {
  document.getElementById("splash")?.remove();
}

// Remove the splash. Do not leave the user on it when the terminal never appears.
setTimeout(removeSplash, 10000);

async function boot(): Promise<void> {
  // Restore layout + panel visibility preferences (default: terminal-left split).
  const layout = parseLayout(localStorage.getItem(LAYOUT_KEY));
  explorerMinimized = localStorage.getItem(EXPLORER_KEY) === "0";
  const storedWork = localStorage.getItem(WORKPANE_KEY);
  minimizedWork = storedWork === "terminal" || storedWork === "editor" ? storedWork : null;
  if (isSplitLayout(layout)) lastSplitLayout = layout;
  applyLayout(layout);
  if (minimizedWork !== "editor" && !editorPaneOccupied()) setMinimizedWork("editor");
  if (localStorage.getItem(MODIFIED_KEY) === "0") setModifiedVisible(false);
  restoreModifiedListHeight();
  void refreshTestCommand();

  // Build the project tab bar; the active project owns the initial view.
  const projects = await window.pi.projectList();
  for (const project of projects) {
    createProjectView(project);
    if (project.active) activeProjectId = project.id;
  }
  setActiveProject(activeProjectId);
  const bootView = activeProjectId ? projectViews.get(activeProjectId) : undefined;
  if (bootView) {
    projectCwd = bootView.cwd;
    explorer.setProject(bootView.cwd);
  }

  const instances = await window.pi.getInstances();
  // A project with no terminals: show why the default agent failed. A
  // launch with no folder stays on the open-folder placeholder.
  if (instances.length === 0 && projects.length > 0) {
    createErrorPane("no agent terminal started.");
    removeSplash();
    return;
  }
  for (const inst of instances) {
    if (!panes.has(inst.id)) createPaneShell(inst.id);
    const pane = panes.get(inst.id);
    if (pane) {
      pane.cwd = inst.cwd;
      pane.workspaceId = inst.workspaceId ?? "";
      pane.projectId = inst.projectId ?? null;
      pane.type = inst.type;
      pane.shellName = inst.shellName;
      if (inst.verify) pane.verify = inst.verify;
      updatePaneTab(pane);
    }
  }
  activateProjectPane();
  updateEditorLock();
  removeSplash();
  // Show the correct project view (the boot instances may belong to it).
  const bootProjectId = instances[0]?.projectId ?? activeProjectId;
  if (bootProjectId && projectViews.has(bootProjectId)) {
    setActiveProject(bootProjectId);
    activateProjectPane();
  }
  // The project may only be known after the instance list arrives —
  // re-query the test command now that the project is known.
  void refreshTestCommand();

  // Worldlines: rebuild the panel from the live list (push events keep it
  // current after this).
  const worldlines = await window.pi.getWorldlines();
  for (const summary of worldlines) worldlinesView.upsert(summary);
}

void boot();