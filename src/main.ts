/**
 * Renderer entry — terminal-first architecture.
 *
 * Left: multiple terminal panes, each running real pi TUI in a pty.
 * Right: shared Monaco editor + file explorer, live-synced via the watcher.
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
import { SettingsView, emptyShortcuts } from "./settings";
import { defaultAppPreferences } from "../shared/types";
import { normalizeAppPreferences } from "../shared/preferences";
import type { AppPreferences, ModifiedFile, InstanceSummary, VerifyInfo, TimelineEvent, PlanTask, RunSummary } from "../shared/types";

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
const rightPaneEl2 = document.getElementById("right-pane")!;
// The base editor fills the pane before any project tab exists (the
// no-project boot). Project views take over once a folder opens.
const baseEmptyEl = emptyTemplate.content.firstElementChild!.cloneNode(true) as HTMLElement;
rightPaneEl2.appendChild(baseEmptyEl);
const baseEditor = new EditorManager(
  document.getElementById("editor-container")!,
  document.getElementById("editor-tabs")!,
  baseEmptyEl,
);
baseEditor.onConflict = (path) => {
  toast(`${path.split("/").pop()} changed on disk — you have unsaved edits`, "warning");
};
applySharedEditorHooks(baseEditor);
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
  rightPaneEl2.insertBefore(editorEl, rightPaneEl2.firstElementChild);

  const editorMgr = new EditorManager(containerEl, tabsEl, emptyEl, true, project.needsLogin === true);
  // A disk write reached a model with unsaved edits: never replace silently.
  editorMgr.onConflict = (path) => {
    toast(`${path.split("/").pop()} changed on disk — you have unsaved edits`, "warning");
  };
  applySharedEditorHooks(editorMgr);
  applyEditorPreferences(editorMgr, preferences);
  const tabEl = document.createElement("div");
  tabEl.className = "project-tab";
  const nameEl = document.createElement("span");
  nameEl.className = "tab-name";
  nameEl.textContent = basenameOf(project.cwd);
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
}

/** Remove a closed project's tab, editor view, and panes. */
function removeProjectView(projectId: string): void {
  const view = projectViews.get(projectId);
  if (!view) return;
  const editorToggle = document.getElementById("btn-min-editor");
  if (editorToggle && view.editorEl.contains(editorToggle)) placeEditorToggle(null);
  view.tabEl.remove();
  view.editorEl.remove();
  projectViews.delete(projectId);
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
  const fallback = projectViews.values().next().value;
  const editor = (view ?? fallback)?.editorMgr ?? baseEditor;
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
  activeProjectId = projectId;
  const baseChrome = document.getElementById("editor-chrome")!;
  const baseContainer = document.getElementById("editor-container")!;
  const noProject = projectId === null;
  baseChrome.style.display = noProject ? "" : "none";
  baseContainer.style.display = noProject ? "" : "none";
  // The base overlay sits on #right-pane. Hide it while a project view is shown.
  if (!noProject) baseEditor.setProjectOpen(true);
  for (const view of projectViews.values()) {
    const active = view.id === projectId;
    view.tabEl.classList.toggle("active", active);
    view.editorEl.style.display = active ? "" : "none";
  }
  placeEditorToggle(projectId);
  // Terminal panes of the active project are visible; the rest stay alive.
  for (const pane of panes.values()) {
    pane.container.style.display = pane.projectId === projectId ? "" : "none";
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
  });
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
(window as unknown as Record<string, unknown>).__worldlinesView = worldlinesView;
worldlinesView.bind({
  onCompareBase: (comparisonId, label, relPath, absPath) => {
    revealEditor();
    void reviewView.showCandidateDiff(comparisonId, label, relPath, absPath);
  },
  onCompareAB: (comparisonId, relPath) => {
    revealEditor();
    void reviewView.showABDiff(comparisonId, relPath, worldlinesView.rootOf(comparisonId, "A"));
  },
  onOpenFile: (absPath) => void openFileSmart(absPath, false),
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
  shellName: string | undefined;
  error: boolean;
  modified: ModifiedFile[];
  accepted: Set<string>;
  reverted: Set<string>;
  verify: VerifyInfo;
  timeline: TimelineEvent[];
  timelineLoaded: boolean;
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
(window as unknown as Record<string, unknown>).__panes = panes;
const closingPanes = new Set<string>();
let activeId: string | null = null;
let projectCwd: string | null = null;
let preferences: AppPreferences = normalizeAppPreferences(await window.pi.getPreferences().catch(() => defaultAppPreferences()));

function applyPreferences(next: AppPreferences, persist: boolean, activateShortcuts: boolean): void {
  preferences = normalizeAppPreferences(next);
  document.documentElement.dataset.theme = preferences.theme;
  applyEditorPreferences(baseEditor, preferences);
  for (const view of projectViews.values()) applyEditorPreferences(view.editorMgr, preferences);
  reviewView.setTheme(preferences.theme);
  reviewView.setFontSize(preferences.editorFontSize);
  reviewView.setFontFamily(preferences.fontFamily);
  reviewView.setWordWrap(preferences.wordWrap);
  for (const pane of panes.values()) applyTerminalPreferences(pane.view, preferences);
  if (persist) {
    void window.pi.updatePreferences(preferences, activateShortcuts).catch(() => toast("Could not save settings", "error"));
  } else if (activateShortcuts) {
    void window.pi.setKeyboardShortcuts(preferences.shortcuts).catch(() => undefined);
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
    () => window.pi.readClipboard(),
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
    modified: [],
    accepted: new Set(),
    reverted: new Set(),
    verify: { state: "untested", command: null, summary: null },
    timeline: [],
    timelineLoaded: false,
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
  applyTerminalPreferences(view, preferences);
  pane.tabEl.prepend(typeEl);
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

function activatePane(instanceId: string): void {
  const pane = panes.get(instanceId);
  if (!pane) return;
  removeSplash();
  activeId = instanceId;
  for (const p of panes.values()) {
    p.container.classList.toggle("active", p.instanceId === instanceId);
    p.tabEl.classList.toggle("active", p.instanceId === instanceId);
  }
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
  });
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
  });
}

/** Session Timeline: show the active pane's points, fetch once per pane. */
function renderTimeline(): void {
  const pane = activeId ? panes.get(activeId) : undefined;
  if (!pane) {
    timelineView.setEvents([]);
    return;
  }
  timelineView.setRecorder(pane.recorderState as Parameters<typeof timelineView.setRecorder>[0]);
  if (!pane.timelineLoaded) {
    pane.timelineLoaded = true;
    void window.pi.getTimeline(pane.instanceId).then((events) => {
      const p = panes.get(pane.instanceId);
      if (!p) return;
      // Events pushed locally while the fetch ran must not get lost:
      // merge them by seq (monotonic per terminal) instead of dropping them.
      const maxSeq = events.length ? Math.max(...events.map((e) => e.seq)) : 0;
      p.timeline = events.concat(p.timeline.filter((e) => e.seq > maxSeq)).slice(-MAX_TIMELINE_EVENTS);
      if (activeId === pane.instanceId) timelineView.setEvents(p.timeline);
    });
    return;
  }
  timelineView.setEvents(pane.timeline);
}

timelineView.bind({
  onJump: async (ev, opts) => {
    // Reveal the editor (a snapshot tab) without leaving fullscreen perma-hidden.
    revealEditor();
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
});

async function closePane(instanceId: string): Promise<void> {
  const pane = panes.get(instanceId);
  if (!pane) return;
  closingPanes.add(instanceId);
  panes.delete(instanceId);
  pane.view.dispose();
  pane.container.remove();
  pane.tabEl.remove();
  await window.pi.closeTerminal(instanceId);
  setTimeout(() => closingPanes.delete(instanceId), 3000);
  if (activeId === instanceId) {
    const next = [...panes.values()].at(-1);
    if (next) activatePane(next.instanceId);
    else {
      activeId = null;
      renderChrome();
    }
  }
}

function updatePaneTab(pane: Pane): void {
  pane.nameEl.textContent = pane.dispatchWorker ? "dispatch" : pane.cwd ? basenameOf(pane.cwd) : "terminal";
  pane.tabEl.title = pane.dispatchWorker
    ? `dispatch worker — ${pane.dispatchTask ?? "plan task"}`
    : `${pane.cwd ?? "?"}${pane.type === "shell" && pane.shellName ? ` · ${pane.shellName} shell` : " · pi agent"}`;
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

function basenameOf(p: string): string {
  return p.split(/[\\/]/).pop() || p;
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
    if (task.paths.length > 0) {
      li.title = task.paths.join(", ");
      li.addEventListener("click", () => void openFileSmart(task.paths[0], true));
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
      revealEditor();
      if (reviewView.isVisible) reviewView.hide();
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
  if (res.error) toast(res.error, "warning");
  else if (res.id && panes.has(res.id)) activatePane(res.id);
}

// ---------------------------------------------------------------- commands --

async function openFileSmart(path: string, preview = true): Promise<void> {
  // Opening a file from the explorer/modified list reveals the editor.
  revealEditor();
  const abs = path.startsWith("/") ? path : projectCwd ? `${projectCwd}/${path}` : path;
  await activeEditor().openFile(abs, { preview });
}

// ---------------------------------------------------------------- panels ----

// Terminal-type chooser: ＋ opens a menu (agent vs shells).
let terminalMenu: HTMLElement | null = null;
let shellsCache: { name: string; path: string }[] | null = null;

async function openTerminalMenu(): Promise<void> {
  closeTerminalMenu();
  if (!shellsCache) {
    try {
      shellsCache = await window.pi.getShells();
    } catch {
      shellsCache = [];
    }
  }
  const menu = document.createElement("div");
  menu.className = "terminal-menu";
  const item = (label: string, desc: string, onClick: () => void) => {
    const row = document.createElement("div");
    row.className = "terminal-menu-item";
    const name = document.createElement("span");
    name.className = "terminal-menu-name";
    name.textContent = label;
    const d = document.createElement("span");
    d.className = "terminal-menu-desc";
    d.textContent = desc;
    row.append(name, d);
    row.addEventListener("click", () => {
      closeTerminalMenu();
      onClick();
    });
    menu.appendChild(row);
  };
  const makeTerminal = (opts?: { type?: "agent" | "shell"; shell?: string }) => {
    void window.pi.createTerminal(opts).then((res) => {
      if (res.error) {
        createErrorPane(res.error);
        return;
      }
      if (res.id && panes.has(res.id)) activatePane(res.id);
    });
  };
  item("Agent (pi)", "the pi coding agent terminal", () => makeTerminal({ type: "agent" }));
  for (const shell of shellsCache) {
    item(shell.name, `interactive ${shell.name} shell`, () => makeTerminal({ type: "shell", shell: shell.path }));
  }
  document.body.appendChild(menu);
  const rect = btnNewTerminal.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 220))}px`;
  menu.style.top = `${rect.bottom + 6}px`;
  terminalMenu = menu;
}

function closeTerminalMenu(): void {
  terminalMenu?.remove();
  terminalMenu = null;
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
  if (pane) {
    pane.modified = [];
    renderModified(pane);
  }
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
const WORKPANE_KEY = "termina.workpane";
const PANE_MIN_ICON = "–";
const PANE_MAX_ICON = "□";
const MAX_TIMELINE_EVENTS = 400;

const splitEl = document.getElementById("main-split")!;
const modifiedPanelEl = document.getElementById("modified-panel")!;
const explorerDividerEl = document.getElementById("explorer-divider")!;
const rightPaneEl = document.getElementById("right-pane")!;
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
  requestAnimationFrame(() => {
    for (const p of panes.values()) p.view.fit();
  });
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

function requestMinimize(pane: WorkPane): void {
  if (isFullscreenLayout()) {
    exitFullscreen();
    if (minimizedWork === pane) setMinimizedWork(null);
    return;
  }
  // Restore when this pane is already the thin bar.
  if (minimizedWork === pane) {
    setMinimizedWork(null);
    return;
  }
  // Terminal and editor cannot both be bars. Minimizing the expanded pane
  // swaps which one is compacted.
  setMinimizedWork(pane);
}

function revealEditor(): void {
  exitFullscreen();
  if (minimizedWork === "editor") setMinimizedWork(null);
}

function revealTerminal(): void {
  exitFullscreen();
  if (minimizedWork === "terminal") setMinimizedWork(null);
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

window.pi.onMenuCommand((cmd) => {
  switch (cmd.command) {
    case "save-all":
      void activeEditor().flushAll().then((res) => {
        if (!res.ok) toast(`could not save: ${res.failed.map((p) => p.split("/").pop()).join(", ")}`, "warning");
      });
      break;
    case "edit:undo":
      runMenuEdit("undo");
      break;
    case "edit:redo":
      runMenuEdit("redo");
      break;
    case "edit:select-all":
      runMenuEdit("select-all");
      break;
    case "layout-terminal-left":
      applyLayout("terminal-left");
      break;
    case "layout-terminal-right":
      applyLayout("terminal-right");
      break;
    case "layout-terminal-top":
      applyLayout("terminal-top");
      break;
    case "layout-terminal-bottom":
      applyLayout("terminal-bottom");
      break;
    case "toggle-explorer":
      if (isFullscreenLayout()) exitFullscreen();
      else setExplorerMinimized(!explorerMinimized);
      break;
    case "toggle-modified":
      setModifiedVisible(modifiedPanelEl.style.display === "none");
      break;
    case "layout-terminal-fullscreen":
      applyLayout("terminal-fullscreen");
      break;
    case "toggle-terminal":
      requestMinimize("terminal");
      break;
    case "toggle-editor":
      requestMinimize("editor");
      break;
    case "session-search":
      sessionSearch.open();
      break;
    case "open-settings":
      settingsView.open(preferences);
      break;
    default:
      explorer.handleCommand(cmd.command);
  }
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
  activeEditor().markTouched(p.path);
  void activeEditor().openFile(p.path, { preview: false });
});

const lastChangePush = new Map<string, number>();
window.pi.onFileChanged((p) => {
  const at = Date.now();
  lastChangePush.set(p.path, at);
  activeEditor().markTouched(p.path);
  if (p.content !== undefined) {
    activeEditor().updateContent(p.path, p.content);
  } else {
    // The main process caps large pushes. Fetch the file on demand, and
    // drop the fetch when a newer change push superseded it.
    void window.pi.openFile(p.path).then((res) => {
      if ("content" in res && lastChangePush.get(p.path) === at) {
        activeEditor().updateContent(p.path, res.content);
      }
    });
  }
  explorer.handleDiskChange();
  // The open review stays in sync with the agent's writes.
  if (reviewView.isVisible && reviewView.matchesPath(p.path)) void reviewView.refreshCurrent();
});

window.pi.onFileDeleted((p) => {
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
  // Activate the project's first terminal (its panes are now visible).
  const firstPane = [...panes.values()].find((p) => p.projectId === view!.id);
  if (firstPane) activatePane(firstPane.instanceId);
  else {
    activeId = null;
    renderChrome();
  }
  timelineView.resetForProject();
  renderTimeline();
  // Rebuild the worldline panel for this project (pushes are per-project).
  void window.pi.getWorldlines().then((list) => {
    worldlinesView.resetForProject();
    for (const summary of list) worldlinesView.upsert(summary);
  });
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
  const pane = panes.get(terminalId);
  if (pane) activatePane(terminalId);
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
    pane.shellName = summary.shellName;
    pane.dispatchWorker = summary.dispatchWorker ?? false;
    pane.dispatchTask = summary.dispatchTask;
    if (summary.verify) pane.verify = summary.verify;
    updatePaneTab(pane);
  }
  if (!activeId && list.length > 0) activatePane(list[0].id);
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
  if (localStorage.getItem(MODIFIED_KEY) === "0") setModifiedVisible(false);
  void refreshTestCommand();

  // Build the project tab bar; the active project owns the initial view.
  const projects = await window.pi.projectList();
  for (const project of projects) {
    createProjectView(project);
    if (project.active) activeProjectId = project.id;
  }
  setActiveProject(activeProjectId);

  const instances = await window.pi.getInstances();
  // A project with no terminals: show why pi failed to start. A launch
  // with no folder stays on the open-folder placeholder.
  if (instances.length === 0 && projects.length > 0) {
    const status = await window.pi.getPiStatus();
    if (!status.available) {
      createErrorPane(status.message ?? "pi is not installed.");
      removeSplash();
      return;
    }
  }
  for (const inst of instances) {
    if (!panes.has(inst.id)) createPaneShell(inst.id);
    const pane = panes.get(inst.id);
    if (pane) {
      pane.cwd = inst.cwd;
      pane.workspaceId = inst.workspaceId ?? "";
      pane.type = inst.type;
      pane.shellName = inst.shellName;
      if (inst.verify) pane.verify = inst.verify;
      updatePaneTab(pane);
    }
  }
  if (!activeId && instances.length > 0) activatePane(instances[0].id);
  updateEditorLock();
  removeSplash();
  // Show the correct project view (the boot instances may belong to it).
  const bootProjectId = instances[0]?.projectId ?? activeProjectId;
  if (bootProjectId && projectViews.has(bootProjectId)) setActiveProject(bootProjectId);
  // The project may only be known after the instance list arrives —
  // re-query the test command now that the project is known.
  void refreshTestCommand();

  // Worldlines: rebuild the panel from the live list (push events keep it
  // current after this).
  const worldlines = await window.pi.getWorldlines();
  for (const summary of worldlines) worldlinesView.upsert(summary);
}

void boot();