/**
 * Minimal xterm view wired to a pty: output streams in, keystrokes flow out.
 * This is the real-terminal experience — no chat rendering, just pi's TUI.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { cssFontFamily, type TerminalPasteResult, type ThemeId } from "../shared/types";
import { CanvasAddon } from "@xterm/addon-canvas";
import { terminalTheme } from "./terminal-themes";
import { isMacPlatform } from "./settings-shortcuts";
import { toast } from "./components/modals";

export class PtyView {
  private term: Terminal;
  private fitAddon: FitAddon;
  private readonly sendInput: (data: string) => void;
  private disposed = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastRender = 0;
  private resizeObserver: ResizeObserver | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private fontSize: number;
  private fontFamily: string;
  private themeId: ThemeId;
  private engine: "pi" | "core" | undefined;
  private refreshFont = false;
  private wheelDelta = 0;
  private wheelTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly container: HTMLElement;
  private dragDepth = 0;
  private dropInFlight = false;
  private readonly onDragEnter = (event: DragEvent) => this.handleDragEnter(event);
  private readonly onDragOver = (event: DragEvent) => this.handleDragOver(event);
  private readonly onDragLeave = (event: DragEvent) => this.handleDragLeave(event);
  private readonly onDrop = (event: DragEvent) => {
    void this.handleDrop(event);
  };
  private readonly onDragEnd = () => this.clearDropTarget();
  private readonly onWindowBlur = () => this.clearDropTarget();

  constructor(
    container: HTMLElement,
    onInput: (data: string) => void,
    onResize: (cols: number, rows: number) => void,
    private readonly writeClipboard: (text: string) => void,
    private readonly pasteFromHost: () => Promise<TerminalPasteResult>,
    private readonly reportTerminalError: (message: string) => void,
    private readonly dropFromHost: (files: File[]) => Promise<TerminalPasteResult>,
    appearance: { theme: ThemeId; fontSize: number; fontFamily: string },
  ) {
    this.container = container;
    this.sendInput = onInput;
    this.fontSize = appearance.fontSize;
    this.fontFamily = appearance.fontFamily;
    this.themeId = appearance.theme;
    this.term = new Terminal({
      fontSize: appearance.fontSize,
      fontFamily: cssFontFamily(appearance.fontFamily),
      convertEol: true,
      theme: terminalTheme(appearance.theme),
      cursorBlink: true,
      scrollback: 8000,
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(new CanvasAddon());
    this.term.open(container);
    container.addEventListener("mousedown", () => this.focus());
    container.addEventListener("dragenter", this.onDragEnter);
    container.addEventListener("dragover", this.onDragOver);
    container.addEventListener("dragleave", this.onDragLeave);
    container.addEventListener("drop", this.onDrop);
    container.addEventListener("dragend", this.onDragEnd);
    window.addEventListener("blur", this.onWindowBlur);
    this.term.attachCustomKeyEventHandler((event) => this.handleKey(event));
    this.term.attachCustomWheelEventHandler((event) => this.handleWheel(event));

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

  /** Core TUI does not enable mouse tracking (so drag-select works).
   *  Forward wheel as SGR 64/65, the sequences it already scrolls on.
   *  Accumulate pixel delta so trackpads and wheels scroll smoothly. */
  private handleWheel(event: WheelEvent): boolean {
    if (this.disposed || this.engine !== "core") return true;
    if (event.deltaY === 0) return true;
    event.preventDefault();

    const lineHeight = Math.max(16, Math.round(this.fontSize * 1.35));
    let delta = event.deltaY;
    if (event.deltaMode === 1) {
      delta *= lineHeight;
    } else if (event.deltaMode === 2) {
      delta *= lineHeight * 20;
    }

    if (this.wheelTimer !== null) {
      clearTimeout(this.wheelTimer);
      this.wheelTimer = null;
    }
    this.wheelTimer = setTimeout(() => {
      this.wheelDelta = 0;
      this.wheelTimer = null;
    }, 150);

    if ((this.wheelDelta > 0 && delta < 0) || (this.wheelDelta < 0 && delta > 0)) {
      this.wheelDelta = 0;
    }

    this.wheelDelta += delta;
    const steps = Math.trunc(this.wheelDelta / lineHeight);
    if (steps !== 0) {
      this.wheelDelta -= steps * lineHeight;
      const count = Math.min(Math.abs(steps), 8);
      const btn = steps > 0 ? 65 : 64;
      for (let i = 0; i < count; i++) {
        this.sendInput(`\x1b[<${btn};1;1M`);
      }
    }
    return false;
  }

  private handleKey(event: KeyboardEvent): boolean {
    // Let the IME own every keystroke during composition: committing
    // candidates fires modified Enter keydowns that must reach the
    // composition buffer, never the pty.
    if (event.type !== "keydown" || event.isComposing) return true;
    // Enter inserts a newline in pi's editor on the platform's primary
    // modifier — Cmd on macOS, Alt elsewhere — plus Shift and Ctrl
    // everywhere (OpenCode-style: every conventional newline chord).
    // xterm.js drops the Shift modifier on Enter, and macOS treats
    // Option as a level-3 shift, so neither reaches the pty correctly
    // without synthesis. The CSI-u shift+Enter sequence is what pi's
    // decoder reads as its newLine binding in every protocol.
    const mac = isMacPlatform();
    const newlineCombo = event.key === "Enter" && !event.altKey &&
      (event.shiftKey || event.ctrlKey || (mac && event.metaKey));
    const modelBackCombo = event.key.toLowerCase() === "p" && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
    if (!event.metaKey && !event.ctrlKey && !event.altKey && !newlineCombo) return true;
    const key = event.key.toLowerCase();
    if (modelBackCombo) {
      event.preventDefault();
      this.sendInput("\x1b[112;6u");
      return false;
    }
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
    if (newlineCombo) {
      event.preventDefault();
      this.sendInput("\x1b[13;2u");
      return false;
    }
    // macOS keeps pi's alt+enter queue-follow-up on Option, the one chord
    // left free; other platforms spend their modifiers on newlines.
    if (mac && event.key === "Enter" && event.altKey && !event.metaKey) {
      event.preventDefault();
      this.sendInput("\x1b\r");
      return false;
    }
    if (event.altKey && event.key === "Backspace") {
      event.preventDefault();
      this.sendInput("\x17");
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
      const result = await this.pasteFromHost();
      this.applyPasteResult(result, false);
    } catch {
      // Keep terminal input available when the system clipboard is unavailable.
    }
  }

  private isFileDrag(event: DragEvent): boolean {
    return Boolean(event.dataTransfer?.types?.includes("Files") || (event.dataTransfer?.files?.length ?? 0) > 0);
  }

  private filesFromEvent(event: DragEvent): File[] {
    const listed = Array.from(event.dataTransfer?.files ?? []);
    if (listed.length > 0) return listed;
    const items = event.dataTransfer?.items;
    if (!items) return [];
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const file = items[i]?.getAsFile();
      if (file) files.push(file);
    }
    return files;
  }

  private handleDragEnter(event: DragEvent): void {
    if (this.disposed || !this.isFileDrag(event)) return;
    event.preventDefault();
    this.dragDepth += 1;
    this.container.classList.add("term-drop-target");
  }

  private handleDragOver(event: DragEvent): void {
    if (this.disposed || !this.isFileDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }

  private handleDragLeave(event: DragEvent): void {
    if (this.disposed || !this.isFileDrag(event)) return;
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) this.container.classList.remove("term-drop-target");
  }

  private clearDropTarget(): void {
    this.dragDepth = 0;
    this.container.classList.remove("term-drop-target");
  }

  private async handleDrop(event: DragEvent): Promise<void> {
    if (this.disposed || !this.isFileDrag(event)) return;
    event.preventDefault();
    this.clearDropTarget();
    if (this.dropInFlight) {
      this.reportTerminalError("drop already in progress");
      return;
    }
    const files = this.filesFromEvent(event);
    if (files.length === 0) {
      this.reportTerminalError("no files");
      return;
    }
    this.dropInFlight = true;
    try {
      const result = await this.dropFromHost(files);
      this.applyPasteResult(result, true);
    } catch {
      if (!this.disposed) this.reportTerminalError("invalid dropped file");
    } finally {
      this.dropInFlight = false;
    }
  }

  private applyPasteResult(result: TerminalPasteResult, focus: boolean): void {
    if (this.disposed) return;
    if (!result.ok) {
      this.reportTerminalError(result.error);
      return;
    }
    if (result.kind === "text" && result.text) {
      // Agent TUIs enable bracketed paste before the renderer attaches, so
      // xterm can miss that mode sequence and treat multiline paste as Enter
      // presses. Bracket it explicitly to keep the paste as one editor block.
      if (this.engine && /[\r\n]/.test(result.text)) {
        const text = result.text.replace(/\r?\n/g, "\r");
        this.sendInput(`\x1b[200~${text}\x1b[201~`);
      } else {
        this.term.paste(result.text);
      }
    } else if (result.kind === "image") this.sendInput("\x1b[201~");
    if (result.kind === "image" && result.queued) toast("queued for next prompt", "info");
    if (focus) this.focus();
  }

  write(data: string, onConsumed?: () => void): void {
    if (this.disposed) return;
    this.term.write(data, () => {
      if (!this.disposed) onConsumed?.();
    });
  }

  setTheme(theme: ThemeId): void {
    if (this.disposed) return;
    this.themeId = theme;
    this.term.options.theme = terminalTheme(theme, this.engine);
  }

  setEngine(engine: "pi" | "core" | undefined): void {
    if (this.disposed || this.engine === engine) return;
    this.engine = engine;
    this.term.options.theme = terminalTheme(this.themeId, this.engine);
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
    this.clearDropTarget();
    this.container.removeEventListener("dragenter", this.onDragEnter);
    this.container.removeEventListener("dragover", this.onDragOver);
    this.container.removeEventListener("dragleave", this.onDragLeave);
    this.container.removeEventListener("drop", this.onDrop);
    this.container.removeEventListener("dragend", this.onDragEnd);
    window.removeEventListener("blur", this.onWindowBlur);
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = null;
    if (this.wheelTimer) clearTimeout(this.wheelTimer);
    this.wheelTimer = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.term.dispose();
  }
}
