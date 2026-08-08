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
import { Explorer } from "./components/explorer";
import { toast } from "./components/modals";
import type { ModifiedFile, InstanceSummary } from "../shared/types";

const editorMgr = new EditorManager(document.getElementById("editor-container")!);
const explorer = new Explorer(document.getElementById("explorer")!);
const explorerEl = document.getElementById("explorer")!;
explorer.bind({ onOpenFile: (path, preview) => void openFileSmart(path, preview ?? true) });

const leftPane = document.getElementById("left-pane")!;
const termTabsList = document.getElementById("terminal-tabs-list")!;
const termContainer = document.getElementById("terminal-container")!;
const btnNewTerminal = document.getElementById("btn-new-terminal") as HTMLButtonElement;
const btnAbort = document.getElementById("btn-abort") as HTMLButtonElement;
const statusCwd = document.getElementById("status-cwd")!;
const statusState = document.getElementById("status-state")!;
const modifiedList = document.getElementById("modified-list")!;
const modifiedPanel = document.getElementById("modified-panel")!;
const modifiedCount = document.getElementById("modified-count")!;
const btnClearModified = document.getElementById("btn-clear-modified") as HTMLButtonElement;

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
  modified: ModifiedFile[];
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
    modified: [],
  };
  panes.set(instanceId, pane);
  return pane;
}

function activatePane(instanceId: string): void {
  const pane = panes.get(instanceId);
  if (!pane) return;
  activeId = instanceId;
  for (const p of panes.values()) {
    p.container.classList.toggle("active", p.instanceId === instanceId);
    p.tabEl.classList.toggle("active", p.instanceId === instanceId);
  }
  (window as unknown as Record<string, unknown>).__piTerminal = pane.view.getTerminal();
  pane.view.fit();
  renderChrome();
}

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
  pane.nameEl.textContent = pane.cwd ? basenameOf(pane.cwd) : "terminal";
  pane.tabEl.title = pane.cwd ?? "?";
  pane.statusEl.classList.toggle("busy", pane.busy);
}

function basenameOf(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

function renderChrome(): void {
  const pane = activeId ? panes.get(activeId) : undefined;
  if (!pane) {
    statusState.textContent = "no terminal";
    statusCwd.textContent = "";
    btnAbort.disabled = true;
    modifiedList.replaceChildren();
    return;
  }
  statusState.textContent = pane.busy ? "● agent working" : "idle";
  statusState.classList.toggle("busy", pane.busy);
  statusCwd.textContent = pane.cwd ?? "";
  btnAbort.disabled = !pane.busy;
  renderModified(pane);
}

function renderModified(pane: Pane): void {
  modifiedCount.textContent = pane.modified.length ? `(${pane.modified.length})` : "";
  modifiedList.replaceChildren();
  for (const f of pane.modified) {
    const li = document.createElement("li");
    const badge = document.createElement("span");
    badge.className = `status-badge ${f.status}`;
    badge.textContent = f.status === "created" ? "A" : "M";
    const path = document.createElement("span");
    path.className = "path";
    path.textContent = f.relPath;
    path.title = f.path;
    li.append(badge, path);
    li.addEventListener("click", () => void openFileSmart(f.path, false));
    modifiedList.appendChild(li);
  }
  modifiedPanel.classList.toggle("collapsed", pane.modified.length === 0);
}

// ---------------------------------------------------------------- commands --

async function openFileSmart(path: string, preview = true): Promise<void> {
  const abs = path.startsWith("/") ? path : projectCwd ? `${projectCwd}/${path}` : path;
  await editorMgr.openFile(abs, { preview });
}

// ---------------------------------------------------------------- panels ----

btnNewTerminal.addEventListener("click", () => {
  void window.pi.createTerminal().then(({ id }) => {
    if (panes.has(id)) activatePane(id);
  });
});
btnAbort.addEventListener("click", () => {
  if (activeId) void window.pi.abortTerminal(activeId);
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

type Layout = "terminal-left" | "terminal-right" | "terminal-top" | "terminal-bottom";
const LAYOUT_KEY = "pi-editor.layout";
const EXPLORER_KEY = "pi-editor.explorer";
const MODIFIED_KEY = "pi-editor.modified";

const splitEl = document.getElementById("main-split")!;
const modifiedPanelEl = document.getElementById("modified-panel")!;
const explorerDividerEl = document.getElementById("explorer-divider")!;

function applyLayout(layout: Layout): void {
  for (const l of ["terminal-left", "terminal-right", "terminal-top", "terminal-bottom"] as const) {
    splitEl.classList.toggle(`layout-${l}`, l === layout);
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

function setExplorerVisible(visible: boolean): void {
  explorerEl.style.display = visible ? "" : "none";
  explorerDividerEl.style.display = visible ? "" : "none";
  localStorage.setItem(EXPLORER_KEY, visible ? "1" : "0");
}

function setModifiedVisible(visible: boolean): void {
  modifiedPanelEl.style.display = visible ? "" : "none";
  localStorage.setItem(MODIFIED_KEY, visible ? "1" : "0");
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
});

window.pi.onInstances((list: InstanceSummary[]) => {
  for (const summary of list) {
    let pane = panes.get(summary.id);
    if (!pane) pane = createPaneShell(summary.id); // terminal spawned after boot
    pane.cwd = summary.cwd;
    pane.busy = summary.busy;
    updatePaneTab(pane);
    if (!projectCwd && summary.cwd) {
      projectCwd = summary.cwd;
      explorer.setProject(summary.cwd);
    }
  }
  if (!activeId && list.length > 0) activatePane(list[0].id);
});

// ---------------------------------------------------------------- startup --

async function boot(): Promise<void> {
  // Restore layout + panel visibility preferences.
  const layout = localStorage.getItem(LAYOUT_KEY) as Layout | null;
  if (layout) applyLayout(layout);
  if (localStorage.getItem(EXPLORER_KEY) === "0") setExplorerVisible(false);
  if (localStorage.getItem(MODIFIED_KEY) === "0") setModifiedVisible(false);

  const instances = await window.pi.getInstances();
  for (const inst of instances) {
    if (!panes.has(inst.id)) createPaneShell(inst.id);
    const pane = panes.get(inst.id);
    if (pane) {
      pane.cwd = inst.cwd;
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