/**
 * Minimal xterm view wired to a pty: output streams in, keystrokes flow out.
 * This is the real-terminal experience — no chat rendering, just pi's TUI.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";

export class PtyView {
  private term: Terminal;
  private fitAddon: FitAddon;
  private fitScheduled = false;
  private disposed = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastRender = 0;

  constructor(
    container: HTMLElement,
    onInput: (data: string) => void,
    onResize: (cols: number, rows: number) => void,
  ) {
    this.term = new Terminal({
      fontSize: 13,
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
      convertEol: true,
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
      scrollback: 8000,
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(new CanvasAddon());
    this.term.open(container);

    this.term.onData((data) => onInput(data));
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
    try {
      new ResizeObserver(() => this.fit()).observe(container);
    } catch {
      /* not available */
    }
  }

  write(data: string): void {
    if (!this.disposed) this.term.write(data);
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

  dispose(): void {
    this.disposed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.term.dispose();
  }
}