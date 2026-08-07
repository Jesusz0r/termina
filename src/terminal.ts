/**
 * xterm.js session view: renders the pi agent conversation — streaming text,
 * thinking placeholder, tool-call cards (bash output streams live), and a
 * clickable "modified files" summary when the agent settles.
 *
 * File paths in the buffer are clickable via a custom LinkProvider.
 */
import { Terminal, type ILink } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import type { ModifiedFile } from "../shared/types";

export class TerminalManager {
  private term: Terminal;
  private fitAddon: FitAddon;
  private toolCalls = new Map<string, { toolName: string; args: Record<string, unknown>; written: number; open: boolean }>();
  private thinkingActive = false;
  private thinkingBuf = "";
  private assistantOpen = false;
  private onOpenFile: (path: string) => void;
  private disposed = false;
  private lastRender = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(container: HTMLElement, onOpenFile: (path: string) => void) {
    this.onOpenFile = onOpenFile;
    this.term = new Terminal({
      fontSize: 13,
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
      theme: {
        background: "#141414",
        foreground: "#d4d4d4",
        cursor: "#4fc1ff",
        selectionBackground: "#264f78",
        black: "#1e1e1e",
        red: "#f14c4c",
        green: "#4ec9b0",
        yellow: "#dcdcaa",
        blue: "#4fc1ff",
        magenta: "#c586c0",
        cyan: "#4ec9b0",
        white: "#d4d4d4",
      },
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    // Canvas renderer: the built-in DOM renderer can silently stall under write
    // bursts + resizes; canvas rendering is reliable and faster.
    this.term.loadAddon(new CanvasAddon());
    this.term.open(container);
    (window as unknown as Record<string, unknown>).__piTerminal = this.term; // dev hook

    // Watchdog: the xterm DOM renderer can silently stall its animation-frame
    // loop under write bursts + resizes, leaving the buffer full but nothing
    // drawn. Track renders; if none happened recently, force a refresh.
    this.term.onRender(() => {
      this.lastRender = Date.now();
    });
    this.watchdog = setInterval(() => {
      if (this.disposed) return;
      if (Date.now() - this.lastRender > 1500 && this.term.buffer.active.length > 0) {
        try {
          this.term.refresh(0, this.term.rows - 1);
          this.lastRender = Date.now();
        } catch {
          /* ignore */
        }
      }
    }, 1500);
    requestAnimationFrame(() => this.fit());
    try {
      new ResizeObserver(() => this.fitAddon.fit()).observe(container);
    } catch {
      /* not available */
    }
    this.setupLinkProvider();
  }

  fit(): void {
    try {
      this.fitAddon.fit();
    } catch {
      /* hidden/zero-size */
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.term.dispose();
  }

  // ------------------------------------------------------------ rendering --

  private write(text: string): void {
    if (!this.disposed) this.term.write(text);
  }

  private writeln(text = ""): void {
    this.write(text + "\r\n");
  }

  banner(lines: string[]): void {
    this.writeln(`\x1b[1m\x1b[36mpi-editor\x1b[0m \x1b[90m— hybrid terminal + live editor\x1b[0m`);
    for (const l of lines) this.writeln(`\x1b[90m${l}\x1b[0m`);
    this.writeln();
  }

  system(msg: string): void {
    this.writeln(`\x1b[90m${msg}\x1b[0m`);
  }

  error(msg: string): void {
    this.writeln();
    this.writeln(`\x1b[1;31m✗ ${msg.replace(/\n/g, "\n  ")}\x1b[0m`);
  }

  userPrompt(text: string): void {
    this.writeln();
    this.writeln(`\x1b[1;32m❯\x1b[0m ${text}`);
  }

  // ---- assistant streaming -------------------------------------------------

  startAssistant(): void {
    if (!this.assistantOpen) {
      this.writeln();
      this.assistantOpen = true;
    }
  }

  streamText(delta: string): void {
    this.endThinking();
    this.startAssistant();
    this.write(delta);
  }

  startThinking(): void {
    this.thinkingActive = true;
    this.thinkingBuf = "";
    this.startAssistant();
  }

  thinkingDelta(delta: string): void {
    if (!this.thinkingActive) return;
    if (this.thinkingBuf === "") {
      // Render a single placeholder line with the first bit of reasoning;
      // never update it (avoids buffer-wrapping noise on long thinking).
      this.thinkingBuf = delta;
      const shown = delta.length > 40 ? delta.slice(0, 40) + "…" : delta;
      this.writeln(`\x1b[2m… thinking: ${shown}\x1b[0m`);
    } else {
      this.thinkingBuf += delta;
    }
  }

  endThinking(): void {
    if (!this.thinkingActive) return;
    this.thinkingActive = false;
    this.thinkingBuf = "";
    this.writeln();
  }

  // ---- tool calls ----------------------------------------------------------

  startToolCall(toolCallId: string, toolName: string, args: Record<string, unknown>): void {
    this.endThinking();
    const summary = summarizeToolArgs(toolName, args);
    const icon = toolName === "bash" ? "\x1b[36m▸\x1b[0m" : "\x1b[35m◇\x1b[0m";
    this.writeln(`\x1b[90m╭─\x1b[0m ${icon} \x1b[1m${toolName}\x1b[0m \x1b[90m${summary.time}\x1b[0m ${summary.text}`);
    this.toolCalls.set(toolCallId, { toolName, args, written: 0, open: true });
  }

  updateToolCall(toolCallId: string, partialText: string): void {
    const tc = this.toolCalls.get(toolCallId);
    if (!tc || !tc.open) return;
    const content = partialText ?? "";
    const delta = content.slice(tc.written);
    tc.written = content.length;
    if (!delta) return;
    for (const [i, line] of delta.split("\n").entries()) {
      if (line === "" && i === delta.split("\n").length - 1) continue;
      this.writeln(`\x1b[2m  ${line}\x1b[0m`);
    }
  }

  endToolCall(toolCallId: string, resultText: string, isError: boolean): void {
    const tc = this.toolCalls.get(toolCallId);
    if (!tc) return;
    tc.open = false;
    const summary = firstMeaningfulLine(resultText) || (isError ? "error" : "ok");
    const mark = isError ? "\x1b[31m✗\x1b[0m" : "\x1b[32m✓\x1b[0m";
    this.writeln(`\x1b[90m╰─\x1b[0m ${mark} ${truncate(summary, 160)}`);
  }

  // ---- session complete ----------------------------------------------------

  settled(modifiedFiles: ModifiedFile[], durationMs: number): void {
    this.writeln();
    this.writeln(`\x1b[90m──\x1b[0m \x1b[1mSession complete\x1b[0m \x1b[90m(${formatDuration(durationMs)})\x1b[0m`);
    if (modifiedFiles.length === 0) {
      this.writeln("\x1b[90m  no files were modified\x1b[0m");
      return;
    }
    const created = modifiedFiles.filter((f) => f.status === "created");
    const modified = modifiedFiles.filter((f) => f.status === "modified");
    if (created.length) this.writeln(`\x1b[90m  ${created.length} created, ${modified.length} modified:\x1b[0m`);
    for (const f of created) this.writeln(`   \x1b[32m●\x1b[0m ${f.relPath}`);
    for (const f of modified) this.writeln(`   \x1b[33m●\x1b[0m ${f.relPath}`);
    this.writeln("\x1b[90m  click a path (or the list below) to open it in the editor\x1b[0m");
  }

  queued(info: string): void {
    this.writeln(`\x1b[90m⏳ ${info}\x1b[0m`);
  }

  // ---- clickable paths -----------------------------------------------------

  private setupLinkProvider(): void {
    // Known file extensions: bare filenames ("hello.txt") and relative paths
    // ("src/a.ts", "./b.md") are clickable, but version strings ("v1.2.3")
    // and URL hosts are not. Absolute paths match via the leading slash.
    const EXT =
      "(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|html?|css|scss|less|md|markdown|py|rb|go|rs|java|c|h|cpp|hpp|cc|cs|php|sh|bash|zsh|ya?ml|toml|ini|conf|config|env|sql|xml|svg|vue|svelte|swift|kt|kts|dart|txt|log|lock|db|sqlite|pdf|zip|tar|gz|png|jpe?g|gif|ico|woff2?|ttf|otf)";
    const absRe = new RegExp(`(?<![\\w:.\\/])\\/[\\w@.\\-]+(?:\\/[\\w@.\\-]+)+\\.${EXT}(?![\\w])`, "g");
    const relRe = new RegExp(`(?<![\\w./])(?:\\.\\/)?(?:[\\w@.\\-]+\\/)*[\\w@.\\-]+\\.${EXT}(?![\\w])`, "g");
    this.term.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const line = this.term.buffer.active.getLine(bufferLineNumber);
        if (!line) {
          callback(undefined);
          return;
        }
        const text = line.translateToString(true);
        const links: ILink[] = [];
        const matches: Array<{ index: number; len: number; text: string }> = [];
        for (const re of [absRe, relRe]) {
          re.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = re.exec(text)) !== null) {
            matches.push({ index: m.index, len: m[0].length, text: m[0] });
          }
        }
        matches.sort((a, b) => a.index - b.index);
        for (const m of matches) {
          links.push({
            range: {
              start: { x: m.index + 1, y: bufferLineNumber + 1 },
              end: { x: m.index + m.len + 1, y: bufferLineNumber + 1 },
            },
            text: m.text,
            activate: () => this.onOpenFile(m.text),
          });
        }
        callback(links);
      },
    });
  }
}

// ---------------------------------------------------------------- helpers --

function summarizeToolArgs(toolName: string, args: Record<string, unknown>): { text: string; time: string } {
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  switch (toolName) {
    case "bash":
      return { text: `$ ${String(args.command ?? "")}`, time };
    case "write":
    case "create_file":
    case "insert":
      return { text: String(args.path ?? ""), time };
    case "edit":
    case "apply_patch": {
      const path = String(args.path ?? "");
      const edits = Array.isArray(args.edits) ? args.edits.length : args.patch ? "patch" : "";
      return { text: `${path}${edits ? `  (${edits} edits)` : ""}`, time };
    }
    case "read":
      return { text: String(args.path ?? args.file_path ?? ""), time };
    case "grep":
      return { text: `${String(args.pattern ?? "")} in ${String(args.path ?? ".")}`, time };
    case "find":
    case "ls":
      return { text: String(args.path ?? args.cwd ?? "."), time };
    default:
      return { text: truncate(JSON.stringify(args), 120), time };
  }
}

function firstMeaningfulLine(text: string): string {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function formatDuration(ms: number): string {
  if (!ms) return "";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}