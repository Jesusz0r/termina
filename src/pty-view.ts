/**
 * Minimal xterm view wired to a pty: output streams in, keystrokes flow out.
 * This is the real-terminal experience — no chat rendering, just pi's TUI.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { cssFontFamily, type ThemeId } from "../shared/types";
import { CanvasAddon } from "@xterm/addon-canvas";
import { TERMINAL_THEMES } from "./terminal-themes";

export class PtyView {
  private term: Terminal;
  private fitAddon: FitAddon;
  private readonly sendInput: (data: string) => void;
  private disposed = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastRender = 0;
  private resizeObserver: ResizeObserver | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private fontSize = 13;
  private fontFamily = "";
  private refreshFont = false;

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
      fontFamily: cssFontFamily(""),
      convertEol: true,
      theme: TERMINAL_THEMES.dark,
      cursorBlink: true,
      scrollback: 8000,
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(new CanvasAddon());
    this.term.open(container);
    container.addEventListener("mousedown", () => this.focus());
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
      this.resizeObserver = new ResizeObserver(() => {
        if (this.resizeTimer) clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => {
          this.resizeTimer = null;
          this.fit();
        }, 50);
      });
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

  setFontSize(size: number): void {
    if (this.disposed || this.fontSize === size) return;
    this.fontSize = size;
    this.term.options.fontSize = size;
    this.refreshFont = true;
    this.fit();
  }

  setFontFamily(family: string): void {
    if (this.disposed || this.fontFamily === family) return;
    this.fontFamily = family;
    this.term.options.fontFamily = cssFontFamily(family);
    this.refreshFont = true;
    this.fit();
    this.loadFamilyThenFit(family);
  }

  private loadFamilyThenFit(family: string): void {
    if (!family || !document.fonts?.load) return;
    // document.fonts.ready does not wait for a family chosen after startup.
    void document.fonts.load(`${this.fontSize}px "${family}"`).then(() => {
      if (this.disposed || this.fontFamily !== family) return;
      this.refreshFont = true;
      this.fit();
    }).catch(() => undefined);
  }

  fit(): void {
    if (this.disposed) return;
    const container = this.term.element?.parentElement;
    if (!container || container.clientWidth === 0 || container.clientHeight === 0) return;
    const dims = this.fitAddon.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
    const refreshFont = this.refreshFont;
    this.refreshFont = false;
    if (!refreshFont && dims.cols === this.term.cols && dims.rows === this.term.rows) return;
    const scroll = this.readScrollAnchor();
    try {
      this.fitAddon.fit();
    } catch {
      this.refreshFont = refreshFont;
      return;
    }
    if (refreshFont) {
      try {
        this.term.clearTextureAtlas();
        this.term.refresh(0, this.term.rows - 1);
        this.lastRender = Date.now();
      } catch {
        /* ignore */
      }
    }
    this.restoreScrollAnchor(scroll);
  }

  /** Pin to the live row when the user is at the bottom. Keep the same
   *  distance from the bottom when they have scrolled up. */
  private readScrollAnchor(): { pinToBottom: boolean; fromBottom: number } {
    const viewport = this.term.element?.querySelector(".xterm-viewport") as HTMLElement | null;
    const buf = this.term.buffer.active;
    const fromBottom = viewport
      ? Math.max(0, viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop)
      : 0;
    return {
      pinToBottom: buf.baseY - buf.viewportY <= 1 || fromBottom <= 2,
      fromBottom,
    };
  }

  private restoreScrollAnchor(scroll: { pinToBottom: boolean; fromBottom: number }): void {
    if (scroll.pinToBottom) {
      this.term.scrollToBottom();
      return;
    }
    const viewport = this.term.element?.querySelector(".xterm-viewport") as HTMLElement | null;
    if (!viewport) return;
    viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight - scroll.fromBottom);
  }

  getTerminal(): Terminal {
    return this.term;
  }

  focus(): void {
    if (this.disposed) return;
    const textarea = this.term.textarea;
    if (textarea) textarea.focus({ preventScroll: true });
    else this.term.focus();
  }

  dispose(): void {
    this.disposed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.term.dispose();
  }
}