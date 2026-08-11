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
import type { AppPreferences, ModifiedFile, InstanceSummary, VerifyInfo, TimelineEvent, PlanTask, RunSummary } from "../shared/types";

const { EditorManager } = await import("./editor");
const { ReviewView } = await import("./review");
const editorMgr = new EditorManager(document.getElementById("editor-container")!);
(window as unknown as Record<string, unknown>).__editorMgr = editorMgr;
// A disk write reached a model with unsaved edits: never replace silently.
editorMgr.onConflict = (path) => {
  toast(`${path.split("/").pop()} changed on disk — you have unsaved edits`, "warning");
};
const reviewView = new ReviewView();
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
editorMgr.onToggleMine = (path) => {
  const mine = !editorMgr.isMine(path);
  editorMgr.setMine(path, mine);
  void window.pi.setMineFile(path, mine).catch(() => {
    editorMgr.setMine(path, !mine); // the main side failed: revert the mark
  });
};
function refreshMine(): void {
  editorMgr.clearMine();
  void window.pi.getMineFiles().then((paths) => {
    for (const p of paths) editorMgr.setMine(p, true);
  });
}
void refreshMine();
const explorerEl = document.getElementById("explorer")!;
explorer.bind({ onOpenFile: (path, preview) => void openFileSmart(path, preview ?? true) });

const leftPane = document.getElementById("left-pane")!;
const termTabsList = document.getElementById("terminal-tabs-list")!;
const termContainer = document.getElementById("terminal-container")!;
const btnNewTerminal = document.getElementById("btn-new-terminal") as HTMLButtonElement;
const btnSettings = document.getElementById("btn-settings") as HTMLButtonElement;
const btnVerify = document.getElementById("btn-verify") as HTMLButtonElement;
const verifyBadge = document.getElementById("verify-badge")!;
const statusCwd = document.getElementById("status-cwd")!;
const statusState = document.getElementById("status-state")!;
const modifiedList = document.getElementById("modified-list")!;
const modifiedPanel = document.getElementById("modified-panel")!;
const modifiedCount = document.getElementById("modified-count")!;
const btnClearModified = document.getElementById("btn-clear-modified") as HTMLButtonElement;
const btnAcceptAll = document.getElementById("btn-accept-all") as HTMLButtonElement;
const planPanel = document.getElementById("plan-panel")!;
const planList = document.getElementById("plan-list")!;
const planCount = document.getElementById("plan-count")!;
const btnDispatch = document.getElementById("btn-dispatch") as HTMLButtonElement;
const timelineView = new TimelineView(document.getElementById("timeline-strip")!);
(window as unknown as Record<string, unknown>).__timelineView = timelineView;
const worldlinesView = new WorldlinesView(document.getElementById("worldline-panel")!);
(window as unknown as Record<string, unknown>).__worldlinesView = worldlinesView;
worldlinesView.bind({
  onCompareBase: (comparisonId, label, relPath, absPath) => void reviewView.showCandidateDiff(comparisonId, label, relPath, absPath),
  onCompareAB: (comparisonId, relPath) =>
    void reviewView.showABDiff(comparisonId, relPath, worldlinesView.rootOf(comparisonId, "A")),
  onOpenFile: (absPath) => void openFileSmart(absPath, false),
});
// Editor tabs under a candidate root carry the A/B badge.
editorMgr.tabBadge = (path) => worldlinesView.labelOfPath(path);
const btnForkRun = document.getElementById("btn-fork-run") as HTMLButtonElement;

// ---------------------------------------------------------------- panes -----

interface Pane {
  instanceId: string;
  workspaceId: string;
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
let preferences: AppPreferences = await window.pi.getPreferences().catch(() => defaultAppPreferences());

function applyPreferences(next: AppPreferences, persist: boolean, activateShortcuts: boolean): void {
  preferences = next;
  document.documentElement.dataset.theme = next.theme;
  editorMgr.setTheme(next.theme);
  editorMgr.setFontSize(next.editorFontSize);
  editorMgr.setMinimap(next.minimap);
  reviewView.setTheme(next.theme);
  reviewView.setFontSize(next.editorFontSize);
  for (const pane of panes.values()) pane.view.setTheme(next.theme);
  if (persist) {
    void window.pi.updatePreferences(next, activateShortcuts).catch(() => toast("Could not save settings", "error"));
  } else if (activateShortcuts) {
    void window.pi.setKeyboardShortcuts(next.shortcuts).catch(() => undefined);
  }
}

const settingsView = new SettingsView({
  onChange: (next) => applyPreferences(next, true, false),
  onOpen: () => void window.pi.setKeyboardShortcuts(emptyShortcuts()),
  onClose: (next) => applyPreferences(next, true, true),
});

applyPreferences(preferences, false, true);

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
  view.setTheme(preferences.theme);
  pane.tabEl.prepend(typeEl);
  return pane;
}

/** A terminal tab that shows a message instead of a live pty (e.g. pi missing). */
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
    if (activeId === pane.instanceId) renderChrome();
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
      // Events may have been pushed locally while the fetch was in flight —
      // merge them in by seq (monotonic per terminal) instead of losing them.
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
    if (splitEl.classList.contains("layout-terminal-fullscreen")) applyLayout("terminal-left");
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
    editorMgr.openSnapshot(pane.instanceId, String(ev.seq), res.relPath ?? res.path ?? "", res.content ?? "", label, opts?.replay ?? false);
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
    return;
  }
  statusState.textContent = pane.busy ? "● agent working" : "idle";
  statusState.classList.toggle("busy", pane.busy);
  statusCwd.textContent = pane.cwd ?? "";
  renderVerify(pane);
  renderPlan(pane);
  renderModified(pane);
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
    if (task.paths.length > 0) {
      li.title = task.paths.join(", ");
      li.addEventListener("click", () => void openFileSmart(task.paths[0], true));
    }
    planList.appendChild(li);
  }
  planPanel.classList.toggle("collapsed", pane.plan.length === 0);
  // Dispatch is possible when the plan has tasks. The button label shows
  // whether a dispatch is in flight (main re-sends the plan on settle).
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
  renderChrome();
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
    // Loader: a spinner and a label show that the run is in flight.
    const spin = document.createElement("span");
    spin.className = "verify-spinner";
    verifyBadge.appendChild(spin);
    verifyBadge.appendChild(document.createTextNode(` verifying · ${v.command ?? ""}`));
  } else {
    verifyBadge.textContent =
      v.state === "pass" ? `✓ ${v.summary ?? "green"}` : v.state === "timeout" ? `⏰ ${v.summary ?? "timed out"}` : v.state === "cancelled" ? `⏸ ${v.summary ?? "cancelled"}` : `✗ ${v.summary ?? "failing"}`;
  }
  verifyBadge.title = v.state === "running" ? "Click to cancel verification" : v.command ?? "";
}

function renderModified(pane: Pane): void {
  modifiedCount.textContent = pane.modified.length ? `(${pane.modified.length})` : "";
  modifiedList.replaceChildren();
  for (const f of pane.modified) {
    void pane;
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

// ---------------------------------------------------------------- commands --

async function openFileSmart(path: string, preview = true): Promise<void> {
  // Opening a file from the explorer/modified list reveals the editor.
  if (splitEl.classList.contains("layout-terminal-fullscreen")) applyLayout("terminal-left");
  const abs = path.startsWith("/") ? path : projectCwd ? `${projectCwd}/${path}` : path;
  await editorMgr.openFile(abs, { preview });
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
btnSettings.addEventListener("click", () => settingsView.open(preferences));
window.addEventListener("click", () => closeTerminalMenu());
window.addEventListener("blur", () => closeTerminalMenu());
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
  toast(`${pane.modified.length} file(s) accepted`, "info");
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
const DEFAULT_LAYOUT: Layout = "terminal-left";
const LAYOUT_KEY = "termina.layout";
const EXPLORER_KEY = "termina.explorer";
const MODIFIED_KEY = "termina.modified";
const MAX_TIMELINE_EVENTS = 400;

const splitEl = document.getElementById("main-split")!;
const modifiedPanelEl = document.getElementById("modified-panel")!;
const explorerDividerEl = document.getElementById("explorer-divider")!;
const rightPaneEl = document.getElementById("right-pane")!;

function applyLayout(layout: Layout): void {
  for (const l of ["terminal-left", "terminal-right", "terminal-top", "terminal-bottom", "terminal-fullscreen"] as const) {
    splitEl.classList.toggle(`layout-${l}`, l === layout);
  }
  // Fullscreen hides the editor (and explorer) so the TUI owns the window.
  if (layout === "terminal-fullscreen") {
    // Hide without persisting: the user's own toggle preference is respected
    // when they exit fullscreen.
    setExplorerVisible(false, false);
    setEditorVisible(false);
  } else {
    setEditorVisible(true);
  }
  // Drop inline size overrides from previous drags so the flex layout applies.
  leftPane.style.width = "";
  leftPane.style.height = "";
  leftPane.style.flexBasis = "";
  localStorage.setItem(LAYOUT_KEY, layout);
  requestAnimationFrame(() => {
    for (const p of panes.values()) p.view.fit();
  });
}

function setExplorerVisible(visible: boolean, persist = true): void {
  explorerEl.style.display = visible ? "" : "none";
  explorerDividerEl.style.display = visible ? "" : "none";
  if (persist) localStorage.setItem(EXPLORER_KEY, visible ? "1" : "0");
}

function setModifiedVisible(visible: boolean): void {
  modifiedPanelEl.style.display = visible ? "" : "none";
  localStorage.setItem(MODIFIED_KEY, visible ? "1" : "0");
}

function setEditorVisible(visible: boolean): void {
  rightPaneEl.style.display = visible ? "" : "none";
}

function isColumnLayout(): boolean {
  return splitEl.classList.contains("layout-terminal-top") || splitEl.classList.contains("layout-terminal-bottom");
}

// File-menu commands + layout/toggle commands
/**
 * Route a menu edit command to the focused surface. The editor runs its own
 * action. A focused terminal selects its whole buffer. Any other input uses
 * the browser command.
 */
function runMenuEdit(kind: "undo" | "redo" | "select-all"): void {
  if (editorMgr.runMenuEdit(kind)) return;
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
      void editorMgr.flushAll().then((res) => {
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
      // currently hidden → show; currently visible → hide
      setExplorerVisible(explorerEl.style.display === "none");
      break;
    case "toggle-modified":
      setModifiedVisible(modifiedPanelEl.style.display === "none");
      break;
    case "layout-terminal-fullscreen":
      applyLayout("terminal-fullscreen");
      break;
    case "toggle-editor":
      // Toggle Editor = switch between fullscreen and the split view.
      if (splitEl.classList.contains("layout-terminal-fullscreen")) applyLayout("terminal-left");
      else applyLayout("terminal-fullscreen");
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
  editorMgr.setLocked(busy);
}

window.pi.onFlushRequest(({ requestId, writerId }) => {
  void editorMgr.flushAll(writerId).then((result) => void window.pi.reportFlush(requestId, result));
});

window.pi.onBusy(({ instanceId, busy }) => {
  const pane = panes.get(instanceId);
  if (!pane) return;
  pane.busy = busy;
  updatePaneTab(pane);
  updateEditorLock();
  if (activeId === instanceId) renderChrome();
});

window.pi.onVerifyState(({ terminalId, verify }) => {
  const pane = panes.get(terminalId);
  if (!pane) return;
  pane.verify = verify;
  if (activeId === terminalId) renderChrome();
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
  editorMgr.markTouched(p.path);
  void editorMgr.openFile(p.path, { preview: false });
});

window.pi.onFileChanged((p) => {
  editorMgr.markTouched(p.path);
  editorMgr.updateContent(p.path, p.content);
  explorer.handleDiskChange();
  // The open review stays in sync with the agent's writes.
  if (reviewView.isVisible && reviewView.matchesPath(p.path)) void reviewView.refreshCurrent();
});

window.pi.onFileDeleted((p) => {
  editorMgr.closeIfOpen(p.path);
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
  explorer.setProject(e.cwd);
  reviewView.resetForProject();
  editorMgr.resetForProject();
  worldlinesView.resetForProject();
  refreshMine();
  void refreshTestCommand();
  for (const p of [...panes.values()]) void closePane(p.instanceId);
  timelineView.resetForProject();
  renderTimeline();
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
  editorMgr.refreshBadges();
});

window.pi.onWorldlineRemoved(({ comparisonId }) => {
  worldlinesView.remove(comparisonId);
  for (const p of panes.values()) updatePaneTab(p);
  editorMgr.refreshBadges();
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
    pane.busy = summary.busy;
    pane.type = summary.type;
    pane.shellName = summary.shellName;
    pane.dispatchWorker = summary.dispatchWorker ?? false;
    pane.dispatchTask = summary.dispatchTask;
    if (summary.verify) pane.verify = summary.verify;
    updatePaneTab(pane);
    if (!projectCwd && summary.cwd) {
      projectCwd = summary.cwd;
      explorer.setProject(summary.cwd);
    }
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
  const layout = (localStorage.getItem(LAYOUT_KEY) as Layout | null) ?? DEFAULT_LAYOUT;
  applyLayout(layout);
  if (localStorage.getItem(EXPLORER_KEY) === "0") setExplorerVisible(false);
  if (localStorage.getItem(MODIFIED_KEY) === "0") setModifiedVisible(false);
  void refreshTestCommand();

  const instances = await window.pi.getInstances();
  // No terminals could be created (e.g. pi is missing) — explain instead of
  // leaving an empty window behind the splash.
  if (instances.length === 0) {
    const status = await window.pi.getPiStatus();
    if (!status.available) {
      createErrorPane(status.message ?? "pi is not installed.");
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
  if (instances[0]?.cwd && !projectCwd) {
    projectCwd = instances[0].cwd;
    explorer.setProject(instances[0].cwd);
  }
  // The project may only be known after the instance list arrives — re-query
  // Query the test command again. The project is now known (the boot query ran too early).
  void refreshTestCommand();

  // Worldlines: rebuild the panel from the live list (push events keep it
  // current after this).
  const worldlines = await window.pi.getWorldlines();
  for (const summary of worldlines) worldlinesView.upsert(summary);
}

void boot();