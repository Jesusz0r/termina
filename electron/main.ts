/**
 * Electron main process.
 *
 * Owns:
 *  - multiple isolated pi agent instances (RPC mode, JSONL over stdio), each
 *    with its own model, session and modified-files tracking
 *  - the project file watcher that feeds the shared live editor
 *  - IPC to the renderer (Monaco + xterm UI)
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from "electron";
import { existsSync, realpathSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PiRpcClient, type ToolExecutionStartEvent } from "./rpc-client.js";
import { ProjectWatcher } from "./watcher.js";
import type { InstanceSummary, ModifiedFile, ModelInfo, PiState } from "../shared/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MAX_OPEN_FILE_SIZE = 2 * 1024 * 1024;

const FILE_TOOLS = new Set(["write", "edit", "apply_patch", "create_file", "insert"]);

let instanceSeq = 0;

/** One isolated agent: its own pi process, model and modified-files tracking. */
class AgentInstance {
  id = `inst-${++instanceSeq}`;
  rpc: PiRpcClient;
  cwd: string;
  modified = new Map<string, ModifiedFile>();
  runModified = new Map<string, ModifiedFile>();
  isStreaming = false;
  models: ModelInfo[] = [];
  levels: string[] = [];
  currentModel: ModelInfo | null = null;
  thinkingLevel: string | null = null;
  sessionId: string | null = null;
  sessionStart = 0;

  constructor(cwd: string, bin: string) {
    this.cwd = cwd;
    this.rpc = new PiRpcClient({ bin, args: ["--mode", "rpc"], cwd });
  }

  get state(): PiState {
    return {
      instanceId: this.id,
      isStreaming: this.isStreaming,
      model: this.currentModel,
      thinkingLevel: this.thinkingLevel,
      cwd: this.cwd,
      sessionId: this.sessionId,
      models: this.models,
      levels: this.levels,
      hasProject: this.cwd !== homedir(),
    };
  }
}

class PiEditorApp {
  private win: BrowserWindow | null = null;
  private instances = new Map<string, AgentInstance>();
  private watcher: ProjectWatcher | null = null;
  private projectCwd: string | null = null;
  private paintWatchdog: ReturnType<typeof setInterval> | null = null;

  // ---------------------------------------------------------------- window --

  async createWindow(): Promise<void> {
    // The app is dark-themed; force dark mode so the native title bar, dialogs
    // and scrollbars match instead of rendering a white strip in Light Mode.
    nativeTheme.themeSource = "dark";
    this.win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 960,
      minHeight: 600,
      title: "pi-editor",
      backgroundColor: "#1e1e1e",
      // Inset title bar: traffic lights overlay the toolbar (VS Code style)
      // instead of a separate light band above the app content.
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 12 },
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
        label: "Terminal",
        submenu: [
          { label: "New Terminal", accelerator: "CmdOrCtrl+Shift+T", click: () => void this.createInstance() },
          { label: "New Session", accelerator: "CmdOrCtrl+N", click: () => void this.newSessionForActive() },
          { label: "Abort Agent", accelerator: "CmdOrCtrl+.", click: () => void this.abortActive() },
          { type: "separator" },
          { label: "Clear Modified List", click: () => this.clearModifiedForActive() },
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

  // ------------------------------------------------------------- instances --

  private resolvePiBin(): string {
    return process.env.PI_EDITOR_PI_BIN ?? "pi";
  }

  private instanceCwd(): string {
    return this.projectCwd ?? homedir();
  }

  /** Spawn a new isolated agent instance; lands on the current project folder. */
  async createInstance(cwd?: string): Promise<AgentInstance> {
    const inst = new AgentInstance(cwd ?? this.instanceCwd(), this.resolvePiBin());

    inst.rpc.onEvent = (event) => this.handlePiEvent(inst, event);
    inst.rpc.onExit = (code, _signal, err, intentional) => {
      inst.isStreaming = false;
      this.pushState(inst);
      if (err) {
        this.send("pi:error", {
          instanceId: inst.id,
          message: `Could not start pi: ${err.message}\n\nInstall the pi coding agent with:\n  npm install -g @earendil-works/pi-coding-agent\nor point PI_EDITOR_PI_BIN at the pi binary.`,
        });
      } else if (code !== 0 && !intentional) {
        this.send("pi:error", { instanceId: inst.id, message: `pi exited unexpectedly (code ${code}). Use Session → New Session to restart.` });
      }
    };
    inst.rpc.onStderr = (line) => this.send("pi:stderr", { instanceId: inst.id, line });

    this.instances.set(inst.id, inst);
    try {
      await inst.rpc.start();
      await this.refreshState(inst);
    } catch (err) {
      this.send("pi:error", { instanceId: inst.id, message: `Failed to start pi: ${(err as Error).message}` });
    }
    this.sendInstances();
    return inst;
  }

  async closeInstance(id: string): Promise<void> {
    const inst = this.instances.get(id);
    if (!inst) return;
    inst.rpc.stop();
    this.instances.delete(id);
    this.sendInstances();
  }

  private instanceOf(id: string): AgentInstance | undefined {
    return this.instances.get(id);
  }

  private sendInstances(): void {
    const list: InstanceSummary[] = [...this.instances.values()].map((i) => ({
      id: i.id,
      cwd: i.cwd,
      model: i.currentModel ? `${i.currentModel.name} (${i.currentModel.provider})` : null,
      isStreaming: i.isStreaming,
      modifiedCount: i.modified.size,
    }));
    this.send("instances:list", list);
  }

  private async refreshState(inst: AgentInstance): Promise<void> {
    try {
      const [state, modelsResp, levelsResp] = await Promise.all([
        inst.rpc.getState(),
        inst.rpc.getAvailableModels(),
        inst.rpc.getAvailableThinkingLevels(),
      ]);
      if (state.success && state.data) {
        const s = state.data as { model?: Record<string, unknown> | null; thinkingLevel?: string; sessionId?: string };
        inst.currentModel = s.model ? this.toModelInfo(s.model) : null;
        inst.thinkingLevel = s.thinkingLevel ?? null;
        inst.sessionId = s.sessionId ?? null;
      }
      if (modelsResp.success && modelsResp.data) {
        inst.models = modelsResp.data.models.map((m) => this.toModelInfo(m as unknown as Record<string, unknown>));
      }
      if (levelsResp.success && levelsResp.data) {
        inst.levels = (levelsResp.data as { levels: string[] }).levels;
      }
    } catch {
      /* pi may be mid-restart */
    }
    this.pushState(inst);
  }

  private toModelInfo(m: Record<string, unknown>): ModelInfo {
    return {
      id: String(m.id ?? ""),
      name: String(m.name ?? m.id ?? ""),
      provider: String(m.provider ?? ""),
    };
  }

  private pushState(inst: AgentInstance): void {
    this.send("pi:state", inst.state);
  }

  // ------------------------------------------------------------ pi events ---

  private handlePiEvent(inst: AgentInstance, event: Record<string, unknown>): void {
    const type = event.type as string;
    switch (type) {
      case "agent_start":
        inst.isStreaming = true;
        inst.sessionStart = inst.sessionStart || Date.now();
        inst.runModified.clear();
        this.pushState(inst);
        this.sendInstances();
        break;
      case "agent_settled":
        inst.isStreaming = false;
        this.pushState(inst);
        this.send("agent:settled", {
          instanceId: inst.id,
          runFiles: [...inst.runModified.values()],
          allFiles: [...inst.modified.values()],
          durationMs: inst.sessionStart ? Date.now() - inst.sessionStart : 0,
        });
        inst.sessionStart = 0;
        this.sendInstances();
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
        if (e.willRetry) inst.isStreaming = true;
        break;
      }
    }
    // Forward a slimmed-down event: the renderer only needs roles, tool names,
    // args and deltas — not the full message history or tool results.
    this.send("pi:event", { instanceId: inst.id, ...this.slimEvent(event) });
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
    const abs = isAbsolute(p) ? p : this.projectCwd ? join(this.projectCwd, p) : p;
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

  private recordModified(inst: AgentInstance, absPath: string, status: "created" | "modified"): void {
    const p = this.canonicalPath(absPath);
    // Session list (panel): first observed status wins.
    if (!inst.modified.has(p)) {
      inst.modified.set(p, { path: p, relPath: this.rel(p), status });
    }
    // Run list (settled summary): only agent-driven changes count, and only
    // while the agent is actually working (user saves happen when idle).
    if (inst.isStreaming && !inst.runModified.has(p)) {
      inst.runModified.set(p, { path: p, relPath: this.rel(p), status });
    }
  }

  private recordDeleted(inst: AgentInstance, absPath: string): void {
    const p = this.canonicalPath(absPath);
    inst.modified.delete(p);
    inst.runModified.delete(p);
    this.send("file:deleted", { path: p });
    this.send("modified:list", { instanceId: inst.id, files: [...inst.modified.values()] });
  }

  private withinProject(absPath: string): boolean {
    if (!this.projectCwd) return false;
    const rel = relative(this.canonicalPath(this.projectCwd), this.canonicalPath(absPath));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  }

  private rel(absPath: string): string {
    const p = this.canonicalPath(absPath);
    return this.projectCwd ? relative(this.canonicalPath(this.projectCwd), p) : p;
  }

  // -------------------------------------------------------------- watcher ---

  private startWatcher(cwd: string): void {
    this.watcher?.stop();
    this.watcher = new ProjectWatcher(cwd);
    this.watcher.onChange = (change) => {
      const path = this.canonicalPath(change.path);
      // Attribute disk changes to every instance that is currently working.
      for (const inst of this.instances.values()) {
        this.recordModified(inst, path, change.status);
      }
      this.send("file:changed", { ...change, path, relPath: this.rel(path) });
    };
    this.watcher.onFileTouched = (path, status) => {
      for (const inst of this.instances.values()) {
        this.recordModified(inst, path, status);
      }
    };
    this.watcher.onFileDeleted = (path) => {
      for (const inst of this.instances.values()) {
        this.recordDeleted(inst, path);
      }
    };
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
    this.projectCwd = cwd;
    this.startWatcher(cwd);
    this.send("folder:opened", { cwd });
    return { cwd };
  }

  private async newSessionForActive(): Promise<void> {
    // The renderer drives the active instance; here we act on the most recent.
    const inst = [...this.instances.values()].at(-1);
    if (inst) await this.newSession(inst.id);
  }

  private async newSession(id: string): Promise<void> {
    const inst = this.instanceOf(id);
    if (!inst) return;
    if (!inst.rpc.isRunning) {
      await this.createInstance(inst.cwd);
      return;
    }
    // Clear optimistically; failures surface via pi:error.
    inst.modified.clear();
    inst.runModified.clear();
    this.send("modified:list", { instanceId: inst.id, files: [] });
    try {
      await inst.rpc.newSession();
    } catch (err) {
      this.send("pi:error", { instanceId: inst.id, message: `Failed to start a new session: ${(err as Error).message}` });
    }
  }

  private async abortActive(): Promise<void> {
    const inst = [...this.instances.values()].at(-1);
    if (inst) await this.abort(inst.id);
  }

  private async abort(id: string): Promise<void> {
    const inst = this.instanceOf(id);
    if (!inst) return;
    try {
      await inst.rpc.abort();
    } catch {
      /* ignore */
    }
  }

  private clearModifiedForActive(): void {
    const inst = [...this.instances.values()].at(-1);
    if (inst) this.clearModified(inst.id);
  }

  private clearModified(id: string): void {
    const inst = this.instanceOf(id);
    if (!inst) return;
    inst.modified.clear();
    this.send("modified:list", { instanceId: inst.id, files: [] });
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
    ipcMain.handle("instances:create", () => this.createInstance().then((i) => ({ id: i.id })));
    ipcMain.handle("instances:close", (_e, id: string) => this.closeInstance(id));
    ipcMain.handle("instances:list", () => {
      this.sendInstances();
      return [...this.instances.values()].map((i) => ({
        id: i.id,
        cwd: i.cwd,
        model: i.currentModel ? `${i.currentModel.name} (${i.currentModel.provider})` : null,
        isStreaming: i.isStreaming,
        modifiedCount: i.modified.size,
      }));
    });

    ipcMain.handle("pi:prompt", (_e, instanceId: string, text: string, opts?: { streamingBehavior?: "steer" | "followUp" }) => {
      const inst = this.instanceOf(instanceId);
      if (!inst) return { ok: false, error: "instance not found" };
      if (!text.trim()) return { ok: false, error: "empty prompt" };
      if (!inst.rpc.isRunning) return { ok: false, error: "pi is not running" };
      // Accept the prompt optimistically; report async failures through pi:error.
      inst.rpc.prompt(text, opts).catch((err) => {
        this.send("pi:error", { instanceId: inst.id, message: `Failed to send prompt: ${(err as Error).message}` });
      });
      return { ok: true };
    });
    ipcMain.handle("pi:abort", (_e, instanceId: string) => this.abort(instanceId));
    ipcMain.handle("pi:new-session", (_e, instanceId: string) => this.newSession(instanceId));
    ipcMain.handle("pi:set-model", async (_e, instanceId: string, provider: string, modelId: string) => {
      const inst = this.instanceOf(instanceId);
      if (!inst) return { ok: false, error: "instance not found" };
      if (!inst.rpc.isRunning) return { ok: false, error: "pi is not running" };
      try {
        const r = await inst.rpc.setModel(provider, modelId);
        if (r.success) void this.refreshState(inst);
        return { ok: r.success, error: r.error };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });
    ipcMain.handle("pi:set-thinking", async (_e, instanceId: string, level: string) => {
      const inst = this.instanceOf(instanceId);
      if (!inst) return { ok: false, error: "instance not found" };
      if (!inst.rpc.isRunning) return { ok: false, error: "pi is not running" };
      try {
        const r = await inst.rpc.setThinkingLevel(level);
        if (r.success) void this.refreshState(inst);
        return { ok: r.success, error: r.error };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });
    ipcMain.handle("pi:get-state", (_e, instanceId: string) => {
      const inst = this.instanceOf(instanceId);
      if (!inst) return null;
      void this.refreshState(inst);
      return inst.state;
    });
    ipcMain.handle("pi:ui-response", (_e, instanceId: string, id: string, payload: Record<string, unknown>) => {
      const inst = this.instanceOf(instanceId);
      if (!inst) return;
      try {
        inst.rpc.writeRaw({ type: "extension_ui_response", id, ...payload });
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
    ipcMain.handle("modified:get", (_e, instanceId: string) => {
      const inst = this.instanceOf(instanceId);
      return inst ? [...inst.modified.values()] : [];
    });
    ipcMain.handle("modified:clear", (_e, instanceId: string) => this.clearModified(instanceId));
    ipcMain.handle("app:open-external", (_e, url: string) => void shell.openExternal(url));
  }

  // ---------------------------------------------------------------- boot ----

  async start(): Promise<void> {
    this.registerIpc();
    await this.createWindow();
    // Start with a project folder if provided (dev/testing), else home dir.
    const initial = process.env.PI_EDITOR_INITIAL_CWD;
    this.projectCwd = initial && existsSync(initial) ? initial : null;
    if (this.projectCwd) this.startWatcher(this.projectCwd);
    await this.createInstance();
  }

  dispose(): void {
    this.watcher?.stop();
    for (const inst of this.instances.values()) inst.rpc.stop();
    this.instances.clear();
    this.stopPaintWatchdog();
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