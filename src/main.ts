/**
 * Renderer entry: wires Monaco, multiple isolated xterm panes and the panels
 * to pi agent instances via the preload bridge.
 *
 * Each terminal pane = one agent instance (own pi process, chat, model and
 * modified files). The editor (Monaco) is shared across panes.
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
// xterm's own stylesheet — hides the helper textarea (a visible white input box
// at the terminal's top-left otherwise), styles the viewport/scrollbar, etc.
import "@xterm/xterm/css/xterm.css";
import { TerminalManager, formatMarkdown } from "./terminal";
import { Panels } from "./components/panels";
import { Explorer } from "./components/explorer";
import { handleExtensionUiRequest, toast } from "./components/modals";
import type { PiState, ModifiedFile, ModelInfo, InstanceSummary, ExtensionUiRequest } from "../shared/types";

const editorMgr = new EditorManager(document.getElementById("editor-container")!);
const panels = new Panels();
const explorer = new Explorer(document.getElementById("explorer")!);
explorer.bind({ onOpenFile: (path, preview) => void openFileSmart(path, preview ?? true) });

const promptInput = document.getElementById("prompt-input") as HTMLTextAreaElement;
const btnSend = document.getElementById("btn-send") as HTMLButtonElement;
const leftPane = document.getElementById("left-pane")!;
const termTabsList = document.getElementById("terminal-tabs-list")!;
const termContainer = document.getElementById("terminal-container")!;
const btnNewTerminal = document.getElementById("btn-new-terminal") as HTMLButtonElement;

// ---------------------------------------------------------------- panes -----

interface Pane {
  instanceId: string;
  terminal: TerminalManager;
  container: HTMLElement;
  tabEl: HTMLElement;
  nameEl: HTMLElement;
  statusEl: HTMLElement;
  closeEl: HTMLElement;
  isStreaming: boolean;
  model: ModelInfo | null;
  thinkingLevel: string | null;
  models: ModelInfo[];
  levels: string[];
  cwd: string | null;
  modified: ModifiedFile[];
  booted: boolean;
  lastModelKey: string | null;
  lastThinking: string | null;
  textBuffer: string;
}

const panes = new Map<string, Pane>();
const closingPanes = new Set<string>();
let activeId: string | null = null;
let projectCwd: string | null = null;

function paneById(id: string): Pane | undefined {
  return panes.get(id);
}

function flushBufferedText(pane: Pane): void {
  if (!pane.textBuffer) return;
  pane.terminal.streamText(formatMarkdown(pane.textBuffer));
  pane.textBuffer = "";
}

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
  termTabsList.appendChild(tabEl);

  const terminal = new TerminalManager(container, (path) => void openFileSmart(path));
  const pane: Pane = {
    instanceId,
    terminal,
    container,
    tabEl,
    nameEl,
    statusEl,
    closeEl,
    isStreaming: false,
    model: null,
    thinkingLevel: null,
    models: [],
    levels: [],
    cwd: null,
    modified: [],
    booted: false,
    lastModelKey: null,
    lastThinking: null,
    textBuffer: "",
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
  (window as unknown as Record<string, unknown>).__piTerminal = pane.terminal.getTerminal();
  pane.terminal.fit();
  renderActiveChrome(pane);
}

async function closePane(instanceId: string): Promise<void> {
  const pane = panes.get(instanceId);
  if (!pane) return;
  closingPanes.add(instanceId);
  panes.delete(instanceId);
  pane.terminal.dispose();
  pane.container.remove();
  pane.tabEl.remove();
  await window.pi.closeInstance(instanceId);
  // The dying instance pushes a final state; ignore it (and late events).
  setTimeout(() => closingPanes.delete(instanceId), 5000);
  if (activeId === instanceId) {
    const next = [...panes.values()].at(-1);
    if (next) activatePane(next.instanceId);
    else {
      activeId = null;
      renderActiveChrome(null);
    }
  }
}

function renderActiveChrome(pane: Pane | null): void {
  if (!pane) {
    panels.setState(null);
    panels.setModified([]);
    editorMgr.setStreaming(false);
    return;
  }
  const s: PiState = {
    instanceId: pane.instanceId,
    isStreaming: pane.isStreaming,
    model: pane.model,
    thinkingLevel: pane.thinkingLevel,
    cwd: pane.cwd,
    sessionId: null,
    models: pane.models,
    levels: pane.levels,
    hasProject: !!projectCwd,
  };
  panels.setState(s);
  panels.setModified(pane.modified);
  // The shared editor locks only while the ACTIVE terminal's agent streams.
  editorMgr.setStreaming(pane.isStreaming);
}

function updatePaneTab(pane: Pane): void {
  pane.nameEl.textContent = pane.cwd ? basenameOf(pane.cwd) : "terminal";
  pane.tabEl.title = `${pane.cwd ?? "?"} · ${pane.model ? pane.model.name : "no model"}`;
  pane.statusEl.classList.toggle("busy", pane.isStreaming);
}

function basenameOf(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

// ---------------------------------------------------------------- commands --

async function openFileSmart(path: string, preview = true): Promise<void> {
  const abs = path.startsWith("/") ? path : projectCwd ? `${projectCwd}/${path}` : path;
  await editorMgr.openFile(abs, { preview });
}

async function sendPrompt(steer = false): Promise<void> {
  if (!activeId) return;
  const pane = panes.get(activeId);
  const text = promptInput.value.trim();
  if (!text) return;
  promptInput.value = "";
  autoResizePrompt();
  pane?.terminal.userPrompt(text);
  try {
    const res = await window.pi.prompt(activeId, text, {
      streamingBehavior: steer ? "steer" : pane?.isStreaming ? "followUp" : undefined,
    });
    if (!res.ok) {
      promptInput.value = text; // don't lose the user's words
      pane?.terminal.error(res.error ?? "failed to send prompt");
    }
  } catch (err) {
    promptInput.value = text;
    pane?.terminal.error(`failed to send prompt: ${(err as Error).message}`);
  }
}

function autoResizePrompt(): void {
  promptInput.style.height = "auto";
  promptInput.style.height = Math.min(160, promptInput.scrollHeight) + "px";
}

// ---------------------------------------------------------------- panels ----

panels.bind({
  onAbort: () => {
    const pane = activeId ? panes.get(activeId) : undefined;
    pane?.terminal.system("… aborting");
    if (activeId) void window.pi.abort(activeId);
  },
  onModelChange: (provider, id) => {
    if (activeId) void window.pi.setModel(activeId, provider, id);
  },
  onThinkingChange: (level) => {
    if (activeId) void window.pi.setThinking(activeId, level);
  },
  onOpenFile: (path) => void openFileSmart(path),
  onClearModified: () => {
    if (activeId) void window.pi.clearModified(activeId);
  },
});

btnNewTerminal.addEventListener("click", () => {
  void window.pi.createInstance().then(({ id }) => {
    // The state push usually creates+activates the pane first; be safe.
    if (panes.has(id)) activatePane(id);
  });
});

// File-menu commands (Open Folder, New File/Folder, Rename, Delete, Refresh)
window.pi.onMenuCommand((cmd) => explorer.handleCommand(cmd.command));

promptInput.addEventListener("keydown", (e) => {
  // Enter sends unless composing (IME) or shift (newline)
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void sendPrompt(e.metaKey || e.ctrlKey);
  }
});
promptInput.addEventListener("input", autoResizePrompt);
btnSend.addEventListener("click", () => void sendPrompt(false));

// ------------------------------------------------------------ split pane ----

const divider = document.getElementById("divider")!;
let dragging = false;
divider.addEventListener("mousedown", () => {
  dragging = true;
  document.body.style.cursor = "col-resize";
});
window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const main = document.getElementById("main")!;
  const rect = main.getBoundingClientRect();
  const pct = ((e.clientX - rect.left) / rect.width) * 100;
  leftPane.style.width = `${Math.min(70, Math.max(30, pct))}%`;
});
window.addEventListener("mouseup", () => {
  dragging = false;
  document.body.style.cursor = "";
});

// explorer ↔ editor divider
const explorerDivider = document.getElementById("explorer-divider")!;
const explorerEl = document.getElementById("explorer")!;
let exploring = false;
explorerDivider.addEventListener("mousedown", () => {
  exploring = true;
  document.body.style.cursor = "col-resize";
});
window.addEventListener("mousemove", (e) => {
  if (!exploring) return;
  const pane = document.getElementById("right-pane")!;
  const rect = pane.getBoundingClientRect();
  const w = Math.min(420, Math.max(140, e.clientX - rect.left));
  explorerEl.style.width = `${w}px`;
});
window.addEventListener("mouseup", () => {
  exploring = false;
  document.body.style.cursor = "";
});

// ------------------------------------------------------------ pi events ----

function handlePaneState(s: PiState): void {
  if (closingPanes.has(s.instanceId)) return;
  let pane = panes.get(s.instanceId);
  if (!pane) {
    // State for an instance we don't have yet (e.g. created from the menu).
    pane = createPaneShell(s.instanceId);
    activatePane(s.instanceId); // a brand-new terminal becomes active
  }
  pane.isStreaming = s.isStreaming;
  pane.model = s.model;
  pane.thinkingLevel = s.thinkingLevel;
  pane.models = s.models;
  pane.levels = s.levels;
  pane.cwd = s.cwd;
  // The explorer follows the real project folder only (not the home-dir
  // placeholder): its create/rename/delete ops require a real project.
  if (s.hasProject && !projectCwd && s.cwd) {
    projectCwd = s.cwd;
    explorer.setProject(s.cwd);
  }
  updatePaneTab(pane);

  // Show model / thinking changes in the terminal (skip the initial state).
  const modelKey = s.model ? `${s.model.name} (${s.model.provider})` : null;
  if (pane.lastModelKey !== null && modelKey !== null && modelKey !== pane.lastModelKey) {
    pane.terminal.system(`model: ${pane.lastModelKey} → ${modelKey}`);
  }
  if (modelKey !== null) pane.lastModelKey = modelKey;
  const thinking = s.thinkingLevel;
  if (pane.lastThinking !== null && thinking !== null && thinking !== pane.lastThinking) {
    pane.terminal.system(`thinking: ${pane.lastThinking} → ${thinking}`);
  }
  if (thinking !== null) pane.lastThinking = thinking;

  // Print the banner only once we know the real folder + model.
  if (!pane.booted && s.cwd) {
    pane.booted = true;
    pane.terminal.banner([
      `agent ready · model: ${s.model ? `${s.model.name} (${s.model.provider})` : "—"}`,
      `cwd: ${s.cwd}`,
      "— files the agent touches appear in the editor live · click any path to open it —",
    ]);
  }

  if (activeId === pane.instanceId) renderActiveChrome(pane);
}

function handleAgentEvent(pane: Pane, event: { instanceId: string } & Record<string, unknown>): void {
  const type = event.type as string;
  switch (type) {
    case "message_update": {
      const d = event.assistantMessageEvent as
        | { type: string; delta?: string }
        | undefined;
      if (!d) break;
      switch (d.type) {
        case "text_start":
          pane.terminal.startAssistant();
          break;
        case "text_delta":
          // Deferred: assistant text is buffered and rendered only after the
          // run's tool output (and the session summary) — never in the middle.
          pane.textBuffer += d.delta ?? "";
          break;
        case "thinking_start":
          pane.terminal.startThinking();
          break;
        case "thinking_delta":
          pane.terminal.thinkingDelta(d.delta ?? "");
          break;
      }
      break;
    }
    case "message_start": {
      const msg = event.message as { role?: string } | undefined;
      if (msg?.role === "assistant") {
        pane.terminal.startAssistant();
        // Render the previous message's deferred text now that its tools
        // (if any) have finished — before this message's own content.
        flushBufferedText(pane);
      }
      break;
    }
    case "message_end": {
      const msg = event.message as { role?: string } | undefined;
      if (msg?.role === "assistant") pane.terminal.endAssistant();
      break;
    }
    case "tool_execution_start": {
      pane.terminal.startToolCall(
        String(event.toolCallId ?? ""),
        String(event.toolName ?? ""),
        (event.args as Record<string, unknown>) ?? {},
      );
      break;
    }
    case "tool_execution_update": {
      const text = contentText(event.partialResult);
      pane.terminal.updateToolCall(String(event.toolCallId ?? ""), text);
      break;
    }
    case "tool_execution_end": {
      const text = contentText(event.result);
      pane.terminal.endToolCall(String(event.toolCallId ?? ""), text, Boolean(event.isError));
      break;
    }
    case "queue_update": {
      const n = ((event.steering as unknown[])?.length ?? 0) + ((event.followUp as unknown[])?.length ?? 0);
      if (n > 0) pane.terminal.queued(`${n} queued message${n > 1 ? "s" : ""} pending`);
      break;
    }
    case "compaction_start":
      pane.terminal.system("… compacting context…");
      break;
    case "auto_retry_start":
      pane.terminal.system(`… transient error, retrying (${String(event.attempt)}/${String(event.maxAttempts)})…`);
      break;
    case "extension_error":
      pane.terminal.error(`extension error: ${String(event.error ?? "")}`);
      break;
    case "extension_ui_request": {
      const req = {
        ...(event as object),
        instanceId: pane.instanceId,
      } as ExtensionUiRequest & { instanceId: string };
      void handleExtensionUiRequest(req);
      break;
    }
  }
}

window.pi.onState((s: PiState) => handlePaneState(s));

window.pi.onEvent((event) => {
  const pane = panes.get(event.instanceId);
  if (!pane) return;
  handleAgentEvent(pane, event);
});

window.pi.onFileChanged((p) => {
  editorMgr.markTouched(p.path);
  editorMgr.updateContent(p.path, p.content);
  explorer.handleDiskChange();
});

window.pi.onToolTarget((p) => {
  editorMgr.markTouched(p.path);
  // Files the agent is actively writing stay open (permanent), not preview.
  void editorMgr.openFile(p.path, { preview: false });
});

window.pi.onSettled((p) => {
  const pane = panes.get(p.instanceId);
  if (!pane) return;
  // Summary first, response last: the final text renders after the
  // session-complete block, so it reads as the deliverable at the end.
  pane.terminal.settled(p.runFiles, p.durationMs);
  pane.modified = p.allFiles;
  for (const f of p.runFiles) editorMgr.markTouched(f.path);
  flushBufferedText(pane);
  if (activeId === pane.instanceId) {
    panels.setModified(pane.modified);
  }
});

window.pi.onFileDeleted((p) => {
  editorMgr.closeIfOpen(p.path);
  explorer.handleDiskChange();
});

window.pi.onModifiedList((p) => {
  const pane = panes.get(p.instanceId);
  if (!pane) return;
  pane.modified = p.files;
  if (activeId === pane.instanceId) panels.setModified(p.files);
});

window.pi.onError((e) => {
  const pane = panes.get(e.instanceId);
  if (pane) pane.terminal.error(e.message);
  toast(e.message.split("\n")[0], "error");
});

window.pi.onStderr((e) => {
  const pane = panes.get(e.instanceId);
  if (!pane) return;
  // pi diagnostics — keep quiet unless it looks important
  if (/error|warn/i.test(e.line)) pane.terminal.system(`[pi] ${e.line}`);
});

window.pi.onFolderOpened((e) => {
  projectCwd = e.cwd;
  explorer.setProject(e.cwd);
  for (const pane of panes.values()) {
    pane.terminal.system(`project folder: ${e.cwd}`);
  }
});

window.pi.onInstances((list: InstanceSummary[]) => {
  // Tabs are created by the renderer; this keeps names/summaries in sync.
  for (const summary of list) {
    const pane = panes.get(summary.id);
    if (pane) updatePaneTab(pane);
  }
});

// ---------------------------------------------------------------- helpers --

function contentText(res: unknown): string {
  if (!res || typeof res !== "object") return "";
  const content = (res as { content?: Array<{ type?: string; text?: string }> }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (typeof c.text === "string" ? c.text : ""))
    .join("\n");
}

// ---------------------------------------------------------------- startup --

async function boot(): Promise<void> {
  const instances = await window.pi.getInstances();
  for (const inst of instances) {
    if (!panes.has(inst.id)) {
      createPaneShell(inst.id);
    }
  }
  if (!activeId && instances.length > 0) {
    activatePane(instances[0].id);
  }
  // The project folder for the explorer comes from the first instance's cwd
  // (only when it's a real project, not the home-dir placeholder).
  const first = await window.pi.getState(instances[0]?.id ?? "");
  if (first?.hasProject && first.cwd) {
    projectCwd = first.cwd;
    explorer.setProject(first.cwd);
  }
  // Refresh states + modified lists for all instances.
  for (const inst of instances) {
    const state = await window.pi.getState(inst.id);
    if (state) handlePaneState(state);
    const files = await window.pi.getModifiedFiles(inst.id);
    const pane = panes.get(inst.id);
    if (pane) {
      pane.modified = files;
      if (activeId === pane.instanceId) panels.setModified(files);
    }
  }
}

void boot();