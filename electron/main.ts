/**
 * Electron main process — terminal-first architecture.
 *
 * Left side: real pi interactive TUI instances running in ptys (node-pty).
 * Right side: Monaco IDE + explorer, live-synced by the file watcher.
 * A bridge extension auto-installed into the project streams agent events
 * (tool calls, busy state) to sidecar files we tail — that powers auto-open
 * of files mid-run and the modified-files panel.
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme } from "electron";

// Name the app for the macOS menu bar and user-data paths. Unpackaged runs default to "Electron".
app.setName("Termina");
import { execFile, spawn } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { openSync, closeSync, fsyncSync } from "node:fs";
import { chmod, cp, copyFile, mkdir, mkdtemp, readFile, readdir, realpath as fsRealpath, rename as fsRename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { PtyTerminal } from "./pty-terminal.js";
import { SidecarEvent, SidecarTailer } from "./sidecar.js";
import { IGNORED_SEGMENTS, ProjectWatcher } from "./watcher.js";
import { SnapshotStore, freeDiskBytes, gitCommonDir, gitHead, gitObjectFormat, gitTopLevel, platformHasCopyOnWrite, platformHasRecursiveWatcher, platformHasSandboxExec, type SourceState } from "./worldline-git.js";
import { WorldlineManager, type ForkableRun } from "./worldlines.js";
import { sandboxShellPreamble, writeEvidenceProfile } from "./sandbox.js";
import { EvidenceEngine, mineChangeReason, rankProfiles, type EvidenceDeps, type EvidenceRecord, type EvidenceSummary as EngineSummary } from "./evidence.js";
import { coreClient } from "./core-client.js";
import { AppPreferencesStore, normalizeAppPreferences, sanitizeShortcutMap } from "./preferences.js";
import {
  DEFAULT_SHORTCUTS,
  defaultAppPreferences,
  type AppPreferences,
  type ExplorerEntry,
  type InstanceSummary,
  type ModifiedFile,
  type RecorderState,
  type RunSummary,
  type SessionHit,
  type ShortcutCommand,
  type ShortcutMap,
  type TimelineEvent,
  type VerifyInfo,
  type VerifyState,
} from "../shared/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MAX_OPEN_FILE_SIZE = 2 * 1024 * 1024;
const MAX_PROMPT_BYTES = 20 * 1024 * 1024;
const MAX_PI_RESOURCE_BYTES = 200 * 1024 * 1024;
const MAX_PTY_IPC_CHUNK = 64 * 1024;
const MAX_CLIPBOARD_BYTES = 4 * 1024 * 1024;
const MAX_VERIFY_OUTPUT = 200_000;
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
 * Termina bridge extension — auto-generated, do not edit.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FILE_TOOLS = new Set(["write", "edit", "apply_patch", "create_file", "insert"]);


export default function (pi: ExtensionAPI): void {
  const dir = process.env.TERMINA_EVENTS_DIR;
  const id = process.env.TERMINA_TERMINAL_ID;
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
          const claimedPath = \`\${ackPath}.claimed-\${bridgeId}\`;
          renameSync(ackPath, claimedPath);
          try {
            const raw = readFileSync(claimedPath, "utf8");
            resolve(JSON.parse(raw) as Record<string, unknown>);
          } finally {
            rmSync(claimedPath, { force: true });
          }
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

  // ---- project trust (WORLDLINES §6.7) ----
  // A candidate inherits one-process trust only when the app granted it:
  // the run was trusted and its trust-sensitive resources still match.
  // The grant never persists the candidate path (remember: false).
  pi.on("project_trust", async () => {
    if (process.env.TERMINA_INHERIT_TRUST === "1") {
      return { trusted: "yes" as const, remember: false };
    }
    return { trusted: "undecided" as const };
  });

  // ---- startup control (WORLDLINES §6.7) ----
  // The candidate terminal starts with a one-shot control file: prefill
  // text, send a structured prompt, or start with no prompt. The bridge
  // consumes the file exactly once before applying it.
  pi.on("session_start", (_event, ctx) => {
    let control: { opId?: unknown; action?: unknown; text?: unknown; content?: unknown } | null = null;
    try {
      const controlPath = join(dir, "startup-control.json");
      const claimedPath = \`\${controlPath}.claimed-\${bridgeId}\`;
      renameSync(controlPath, claimedPath);
      try {
        const raw = readFileSync(claimedPath, "utf8");
        control = JSON.parse(raw) as { opId?: unknown; action?: unknown; text?: unknown; content?: unknown };
      } finally {
        rmSync(claimedPath, { force: true });
      }
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
        pi.appendEntry("termina-control", { opId });
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
      ctx.ui.notify("termina: the run did not start (" + err + "). Your text is still in the editor.", "warning");
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
    const ack = await waitForAck(requestId, 5000);
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
      message: { customType: "termina-context", content: context, display: false },
    };
  });
  pi.on("tool_execution_start", async (event, ctx) => {
    if (!FILE_TOOLS.has(event.toolName)) return;
    const args = (event.args ?? {}) as { path?: unknown; edits?: unknown };
    if (typeof args.path === "string" && args.path) {
      log({
        t: "tool",
        toolName: event.toolName,
        path: args.path,
        edits: event.toolName === "edit" || event.toolName === "apply_patch" ? args.edits : undefined,
        // The tool call id correlates the result; the leaf id is the
        // session entry of this moment (parallel siblings share it).
        toolCallId: event.toolCallId,
        entryId: ctx?.sessionManager?.getLeafId?.() ?? null,
      });
    }
  });
  pi.on("tool_execution_end", async (event) => {
    // The tool finished: its disk effects landed (the watcher confirms
    // them); this is the moment-capture scheduling signal.
    log({ t: "tool_end", toolCallId: event.toolCallId, isError: !!event.isError });
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
  /** The events directory that contains the prompt payload. */
  promptEventsDir: string | null;
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
  /** The trust-sensitive resource hashes captured at run start (§6.7). */
  trustHashes: Record<string, string> | null;
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
  return env;
}

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

/** One task on the Plan Board. */
interface PlanTask {
  text: string;
  paths: string[];
  state: "pending" | "active" | "done";
}


/** Quote one shell argument: the resolved base commands carry scripts that
 * must survive as one argument through the wrapper shell. */
function quoteShellArg(a: string): string {
  return "'" + a.replace(/'/g, "'\\''") + "'";
}

function capUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= maxBytes ? text : bytes.subarray(0, maxBytes).toString("utf8");
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
  baselineBytes = 0;
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
  runSnapshotBytes = 0;
  /** Last tool event per path (dedupe with watcher changes). */
  lastToolPath: { path: string; at: number } | null = null;
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
  private eventsDir = process.env.TERMINA_EVENTS_DIR ?? join(app.getPath("temp"), "termina-events");
  /** The app-private session branch workspace. */
  private sessionWorkspaceDir = join(this.eventsDir, "session-workspace");
  private tailer = new SidecarTailer(this.eventsDir);
  private paintWatchdog: ReturnType<typeof setInterval> | null = null;
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
  /** The session worker (session forking off the main thread). */
  private sessionWorker = new SessionWorkerClient();
  /** The worldline manager (Fork Run candidates). */
  private worldlines: WorldlineManager | null = null;
  /** The app-owned worlds root. */
  private userDataDir = process.env.TERMINA_USER_DATA_DIR ?? app.getPath("userData");
  private preferencesStore = new AppPreferencesStore(join(this.userDataDir, "preferences.json"));
  private preferences: AppPreferences = defaultAppPreferences();
  private shortcutMap: ShortcutMap = { ...DEFAULT_SHORTCUTS };
  private worldsRoot = process.env.TERMINA_WORLDS_DIR ?? join(this.userDataDir, "worlds");
  /** Tailers for candidate events directories. */
  private worldlineTailers = new Map<string, SidecarTailer>();
  /** Preserve event order while prompt payloads load asynchronously. */
  private sidecarQueues = new Map<string, Promise<void>>();
  /** One-use start preflights by token. */
  private pendingPreflights = new Map<string, PendingPreflight>();
  /** Capture and acknowledgement tasks that must finish before store teardown. */
  private recordingTasks = new Set<Promise<unknown>>();
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
  /** Evidence summaries per comparison (WORLDLINES §6.9). */
  private evidenceByComparison = new Map<string, EngineSummary>();
  /** Evidence runs serialize: one challenger and one evidence run at a time. */
  private evidenceQueue: Promise<unknown> = Promise.resolve();
  private static readonly USER_EDITS_MAX = 50;
  private static readonly MAX_MODIFIED_FILES = 2000;
  private static readonly MAX_BASELINE_FILES = 2000;
  private static readonly MAX_BASELINE_BYTES = 64 * 1024 * 1024;
  private static readonly MAX_RUN_SNAPSHOTS = 2000;
  private static readonly MAX_RUN_SNAPSHOT_BYTES = 64 * 1024 * 1024;
  private static readonly MAX_PENDING_HINTS = 2000;
  private static readonly MAX_MINE_FILES = 2000;
  private static readonly MAX_RETAINED_RUNS = 200;
  /**
   * The last watcher change per path. A single physical write can produce
   * several fs events; the duplicates must not count as fresh user edits.
   */
  private lastWatchChange = new Map<string, { content: string; at: number }>();
  private static readonly LAST_WATCH_MAX = 500;
  private disposed = false;
  private switchingProject = false;
  private folderOpenPromise: Promise<{ cwd: string } | { cancelled: true }> | null = null;

  // ---------------------------------------------------------------- window --

  async createWindow(): Promise<void> {
    nativeTheme.themeSource = this.preferences.theme === "light" ? "light" : "dark";
    const backgroundColor = this.preferences.theme === "light" ? "#f6f8fa" : this.preferences.theme === "high-contrast" ? "#000000" : "#1e1e1e";
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
    const send = (command: string) => () => this.send("menu:command", { command });
    const shortcut = (command: ShortcutCommand): string | undefined => this.shortcutMap[command] || undefined;
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: "Termina",
        submenu: [
          { role: "about" },
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
          // Cut, Copy, Paste, and Delete use system roles. The browser
          // routes the edit command to the focused surface, and the role
          // inherits the standard accelerator. Undo, Redo, and Select All
          // dispatch to the renderer instead: the user can rebind them, and
          // each surface keeps its own undo stack and selection.
          { label: "Undo", accelerator: shortcut("undo"), click: send("edit:undo") },
          { label: "Redo", accelerator: shortcut("redo"), click: send("edit:redo") },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "pasteAndMatchStyle" },
          { role: "delete" },
          { type: "separator" },
          { label: "Select All", accelerator: shortcut("select-all"), click: send("edit:select-all") },
        ],
      },
      {
        label: "Terminal",
        submenu: [
          { label: "New Terminal", accelerator: shortcut("new-terminal"), click: () => void this.createTerminal() },
          { label: "Close Terminal", accelerator: shortcut("close-terminal"), click: () => void this.closeActiveTerminal() },
          { type: "separator" },
          { label: "Send Ctrl+C (abort)", accelerator: shortcut("abort-terminal"), click: () => void this.abortActive() },
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
              { label: "Terminal Fullscreen", accelerator: shortcut("fullscreen"), click: send("layout-terminal-fullscreen") },
            ],
          },
          { label: "Toggle Explorer", accelerator: shortcut("toggle-explorer"), click: send("toggle-explorer") },
          { label: "Toggle Editor", accelerator: shortcut("toggle-editor"), click: send("toggle-editor") },
          { label: "Toggle Modified Panel", accelerator: shortcut("toggle-modified"), click: send("toggle-modified") },
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

  private setKeyboardShortcuts(raw: unknown): ShortcutMap {
    this.shortcutMap = sanitizeShortcutMap(raw, {} as ShortcutMap);
    this.buildMenu();
    return { ...this.shortcutMap };
  }

  private async updatePreferences(raw: unknown, activateShortcuts: boolean): Promise<AppPreferences> {
    const next = normalizeAppPreferences(raw);
    this.preferences = next;
    nativeTheme.themeSource = next.theme === "light" ? "light" : "dark";
    if (activateShortcuts) {
      this.shortcutMap = { ...next.shortcuts };
      this.buildMenu();
    }
    try {
      await this.preferencesStore.save(next);
    } catch (err) {
      console.warn(`[main] preferences save failed: ${(err as Error).message}`);
      throw err;
    }
    return { ...next, shortcuts: { ...next.shortcuts } };
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
      retainedBlobBytes: 0,
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
    if (this.storePromise) return;
    const storeRoot = this.canonicalPath(ws.root);
    this.storeDir = join(this.userDataDir, "worldlines", createHash("sha256").update(storeRoot).digest("hex").slice(0, 16));
    const promise = (async (): Promise<SnapshotStore | null> => {
      const top = await gitTopLevel(ws.root);
      if (!top) {
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
      // The store pins the canonical root (gitTopLevel resolves symlinks).
      const store = await SnapshotStore.create(this.storeDir!, top, gitDir, fmt);
      const state = await store.capture(await gitHead(ws.root), null);
      ws.lastStateCommit = state.commit;
      this.pushRecorderForWorkspace(ws, "ready");
      return store;
    })();
    ws.indexReady = promise.then(() => undefined, (err) => {
      ws.recordError = err instanceof Error ? err.message : String(err);
    });
    this.storePromise = promise;
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
    const project = this.projectCwd ? resolve(this.projectCwd) : null;
    return coreClient.trustHashes(agentDir, project);
  }

  /**
   * Create the worldline manager. Depends on app paths that exist only
   * after the app creates the window.
   */
  private initWorldlines(): void {
    if (this.worldlines) return;
    this.worldlines = new WorldlineManager({
      worldsRoot: this.worldsRoot,
      // The canonical primary root: the sandbox compares canonical paths.
      primaryRoot: realpathSync(this.primaryWorkspace()?.root ?? this.projectCwd ?? homedir()),
      realHome: homedir(),
      userData: this.userDataDir,
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
        const out: string[] = [dirname(dirname(dirname(dirname(this.resolvePiBin()))))];
        out.push(process.execPath);
        out.push(dirname(dirname(process.execPath)));
        const node = this.findOnPath("node") ?? process.execPath;
        out.push(node, dirname(node));
        try {
          out.push(realpathSync(node));
        } catch {
          /* The configured node path can disappear between checks. */
        }
        return [...new Set(out)];
      },
      snapshot: {
        template: (opts) => opts.store.template(opts),
        applyState: (opts) => opts.store.applyState(opts),
      },
      session: {
        fork: (opts) => this.sessionWorker.fork(opts),
      },
      createCandidate: (opts) => this.createCandidate(opts),
      createCandidateWorkspace: (root, baseStateId, comparisonId) => this.createCandidateWorkspace(root, baseStateId, comparisonId),
      onUpdate: (summary) => this.send("worldline:update", summary),
      onCandidateState: (root, stateId) => {
        const workspace = this.workspaceContaining(root);
        if (workspace && !workspace.primary) this.setWorkspaceState(workspace, stateId);
      },
      onRemoved: (comparisonId) => {
        this.cancelVerifyForComparison(comparisonId);
        const summary = this.evidenceByComparison.get(comparisonId);
        this.evidenceByComparison.delete(comparisonId);
        if (summary) void this.releaseEvidenceStates(summary);
        this.removeCandidateWorkspaces(comparisonId);
        this.send("worldline:removed", { comparisonId });
      },
      // The fork preflight (WORLDLINES §4): repository, platform, disk.
      preflight: async () => {
        const reasons: string[] = [];
        const store = await this.storePromise;
        const primaryRoot = this.primaryWorkspace()?.root ?? this.projectCwd ?? "";
        if (store) {
          const repo = await store.preflightRepo({ worldsRoot: this.worldsRoot });
          reasons.push(...repo.reasons);
          // The opened folder must BE the top level (WORLDLINES §4: a Git
          // subdirectory is not a recordable project).
          const top = await gitTopLevel(primaryRoot).catch(() => null);
          const canonicalRoot = realpathSync(primaryRoot);
          if (top && resolve(top) !== resolve(canonicalRoot)) {
            reasons.push("the opened folder is not the Git top-level directory");
          }
        } else {
          // No store: the folder is not a recordable repository.
          const top = primaryRoot ? await gitTopLevel(primaryRoot).catch(() => null) : null;
          if (!top) reasons.push("the opened folder is not inside a Git repository");
        }
        if (!platformHasSandboxExec()) reasons.push("the platform has no sandbox-exec");
        if (!platformHasCopyOnWrite()) reasons.push("the platform has no copy-on-write clone support");
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
        if (free !== null && free < 4 * 1024 * 1024 * 1024) {
          reasons.push(`free disk space is below the 4 GB minimum (${(free / 1e9).toFixed(1)} GB)`);
        }
        return { ok: reasons.length === 0, reasons };
      },
      trustHashes: async () => this.computeTrustHashes(),
      unownedEditsOf: (runId) => {
        const run = [...this.runsByTerminal.values()].flat().find((r) => r.id === runId);
        return run?.unownedEdits ?? 0;
      },
      captureHead: async (root, gitDir, parent) => {
        const store = await this.storePromise;
        if (!store) throw new Error("recording is not available");
        const state = await store.capture(await gitHead(root), parent, {}, {}, { root, gitDir });
        return { commit: state.commit, tree: state.tree };
      },
      sourceRunOf: (runId) => {
        const run = [...this.runsByTerminal.values()].flat().find((r) => r.id === runId);
        return run
          ? {
              promptPayloadFile: run.promptPayloadFile,
              promptEventsDir: run.promptEventsDir,
              promptParentEntryId: run.promptParentEntryId,
              sessionFile: run.sessionFile,
            }
          : null;
      },
      capturePrimary: async () => {
        const ws = this.primaryWorkspace();
        const store = await this.storePromise;
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
    });
  }

  /** The events dir a terminal's bridge reads (candidates have their own). */
  private eventsDirOf(inst: PiTerminalInstance): string {
    return this.worldlines?.eventsDirOf(inst.id) ?? this.eventsDir;
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
    launch: { cmd: string; args: string[]; env: Record<string, string | undefined> };
  }): Promise<{ terminalId: string; pid: number }> {
    const inst = await this.createTerminal(opts.root, { type: "agent", workspaceId: opts.workspaceId, launch: opts.launch });
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
  private createCandidateWorkspace(root: string, baseStateId: string | null, comparisonId: string): string {
    const ws = this.createWorkspace(root, false);
    ws.comparisonId = comparisonId;
    ws.lastStateCommit = baseStateId;
    return ws.id;
  }

  /** Remove candidate workspaces after one comparison is torn down. */
  private removeCandidateWorkspaces(comparisonId: string): void {
    for (const [id, ws] of [...this.workspaces]) {
      if (ws.primary || ws.comparisonId !== comparisonId) continue;
      const stateId = ws.lastStateCommit;
      ws.watcher?.stop();
      this.workspaces.delete(id);
      this.userEditsByWorkspace.delete(id);
      if (stateId) void this.releaseStateIfUnused(stateId);
    }
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
      const root = this.canonicalPath(ws.root);
      const rel = relative(root, p);
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return ws;
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
  private async promoteCandidate(comparisonId: string, label: "A" | "B", force = false): Promise<{ ok: boolean; error?: string; terminalId?: string; confirm?: string }> {
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
    // A confirmation request releases the leases and keeps the pair usable.
    const askConfirm = async (message: string): Promise<{ ok: false; confirm: string }> => {
      releaseLeases();
      await this.worldlines?.finishPromotion(comparisonId, false, null);
      return { ok: false, confirm: message };
    };

    try {
      // Flush the dirty editor models (both leases cover every save path).
      const flush = await this.flushDirtyModels(requester, 8000);
      if (!flush.ok) return fail("could not save editor changes");

      this.worldlines?.markPromoting(comparisonId, label);

      // Capture W (candidate head, chained from R) and P (current primary).
      const candGitDir = await gitCommonDir(target.root);
      const [wState, pState] = await Promise.all([
        store.capture(await gitHead(target.root), baseState, {}, {}, { root: target.root, gitDir: candGitDir ?? target.root }),
        store.capture(await gitHead(primary.root), primary.lastStateCommit ?? null),
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
      // Confirmations (WORLDLINES §6.10): after the hard checks, absent /
      // stale / failed evidence and ignored/generated writes require an
      // explicit confirmation once.
      if (!force) {
        const summary = this.evidenceByComparison.get(comparisonId);
        const recs = summary?.byCandidate[label] ?? [];
        const verify = recs.find((r) => r.kind === "verify");
        const evidenceOk = verify?.status === "pass" && summary?.stale !== true;
        const ignored = await this.worldlines?.ignoredWrites(comparisonId, label);
        if (!evidenceOk) {
          const why = !verify ? "no evidence has been computed for this candidate" : summary?.stale ? "the evidence is stale (the candidate ran again)" : `the evidence is ${verify?.status}`;
          return askConfirm(`promote without current passing evidence? (${why})`);
        }
        if ((ignored?.count ?? 0) > 0) {
          return askConfirm(`${ignored!.count} ignored/generated file(s) (${((ignored!.bytes ?? 0) / 1024).toFixed(0)} kB) will be excluded from the promotion`);
        }
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
          env: { ...cleanEnv(), TERMINA_EVENTS_DIR: this.eventsDir },
        },
      });
      // Seed Change Review: the promotion is the run's own change set.
      for (const p of paths) {
        const abs = this.canonicalPath(join(primary.root, p.rel));
        const before = p.beforeExists ? await readFile(join(beforeDir, p.rel)) : null;
        this.setBaseline(inst, abs, before === null ? null : before.toString("utf8"));
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
          /* The context file is optional. */
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
  // ------------------------------------------------- evidence (WORLDLINES §6.8) ----

  /** One sandboxed command run with bounded output and time. */
  private runSandboxedEvidence(
    cand: { root: string; profilePath: string; homeDir: string; tmpDir: string },
    command: string[],
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string; timedOut: boolean }> {
    return new Promise((resolvePromise) => {
      const shells = detectShells();
      const shell = shells[0] ?? { path: "/bin/zsh", name: "zsh" };
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
      child.stdout.on("data", (d: Buffer) => {
        if (stdout.length < 200_000) stdout += d.toString("utf8");
      });
      child.stderr.on("data", () => undefined);
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

  /** Return the bounded size of a directory tree. */
  private async dirBytesOf(dir: string): Promise<number> {
    let total = 0;
    const walk = async (current: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (total > 200 * 1024 * 1024) return;
        const full = join(current, entry.name);
        try {
          if (entry.isDirectory()) await walk(full);
          else if (entry.isFile()) total += (await stat(full)).size;
        } catch {
          /* A transient resource is not copied. */
        }
      }
    };
    await walk(dir);
    return total;
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
          if ((await stat(src)).isDirectory() && (await this.dirBytesOf(src)) <= MAX_PI_RESOURCE_BYTES) {
            await cp(src, join(agentDst, name), { recursive: true });
          }
        } catch {
          /* An optional or oversized resource is omitted. */
        }
      }
      await mkdir(join(dir, "tmp"), { recursive: true, mode: 0o700 });
      complete = true;
      return dir;
    } finally {
      if (!complete) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** The base state of a comparison (its source run's start state). */
  private markCandidateEvidenceStale(comparisonId: string | undefined): void {
    if (!comparisonId) return;
    const summary = this.evidenceByComparison.get(comparisonId);
    if (!summary || summary.stale) return;
    summary.stale = true;
    this.send("worldline:evidence-update", summary);
  }

  private stateIsReferenced(stateId: string, ignoredTerminalId?: string, ignoredSeq?: number): boolean {
    for (const records of this.runsByTerminal.values()) {
      if (records.some((run) => run.startStateId === stateId || run.settledStateId === stateId)) return true;
    }
    for (const pending of this.pendingPreflights.values()) {
      if (pending.startState?.commit === stateId) return true;
    }
    for (const workspace of this.workspaces.values()) {
      if (workspace.lastStateCommit === stateId) return true;
    }
    for (const summary of this.worldlines?.list() ?? []) {
      if (summary.comparisonBaseStateId === stateId || summary.promotionBaseStateId === stateId || summary.headStateId === stateId) return true;
    }
    for (const summary of this.evidenceByComparison.values()) {
      if (Object.values(summary.byCandidate).some((records) => records.some((record) => record.stateId === stateId))) return true;
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
    const store = await this.storePromise;
    if (!store || this.stateIsReferenced(stateId, ignoredTerminalId, ignoredSeq)) return;
    await store.unref(stateId).catch(() => undefined);
  }

  private setWorkspaceState(ws: WorkspaceState, stateId: string): void {
    const previous = ws.lastStateCommit;
    ws.lastStateCommit = stateId;
    if (previous && previous !== stateId) void this.releaseStateIfUnused(previous);
  }

  private async releaseEvidenceStates(summary: EngineSummary): Promise<void> {
    const states = new Set<string>();
    for (const records of Object.values(summary.byCandidate)) {
      for (const record of records) states.add(record.stateId);
    }
    for (const stateId of states) await this.releaseStateIfUnused(stateId);
  }

  private baseStateOf(comparisonId: string): string | null {
    const target = this.worldlines?.promotionTarget(comparisonId, "A");
    if (!target) return null;
    const run = [...this.runsByTerminal.values()].flat().find((r) => r.id === target.sourceRunId);
    return run?.startStateId ?? null;
  }

  /**
   * Compute evidence for both candidates serially and rank the profiles
   * (WORLDLINES §6.8: run required evidence for A and B serially).
   */
  private runEvidence(comparisonId: string): Promise<{ ok: boolean; error?: string }> {
    const run = this.evidenceQueue.then(async (): Promise<{ ok: boolean; error?: string }> => {
      const store = await this.storePromise;
      const baseStateId = this.baseStateOf(comparisonId);
      if (!store || !baseStateId) return { ok: false, error: "recording is not available" };
      const targets = new Map<"A" | "B", NonNullable<ReturnType<WorldlineManager["evidenceTarget"]>>>();
      const generations = new Map<"A" | "B", number>();
      const leases: Array<{ workspaceId: string; requesterId: string }> = [];
      const releaseLeases = (): void => {
        for (const lease of leases) this.releaseWriteLease(lease.workspaceId, lease.requesterId);
      };
      for (const label of ["A", "B"] as const) {
        const target = this.worldlines?.evidenceTarget(comparisonId, label);
        if (!target) {
          releaseLeases();
          return { ok: false, error: "candidate not found" };
        }
        const terminal = target.terminalId ? this.terminals.get(target.terminalId) : null;
        if (terminal?.busy || target.state === "running" || target.state === "verifying") {
          releaseLeases();
          return { ok: false, error: `candidate ${label} is active` };
        }
        const workspace = this.workspaceContaining(target.root);
        if (!workspace) {
          releaseLeases();
          return { ok: false, error: "candidate workspace not found" };
        }
        const requesterId = `evidence:${comparisonId}:${label}`;
        const lease = await this.acquireWriteLease(workspace.id, requesterId, 2000);
        if (!lease.ok) {
          releaseLeases();
          return { ok: false, error: lease.error ?? "a candidate workspace is busy" };
        }
        leases.push({ workspaceId: workspace.id, requesterId });
        targets.set(label, target);
        generations.set(label, workspace.generation);
      }
      let tc: { command: string; args: string[]; label: string } | null;
      let bm: { command: string[]; unit: string; direction: "lower" | "higher"; samples: number; thresholdPct: number } | null;
      let evidenceHome: string | null = null;
      try {
        tc = await this.detectTestFromState(store, baseStateId);
        bm = await this.benchmarkConfigFrom(store, baseStateId);
        evidenceHome = await this.createEvidenceHome();
      } catch (err) {
        releaseLeases();
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      const evidenceRoot = evidenceHome;
      if (!evidenceRoot) {
        releaseLeases();
        return { ok: false, error: "evidence home is unavailable" };
      }
      const capturedStates = new Set<string>();
      const capturedTrees = new Map<string, string>();
      const deps: EvidenceDeps = {
        store,
        baseStateId,
        primaryRoot: this.primaryWorkspace()?.root ?? "",
        mineFiles: new Set(this.mineFiles),
        captureHead: async (root, gitDir, parent) => {
          const state = await store.capture(await gitHead(root), parent, {}, {}, { root, gitDir });
          capturedStates.add(state.commit);
          capturedTrees.set(state.commit, state.tree);
          return { commit: state.commit, tree: state.tree };
        },
        runSandboxed: (cand, command, timeoutMs) => this.runSandboxedEvidence(cand, command, timeoutMs),
        baseTestCommand: () => tc,
        benchmarkConfig: () => bm,
        sourceFilesOf: (root) => this.sourceFilesOf(root),
      };
      const engine = new EvidenceEngine(deps);
      const byCandidate: Record<"A" | "B", EvidenceRecord[]> = { A: [], B: [] };
      const mineReason: Record<"A" | "B", string | null> = { A: null, B: null };
      const retainedStates = new Set<string>();
      const expectedVersions = new Map<"A" | "B", number>();
      let result: { ok: boolean; error?: string };
      try {
        result = { ok: true };
        for (const label of ["A", "B"] as const) {
          const target = targets.get(label)!;
          const cand = { root: target.root, profilePath: target.profilePath, homeDir: evidenceRoot, tmpDir: join(evidenceRoot, "tmp"), shell: "" };
          byCandidate[label] = await engine.measure(label, cand);
          const finalState = await deps.captureHead(target.root, join(target.root, ".git"), null);
          const workspace = this.workspaceContaining(target.root);
          const current = this.worldlines?.evidenceVersion(comparisonId, label);
          if (!workspace || workspace.generation !== generations.get(label) || !current || current.version !== target.version) {
            result = { ok: false, error: `candidate ${label} changed during evidence` };
            break;
          }
          const head = byCandidate[label].find((record) => record.kind === "verify") ?? byCandidate[label][0];
          if (head && capturedTrees.get(head.stateId) !== finalState.tree) {
            result = { ok: false, error: `candidate ${label} changed during evidence` };
            break;
          }
          if (head) {
            retainedStates.add(head.stateId);
            this.worldlines?.setCandidateHead(comparisonId, label, head.stateId);
            expectedVersions.set(label, this.worldlines?.evidenceVersion(comparisonId, label)?.version ?? target.version);
            mineReason[label] = await mineChangeReason(store, baseStateId, head.stateId, deps.primaryRoot, deps.mineFiles, (p) => fsRealpath(p));
          } else {
            expectedVersions.set(label, target.version);
          }
        }
        if (result.ok) {
          for (const label of ["A", "B"] as const) {
            const target = targets.get(label)!;
            const workspace = this.workspaceContaining(target.root);
            const current = this.worldlines?.evidenceVersion(comparisonId, label);
            if (!workspace || workspace.generation !== generations.get(label) || !current || current.version !== expectedVersions.get(label)) {
              result = { ok: false, error: `candidate ${label} changed during evidence` };
              break;
            }
          }
        }
        if (!result.ok) return result;
        const summary: EngineSummary = {
          comparisonId,
          ts: Date.now(),
          byCandidate,
          profiles: rankProfiles(byCandidate, mineReason, bm?.thresholdPct ?? 0.05),
          error: null,
          stale: false,
        };
        const previous = this.evidenceByComparison.get(comparisonId);
        this.evidenceByComparison.set(comparisonId, summary);
        if (previous) void this.releaseEvidenceStates(previous);
        this.send("worldline:evidence-update", summary);
        return result;
      } finally {
        for (const stateId of capturedStates) {
          if (!retainedStates.has(stateId)) await this.releaseStateIfUnused(stateId);
        }
        releaseLeases();
        if (evidenceHome) await rm(evidenceHome, { recursive: true, force: true }).catch(() => undefined);
      }
    });
    this.evidenceQueue = run.catch(() => undefined);
    return run;
  }

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
      // not the asar archive (node-pty cannot open asar paths).
      const real = entry.includes("app.asar") ? entry.replace("app.asar", "app.asar.unpacked") : entry;
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

  /**
   * Whether the pi binary exists and runs. Success is cached; a FAILURE is
   * only trusted for a few seconds. A transient spawn error must not disable
   * the app for its full lifetime. The check is asynchronous because Pi's
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
      "pi is not installed.\n\nInstall it with:\n  npm install -g @earendil-works/pi-coding-agent\n\nor set TERMINA_PI_BIN to the pi binary path."
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
      env = { ...opts.launch.env, TERMINA_TERMINAL_ID: id };
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
      env = { ...cleanEnv(), TERMINA_TERMINAL_ID: id, TERMINA_EVENTS_DIR: this.eventsDir };
    }
    const inst = new PiTerminalInstance(id, cwd ?? this.terminalCwd(), workspaceId, type, shellName, cmd, args, env, 80, 24);
    this.terminals.set(inst.id, inst);
    this.workspaces.get(workspaceId)?.terminalIds.add(id);

    inst.pty.onData = (data) => this.sendPtyData(inst.id, data);
    inst.pty.onExit = (code) => {
      console.log(`[main] terminal ${inst.id} (${inst.type}) exited code=${code}`);
      this.send("pty:exit", { id: inst.id, code });
      this.closeRunOnExit(inst);
      void this.cleanupPromptPayloads(inst);
      for (const event of inst.timeline) {
        if (event.stateId) void this.releaseStateIfUnused(event.stateId, inst.id, event.seq);
      }
      this.terminals.delete(inst.id);
      this.workspaces.get(inst.workspaceId)?.terminalIds.delete(inst.id);
      this.worldlines?.terminalExited(inst.id);
      this.worldlineTailers.get(inst.id)?.stop();
      this.worldlineTailers.delete(inst.id);
      this.tailer.stopWatching(inst.id);
      this.sidecarQueues.delete(inst.id);
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
        if (tokens.some((t) => /[|&;<>()]/.test(t))) return { command: "sh", args: ["-c", body], label: `npm run ${pick}` };
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
      await stat(join(cwd, "cargo.toml"));
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
    if (this.disposed || this.switchingProject) return { ok: false, error: "the project is changing" };
    if (this.verifyRuns.has(ownerId)) return { ok: false, error: "a verify run is already in progress" };
    this.verifyRuns.add(ownerId);
    // Run candidate tests inside the candidate sandbox. The tests cannot write
    // the primary project.
    const candidate = this.worldlines?.candidateSandboxOf(ownerId) ?? null;
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
      this.switchingProject ||
      this.terminals.get(ownerId) !== owner ||
      (candidate && (!this.worldlines?.candidateSandboxOf(ownerId) || !existsSync(candidate.root)))
    ) {
      this.verifyRuns.delete(ownerId);
      return { ok: false, error: "the project is changing" };
    }

    let child: ReturnType<typeof spawn>;
    try {
      const shells = detectShells();
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
    const appendOutput = (data: Buffer | string): void => {
      if (output.length >= MAX_VERIFY_OUTPUT) return;
      output += data.toString().slice(0, MAX_VERIFY_OUTPUT - output.length);
    };
    const finish = (code: number | null, how: VerifyState): void => {
      if (finished) return;
      finished = true;
      clearTimeout(verifyTimer);
      this.verifyRuns.delete(ownerId);
      this.verifyJobs.delete(ownerId);
      if (this.terminals.get(ownerId) !== owner || this.switchingProject || this.disposed) return;
      const summary = how === "pass" ? "tests green" : how === "timeout" ? "tests timed out" : how === "cancelled" ? "cancelled" : "tests failing";
      owner.verify = { state: how, command: tc.label, summary };
      // Do not write a result for a cancelled run. The previous context stays.
      if (how !== "cancelled") this.writeVerifyContext(ownerId, tc.label, how, code, output);
      this.send("verify:state", { terminalId: ownerId, verify: owner.verify });
    };
    const verifyTimer = setTimeout(() => {
      console.warn(`[main] background verify timed out after 600s for ${ownerId}`);
      finish(null, "timeout");
      this.killVerifyChild(child, "SIGTERM");
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
      const workspace = owner ? this.workspaces.get(owner.workspaceId) : undefined;
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

  private async drainVerifyJobs(timeoutMs = 2000): Promise<void> {
    for (const job of this.verifyJobs.values()) this.killVerifyChild(job.child, "SIGTERM");
    const deadline = Date.now() + timeoutMs;
    while (this.verifyJobs.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (const job of this.verifyJobs.values()) this.killVerifyChild(job.child, "SIGKILL");
    this.verifyJobs.clear();
    this.verifyRuns.clear();
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

  /** The run ended: a task is done when the run touched every path it mentions. */
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
   * behind because their tasks can modify the same files. At most 3 workers run at
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
    const managed = this.managedPath(path, true);
    if (!managed) return;
    const p = managed.path;
    if (mine) {
      if (!this.mineFiles.has(p) && this.mineFiles.size >= PiEditorApp.MAX_MINE_FILES) return;
      this.mineFiles.add(p);
    } else {
      this.mineFiles.delete(p);
    }
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
          if (this.mineFiles.size >= PiEditorApp.MAX_MINE_FILES) break;
          if (typeof p !== "string") continue;
          const managed = this.managedPath(p, true);
          if (managed) this.mineFiles.add(managed.path);
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
    if (this.verifyRuns.has(id)) this.cancelVerify(id);
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
    if (this.disposed || this.switchingProject) return;
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
    if (this.disposed || this.switchingProject) return;
    const inst = this.terminals.get(terminalId);
    if (!inst) return;
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
        this.worldlines?.onSessionReady(terminalId, readyOk, String(event.error ?? null) || null);
        break;
      }
      case "agent_start":
        inst.busy = true;
        // Track busy agents: a second agent starting in the same workspace
        // overlaps this run (marked in coupleRunStart, WORLDLINES §5).
        if (inst.type === "agent") this.busyAgents.add(inst.id);
        // A candidate run invalidates its comparison's evidence: the head
        // moved (WORLDLINES §6.8 — results are bound to the measured state).
        const candHit = (this.worldlines?.list() ?? []).find((w) => w.terminalId === inst.id);
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
        this.resetBaselines(inst, startWs?.watcher?.lastContents);
        inst.runSnapshots.clear();
        inst.runSnapshotBytes = 0;
        inst.lastToolPath = null;
        inst.pendingHints = new Set();
        inst.momentDots = [];
        inst.captureTimer = null;
        this.pushTimeline(inst, { t: "agent_start" });
        // The run records moments: the recorder state follows the store.
        const startWs2 = this.workspaceOfTerminal(inst);
        void this.storePromise?.then((s) => {
          if (!this.disposed && !this.switchingProject && this.terminals.has(inst.id)) {
            this.setRecorderState(inst, !s ? "paused" : startWs2?.indexReady ? "indexing" : "ready");
          }
        });
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
        // Push invalidation after the busy state. The renderer must not start
        // evidence from the stale idle view between these two updates.
        if (candHit) this.markCandidateEvidenceStale(candHit.comparisonId);
        break;
      case "agent_settled":
        inst.busy = false;
        this.busyAgents.delete(inst.id);
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
        // Candidate tool paths resolve against the candidate root; the
        // within-project guard applies to the primary only (nested moments).
        const toolWs = this.workspaceOfTerminal(inst);
        const toolBase = toolWs?.root ?? this.projectCwd;
        const path = this.canonicalPath(isAbsolute(rawPath) ? rawPath : toolBase ? join(toolBase, rawPath) : rawPath);
        if (!path) return;
        const isCandidateTerminal = !!this.worldlines?.eventsDirOf(inst.id);
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
          this.trackRecordingTask(this.fillBaselineFromState(inst, path, status));
        }
        inst.touched.add(this.rel(path));
        this.updatePlanProgress(inst, path);
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
        // The tool finished: schedule the moment capture for its dots.
        const inst2 = this.terminals.get(terminalId);
        if (inst2 && inst2.currentRun) this.scheduleMomentCapture(inst2);
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
      // A second agent running in the same workspace overlaps this run and
      // the other open run (WORLDLINES §5): both become ineligible.
      if (ws && inst.type === "agent") {
        for (const otherId of this.busyAgents) {
          if (otherId === inst.id) continue;
          const other = this.terminals.get(otherId);
          if (!other || other.workspaceId !== inst.workspaceId) continue;
          run.overlap = true;
          run.replayable = false;
          run.reason = "another agent ran in the same workspace";
          if (other.currentRun && other.currentRun.replayable) {
            other.currentRun.overlap = true;
            other.currentRun.replayable = false;
            other.currentRun.reason = "another agent ran in the same workspace";
          }
        }
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
      };
      this.pushRun(inst, run);
    }
  }

  /** Store a run record with per-terminal and global limits. */
  private pushRun(inst: PiTerminalInstance, run: RunRecord): void {
    inst.currentRun = run;
    let list = this.runsByTerminal.get(inst.id);
    if (!list) {
      list = [];
      this.runsByTerminal.set(inst.id, list);
    }
    list.push(run);
    if (list.length > 20) this.discardRunRecord(list.shift());
    while (this.retainedRunCount() > PiEditorApp.MAX_RETAINED_RUNS) {
      let oldestTerminal: string | null = null;
      let oldest: RunRecord | undefined;
      for (const [terminalId, records] of this.runsByTerminal) {
        const candidate = records[0];
        if (candidate && (!oldest || candidate.startedAt < oldest.startedAt)) {
          oldest = candidate;
          oldestTerminal = terminalId;
        }
      }
      if (!oldest || !oldestTerminal) break;
      const records = this.runsByTerminal.get(oldestTerminal);
      if (!records) break;
      this.discardRunRecord(records.shift());
      if (records.length === 0) this.runsByTerminal.delete(oldestTerminal);
    }
  }

  private retainedRunCount(): number {
    let count = 0;
    for (const records of this.runsByTerminal.values()) count += records.length;
    return count;
  }

  private discardRunRecord(run: RunRecord | undefined): void {
    if (!run) return;
    if (run.startStateId) void this.releaseStateIfUnused(run.startStateId);
    if (run.settledStateId && run.settledStateId !== run.startStateId) void this.releaseStateIfUnused(run.settledStateId);
    if (run.promptPayloadFile && run.promptEventsDir) {
      void rm(join(run.promptEventsDir, run.promptPayloadFile), { force: true }).catch(() => undefined);
    }
    if (run.sessionBranchFile) void rm(run.sessionBranchFile, { force: true }).catch(() => undefined);
  }

  private clearRunRecords(): void {
    const records = [...this.runsByTerminal.values()];
    this.runsByTerminal.clear();
    for (const list of records) {
      for (const run of list) this.discardRunRecord(run);
    }
  }

  private async cleanupPromptPayloads(inst: PiTerminalInstance): Promise<void> {
    const keep = new Set((this.runsByTerminal.get(inst.id) ?? []).map((run) => run.promptPayloadFile).filter((file): file is string => file !== null));
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
      this.setWorkspaceState(ws, state.commit);
      if (!ws.primary) this.worldlines?.updateHeadState(inst.id, state.commit);
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
      if (this.disposed || this.switchingProject) return;
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
    const store = await this.storePromise;
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
    // Reconcile: the watcher cache catches changes the hints missed. Bound
    // the reconcile walk so a huge cache cannot stall the capture.
    const cache = ws.watcher?.lastContents ?? new Map<string, string>();
    const reconcile: Array<{ relPath: string; content: string }> = [];
    const hinted = new Set(hints);
    let walked = 0;
    for (const [path, content] of cache) {
      if (walked++ > 2000) break;
      const rel = this.rel(path, ws.root);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
      if (hinted.has(rel)) continue;
      if (this.ignoredSegmentIn(rel)) continue;
      reconcile.push({ relPath: rel, content });
    }
    try {
      // A candidate workspace captures its OWN tree (the source override).
      const source = ws.primary ? undefined : { root: ws.root, gitDir: (await gitCommonDir(ws.root)) ?? ws.root };
      const state = await store.captureIncremental(ws.lastStateCommit, hints, reconcile, {}, {}, source);
      this.setWorkspaceState(ws, state.commit);
      ws.retainedBlobBytes = (ws.retainedBlobBytes ?? 0) + state.newBlobBytes;
      if (!ws.primary) this.worldlines?.updateHeadState(inst.id, state.commit);
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
        await copyFile(run.sessionFile, target, constants.COPYFILE_EXCL);
        run.sessionBranchFile = target;
      } catch (err) {
        run.replayable = false;
        run.reason = `could not copy the session branch: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    // The run must not leave a live mutating descendant process behind
    // (WORLDLINES §6.5): a background bash would keep writing after the
    // captured settle state.
    if (run.replayable && (await this.descendantPids(inst.pty.pid)).length > 0) {
      run.replayable = false;
      run.reason = "the run left a live descendant process";
    }
    inst.currentRun = null;
    // The run record is complete now: the renderer refreshes its Fork Run
    // button from this push (the settle timeline event arrives earlier).
    this.send("worldline:runs-changed", { terminalId: inst.id });
  }

  /** The descendant pids of a process, from one ps snapshot. */
  private async descendantPids(pid: number): Promise<number[]> {
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
      return [];
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
    // Dedupe with the imminent watcher change — set in EVERY branch so the
    // write-without-cache path also claims the change event.
    inst.lastToolPath = { path, at: Date.now() };
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

  /** Append a timeline point, keep caps, push a CONTENT-FREE event to the
   *  renderer (snapshots are fetched on demand when a dot is clicked, so the
   *  strip and IPC stay light). Tool and change dots join the open batch and
   *  receive their captured source state with the next moment capture. */
  private pushTimeline(inst: PiTerminalInstance, ev: Omit<TimelineEvent, "seq" | "ts">): void {
    const event: TimelineEvent = { seq: ++inst.timelineSeq, ...ev, ts: Date.now() };
    inst.timeline.push(event);
    if (inst.timeline.length > MAX_TIMELINE_EVENTS) inst.timeline.splice(0, inst.timeline.length - MAX_TIMELINE_EVENTS);
    this.trimTimelineContent(inst);
    if (inst.currentRun && (event.t === "tool" || event.t === "change")) {
      inst.momentDots.push(event);
      if (inst.momentDots.length > MAX_TIMELINE_EVENTS) inst.momentDots.shift();
    }
    const { content: _content, ...pub } = event;
    this.send("timeline:event", { terminalId: inst.id, event: pub });
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
   * (oldText/newText from the tool call) in reverse order. Only edits that
   * have ACTUALLY landed on disk are reversed — the sidecar event fires at
   * tool start, and if the write has not happened yet the disk content IS the
   * pre-run content (reversing it would double-reverse and corrupt the
   * baseline). Return null when no baseline exists and the file cannot be read.
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
        if (newText && !base.includes(newText)) continue; // not landed yet — keep as-is
        base = base.split(newText).join(oldText);
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

  private async fillBaselineFromState(inst: PiTerminalInstance, path: string, status: "created" | "modified"): Promise<void> {
    if (inst.baselines.has(path) || status === "created") {
      if (status === "created" && !inst.baselines.has(path)) this.setBaseline(inst, path, null);
      return;
    }
    const stateId = inst.currentRun?.startStateId;
    const workspace = this.workspaceOfTerminal(inst);
    const store = await this.storePromise;
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
  async confirmDiscardActiveCandidates(): Promise<boolean> {
    const active = await this.worldlines?.activeCandidates().catch(() => 0) ?? 0;
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
    // Live candidates with activity need a confirmation before the switch
    // discards them (WORLDLINES §6.11). A confirmed switch discards every
    // live candidate and releases the manager.
    if (!(await this.confirmDiscardActiveCandidates())) return { cancelled: true };
    this.switchingProject = true;
    try {
      await this.drainVerifyJobs();
      await this.drainSidecarQueues();
      await this.evidenceQueue.catch(() => undefined);
      await this.worldlines?.dispose().catch(() => undefined);
      this.worldlines = null;
      this.clearMineFiles();
      for (const id of [...this.terminals.keys()]) {
        this.tailer.stopWatching(id);
        this.worldlineTailers.get(id)?.stop();
        this.worldlineTailers.delete(id);
        this.closeTerminal(id);
      }
      await this.drainTerminals();
      await this.drainSidecarQueues();
      this.sidecarQueues.clear();
      for (const ws of this.workspaces.values()) ws.watcher?.stop();
      this.workspaces.clear();
      this.userEditsByWorkspace.clear();
      if (this.userEditsWriteTimer) clearTimeout(this.userEditsWriteTimer);
      this.userEditsWriteTimer = null;
      for (const waiter of this.flushWaiters.values()) {
        clearTimeout(waiter.timer);
        waiter.resolve({ ok: false, failed: ["folder switch"] });
      }
      this.flushWaiters.clear();
      this.clearRunRecords();
      this.evidenceByComparison.clear();
      this.lastWatchChange.clear();
      this.busyAgents.clear();
      this.dispatchWorkers.clear();
      this.dispatchRuns.clear();
      await this.teardownRecording();
      this.projectCwd = cwd;
      this.ensureAppBridge();
      this.removeLegacyProjectBridge(cwd);
      this.createWorkspace(cwd, true);
      this.loadMineFiles();
      this.send("folder:opened", { cwd });
      try {
        await this.createTerminal(cwd);
      } catch {
        /* Pi can be unavailable while the folder still opens. */
      }
      return { cwd };
    } finally {
      this.switchingProject = false;
    }
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
    for (const waiter of this.flushWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve({ ok: false, failed: ["recording teardown"] });
    }
    this.flushWaiters.clear();
    await this.drainRecordingTasks();
    const promise = this.storePromise;
    this.storePromise = null;
    const storeDir = this.storeDir;
    this.storeDir = null;
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
      if (this.disposed || this.switchingProject) return;
      const path = this.canonicalPath(change.path);
      const relPath = relative(this.canonicalPath(ws.root), path);
      if (!relPath || relPath.startsWith("..") || isAbsolute(relPath)) return;
      ws.generation++;
      this.markCandidateEvidenceStale(ws.comparisonId);
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
      // verify run is running: test outputs (snapshots, coverage,
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
          this.setBaseline(inst, path, null);
        } else if (change.prev !== undefined) {
          this.setBaseline(inst, path, change.prev);
        } else {
          this.trackRecordingTask(this.fillBaselineFromState(inst, path, change.status));
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
          // Fork Any Moment: the path joins the terminal's next capture.
          this.addPendingHint(inst, relPath);
          this.scheduleMomentCapture(inst);
          const last = inst.timeline.at(-1);
          if (last && last.t === "tool" && last.path === path && this.contentSizeOk(change.content)) {
            last.content = change.content;
            this.setRunSnapshot(inst, path, change.content);
          }
        }
      } else {
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
      this.send("file:changed", { path, relPath, content: change.content, status: change.status });
    };
    watcher.onFileTouched = (path, status) => {
      if (this.disposed || this.switchingProject) return;
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
      if (this.disposed || this.switchingProject) return;
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
    const managed = this.managedPath(abs, true);
    if (!managed || managed.path === this.canonicalPath(cwd)) throw new Error(`path outside project: ${relPath}`);
    return managed.path;
  }

  private async listDir(absPath: string): Promise<{ entries: ExplorerEntry[]; error?: string }> {
    const managed = this.managedPath(absPath, true);
    if (!managed) return { entries: [], error: "path outside the project workspace" };
    try {
      const dirents = await readdir(managed.path, { withFileTypes: true });
      const entries: ExplorerEntry[] = [];
      for (const ent of dirents) {
        if (IGNORED_SEGMENTS.has(ent.name) || ent.name.startsWith(".")) continue;
        const full = join(managed.path, ent.name);
        const child = this.managedPath(full, true);
        if (!child || child.workspace.id !== managed.workspace.id) continue;
        entries.push({
          name: ent.name,
          path: child.path,
          relPath: relative(this.canonicalPath(managed.workspace.root), child.path),
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
    ipcMain.handle("folder:open", () => this.openFolder());
    ipcMain.handle("clipboard:write", (_e, text: unknown) => {
      if (typeof text !== "string") return { ok: false, error: "clipboard text is invalid" };
      if (Buffer.byteLength(text, "utf8") > MAX_CLIPBOARD_BYTES) return { ok: false, error: "clipboard text is too large" };
      clipboard.writeText(text);
      return { ok: true };
    });
    ipcMain.handle("clipboard:read", () => capUtf8(clipboard.readText(), MAX_CLIPBOARD_BYTES));
    ipcMain.handle("settings:get", () => ({ ...this.preferences, shortcuts: { ...this.preferences.shortcuts } }));
    ipcMain.handle("settings:update", (_e, preferences: unknown, activateShortcuts?: boolean) =>
      this.updatePreferences(preferences, activateShortcuts === true),
    );
    ipcMain.handle("settings:shortcuts", (_e, shortcuts: unknown) => this.setKeyboardShortcuts(shortcuts));

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
    ipcMain.handle("worldline:promote", (_e, comparisonId: string, label: "A" | "B", force?: boolean) => this.promoteCandidate(comparisonId, label, force ?? false));
    ipcMain.handle("worldline:challenge", async (_e, runId: string) => {
      const run = [...this.runsByTerminal.values()].flat().find((r) => r.id === runId);
      if (!run) return { ok: false, error: "run not found" };
      if (!run.promptPayloadFile) return { ok: false, error: "the run has no captured task to replay" };
      this.initWorldlines();
      const forkable: ForkableRun = {
        id: run.id,
        terminalId: run.terminalId,
        startStateId: run.startStateId,
        settledStateId: run.settledStateId,
        promptPayloadFile: run.promptPayloadFile,
        promptEventsDir: run.promptEventsDir,
        promptEntryId: run.promptEntryId,
        promptParentEntryId: run.promptParentEntryId,
        settledEntryId: run.settledEntryId,
        sessionBranchFile: run.sessionBranchFile,
        replayable: run.replayable,
        reason: run.reason,
        model: run.model,
        thinkingLevel: run.thinkingLevel,
        startedAt: run.startedAt,
        trustHashes: run.trustHashes,
        trusted: run.trusted,
      };
      return this.worldlines!.forkRun(forkable, { challenge: true });
    });
    ipcMain.handle("worldline:evidence", (_e, comparisonId: string) => this.runEvidence(comparisonId));
    ipcMain.handle("worldline:fork-point", async (_e, terminalId: string, seq: number) => {
      const inst = this.terminals.get(terminalId);
      if (!inst) return { ok: false, error: "terminal not found" };
      const ev = inst.timeline.find((e) => e.seq === seq);
      // Expected-version checks: the dot must exist with its state and
      // entry, and the state must still exist.
      if (!ev) return { ok: false, error: "timeline moment not found" };
      if (!ev.stateId || !ev.entryId || ev.evicted) {
        return { ok: false, error: ev.evicted ? "this moment's source state was evicted" : "this moment is not forkable" };
      }
      // A nested moment lives inside a candidate: its session is the
      // candidate's live session and its lineage base is the ROOT run
      // start (R) — promotion then includes every ancestor change.
      const nested = this.worldlines?.candidateContextOf(terminalId) ?? null;
      const run = [...this.runsByTerminal.values()]
        .flat()
        .find((r) => r.startedAt <= ev.ts && (r.settledAt === null || r.settledAt >= ev.ts));
      const rootRun = nested
        ? [...this.runsByTerminal.values()].flat().find((r) => r.id === nested.sourceRunId) ?? run
        : run;
      const sessionFile = nested?.sessionFile ?? run?.sessionFile;
      if (!sessionFile) return { ok: false, error: "the run session is unavailable" };
      this.initWorldlines();
      return this.worldlines!.forkPoint({
        terminalId,
        stateId: ev.stateId,
        entryId: ev.entryId,
        model: ev.model ?? rootRun?.model ?? null,
        thinkingLevel: rootRun?.thinkingLevel ?? null,
        sessionFile,
        sourceRunId: rootRun?.id ?? "",
        baseStateId: rootRun?.startStateId ?? null,
        inheritTrust: rootRun?.trusted === true ? true : null,
      });
    });
    ipcMain.handle("worldline:details", (_e, comparisonId: string, label: "A" | "B") => this.worldlines?.details(comparisonId, label) ?? { ok: false, error: "worldlines unavailable" });
    ipcMain.handle("worldline:compare", (_e, comparisonId: string) => this.worldlines?.compare(comparisonId) ?? { ok: false, error: "worldlines unavailable" });
    ipcMain.handle("worldline:challenge-candidate", (_e, comparisonId: string, label: "A" | "B") => this.worldlines?.challengeFromCandidate(comparisonId, label) ?? { ok: false, error: "worldlines unavailable" });
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
        promptEventsDir: run.promptEventsDir,
        promptEntryId: run.promptEntryId,
        promptParentEntryId: run.promptParentEntryId,
        settledEntryId: run.settledEntryId,
        sessionBranchFile: run.sessionBranchFile,
        replayable: run.replayable,
        reason: run.reason,
        model: run.model,
        thinkingLevel: run.thinkingLevel,
        startedAt: run.startedAt,
        trustHashes: run.trustHashes,
        trusted: run.trusted,
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
        const dir = await mkdtemp(join(app.getPath("temp"), "termina-state-"));
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
      const managed = inst ? this.managedPath(path) : null;
      if (!inst || !managed || managed.workspace.id !== inst.workspaceId) return { status: "modified", baseline: undefined };
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
          await rm(p, { force: true }); // the agent created it → delete
        } else {
          await writeFile(p, b, "utf8");
        }
        this.deleteBaseline(inst, p);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    ipcMain.handle("file:open", (_e, absPath: string) => this.openFileInEditor(absPath));
    ipcMain.handle("file:save", async (_e, absPath: string, content: string) => {
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
    const managed = this.managedPath(absPath);
    if (!managed) return { path: absPath, error: "path is outside a managed workspace" };
    try {
      const st = await stat(managed.path);
      if (!st.isFile()) return { path: managed.path, error: "not a file" };
      if (st.size > MAX_OPEN_FILE_SIZE) return { path: managed.path, error: `file is too large to open (${st.size} bytes)` };
      const content = await readFile(managed.path, "utf8");
      return { path: managed.path, content };
    } catch (err) {
      return { path: managed.path, error: (err as Error).message };
    }
  }

  // ---------------------------------------------------------------- boot ----

  async start(): Promise<void> {
    this.preferences = await this.preferencesStore.load();
    this.shortcutMap = { ...this.preferences.shortcuts };
    this.registerIpc();
    // Set the project BEFORE the window loads: the renderer queries the
    // project (test detection, cwd) as soon as it boots, and terminalCwd()
    // must already point at the real folder — otherwise it answers with the
    // home directory and the Verify button stays disabled forever.
    const initial = process.env.TERMINA_INITIAL_CWD;
    this.projectCwd = initial && existsSync(initial) ? initial : null;
    this.tailer.onEvent = (id, event) => this.enqueueSidecarEvent(id, event);
    this.tailer.start();
    // Write the bridge before the first terminal starts: pi loads it with
    // the CLI extension option on every agent launch, with or without a
    // project folder.
    this.ensureAppBridge();
    await this.createWindow();
    if (this.projectCwd) {
      // Finish or roll back any pending promotion journal BEFORE the primary
      // watcher starts: the restored bytes must not attribute to a user edit.
      await this.recoverPromotions();
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

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.preferencesStore.flush();
    await this.drainVerifyJobs();
    this.tailer.stop();
    await this.drainSidecarQueues();
    this.sidecarQueues.clear();
    await this.evidenceQueue.catch(() => undefined);
    await this.worldlines?.dispose().catch((err) => console.warn(`[main] worldline cleanup failed: ${String(err)}`));
    coreClient.dispose();
    this.worldlines = null;
    for (const ws of this.workspaces.values()) ws.watcher?.stop();
    for (const inst of this.terminals.values()) inst.pty.kill();
    await this.drainTerminals();
    for (const inst of this.terminals.values()) {
      for (const event of inst.timeline) {
        if (event.stateId) void this.releaseStateIfUnused(event.stateId, inst.id, event.seq);
      }
    }
    this.clearRunRecords();
    this.evidenceByComparison.clear();
    this.workspaces.clear();
    this.terminals.clear();
    for (const tailer of this.worldlineTailers.values()) tailer.stop();
    this.worldlineTailers.clear();
    await this.teardownRecording().catch((err) => console.warn(`[main] recording cleanup failed: ${String(err)}`));
    this.sessionWorker.dispose();
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

let quitConfirmed = false;
let cleanupComplete = false;
let cleanupStarted = false;
app.on("before-quit", (event) => {
  if (cleanupComplete) return;
  event.preventDefault();
  if (cleanupStarted) return;
  if (quitConfirmed) {
    cleanupStarted = true;
    void appState.dispose().then(() => {
      cleanupComplete = true;
      app.quit();
    });
    return;
  }
  cleanupStarted = true;
  void appState.confirmDiscardActiveCandidates().then((ok) => {
    cleanupStarted = false;
    if (!ok) return;
    quitConfirmed = true;
    app.quit();
  });
});