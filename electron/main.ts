/**
 * Electron main process — terminal-first architecture.
 *
 * Left side: real pi interactive TUI instances running in ptys (node-pty).
 * Right side: Monaco IDE + explorer, live-synced by the file watcher.
 * A bridge extension auto-installed into the project streams agent events
 * (tool calls, busy state) to sidecar files we tail — that powers auto-open
 * of files mid-run and the modified-files panel.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme } from "electron";
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename as fsRename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PtyTerminal } from "./pty-terminal.js";
import { SidecarEvent, SidecarTailer } from "./sidecar.js";
import { IGNORED_SEGMENTS, ProjectWatcher } from "./watcher.js";
import type {
  ExplorerEntry,
  InstanceSummary,
  ModifiedFile,
  SessionHit,
  TimelineEvent,
  VerifyInfo,
  VerifyState,
} from "../shared/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MAX_OPEN_FILE_SIZE = 2 * 1024 * 1024;
/** Timeline snapshots bigger than this are dropped (dot stays, no content). */
const MAX_SNAPSHOT_SIZE = 100_000;
/** Cap the per-terminal timeline so memory stays bounded. */
const MAX_TIMELINE_EVENTS = 400;
/** Total snapshot bytes kept per terminal — oldest content is dropped first. */
const MAX_TIMELINE_CONTENT_BYTES = 4 * 1024 * 1024;
/** A watcher change within this window after a tool event is the same action. */
const TOOL_CHANGE_DEDUP_MS = 1500;
const BRIDGE_EXTENSION = `
/**
 * pi-editor bridge extension — auto-generated, do not edit.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
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
  let planLogged = false;
  pi.on("agent_start", () => {
    planLogged = false;
    log({ t: "agent_start" });
  });
  pi.on("agent_settled", () => log({ t: "agent_settled" }));
  // Plan Board: capture the first assistant message of a run that contains
  // a task list (bullet or numbered lines).
  pi.on("message_end", (event) => {
    if (planLogged) return;
    const message = (event as { message?: { role?: string; content?: unknown } }).message;
    if (message?.role !== "assistant") return;
    // Message content is an array of parts (thinking, text) or a plain string.
    let text = "";
    const content = message.content;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
        .join("\\n");
    }
    if (!text.trim()) return;
    if (!/^\\s*(?:[-*]|\\d+[.)])\\s/m.test(text)) return;
    planLogged = true;
    log({ t: "plan", text: text.slice(0, 4000) });
  });
  // Feed the latest context files (test results, user edits) into the
  // agent's next turn.
  pi.on("before_agent_start", async () => {
    let context = "";
    for (const name of [\`verify-\${id}.md\`, \`edits-\${id}.md\`]) {
      try {
        const text = readFileSync(join(dir, name), "utf8");
        if (text) context += (context ? "\\n\\n---\\n\\n" : "") + text;
      } catch {}
    }
    if (!context) return;
    return {
      message: { customType: "pi-editor-context", content: context, display: false },
    };
  });
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

/**
 * Host agent session variables. The app's pi TUI must start clean — a pinned
 * session file or model makes the TUI crash or hang at startup.
 */
const AGENT_ENV_BLOCKLIST = new Set([
  "PI_SESSION_FILE",
  "PI_SESSION_ID",
  "PI_MODEL",
  "PI_PROVIDER",
  "PI_REASONING_LEVEL",
  "PI_CODING_AGENT",
]);

/** The environment for a pi process: the host env minus session pins. */
function cleanEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!AGENT_ENV_BLOCKLIST.has(key)) env[key] = value;
  }
  return env;
}

/** A file the user changed while no agent terminal was busy. */
interface UserEdit {
  path: string;
  relPath: string;
  status: "created" | "modified";
  /** The content before the first user change. */
  prev?: string;
  /** The latest content. */
  content: string;
  at: number;
}

/** One task on the Plan Board. */
interface PlanTask {
  text: string;
  paths: string[];
  state: "pending" | "active" | "done";
}

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
  /** Verify & Iterate: last test run attached to this terminal. */
  verify: VerifyInfo = { state: "untested", command: null, summary: null };
  /** Plan Board: the tasks of the current run. */
  plan: PlanTask[] = [];
  /** Paths this run touched, relative to the project (for task progress). */
  touched = new Set<string>();
  /** When the user sent an interrupt (\x03) into this terminal. */
  interruptedAt?: number;
  /** Session Timeline: ordered points with file snapshots. */
  timeline: TimelineEvent[] = [];
  /** Per-path content as of the last snapshot in this run (for edit math). */
  runSnapshots = new Map<string, string>();
  /** Last tool event per path (dedupe with watcher changes). */
  lastToolPath: { path: string; at: number } | null = null;
  timelineSeq = 0;

  constructor(
    id: string,
    cwd: string,
    type: "agent" | "shell",
    shellName: string | undefined,
    cmd: string,
    args: string[],
    env: Record<string, string | undefined>,
    cols: number,
    rows: number,
  ) {
    this.id = id;
    this.cwd = cwd;
    this.type = type;
    this.shellName = shellName;
    this.pty = new PtyTerminal({ id, cwd, cmd, args, env, cols, rows });
  }
}

class PiEditorApp {
  private win: BrowserWindow | null = null;
  private terminals = new Map<string, PiTerminalInstance>();
  private watcher: ProjectWatcher | null = null;
  private projectCwd: string | null = null;
  private eventsDir = process.env.PI_EDITOR_EVENTS_DIR ?? join(app.getPath("temp"), "pi-editor-events");
  private tailer = new SidecarTailer(this.eventsDir);
  private paintWatchdog: ReturnType<typeof setInterval> | null = null;
  /** In-flight verify runs: owner terminal id → worker id. */
  private verifyRuns = new Map<string, string>();
  /** Worker terminal ids (kept after the run so tabs can be labeled). */
  private verifyWorkers = new Set<string>();
  /**
   * Files the user changed while no agent terminal was busy. The agent
   * receives them on its next turn. It adapts instead of overwriting them.
   */
  private userEdits = new Map<string, UserEdit>();
  private userEditsWriteTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly USER_EDITS_MAX = 50;
  /**
   * The last watcher change per path. A single physical write can produce
   * several fs events; the duplicates must not count as fresh user edits.
   */
  private lastWatchChange = new Map<string, { content: string; at: number }>();
  private static readonly LAST_WATCH_MAX = 500;

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
          { label: "Search Sessions…", accelerator: "CmdOrCtrl+Shift+F", click: send("session-search") },
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
  private piCheckedAt = 0;

  /**
   * Whether the pi binary exists and runs. Success is cached; a FAILURE is
   * only trusted for a few seconds — a transient spawn error must not brick
   * the app for its whole lifetime. Async: the check can take seconds (pi's
   * CLI runs an update check) and must not block the main process.
   */
  private async checkPiAvailable(): Promise<boolean> {
    const now = Date.now();
    if (this.piAvailable === true) return true;
    if (this.piAvailable === false && now - this.piCheckedAt < 5000) return false;
    this.piCheckedAt = now;
    const bin = this.resolvePiBin();
    if (await this.spawnPiVersionCheck(bin)) {
      this.piAvailable = true;
      return true;
    }
    // Fallback: manual PATH scan (spawn can miss it when PATH is odd).
    const found = this.findOnPath(bin);
    if (found && found !== bin && (await this.spawnPiVersionCheck(found))) {
      this.piAvailable = true;
      return true;
    }
    this.piAvailable = false;
    return false;
  }

  /** Run `bin --version` without blocking. True when it exits with code 0. */
  private spawnPiVersionCheck(bin: string): Promise<boolean> {
    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn> | null = null;
      try {
        child = spawn(bin, ["--version"], { stdio: "ignore", env: cleanEnv() });
      } catch (err) {
        console.warn(`[main] pi check threw: ${(err as Error).message}`);
        resolve(false);
        return;
      }
      // The CLI runs an update check that can stall for many seconds.
      const timer = setTimeout(() => {
        child?.kill();
        console.warn("[main] pi check timed out after 15 s");
        resolve(false);
      }, 15000);
      child.on("error", (err) => {
        clearTimeout(timer);
        console.warn(`[main] pi check failed: ${(err as NodeJS.ErrnoException).code ?? "?"} ${err.message}`);
        resolve(false);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
  }

  private findOnPath(name: string): string | null {
    for (const dir of (process.env.PATH ?? "").split(":")) {
      if (!dir) continue;
      try {
        const candidate = join(dir, name);
        if (existsSync(candidate)) {
          accessSync(candidate, constants.X_OK);
          return candidate;
        }
      } catch {
        /* keep scanning */
      }
    }
    return null;
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
    if (type === "agent" && !(await this.checkPiAvailable())) {
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
      env = { ...cleanEnv(), PI_EDITOR_TERMINAL_ID: id, PI_EDITOR_EVENTS_DIR: this.eventsDir };
    }
    const inst = new PiTerminalInstance(id, cwd ?? this.terminalCwd(), type, shellName, cmd, [], env, 80, 24);
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

  // ------------------------------------------------------------- verify ----

  /**
   * Detect the project's test command: package.json scripts (prefer `test`,
   * then the first `test:*` script), pytest, cargo test, go test.
   */
  private detectTestCommand(cwd: string): { command: string; args: string[]; label: string } | null {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      const names = Object.keys(scripts);
      const pick = names.includes("test") ? "test" : names.find((n) => n.startsWith("test:"));
      if (pick) return { command: "npm", args: ["run", pick], label: `npm run ${pick}` };
    } catch {
      /* no package.json */
    }
    try {
      if (existsSync(join(cwd, "pytest.ini")) || (existsSync(join(cwd, "pyproject.toml")) && readFileSync(join(cwd, "pyproject.toml"), "utf8").includes("[tool.pytest"))) {
        return { command: "pytest", args: [], label: "pytest" };
      }
    } catch {
      /* unreadable */
    }
    if (existsSync(join(cwd, "cargo.toml"))) return { command: "cargo", args: ["test"], label: "cargo test" };
    if (existsSync(join(cwd, "go.mod"))) return { command: "go", args: ["test", "./..."], label: "go test ./..." };
    return null;
  }

  private async runVerify(ownerId: string): Promise<{ ok: boolean; error?: string }> {
    const owner = this.terminals.get(ownerId);
    if (!owner) return { ok: false, error: "terminal not found" };
    if (this.verifyRuns.has(ownerId)) return { ok: false, error: "a verify run is already in progress" };
    const tc = this.detectTestCommand(this.terminalCwd());
    if (!tc) return { ok: false, error: "no test command detected (looked for package.json scripts, pytest, cargo, go)" };

    // Spawn a worker shell terminal that runs the tests, visible in the UI.
    // The env is sanitized: the host session variables must not reach the
    // tests (they could spawn the pi CLI and crash it, like the agent TUI).
    const shells = detectShells();
    const shell = shells[0] ?? { path: "/bin/zsh", name: "zsh" };
    const id = `term-${++terminalSeq}`;
    let inst: PiTerminalInstance;
    try {
      inst = new PiTerminalInstance(
        id,
        this.terminalCwd(),
        "shell",
        shell.name,
        shell.path,
        ["-c", `${tc.command} ${tc.args.join(" ")}`],
        { ...cleanEnv() },
        80,
        24,
      );
    } catch (err) {
      return { ok: false, error: `could not start the test worker: ${(err as Error).message}` };
    }
    this.terminals.set(inst.id, inst);
    this.verifyWorkers.add(inst.id);
    let output = "";
    let finished = false;
    const MAX_VERIFY_MS = 10 * 60 * 1000;
    const finish = (code: number | null, how: VerifyState): void => {
      if (finished) return;
      finished = true;
      const timer = verifyTimer;
      if (timer) clearTimeout(timer);
      this.verifyRuns.delete(ownerId);
      let summary: string;
      if (how === "pass") summary = "tests green";
      else if (how === "timeout") summary = "tests timed out";
      else if (how === "cancelled") summary = "cancelled";
      else summary = "tests failing";
      owner.verify = {
        state: how,
        command: tc.label,
        summary,
        workerId: inst.id,
      };
      // A cancelled run is not a test result: the previous context file stays
      // and the agent keeps the last real outcome.
      if (how !== "cancelled") this.writeVerifyContext(ownerId, tc.label, how, code, output);
      this.send("verify:state", { terminalId: ownerId, verify: owner.verify });
      this.sendInstances();
    };
    const verifyTimer = setTimeout(() => {
      console.warn(`[main] verify worker ${inst.id} timed out after ${MAX_VERIFY_MS / 1000}s`);
      finish(null, "timeout");
      inst.pty.kill(); // onExit still fires; finish() already ran
    }, MAX_VERIFY_MS);

    inst.pty.onData = (data) => {
      this.send("pty:data", { id: inst.id, data });
      if (output.length < 200_000) output += data;
    };
    inst.pty.onExit = (code) => {
      console.log(`[main] verify worker ${inst.id} exited code=${code}`);
      this.send("pty:exit", { id: inst.id, code });
      this.terminals.delete(inst.id);
      this.verifyWorkers.delete(inst.id);
      this.tailer.stopWatching(inst.id);
      if (!finished) {
        // A shell -c process exits 0 when the pty delivers an interrupt: the
        // app's own interrupt mark is the reliable cancellation signal.
        const how: VerifyState =
          code === 0 && inst.interruptedAt !== undefined ? "cancelled" : code === 0 ? "pass" : "fail";
        finish(code, how);
      } else {
        this.sendInstances();
      }
    };

    this.verifyRuns.set(ownerId, inst.id);
    owner.verify = { state: "running", command: tc.label, summary: "running…", workerId: inst.id };
    // Instances first: the renderer must know the worker pane before the
    // running push arrives, so it can auto-activate the worker.
    this.sendInstances();
    this.send("verify:state", { terminalId: ownerId, verify: owner.verify });
    return { ok: true };
  }

  /** Write the verify result to the context file the bridge extension reads. */
  private writeVerifyContext(ownerId: string, label: string, state: VerifyState, code: number | null, output: string): void {
    try {
      mkdirSync(this.eventsDir, { recursive: true });
      const stamp = new Date().toLocaleTimeString();
      const status = state === "pass" ? "✅ PASSED" : state === "timeout" ? "⏰ TIMED OUT" : "❌ FAILED";
      const body = output.trim().slice(-6000);
      const md =
        `## Test run — \`${label}\` — ${stamp}\n\n` +
        `**Status:** ${status}${code !== null ? ` (exit code ${code})` : ""}\n\n` +
        (body ? `<details>\n<summary>Output</summary>\n\n\`\`\`text\n${body}\n\`\`\`\n</details>\n` : "");
      writeFileSync(join(this.eventsDir, `verify-${ownerId}.md`), md, "utf8");
    } catch (err) {
      console.warn(`[main] could not write verify context: ${(err as Error).message}`);
    }
  }

  // ------------------------------------------------------------ plan board --

  /** Send the current plan to the renderer. */
  private sendPlan(inst: PiTerminalInstance): void {
    this.send("plan:update", { instanceId: inst.id, tasks: inst.plan });
  }

  /** Parse markdown task lines from the plan text. At most 20 tasks. */
  private parsePlanTasks(text: string): PlanTask[] {
    const tasks: PlanTask[] = [];
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      const match = line.match(/^(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/);
      if (!match) continue;
      const body = match[1].trim();
      if (!body) continue;
      const paths: string[] = [];
      for (const token of body.split(/\s+/)) {
        const clean = token.replace(/[`.,;:!?)"']+$/g, "").replace(/^[`("']+/g, "").replace(/\/+$/, "");
        if (this.looksLikePath(clean)) paths.push(clean);
      }
      tasks.push({ text: body, paths: [...new Set(paths)].slice(0, 5), state: "pending" });
      if (tasks.length >= 20) break;
    }
    return tasks;
  }

  /** A token is a file path when it has a slash or a code extension. */
  private looksLikePath(token: string): boolean {
    if (!token || token.length > 200) return false;
    return token.includes("/") || /\.[a-zA-Z0-9]{1,5}$/.test(token);
  }

  /** A tool touched a path: mark every task that mentions it as active. */
  private updatePlanProgress(inst: PiTerminalInstance, path: string): void {
    if (inst.plan.length === 0) return;
    const rel = this.rel(path);
    let changed = false;
    for (const task of inst.plan) {
      if (task.state === "done") continue;
      const matched = task.paths.some((p) => rel === p || rel.endsWith("/" + p));
      if (matched && task.state !== "active") {
        task.state = "active";
        changed = true;
      }
    }
    if (changed) this.sendPlan(inst);
  }

  /** The run ended: a task is done when every path it mentions was touched. */
  private finalizePlan(inst: PiTerminalInstance): void {
    if (inst.plan.length === 0) return;
    for (const task of inst.plan) {
      if (task.paths.length > 0 && task.paths.every((p) => inst.touched.has(p))) {
        task.state = "done";
      }
    }
    this.sendPlan(inst);
  }

  // ------------------------------------------------------ session search ----

  /** The sessions directory name for a project path: "--" + the path with
   *  slashes replaced by dashes + "--" (pi's convention, canonical path). */
  private sanitizeSessionDir(absPath: string): string {
    const p = absPath.replace(/^\/+|\/+$/g, "");
    return "--" + p.replace(/\//g, "-") + "--";
  }

  /** Full-text search over the project's past session files. Bounded: the
   *  50 newest sessions, 2 MB per file, 50 hits, 400 chars per line. */
  private async searchSessions(query: string): Promise<SessionHit[]> {
    const cwd = this.projectCwd;
    const needle = query.trim().toLowerCase();
    if (!cwd || needle.length < 2) return [];
    const dir = join(homedir(), ".pi", "agent", "sessions", this.sanitizeSessionDir(this.canonicalPath(cwd)));
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort().reverse();
    } catch {
      return []; // no sessions for this project yet
    }
    const hits: SessionHit[] = [];
    for (const file of files.slice(0, 50)) {
      let content: string;
      try {
        const st = await stat(join(dir, file));
        if (st.size > 2 * 1024 * 1024) continue;
        content = await readFile(join(dir, file), "utf8");
      } catch {
        continue; // unreadable session — skip
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].toLowerCase().includes(needle)) continue;
        hits.push({
          sessionFile: file,
          line: i + 1,
          text: this.snippetLine(lines[i]),
          before: i > 0 ? this.snippetLine(lines[i - 1]) : "",
          after: i + 1 < lines.length ? this.snippetLine(lines[i + 1]) : "",
          ts: this.sessionTimestamp(file),
          filePath: this.resolveHitPath(lines[i]) ?? undefined,
        });
        if (hits.length >= 50) break;
      }
      if (hits.length >= 50) break;
    }
    return hits;
  }

  /** Cap a hit line so the result list stays small. */
  private snippetLine(line: string): string {
    return line.length > 400 ? line.slice(0, 400) + "…" : line;
  }

  /** The session start time from the file name (ISO prefix). */
  private sessionTimestamp(file: string): number {
    const m = file.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    if (!m) return 0;
    return new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}`).getTime();
  }

  /** The first token in a line that resolves to a file inside the project. */
  private resolveHitPath(line: string): string | null {
    if (!this.projectCwd) return null;
    const tokens = line.match(/`[^`]+`|"[^"]*"|'[^']*'|\S+/g) ?? [];
    for (const raw of tokens) {
      const token = raw.replace(/^[`"']+|[`"']+$/g, "");
      if (!token.includes("/") && !/\.[a-zA-Z0-9]{1,5}$/.test(token)) continue;
      const abs = join(this.projectCwd, token);
      if (!this.withinProject(abs)) continue;
      try {
        if (existsSync(abs)) return token;
      } catch {
        /* keep scanning */
      }
    }
    return null;
  }

  // --------------------------------------------------------- user edits ----

  /** Record a change the user made. Keep the FIRST prev so the context file
   *  shows the net change, not the last step. A later prev replaces an
   *  undefined one (the first change of a file has no cached prev). The
   *  stored content is capped: the context file never shows more than 4 KB. */
  private recordUserEdit(edit: UserEdit): void {
    // Keep prev undefined when absent: an empty string would render an empty
    // "before" block instead of no block at all.
    const capped = { ...edit, prev: edit.prev === undefined ? undefined : this.snippet(edit.prev), content: this.snippet(edit.content) };
    const existing = this.userEdits.get(capped.path);
    if (existing) {
      if (existing.prev === undefined && capped.prev !== undefined) existing.prev = capped.prev;
      existing.content = capped.content;
      existing.at = capped.at;
    } else {
      this.userEdits.set(capped.path, capped);
      if (this.userEdits.size > PiEditorApp.USER_EDITS_MAX) {
        // Evict the oldest known edit (map order is insertion order).
        const oldest = this.userEdits.keys().next().value;
        if (oldest !== undefined) this.userEdits.delete(oldest);
      }
    }
    this.scheduleUserEditsWrite();
  }

  /** Debounce the context write so a burst of edits writes once. */
  private scheduleUserEditsWrite(): void {
    if (this.userEditsWriteTimer) clearTimeout(this.userEditsWriteTimer);
    this.userEditsWriteTimer = setTimeout(() => {
      this.userEditsWriteTimer = null;
      this.writeUserEditsContext();
    }, 300);
  }

  /** Write the edits context file for every agent terminal. */
  private writeUserEditsContext(): void {
    if (this.userEdits.size === 0) return;
    try {
      mkdirSync(this.eventsDir, { recursive: true });
    } catch {
      return;
    }
    const md = this.buildUserEditsMarkdown();
    for (const inst of this.terminals.values()) {
      if (inst.type !== "agent") continue;
      try {
        writeFileSync(join(this.eventsDir, `edits-${inst.id}.md`), md, "utf8");
      } catch (err) {
        console.warn(`[main] could not write edits context: ${(err as Error).message}`);
      }
    }
  }

  /** Build the context markdown: one section per file with before/after. */
  private buildUserEditsMarkdown(): string {
    // The whole context must stay small: it is injected into the model's
    // context on every turn. Drop the OLDEST edits beyond the cap (the map
    // iterates in insertion order).
    const MAX_CONTEXT_BYTES = 16 * 1024;
    const out: string[] = [];
    out.push("## Your edits");
    out.push("");
    out.push("You changed these files after the last agent run. Read them before you change them.");
    let size = out.join("\n").length;
    for (const edit of this.userEdits.values()) {
      const block: string[] = [];
      block.push("", `- \`${edit.relPath}\` (${edit.status})`);
      if (edit.status === "modified" && edit.prev !== undefined) {
        block.push("", "  before:", "  ```text");
        for (const line of this.snippet(edit.prev).split("\n")) block.push("  " + line);
        block.push("  ```");
      }
      block.push("", "  after:", "  ```text");
      for (const line of this.snippet(edit.content).split("\n")) block.push("  " + line);
      block.push("  ```");
      const blockText = block.join("\n");
      if (size + blockText.length > MAX_CONTEXT_BYTES) break;
      size += blockText.length;
      out.push(blockText);
    }
    return out.join("\n");
  }

  /** Cap the snippet: 30 lines and 4000 chars keep the context file small. */
  private snippet(content: string): string {
    const out = content.split("\n").slice(0, 30).join("\n");
    return out.length > 4000 ? out.slice(0, 4000) + "\n…" : out;
  }

  /** The run consumes the edits context. Clear it and the files. */
  private clearUserEdits(): void {
    this.userEdits.clear();
    if (this.userEditsWriteTimer) {
      clearTimeout(this.userEditsWriteTimer);
      this.userEditsWriteTimer = null;
    }
    this.removeUserEditsFiles();
  }

  /** Remove the edits context files for every agent terminal. */
  private removeUserEditsFiles(): void {
    for (const inst of this.terminals.values()) {
      if (inst.type !== "agent") continue;
      try {
        rmSync(join(this.eventsDir, `edits-${inst.id}.md`), { force: true });
      } catch {
        /* ignore */
      }
    }
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

  private instanceList(): InstanceSummary[] {
    return [...this.terminals.values()].map((t) => ({
      id: t.id,
      cwd: t.cwd,
      busy: t.busy,
      type: t.type,
      shellName: t.shellName,
      verifyWorker: this.verifyWorkers.has(t.id),
      verify: t.type === "agent" ? t.verify : null,
    }));
  }

  private sendInstances(): void {
    this.send("instances:list", this.instanceList());
  }

  // -------------------------------------------------------------- sidecar ---

  private handleSidecarEvent(terminalId: string, event: SidecarEvent): void {
    const inst = this.terminals.get(terminalId);
    if (!inst) return;
    switch (event.t) {
      case "agent_start":
        inst.busy = true;
        // The run consumes the user-edits context (the extension already read
        // it in before_agent_start). Clear it so the next run stays fresh.
        this.clearUserEdits();
        // The old run's plan is stale until the new plan message arrives.
        inst.plan = [];
        inst.touched = new Set();
        this.sendPlan(inst);
        // Baseline for Change Review: snapshot the watcher's content cache so
        // diffs compare the run's start state against the current files.
        inst.baselines = new Map(this.watcher?.lastContents ?? []);
        inst.runSnapshots = new Map();
        inst.lastToolPath = null;
        this.pushTimeline(inst, { t: "agent_start" });
        this.send("busy", { instanceId: inst.id, busy: true });
        this.sendInstances();
        break;
      case "agent_settled":
        inst.busy = false;
        this.finalizePlan(inst);
        this.pushTimeline(inst, { t: "agent_settled" });
        this.send("busy", { instanceId: inst.id, busy: false });
        this.send("modified:list", { instanceId: inst.id, files: [...inst.modified.values()] });
        this.sendInstances();
        break;
      case "plan": {
        const text = String(event.text ?? "");
        inst.plan = this.parsePlanTasks(text);
        // touched was reset at agent_start. Do not reset it here: the plan
        // message can arrive after the first tool events, and their progress
        // must count.
        this.sendPlan(inst);
        break;
      }
      case "tool": {
        const rawPath = String(event.path ?? "");
        const path = this.resolvePath(rawPath);
        if (!path || !this.withinProject(path)) return;
        const toolName = String(event.toolName ?? "");
        // Pre-run baseline capture. The rules:
        // - agent_start snapshots the watcher cache (best source when present).
        // - edit/apply_patch reconstruct from the edit args — correct in both
        //   poll orderings (landed or not). They also recover a null baseline
        //   poisoned by a first-touch write that had no cached prev.
        // - write/create_file defer to the watcher change event, which knows
        //   the authoritative status and carries prev when available.
        if (toolName === "edit" || toolName === "apply_patch") {
          const current = inst.baselines.get(path);
          if (current === undefined) {
            const status = inst.modified.get(path)?.status;
            if (status !== "created") {
              inst.baselines.set(path, this.reconstructBaseline(path, event.edits) ?? this.watcher?.lastContents.get(path) ?? null);
            }
            // A file created this run stays undefined; the change event sets null.
          } else if (current === null && inst.modified.get(path)?.status === "modified") {
            inst.baselines.set(path, this.reconstructBaseline(path, event.edits) ?? null);
          }
        }
        this.recordModified(inst, path, toolName === "write" ? this.classifyWrite(path) : "modified");
        inst.touched.add(this.rel(path));
        this.updatePlanProgress(inst, path);
        this.send("tool:target", { path, relPath: this.rel(path), toolName });
        // Session Timeline: snapshot the file as of this tool call. The event
        // object is created first so a delayed content fill can find it later.
        const ev: Omit<TimelineEvent, "seq" | "ts"> = { t: "tool", toolName, path, relPath: this.rel(path) };
        const snapshot = this.toolSnapshot(inst, path, toolName, event.edits, ev);
        if (snapshot?.content !== undefined) ev.content = snapshot.content;
        if (snapshot?.status) ev.status = snapshot.status;
        this.pushTimeline(inst, ev);
        break;
      }
    }
  }

  /**
   * Compute the file's content right after a tool call:
   * - edit/apply_patch: apply the edit regions to the previously known content
   * - write/create_file: the watcher cache (the change event usually lands
   *   around the same poll; if not, a delayed fill attaches it later)
   * The event object is passed so the delayed fill can locate it by reference
   * even if newer events arrive in between.
   */
  private toolSnapshot(
    inst: PiTerminalInstance,
    path: string,
    toolName: string,
    edits: unknown,
    ev: Omit<TimelineEvent, "seq" | "ts">,
  ): { content?: string; status?: "created" | "modified" } {
    const status = toolName === "write" ? this.classifyWrite(path) : "modified";
    // Dedupe with the imminent watcher change — set in EVERY branch so the
    // write-without-cache path also claims the change event.
    inst.lastToolPath = { path, at: Date.now() };
    if (toolName === "edit" || toolName === "apply_patch") {
      const base = inst.runSnapshots.get(path) ?? this.preRunContent(inst, path) ?? "";
      const content = this.applyEdits(base, edits);
      inst.runSnapshots.set(path, content);
      return content.length > MAX_SNAPSHOT_SIZE ? { status } : { content, status };
    }
    // write / create_file: prefer the watcher cache, else fill in shortly after.
    const cached = this.watcher?.lastContents.get(path);
    if (cached !== undefined) {
      inst.runSnapshots.set(path, cached);
      return cached.length > MAX_SNAPSHOT_SIZE ? { status } : { content: cached, status };
    }
    // The write may not have landed in the watcher cache yet — retry shortly,
    // addressing the event by reference (the tail may have moved on). Content
    // stays main-side; the renderer fetches it on click.
    setTimeout(() => {
      const fresh = this.watcher?.lastContents.get(path);
      if (fresh === undefined) return;
      const idx = inst.timeline.indexOf(ev as TimelineEvent);
      if (idx === -1) return; // dropped by the cap or terminal gone
      const target = inst.timeline[idx];
      target.content = fresh.length > MAX_SNAPSHOT_SIZE ? undefined : fresh;
      target.status = status;
      inst.runSnapshots.set(path, fresh);
    }, 400);
    return { status };
  }

  /** Content of a path before this run's first touch (baseline or cache). */
  private preRunContent(inst: PiTerminalInstance, path: string): string | null | undefined {
    const b = inst.baselines.get(path);
    if (b !== undefined) return b;
    return this.watcher?.lastContents.get(path);
  }

  /** Apply edit regions forward (first occurrence, matching the edit tool). */
  private applyEdits(base: string, edits: unknown): string {
    let out = base;
    const list = Array.isArray(edits) ? (edits as Array<{ oldText?: string; newText?: string }>) : [];
    for (const e of list) {
      const oldText = e.oldText ?? "";
      if (!oldText) continue;
      const idx = out.indexOf(oldText);
      if (idx === -1) continue;
      out = out.slice(0, idx) + (e.newText ?? "") + out.slice(idx + oldText.length);
    }
    return out;
  }

  /** Append a timeline point, keep caps, push a CONTENT-FREE event to the
   *  renderer (snapshots are fetched on demand when a dot is clicked, so the
   *  strip and IPC stay light). */
  private pushTimeline(inst: PiTerminalInstance, ev: Omit<TimelineEvent, "seq" | "ts">): void {
    const event: TimelineEvent = { seq: ++inst.timelineSeq, ...ev, ts: Date.now() };
    inst.timeline.push(event);
    if (inst.timeline.length > MAX_TIMELINE_EVENTS) inst.timeline.splice(0, inst.timeline.length - MAX_TIMELINE_EVENTS);
    this.trimTimelineContent(inst);
    const { content: _content, ...pub } = event;
    this.send("timeline:event", { terminalId: inst.id, event: pub });
  }

  /** Keep snapshot memory bounded per terminal: drop content from the OLDEST
   *  events first (the dots remain; clicking them explains why). */
  private trimTimelineContent(inst: PiTerminalInstance): void {
    let bytes = 0;
    for (const e of inst.timeline) bytes += e.content?.length ?? 0;
    if (bytes <= MAX_TIMELINE_CONTENT_BYTES) return;
    for (const e of inst.timeline) {
      if (bytes <= MAX_TIMELINE_CONTENT_BYTES) break;
      if (e.content !== undefined) {
        bytes -= e.content.length;
        e.content = undefined;
      }
    }
  }

  private contentSizeOk(content: string | undefined): boolean {
    return content !== undefined && content.length <= MAX_SNAPSHOT_SIZE;
  }

  private classifyWrite(path: string): "created" | "modified" {
    return existsSync(path) ? "modified" : "created";
  }

  /**
   * Best-effort pre-edit baseline: read the file and undo the edit regions
   * (oldText/newText from the tool call) in reverse order. Only edits that
   * have ACTUALLY landed on disk are reversed — the sidecar event fires at
   * tool start, and if the write hasn't happened yet the disk content IS the
   * pre-run content (reversing it would double-reverse and corrupt the
   * baseline). Falls back to null (no baseline) when the file can't be read.
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
        if (newText && !base.includes(newText)) continue; // not landed yet — keep as-is
        base = base.split(newText).join(oldText);
      }
      return base;
    } catch {
      return null;
    }
  }

  private recordModified(inst: PiTerminalInstance, absPath: string, status: "created" | "modified"): void {
    const p = this.canonicalPath(absPath);
    const existing = inst.modified.get(p);
    if (existing) {
      // The watcher status is authoritative: it knows whether the file
      // existed before the first change it ever saw for this path.
      existing.status = status;
    } else {
      inst.modified.set(p, { path: p, relPath: this.rel(p), status });
    }
  }

  private recordDeleted(inst: PiTerminalInstance, absPath: string): void {
    const p = this.canonicalPath(absPath);
    const baseline = inst.baselines.get(p);
    if (baseline !== undefined && baseline !== null) {
      // A pre-existing file was deleted and a baseline can restore it: keep
      // the entry so the user can revert.
      const entry = inst.modified.get(p);
      if (entry) {
        entry.status = "deleted";
      } else {
        inst.modified.set(p, { path: p, relPath: this.rel(p), status: "deleted" });
      }
    } else {
      // Nothing to restore (created this run, or no baseline): drop the entry.
      inst.modified.delete(p);
    }
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
    // A folder switch starts a fresh context: agent terminals move to the new
    // folder and ALL per-run state is reset (timeline, review baselines,
    // snapshots, modified list, verify). Shell terminals keep their cwd —
    // they are real shells still running in their original directory.
    for (const inst of this.terminals.values()) {
      if (inst.type !== "agent") continue;
      inst.cwd = cwd;
      inst.timeline = [];
      inst.timelineSeq = 0;
      inst.runSnapshots = new Map();
      inst.baselines = new Map();
      inst.modified = new Map();
      inst.lastToolPath = null;
      inst.verify = { state: "untested", command: null, summary: null };
      inst.plan = [];
      inst.touched = new Set();
    }
    this.clearUserEdits();
    this.sendInstances();
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
    this.watcher = new ProjectWatcher(cwd, (p) => this.canonicalPath(p));
    this.watcher.onChange = (change) => {
      const path = this.canonicalPath(change.path);
      const relPath = this.rel(path);
      const now = Date.now();
      // Dedupe duplicate fs events for the same physical write (same content,
      // recent). A duplicate that lands after the run settled must not appear
      // as a fresh user edit.
      const cappedContent = change.content.length > 4000 ? change.content.slice(0, 4000) : change.content;
      // macOS can deliver a duplicate fs event seconds late (under load). The
      // window must outlive that delay, or the duplicate re-records an edit
      // the run already consumed.
      const lastWatch = this.lastWatchChange.get(path);
      const isDupWatch = lastWatch !== undefined && lastWatch.content === cappedContent && now - lastWatch.at < 5000;
      // Cap the stored content: the dedupe only compares equality within 2 s.
      this.lastWatchChange.set(path, { content: cappedContent, at: now });
      if (this.lastWatchChange.size > PiEditorApp.LAST_WATCH_MAX) {
        const oldest = this.lastWatchChange.keys().next().value;
        if (oldest !== undefined) this.lastWatchChange.delete(oldest);
      }
      // A change with no busy agent terminal belongs to the user — unless a
      // verify run is in flight: test outputs (snapshots, coverage,
      // fixtures) are automated writes, not user edits. The agent receives
      // user edits on its next turn (see the edits-<id>.md context file).
      const agentBusy = [...this.terminals.values()].some((t) => t.busy);
      if (!isDupWatch && !agentBusy && this.verifyRuns.size === 0) {
        this.recordUserEdit({ path, relPath, status: change.status, prev: change.prev, content: change.content, at: now });
      }
      // The watcher change event is the baseline authority for writes: it
      // carries the pre-change content, captured atomically before the cache
      // update. This is correct no matter which poll (sidecar vs watcher)
      // processed first — the tool event itself never sets write baselines.
      // A modified file without prev (first touch) stays UNDEFINED: reverting
      // refuses instead of deleting a file that existed pre-run.
      for (const inst of this.terminals.values()) {
        if (!inst.busy || inst.baselines.has(path)) continue;
        if (change.status === "created") {
          inst.baselines.set(path, null);
        } else if (change.prev !== undefined) {
          inst.baselines.set(path, change.prev);
        }
      }
      // Attribute the change: the terminal whose recent tool event touched
      // this path owns it (attach the authoritative disk content to its tool
      // point — no extra dot). If nobody claims it (bash-driven or external),
      // broadcast a change point to every busy terminal.
      const owners: PiTerminalInstance[] = [];
      const unowned: PiTerminalInstance[] = [];
      for (const inst of this.terminals.values()) {
        if (!inst.busy) continue;
        const mine = inst.lastToolPath && inst.lastToolPath.path === path && now - inst.lastToolPath.at < TOOL_CHANGE_DEDUP_MS;
        (mine ? owners : unowned).push(inst);
      }
      if (owners.length > 0) {
        for (const inst of owners) {
          this.recordModified(inst, path, change.status);
          const last = inst.timeline.at(-1);
          if (last && last.t === "tool" && last.path === path && this.contentSizeOk(change.content)) {
            last.content = change.content;
            inst.runSnapshots.set(path, change.content);
          }
        }
      } else {
        for (const inst of unowned) {
          this.recordModified(inst, path, change.status);
          const content = this.contentSizeOk(change.content) ? change.content : undefined;
          // Bash-driven changes are the ground truth for later edit math.
          if (content !== undefined) inst.runSnapshots.set(path, content);
          // Burst throttle: a build writing the same file repeatedly is one
          // moment — refresh the last change point instead of adding dots.
          const last = inst.timeline.at(-1);
          if (last && last.t === "change" && last.path === path && now - (last.ts ?? 0) < 800) {
            if (content !== undefined) last.content = content;
            last.ts = now;
          } else {
            this.pushTimeline(inst, { t: "change", path, relPath, content, status: change.status });
          }
        }
      }
      this.send("file:changed", { ...change, path, relPath });
    };
    this.watcher.onFileTouched = (path, status) => {
      for (const inst of this.terminals.values()) {
        if (inst.busy) this.recordModified(inst, path, status);
      }
    };
    this.watcher.onFileDeleted = (path) => {
      const p = this.canonicalPath(path);
      this.send("file:deleted", { path: p });
      for (const inst of this.terminals.values()) this.recordDeleted(inst, path);
      // A user-side deletion makes the recorded edit moot: drop the entry so
      // the context never points at a file that no longer exists. An empty
      // map must remove the file itself — the writer skips empty maps.
      const agentBusy = [...this.terminals.values()].some((t) => t.busy);
      if (!agentBusy && this.userEdits.delete(p)) {
        if (this.userEdits.size === 0) this.removeUserEditsFiles();
        else this.scheduleUserEditsWrite();
      }
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
    ipcMain.handle("app:pi-status", async () => {
      const available = await this.checkPiAvailable();
      return { available, bin: this.resolvePiBin(), message: available ? undefined : this.piMissingMessage() };
    });
    ipcMain.handle("terminals:close", (_e, id: string) => this.closeTerminal(id));
    ipcMain.handle("terminals:write", (_e, id: string, data: string) => {
      const inst = this.terminals.get(id);
      if (!inst) return;
      if (String(data).includes("\x03")) inst.interruptedAt = Date.now();
      inst.pty.write(String(data));
    });
    ipcMain.handle("terminals:resize", (_e, id: string, cols: number, rows: number) => {
      this.terminals.get(id)?.pty.resize(Math.max(2, Math.floor(cols)), Math.max(2, Math.floor(rows)));
    });
    ipcMain.handle("terminals:list", () => {
      this.sendInstances();
      return this.instanceList();
    });
    ipcMain.handle("terminals:abort", (_e, id: string) => {
      const inst = this.terminals.get(id);
      if (!inst) return;
      inst.interruptedAt = Date.now();
      inst.pty.write("\x03");
    });

    // ---- Verify & Iterate ----
    ipcMain.handle("verify:detect", () => this.detectTestCommand(this.terminalCwd()));
    ipcMain.handle("verify:run", (_e, terminalId: string) => this.runVerify(terminalId));

    // ---- Session Search ----
    ipcMain.handle("session:search", (_e, query: string) => this.searchSessions(query));

    // ---- Plan Board ----
    ipcMain.handle("plan:get", (_e, terminalId: string) => this.terminals.get(terminalId)?.plan ?? []);

    // ---- Session Timeline ----
    ipcMain.handle("timeline:get", (_e, terminalId: string) => {
      const tl = this.terminals.get(terminalId)?.timeline ?? [];
      return tl.map(({ content: _content, ...pub }) => pub);
    });
    ipcMain.handle("timeline:content", (_e, terminalId: string, seq: number) => {
      const inst = this.terminals.get(terminalId);
      const ev = inst?.timeline.find((e) => e.seq === seq);
      if (!ev) return { ok: false, seq };
      if (ev.content === undefined) return { ok: false, seq, path: ev.path, relPath: ev.relPath };
      return { ok: true, seq, path: ev.path, relPath: ev.relPath, content: ev.content, ts: ev.ts, toolName: ev.toolName };
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
    // Set the project BEFORE the window loads: the renderer queries the
    // project (test detection, cwd) as soon as it boots, and terminalCwd()
    // must already point at the real folder — otherwise it answers with the
    // home directory and the Verify button stays disabled forever.
    const initial = process.env.PI_EDITOR_INITIAL_CWD;
    this.projectCwd = initial && existsSync(initial) ? initial : null;
    this.tailer.onEvent = (id, event) => this.handleSidecarEvent(id, event);
    this.tailer.start();
    await this.createWindow();
    if (this.projectCwd) {
      this.installBridgeExtension(this.projectCwd);
      this.startWatcher(this.projectCwd);
    }
    // Create the agent terminal. A transient pi failure (slow start, update
    // check) must not kill the app: retry with backoff. The renderer shows
    // the friendly install message when every attempt fails.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.createTerminal();
        break;
      } catch (err) {
        console.warn(`[main] terminal creation failed (attempt ${attempt}/3): ${(err as Error).message}`);
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 4000));
      }
    }
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
    let healthy = false;
    let lastCheck = 0;
    this.paintWatchdog = setInterval(() => {
      const win = this.win;
      if (!win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) return;
      // The FOUC risk is a startup problem: check every 3 s until the window
      // paints real content once. After that, only check every 15 s as a net
      // for a stalled renderer.
      const cadence = healthy ? 15000 : 3000;
      const now = Date.now();
      if (now - lastCheck < cadence) return;
      lastCheck = now;
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
          // Downscale before sampling: a full-window bitmap is megabytes; a
          // 64x40 sample (2560 pixels) carries the same uniform-vs-content
          // signal for a fraction of the allocation cost.
          const small = img.resize({ width: 64, height: 40 });
          const { width: w, height: h } = small.getSize();
          if (w > 0 && h > 0) {
            const bitmap = small.toBitmap();
            const first = bitmap.readUInt32LE(0);
            let same = 0;
            for (let off = 0; off < bitmap.length; off += 4) {
              if (bitmap.readUInt32LE(off) === first) same++;
            }
            uniform = same / (bitmap.length / 4) > 0.98;
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
          healthy = true;
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