/**
 * Renderer entry: wires Monaco, xterm and the panels to the pi agent via the
 * preload bridge. Handles the pi event stream and renders it in the terminal,
 * keeps the editor synced with disk, and manages the prompt input.
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
import { handleExtensionUiRequest, toast } from "./components/modals";
import type { PiState, ModifiedFile } from "../shared/types";

const editorMgr = new EditorManager(document.getElementById("editor-container")!);
const terminal = new TerminalManager(document.getElementById("terminal-container")!, (path) => void openFileSmart(path));
const panels = new Panels();

const promptInput = document.getElementById("prompt-input") as HTMLTextAreaElement;
const btnSend = document.getElementById("btn-send") as HTMLButtonElement;
const leftPane = document.getElementById("left-pane")!;

let streaming = false;
let cwd: string | null = null;
let booted = false;
let lastModelKey: string | null = null;
let lastThinking: string | null = null;

// Deferred assistant text: deltas are buffered and rendered only when the
// next assistant message starts (previous message's text) or when the run
// settles — AFTER the session-complete summary. Responses therefore always
// appear after all tool output and after the summary.
let textBuffer = "";

function flushBufferedText(): void {
  if (!textBuffer) return;
  terminal.streamText(formatMarkdown(textBuffer));
  textBuffer = "";
}

// ---------------------------------------------------------------- commands --

async function openFileSmart(path: string): Promise<void> {
  const abs = path.startsWith("/") ? path : cwd ? `${cwd}/${path}` : path;
  await editorMgr.openFile(abs);
}

async function sendPrompt(steer = false): Promise<void> {
  const text = promptInput.value.trim();
  if (!text) return;
  promptInput.value = "";
  autoResizePrompt();
  terminal.userPrompt(text);
  try {
    const res = await window.pi.prompt(text, {
      streamingBehavior: steer ? "steer" : streaming ? "followUp" : undefined,
    });
    if (!res.ok) {
      promptInput.value = text; // don't lose the user's words
      terminal.error(res.error ?? "failed to send prompt");
    }
  } catch (err) {
    promptInput.value = text;
    terminal.error(`failed to send prompt: ${(err as Error).message}`);
  }
}

function autoResizePrompt(): void {
  promptInput.style.height = "auto";
  promptInput.style.height = Math.min(160, promptInput.scrollHeight) + "px";
}

// ---------------------------------------------------------------- panels ----

panels.bind({
  onOpenFolder: () => void window.pi.openFolder(),
  onNewSession: () => {
    terminal.system("… starting a new session");
    void window.pi.newSession();
  },
  onAbort: () => {
    terminal.system("… aborting");
    void window.pi.abort();
  },
  onModelChange: (provider, id) => void window.pi.setModel(provider, id),
  onThinkingChange: (level) => void window.pi.setThinking(level),
  onOpenFile: (path) => void openFileSmart(path),
  onClearModified: () => void window.pi.clearModified(),
});

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

new ResizeObserver(() => terminal.fit()).observe(document.getElementById("main")!);

// ------------------------------------------------------------ pi events ----

window.pi.onState((s: PiState) => {
  streaming = s.isStreaming;
  cwd = s.cwd;
  panels.setState(s);
  editorMgr.setStreaming(s.isStreaming);
  editorMgr.setProjectOpen(s.hasProject);
  // Show model / thinking changes in the terminal (skip the initial state).
  const modelKey = s.model ? `${s.model.name} (${s.model.provider})` : null;
  if (lastModelKey !== null && modelKey !== null && modelKey !== lastModelKey) {
    terminal.system(`model: ${lastModelKey} → ${modelKey}`);
  }
  if (modelKey !== null) lastModelKey = modelKey;
  const thinking = s.thinkingLevel;
  if (lastThinking !== null && thinking !== null && thinking !== lastThinking) {
    terminal.system(`thinking: ${lastThinking} → ${thinking}`);
  }
  if (thinking !== null) lastThinking = thinking;
  // Print the banner only once we know the real folder + model.
  if (!booted && s.cwd) {
    booted = true;
    terminal.banner([
      `agent ready · model: ${s.model ? `${s.model.name} (${s.model.provider})` : "—"}`,
      `cwd: ${s.cwd}`,
      "— files the agent touches appear in the editor live · click any path to open it —",
    ]);
  }
});

window.pi.onEvent((event) => {
  const type = event.type as string;
  switch (type) {
    case "message_update": {
      const d = event.assistantMessageEvent as
        | { type: string; delta?: string }
        | undefined;
      if (!d) break;
      switch (d.type) {
        case "text_start":
          terminal.startAssistant();
          break;
        case "text_delta":
          // Deferred: assistant text is buffered and rendered only after the
          // run's tool output (and the session summary) — never in the middle.
          textBuffer += d.delta ?? "";
          break;
        case "thinking_start":
          terminal.startThinking();
          break;
        case "thinking_delta":
          terminal.thinkingDelta(d.delta ?? "");
          break;
      }
      break;
    }
    case "message_start": {
      const msg = event.message as { role?: string } | undefined;
      if (msg?.role === "assistant") {
        terminal.startAssistant();
        // Render the previous message's deferred text now that its tools
        // (if any) have finished — before this message's own content.
        flushBufferedText();
      }
      break;
    }
    case "message_end": {
      const msg = event.message as { role?: string } | undefined;
      if (msg?.role === "assistant") terminal.endAssistant();
      break;
    }
    case "tool_execution_start": {
      terminal.startToolCall(
        String(event.toolCallId ?? ""),
        String(event.toolName ?? ""),
        (event.args as Record<string, unknown>) ?? {},
      );
      break;
    }
    case "tool_execution_update": {
      const text = contentText(event.partialResult);
      terminal.updateToolCall(String(event.toolCallId ?? ""), text);
      break;
    }
    case "tool_execution_end": {
      const text = contentText(event.result);
      terminal.endToolCall(String(event.toolCallId ?? ""), text, Boolean(event.isError));
      break;
    }
    case "queue_update": {
      const n = ((event.steering as unknown[])?.length ?? 0) + ((event.followUp as unknown[])?.length ?? 0);
      if (n > 0) terminal.queued(`${n} queued message${n > 1 ? "s" : ""} pending`);
      break;
    }
    case "compaction_start":
      terminal.system("… compacting context…");
      break;
    case "auto_retry_start":
      terminal.system(`… transient error, retrying (${String(event.attempt)}/${String(event.maxAttempts)})…`);
      break;
    case "extension_error":
      terminal.error(`extension error: ${String(event.error ?? "")}`);
      break;
    case "extension_ui_request":
      void handleExtensionUiRequest(event as never);
      break;
  }
});

window.pi.onFileChanged((p) => {
  editorMgr.markTouched(p.path);
  editorMgr.updateContent(p.path, p.content);
});

window.pi.onToolTarget((p) => {
  editorMgr.markTouched(p.path);
  void editorMgr.openFile(p.path);
});

window.pi.onSettled((p) => {
  // Summary first, response last: the final text renders after the
  // session-complete block, so it reads as the deliverable at the end.
  terminal.settled(p.runFiles, p.durationMs);
  panels.setModified(p.allFiles);
  for (const f of p.runFiles) editorMgr.markTouched(f.path);
  flushBufferedText();
});

window.pi.onFileDeleted((p) => {
  editorMgr.closeIfOpen(p.path);
});

window.pi.onModifiedList((files) => {
  panels.setModified(files);
});

window.pi.onError((e) => {
  terminal.error(e.message);
  toast(e.message.split("\n")[0], "error");
});

window.pi.onStderr((e) => {
  // pi diagnostics — keep quiet unless it looks important
  if (/error|warn/i.test(e.line)) terminal.system(`[pi] ${e.line}`);
});

window.pi.onFolderOpened((e) => {
  cwd = e.cwd;
  terminal.system(`working directory: ${e.cwd}`);
  void window.pi.getModifiedFiles().then((files) => panels.setModified(files));
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

// Snapshot the initial state for the toolbar/status bar and the modified list.
void window.pi.getState().then((s: PiState) => {
  panels.setState(s);
  streaming = s.isStreaming;
  cwd = s.cwd;
  editorMgr.setStreaming(s.isStreaming);
}).then(() => window.pi.getModifiedFiles()).then((files: ModifiedFile[]) => {
  panels.setModified(files);
});