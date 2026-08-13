/**
 * Minimal xterm view wired to a pty: output streams in, keystrokes flow out.
 * This is the real-terminal experience — no chat rendering, just pi's TUI.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { ThemeId } from "../shared/types";
import { CanvasAddon } from "@xterm/addon-canvas";

const TERMINAL_THEMES: Record<ThemeId, Record<string, string>> = {
  dark: {
    background: "#141414", foreground: "#d4d4d4", cursor: "#4fc1ff", selectionBackground: "#264f78",
    black: "#1e1e1e", red: "#f14c4c", green: "#4ec9b0", yellow: "#dcdcaa", blue: "#4fc1ff", magenta: "#c586c0", cyan: "#4ec9b0", white: "#d4d4d4",
  },
  light: {
    background: "#f7f8fa", foreground: "#1f2328", cursor: "#0969da", selectionBackground: "#b6d7ff",
    black: "#24292f", red: "#cf222e", green: "#1a7f37", yellow: "#9a6700", blue: "#0969da", magenta: "#8250df", cyan: "#0a7b83", white: "#f6f8fa",
  },
  "high-contrast": {
    background: "#000000", foreground: "#ffffff", cursor: "#ffffff", selectionBackground: "#264f78",
    black: "#000000", red: "#ff6b6b", green: "#7ee787", yellow: "#f2cc60", blue: "#79c0ff", magenta: "#d2a8ff", cyan: "#56d4dd", white: "#ffffff",
  },
};

export class PtyView {
  private term: Terminal;
  private fitAddon: FitAddon;
  private readonly sendInput: (data: string) => void;
  private fitScheduled = false;
  private disposed = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastRender = 0;
  private resizeObserver: ResizeObserver | null = null;

  constructor(
    container: HTMLElement,
    onInput: (data: string) => void,
    onResize: (cols: number, rows: number) => void,
    private readonly writeClipboard: (text: string) => void,
    private readonly readClipboard: () => Promise<string>,
  ) {
    this.sendInput = onInput;
    this.term = new Terminal({
      fontSize: 13,
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
      convertEol: true,
      theme: TERMINAL_THEMES.dark,
      cursorBlink: true,
      scrollback: 8000,
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(new CanvasAddon());
    this.term.open(container);
    container.addEventListener("mousedown", () => this.term.focus());
    this.term.attachCustomKeyEventHandler((event) => this.handleKey(event));

    this.term.onData((data) => this.sendInput(data));
    this.term.onResize(({ cols, rows }) => onResize(cols, rows));

    // Watchdog: force a repaint when the renderer stalls (canvas renderer failure).
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
    // The first fit can run before the terminal font is ready; the cell
    // measurement then differs from later fits and the row count jumps.
    // Fit again once the fonts load so every terminal shares one size.
    if (typeof document !== "undefined" && document.fonts?.ready) {
      void document.fonts.ready.then(() => this.fit()).catch(() => undefined);
    }
    try {
      this.resizeObserver = new ResizeObserver(() => this.fit());
      this.resizeObserver.observe(container);
    } catch {
      /* not available */
    }
  }

  private handleKey(event: KeyboardEvent): boolean {
    if (event.type !== "keydown" || (!event.metaKey && !event.ctrlKey && !(event.altKey && event.key === "Backspace"))) return true;
    const key = event.key.toLowerCase();
    if (key === "c" && this.term.hasSelection()) {
      event.preventDefault();
      this.copySelection();
      return false;
    }
    if (key === "v") {
      event.preventDefault();
      void this.pasteClipboard();
      return false;
    }
    if (event.metaKey && !event.ctrlKey) {
      const macInput = {
        Backspace: "\x15",
        Delete: "\x0b",
        ArrowLeft: "\x01",
        ArrowRight: "\x05",
      }[event.key];
      if (macInput) {
        event.preventDefault();
        this.sendInput(macInput);
        return false;
      }
    }
    if (event.altKey && event.key === "Backspace") {
      event.preventDefault();
      this.sendInput("\x17");
      return false;
    }
    return true;
  }

  copySelection(): boolean {
    if (this.disposed || !this.term.hasSelection()) return false;
    this.writeClipboard(this.term.getSelection());
    return true;
  }

  async pasteClipboard(): Promise<void> {
    if (this.disposed) return;
    try {
      const text = await this.readClipboard();
      if (!this.disposed && text) this.term.paste(text);
    } catch {
      // Keep terminal input available when the system clipboard is unavailable.
    }
  }

  write(data: string): void {
    if (!this.disposed) this.term.write(data);
  }

  setTheme(theme: ThemeId): void {
    if (!this.disposed) this.term.options.theme = TERMINAL_THEMES[theme];
  }

  fit(): void {
    if (this.fitScheduled || this.disposed) return;
    this.fitScheduled = true;
    requestAnimationFrame(() => {
      this.fitScheduled = false;
      if (this.disposed) return;
      const container = this.term.element?.parentElement;
      if (!container || container.clientWidth === 0 || container.clientHeight === 0) return;
      const prevCols = this.term.cols;
      const prevRows = this.term.rows;
      try {
        this.fitAddon.fit();
      } catch {
        return;
      }
      if (this.term.cols !== prevCols || this.term.rows !== prevRows) {
        try {
          this.term.clearTextureAtlas();
          this.term.refresh(0, this.term.rows - 1);
          this.lastRender = Date.now();
        } catch {
          /* ignore */
        }
      }
    });
  }

  getTerminal(): Terminal {
    return this.term;
  }

  focus(): void {
    if (!this.disposed) this.term.focus();
  }

  dispose(): void {
    this.disposed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.term.dispose();
  }
}