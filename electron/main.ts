/**
 * Electron main process.
 *
 * Owns:
 *  - the pi agent child process (RPC mode, JSONL over stdio)
 *  - the project file watcher that feeds the live editor
 *  - the "modified files" tracker shown when the agent settles
 *  - IPC to the renderer (Monaco + xterm UI)
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { existsSync, realpathSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PiRpcClient, type ToolExecutionStartEvent } from "./rpc-client.js";
import { ProjectWatcher } from "./watcher.js";
import type { ModifiedFile, ModelInfo, PiState } from "../shared/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MAX_OPEN_FILE_SIZE = 2 * 1024 * 1024;

const FILE_TOOLS = new Set(["write", "edit", "apply_patch", "create_file", "insert"]);

class PiEditorApp {
  private win: BrowserWindow | null = null;
  private rpc = new PiRpcClient({ bin: "pi", args: ["--mode", "rpc"], cwd: homedir() });
  private watcher: ProjectWatcher | null = null;
  private cwd: string | null = null;
  private cwdReal: string | null = null;

  private modified = new Map<string, ModifiedFile>();
  /** Files modified during the current agent run (reset on each agent_start). */
  private runModified = new Map<string, ModifiedFile>();
  private sessionStart = 0;
  private isStreaming = false;
  private models: ModelInfo[] = [];
  private levels: string[] = [];
  private currentModel: ModelInfo | null = null;
  private thinkingLevel: string | null = null;
  private sessionId: string | null = null;
  private paintWatchdog: ReturnType<typeof setInterval> | null = null;

  // ---------------------------------------------------------------- window --

  async createWindow(): Promise<void> {
    this.win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 960,
      minHeight: 600,
      title: "pi-editor",
      backgroundColor: "#1e1e1e",
      webPreferences: {
        preload: join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // required for Monaco web workers to load from file:// in packaged builds
      },
    });
    this.win.removeMenu();

    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl) {
      await this.win.loadURL(devUrl);
      // DevTools only open when explicitly requested (PI_EDITOR_DEVTOOLS=1);
      // otherwise the View menu (Alt+Cmd+I) opens them on demand.
      if (process.env.PI_EDITOR_DEVTOOLS) {
        this.win.webContents.openDevTools({ mode: "detach" });
      }
    } else {
      await this.win.loadFile(join(__dirname, "..", "dist-renderer", "index.html"));
    }
    this.win.on("closed", () => {
      this.win = null;
      this.stopPaintWatchdog();
    });
    // If the renderer crashes (GPU hiccup etc.), bring the UI back.
    this.win.webContents.on("render-process-gone", (_e, details) => {
      console.warn(`[main] renderer gone: ${details.reason}`);
      if (this.win && !this.win.isDestroyed()) {
        this.win.reload();
      }
    });
    this.startPaintWatchdog();
    this.buildMenu();
  }

  private buildMenu(): void {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: "File",
        submenu: [
          { label: "Open Folder…", accelerator: "CmdOrCtrl+O", click: () => void this.openFolder() },
          { type: "separator" },
          { label: "Close Window", accelerator: "CmdOrCtrl+W", role: "close" },
        ],
      },
      {
        label: "Session",
        submenu: [
          { label: "New Session", accelerator: "CmdOrCtrl+N", click: () => void this.newSession() },
          { label: "Abort Agent", accelerator: "CmdOrCtrl+.", click: () => void this.abort() },
          { type: "separator" },
          { label: "Clear Modified List", click: () => this.clearModified() },
        ],
      },
      {
        label: "View",
        submenu: [
          { label: "Toggle DevTools", accelerator: "Alt+Cmd+I", role: "toggleDevTools" },
          { label: "Reload", accelerator: "CmdOrCtrl+R", role: "reload" },
          { type: "separator" },
          { label: "Zoom In", role: "zoomIn" },
          { label: "Zoom Out", role: "zoomOut" },
          { label: "Reset Zoom", role: "resetZoom" },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  // ------------------------------------------------------------------- pi ----

  private resolvePiBin(): string {
    return process.env.PI_EDITOR_PI_BIN ?? "pi";
  }

  private async startPi(cwd: string): Promise<void> {
    this.stopPi();
    this.rpc = new PiRpcClient({
      bin: this.resolvePiBin(),
      args: ["--mode", "rpc"],
      cwd,
    });

    this.rpc.onEvent = (event) => this.handlePiEvent(event);
    this.rpc.onExit = (code, _signal, err) => {
      this.isStreaming = false;
      this.pushState();
      if (err) {
        this.send("pi:error", {
          message: `Could not start pi: ${err.message}\n\nInstall the pi coding agent with:\n  npm install -g @earendil-works/pi-coding-agent\nor point PI_EDITOR_PI_BIN at the pi binary.`,
        });
      } else if (code !== 0) {
        this.send("pi:error", { message: `pi exited unexpectedly (code ${code}). Use Session → New Session to restart.` });
      }
    };
    this.rpc.onStderr = (line) => this.send("pi:stderr", { line });

    try {
      await this.rpc.start();
      await this.refreshState();
    } catch (err) {
      this.send("pi:error", { message: `Failed to start pi: ${(err as Error).message}` });
    }
  }

  private stopPi(): void {
    this.rpc.stop();
  }

  private async refreshState(): Promise<void> {
    try {
      const [state, modelsResp, levelsResp] = await Promise.all([
        this.rpc.getState(),
        this.rpc.getAvailableModels(),
        this.rpc.getAvailableThinkingLevels(),
      ]);
      if (state.success && state.data) {
        const s = state.data as { model?: Record<string, unknown> | null; thinkingLevel?: string; sessionId?: string };
        this.currentModel = s.model ? this.toModelInfo(s.model) : null;
        this.thinkingLevel = s.thinkingLevel ?? null;
        this.sessionId = s.sessionId ?? null;
      }
      if (modelsResp.success && modelsResp.data) {
        this.models = modelsResp.data.models.map((m) => this.toModelInfo(m as unknown as Record<string, unknown>));
      }
      if (levelsResp.success && levelsResp.data) {
        this.levels = (levelsResp.data as { levels: string[] }).levels;
      }
    } catch {
      /* pi may be mid-restart */
    }
    this.pushState();
  }

  private toModelInfo(m: Record<string, unknown>): ModelInfo {
    return {
      id: String(m.id ?? ""),
      name: String(m.name ?? m.id ?? ""),
      provider: String(m.provider ?? ""),
    };
  }

  private pushState(): void {
    const state: PiState = {
      isStreaming: this.isStreaming,
      model: this.currentModel,
      thinkingLevel: this.thinkingLevel,
      cwd: this.cwd,
      sessionId: this.sessionId,
      models: this.models,
      levels: this.levels,
    };
    this.send("pi:state", state);
  }

  // ------------------------------------------------------------ pi events ---

  private handlePiEvent(event: Record<string, unknown>): void {
    const type = event.type as string;
    switch (type) {
      case "agent_start":
        this.isStreaming = true;
        this.sessionStart = this.sessionStart || Date.now();
        this.runModified.clear();
        this.pushState();
        break;
      case "agent_settled":
        this.isStreaming = false;
        this.pushState();
        this.send("agent:settled", {
          runFiles: [...this.runModified.values()],
          allFiles: [...this.modified.values()],
          durationMs: this.sessionStart ? Date.now() - this.sessionStart : 0,
        });
        this.sessionStart = 0;
        break;
      case "tool_execution_start": {
        const e = event as unknown as ToolExecutionStartEvent;
        if (FILE_TOOLS.has(e.toolName)) {
          const path = this.resolvePath(String(e.args.path ?? ""));
          if (path && this.withinProject(path)) {
            // The file watcher is the source of truth for created vs modified.
            this.send("tool:target", { path, relPath: this.rel(path), toolName: e.toolName });
          }
        }
        break;
      }
      case "agent_end": {
        const e = event as { willRetry?: boolean };
        if (e.willRetry) this.isStreaming = true;
        break;
      }
    }
    // Forward a slimmed-down event: the renderer only needs roles, tool names,
    // args and deltas — not the full message history or tool results.
    this.send("pi:event", this.slimEvent(event));
  }

  /** Strip heavy fields (full messages, tool results) from forwarded events. */
  private slimEvent(event: Record<string, unknown>): Record<string, unknown> {
    const type = event.type as string;
    if (type === "agent_end" || type === "turn_end") {
      const { messages, toolResults, ...rest } = event;
      void messages;
      void toolResults;
      return rest;
    }
    if (type === "message_start" || type === "message_end") {
      const msg = event.message as { role?: string } | undefined;
      return { ...event, message: msg ? { role: msg.role } : undefined };
    }
    return event;
  }

  /** Resolve possibly-relative tool paths against the project cwd. */
  private resolvePath(p: string): string {
    if (!p) return "";
    const abs = isAbsolute(p) ? p : this.cwd ? join(this.cwd, p) : p;
    return this.canonicalPath(abs);
  }

  /**
   * Canonical absolute path: resolve symlinks of the deepest *existing*
   * ancestor, re-appending the unresolved tail. This makes /tmp/… and
   * /private/tmp/… compare equal even for brand-new files in brand-new
   * directories (e.g. a write tool creating src/newdir/file.ts).
   */
  private canonicalPath(p: string): string {
    let tail = "";
    let cur = p;
    while (true) {
      try {
        const real = realpathSync(cur);
        return tail ? join(real, tail) : real;
      } catch {
        const parent = dirname(cur);
        if (parent === cur) return p; // hit the root without resolving
        tail = tail ? join(basename(cur), tail) : basename(cur);
        cur = parent;
      }
    }
  }

  private recordModified(absPath: string, status: "created" | "modified"): void {
    const p = this.canonicalPath(absPath);
    // Session list (panel): first observed status wins.
    if (!this.modified.has(p)) {
      this.modified.set(p, { path: p, relPath: this.rel(p), status });
    }
    // Run list (settled summary): only agent-driven changes count, and only
    // while the agent is actually working (user saves happen when idle).
    if (this.isStreaming && !this.runModified.has(p)) {
      this.runModified.set(p, { path: p, relPath: this.rel(p), status });
    }
  }

  private recordDeleted(absPath: string): void {
    const p = this.canonicalPath(absPath);
    this.modified.delete(p);
    this.runModified.delete(p);
    this.send("file:deleted", { path: p });
    this.send("modified:list", [...this.modified.values()]);
  }

  private withinProject(absPath: string): boolean {
    if (!this.cwdReal) return false;
    const rel = relative(this.cwdReal, this.canonicalPath(absPath));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  }

  private rel(absPath: string): string {
    const p = this.canonicalPath(absPath);
    return this.cwdReal ? relative(this.cwdReal, p) : p;
  }

  // -------------------------------------------------------------- watcher ---

  private startWatcher(cwd: string): void {
    this.watcher?.stop();
    this.watcher = new ProjectWatcher(cwd);
    this.watcher.onChange = (change) => {
      const path = this.canonicalPath(change.path);
      this.recordModified(path, change.status);
      this.send("file:changed", { ...change, path, relPath: this.rel(path) });
    };
    this.watcher.onFileTouched = (path, status) => this.recordModified(path, status);
    this.watcher.onFileDeleted = (path) => this.recordDeleted(path);
    this.watcher.start();
  }

  // -------------------------------------------------------------- actions ---

  private async openFolder(): Promise<{ cwd: string } | { cancelled: true }> {
    if (!this.win || this.win.isDestroyed()) return { cancelled: true };
    const result = await dialog.showOpenDialog(this.win, {
      title: "Open a project folder",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return { cancelled: true };
    const cwd = result.filePaths[0];
    await this.setProject(cwd, { watch: true });
    return { cwd };
  }

  private async setProject(cwd: string, opts: { watch?: boolean } = {}): Promise<void> {
    this.cwd = cwd;
    this.cwdReal = this.canonicalPath(cwd);
    this.modified.clear();
    this.runModified.clear();
    this.sessionStart = 0;
    // Only watch real project folders: watching ~ (the pre-open default)
    // would walk and FSEvents-watch the entire home directory.
    if (opts.watch !== false) this.startWatcher(cwd);
    await this.startPi(cwd);
    this.send("folder:opened", { cwd });
    this.pushState();
  }

  private async newSession(): Promise<void> {
    if (!this.rpc.isRunning) {
      if (this.cwd) await this.startPi(this.cwd);
      return;
    }
    // Clear optimistically; failures surface via pi:error.
    this.modified.clear();
    this.runModified.clear();
    this.send("modified:list", []);
    try {
      await this.rpc.newSession();
    } catch (err) {
      this.send("pi:error", { message: `Failed to start a new session: ${(err as Error).message}` });
    }
  }

  private async abort(): Promise<void> {
    try {
      await this.rpc.abort();
    } catch {
      /* ignore */
    }
  }

  private clearModified(): void {
    this.modified.clear();
    this.send("modified:list", []);
  }

  private async openFileInEditor(absPath: string): Promise<{ path: string; content: string } | { path: string; error: string }> {
    try {
      const st = await stat(absPath);
      if (!st.isFile()) {
        return { path: absPath, error: "Not a file" };
      }
      if (st.size > MAX_OPEN_FILE_SIZE) {
        return { path: absPath, error: `File is too large to open (${st.size} bytes)` };
      }
      const content = await readFile(absPath, "utf8");
      return { path: absPath, content };
    } catch (err) {
      return { path: absPath, error: (err as Error).message };
    }
  }

  // ------------------------------------------------------------------ IPC ---

  private send(channel: string, payload: unknown): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, payload);
    }
  }

  private registerIpc(): void {
    ipcMain.handle("folder:open", () => this.openFolder());
    ipcMain.handle("pi:prompt", (_e, text: string, opts?: { streamingBehavior?: "steer" | "followUp" }) => {
      if (!text.trim()) return { ok: false, error: "empty prompt" };
      if (!this.rpc.isRunning) return { ok: false, error: "pi is not running" };
      // Accept the prompt optimistically; report async failures through pi:error.
      this.rpc.prompt(text, opts).catch((err) => {
        this.send("pi:error", { message: `Failed to send prompt: ${(err as Error).message}` });
      });
      return { ok: true };
    });
    ipcMain.handle("pi:abort", () => this.abort());
    ipcMain.handle("pi:new-session", () => this.newSession());
    ipcMain.handle("pi:set-model", async (_e, provider: string, modelId: string) => {
      if (!this.rpc.isRunning) return { ok: false, error: "pi is not running" };
      try {
        const r = await this.rpc.setModel(provider, modelId);
        if (r.success) void this.refreshState();
        return { ok: r.success, error: r.error };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });
    ipcMain.handle("pi:set-thinking", async (_e, level: string) => {
      if (!this.rpc.isRunning) return { ok: false, error: "pi is not running" };
      try {
        const r = await this.rpc.setThinkingLevel(level);
        if (r.success) void this.refreshState();
        return { ok: r.success, error: r.error };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });
    ipcMain.handle("pi:get-state", () => {
      void this.refreshState();
      return this.currentState();
    });
    ipcMain.handle("pi:ui-response", (_e, id: string, payload: Record<string, unknown>) => {
      try {
        this.rpc.writeRaw({ type: "extension_ui_response", id, ...payload });
      } catch {
        /* ignore */
      }
    });
    ipcMain.handle("file:open", (_e, absPath: string) => this.openFileInEditor(absPath));
    ipcMain.handle("file:save", async (_e, absPath: string, content: string) => {
      try {
        await writeFile(absPath, content, "utf8");
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });
    ipcMain.handle("modified:get", () => [...this.modified.values()]);
    ipcMain.handle("modified:clear", () => this.clearModified());
    ipcMain.handle("app:open-external", (_e, url: string) => void shell.openExternal(url));
  }

  private currentState(): PiState {
    return {
      isStreaming: this.isStreaming,
      model: this.currentModel,
      thinkingLevel: this.thinkingLevel,
      cwd: this.cwd,
      sessionId: this.sessionId,
      models: this.models,
      levels: this.levels,
    };
  }

  // ---------------------------------------------------------------- boot ----

  async start(): Promise<void> {
    this.registerIpc();
    await this.createWindow();
    // Start with a project folder if provided (dev/testing), else home dir.
    // The home dir is NOT watched (no watcher until a real folder is opened).
    const initial = process.env.PI_EDITOR_INITIAL_CWD;
    await this.setProject(initial && existsSync(initial) ? initial : homedir(), { watch: false });
  }

  dispose(): void {
    this.watcher?.stop();
    this.stopPi();
    this.stopPaintWatchdog();
  }

  /**
   * Paint watchdog: if the window ever stops compositing (a wedged renderer or
   * GPU process turns it into a solid-color rectangle), detect it and reload.
   * The app's chrome (toolbar/statusbar/prompt bar) means a healthy frame is
   * never more than ~98% one color, so a uniform capture = not painting.
   */
  private startPaintWatchdog(): void {
    this.stopPaintWatchdog();
    let blankCount = 0;
    this.paintWatchdog = setInterval(() => {
      const win = this.win;
      if (!win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) return;
      void (async () => {
        let img: Electron.NativeImage | null = null;
        try {
          img = await Promise.race([
            win.webContents.capturePage(),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("capture timeout")), 2500)),
          ]);
        } catch {
          img = null; // capture hung/failed — treat as not painting
        }
        let uniform = img === null;
        if (img && !img.isEmpty()) {
          const { width: w, height: h } = img.getSize();
          if (w > 0 && h > 0) {
            const bitmap = img.toBitmap();
            const stride = Math.max(1, Math.floor(h / 16));
            const first = bitmap.readUInt32LE(0);
            let same = 0;
            let total = 0;
            for (let y = 0; y < h; y += stride) {
              for (let x = 0; x < w; x += stride) {
                const off = (y * w + x) * 4;
                if (bitmap.readUInt32LE(off) === first) same++;
                total++;
              }
            }
            uniform = same / total > 0.98;
          }
        }
        if (uniform) {
          blankCount++;
          if (blankCount >= 4) {
            console.warn("[main] paint watchdog: window not painting — reloading");
            win.webContents.reload();
            blankCount = 0;
          }
        } else {
          blankCount = 0;
        }
      })();
    }, 3000);
  }

  private stopPaintWatchdog(): void {
    if (this.paintWatchdog) {
      clearInterval(this.paintWatchdog);
      this.paintWatchdog = null;
    }
  }

  focusWindow(): void {
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isMinimized()) this.win.restore();
      this.win.focus();
    }
  }

  reloadWindow(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.reload();
    }
  }
}

const appState = new PiEditorApp();

// Text editor + terminal = 2D content; hardware acceleration has caused GPU
// process crashes and compositor wedges (solid-color windows) on some Macs.
// Software rendering is rock solid for this app's workload.
app.disableHardwareAcceleration();

// If the GPU process still dies, bring the compositor back via a reload.
app.on("child-process-gone", (_e, details) => {
  if (details.type === "GPU") {
    console.warn(`[main] GPU process gone (${details.reason}) — reloading window`);
    appState.reloadWindow();
  }
});

// Only one instance: a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => appState.focusWindow());
  app.whenReady().then(() => void appState.start());
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void appState.createWindow();
});

app.on("before-quit", () => {
  appState.dispose();
});