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
import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { openSync, closeSync, fsyncSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename as fsRename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { PtyTerminal } from "./pty-terminal.js";
import { SidecarEvent, SidecarTailer } from "./sidecar.js";
import { IGNORED_SEGMENTS, ProjectWatcher } from "./watcher.js";
import { SnapshotStore, gitCommonDir, gitHead, gitObjectFormat, gitTopLevel, type SourceState } from "./worldline-git.js";
import { WorldlineManager, type ForkableRun } from "./worldlines.js";
import type {
  ExplorerEntry,
  InstanceSummary,
  ModifiedFile,
  RunSummary,
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
 * Pi/ditor bridge extension — auto-generated, do not edit.
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FILE_TOOLS = new Set(["write", "edit", "apply_patch", "create_file", "insert"]);


export default function (pi: ExtensionAPI): void {
  const dir = process.env.PI_EDITOR_EVENTS_DIR;
  const id = process.env.PI_EDITOR_TERMINAL_ID;
  if (!dir || !id) return;
  // One random bridge instance id per extension load. Main accepts a
  // sequence reset only after a new instance id (WORLDLINES §6.3).
  const bridgeId = randomUUID();
  let seq = 0;
  const log = (event: Record<string, unknown>): void => {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      seq++;
      appendFileSync(join(dir, id + ".jsonl"), JSON.stringify({ bridgeId, seq, ...event }) + "\\n", { mode: 0o600 });
    } catch {}
  };
  /** Poll for the app's acknowledgement file, consume it exactly once. */
  const waitForAck = (requestId: string, timeoutMs: number): Promise<Record<string, unknown> | null> => {
    const ackPath = join(dir, \`ack-\${id}-\${requestId}.json\`);
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const poll = (): void => {
        try {
          const raw = readFileSync(ackPath, "utf8");
          rmSync(ackPath, { force: true });
          resolve(JSON.parse(raw) as Record<string, unknown>);
          return;
        } catch {
          /* not written yet */
        }
        if (Date.now() > deadline) {
          resolve(null);
          return;
        }
        setTimeout(poll, 50);
      };
      poll();
    });
  };
  /** One-use preflight state carried from input to agent_start. */
  let preflight: { requestId: string; token: string | null } | null = null;
  let planLogged = false;

  // ---- startup control (WORLDLINES §6.7) ----
  // The candidate terminal starts with a one-shot control file: prefill
  // text, send a structured prompt, or start with no prompt. The bridge
  // consumes the file exactly once before applying it.
  pi.on("session_start", (_event, ctx) => {
    let control: { opId?: unknown; action?: unknown; text?: unknown; content?: unknown } | null = null;
    try {
      const controlPath = join(dir, "startup-control.json");
      const raw = readFileSync(controlPath, "utf8");
      rmSync(controlPath, { force: true });
      control = JSON.parse(raw) as { opId?: unknown; action?: unknown; text?: unknown; content?: unknown };
    } catch {
      /* no control: a reload after application */
    }
    const opId = String(control?.opId ?? "");
    if (!control) {
      log({ t: "session_ready", opId, ok: true, reload: true });
      return;
    }
    try {
      if (control.action === "prefill" && typeof control.text === "string") {
        // Editable text: the user can change it before submitting.
        ctx.ui.setEditorText(control.text);
      } else if (control.action === "structured") {
        // One-shot marker: a reload cannot submit the prompt twice.
        pi.appendEntry("pi-ditor-control", { opId });
        const content = Array.isArray(control.content) ? control.content : [String(control.text ?? "")];
        pi.sendUserMessage(content);
      }
      log({ t: "session_ready", opId, ok: true });
    } catch (err) {
      log({ t: "session_ready", opId, ok: false, error: String(err) });
    }
  });

  // ---- run-start preflight (WORLDLINES §6.3) ----
  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive") return { action: "continue" };
    const text = String(event.text ?? "").trim();
    const images = (event.images ?? []) as unknown[];
    if (!ctx.isIdle()) {
      // A steering interrupt or queued follow-up: the open run cannot be
      // replayed as one task.
      log({ t: "steer_input", behavior: String(event.streamingBehavior ?? "steer") });
      return { action: "continue" };
    }
    if (!text && images.length === 0) return { action: "continue" };
    const requestId = randomUUID();
    log({ t: "preflight_request", requestId, hasImages: images.length > 0 });
    const ack = await waitForAck(requestId, 15000);
    if (!ack || ack.ok !== true) {
      const err = String((ack as { error?: unknown })?.error ?? "preflight timed out");
      // Keep the draft editable: restore the raw text and do not start.
      if (text) ctx.ui.setEditorText(String(event.text ?? ""));
      ctx.ui.notify("pi/ditor: the run did not start (" + err + "). Your text is still in the editor.", "warning");
      return { action: "handled" };
    }
    preflight = { requestId, token: (ack as { token?: string | null }).token ?? null };
    return { action: "continue" };
  });

  pi.on("agent_start", (event, ctx) => {
    planLogged = false;
    const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
    const leafId = ctx.sessionManager.getLeafId();
    const parentId = leafId ? (ctx.sessionManager.getEntry(leafId)?.parentId ?? null) : null;
    log({
      t: "agent_start",
      preflightRequestId: preflight?.requestId ?? null,
      preflightToken: preflight?.token ?? null,
      sessionFile,
      sessionId: ctx.sessionManager.getSessionId(),
      entryId: leafId,
      parentEntryId: parentId,
      trusted: ctx.isProjectTrusted(),
      model: ctx.model?.id ?? null,
      thinkingLevel: ctx.thinkingLevel ?? null,
    });
    preflight = null;
  });

  // The settled boundary: report the settle, then ask for a checkpoint
  // and wait for the outcome.
  pi.on("agent_settled", async (event, ctx) => {
    log({ t: "agent_settled" });
    const requestId = randomUUID();
    log({ t: "checkpoint_request", requestId, kind: "settled", entryId: ctx.sessionManager.getLeafId() });
    const ack = await waitForAck(requestId, 20000);
    log({ t: "checkpoint_result", requestId, ok: ack?.ok === true, error: (ack as { error?: unknown })?.error ?? null });
  });

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
  // agent's next turn. Capture the effective expanded prompt and images in
  // an app-private payload file first.
  pi.on("before_agent_start", async (event) => {
    let context = "";
    for (const name of [\`verify-\${id}.md\`, \`edits-\${id}.md\`, \`mine-\${id}.md\`]) {
      try {
        const text = readFileSync(join(dir, name), "utf8");
        if (text) context += (context ? "\\n\\n---\\n\\n" : "") + text;
      } catch {}
    }
    try {
      const file = \`prompt-\${id}-\${bridgeId.slice(0, 8)}-\${seq}.json\`;
      writeFileSync(join(dir, file), JSON.stringify({ prompt: event.prompt, images: event.images ?? [], context }), { mode: 0o600 });
      log({ t: "prompt", file, hasPreflight: preflight !== null });
    } catch {}
    if (!context) return;
    return {
      message: { customType: "pi-ditor-context", content: context, display: false },
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
let workspaceSeq = 0;

/** One source tree the app controls (WORLDLINES §6.2). */
interface WorkspaceState {
  id: string;
  root: string;
  /** True for the opened project; false for worldline candidates. */
  primary: boolean;
  /** Bumped on every watcher-observed content change. */
  generation: number;
  /** The id of the current write-lease holder, or null. */
  writerId: string | null;
  watcher: ProjectWatcher | null;
  terminalIds: Set<string>;
  /** The last captured state commit (the lineage parent). */
  lastStateCommit: string | null;
  /** Resolves when the initial index capture finished. */
  indexReady: Promise<void> | null;
  /** Why recording is unavailable, when it is. */
  recordError: string | null;
}

/** One recorded run (WORLDLINES §6.5). */
interface RunRecord {
  id: string;
  terminalId: string;
  workspaceId: string;
  startStateId: string | null;
  settledStateId: string | null;
  /** The app-private prompt payload file (text + images). */
  promptPayloadFile: string | null;
  /** The effective prompt text, capped for IPC. */
  promptText: string | null;
  promptEntryId: string | null;
  promptParentEntryId: string | null;
  settledEntryId: string | null;
  sessionFile: string | null;
  /** The app-private copy of the session branch. */
  sessionBranchFile: string | null;
  trusted: boolean | null;
  /** The selected model and thinking level of the run. */
  model: string | null;
  thinkingLevel: string | null;
  replayable: boolean;
  reason: string | null;
  interrupted: boolean;
  steering: boolean;
  overlap: boolean;
  unownedEdits: number;
  startedAt: number;
  settledAt: number | null;
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
  /** The workspace this terminal works in (empty when no folder is open). */
  workspaceId: string;
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
 * Runs captures on a worker thread. Requests are serialized: the store
 * writes one capture at a time.
 */
class SnapshotWorkerClient {
  private worker: Worker | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;

  private ensure(): Worker {
    if (this.worker) return this.worker;
    this.worker = new Worker(join(__dirname, "snapshot-worker.mjs"));
    this.worker.on("message", (msg: { op?: string; requestId?: string; ok?: boolean; error?: string; state?: SourceState }) => {
      // The worker answers every op with <op>-result.
      if (!msg.requestId) return;
      const p = this.pending.get(msg.requestId);
      if (!p) return;
      this.pending.delete(msg.requestId);
      if (msg.ok) p.resolve(msg.state ?? msg);
      else p.reject(new Error(msg.error ?? "snapshot worker op failed"));
    });
    this.worker.on("error", (err) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.worker = null;
    });
    return this.worker;
  }

  /** Serialize captures; a failing capture does not poison the queue. */
  request(payload: Record<string, unknown>): Promise<unknown> {
    const run = this.queue.then(() => this.dispatch(payload));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private dispatch(payload: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const requestId = `cap-${++this.seq}`;
      this.pending.set(requestId, { resolve, reject });
      try {
        // The payload carries its own op (capture, template, apply-state).
        this.ensure().postMessage({ ...payload, requestId });
      } catch (err) {
        this.pending.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Capture one source state off the main thread. */
  capture(store: SnapshotStore, head: string | null, parentCommit: string | null, source?: { root: string; gitDir: string }): Promise<SourceState> {
    return this.request({
      op: "capture",
      storeDir: store.dir,
      sourceRoot: store.sourceRoot,
      sourceGitDir: store.sourceGitDir,
      objectFormat: store.objectFormat,
      head,
      parentCommit,
      captureRoot: source?.root,
      captureGitDir: source?.gitDir,
    }) as Promise<SourceState>;
  }

  /** Create the comparison template (git init, base bytes, commit). */
  template(opts: { store: SnapshotStore; stateId: string; targetDir: string; sourceObjectsDir: string }): Promise<void> {
    return this.request({
      op: "template",
      storeDir: opts.store.dir,
      sourceRoot: opts.store.sourceRoot,
      sourceGitDir: opts.store.sourceGitDir,
      objectFormat: opts.store.objectFormat,
      stateId: opts.stateId,
      targetDir: opts.targetDir,
      sourceObjectsDir: opts.sourceObjectsDir,
    }) as Promise<void>;
  }

  /** Apply a state over a candidate directory and commit it. */
  applyState(opts: { store: SnapshotStore; stateId: string; targetDir: string }): Promise<void> {
    return this.request({
      op: "apply-state",
      storeDir: opts.store.dir,
      sourceRoot: opts.store.sourceRoot,
      sourceGitDir: opts.store.sourceGitDir,
      objectFormat: opts.store.objectFormat,
      stateId: opts.stateId,
      targetDir: opts.targetDir,
    }) as Promise<void>;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}

/**
 * Runs SessionManager work (session forking) on a worker thread.
 * Requests are serialized.
 */
class SessionWorkerClient {
  private worker: Worker | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;

  private ensure(): Worker {
    if (this.worker) return this.worker;
    this.worker = new Worker(join(__dirname, "session-worker.mjs"));
    this.worker.on("message", (msg: { op?: string; requestId?: string; ok?: boolean; error?: string }) => {
      if (msg.op !== "fork-result" || !msg.requestId) return;
      const p = this.pending.get(msg.requestId);
      if (!p) return;
      this.pending.delete(msg.requestId);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(msg.error ?? "session fork failed"));
    });
    this.worker.on("error", (err) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.worker = null;
    });
    return this.worker;
  }

  request(payload: Record<string, unknown>): Promise<unknown> {
    const run = this.queue.then(() => this.dispatch(payload));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private dispatch(payload: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const requestId = `fork-${++this.seq}`;
      this.pending.set(requestId, { resolve, reject });
      try {
        this.ensure().postMessage({ ...payload, op: "fork", requestId });
      } catch (err) {
        this.pending.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Fork a candidate session: branch at the entry, fork into the dir. */
  fork(opts: {
    sourceSessionFile: string;
    entryId: string | null;
    sessionWorkspaceDir: string;
    candidateRoot: string;
    candidateSessionDir: string;
    relocationNote?: string;
    contextText?: string;
  }): Promise<{ ok: boolean; sessionFile: string | null; entryCount: number; leafId: string | null }> {
    return this.request(opts) as Promise<{ ok: boolean; sessionFile: string | null; entryCount: number; leafId: string | null }>;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}

class PiEditorApp {
  private win: BrowserWindow | null = null;
  private terminals = new Map<string, PiTerminalInstance>();
  /** One workspace per source tree (WORLDLINES §6.2). */
  private workspaces = new Map<string, WorkspaceState>();
  /** The cwd of the primary workspace (kept for renderer-facing APIs). */
  private projectCwd: string | null = null;
  private eventsDir = process.env.PI_EDITOR_EVENTS_DIR ?? join(app.getPath("temp"), "pi-ditor-events");
  /** The app-private session branch workspace. */
  private sessionWorkspaceDir = join(this.eventsDir, "session-workspace");
  private tailer = new SidecarTailer(this.eventsDir);
  private paintWatchdog: ReturnType<typeof setInterval> | null = null;
  /** In-flight verify runs: owner terminal id → worker id. */
  private verifyRuns = new Map<string, string>();
  /** Worker terminal ids (kept after the run so tabs can be labeled). */
  private verifyWorkers = new Set<string>();
  /** Dispatch workers: worker terminal id → its task text. */
  private dispatchWorkers = new Map<string, string>();
  /** Dispatch runs: worker terminal id → owner + the dispatched task text. */
  private dispatchRuns = new Map<string, { ownerId: string; taskText: string }>();
  /** Files the user marked as theirs (canonical paths). The agent is told
   *  not to modify them without asking. */
  private mineFiles = new Set<string>();
  /** Files the user changed while no agent terminal was busy. The agent
   *  receives them on its next turn. It adapts instead of overwriting them.
   *  One map per workspace. */
  private userEditsByWorkspace = new Map<string, Map<string, UserEdit>>();
  /** The app-owned snapshot store of the current project, or null. */
  private storePromise: Promise<SnapshotStore | null> | null = null;
  /** The store directory (app-owned, outside the project). */
  private storeDir: string | null = null;
  /** The snapshot worker (captures off the main thread). */
  private snapshotWorker = new SnapshotWorkerClient();
  /** The session worker (session forking off the main thread). */
  private sessionWorker = new SessionWorkerClient();
  /** The worldline manager (Fork Run candidates). */
  private worldlines: WorldlineManager | null = null;
  /** The app-owned worlds root. */
  private worldsRoot = process.env.PI_EDITOR_WORLDS_DIR ?? join(app.getPath("userData"), "worlds");
  /** Tailers for candidate events directories. */
  private worldlineTailers = new Map<string, SidecarTailer>();
  /** One-use start preflights by token. */
  private pendingPreflights = new Map<string, PendingPreflight>();
  /** Run records per terminal (WORLDLINES §6.5). */
  private runsByTerminal = new Map<string, RunRecord[]>();
  private runSeq = 0;
  /** Renderer flush requests awaiting their report. */
  private flushWaiters = new Map<string, { resolve: (r: { ok: boolean; failed: string[] }) => void; timer: ReturnType<typeof setTimeout> }>();
  private flushSeq = 0;
  private userEditsWriteTimer: ReturnType<typeof setTimeout> | null = null;
  /** Promotion operation sequence (op ids). */
  private promoteSeq = 0;
  /** Paths the promotion is applying right now (suppress user-edit records). */
  private promotionPaths: Set<string> | null = null;
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
      title: "Pi/ditor",
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
          { label: "Save All", accelerator: "CmdOrCtrl+Alt+S", click: send("save-all") },
          { type: "separator" },
          { label: "Close Window", accelerator: "CmdOrCtrl+W", role: "close" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          // Undo, Redo, and Select All dispatch to the renderer. The focused
          // surface (Monaco or terminal) runs its own handler. Role items
          // would run the browser undo and select on the hidden input only.
          { label: "Undo", accelerator: "CmdOrCtrl+Z", click: send("edit:undo") },
          { label: "Redo", accelerator: "Shift+CmdOrCtrl+Z", click: send("edit:redo") },
          { type: "separator" },
          // The roles fire the cut, copy, and paste events. Monaco and xterm
          // listen for these events, so the native shortcuts work in both
          // the editor and the terminal.
          { role: "cut", label: "Cut" },
          { role: "copy", label: "Copy" },
          { role: "paste", label: "Paste" },
          { role: "pasteAndMatchStyle", label: "Paste and Match Style" },
          { role: "delete", label: "Delete" },
          { type: "separator" },
          { label: "Select All", accelerator: "CmdOrCtrl+A", click: send("edit:select-all") },
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

  // ---------------------------------------------------------- workspaces ---

  /** The opened project's workspace, or null when no folder is open. */
  private primaryWorkspace(): WorkspaceState | null {
    for (const ws of this.workspaces.values()) if (ws.primary) return ws;
    return null;
  }

  /** The workspace a terminal works in (falls back to the primary). */
  private workspaceOfTerminal(inst: PiTerminalInstance): WorkspaceState | null {
    return this.workspaces.get(inst.workspaceId) ?? this.primaryWorkspace();
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

  /** Create a workspace and start its watcher. The primary workspace sets
   *  the project cwd used by the renderer-facing APIs. */
  private createWorkspace(root: string, primary: boolean): WorkspaceState {
    const ws: WorkspaceState = {
      id: `ws-${++workspaceSeq}`,
      root,
      primary,
      generation: 0,
      writerId: null,
      watcher: null,
      terminalIds: new Set(),
      lastStateCommit: null,
      indexReady: null,
      recordError: null,
    };
    this.workspaces.set(ws.id, ws);
    if (primary) this.projectCwd = root;
    ws.watcher = this.startWatcher(ws);
    if (primary) this.initRecording(ws);
    return ws;
  }

  /**
   * Create the app-owned snapshot store and run the initial index capture
   * (WORLDLINES §6.4). Runs do not record until the index finishes.
   */
  private initRecording(ws: WorkspaceState): void {
    if (this.storePromise) return; // already initializing
    this.storeDir = join(app.getPath("userData"), "worldlines", createHash("sha256").update(ws.root).digest("hex").slice(0, 16));
    const promise = (async (): Promise<SnapshotStore | null> => {
      const top = await gitTopLevel(ws.root);
      if (!top) {
        ws.recordError = "the opened folder is not inside a Git repository";
        return null;
      }
      const gitDir = await gitCommonDir(ws.root);
      const fmt = await gitObjectFormat(ws.root);
      if (!gitDir) {
        ws.recordError = "the opened folder has no Git directory";
        return null;
      }
      // The store pins the canonical root (gitTopLevel resolves symlinks).
      const store = await SnapshotStore.create(this.storeDir!, top, gitDir, fmt);
      const state = await this.snapshotWorker.capture(store, await gitHead(ws.root), null);
      ws.lastStateCommit = state.commit;
      return store;
    })();
    ws.indexReady = promise.then(() => undefined, (err) => {
      ws.recordError = err instanceof Error ? err.message : String(err);
    });
    this.storePromise = promise;
  }

  /**
   * Create the worldline manager. Depends on app paths that exist only
   * after the window is created.
   */
  private initWorldlines(): void {
    if (this.worldlines) return;
    this.worldlines = new WorldlineManager({
      worldsRoot: this.worldsRoot,
      // The canonical primary root: the sandbox compares canonical paths.
      primaryRoot: realpathSync(this.primaryWorkspace()?.root ?? this.projectCwd ?? homedir()),
      realHome: homedir(),
      userData: app.getPath("userData"),
      primaryEventsDir: this.eventsDir,
      bridgePath: this.bridgePath(),
      piBin: this.resolvePiBin(),
      baseEnv: cleanEnv(),
      getStore: async () => {
        const store = await this.storePromise;
        return store;
      },
      // The sandboxed pi loads the pinned package and the node binary.
      appReadPaths: () => {
        const out: string[] = [];
        out.push(dirname(dirname(dirname(dirname(this.resolvePiBin()))))); // app root
        try {
          const nodeBin = execFileSync("which", ["node"], { encoding: "utf8" }).trim();
          if (nodeBin) {
            out.push(nodeBin);
            out.push(dirname(dirname(nodeBin))); // the node version dir (bin + lib)
          }
        } catch {
          /* keep only the app root */
        }
        return out;
      },
      snapshot: {
        template: (opts) => this.snapshotWorker.template(opts),
        applyState: (opts) => this.snapshotWorker.applyState(opts),
      },
      session: {
        fork: (opts) => this.sessionWorker.fork(opts),
      },
      createCandidate: (opts) => this.createCandidate(opts),
      createCandidateWorkspace: (root) => this.createCandidateWorkspace(root),
      onUpdate: (summary) => this.send("worldline:update", summary),
      onRemoved: (comparisonId) => {
        this.removeCandidateWorkspaces(comparisonId);
        this.send("worldline:removed", { comparisonId });
      },
    });
  }

  /** The events dir a terminal's bridge reads (candidates have their own). */
  private eventsDirOf(inst: PiTerminalInstance): string {
    return this.worldlines?.eventsDirOf(inst.id) ?? this.eventsDir;
  }

  /** Create a candidate terminal inside its sandbox. */
  private async createCandidate(opts: {
    root: string;
    workspaceId: string;
    launch: { cmd: string; args: string[]; env: Record<string, string | undefined> };
  }): Promise<{ terminalId: string; pid: number }> {
    const inst = await this.createTerminal(opts.root, { type: "agent", workspaceId: opts.workspaceId, launch: opts.launch });
    // The candidate's bridge writes to its own events dir: tail it.
    const eventsDir = opts.launch.env.PI_EDITOR_EVENTS_DIR;
    if (eventsDir && eventsDir !== this.eventsDir) {
      const tailer = new SidecarTailer(eventsDir);
      tailer.onEvent = (id, event) => this.handleSidecarEvent(id, event);
      tailer.start();
      tailer.watch(inst.id);
      this.worldlineTailers.set(inst.id, tailer);
    }
    return { terminalId: inst.id, pid: inst.pty.pid };
  }

  /** A candidate source tree workspace (no recording, own watcher). */
  private createCandidateWorkspace(root: string): string {
    const ws = this.createWorkspace(root, false);
    return ws.id;
  }

  /** Remove candidate workspaces after a comparison is torn down. */
  private removeCandidateWorkspaces(comparisonId: string): void {
    for (const [id, ws] of [...this.workspaces]) {
      if (ws.primary) continue;
      if (!this.worldlines || !ws.root.startsWith(this.worldsRoot)) continue;
      ws.watcher?.stop();
      this.workspaces.delete(id);
      this.userEditsByWorkspace.delete(id);
    }
    void comparisonId;
  }

  /** Release a workspace write lease. Only the holder can release it. */
  private releaseWriteLease(wsId: string, requesterId: string): void {
    const ws = this.workspaces.get(wsId);
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
      const ws = this.workspaces.get(wsId);
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
    for (const ws of this.workspaces.values()) {
      const rel = relative(this.canonicalPath(ws.root), p);
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return ws;
    }
    return null;
  }

  /**
   * Error text when a write lease blocks user file operations in a
   * workspace. A held lease means a capture or promotion is in progress.
   * The run-start preflight (Phase 2) acquires the lease; the renderer
   * never acquires it directly.
   */
  private assertWorkspaceWritable(wsId: string): string | null {
    const ws = this.workspaces.get(wsId);
    if (ws && ws.writerId !== null) return `the workspace is busy (${ws.writerId} holds the write lease)`;
    return null;
  }

  /** The root directory used by terminals that have no explicit cwd. */
  private terminalCwd(): string {
    return this.primaryWorkspace()?.root ?? homedir();
  }

  // ------------------------------------------------- promotion (WORLDLINES §6.10) ----

  /** The journal of one promotion operation. */
  private journalOf(opId: string): string {
    return join(this.worldsRoot, "promotion-journal", opId);
  }

  private writeJournal(journalDir: string, journal: Record<string, unknown>): void {
    mkdirSync(journalDir, { recursive: true, mode: 0o700 });
    const file = join(journalDir, "journal.json");
    const fd = openSync(file, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(journal, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** The promoted session installs into the primary session directory. */
  private primarySessionDir(cwd: string): string {
    // pi canonicalizes the cwd for its session dir (realpath); the install
    // must land in the same directory the session picker reads.
    const canonical = realpathSync(cwd);
    const safePath = `--${canonical.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    return join(homedir(), ".pi", "agent", "sessions", safePath);
  }

  /**
   * Promote one candidate into the primary project (WORLDLINES §6.10).
   * The merge runs with R (the run start) as the shared base; P and W are
   * captured fresh under the write leases. Every output lands through a
   * durable journal so a crash can roll back or recover.
   */
  private async promoteCandidate(comparisonId: string, label: "A" | "B"): Promise<{ ok: boolean; error?: string; terminalId?: string }> {
    const target = this.worldlines?.promotionTarget(comparisonId, label);
    if (!target) return { ok: false, error: "candidate not found" };
    if (!target.sessionFile) return { ok: false, error: "the candidate has no session" };
    if (!["ready", "running", "settled"].includes(target.state)) {
      return { ok: false, error: `cannot promote from state ${target.state}` };
    }
    const candTerm = target.terminalId ? this.terminals.get(target.terminalId) : undefined;
    if (candTerm?.busy) return { ok: false, error: "the candidate agent is busy" };
    if (target.terminalId && this.verifyRuns.has(target.terminalId)) {
      return { ok: false, error: "the candidate is verifying" };
    }
    const store = await this.storePromise;
    if (!store) return { ok: false, error: "recording is not available" };
    const primary = this.primaryWorkspace();
    if (!primary) return { ok: false, error: "no primary workspace" };
    const run = [...this.runsByTerminal.values()].flat().find((r) => r.id === target.sourceRunId);
    if (!run?.startStateId) return { ok: false, error: "the source run base is missing" };
    const baseState = run.startStateId; // R
    const candWs = candTerm ? this.workspaces.get(candTerm.workspaceId) : undefined;
    const candGen = candWs?.generation ?? 0;

    const opId = `promote-${++this.promoteSeq}`;
    const requester = `promote:${opId}`;
    const journalDir = this.journalOf(opId);
    const journal: Record<string, unknown> = {
      opId,
      comparisonId,
      label,
      stateR: baseState,
      primaryRoot: primary.root,
      phase: "prepared",
      createdAt: Date.now(),
      paths: [],
      stagedSession: null,
      installedSession: null,
    };

    // The write leases serialize the promotion against every other writer.
    const leaseP = await this.acquireWriteLease(primary.id, requester, 12000);
    if (!leaseP.ok) return { ok: false, error: leaseP.error ?? "the primary workspace is busy" };
    let candLease = true;
    if (candWs) {
      const l = await this.acquireWriteLease(candWs.id, requester, 8000);
      candLease = l.ok;
    }
    if (!candLease) {
      this.releaseWriteLease(primary.id, requester);
      return { ok: false, error: "the candidate workspace is busy" };
    }
    const releaseLeases = (): void => {
      this.releaseWriteLease(primary.id, requester);
      if (candWs) this.releaseWriteLease(candWs.id, requester);
    };
    // A rejected promotion releases the leases and returns the pair to its
    // previous lifecycle state.
    const fail = async (message: string): Promise<{ ok: false; error: string }> => {
      releaseLeases();
      await this.worldlines?.finishPromotion(comparisonId, false, message);
      return { ok: false, error: message };
    };

    try {
      // Flush the dirty editor models (both leases cover every save path).
      const flush = await this.flushDirtyModels(requester, 8000);
      if (!flush.ok) return fail("could not save editor changes");

      this.worldlines?.markPromoting(comparisonId, label);

      // Capture W (candidate head, chained from R) and P (current primary).
      const candGitDir = await gitCommonDir(target.root);
      const [wState, pState] = await Promise.all([
        this.snapshotWorker.capture(store, await gitHead(target.root), baseState, { root: target.root, gitDir: candGitDir ?? target.root }),
        this.snapshotWorker.capture(store, await gitHead(primary.root), primary.lastStateCommit ?? null),
      ]);
      primary.lastStateCommit = pState.commit;
      // Expected versions: nothing moved during the captures.
      if (primary.generation !== leaseP.generation) return fail("the primary changed during promotion preflight");
      if (candWs && candWs.generation !== candGen) return fail("the candidate changed during promotion preflight");
      const top = await gitTopLevel(primary.root);
      if (!top || resolve(top) !== resolve(store.sourceRoot)) return fail("the source repository identity changed");

      // Mine enforcement: a changed path that is Mine (or a symlink that
      // aliases a Mine path) rejects the promotion.
      const changed = await store.diffTree(baseState, wState.commit);
      for (const c of changed) {
        const abs = join(primary.root, c.relPath);
        if (this.mineFiles.has(this.canonicalPath(abs))) {
          return fail(`the candidate changes a file you own: ${c.relPath}`);
        }
        const link = await store.symlinkTarget(wState.commit, c.relPath);
        if (link) {
          const resolved = realpathSync(join(dirname(abs), link));
          if (this.mineFiles.has(resolved)) {
            return fail(`the candidate aliases a file you own through a symlink: ${c.relPath}`);
          }
        }
      }

      // The three-way merge with R as the shared base (WORLDLINES §6.10).
      const merge = await store.merge3(wState.commit, pState.commit);
      if (!merge.ok || !merge.tree) {
        const reason = merge.reason ?? `the merge conflicts on: ${merge.conflicts.join(", ")}`;
        return fail(reason);
      }

      // Stage: merged bytes, before-bytes, and the promoted session.
      const mergedDir = join(journalDir, "merged");
      await store.materialize(merge.tree, mergedDir);
      const pPaths = await store.treePaths(pState.commit);
      const mergedPaths = await store.treePaths(merge.tree);
      const beforeDir = join(journalDir, "before");
      const paths: Array<{ rel: string; kind: "write" | "delete"; beforeHash: string; afterHash: string; beforeExists: boolean }> = [];
      const sha = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");
      for (const rel of [...mergedPaths].sort()) {
        const abs = join(primary.root, rel);
        const beforeExists = existsSync(abs);
        const before = beforeExists ? await readFile(abs) : Buffer.alloc(0);
        const after = await readFile(join(mergedDir, rel));
        paths.push({ rel, kind: "write", beforeHash: sha(before), afterHash: sha(after), beforeExists });
        if (beforeExists) {
          const target = join(beforeDir, rel);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, before);
        }
      }
      for (const rel of [...pPaths].filter((p) => !mergedPaths.has(p)).sort()) {
        const abs = join(primary.root, rel);
        const beforeExists = existsSync(abs);
        const before = beforeExists ? await readFile(abs) : Buffer.alloc(0);
        paths.push({ rel, kind: "delete", beforeHash: sha(before), afterHash: sha(Buffer.alloc(0)), beforeExists });
        if (beforeExists) {
          const target = join(beforeDir, rel);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, before);
        }
      }
      if (paths.length > 2000) throw new Error("the promotion touches too many paths");
      journal.paths = paths;

      // Fork the candidate leaf into a primary-cwd session (staged).
      const sessionDir = join(journalDir, "session");
      const fork = await this.sessionWorker.fork({
        sourceSessionFile: target.sessionFile,
        entryId: null,
        sessionWorkspaceDir: sessionDir,
        candidateRoot: primary.root,
        candidateSessionDir: sessionDir,
        relocationNote: `The candidate project lived at ${target.root}. In this promoted session, that path maps to ${primary.root}.`,
      });
      if (!fork.sessionFile) throw new Error("the promoted session fork produced no file");
      journal.stagedSession = fork.sessionFile;
      this.writeJournal(journalDir, journal);

      // Recheck expected P: every target path still matches the preflight.
      for (const p of paths) {
        const abs = join(primary.root, p.rel);
        const now = existsSync(abs) ? await readFile(abs) : Buffer.alloc(0);
        if (sha(now) !== p.beforeHash) return fail(`the primary changed at ${p.rel} during promotion`);
      }
      if (primary.generation !== leaseP.generation) return fail("the primary changed during promotion apply");

      // Apply: atomic per-path renames; the watcher events land after.
      this.promotionPaths = new Set(paths.map((p) => p.rel));
      try {
        for (const p of paths) {
          const abs = join(primary.root, p.rel);
          if (p.kind === "delete") {
            await rm(abs, { force: true });
          } else {
            await mkdir(dirname(abs), { recursive: true });
            await fsRename(join(mergedDir, p.rel), abs);
          }
        }
      } finally {
        this.promotionPaths = null;
      }
      journal.phase = "applied";
      this.writeJournal(journalDir, journal);

      // Install the session atomically in the primary session directory.
      const installDir = this.primarySessionDir(primary.root);
      await mkdir(installDir, { recursive: true });
      const sessionName = `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID()}.jsonl`;
      const installed = join(installDir, sessionName);
      const tmp = join(installDir, `.${sessionName}.tmp`);
      await writeFile(tmp, await readFile(fork.sessionFile));
      await fsRename(tmp, installed);
      journal.installedSession = installed;
      journal.phase = "done";
      this.writeJournal(journalDir, journal);

      // Open the promoted primary terminal on the installed session.
      const inst = await this.createTerminal(primary.root, {
        type: "agent",
        workspaceId: primary.id,
        launch: {
          cmd: this.resolvePiBin(),
          args: ["-e", this.bridgePath(), "--session", installed],
          env: { ...cleanEnv(), PI_EDITOR_EVENTS_DIR: this.eventsDir },
        },
      });
      // Seed Change Review: the promotion is the run's own change set.
      for (const p of paths) {
        const abs = this.canonicalPath(join(primary.root, p.rel));
        const before = p.beforeExists ? await readFile(join(beforeDir, p.rel)) : null;
        inst.baselines.set(abs, before === null ? null : before.toString("utf8"));
        if (p.kind === "delete") this.recordDeleted(inst, abs);
        else this.recordModified(inst, abs, p.beforeExists ? "modified" : "created");
      }
      this.send("modified:list", { instanceId: inst.id, files: [...inst.modified.values()] });

      // Mark the older primary terminals out of date with a context file.
      const changedList = paths.map((p) => `- \`${p.rel}\``).join("\n");
      for (const other of this.terminals.values()) {
        if (other.id === inst.id || other.workspaceId !== primary.id || other.type !== "agent") continue;
        try {
          mkdirSync(this.eventsDirOf(other), { recursive: true, mode: 0o700 });
          writeFileSync(
            join(this.eventsDirOf(other), `edits-${other.id}.md`),
            `## Source changed by promotion (${comparisonId}, candidate ${label})\n\n${changedList}\n`,
            "utf8",
          );
        } catch {
          /* the context is best-effort */
        }
      }

      // The comparison is consumed: tear it down and release everything.
      await this.worldlines?.finishPromotion(comparisonId, true, null);
      releaseLeases();
      // The promotion is complete: the journal has no recovery duty.
      await rm(journalDir, { recursive: true, force: true });
      this.sendInstances();
      this.send("promotion:opened", { terminalId: inst.id });
      return { ok: true, terminalId: inst.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.rollbackPromotion(journalDir, journal, primary.root);
      // A session installed before the failure is an orphan: remove it.
      if (journal.installedSession) await rm(String(journal.installedSession), { force: true });
      releaseLeases();
      await this.worldlines?.finishPromotion(comparisonId, false, message);
      return { ok: false, error: message };
    }
  }

  /** Roll back every applied path of a failed promotion. */
  private async rollbackPromotion(journalDir: string, journal: Record<string, unknown>, primaryRoot: string): Promise<void> {
    const phase = String(journal.phase ?? "prepared");
    // "done" means the promotion completed: the journal has no duty.
    if (phase !== "applied") {
      await rm(journalDir, { recursive: true, force: true });
      return;
    }
    const sha = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");
    let conflicted = false;
    for (const p of (journal.paths ?? []) as Array<{ rel: string; beforeHash: string; afterHash: string; beforeExists: boolean }>) {
      const abs = join(primaryRoot, p.rel);
      const now = existsSync(abs) ? await readFile(abs) : Buffer.alloc(0);
      if (sha(now) !== p.afterHash) {
        // The app did not write this path (or someone wrote after us).
        if (sha(now) !== p.beforeHash) conflicted = true;
        continue;
      }
      const before = join(journalDir, "before", p.rel);
      if (p.beforeExists && existsSync(before)) {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, await readFile(before));
      } else {
        await rm(abs, { force: true });
      }
    }
    journal.phase = conflicted ? "conflict" : "rolled-back";
    this.writeJournal(journalDir, journal);
    if (!conflicted) await rm(journalDir, { recursive: true, force: true });
  }

  /**
   * Startup recovery: finish or roll back every pending promotion journal
   * before the primary watcher starts (WORLDLINES §6.10 step 10-11).
   * Restore a path only when its bytes still equal the app-written value.
   */
  private async recoverPromotions(): Promise<void> {
    const root = join(this.worldsRoot, "promotion-journal");
    let names: string[] = [];
    try {
      names = await readdir(root);
    } catch {
      return; // no journal dir yet
    }
    const sha = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");
    for (const name of names) {
      const dir = join(root, name);
      let journal: Record<string, unknown> | null = null;
      try {
        journal = JSON.parse(await readFile(join(dir, "journal.json"), "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      const phase = String(journal.phase ?? "prepared");
      const primaryRoot = String(journal.primaryRoot ?? "");
      const paths = (journal.paths ?? []) as Array<{ rel: string; beforeHash: string; afterHash: string; beforeExists: boolean }>;
      // "done" means the promotion completed: keep the source as it is.
      if (phase === "done") {
        await rm(dir, { recursive: true, force: true });
        continue;
      }
      if (phase !== "applied") {
        // Nothing reached the primary: drop the staged resources.
        await rm(dir, { recursive: true, force: true });
        continue;
      }
      // Restore every path the app wrote. An external change keeps all
      // versions and stops automatic recovery (a recovery conflict).
      for (const p of paths) {
        const abs = join(primaryRoot, p.rel);
        const now = existsSync(abs) ? await readFile(abs) : Buffer.alloc(0);
        if (sha(now) !== p.afterHash) continue;
        const before = join(dir, "before", p.rel);
        if (p.beforeExists && existsSync(before)) {
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, await readFile(before));
        } else {
          await rm(abs, { force: true });
        }
      }
      let conflicted = false;
      for (const p of paths) {
        const abs = join(primaryRoot, p.rel);
        const now = existsSync(abs) ? await readFile(abs) : Buffer.alloc(0);
        const h = sha(now);
        if (h !== p.beforeHash && h !== p.afterHash) {
          conflicted = true;
          break;
        }
      }
      if (!conflicted) {
        await rm(dir, { recursive: true, force: true });
      } else {
        await writeFile(join(dir, "conflict.json"), JSON.stringify({ at: Date.now(), paths: paths.map((p) => p.rel) }));
        console.warn(`[main] promotion recovery conflict: ${dir} — kept every version`);
      }
    }
  }


  private resolvePiBin(): string {
    if (process.env.PI_EDITOR_PI_BIN) return process.env.PI_EDITOR_PI_BIN;
    // Launch the pi binary shipped with the pinned package (WORLDLINES
    // §6.7). The package entry resolves to dist/index.js; the CLI sits
    // next to it. The exports map has only an import condition, so use
    // import.meta.resolve, not require.resolve.
    try {
      const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
      return join(dirname(entry), "cli.js");
    } catch (err) {
      console.warn(`[main] pinned pi package not found: ${(err as Error).message}`);
      return "pi";
    }
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

  private async createTerminal(
    cwd?: string,
    opts?: { type?: "agent" | "shell"; shell?: string; workspaceId?: string; launch?: { cmd: string; args: string[]; env: Record<string, string | undefined> } },
  ): Promise<PiTerminalInstance> {
    const type = opts?.type ?? "agent";
    if (type === "agent" && !(await this.checkPiAvailable())) {
      throw new Error(this.piMissingMessage());
    }
    const id = `term-${++terminalSeq}`;
    const workspaceId = opts?.workspaceId ?? this.primaryWorkspace()?.id ?? "";
    let cmd: string;
    let args: string[];
    let shellName: string | undefined;
    let env: Record<string, string | undefined>;
    if (opts?.launch) {
      // A worldline candidate: the sandbox wraps the pinned pi binary.
      cmd = opts.launch.cmd;
      args = opts.launch.args;
      env = { ...opts.launch.env, PI_EDITOR_TERMINAL_ID: id };
    } else if (type === "shell") {
      const shells = detectShells();
      const chosen = opts?.shell && existsSync(opts.shell) ? { path: opts.shell, name: basename(opts.shell) } : shells[0] ?? { path: "/bin/zsh", name: "zsh" };
      cmd = chosen.path;
      args = [];
      shellName = chosen.name;
      env = { ...process.env };
    } else {
      cmd = this.resolvePiBin();
      // The app-owned bridge loads through the CLI option, not project
      // trust (WORLDLINES §6.3).
      args = ["-e", this.bridgePath()];
      env = { ...cleanEnv(), PI_EDITOR_TERMINAL_ID: id, PI_EDITOR_EVENTS_DIR: this.eventsDir };
    }
    const inst = new PiTerminalInstance(id, cwd ?? this.terminalCwd(), workspaceId, type, shellName, cmd, args, env, 80, 24);
    this.terminals.set(inst.id, inst);
    this.workspaces.get(workspaceId)?.terminalIds.add(id);

    inst.pty.onData = (data) => this.send("pty:data", { id: inst.id, data });
    inst.pty.onExit = (code) => {
      console.log(`[main] terminal ${inst.id} (${inst.type}) exited code=${code}`);
      this.send("pty:exit", { id: inst.id, code });
      this.closeRunOnExit(inst);
      this.terminals.delete(inst.id);
      this.workspaces.get(inst.workspaceId)?.terminalIds.delete(inst.id);
      this.worldlines?.terminalExited(inst.id);
      this.worldlineTailers.get(inst.id)?.stop();
      this.worldlineTailers.delete(inst.id);
      this.tailer.stopWatching(inst.id);
      // A dispatch worker closed before settling: its task goes back to
      // pending so the board stays honest.
      const dispatchExit = this.dispatchRuns.get(inst.id);
      if (dispatchExit) {
        this.dispatchRuns.delete(inst.id);
        this.dispatchWorkers.delete(inst.id);
        const ownerInst = this.terminals.get(dispatchExit.ownerId);
        const task = ownerInst ? this.findDispatchedTask(ownerInst, dispatchExit.taskText) : undefined;
        if (ownerInst && task) {
          task.state = "pending";
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
    // A worldline candidate verifies inside its own isolated tree under its
    // sandbox profile: the tests cannot write the primary project.
    const candidate = this.worldlines?.candidateSandboxOf(ownerId) ?? null;
    const cwd = candidate?.root ?? this.terminalCwd();
    const tc = this.detectTestCommand(cwd);
    if (!tc) return { ok: false, error: "no test command detected (looked for package.json scripts, pytest, cargo, go)" };

    // Spawn a worker shell terminal that runs the tests, visible in the UI.
    // The env is sanitized: the host session variables must not reach the
    // tests (they could spawn the pi CLI and crash it, like the agent TUI).
    const shells = detectShells();
    const shell = shells[0] ?? { path: "/bin/zsh", name: "zsh" };
    const id = `term-${++terminalSeq}`;
    let inst: PiTerminalInstance;
    const cmdline = `${tc.command} ${tc.args.join(" ")}`;
    try {
      if (candidate) {
        inst = new PiTerminalInstance(
          id,
          candidate.root,
          owner.workspaceId, // the worker inherits the owner's workspace
          "shell",
          shell.name,
          "sandbox-exec",
          ["-f", candidate.profilePath, shell.path, "-c", cmdline],
          { ...cleanEnv(), HOME: candidate.homeDir, TMPDIR: candidate.tmpDir, PI_EDITOR_EVENTS_DIR: candidate.eventsDir },
          80,
          24,
        );
      } else {
        inst = new PiTerminalInstance(
          id,
          this.terminalCwd(),
          owner.workspaceId, // the worker inherits the owner's workspace
          "shell",
          shell.name,
          shell.path,
          ["-c", cmdline],
          { ...cleanEnv() },
          80,
          24,
        );
      }
    } catch (err) {
      return { ok: false, error: `could not start the test worker: ${(err as Error).message}` };
    }
    this.terminals.set(inst.id, inst);
    this.workspaces.get(owner.workspaceId)?.terminalIds.add(id);
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
      this.workspaces.get(inst.workspaceId)?.terminalIds.delete(inst.id);
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
    const owner = this.terminals.get(ownerId);
    const eventsDir = owner ? this.eventsDirOf(owner) : this.eventsDir;
    try {
      mkdirSync(eventsDir, { recursive: true, mode: 0o700 });
      const stamp = new Date().toLocaleTimeString();
      const status = state === "pass" ? "✅ PASSED" : state === "timeout" ? "⏰ TIMED OUT" : "❌ FAILED";
      const body = output.trim().slice(-6000);
      const md =
        `## Test run — \`${label}\` — ${stamp}\n\n` +
        `**Status:** ${status}${code !== null ? ` (exit code ${code})` : ""}\n\n` +
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
        // Strip punctuation AND markdown emphasis (bold/italic markers often
        // wrap the path: **`utils.ts`**). A LEADING underscore is a filename
        // (for example _test.py), not italic markup — unless the token also ends
        // with one (markdown italic pairs _text_).
        const isItalicPair = /_$/.test(token);
        let clean = token.replace(/[`.,;:!?)"'*_]+$/g, "").replace(/^[`("'*]+/g, "");
        if (isItalicPair) clean = clean.replace(/^_+/, "");
        clean = clean.replace(/\/+$/, "");
        // Normalize absolute paths to project-relative (canonical: /tmp and
        // /private/tmp are the same directory) so progress matching hits.
        if (isAbsolute(clean) && this.projectCwd) {
          const rel = relative(this.canonicalPath(this.projectCwd), this.canonicalPath(clean));
          if (rel && !rel.startsWith("..")) clean = rel;
        }
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

  // ------------------------------------------------------------- dispatch --

  /**
   * Dispatch the plan tasks of a terminal to parallel agent workers. Each
   * task must mention files; tasks whose files overlap another task stay
   * behind (they would fight over the same files). At most 3 workers run at
   * once. The owner's partial run is interrupted first.
   */
  /** Normalize a task path to a comparable key (canonical absolute path). */
  private taskPathKey(p: string): string {
    return this.canonicalPath(join(this.terminalCwd(), p));
  }

  /** The owner's task that matches a dispatched text. The plan can be
   *  replaced mid-dispatch (an auto-retry posts a new plan), so tasks are
   *  matched by text, never by position. */
  private findDispatchedTask(owner: PiTerminalInstance, taskText: string): PlanTask | undefined {
    return owner.plan.find((t) => t.text === taskText);
  }

  private async dispatchRun(ownerId: string): Promise<{ ok: boolean; error?: string; dispatched?: number }> {
    const owner = this.terminals.get(ownerId);
    if (!owner || owner.type !== "agent") return { ok: false, error: "terminal not found" };
    if (owner.plan.length === 0) return { ok: false, error: "the plan board is empty — ask the agent for a plan first" };
    if (this.dispatchRuns.size > 0) return { ok: false, error: "a dispatch is already running" };
    if (owner.busy) owner.pty.write("\x03"); // the workers replace the owner's run
    // Pick tasks with paths, no overlapping files, at most 3. The overlap
    // check compares canonical paths: "utils.ts" and "./utils.ts" are the
    // same file, "src/utils.ts" is a different one.
    const chosen: PlanTask[] = [];
    const used = new Set<string>();
    for (const task of owner.plan) {
      if (chosen.length >= 3) break;
      if (task.paths.length === 0) continue;
      const keys = task.paths.map((p) => this.taskPathKey(p));
      if (keys.some((k) => used.has(k))) continue;
      keys.forEach((k) => used.add(k));
      chosen.push(task);
    }
    if (chosen.length === 0) return { ok: false, error: "no task mentions a file to scope it" };
    let dispatched = 0;
    for (const task of chosen) {
      try {
        const worker = await this.createTerminal(undefined, { type: "agent", workspaceId: owner.workspaceId });
        this.dispatchWorkers.set(worker.id, task.text);
        this.dispatchRuns.set(worker.id, { ownerId, taskText: task.text });
        // The pi TUI needs a moment to boot before it accepts the prompt.
        setTimeout(() => {
          if (this.terminals.has(worker.id)) worker.pty.write(task.text + "\r");
        }, 1500);
        dispatched++;
      } catch (err) {
        console.warn(`[main] dispatch worker failed: ${(err as Error).message}`);
      }
    }
    return { ok: true, dispatched };
  }

  /** Copy a finished worker's files and baselines into the owner's review. */
  private collectWorker(worker: PiTerminalInstance, owner: PiTerminalInstance): void {
    let changed = false;
    for (const [p, f] of worker.modified) {
      if (!owner.modified.has(p)) {
        owner.modified.set(p, f);
        changed = true;
      }
    }
    for (const [p, b] of worker.baselines) {
      if (!owner.baselines.has(p)) owner.baselines.set(p, b);
    }
    if (changed) this.send("modified:list", { instanceId: owner.id, files: [...owner.modified.values()] });
  }

  // ----------------------------------------------------------------- mine ----

  /** Mark a file as the user's own (or clear the mark). */
  private setMineFile(path: string, mine: boolean): void {
    const p = this.canonicalPath(path);
    if (mine) this.mineFiles.add(p);
    else this.mineFiles.delete(p);
    this.saveMineFiles();
    this.writeMineContext();
  }

  /** Write the mine context file for every agent terminal. */
  private writeMineContext(): void {
    try {
      mkdirSync(this.eventsDir, { recursive: true });
    } catch {
      return;
    }
    const md = this.buildMineMarkdown();
    for (const inst of this.terminals.values()) {
      if (inst.type !== "agent") continue;
      const eventsDir = this.eventsDirOf(inst);
      try {
        writeFileSync(join(eventsDir, `mine-${inst.id}.md`), md, "utf8");
      } catch (err) {
        console.warn(`[main] could not write mine context: ${(err as Error).message}`);
      }
    }
  }

  /** Build the mine context markdown: one file per line. */
  private buildMineMarkdown(): string {
    const out: string[] = ["## Your files", "", "These files belong to the user. Do not modify them without asking first.", ""];
    for (const p of this.mineFiles) out.push(`- \`${this.rel(p)}\``);
    return out.join("\n");
  }

  /** Clear the marks and their context files (folder switch). The saved
   *  marks stay in their file: revisiting the project restores them. */
  private clearMineFiles(): void {
    this.mineFiles.clear();
    for (const inst of this.terminals.values()) {
      if (inst.type !== "agent") continue;
      try {
        rmSync(join(this.eventsDir, `mine-${inst.id}.md`), { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  /** The persisted marks file for the current project. */
  private mineFilePath(): string {
    const cwd = this.canonicalPath(this.projectCwd ?? "");
    return join(this.eventsDir, `mine-${this.sanitizeSessionDir(cwd)}.json`);
  }

  /** Load the marks saved for the current project (restart persistence). */
  private loadMineFiles(): void {
    if (!this.projectCwd) return;
    try {
      const raw = readFileSync(this.mineFilePath(), "utf8");
      const list = JSON.parse(raw) as string[];
      if (Array.isArray(list)) {
        for (const p of list) {
          if (typeof p === "string") this.mineFiles.add(p);
        }
      }
    } catch {
      /* no marks saved yet */
    }
  }

  /** Save the marks so a restart restores the ownership. */
  private saveMineFiles(): void {
    if (!this.projectCwd) return;
    try {
      mkdirSync(this.eventsDir, { recursive: true });
      writeFileSync(this.mineFilePath(), JSON.stringify([...this.mineFiles]), "utf8");
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
      if (existing.prev === undefined && capped.prev !== undefined) existing.prev = capped.prev;
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
        rmSync(join(this.eventsDir, `edits-${id}.md`), { force: true });
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
      workspaceId: t.workspaceId,
      verifyWorker: this.verifyWorkers.has(t.id),
      dispatchWorker: this.dispatchWorkers.has(t.id),
      dispatchTask: this.dispatchWorkers.get(t.id),
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
      // ---- run-boundary events (WORLDLINES §6.3) ----
      case "preflight_request":
        this.handlePreflightRequest(inst, String(event.requestId ?? ""));
        break;
      case "prompt": {
        const file = String(event.file ?? "");
        // The payload file must be a plain name inside the events dir.
        if (!file || file.includes("/") || file.includes("\\")) break;
        try {
          // Read synchronously: agent_start couples the run right after the
          // prompt event, and the payload must be attached in order.
          const raw = readFileSync(join(this.eventsDir, file), "utf8");
          const payload = JSON.parse(raw) as { prompt?: unknown; images?: unknown };
          inst.pendingPrompt = {
            file,
            text: String(payload.prompt ?? "").slice(0, 64000),
            images: Array.isArray(payload.images) ? payload.images.length : 0,
          };
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
        this.handleCheckpointRequest(inst, String(event.requestId ?? ""), String(event.kind ?? "settled"), String(event.entryId ?? ""));
        break;
      case "checkpoint_result":
        // Informational; the run record carries the result already.
        break;
      case "session_ready": {
        // The bridge consumed the candidate startup control.
        const readyOk = event.ok === true;
        this.worldlines?.onSessionReady(terminalId, readyOk, String(event.error ?? null) || null);
        break;
      }
      case "agent_start":
        inst.busy = true;
        // The run consumes the user-edits context (the extension already read
        // it in before_agent_start). Clear it so the next run stays fresh.
        const startWs = this.workspaceOfTerminal(inst);
        if (startWs) this.clearUserEdits(startWs);
        // The old run's plan is stale until the new plan message arrives.
        inst.plan = [];
        inst.touched = new Set();
        this.sendPlan(inst);
        // Baseline for Change Review: snapshot the watcher's content cache so
        // diffs compare the run's start state against the current files.
        inst.baselines = new Map(startWs?.watcher?.lastContents ?? []);
        inst.runSnapshots = new Map();
        inst.lastToolPath = null;
        this.pushTimeline(inst, { t: "agent_start" });
        // Couple the run to its start preflight when the token matches.
        this.coupleRunStart(inst, event);
        // A dispatch worker started: mark its task active on the owner board.
        const dispatchStart = this.dispatchRuns.get(inst.id);
        if (dispatchStart) {
          const ownerInst = this.terminals.get(dispatchStart.ownerId);
          const task = ownerInst ? this.findDispatchedTask(ownerInst, dispatchStart.taskText) : undefined;
          if (ownerInst && task) {
            task.state = "active";
            this.sendPlan(ownerInst);
          }
        }
        this.send("busy", { instanceId: inst.id, busy: true });
        this.sendInstances();
        break;
      case "agent_settled":
        inst.busy = false;
        this.finalizePlan(inst);
        // A dispatch worker finished: mark its task done and collect its
        // files into the owner's Change Review.
        const dispatchEnd = this.dispatchRuns.get(inst.id);
        if (dispatchEnd) {
          const ownerInst = this.terminals.get(dispatchEnd.ownerId);
          const task = ownerInst ? this.findDispatchedTask(ownerInst, dispatchEnd.taskText) : undefined;
          if (ownerInst) {
            if (task) task.state = "done";
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
              inst.baselines.set(path, this.reconstructBaseline(path, event.edits) ?? this.workspaceOfTerminal(inst)?.watcher?.lastContents.get(path) ?? null);
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
  // ---------------------------------------------------- run boundaries ----

  /** Write an acknowledgement file for the bridge to consume exactly once. */
  private writeAck(terminalId: string, requestId: string, payload: Record<string, unknown>): void {
    try {
      mkdirSync(this.eventsDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(this.eventsDir, `ack-${terminalId}-${requestId}.json`), JSON.stringify(payload), { mode: 0o600 });
    } catch (err) {
      console.warn(`[main] could not write ack: ${(err as Error).message}`);
    }
  }

  /** Ask the renderer to save every dirty model. Bounded wait. */
  private flushDirtyModels(writerId: string, timeoutMs = 5000): Promise<{ ok: boolean; failed: string[] }> {
    return new Promise((resolve) => {
      const requestId = `flush-${++this.flushSeq}`;
      this.flushWaiters.set(requestId, {
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
    const flush = await this.flushDirtyModels(leaseRequester);
    if (!flush.ok) {
      this.releaseWriteLease(ws.id, leaseRequester);
      this.writeAck(inst.id, requestId, { ok: false, error: "could not save editor changes" });
      return;
    }
    const store = await this.storePromise;
    await ws.indexReady;
    if (!store) {
      // Recording unavailable (no Git): the run proceeds without a token.
      this.releaseWriteLease(ws.id, leaseRequester);
      this.writeAck(inst.id, requestId, { ok: true, token: null });
      return;
    }
    try {
      const state = await this.snapshotWorker.capture(store, await gitHead(ws.root), ws.lastStateCommit ?? null);
      ws.lastStateCommit = state.commit;
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
    this.pendingPreflights.delete(token);
    this.releaseWriteLease(pending.workspaceId, pending.leaseRequester);
  }

  /**
   * agent_start: consume the preflight token and open the run record.
   * A token-less agent_start is a retry or compaction of the open run.
   */
  private coupleRunStart(inst: PiTerminalInstance, event: SidecarEvent): void {
    const token = String(event.preflightToken ?? "");
    const pending = token ? this.pendingPreflights.get(token) : undefined;
    const ws = this.workspaceOfTerminal(inst);
    if (pending && pending.terminalId === inst.id) {
      this.pendingPreflights.delete(token);
      clearTimeout(pending.timer);
      this.releaseWriteLease(pending.workspaceId, pending.leaseRequester);
      const run: RunRecord = {
        id: `run-${++this.runSeq}`,
        terminalId: inst.id,
        workspaceId: inst.workspaceId,
        startStateId: pending.startState?.commit ?? null,
        settledStateId: null,
        promptPayloadFile: inst.pendingPrompt?.file ?? null,
        promptText: inst.pendingPrompt?.text ?? null,
        promptEntryId: String(event.entryId ?? null) || null,
        promptParentEntryId: String(event.parentEntryId ?? null) || null,
        settledEntryId: null,
        sessionFile: String(event.sessionFile ?? null) || null,
        sessionBranchFile: null,
        trusted: typeof event.trusted === "boolean" ? event.trusted : null,
        model: String(event.model ?? null) || null,
        thinkingLevel: String(event.thinkingLevel ?? null) || null,
        replayable: true,
        reason: null,
        interrupted: false,
        steering: false,
        overlap: this.verifyRuns.size > 0 || this.dispatchRuns.size > 0,
        unownedEdits: 0,
        startedAt: Date.now(),
        settledAt: null,
      };
      // The source must not have changed between preflight and start.
      if (ws && ws.generation !== pending.generation) {
        run.replayable = false;
        run.reason = "the source changed while the run started";
      }
      if (!run.sessionFile) {
        run.replayable = false;
        run.reason = "the Pi session is not persisted";
      }
      this.pushRun(inst, run);
    } else if (inst.currentRun && !inst.currentRun.settledAt) {
      // A retry or compaction of the open run. Keep its start state.
    } else {
      // No preflight (for example a queued follow-up): the run still runs
      // but cannot be forked.
      const run: RunRecord = {
        id: `run-${++this.runSeq}`,
        terminalId: inst.id,
        workspaceId: inst.workspaceId,
        startStateId: null,
        settledStateId: null,
        promptPayloadFile: inst.pendingPrompt?.file ?? null,
        promptText: inst.pendingPrompt?.text ?? null,
        promptEntryId: String(event.entryId ?? null) || null,
        promptParentEntryId: String(event.parentEntryId ?? null) || null,
        settledEntryId: null,
        sessionFile: String(event.sessionFile ?? null) || null,
        sessionBranchFile: null,
        trusted: typeof event.trusted === "boolean" ? event.trusted : null,
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
      };
      this.pushRun(inst, run);
    }
  }

  /** Store a run record, keep the per-terminal cap. */
  private pushRun(inst: PiTerminalInstance, run: RunRecord): void {
    inst.currentRun = run;
    let list = this.runsByTerminal.get(inst.id);
    if (!list) {
      list = [];
      this.runsByTerminal.set(inst.id, list);
    }
    list.push(run);
    if (list.length > 20) {
      const evicted = list.shift();
      if (evicted?.promptPayloadFile) {
        try {
          rmSync(join(this.eventsDir, evicted.promptPayloadFile), { force: true });
        } catch {
          /* ignore */
        }
      }
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
    const store = await this.storePromise;
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
      ws.lastStateCommit = state.commit;
      this.writeAck(inst.id, requestId, { ok: true, stateId: state.commit });
      if (kind === "settled" && inst.currentRun && !inst.currentRun.settledAt) {
        this.finalizeRun(inst, state, entryId);
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
      const state = await this.snapshotWorker.capture(store, await gitHead(ws.root), ws.lastStateCommit ?? null);
      if (ws.generation === gen) return state;
    }
    throw new Error("the source changed during capture");
  }

  /** Attach the settled state, copy the session branch, mark eligibility. */
  private finalizeRun(inst: PiTerminalInstance, state: SourceState, entryId: string): void {
    const run = inst.currentRun;
    if (!run) return;
    run.settledStateId = state.commit;
    run.settledEntryId = entryId || null;
    run.settledAt = Date.now();
    run.interrupted = inst.interruptedAt !== undefined && inst.interruptedAt > run.startedAt;
    if (run.overlap || this.verifyRuns.size > 0 || this.dispatchRuns.size > 0) {
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
        copyFileSync(run.sessionFile, target, constants.COPYFILE_EXCL);
        run.sessionBranchFile = target;
      } catch (err) {
        run.replayable = false;
        run.reason = `could not copy the session branch: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    inst.currentRun = null;
    // The run record is complete now: the renderer refreshes its Fork Run
    // button from this push (the settle timeline event arrives earlier).
    this.send("worldline:runs-changed", { terminalId: inst.id });
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
    const cached = this.workspaceOfTerminal(inst)?.watcher?.lastContents.get(path);
    if (cached !== undefined) {
      inst.runSnapshots.set(path, cached);
      return cached.length > MAX_SNAPSHOT_SIZE ? { status } : { content: cached, status };
    }
    // The write may not have landed in the watcher cache yet — retry shortly,
    // addressing the event by reference (the tail may have moved on). Content
    // stays main-side; the renderer fetches it on click.
    setTimeout(() => {
      const fresh = this.workspaceOfTerminal(inst)?.watcher?.lastContents.get(path);
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
    // A folder switch tears down the previous primary workspace and its
    // per-workspace state (watcher, user edits, write lease, run records,
    // snapshot store).
    const old = this.primaryWorkspace();
    if (old) {
      old.watcher?.stop();
      this.workspaces.delete(old.id);
      this.userEditsByWorkspace.delete(old.id);
    }
    this.teardownRecording();
    this.runsByTerminal.clear();
    this.projectCwd = cwd;
    this.ensureAppBridge();
    this.removeLegacyProjectBridge(cwd);
    this.createWorkspace(cwd, true);
    // A folder switch starts a fresh context. Kill every terminal: the old
    // pty processes still run in the previous directory, so they cannot
    // follow the new folder. One agent terminal starts in the new folder.
    for (const id of [...this.terminals.keys()]) this.closeTerminal(id);
    await this.drainTerminals();
    this.verifyRuns.clear();
    this.verifyWorkers.clear();
    this.dispatchWorkers.clear();
    this.dispatchRuns.clear();
    this.clearMineFiles();
    this.loadMineFiles();
    this.send("folder:opened", { cwd });
    try {
      await this.createTerminal(cwd);
    } catch {
      /* pi unavailable; the folder still opens */
    }
    return { cwd };
  }

  /**
   * Tear down the snapshot store and worker of the previous project.
   * The store is app-owned and deleted with its project session.
   */
  private async teardownRecording(): Promise<void> {
    for (const pending of this.pendingPreflights.values()) {
      clearTimeout(pending.timer);
      this.releaseWriteLease(pending.workspaceId, pending.leaseRequester);
    }
    this.pendingPreflights.clear();
    const store = await this.storePromise;
    this.storePromise = null;
    this.snapshotWorker.dispose();
    if (store && this.storeDir) await store.destroy();
    this.storeDir = null;
    // Remove stale bridge acknowledgement files.
    try {
      for (const f of await readdir(this.eventsDir)) {
        if (f.startsWith("ack-")) rmSync(join(this.eventsDir, f), { force: true });
      }
    } catch {
      /* events dir absent */
    }
  }

  /** Wait until every killed terminal has exited. A terminal that survives
   *  the deadline receives SIGKILL. */
  private async drainTerminals(timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.terminals.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (const inst of [...this.terminals.values()]) inst.pty.kill("SIGKILL");
  }

  // ---------------------------------------------------------- app bridge ----

  /** The app-owned bridge file, passed to pi with the CLI extension option. */
  private bridgePath(): string {
    return join(app.getPath("userData"), "pi-ditor-bridge.ts");
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
    const p = join(cwd, ".pi", "extensions", "pi-ditor-bridge.ts");
    try {
      const content = readFileSync(p, "utf8");
      if (content.includes("Pi/ditor bridge extension — auto-generated")) rmSync(p, { force: true });
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
      ws.generation++;
      const path = this.canonicalPath(change.path);
      const relPath = this.rel(path, ws.root);
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
      // Cap the stored content: the dedupe only compares equality within 2 seconds.
      this.lastWatchChange.set(path, { content: cappedContent, at: now });
      if (this.lastWatchChange.size > PiEditorApp.LAST_WATCH_MAX) {
        const oldest = this.lastWatchChange.keys().next().value;
        if (oldest !== undefined) this.lastWatchChange.delete(oldest);
      }
      // A change with no busy agent terminal belongs to the user — unless a
      // verify run is in flight: test outputs (snapshots, coverage,
      // fixtures) are automated writes, not user edits. The agent receives
      // user edits on its next turn (see the edits-<id>.md context file).
      const busy = workspaceTerminals().filter((t) => t.busy);
      if (!isDupWatch && busy.length === 0 && this.verifyRuns.size === 0 && !this.promotionPaths?.has(relPath)) {
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
      for (const inst of busy) {
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
          // An unowned change during a run is manual provenance: it marks
          // the run collaborative (WORLDLINES §6.5).
          if (inst.currentRun) inst.currentRun.unownedEdits++;
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
    watcher.onFileTouched = (path, status) => {
      ws.generation++;
      for (const inst of workspaceTerminals()) {
        if (inst.busy) this.recordModified(inst, path, status);
      }
    };
    watcher.onFileDeleted = (path) => {
      ws.generation++;
      const p = this.canonicalPath(path);
      this.send("file:deleted", { path: p });
      for (const inst of workspaceTerminals()) this.recordDeleted(inst, path);
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

  private rel(absPath: string, root: string | null = this.projectCwd): string {
    const p = this.canonicalPath(absPath);
    return root ? relative(this.canonicalPath(root), p) : p;
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
          path: this.canonicalPath(full),
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

    // ---- Worldlines: run records (WORLDLINES §6.5) ----
    ipcMain.handle("worldline:runs", (_e, terminalId?: string) => {
      const runs = terminalId ? (this.runsByTerminal.get(terminalId) ?? []) : [...this.runsByTerminal.values()].flat();
      return runs.map((r): RunSummary => ({
        id: r.id,
        terminalId: r.terminalId,
        workspaceId: r.workspaceId,
        startStateId: r.startStateId,
        settledStateId: r.settledStateId,
        promptText: r.promptText,
        promptEntryId: r.promptEntryId,
        promptParentEntryId: r.promptParentEntryId,
        settledEntryId: r.settledEntryId,
        sessionFile: r.sessionFile,
        sessionBranchFile: r.sessionBranchFile,
        replayable: r.replayable,
        reason: r.reason,
        interrupted: r.interrupted,
        steering: r.steering,
        overlap: r.overlap,
        unownedEdits: r.unownedEdits,
        trusted: r.trusted,
        model: r.model,
        thinkingLevel: r.thinkingLevel,
        startedAt: r.startedAt,
        settledAt: r.settledAt,
      }));
    });

    // ---- Worldlines: candidates (WORLDLINES §6.5, §6.6) ----
    ipcMain.handle("worldline:list", () => this.worldlines?.list() ?? []);
    ipcMain.handle("worldline:promote", (_e, comparisonId: string, label: "A" | "B") => this.promoteCandidate(comparisonId, label));
    ipcMain.handle("worldline:details", (_e, comparisonId: string, label: "A" | "B") => this.worldlines?.details(comparisonId, label) ?? { ok: false, error: "worldlines unavailable" });
    ipcMain.handle("worldline:file", (_e, comparisonId: string, label: "A" | "B", relPath: string) => this.worldlines?.fileOf(comparisonId, label, relPath) ?? { ok: false, error: "worldlines unavailable" });
    ipcMain.handle("worldline:base-file", (_e, comparisonId: string, relPath: string) => this.worldlines?.baseFileOf(comparisonId, relPath) ?? { ok: false, error: "worldlines unavailable" });
    ipcMain.handle("worldline:fork-run", async (_e, runId: string) => {
      const run = [...this.runsByTerminal.values()].flat().find((r) => r.id === runId);
      if (!run) return { ok: false, error: "run not found" };
      this.initWorldlines();
      const forkable: ForkableRun = {
        id: run.id,
        terminalId: run.terminalId,
        startStateId: run.startStateId,
        settledStateId: run.settledStateId,
        promptPayloadFile: run.promptPayloadFile,
        promptEntryId: run.promptEntryId,
        promptParentEntryId: run.promptParentEntryId,
        settledEntryId: run.settledEntryId,
        sessionBranchFile: run.sessionBranchFile,
        replayable: run.replayable,
        reason: run.reason,
        model: run.model,
        thinkingLevel: run.thinkingLevel,
        startedAt: run.startedAt,
      };
      return this.worldlines!.forkRun(forkable);
    });
    ipcMain.handle("worldline:cancel", (_e, comparisonId: string) => this.worldlines?.cancel(comparisonId) ?? { ok: false, error: "worldlines unavailable" });
    ipcMain.handle("worldline:discard", (_e, comparisonId: string) => this.worldlines?.discard(comparisonId) ?? { ok: false, error: "worldlines unavailable" });
    ipcMain.handle("worldline:open-terminal", (_e, comparisonId: string, label: "A" | "B") =>
      this.worldlines?.openTerminal(comparisonId, label) ?? { ok: false, error: "worldlines unavailable" },
    );
    /** Materialize a run's start or settled state for inspection. */
    ipcMain.handle("worldline:export-state", async (_e, runId: string, kind: "start" | "settled") => {
      const run = [...this.runsByTerminal.values()].flat().find((r) => r.id === runId);
      if (!run) return { ok: false, error: "run not found" };
      const stateId = kind === "start" ? run.startStateId : run.settledStateId;
      if (!stateId) return { ok: false, error: `no ${kind} state` };
      const store = await this.storePromise;
      if (!store) return { ok: false, error: "recording is not available" };
      try {
        const dir = await mkdtemp(join(app.getPath("temp"), "pi-ditor-state-"));
        await store.materialize(stateId, dir);
        return { ok: true, dir };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    // ---- Editor flush (run-start preflight) ----
    ipcMain.handle("editor:flush-report", (_e, requestId: string, result: { ok: boolean; failed: string[] }) => {
      const waiter = this.flushWaiters.get(requestId);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.flushWaiters.delete(requestId);
      waiter.resolve(result);
    });
    /** The flush saves go through the lease holder (the preflight). */
    ipcMain.handle("file:flush-save", async (_e, absPath: string, content: string, writerId: string) => {
      const ws = this.workspaceContaining(absPath);
      if (ws && ws.writerId !== writerId) return { ok: false, error: "the flush does not hold the write lease" };
      try {
        await writeFile(absPath, content, "utf8");
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

    // ---- Mine ----
    ipcMain.handle("mine:set", (_e, path: string, mine: boolean) => this.setMineFile(path, mine));
    ipcMain.handle("mine:list", () => [...this.mineFiles]);

    // ---- Dispatch ----
    ipcMain.handle("dispatch:run", (_e, terminalId: string) => this.dispatchRun(terminalId));

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
      const blocked = this.assertWorkspaceWritable(inst.workspaceId);
      if (blocked) return { ok: false, error: blocked };
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
      const ws = this.workspaceContaining(absPath);
      const blocked = this.assertWorkspaceWritable(ws?.id ?? "");
      if (blocked) return { ok: false, error: blocked };
      try {
        await writeFile(absPath, content, "utf8");
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    ipcMain.handle("explorer:list-dir", (_e, absPath: string) => this.listDir(absPath));
    ipcMain.handle("explorer:create", async (_e, relPath: string, kind: "file" | "dir") => {
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
    ipcMain.handle("explorer:rename", async (_e, relPath: string, newName: string) => {
      const blocked = this.assertWorkspaceWritable(this.primaryWorkspace()?.id ?? "");
      if (blocked) return { ok: false, error: blocked };
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
      // Finish or roll back any pending promotion journal BEFORE the primary
      // watcher starts: the restored bytes must not attribute to a user edit.
      await this.recoverPromotions();
      this.ensureAppBridge();
      this.removeLegacyProjectBridge(this.projectCwd);
      this.createWorkspace(this.projectCwd, true);
      this.loadMineFiles();
    }
    this.initWorldlines();
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
    for (const ws of this.workspaces.values()) ws.watcher?.stop();
    this.workspaces.clear();
    this.worldlines?.dispose();
    for (const tailer of this.worldlineTailers.values()) tailer.stop();
    this.worldlineTailers.clear();
    for (const inst of this.terminals.values()) inst.pty.kill();
    this.terminals.clear();
    this.snapshotWorker?.dispose();
    this.sessionWorker.dispose();
    void this.teardownRecording();
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
      // paints real content once. After that, only check every 15 seconds as a net
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