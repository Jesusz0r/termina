/**
 * Electron main process — terminal-first architecture.
 *
 * Left side: real pi interactive TUI instances running in ptys (node-pty).
 * Right side: Monaco IDE + explorer, live-synced by the file watcher.
 * A bridge extension auto-installed into the project streams agent events
 * (tool calls, busy state) to sidecar files we tail — that powers auto-open
 * of files mid-run and the modified-files panel.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from "electron";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename as fsRename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PtyTerminal } from "./pty-terminal.js";
import { SidecarTailer } from "./sidecar.js";
import { IGNORED_SEGMENTS, ProjectWatcher } from "./watcher.js";
import type { ExplorerEntry, InstanceSummary, ModifiedFile } from "../shared/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MAX_OPEN_FILE_SIZE = 2 * 1024 * 1024;
const FILE_TOOLS = new Set(["write", "edit", "apply_patch", "create_file", "insert"]);
const BRIDGE_EXTENSION = `
/**
 * pi-editor bridge extension — auto-generated, do not edit.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FILE_TOOLS = new Set(["write", "edit", "apply_patch", "create_file", "insert"]);

export default function (pi: ExtensionAPI): void {
  const dir = process.env.PI_EDITOR_EVENTS_DIR;
  const id = process.env.PI_EDITOR_TERMINAL_ID;
  if (!dir || !id) return;
  const log = (event: Record<string, unknown>): void => {
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, id + ".jsonl"), JSON.stringify(event) + "\\n");
    } catch {}
  };
  pi.on("agent_start", () => log({ t: "agent_start" }));
  pi.on("agent_settled", () => log({ t: "agent_settled" }));
  pi.on("tool_execution_start", async (event) => {
    if (!FILE_TOOLS.has(event.toolName)) return;
    const args = (event.args ?? {}) as { path?: unknown; edits?: unknown };
    if (typeof args.path === "string" && args.path) {
      log({
        t: "tool",
        toolName: event.toolName,
        path: args.path,
        edits: event.toolName === "edit" || event.toolName === "apply_patch" ? args.edits : undefined,
      });
    }
  });
}
`;

let terminalSeq = 0;

function detectShells(): { name: string; path: string }[] {
  const candidates: Array<[string, string]> = [
    ["zsh", "/bin/zsh"],
    ["bash", "/bin/bash"],
    ["sh", "/bin/sh"],
    ["fish", "/opt/homebrew/bin/fish"],
    ["fish", "/usr/local/bin/fish"],
    ["fish", "/usr/bin/fish"],
  ];
  const out: { name: string; path: string }[] = [];
  for (const [name, path] of candidates) {
    if (existsSync(path) && !out.some((s) => s.name === name)) out.push({ name, path });
  }
  return out;
}

class PiTerminalInstance {
  readonly id: string;
  pty: PtyTerminal;
  cwd: string;
  type: "agent" | "shell";
  shellName?: string;
  busy = false;
  modified = new Map<string, ModifiedFile>();
  /** Pre-run content per path (Change Review): string = baseline, null = created. */
  baselines = new Map<string, string | null>();

  constructor(id: string, cwd: string, type: "agent" | "shell", shellName: string | undefined, cmd: string, env: Record<string, string | undefined>, cols: number, rows: number) {
    this.id = id;
    this.cwd = cwd;
    this.type = type;
    this.shellName = shellName;
    this.pty = new PtyTerminal({ id, cwd, cmd, args: [], env, cols, rows });
  }
}

class PiEditorApp {
  private win: BrowserWindow | null = null;
  private terminals = new Map<string, PiTerminalInstance>();
  private watcher: ProjectWatcher | null = null;
  private projectCwd: string | null = null;
  private eventsDir = join(app.getPath("temp"), "pi-editor-events");
  private tailer = new SidecarTailer(this.eventsDir);
  private paintWatchdog: ReturnType<typeof setInterval> | null = null;

  // ---------------------------------------------------------------- window --

  async createWindow(): Promise<void> {
    nativeTheme.themeSource = "dark";
    this.win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 960,
      minHeight: 600,
      title: "pi-editor",
      backgroundColor: "#1e1e1e",
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 12 },
      webPreferences: {
        preload: join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    this.win.removeMenu();

    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl) {
      await this.win.loadURL(devUrl);
      if (process.env.PI_EDITOR_DEVTOOLS) this.win.webContents.openDevTools({ mode: "detach" });
    } else {
      await this.win.loadFile(join(__dirname, "..", "dist-renderer", "index.html"));
    }
    this.win.on("closed", () => {
      this.win = null;
      this.stopPaintWatchdog();
    });
    this.win.webContents.on("render-process-gone", (_e, details) => {
      console.warn(`[main] renderer gone: ${details.reason}`);
      if (this.win && !this.win.isDestroyed()) this.win.reload();
    });
    this.startPaintWatchdog();
    this.buildMenu();
  }

  private buildMenu(): void {
    const send = (command: string) => () => this.send("menu:command", { command });
    const template: Electron.MenuItemConstructorOptions[] = [
      { role: "appMenu" },
      {
        label: "File",
        submenu: [
          { label: "Open Folder…", accelerator: "CmdOrCtrl+O", click: () => void this.openFolder() },
          { type: "separator" },
          { label: "New File…", accelerator: "CmdOrCtrl+Alt+N", click: send("new-file") },
          { label: "New Folder…", accelerator: "CmdOrCtrl+Alt+Shift+N", click: send("new-folder") },
          { label: "Rename…", accelerator: "F2", click: send("rename") },
          { label: "Delete…", click: send("delete") },
          { type: "separator" },
          { label: "Refresh Explorer", click: send("refresh") },
          { type: "separator" },
          { label: "Close Window", accelerator: "CmdOrCtrl+W", role: "close" },
        ],
      },
      {
        label: "Terminal",
        submenu: [
          { label: "New Terminal", accelerator: "CmdOrCtrl+Shift+T", click: () => void this.createTerminal() },
          { label: "Close Terminal", accelerator: "CmdOrCtrl+Shift+W", click: () => void this.closeActiveTerminal() },
          { type: "separator" },
          { label: "Send Ctrl+C (abort)", accelerator: "CmdOrCtrl+.", click: () => void this.abortActive() },
        ],
      },
      {
        label: "View",
        submenu: [
          {
            label: "Layout",
            submenu: [
              { label: "Terminal Left", click: send("layout-terminal-left") },
              { label: "Terminal Right", click: send("layout-terminal-right") },
              { label: "Terminal Top", click: send("layout-terminal-top") },
              { label: "Terminal Bottom", click: send("layout-terminal-bottom") },
              { type: "separator" },
              { label: "Terminal Fullscreen", accelerator: "CmdOrCtrl+Shift+F", click: send("layout-terminal-fullscreen") },
            ],
          },
          { label: "Toggle Explorer", accelerator: "CmdOrCtrl+B", click: send("toggle-explorer") },
          { label: "Toggle Editor", accelerator: "CmdOrCtrl+E", click: send("toggle-editor") },
          { label: "Toggle Modified Panel", click: send("toggle-modified") },
          { type: "separator" },
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

  // ------------------------------------------------------------- terminals --

  private resolvePiBin(): string {
    return process.env.PI_EDITOR_PI_BIN ?? "pi";
  }

  private piAvailable: boolean | null = null;

  /** Whether the pi binary exists and runs. Cached; shells never need this. */
  private checkPiAvailable(): boolean {
    if (this.piAvailable !== null) return this.piAvailable;
    try {
      const r = spawnSync(this.resolvePiBin(), ["--version"], { stdio: "ignore", timeout: 5000 });
      this.piAvailable = r.error === undefined && r.status === 0;
    } catch {
      this.piAvailable = false;
    }
    return this.piAvailable;
  }

  private piMissingMessage(): string {
    return (
      "pi is not installed.\n\nInstall it with:\n  npm install -g @earendil-works/pi-coding-agent\n\nor set PI_EDITOR_PI_BIN to the pi binary path."
    );
  }

  private terminalCwd(): string {
    return this.projectCwd ?? homedir();
  }

  private async createTerminal(cwd?: string, opts?: { type?: "agent" | "shell"; shell?: string }): Promise<PiTerminalInstance> {
    const type = opts?.type ?? "agent";
    if (type === "agent" && !this.checkPiAvailable()) {
      throw new Error(this.piMissingMessage());
    }
    const id = `term-${++terminalSeq}`;
    let cmd: string;
    let shellName: string | undefined;
    let env: Record<string, string | undefined>;
    if (type === "shell") {
      const shells = detectShells();
      const chosen = opts?.shell && existsSync(opts.shell) ? { path: opts.shell, name: basename(opts.shell) } : shells[0] ?? { path: "/bin/zsh", name: "zsh" };
      cmd = chosen.path;
      shellName = chosen.name;
      env = { ...process.env };
    } else {
      cmd = this.resolvePiBin();
      env = { ...process.env, PI_EDITOR_TERMINAL_ID: id, PI_EDITOR_EVENTS_DIR: this.eventsDir };
    }
    const inst = new PiTerminalInstance(id, cwd ?? this.terminalCwd(), type, shellName, cmd, env, 80, 24);
    this.terminals.set(inst.id, inst);

    inst.pty.onData = (data) => this.send("pty:data", { id: inst.id, data });
    inst.pty.onExit = (code) => {
      console.log(`[main] terminal ${inst.id} (${inst.type}) exited code=${code}`);
      this.send("pty:exit", { id: inst.id, code });
      this.terminals.delete(inst.id);
      this.tailer.stopWatching(inst.id);
      this.sendInstances();
    };

    this.tailer.watch(inst.id);
    this.sendInstances();
    return inst;
  }

  private closeTerminal(id: string): void {
    const inst = this.terminals.get(id);
    if (!inst) return;
    inst.pty.kill();
    // pty.onExit removes it from the map
  }

  private closeActiveTerminal(): void {
    const inst = [...this.terminals.values()].at(-1);
    if (inst) this.closeTerminal(inst.id);
  }

  private async abortActive(): Promise<void> {
    const inst = [...this.terminals.values()].at(-1);
    if (inst) inst.pty.write("\x03");
  }

  private sendInstances(): void {
    const list: InstanceSummary[] = [...this.terminals.values()].map((t) => ({
      id: t.id,
      cwd: t.cwd,
      busy: t.busy,
      type: t.type,
      shellName: t.shellName,
    }));
    this.send("instances:list", list);
  }

  // -------------------------------------------------------------- sidecar ---

  private handleSidecarEvent(terminalId: string, event: { t: string; toolName?: string; path?: string; edits?: unknown }): void {
    const inst = this.terminals.get(terminalId);
    if (!inst) return;
    switch (event.t) {
      case "agent_start":
        inst.busy = true;
        // Baseline for Change Review: snapshot the watcher's content cache so
        // diffs compare the run's start state against the current files.
        inst.baselines = new Map(this.watcher?.lastContents ?? []);
        this.send("busy", { instanceId: inst.id, busy: true });
        this.sendInstances();
        break;
      case "agent_settled":
        inst.busy = false;
        this.send("busy", { instanceId: inst.id, busy: false });
        this.send("modified:list", { instanceId: inst.id, files: [...inst.modified.values()] });
        this.sendInstances();
        break;
      case "tool": {
        const rawPath = String(event.path ?? "");
        const path = this.resolvePath(rawPath);
        if (!path || !this.withinProject(path)) return;
        const toolName = String(event.toolName ?? "");
        // Capture the pre-run content for files the agent edits.
        if (!inst.baselines.has(path)) {
          if (toolName === "edit" || toolName === "apply_patch") {
            const cached = this.watcher?.lastContents.get(path);
            if (cached !== undefined) {
              inst.baselines.set(path, cached);
            } else {
              inst.baselines.set(path, this.reconstructBaseline(path, event.edits));
            }
          } else {
            inst.baselines.set(path, null); // write/create → treated as created
          }
        }
        this.recordModified(inst, path, toolName === "write" ? this.classifyWrite(path) : "modified");
        this.send("tool:target", { path, relPath: this.rel(path), toolName });
        break;
      }
    }
  }

  private classifyWrite(path: string): "created" | "modified" {
    return existsSync(path) ? "modified" : "created";
  }

  /**
   * Best-effort pre-edit baseline: read the file and undo the edit regions
   * (oldText/newText from the tool call) in reverse order. Falls back to null
   * (no baseline) when the file can't be read.
   */
  private reconstructBaseline(path: string, edits: unknown): string | null {
    try {
      const content = readFileSync(path, "utf8");
      const list = Array.isArray(edits) ? (edits as Array<{ oldText?: string; newText?: string }>) : [];
      let base = content;
      for (let i = list.length - 1; i >= 0; i--) {
        const oldText = list[i]?.oldText ?? "";
        const newText = list[i]?.newText ?? "";
        if (!oldText && !newText) continue;
        base = base.split(newText).join(oldText);
      }
      return base;
    } catch {
      return null;
    }
  }

  private recordModified(inst: PiTerminalInstance, absPath: string, status: "created" | "modified"): void {
    const p = this.canonicalPath(absPath);
    if (!inst.modified.has(p)) {
      inst.modified.set(p, { path: p, relPath: this.rel(p), status });
    }
  }

  private recordDeleted(inst: PiTerminalInstance, absPath: string): void {
    inst.modified.delete(this.canonicalPath(absPath));
    this.send("modified:list", { instanceId: inst.id, files: [...inst.modified.values()] });
  }

  // ------------------------------------------------------------- project -----

  private async openFolder(): Promise<{ cwd: string } | { cancelled: true }> {
    if (!this.win || this.win.isDestroyed()) return { cancelled: true };
    const result = await dialog.showOpenDialog(this.win, {
      title: "Open a project folder",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return { cancelled: true };
    const cwd = result.filePaths[0];
    this.projectCwd = cwd;
    this.installBridgeExtension(cwd);
    this.startWatcher(cwd);
    this.send("folder:opened", { cwd });
    return { cwd };
  }

  /** Install (or refresh) the bridge extension in the project. */
  private installBridgeExtension(cwd: string): void {
    try {
      const dir = join(cwd, ".pi", "extensions");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "pi-editor-bridge.ts"), BRIDGE_EXTENSION, "utf8");
    } catch (err) {
      console.warn(`[main] could not install bridge extension: ${(err as Error).message}`);
    }
  }

  // -------------------------------------------------------------- watcher ---

  private startWatcher(cwd: string): void {
    this.watcher?.stop();
    this.watcher = new ProjectWatcher(cwd);
    this.watcher.onChange = (change) => {
      const path = this.canonicalPath(change.path);
      for (const inst of this.terminals.values()) {
        if (inst.busy) this.recordModified(inst, path, change.status);
      }
      this.send("file:changed", { ...change, path, relPath: this.rel(path) });
    };
    this.watcher.onFileTouched = (path, status) => {
      for (const inst of this.terminals.values()) {
        if (inst.busy) this.recordModified(inst, path, status);
      }
    };
    this.watcher.onFileDeleted = (path) => {
      this.send("file:deleted", { path: this.canonicalPath(path) });
      for (const inst of this.terminals.values()) this.recordDeleted(inst, path);
    };
    this.watcher.start();
  }

  // ---------------------------------------------------------------- paths ---

  private resolvePath(p: string): string {
    if (!p) return "";
    const abs = isAbsolute(p) ? p : this.projectCwd ? join(this.projectCwd, p) : p;
    return this.canonicalPath(abs);
  }

  private canonicalPath(p: string): string {
    let tail = "";
    let cur = p;
    while (true) {
      try {
        const real = realpathSync(cur);
        return tail ? join(real, tail) : real;
      } catch {
        const parent = dirname(cur);
        if (parent === cur) return p;
        tail = tail ? join(basename(cur), tail) : basename(cur);
        cur = parent;
      }
    }
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

  private projectAbs(relPath: string): string {
    const cwd = this.projectCwd;
    if (!cwd) throw new Error("open a project folder first");
    const abs = isAbsolute(relPath) ? relPath : join(cwd, relPath);
    if (!this.withinProject(abs)) throw new Error(`path outside project: ${relPath}`);
    return abs;
  }

  private async listDir(absPath: string): Promise<{ entries: ExplorerEntry[]; error?: string }> {
    try {
      const dirents = await readdir(absPath, { withFileTypes: true });
      const entries: ExplorerEntry[] = [];
      for (const ent of dirents) {
        if (IGNORED_SEGMENTS.has(ent.name) || ent.name.startsWith(".")) continue;
        const full = join(absPath, ent.name);
        entries.push({
          name: ent.name,
          path: full,
          relPath: this.projectCwd ? relative(this.projectCwd, full) : full,
          type: ent.isDirectory() ? "dir" : "file",
        });
      }
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });
      return { entries };
    } catch (err) {
      return { entries: [], error: (err as Error).message };
    }
  }

  // ------------------------------------------------------------------ IPC ---

  private send(channel: string, payload: unknown): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  private registerIpc(): void {
    ipcMain.handle("folder:open", () => this.openFolder());

    ipcMain.handle("terminals:create", async (_e, opts?: { type?: "agent" | "shell"; shell?: string }) => {
      try {
        const t = await this.createTerminal(undefined, opts);
        return { id: t.id };
      } catch (err) {
        return { error: (err as Error).message };
      }
    });
    ipcMain.handle("terminals:shells", () => detectShells());
    ipcMain.handle("app:pi-status", () => {
      const available = this.checkPiAvailable();
      return { available, bin: this.resolvePiBin(), message: available ? undefined : this.piMissingMessage() };
    });
    ipcMain.handle("terminals:close", (_e, id: string) => this.closeTerminal(id));
    ipcMain.handle("terminals:write", (_e, id: string, data: string) => {
      this.terminals.get(id)?.pty.write(String(data));
    });
    ipcMain.handle("terminals:resize", (_e, id: string, cols: number, rows: number) => {
      this.terminals.get(id)?.pty.resize(Math.max(2, Math.floor(cols)), Math.max(2, Math.floor(rows)));
    });
    ipcMain.handle("terminals:list", () => {
      this.sendInstances();
      return [...this.terminals.values()].map((t) => ({ id: t.id, cwd: t.cwd, busy: t.busy, type: t.type, shellName: t.shellName }));
    });
    ipcMain.handle("terminals:abort", (_e, id: string) => {
      this.terminals.get(id)?.pty.write("\x03");
    });

    // ---- Change Review ----
    ipcMain.handle("review:baseline", (_e, terminalId: string, path: string) => {
      const inst = this.terminals.get(terminalId);
      const p = this.canonicalPath(path);
      const b = inst?.baselines.get(p);
      if (b === undefined) return { status: "modified", baseline: null }; // not captured
      if (b === null) return { status: "created", baseline: null };
      return { status: "modified", baseline: b };
    });
    ipcMain.handle("review:revert", async (_e, terminalId: string, path: string) => {
      const inst = this.terminals.get(terminalId);
      if (!inst) return { ok: false, error: "terminal not found" };
      const p = this.canonicalPath(path);
      const b = inst.baselines.get(p);
      if (b === undefined) return { ok: false, error: "no baseline captured for this file" };
      try {
        if (b === null) {
          await rm(p, { force: true }); // the agent created it → delete
        } else {
          await writeFile(p, b, "utf8");
        }
        inst.baselines.delete(p);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
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

    ipcMain.handle("explorer:list-dir", (_e, absPath: string) => this.listDir(absPath));
    ipcMain.handle("explorer:create", async (_e, relPath: string, kind: "file" | "dir") => {
      try {
        const abs = this.projectAbs(relPath);
        if (kind === "dir") {
          await mkdir(abs, { recursive: true });
        } else {
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, "", "utf8");
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });
    ipcMain.handle("explorer:rename", async (_e, relPath: string, newName: string) => {
      try {
        if (!newName || newName.includes("/") || newName === "." || newName === "..") {
          return { ok: false, error: "invalid name" };
        }
        const abs = this.projectAbs(relPath);
        await fsRename(abs, join(dirname(abs), newName));
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });
    ipcMain.handle("explorer:delete", async (_e, relPath: string) => {
      try {
        const abs = this.projectAbs(relPath);
        await rm(abs, { recursive: true, force: true });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });
  }

  private async openFileInEditor(absPath: string): Promise<{ path: string; content: string } | { path: string; error: string }> {
    try {
      const st = await stat(absPath);
      if (!st.isFile()) return { path: absPath, error: "Not a file" };
      if (st.size > MAX_OPEN_FILE_SIZE) return { path: absPath, error: `File is too large to open (${st.size} bytes)` };
      const content = await readFile(absPath, "utf8");
      return { path: absPath, content };
    } catch (err) {
      return { path: absPath, error: (err as Error).message };
    }
  }

  // ---------------------------------------------------------------- boot ----

  async start(): Promise<void> {
    this.registerIpc();
    this.tailer.onEvent = (id, event) => this.handleSidecarEvent(id, event);
    this.tailer.start();
    await this.createWindow();
    const initial = process.env.PI_EDITOR_INITIAL_CWD;
    this.projectCwd = initial && existsSync(initial) ? initial : null;
    if (this.projectCwd) {
      this.installBridgeExtension(this.projectCwd);
      this.startWatcher(this.projectCwd);
    }
    await this.createTerminal();
  }

  dispose(): void {
    this.tailer.stop();
    this.watcher?.stop();
    for (const inst of this.terminals.values()) inst.pty.kill();
    this.terminals.clear();
    this.stopPaintWatchdog();
  }

  focusWindow(): void {
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isMinimized()) this.win.restore();
      this.win.focus();
    }
  }

  reloadWindow(): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.reload();
  }

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
          img = null;
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

app.disableHardwareAcceleration();

app.on("child-process-gone", (_e, details) => {
  if (details.type === "GPU") {
    console.warn(`[main] GPU process gone (${details.reason}) — reloading window`);
    appState.reloadWindow();
  }
});

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