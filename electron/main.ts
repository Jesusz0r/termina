/**
 * Electron main process — terminal-first architecture.
 *
 * Left side: real pi interactive TUI instances running in ptys (node-pty).
 * Right side: Monaco IDE + explorer, live-synced by the file watcher.
 * An app-owned bridge extension streams agent events (tool calls, busy
 * state) to sidecar files we tail — that powers auto-open of files
 * mid-run and the modified-files panel.
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme } from "electron";

// Name the app for the macOS menu bar and user-data paths. Unpackaged runs default to "Electron".
app.setName("Termina");
import { execFile, spawn } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { access, chmod, cp, copyFile, mkdir, mkdtemp, readFile, readdir, realpath as fsRealpath, rename as fsRename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionForkClient } from "./session-fork.js";
import { PtyTerminal } from "./pty-terminal.js";
import { BRIDGE_EXTENSION } from "./bridge-extension.js";
import { AgentStartEvent, SidecarEvent, SidecarTailer } from "./sidecar.js";
import { IGNORED_SEGMENTS, ProjectWatcher } from "./watcher.js";
import { SnapshotStore, MIN_WORLDS_FREE_BYTES, captureRootInRepo, freeDiskBytes, gitCommonDir, gitHead, gitObjectFormat, gitTopLevel, platformHasRecursiveWatcher, platformHasSandboxExec, type SourceState } from "./worldline-git.js";
import { WorldlineManager, dirBytes, quoteShellArg, recoverPromotionJournals, type RunRecord } from "./worldlines.js";
import { sandboxShellPreamble, writeEvidenceProfile } from "./sandbox.js";
import { parseFailingTests, verifyFailSummary } from "./evidence.js";
import { coreClient } from "./core-client.js";
import { changedLinesInAfter } from "../shared/line-diff.js";
import { createAppUpdater, updateMenuCopy, type AppUpdateController } from "./app-update.js";
import {
  MAX_DISPATCH_WORKERS,
  findTaskByText,
  finalizePlanTasks,
  formatDispatchBriefing,
  markPlanProgress,
  parsePlanTasks,
  pickDispatchTasks,
  reattachDispatchAssignments,
  taskIsComplete,
} from "./plan-board.js";
import { AppPreferencesStore } from "./preferences.js";
import { listSessionJsonl, mergeSessionFiles, searchSessionFiles, sessionFileEntry, type SessionFileEntry } from "./session-search.js";
import { appendPendingImages, MAX_PENDING_IMAGES, pendingImageState } from "../agent-core/host.js";
import {
  isAuthorizedDropSender,
  normalizeDroppedPaths,
  quotePosixPaths,
  readDroppedImages,
  validatePathDropTargets,
} from "./terminal-drop.js";
import {
  composeTerminalRoster,
  isCoreSessionId,
  isRosterSessionId,
  MAX_ROSTER_BYTES,
  MAX_TERMINAL_ROSTER,
  parseTerminalRoster,
  type TerminalRosterEntry,
} from "./terminal-roster.js";
import { normalizeAppPreferences, normalizeUserPreferencePatch, sanitizeShortcutMap } from "../shared/preferences.js";
import { HIDE_THINKING_CSI, SHOW_THINKING_CSI, thinkingStartupArgs } from "../shared/terminal-control.js";
import {
  DEFAULT_SHORTCUTS,
  defaultAppPreferences,
  type AppPreferences,
  type CommandId,
  type ExplorerEntry,
  type InstanceSummary,
  type ModifiedFile,
  type PlanTask,
  type RecorderState,
  type SessionHit,
  type ShortcutCommand,
  type ShortcutMap,
  type TerminalPasteResult,
  type ThemeId,
  type TimelineEvent,
  type TimelinePrefix,
  type TimelineProgress,
  type VerifyInfo,
  type VerifyState,
} from "../shared/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MAX_OPEN_FILE_SIZE = 2 * 1024 * 1024;
const MAX_PROMPT_BYTES = 20 * 1024 * 1024;
const MAX_PI_RESOURCE_BYTES = 200 * 1024 * 1024;
/** Bound for ~/.pi/agent/auth.json when checking whether a provider exists. */
const MAX_AUTH_JSON_BYTES = 128 * 1024;
const MAX_PTY_IPC_CHUNK = 64 * 1024;
const MAX_CLIPBOARD_BYTES = 4 * 1024 * 1024;
const MAX_EXPLORER_ENTRIES = 2000;
const MAX_VERIFY_OUTPUT = 200_000;
/** Timeline snapshots bigger than this are dropped (dot stays, no content). */
const MAX_SNAPSHOT_SIZE = 100_000;
/** file:changed pushes the content only up to this byte budget. The
 *  renderer fetches larger files on demand. */
const MAX_LIVE_SYNC_BYTES = 256 * 1024;
/** Cap the per-terminal timeline so memory stays bounded. */
const MAX_TIMELINE_EVENTS = 400;
/** Total snapshot bytes kept per terminal — oldest content is dropped first. */
const MAX_TIMELINE_CONTENT_BYTES = 4 * 1024 * 1024;
/** A watcher change within this window after a tool event is the same action. */
const TOOL_CHANGE_DEDUP_MS = 1500;
/** Unowned disk writes (installs, builds, tests) inside this window refresh
 *  the last change dot instead of adding one per file. */
const CHANGE_BURST_MS = 2000;

let terminalSeq = 0;
let workspaceSeq = 0;
let projectSeq = 0;

/** One source tree the app controls (WORLDLINES §6.2). */
interface WorkspaceState {
  id: string;
  root: string;
  /** True for the opened project; false for worldline candidates. */
  primary: boolean;
  /** The comparison that owns a candidate workspace. */
  comparisonId?: string;
  /** Bumped on every watcher-observed content change. */
  generation: number;
  /** The id of the current write-lease holder, or null. */
  writerId: string | null;
  watcher: ProjectWatcher | null;
  terminalIds: Set<string>;
  /** The last captured state commit (the lineage parent). */
  lastStateCommit: string | null;
  /** New retained blob bytes since the index (WORLDLINES §9). */
  retainedBlobBytes: number;
  /** Resolves when the initial index capture finished. */
  indexReady: Promise<void> | null;
  /** Why recording is unavailable, when it is. */
  recordError: string | null;
  /** Last watcher transition per path as 1-based changed lines. The editor
   *  paints these on open, so highlights do not depend on tab history. */
  changeLines: Map<string, number[]>;
}

/** A start preflight waiting for agent_start to consume its token. */
interface PendingPreflight {
  requestId: string;
  token: string;
  terminalId: string;
  workspaceId: string;
  startState: SourceState | null;
  generation: number;
  leaseRequester: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  /** The trust-sensitive resource hashes at preflight time (§6.7). */
  trustHashes: Record<string, string> | null;
}

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
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "TERMINA_CORE_SESSION_FILE",
  "TERMINA_CORE_SESSION_ID",
  "TERMINA_CORE_RESUME",
]);

/** The environment for a pi process: the host env minus session pins. */
function cleanEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!AGENT_ENV_BLOCKLIST.has(key)) env[key] = value;
  }
  // The packaged bundle ships its own node for pi. Put it first on PATH so
  // the cli.js shebang and pi's own child processes resolve it.
  const bundledNode = join(process.resourcesPath, "node", "bin");
  if (existsSync(bundledNode)) {
    env.PATH = `${bundledNode}${env.PATH ? `:${env.PATH}` : ""}`;
  }
  // Termina launches a pinned pi package. The TUI update check would tell
  // the user to upgrade, but that command cannot change the pin.
  env.PI_SKIP_VERSION_CHECK = "1";
  return env;
}

/** Values pi accepts for --thinking. Reject anything else at spawn. */
const PI_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MAX_PI_MODEL_CHARS = 256;

/** One background process that runs a test command. */
interface VerifyJob {
  child: ReturnType<typeof spawn>;
  interrupted: boolean;
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

function capUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= maxBytes ? text : bytes.subarray(0, maxBytes).toString("utf8");
}

function isFlushResult(value: unknown): value is { ok: boolean; failed: string[] } {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as { ok?: unknown; failed?: unknown };
  return typeof rec.ok === "boolean" && Array.isArray(rec.failed) && rec.failed.every((item) => typeof item === "string");
}

let shellsPromise: Promise<{ name: string; path: string }[]> | null = null;

function detectShells(): Promise<{ name: string; path: string }[]> {
  if (shellsPromise) return shellsPromise;
  const candidates: Array<[string, string]> = [
    ["zsh", "/bin/zsh"],
    ["bash", "/bin/bash"],
    ["sh", "/bin/sh"],
    ["fish", "/opt/homebrew/bin/fish"],
    ["fish", "/usr/local/bin/fish"],
    ["fish", "/usr/bin/fish"],
  ];
  shellsPromise = Promise.all(
    candidates.map(async ([name, path]) => {
      try {
        await access(path);
        return { name, path };
      } catch {
        return null;
      }
    }),
  ).then((found) => {
    const out: { name: string; path: string }[] = [];
    for (const item of found) {
      if (item && !out.some((s) => s.name === item.name)) out.push(item);
    }
    return out;
  });
  return shellsPromise;
}

class PiTerminalInstance {
  readonly id: string;
  pty: PtyTerminal;
  cwd: string;
  /** The workspace this terminal works in (empty when no folder is open). */
  workspaceId: string;
  /** The project that owns this terminal, or null. */
  projectId: string | null = null;
  type: "agent" | "shell";
  /** The engine for an agent terminal. Shells leave this unset. */
  engine?: "pi" | "core";
  /** Persist this tab in the project roster (user terminals, not dispatch or candidates). */
  persist = true;
  /** Harness session id for resume. */
  sessionId: string | null = null;
  /** Absolute session file used to resume this harness. */
  sessionFile: string | null = null;
  /** The live model of this agent, provider-qualified when known. */
  model: string | null = null;
  /** The live thinking level of this agent. */
  thinkingLevel: string | null = null;
  shellName?: string;
  /** Absolute shell binary, for roster resume. */
  shellPath?: string;
  busy = false;
  modified = new Map<string, ModifiedFile>();
  /** Pre-run content per path (Change Review): string = baseline, null = created. */
  baselines = new Map<string, string | null>();
  baselineBytes = 0;
  /** In-flight lazy baseline captures per path (Change Review waits for them). */
  baselineFills = new Map<string, Promise<void>>();
  /** Verify & Iterate: last test run attached to this terminal. */
  verify: VerifyInfo = { state: "untested", command: null, summary: null };
  /** Plan Board: the tasks of the current run. */
  plan: PlanTask[] = [];
  /** Paths this run touched, relative to the project (for task progress). */
  touched = new Set<string>();
  /** In-flight file tools: tool call id to the relative path. */
  pendingFileTools = new Map<string, string>();
  /** Last file-tool outcome per relative path. */
  toolOutcomes = new Map<string, "ok" | "error">();
  /** Last prefix payload sent, so identical tool_end events skip IPC. */
  lastTimelinePrefixKey = "";
  /** When the user sent an interrupt (\x03) into this terminal. */
  interruptedAt?: number;
  /** Session Timeline: ordered points with file snapshots. */
  timeline: TimelineEvent[] = [];
  /** Per-path content as of the last snapshot in this run (for edit math). */
  runSnapshots = new Map<string, string>();
  runSnapshotBytes = 0;
  /** Recent file-tool paths. Watcher changes on these paths join the tool
   *  dot instead of adding a second change dot. */
  lastToolAt = new Map<string, number>();
  timelineSeq = 0;
  /** Watcher hint paths since the last moment capture (Phase 6). */
  pendingHints = new Set<string>();
  /** Debounced moment-capture timer. */
  captureTimer: ReturnType<typeof setTimeout> | null = null;
  momentCapturePromise: Promise<void> | null = null;
  /** Dots waiting for their captured source state. */
  momentDots: TimelineEvent[] = [];
  /** The recorder state of this terminal's timeline. */
  recorderState: RecorderState = "paused";
  /** The prompt payload reported by before_agent_start. */
  pendingPrompt: { file: string; text: string; images: number } | null = null;
  /** The open run record of this terminal, or null. */
  currentRun: RunRecord | null = null;

  constructor(
    id: string,
    cwd: string,
    workspaceId: string,
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
    this.workspaceId = workspaceId;
    this.type = type;
    this.shellName = shellName;
    this.pty = new PtyTerminal({ id, cwd, cmd, args, env, cols, rows });
  }
}

/**
 * All per-project state. One entry per opened folder.
 */
interface ProjectState {
  id: string;
  /** The opened folder. */
  cwd: string;
  /** The canonical project root (the Git top level). */
  canonicalRoot: string;
  /** One workspace per source tree: the primary plus candidates. */
  workspaces: Map<string, WorkspaceState>;
  /** The app-owned snapshot store of this project, or null. */
  storePromise: Promise<SnapshotStore | null> | null;
  /** The store directory (app-owned, outside the project). */
  storeDir: string | null;
  /** Files the user marked as theirs (canonical paths). The agent is told
   *  not to modify them without asking. */
  mineFiles: Set<string>;
  /** The worldline manager (Fork Run candidates). */
  worldlines: WorldlineManager | null;
  /** Terminal ids owned by this project (agents, shells, candidates). */
  terminalIds: Set<string>;
  /** Roster entries that failed to spawn this session. Keep them on disk so a later launch can retry. */
  unrestoredTerminals: TerminalRosterEntry[];
}

/** Env vars pi treats as a provider credential (see pi providers.md). */
const PI_PROVIDER_ENV = [
  "ANTHROPIC_API_KEY",
  "ANT_LING_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "NVIDIA_API_KEY",
  "GEMINI_API_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "CLOUDFLARE_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
  "OPENCODE_API_KEY",
  "RADIUS_API_KEY",
  "HF_TOKEN",
  "FIREWORKS_API_KEY",
  "TOGETHER_API_KEY",
  "BASETEN_API_KEY",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "QWEN_TOKEN_PLAN_API_KEY",
  "QWEN_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
] as const;

/** True when process env already supplies a pi provider key. */
function envHasPiProvider(env: NodeJS.Dict<string | undefined>): boolean {
  for (const key of PI_PROVIDER_ENV) {
    if (env[key]) return true;
  }
  return false;
}

/** True when auth.json holds at least one provider credential. */
function authJsonHasPiProvider(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  for (const value of Object.values(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const type = typeof entry.type === "string" ? entry.type : "";
    if (type === "oauth") return true;
    if (typeof entry.key === "string" && entry.key.length > 0) return true;
  }
  return false;
}

let quitConfirmed = false;
let cleanupComplete = false;
let cleanupStarted = false;

class PiEditorApp {
  private win: BrowserWindow | null = null;
  private terminals = new Map<string, PiTerminalInstance>();

  /** The renderer-facing project (the tab in front), or null. */
  private project(): ProjectState | null {
    return this.activeProjectId ? this.projects.get(this.activeProjectId) ?? null : null;
  }

  /** The project that owns a terminal, or null. */
  private projectOfTerminal(terminalId: string): ProjectState | null {
    const inst = this.terminals.get(terminalId);
    if (!inst?.projectId) return null;
    return this.projects.get(inst.projectId) ?? null;
  }

  /** The project that holds a recorded run, or null. */
  private projectForRun(runId: string): ProjectState | null {
    for (const project of this.projects.values()) {
      if (project.worldlines?.runOf(runId)) return project;
    }
    return null;
  }

  /** The project that owns a workspace, or null. */
  private projectOfWorkspace(workspaceId: string): ProjectState | null {
    const projectId = this.workspaceOwners.get(workspaceId);
    return projectId ? this.projects.get(projectId) ?? null : null;
  }

  /** True while the given project id is opening or closing. */
  private projectIsSwitching(projectId: string | undefined): boolean {
    return projectId !== undefined && this.switchingProjects.has(projectId);
  }

  /** A workspace by id, across all projects. Ids are globally unique. */
  private workspaceById(workspaceId: string): WorkspaceState | null {
    return this.projectOfWorkspace(workspaceId)?.workspaces.get(workspaceId) ?? null;
  }
  /** One workspace per source tree (WORLDLINES §6.2). */
  /** One open project: its workspaces, store, and worldline manager. */
  private projects = new Map<string, ProjectState>();
  private activeProjectId: string | null = null;
  /** workspace id → project id. Watcher and IPC lookups stay O(1). */
  private workspaceOwners = new Map<string, string>();
  /** Last auth.json check. A matching mtime and size skip the parse. */
  private loginHint: { mtimeMs: number; size: number; needsLogin: boolean } | null = null;
  private eventsDir = process.env.TERMINA_EVENTS_DIR ?? join(app.getPath("temp"), "termina-events");
  /** The app-private session branch workspace. */
  private sessionWorkspaceDir = join(this.eventsDir, "session-workspace");
  private tailer = new SidecarTailer(this.eventsDir);
  private paintWatchdog: ReturnType<typeof setInterval> | null = null;
  private appUpdater: AppUpdateController | null = null;
  private installingUpdate = false;
  /** In-flight background verify runs by owner terminal id. */
  private verifyRuns = new Set<string>();
  /** Background test processes by owner terminal id. */
  private verifyJobs = new Map<string, VerifyJob>();
  /** Busy agent terminal ids: concurrent runs in one workspace overlap. */
  private busyAgents = new Set<string>();
  /** Dispatch workers: worker terminal id → its task text. */
  private dispatchWorkers = new Map<string, string>();
  /** Dispatch runs: worker terminal id → owner + the dispatched task text. */
  private dispatchRuns = new Map<string, { ownerId: string; taskText: string }>();
  /** Dispatch mailbox notes per terminal, flushed to mailbox-<id>.md. */
  private dispatchMailbox = new Map<string, string[]>();
  /** True after the first successful mkdir of the events directory. */
  private eventsDirReady = false;

  /** Files the user changed while no agent terminal was busy. The agent
   *  receives them on its next turn. It adapts instead of overwriting them.
   *  One map per workspace. */
  private userEditsByWorkspace = new Map<string, Map<string, UserEdit>>();

  /** The session-fork client. SessionManager work runs in the worker. */
  private sessionFork = new SessionForkClient();

  /** The app-owned worlds root. */
  private userDataDir = process.env.TERMINA_USER_DATA_DIR ?? app.getPath("userData");
  private preferencesStore = new AppPreferencesStore(join(this.userDataDir, "preferences.json"));
  private preferences: AppPreferences = defaultAppPreferences();
  private preferenceCommits: Promise<void> = Promise.resolve();
  private shortcutMap: ShortcutMap = { ...DEFAULT_SHORTCUTS };
  private worldsRoot = process.env.TERMINA_WORLDS_DIR ?? join(this.userDataDir, "worlds");
  /** Input buffer for /new slash-command detection (terminals:write is per keystroke). */
  private newCommandBuffers = new Map<string, string>();
  /** Tailers for candidate events directories. */
  private worldlineTailers = new Map<string, SidecarTailer>();
  /** Preserve event order while prompt payloads load asynchronously. */
  private sidecarQueues = new Map<string, Promise<void>>();
  /** One-use start preflights by token. */
  private pendingPreflights = new Map<string, PendingPreflight>();
  /** Capture and acknowledgement tasks that must finish before store teardown. */
  private recordingTasks = new Set<Promise<unknown>>();
  /** Renderer flush requests awaiting their report. */
  private flushWaiters = new Map<string, { workspaceId: string; resolve: (r: { ok: boolean; failed: string[] }) => void; timer: ReturnType<typeof setTimeout> }>();
  private flushSeq = 0;
  private userEditsWriteTimer: ReturnType<typeof setTimeout> | null = null;
  /** Paths the promotion is applying right now (suppress user-edit records). */
  private promotionPaths: Set<string> | null = null;
  /** The materialized export dirs: dir path → owning project id. */
  private exportedStateDirs = new Map<string, string | undefined>();
  private static readonly USER_EDITS_MAX = 50;
  private static readonly MAX_MODIFIED_FILES = 2000;
  private static readonly MAX_BASELINE_FILES = 2000;
  private static readonly MAX_BASELINE_BYTES = 64 * 1024 * 1024;
  private static readonly MAX_RUN_SNAPSHOTS = 2000;
  private static readonly MAX_RUN_SNAPSHOT_BYTES = 64 * 1024 * 1024;
  private static readonly MAX_PENDING_HINTS = 2000;
  private static readonly MAX_MINE_FILES = 2000;
  /**
   * The last watcher change per path. A single physical write can produce
   * several fs events; the duplicates must not count as fresh user edits.
   */
  private lastWatchChange = new Map<string, { content: string; at: number }>();
  private static readonly LAST_WATCH_MAX = 500;
  private disposed = false;
  /** The project ids with an open or close in progress. Events of these
   *  projects wait; every other project keeps running. */
  private switchingProjects = new Set<string>();
  private folderOpenPromise: Promise<{ cwd: string } | { cancelled: true }> | null = null;

  // ---------------------------------------------------------------- window --

  async createWindow(): Promise<void> {
    // Dev runs the Electron binary, whose Dock icon is Electron's. The
    // packaged bundle carries the Termina icon; override the Dock here.
    if (!app.isPackaged) {
      const icon = join(__dirname, "..", "build", "icon.png");
      try {
        app.dock?.setIcon(icon);
      } catch {
        /* the icon is optional in dev */
      }
    }
    nativeTheme.themeSource = this.preferences.theme === "light" ? "light" : "dark";
    const windowBackground: Record<ThemeId, string> = {
      dark: "#1e1e1e",
      light: "#f6f8fa",
      "high-contrast": "#000000",
      atom: "#282c34",
    };
    const backgroundColor = windowBackground[this.preferences.theme];
    this.win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 960,
      minHeight: 600,
      title: "Termina",
      backgroundColor,
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
      if (process.env.TERMINA_DEVTOOLS) this.win.webContents.openDevTools({ mode: "detach" });
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
    const send = (command: CommandId) => () => this.send("menu:command", { command });
    const shortcut = (command: ShortcutCommand): string | undefined => this.shortcutMap[command] || undefined;
    const update = updateMenuCopy(
      this.appUpdater?.getState() ?? { status: "disabled", currentVersion: app.getVersion() },
    );
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: "Termina",
        submenu: [
          { role: "about" },
          { type: "separator" },
          { label: update.status, id: "app-update-status", enabled: false },
          {
            id: "app-update-action",
            label: update.action,
            enabled: update.enabled,
            click: () => void this.handleUpdateMenuAction(),
          },
          { type: "separator" },
          { label: "Settings…", accelerator: shortcut("open-settings"), click: send("open-settings") },
          { type: "separator" },
          { role: "services", submenu: [] },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "File",
        submenu: [
          { label: "Open Folder…", accelerator: shortcut("open-folder"), click: () => void this.openFolder() },
          { type: "separator" },
          { label: "New File…", accelerator: shortcut("new-file"), click: send("new-file") },
          { label: "New Folder…", accelerator: shortcut("new-folder"), click: send("new-folder") },
          { label: "Rename…", accelerator: shortcut("rename"), click: send("rename") },
          { label: "Delete…", accelerator: shortcut("delete"), click: send("delete") },
          { type: "separator" },
          { label: "Refresh Explorer", accelerator: shortcut("refresh"), click: send("refresh") },
          { type: "separator" },
          { label: "Save All", accelerator: shortcut("save-all"), click: send("save-all") },
          { type: "separator" },
          { label: "Close Window", accelerator: shortcut("close-window"), role: "close" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          // Copy and Paste route through the terminal when it has focus.
          // System roles cannot read the terminal's canvas selection.
          { label: "Undo", accelerator: shortcut("undo"), click: send("undo") },
          { label: "Redo", accelerator: shortcut("redo"), click: send("redo") },
          { type: "separator" },
          { role: "cut" },
          { label: "Copy", accelerator: shortcut("copy"), click: send("copy") },
          { label: "Paste", accelerator: shortcut("paste"), click: send("paste") },
          { role: "pasteAndMatchStyle" },
          { role: "delete" },
          { type: "separator" },
          { label: "Select All", accelerator: shortcut("select-all"), click: send("select-all") },
        ],
      },
      {
        label: "Terminal",
        submenu: [
          { label: "New Terminal", accelerator: shortcut("new-terminal"), click: send("new-terminal") },
          { label: "Close Terminal", accelerator: shortcut("close-terminal"), click: () => void this.closeActiveTerminal() },
          { type: "separator" },
          { label: "Next Terminal", accelerator: shortcut("next-terminal"), click: send("next-terminal") },
          { label: "Previous Terminal", accelerator: shortcut("previous-terminal"), click: send("previous-terminal") },
          { type: "separator" },
          { label: "Send Ctrl+C (abort)", accelerator: shortcut("abort-terminal"), click: () => void this.abortActive() },
          {
            label: "Show Thinking",
            type: "checkbox",
            checked: this.preferences.showThinking,
            click: (item) => {
              item.checked = this.preferences.showThinking;
              send("toggle-thinking")();
            },
          },
        ],
      },
      {
        label: "View",
        submenu: [
          {
            label: "Layout",
            submenu: [
              { label: "Terminal Left", accelerator: shortcut("layout-terminal-left"), click: send("layout-terminal-left") },
              { label: "Terminal Right", accelerator: shortcut("layout-terminal-right"), click: send("layout-terminal-right") },
              { label: "Terminal Top", accelerator: shortcut("layout-terminal-top"), click: send("layout-terminal-top") },
              { label: "Terminal Bottom", accelerator: shortcut("layout-terminal-bottom"), click: send("layout-terminal-bottom") },
              { type: "separator" },
              { label: "Terminal Fullscreen", accelerator: shortcut("fullscreen"), click: send("fullscreen") },
            ],
          },
          { label: "Toggle Explorer", accelerator: shortcut("toggle-explorer"), click: send("toggle-explorer") },
          { label: "Toggle Terminal", accelerator: shortcut("toggle-terminal"), click: send("toggle-terminal") },
          { label: "Toggle Editor", accelerator: shortcut("toggle-editor"), click: send("toggle-editor") },
          { label: "Toggle Modified Panel", accelerator: shortcut("toggle-modified"), click: send("toggle-modified") },
          { label: "Next Project", accelerator: shortcut("next-project"), click: send("next-project") },
          { label: "Previous Project", accelerator: shortcut("previous-project"), click: send("previous-project") },
          { label: "Search Sessions…", accelerator: shortcut("session-search"), click: send("session-search") },
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

  private applyUpdateMenu(): void {
    const copy = updateMenuCopy(
      this.appUpdater?.getState() ?? { status: "disabled", currentVersion: app.getVersion() },
    );
    const menu = Menu.getApplicationMenu();
    const statusItem = menu?.getMenuItemById("app-update-status");
    const actionItem = menu?.getMenuItemById("app-update-action");
    if (!statusItem || !actionItem) {
      this.buildMenu();
      return;
    }
    statusItem.label = copy.status;
    actionItem.label = copy.action;
    actionItem.enabled = copy.enabled;
  }

  private handleUpdateMenuAction(): void {
    const copy = updateMenuCopy(
      this.appUpdater?.getState() ?? { status: "disabled", currentVersion: app.getVersion() },
    );
    if (copy.kind === "install") void this.installAppUpdate();
    else if (copy.kind === "check") void this.checkAppUpdateFromMenu();
  }

  private setKeyboardShortcuts(raw: unknown): ShortcutMap {
    this.shortcutMap = sanitizeShortcutMap(raw, {} as ShortcutMap);
    this.buildMenu();
    return { ...this.shortcutMap };
  }

  private async commitPreferencePatch(patch: Partial<AppPreferences>, activateShortcuts: boolean): Promise<AppPreferences> {
    const operation = this.preferenceCommits.then(async () => {
      const candidate = normalizeAppPreferences({ ...this.preferences, ...patch });
      if (!Object.prototype.hasOwnProperty.call(patch, "openProjects")) {
        candidate.openProjects = this.preferences.openProjects;
      }
      await this.preferencesStore.save(candidate);
      const thinkingChanged = this.preferences.showThinking !== candidate.showThinking;
      this.preferences = candidate;
      nativeTheme.themeSource = candidate.theme === "light" ? "light" : "dark";
      if (activateShortcuts) this.shortcutMap = { ...candidate.shortcuts };
      this.buildMenu();
      if (thinkingChanged) {
        const seq = candidate.showThinking ? SHOW_THINKING_CSI : HIDE_THINKING_CSI;
        for (const inst of this.terminals.values()) {
          if (inst.engine === "core") inst.pty.write(seq);
        }
      }
      return { ...candidate, shortcuts: { ...candidate.shortcuts } };
    });
    this.preferenceCommits = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async updatePreferences(raw: unknown, activateShortcuts: boolean): Promise<AppPreferences> {
    const patch = normalizeUserPreferencePatch(raw && typeof raw === "object" && raw !== null && "patch" in raw
      ? (raw as { patch: unknown }).patch
      : raw);
    const activate = raw && typeof raw === "object" && raw !== null && "activateShortcuts" in raw
      ? (raw as { activateShortcuts?: boolean }).activateShortcuts === true
      : activateShortcuts;
    return this.commitPreferencePatch(patch, activate);
  }

  // ------------------------------------------------------------- terminals --

  // ---------------------------------------------------------- workspaces ---

  /** The opened project's workspace, or null when no folder is open. */
  private primaryWorkspace(project?: ProjectState): WorkspaceState | null {
    const owner = project ?? this.project();
    if (!owner) return null;
    for (const ws of owner.workspaces.values()) if (ws.primary) return ws;
    return null;
  }

  /** The workspace a terminal works in (falls back to its project's primary). */
  private workspaceOfTerminal(inst: PiTerminalInstance): WorkspaceState | null {
    const owner = this.projectOfTerminal(inst.id);
    if (owner) return owner.workspaces.get(inst.workspaceId) ?? null;
    return this.primaryWorkspace();
  }

  /** The user-edit map of a workspace (WORLDLINES §6.2: one per workspace). */
  private userEditsOf(ws: WorkspaceState): Map<string, UserEdit> {
    let m = this.userEditsByWorkspace.get(ws.id);
    if (!m) {
      m = new Map();
      this.userEditsByWorkspace.set(ws.id, m);
    }
    return m;
  }

  /** Create a workspace in a project and start its watcher. The primary
   *  workspace sets the project cwd used by the renderer-facing APIs. */
  private createWorkspace(project: ProjectState, root: string, primary: boolean): WorkspaceState {
    const ws: WorkspaceState = {
      id: `ws-${++workspaceSeq}`,
      root,
      primary,
      generation: 0,
      writerId: null,
      watcher: null,
      terminalIds: new Set(),
      lastStateCommit: null,
      retainedBlobBytes: 0,
      indexReady: null,
      recordError: null,
      changeLines: new Map(),
    };
    project.workspaces.set(ws.id, ws);
    this.workspaceOwners.set(ws.id, project.id);
    if (primary) project.cwd = root;
    ws.watcher = this.startWatcher(ws);
    if (primary) this.initRecording(project, ws);
    return ws;
  }

  /**
   * Create the app-owned snapshot store and run the initial index capture
   * (WORLDLINES §6.4). Runs do not record until the index finishes.
   */
  private initRecording(project: ProjectState, ws: WorkspaceState): void {
    if (project.storePromise) return;
    const storeRoot = this.canonicalPath(ws.root);
    // v2 keys the store by the opened folder. Older stores captured the
    // Git top-level for a subdirectory path and must not mix with this.
    project.storeDir = join(
      this.userDataDir,
      "worldlines",
      createHash("sha256").update(`v2:${storeRoot}`).digest("hex").slice(0, 16),
    );
    const promise = (async (): Promise<SnapshotStore | null> => {
      const top = await gitTopLevel(ws.root);
      if (!top) {
        ws.recordError = "the opened folder is not inside a Git repository";
        this.pushRecorderForWorkspace(ws, "paused");
        return null;
      }
      if (!captureRootInRepo(storeRoot, this.canonicalPath(top))) {
        ws.recordError = "the opened folder is not inside a Git repository";
        this.pushRecorderForWorkspace(ws, "paused");
        return null;
      }
      const gitDir = await gitCommonDir(ws.root);
      const fmt = await gitObjectFormat(ws.root);
      if (!gitDir) {
        ws.recordError = "the opened folder has no Git directory";
        this.pushRecorderForWorkspace(ws, "paused");
        return null;
      }
      // Capture the opened folder. A Git subdirectory is a valid project.
      // v2: older stores captured the Git top-level for the same folder key.
      const store = await SnapshotStore.create(project.storeDir!, storeRoot, gitDir, fmt);
      const state = await store.capture(await gitHead(ws.root), null);
      ws.lastStateCommit = state.commit;
      this.pushRecorderForWorkspace(ws, "ready");
      return store;
    })();
    ws.indexReady = promise.then(() => undefined, (err) => {
      ws.recordError = err instanceof Error ? err.message : String(err);
    });
    project.storePromise = promise;
  }

  /** Recorder state for every agent terminal of a workspace. */
  private pushRecorderForWorkspace(ws: WorkspaceState, state: RecorderState): void {
    for (const id of ws.terminalIds) {
      const inst = this.terminals.get(id);
      if (inst && inst.type === "agent") this.setRecorderState(inst, state);
    }
  }

  // ------------------------------------------------- trust (WORLDLINES §6.7) ----

  /** The trust-sensitive resource hashes, computed off the main thread. */
  private async computeTrustHashes(): Promise<Record<string, string>> {
    const agentDir = join(homedir(), ".pi", "agent");
    const project = this.project()?.cwd ? resolve(this.project()!.cwd) : null;
    return coreClient.trustHashes(agentDir, project);
  }

  /**
   * Create the worldline manager of one project. Depends on app paths
   * that exist only after the app creates the window.
   */
  private initWorldlines(project: ProjectState): void {
    if (project.worldlines) return;
    project.worldlines = new WorldlineManager({
      worldsRoot: this.worldsRoot,
      // The canonical primary root: the sandbox compares canonical paths.
      primaryRoot: realpathSync(this.primaryWorkspace(project)?.root ?? project.cwd ?? homedir()),
      realHome: homedir(),
      userData: this.userDataDir,
      primaryEventsDir: this.eventsDir,
      bridgePath: this.bridgePath(),
      piBin: this.resolvePiBin(),
      agentCorePath: join(__dirname, "agent-core.mjs").replace("app.asar", "app.asar.unpacked"),
      electronExecPath: process.execPath,
      baseEnv: cleanEnv(),
      showThinking: () => this.preferences.showThinking,
      getStore: async () => {
        const store = await project.storePromise;
        return store;
      },
      // The sandboxed pi loads the pinned package and the node binary.
      appReadPaths: () => {
        const out: string[] = [dirname(dirname(dirname(dirname(this.resolvePiBin()))))];
        out.push(process.execPath);
        out.push(dirname(dirname(process.execPath)));
        const corePath = join(__dirname, "agent-core.mjs").replace("app.asar", "app.asar.unpacked");
        out.push(corePath, dirname(corePath));
        const node = this.findOnPath("node") ?? process.execPath;
        out.push(node, dirname(node));
        try {
          out.push(realpathSync(node));
        } catch {
          /* The configured node path can disappear between checks. */
        }
        return [...new Set(out)];
      },
      forkSession: (opts) => this.sessionFork.fork(opts),
      createCandidate: (opts) => this.createCandidate(opts),
      createCandidateWorkspace: (root, baseStateId, comparisonId) => this.createCandidateWorkspace(project, root, baseStateId, comparisonId),
      onUpdate: (summary) => this.send("worldline:update", summary),
      onCandidateState: (root, stateId) => {
        const workspace = this.workspaceContaining(root);
        if (workspace) this.setWorkspaceState(workspace, stateId);
      },
      onRemoved: (comparisonId) => {
        this.cancelVerifyForComparison(comparisonId);
        this.removeCandidateWorkspaces(project, comparisonId);
        this.send("worldline:removed", { comparisonId });
      },
      // The fork preflight (WORLDLINES §4): repository, platform, disk.
      preflight: async () => {
        const reasons: string[] = [];
        const store = await project.storePromise;
        const primaryRoot = this.primaryWorkspace(project)?.root ?? project.cwd ?? "";
        if (store) {
          const repo = await store.preflightRepo({ worldsRoot: this.worldsRoot });
          reasons.push(...repo.reasons);
        } else {
          // No store: the folder is not a recordable repository.
          const top = primaryRoot ? await gitTopLevel(primaryRoot).catch(() => null) : null;
          if (!top) reasons.push("the opened folder is not inside a Git repository");
        }
        if (!platformHasSandboxExec()) reasons.push("the platform has no sandbox-exec");
        if (!platformHasRecursiveWatcher()) reasons.push("the platform has no reliable recursive watcher");
        // A custom TERMINA_PI_BIN must match the pinned pi version
        // (WORLDLINES §5): a mismatched session format disables Worldlines.
        if (process.env.TERMINA_PI_BIN) {
          const override = realpathSync(process.env.TERMINA_PI_BIN);
          const pinned = realpathSync(this.pinnedPiBin());
          if (override !== pinned) {
            const [overrideV, pinnedV] = await Promise.all([this.piVersionOf(override), this.piVersionOf(pinned)]);
            if (overrideV !== pinnedV) {
              reasons.push(`TERMINA_PI_BIN is a different pi version (${overrideV ?? "unknown"} vs ${pinnedV ?? "unknown"})`);
            }
          }
        }
        const free = await freeDiskBytes(this.worldsRoot);
        if (free !== null && free < MIN_WORLDS_FREE_BYTES) {
          reasons.push(`free disk space is below the 512 MB minimum (${Math.floor(free / (1024 * 1024))} MB)`);
        }
        return { ok: reasons.length === 0, reasons };
      },
      trustHashes: async () => this.computeTrustHashes(),
      captureHead: async (root, gitDir, parent) => {
        const store = await project.storePromise;
        if (!store) throw new Error("recording is not available");
        const state = await store.capture(await gitHead(root), parent, {}, {}, { root, gitDir });
        return { commit: state.commit, tree: state.tree };
      },
      capturePrimary: async () => {
        const ws = this.primaryWorkspace(project);
        const store = await project.storePromise;
        if (!ws || !store || !ws.lastStateCommit) return null;
        try {
          const state = await store.capture(await gitHead(ws.root), ws.lastStateCommit);
          return state.commit;
        } catch {
          return null;
        }
      },
      releaseState: async (stateId) => {
        await this.releaseStateIfUnused(stateId);
      },
      terminalBusy: (terminalId) => this.terminals.get(terminalId)?.busy === true,
      terminalVerifying: (terminalId) => this.verifyRuns.has(terminalId),
      workspaceAt: (root) => {
        const ws = this.workspaceContaining(root);
        return ws ? { id: ws.id, generation: ws.generation, lastStateCommit: ws.lastStateCommit } : null;
      },
      acquireWriteLease: (workspaceId, requester, timeoutMs) => this.acquireWriteLease(workspaceId, requester, timeoutMs),
      releaseWriteLease: (workspaceId, requester) => this.releaseWriteLease(workspaceId, requester),
      flushDirtyModels: (requester, workspaceId, timeoutMs) => this.flushDirtyModels(requester, workspaceId, timeoutMs),
      canonicalPath: (absPath) => this.canonicalPath(absPath),
      mineFiles: () => project.mineFiles,
      runSandboxedEvidence: (cand, command, timeoutMs) => this.runSandboxedEvidence(cand, command, timeoutMs),
      sourceFilesOf: (root) => this.sourceFilesOf(root),
      createEvidenceHome: () => this.createEvidenceHome(),
      detectTestFromState: (store, stateId) => this.detectTestFromState(store, stateId),
      benchmarkConfigFrom: (store, stateId) => this.benchmarkConfigFrom(store, stateId),
      onEvidenceUpdate: (summary) => this.send("worldline:evidence-update", summary),
      onPromotionApply: (relPaths) => {
        this.promotionPaths = relPaths ? new Set(relPaths) : null;
      },
      primarySessionDir: (cwd) => this.primarySessionDir(cwd),
      installPromoted: async (seed) => {
        const inst = await this.createTerminal(
          seed.primaryRoot,
          seed.engine === "core"
            ? await (async () => {
                const sessionId = `core-${randomUUID()}`;
                const dest = this.coreSessionFile(sessionId, seed.primaryRoot);
                mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
                await copyFile(seed.installedSession, dest);
                return {
                  type: "agent" as const,
                  engine: "core" as const,
                  workspaceId: seed.primaryWorkspaceId,
                  resume: { sessionId, sessionFile: dest },
                };
              })()
            : {
                type: "agent",
                engine: "pi" as const,
                workspaceId: seed.primaryWorkspaceId,
                launch: {
                  cmd: this.resolvePiBin(),
                  args: ["-e", this.bridgePath(), "--session", seed.installedSession],
                  env: { ...cleanEnv(), TERMINA_EVENTS_DIR: this.eventsDir },
                },
              },
        );
        for (const path of seed.paths) {
          const abs = this.canonicalPath(join(seed.primaryRoot, path.rel));
          const before = path.beforeExists ? await readFile(join(seed.beforeDir, path.rel)) : null;
          this.setBaseline(inst, abs, before === null ? null : before.toString("utf8"));
          if (path.kind === "delete") this.recordDeleted(inst, abs);
          else this.recordModified(inst, abs, path.beforeExists ? "modified" : "created");
        }
        this.send("modified:list", { instanceId: inst.id, files: [...inst.modified.values()] });
        const changedList = seed.paths.map((path) => `- \`${path.rel}\``).join("\n");
        for (const other of this.terminals.values()) {
          if (other.id === inst.id || other.workspaceId !== seed.primaryWorkspaceId || other.type !== "agent") continue;
          try {
            mkdirSync(this.eventsDirOf(other), { recursive: true, mode: 0o700 });
            writeFileSync(
              join(this.eventsDirOf(other), `edits-${other.id}.md`),
              `## Source changed by promotion (${seed.comparisonId}, candidate ${seed.label})\n\n${changedList}\n`,
              "utf8",
            );
          } catch {
            /* The context file is optional. */
          }
        }
        this.sendInstances();
        this.send("promotion:opened", { terminalId: inst.id });
        return { terminalId: inst.id };
      },
    });
  }

  /** The events dir a terminal's bridge reads (candidates have their own). */
  private eventsDirOf(inst: PiTerminalInstance): string {
    const owner = this.projectOfTerminal(inst.id);
    return owner?.worldlines?.eventsDirOf(inst.id) ?? this.eventsDir;
  }

  /** Core tabs attach a clipboard image as a pending host file. Pi and
   *  shell tabs only paste text: a PNG cannot travel through the pty. */
  private async pasteTerminal(id: unknown): Promise<TerminalPasteResult> {
    const text = (): TerminalPasteResult => ({ ok: true, kind: "text", text: capUtf8(clipboard.readText(), MAX_CLIPBOARD_BYTES) });
    if (typeof id !== "string") return text();
    const captured = this.terminals.get(id);
    if (!captured || captured.engine !== "core") return text();
    const image = clipboard.readImage();
    if (image.isEmpty()) return text();
    let png: Buffer;
    try {
      png = Buffer.from(image.toPNG());
    } catch {
      return { ok: false, error: "image is empty" };
    }
    if (png.length === 0) return { ok: false, error: "image is empty" };
    if (png.length > MAX_CLIPBOARD_BYTES) return { ok: false, error: "image is too large" };
    if (this.terminals.get(id) !== captured) return { ok: false, error: "terminal closed" };
    const attached = await appendPendingImages(
      this.eventsDirOf(captured),
      captured.id,
      [{ bytes: png, mediaType: "image/png", id: randomUUID() }],
      { canCommit: () => this.terminals.get(id) === captured },
    );
    if (!attached.ok) return { ok: false, error: attached.error };
    return { ok: true, kind: "image", count: attached.count, queued: captured.busy };
  }

  private async dropTerminalFiles(event: Electron.IpcMainInvokeEvent, id: unknown, raw: unknown): Promise<TerminalPasteResult> {
    if (!isAuthorizedDropSender(event, this.win)) return { ok: false, error: "unauthorized" };
    if (typeof id !== "string" || !/^term-\d+$/.test(id)) return { ok: false, error: "terminal closed" };
    const captured = this.terminals.get(id);
    if (!captured) return { ok: false, error: "terminal closed" };
    const normalized = normalizeDroppedPaths(raw);
    if (!normalized.ok) return normalized;
    if (captured.engine === "core") {
      const eventsDir = this.eventsDirOf(captured);
      const state = await pendingImageState(eventsDir, captured.id);
      if (!state.ok) return { ok: false, error: state.error };
      const remaining = Math.max(0, MAX_PENDING_IMAGES - state.count);
      const images = await readDroppedImages(normalized.paths, remaining);
      if (!images.ok) return images;
      if (this.terminals.get(id) !== captured) return { ok: false, error: "terminal closed" };
      const attached = await appendPendingImages(eventsDir, captured.id, images.images, {
        canCommit: () => this.terminals.get(id) === captured,
      });
      if (!attached.ok) return { ok: false, error: attached.error };
      return { ok: true, kind: "image", count: attached.count, queued: captured.busy };
    }
    const exists = await validatePathDropTargets(normalized.paths);
    if (!exists.ok) return exists;
    const quoted = quotePosixPaths(normalized.paths, process.platform);
    if (!quoted.ok) return quoted;
    if (this.terminals.get(id) !== captured) return { ok: false, error: "terminal closed" };
    return { ok: true, kind: "text", text: quoted.text };
  }

  private async safeEventsFile(dir: string, name: string): Promise<string | null> {
    if (!name || name.includes("/") || name.includes("\\")) return null;
    try {
      const [canonicalDir, canonicalFile] = await Promise.all([fsRealpath(dir), fsRealpath(join(dir, name))]);
      const rel = relative(canonicalDir, canonicalFile);
      return rel && !rel.startsWith("..") && !isAbsolute(rel) ? canonicalFile : null;
    } catch {
      return null;
    }
  }

  /** Create a candidate terminal inside its sandbox. */
  private async createCandidate(opts: {
    root: string;
    workspaceId: string;
    engine?: "pi" | "core";
    launch: { cmd: string; args: string[]; env: Record<string, string | undefined> };
  }): Promise<{ terminalId: string; pid: number }> {
    const inst = await this.createTerminal(opts.root, {
      type: "agent",
      engine: opts.engine,
      workspaceId: opts.workspaceId,
      launch: opts.launch,
    });
    // The candidate's bridge writes to its own events dir: tail it.
    const eventsDir = opts.launch.env.TERMINA_EVENTS_DIR;
    if (eventsDir && eventsDir !== this.eventsDir) {
      const tailer = new SidecarTailer(eventsDir);
      tailer.onEvent = (id, event) => this.enqueueSidecarEvent(id, event);
      tailer.start();
      tailer.watch(inst.id);
      this.worldlineTailers.set(inst.id, tailer);
    }
    return { terminalId: inst.id, pid: inst.pty.pid };
  }

  /** A candidate source tree workspace (no recording, own watcher). The
   *  lineage base seeds its moment-capture chain (nested worldlines keep
   *  the root promotion base). */
  private createCandidateWorkspace(project: ProjectState, root: string, baseStateId: string | null, comparisonId: string): string {
    const ws = this.createWorkspace(project, root, false);
    ws.comparisonId = comparisonId;
    ws.lastStateCommit = baseStateId;
    return ws.id;
  }

  /** Remove candidate workspaces after one comparison is torn down. */
  private removeCandidateWorkspaces(project: ProjectState, comparisonId: string): void {
    for (const [id, ws] of [...project.workspaces]) {
      if (ws.primary || ws.comparisonId !== comparisonId) continue;
      const stateId = ws.lastStateCommit;
      ws.watcher?.stop();
      project.workspaces.delete(id);
      this.workspaceOwners.delete(id);
      project.terminalIds.forEach((tid) => {
        const inst = this.terminals.get(tid);
        if (inst && inst.workspaceId === id) project.terminalIds.delete(tid);
      });
      this.userEditsByWorkspace.delete(id);
      if (stateId) void this.releaseStateIfUnused(stateId);
    }
  }

  /** Release a workspace write lease. Only the holder can release it. */
  private releaseWriteLease(wsId: string, requesterId: string): void {
    const ws = this.workspaceById(wsId);
    if (ws && ws.writerId === requesterId) ws.writerId = null;
  }

  /**
   * Acquire the workspace write lease, waiting up to `timeoutMs` when
   * another writer holds it. Serializing keeps concurrent captures and
   * run starts from corrupting each other.
   */
  private async acquireWriteLease(wsId: string, requesterId: string, timeoutMs = 5000): Promise<{ ok: boolean; generation: number; error?: string }> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const ws = this.workspaceById(wsId);
      if (!ws) return { ok: false, generation: 0, error: "workspace not found" };
      if (ws.writerId === null || ws.writerId === requesterId) {
        ws.writerId = requesterId;
        return { ok: true, generation: ws.generation };
      }
      if (Date.now() >= deadline) return { ok: false, generation: ws.generation, error: `another writer holds the lease: ${ws.writerId}` };
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** The workspace whose root contains the path, or null. */
  private workspaceContaining(absPath: string): WorkspaceState | null {
    const p = this.canonicalPath(absPath);
    for (const project of this.projects.values()) {
      for (const ws of project.workspaces.values()) {
        const root = this.canonicalPath(ws.root);
        const rel = relative(root, p);
        if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return ws;
      }
    }
    return null;
  }

  private managedPath(absPath: string, primaryOnly = false): { path: string; workspace: WorkspaceState } | null {
    if (this.hasDanglingSymlink(absPath)) return null;
    const path = this.canonicalPath(absPath);
    const workspace = this.workspaceContaining(path);
    if (!workspace || (primaryOnly && !workspace.primary)) return null;
    return { path, workspace };
  }

  private hasDanglingSymlink(path: string): boolean {
    let current = resolve(path);
    while (true) {
      try {
        if (lstatSync(current).isSymbolicLink()) {
          try {
            realpathSync(current);
          } catch {
            return true;
          }
        }
      } catch {
        // The missing path itself is safe. Check its parent for a link.
      }
      const parent = dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }

  /**
   * Error text when a write lease blocks user file operations in a
   * workspace. A held lease means a capture or promotion is in progress.
   * The run-start preflight (Phase 2) acquires the lease; the renderer
   * never acquires it directly.
   */
  private assertWorkspaceWritable(wsId: string): string | null {
    const ws = this.workspaceById(wsId);
    if (ws && ws.writerId !== null) return `the workspace is busy (${ws.writerId} holds the write lease)`;
    return null;
  }

  /** The root directory used by terminals that have no explicit cwd. */
  private terminalCwd(): string {
    return this.primaryWorkspace()?.root ?? homedir();
  }

  // ------------------------------------------------- promotion (WORLDLINES §6.10) ----

  /** The promoted session installs into the primary session directory. */
  private primarySessionDir(cwd: string): string {
    // pi canonicalizes the cwd for its session dir (realpath); the install
    // must land in the same directory the session picker reads.
    return join(homedir(), ".pi", "agent", "sessions", this.sanitizeSessionDir(realpathSync(cwd)));
  }

  /** The project that owns a comparison, or null. */
  private projectOfComparison(comparisonId: string): ProjectState | null {
    for (const project of this.projects.values()) {
      if (project.worldlines?.promotionTarget(comparisonId, "A") || project.worldlines?.evidenceTarget(comparisonId, "A")) {
        return project;
      }
    }
    return null;
  }

  // ------------------------------------------------- evidence (WORLDLINES §6.8) ----

  /** One sandboxed command run with bounded combined stdout and stderr. */
  private async runSandboxedEvidence(
    cand: { root: string; profilePath: string; homeDir: string; tmpDir: string },
    command: string[],
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string; timedOut: boolean }> {
    const shells = await detectShells();
    const shell = shells[0] ?? { path: "/bin/zsh", name: "zsh" };
    return new Promise((resolvePromise) => {
      // Evidence workers run fully offline under the same deny-list profile
      // with the resource limits applied by the wrapper (WORLDLINES §6.8).
      const profilePath = writeEvidenceProfile(cand);
      const child = spawn("sandbox-exec", ["-f", profilePath, shell.path, "-c", `${sandboxShellPreamble()} ${command.map(quoteShellArg).join(" ")}`], {
        cwd: cand.root,
        env: { ...cleanEnv(), HOME: cand.homeDir, TMPDIR: cand.tmpDir },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let timedOut = false;
      const appendOutput = (d: Buffer): void => {
        if (stdout.length >= MAX_VERIFY_OUTPUT) return;
        stdout += d.toString("utf8").slice(0, MAX_VERIFY_OUTPUT - stdout.length);
      };
      child.stdout.on("data", appendOutput);
      child.stderr.on("data", appendOutput);
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (result: { code: number; stdout: string; timedOut: boolean }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void rm(profilePath, { force: true }).then(
          () => resolvePromise(result),
          () => resolvePromise(result),
        );
      };
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.on("error", (err) => finish({ code: -1, stdout: String(err.message), timedOut: false }));
      child.on("close", (code) => finish({ code: code ?? -1, stdout, timedOut }));
    });
  }

  /** Read bounded tracked source files for package checks. */
  private async sourceFilesOf(root: string): Promise<Array<{ relPath: string; content: string }>> {
    const out: Array<{ relPath: string; content: string }> = [];
    try {
      const canonicalRoot = await fsRealpath(root);
      const tracked = await coreClient.lsTracked(root);
      let bytes = 0;
      for (const rel of tracked) {
        if (!rel || out.length >= 2000 || bytes >= 8 * 1024 * 1024) continue;
        try {
          const path = await fsRealpath(join(root, rel));
          const canonicalRel = relative(canonicalRoot, path);
          if (!canonicalRel || canonicalRel.startsWith("..") || isAbsolute(canonicalRel)) continue;
          const info = await stat(path);
          if (!info.isFile() || bytes + info.size > 8 * 1024 * 1024) continue;
          const content = await readFile(path, "utf8");
          bytes += Buffer.byteLength(content, "utf8");
          out.push({ relPath: rel, content });
        } catch {
          /* The file can disappear while evidence reads it. */
        }
      }
    } catch {
      /* The candidate can stop during evidence. */
    }
    return out;
  }

  /** Create a bounded evidence home from the real Pi resources. */
  private async createEvidenceHome(): Promise<string> {
    const dir = await mkdtemp(join(this.eventsDir, "evidence-home-"));
    let complete = false;
    try {
      const agentDst = join(dir, ".pi", "agent");
      await mkdir(agentDst, { recursive: true, mode: 0o700 });
      const agentSrc = join(homedir(), ".pi", "agent");
      for (const name of ["auth.json", "settings.json", "models.json", "models-store.json"]) {
        try {
          const source = join(agentSrc, name);
          const info = await stat(source);
          if (!info.isFile() || info.size > MAX_PI_RESOURCE_BYTES) continue;
          const target = join(agentDst, name);
          await copyFile(source, target);
          await chmod(target, 0o600);
        } catch {
          /* The resource is optional. */
        }
      }
      for (const name of ["skills", "prompts", "themes", "extensions"]) {
        const src = join(agentSrc, name);
        try {
          if ((await stat(src)).isDirectory() && (await dirBytes(src)) <= MAX_PI_RESOURCE_BYTES) {
            await cp(src, join(agentDst, name), { recursive: true });
          }
        } catch {
          /* An optional or oversized resource is omitted. */
        }
      }
      await mkdir(join(dir, "tmp", "A"), { recursive: true, mode: 0o700 });
      await mkdir(join(dir, "tmp", "B"), { recursive: true, mode: 0o700 });
      complete = true;
      return dir;
    } finally {
      if (!complete) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private markCandidateEvidenceStale(comparisonId: string | undefined): void {
    if (!comparisonId) return;
    this.projectOfComparison(comparisonId)?.worldlines?.markEvidenceStale(comparisonId);
  }

  private stateIsReferenced(stateId: string, ignoredTerminalId?: string, ignoredSeq?: number): boolean {
    for (const pending of this.pendingPreflights.values()) {
      if (pending.startState?.commit === stateId) return true;
    }
    for (const project of this.projects.values()) {
      for (const workspace of project.workspaces.values()) {
        if (workspace.lastStateCommit === stateId) return true;
      }
      for (const summary of project.worldlines?.list() ?? []) {
        if (summary.comparisonBaseStateId === stateId || summary.promotionBaseStateId === stateId || summary.headStateId === stateId) return true;
      }
      if (project.worldlines?.holdsEvidenceState(stateId)) return true;
      if (project.worldlines?.holdsRunState(stateId)) return true;
    }
    for (const [terminalId, inst] of this.terminals) {
      if (terminalId === ignoredTerminalId) {
        if (inst.timeline.some((event) => event.stateId === stateId && event.seq !== ignoredSeq)) return true;
        continue;
      }
      if (inst.timeline.some((event) => event.stateId === stateId)) return true;
    }
    return false;
  }

  private async releaseStateIfUnused(stateId: string, ignoredTerminalId?: string, ignoredSeq?: number): Promise<void> {
    if (this.stateIsReferenced(stateId, ignoredTerminalId, ignoredSeq)) return;
    for (const project of this.projects.values()) {
      const store = await project.storePromise;
      if (store) await store.unref(stateId).catch(() => undefined);
    }
  }

  private setWorkspaceState(ws: WorkspaceState, stateId: string): void {
    const previous = ws.lastStateCommit;
    ws.lastStateCommit = stateId;
    if (previous && previous !== stateId) void this.releaseStateIfUnused(previous);
  }

  private resolvePiBin(): string {
    if (process.env.TERMINA_PI_BIN) return process.env.TERMINA_PI_BIN;
    return this.pinnedPiBin();
  }

  /** The pi binary of the pinned package (ignores TERMINA_PI_BIN). */
  private pinnedPiBin(): string {
    // Launch the pi binary shipped with the pinned package (WORLDLINES
    // §6.7). The package entry resolves to dist/index.js; the CLI sits
    // next to it. The exports map has only an import condition, so use
    // import.meta.resolve, not require.resolve.
    try {
      const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
      // The packaged bundle unpacks this package: spawn the real files,
      // not the asar archive (node-pty cannot open asar paths). The
      // resolver may already return the unpacked path; never remap twice.
      const real = entry.includes("app.asar.unpacked") ? entry : entry.replace("app.asar/", "app.asar.unpacked/");
      return join(dirname(real), "cli.js");
    } catch (err) {
      // Packaged: the ESM resolver cannot read inside app.asar, but the
      // unpacked copy is a real path.
      const unpacked = join(
        process.resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "dist",
        "cli.js",
      );
      if (existsSync(unpacked)) return unpacked;
      console.warn(`[main] pinned pi package not found: ${(err as Error).message}`);
      return "pi";
    }
  }

  /** The version of a pi binary, bounded (pi --version can update-check). */
  private async piVersionOf(bin: string): Promise<string | null> {
    try {
      const out = await new Promise<string>((resolvePromise) => {
        const child = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
        let text = "";
        child.stdout.on("data", (d: Buffer) => {
          if (text.length < 256) text += d.toString("utf8");
        });
        const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
        child.on("error", () => {
          clearTimeout(timer);
          resolvePromise("");
        });
        child.on("close", () => {
          clearTimeout(timer);
          resolvePromise(text.trim());
        });
      });
      return out ? out : null;
    } catch {
      return null;
    }
  }

  private piAvailable: boolean | null = null;
  private piCheckedAt = 0;
  private piCheckInFlight: Promise<boolean> | null = null;

  /**
   * Whether the pi binary exists and runs. Success is cached; a FAILURE is
   * only trusted for a few seconds. A transient spawn error must not disable
   * the app for its full lifetime. Run the check asynchronously: the CLI
   * update check can stall for seconds and must not block the main process.
   * Concurrent callers share one in-flight check.
   */
  private checkPiAvailable(): Promise<boolean> {
    if (this.piCheckInFlight) return this.piCheckInFlight;
    const run = this.performPiCheck().finally(() => {
      if (this.piCheckInFlight === run) this.piCheckInFlight = null;
    });
    this.piCheckInFlight = run;
    return run;
  }

  private async performPiCheck(): Promise<boolean> {
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
      "pi is not installed.\n\nInstall it with:\n  npm install -g @earendil-works/pi-coding-agent\n\nor set TERMINA_PI_BIN to the pi binary path."
    );
  }

  private allocateTerminalId(): string {
    return `term-${++terminalSeq}`;
  }

  private noteTerminalId(id: string): void {
    const m = /^term-(\d+)$/.exec(id);
    if (!m) return;
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > terminalSeq) terminalSeq = n;
  }

  private coreSessionRoot(): string {
    return join(this.userDataDir, "agent-sessions");
  }

  private coreProjectSessionDir(cwd: string): string {
    return join(this.coreSessionRoot(), this.sanitizeSessionDir(this.canonicalPath(cwd)));
  }

  private coreSessionFile(sessionId: string, cwd: string): string {
    return join(this.coreProjectSessionDir(cwd), `${sessionId}.jsonl`);
  }

  /** True when `file` sits directly in `parent` (not in a subdirectory). */
  private isDirectSessionChild(parent: string, file: string): boolean {
    try {
      return realpathSync(dirname(file)) === realpathSync(parent);
    } catch {
      return resolve(dirname(file)) === resolve(parent);
    }
  }

  /**
   * Move a leftover flat `agent-sessions/core-*.jsonl` into this project's
   * session directory. Search only walks the project dir after a tab
   * closes, so a file left at the root would disappear from results.
   */
  private adoptCoreSessionFile(sessionId: string, sessionFile: string | null, cwd: string): string {
    const dest = this.coreSessionFile(sessionId, cwd);
    try {
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    } catch {
      /* dest writes still try */
    }
    if (!sessionFile || !this.sessionFileExists(sessionFile)) return dest;
    try {
      if (realpathSync(sessionFile) === realpathSync(dest)) return dest;
    } catch {
      if (resolve(sessionFile) === resolve(dest)) return dest;
    }
    if (!this.isDirectSessionChild(this.coreSessionRoot(), sessionFile)) return sessionFile;
    try {
      if (this.sessionFileExists(dest)) {
        if (this.sessionFileHasContent(dest) || !this.sessionFileHasContent(sessionFile)) return dest;
        rmSync(dest, { force: true });
      }
      renameSync(sessionFile, dest);
      return dest;
    } catch {
      return sessionFile;
    }
  }

  private terminalRosterPath(project: ProjectState): string {
    return join(this.userDataDir, "terminal-rosters", `${this.sanitizeSessionDir(project.canonicalRoot)}.json`);
  }

  private loadTerminalRoster(project: ProjectState): TerminalRosterEntry[] {
    try {
      const path = this.terminalRosterPath(project);
      const info = statSync(path);
      if (!info.isFile() || info.size > MAX_ROSTER_BYTES) return [];
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      return parseTerminalRoster(raw);
    } catch {
      return [];
    }
  }

  private rosterEntryFor(inst: PiTerminalInstance): TerminalRosterEntry {
    const entry: TerminalRosterEntry = { id: inst.id, type: inst.type };
    if (inst.type === "agent") entry.engine = inst.engine === "core" ? "core" : "pi";
    if (inst.type === "shell" && inst.shellPath) entry.shell = inst.shellPath;
    if (inst.sessionId) entry.sessionId = inst.sessionId;
    if (inst.sessionFile) entry.sessionFile = inst.sessionFile;
    return entry;
  }

  private saveTerminalRoster(project: ProjectState): void {
    const live: TerminalRosterEntry[] = [];
    for (const id of project.terminalIds) {
      const inst = this.terminals.get(id);
      if (!inst?.persist) continue;
      live.push(this.rosterEntryFor(inst));
    }
    const entries = composeTerminalRoster(live, project.unrestoredTerminals);
    try {
      const dir = join(this.userDataDir, "terminal-rosters");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = this.terminalRosterPath(project);
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ terminals: entries })}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    } catch (err) {
      console.warn(`[main] could not save terminal roster: ${(err as Error).message}`);
    }
  }

  private sessionFileExists(path: string | null | undefined): boolean {
    if (!path) return false;
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  }

  private sessionFileHasContent(path: string | null | undefined): boolean {
    if (!path) return false;
    try {
      const info = statSync(path);
      return info.isFile() && info.size > 0;
    } catch {
      return false;
    }
  }

  /** True when `target` resolves inside `parent`. Neither path needs to exist. */
  private pathInside(parent: string, target: string): boolean {
    const rel = relative(resolve(parent), resolve(target));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  }

  private sessionFileInUse(path: string | null | undefined): boolean {
    if (!path) return false;
    for (const inst of this.terminals.values()) {
      if (inst.sessionFile === path) return true;
    }
    return false;
  }

  private coreSessionInUse(sessionId: string): boolean {
    for (const inst of this.terminals.values()) {
      if (inst.sessionId === sessionId) return true;
    }
    return false;
  }

  /** Pi `--session` only accepts a jsonl file under ~/.pi/agent/sessions. */
  private trustedPiSessionFile(path: string | null | undefined): string | null {
    if (!path || !path.endsWith(".jsonl") || !this.sessionFileExists(path)) return null;
    try {
      const real = realpathSync(path);
      const root = realpathSync(join(homedir(), ".pi", "agent", "sessions"));
      if (!this.pathInside(root, real)) return null;
      return real;
    } catch {
      return null;
    }
  }

  /** Delete an empty agent-core jsonl. A session with content stays on disk
   *  so Session Search can read it after the tab closes. A leftover file
   *  at the agent-sessions root moves into this project's directory. */
  private discardCoreSession(inst: PiTerminalInstance): void {
    if (inst.engine !== "core" || !inst.sessionFile) return;
    if (!this.pathInside(this.coreSessionRoot(), inst.sessionFile)) return;
    if (this.sessionFileHasContent(inst.sessionFile)) {
      if (inst.sessionId && isCoreSessionId(inst.sessionId)) {
        this.adoptCoreSessionFile(inst.sessionId, inst.sessionFile, inst.cwd);
      }
      return;
    }
    try {
      rmSync(inst.sessionFile, { force: true });
    } catch {
      /* ignore */
    }
  }

  private persistLive(project: ProjectState): PiTerminalInstance[] {
    const out: PiTerminalInstance[] = [];
    for (const id of project.terminalIds) {
      const inst = this.terminals.get(id);
      if (inst?.persist) out.push(inst);
    }
    return out;
  }

  private async restoreProjectTerminals(project: ProjectState): Promise<void> {
    const roster = this.loadTerminalRoster(project);
    if (roster.length === 0) {
      try {
        await this.createTerminal(project.cwd);
      } catch {
        /* Pi can be unavailable while the folder still opens. */
      }
      return;
    }
    const unrestored: TerminalRosterEntry[] = [];
    const spawned: { rec: TerminalRosterEntry; id: string }[] = [];
    for (const rec of roster) {
      this.noteTerminalId(rec.id);
      try {
        const inst = await this.createTerminal(project.cwd, {
          id: rec.id,
          type: rec.type,
          engine: rec.engine,
          shell: rec.shell,
          persist: true,
          skipRosterSave: true,
          resume: { sessionId: rec.sessionId ?? null, sessionFile: rec.sessionFile ?? null },
        });
        spawned.push({ rec, id: inst.id });
      } catch (err) {
        unrestored.push(rec);
        console.warn(`[main] could not restore terminal ${rec.id}: ${(err as Error).message}`);
      }
    }
    for (const item of spawned) {
      if (!this.terminals.get(item.id)?.persist) unrestored.push(item.rec);
    }
    if (this.persistLive(project).length === 0) {
      try {
        await this.createTerminal(project.cwd, { persist: true, skipRosterSave: true });
      } catch {
        /* Pi can be unavailable while the folder still opens. */
      }
    }
    project.unrestoredTerminals = unrestored;
    this.saveTerminalRoster(project);
  }

  /** Live model and thinking of a pi agent tab, for copying onto a new tab. */
  private copiedAgentSettings(fromTerminalId: string | undefined): { model: string | null; thinkingLevel: string | null } | null {
    if (!fromTerminalId) return null;
    const source = this.terminals.get(fromTerminalId);
    if (!source || source.type !== "agent" || source.engine === "core") return null;
    return {
      model: source.model ?? source.currentRun?.model ?? null,
      thinkingLevel: source.thinkingLevel ?? source.currentRun?.thinkingLevel ?? null,
    };
  }

  /** Provider-qualified model of a core tab, for TERMINA_CORE_* env. */
  private copiedCoreModel(fromTerminalId: string | undefined): string | null {
    if (!fromTerminalId) return null;
    const source = this.terminals.get(fromTerminalId);
    if (!source || source.type !== "agent" || source.engine !== "core") return null;
    const model = source.model ?? source.currentRun?.model ?? null;
    return typeof model === "string" && model.includes("/") ? model : null;
  }

  /** Provider-qualified model id that is safe to pass as --model. */
  private usablePiModel(model: string | null | undefined): string | null {
    if (typeof model !== "string") return null;
    const next = model.trim();
    if (next.length < 3 || next.length > MAX_PI_MODEL_CHARS) return null;
    if (!next.includes("/")) return null;
    if (/[\x00-\x1f]/.test(next)) return null;
    return next;
  }

  private usablePiThinking(level: string | null | undefined): string | null {
    if (typeof level !== "string") return null;
    const next = level.trim().toLowerCase();
    return PI_THINKING_LEVELS.has(next) ? next : null;
  }

  /** CLI flags that pin a new pi process to another tab's live model. */
  private piFlagsFromSettings(settings: { model: string | null; thinkingLevel: string | null } | null): string[] {
    if (!settings) return [];
    const model = this.usablePiModel(settings.model);
    if (!model) return [];
    const extra = ["--model", model];
    const thinking = this.usablePiThinking(settings.thinkingLevel);
    // Do not pin thinking onto a different default model when the copy
    // of the model itself cannot be applied.
    if (thinking) extra.push("--thinking", thinking);
    return extra;
  }

  private applyAgentSettings(inst: PiTerminalInstance, model: string | null | undefined, thinkingLevel: string | null | undefined): void {
    const nextModel = this.usablePiModel(model);
    if (nextModel) inst.model = nextModel;
    const nextThinking = this.usablePiThinking(thinkingLevel);
    if (nextThinking) inst.thinkingLevel = nextThinking;
  }

  private async createTerminal(
    cwd?: string,
    opts?: {
      type?: "agent" | "shell";
      shell?: string;
      engine?: "pi" | "core";
      workspaceId?: string;
      id?: string;
      fromTerminalId?: string;
      launch?: { cmd: string; args: string[]; env: Record<string, string | undefined> };
      persist?: boolean;
      skipRosterSave?: boolean;
      resume?: { sessionId: string | null; sessionFile: string | null };
    },
  ): Promise<PiTerminalInstance> {
    const type = opts?.type ?? "agent";
    const agentEngine: "pi" | "core" | undefined = type === "agent" ? (opts?.engine === "pi" ? "pi" : "core") : undefined;
    const persist = opts?.persist ?? (!opts?.launch && !opts?.id);
    const workspaceId = opts?.workspaceId ?? this.primaryWorkspace()?.id ?? "";
    const owner = this.projectOfWorkspace(workspaceId) ?? this.project();
    let id = opts?.id;
    if (id && this.terminals.has(id)) {
      // Two projects both restore term-1. Keep the session; never overwrite a live pty.
      if (!persist) throw new Error(`terminal ${id} already exists`);
      id = this.allocateTerminalId();
    } else if (id) {
      this.noteTerminalId(id);
    } else {
      id = this.allocateTerminalId();
    }
    if (agentEngine === "pi" && !(await this.checkPiAvailable())) {
      throw new Error(this.piMissingMessage());
    }
    const copied = agentEngine === "pi" && !opts?.launch && !opts?.resume
      ? this.copiedAgentSettings(opts?.fromTerminalId)
      : null;
    let cmd: string;
    let args: string[];
    let shellName: string | undefined;
    let shellPath: string | undefined;
    let env: Record<string, string | undefined>;
    let sessionId = persist ? opts?.resume?.sessionId ?? null : null;
    let sessionFile = persist ? opts?.resume?.sessionFile ?? null : null;
    if (opts?.launch) {
      // A worldline candidate: the sandbox wraps the pinned pi binary.
      cmd = opts.launch.cmd;
      args = opts.launch.args;
      env = { ...opts.launch.env, TERMINA_TERMINAL_ID: id };
    } else if (type === "shell") {
      const shells = await detectShells();
      const chosen = opts?.shell && existsSync(opts.shell) ? { path: opts.shell, name: basename(opts.shell) } : shells[0] ?? { path: "/bin/zsh", name: "zsh" };
      cmd = chosen.path;
      args = [];
      shellName = chosen.name;
      shellPath = chosen.path;
      env = { ...process.env };
    } else if (agentEngine === "core") {
      // In-house engine. Same sidecar contract as the Pi bridge, so
      // timeline and modified list work unchanged. ELECTRON_RUN_AS_NODE
      // cannot read inside the asar; spawn the unpacked copy (same rule
      // as pi's cli.js).
      cmd = process.execPath;
      args = [
        join(__dirname, "agent-core.mjs").replace("app.asar", "app.asar.unpacked"),
        ...thinkingStartupArgs(this.preferences.showThinking),
      ];
      if (persist) {
        const sessionCwd = cwd ?? owner?.cwd ?? this.terminalCwd();
        if (!sessionId || !isCoreSessionId(sessionId) || this.coreSessionInUse(sessionId)) {
          sessionId = `core-${randomUUID()}`;
          sessionFile = this.coreSessionFile(sessionId, sessionCwd);
        } else {
          sessionFile = this.adoptCoreSessionFile(sessionId, sessionFile, sessionCwd);
        }
        try {
          if (sessionFile) mkdirSync(dirname(sessionFile), { recursive: true, mode: 0o700 });
        } catch {
          /* resume still tries the path */
        }
      } else {
        sessionId = null;
        sessionFile = null;
      }
      env = {
        ...cleanEnv(),
        ELECTRON_RUN_AS_NODE: "1",
        TERMINA_TERMINAL_ID: id,
        TERMINA_EVENTS_DIR: this.eventsDir,
      };
      if (sessionFile) env.TERMINA_CORE_SESSION_FILE = sessionFile;
      else delete env.TERMINA_CORE_SESSION_FILE;
      if (sessionId) env.TERMINA_CORE_SESSION_ID = sessionId;
      else delete env.TERMINA_CORE_SESSION_ID;
      if (this.sessionFileHasContent(sessionFile)) env.TERMINA_CORE_RESUME = "1";
      else delete env.TERMINA_CORE_RESUME;
      const coreModel = this.copiedCoreModel(opts?.fromTerminalId);
      if (coreModel) {
        const cut = coreModel.indexOf("/");
        env.TERMINA_CORE_PROVIDER = coreModel.slice(0, cut);
        env.TERMINA_CORE_MODEL = coreModel.slice(cut + 1);
      }
      if (!persist) env.TERMINA_CORE_APPROVE = "all";
    } else {
      cmd = this.resolvePiBin();
      // The app-owned bridge loads through the CLI option, not project
      // trust (WORLDLINES §6.3). A new tab copies model and thinking
      // from the focused agent so session-scoped picks survive.
      const trusted = this.trustedPiSessionFile(sessionFile);
      sessionFile = trusted && !this.sessionFileInUse(trusted) ? trusted : null;
      const sessionArgs = sessionFile ? ["--session", sessionFile] : [];
      args = ["-e", this.bridgePath(), ...sessionArgs, ...this.piFlagsFromSettings(copied)];
      env = { ...cleanEnv(), TERMINA_TERMINAL_ID: id, TERMINA_EVENTS_DIR: this.eventsDir };
    }
    if (persist && owner && this.persistLive(owner).length >= MAX_TERMINAL_ROSTER) {
      throw new Error("this project already has the maximum number of saved terminals");
    }
    const inst = new PiTerminalInstance(id, cwd ?? this.terminalCwd(), workspaceId, type, shellName, cmd, args, env, 80, 24);
    inst.projectId = owner?.id ?? null;
    inst.persist = persist;
    inst.shellPath = shellPath;
    inst.sessionId = sessionId;
    inst.sessionFile = sessionFile;
    if (type === "agent") inst.engine = agentEngine === "core" ? "core" : "pi";
    if (copied) this.applyAgentSettings(inst, copied.model, copied.thinkingLevel);
    this.terminals.set(inst.id, inst);
    if (owner) {
      owner.workspaces.get(workspaceId)?.terminalIds.add(id);
      owner.terminalIds.add(id);
      if (persist && !opts?.skipRosterSave) this.saveTerminalRoster(owner);
    }

    inst.pty.onData = (data) => this.sendPtyData(inst.id, data);
    inst.pty.onExit = (code) => {
      console.log(`[main] terminal ${inst.id} (${inst.type}) exited code=${code}`);
      if (inst.captureTimer) {
        clearTimeout(inst.captureTimer);
        inst.captureTimer = null;
      }
      for (const [token, pending] of [...this.pendingPreflights]) {
        if (pending.terminalId !== inst.id) continue;
        clearTimeout(pending.timer);
        this.releaseWriteLease(pending.workspaceId, pending.leaseRequester);
        this.pendingPreflights.delete(token);
      }
      this.send("pty:exit", { id: inst.id, code });
      this.closeRunOnExit(inst);
      void this.cleanupPromptPayloads(inst);
      for (const event of inst.timeline) {
        if (event.stateId) void this.releaseStateIfUnused(event.stateId, inst.id, event.seq);
      }
      // Resolve the owner before the map delete. projectOfTerminal reads
      // the terminal map, so a lookup after the delete finds no project.
      const exitOwner = this.projectOfTerminal(inst.id);
      this.terminals.delete(inst.id);
      exitOwner?.workspaces.get(inst.workspaceId)?.terminalIds.delete(inst.id);
      exitOwner?.terminalIds.delete(inst.id);
      if (inst.persist && exitOwner && !this.disposed && !this.projectIsSwitching(exitOwner.id)) {
        this.discardCoreSession(inst);
        this.saveTerminalRoster(exitOwner);
      }
      exitOwner?.worldlines?.terminalExited(inst.id);
      this.worldlineTailers.get(inst.id)?.stop();
      this.worldlineTailers.delete(inst.id);
      this.tailer.stopWatching(inst.id);
      this.sidecarQueues.delete(inst.id);
      // A dispatch worker closed before settling: its task goes back to
      // pending so the board stays honest.
      const dispatchExit = this.dispatchRuns.get(inst.id);
      if (dispatchExit) {
        this.writeDispatchSettleNote(inst, "exited");
        this.dispatchRuns.delete(inst.id);
        this.dispatchWorkers.delete(inst.id);
        const ownerInst = this.terminals.get(dispatchExit.ownerId);
        const task = ownerInst ? findTaskByText(ownerInst.plan, dispatchExit.taskText) : undefined;
        if (ownerInst && task) {
          task.state = "pending";
          task.workerId = undefined;
          task.claimed = undefined;
          this.sendPlan(ownerInst);
        }
      }
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
  private async detectTestCommand(cwd: string): Promise<{ command: string; args: string[]; label: string } | null> {
    const pkgText = await this.safeWorkspaceRead(cwd, "package.json");
    if (pkgText !== null) {
      const fromPkg = this.detectTestFromPkg(pkgText);
      if (fromPkg) return fromPkg;
    }
    return this.detectTestFromFiles(cwd);
  }

  private async safeWorkspaceRead(root: string, relPath: string): Promise<string | null> {
    try {
      const [canonicalRoot, canonicalPath] = await Promise.all([fsRealpath(root), fsRealpath(join(root, relPath))]);
      const rel = relative(canonicalRoot, canonicalPath);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
      return await readFile(canonicalPath, "utf8");
    } catch {
      return null;
    }
  }

  /** The npm test script of a package text, resolved to its immutable base
   *  command body (WORLDLINES §6.8): a candidate's changed test config
   *  never changes what the evidence runs. */
  private detectTestFromPkg(pkgText: string): { command: string; args: string[]; label: string } | null {
    try {
      const pkg = JSON.parse(pkgText) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      const names = Object.keys(scripts);
      const pick = names.includes("test") ? "test" : names.find((n) => n.startsWith("test:"));
      if (pick) {
        const body = (scripts[pick] ?? "").trim();
        if (!body) return null;
        // A simple invocation runs directly; a shell body runs under sh.
        const tokens = body.split(/\s+/);
        if (tokens.some((t) => /[|&;<>()]/.test(t) || /[=$]/.test(t))) return { command: "sh", args: ["-c", body], label: `npm run ${pick}` };
        return { command: tokens[0] ?? "true", args: tokens.slice(1), label: `npm run ${pick}` };
      }
    } catch {
      /* no package.json */
    }
    return null;
  }

  /** The pytest/cargo/go detection of a workspace. */
  private async detectTestFromFiles(cwd: string): Promise<{ command: string; args: string[]; label: string } | null> {
    try {
      await stat(join(cwd, "pytest.ini"));
      return { command: "pytest", args: [], label: "pytest" };
    } catch {
      const pyproject = await this.safeWorkspaceRead(cwd, "pyproject.toml");
      if (pyproject?.includes("[tool.pytest")) return { command: "pytest", args: [], label: "pytest" };
    }
    try {
      await stat(join(cwd, "Cargo.toml"));
      return { command: "cargo", args: ["test"], label: "cargo test" };
    } catch {
      /* Cargo is not configured. */
    }
    try {
      await stat(join(cwd, "go.mod"));
      return { command: "go", args: ["test", "./..."], label: "go test ./..." };
    } catch {
      return null;
    }
  }

  /** The test command of a captured state (the shared base). */
  private async detectTestFromState(store: SnapshotStore, stateId: string): Promise<{ command: string; args: string[]; label: string } | null> {
    const pkg = await store.readBlob(stateId, "package.json");
    if (pkg) {
      const fromPkg = this.detectTestFromPkg(pkg.toString("utf8"));
      if (fromPkg) return fromPkg;
    }
    return null;
  }

  /** The benchmark harness config of a captured state, or null. */
  private async benchmarkConfigFrom(store: SnapshotStore, stateId: string): Promise<{ command: string[]; unit: string; direction: "lower" | "higher"; samples: number; thresholdPct: number } | null> {
    const pkg = await store.readBlob(stateId, "package.json");
    if (!pkg) return null;
    try {
      const cfg = (JSON.parse(pkg.toString("utf8")) as { "termina"?: { benchmark?: { command?: string; unit?: string; direction?: string; samples?: number; thresholdPct?: number } } })["termina"]?.benchmark;
      if (!cfg?.command) return null;
      return {
        command: cfg.command.split(/\s+/),
        unit: cfg.unit ?? "ms",
        direction: cfg.direction === "higher" ? "higher" : "lower",
        samples: Math.min(10, Math.max(3, cfg.samples ?? 5)),
        thresholdPct: Math.max(1, cfg.thresholdPct ?? 5) / 100,
      };
    } catch {
      return null;
    }
  }

  private async runVerify(ownerId: string): Promise<{ ok: boolean; error?: string }> {
    const owner = this.terminals.get(ownerId);
    if (!owner) return { ok: false, error: "terminal not found" };
    const verifyOwnerId = this.projectOfTerminal(ownerId)?.id;
    if (this.disposed || this.projectIsSwitching(verifyOwnerId)) return { ok: false, error: "the project is changing" };
    if (this.verifyRuns.has(ownerId)) return { ok: false, error: "a verify run is already in progress" };
    this.verifyRuns.add(ownerId);
    // Run candidate tests inside the candidate sandbox. The tests cannot write
    // the primary project.
    const verifyOwner = this.projectOfTerminal(ownerId);
    const candidate = verifyOwner?.worldlines?.candidateSandboxOf(ownerId) ?? null;
    const cwd = candidate?.root ?? this.terminalCwd();
    let tc: { command: string; args: string[]; label: string } | null;
    try {
      tc = await this.detectTestCommand(cwd);
    } catch (err) {
      this.verifyRuns.delete(ownerId);
      return { ok: false, error: `could not detect the test command: ${(err as Error).message}` };
    }
    if (!tc) {
      this.verifyRuns.delete(ownerId);
      return { ok: false, error: "no test command detected (looked for package.json scripts, pytest, cargo, go)" };
    }
    if (
      this.disposed ||
      this.projectIsSwitching(verifyOwnerId) ||
      this.terminals.get(ownerId) !== owner ||
      (candidate && (!verifyOwner?.worldlines?.candidateSandboxOf(ownerId) || !existsSync(candidate.root)))
    ) {
      this.verifyRuns.delete(ownerId);
      return { ok: false, error: "the project is changing" };
    }

    let child: ReturnType<typeof spawn>;
    try {
      const shells = await detectShells();
      const shell = shells[0] ?? { path: "/bin/zsh", name: "zsh" };
      const cmdline = `${tc.command} ${tc.args.map(quoteShellArg).join(" ")}`;
      const command = candidate ? "sandbox-exec" : shell.path;
      const args = candidate
        ? ["-f", writeEvidenceProfile(candidate), shell.path, "-c", `${sandboxShellPreamble()} ${cmdline}`]
        : ["-c", cmdline];
      const env = candidate
        ? { ...cleanEnv(), HOME: candidate.homeDir, TMPDIR: candidate.tmpDir, TERMINA_EVENTS_DIR: candidate.eventsDir }
        : { ...cleanEnv() };
      child = spawn(command, args, {
        cwd,
        detached: process.platform !== "win32",
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      this.verifyRuns.delete(ownerId);
      return { ok: false, error: `could not start the background test: ${(err as Error).message}` };
    }

    const job: VerifyJob = { child, interrupted: false };
    this.verifyJobs.set(ownerId, job);
    let output = "";
    let finished = false;
    let escalateTimer: ReturnType<typeof setTimeout> | null = null;
    const appendOutput = (data: Buffer | string): void => {
      if (output.length >= MAX_VERIFY_OUTPUT) return;
      output += data.toString().slice(0, MAX_VERIFY_OUTPUT - output.length);
    };
    const finish = (code: number | null, how: VerifyState): void => {
      if (finished) return;
      finished = true;
      clearTimeout(verifyTimer);
      if (escalateTimer) clearTimeout(escalateTimer);
      this.verifyRuns.delete(ownerId);
      this.verifyJobs.delete(ownerId);
      if (this.terminals.get(ownerId) !== owner || this.projectIsSwitching(this.projectOfTerminal(ownerId)?.id) || this.disposed) return;
      let summary = how === "pass" ? "tests green" : how === "timeout" ? "tests timed out" : how === "cancelled" ? "cancelled" : "tests failing";
      let failed: { count: number; names: string[] } | null = null;
      if (how === "fail") {
        try {
          const parsed = parseFailingTests(output);
          if (parsed.count > 0) {
            failed = parsed;
            summary = verifyFailSummary(parsed);
          }
        } catch {
          /* Keep the generic failing summary. Parsing never fails the run. */
        }
      }
      owner.verify = { state: how, command: tc.label, summary };
      // Do not write a result for a cancelled run. The previous context stays.
      if (how !== "cancelled") this.writeVerifyContext(ownerId, tc.label, how, code, output, failed);
      this.send("verify:state", { terminalId: ownerId, verify: owner.verify });
    };
    const verifyTimer = setTimeout(() => {
      console.warn(`[main] background verify timed out after 600s for ${ownerId}`);
      finish(null, "timeout");
      this.killVerifyChild(child, "SIGTERM");
      // Escalate when the group ignores SIGTERM: a survivor keeps writing
      // into the workspace after the run reports timed out.
      escalateTimer = setTimeout(() => this.killVerifyChild(child, "SIGKILL"), 5000);
    }, 10 * 60 * 1000);

    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);
    child.once("error", (err) => {
      appendOutput(err.message);
      if (!finished) finish(null, job.interrupted ? "cancelled" : "fail");
    });
    child.once("close", (code) => {
      if (!finished) finish(code, job.interrupted ? "cancelled" : code === 0 ? "pass" : "fail");
    });

    owner.verify = { state: "running", command: tc.label, summary: "running…" };
    this.send("verify:state", { terminalId: ownerId, verify: owner.verify });
    return { ok: true };
  }

  private killVerifyChild(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
    const pid = child.pid;
    try {
      if (process.platform !== "win32" && pid && pid > 0) process.kill(-pid, signal);
      else child.kill(signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* The process already exited. */
      }
    }
  }

  private cancelVerifyForComparison(comparisonId: string): void {
    for (const ownerId of [...this.verifyRuns]) {
      const owner = this.terminals.get(ownerId);
      const workspace = owner ? this.projectOfTerminal(ownerId)?.workspaces.get(owner.workspaceId) : undefined;
      if (workspace?.comparisonId !== comparisonId) continue;
      if (this.verifyJobs.has(ownerId)) this.cancelVerify(ownerId);
      else this.verifyRuns.delete(ownerId);
    }
  }

  private cancelVerify(ownerId: string): { ok: boolean; error?: string } {
    if (!this.terminals.has(ownerId)) return { ok: false, error: "terminal not found" };
    const job = this.verifyJobs.get(ownerId);
    if (!job || !this.verifyRuns.has(ownerId)) return { ok: false, error: "no verify run is in progress" };
    job.interrupted = true;
    this.killVerifyChild(job.child, "SIGINT");
    return { ok: true };
  }

  private async drainVerifyJobs(ids: Iterable<string> | null, timeoutMs = 2000): Promise<void> {
    const target = ids === null ? null : new Set(ids);
    const matchingJobs = (): VerifyJob[] =>
      [...this.verifyJobs.entries()]
        .filter(([id]) => target === null || target.has(id))
        .map(([, job]) => job);
    for (const job of matchingJobs()) this.killVerifyChild(job.child, "SIGTERM");
    const deadline = Date.now() + timeoutMs;
    while (matchingJobs().length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (const job of matchingJobs()) this.killVerifyChild(job.child, "SIGKILL");
    for (const id of [...this.verifyJobs.keys()]) {
      if (target === null || target.has(id)) this.verifyJobs.delete(id);
    }
    for (const id of [...this.verifyRuns.keys()]) {
      if (target === null || target.has(id)) this.verifyRuns.delete(id);
    }
  }

  /** Write the verify result to the context file the bridge extension reads. */
  private writeVerifyContext(
    ownerId: string,
    label: string,
    state: VerifyState,
    code: number | null,
    output: string,
    failed: { count: number; names: string[] } | null = null,
  ): void {
    const owner = this.terminals.get(ownerId);
    const eventsDir = owner ? this.eventsDirOf(owner) : this.eventsDir;
    try {
      mkdirSync(eventsDir, { recursive: true, mode: 0o700 });
      const stamp = new Date().toISOString();
      const status = state === "pass" ? "✅ PASSED" : state === "timeout" ? "⏰ TIMED OUT" : "❌ FAILED";
      const failLine =
        failed && failed.count > 0
          ? `**Failed:** ${failed.count} — ${failed.names.map((n) => `\`${n}\``).join(", ")}\n\n`
          : "";
      const body = output.trim().slice(-6000);
      const md =
        `## Test run — \`${label}\` — ${stamp}\n\n` +
        `**Status:** ${status}${code !== null ? ` (exit code ${code})` : ""}\n\n` +
        failLine +
        (body ? `<details>\n<summary>Output</summary>\n\n\`\`\`text\n${body}\n\`\`\`\n</details>\n` : "");
      writeFileSync(join(eventsDir, `verify-${ownerId}.md`), md, "utf8");
    } catch (err) {
      console.warn(`[main] could not write verify context: ${(err as Error).message}`);
    }
  }

  // ------------------------------------------------------------ plan board --

  /** Send the current plan to the renderer. */
  private sendPlan(inst: PiTerminalInstance): void {
    this.send("plan:update", { instanceId: inst.id, tasks: inst.plan });
  }

  private applyPlanMessage(inst: PiTerminalInstance, text: string): void {
    if (!inst.busy) return;
    const tasks = parsePlanTasks(
      text,
      this.workspaceOfTerminal(inst)?.root ?? null,
      (p) => this.canonicalPath(p),
    );
    if (tasks.length === 0) return;
    inst.plan = tasks;
    // Do not reset touched or tool outcomes. The plan can arrive after
    // the first tool events, and their progress must count.
    reattachDispatchAssignments(
      inst.plan,
      [...this.dispatchRuns]
        .filter(([, entry]) => entry.ownerId === inst.id)
        .map(([workerId, entry]) => ({ workerId, taskText: entry.taskText })),
    );
    this.sendPlan(inst);
  }

  private updatePlanProgress(inst: PiTerminalInstance, path: string): void {
    if (markPlanProgress(inst.plan, this.rel(path))) this.sendPlan(inst);
  }

  private finalizePlan(inst: PiTerminalInstance): void {
    if (inst.plan.length === 0) return;
    finalizePlanTasks(inst.plan, inst.touched, inst.toolOutcomes);
    this.sendPlan(inst);
  }

  // ------------------------------------------------------ session search ----

  /** The sessions directory name for a project path: "--" + the canonical
   *  path with separators replaced by dashes + "--". One sanitizer serves
   *  the session picker and the promotion install. */
  private sanitizeSessionDir(absPath: string): string {
    const p = absPath.replace(/^[/\\]+/, "").replace(/[/\\]+$/, "").replace(/[/\\:]/g, "-");
    return "--" + p + "--";
  }

  private searchSessionsSeq = 0;

  /**
   * Search past session files for the active project (Pi and core).
   * Streams lines asynchronously so the main process stays responsive.
   * Bounded to the 50 newest sessions and 50 total hits.
   */
  private async searchSessions(query: string): Promise<SessionHit[]> {
    const project = this.project();
    const cwd = project?.cwd ?? null;
    if (!project || !cwd || query.trim().length < 2) return [];
    const projectCwd = this.canonicalPath(cwd);
    const key = this.sanitizeSessionDir(projectCwd);
    const piDir = join(homedir(), ".pi", "agent", "sessions", key);
    const coreDir = join(this.coreSessionRoot(), key);
    const seq = ++this.searchSessionsSeq;
    const extra = await this.extraSessionFiles(project);
    const files = mergeSessionFiles([
      await listSessionJsonl(piDir),
      await listSessionJsonl(coreDir),
      extra,
    ]);
    const hits = await searchSessionFiles({
      query,
      files,
      projectCwd,
      canonicalize: (absPath) => this.canonicalPath(absPath),
      isProjectFile: (relPath, root) => this.isProjectFile(relPath, root),
      shouldStop: () => seq !== this.searchSessionsSeq || this.disposed,
    });
    return seq === this.searchSessionsSeq ? hits : [];
  }

  /** Live persist tabs and unrestored roster entries (flat paths still count). */
  private async extraSessionFiles(project: ProjectState): Promise<SessionFileEntry[]> {
    const paths: string[] = [];
    for (const id of project.terminalIds) {
      const inst = this.terminals.get(id);
      if (inst?.persist && inst.sessionFile) paths.push(inst.sessionFile);
    }
    for (const rec of project.unrestoredTerminals) {
      if (rec.sessionFile) paths.push(rec.sessionFile);
    }
    const out: SessionFileEntry[] = [];
    for (const path of paths) {
      let real = path;
      try {
        real = realpathSync(path);
      } catch {
        /* keep the unresolved path */
      }
      const entry = await sessionFileEntry(real);
      if (entry) out.push(entry);
    }
    return out;
  }

  private isProjectFile(relPath: string, projectCwd: string): boolean {
    if (!relPath || relPath.startsWith("..") || isAbsolute(relPath)) return false;
    const abs = join(projectCwd, relPath);
    if (!this.withinProject(abs)) return false;
    try {
      return existsSync(abs) && statSync(abs).isFile();
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------- dispatch --

  /** Normalize a task path to a comparable key (canonical absolute path). */
  private taskPathKey(p: string, root: string): string {
    return this.canonicalPath(join(root, p));
  }

  /** True when an active verify or dispatch overlaps the given workspace. */
  private overlapInWorkspace(workspaceId: string): boolean {
    for (const id of this.verifyRuns) {
      const inst = this.terminals.get(id);
      if (inst && inst.workspaceId === workspaceId) return true;
    }
    for (const entry of this.dispatchRuns.values()) {
      const owner = this.terminals.get(entry.ownerId);
      if (owner && owner.workspaceId === workspaceId) return true;
    }
    return false;
  }

  private ownerDispatchCount(ownerId: string): number {
    let n = 0;
    for (const entry of this.dispatchRuns.values()) {
      if (entry.ownerId === ownerId) n++;
    }
    return n;
  }

  /** Canonical paths already claimed by this owner's live workers. */
  private dispatchPathKeysInFlight(ownerId: string, root: string): Set<string> {
    const used = new Set<string>();
    const owner = this.terminals.get(ownerId);
    if (!owner) return used;
    for (const entry of this.dispatchRuns.values()) {
      if (entry.ownerId !== ownerId) continue;
      const task = findTaskByText(owner.plan, entry.taskText);
      if (!task) continue;
      for (const p of task.paths) used.add(this.taskPathKey(p, root));
    }
    return used;
  }

  /** Live workers plus the jobs about to start. Briefings list sibling claims. */
  private dispatchJobsForBriefing(
    owner: PiTerminalInstance,
    extra: Array<{ task: PlanTask; id: string }>,
  ): Array<{ task: PlanTask; id: string }> {
    const jobs: Array<{ task: PlanTask; id: string }> = [];
    const seen = new Set<string>();
    for (const [id, entry] of this.dispatchRuns) {
      if (entry.ownerId !== owner.id) continue;
      const task = findTaskByText(owner.plan, entry.taskText);
      if (!task) continue;
      jobs.push({ task, id });
      seen.add(id);
    }
    for (const job of extra) {
      if (seen.has(job.id)) continue;
      jobs.push(job);
    }
    return jobs;
  }

  private async dispatchRun(
    ownerId: string,
    taskText?: string,
  ): Promise<{ ok: boolean; error?: string; dispatched?: number }> {
    const owner = this.terminals.get(ownerId);
    if (!owner || owner.type !== "agent") return { ok: false, error: "terminal not found" };
    if (owner.plan.length === 0) return { ok: false, error: "the plan board is empty — ask the agent for a plan first" };
    const ownerWs = this.workspaceOfTerminal(owner);
    for (const entry of this.dispatchRuns.values()) {
      if (entry.ownerId === ownerId) continue;
      const running = this.terminals.get(entry.ownerId);
      if (running && ownerWs && running.workspaceId === ownerWs.id) {
        return { ok: false, error: "a dispatch is already running" };
      }
    }
    const dispatchRoot = ownerWs?.root ?? owner.cwd;
    const picked = pickDispatchTasks({
      plan: owner.plan,
      remainingSlots: MAX_DISPATCH_WORKERS - this.ownerDispatchCount(owner.id),
      inFlightPathKeys: this.dispatchPathKeysInFlight(owner.id, dispatchRoot),
      pathKey: (p) => this.taskPathKey(p, dispatchRoot),
      taskText,
    });
    if (picked.error) return { ok: false, error: picked.error };
    const chosen = picked.tasks;
    const alreadyDispatching = this.ownerDispatchCount(ownerId) > 0;
    if (owner.busy && !alreadyDispatching) owner.pty.write("\x03"); // the workers replace the owner's run
    // Structured startup skips the interactive preflight. Flush once so
    // unsaved editor buffers land before the workers write.
    if (ownerWs) {
      const flush = await this.flushDirtyModels(`dispatch:${ownerId}`, ownerWs.id);
      if (!flush.ok) return { ok: false, error: "could not save editor changes" };
    }
    const jobs = chosen.map((task) => ({ task, id: this.allocateTerminalId() }));
    try {
      mkdirSync(this.eventsDir, { recursive: true, mode: 0o700 });
      this.eventsDirReady = true;
      const briefingJobs = this.dispatchJobsForBriefing(owner, jobs);
      for (const job of jobs) {
        this.writeDispatchBriefing(job.id, job.task, briefingJobs);
        this.writeDispatchStartupControl(job.id, job.task.text);
      }
    } catch (err) {
      for (const job of jobs) {
        this.clearMailbox(job.id);
        this.removeDispatchStartupControl(job.id);
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    let dispatched = 0;
    for (const job of jobs) {
      try {
        const worker = await this.createTerminal(undefined, {
          type: "agent",
          engine: owner.engine === "core" ? "core" : "pi",
          workspaceId: owner.workspaceId,
          id: job.id,
          fromTerminalId: ownerId,
        });
        this.dispatchWorkers.set(worker.id, job.task.text);
        this.dispatchRuns.set(worker.id, { ownerId, taskText: job.task.text });
        job.task.workerId = worker.id;
        job.task.claimed = [...job.task.paths];
        job.task.state = "active";
        dispatched++;
      } catch (err) {
        this.clearMailbox(job.id);
        this.removeDispatchStartupControl(job.id);
        console.warn(`[main] dispatch worker failed: ${(err as Error).message}`);
      }
    }
    if (dispatched === 0) {
      for (const job of jobs) {
        this.clearMailbox(job.id);
        this.removeDispatchStartupControl(job.id);
      }
      return { ok: false, error: "no dispatch worker started" };
    }
    this.sendPlan(owner);
    return { ok: true, dispatched };
  }

  private static readonly MAX_MAILBOX_BYTES = 4 * 1024;
  private static readonly MAX_MAILBOX_NOTES = 20;

  /** True when this terminal's bridge reads a Worldline events directory. */
  private isWorldlineTerminal(terminalId: string): boolean {
    return !!this.projectOfTerminal(terminalId)?.worldlines?.eventsDirOf(terminalId);
  }

  /** Primary events-dir mailbox path. Worldline terminals have no mailbox. */
  private mailboxFile(terminalId: string): string | null {
    if (this.isWorldlineTerminal(terminalId)) return null;
    return join(this.eventsDir, `mailbox-${terminalId}.md`);
  }

  private writeDispatchBriefing(workerId: string, assigned: PlanTask, jobs: Array<{ task: PlanTask; id: string }>): void {
    let briefing = formatDispatchBriefing(workerId, assigned, jobs);
    if (briefing.length > PiEditorApp.MAX_MAILBOX_BYTES) {
      briefing = briefing.slice(0, PiEditorApp.MAX_MAILBOX_BYTES) + "\n…";
    }
    this.dispatchMailbox.set(workerId, [briefing]);
    this.flushMailbox(workerId);
  }

  private writeDispatchStartupControl(workerId: string, taskText: string): void {
    const target = join(this.eventsDir, `startup-control-${workerId}.json`);
    const temporary = `${target}.tmp-${randomUUID()}`;
    const control = { opId: randomUUID(), action: "structured", content: [{ type: "text", text: taskText }] };
    this.ensureEventsDir();
    writeFileSync(temporary, JSON.stringify(control), { mode: 0o600 });
    renameSync(temporary, target);
  }

  private removeDispatchStartupControl(workerId: string): void {
    rmSync(join(this.eventsDir, `startup-control-${workerId}.json`), { force: true });
  }

  /** Remove leftover dispatch control and mailbox files. The events
   *  directory persists across launches, and terminal ids restart at
   *  term-1, so a stale control would submit the old task. */
  private cleanupStaleDispatchFiles(): void {
    let names: string[] = [];
    try {
      names = readdirSync(this.eventsDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (
        name === "startup-control.json" ||
        name.startsWith("mailbox-term-") ||
        name.startsWith("startup-control-term-") ||
        name.startsWith("image-term-") ||
        name.startsWith("images-term-") ||
        name.startsWith("images-claim-term-") ||
        name.startsWith("images-owner-term-") ||
        name.startsWith("images-tx-term-")
      ) {
        rmSync(join(this.eventsDir, name), { force: true });
      }
    }
  }

  private dispatchGroupIds(ownerId: string): string[] {
    const ids = new Set<string>([ownerId]);
    for (const [workerId, entry] of this.dispatchRuns) {
      if (entry.ownerId === ownerId) ids.add(workerId);
    }
    return [...ids];
  }

  private ensureEventsDir(): void {
    if (this.eventsDirReady) return;
    mkdirSync(this.eventsDir, { recursive: true, mode: 0o700 });
    this.eventsDirReady = true;
  }

  private appendMailboxNote(terminalId: string, note: string): void {
    if (this.isWorldlineTerminal(terminalId)) return;
    const notes = this.dispatchMailbox.get(terminalId) ?? [];
    notes.push(note);
    while (notes.length > PiEditorApp.MAX_MAILBOX_NOTES) notes.shift();
    this.dispatchMailbox.set(terminalId, notes);
    this.flushMailbox(terminalId);
  }

  private flushMailbox(terminalId: string): void {
    const path = this.mailboxFile(terminalId);
    if (!path) return;
    const notes = this.dispatchMailbox.get(terminalId) ?? [];
    try {
      if (notes.length === 0) {
        rmSync(path, { force: true });
        return;
      }
      let body = notes.join("\n\n---\n\n");
      while (body.length > PiEditorApp.MAX_MAILBOX_BYTES && notes.length > 1) {
        notes.shift();
        body = notes.join("\n\n---\n\n");
      }
      if (body.length > PiEditorApp.MAX_MAILBOX_BYTES) body = body.slice(0, PiEditorApp.MAX_MAILBOX_BYTES) + "\n…";
      this.ensureEventsDir();
      writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
    } catch (err) {
      console.warn(`[main] could not write mailbox context: ${(err as Error).message}`);
    }
  }

  private clearMailbox(terminalId: string): void {
    if (!this.dispatchMailbox.has(terminalId)) return;
    this.dispatchMailbox.delete(terminalId);
    const path = this.mailboxFile(terminalId);
    if (path) {
      try {
        rmSync(path, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  private writeDispatchSettleNote(worker: PiTerminalInstance, status: "settled" | "exited"): void {
    const dispatch = this.dispatchRuns.get(worker.id);
    if (!dispatch) return;
    const touched = [...worker.touched].map((p) => `\`${p}\``).join(", ");
    const note = [
      `## Sibling ${status} (\`${worker.id}\`)`,
      "",
      `Task: ${dispatch.taskText}`,
      `Status: ${status}`,
      touched ? `Touched: ${touched}` : "Touched: none",
    ].join("\n");
    for (const id of this.dispatchGroupIds(dispatch.ownerId)) {
      if (id === worker.id) continue;
      this.appendMailboxNote(id, note);
    }
  }

  /** Copy a finished worker's files and baselines into the owner's review. */
  private collectWorker(worker: PiTerminalInstance, owner: PiTerminalInstance): void {
    let changed = false;
    for (const [p, f] of worker.modified) {
      if (!owner.modified.has(p)) {
        this.setBounded(owner.modified, p, f, PiEditorApp.MAX_MODIFIED_FILES);
        changed = true;
      }
    }
    for (const [p, b] of worker.baselines) {
      if (!owner.baselines.has(p)) this.setBaseline(owner, p, b);
    }
    if (changed) this.send("modified:list", { instanceId: owner.id, files: [...owner.modified.values()] });
  }

  // ----------------------------------------------------------------- mine ----

  /** Mark a file as the user's own (or clear the mark). */
  private setMineFile(path: string, mine: boolean): void {
    const project = this.project();
    if (!project) return;
    const managed = this.managedPath(path, true);
    if (!managed) return;
    const p = managed.path;
    if (mine) {
      if (!project.mineFiles.has(p) && project.mineFiles.size >= PiEditorApp.MAX_MINE_FILES) return;
      project.mineFiles.add(p);
    } else {
      project.mineFiles.delete(p);
    }
    this.saveMineFiles(project);
    this.writeMineContext(project);
  }

  /** Write the mine context file for the agent terminals of one project. */
  private writeMineContext(project: ProjectState): void {
    try {
      mkdirSync(this.eventsDir, { recursive: true });
    } catch {
      return;
    }
    const md = this.buildMineMarkdown(project);
    for (const inst of this.terminals.values()) {
      if (inst.type !== "agent") continue;
      if (this.projectOfTerminal(inst.id) !== project) continue;
      const eventsDir = this.eventsDirOf(inst);
      try {
        writeFileSync(join(eventsDir, `mine-${inst.id}.md`), md, "utf8");
      } catch (err) {
        console.warn(`[main] could not write mine context: ${(err as Error).message}`);
      }
    }
  }

  /** Build the mine context markdown: one file per line. */
  private buildMineMarkdown(project: ProjectState): string {
    const out: string[] = ["## Your files", "", "These files belong to the user. Do not modify them without asking first.", ""];
    for (const p of project.mineFiles) out.push(`- \`${this.rel(p)}\``);
    return out.join("\n");
  }

  /** Clear the marks and their context files (project switch). The saved
   *  marks stay in their file: revisiting the project restores them. */
  private clearMineFiles(project: ProjectState): void {
    project.mineFiles.clear();
    for (const inst of this.terminals.values()) {
      if (inst.type !== "agent") continue;
      if (this.projectOfTerminal(inst.id) !== project) continue;
      try {
        // Remove from the terminal's OWN events dir (see writeMineContext).
        rmSync(join(this.eventsDirOf(inst), `mine-${inst.id}.md`), { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  /** The persisted marks file for one project. */
  private mineFilePath(project: ProjectState): string {
    const cwd = this.canonicalPath(project.cwd);
    return join(this.eventsDir, `mine-${this.sanitizeSessionDir(cwd)}.json`);
  }

  /** Load the marks saved for one project (restart persistence). */
  private loadMineFiles(project: ProjectState): void {
    try {
      const raw = readFileSync(this.mineFilePath(project), "utf8");
      const list = JSON.parse(raw) as string[];
      if (Array.isArray(list)) {
        for (const p of list) {
          if (project.mineFiles.size >= PiEditorApp.MAX_MINE_FILES) break;
          if (typeof p !== "string") continue;
          const managed = this.managedPath(p, true);
          if (managed) project.mineFiles.add(managed.path);
        }
      }
    } catch {
      /* no marks saved yet */
    }
  }

  /** Save the marks so a restart restores the ownership. */
  private saveMineFiles(project: ProjectState): void {
    try {
      mkdirSync(this.eventsDir, { recursive: true });
      writeFileSync(this.mineFilePath(project), JSON.stringify([...project.mineFiles]), "utf8");
    } catch (err) {
      console.warn(`[main] could not save mine marks: ${(err as Error).message}`);
    }
  }

  // --------------------------------------------------------- user edits ----

  /** Record a change the user made. Keep the FIRST prev so the context file
   *  shows the net change, not the last step. A later prev replaces an
   *  undefined one (the first change of a file has no cached prev). The
   *  stored content is capped: the context file never shows more than 4 KB. */
  private recordUserEdit(ws: WorkspaceState, edit: UserEdit): void {
    const edits = this.userEditsOf(ws);
    // Keep prev undefined when absent: an empty string would render an empty
    // "before" block instead of no block at all.
    const capped = { ...edit, prev: edit.prev === undefined ? undefined : this.snippet(edit.prev), content: this.snippet(edit.content) };
    const existing = edits.get(capped.path);
    if (existing) {
      // Track the latest transition: the cache now always knows the state
      // right before this edit, so the context shows a fresh before block.
      if (capped.prev !== undefined) existing.prev = capped.prev;
      existing.content = capped.content;
      existing.at = capped.at;
    } else {
      edits.set(capped.path, capped);
      if (edits.size > PiEditorApp.USER_EDITS_MAX) {
        // Evict the oldest known edit (map order is insertion order).
        const oldest = edits.keys().next().value;
        if (oldest !== undefined) edits.delete(oldest);
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
    if (this.userEditsByWorkspace.size === 0) return;
    try {
      mkdirSync(this.eventsDir, { recursive: true });
    } catch {
      return;
    }
    for (const inst of this.terminals.values()) {
      if (inst.type !== "agent") continue;
      const ws = this.workspaceOfTerminal(inst);
      if (!ws) continue;
      const edits = this.userEditsOf(ws);
      if (edits.size === 0) continue;
      const md = this.buildUserEditsMarkdown(edits);
      const eventsDir = this.eventsDirOf(inst);
      try {
        writeFileSync(join(eventsDir, `edits-${inst.id}.md`), md, "utf8");
      } catch (err) {
        console.warn(`[main] could not write edits context: ${(err as Error).message}`);
      }
    }
  }

  /** Build the context markdown: one section per file with before/after. */
  private buildUserEditsMarkdown(edits: Map<string, UserEdit>): string {
    // The whole context must stay small: it is injected into the model's
    // context on every turn. Drop the OLDEST edits beyond the cap (the map
    // iterates in insertion order).
    const MAX_CONTEXT_BYTES = 16 * 1024;
    const out: string[] = [];
    out.push("## Your edits");
    out.push("");
    out.push("You changed these files after the last agent run. Read them before you change them.");
    let size = out.join("\n").length;
    for (const edit of edits.values()) {
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

  /** The run consumes the edits context of its workspace. Clear the map and
   *  the context files of that workspace. */
  private clearUserEdits(ws: WorkspaceState): void {
    this.userEditsOf(ws).clear();
    this.removeUserEditsFiles(ws);
  }

  /** Remove the edits context files of a workspace's agent terminals. */
  private removeUserEditsFiles(ws: WorkspaceState): void {
    for (const id of ws.terminalIds) {
      const inst = this.terminals.get(id);
      if (inst?.type !== "agent") continue;
      try {
        // Remove from the terminal's OWN events dir: a candidate's bridge
        // reads its candidate dir, not the primary's.
        rmSync(join(this.eventsDirOf(inst), `edits-${id}.md`), { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  private closeTerminal(id: string): void {
    const inst = this.terminals.get(id);
    if (!inst) return;
    this.newCommandBuffers.delete(id);
    if (inst.captureTimer) {
      clearTimeout(inst.captureTimer);
      inst.captureTimer = null;
    }
    if (this.verifyRuns.has(id)) this.cancelVerify(id);
    inst.pty.kill();
    // pty.onExit removes it from the map
  }

  private closeActiveTerminal(): void {
    const inst = this.activeProjectTerminals().at(-1);
    if (inst) this.closeTerminal(inst.id);
  }

  private async abortActive(): Promise<void> {
    const inst = this.activeProjectTerminals().at(-1);
    if (inst) inst.pty.write("\x03");
  }

  /** The terminals of the active project, in creation order. */
  private activeProjectTerminals(): PiTerminalInstance[] {
    const project = this.project();
    return [...this.terminals.values()].filter((inst) => !project || project.terminalIds.has(inst.id));
  }

  private instanceList(): InstanceSummary[] {
    return [...this.terminals.values()].map((t) => ({
      id: t.id,
      cwd: t.cwd,
      busy: t.busy,
      type: t.type,
      engine: t.engine,
      shellName: t.shellName,
      workspaceId: t.workspaceId,
      projectId: t.projectId ?? undefined,
      dispatchWorker: this.dispatchWorkers.has(t.id),
      dispatchTask: this.dispatchWorkers.get(t.id),
      verify: t.type === "agent" ? t.verify : null,
    }));
  }

  private sendInstances(): void {
    this.send("instances:list", this.instanceList());
  }

  // -------------------------------------------------------------- sidecar ---

  private trackRecordingTask<T>(task: Promise<T>): void {
    this.recordingTasks.add(task);
    void task.then(
      () => this.recordingTasks.delete(task),
      () => this.recordingTasks.delete(task),
    );
  }

  private async drainRecordingTasks(): Promise<void> {
    while (this.recordingTasks.size > 0) {
      await Promise.all([...this.recordingTasks].map((task) => task.catch(() => undefined)));
    }
  }

  private async drainSidecarQueues(): Promise<void> {
    while (this.sidecarQueues.size > 0) {
      await Promise.all([...this.sidecarQueues.values()].map((task) => task.catch(() => undefined)));
    }
  }

  private enqueueSidecarEvent(terminalId: string, event: SidecarEvent): void {
    if (this.disposed) return;
    if (this.projectIsSwitching(this.projectOfTerminal(terminalId)?.id)) return;
    const previous = this.sidecarQueues.get(terminalId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.handleSidecarEvent(terminalId, event))
      .finally(() => {
        if (this.sidecarQueues.get(terminalId) === next) this.sidecarQueues.delete(terminalId);
      });
    this.sidecarQueues.set(terminalId, next);
  }

  private async handleSidecarEvent(terminalId: string, event: SidecarEvent): Promise<void> {
    if (this.disposed) return;
    const inst = this.terminals.get(terminalId);
    if (!inst) return;
    if (this.projectIsSwitching(this.projectOfTerminal(terminalId)?.id)) return;
    switch (event.t) {
      // ---- run-boundary events (WORLDLINES §6.3) ----
      case "preflight_request":
        this.trackRecordingTask(this.handlePreflightRequest(inst, String(event.requestId ?? "")));
        break;
      case "prompt": {
        const file = String(event.file ?? "");
        // The payload file must be a plain name inside the events dir.
        if (!file || file.includes("/") || file.includes("\\")) break;
        try {
          const dir = this.eventsDirOf(inst);
          const payloadPath = await this.safeEventsFile(dir, file);
          if (!payloadPath) throw new Error("prompt payload path is outside the events directory");
          const info = await stat(payloadPath);
          if (info.size > MAX_PROMPT_BYTES) throw new Error("prompt payload exceeds the 20 MB budget");
          const raw = await readFile(payloadPath, "utf8");
          const payload = JSON.parse(raw) as { prompt?: unknown; images?: unknown };
          inst.pendingPrompt = {
            file,
            text: String(payload.prompt ?? "").slice(0, 64000),
            images: Array.isArray(payload.images) ? payload.images.length : 0,
          };
          if (inst.pendingPrompt.text && this.isNewCommand(inst.pendingPrompt.text)) {
            this.clearForNewSession(terminalId);
          }
        } catch {
          inst.pendingPrompt = null;
        }
        break;
      }
      case "steer_input":
        // A steering or queued follow-up message: the open run cannot be
        // replayed as one task.
        if (inst.currentRun && inst.currentRun.replayable) {
          inst.currentRun.replayable = false;
          inst.currentRun.reason = "a steering message interrupted the run";
          inst.currentRun.steering = true;
        }
        break;
      case "checkpoint_request":
        this.trackRecordingTask(this.handleCheckpointRequest(inst, String(event.requestId ?? ""), String(event.kind ?? "settled"), String(event.entryId ?? "")));
        break;
      case "checkpoint_result":
        // Informational; the run record carries the result already.
        break;
      case "session_ready": {
        // The bridge consumed the candidate startup control.
        const readyOk = event.ok === true;
        this.projectOfTerminal(terminalId)?.worldlines?.onSessionReady(terminalId, readyOk, String(event.error ?? null) || null);
        break;
      }
      case "agent_settings":
        this.applyAgentSettings(inst, event.model, event.thinkingLevel);
        break;
      case "agent_start":
        this.applyAgentSettings(inst, event.model, event.thinkingLevel);
        inst.busy = true;
        // Track busy agents: a second agent starting in the same workspace
        // overlaps this run (marked in coupleRunStart, WORLDLINES §5).
        if (inst.type === "agent") this.busyAgents.add(inst.id);
        // A candidate run invalidates its comparison's evidence: the head
        // moved (WORLDLINES §6.8 — results are bound to the measured state).
        const agentOwner = this.projectOfTerminal(inst.id);
        const candHit = (agentOwner?.worldlines?.list() ?? []).find((w) => w.terminalId === inst.id);
        // The run consumes the user-edits context (the extension already read
        // it in before_agent_start). Clear it so the next run stays fresh.
        const startWs = this.workspaceOfTerminal(inst);
        if (startWs) this.clearUserEdits(startWs);
        this.clearMailbox(inst.id);
        // The old run's plan is stale until the new plan message arrives.
        inst.plan = [];
        inst.touched = new Set();
        inst.pendingFileTools = new Map();
        inst.toolOutcomes = new Map();
        this.sendPlan(inst);
        this.sendTimelinePrefix(inst);
        // Baseline for Change Review: snapshot the watcher's content cache so
        // diffs compare the run's start state against the current files.
        this.resetBaselines(inst, startWs?.watcher?.lastContents);
        inst.runSnapshots.clear();
        inst.runSnapshotBytes = 0;
        inst.lastToolAt.clear();
        inst.pendingHints = new Set();
        inst.momentDots = [];
        inst.captureTimer = null;
        this.pushTimeline(inst, { t: "agent_start" });
        // The run records moments: the recorder state follows the store.
        const startWs2 = this.workspaceOfTerminal(inst);
        void agentOwner?.storePromise?.then((s) => {
          if (!this.disposed && !this.projectIsSwitching(agentOwner?.id) && this.terminals.has(inst.id)) {
            this.setRecorderState(inst, !s ? "paused" : startWs2?.indexReady ? "indexing" : "ready");
          }
        });
        // Couple the run to its start preflight when the token matches.
        this.coupleRunStart(inst, event);
        // A dispatch worker started: mark its task active on the owner board.
        const dispatchStart = this.dispatchRuns.get(inst.id);
        if (dispatchStart) {
          const ownerInst = this.terminals.get(dispatchStart.ownerId);
          const task = ownerInst ? findTaskByText(ownerInst.plan, dispatchStart.taskText) : undefined;
          if (ownerInst && task) {
            task.state = "active";
            this.sendPlan(ownerInst);
          }
        }
        this.send("busy", { instanceId: inst.id, busy: true });
        this.sendInstances();
        // Push invalidation after the busy state. The renderer must not start
        // evidence from the stale idle view between these two updates.
        if (candHit) this.markCandidateEvidenceStale(candHit.comparisonId);
        break;
      case "agent_settled":
        inst.busy = false;
        this.busyAgents.delete(inst.id);
        this.finalizePlan(inst);
        // A dispatch worker finished: mark the owner task done only when
        // the worker's last file-tool outcomes cover that task's paths.
        const dispatchEnd = this.dispatchRuns.get(inst.id);
        if (dispatchEnd) {
          this.writeDispatchSettleNote(inst, "settled");
          const ownerInst = this.terminals.get(dispatchEnd.ownerId);
          const task = ownerInst ? findTaskByText(ownerInst.plan, dispatchEnd.taskText) : undefined;
          if (ownerInst) {
            if (task && taskIsComplete(task.paths, inst.touched, inst.toolOutcomes)) task.state = "done";
            this.sendPlan(ownerInst);
            this.collectWorker(inst, ownerInst);
          }
          // The run entry goes; the tab label stays until the terminal exits.
          this.dispatchRuns.delete(inst.id);
        }
        this.pushTimeline(inst, { t: "agent_settled" });
        this.send("busy", { instanceId: inst.id, busy: false });
        this.send("modified:list", { instanceId: inst.id, files: [...inst.modified.values()] });
        this.sendInstances();
        break;
      case "plan": {
        this.applyPlanMessage(inst, String(event.text ?? ""));
        break;
      }
      case "tool": {
        const rawPath = String(event.path ?? "");
        // Candidate tool paths resolve against the candidate root; the
        // within-project guard applies to the primary only (nested moments).
        const toolWs = this.workspaceOfTerminal(inst);
        const toolBase = toolWs?.root ?? this.projectOfTerminal(inst.id)?.cwd ?? null;
        const path = this.canonicalPath(isAbsolute(rawPath) ? rawPath : toolBase ? join(toolBase, rawPath) : rawPath);
        if (!path) return;
        const isCandidateTerminal = !!this.projectOfTerminal(inst.id)?.worldlines?.eventsDirOf(inst.id);
        if (isCandidateTerminal) {
          // Reject file-tool paths that resolve outside the candidate root
          // (WORLDLINES §5): the sandbox blocks the write, the guard keeps
          // the timeline and baselines truthful.
          const root = toolWs?.root ? this.canonicalPath(toolWs.root) : null;
          if (!root || !(path === root || path.startsWith(root + "/"))) return;
        } else if (!this.withinProject(path)) {
          return;
        }
        const toolName = String(event.toolName ?? "");
        // Pre-run baseline capture. The rules:
        // - agent_start snapshots the watcher cache (best source when present).
        // - edit/apply_patch reconstruct from the edit args — correct in both
        //   poll orderings (landed or not). They also recover a null baseline
        //   invalid baseline from a first-touch write without cached content.
        // - write/create_file defer to the watcher change event, which knows
        //   the authoritative status and carries prev when available.
        if (toolName === "edit" || toolName === "apply_patch") {
          const current = inst.baselines.get(path);
          if (current === undefined) {
            const status = inst.modified.get(path)?.status;
            if (status !== "created") {
              const baseline = (await this.reconstructBaseline(path, event.edits)) ?? this.workspaceOfTerminal(inst)?.watcher?.lastContents.get(path);
              if (baseline !== undefined) this.setBaseline(inst, path, baseline);
            }
            // A file created this run stays undefined until the watcher confirms it.
          } else if (current === null && inst.modified.get(path)?.status === "modified") {
            const baseline = await this.reconstructBaseline(path, event.edits);
            if (baseline !== undefined) this.setBaseline(inst, path, baseline);
          }
        }
        const status = toolName === "write" ? this.classifyWrite(path) : "modified";
        this.recordModified(inst, path, status);
        if ((toolName === "write" || toolName === "create_file") && !inst.baselines.has(path)) {
          this.trackRecordingTask(this.fillBaseline(inst, path, status));
        }
        const rel = this.rel(path);
        inst.touched.add(rel);
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId.trim() : "";
        if (toolCallId && rel) inst.pendingFileTools.set(toolCallId, rel);
        this.updatePlanProgress(inst, path);
        this.sendTimelinePrefix(inst);
        this.send("tool:target", { path, relPath: this.rel(path), toolName });
        // Session Timeline: snapshot the file as of this tool call. Create
        // the event object first so a delayed content fill can find it later.
        // The tool call and entry ids make the dot a forkable moment.
        const ev: Omit<TimelineEvent, "seq" | "ts"> = {
          t: "tool",
          toolName,
          path,
          relPath: this.rel(path, toolWs?.root ?? null),
          toolCallId: event.toolCallId ?? null,
          entryId: event.entryId ?? null,
          model: inst.currentRun?.model ?? null,
        };
        const snapshot = this.toolSnapshot(inst, path, toolName, event.edits, ev);
        if (snapshot?.content !== undefined) ev.content = snapshot.content;
        if (snapshot?.status) ev.status = snapshot.status;
        this.pushTimeline(inst, ev);
        break;
      }
      case "tool_end": {
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId.trim() : "";
        if (toolCallId) {
          const rel = inst.pendingFileTools.get(toolCallId);
          inst.pendingFileTools.delete(toolCallId);
          // Ignore ends with no matching file-tool start (read, bash, orphan).
          if (rel !== undefined) inst.toolOutcomes.set(rel, event.isError === true ? "error" : "ok");
        }
        this.sendTimelinePrefix(inst);
        // The tool finished: schedule the moment capture for its dots.
        if (inst.currentRun) this.scheduleMomentCapture(inst);
        break;
      }
    }
  }

  /**
   * Compute the file's content right after a tool call:
   * - edit/apply_patch: apply the edit regions to the previously known content
   * - write/create_file: the watcher cache (the change event usually lands
   *   around the same poll; if not, a delayed fill attaches it later)
   * The caller passes the event object so the delayed fill can locate it by
   * reference even if newer events arrive in between.
   */
  // ---------------------------------------------------- run boundaries ----

  /** Write an acknowledgement file for the bridge to consume exactly once. */
  private writeAck(terminalId: string, requestId: string, payload: Record<string, unknown>): void {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) return;
    try {
      // The ack must land in the terminal's OWN events dir: a candidate's
      // bridge polls its candidate events dir, not the primary's.
      const inst = this.terminals.get(terminalId);
      const dir = inst ? this.eventsDirOf(inst) : this.eventsDir;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const target = join(dir, `ack-${terminalId}-${requestId}.json`);
      const temporary = `${target}.tmp-${randomUUID()}`;
      writeFileSync(temporary, JSON.stringify(payload), { mode: 0o600 });
      renameSync(temporary, target);
    } catch (err) {
      console.warn(`[main] could not write ack: ${(err as Error).message}`);
    }
  }

  /** Ask the renderer to save every dirty model. Bounded wait. The workspace
   *  id scopes the waiter to its project on teardown. */
  private flushDirtyModels(writerId: string, workspaceId: string, timeoutMs = 5000): Promise<{ ok: boolean; failed: string[] }> {
    return new Promise((resolve) => {
      const requestId = `flush-${++this.flushSeq}`;
      this.flushWaiters.set(requestId, {
        workspaceId,
        resolve,
        timer: setTimeout(() => {
          this.flushWaiters.delete(requestId);
          resolve({ ok: false, failed: ["renderer did not answer the flush request"] });
        }, timeoutMs),
      });
      this.send("editor:flush-request", { requestId, writerId });
    });
  }

  /**
   * The start preflight (WORLDLINES §6.3 steps 2-5): lease, flush, capture
   * the start state, then answer the bridge with a one-use token. The lease
   * stays held until agent_start consumes the token.
   */
  private async handlePreflightRequest(inst: PiTerminalInstance, requestId: string): Promise<void> {
    if (!requestId) return;
    const ws = this.workspaceOfTerminal(inst);
    if (!ws) {
      // No workspace: nothing to record. The run proceeds without a token.
      this.writeAck(inst.id, requestId, { ok: true, token: null });
      return;
    }
    if (!ws.primary) {
      // A candidate run: Release 1 records primary runs only.
      this.writeAck(inst.id, requestId, { ok: true, token: null });
      return;
    }
    const leaseRequester = `preflight:${inst.id}:${requestId}`;
    const lease = await this.acquireWriteLease(ws.id, leaseRequester, 12000);
    if (!lease.ok) {
      this.writeAck(inst.id, requestId, { ok: false, error: lease.error ?? "the workspace is busy" });
      return;
    }
    const flush = await this.flushDirtyModels(leaseRequester, ws.id);
    if (!flush.ok) {
      this.releaseWriteLease(ws.id, leaseRequester);
      this.writeAck(inst.id, requestId, { ok: false, error: "could not save editor changes" });
      return;
    }
    const preflightOwner = this.projectOfTerminal(inst.id);
    const store = await preflightOwner?.storePromise;
    await ws.indexReady;
    if (!store) {
      // Recording unavailable (no Git): the run proceeds without a token.
      this.releaseWriteLease(ws.id, leaseRequester);
      this.writeAck(inst.id, requestId, { ok: true, token: null });
      return;
    }
    try {
      // The retained-blob budget (WORLDLINES §9): no new states past it.
      if ((ws.retainedBlobBytes ?? 0) > 256 * 1024 * 1024) {
        this.releaseWriteLease(ws.id, leaseRequester);
        this.setRecorderState(inst, "budget");
        this.writeAck(inst.id, requestId, { ok: true, token: null });
        return;
      }
      const state = await store.capture(await gitHead(ws.root), ws.lastStateCommit ?? null);
      this.setWorkspaceState(ws, state.commit);
      ws.retainedBlobBytes = (ws.retainedBlobBytes ?? 0) + state.newBlobBytes;
      const token = randomUUID();
      const pending: PendingPreflight = {
        requestId,
        token,
        terminalId: inst.id,
        workspaceId: ws.id,
        startState: state,
        // The generation baseline is taken AFTER the capture: the flush
        // that precedes it bumps the generation, and the captured state
        // already includes the flushed bytes.
        generation: ws.generation,
        leaseRequester,
        expiresAt: Date.now() + 60000,
        timer: setTimeout(() => this.expirePreflight(token), 60000),
        trustHashes: await this.computeTrustHashes(),
      };
      this.pendingPreflights.set(token, pending);
      this.writeAck(inst.id, requestId, { ok: true, token });
    } catch (err) {
      this.releaseWriteLease(ws.id, leaseRequester);
      this.writeAck(inst.id, requestId, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** A preflight that never reached agent_start releases its lease. */
  private expirePreflight(token: string): void {
    const pending = this.pendingPreflights.get(token);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingPreflights.delete(token);
    this.releaseWriteLease(pending.workspaceId, pending.leaseRequester);
  }

  /**
   * agent_start: consume the preflight token and open the run record.
   * A token-less agent_start is a retry or compaction of the open run.
   */
  private coupleRunStart(inst: PiTerminalInstance, event: AgentStartEvent): void {
    const token = String(event.preflightToken ?? "");
    const pending = token ? this.pendingPreflights.get(token) : undefined;
    const ws = this.workspaceOfTerminal(inst);
    const owner = this.projectOfTerminal(inst.id);
    if (owner) this.initWorldlines(owner);
    const manager = owner?.worldlines ?? null;
    if (pending && pending.terminalId === inst.id) {
      this.pendingPreflights.delete(token);
      clearTimeout(pending.timer);
      this.releaseWriteLease(pending.workspaceId, pending.leaseRequester);
      const run: RunRecord = {
        id: `run-${randomUUID()}`,
        terminalId: inst.id,
        workspaceId: inst.workspaceId,
        startStateId: pending.startState?.commit ?? null,
        settledStateId: null,
        promptPayloadFile: inst.pendingPrompt?.file ?? null,
        promptEventsDir: inst.pendingPrompt?.file ? this.eventsDirOf(inst) : null,
        promptText: inst.pendingPrompt?.text ?? null,
        promptEntryId: String(event.entryId ?? null) || null,
        promptParentEntryId: String(event.parentEntryId ?? null) || null,
        settledEntryId: null,
        sessionFile: String(event.sessionFile ?? null) || null,
        sessionBranchFile: null,
        trusted: typeof event.trusted === "boolean" ? event.trusted : null,
        trustHashes: pending ? pending.trustHashes : null,
        model: String(event.model ?? null) || null,
        thinkingLevel: String(event.thinkingLevel ?? null) || null,
        replayable: true,
        reason: null,
        interrupted: false,
        steering: false,
        overlap: this.overlapInWorkspace(inst.workspaceId),
        unownedEdits: 0,
        startedAt: Date.now(),
        settledAt: null,
        engine: inst.engine === "core" ? "core" : "pi",
      };
      // The source must not have changed between preflight and start.
      if (ws && ws.generation !== pending.generation) {
        run.replayable = false;
        run.reason = "the source changed while the run started";
      }
      if (!run.sessionFile) {
        run.replayable = false;
        run.reason = "the session is not persisted";
      }
      // A second agent running in the same workspace overlaps this run and
      // the other open run (WORLDLINES §5): both become ineligible.
      this.markOverlappingAgents(inst, run);
      this.pushRun(inst, run, manager);
    } else if (inst.currentRun && !inst.currentRun.settledAt) {
      // A retry or compaction of the open run. Keep its start state.
    } else {
      // No preflight (for example a queued follow-up): the run still runs
      // but cannot be forked.
      const run: RunRecord = {
        id: `run-${randomUUID()}`,
        terminalId: inst.id,
        workspaceId: inst.workspaceId,
        startStateId: null,
        settledStateId: null,
        promptPayloadFile: inst.pendingPrompt?.file ?? null,
        promptEventsDir: inst.pendingPrompt?.file ? this.eventsDirOf(inst) : null,
        promptText: inst.pendingPrompt?.text ?? null,
        promptEntryId: String(event.entryId ?? null) || null,
        promptParentEntryId: String(event.parentEntryId ?? null) || null,
        settledEntryId: null,
        sessionFile: String(event.sessionFile ?? null) || null,
        sessionBranchFile: null,
        trusted: typeof event.trusted === "boolean" ? event.trusted : null,
        trustHashes: pending ? pending.trustHashes : null,
        model: String(event.model ?? null) || null,
        thinkingLevel: String(event.thinkingLevel ?? null) || null,
        replayable: false,
        reason: "the run started without a start preflight",
        interrupted: false,
        steering: false,
        overlap: false,
        unownedEdits: 0,
        startedAt: Date.now(),
        settledAt: null,
        engine: inst.engine === "core" ? "core" : "pi",
      };
      this.markOverlappingAgents(inst, run);
      this.pushRun(inst, run, manager);
    }
    const startedSessionFile = String(event.sessionFile ?? "") || inst.sessionFile;
    const startedSessionId = String(event.sessionId ?? "") || inst.sessionId;
    if (inst.engine === "core") {
      if (inst.persist) {
        if (startedSessionId && isCoreSessionId(startedSessionId) && (startedSessionId === inst.sessionId || !this.coreSessionInUse(startedSessionId))) {
          inst.sessionId = startedSessionId;
        }
        if (!inst.sessionFile && inst.sessionId) {
          inst.sessionFile = this.coreSessionFile(inst.sessionId, inst.cwd);
        }
      }
    } else {
      const trusted = this.trustedPiSessionFile(startedSessionFile) ?? this.trustedPiSessionFile(inst.sessionFile);
      if (trusted && (trusted === inst.sessionFile || !this.sessionFileInUse(trusted))) inst.sessionFile = trusted;
      if (startedSessionId && isRosterSessionId(startedSessionId)) inst.sessionId = startedSessionId;
    }
    const rosterOwner = this.projectOfTerminal(inst.id);
    if (inst.persist && rosterOwner) this.saveTerminalRoster(rosterOwner);
    // The staged prompt belongs to one run start. Clear it so a later
    // retry cannot reuse the previous run's payload.
    inst.pendingPrompt = null;
  }

  /** Mark this run and every other open agent in the same workspace. */
  private markOverlappingAgents(inst: PiTerminalInstance, run: RunRecord): void {
    if (inst.type !== "agent") return;
    for (const otherId of this.busyAgents) {
      if (otherId === inst.id) continue;
      const other = this.terminals.get(otherId);
      if (!other || other.workspaceId !== inst.workspaceId) continue;
      run.overlap = true;
      run.replayable = false;
      run.reason = "another agent ran in the same workspace";
      if (other.currentRun) {
        other.currentRun.overlap = true;
        if (other.currentRun.replayable) {
          other.currentRun.replayable = false;
          other.currentRun.reason = "another agent ran in the same workspace";
        }
      }
    }
  }

  /** Store a run record on the live terminal and on the project catalog. */
  private pushRun(inst: PiTerminalInstance, run: RunRecord, manager: WorldlineManager | null): void {
    inst.currentRun = run;
    manager?.recordRun(run);
  }

  private async cleanupPromptPayloads(inst: PiTerminalInstance): Promise<void> {
    const keep = this.projectOfTerminal(inst.id)?.worldlines?.promptPayloadsOf(inst.id) ?? new Set<string>();
    const dir = this.eventsDirOf(inst);
    try {
      for (const file of await readdir(dir)) {
        if (file.startsWith(`prompt-${inst.id}-`) && !keep.has(file)) await rm(join(dir, file), { force: true });
      }
    } catch {
      /* The events directory can be absent. */
    }
  }

  /**
   * The settled checkpoint (WORLDLINES §6.3): quiet window, capture,
   * generation check, atomic acknowledgement. Attaches the settled state
   * to the open run.
   */
  private async handleCheckpointRequest(inst: PiTerminalInstance, requestId: string, kind: string, entryId: string): Promise<void> {
    if (!requestId) return;
    const ws = this.workspaceOfTerminal(inst);
    if (!ws || !ws.lastStateCommit) {
      this.writeAck(inst.id, requestId, { ok: false, error: "recording is not available" });
      return;
    }
    const checkpointOwner = this.projectOfTerminal(inst.id);
    const store = await checkpointOwner?.storePromise;
    if (!store) {
      this.writeAck(inst.id, requestId, { ok: false, error: "recording is not available" });
      return;
    }
    const leaseRequester = `checkpoint:${inst.id}:${requestId}`;
    const lease = await this.acquireWriteLease(ws.id, leaseRequester, 8000);
    if (!lease.ok) {
      this.writeAck(inst.id, requestId, { ok: false, error: lease.error ?? "the workspace is busy" });
      return;
    }
    try {
      const state = await this.captureStable(store, ws);
      this.setWorkspaceState(ws, state.commit);
      if (!ws.primary) checkpointOwner?.worldlines?.updateHeadState(inst.id, state.commit);
      this.writeAck(inst.id, requestId, { ok: true, stateId: state.commit });
      if (kind === "settled" && inst.currentRun && !inst.currentRun.settledAt) {
        await this.finalizeRun(inst, state, entryId);
      }
      // Fork Any Moment: the settled state is the last moment of the run.
      if (kind === "settled" && inst.momentDots.length > 0) {
        this.attachMomentState(inst, state.commit);
      }
    } catch (err) {
      this.writeAck(inst.id, requestId, { ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.releaseWriteLease(ws.id, leaseRequester);
    }
  }

  /**
   * Capture only when the source is quiet: a short quiet window before and
   * a generation check after. One bounded retry on a concurrent change.
   */
  private async captureStable(store: SnapshotStore, ws: WorkspaceState): Promise<SourceState> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const gen = ws.generation;
      await new Promise((r) => setTimeout(r, 100)); // quiet window
      if (ws.generation !== gen) continue;
      if ((ws.retainedBlobBytes ?? 0) > 256 * 1024 * 1024) {
        throw new Error("the retained-blob budget is exhausted");
      }
      const state = await store.capture(await gitHead(ws.root), ws.lastStateCommit ?? null);
      ws.retainedBlobBytes = (ws.retainedBlobBytes ?? 0) + state.newBlobBytes;
      if (ws.generation === gen) return state;
    }
    throw new Error("the source changed during capture");
  }

  // -------------------------------------------------- fork any moment ----

  private static readonly MAX_FORK_POINTS = 100;
  private static readonly MAX_PROGRESS_PATHS = 8;



  private addPendingHint(inst: PiTerminalInstance, relPath: string): void {
    if (inst.pendingHints.has(relPath)) return;
    if (inst.pendingHints.size >= PiEditorApp.MAX_PENDING_HINTS) {
      const oldest = inst.pendingHints.values().next().value;
      if (oldest !== undefined) inst.pendingHints.delete(oldest);
    }
    inst.pendingHints.add(relPath);
  }

  /** Debounce a moment capture: sibling tools coalesce into one state. */
  private scheduleMomentCapture(inst: PiTerminalInstance): void {
    if (!inst.currentRun) return;
    const ws = this.workspaceOfTerminal(inst);
    // Candidate workspaces record moments too (nested worldlines): their
    // chain was seeded with the root base at creation.
    if (!ws || (!ws.primary && !ws.lastStateCommit)) return;
    if (inst.captureTimer) clearTimeout(inst.captureTimer);
    inst.captureTimer = setTimeout(() => {
      inst.captureTimer = null;
      if (this.disposed || this.projectIsSwitching(this.projectOfTerminal(inst.id)?.id)) return;
      this.trackRecordingTask(this.runMomentCapture(inst, ws));
    }, 200);
  }

  /**
   * One incremental capture for the dots since the last one. The watcher
   * hints are the delta; the watcher cache reconciles missed events.
   */
  private runMomentCapture(inst: PiTerminalInstance, ws: WorkspaceState): Promise<void> {
    const previous = inst.momentCapturePromise ?? Promise.resolve();
    let current: Promise<void>;
    current = previous
      .catch(() => undefined)
      .then(() => this.captureMomentNow(inst, ws))
      .finally(() => {
        if (inst.momentCapturePromise === current) inst.momentCapturePromise = null;
      });
    inst.momentCapturePromise = current;
    return current;
  }

  private async captureMomentNow(inst: PiTerminalInstance, ws: WorkspaceState): Promise<void> {
    if (inst.momentDots.length === 0 && inst.pendingHints.size === 0) return;
    const batch = inst.momentDots;
    inst.momentDots = [];
    const momentOwner = this.projectOfTerminal(inst.id);
    const store = await momentOwner?.storePromise;
    if (!store || !ws.lastStateCommit) {
      this.setRecorderState(inst, "paused");
      inst.momentDots.unshift(...batch);
      return;
    }
    // The retained-blob budget (WORLDLINES §9): pause recording beyond it.
    if ((ws.retainedBlobBytes ?? 0) > 256 * 1024 * 1024) {
      this.setRecorderState(inst, "budget");
      inst.pendingHints.clear();
      return;
    }
    const hints = [...inst.pendingHints];
    inst.pendingHints.clear();
    // Reconcile: the watcher's precomputed blob oids catch changes the
    // hints missed. Shipping hashes instead of contents keeps the request
    // small and skips a re-hash of the whole cache per capture. Bound the
    // walk so a huge cache cannot stall the capture.
    const oids = ws.watcher?.lastOids;
    const reconcile: Array<{ relPath: string; oid: string }> = [];
    const hinted = new Set(hints);
    let walked = 0;
    for (const [path, pair] of oids ?? []) {
      if (walked++ > 2000) break;
      const rel = this.rel(path, ws.root);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
      if (hinted.has(rel)) continue;
      if (this.ignoredSegmentIn(rel)) continue;
      reconcile.push({ relPath: rel, oid: store.objectFormat === "sha256" ? pair.sha256 : pair.sha1 });
    }
    try {
      // A candidate workspace captures its OWN tree (the source override).
      const source = ws.primary ? undefined : { root: ws.root, gitDir: (await gitCommonDir(ws.root)) ?? ws.root };
      const state = await store.captureIncremental(ws.lastStateCommit, hints, reconcile, {}, {}, source);
      this.setWorkspaceState(ws, state.commit);
      ws.retainedBlobBytes = (ws.retainedBlobBytes ?? 0) + state.newBlobBytes;
      if (!ws.primary) momentOwner?.worldlines?.updateHeadState(inst.id, state.commit);
      this.attachMomentState(inst, state.commit, batch);
      this.setRecorderState(inst, "ready");
      this.evictForkPoints(inst);
    } catch (err) {
      console.warn(`[main] moment capture failed: ${(err as Error).message}`);
      // The dots stay visible but not forkable; the recorder degrades.
      this.setRecorderState(inst, "degraded");
    }
  }

  /** Attach the captured state to every dot of the batch and push it. */
  private attachMomentState(inst: PiTerminalInstance, stateId: string, batch = inst.momentDots): void {
    if (batch === inst.momentDots) inst.momentDots = [];
    for (const ev of batch) {
      ev.stateId = stateId;
      if (ev.runStartStateId === undefined) ev.runStartStateId = inst.currentRun?.startStateId ?? null;
      const pub = { ...ev };
      delete (pub as Partial<TimelineEvent>).content;
      this.send("timeline:event", { terminalId: inst.id, event: pub });
    }
  }

  /**
   * Budget: keep at most 100 forkable points per terminal. Evicted dots
   * lose their dots and their store states together.
   */
  private evictForkPoints(inst: PiTerminalInstance): void {
    const forkable = inst.timeline.filter((e) => e.stateId);
    if (forkable.length <= PiEditorApp.MAX_FORK_POINTS) return;
    let excess = forkable.length - PiEditorApp.MAX_FORK_POINTS;
    const evicted: number[] = [];
    for (const e of inst.timeline) {
      if (excess <= 0) break;
      if (!e.stateId) continue;
      excess--;
      evicted.push(e.seq);
      const evictedState = e.stateId;
      if (evictedState) void this.releaseStateIfUnused(evictedState, inst.id, e.seq);
      e.stateId = null;
      e.evicted = true;
      const pub = { ...e };
      delete (pub as Partial<TimelineEvent>).content;
      this.send("timeline:event", { terminalId: inst.id, event: pub });
    }
    if (evicted.length > 0) {
      this.send("timeline:evict", { terminalId: inst.id, seqs: evicted });
      this.setRecorderState(inst, "budget");
    }
  }

  /** Push the recorder state label (WORLDLINES §6). */
  private setRecorderState(inst: PiTerminalInstance, state: RecorderState): void {
    if (inst.recorderState === state) return;
    inst.recorderState = state;
    this.send("timeline:recorder-state", { terminalId: inst.id, state });
  }

  private ignoredSegmentIn(rel: string): boolean {
    return rel.split(/[\\/]/).some((seg) => IGNORED_SEGMENTS.has(seg) || seg === ".git");
  }

  /** Attach the settled state, copy the session branch, mark eligibility. */
  private async finalizeRun(inst: PiTerminalInstance, state: SourceState, entryId: string): Promise<void> {
    const run = inst.currentRun;
    if (!run) return;
    run.settledStateId = state.commit;
    run.settledEntryId = entryId || null;
    run.settledAt = Date.now();
    run.interrupted = inst.interruptedAt !== undefined && inst.interruptedAt > run.startedAt;
    if (run.overlap || this.overlapInWorkspace(run.workspaceId)) {
      run.overlap = true;
      run.replayable = false;
      run.reason = "another writer overlapped the same workspace";
    }
    if (run.interrupted) {
      run.replayable = false;
      run.reason = "the run was interrupted";
    }
    if (!run.settledStateId || !run.startStateId) {
      run.replayable = false;
      run.reason = run.reason ?? "the run has no complete source checkpoints";
    }
    // Copy the session branch into app-private storage.
    if (run.sessionFile) {
      try {
        mkdirSync(this.sessionWorkspaceDir, { recursive: true, mode: 0o700 });
        const target = join(this.sessionWorkspaceDir, `${run.id}.jsonl`);
        await copyFile(run.sessionFile, target, constants.COPYFILE_EXCL);
        run.sessionBranchFile = target;
      } catch (err) {
        run.replayable = false;
        run.reason = `could not copy the session branch: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    // The run must not leave a live mutating descendant process behind
    // (WORLDLINES §6.5): a background bash would keep writing after the
    // captured settle state. A failed check cannot prove the run clean.
    const descendants = await this.descendantPids(inst.pty.pid);
    if (run.replayable && (descendants === null || descendants.length > 0)) {
      run.replayable = false;
      run.reason = descendants === null ? "the descendant check could not run" : "the run left a live descendant process";
    }
    inst.currentRun = null;
    // The run record is complete now: the renderer refreshes its Fork Run
    // button from this push (the settle timeline event arrives earlier).
    this.send("worldline:runs-changed", { terminalId: inst.id });
  }

  /** The descendant pids of a process, from one ps snapshot. Null when the
   *  check cannot run. */
  private async descendantPids(pid: number): Promise<number[] | null> {
    try {
      const out = await new Promise<string>((resolvePromise, reject) => {
        execFile("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", maxBuffer: 1024 * 1024 }, (err, stdout) => {
          if (err) reject(err);
          else resolvePromise(stdout);
        });
      });
      const children = new Map<number, number[]>();
      for (const line of out.split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)/.exec(line);
        if (!m) continue;
        const p = Number(m[1]);
        const pp = Number(m[2]);
        const list = children.get(pp) ?? [];
        list.push(p);
        children.set(pp, list);
      }
      const outPids: number[] = [];
      const stack = [pid];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        for (const child of children.get(cur) ?? []) {
          outPids.push(child);
          stack.push(child);
        }
      }
      return outPids;
    } catch {
      return null;
    }
  }

  /**
   * A terminal that exits mid-run never settles. Mark the open run.
   */
  private closeRunOnExit(inst: PiTerminalInstance): void {
    const run = inst.currentRun;
    if (run && !run.settledAt) {
      run.replayable = false;
      run.reason = "the terminal exited mid-run";
      run.settledAt = Date.now();
      inst.currentRun = null;
    }
  }

  private toolSnapshot(
    inst: PiTerminalInstance,
    path: string,
    toolName: string,
    edits: unknown,
    ev: Omit<TimelineEvent, "seq" | "ts">,
  ): { content?: string; status?: "created" | "modified" } {
    const status = toolName === "write" ? this.classifyWrite(path) : "modified";
    // Claim the imminent watcher change. Set the marker in every branch so
    // the write-without-cache path also claims the change event.
    inst.lastToolAt.set(path, Date.now());
    if (inst.lastToolAt.size > 64) {
      const cutoff = Date.now() - TOOL_CHANGE_DEDUP_MS;
      for (const [p, at] of inst.lastToolAt) {
        if (at < cutoff) inst.lastToolAt.delete(p);
      }
    }
    if (toolName === "edit" || toolName === "apply_patch") {
      const base = inst.runSnapshots.get(path) ?? this.preRunContent(inst, path) ?? "";
      const content = this.applyEdits(base, edits);
      this.setRunSnapshot(inst, path, content);
      return content.length > MAX_SNAPSHOT_SIZE ? { status } : { content, status };
    }
    // write / create_file: prefer the watcher cache, else fill in shortly after.
    const cached = this.workspaceOfTerminal(inst)?.watcher?.lastContents.get(path);
    if (cached !== undefined) {
      this.setRunSnapshot(inst, path, cached);
      return cached.length > MAX_SNAPSHOT_SIZE ? { status } : { content: cached, status };
    }
    // The write may not have landed in the watcher cache yet — retry shortly,
    // addressing the event by reference (the tail may have moved on). Content
    // stays main-side; the renderer fetches it on click.
    setTimeout(() => {
      if (this.disposed || !this.terminals.has(inst.id)) return;
      const fresh = this.workspaceOfTerminal(inst)?.watcher?.lastContents.get(path);
      if (fresh === undefined) return;
      const idx = inst.timeline.indexOf(ev as TimelineEvent);
      if (idx === -1) return; // dropped by the cap or terminal gone
      const target = inst.timeline[idx];
      target.content = fresh.length > MAX_SNAPSHOT_SIZE ? undefined : fresh;
      target.status = status;
      this.setRunSnapshot(inst, path, fresh);
    }, 400);
    return { status };
  }

  /** Content of a path before this run's first touch (baseline or cache). */
  private preRunContent(inst: PiTerminalInstance, path: string): string | null | undefined {
    const b = inst.baselines.get(path);
    if (b !== undefined) return b;
    return this.workspaceOfTerminal(inst)?.watcher?.lastContents.get(path);
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

  /** Last-tool counts for the Timeline header. Tiny payload. Not ranking. */
  private timelinePrefixOf(inst: PiTerminalInstance | undefined): TimelinePrefix {
    if (!inst) return { terminalId: "", ok: 0, error: 0, open: 0 };
    let ok = 0;
    let error = 0;
    for (const v of inst.toolOutcomes.values()) {
      if (v === "ok") ok++;
      else error++;
    }
    return { terminalId: inst.id, ok, error, open: inst.pendingFileTools.size };
  }

  private sendTimelinePrefix(inst: PiTerminalInstance): void {
    const payload = this.timelinePrefixOf(inst);
    const key = `${payload.ok}:${payload.error}:${payload.open}`;
    if (inst.lastTimelinePrefixKey === key) return;
    inst.lastTimelinePrefixKey = key;
    this.send("timeline:prefix", payload);
  }

  private isNewCommand(text: string): boolean {
    const t = text.trim();
    return t === "/new" || t.startsWith("/new ");
  }

  /**
   * Reset session-scoped state for a slash-command reset (/new). The
   * timeline, plan, and worldline comparisons reflect the abandoned run;\n   * the workspace source and modified files reflect real disk changes and\n   * persist.\n   */
  private clearForNewSession(terminalId: string): void {
    const inst = this.terminals.get(terminalId);
    if (!inst) return;
    // Timeline: drop every dot and release its captured state.
    for (const ev of inst.timeline) {
      if (ev.stateId) void this.releaseStateIfUnused(ev.stateId, terminalId, ev.seq);
    }
    inst.timeline = [];
    inst.momentDots = [];
    if (inst.captureTimer) { clearTimeout(inst.captureTimer); inst.captureTimer = null; }
    inst.pendingHints.clear();
    inst.lastToolAt.clear();
    inst.runSnapshots.clear();
    inst.runSnapshotBytes = 0;
    inst.lastTimelinePrefixKey = "";
    this.send("timeline:clear", { terminalId });
    this.sendTimelinePrefix(inst);
    // Plan: fresh board for the new session.
    inst.plan = [];
    inst.touched = new Set();
    inst.pendingFileTools.clear();
    inst.toolOutcomes.clear();
    this.sendPlan(inst);
    // The open run is abandoned by /new. Mark it non-replayable so a later
    // token-less agent_start does not treat it as a retry.
    if (inst.currentRun && !inst.currentRun.settledAt) {
      inst.currentRun.replayable = false;
      inst.currentRun.reason = inst.currentRun.reason ?? "session reset by /new";
      inst.currentRun = null;
    }
    // Baselines and user-edit context: cleared so a new run starts clean,
    // matching the agent_start reset even when /new skipped a prompt cycle.
    // Modified files are intentionally kept (agent_start also preserves them)
    // as they reflect real workspace changes on disk.
    inst.baselines.clear();
    inst.baselineBytes = 0;
    const ws = this.workspaceOfTerminal(inst);
    if (ws) this.clearUserEdits(ws);
    this.clearMailbox(terminalId);
    // Worldlines: discard every live comparison of this project.
    const project = this.projectOfTerminal(terminalId);
    if (project?.worldlines) {
      const ids = [...new Set(project.worldlines.list().map((s) => s.comparisonId))];
      for (const id of ids) void project.worldlines.discard(id).catch(() => undefined);
    }
  }

  /**
   * The run-start state of a moment. Prefer the stamp taken when the dot
   * joined the capture batch. Do not use the live currentRun: a later
   * agent_start would make old dots diff against the new run.
   */
  private startStateForMoment(inst: PiTerminalInstance, ev: TimelineEvent): string | null {
    if (ev.runStartStateId) return ev.runStartStateId;
    if (ev.runStartStateId === null) return null;
    const run = this.projectOfTerminal(inst.id)?.worldlines?.runCovering(inst.id, ev.ts);
    return run?.startStateId ?? null;
  }

  /** On-demand source diff of one forkable moment. Never from the sidecar handler. */
  private async timelineProgress(terminalId: string, seq: number): Promise<TimelineProgress> {
    const fail = (): TimelineProgress => ({ ok: false, seq });
    const inst = this.terminals.get(terminalId);
    const ev = inst?.timeline.find((e) => e.seq === seq);
    if (!inst || !ev?.stateId || ev.evicted) return fail();
    const base = this.startStateForMoment(inst, ev);
    if (!base) return fail();
    if (base === ev.stateId) {
      return { ok: true, seq, files: 0, created: 0, modified: 0, deleted: 0, paths: [] };
    }
    const project = this.projectOfTerminal(terminalId);
    const store = await project?.storePromise;
    if (
      !store ||
      this.disposed ||
      this.projectIsSwitching(project?.id) ||
      this.terminals.get(terminalId) !== inst
    ) {
      return fail();
    }
    const still = inst.timeline.find((e) => e.seq === seq);
    if (!still?.stateId || still.evicted || still.stateId !== ev.stateId) return fail();
    try {
      const changes = await store.diffTree(base, ev.stateId);
      let created = 0;
      let modified = 0;
      let deleted = 0;
      for (const c of changes) {
        if (c.status === "created") created++;
        else if (c.status === "deleted") deleted++;
        else modified++;
      }
      return {
        ok: true,
        seq,
        files: changes.length,
        created,
        modified,
        deleted,
        paths: changes.slice(0, PiEditorApp.MAX_PROGRESS_PATHS).map((c) => c.relPath),
      };
    } catch {
      return fail();
    }
  }

  /** Append a timeline point, keep caps, push a CONTENT-FREE event to the
   *  renderer (snapshots are fetched on demand when a dot is clicked, so the
   *  strip and IPC stay light). Tool and change dots join the open batch and
   *  receive their captured source state with the next moment capture.
   *  Mutate the passed event object so a delayed fill can find it by
   *  reference in the timeline array. */
  private pushTimeline(inst: PiTerminalInstance, ev: Omit<TimelineEvent, "seq" | "ts">): TimelineEvent {
    const event = ev as TimelineEvent;
    event.seq = ++inst.timelineSeq;
    event.ts = Date.now();
    inst.timeline.push(event);
    if (inst.timeline.length > MAX_TIMELINE_EVENTS) inst.timeline.splice(0, inst.timeline.length - MAX_TIMELINE_EVENTS);
    this.trimTimelineContent(inst);
    if (inst.currentRun && (event.t === "tool" || event.t === "change")) {
      inst.momentDots.push(event);
      if (inst.momentDots.length > MAX_TIMELINE_EVENTS) inst.momentDots.shift();
      event.runStartStateId = inst.currentRun.startStateId;
    }
    const { content: _content, ...pub } = event;
    this.send("timeline:event", { terminalId: inst.id, event: pub });
    return event;
  }

  /** Keep snapshot memory bounded per terminal: drop content from the OLDEST
   *  events first (the dots remain; clicking them explains why). */
  private trimTimelineContent(inst: PiTerminalInstance): void {
    let bytes = 0;
    for (const e of inst.timeline) bytes += e.content ? Buffer.byteLength(e.content, "utf8") : 0;
    if (bytes <= MAX_TIMELINE_CONTENT_BYTES) return;
    for (const e of inst.timeline) {
      if (bytes <= MAX_TIMELINE_CONTENT_BYTES) break;
      if (e.content !== undefined) {
        bytes -= Buffer.byteLength(e.content, "utf8");
        e.content = undefined;
      }
    }
  }

  private contentSizeOk(content: string | undefined): boolean {
    return content !== undefined && Buffer.byteLength(content, "utf8") <= MAX_SNAPSHOT_SIZE;
  }

  private classifyWrite(path: string): "created" | "modified" {
    return existsSync(path) ? "modified" : "created";
  }

  /**
   * Reconstruct a pre-edit baseline from the file and edit regions
   * (oldText/newText from the tool call) in reverse order. Reverse only the
   * edits that landed on disk: the sidecar event fires at tool start, and
   * the disk content is still the pre-run content until the write lands.
   * Skip pure deletions: reversing one needs the edit position, which the
   * event does not carry. Return null when the file cannot be read.
   */
  private async reconstructBaseline(path: string, edits: unknown): Promise<string | null> {
    try {
      const content = await readFile(path, "utf8");
      const list = Array.isArray(edits) ? (edits as Array<{ oldText?: string; newText?: string }>) : [];
      let base = content;
      for (let i = list.length - 1; i >= 0; i--) {
        const oldText = list[i]?.oldText ?? "";
        const newText = list[i]?.newText ?? "";
        if (!oldText && !newText) continue;
        if (!newText) continue; // no anchor in the current content
        // A pure insertion reverses by removing one occurrence.
        if (!oldText) {
          const idx = base.indexOf(newText);
          if (idx === -1) continue; // not landed yet — keep as-is
          base = base.slice(0, idx) + base.slice(idx + newText.length);
          continue;
        }
        if (!base.includes(newText)) continue; // not landed yet — keep as-is
        // Replace one occurrence. This mirrors the forward first-occurrence rule.
        const idx = base.indexOf(newText);
        base = base.slice(0, idx) + oldText + base.slice(idx + newText.length);
      }
      return base;
    } catch {
      return null;
    }
  }

  private resetBaselines(inst: PiTerminalInstance, source: Map<string, string> | undefined): void {
    inst.baselines.clear();
    inst.baselineBytes = 0;
    if (!source) return;
    for (const [path, content] of source) this.setBaseline(inst, path, content);
  }

  private setBaseline(inst: PiTerminalInstance, path: string, value: string | null): void {
    const previous = inst.baselines.get(path);
    if (previous !== undefined && previous !== null) inst.baselineBytes -= Buffer.byteLength(previous, "utf8");
    inst.baselines.set(path, value);
    if (value !== null) inst.baselineBytes += Buffer.byteLength(value, "utf8");
    while (inst.baselines.size > PiEditorApp.MAX_BASELINE_FILES || inst.baselineBytes > PiEditorApp.MAX_BASELINE_BYTES) {
      const oldest = inst.baselines.keys().next().value;
      if (oldest === undefined) break;
      this.deleteBaseline(inst, oldest);
    }
  }

  private deleteBaseline(inst: PiTerminalInstance, path: string): void {
    const previous = inst.baselines.get(path);
    if (previous !== undefined && previous !== null) inst.baselineBytes -= Buffer.byteLength(previous, "utf8");
    inst.baselines.delete(path);
  }

  private setRunSnapshot(inst: PiTerminalInstance, path: string, content: string): void {
    const previous = inst.runSnapshots.get(path);
    if (previous !== undefined) inst.runSnapshotBytes -= Buffer.byteLength(previous, "utf8");
    inst.runSnapshots.set(path, content);
    inst.runSnapshotBytes += Buffer.byteLength(content, "utf8");
    while (inst.runSnapshots.size > PiEditorApp.MAX_RUN_SNAPSHOTS || inst.runSnapshotBytes > PiEditorApp.MAX_RUN_SNAPSHOT_BYTES) {
      const oldest = inst.runSnapshots.keys().next().value;
      if (oldest === undefined) break;
      const value = inst.runSnapshots.get(oldest);
      if (value !== undefined) inst.runSnapshotBytes -= Buffer.byteLength(value, "utf8");
      inst.runSnapshots.delete(oldest);
    }
  }

  /** Run one lazy baseline capture and remember it. Change Review waits
   *  for the fill so an early diff open does not show a missing baseline. */
  private fillBaseline(inst: PiTerminalInstance, path: string, status: "created" | "modified"): Promise<void> {
    const task = this.fillBaselineFromState(inst, path, status)
      .catch(() => undefined)
      .finally(() => {
        if (inst.baselineFills.get(path) === task) inst.baselineFills.delete(path);
      });
    inst.baselineFills.set(path, task);
    return task;
  }

  private async fillBaselineFromState(inst: PiTerminalInstance, path: string, status: "created" | "modified"): Promise<void> {
    if (inst.baselines.has(path) || status === "created") {
      if (status === "created" && !inst.baselines.has(path)) this.setBaseline(inst, path, null);
      return;
    }
    const stateId = inst.currentRun?.startStateId;
    const workspace = this.workspaceOfTerminal(inst);
    const store = await this.projectOfTerminal(inst.id)?.storePromise;
    if (!stateId || !workspace || !store) return;
    const relPath = relative(this.canonicalPath(workspace.root), path);
    if (!relPath || relPath.startsWith("..") || isAbsolute(relPath)) return;
    const content = await store.readBlob(stateId, relPath);
    if (content !== null && content.byteLength <= MAX_OPEN_FILE_SIZE && !inst.baselines.has(path)) {
      this.setBaseline(inst, path, content.toString("utf8"));
    }
  }

  private setBounded<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
    map.set(key, value);
    while (map.size > limit) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
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
      this.setBounded(inst.modified, p, { path: p, relPath: this.rel(p), status }, PiEditorApp.MAX_MODIFIED_FILES);
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
        this.setBounded(inst.modified, p, { path: p, relPath: this.rel(p), status: "deleted" }, PiEditorApp.MAX_MODIFIED_FILES);
      }
    } else {
      // Nothing to restore (created this run, or no baseline): drop the entry.
      inst.modified.delete(p);
    }
    this.send("modified:list", { instanceId: inst.id, files: [...inst.modified.values()] });
  }

  // ------------------------------------------------------------- project -----

  /**
   * Confirmation for live candidates with activity (§6.11): a folder
   * switch or app quit discards them; ask first.
   */
  async confirmDiscardActiveCandidates(projectId?: string): Promise<boolean> {
    // Count only the given project when one tab closes. App quit passes no
    // id and counts every project.
    const wanted = projectId ? [this.projects.get(projectId)] : [...this.projects.values()];
    let active = 0;
    for (const project of wanted) {
      if (!project) continue;
      active += (await project.worldlines?.activeCandidates().catch(() => 0)) ?? 0;
    }
    if (active === 0) return true;
    const win = this.win;
    if (!win) return true;
    const res = await dialog.showMessageBox(win, {
      type: "warning",
      message: `${active} worldline candidate(s) have source changes or session activity`,
      detail: "Closing the project or quitting discards them. Discard and continue?",
      buttons: ["Discard and continue", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    return res.response === 0;
  }

  private openFolder(): Promise<{ cwd: string } | { cancelled: true }> {
    if (this.folderOpenPromise) return this.folderOpenPromise;
    const promise = this.performOpenFolder();
    this.folderOpenPromise = promise;
    void promise.then(
      () => {
        if (this.folderOpenPromise === promise) this.folderOpenPromise = null;
      },
      () => {
        if (this.folderOpenPromise === promise) this.folderOpenPromise = null;
      },
    );
    return promise;
  }

  private async performOpenFolder(): Promise<{ cwd: string } | { cancelled: true }> {
    if (!this.win || this.win.isDestroyed()) return { cancelled: true };
    const result = await dialog.showOpenDialog(this.win, {
      title: "Open a project folder",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return { cancelled: true };
    const cwd = result.filePaths[0];
    // One tab per folder: reactivate an already-open project.
    const canonical = this.canonicalPath(cwd);
    for (const existing of this.projects.values()) {
      if (existing.canonicalRoot === canonical) {
        await this.activateProject(existing.id);
        return { cwd };
      }
    }
    const project = await this.openProject(cwd);
    return project ? { cwd } : { cancelled: true };
  }

  /** Open or reactivate the project at a path (the dialog-free path). */
  private async openProjectAt(cwd: string): Promise<{ cwd: string } | { cancelled: true }> {
    const canonical = this.canonicalPath(cwd);
    for (const existing of this.projects.values()) {
      if (existing.canonicalRoot === canonical) {
        await this.activateProject(existing.id);
        return { cwd };
      }
    }
    const project = await this.openProject(cwd);
    return project ? { cwd } : { cancelled: true };
  }

  /** Create a project, start its watcher and store, and activate it. */
  private async openProject(cwd: string): Promise<ProjectState | null> {
    const id = `proj-${++projectSeq}`;
    this.switchingProjects.add(id);
    try {
      const project: ProjectState = {
        id,
        cwd,
        canonicalRoot: this.canonicalPath(cwd),
        workspaces: new Map(),
        storePromise: null,
        storeDir: null,
        mineFiles: new Set(),
        worldlines: null,
        terminalIds: new Set(),
        unrestoredTerminals: [],
      };
      this.projects.set(id, project);
      this.activeProjectId = id;
      this.ensureAppBridge();
      this.removeLegacyProjectBridge(cwd);
      // Finish or roll back any pending promotion journal BEFORE the
      // primary watcher starts: the restored bytes must not attribute to
      // a user edit.
      await recoverPromotionJournals(this.worldsRoot);
      this.createWorkspace(project, cwd, true);
      this.loadMineFiles(project);
      this.initWorldlines(project);
      // Spawn the terminal before folder:opened so the renderer can show
      // that pane when it switches the project view.
      await this.restoreProjectTerminals(project);
      await this.sendFolderOpened(cwd, id);
      this.persistOpenProjects();
      return project;
    } finally {
      this.switchingProjects.delete(id);
    }
  }

  /** Switch the renderer to another open project. Nothing is torn down. */
  private async activateProject(projectId: string): Promise<void> {
    if (!this.projects.has(projectId)) return;
    this.activeProjectId = projectId;
    const project = this.projects.get(projectId)!;
    await this.sendFolderOpened(project.cwd, project.id);
  }

  /** Push folder:opened with a login hint flag. The renderer never reads auth.json. */
  private async sendFolderOpened(cwd: string, projectId: string): Promise<void> {
    this.send("folder:opened", { cwd, projectId, needsLogin: await this.piNeedsLogin() });
  }

  /**
   * True when pi has no provider in auth.json or in the process environment.
   * The check is boolean only. It never sends credentials to the renderer.
   */
  private async piNeedsLogin(): Promise<boolean> {
    if (envHasPiProvider(process.env)) return false;
    const authPath = join(homedir(), ".pi", "agent", "auth.json");
    try {
      const info = await stat(authPath);
      if (!info.isFile() || info.size === 0) {
        this.loginHint = null;
        return true;
      }
      if (info.size > MAX_AUTH_JSON_BYTES) {
        this.loginHint = { mtimeMs: info.mtimeMs, size: info.size, needsLogin: false };
        return false;
      }
      if (this.loginHint && this.loginHint.mtimeMs === info.mtimeMs && this.loginHint.size === info.size) {
        return this.loginHint.needsLogin;
      }
      const needsLogin = !authJsonHasPiProvider(JSON.parse(await readFile(authPath, "utf8")));
      this.loginHint = { mtimeMs: info.mtimeMs, size: info.size, needsLogin };
      return needsLogin;
    } catch {
      this.loginHint = null;
      return true;
    }
  }

  /** Tear down one project: manager, terminals, watchers, and store. */
  private async closeProject(projectId: string): Promise<{ ok: boolean; error?: string; cancelled?: boolean }> {
    const project = this.projects.get(projectId);
    if (!project) return { ok: false, error: "project not found" };
    if (!(await this.confirmDiscardActiveCandidates(projectId))) return { ok: false, cancelled: true };
    this.switchingProjects.add(projectId);
    // Capture the project's ids before teardown removes candidate workspaces
    // and exited terminals leave the sets.
    const closingWorkspaceIds = new Set(project.workspaces.keys());
    const closingRoots = [...project.workspaces.values()].map((ws) => this.canonicalPath(ws.root));
    const closingIds = [...project.terminalIds];
    try {
      await this.drainVerifyJobs(closingIds);
      await this.drainSidecarQueues();
      await project.worldlines?.drainEvidence();
      await project.worldlines?.dispose().catch(() => undefined);
      project.worldlines = null;
      this.clearMineFiles(project);
      // Drain only this project's terminals. Other open projects keep running.
      for (const id of closingIds) {
        this.tailer.stopWatching(id);
        this.worldlineTailers.get(id)?.stop();
        this.worldlineTailers.delete(id);
        this.closeTerminal(id);
      }
      await this.drainTerminals(closingIds);
      await this.drainSidecarQueues();
      this.sidecarQueues.clear();
      for (const ws of project.workspaces.values()) ws.watcher?.stop();
      for (const wsId of project.workspaces.keys()) this.workspaceOwners.delete(wsId);
      project.workspaces.clear();
      project.terminalIds.clear();
      // Scope every remaining cleanup to this project. Other open projects
      // keep their user edits, dispatch workers, and watch dedupe state.
      for (const wsId of closingWorkspaceIds) this.userEditsByWorkspace.delete(wsId);
      for (const key of [...this.lastWatchChange.keys()]) {
        if (closingRoots.some((root) => key === root || key.startsWith(root + sep))) {
          this.lastWatchChange.delete(key);
        }
      }
      for (const id of closingIds) {
        this.busyAgents.delete(id);
        this.dispatchWorkers.delete(id);
        this.dispatchRuns.delete(id);
        this.clearMailbox(id);
      }
      await this.teardownRecording(project, closingWorkspaceIds);
      this.cleanupExportedStates(projectId);
      this.projects.delete(projectId);
      this.persistOpenProjects();
      this.send("project:closed", { projectId });
      if (this.activeProjectId === projectId) {
        const next = this.projects.keys().next().value;
        this.activeProjectId = next ?? null;
        if (next) await this.sendFolderOpened(this.projects.get(next)!.cwd, next);
      }
      return { ok: true };
    } finally {
      this.switchingProjects.delete(projectId);
    }
  }

  /**
   * Tear down the snapshot store and worker of the previous project.
   * The store is app-owned and deleted with its project session.
   */
  private async teardownRecording(project: ProjectState, closingWorkspaceIds: Set<string>): Promise<void> {
    for (const [token, pending] of [...this.pendingPreflights]) {
      if (!closingWorkspaceIds.has(pending.workspaceId)) continue;
      clearTimeout(pending.timer);
      this.releaseWriteLease(pending.workspaceId, pending.leaseRequester);
      this.pendingPreflights.delete(token);
    }
    for (const [requestId, waiter] of [...this.flushWaiters]) {
      if (!closingWorkspaceIds.has(waiter.workspaceId)) continue;
      clearTimeout(waiter.timer);
      waiter.resolve({ ok: false, failed: ["recording teardown"] });
      this.flushWaiters.delete(requestId);
    }
    await this.drainRecordingTasks();
    const promise = project.storePromise;
    project.storePromise = null;
    const storeDir = project.storeDir;
    project.storeDir = null;
    let store: SnapshotStore | null = null;
    try {
      store = promise ? await promise : null;
    } catch (err) {
      console.warn(`[main] snapshot store initialization failed during cleanup: ${String(err)}`);
    }
    if (store && storeDir) {
      try {
        await store.destroy();
      } catch (err) {
        console.warn(`[main] snapshot store removal failed: ${String(err)}`);
      }
    }
    try {
      for (const f of await readdir(this.eventsDir)) {
        if (f.startsWith("ack-")) await rm(join(this.eventsDir, f), { force: true });
      }
    } catch {
      /* The events directory can be absent. */
    }
  }

  /** Remove the materialized export dirs. Pass a project id to remove only
   *  that project's exports; no id removes every export (app quit). */
  private cleanupExportedStates(projectId?: string): void {
    for (const [dir, ownerId] of [...this.exportedStateDirs]) {
      if (projectId !== undefined && ownerId !== projectId) continue;
      this.exportedStateDirs.delete(dir);
      void rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Wait until the given killed terminals have exited. A terminal that
   *  survives the deadline receives SIGKILL. Pass null to drain every
   *  terminal (app quit). */
  private async drainTerminals(ids: Iterable<string> | null, timeoutMs = 2000): Promise<void> {
    const target = ids === null ? null : new Set(ids);
    const anyAlive = (): boolean => {
      for (const inst of this.terminals.values()) {
        if (target === null || target.has(inst.id)) return true;
      }
      return false;
    };
    const deadline = Date.now() + timeoutMs;
    while (anyAlive() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (const inst of [...this.terminals.values()]) {
      if (target === null || target.has(inst.id)) inst.pty.kill("SIGKILL");
    }
  }

  // ---------------------------------------------------------- app bridge ----

  /** The app-owned bridge file, passed to pi with the CLI extension option. */
  private bridgePath(): string {
    return join(this.userDataDir, "termina-bridge.ts");
  }

  /** Write the bridge to the app user-data directory when it changed. */
  private ensureAppBridge(): void {
    try {
      const p = this.bridgePath();
      try {
        if (readFileSync(p, "utf8") === BRIDGE_EXTENSION) return; // already current
      } catch {
        /* missing — write it */
      }
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, BRIDGE_EXTENSION, "utf8");
    } catch (err) {
      console.warn(`[main] could not write the app bridge: ${(err as Error).message}`);
    }
  }

  /**
   * Remove the legacy generated bridge from a project. A user file that
   * only shares the name stays untouched (the marker check is the proof).
   */
  private removeLegacyProjectBridge(cwd: string): void {
    const p = join(cwd, ".pi", "extensions", "termina-bridge.ts");
    try {
      const content = readFileSync(p, "utf8");
      if (content.includes("Termina bridge extension — auto-generated")) rmSync(p, { force: true });
    } catch {
      /* absent or unreadable — nothing to remove */
    }
  }

  // -------------------------------------------------------------- watcher ---

  /** Start the watcher of one workspace. Returns the watcher. */
  private startWatcher(ws: WorkspaceState): ProjectWatcher {
    const watcher = new ProjectWatcher(ws.root, (p) => this.canonicalPath(p));
    const workspaceTerminals = (): PiTerminalInstance[] =>
      [...ws.terminalIds].map((id) => this.terminals.get(id)).filter((t): t is PiTerminalInstance => t !== undefined);
    watcher.onChange = (change) => {
      if (this.disposed || this.projectIsSwitching(this.projectOfWorkspace(ws.id)?.id)) return;
      const path = this.canonicalPath(change.path);
      const relPath = relative(this.canonicalPath(ws.root), path);
      if (!relPath || relPath.startsWith("..") || isAbsolute(relPath)) return;
      ws.generation++;
      this.markCandidateEvidenceStale(ws.comparisonId);
      const now = Date.now();
      // Merge duplicate file system events for the same physical write
      // (same content, recent). A duplicate that lands after the run
      // settled must not appear as a fresh user edit.
      const cappedContent = change.content.length > 4000 ? change.content.slice(0, 4000) : change.content;
      // macOS can deliver a duplicate fs event seconds late (under load). The
      // window must outlive that delay, or the duplicate re-records an edit
      // the run already consumed.
      const lastWatch = this.lastWatchChange.get(path);
      const isDupWatch = lastWatch !== undefined && lastWatch.content === cappedContent && now - lastWatch.at < 5000;
      // Cap the stored content. The merge window is 5 seconds.
      this.lastWatchChange.set(path, { content: cappedContent, at: now });
      if (this.lastWatchChange.size > PiEditorApp.LAST_WATCH_MAX) {
        const oldest = this.lastWatchChange.keys().next().value;
        if (oldest !== undefined) this.lastWatchChange.delete(oldest);
      }
      if (isDupWatch) return;
      // A change with no busy agent terminal belongs to the user — unless a
      // verify run is running in this workspace: test outputs (snapshots,
      // coverage, fixtures) are automated writes, not user edits. The agent
      // receives user edits on its next turn (see the edits-<id>.md context
      // file).
      const busy = workspaceTerminals().filter((t) => t.busy);
      const verifyInWorkspace = [...this.verifyRuns].some((id) => this.terminals.get(id)?.workspaceId === ws.id);
      if (busy.length === 0 && !verifyInWorkspace && !this.promotionPaths?.has(relPath)) {
        this.recordUserEdit(ws, { path, relPath, status: change.status, prev: change.prev, content: change.content, at: now });
      }
      // The watcher change event is the baseline authority for writes: it
      // carries the pre-change content, captured atomically before the cache
      // update. This is correct no matter which poll (sidecar vs watcher)
      // processed first — the tool event itself never sets write baselines.
      // A modified file without prev (first touch) stays UNDEFINED: reverting
      // refuses instead of deleting a file that existed pre-run.
      for (const inst of busy) {
        if (inst.baselines.has(path)) continue;
        if (change.status === "created") {
          this.setBaseline(inst, path, null);
        } else if (change.prev !== undefined) {
          this.setBaseline(inst, path, change.prev);
        } else {
          this.trackRecordingTask(this.fillBaseline(inst, path, change.status));
        }
      }
      // Attribute the change: the terminal whose recent tool event touched
      // this path owns it (attach the authoritative disk content to its tool
      // point — no extra dot). If nobody claims it (bash-driven or external),
      // broadcast a change point to every busy terminal.
      const owners: PiTerminalInstance[] = [];
      const unowned: PiTerminalInstance[] = [];
      for (const inst of busy) {
        const at = inst.lastToolAt.get(path);
        const mine = at !== undefined && now - at < TOOL_CHANGE_DEDUP_MS;
        (mine ? owners : unowned).push(inst);
      }
      if (owners.length > 0) {
        for (const inst of owners) {
          this.recordModified(inst, path, change.status);
          // Fork Any Moment: the path joins the terminal's next capture.
          this.addPendingHint(inst, relPath);
          this.scheduleMomentCapture(inst);
          const last = inst.timeline.at(-1);
          if (last && last.t === "tool" && last.path === path && this.contentSizeOk(change.content)) {
            last.content = change.content;
            this.setRunSnapshot(inst, path, change.content);
          }
        }
      } else if (!verifyInWorkspace) {
        for (const inst of unowned) {
          this.recordModified(inst, path, change.status);
          this.addPendingHint(inst, relPath);
          this.scheduleMomentCapture(inst);
          // An unowned change during a run is manual provenance: it marks
          // the run collaborative (WORLDLINES §6.5).
          if (inst.currentRun) inst.currentRun.unownedEdits++;
          const content = this.contentSizeOk(change.content) ? change.content : undefined;
          // Bash-driven changes provide the authoritative content for edit math.
          if (content !== undefined) this.setRunSnapshot(inst, path, content);
          // Burst coalescing: a build or install writing many files is one
          // moment. Refresh the last change dot instead of spraying dots.
          const last = inst.timeline.at(-1);
          if (last && last.t === "change" && now - (last.ts ?? 0) < CHANGE_BURST_MS) {
            last.path = path;
            last.relPath = relPath;
            last.status = change.status;
            if (content !== undefined) last.content = content;
            last.ts = now;
            const { content: _burstContent, ...pub } = last;
            this.send("timeline:event", { terminalId: inst.id, event: pub });
          } else {
            this.pushTimeline(inst, { t: "change", path, relPath, content, status: change.status });
          }
        }
      }
      // Keep the IPC light: push the content only when it fits the live
      // sync budget. The renderer fetches larger files on demand.
      const liveContent = Buffer.byteLength(change.content, "utf8") <= MAX_LIVE_SYNC_BYTES ? change.content : undefined;
      // The pre-change cache gives the exact transition. Cache the lines so
      // a later open paints the same highlight without tab history.
      let changedLines: number[] | undefined;
      if (change.prev !== undefined) {
        changedLines = changedLinesInAfter(change.prev, change.content);
        this.setBounded(ws.changeLines, path, changedLines, PiEditorApp.MAX_MODIFIED_FILES);
      } else {
        ws.changeLines.delete(path);
      }
      this.send("file:changed", { path, relPath, content: liveContent, status: change.status, changedLines });
    };
    watcher.onFileTouched = (path, status) => {
      if (this.disposed || this.projectIsSwitching(this.projectOfWorkspace(ws.id)?.id)) return;
      const canonical = this.canonicalPath(path);
      const relPath = relative(this.canonicalPath(ws.root), canonical);
      if (!relPath || relPath.startsWith("..") || isAbsolute(relPath)) return;
      ws.generation++;
      this.markCandidateEvidenceStale(ws.comparisonId);
      for (const inst of workspaceTerminals()) {
        if (inst.busy) this.recordModified(inst, canonical, status);
      }
    };
    watcher.onFileDeleted = (path) => {
      if (this.disposed || this.projectIsSwitching(this.projectOfWorkspace(ws.id)?.id)) return;
      const p = this.canonicalPath(path);
      const relPath = relative(this.canonicalPath(ws.root), p);
      if (!relPath || relPath.startsWith("..") || isAbsolute(relPath)) return;
      ws.generation++;
      this.markCandidateEvidenceStale(ws.comparisonId);
      this.send("file:deleted", { path: p });
      for (const inst of workspaceTerminals()) this.recordDeleted(inst, p);
      // A user-side deletion makes the recorded edit moot: drop the entry so
      // the context never points at a file that no longer exists. An empty
      // map must remove the file itself — the writer skips empty maps.
      const busy = workspaceTerminals().some((t) => t.busy);
      const edits = this.userEditsOf(ws);
      if (!busy && edits.delete(p)) {
        if (edits.size === 0) this.removeUserEditsFiles(ws);
        else this.scheduleUserEditsWrite();
      }
    };
    watcher.start();
    return watcher;
  }

  // ---------------------------------------------------------------- paths ---

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
    if (!this.project()?.cwd) return false;
    const rel = relative(this.canonicalPath(this.project()!.cwd), this.canonicalPath(absPath));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  }

  private rel(absPath: string, root: string | null = this.project()?.cwd ?? null): string {
    const p = this.canonicalPath(absPath);
    return root ? relative(this.canonicalPath(root), p) : p;
  }

  private projectAbs(relPath: string): string {
    const cwd = this.project()?.cwd;
    if (!cwd) throw new Error("open a project folder first");
    const abs = isAbsolute(relPath) ? relPath : join(cwd, relPath);
    const managed = this.managedPath(abs, true);
    if (!managed || managed.path === this.canonicalPath(cwd)) throw new Error(`path outside project: ${relPath}`);
    return managed.path;
  }

  /** Path under dirAbs that does not exist. Collisions use " copy" then " copy N". */
  private unusedCopyDest(dirAbs: string, name: string): string | null {
    const first = join(dirAbs, name);
    if (!existsSync(first)) return first;
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let n = 2; n < 100; n++) {
      const candidate = n === 2 ? `${stem} copy${ext}` : `${stem} copy ${n}${ext}`;
      const dest = join(dirAbs, candidate);
      if (!existsSync(dest)) return dest;
    }
    return null;
  }

  private async listDir(absPath: string): Promise<{ entries: ExplorerEntry[]; error?: string; truncated?: boolean }> {
    const managed = this.managedPath(absPath, true);
    if (!managed) return { entries: [], error: "path outside the project workspace" };
    try {
      const dirents = await readdir(managed.path, { withFileTypes: true });
      const visible = dirents.filter((ent) => !IGNORED_SEGMENTS.has(ent.name) && !ent.name.startsWith("."));
      visible.sort((a, b) => {
        const aDir = a.isDirectory() ? 0 : 1;
        const bDir = b.isDirectory() ? 0 : 1;
        if (aDir !== bDir) return aDir - bDir;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });
      const rootCanon = this.canonicalPath(managed.workspace.root);
      const entries: ExplorerEntry[] = [];
      let truncated = false;
      for (const ent of visible) {
        if (entries.length >= MAX_EXPLORER_ENTRIES) {
          truncated = true;
          break;
        }
        const full = join(managed.path, ent.name);
        const child = this.managedPath(full, true);
        if (!child || child.workspace.id !== managed.workspace.id) continue;
        entries.push({
          name: ent.name,
          path: child.path,
          relPath: relative(rootCanon, child.path),
          type: ent.isDirectory() ? "dir" : "file",
        });
      }
      return truncated ? { entries, truncated: true } : { entries };
    } catch (err) {
      return { entries: [], error: (err as Error).message };
    }
  }

  // ------------------------------------------------------------------ IPC ---

  private send(channel: string, payload: unknown): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  /** Keep terminal output inter-process communication messages bounded. */
  private sendPtyData(id: string, data: string): void {
    if (data.length <= MAX_PTY_IPC_CHUNK) {
      this.send("pty:data", { id, data });
      return;
    }
    for (let offset = 0; offset < data.length; offset += MAX_PTY_IPC_CHUNK) {
      this.send("pty:data", { id, data: data.slice(offset, offset + MAX_PTY_IPC_CHUNK) });
    }
  }

  private registerIpc(): void {
    // ---- Project tabs ----
    ipcMain.handle("project:list", async () => {
      const needsLogin = await this.piNeedsLogin();
      return [...this.projects.values()].map((p) => ({
        id: p.id,
        cwd: p.cwd,
        active: p.id === this.activeProjectId,
        terminals: p.terminalIds.size,
        needsLogin,
      }));
    });
    ipcMain.handle("project:open", () => this.openFolder());
    ipcMain.handle("project:open-path", async (_e, cwd: unknown) => {
      if (typeof cwd !== "string") return { cancelled: true };
      try {
        await access(cwd);
      } catch {
        return { cancelled: true };
      }
      return this.openProjectAt(cwd);
    });
    ipcMain.handle("project:activate", async (_e, projectId: unknown) => {
      if (typeof projectId !== "string" || !this.projects.has(projectId)) return { ok: false };
      await this.activateProject(projectId);
      return { ok: true };
    });
    ipcMain.handle("project:close", async (_e, projectId: unknown) => {
      if (typeof projectId !== "string") return { ok: false, error: "invalid project" };
      return this.closeProject(projectId);
    });

    ipcMain.handle("clipboard:write", (_e, text: unknown) => {
      if (typeof text !== "string") return { ok: false, error: "clipboard text is invalid" };
      if (Buffer.byteLength(text, "utf8") > MAX_CLIPBOARD_BYTES) return { ok: false, error: "clipboard text is too large" };
      clipboard.writeText(text);
      return { ok: true };
    });
    ipcMain.handle("clipboard:read", () => capUtf8(clipboard.readText(), MAX_CLIPBOARD_BYTES));
    ipcMain.handle("clipboard:edit", (_e, command: unknown) => {
      if (!this.win || this.win.isDestroyed()) return;
      if (command === "copy") this.win.webContents.copy();
      else if (command === "paste") this.win.webContents.paste();
    });
    ipcMain.handle("terminals:paste", (_e, id: unknown) => this.pasteTerminal(id));
    ipcMain.handle("terminals:drop-files", (e, id: unknown, paths: unknown) => this.dropTerminalFiles(e, id, paths));
    ipcMain.handle("settings:get", () => {
      const next = normalizeAppPreferences(this.preferences);
      return { ...next, shortcuts: { ...next.shortcuts } };
    });
    ipcMain.handle("settings:update", (_e, update: unknown, activateShortcuts?: boolean) =>
      this.updatePreferences(update, activateShortcuts === true),
    );
    ipcMain.handle("settings:shortcuts", (_e, shortcuts: unknown) => this.setKeyboardShortcuts(shortcuts));
    ipcMain.handle("update:get", () => this.appUpdater?.getState() ?? { status: "disabled" as const, currentVersion: app.getVersion() });
    ipcMain.handle("update:check", () => {
      this.appUpdater?.check();
      return this.appUpdater?.getState() ?? { status: "disabled" as const, currentVersion: app.getVersion() };
    });
    ipcMain.handle("update:install", () => this.installAppUpdate());

    ipcMain.handle("terminals:create", async (_e, opts?: unknown) => {
      let type: "agent" | "shell" | undefined;
      let shell: string | undefined;
      let engine: "pi" | "core" | undefined;
      let fromTerminalId: string | undefined;
      if (opts !== undefined) {
        if (typeof opts !== "object" || opts === null) return { ok: false, error: "invalid terminal options" };
        const rec = opts as { type?: unknown; shell?: unknown; engine?: unknown; fromTerminalId?: unknown };
        if (rec.type !== undefined && rec.type !== "agent" && rec.type !== "shell") {
          return { ok: false, error: "invalid terminal type" };
        }
        if (rec.engine !== undefined && rec.engine !== "pi" && rec.engine !== "core") {
          return { ok: false, error: "invalid agent engine" };
        }
        if (rec.shell !== undefined && typeof rec.shell !== "string") return { ok: false, error: "invalid shell" };
        if (rec.fromTerminalId != null) {
          if (typeof rec.fromTerminalId !== "string" || rec.fromTerminalId.length > 64) {
            return { ok: false, error: "invalid source terminal" };
          }
          const id = rec.fromTerminalId.trim();
          if (id) fromTerminalId = id;
        }
        type = rec.type;
        shell = rec.shell;
        engine = rec.engine;
        if (shell) {
          const shells = await detectShells();
          if (!shells.some((item) => item.path === shell)) return { ok: false, error: "unknown shell" };
        }
      }
      try {
        const t = await this.createTerminal(undefined, { type, shell, engine, fromTerminalId });
        return { ok: true, id: t.id };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });
    ipcMain.handle("terminals:shells", () => detectShells());
    ipcMain.handle("app:pi-status", async () => {
      const available = await this.checkPiAvailable();
      return { available, bin: this.resolvePiBin(), message: available ? undefined : this.piMissingMessage() };
    });
    ipcMain.handle("terminals:close", (_e, id: string) => this.closeTerminal(id));
    ipcMain.handle("terminals:write", (_e, id: unknown, data: unknown) => {
      if (typeof id !== "string" || typeof data !== "string") return;
      const inst = this.terminals.get(id);
      if (!inst) return;
      // Detect /new slash command before it reaches the pty. The bridge also
      // catches it via the prompt payload, but /new may reset the session
      // without a prompt/before_agent_start cycle.
      if (inst.type === "agent") {
        const buf = (this.newCommandBuffers.get(id) ?? "") + data;
        if (buf.includes("\r") || buf.includes("\n")) {
          const lines = buf.split(/\r|\n/);
          this.newCommandBuffers.set(id, lines.pop() ?? "");
          for (const line of lines) {
            if (this.isNewCommand(line)) { this.clearForNewSession(id); break; }
          }
        } else {
          this.newCommandBuffers.set(id, buf.length > 200 ? buf.slice(-200) : buf);
        }
        if ((this.newCommandBuffers.get(id)?.length ?? 0) > 200) {
          this.newCommandBuffers.set(id, (this.newCommandBuffers.get(id) ?? "").slice(-200));
        }
      }
      // Keystrokes are tiny. Skip the UTF-8 scan until the payload is large.
      let text = data;
      if (data.length > 4096 && Buffer.byteLength(data, "utf8") > MAX_CLIPBOARD_BYTES) {
        text = capUtf8(data, MAX_CLIPBOARD_BYTES);
      }
      if (text === "\x03") inst.interruptedAt = Date.now();
      inst.pty.write(text);
    });
    ipcMain.handle("terminals:resize", (_e, id: unknown, cols: unknown, rows: unknown) => {
      if (typeof id !== "string" || !Number.isFinite(cols) || !Number.isFinite(rows)) return;
      this.terminals.get(id)?.pty.resize(Math.max(2, Math.floor(Number(cols))), Math.max(2, Math.floor(Number(rows))));
    });
    ipcMain.handle("terminals:list", () => {
      this.sendInstances();
      return this.instanceList();
    });

    // ---- Worldlines: run records (WORLDLINES §6.5) ----
    ipcMain.handle("worldline:runs", (_e, terminalId?: string) => {
      if (terminalId) {
        return this.projectOfTerminal(terminalId)?.worldlines?.runSummaries(terminalId) ?? [];
      }
      return this.project()?.worldlines?.runSummaries() ?? [];
    });

    // ---- Worldlines: candidates (WORLDLINES §6.5, §6.6) ----
    ipcMain.handle("worldline:list", () => this.project()?.worldlines?.list() ?? []);
    ipcMain.handle("worldline:promote", (_e, comparisonId: string, label: "A" | "B", force?: boolean) => {
      const manager = this.projectOfComparison(comparisonId)?.worldlines;
      if (!manager) return Promise.resolve({ ok: false, error: "candidate not found" });
      return manager.promote(comparisonId, label, force ?? false);
    });
    ipcMain.handle("worldline:challenge", async (_e, runId: string) => {
      const manager = this.projectForRun(runId)?.worldlines;
      if (!manager) return { ok: false, error: "run not found" };
      return manager.challenge(runId);
    });
    ipcMain.handle("worldline:evidence", (_e, comparisonId: string) => {
      const manager = this.projectOfComparison(comparisonId)?.worldlines;
      if (!manager) return Promise.resolve({ ok: false, error: "comparison not found" });
      return manager.measureEvidence(comparisonId);
    });
    ipcMain.handle("worldline:fork-point", async (_e, terminalId: string, seq: number) => {
      const inst = this.terminals.get(terminalId);
      if (!inst) return { ok: false, error: "terminal not found" };
      const owner = this.projectOfTerminal(terminalId);
      if (!owner) return { ok: false, error: "no project open" };
      this.initWorldlines(owner);
      const ev = inst.timeline.find((e) => e.seq === seq) ?? null;
      return owner.worldlines!.forkPoint(terminalId, ev);
    });
    const wlOf = (comparisonId: string) => this.projectOfComparison(comparisonId)?.worldlines ?? null;
    ipcMain.handle("worldline:details", (_e, comparisonId: string, label: "A" | "B") => wlOf(comparisonId)?.details(comparisonId, label) ?? { ok: false, error: "worldlines unavailable" });
    ipcMain.handle("worldline:challenge-candidate", (_e, comparisonId: string, label: "A" | "B") => wlOf(comparisonId)?.challengeFromCandidate(comparisonId, label) ?? { ok: false, error: "worldlines unavailable" });
    ipcMain.handle("worldline:file", (_e, comparisonId: string, label: "A" | "B", relPath: string) => wlOf(comparisonId)?.fileOf(comparisonId, label, relPath) ?? { ok: false, error: "worldlines unavailable" });
    ipcMain.handle("worldline:base-file", (_e, comparisonId: string, relPath: string) => wlOf(comparisonId)?.baseFileOf(comparisonId, relPath) ?? { ok: false, error: "worldlines unavailable" });
    ipcMain.handle("worldline:fork-run", async (_e, runId: string) => {
      const manager = this.projectForRun(runId)?.worldlines;
      if (!manager) return { ok: false, error: "run not found" };
      return manager.forkRun(runId);
    });
    ipcMain.handle("worldline:cancel", (_e, comparisonId: string) => wlOf(comparisonId)?.cancel(comparisonId) ?? { ok: false, error: "worldlines unavailable" });
    ipcMain.handle("worldline:discard", (_e, comparisonId: string) => wlOf(comparisonId)?.discard(comparisonId) ?? { ok: false, error: "worldlines unavailable" });
    ipcMain.handle("worldline:open-terminal", (_e, comparisonId: string, label: "A" | "B") =>
      wlOf(comparisonId)?.openTerminal(comparisonId, label) ?? { ok: false, error: "worldlines unavailable" },
    );
    /** Materialize a run's start or settled state for inspection. */
    ipcMain.handle("worldline:export-state", async (_e, runId: string, kind: "start" | "settled") => {
      const project = this.projectForRun(runId);
      const run = project?.worldlines?.runOf(runId);
      if (!project || !run) return { ok: false, error: "run not found" };
      const stateId = kind === "start" ? run.startStateId : run.settledStateId;
      if (!stateId) return { ok: false, error: `no ${kind} state` };
      const store = await project.storePromise;
      if (!store) return { ok: false, error: "recording is not available" };
      try {
        const dir = await mkdtemp(join(app.getPath("temp"), "termina-state-"));
        this.exportedStateDirs.set(dir, project.id);
        await store.materialize(stateId, dir);
        return { ok: true, dir };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    // ---- Editor flush (run-start preflight) ----
    ipcMain.handle("editor:flush-report", (_e, requestId: unknown, result: unknown) => {
      if (typeof requestId !== "string") return;
      if (!isFlushResult(result)) return;
      const waiter = this.flushWaiters.get(requestId);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.flushWaiters.delete(requestId);
      waiter.resolve(result);
    });
    /** The flush saves go through the lease holder (the preflight). */
    ipcMain.handle("file:flush-save", async (_e, absPath: string, content: string, writerId: string) => {
      if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_OPEN_FILE_SIZE) return { ok: false, error: "file content is too large" };
      const managed = this.managedPath(absPath);
      if (!managed) return { ok: false, error: "path is outside a managed workspace" };
      if (managed.workspace.writerId !== writerId) return { ok: false, error: "the flush does not hold the write lease" };
      try {
        const info = await stat(managed.path);
        if (!info.isFile()) return { ok: false, error: "path is not a regular file" };
        await writeFile(managed.path, content, "utf8");
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });
    ipcMain.handle("terminals:abort", (_e, id: string) => {
      const inst = this.terminals.get(id);
      if (!inst) return;
      inst.interruptedAt = Date.now();
      inst.pty.write("\x03");
    });

    // ---- Verify & Iterate ----
    ipcMain.handle("verify:detect", (_e, terminalId?: string) => {
      // A candidate terminal detects from its own isolated tree.
      if (terminalId && this.terminals.has(terminalId)) {
        const inst = this.terminals.get(terminalId)!;
        return this.detectTestCommand(inst.cwd);
      }
      return this.detectTestCommand(this.terminalCwd());
    });
    ipcMain.handle("verify:run", (_e, terminalId: string) => this.runVerify(terminalId));
    ipcMain.handle("verify:cancel", (_e, terminalId: string) => this.cancelVerify(terminalId));

    // ---- Mine ----
    ipcMain.handle("mine:set", (_e, path: string, mine: boolean) => this.setMineFile(path, mine));
    ipcMain.handle("mine:list", () => [...(this.project()?.mineFiles ?? [])]);

    // ---- Dispatch ----
    ipcMain.handle("dispatch:run", (_e, terminalId: string, taskText?: string) =>
      this.dispatchRun(terminalId, typeof taskText === "string" ? taskText : undefined),
    );

    // ---- Session Search ----
    ipcMain.handle("session:search", (_e, query: unknown) => this.searchSessions(typeof query === "string" ? query : ""));

    // ---- Plan Board ----
    ipcMain.handle("plan:get", (_e, terminalId: string) => this.terminals.get(terminalId)?.plan ?? []);

    // ---- Session Timeline ----
    ipcMain.handle("timeline:get", (_e, terminalId: string) => {
      const tl = this.terminals.get(terminalId)?.timeline ?? [];
      return tl.map(({ content: _content, ...pub }) => pub);
    });
    ipcMain.handle("timeline:prefix", (_e, terminalId: string) => {
      const inst = this.terminals.get(terminalId);
      if (!inst) return { terminalId, ok: 0, error: 0, open: 0 };
      return this.timelinePrefixOf(inst);
    });
    ipcMain.handle("timeline:progress", (_e, terminalId: string, seq: number) => this.timelineProgress(terminalId, seq));
    ipcMain.handle("timeline:content", (_e, terminalId: string, seq: number) => {
      const inst = this.terminals.get(terminalId);
      const ev = inst?.timeline.find((e) => e.seq === seq);
      if (!ev) return { ok: false, seq };
      if (ev.content === undefined) return { ok: false, seq, path: ev.path, relPath: ev.relPath };
      return { ok: true, seq, path: ev.path, relPath: ev.relPath, content: ev.content, ts: ev.ts, toolName: ev.toolName };
    });

    // ---- Modified list ----
    ipcMain.handle("modified:clear", (_e, terminalId: string) => {
      const inst = this.terminals.get(terminalId);
      if (!inst) return { ok: false, error: "terminal not found" };
      // Main owns the list: clearing only the renderer copy would resurrect
      // every entry on the next push.
      inst.modified.clear();
      this.send("modified:list", { instanceId: inst.id, files: [] });
      return { ok: true };
    });

    // ---- Change Review ----
    ipcMain.handle("review:baseline", async (_e, terminalId: string, path: string) => {
      const inst = this.terminals.get(terminalId);
      const managed = inst ? this.managedPath(path) : null;
      if (!inst || !managed || managed.workspace.id !== inst.workspaceId) return { status: "modified", baseline: undefined };
      // A lazy capture can still be in flight when the user clicks the
      // modified entry. Wait for it so the diff does not show a false
      // "no baseline" state.
      if (!inst.baselines.has(managed.path)) {
        const pending = inst.baselineFills.get(managed.path);
        if (pending) await Promise.race([pending, new Promise((r) => setTimeout(r, 2000))]);
      }
      const b = inst.baselines.get(managed.path);
      if (b === undefined) return { status: "modified", baseline: undefined };
      if (b === null) return { status: "created", baseline: null };
      return { status: "modified", baseline: b };
    });
    ipcMain.handle("review:revert", async (_e, terminalId: string, path: string) => {
      const inst = this.terminals.get(terminalId);
      if (!inst) return { ok: false, error: "terminal not found" };
      const blocked = this.assertWorkspaceWritable(inst.workspaceId);
      if (blocked) return { ok: false, error: blocked };
      const managed = this.managedPath(path);
      if (!managed || managed.workspace.id !== inst.workspaceId) return { ok: false, error: "path is outside the terminal workspace" };
      const p = managed.path;
      const b = inst.baselines.get(p);
      if (b === undefined) return { ok: false, error: "no baseline captured for this file" };
      try {
        if (b === null) {
          // The agent created the file. Delete it.
          await rm(p, { force: true });
        } else {
          await writeFile(p, b, "utf8");
        }
        this.deleteBaseline(inst, p);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    ipcMain.handle("file:open", (_e, absPath: unknown) => {
      if (typeof absPath !== "string") return { ok: false, path: "", error: "invalid path" };
      return this.openFileInEditor(absPath);
    });
    ipcMain.handle("file:save", async (_e, absPath: unknown, content: unknown) => {
      if (typeof absPath !== "string") return { ok: false, error: "invalid path" };
      if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_OPEN_FILE_SIZE) return { ok: false, error: "file content is too large" };
      const managed = this.managedPath(absPath);
      if (!managed) return { ok: false, error: "path is outside a managed workspace" };
      const blocked = this.assertWorkspaceWritable(managed.workspace.id);
      if (blocked) return { ok: false, error: blocked };
      try {
        const info = await stat(managed.path);
        if (!info.isFile()) return { ok: false, error: "path is not a regular file" };
        await writeFile(managed.path, content, "utf8");
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    ipcMain.handle("explorer:list-dir", (_e, absPath: unknown) => {
      if (typeof absPath !== "string") return { entries: [], error: "invalid path" };
      return this.listDir(absPath);
    });
    ipcMain.handle("explorer:create", async (_e, relPath: unknown, kind: unknown) => {
      if (typeof relPath !== "string") return { ok: false, error: "invalid path" };
      if (kind !== "file" && kind !== "dir") return { ok: false, error: "kind must be file or dir" };
      const blocked = this.assertWorkspaceWritable(this.primaryWorkspace()?.id ?? "");
      if (blocked) return { ok: false, error: blocked };
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
    ipcMain.handle("explorer:rename", async (_e, relPath: unknown, newName: unknown) => {
      const blocked = this.assertWorkspaceWritable(this.primaryWorkspace()?.id ?? "");
      if (blocked) return { ok: false, error: blocked };
      try {
        if (typeof relPath !== "string") return { ok: false, error: "invalid path" };
        if (typeof newName !== "string" || !newName || newName.includes("/") || newName === "." || newName === "..") {
          return { ok: false, error: "invalid name" };
        }
        const abs = this.projectAbs(relPath);
        await fsRename(abs, join(dirname(abs), newName));
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });
    ipcMain.handle("explorer:delete", async (_e, relPath: unknown) => {
      if (typeof relPath !== "string") return { ok: false, error: "invalid path" };
      const blocked = this.assertWorkspaceWritable(this.primaryWorkspace()?.id ?? "");
      if (blocked) return { ok: false, error: blocked };
      try {
        const abs = this.projectAbs(relPath);
        await rm(abs, { recursive: true, force: true });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    // Explorer clipboard paste. Copies (or moves, for a cut entry) the source
    // under the target directory; a name collision gets " copy" / " copy N".
    // An empty targetDirRel means the project root itself.
    ipcMain.handle("explorer:paste", async (_e, targetDirRel: unknown, srcRel: unknown, move: unknown) => {
      if (typeof targetDirRel !== "string" || typeof srcRel !== "string" || typeof move !== "boolean") {
        return { ok: false, error: "invalid arguments" };
      }
      if (!srcRel || srcRel === ".") return { ok: false, error: "invalid source" };
      const blocked = this.assertWorkspaceWritable(this.primaryWorkspace()?.id ?? "");
      if (blocked) return { ok: false, error: blocked };
      try {
        const src = this.projectAbs(srcRel);
        let dirAbs: string;
        if (targetDirRel === "" || targetDirRel === ".") {
          const cwd = this.project()?.cwd;
          if (!cwd) return { ok: false, error: "open a project folder first" };
          dirAbs = this.canonicalPath(cwd);
        } else {
          dirAbs = this.projectAbs(targetDirRel);
        }
        // The paste target must be a directory.
        if (!existsSync(dirAbs) || !statSync(dirAbs).isDirectory()) {
          return { ok: false, error: "paste target is not a folder" };
        }
        // A folder cannot be pasted into itself or one of its descendants.
        if (dirAbs === src || dirAbs.startsWith(src + sep)) {
          return { ok: false, error: "cannot paste a folder into itself" };
        }
        const dest = this.unusedCopyDest(dirAbs, basename(src));
        if (!dest) return { ok: false, error: "destination already exists" };
        if (move) await fsRename(src, dest);
        else await cp(src, dest, { recursive: true });
        return { ok: true, name: basename(dest) };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });
  }

  private async openFileInEditor(absPath: string): Promise<{ ok: true; path: string; content: string; changedLines?: number[] } | { ok: false; path: string; error: string }> {
    const managed = this.managedPath(absPath);
    if (!managed) return { ok: false, path: absPath, error: "path is outside a managed workspace" };
    try {
      const st = await stat(managed.path);
      if (!st.isFile()) return { ok: false, path: managed.path, error: "not a file" };
      if (st.size > MAX_OPEN_FILE_SIZE) return { ok: false, path: managed.path, error: `file is too large to open (${st.size} bytes)` };
      const content = await readFile(managed.path, "utf8");
      return { ok: true, path: managed.path, content, changedLines: managed.workspace.changeLines.get(managed.path) };
    } catch (err) {
      return { ok: false, path: managed.path, error: (err as Error).message };
    }
  }

  // ---------------------------------------------------------------- boot ----

  async start(): Promise<void> {
    this.preferences = await this.preferencesStore.load();
    this.shortcutMap = { ...this.preferences.shortcuts };
    this.appUpdater = createAppUpdater({
      send: (state) => {
        this.send("update:state", state);
        this.applyUpdateMenu();
      },
    });
    this.registerIpc();
    void detectShells();
    // The session workspace is per-launch scratch: run ids restart at
    // run-1, and stale copies from a previous launch would collide.
    rmSync(this.sessionWorkspaceDir, { recursive: true, force: true });
    this.cleanupStaleDispatchFiles();
    // Tests set TERMINA_INITIAL_CWD so the fixture is open before the
    // window loads. A normal launch has no folder until the user picks one.
    const initial = process.env.TERMINA_INITIAL_CWD;
    const initialCwd = initial && existsSync(initial) ? initial : null;
    this.tailer.onEvent = (id, event) => this.enqueueSidecarEvent(id, event);
    this.tailer.start();
    // Write the bridge before the first terminal starts: pi loads it with
    // the CLI extension option on every agent launch, with or without a
    // project folder.
    this.ensureAppBridge();
    await this.createWindow();
    this.appUpdater.start();
    if (initialCwd) {
      await this.openProject(initialCwd);
      return;
    }
    // Restore the projects from the last session. Missing or non-directory
    // paths are skipped: they may be unmounted volumes or hand-edited entries.
    for (const root of this.preferences.openProjects) {
      try {
        if (!statSync(root).isDirectory()) continue;
      } catch {
        continue;
      }
      try {
        await this.openProject(root);
      } catch (err) {
        console.warn(`[main] could not restore project ${root}: ${(err as Error).message}`);
      }
    }
    // A normal launch has no folder. The renderer shows the open-folder
    // placeholder until the user picks one. Tests set TERMINA_INITIAL_CWD.
  }

  /** Record the open projects so the next launch restores them. */
  private persistOpenProjects(): Promise<void> {
    const roots = [...this.projects.values()].map((p) => p.canonicalRoot);
    if (JSON.stringify(roots) === JSON.stringify(this.preferences.openProjects)) return Promise.resolve();
    return this.commitPreferencePatch({ openProjects: roots }, false).then(
      () => undefined,
      (err) => {
        console.warn(`[main] project list save failed: ${(err as Error).message}`);
      },
    );
  }

  private async checkAppUpdateFromMenu(): Promise<void> {
    if (!app.isPackaged) {
      const payload = {
        type: "info" as const,
        title: "Updates",
        message: "This launch does not auto-update.",
        detail: "Install Termina from GitHub Releases to receive in-app updates. A source or npm run dev launch stays on the code you built.",
      };
      const win = this.win;
      if (win && !win.isDestroyed()) await dialog.showMessageBox(win, payload);
      else await dialog.showMessageBox(payload);
      return;
    }
    this.appUpdater?.check();
  }

  private async installAppUpdate(): Promise<{ ok: boolean; error?: string }> {
    const updater = this.appUpdater;
    if (!updater) return { ok: false, error: "No update is ready." };
    const current = updater.getState();
    if (current.status !== "ready") return updater.install();
    if (this.installingUpdate) return { ok: false, error: "The update is already installing." };
    this.installingUpdate = true;
    if (!(await this.confirmDiscardActiveCandidates())) {
      this.installingUpdate = false;
      return { ok: false, error: "Update cancelled." };
    }
    // Finish app teardown before the installer quits the process. A
    // preventDefault on before-quit would stop macOS from installing.
    quitConfirmed = true;
    cleanupStarted = true;
    try {
      await this.dispose();
    } catch (err) {
      console.warn(`[main] dispose failed before update: ${(err as Error).message}`);
    }
    cleanupComplete = true;
    updater.quitAndInstall();
    return { ok: true };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.appUpdater?.dispose();
    await this.persistOpenProjects();
    await this.preferenceCommits;
    await this.preferencesStore.flush();
    await this.drainVerifyJobs(null);
    this.tailer.stop();
    await this.drainSidecarQueues();
    this.sidecarQueues.clear();
    await Promise.all([...this.projects.values()].map((project) => project.worldlines?.drainEvidence() ?? Promise.resolve()));
    this.cleanupExportedStates();
    for (const project of this.projects.values()) {
      await project.worldlines?.dispose().catch(() => undefined);
      project.worldlines = null;
      for (const ws of project.workspaces.values()) ws.watcher?.stop();
    }
    coreClient.dispose();
    for (const inst of this.terminals.values()) {
      if (inst.captureTimer) {
        clearTimeout(inst.captureTimer);
        inst.captureTimer = null;
      }
      inst.pty.kill();
    }
    await this.drainTerminals(null);
    for (const inst of this.terminals.values()) {
      for (const event of inst.timeline) {
        if (event.stateId) void this.releaseStateIfUnused(event.stateId, inst.id, event.seq);
      }
    }
    if (this.userEditsWriteTimer) {
      clearTimeout(this.userEditsWriteTimer);
      this.userEditsWriteTimer = null;
    }
    for (const pending of this.pendingPreflights.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingPreflights.clear();
    for (const waiter of this.flushWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve({ ok: false, failed: ["app disposed"] });
    }
    this.flushWaiters.clear();
    this.projects.clear();
    this.terminals.clear();
    for (const tailer of this.worldlineTailers.values()) tailer.stop();
    this.worldlineTailers.clear();
    this.sessionFork.dispose();
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
      // A blank first paint is a startup problem. Check every 3 seconds
      // until the window paints content once. Then check every 15 seconds
      // to catch a stalled renderer.
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

// An explicit user-data dir must also move the single-instance lock. A
// dev or test instance then runs beside the installed app.
const userDataOverride = process.env.TERMINA_USER_DATA_DIR;
if (userDataOverride) {
  try {
    mkdirSync(userDataOverride, { recursive: true });
    app.setPath("userData", userDataOverride);
  } catch (err) {
    // Keep the default user data: a broken override must not kill startup.
    console.error(`[termina] ignoring TERMINA_USER_DATA_DIR: ${(err as Error).message}`);
  }
}

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
  // Boot the app when Electron is ready. Without this line the window
  // never opens: every handler above only reacts to events.
  app.whenReady().then(() => void appState.start());
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void appState.createWindow();
});

app.on("before-quit", (event) => {
  if (cleanupComplete) return;
  event.preventDefault();
  if (cleanupStarted) return;
  if (quitConfirmed) {
    cleanupStarted = true;
    void appState
      .dispose()
      .catch((err) => {
        console.warn(`[main] dispose failed during quit: ${(err as Error).message}`);
      })
      .then(() => {
        cleanupComplete = true;
        app.quit();
      });
    return;
  }
  cleanupStarted = true;
  void appState
    .confirmDiscardActiveCandidates()
    .catch(() => false)
    .then((ok) => {
      cleanupStarted = false;
      if (!ok) return;
      quitConfirmed = true;
      app.quit();
    });
});