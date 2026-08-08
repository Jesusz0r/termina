/**
 * Renderer entry — terminal-first architecture.
 *
 * Left: multiple terminal panes, each running real pi TUI in a pty.
 * Right: shared Monaco editor + file explorer, live-synced via the watcher.
 * The bridge extension's sidecar events drive auto-open and the modified list.
 */
import * as monaco from "monaco-editor";
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

import { EditorManager } from "./editor";
import "./styles.css";
import "@xterm/xterm/css/xterm.css";
import { PtyView } from "./pty-view";
import { ReviewView } from "./review";
import { TimelineView } from "./timeline";
import { Explorer } from "./components/explorer";
import { toast } from "./components/modals";
import type { ModifiedFile, InstanceSummary, VerifyInfo, TimelineEvent } from "../shared/types";

const editorMgr = new EditorManager(document.getElementById("editor-container")!);
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
const timelineView = new TimelineView(document.getElementById("timeline-strip")!);
(window as unknown as Record<string, unknown>).__timelineView = timelineView;

// ---------------------------------------------------------------- panes -----

interface Pane {
  instanceId: string;
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
  verifyWorker: boolean;
  timeline: TimelineEvent[];
  timelineLoaded: boolean;
}

const panes = new Map<string, Pane>();
const closingPanes = new Set<string>();
let activeId: string | null = null;
let projectCwd: string | null = null;

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
  tabEl.append(statusEl, nameEl, closeEl);
  tabEl.addEventListener("click", () => activatePane(instanceId));
  setupTabDrag(tabEl);
  termTabsList.appendChild(tabEl);

  const view = new PtyView(
    container,
    (data) => void window.pi.writeTerminal(instanceId, data),
    (cols, rows) => void window.pi.resizeTerminal(instanceId, cols, rows),
  );

  const pane: Pane = {
    instanceId,
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
    verifyWorker: false,
    timeline: [],
    timelineLoaded: false,
  };
  panes.set(instanceId, pane);
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
  (window as unknown as Record<string, unknown>).__piTerminal = pane.view.getTerminal();
  pane.view.fit();
  renderChrome();
  renderTimeline();
}

/** Session Timeline: show the active pane's points, fetch once per pane. */
function renderTimeline(): void {
  const pane = activeId ? panes.get(activeId) : undefined;
  if (!pane) {
    timelineView.setEvents([]);
    return;
  }
  if (!pane.timelineLoaded) {
    pane.timelineLoaded = true;
    void window.pi.getTimeline(pane.instanceId).then((events) => {
      const p = panes.get(pane.instanceId);
      if (!p) return;
      // Events may have been pushed locally while the fetch was in flight —
      // merge them in by seq (monotonic per terminal) instead of losing them.
      const maxSeq = events.length ? Math.max(...events.map((e) => e.seq)) : 0;
      p.timeline = events.concat(p.timeline.filter((e) => e.seq > maxSeq));
      if (activeId === pane.instanceId) timelineView.setEvents(p.timeline);
    });
    return;
  }
  timelineView.setEvents(pane.timeline);
}

timelineView.bind({
  onJump: async (ev) => {
    // Reveal the editor (a snapshot tab) without leaving fullscreen perma-hidden.
    if (splitEl.classList.contains("layout-terminal-fullscreen")) applyLayout("terminal-left");
    const pane = activeId ? panes.get(activeId) : undefined;
    if (!pane) return;
    // Snapshots are fetched on demand — the strip/IPC never carries content.
    const res = await window.pi.getTimelineContent(pane.instanceId, ev.seq);
    if (!res.ok) {
      const what = ev.t === "change" ? "change" : ev.toolName ?? "event";
      toast(`${what} ${res.relPath ?? ev.relPath ?? ""} — no snapshot for this moment`, "info");
      return;
    }
    const label = `${new Date(res.ts ?? ev.ts).toLocaleTimeString()} · ${res.toolName ?? ev.toolName ?? "on disk"}`;
    editorMgr.openSnapshot(pane.instanceId, String(ev.seq), res.relPath ?? res.path ?? "", res.content ?? "", label);
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
  pane.nameEl.textContent = pane.verifyWorker ? "verify" : pane.cwd ? basenameOf(pane.cwd) : "terminal";
  pane.tabEl.title = pane.verifyWorker
    ? `verify worker — runs tests for ${pane.cwd ?? "this project"}`
    : `${pane.cwd ?? "?"}${pane.type === "shell" && pane.shellName ? ` · ${pane.shellName} shell` : " · pi agent"}`;
  pane.statusEl.classList.toggle("busy", pane.busy);
  applyTypeBadge(pane);
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
    modifiedList.replaceChildren();
    return;
  }
  statusState.textContent = pane.busy ? "● agent working" : "idle";
  statusState.classList.toggle("busy", pane.busy);
  statusCwd.textContent = pane.cwd ?? "";
  renderVerify(pane);
  renderModified(pane);
}

/** Verify & Iterate: badge + button for the active terminal. */
function renderVerify(pane: Pane): void {
  const v = pane.verify;
  const isAgent = pane.type === "agent" && !pane.error;
  if (!isAgent) {
    btnVerify.disabled = true;
    verifyBadge.textContent = "";
    verifyBadge.hidden = true;
    return;
  }
  btnVerify.disabled = v.state === "running" || !v.command;
  btnVerify.title = v.command ? `Run ${v.command}` : "No test command detected (package.json, pytest, cargo, go)";
  if (v.state === "untested") {
    verifyBadge.textContent = "";
    verifyBadge.hidden = true;
    return;
  }
  verifyBadge.hidden = false;
  verifyBadge.className = `verify-badge state-${v.state}`;
  verifyBadge.replaceChildren();
  if (v.state === "running") {
    // Loader: spinner + label, so it's obvious the run is in flight.
    const spin = document.createElement("span");
    spin.className = "verify-spinner";
    verifyBadge.appendChild(spin);
    verifyBadge.appendChild(document.createTextNode(` verifying · ${v.command ?? ""}`));
  } else {
    verifyBadge.textContent =
      v.state === "pass" ? `✓ ${v.summary ?? "green"}` : v.state === "timeout" ? `⏰ ${v.summary ?? "timed out"}` : `✗ ${v.summary ?? "failing"}`;
  }
  verifyBadge.title = v.command ?? "";
}

function renderModified(pane: Pane): void {
  modifiedCount.textContent = pane.modified.length ? `(${pane.modified.length})` : "";
  modifiedList.replaceChildren();
  for (const f of pane.modified) {
    void pane;
    const li = document.createElement("li");
    const badge = document.createElement("span");
    badge.className = `status-badge ${f.status}`;
    badge.textContent = f.status === "created" ? "A" : "M";
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
  if (!pane || !pane.verify.workerId) return;
  const worker = panes.get(pane.verify.workerId);
  if (worker) activatePane(worker.instanceId);
  else toast(pane.verify.summary ?? "", "info");
});
btnClearModified.addEventListener("click", (e) => {
  e.stopPropagation();
  const pane = activeId ? panes.get(activeId) : undefined;
  if (pane) {
    pane.modified = [];
    renderModified(pane);
  }
});
modifiedPanel.querySelector(".panel-header")?.addEventListener("click", () => {
  modifiedPanel.classList.toggle("collapsed");
});

// ---------------------------------------------------------------- layout ---

type Layout = "terminal-left" | "terminal-right" | "terminal-top" | "terminal-bottom" | "terminal-fullscreen";
const DEFAULT_LAYOUT: Layout = "terminal-left";
const LAYOUT_KEY = "pi-editor.layout";
const EXPLORER_KEY = "pi-editor.explorer";
const MODIFIED_KEY = "pi-editor.modified";

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
window.pi.onMenuCommand((cmd) => {
  switch (cmd.command) {
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

window.pi.onBusy(({ instanceId, busy }) => {
  const pane = panes.get(instanceId);
  if (!pane) return;
  pane.busy = busy;
  updatePaneTab(pane);
  if (activeId === instanceId) renderChrome();
});

window.pi.onVerifyState(({ terminalId, verify }) => {
  const pane = panes.get(terminalId);
  if (!pane) return;
  const wasRunning = pane.verify.state === "running";
  pane.verify = verify;
  if (activeId === terminalId) renderChrome();
  if (verify.state === "running" && verify.workerId && panes.has(verify.workerId)) {
    // The worker terminal appears via onInstances; activate it so the user
    // sees the tests running.
    activatePane(verify.workerId);
  } else if (wasRunning && verify.state !== "running" && !pane.verifyWorker) {
    // Run finished → return focus to the owner so the result badge is visible.
    activatePane(terminalId);
  }
});

window.pi.onTimelineEvent(({ terminalId, event }) => {
  const pane = panes.get(terminalId);
  if (!pane) return;
  // Updates from main re-use the seq — replace in place, never duplicate.
  const idx = pane.timeline.findIndex((e) => e.seq === event.seq);
  if (idx === -1) pane.timeline.push(event);
  else pane.timeline[idx] = event;
  if (activeId === terminalId) timelineView.push(event);
});

window.pi.onToolTarget((p) => {
  editorMgr.markTouched(p.path);
  void editorMgr.openFile(p.path, { preview: false });
});

window.pi.onFileChanged((p) => {
  editorMgr.markTouched(p.path);
  editorMgr.updateContent(p.path, p.content);
  explorer.handleDiskChange();
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
  // New folder = fresh context: drop every pane's cached timeline; main has
  // already reset the per-terminal state.
  for (const p of panes.values()) {
    p.timeline = [];
    p.timelineLoaded = true;
  }
  renderTimeline();
});

window.pi.onInstances((list: InstanceSummary[]) => {
  for (const summary of list) {
    let pane = panes.get(summary.id);
    if (!pane) pane = createPaneShell(summary.id); // terminal spawned after boot
    pane.cwd = summary.cwd;
    pane.busy = summary.busy;
    pane.type = summary.type;
    pane.shellName = summary.shellName;
    pane.verifyWorker = summary.verifyWorker ?? false;
    if (summary.verify) pane.verify = summary.verify;
    updatePaneTab(pane);
    if (!projectCwd && summary.cwd) {
      projectCwd = summary.cwd;
      explorer.setProject(summary.cwd);
    }
  }
  if (!activeId && list.length > 0) activatePane(list[0].id);
});

// ---------------------------------------------------------------- startup --

function removeSplash(): void {
  document.getElementById("splash")?.remove();
}

// Safety: never trap the user on the splash if the terminal never appears.
setTimeout(removeSplash, 10000);

async function boot(): Promise<void> {
  // Restore layout + panel visibility preferences (default: terminal-left split).
  const layout = (localStorage.getItem(LAYOUT_KEY) as Layout | null) ?? DEFAULT_LAYOUT;
  applyLayout(layout);
  if (localStorage.getItem(EXPLORER_KEY) === "0") setExplorerVisible(false);
  if (localStorage.getItem(MODIFIED_KEY) === "0") setModifiedVisible(false);

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
      pane.type = inst.type;
      pane.shellName = inst.shellName;
      pane.verifyWorker = inst.verifyWorker ?? false;
      if (inst.verify) pane.verify = inst.verify;
      updatePaneTab(pane);
    }
  }
  if (!activeId && instances.length > 0) activatePane(instances[0].id);
  if (instances[0]?.cwd && !projectCwd) {
    projectCwd = instances[0].cwd;
    explorer.setProject(instances[0].cwd);
  }
}

void boot();