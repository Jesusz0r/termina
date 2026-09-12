/**
 * Electron main process — terminal-first architecture.
 *
 * Left side: real agent-core interactive TUI instances running in ptys (node-pty).
 * Right side: Monaco IDE + explorer, live-synced by the file watcher.
 * The agent-core host streams agent events (tool calls, busy
 * state) to sidecar files we tail — that powers auto-open of files
 * mid-run and the modified-files panel.
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain as electronIpcMain, Menu, nativeTheme } from "electron";

// Name the app for the macOS menu bar and user-data paths. Unpackaged runs default to "Electron".
app.setName("Termina");
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { access, cp, lstat, mkdir, readFile, readdir, realpath as fsRealpath, rename as fsRename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionForkClient } from "./session-fork.js";
import { SessionRetentionOwner } from "./session-retention.js";
import {
  isPtyDocumentCurrent,
  isPtyFrameEventCurrent,
  isPtyLifecycleCurrent,
  isPtyRendererSendTargetCurrent,
  isPtyReadyHandshakeCurrent,
  PtyEgressScheduler,
  sendPtyRendererMessage,
  type PtyDocumentIdentity,
  type PtyLifecycleIdentity,
  type PtyRendererSendTarget,
} from "./pty-egress.js";
import { AgentStartEvent, SidecarEvent, SidecarEventDelivery, SidecarEventQueue, SidecarTailer } from "./sidecar.js";
import { IGNORED_SEGMENTS, ProjectWatcher } from "./watcher.js";
import { SnapshotStore, bindOwnedDirectory, bindOwnedEntry, boundPromotionEnsureDirectory, boundPromotionListEntries, boundPromotionOpenDirectory, boundPromotionReadFile, captureRootInRepo, createOwnedDirectory, disposeWorldlineGitCore, gitCommonDir, gitHead, gitObjectFormat, gitTopLevel, gitTrackedFiles, removeBoundOwnedDirectory, removeBoundOwnedEntry, trustResourceHashes, type BoundPromotionExpectedLeaf, type PromotionFsIdentity, type SourceState, writeBoundOwnedFile } from "./worldline-git.js";
import { EvidenceHomeStore } from "./evidence-home.js";
import { benchmarkConfigFrom, detectTestCommand, detectTestFromState } from "./verify-detect.js";
import { WorldlineManager, quoteShellArg, recoverPromotionJournals, type RunRecord } from "./worldlines/index.js";
import { worldlineAppReadPaths, worldlineCaptureHead, worldlineCapturePrimary, worldlinePreflight } from "./worldlines/bootstrap.js";
import {
  candidateSandboxLaunch,
  evidenceProfileContent,
  filterCandidateEnvironment,
  terminateSandboxProcessGroup,
} from "./sandbox.js";
import { parseFailingTests, verifyFailSummary } from "./evidence.js";
import { changedLinesInAfter } from "../shared/line-diff.js";
import { createAppUpdater, updateMenuCopy, type AppUpdateController } from "./app-update.js";
import { installCliCommand, uninstallCliCommand, isCliCommandInstalled, parseTargetCwdFromArgv } from "./cli-install.js";
import {
  MAX_DISPATCH_WORKERS,
  findTaskByText,
  finalizePlanTasks,
  formatDispatchBriefing,
  markPlanProgress,
  parsePlanTasks,
  parseScheduleMarker,
  pickDispatchTasks,
  reattachDispatchAssignments,
  taskIsComplete,
} from "./plan-board.js";
import { AppPreferencesStore } from "./preferences.js";
import { SubagentHost } from "./subagents.js";
import { anchorClaimPath, isSubagentManagedFile } from "../agent-core/subagents.js";
import { MAX_SESSION_SEARCH_QUERY, collectSessionSearchFiles } from "./session-search.js";
import { DiagnosticsRunner } from "./diagnostics.js";
import { ScheduleRunner, type ScheduleTickTask } from "./schedule.js";
import { ProjectPathIndex, SearchGenerations, listProjectSnapshot, searchProjectFiles } from "./quick-open.js";
import { searchProjectContent } from "./content-search.js";
import { appendPendingImages, MAX_PENDING_IMAGES, pendingImageState } from "../agent-core/host.js";
import {
  coreSessionFile as bundleSessionFile,
  isCoreSessionId,
  parseSessionBundlePath,
  sessionBundleHasContent,
} from "../agent-core/session.js";
import {
  isAuthorizedDropSender,
  normalizeDroppedPaths,
  quotePosixPaths,
  readDroppedImages,
  validatePathDropTargets,
} from "./terminal-drop.js";
import {
  MAX_TERMINAL_ROSTER,
  type TerminalRosterEntry,
} from "./terminal-roster.js";
import { TerminalRosterStore, loadRosterFile, rosterFilePath, type RosterTerminal } from "./roster-store.js";
import { AgentTerminalInstance } from "./terminal-instance.js";
import { PathLookup } from "./path-lookup.js";
import { normalizeAppPreferences, normalizeUserPreferencePatch, recordRecentFile, recordRecentModel, sanitizeShortcutMap } from "../shared/preferences.js";
import { HIDE_THINKING_CSI, SHOW_THINKING_CSI, thinkingStartupArgs } from "../shared/terminal-control.js";
import { validateGrepPattern } from "../shared/grep-pattern.js";
import {
  DEFAULT_SHORTCUTS,
  defaultAppPreferences,
  type AppPreferences,
  CHALLENGE_PROFILES,
  type ChallengeProfile,
  type CommandId,
  type ContentHit,
  type ExplorerEntry,
  type InstanceSummary,
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
  type ProjectWorkspaceRef,
  type RendererIpcCapability,
  type VerifyState,
} from "../shared/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MAX_OPEN_FILE_SIZE = 2 * 1024 * 1024;
const MAX_PROMPT_BYTES = 20 * 1024 * 1024;
/** Bound for ~/.termina/agent/auth.json when checking whether a provider exists. */
const MAX_AUTH_JSON_BYTES = 128 * 1024;

function isChallengeProfile(value: unknown): value is ChallengeProfile {
  return typeof value === "string" && (CHALLENGE_PROFILES as readonly string[]).includes(value);
}
const MAX_CLIPBOARD_BYTES = 4 * 1024 * 1024;
const MAX_EXPLORER_ENTRIES = 2000;
const MAX_VERIFY_OUTPUT = 200_000;
/** Bound for one project snapshot context file (tree listing for a turn). */
const MAX_PROJECT_SNAPSHOT_BYTES = 12 * 1024;
/** Debounce for snapshot refresh after watcher bursts. */
const PROJECT_SNAPSHOT_DEBOUNCE_MS = 5000;
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
/** Bound one checkpoint's watcher-idle barrier without blocking main. */
const CHECKPOINT_IDLE_WAIT_MS = 1000;

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
  /** Re-entrancy depth for nested write lease acquisition. */
  leaseDepth?: number;
  watcher: ProjectWatcher | null;
  terminalIds: Set<string>;
  /** The last captured state commit (the lineage parent). */
  lastStateCommit: string | null;
  /** Serializes incremental moment captures so siblings never snapshot the same parent. */
  momentCapturePromise: Promise<void> | null;
  /** Last wall-clock reseed after a capture failure (bounds retries). */
  lastReseedMs: number;
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
 * Host agent session variables. The app's agent TUI must start clean — a pinned
 * session file or model makes the TUI attach to the wrong session or hang.
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

/** The environment for an agent process: the host env minus session pins. */
function cleanEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!AGENT_ENV_BLOCKLIST.has(key)) env[key] = value;
  }
  // The packaged bundle ships its own node for the agent. Put it first on
  // PATH so the agent binary and its child processes resolve it.
  const bundledNode = join(process.resourcesPath, "node", "bin");
  if (existsSync(bundledNode)) {
    env.PATH = `${bundledNode}${env.PATH ? `:${env.PATH}` : ""}`;
  }
  return env;
}

/**
 * Bundled agent-core entry. ELECTRON_RUN_AS_NODE cannot read inside the
 * asar; spawn the unpacked copy.
 */
function coreEngineBinary(): string {
  return join(__dirname, "agent-core.mjs").replace("app.asar", "app.asar.unpacked");
}

/**
 * Candidate processes get a minted environment capability, never the ordinary
 * terminal environment. The selected provider is the only ambient credential
 * namespace that may cross the boundary; copied auth files remain preferred.
 */
function candidateEnv(provider: string | null): Record<string, string | undefined> {
  const bundledNode = join(process.resourcesPath, "node", "bin");
  return filterCandidateEnvironment(process.env, provider, existsSync(bundledNode) ? [bundledNode] : []);
}

/** Thinking levels the agent accepts. Reject anything else at spawn. */
const AGENT_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MAX_AGENT_MODEL_CHARS = 256;
const MAX_AGENT_USAGE_CHARS = 512;

/**
 * True for the e2e suite, which drives this same app in a real window. A shown
 * window takes the user's focus for the whole run, so the suite asks for a
 * window that is never displayed (tests/e2e/fixtures.ts sets TERMINA_E2E_HIDDEN).
 * `backgroundThrottling` stays off because Chromium throttles timers in hidden
 * windows, which would change the timing the tests assert against. Absent the
 * variable, launch behavior is exactly as before.
 */
const E2E_HIDDEN_WINDOW = process.env.TERMINA_E2E_HIDDEN === "1";

/** One background process that runs a test command. */
interface VerifyJob {
  child: ReturnType<typeof spawn>;
  interrupted: boolean;
  /** One idempotent process-group cleanup operation for this worker. */
  cleanup: (signal: NodeJS.Signals, graceMs?: number) => Promise<boolean>;
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

function isUnsavedConfirmResult(value: unknown): value is { ok: boolean; cancelled?: boolean; error?: string } {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as { ok?: unknown; cancelled?: unknown; error?: unknown };
  if (typeof rec.ok !== "boolean") return false;
  if (rec.cancelled !== undefined && typeof rec.cancelled !== "boolean") return false;
  if (rec.error !== undefined && typeof rec.error !== "string") return false;
  return true;
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

/** Stop waiting for a candidate tailer when its owning startup attempt closes. */
function awaitCandidateAbortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("candidate startup was cancelled"));
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      rejectPromise(new Error("candidate startup was cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        rejectPromise(error);
      },
    );
  });
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
  /** Identity captured at the explicit project-open admission boundary. */
  primaryRootIdentity: PromotionFsIdentity;
  /** One workspace per source tree: the primary plus candidates. */
  workspaces: Map<string, WorkspaceState>;
  /** The app-owned snapshot store of this project, or null. */
  storePromise: Promise<SnapshotStore | null> | null;
  /** The store directory (app-owned, outside the project). */
  storeDir: string | null;
  /** Files the user marked as theirs (canonical paths). The agent is told
   *  not to modify them without asking. */
  mineFiles: Set<string>;
  /** Serializes Mine mutations and their two persisted views. */
  mineCommit: Promise<void>;
  /** The worldline manager (Fork Run candidates). */
  worldlines: WorldlineManager | null;
  /** Terminal ids owned by this project (agents, shells, candidates). */
  terminalIds: Set<string>;
  /** Activation epoch of the last folder push for this project, or zero. */
  activationGeneration: number;
  /** Roster entries that failed to spawn this session. Keep them on disk so a later launch can retry. */
  unrestoredTerminals: TerminalRosterEntry[];
}

/** Env vars the agent treats as a provider credential (see agent-core providers). */
const AGENT_PROVIDER_ENV = [
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

/** True when process env already supplies an agent provider key. */
function envHasAgentProvider(env: NodeJS.Dict<string | undefined>): boolean {
  for (const key of AGENT_PROVIDER_ENV) {
    if (env[key]) return true;
  }
  return false;
}

/** True when core auth.json holds at least one provider credential
 *  (api_key with a key, or oauth with a refresh token). */
function authJsonHasCoreCredential(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  for (const value of Object.values(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const type = typeof entry.type === "string" ? entry.type : "";
    if (type === "oauth" && typeof entry.refresh === "string" && entry.refresh.length > 0) return true;
    if (type === "api_key" && typeof entry.key === "string" && entry.key.length > 0) return true;
  }
  return false;
}

let quitConfirmed = false;
let cleanupComplete = false;
let cleanupStarted = false;
let rendererWindowGenerationSeq = 0;
let rendererGenerationSeq = 0;
let rendererLoadGenerationSeq = 0;

class TerminaApp {
  private win: BrowserWindow | null = null;
  private terminals = new Map<string, AgentTerminalInstance>();
  /** In-flight initial project/terminal restoration on app boot. */
  private initialRestorePromise: Promise<void> | null = null;
  /** True only while the current renderer can consume pushed IPC. */
  private rendererReady = false;
  /** BrowserWindow identity and current renderer-document generations. */
  private rendererWindowGeneration = 0;
  private rendererGeneration = 0;
  /** Main-issued capability for the current renderer document. */
  private rendererDocumentNonce = "";
  /** Exact main-frame load/process identity for same-WebContents callbacks. */
  private rendererLoadGeneration = 0;
  private rendererProcessId = 0;
  private rendererFrameRoutingId = 0;
  private rendererLoadPending = false;
  /** Snapshot that state-changing load callbacks must match before acting. */
  private rendererPendingLoad: PtyLifecycleIdentity | null = null;
  /** A crash/reload has invalidated the old document; the next main-frame
   * navigation supplies the replacement process/routing pair. */
  private rendererAwaitingNewFrame = false;
  /** Exact frame pair invalidated by the most recent renderer crash. */
  private rendererCrashedFrame: { processId: number; frameRoutingId: number } | null = null;
  /** Only this app document may receive a privileged renderer capability. */
  private trustedRendererProtocol: "file:" | "http:" | "https:" | null = null;
  private trustedRendererOrigin: string | null = null;
  private trustedRendererFilePath: string | null = null;
  /** The single lossless PTY→renderer delivery owner. */
  private ptyEgress = new PtyEgressScheduler({
    send: (terminalId, terminalGeneration, windowGeneration, rendererGeneration, sequence, data) =>
      this.sendPtyChunk(terminalId, terminalGeneration, windowGeneration, rendererGeneration, sequence, data),
    sendExit: (terminalId, terminalGeneration, windowGeneration, rendererGeneration, sequence, code) =>
      this.sendPtyExit(terminalId, terminalGeneration, windowGeneration, rendererGeneration, sequence, code),
  });

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
    return projectId !== undefined
      && (this.switchingProjects.has(projectId) || this.projectClosePromises.has(projectId));
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
  private loginHintWatcher: FSWatcher | null = null;
  private loginHintTimer: ReturnType<typeof setTimeout> | null = null;
  private eventsDir = process.env.TERMINA_EVENTS_DIR ?? join(app.getPath("temp"), "termina-sidecars");
  /** The app-private session branch workspace. */
  private sessionWorkspaceDir = join(this.eventsDir, "session-workspace");
  /** Identity of the events root bound during this launch. */
  private eventsDirBinding: PromotionFsIdentity | null = null;
  /** True only when the persisted root provenance matched this launch. */
  private eventsDirProvenanceTrusted = false;
  private tailer = new SidecarTailer(this.eventsDir);
  /** Headless background subagent runs (SUBAGENTS-PLAN.md Phase 2). */
  private subagents = new SubagentHost({
    eventsDirFor: (terminalId) => {
      const inst = this.terminals.get(terminalId);
      return inst ? this.eventsDirOf(inst) : null;
    },
    baseEnv: () => cleanEnv(),
    coreBinary: () => coreEngineBinary(),
    sessionRootFor: (cwd) => this.coreProjectSessionDir(cwd),
    appendMailboxNote: (terminalId, note) => this.appendMailboxNote(terminalId, note),
    watchStream: (terminalId) => this.tailer.watch(terminalId),
    releaseStream: (terminalId) => {
      this.tailer.stopWatching(terminalId);
      this.sidecarQueues.delete(terminalId);
    },
    dispatchKeysFor: async (ownerId) => {
      const owner = this.terminals.get(ownerId);
      if (!owner) return { keys: new Set<string>(), root: "" };
      const ws = this.workspaceOfTerminal(owner);
      const root = ws?.root ?? owner.cwd;
      return { keys: await this.dispatchPathKeysInFlight(ownerId, root), root };
    },
    canonicalPath: (p) => this.canonicalPath(p),
    isWorldlineTerminal: (terminalId) =>
      this.worldlineTailers.has(terminalId) || this.isWorldlineTerminal(terminalId),
    workspaceRootFor: (terminalId) => {
      const inst = this.terminals.get(terminalId);
      if (!inst) return null;
      const ws = this.workspaceOfTerminal(inst);
      return { root: ws?.root ?? inst.cwd, cwd: inst.cwd };
    },
    // Primary terminals start in `ask` (no TERMINA_CORE_APPROVE bypass at
    // launch); only an explicit host-level opt-in lets a child auto-approve.
    // Worldline candidates never qualify: the host refuses their spawns.
    autoApproveAllowedFor: (terminalId) =>
      !this.worldlineTailers.has(terminalId)
      && !this.isWorldlineTerminal(terminalId)
      && cleanEnv().TERMINA_CORE_APPROVE === "all",
  });
  private paintWatchdog: ReturnType<typeof setInterval> | null = null;
  private appUpdater: AppUpdateController | null = null;
  private installingUpdate = false;
  /** In-flight background verify runs by owner terminal id. */
  private verifyRuns = new Set<string>();
  /** Background static diagnostics; main supplies live reads into app state. */
  private diagnostics = new DiagnosticsRunner({
    workspaceById: (workspaceId) => this.workspaceById(workspaceId),
    isProjectSwitching: (workspaceId) => {
      const owner = this.projectOfWorkspace(workspaceId);
      return !owner || this.projectIsSwitching(owner.id);
    },
    isDisposed: () => this.disposed,
    isTerminalCurrent: (inst) => this.terminals.get(inst.id) === inst && !inst.closed,
    eventsTarget: (terminalId) => {
      // finish() already gated on isTerminalCurrent, so this is the run's terminal.
      const inst = this.terminals.get(terminalId);
      if (!inst) return null;
      const binding = this.eventsBindingOf(inst);
      if (!binding) return null;
      return { dir: this.eventsDirOf(inst), binding };
    },
    cleanEnv: () => cleanEnv(),
  });
  /** Debounced snapshot refresh timers by workspace id. */
  private projectSnapshotTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
  /** Background schedule tick; main supplies live reads into app state. */
  private schedules = new ScheduleRunner({
    isDisposed: () => this.disposed,
    agentTasks: () => this.agentScheduleTasks(),
    dispatchRun: (ownerId, taskText) => this.dispatchRun(ownerId, taskText),
  });
  /** Owner terminal id → task text awaiting an automatic verify after a
   *  dispatch worker settled with its task done. Consumed once by the
   *  verify finish path; never retried. */
  private autoVerifyTasks = new Map<string, string>();
  /** Owner terminal id → consecutive failed verifies (manual or auto).
   *  Seeded by any failure, consumed by the loop below. Pass, cancel, or
   *  terminal close clears it. */
  private autoVerifyFailures = new Map<string, number>();
  /** Consecutive failed verifies before the automatic loop stops. */
  private static readonly MAX_AUTO_VERIFY_ATTEMPTS = 3;
  /** True after the native owner has bound the events directory. */
  private eventsDirReady = false;

  /** Files the user changed while no agent terminal was busy. The agent
   *  receives them on its next turn. It adapts instead of overwriting them.
   *  One map per workspace. */
  private userEditsByWorkspace = new Map<string, Map<string, UserEdit>>();

  /** The session-fork client. Bundle forks run in the worker. */
  private sessionFork = new SessionForkClient();

  /** The app-owned worlds root. */
  private userDataDir = process.env.TERMINA_USER_DATA_DIR ?? app.getPath("userData");
  /** Durable provenance for the launch-persistent events root. */
  private eventsDirAnchorPath = join(this.userDataDir, "termina-events-root.json");
  /** Durable root for core finalization artifacts, separate from launch scratch. */
  private retainedSessionRoot = join(this.userDataDir, "retained-sessions");
  private sessionRetention = new SessionRetentionOwner(this.retainedSessionRoot);
  private preferencesStore = new AppPreferencesStore(join(this.userDataDir, "preferences.json"));
  private preferences: AppPreferences = defaultAppPreferences();
  private preferenceCommits: Promise<void> = Promise.resolve();
  /** Terminal roster persistence; main supplies live terminals when saving. */
  private rosterStore = new TerminalRosterStore({
    usableModel: (model) => this.usableAgentModel(model),
  });
  private shortcutMap: ShortcutMap = { ...DEFAULT_SHORTCUTS };
  private worldsRoot = process.env.TERMINA_WORLDS_DIR ?? join(this.userDataDir, "worlds");
  /** Input buffer for /clear (/new alias) slash-command detection (terminals:write is per keystroke). */
  private newCommandBuffers = new Map<string, string>();
  /** Tailers for candidate events directories. */
  private worldlineTailers = new Map<string, SidecarTailer>();
  /** Preserve event order while bounding sidecar fanout per terminal. */
  private sidecarQueues = new Map<string, SidecarEventQueue>();
  /** One-use start preflights by token. */
  private pendingPreflights = new Map<string, PendingPreflight>();
  /** Capture tasks that must finish before store teardown. */
  private recordingTasks = new Set<Promise<unknown>>();
  /** Asynchronous bridge acknowledgements accepted from sidecar events. */
  private ackWrites = new Set<Promise<void>>();
  /** Renderer flush requests awaiting their report. */
  private flushWaiters = new Map<string, { workspaceId: string; resolve: (r: { ok: boolean; failed: string[] }) => void; timer: ReturnType<typeof setTimeout> }>();
  private flushSeq = 0;
  /** Renderer unsaved-buffer confirms awaiting their report. */
  private unsavedWaiters = new Map<string, { resolve: (r: { ok: boolean; cancelled?: boolean; error?: string }) => void; timer: ReturnType<typeof setTimeout> }>();
  private unsavedSeq = 0;
  /** Per-caller file:search generations; older same-caller walks abort so fast
   *  typing never stacks full-tree walks. */
  private fileSearchSeq = new SearchGenerations(["quick-open", "filter"] as const, "quick-open");
  /** Per-caller content:search generations; older same-caller searches abort. */
  private contentSearchSeq = new SearchGenerations(["modal", "explorer"] as const, "modal");
  /** Cached project file list for Quick Open; patched by watcher events. */
  private readonly pathIndex = new ProjectPathIndex();
  private userEditsWriteTimer: ReturnType<typeof setTimeout> | null = null;
  /** Paths the promotion is applying right now (suppress user-edit records). */
  private promotionPaths: Set<string> | null = null;
  /** Evidence homes retain the same provenance across the measurement. */
  private evidenceHomes = new EvidenceHomeStore({
    eventsDir: () => this.eventsDir,
    eventsBinding: () => this.eventsDirBinding,
  });
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
  /** One close confirmation/teardown transaction per project. */
  private projectClosePromises = new Map<string, Promise<{ ok: boolean; error?: string; cancelled?: boolean }>>();
  private folderOpenPromise: Promise<{ cwd: string } | { cancelled: true }> | null = null;
  /** Monotonic project-selection epoch carried by folder/close pushes. */
  private projectActivationGeneration = 0;
  /** Latest action that is allowed to claim the active-project slot. */
  private projectSelectionAction = 0;
  private projectSelectionActionSeq = 0;

  private beginProjectSelectionAction(): number {
    const action = ++this.projectSelectionActionSeq;
    this.projectSelectionAction = action;
    return action;
  }

  private nextProjectActivationGeneration(): number {
    return ++this.projectActivationGeneration;
  }

  /** Validate the shape of a renderer capability before comparing it. */
  private parseRendererCapability(value: unknown): RendererIpcCapability | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const rec = value as Record<string, unknown>;
    const integer = (key: string): number | null => {
      const n = rec[key];
      return typeof n === "number" && Number.isSafeInteger(n) && n >= 1 ? n : null;
    };
    const windowGeneration = integer("windowGeneration");
    const rendererGeneration = integer("rendererGeneration");
    const loadGeneration = integer("loadGeneration");
    const processId = integer("processId");
    const frameRoutingId = integer("frameRoutingId");
    const nonce = rec.nonce;
    if (
      windowGeneration === null
      || rendererGeneration === null
      || loadGeneration === null
      || processId === null
      || frameRoutingId === null
      || typeof nonce !== "string"
      || nonce.length < 16
      || nonce.length > 128
    ) return null;
    return { windowGeneration, rendererGeneration, loadGeneration, nonce, processId, frameRoutingId };
  }

  /** Configure the one URL/protocol that is allowed to host the app bridge. */
  private configureTrustedRendererTarget(devUrl: string | undefined): void {
    this.trustedRendererProtocol = null;
    this.trustedRendererOrigin = null;
    this.trustedRendererFilePath = null;
    if (devUrl) {
      try {
        const url = new URL(devUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:") return;
        this.trustedRendererProtocol = url.protocol;
        this.trustedRendererOrigin = url.origin;
      } catch {
        // A malformed dev URL will fail at loadURL; fail closed for IPC too.
      }
      return;
    }
    this.trustedRendererProtocol = "file:";
    this.trustedRendererFilePath = resolve(join(__dirname, "..", "dist-renderer", "index.html"));
  }

  /** True only for the exact application origin (or packaged index file). */
  private isTrustedRendererUrl(value: unknown): boolean {
    if (typeof value !== "string" || !this.trustedRendererProtocol) return false;
    try {
      const url = new URL(value);
      if (url.protocol !== this.trustedRendererProtocol) return false;
      if (url.protocol === "file:") {
        if (!this.trustedRendererFilePath || url.hostname !== "") return false;
        return resolve(fileURLToPath(url)) === this.trustedRendererFilePath;
      }
      return url.origin === this.trustedRendererOrigin;
    } catch {
      return false;
    }
  }

  /** Bind capability checks to both the exact main frame and its trusted URL. */
  private isTrustedRendererFrame(frame: Electron.WebFrameMain | null | undefined, mainFrame: Electron.WebFrameMain | null | undefined): boolean {
    if (!frame || !mainFrame) return false;
    try {
      if (!this.isTrustedRendererUrl(frame.url) || !this.isTrustedRendererUrl(mainFrame.url)) return false;
      const top = frame.top;
      return frame.processId === mainFrame.processId
        && frame.routingId === mainFrame.routingId
        && !!top
        && top.processId === mainFrame.processId
        && top.routingId === mainFrame.routingId;
    } catch {
      // A frame wrapper can become invalid while a renderer is crashing or
      // navigating. Treat that lifecycle race as an unauthorized sender.
      return false;
    }
  }

  /**
   * Authenticate every renderer-originated invoke at one shared boundary.
   * A WebContents identity alone is insufficient because Chromium can reuse
   * it across navigations; the main-frame pair, document generations, and
   * main-issued nonce must all match the current lifecycle.
   */
  private isTrustedRenderer(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent, value: unknown): boolean {
    const win = this.win;
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return false;
    if (win.webContents.isDestroyed()) return false;
    try {
      if (win.webContents.isCrashed()) return false;
    } catch {
      return false;
    }
    const frame = event.senderFrame;
    const mainFrame = win.webContents.mainFrame;
    // WebFrameMain wrappers are not required to be object-identical across
    // getters. The process/routing pair is the stable frame identity and
    // rejects subframes even when they share a renderer process.
    if (!this.isTrustedRendererFrame(frame, mainFrame)) return false;
    const capability = this.parseRendererCapability(value);
    const current = this.currentPtyLifecycle();
    const identity = this.readIpcFrameIdentity(event);
    if (!capability || !current || !identity || this.rendererAwaitingNewFrame) return false;
    return capability.windowGeneration === current.windowGeneration
      && capability.rendererGeneration === current.rendererGeneration
      && capability.loadGeneration === current.loadGeneration
      && capability.nonce === current.nonce
      && capability.processId === identity.processId
      && capability.frameRoutingId === identity.frameRoutingId
      && capability.processId === current.processId
      && capability.frameRoutingId === current.frameRoutingId;
  }

  /** Register a privileged invoke handler behind the renderer capability gate. */
  private handleIpc(channel: string, listener: (...args: any[]) => any): void {
    electronIpcMain.handle(channel, (event, ...args) => {
      const capability = args.pop();
      if (!this.isTrustedRenderer(event, capability)) {
        throw new Error("unauthorized renderer");
      }
      return listener(event, ...args);
    });
  }

  /** Issue the current document capability only to its exact main frame. */
  private rendererCapabilityFor(event: Electron.IpcMainEvent): RendererIpcCapability | null {
    const win = this.win;
    if (!win || win.isDestroyed() || event.sender !== win.webContents || win.webContents.isDestroyed()) return null;
    const frame = event.senderFrame;
    const mainFrame = win.webContents.mainFrame;
    if (!this.isTrustedRendererFrame(frame, mainFrame)) return null;
    const current = this.currentPtyLifecycle();
    const identity = this.readIpcFrameIdentity(event);
    if (!current || !identity || this.rendererAwaitingNewFrame) return null;
    if (
      identity.processId !== current.processId
      || identity.frameRoutingId !== current.frameRoutingId
    ) return null;
    try {
      if (win.webContents.isCrashed()) return null;
    } catch {
      return null;
    }
    return {
      windowGeneration: current.windowGeneration,
      rendererGeneration: current.rendererGeneration,
      loadGeneration: current.loadGeneration,
      nonce: current.nonce,
      processId: identity.processId,
      frameRoutingId: identity.frameRoutingId,
    };
  }

  // ---------------------------------------------------------------- window --

  private currentPtyDocument(): PtyDocumentIdentity | null {
    if (!this.win) return null;
    return {
      window: this.win,
      windowGeneration: this.rendererWindowGeneration,
      rendererGeneration: this.rendererGeneration,
      nonce: this.rendererDocumentNonce,
    };
  }

  private currentPtyLifecycle(): PtyLifecycleIdentity | null {
    const document = this.currentPtyDocument();
    if (!document) return null;
    return {
      ...document,
      loadGeneration: this.rendererLoadGeneration,
      processId: this.rendererProcessId,
      frameRoutingId: this.rendererFrameRoutingId,
    };
  }

  /** True only for the exact BrowserWindow and renderer document captured by a callback. */
  private isCurrentPtyDocument(
    win: BrowserWindow,
    windowGeneration: number,
    rendererGeneration: number,
    nonce = this.rendererDocumentNonce,
  ): boolean {
    return isPtyDocumentCurrent(this.currentPtyDocument(), {
      window: win,
      windowGeneration,
      rendererGeneration,
      nonce,
    });
  }

  /** True only for the exact document/load/frame process captured by a callback. */
  private isCurrentPtyLifecycle(
    win: BrowserWindow,
    windowGeneration: number,
    rendererGeneration: number,
    nonce: string,
    loadGeneration: number,
    processId: number,
    frameRoutingId: number,
  ): boolean {
    return isPtyLifecycleCurrent(this.currentPtyLifecycle(), {
      window: win,
      windowGeneration,
      rendererGeneration,
      nonce,
      loadGeneration,
      processId,
      frameRoutingId,
    });
  }

  private readPtyFrameIdentity(win: BrowserWindow): { processId: number; frameRoutingId: number } | null {
    try {
      const frame = win.webContents.mainFrame;
      const processId = frame?.processId ?? win.webContents.getProcessId();
      const frameRoutingId = frame?.routingId;
      if (
        !Number.isSafeInteger(processId)
        || processId < 1
        || !Number.isSafeInteger(frameRoutingId)
        || frameRoutingId < 1
      ) return null;
      return { processId, frameRoutingId };
    } catch {
      return null;
    }
  }

  private readNavigationFrameIdentity(
    win: BrowserWindow,
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    frameProcessId: number,
    frameRoutingId: number,
  ): { processId: number; frameRoutingId: number } | null {
    const processId = details.frame?.processId ?? frameProcessId;
    const routingId = details.frame?.routingId ?? frameRoutingId;
    if (
      !Number.isSafeInteger(processId)
      || processId < 1
      || !Number.isSafeInteger(routingId)
      || routingId < 1
    ) return this.readPtyFrameIdentity(win);
    return { processId, frameRoutingId: routingId };
  }

  private readGoneProcessIdentity(
    win: BrowserWindow,
    event: Electron.Event,
  ): { processId: number; frameRoutingId: number; explicit: boolean } | null {
    const eventRecord = event as unknown as Record<string, unknown>;
    const senderFrame = eventRecord.senderFrame as { processId?: unknown; routingId?: unknown } | null | undefined;
    const processId = typeof eventRecord.processId === "number"
      ? eventRecord.processId
      : typeof senderFrame?.processId === "number" ? senderFrame.processId : undefined;
    const frameRoutingId = typeof eventRecord.frameRoutingId === "number"
      ? eventRecord.frameRoutingId
      : typeof senderFrame?.routingId === "number" ? senderFrame.routingId : undefined;
    if (
      typeof processId === "number"
      && Number.isSafeInteger(processId)
      && processId >= 1
      && typeof frameRoutingId === "number"
      && Number.isSafeInteger(frameRoutingId)
      && frameRoutingId >= 1
    ) return { processId, frameRoutingId, explicit: true };
    if (this.rendererProcessId >= 1 && this.rendererFrameRoutingId >= 1) {
      return {
        processId: this.rendererProcessId,
        frameRoutingId: this.rendererFrameRoutingId,
        explicit: false,
      };
    }
    const current = this.readPtyFrameIdentity(win);
    if (current) return { ...current, explicit: false };
    return null;
  }

  /** Read the exact process/frame pair that sent a renderer IPC message. */
  private readIpcFrameIdentity(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): { processId: number; frameRoutingId: number } | null {
    const processId = event.senderFrame?.processId ?? event.processId;
    const frameRoutingId = event.senderFrame?.routingId ?? event.frameId;
    if (
      !Number.isSafeInteger(processId)
      || processId < 1
      || !Number.isSafeInteger(frameRoutingId)
      || frameRoutingId < 1
    ) return null;
    return { processId, frameRoutingId };
  }

  /** Fence all queued delivery before a renderer document is replaced. */
  private advancePtyDocument(
    win: BrowserWindow,
    windowGeneration: number,
    processId = this.rendererProcessId,
    frameRoutingId = this.rendererFrameRoutingId,
  ): boolean {
    if (
      this.disposed
      || this.win !== win
      || this.rendererWindowGeneration !== windowGeneration
      || win.isDestroyed()
    ) return false;
    this.rendererReady = false;
    this.rendererGeneration = ++rendererGenerationSeq;
    this.rendererDocumentNonce = randomUUID();
    this.rendererLoadGeneration = ++rendererLoadGenerationSeq;
    this.rendererProcessId = processId;
    this.rendererFrameRoutingId = frameRoutingId;
    this.rendererLoadPending = true;
    this.rendererAwaitingNewFrame = false;
    this.rendererCrashedFrame = null;
    this.ptyEgress.setRendererReady(windowGeneration, this.rendererGeneration, false);
    this.rendererPendingLoad = this.currentPtyLifecycle();
    return true;
  }

  /**
   * Invalidate one crashed document and wait for Chromium's next main-frame
   * navigation to bind the replacement frame. Keeping the process/routing
   * fields at zero is intentional: delayed callbacks from the crashed frame
   * cannot satisfy the replacement load predicate before that navigation.
   */
  private invalidateCrashedPtyDocument(
    win: BrowserWindow,
    windowGeneration: number,
    processId: number,
    frameRoutingId: number,
  ): boolean {
    const current = this.currentPtyLifecycle();
    if (
      !current
      || !this.isCurrentPtyLifecycle(
        win,
        windowGeneration,
        current.rendererGeneration,
        current.nonce,
        current.loadGeneration,
        processId,
        frameRoutingId,
      )
    ) return false;
    this.rendererReady = false;
    this.rendererGeneration = ++rendererGenerationSeq;
    this.rendererDocumentNonce = randomUUID();
    this.rendererLoadGeneration = ++rendererLoadGenerationSeq;
    this.rendererProcessId = 0;
    this.rendererFrameRoutingId = 0;
    this.rendererLoadPending = true;
    this.rendererAwaitingNewFrame = true;
    this.rendererCrashedFrame = { processId, frameRoutingId };
    this.ptyEgress.setRendererReady(windowGeneration, this.rendererGeneration, false);
    this.rendererPendingLoad = this.currentPtyLifecycle();
    return true;
  }

  /** Begin a helper-triggered reload without borrowing the old frame pair. */
  private beginPtyDocumentReload(win: BrowserWindow, windowGeneration: number): boolean {
    const current = this.currentPtyLifecycle();
    if (
      !current
      || !this.isCurrentPtyDocument(win, windowGeneration, current.rendererGeneration)
      || win.isDestroyed()
    ) return false;
    this.rendererReady = false;
    this.rendererGeneration = ++rendererGenerationSeq;
    this.rendererDocumentNonce = randomUUID();
    this.rendererLoadGeneration = ++rendererLoadGenerationSeq;
    this.rendererProcessId = 0;
    this.rendererFrameRoutingId = 0;
    this.rendererLoadPending = true;
    this.rendererAwaitingNewFrame = true;
    this.rendererCrashedFrame = null;
    this.ptyEgress.setRendererReady(windowGeneration, this.rendererGeneration, false);
    this.rendererPendingLoad = this.currentPtyLifecycle();
    return true;
  }

  /** The only path allowed to request a renderer reload. */
  private reloadPtyDocument(win: BrowserWindow, windowGeneration: number): boolean {
    if (!this.beginPtyDocumentReload(win, windowGeneration)) return false;
    try {
      win.webContents.reload();
      return true;
    } catch {
      return false;
    }
  }

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
    const win = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 960,
      minHeight: 600,
      title: "Termina",
      backgroundColor,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 12 },
      ...(E2E_HIDDEN_WINDOW ? { show: false } : {}),
      webPreferences: {
        preload: join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        // Sandboxed: the preload may only use contextBridge/ipcRenderer/webUtils.
        sandbox: true,
        ...(E2E_HIDDEN_WINDOW ? { backgroundThrottling: false } : {}),
      },
    });
    const windowGeneration = ++rendererWindowGenerationSeq;
    const rendererGeneration = ++rendererGenerationSeq;
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    this.configureTrustedRendererTarget(devUrl);
    this.win = win;
    this.rendererWindowGeneration = windowGeneration;
    this.rendererGeneration = rendererGeneration;
    this.rendererDocumentNonce = randomUUID();
    this.rendererReady = false;
    this.rendererLoadGeneration = ++rendererLoadGenerationSeq;
    // Do not borrow a pre-navigation frame pair. The first
    // did-start-navigation callback binds the issued nonce to its exact
    // main-frame process/routing identity.
    this.rendererProcessId = 0;
    this.rendererFrameRoutingId = 0;
    this.rendererLoadPending = true;
    this.rendererAwaitingNewFrame = true;
    this.rendererCrashedFrame = null;
    this.rendererPendingLoad = this.currentPtyLifecycle();
    this.ptyEgress.setRendererReady(windowGeneration, rendererGeneration, false);
    win.removeMenu();

    // Attach lifecycle listeners before loading.  PTY output can arrive while
    // the first document or a reload is still being parsed; it stays in the
    // bounded egress queues until the new renderer has finished loading.
    win.on("closed", () => {
      if (this.win !== win || this.rendererWindowGeneration !== windowGeneration) return;
      this.rendererReady = false;
      this.rendererLoadPending = false;
      this.rendererAwaitingNewFrame = false;
      this.rendererCrashedFrame = null;
      this.rendererPendingLoad = null;
      this.ptyEgress.setRendererReady(windowGeneration, this.rendererGeneration, false);
      this.win = null;
      this.stopPaintWatchdog();
    });
    win.webContents.on("will-frame-navigate", (details) => {
      if (this.disposed || this.win !== win || this.rendererWindowGeneration !== windowGeneration || win.isDestroyed()) return;
      // No subframe is part of the application bridge. Deny it before a
      // foreign document can execute the preload, and apply the same origin
      // boundary to main-frame navigations initiated by page content.
      if (!details.isMainFrame || !this.isTrustedRendererUrl(details.url)) {
        details.preventDefault();
        return;
      }
      if (!this.rendererAwaitingNewFrame) this.beginPtyDocumentReload(win, windowGeneration);
    });
    // The bridge is privileged: deny every foreign top-frame navigation
    // before Chromium can commit it, and revoke the old document capability
    // before an allowed app-document navigation starts.
    win.webContents.on("will-navigate", (event, url) => {
      if (this.disposed || this.win !== win || this.rendererWindowGeneration !== windowGeneration || win.isDestroyed()) return;
      if (!this.isTrustedRendererUrl(url)) {
        event.preventDefault();
        return;
      }
      if (!this.rendererAwaitingNewFrame) this.beginPtyDocumentReload(win, windowGeneration);
    });
    win.webContents.on("will-redirect", (event, url, _isInPlace, isMainFrame) => {
      if (this.disposed || this.win !== win || this.rendererWindowGeneration !== windowGeneration || win.isDestroyed()) return;
      if (!isMainFrame) {
        event.preventDefault();
        return;
      }
      if (!this.isTrustedRendererUrl(url)) {
        event.preventDefault();
        return;
      }
      if (!this.rendererAwaitingNewFrame) this.beginPtyDocumentReload(win, windowGeneration);
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // The renderer needs no web permissions except the DOM clipboard that
    // Monaco copy/cut/paste and the copy buttons use. Deny everything else
    // so a future XSS cannot reach media, geolocation, notifications, or
    // devices. The already-privileged bridge owns terminal clipboard flows.
    win.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) =>
      callback(permission === "clipboard-read" || permission === "clipboard-sanitized-write"),
    );
    win.webContents.session.setPermissionCheckHandler((_webContents, permission) =>
      permission === "clipboard-read" || permission === "clipboard-sanitized-write",
    );
    win.webContents.on("did-start-navigation", (details, _url, _isInPlace, _isMainFrame, frameProcessId, frameRoutingId) => {
      if (this.disposed || this.win !== win || this.rendererWindowGeneration !== windowGeneration || win.isDestroyed()) return;
      if (!details.isMainFrame || details.isSameDocument) return;
      if (!this.isTrustedRendererUrl(details.url)) {
        // will-navigate/will-redirect normally prevent this path. Keep the
        // second guard for programmatic/redirect edge cases: once a foreign
        // document begins, its old capability is revoked before commit.
        if (!this.rendererAwaitingNewFrame) this.beginPtyDocumentReload(win, windowGeneration);
        try {
          win.webContents.stop();
        } catch {
          /* The navigation may already have torn down WebContents. */
        }
        return;
      }
      const identity = this.readNavigationFrameIdentity(win, details, frameProcessId, frameRoutingId);
      if (!identity) return;
      // Every non-same-document main-frame navigation is a new document
      // boundary, even when Chromium reuses the same process/routing pair.
      // The pending reload/crash path already minted its nonce before this
      // event; bind that nonce to the first replacement frame. Generic
      // finish/failure events below cannot mint or consume a token.
      if (this.rendererAwaitingNewFrame) {
        if (
          (this.rendererCrashedFrame
            && this.rendererCrashedFrame.processId === identity.processId
            && this.rendererCrashedFrame.frameRoutingId === identity.frameRoutingId)
        ) return;
        this.rendererProcessId = identity.processId;
        this.rendererFrameRoutingId = identity.frameRoutingId;
        this.rendererAwaitingNewFrame = false;
        this.rendererPendingLoad = this.currentPtyLifecycle();
        return;
      }
      // A user/programmatic navigation that was not initiated by one of the
      // helpers also replaces the document at this exact main-frame boundary.
      this.advancePtyDocument(win, windowGeneration, identity.processId, identity.frameRoutingId);
    });
    win.webContents.on("did-frame-finish-load", (_event, isMainFrame, frameProcessId, frameRoutingId) => {
      if (this.disposed || this.win !== win || this.rendererWindowGeneration !== windowGeneration || win.isDestroyed()) return;
      if (!isMainFrame || !this.rendererLoadPending || this.rendererAwaitingNewFrame) return;
      const current = this.currentPtyLifecycle();
      const pending = this.rendererPendingLoad;
      // The frame pair and current load generation are useful for rejecting
      // unrelated frames, but this callback has no document token. Even an
      // exact same-pair callback is ambiguous, so readiness changes only in
      // the nonce-bearing pty:ready handler below.
      if (!current || !pending || !isPtyFrameEventCurrent(current, pending, frameProcessId, frameRoutingId)) return;
    });
    win.webContents.on("did-fail-load", (_event, _errorCode, _errorDescription, _validatedURL, isMainFrame, frameProcessId, frameRoutingId) => {
      if (this.disposed || this.win !== win || this.rendererWindowGeneration !== windowGeneration || win.isDestroyed()) return;
      if (!isMainFrame || !this.rendererLoadPending || this.rendererAwaitingNewFrame) return;
      const current = this.currentPtyLifecycle();
      const pending = this.rendererPendingLoad;
      // The pending snapshot includes the navigation/load generation. The
      // event-specific main-frame process/routing pair must match it too;
      // delayed failures from a prior same-WebContents document are inert.
      // An exact same-pair failure is still ambiguous, so fail closed rather
      // than mutating readiness; the replacement's nonce-bearing ready proof
      // remains the only state-changing path.
      if (!current || !pending || !isPtyFrameEventCurrent(current, pending, frameProcessId, frameRoutingId)) return;
    });
    win.webContents.on("render-process-gone", (event, details) => {
      if (this.disposed || this.win !== win || this.rendererWindowGeneration !== windowGeneration || win.isDestroyed()) return;
      const current = this.currentPtyLifecycle();
      const identity = this.readGoneProcessIdentity(win, event);
      if (!current || !identity || !this.isCurrentPtyLifecycle(
        win,
        windowGeneration,
        this.rendererGeneration,
        this.rendererDocumentNonce,
        current.loadGeneration,
        identity.processId,
        identity.frameRoutingId,
      )) return;
      // Electron's public render-process-gone payload does not include a
      // process id. In that form only a currently crashed WebContents is
      // actionable; a delayed old-process event after a healthy replacement
      // is ignored. Test/instrumented payloads may provide explicit ids.
      if (!identity.explicit) {
        try {
          if (!win.webContents.isCrashed()) return;
        } catch {
          return;
        }
      }
      console.warn(`[main] renderer gone: ${details.reason}`);
      if (!this.invalidateCrashedPtyDocument(win, windowGeneration, identity.processId, identity.frameRoutingId)) return;
      try {
        win.webContents.reload();
      } catch {
        /* The crashed WebContents may already be destroyed. */
      }
    });

    if (devUrl) {
      await win.loadURL(devUrl);
      if (process.env.TERMINA_DEVTOOLS) win.webContents.openDevTools({ mode: "detach" });
    } else {
      await win.loadFile(join(__dirname, "..", "dist-renderer", "index.html"));
    }
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
          {
            id: "app-update",
            label: update.label,
            enabled: update.enabled,
            click: () => void this.handleUpdateMenuAction(),
          },
          {
            id: "cli-install",
            label: "Install 'termina' command in PATH…",
            click: () => void this.handleInstallCli(),
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
          { label: "Undo", accelerator: shortcut("undo"), click: send("undo") },
          { label: "Redo", accelerator: shortcut("redo"), click: send("redo") },
          { type: "separator" },
          // Cut/Copy/Paste route through the focused surface: the terminal
          // owns a canvas selection no system role can read, and Monaco's
          // EditContext renderer has no focused textarea for a native
          // cut/copy/paste to act on. System roles would eat the keystroke
          // and then no-op in the editor.
          { label: "Cut", accelerator: shortcut("cut"), click: send("cut") },
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
          { label: "Find in Terminal…", accelerator: shortcut("terminal-find"), click: send("terminal-find") },
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
          { label: "Quick Open…", accelerator: shortcut("quick-open"), click: send("quick-open") },
          { label: "Search File Contents…", accelerator: shortcut("content-search"), click: send("content-search") },
          { label: "Command Palette…", accelerator: shortcut("command-palette"), click: send("command-palette") },
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
    this.buildMenu();
  }

  private handleUpdateMenuAction(): void {
    const copy = updateMenuCopy(
      this.appUpdater?.getState() ?? { status: "disabled", currentVersion: app.getVersion() },
    );
    if (copy.kind === "install") void this.installAppUpdate();
    else if (copy.kind === "check") void this.checkAppUpdateFromMenu();
  }

  private async handleInstallCli(): Promise<void> {
    const win = this.win && !this.win.isDestroyed() ? this.win : undefined;
    if (isCliCommandInstalled()) {
      const choice = await dialog.showMessageBox(win ?? ({} as Electron.BrowserWindow), {
        type: "question",
        title: "Termina CLI Launcher",
        message: "The 'termina' command is already installed in your PATH.",
        detail: "Would you like to reinstall/repair the launcher or remove it from your PATH?",
        buttons: ["Reinstall / Repair", "Uninstall", "Cancel"],
        defaultId: 0,
        cancelId: 2,
      });
      if (choice.response === 0) {
        const res = await installCliCommand();
        if (res.ok) {
          const payload = {
            type: "info" as const,
            title: "Shell Command Reinstalled",
            message: "The 'termina' command was reinstalled successfully.",
            detail: `Installed in ${res.path ?? "/usr/local/bin/termina"}.\n\nYou can open any folder in Termina by running:\n  termina .\nin your terminal.`,
          };
          if (win) await dialog.showMessageBox(win, payload);
          else await dialog.showMessageBox(payload);
        } else {
          const payload = {
            type: "error" as const,
            title: "Install Failed",
            message: "Could not reinstall 'termina' command in PATH.",
            detail: res.error ?? "Unknown error",
          };
          if (win) await dialog.showMessageBox(win, payload);
          else await dialog.showMessageBox(payload);
        }
      } else if (choice.response === 1) {
        const res = await uninstallCliCommand();
        if (res.ok) {
          const payload = {
            type: "info" as const,
            title: "Shell Command Uninstalled",
            message: "The 'termina' command was removed from PATH.",
          };
          if (win) await dialog.showMessageBox(win, payload);
          else await dialog.showMessageBox(payload);
        } else {
          const payload = {
            type: "error" as const,
            title: "Uninstall Failed",
            message: "Could not remove 'termina' command from PATH.",
            detail: res.error ?? "Unknown error",
          };
          if (win) await dialog.showMessageBox(win, payload);
          else await dialog.showMessageBox(payload);
        }
      }
      return;
    }

    const res = await installCliCommand();
    if (res.ok) {
      const payload = {
        type: "info" as const,
        title: "Shell Command Installed",
        message: "The 'termina' command was installed successfully.",
        detail: `Installed in ${res.path ?? "/usr/local/bin/termina"}.\n\nYou can now open any folder in Termina by running:\n  termina .\nin your terminal.`,
      };
      if (win) await dialog.showMessageBox(win, payload);
      else await dialog.showMessageBox(payload);
    } else {
      const payload = {
        type: "error" as const,
        title: "Install Failed",
        message: "Could not install 'termina' command in PATH.",
        detail: res.error ?? "Unknown error",
      };
      if (win) await dialog.showMessageBox(win, payload);
      else await dialog.showMessageBox(payload);
    }
  }

  private setKeyboardShortcuts(raw: unknown): ShortcutMap {
    this.shortcutMap = sanitizeShortcutMap(raw, {} as ShortcutMap);
    this.buildMenu();
    return { ...this.shortcutMap };
  }

  private async commitPreferencePatch(patch: Partial<AppPreferences>, activateShortcuts: boolean, confirmReset = false): Promise<AppPreferences> {
    const operation = this.preferenceCommits.then(async () => {
      const candidate = normalizeAppPreferences({ ...this.preferences, ...patch });
      if (!Object.prototype.hasOwnProperty.call(patch, "openProjects")) {
        candidate.openProjects = this.preferences.openProjects;
      }
      if (!Object.prototype.hasOwnProperty.call(patch, "activeProject")) {
        candidate.activeProject = this.preferences.activeProject;
      }
      await this.preferencesStore.save(candidate, confirmReset ? { confirmReset: true } : undefined);
      const thinkingChanged = this.preferences.showThinking !== candidate.showThinking;
      this.preferences = candidate;
      nativeTheme.themeSource = candidate.theme === "light" ? "light" : "dark";
      if (activateShortcuts) this.shortcutMap = { ...candidate.shortcuts };
      this.buildMenu();
      if (thinkingChanged) {
        const seq = candidate.showThinking ? SHOW_THINKING_CSI : HIDE_THINKING_CSI;
        for (const inst of this.terminals.values()) {
          if (inst.type === "agent") inst.pty.write(seq);
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
    // "Reset all" is the explicit user confirmation that overwrites an
    // unreadable prefs file; every other save refuses until then.
    const reset = raw && typeof raw === "object" && raw !== null && "confirmReset" in raw
      ? (raw as { confirmReset?: boolean }).confirmReset === true
      : false;
    return this.commitPreferencePatch(patch, activate, reset);
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

  /** The workspace a terminal works in. Missing ownership fails closed. */
  private workspaceOfTerminal(inst: AgentTerminalInstance): WorkspaceState | null {
    const owner = this.projectOfTerminal(inst.id);
    return owner?.workspaces.get(inst.workspaceId) ?? null;
  }

  /** Terminals that share a source tree (dispatch workers plus the owner).
   *  A closed terminal stays listed while it still has undrained moment work. */
  private terminalsOnWorkspace(ws: WorkspaceState): AgentTerminalInstance[] {
    const out: AgentTerminalInstance[] = [];
    for (const id of ws.terminalIds) {
      const inst = this.terminals.get(id);
      if (!inst) continue;
      if (inst.closed && inst.momentDots.length === 0 && inst.pendingHints.size === 0) continue;
      out.push(inst);
    }
    return out;
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
      momentCapturePromise: null,
      lastReseedMs: 0,
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
    const rendererTarget = this.captureRendererSendTarget();
    const promise = (async (): Promise<SnapshotStore | null> => {
      const storeRoot = await this.canonicalPath(ws.root);
      // v2 keys the store by the opened folder. Older stores captured the
      // Git top-level for a subdirectory path and must not mix with this.
      project.storeDir = join(
        this.userDataDir,
        "worldlines",
        createHash("sha256").update(`v2:${storeRoot}`).digest("hex").slice(0, 16),
      );
      const top = await gitTopLevel(ws.root);
      if (!top) {
        ws.recordError = "the opened folder is not inside a Git repository";
        this.pushRecorderForWorkspace(ws, "paused", rendererTarget);
        return null;
      }
      if (!captureRootInRepo(storeRoot, await this.canonicalPath(top))) {
        ws.recordError = "the opened folder is not inside a Git repository";
        this.pushRecorderForWorkspace(ws, "paused", rendererTarget);
        return null;
      }
      const gitDir = await gitCommonDir(ws.root);
      const fmt = await gitObjectFormat(ws.root);
      if (!gitDir) {
        ws.recordError = "the opened folder has no Git directory";
        this.pushRecorderForWorkspace(ws, "paused", rendererTarget);
        return null;
      }
      // Capture the opened folder. A Git subdirectory is a valid project.
      // v2: older stores captured the Git top-level for the same folder key.
      const store = await SnapshotStore.create(project.storeDir!, storeRoot, gitDir, fmt);
      const state = await store.capture(await gitHead(ws.root), null);
      ws.lastStateCommit = state.commit;
      this.pushRecorderForWorkspace(ws, "ready", rendererTarget);
      return store;
    })();
    ws.indexReady = promise.then(() => undefined, (err) => {
      ws.recordError = err instanceof Error ? err.message : String(err);
    });
    project.storePromise = promise;
  }

  /** Recorder state for every agent terminal of a workspace. */
  private pushRecorderForWorkspace(ws: WorkspaceState, state: RecorderState, expected?: PtyRendererSendTarget | null): void {
    for (const id of ws.terminalIds) {
      const inst = this.terminals.get(id);
      if (inst && inst.type === "agent") this.setRecorderState(inst, state, expected);
    }
  }

  // ------------------------------------------------- trust (WORLDLINES §6.7) ----

  /** The trust-sensitive resource hashes, computed off the main thread. */
  private async computeTrustHashes(project: ProjectState): Promise<Record<string, string>> {
    const agentDir = join(homedir(), ".termina", "agent");
    return trustResourceHashes(agentDir, project.cwd ? resolve(project.cwd) : null);
  }

  /**
   * Create the worldline manager of one project. Depends on app paths
   * that exist only after the app creates the window.
   */
  /** Cached host path resolution (realpath + PATH lookup). */
  private paths = new PathLookup();

  /** In-flight worldline inits by project id. The sync guard below used to be
   * atomic; the canonical-path await in construction is not, so concurrent
   * agent_start events for one project must share a single construction. */
  private worldlineInits = new Map<string, Promise<void>>();

  private initWorldlines(project: ProjectState): Promise<void> {
    if (project.worldlines) return Promise.resolve();
    const pending = this.worldlineInits.get(project.id);
    if (pending) return pending;
    const task = (async () => {
      if (project.worldlines) return;
      project.worldlines = new WorldlineManager({
        worldsRoot: this.worldsRoot,
        // The canonical primary root: the sandbox compares canonical paths.
        primaryRoot: await this.canonicalPath(this.primaryWorkspace(project)?.root ?? project.cwd ?? homedir()),
      primaryRootIdentity: project.primaryRootIdentity,
      realHome: homedir(),
      userData: this.userDataDir,
      primaryEventsDir: this.eventsDir,
      agentCorePath: coreEngineBinary(),
      electronExecPath: process.execPath,
      candidateEnv: (provider) => candidateEnv(provider),
      showThinking: () => this.preferences.showThinking,
      getStore: async () => {
        const store = await project.storePromise;
        return store;
      },
      // The sandboxed core loads the app-owned agent-core copy, the
      // electron binary, and the node binary.
      appReadPaths: () => worldlineAppReadPaths(coreEngineBinary(), this.paths),
      forkCoreSession: (opts, callOptions) => this.sessionFork.forkCore(opts, callOptions),
      buildExportPatch: (files) =>
        this.sessionFork.exportPatch({ files }).then((result) => {
          if (!result.ok) throw new Error(result.error);
          return result.patch;
        }),
      discardCoreSession: (runId) => this.sessionRetention.discard(runId),
      createCandidate: (opts) => this.createCandidate(opts),
      terminateCandidate: (terminalId) => this.terminateCandidate(terminalId),
      createCandidateWorkspace: (root, baseStateId, comparisonId) => this.createCandidateWorkspace(project, root, baseStateId, comparisonId),
      onUpdate: (summary) => this.send("worldline:update", { projectId: project.id, summary }),
      onCandidateState: async (root, stateId) => {
        const workspace = await this.workspaceContaining(root);
        if (workspace) this.setWorkspaceState(workspace, stateId);
      },
      onRemoved: (comparisonId) => {
        this.cancelVerifyForComparison(comparisonId);
        this.removeCandidateWorkspaces(project, comparisonId);
        this.send("worldline:removed", { projectId: project.id, comparisonId });
      },
      // The fork preflight (WORLDLINES §4): repository, platform, disk.
      preflight: () =>
        worldlinePreflight({
          storePromise: project.storePromise,
          worldsRoot: this.worldsRoot,
          primaryRoot: this.primaryWorkspace(project)?.root ?? project.cwd ?? "",
        }),
      trustHashes: async () => this.computeTrustHashes(project),
      captureHead: (root, gitDir, parent) => worldlineCaptureHead(project.storePromise, root, gitDir, parent),
      capturePrimary: () => worldlineCapturePrimary(project.storePromise, this.primaryWorkspace(project)),
      releaseState: async (stateId) => {
        await this.releaseStateIfUnused(stateId);
      },
      terminalBusy: (terminalId) => this.terminals.get(terminalId)?.busy === true,
      terminalVerifying: (terminalId) => this.verifyRuns.has(terminalId),
      workspaceAt: async (root) => {
        const ws = await this.workspaceContaining(root);
        return ws ? { id: ws.id, generation: ws.generation, lastStateCommit: ws.lastStateCommit } : null;
      },
      acquireWriteLease: (workspaceId, requester, timeoutMs) => this.acquireWriteLease(workspaceId, requester, timeoutMs),
      releaseWriteLease: (workspaceId, requester) => this.releaseWriteLease(workspaceId, requester),
      flushDirtyModels: (requester, workspaceId, timeoutMs) => this.flushDirtyModels(requester, workspaceId, timeoutMs),
      canonicalPath: (absPath) => this.canonicalPath(absPath),
      mineFiles: () => project.mineFiles,
      drainMineUpdates: () => project.mineCommit.catch(() => undefined),
      removePromptPayload: (eventsDir, fileName) => this.removePromptPayload(eventsDir, fileName),
      runSandboxedEvidence: (cand, command, timeoutMs, signal) => this.runSandboxedEvidence(cand, command, timeoutMs, signal),
      sourceFilesOf: (root) => this.sourceFilesOf(root),
      createEvidenceHome: () => this.evidenceHomes.create(),
      removeEvidenceHome: (path) => this.evidenceHomes.remove(path),
      detectTestFromState: (store, stateId) => detectTestFromState(store, stateId),
      benchmarkConfigFrom: (store, stateId) => benchmarkConfigFrom(store, stateId),
      onEvidenceUpdate: (summary) => this.send("worldline:evidence-update", { projectId: project.id, summary }),
      onPromotionApply: (relPaths) => {
        this.promotionPaths = relPaths ? new Set(relPaths) : null;
      },
      primarySessionDir: (cwd) => this.coreProjectSessionDir(cwd),
      installPromoted: async (seed) => {
        const rendererTarget = this.captureRendererSendTarget();
        const inst = await this.createTerminal(
          seed.primaryRoot,
          await (async () => {
            if (seed.engine !== "core") throw new Error("core is the only engine");
            const parsed = parseSessionBundlePath(seed.installedSession);
            if (!parsed || resolve(parsed.projectDir) !== resolve(await this.coreProjectSessionDir(seed.primaryRoot))) {
              throw new Error("the promoted core session path is invalid");
            }
            return {
              type: "agent" as const,
              engine: "core" as const,
              workspaceId: seed.primaryWorkspaceId,
              resume: { sessionId: parsed.sessionId, sessionFile: parsed.sessionFile },
            };
          })(),
        );
        for (const path of seed.paths) {
          const abs = await this.canonicalPath(join(seed.primaryRoot, path.rel));
          const before = path.beforeExists ? await readFile(join(seed.beforeDir, path.rel)) : null;
          this.setBaseline(inst, abs, before === null ? null : before.toString("utf8"));
          if (path.kind === "delete") await this.recordDeleted(inst, abs, rendererTarget);
          else await this.recordModified(inst, abs, path.beforeExists ? "modified" : "created");
        }
        this.send("modified:list", { instanceId: inst.id, files: [...inst.modified.values()] }, rendererTarget);
        const changedList = seed.paths.map((path) => `- \`${path.rel}\``).join("\n");
        for (const other of this.terminals.values()) {
          if (other.id === inst.id || other.workspaceId !== seed.primaryWorkspaceId || other.type !== "agent") continue;
          try {
            await this.writeEventLeaf(
              other,
              `edits-${other.id}.md`,
              Buffer.from(`## Source changed by promotion (${seed.comparisonId}, candidate ${seed.label})\n\n${changedList}\n`),
              16 * 1024,
            );
          } catch {
            /* The context file is optional. */
          }
        }
        this.sendInstances(rendererTarget);
        this.send("promotion:opened", { terminalId: inst.id }, rendererTarget);
        return { terminalId: inst.id };
      },
    });
    })();
    this.worldlineInits.set(project.id, task);
    const forget = () => {
      if (this.worldlineInits.get(project.id) === task) this.worldlineInits.delete(project.id);
    };
    task.then(forget, forget);
    return task;
  }

  /** The events dir a terminal's bridge reads (candidates have their own). */
  private eventsDirOf(inst: AgentTerminalInstance): string {
    const owner = this.projectOfTerminal(inst.id);
    return owner?.worldlines?.eventsDirOf(inst.id) ?? this.eventsDir;
  }

  /** Resolve the native identity for a terminal's private events root. */
  private eventsBindingOf(inst: AgentTerminalInstance): PromotionFsIdentity | null {
    const owner = this.projectOfTerminal(inst.id);
    const candidate = owner?.worldlines?.eventsBindingOf(inst.id);
    if (candidate) return { dev: candidate.dev, ino: candidate.ino };
    return this.eventsDirBinding;
  }

  /** Write one terminal-private event leaf below its bound events root. */
  private async writeEventLeaf(inst: AgentTerminalInstance, name: string, content: Buffer, maxBytes: number): Promise<void> {
    const root = this.eventsBindingOf(inst);
    if (!root) throw new Error("terminal events directory is not bound");
    await writeBoundOwnedFile({
      root: this.eventsDirOf(inst),
      rootIdentity: root,
      components: [name],
      parentIdentity: root,
      content,
      mode: 0o600,
      maxBytes,
    });
  }

  /** Remove one terminal-private event leaf through its bound root. */
  private async removeEventLeaf(inst: AgentTerminalInstance, name: string): Promise<void> {
    const root = this.eventsBindingOf(inst);
    if (!root) return;
    await this.removeBoundEventLeaf(this.eventsDirOf(inst), root, name);
  }

  private async removeBoundEventLeaf(rootPath: string, root: PromotionFsIdentity, name: string, expectedIdentity?: PromotionFsIdentity): Promise<void> {
    try {
      const binding = await bindOwnedEntry(join(rootPath, name), root, expectedIdentity);
      await removeBoundOwnedEntry({ binding });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[main] retained terminal event ${name}: ${String(error)}`);
      }
    }
  }

  /** Core tabs attach a clipboard image as a pending host file. Shell
   *  tabs only paste text: a PNG cannot travel through the pty. */
  private async pasteTerminal(id: unknown): Promise<TerminalPasteResult> {
    const text = (): TerminalPasteResult => ({ ok: true, kind: "text", text: capUtf8(clipboard.readText(), MAX_CLIPBOARD_BYTES) });
    if (typeof id !== "string") return text();
    const captured = this.terminals.get(id);
    if (!captured || captured.type !== "agent") return text();
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
    if (captured.type === "agent") {
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
    engine?: "core";
    launch: { cmd: string; args: string[]; env: Record<string, string | undefined> };
    beforeSpawn?: (terminalId: string) => void;
    signal?: AbortSignal;
  }): Promise<{ terminalId: string; pid: number }> {
    const eventsDir = opts.launch.env.TERMINA_EVENTS_DIR;
    // Allocate the id and arm the candidate-owned tailer before constructing
    // the PTY.  Core can emit session_ready from its startup handler
    // synchronously with process creation; installing the cursor after the
    // spawn would make watch() treat that record as old history and drop the
    // readiness transition.
    const terminalId = this.allocateTerminalId();
    if (!eventsDir) throw new Error("candidate events directory is missing");
    const tailer = new SidecarTailer(eventsDir);
    tailer.onEvent = (id, event) => this.enqueueSidecarEvent(id, event);
    tailer.start();
    this.worldlineTailers.set(terminalId, tailer);
    try {
      // The durable `await tailer.watchReady(terminalId)` boundary is
      // cancellation-raced so teardown cannot leave a waiter behind.
      if (!(await awaitCandidateAbortable(tailer.watchReady(terminalId), opts.signal))) {
        throw new Error("candidate sidecar tailer could not establish a durable startup cursor");
      }
      if (opts.signal?.aborted) throw new Error("candidate startup was cancelled");
      // Worldline routing is installed while the sidecar cursor is durable and
      // before createTerminal can spawn a child. This is the final admission
      // boundary for an immediate session_ready.
      opts.beforeSpawn?.(terminalId);
      if (opts.signal?.aborted) throw new Error("candidate startup was cancelled");
      const inst = await this.createTerminal(opts.root, {
        type: "agent",
        engine: opts.engine,
        workspaceId: opts.workspaceId,
        launch: opts.launch,
        id: terminalId,
        sidecarTailer: tailer,
        skipSidecarWatch: true,
      });
      if (opts.signal?.aborted) {
        this.terminateCandidate(inst.id);
        throw new Error("candidate startup was cancelled");
      }
      return { terminalId: inst.id, pid: inst.pty.pid };
    } catch (error) {
      if (tailer) {
        this.worldlineTailers.delete(terminalId);
        tailer.stopWatching(terminalId);
        tailer.stop();
      }
      throw error;
    }
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
    if (!ws || ws.writerId !== requesterId) return;
    ws.leaseDepth = Math.max(0, (ws.leaseDepth ?? 1) - 1);
    if (ws.leaseDepth === 0) {
      ws.writerId = null;
      // Moment capture bails while another writer holds the tree. Kick once
      // the tree is free so drained-not-yet-captured dots are not stranded.
      // The moment writer itself must not kick: a failed incremental restores
      // its batch and a self-kick would tight-loop on a wedged store.
      if (!requesterId.startsWith("moment:")) this.kickWorkspaceMomentCapture(ws);
    }
  }

  /** Schedule one capture if any terminal on this tree still has dots or hints. */
  private kickWorkspaceMomentCapture(ws: WorkspaceState): void {
    if (this.disposed) return;
    if (this.projectIsSwitching(this.projectOfWorkspace(ws.id)?.id)) return;
    for (const member of this.terminalsOnWorkspace(ws)) {
      if (!member.currentRun) continue;
      if (member.momentDots.length === 0 && member.pendingHints.size === 0) continue;
      this.scheduleMomentCapture(member);
      return;
    }
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
        ws.leaseDepth = (ws.leaseDepth ?? 0) + 1;
        return { ok: true, generation: ws.generation };
      }
      if (Date.now() >= deadline) return { ok: false, generation: ws.generation, error: `another writer holds the lease: ${ws.writerId}` };
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** The workspace whose root contains the path, or null. */
  private async workspaceContaining(absPath: string): Promise<WorkspaceState | null> {
    return this.workspaceContainingCanonical(await this.canonicalPath(absPath));
  }

  /** Find a workspace for a path that is already canonical. */
  private async workspaceContainingCanonical(path: string): Promise<WorkspaceState | null> {
    let match: { workspace: WorkspaceState; rootLength: number } | null = null;
    for (const project of this.projects.values()) {
      for (const ws of project.workspaces.values()) {
        const root = await this.canonicalPath(ws.root);
        if (project.workspaces.get(ws.id) !== ws || this.workspaceOwners.get(ws.id) !== project.id) continue;
        const rel = relative(root, path);
        if ((rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) && (!match || root.length > match.rootLength)) {
          match = { workspace: ws, rootLength: root.length };
        }
      }
    }
    return match?.workspace ?? null;
  }

  /** Resolve a renderer-provided owner to the live project/workspace pair. */
  private projectWorkspace(owner: unknown): { project: ProjectState; workspace: WorkspaceState } | null {
    if (!owner || typeof owner !== "object" || Array.isArray(owner)) return null;
    const value = owner as Partial<ProjectWorkspaceRef>;
    if (typeof value.projectId !== "string" || typeof value.workspaceId !== "string") return null;
    const project = this.projects.get(value.projectId);
    if (!project || this.workspaceOwners.get(value.workspaceId) !== project.id) return null;
    const workspace = project.workspaces.get(value.workspaceId);
    return workspace ? { project, workspace } : null;
  }

  private async managedPath(absPath: string, workspaceId: string, primaryOnly = false): Promise<{ path: string; workspace: WorkspaceState } | null> {
    if (await this.hasDanglingSymlink(absPath)) return null;
    const path = await this.canonicalPath(absPath);
    const workspace = this.workspaceById(workspaceId);
    if (!workspace || (primaryOnly && !workspace.primary)) return null;
    const root = await this.canonicalPath(workspace.root);
    const rel = relative(root, path);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    return { path, workspace };
  }

  private async hasDanglingSymlink(path: string): Promise<boolean> {
    let current = resolve(path);
    while (true) {
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          try {
            await fsRealpath(current);
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

  /** Create one evidence profile below the comparison's bound profiles root. */
  private async createBoundEvidenceProfile(cand: {
    root: string;
    profilePath: string;
    profileBinding?: PromotionFsIdentity;
    profileLeaf?: BoundPromotionExpectedLeaf;
  }): Promise<{ path: string; parentIdentity: PromotionFsIdentity }> {
    const parentIdentity = cand.profileBinding;
    if (!parentIdentity || !cand.profileLeaf) throw new Error("candidate evidence profile is not bound");
    const base = await boundPromotionReadFile({
      root: dirname(cand.profilePath),
      rootIdentity: parentIdentity,
      components: [basename(cand.profilePath)],
      parentIdentity,
      expectedIdentity: cand.profileLeaf.identity,
      maxBytes: 2 * 1024 * 1024,
    });
    const generated = evidenceProfileContent(cand, base.content.toString("utf8"));
    await writeBoundOwnedFile({
      root: dirname(generated.path),
      rootIdentity: parentIdentity,
      components: [basename(generated.path)],
      parentIdentity,
      content: Buffer.from(generated.content),
      mode: 0o600,
      maxBytes: 2 * 1024 * 1024,
    });
    return { path: generated.path, parentIdentity };
  }

  /** Remove one generated evidence profile through its bound parent. */
  private async removeBoundEvidenceProfile(path: string, parentIdentity: PromotionFsIdentity): Promise<void> {
    try {
      const binding = await bindOwnedEntry(path, parentIdentity);
      await removeBoundOwnedEntry({ binding });
    } catch (error) {
      // A failed identity proof is retained for the owner/restart cleanup;
      // pathname `rm` would risk deleting a replacement profile.
      console.warn(`[main] evidence profile cleanup retained ${path}: ${String(error)}`);
    }
  }

  /** One sandboxed command run with bounded combined stdout and stderr. */
  private async runSandboxedEvidence(
    cand: { root: string; profilePath: string; homeDir: string; tmpDir: string; profileBinding?: PromotionFsIdentity; profileLeaf?: BoundPromotionExpectedLeaf },
    command: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ code: number; stdout: string; timedOut: boolean }> {
    const shells = await detectShells();
    const shell = shells[0] ?? { path: "/bin/zsh", name: "zsh" };
    if (signal?.aborted) return { code: -1, stdout: "evidence worker cancelled", timedOut: false };
    const generatedProfile = await this.createBoundEvidenceProfile(cand);
    const profileBinding = generatedProfile.parentIdentity;
    const profilePath = generatedProfile.path;
    const cleanupProfile = async (): Promise<void> => {
      await this.removeBoundEvidenceProfile(profilePath, profileBinding);
    };
    if (signal?.aborted) {
      await cleanupProfile();
      return { code: -1, stdout: "evidence worker cancelled", timedOut: false };
    }
    return new Promise((resolvePromise) => {
      // Evidence workers run fully offline under the same deny-list profile
      // with the resource limits applied by the wrapper (WORLDLINES §6.8).
      let child: ReturnType<typeof spawn>;
      try {
        const launch = candidateSandboxLaunch(profilePath, [shell.path, "-c", command.map(quoteShellArg).join(" ")]);
        child = spawn(launch.cmd, launch.args, {
          cwd: cand.root,
          env: { ...candidateEnv(null), HOME: cand.homeDir, TMPDIR: cand.tmpDir },
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
      } catch (error) {
        void cleanupProfile().then(() => resolvePromise({ code: -1, stdout: error instanceof Error ? error.message : String(error), timedOut: false }));
        return;
      }
      let stdout = "";
      let timedOut = false;
      let childEnded = false;
      let childCode = -1;
      let cleanupPromise: Promise<boolean> | null = null;
      let cleanupSettled = false;
      let cleanupWaitAttached = false;
      let cancellationRequested = false;
      const appendOutput = (d: Buffer): void => {
        if (stdout.length >= MAX_VERIFY_OUTPUT) return;
        stdout += d.toString("utf8").slice(0, MAX_VERIFY_OUTPUT - stdout.length);
      };
      child.stdout?.on("data", appendOutput);
      child.stderr?.on("data", appendOutput);
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (result: { code: number; stdout: string; timedOut: boolean }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", requestCancellation);
        void cleanupProfile().then(() => resolvePromise(result));
      };
      const maybeFinish = (): void => {
        if (settled || (!childEnded && !timedOut && !cancellationRequested)) return;
        if (!cleanupPromise) cleanupPromise = terminateSandboxProcessGroup(child, cancellationRequested || !timedOut ? "SIGTERM" : "SIGKILL");
        if (!cleanupWaitAttached) {
          cleanupWaitAttached = true;
          void cleanupPromise.then(
            () => {
              cleanupSettled = true;
              maybeFinish();
            },
            () => {
              cleanupSettled = true;
              maybeFinish();
            },
          );
        }
        if (!cleanupSettled) return;
        finish({ code: cancellationRequested ? -1 : childCode, stdout, timedOut });
      };
      const requestCancellation = (): void => {
        if (settled) return;
        cancellationRequested = true;
        maybeFinish();
      };
      timer = setTimeout(() => {
        timedOut = true;
        maybeFinish();
      }, timeoutMs);
      signal?.addEventListener("abort", requestCancellation, { once: true });
      if (signal?.aborted) requestCancellation();
      child.on("error", (err) => {
        appendOutput(Buffer.from(String(err.message)));
        childEnded = true;
        childCode = -1;
        maybeFinish();
      });
      child.on("close", (code) => {
        childEnded = true;
        childCode = code ?? -1;
        maybeFinish();
      });
    });
  }

  /** Read bounded tracked source files for package checks. */
  private async sourceFilesOf(root: string): Promise<Array<{ relPath: string; content: string }>> {
    const out: Array<{ relPath: string; content: string }> = [];
    try {
      const canonicalRoot = await fsRealpath(root);
      const tracked = await gitTrackedFiles(root);
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

  private setWorkspaceState(ws: WorkspaceState, stateId: string | null): void {
    const previous = ws.lastStateCommit;
    ws.lastStateCommit = stateId;
    if (previous && previous !== stateId) void this.releaseStateIfUnused(previous);
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

  private async coreProjectSessionDir(cwd: string): Promise<string> {
    return join(this.coreSessionRoot(), this.sanitizeSessionDir(await this.canonicalPath(cwd)));
  }

  private async coreSessionFile(sessionId: string, cwd: string): Promise<string> {
    return bundleSessionFile(await this.coreProjectSessionDir(cwd), sessionId);
  }

  private saveTerminalRoster(project: ProjectState): void {
    const live: RosterTerminal[] = [];
    for (const id of project.terminalIds) {
      const inst = this.terminals.get(id);
      if (!inst?.persist || inst.closed) continue;
      live.push(inst);
    }
    this.rosterStore.save(
      rosterFilePath(this.userDataDir, this.sanitizeSessionDir(project.canonicalRoot)),
      live,
      project.unrestoredTerminals,
    );
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

  /** Delete an empty agent-core bundle. Keep a bundle with content so
   *  Session Search can read it after the tab closes. */
  private async discardCoreSession(inst: AgentTerminalInstance): Promise<void> {
    if (!inst.sessionFile) return;
    if (!this.pathInside(this.coreSessionRoot(), inst.sessionFile)) return;
    // Empty core bundles are reclaimed by the worker's native descriptor/
    // provenance-bound owner.
    await this.sessionFork.discardEmptyCoreSession(inst.sessionFile);
  }

  private persistLive(project: ProjectState): AgentTerminalInstance[] {
    const out: AgentTerminalInstance[] = [];
    for (const id of project.terminalIds) {
      const inst = this.terminals.get(id);
      if (inst?.persist && !inst.closed) out.push(inst);
    }
    return out;
  }

  private async restoreProjectTerminals(project: ProjectState): Promise<void> {
    const loaded = await loadRosterFile(rosterFilePath(this.userDataDir, this.sanitizeSessionDir(project.canonicalRoot)));
    if (loaded.entries.length === 0) {
      // Only a genuinely new project gets a default terminal. An existing
      // empty roster is the durable result of closing the project's last tab.
      if (!loaded.exists) {
        try {
          await this.createTerminal(project.cwd, {
            projectId: project.id,
            workspaceId: this.primaryWorkspace(project)?.id,
          });
        } catch {
          /* The agent can be unavailable while the folder still opens. */
        }
      }
      return;
    }
    const unrestored: TerminalRosterEntry[] = [];
    const spawned: { rec: TerminalRosterEntry; id: string }[] = [];
    for (const rec of loaded.entries) {
      this.noteTerminalId(rec.id);
      try {
        const inst = await this.createTerminal(project.cwd, {
          id: rec.id,
          type: rec.type,
          engine: "core",
          shell: rec.shell,
          projectId: project.id,
          workspaceId: this.primaryWorkspace(project)?.id,
          persist: true,
          skipRosterSave: true,
          resume: { sessionId: rec.sessionId ?? null, sessionFile: null },
          model: rec.model ?? null,
        });
        // Handoff: restore the board and the last verdict. Worker assignments
        // never survive — dispatched tasks return to pending without claims.
        if (rec.type === "agent") {
          if (rec.plan && rec.plan.length > 0) {
            inst.plan = rec.plan.map((t) => ({
              text: t.text,
              paths: t.paths,
              state: t.state === "done" ? "done" : "pending",
            }));
            this.sendPlan(inst);
          }
          if (rec.verify) {
            inst.verify = { state: rec.verify.state, command: rec.verify.command, summary: rec.verify.summary };
          }
        }
        spawned.push({ rec, id: inst.id });
      } catch (err) {
        unrestored.push(rec);
        console.warn(`[main] could not restore terminal ${rec.id}: ${(err as Error).message}`);
      }
    }
    for (const item of spawned) {
      if (!this.terminals.get(item.id)?.persist) unrestored.push(item.rec);
    }
    // A non-empty roster is authoritative. Do not replace failed restores
    // with a fresh core tab: retaining both would make the old tab appear as
    // a phantom if it becomes launchable on a later restart.
    project.unrestoredTerminals = unrestored;
    this.saveTerminalRoster(project);
  }

  /** Provider-qualified model of a core tab, for TERMINA_CORE_* env. */
  private copiedCoreModel(fromTerminalId: string | undefined): string | null {
    if (!fromTerminalId) return null;
    const source = this.terminals.get(fromTerminalId);
    if (!source || source.type !== "agent") return null;
    const model = source.model ?? source.currentRun?.model ?? null;
    return typeof model === "string" && model.includes("/") ? model : null;
  }

  /** Provider-qualified model id that is safe to pass as --model. */
  private usableAgentModel(model: string | null | undefined): string | null {
    if (typeof model !== "string") return null;
    const next = model.trim();
    if (next.length < 3 || next.length > MAX_AGENT_MODEL_CHARS) return null;
    if (!next.includes("/")) return null;
    if (/[\x00-\x1f]/.test(next)) return null;
    return next;
  }

  private usableAgentThinking(level: string | null | undefined): string | null {
    if (typeof level !== "string") return null;
    const next = level.trim().toLowerCase();
    return AGENT_THINKING_LEVELS.has(next) ? next : null;
  }

  private usableAgentUsage(usage: string | null | undefined): string | null {
    if (typeof usage !== "string") return null;
    const next = usage.trim();
    if (next.length < 1 || next.length > MAX_AGENT_USAGE_CHARS) return null;
    if (/[\x00-\x1f]/.test(next)) return null;
    return next;
  }

  private applyAgentSettings(
    inst: AgentTerminalInstance,
    model: string | null | undefined,
    thinkingLevel: string | null | undefined,
    usage?: string | null | undefined,
    expected?: PtyRendererSendTarget | null,
  ): void {
    let changed = false;
    const nextModel = this.usableAgentModel(model);
    if (nextModel) {
      if (nextModel !== inst.model) {
        inst.model = nextModel;
        changed = true;
      }
      this.rememberModel(nextModel);
    }
    const nextThinking = this.usableAgentThinking(thinkingLevel);
    if (nextThinking) {
      if (nextThinking !== inst.thinkingLevel) {
        inst.thinkingLevel = nextThinking;
        changed = true;
      }
      this.rememberEffort(inst, nextThinking);
    }
    const nextUsage = usage === undefined ? null : this.usableAgentUsage(usage);
    if (nextUsage && nextUsage !== inst.usage) {
      inst.usage = nextUsage;
      changed = true;
    }
    if (changed) this.sendAgentStatus(inst, expected);
  }

  private sendAgentStatus(inst: AgentTerminalInstance, expected?: PtyRendererSendTarget | null): void {
    if (inst.type !== "agent") return;
    this.send("agent:status", {
      terminalId: inst.id,
      model: inst.model,
      thinkingLevel: inst.thinkingLevel,
      usage: inst.usage,
    }, expected);
  }

  /** Silently remember the last-used model per provider so fresh sessions
   *  reopen on it instead of the provider default. */
  private rememberModel(full: string): void {
    const cut = full.indexOf("/");
    if (cut < 1 || cut === full.length - 1) return;
    const next = recordRecentModel(this.preferences.recentModels ?? [], full.slice(0, cut), full.slice(cut + 1));
    if (JSON.stringify(next) === JSON.stringify(this.preferences.recentModels ?? [])) return;
    this.commitPreferencePatch({ recentModels: next }, false).then(
      () => undefined,
      (err) => {
        console.warn(`[main] recent model save failed: ${(err as Error).message}`);
      },
    );
  }

  /** Silently remember a file the renderer opened, so an empty Quick Open
   *  leads with it. The renderer requests, main validates and persists. */
  private rememberFile(projectId: unknown, relPath: unknown): void {
    if (typeof projectId !== "string" || typeof relPath !== "string") return;
    if (!this.projects.has(projectId)) return;
    const next = recordRecentFile(this.preferences.recentFiles ?? [], projectId, relPath);
    if (JSON.stringify(next) === JSON.stringify(this.preferences.recentFiles ?? [])) return;
    this.commitPreferencePatch({ recentFiles: next }, false).then(
      () => undefined,
      (err) => {
        console.warn(`[main] recent file save failed: ${(err as Error).message}`);
      },
    );
  }

  /** Silently remember the last-used effort so fresh sessions reopen on it
   *  instead of the core default. Worldline candidates run explicit specs;
   *  their levels never become the user default. */
  private rememberEffort(inst: AgentTerminalInstance, level: string): void {
    if (this.worldlineTailers.has(inst.id)) return;
    if ((this.preferences.defaultEffort ?? null) === level) return;
    this.commitPreferencePatch({ defaultEffort: level }, false).then(
      () => undefined,
      (err) => {
        console.warn(`[main] effort save failed: ${(err as Error).message}`);
      },
    );
  }
  private rememberedAgentSettings(): { model: string | null; thinkingLevel: null } | null {
    const [first] = this.preferences.recentModels ?? [];
    if (!first) return null;
    return { model: `${first.provider}/${first.model}`, thinkingLevel: null };
  }

  private async createTerminal(
    cwd?: string,
    opts?: {
      type?: "agent" | "shell";
      shell?: string;
      engine?: "core";
      workspaceId?: string;
      projectId?: string;
      id?: string;
      fromTerminalId?: string;
      launch?: { cmd: string; args: string[]; env: Record<string, string | undefined> };
      /** Candidate-owned tailer, already watching before the PTY is spawned. */
      sidecarTailer?: SidecarTailer;
      /** The candidate tailer was armed before spawn; do not reset its cursor
       * after the child has had a chance to publish session_ready. */
      skipSidecarWatch?: boolean;
      persist?: boolean;
      skipRosterSave?: boolean;
      resume?: { sessionId: string | null; sessionFile: string | null };
      /** Roster-pinned model for core resume: the session's own last model. */
      model?: string | null;
    },
  ): Promise<AgentTerminalInstance> {
    // Terminal creation crosses several awaits (provider/session setup and
    // process spawn). Preserve the requesting document so a late completion
    // cannot publish its list into a replacement renderer.
    const rendererTarget = this.captureRendererSendTarget();
    const type = opts?.type ?? "agent";
    const persist = opts?.persist ?? (!opts?.launch && !opts?.id);
    const requestedProject = opts?.projectId ? this.projects.get(opts.projectId) ?? null : null;
    const workspaceId =
      opts?.workspaceId ?? requestedProject?.workspaces.values().next().value?.id ?? this.primaryWorkspace(requestedProject ?? undefined)?.id ?? this.primaryWorkspace()?.id ?? "";
    const owner = this.projectOfWorkspace(workspaceId) ?? requestedProject ?? this.project();
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
    if (opts?.engine !== undefined && opts.engine !== "core") {
      throw new Error("core is the only engine");
    }
    let cmd: string;
    let args: string[];
    let shellName: string | undefined;
    let shellPath: string | undefined;
    let env: Record<string, string | undefined>;
    let sessionId = persist ? opts?.resume?.sessionId ?? null : null;
    let sessionFile = persist ? opts?.resume?.sessionFile ?? null : null;
    if (opts?.launch) {
      // A worldline candidate: the sandbox wraps the core binary.
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
    } else if (type === "agent") {
      // In-house engine. Timeline and modified list consume its sidecar
      // contract. ELECTRON_RUN_AS_NODE cannot read inside the asar; spawn
      // the unpacked copy.
      cmd = process.execPath;
      args = [
        coreEngineBinary(),
        ...thinkingStartupArgs(this.preferences.showThinking),
      ];
      if (persist) {
        const sessionCwd = cwd ?? owner?.cwd ?? this.terminalCwd();
        sessionFile = sessionId && isCoreSessionId(sessionId) ? await this.coreSessionFile(sessionId, sessionCwd) : null;
        if (!sessionFile || this.sessionFileInUse(sessionFile)) {
          sessionId = `core-${randomUUID()}`;
          sessionFile = await this.coreSessionFile(sessionId, sessionCwd);
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
      const resuming = Boolean(sessionFile && sessionBundleHasContent(sessionFile));
      if (resuming) env.TERMINA_CORE_RESUME = "1";
      else delete env.TERMINA_CORE_RESUME;
      // Fresh sessions reopen on the last-used effort; resumed bundles keep
      // their own saved level, and agent-core clamps per model regardless.
      const defaultEffort = this.usableAgentThinking(this.preferences.defaultEffort ?? null);
      if (defaultEffort) env.TERMINA_CORE_EFFORT = defaultEffort;
      else delete env.TERMINA_CORE_EFFORT;
      const coreModel = this.copiedCoreModel(opts?.fromTerminalId);
      const resumeModel = this.usableAgentModel(opts?.model);
      if (coreModel) {
        const cut = coreModel.indexOf("/");
        env.TERMINA_CORE_PROVIDER = coreModel.slice(0, cut);
        env.TERMINA_CORE_MODEL = coreModel.slice(cut + 1);
      } else if (resumeModel) {
        // Roster resume: the session's own last model beats the global one.
        const cut = resumeModel.indexOf("/");
        env.TERMINA_CORE_PROVIDER = resumeModel.slice(0, cut);
        env.TERMINA_CORE_MODEL = resumeModel.slice(cut + 1);
      } else if (!resuming) {
        // Fresh session without a source tab: reopen on the last-used model.
        // agent-core ignores the pin when that provider is no longer authenticated.
        const remembered = this.rememberedAgentSettings()?.model;
        const cut = remembered?.indexOf("/") ?? -1;
        if (remembered && cut > 0) {
          env.TERMINA_CORE_PROVIDER = remembered.slice(0, cut);
          env.TERMINA_CORE_MODEL = remembered.slice(cut + 1);
        }
      }
      // No TERMINA_CORE_APPROVE bypass here: primary terminals ask the host
      // (dialog outside the pty) for every bash run. Sandboxed worldline
      // candidates alone auto-approve via electron/worldlines/.
    } else {
      throw new Error("unsupported terminal type");
    }
    if (persist && owner && this.persistLive(owner).length >= MAX_TERMINAL_ROSTER) {
      throw new Error("this project already has the maximum number of saved terminals");
    }
    const inst = new AgentTerminalInstance(id, cwd ?? this.terminalCwd(), workspaceId, type, shellName, cmd, args, env, 80, 24);
    inst.projectId = owner?.id ?? null;
    inst.persist = persist;
    inst.shellPath = shellPath;
    inst.sessionId = sessionId;
    inst.sessionFile = sessionFile;
    if (type === "agent") inst.engine = "core";
    if (type === "agent" && !opts?.launch) {
      const provider = env.TERMINA_CORE_PROVIDER?.trim() ?? "";
      const modelName = env.TERMINA_CORE_MODEL?.trim() ?? "";
      if (provider && modelName) {
        const provisional = this.usableAgentModel(`${provider}/${modelName}`);
        if (provisional) inst.model = provisional;
      }
      if (env.TERMINA_CORE_RESUME !== "1") {
        const thinking = this.usableAgentThinking(env.TERMINA_CORE_EFFORT ?? null);
        if (thinking) inst.thinkingLevel = thinking;
      }
    }
    this.terminals.set(inst.id, inst);
    if (owner) {
      owner.workspaces.get(workspaceId)?.terminalIds.add(id);
      owner.terminalIds.add(id);
      if (persist && !opts?.skipRosterSave) this.saveTerminalRoster(owner);
    }

    const terminalGeneration = inst.generation;
    inst.pty.onData = (data) => this.sendPtyData(inst.id, terminalGeneration, data);
    this.ptyEgress.register(inst.id, terminalGeneration, {
      pause: () => inst.pty.pause(),
      resume: () => inst.pty.resume(),
    });
    inst.pty.onExit = async (code) => {
      if (inst.exitHandled) return;
      inst.exitHandled = true;
      console.log(`[main] terminal ${inst.id} (${inst.type}) exited code=${code}`);
      // Keep the terminal in the live map while queued output drains.  An
      // exit notification overtaking PTY bytes changes TUI semantics, and a
      // renderer reload must be able to receive the retained tail.
      await this.ptyEgress.finish(inst.id, terminalGeneration, code);
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
      // The exit marker was delivered and acknowledged by PtyEgressScheduler;
      // it is not sent through the unsequenced generic channel.
      this.closeRunOnExit(inst);
      void this.cleanupPromptPayloads(inst);
      for (const event of inst.timeline) {
        if (event.stateId) void this.releaseStateIfUnused(event.stateId, inst.id, event.seq);
      }
      // Resolve the owner before the map delete. projectOfTerminal reads
      // the terminal map, so a lookup after the delete finds no project.
      const exitOwner = this.projectOfTerminal(inst.id);
      const persistOwner = inst.persist && exitOwner && !this.disposed && !this.projectIsSwitching(exitOwner.id) ? exitOwner : null;
      if (persistOwner) {
        await this.discardCoreSession(inst).catch((error) => {
          console.warn(`[main] could not discard exited core session ${inst.id}: ${(error as Error).message}`);
        });
      }
      this.terminals.delete(inst.id);
      this.busyAgents.delete(inst.id);
      this.autoVerifyTasks.delete(inst.id);
      this.autoVerifyFailures.delete(inst.id);
      exitOwner?.workspaces.get(inst.workspaceId)?.terminalIds.delete(inst.id);
      exitOwner?.terminalIds.delete(inst.id);
      if (persistOwner) this.saveTerminalRoster(persistOwner);
      exitOwner?.worldlines?.terminalExited(inst.id);
      this.worldlineTailers.get(inst.id)?.stop();
      this.worldlineTailers.delete(inst.id);
      this.tailer.stopWatching(inst.id);
      this.sidecarQueues.delete(inst.id);
      this.ptyEgress.cancel(inst.id, terminalGeneration);
      // A closed owner takes its background runs with it: no API burns for
      // a dead terminal, and no orphan results land nowhere.
      this.subagents.killOwner(inst.id, "terminal closed");
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
          this.sendPlan(ownerInst, rendererTarget);
        }
      }
      this.sendInstances(rendererTarget);
    };

    const sidecarTailer = opts?.sidecarTailer ?? this.tailer;
    if (!opts?.skipSidecarWatch) sidecarTailer.watch(inst.id);
    if (type === "agent") sidecarTailer.setExpectedProducer(inst.id, inst.pty.pid);
    if (type === "agent" && owner) {
      const mineRefresh = owner.mineCommit.catch(() => undefined).then(() => this.writeMineContext(owner));
      owner.mineCommit = mineRefresh;
      void mineRefresh.catch((err) => console.warn(`[main] could not refresh mine context: ${(err as Error).message}`));
    }
    // Orient the first turn without discovery tool calls. Refreshes follow
    // watcher bursts through scheduleProjectSnapshot.
    if (type === "agent") void this.writeProjectSnapshot(inst);
    this.sendInstances(rendererTarget);
    return inst;
  }

  // ------------------------------------------------------------- verify ----

  /**
   * Start one automatic verify after a dispatch worker settled with its task
   * done. Only when the owner is idle and no sibling worker is still running:
   * a running agent must not have tests execute under its edits. One shot per
   * settle; never retried, cancellable through the normal verify path. A task
   * that settles while siblings run is still marked done on the board; the
   * last settling worker triggers the single verify covering all of them.
   */
  private maybeAutoVerify(owner: AgentTerminalInstance, taskText: string | null): void {
    if (!taskText || owner.busy || owner.closed) return;
    if (this.verifyRuns.has(owner.id) || this.autoVerifyTasks.has(owner.id)) return;
    for (const id of this.dispatchGroupIds(owner.id)) {
      if (id === owner.id) continue;
      const sibling = this.terminals.get(id);
      if (sibling && !sibling.closed && sibling.busy) return;
    }
    this.autoVerifyTasks.set(owner.id, taskText);
    void this.runVerify(owner.id).then((result) => {
      if (!result.ok) this.autoVerifyTasks.delete(owner.id);
    });
  }

  /**
   * Re-verify after the owner's own run settled with a failing verify on
   * record. Same idle/sibling/overlap guards as the worker path; the finish
   * path counts the attempt and stops the loop at the cap.
   */
  private maybeAutoReverify(owner: AgentTerminalInstance): void {
    const attempts = this.autoVerifyFailures.get(owner.id);
    if (attempts === undefined || owner.busy || owner.closed) return;
    if (this.verifyRuns.has(owner.id) || this.autoVerifyTasks.has(owner.id)) return;
    for (const id of this.dispatchGroupIds(owner.id)) {
      if (id === owner.id) continue;
      const sibling = this.terminals.get(id);
      if (sibling && !sibling.closed && sibling.busy) return;
    }
    void this.runVerify(owner.id).then((result) => {
      if (!result.ok) this.autoVerifyTasks.delete(owner.id);
    });
  }

  private async runVerify(ownerId: string): Promise<{ ok: boolean; error?: string }> {
    const owner = this.terminals.get(ownerId);
    if (!owner) return { ok: false, error: "terminal not found" };
    // The verify job can outlive several awaits (and the process itself can
    // run for minutes). Keep its pushes owned by the document that requested
    // it; a replacement renderer must hydrate from fresh state instead.
    const rendererTarget = this.captureRendererSendTarget();
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
      tc = await detectTestCommand(cwd);
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
    let verifyProfilePath: string | null = null;
    let verifyProfileParent: PromotionFsIdentity | null = null;
    try {
      const shells = await detectShells();
      const shell = shells[0] ?? { path: "/bin/zsh", name: "zsh" };
      const cmdline = `${tc.command} ${tc.args.map(quoteShellArg).join(" ")}`;
      if (candidate) {
        const generated = await this.createBoundEvidenceProfile(candidate);
        verifyProfilePath = generated.path;
        verifyProfileParent = generated.parentIdentity;
      }
      const launch = candidate ? candidateSandboxLaunch(verifyProfilePath!, [shell.path, "-c", cmdline]) : null;
      const command = launch?.cmd ?? shell.path;
      const args = launch?.args ?? ["-c", cmdline];
      const env = candidate
        ? { ...candidateEnv(null), HOME: candidate.homeDir, TMPDIR: candidate.tmpDir, TERMINA_EVENTS_DIR: candidate.eventsDir }
        : { ...cleanEnv() };
      child = spawn(command, args, {
        cwd,
        detached: process.platform !== "win32",
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      if (verifyProfilePath && verifyProfileParent) {
        await this.removeBoundEvidenceProfile(verifyProfilePath, verifyProfileParent);
      }
      this.verifyRuns.delete(ownerId);
      return { ok: false, error: `could not start the background test: ${(err as Error).message}` };
    }

    let output = "";
    let finished = false;
    let timedOut = false;
    let cleanupPromise: Promise<boolean> | null = null;
    let cleanupDone = false;
    let cleanupWaitAttached = false;
    let pendingFinish: { code: number | null; how: VerifyState } | null = null;
    const requestCleanup = (signal: NodeJS.Signals, graceMs = 1_500): Promise<boolean> => {
      cleanupPromise ??= terminateSandboxProcessGroup(child, signal, graceMs);
      if (!cleanupWaitAttached) {
        cleanupWaitAttached = true;
        void cleanupPromise.then(
          () => {
            cleanupDone = true;
            finishAfterCleanup();
          },
          () => {
            cleanupDone = true;
            finishAfterCleanup();
          },
        );
      }
      return cleanupPromise;
    };
    const job: VerifyJob = { child, interrupted: false, cleanup: requestCleanup };
    this.verifyJobs.set(ownerId, job);
    const appendOutput = (data: Buffer | string): void => {
      if (output.length >= MAX_VERIFY_OUTPUT) return;
      output += data.toString().slice(0, MAX_VERIFY_OUTPUT - output.length);
    };
    const finishNow = (code: number | null, how: VerifyState): void => {
      if (finished) return;
      finished = true;
      clearTimeout(verifyTimer);
      this.verifyRuns.delete(ownerId);
      this.verifyJobs.delete(ownerId);
      const autoTask = this.autoVerifyTasks.get(ownerId) ?? null;
      this.autoVerifyTasks.delete(ownerId);
      const wasLooping = this.autoVerifyFailures.has(ownerId);
      if (verifyProfilePath) {
        const profilePath = verifyProfilePath;
        const profileParent = verifyProfileParent;
        verifyProfilePath = null;
        verifyProfileParent = null;
        if (profileParent) void this.removeBoundEvidenceProfile(profilePath, profileParent);
      }
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
      this.savePlanRoster(owner);
      // Do not write a result for a cancelled run. The previous context stays.
      if (how !== "cancelled") this.writeVerifyContext(ownerId, tc.label, how, code, output, failed);
      if (autoTask && how !== "cancelled") {
        const verdict = how === "pass" ? "✅ auto-verify passed" : how === "timeout" ? "⏰ auto-verify timed out" : "❌ auto-verify failed";
        this.appendMailboxNote(ownerId, `## Auto-verify\n\nTask: ${autoTask}\nResult: ${verdict} — \`${summary}\``);
      }
      if (how === "pass" || how === "cancelled") {
        this.autoVerifyFailures.delete(ownerId);
        if (how === "pass" && wasLooping && !autoTask) {
          this.appendMailboxNote(ownerId, `## Auto-verify\n\nResult: ✅ verify passed — \`${summary}\``);
        }
      } else if (how === "timeout") {
        // A timed-out suite usually hangs again; retrying would burn up to
        // three 10-minute runs. Report it and stop the loop.
        this.autoVerifyFailures.delete(ownerId);
        if (!autoTask) {
          this.appendMailboxNote(ownerId, `## Verify timed out\n\n\`${summary}\` — automatic re-verify is disabled for timeouts; run Verify manually when the suite is responsive again.`);
        }
      } else {
        const attempts = (this.autoVerifyFailures.get(ownerId) ?? 0) + 1;
        if (attempts >= TerminaApp.MAX_AUTO_VERIFY_ATTEMPTS) {
          this.autoVerifyFailures.delete(ownerId);
          this.appendMailboxNote(ownerId, `## Auto-verify stopped\n\n${attempts} consecutive failed verifies — needs attention before another automatic run.`);
        } else {
          this.autoVerifyFailures.set(ownerId, attempts);
          if (!autoTask) {
            this.appendMailboxNote(ownerId, `## Verify failed\n\n\`${summary}\` — will automatically re-verify when your next run settles (attempt ${attempts} of ${TerminaApp.MAX_AUTO_VERIFY_ATTEMPTS}).`);
          }
        }
      }
      this.send("verify:state", { terminalId: ownerId, verify: owner.verify }, rendererTarget);
    };
    function finishAfterCleanup(): void {
      if (!cleanupDone || !pendingFinish || finished) return;
      const pending = pendingFinish;
      pendingFinish = null;
      finishNow(pending.code, pending.how);
    }
    const finish = (code: number | null, how: VerifyState): void => {
      if (finished) return;
      pendingFinish = { code, how };
      requestCleanup(how === "timeout" ? "SIGKILL" : "SIGTERM");
      finishAfterCleanup();
    };
    const verifyTimer = setTimeout(() => {
      console.warn(`[main] background verify timed out after 600s for ${ownerId}`);
      timedOut = true;
      finish(null, "timeout");
    }, 10 * 60 * 1000);

    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);
    child.once("error", (err) => {
      appendOutput(err.message);
      if (!finished) finish(null, job.interrupted ? "cancelled" : "fail");
    });
    child.once("close", (code) => {
      if (!finished) finish(code, timedOut ? "timeout" : job.interrupted ? "cancelled" : code === 0 ? "pass" : "fail");
    });

    owner.verify = { state: "running", command: tc.label, summary: "running…" };
    this.send("verify:state", { terminalId: ownerId, verify: owner.verify }, rendererTarget);
    return { ok: true };
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
    void job.cleanup("SIGINT");
    return { ok: true };
  }

  private async drainVerifyJobs(ids: Iterable<string> | null, timeoutMs = 2000): Promise<void> {
    const target = ids === null ? null : new Set(ids);
    const matchingJobs = (): VerifyJob[] =>
      [...this.verifyJobs.entries()]
        .filter(([id]) => target === null || target.has(id))
        .map(([, job]) => job);
    const graceMs = Math.max(25, Math.floor(timeoutMs / 2));
    await Promise.allSettled(matchingJobs().map((job) => job.cleanup("SIGTERM", graceMs)));
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
    const root = owner ? this.eventsBindingOf(owner) : this.eventsDirBinding;
    if (!root) return;
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
    void writeBoundOwnedFile({
      root: eventsDir,
      rootIdentity: root,
      components: [`verify-${ownerId}.md`],
      parentIdentity: root,
      content: Buffer.from(md),
      mode: 0o600,
      maxBytes: 16 * 1024,
    }).catch((err) => {
      console.warn(`[main] could not write verify context: ${String(err)}`);
    });
  }

  /**
   * Write the per-turn project snapshot for one agent terminal: a bounded
   * tree inventory so the run starts oriented without spending tool calls
   * on discovery. Stamped so the agent treats it as a hint; file tools see
   * live state. Skipped silently without an events binding.
   */
  private async writeProjectSnapshot(inst: AgentTerminalInstance): Promise<void> {
    if (inst.type !== "agent" || inst.closed) return;
    const ws = this.workspaceById(inst.workspaceId);
    const root = ws?.root ?? inst.cwd;
    if (!root) return;
    const eventsDir = this.eventsDirOf(inst);
    const binding = this.eventsBindingOf(inst);
    if (!binding) return;
    let snapshot: { entries: string[]; truncated: boolean };
    try {
      snapshot = await listProjectSnapshot(root);
    } catch {
      return;
    }
    if (this.terminals.get(inst.id) !== inst || inst.closed) return;
    if (snapshot.entries.length === 0) {
      await this.removeEventLeaf(inst, `project-${inst.id}.md`);
      return;
    }
    const stamp = new Date().toISOString();
    const build = (lines: string[], truncated: boolean): string =>
      `## Project snapshot — \`${basename(root)}\` — ${stamp}\n\n` +
      "Top-level tree first; `…(truncated)` means the listing hit a bound.\n" +
      "A hint only — file tools see live state.\n\n" +
      "```text\n" +
      `${lines.join("\n")}\n` +
      (truncated ? "…(truncated)\n" : "") +
      "```\n";
    // Shrink from the deepest levels until the file fits its byte bound, so
    // medium projects keep a useful head instead of no snapshot at all.
    let lines = snapshot.entries;
    let truncated = snapshot.truncated;
    let md = build(lines, truncated);
    while (Buffer.byteLength(md, "utf8") > MAX_PROJECT_SNAPSHOT_BYTES && lines.length > 0) {
      lines = lines.slice(0, Math.max(0, lines.length - 50));
      truncated = true;
      md = build(lines, truncated);
    }
    if (lines.length === 0) return;
    const content = Buffer.from(md, "utf8");
    await writeBoundOwnedFile({
      root: eventsDir,
      rootIdentity: binding,
      components: [`project-${inst.id}.md`],
      parentIdentity: binding,
      content,
      mode: 0o600,
      maxBytes: MAX_PROJECT_SNAPSHOT_BYTES,
    }).catch((err) => {
      console.warn(`[main] could not write project snapshot: ${String(err)}`);
    });
  }

  /** Refresh snapshots for every agent terminal of a workspace, debounced
   *  across watcher bursts. The timer fires once; a missing workspace or a
   *  closing project skips silently. */
  private scheduleProjectSnapshot(workspaceId: string): void {
    const pending = this.projectSnapshotTimers.get(workspaceId);
    if (pending) clearTimeout(pending);
    this.projectSnapshotTimers.set(
      workspaceId,
      setTimeout(() => {
        this.projectSnapshotTimers.delete(workspaceId);
        if (this.disposed) return;
        const ws = this.workspaceById(workspaceId);
        const owner = ws ? this.projectOfWorkspace(workspaceId) : null;
        if (!ws || !owner || this.projectIsSwitching(owner.id)) return;
        for (const id of ws.terminalIds) {
          const inst = this.terminals.get(id);
          if (inst && inst.type === "agent" && !inst.closed) void this.writeProjectSnapshot(inst);
        }
      }, PROJECT_SNAPSHOT_DEBOUNCE_MS),
    );
  }

  // ------------------------------------------------------------ plan board --

  /** Send the current plan to the renderer. */
  private sendPlan(inst: AgentTerminalInstance, expected?: PtyRendererSendTarget | null): void {
    this.send("plan:update", { instanceId: inst.id, tasks: inst.plan }, expected);
  }

  /** Persist board/verdict handoff after a mutation. Skipped for transient
   *  terminals and mid-switch projects; the save itself is serialized. */
  private savePlanRoster(inst: AgentTerminalInstance): void {
    if (!inst.persist) return;
    const project = this.projectOfTerminal(inst.id);
    if (project && !this.projectIsSwitching(project.id)) this.saveTerminalRoster(project);
  }

  private async applyPlanMessage(
    inst: AgentTerminalInstance,
    text: string,
    expected?: PtyRendererSendTarget | null,
  ): Promise<void> {
    if (!inst.busy) return;
    const tasks = await parsePlanTasks(
      text,
      this.workspaceOfTerminal(inst)?.root ?? null,
      (p) => this.canonicalPath(p),
    );
    if (tasks.length === 0) return;
    inst.plan = tasks;
    this.savePlanRoster(inst);
    // Do not reset touched or tool outcomes. The plan can arrive after
    // the first tool events, and their progress must count.
    reattachDispatchAssignments(
      inst.plan,
      [...this.dispatchRuns]
        .filter(([, entry]) => entry.ownerId === inst.id)
        .map(([workerId, entry]) => ({ workerId, taskText: entry.taskText })),
    );
    this.sendPlan(inst, expected);
  }

  private async updatePlanProgress(
    inst: AgentTerminalInstance,
    path: string,
    expected?: PtyRendererSendTarget | null,
  ): Promise<void> {
    const workspace = this.workspaceOfTerminal(inst);
    if (workspace && markPlanProgress(inst.plan, await this.rel(path, workspace.root))) {
      this.savePlanRoster(inst);
      this.sendPlan(inst, expected);
    }
  }

  private finalizePlan(inst: AgentTerminalInstance, expected?: PtyRendererSendTarget | null): void {
    if (inst.plan.length === 0) return;
    finalizePlanTasks(inst.plan, inst.touched, inst.toolOutcomes);
    this.savePlanRoster(inst);
    this.sendPlan(inst, expected);
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
  /** Aborts the in-flight worker search when a newer query arrives. */
  private searchAbort: AbortController | null = null;

  /**
   * Search past session files for the active project (core bundles). The
   * walk runs in the session worker so the main process stays responsive.
   * Bounded to the 50 newest sessions and 50 total hits. History search
   * never spawns an agent.
   */
  private async searchSessions(rawQuery: string): Promise<SessionHit[]> {
    const project = this.project();
    const cwd = project?.cwd ?? null;
    // Bound the IPC/worker payload up front; the worker re-bounds defensively.
    const query = rawQuery.trim().slice(0, MAX_SESSION_SEARCH_QUERY);
    if (!project || !cwd || query.length < 2) return [];
    const projectCwd = await this.canonicalPath(cwd);
    const key = this.sanitizeSessionDir(projectCwd);
    const coreDir = join(this.coreSessionRoot(), key);
    const seq = ++this.searchSessionsSeq;
    const files = await collectSessionSearchFiles(coreDir);
    const stale = (): boolean => seq !== this.searchSessionsSeq || this.disposed;
    this.searchAbort?.abort();
    const controller = new AbortController();
    this.searchAbort = controller;
    try {
      const result = await this.sessionFork.searchSessions({ query, files, projectCwd }, { signal: controller.signal });
      if (stale()) return [];
      if (!result.ok) {
        console.warn(`[main] session search failed: ${result.error}`);
        return [];
      }
      return result.hits;
    } catch (err) {
      // AbortError on newer queries or teardown; worker failures otherwise.
      // Search is best-effort: never reject into the IPC handler.
      if (!stale() && (!(err instanceof Error) || err.name !== "AbortError")) {
        console.warn(`[main] session search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return [];
    } finally {
      if (this.searchAbort === controller) this.searchAbort = null;
    }
  }

  /**
   * File search over the active project tree (Quick Open, explorer filter).
   * Scores the cached index; caps in quick-open.ts bound main-thread work and
   * the IPC payload. Each caller has its own cancellation lane.
   */
  private async searchProjectFiles(
    query: string,
    source: unknown,
  ): Promise<{ entries: Array<{ relPath: string; matches?: number[] }>; truncated?: boolean }> {
    const project = this.project();
    const cwd = project?.cwd ?? null;
    if (!project || !cwd) return { entries: [] };
    const root = await this.canonicalPath(cwd);
    const { source: lane, seq } = this.fileSearchSeq.next(source);
    const stop = () => this.disposed || !this.fileSearchSeq.current(lane, seq);
    // Score the cached inventory when there is one: only the first search of a
    // project pays for the walk, and a superseded query still returns nothing
    // rather than a partial result.
    const candidates = await this.pathIndex.candidates(root, stop);
    // Empty queries lead with this project's recent files (rankProjectPaths
    // drops recents that left the tree); scored queries ignore them.
    const recent = (this.preferences.recentFiles ?? [])
      .filter((file) => file.projectId === project.id)
      .map((file) => file.relPath);
    const { entries, truncated } = await searchProjectFiles(root, query, { shouldStop: stop, candidates, recent });
    return truncated ? { entries, truncated: true } : { entries };
  }

  /**
   * Grep the active project tree. The pattern is validated before touching
   * the filesystem; the root always comes from main-side project state, so
   * the renderer cannot aim the search outside the project. Each caller has
   * its own cancellation lane.
   */
  private async searchProjectContent(
    pattern: unknown,
    source: unknown,
  ): Promise<{ hits: ContentHit[]; truncated?: boolean; error?: string }> {
    if (typeof pattern !== "string") return { hits: [], error: "pattern must be a string" };
    const unsafe = validateGrepPattern(pattern);
    if (unsafe) return { hits: [], error: unsafe };
    const project = this.project();
    const cwd = project?.cwd ?? null;
    if (!project || !cwd) return { hits: [] };
    const root = await this.canonicalPath(cwd);
    const { source: lane, seq } = this.contentSearchSeq.next(source);
    const stop = () => this.disposed || !this.contentSearchSeq.current(lane, seq);
    const candidates = await this.pathIndex.candidates(root, stop);
    const { hits, truncated } = await searchProjectContent(root, pattern, { shouldStop: stop, candidates });
    return truncated ? { hits, truncated: true } : { hits };
  }

  // ------------------------------------------------------------- dispatch --

  /** Normalize a task path to a comparable key (canonical absolute path). */
  private taskPathKey(p: string, root: string): Promise<string> {
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
  private async dispatchPathKeysInFlight(ownerId: string, root: string): Promise<Set<string>> {
    const used = new Set<string>();
    const owner = this.terminals.get(ownerId);
    if (!owner) return used;
    for (const entry of this.dispatchRuns.values()) {
      if (entry.ownerId !== ownerId) continue;
      const task = findTaskByText(owner.plan, entry.taskText);
      if (!task) continue;
      for (const p of task.paths) used.add(await this.taskPathKey(p, root));
    }
    // Unified claims (Phase 4): live subagent runs hold path claims on the
    // same tree, so dispatch refuses overlapping rows exactly like it does
    // for dispatch workers. Claims anchor at their own cwd (subdirectory
    // terminals key identically through the shared anchor rule).
    for (const claim of this.subagents.claimsForOwner(ownerId)) {
      const anchored = anchorClaimPath(claim.cwd, claim.path, root);
      used.add(await this.taskPathKey(anchored.rel, anchored.root));
    }
    return used;
  }

  /** Live workers plus the jobs about to start. Briefings list sibling claims. */
  private dispatchJobsForBriefing(
    owner: AgentTerminalInstance,
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

  /**
   * Live traversal of pending scheduled plan tasks across agent owners, for
   * the schedule tick. Lazy: mid-tick interleaving matches the inline loop.
   */
  private *agentScheduleTasks(): Generator<ScheduleTickTask> {
    for (const project of this.projects.values()) {
      for (const id of project.terminalIds) {
        const inst = this.terminals.get(id);
        if (!inst || inst.type !== "agent" || inst.closed) continue;
        for (const task of inst.plan) {
          if (task.state !== "pending") continue;
          const spec = parseScheduleMarker(task.text);
          if (!spec) continue;
          yield { ownerId: inst.id, text: task.text, spec, isBusy: () => inst.busy };
        }
      }
    }
  }

  private async dispatchRun(
    ownerId: string,
    taskText?: string,
  ): Promise<{ ok: boolean; error?: string; dispatched?: number }> {
    const owner = this.terminals.get(ownerId);
    if (!owner || owner.type !== "agent") return { ok: false, error: "terminal not found" };
    const rendererTarget = this.captureRendererSendTarget();
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
    const picked = await pickDispatchTasks({
      plan: owner.plan,
      remainingSlots: MAX_DISPATCH_WORKERS - this.ownerDispatchCount(owner.id),
      inFlightPathKeys: await this.dispatchPathKeysInFlight(owner.id, dispatchRoot),
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
      const flush = await this.flushDirtyModels(`dispatch:${ownerId}`, ownerWs.id, 5000, rendererTarget);
      if (!flush.ok) return { ok: false, error: "could not save editor changes" };
    }
    const jobs = chosen.map((task) => ({ task, id: this.allocateTerminalId() }));
    try {
      this.ensureEventsDir();
      const briefingJobs = this.dispatchJobsForBriefing(owner, jobs);
      for (const job of jobs) {
        await this.writeDispatchBriefing(job.id, job.task, briefingJobs);
        await this.writeDispatchStartupControl(job.id, job.task.text);
      }
    } catch (err) {
      for (const job of jobs) {
        this.clearMailbox(job.id);
        await this.removeDispatchStartupControl(job.id);
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    let dispatched = 0;
    for (const job of jobs) {
      try {
        const worker = await this.createTerminal(undefined, {
          type: "agent",
          engine: "core",
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
        await this.removeDispatchStartupControl(job.id);
        console.warn(`[main] dispatch worker failed: ${(err as Error).message}`);
      }
    }
    if (dispatched === 0) {
      for (const job of jobs) {
        this.clearMailbox(job.id);
        await this.removeDispatchStartupControl(job.id);
      }
      return { ok: false, error: "no dispatch worker started" };
    }
    this.sendPlan(owner, rendererTarget);
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

  private async writeDispatchBriefing(workerId: string, assigned: PlanTask, jobs: Array<{ task: PlanTask; id: string }>): Promise<void> {
    let briefing = formatDispatchBriefing(workerId, assigned, jobs);
    if (briefing.length > TerminaApp.MAX_MAILBOX_BYTES) {
      briefing = briefing.slice(0, TerminaApp.MAX_MAILBOX_BYTES) + "\n…";
    }
    this.dispatchMailbox.set(workerId, [briefing]);
    await this.flushMailbox(workerId);
  }

  private async writeDispatchStartupControl(workerId: string, taskText: string): Promise<void> {
    const control = { opId: randomUUID(), action: "structured", content: [{ type: "text", text: taskText }] };
    this.ensureEventsDir();
    const binding = this.eventsDirBinding;
    if (!binding) throw new Error("events directory is not bound");
    await writeBoundOwnedFile({
      root: this.eventsDir,
      rootIdentity: binding,
      components: [`startup-control-${workerId}.json`],
      parentIdentity: binding,
      content: Buffer.from(JSON.stringify(control)),
      mode: 0o600,
      maxBytes: 64 * 1024,
    });
  }

  private async removeDispatchStartupControl(workerId: string): Promise<void> {
    await this.removeEventsLeaf(`startup-control-${workerId}.json`);
  }

  /** Remove one launch-private events leaf using the current root binding. */
  private async removeEventsLeaf(name: string): Promise<void> {
    const root = this.eventsDirBinding;
    if (!root) return;
    await this.removeBoundEventLeaf(this.eventsDir, root, name);
  }

  /** Remove one recorded prompt payload through the matching events binding. */
  private async removePromptPayload(eventsDir: string, fileName: string): Promise<void> {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(fileName)) return;
    const requested = resolve(eventsDir);
    let binding: PromotionFsIdentity | null = null;
    if (requested === resolve(this.eventsDir)) {
      binding = this.eventsDirBinding;
    } else {
      for (const inst of this.terminals.values()) {
        if (resolve(this.eventsDirOf(inst)) !== requested) continue;
        binding = this.eventsBindingOf(inst);
        break;
      }
    }
    if (!binding) return;
    await this.removeBoundEventLeaf(eventsDir, binding, fileName);
  }

  /** Remove leftover dispatch control and mailbox files. The events
   *  directory persists across launches, and terminal ids restart at
   *  term-1, so a stale control would submit the old task. */
  private async cleanupStaleDispatchFiles(): Promise<void> {
    if (!this.eventsDirProvenanceTrusted) return;
    const root = this.eventsDirBinding;
    if (!root) return;
    let entries: Array<{ name: string; identity: PromotionFsIdentity; kind: "directory" | "file" | "symlink" | "other" }> = [];
    try {
      entries = await boundPromotionListEntries({ root: this.eventsDir, rootIdentity: root });
    } catch {
      return;
    }
    for (const entry of entries) {
      const { name } = entry;
      if (
        name === "startup-control.json" ||
        name.startsWith("mailbox-term-") ||
        name.startsWith("startup-control-term-") ||
        isSubagentManagedFile(name) ||
        name.startsWith("image-term-") ||
        name.startsWith("images-term-") ||
        name.startsWith("images-claim-term-") ||
        name.startsWith("images-owner-term-") ||
        name.startsWith("images-tx-term-")
      ) {
        if (entry.kind === "file" || entry.kind === "symlink") {
          await this.removeBoundEventLeaf(this.eventsDir, root, name, entry.identity);
        }
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
    if (this.eventsDirReady && this.eventsDirBinding) return;
    throw new Error("events directory is not bound");
  }

  /** Bind the launch-persistent events root before any scratch cleanup. */
  private async prepareEventsDir(): Promise<void> {
    const parentPath = dirname(resolve(this.eventsDir));
    const parentInfo = await lstat(parentPath, { bigint: true });
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error("events parent is not a real directory");
    const parentIdentity = await boundPromotionOpenDirectory({
      path: parentPath,
      expectedIdentity: { dev: String(parentInfo.dev), ino: String(parentInfo.ino) },
    });
    const eventsName = basename(resolve(this.eventsDir));
    if (!eventsName || eventsName === "." || eventsName === ".." || eventsName.includes("/") || eventsName.includes("\\")) {
      throw new Error("events directory name is invalid");
    }
    let currentIdentity: PromotionFsIdentity | undefined;
    try {
      const currentInfo = await lstat(this.eventsDir, { bigint: true });
      if (!currentInfo.isDirectory() || currentInfo.isSymbolicLink()) throw new Error("events directory is not a real directory");
      currentIdentity = { dev: String(currentInfo.dev), ino: String(currentInfo.ino) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let prior: PromotionFsIdentity | null = null;
    try {
      const raw = JSON.parse(await readFile(this.eventsDirAnchorPath, "utf8")) as Record<string, unknown>;
      const path = raw.path;
      const dev = raw.dev;
      const ino = raw.ino;
      if (path === resolve(this.eventsDir) && typeof dev === "string" && /^\d+$/.test(dev) && typeof ino === "string" && /^\d+$/.test(ino)) {
        prior = { dev, ino };
      }
    } catch {
      /* A missing/corrupt anchor makes prior-launch cleanup untrusted. */
    }
    let binding: PromotionFsIdentity;
    let trusted = false;
    if (prior) {
      try {
        binding = await boundPromotionOpenDirectory({ path: this.eventsDir, expectedIdentity: prior });
        trusted = binding.dev === prior.dev && binding.ino === prior.ino;
      } catch {
        // Rebind the current root for this launch, but do not touch scratch
        // from the prior root after an ancestor/root replacement.
        if (!currentIdentity) {
          binding = await boundPromotionEnsureDirectory({
            path: this.eventsDir,
            trustedParent: { path: parentPath, identity: parentIdentity, name: eventsName },
          });
        } else {
          binding = await boundPromotionEnsureDirectory({
            path: this.eventsDir,
            expectedIdentity: currentIdentity,
            trustedParent: { path: parentPath, identity: parentIdentity, name: eventsName },
          });
        }
      }
    } else {
      binding = currentIdentity
        ? await boundPromotionEnsureDirectory({
          path: this.eventsDir,
          expectedIdentity: currentIdentity,
          trustedParent: { path: parentPath, identity: parentIdentity, name: eventsName },
        })
        : await boundPromotionEnsureDirectory({
          path: this.eventsDir,
          trustedParent: { path: parentPath, identity: parentIdentity, name: eventsName },
        });
    }
    this.eventsDirBinding = binding;
    this.eventsDirProvenanceTrusted = trusted;
    this.eventsDirReady = true;
    const anchorParentPath = dirname(this.eventsDirAnchorPath);
    const anchorParentInfo = await lstat(anchorParentPath, { bigint: true });
    if (!anchorParentInfo.isDirectory() || anchorParentInfo.isSymbolicLink()) throw new Error("events anchor parent is not a real directory");
    const anchorParent = await boundPromotionOpenDirectory({
      path: anchorParentPath,
      expectedIdentity: { dev: String(anchorParentInfo.dev), ino: String(anchorParentInfo.ino) },
    });
    await writeBoundOwnedFile({
      root: anchorParentPath,
      rootIdentity: anchorParent,
      components: [basename(this.eventsDirAnchorPath)],
      parentIdentity: anchorParent,
      content: Buffer.from(JSON.stringify({ path: resolve(this.eventsDir), dev: binding.dev, ino: binding.ino, type: "directory" })),
      mode: 0o600,
      maxBytes: 16 * 1024,
    });
    if (!trusted) return;
    try {
      const workspace = await bindOwnedDirectory(this.sessionWorkspaceDir, binding);
      await removeBoundOwnedDirectory({ binding: workspace });
    } catch (error) {
      // Missing scratch is normal.  Identity/type/ancestor failures retain
      // the path and keep the main process moving without path recursion.
      console.warn(`[main] session workspace cleanup retained ${this.sessionWorkspaceDir}: ${String(error)}`);
    }

    // Ensure the worker never has to perform a first-create pathname mkdir.
    // If prior provenance was untrusted or the fixed name was retained, use a
    // fresh native-owned leaf and pass that exact path to the session worker.
    try {
      await boundPromotionEnsureDirectory({
        path: this.sessionWorkspaceDir,
        trustedParent: { path: this.eventsDir, identity: binding, name: basename(this.sessionWorkspaceDir) },
      });
    } catch {
      const workspace = await createOwnedDirectory(this.eventsDir, binding, "session-workspace-");
      this.sessionWorkspaceDir = workspace.path;
    }
  }

  private appendMailboxNote(terminalId: string, note: string): void {
    if (this.isWorldlineTerminal(terminalId)) return;
    const notes = this.dispatchMailbox.get(terminalId) ?? [];
    notes.push(note);
    while (notes.length > TerminaApp.MAX_MAILBOX_NOTES) notes.shift();
    this.dispatchMailbox.set(terminalId, notes);
    void this.flushMailbox(terminalId);
  }

  private async flushMailbox(terminalId: string): Promise<void> {
    const path = this.mailboxFile(terminalId);
    if (!path) return;
    const notes = this.dispatchMailbox.get(terminalId) ?? [];
    try {
      if (notes.length === 0) {
        await this.removeEventsLeaf(basename(path));
        return;
      }
      let body = notes.join("\n\n---\n\n");
      while (body.length > TerminaApp.MAX_MAILBOX_BYTES && notes.length > 1) {
        notes.shift();
        body = notes.join("\n\n---\n\n");
      }
      if (body.length > TerminaApp.MAX_MAILBOX_BYTES) body = body.slice(0, TerminaApp.MAX_MAILBOX_BYTES) + "\n…";
      this.ensureEventsDir();
      const binding = this.eventsDirBinding;
      if (!binding) throw new Error("events directory is not bound");
      await writeBoundOwnedFile({
        root: this.eventsDir,
        rootIdentity: binding,
        components: [basename(path)],
        parentIdentity: binding,
        content: Buffer.from(body, "utf8"),
        mode: 0o600,
        maxBytes: TerminaApp.MAX_MAILBOX_BYTES + 64,
      });
    } catch (err) {
      console.warn(`[main] could not write mailbox context: ${(err as Error).message}`);
    }
  }

  private clearMailbox(terminalId: string): void {
    if (!this.dispatchMailbox.has(terminalId)) return;
    this.dispatchMailbox.delete(terminalId);
    const path = this.mailboxFile(terminalId);
    if (path) {
      void this.removeEventsLeaf(basename(path));
    }
  }

  private writeDispatchSettleNote(worker: AgentTerminalInstance, status: "settled" | "exited"): void {
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
  private collectWorker(
    worker: AgentTerminalInstance,
    owner: AgentTerminalInstance,
    expected?: PtyRendererSendTarget | null,
  ): void {
    let changed = false;
    for (const [p, f] of worker.modified) {
      if (!owner.modified.has(p)) {
        this.setBounded(owner.modified, p, f, TerminaApp.MAX_MODIFIED_FILES);
        changed = true;
      }
    }
    for (const [p, b] of worker.baselines) {
      if (!owner.baselines.has(p)) this.setBaseline(owner, p, b);
    }
    if (changed) this.send("modified:list", { instanceId: owner.id, files: [...owner.modified.values()] }, expected);
  }

  // ----------------------------------------------------------------- mine ----

  /** Mark a file as the user's own (or clear the mark). */
  private setMineFile(path: string, mine: boolean, owner: unknown): Promise<void> {
    const target = this.projectWorkspace(owner);
    const project = target?.project ?? null;
    const workspace = target?.workspace ?? null;
    if (typeof path !== "string" || typeof mine !== "boolean") return Promise.reject(new Error("invalid Mine update"));
    if (!project || !workspace || !workspace.primary || this.disposed || this.projectIsSwitching(project.id)) return Promise.reject(new Error("project is not available"));
    const commit = project.mineCommit.catch(() => undefined).then(async () => {
      const managed = await this.managedPath(path, workspace.id, true);
      if (!managed || managed.workspace.id !== workspace.id) throw new Error("path is outside the project workspace");
      const blocked = this.assertWorkspaceWritable(managed.workspace.id);
      if (blocked) throw new Error(blocked);
      const p = managed.path;
      const wasMine = project.mineFiles.has(p);
      if (wasMine === mine) return;
      if (mine) {
        if (project.mineFiles.size >= TerminaApp.MAX_MINE_FILES) throw new Error("too many Mine files");
        project.mineFiles.add(p);
      } else {
        project.mineFiles.delete(p);
      }
      try {
        await this.saveMineFiles(project);
        await this.writeMineContext(project);
      } catch (err) {
        if (wasMine) project.mineFiles.add(p);
        else project.mineFiles.delete(p);
        await this.saveMineFiles(project).catch(() => undefined);
        await this.writeMineContext(project).catch(() => undefined);
        throw err;
      }
    });
    project.mineCommit = commit;
    return commit;
  }

  /** Publish machine-only Mine policy for each terminal's mutation tools. */
  private async writeMineContext(project: ProjectState): Promise<void> {
    const agents = [...this.terminals.values()].filter((inst) => inst.type === "agent" && this.projectOfTerminal(inst.id) === project);
    const content = Buffer.from(JSON.stringify([...project.mineFiles].sort()));
    const writes = await Promise.allSettled(
      agents.map(async (inst) => {
        await this.removeEventLeaf(inst, `mine-${inst.id}.md`);
        if (project.mineFiles.size === 0) {
          await this.removeEventLeaf(inst, `mine-${inst.id}.json`);
          return;
        }
        await this.writeEventLeaf(inst, `mine-${inst.id}.json`, content, 64 * 1024);
      }),
    );
    const failed = writes.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  /** Clear the marks and their context files (project switch). The saved
   *  marks stay in their file: revisiting the project restores them. */
  private async clearMineFiles(project: ProjectState): Promise<void> {
    project.mineFiles.clear();
    const agents = [...this.terminals.values()].filter((inst) => inst.type === "agent" && this.projectOfTerminal(inst.id) === project);
    await Promise.all(
      agents.flatMap((inst) => [
        this.removeEventLeaf(inst, `mine-${inst.id}.md`),
        this.removeEventLeaf(inst, `mine-${inst.id}.json`),
      ]),
    );
  }

  /** The persisted marks file for one project. */
  private async mineFilePath(project: ProjectState): Promise<string> {
    const cwd = await this.canonicalPath(project.cwd);
    return join(this.eventsDir, `mine-${this.sanitizeSessionDir(cwd)}.json`);
  }

  /** Load the marks saved for one project (restart persistence). */
  private async loadMineFiles(project: ProjectState): Promise<void> {
    try {
      const raw = await readFile(await this.mineFilePath(project), "utf8");
      const list = JSON.parse(raw) as string[];
      if (Array.isArray(list)) {
        for (const p of list) {
          if (project.mineFiles.size >= TerminaApp.MAX_MINE_FILES) break;
          if (typeof p !== "string") continue;
          const workspace = this.primaryWorkspace(project);
          const managed = workspace ? await this.managedPath(p, workspace.id, true) : null;
          if (managed && managed.workspace.id === workspace?.id) project.mineFiles.add(managed.path);
        }
      }
    } catch {
      /* no marks saved yet */
    }
  }

  /** Save the marks so a restart restores the ownership. */
  private async saveMineFiles(project: ProjectState): Promise<void> {
    const root = this.eventsDirBinding;
    if (!root) throw new Error("events directory is not bound");
    await writeBoundOwnedFile({
      root: this.eventsDir,
      rootIdentity: root,
      components: [basename(await this.mineFilePath(project))],
      parentIdentity: root,
      content: Buffer.from(JSON.stringify([...project.mineFiles])),
      mode: 0o600,
      maxBytes: 256 * 1024,
    });
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
      // Preserve the first known pre-edit state so the injected context shows
      // the user's net change across an idle editing burst.
      if (existing.prev === undefined && capped.prev !== undefined) existing.prev = capped.prev;
      existing.content = capped.content;
      existing.at = capped.at;
    } else {
      edits.set(capped.path, capped);
      if (edits.size > TerminaApp.USER_EDITS_MAX) {
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
  private async writeUserEditsContext(): Promise<void> {
    if (this.userEditsByWorkspace.size === 0) return;
    const writes: Promise<void>[] = [];
    for (const inst of this.terminals.values()) {
      if (inst.type !== "agent") continue;
      const ws = this.workspaceOfTerminal(inst);
      if (!ws) continue;
      const edits = this.userEditsOf(ws);
      if (edits.size === 0) continue;
      const md = this.buildUserEditsMarkdown(edits);
      writes.push(this.writeEventLeaf(inst, `edits-${inst.id}.md`, Buffer.from(md), 16 * 1024).catch((err) => {
        console.warn(`[main] could not write edits context: ${(err as Error).message}`);
      }));
    }
    await Promise.all(writes);
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
    // Informational only. Do not tell the model to stop or ask. Mine and
    // dispatch mailbox carry the real do-not-touch rules in other files.
    out.push("These files changed after the last agent run. Snippets are partial. Read a listed file when you need more than the snippet.");
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
      // Remove from the terminal's OWN events dir: a candidate's bridge
      // reads its candidate dir, not the primary's.
      void this.removeEventLeaf(inst, `edits-${id}.md`);
    }
  }

  /** Close one candidate by its exact terminal identity after a failed
   * startup handshake. Worldline has already removed its routing, so any
   * late sidecar records from this process are intentionally ignored. */
  private terminateCandidate(id: string): void {
    this.terminals.get(id)?.pty.killGroup();
    this.closeTerminal(id);
  }

  private closeTerminal(id: string): void {
    const inst = this.terminals.get(id);
    if (!inst || inst.closed) return;
    // A user close invalidates queued output.  The PTY exit callback may run
    // later, but its stale tail must not leak into a newly opened terminal
    // that happens to reuse the same renderer tab.
    inst.closed = true;
    this.ptyEgress.cancel(id, inst.generation);
    inst.pty.cancelOutput();
    this.newCommandBuffers.delete(id);
    this.busyAgents.delete(id);
    this.autoVerifyTasks.delete(id);
    this.autoVerifyFailures.delete(id);
    if (inst.captureTimer) {
      clearTimeout(inst.captureTimer);
      inst.captureTimer = null;
    }
    // Closing cancels the debounce timer, and PTY exit would cancel a
    // rescheduled one. Enqueue on the workspace now so leftover hints still
    // enter the lineage before the process map drops this terminal.
    const captureWs = this.workspaceOfTerminal(inst);
    if (
      captureWs
      && inst.currentRun
      && (inst.momentDots.length > 0 || inst.pendingHints.size > 0)
      && !this.disposed
      && !this.projectIsSwitching(this.projectOfTerminal(inst.id)?.id)
    ) {
      this.trackRecordingTask(this.runMomentCapture(inst, captureWs));
    }
    if (this.verifyRuns.has(id)) this.cancelVerify(id);
    inst.pty.killGroup("SIGTERM");
    inst.pty.kill("SIGTERM");
    const existingOnExit = inst.pty.onExit;
    const killWatchdog = setTimeout(() => {
      if (!this.terminals.has(id) || inst.exitHandled) return;
      try { inst.pty.killGroup("SIGKILL"); } catch {}
      try { inst.pty.kill("SIGKILL"); } catch {}
      // Native PTY exit delivery is best-effort after forced termination. Run
      // the same fenced cleanup path so stale terminal state cannot survive.
      if (existingOnExit) {
        try {
          existingOnExit(137);
        } catch (error) {
          console.warn(`[main] forced terminal cleanup failed for ${id}: ${(error as Error).message}`);
        }
      }
    }, 2000);
    inst.pty.onExit = async (code) => {
      clearTimeout(killWatchdog);
      if (existingOnExit) await existingOnExit(code);
    };
    // Native exit or the hard-timeout fallback removes it from the map.
  }

  private closeUserTerminal(id: string): void {
    const inst = this.terminals.get(id);
    if (!inst || inst.closed) return;
    const owner = this.projectOfTerminal(id);
    this.closeTerminal(id);
    // Persist the user's close intent immediately. Waiting for the process
    // exit callback loses it when the app quits while PTY teardown is still
    // in flight. saveTerminalRoster excludes the now-closed live instance.
    if (inst.persist && owner && !this.projectIsSwitching(owner.id)) {
      // Failed restores have no visible pane to close. Closing the last live
      // tab is therefore also the only explicit way to clear those hidden
      // retry entries and persist a genuinely empty project roster.
      owner.unrestoredTerminals = this.persistLive(owner).length === 0
        ? []
        : owner.unrestoredTerminals.filter((entry) => entry.id !== id);
      this.saveTerminalRoster(owner);
    }
    // Closed terminals remain in the process map until ordered PTY output
    // drains, but must disappear from the authoritative renderer roster now.
    this.sendInstances();
  }

  private closeActiveTerminal(): void {
    const inst = this.activeProjectTerminals().at(-1);
    if (inst) this.closeUserTerminal(inst.id);
  }

  private async abortActive(): Promise<void> {
    const inst = this.activeProjectTerminals().at(-1);
    if (inst) inst.pty.write("\x03");
  }

  /** The terminals of the active project, in creation order. */
  private activeProjectTerminals(): AgentTerminalInstance[] {
    const project = this.project();
    return [...this.terminals.values()].filter((inst) => !inst.closed && (!project || project.terminalIds.has(inst.id)));
  }

  private instanceList(): InstanceSummary[] {
    return [...this.terminals.values()].filter((t) => !t.closed).map((t) => ({
      id: t.id,
      generation: t.generation,
      cwd: t.cwd,
      busy: t.busy,
      type: t.type,
      engine: t.engine,
      shellName: t.shellName,
      workspaceId: t.workspaceId,
      projectId: t.projectId ?? undefined,
      dispatchWorker: this.dispatchWorkers.has(t.id),
      dispatchTask: this.dispatchWorkers.get(t.id),
      modified: [...t.modified.values()],
      recorderState: t.recorderState,
      recorderDetail: t.recorderDetail,
      verify: t.type === "agent" ? t.verify : null,
      model: t.type === "agent" ? t.model : null,
      thinkingLevel: t.type === "agent" ? t.thinkingLevel : null,
      usage: t.type === "agent" ? t.usage : null,
    }));
  }

  private sendInstances(expected?: PtyRendererSendTarget | null): void {
    this.send("instances:list", this.instanceList(), expected);
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

  private async drainSidecarQueues(ids?: Iterable<string>): Promise<void> {
    const target = ids === undefined ? null : new Set(ids);
    while (true) {
      const pending = [...this.sidecarQueues]
        .filter(([id]) => target === null || target.has(id))
        .filter(([, queue]) => {
          const stats = queue.stats();
          return stats.items > 0 || stats.inFlight > 0;
        })
        .map(([, queue]) => queue.drain());
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }

  private clearSidecarQueues(ids?: Iterable<string>): void {
    if (ids === undefined) {
      this.sidecarQueues.clear();
      return;
    }
    for (const id of ids) this.sidecarQueues.delete(id);
  }

  private enqueueSidecarEvent(terminalId: string, event: SidecarEvent): SidecarEventDelivery {
    if (this.disposed) return { accepted: false };
    // A candidate's PTY can publish session_ready during the synchronous
    // spawn inside createTerminal, before that method has installed its
    // AgentTerminalInstance in the live map. Keep the durable sidecar record at
    // the tailer's cursor until the instance exists; accepting it here would
    // make handleSidecarEvent drop the startup boundary as "terminal closed".
    // Child subagent streams are tailed on the shared tailer but owned by
    // the subagent host, not by a terminal. Unknown ids stay on disk.
    if (!this.terminals.has(terminalId) && !this.subagents.hasStream(terminalId)) return { accepted: false };
    // A project switch is a temporary admission stop.  Returning without
    // accepting would make the tailer advance past a boundary event, so the
    // caller must retry the same durable record instead.
    if (this.projectIsSwitching(this.projectOfTerminal(terminalId)?.id)) return { accepted: false };
    let queue = this.sidecarQueues.get(terminalId);
    if (!queue) {
      queue = new SidecarEventQueue(
        (queuedEvent) => this.handleSidecarEvent(terminalId, queuedEvent),
        {
          onError: (error, failedEvent) => console.warn(`[main] sidecar ${failedEvent.t} failed: ${error.message}`),
        },
      );
      this.sidecarQueues.set(terminalId, queue);
    }
    // SidecarTailer treats false as backpressure and keeps this event on disk.
    return queue.enqueueTracked(event);
  }

  private async handleSidecarEvent(terminalId: string, event: SidecarEvent): Promise<void> {
    if (this.disposed) return;
    if (this.subagents.hasStream(terminalId)) {
      // Child liveness only (booted/activity/touched for merge evidence).
      // Settlement stays exit-authoritative; no dots are fabricated onto
      // any terminal timeline.
      this.subagents.noteChildEvent(terminalId, event.t, event.t === "tool" ? event.path : undefined);
      return;
    }
    const inst = this.terminals.get(terminalId);
    if (!inst) return;
    // A sidecar callback can yield across store/file work. Keep every push
    // from this event tied to the document that admitted it.
    const rendererTarget = this.captureRendererSendTarget();
    switch (event.t) {
      // ---- run-boundary events (WORLDLINES §6.3) ----
      case "preflight_request":
        {
          const task = this.handlePreflightRequest(inst, String(event.requestId ?? ""), Number(event.deadlineAt), rendererTarget);
          this.trackRecordingTask(task);
          await task;
        }
        break;
      case "preflight_cancel": {
        const requestId = String(event.requestId ?? "");
        for (const [token, pending] of this.pendingPreflights) {
          if (pending.terminalId !== inst.id || pending.requestId !== requestId) continue;
          this.expirePreflight(token);
          break;
        }
        break;
      }
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
            await this.clearForNewSession(terminalId, rendererTarget);
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
        {
          const task = this.handleCheckpointRequest(
            inst,
            String(event.requestId ?? ""),
            String(event.kind ?? "settled"),
            String(event.entryId ?? ""),
            rendererTarget,
          );
          this.trackRecordingTask(task);
          await task;
        }
        break;
      case "checkpoint_result":
        // Informational; the run record carries the result already.
        break;
      case "session_ready": {
        // The bridge consumed the candidate startup control.
        const readyOk = event.ok === true;
        this.projectOfTerminal(terminalId)?.worldlines?.onSessionReady(terminalId, readyOk, event.error ?? null, {
          bridgeId: event.bridgeId,
          seq: event.seq,
          generation: event.generation,
          opId: event.opId,
        });
        break;
      }
      case "agent_settings":
        this.applyAgentSettings(inst, event.model, event.thinkingLevel, event.usage, rendererTarget);
        break;
      case "agent_start":
        this.applyAgentSettings(inst, event.model, event.thinkingLevel, undefined, rendererTarget);
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
        this.sendPlan(inst, rendererTarget);
        this.sendTimelinePrefix(inst, rendererTarget);
        // Refresh untouched-file baselines from the run start, but retain the
        // original baseline of every file already in Change Review. The
        // modified list spans turns, so replacing those baselines here would
        // make earlier files appear unchanged after the next prompt.
        this.prepareRunBaselines(inst, startWs?.watcher?.lastContents);
        inst.runSnapshots.clear();
        inst.runSnapshotBytes = 0;
        inst.lastToolAt.clear();
        inst.pendingHints = new Set();
        inst.momentDots = [];
        inst.captureTimer = null;
        // The run records moments: the recorder state follows the store.
        const startWs2 = this.workspaceOfTerminal(inst);
        void agentOwner?.storePromise?.then((s) => {
          if (!this.disposed && !this.projectIsSwitching(agentOwner?.id) && this.terminals.has(inst.id)) {
            this.setRecorderState(inst, !s ? "paused" : startWs2?.indexReady ? "indexing" : "ready", rendererTarget);
          }
        });
        // Couple the run to its start preflight when the token matches. Publish
        // the boundary only when it has both immutable source and session
        // addresses; every visible timeline dot is therefore forkable.
        await this.coupleRunStart(inst, event);
        if (inst.currentRun?.startStateId) {
          this.pushTimeline(inst, {
            t: "agent_start",
            stateId: inst.currentRun.startStateId,
            entryId: event.parentEntryId ?? event.entryId ?? null,
            model: inst.currentRun.model,
            runStartStateId: inst.currentRun.startStateId,
          }, rendererTarget);
        }
        // A dispatch worker started: mark its task active on the owner board.
        const dispatchStart = this.dispatchRuns.get(inst.id);
        if (dispatchStart) {
          const ownerInst = this.terminals.get(dispatchStart.ownerId);
          const task = ownerInst ? findTaskByText(ownerInst.plan, dispatchStart.taskText) : undefined;
          if (ownerInst && task) {
            task.state = "active";
            this.savePlanRoster(ownerInst);
            this.sendPlan(ownerInst, rendererTarget);
          }
        }
        this.send("busy", { instanceId: inst.id, busy: true }, rendererTarget);
        this.sendInstances(rendererTarget);
        // Push invalidation after the busy state. The renderer must not start
        // evidence from the stale idle view between these two updates.
        if (candHit) this.markCandidateEvidenceStale(candHit.comparisonId);
        break;
      case "agent_settled":
        inst.busy = false;
        this.busyAgents.delete(inst.id);
        if (event.error && inst.currentRun) {
          inst.currentRun.replayable = false;
          inst.currentRun.reason = `session storage failed: ${event.error}`;
          inst.currentRun.settledAt = Date.now();
          inst.currentRun = null;
          this.send("worldline:runs-changed", { terminalId: inst.id }, rendererTarget);
        }
        this.finalizePlan(inst, rendererTarget);
        // A dispatch worker finished: mark the owner task done only when
        // the worker's last file-tool outcomes cover that task's paths.
        const dispatchEnd = this.dispatchRuns.get(inst.id);
        if (dispatchEnd) {
          this.writeDispatchSettleNote(inst, "settled");
          const ownerInst = this.terminals.get(dispatchEnd.ownerId);
          const task = ownerInst ? findTaskByText(ownerInst.plan, dispatchEnd.taskText) : undefined;
          if (ownerInst) {
            if (task && taskIsComplete(task.paths, inst.touched, inst.toolOutcomes)) task.state = "done";
            this.savePlanRoster(ownerInst);
            this.sendPlan(ownerInst, rendererTarget);
            this.collectWorker(inst, ownerInst, rendererTarget);
            this.maybeAutoVerify(ownerInst, task?.state === "done" ? task.text : null);
          }
          // The run entry goes; the tab label stays until the terminal exits.
          this.dispatchRuns.delete(inst.id);
        } else if (inst.type === "agent") {
          // The owner's own run settled with a failing verify on record:
          // re-verify the fix automatically, bounded by the attempt cap.
          this.maybeAutoReverify(inst);
          // Refresh static diagnostics in the background when the tree moved.
          // Generation-cached and silent; the result lands in context.
          void this.diagnostics.run(inst);
        }
        // The settled marker is published by the checkpoint handler only after
        // its immutable source state has been captured.
        this.send("busy", { instanceId: inst.id, busy: false }, rendererTarget);
        this.send("modified:list", { instanceId: inst.id, files: [...inst.modified.values()] }, rendererTarget);
        this.sendInstances(rendererTarget);
        break;
      case "plan": {
        await this.applyPlanMessage(inst, String(event.text ?? ""), rendererTarget);
        break;
      }
      case "tool": {
        const rawPath = String(event.path ?? "");
        // Resolve every sidecar path from the terminal's own workspace. Never
        // consult the active project for hidden terminals or malformed state.
        const toolWs = this.workspaceOfTerminal(inst);
        const toolProject = this.projectOfTerminal(inst.id);
        if (!toolWs || !toolProject) return;
        const path = await this.canonicalPath(isAbsolute(rawPath) ? rawPath : join(toolWs.root, rawPath));
        if (!path) return;
        // Reject file-tool paths outside this workspace (including symlink
        // escapes); the sandbox is defense in depth, not the owner lookup.
        if (!await this.withinRoot(path, toolWs.root)) return;
        const toolName = String(event.toolName ?? "");
        // Pre-run baseline capture. The rules:
        // - agent_start snapshots the watcher cache (best source when present).
        // - edit/apply_patch reconstruct from the edit args — correct in both
        //   poll orderings (landed or not). They also recover a null baseline
        //   invalid baseline from a first-touch write without cached content.
        // - write/create_file defer to the watcher change event, which knows
        //   the authoritative status and carries prev when available.
        // A bounded producer preview is diagnostic only; applying it would
        // manufacture a partial baseline. The watcher/file remains the
        // authority for that state-mutating tool.
        const eventEdits = event.editsTruncated === true ? undefined : event.edits;
        if (toolName === "edit" || toolName === "apply_patch") {
          const current = inst.baselines.get(path);
          if (current === undefined) {
            const status = inst.modified.get(path)?.status;
            if (status !== "created") {
              const baseline = (await this.reconstructBaseline(path, eventEdits)) ?? this.workspaceOfTerminal(inst)?.watcher?.lastContents.get(path);
              if (baseline !== undefined) this.setBaseline(inst, path, baseline);
            }
            // A file created this run stays undefined until the watcher confirms it.
          } else if (current === null && inst.modified.get(path)?.status === "modified") {
            const baseline = await this.reconstructBaseline(path, eventEdits);
            if (baseline !== undefined) this.setBaseline(inst, path, baseline);
          }
        }
        const status = toolName === "write" ? await this.classifyWrite(path) : "modified";
        await this.recordModified(inst, path, status);
        if ((toolName === "write" || toolName === "create_file") && !inst.baselines.has(path)) {
          this.trackRecordingTask(this.fillBaseline(inst, path, status));
        }
        const rel = await this.rel(path, toolWs!.root);
        inst.touched.add(rel);
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId.trim() : "";
        if (toolCallId && rel) inst.pendingFileTools.set(toolCallId, rel);
        await this.updatePlanProgress(inst, path, rendererTarget);
        this.sendTimelinePrefix(inst, rendererTarget);
        this.send("tool:target", { projectId: toolProject.id, workspaceId: toolWs.id, path, relPath: rel, toolName }, rendererTarget);
        // Session Timeline: snapshot the file as of this tool call. Create
        // the event object first so a delayed content fill can find it later.
        // The tool call and entry ids make the dot a forkable moment.
        const ev: Omit<TimelineEvent, "seq" | "ts"> = {
          t: "tool",
          toolName,
          path,
          relPath: await this.rel(path, toolWs!.root),
          toolCallId: event.toolCallId ?? null,
          entryId: event.entryId ?? null,
          model: inst.currentRun?.model ?? null,
        };
        const snapshot = await this.toolSnapshot(inst, path, toolName, eventEdits, ev);
        if (snapshot?.content !== undefined) ev.content = snapshot.content;
        if (snapshot?.status) ev.status = snapshot.status;
        this.pushTimeline(inst, ev, rendererTarget);
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
        this.sendTimelinePrefix(inst, rendererTarget);
        // The tool finished: schedule the moment capture for its dots.
        if (inst.currentRun) this.scheduleMomentCapture(inst, rendererTarget);
        break;
      }
      case "subagent_spawn": {
        // The parent validated the spawn; the host owns everything after.
        // Unknown terminals were already rejected at admission, so this is
        // always a live owner. Candidates share this queue: the host refuses
        // worldline spawns without launching (the task file in the writable
        // candidate events dir is forgeable and ignored). Never blocks the
        // sidecar queue.
        const runId = typeof event.runId === "string" ? event.runId : "";
        const taskFile = typeof event.taskFile === "string" ? event.taskFile : "";
        if (runId && taskFile) void this.subagents.handleSpawn(terminalId, runId, taskFile);
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
    // The ack must land in the terminal's OWN events dir: a candidate's
    // bridge polls its candidate events dir, not the primary's. This write
    // is identity-checked but not queued through the snapshot core: a
    // capture in flight would otherwise delay the ack past the 15s wait.
    const inst = this.terminals.get(terminalId);
    const root = inst ? this.eventsBindingOf(inst) : this.eventsDirBinding;
    const dir = inst ? this.eventsDirOf(inst) : this.eventsDir;
    if (!root) return;
    const name = `ack-${terminalId}-${requestId}.json`;
    const task = (async () => {
      try {
        const st = await lstat(dir);
        if (!st.isDirectory() || String(st.dev) !== String(root.dev) || String(st.ino) !== String(root.ino)) {
          throw new Error("events directory identity changed");
        }
        const target = join(dir, name);
        const temp = `${target}.${randomUUID()}.tmp`;
        try {
          await writeFile(temp, JSON.stringify(payload), { flag: "wx", mode: 0o600 });
          await fsRename(temp, target);
        } finally {
          await rm(temp, { force: true }).catch(() => undefined);
        }
      } catch (error) {
        console.error(`[main] could not write ack terminal=${terminalId} request=${requestId}: ${String(error)}`);
      }
    })();
    this.ackWrites.add(task);
    void task.then(() => this.ackWrites.delete(task));
  }

  /** Ask the renderer to save every dirty model. Bounded wait. The workspace
   *  id scopes the waiter to its project on teardown. */
  private flushDirtyModels(
    writerId: string,
    workspaceId: string,
    timeoutMs = 5000,
    expected?: PtyRendererSendTarget | null,
  ): Promise<{ ok: boolean; failed: string[] }> {
    const project = this.projectOfWorkspace(workspaceId);
    if (!project) return Promise.resolve({ ok: false, failed: ["workspace is no longer owned by a project"] });
    return new Promise((resolve) => {
      const requestId = `flush-${++this.flushSeq}`;
      const timer = setTimeout(() => {
        this.flushWaiters.delete(requestId);
        resolve({ ok: false, failed: ["renderer did not answer the flush request"] });
      }, timeoutMs);
      this.flushWaiters.set(requestId, {
        workspaceId,
        resolve,
        timer,
      });
      const sent = this.send("editor:flush-request", { requestId, writerId, projectId: project.id, workspaceId }, expected);
      if (sent) return;
      clearTimeout(timer);
      this.flushWaiters.delete(requestId);
      resolve({ ok: false, failed: ["renderer is unavailable"] });
    });
  }

  /**
   * The start preflight (WORLDLINES §6.3 steps 2-5): lease, flush, capture
   * the start state, then answer the bridge with a one-use token. The lease
   * stays held until agent_start consumes the token.
   */
  private async handlePreflightRequest(
    inst: AgentTerminalInstance,
    requestId: string,
    deadlineAt: number,
    expected?: PtyRendererSendTarget | null,
  ): Promise<void> {
    if (!requestId) return;
    const startedAt = Date.now();
    let stageStartedAt = startedAt;
    const timings: Record<string, number> = {};
    const markStage = (stage: string): void => {
      const now = Date.now();
      timings[stage] = now - stageStartedAt;
      stageStartedAt = now;
    };
    const report = (outcome: "ok" | "failed"): void => {
      const totalMs = Date.now() - startedAt;
      if (outcome === "failed" || totalMs >= 1000) {
        console.info(`[main] preflight ${outcome} terminal=${inst.id} request=${requestId} totalMs=${totalMs} remainingMs=${deadlineAt - Date.now()} stages=${JSON.stringify(timings)}`);
      }
    };
    const acknowledgeFailure = (error: string): void => {
      this.writeAck(inst.id, requestId, { ok: false, error });
      report("failed");
    };
    if (!Number.isFinite(deadlineAt)) {
      acknowledgeFailure("preflight deadline is missing");
      return;
    }
    // Leave enough time for the descriptor-bound acknowledgement write and
    // the producer's 50 ms poll. Work that misses this shared deadline must
    // release its lease rather than creating an orphaned one-use token.
    const remainingBudget = (): number => deadlineAt - Date.now() - 250;
    const ws = this.workspaceOfTerminal(inst);
    if (!ws) {
      // No workspace: nothing to record. The run proceeds without a token.
      this.writeAck(inst.id, requestId, { ok: true, token: null });
      report("ok");
      return;
    }
    if (!ws.primary) {
      // A candidate run: Release 1 records primary runs only.
      this.writeAck(inst.id, requestId, { ok: true, token: null });
      report("ok");
      return;
    }
    const preflightOwner = this.projectOfTerminal(inst.id);
    if (!preflightOwner || preflightOwner.workspaces.get(ws.id) !== ws) {
      acknowledgeFailure("terminal project ownership is unavailable");
      return;
    }
    if (remainingBudget() <= 0) {
      acknowledgeFailure("preflight deadline expired before admission");
      return;
    }
    const leaseRequester = `preflight:${inst.id}:${requestId}`;
    const lease = await this.acquireWriteLease(ws.id, leaseRequester, Math.min(12000, Math.max(0, remainingBudget() - 4000)));
    markStage("lease");
    if (!lease.ok) {
      acknowledgeFailure(lease.error ?? "the workspace is busy");
      return;
    }
    const failHeldPreflight = (error: string): void => {
      this.releaseWriteLease(ws.id, leaseRequester);
      acknowledgeFailure(error);
    };
    if (remainingBudget() <= 0) {
      failHeldPreflight("preflight deadline exceeded while acquiring the workspace lease");
      return;
    }
    const flush = await this.flushDirtyModels(leaseRequester, ws.id, Math.min(5000, remainingBudget()), expected);
    markStage("flush");
    if (!flush.ok) {
      failHeldPreflight("could not save editor changes");
      return;
    }
    if (remainingBudget() <= 0) {
      failHeldPreflight("preflight deadline exceeded while saving editor changes");
      return;
    }
    let store: SnapshotStore | null;
    try {
      // The store/index bootstrap has no deadline of its own: race it
      // against the shared preflight budget so a slow initial index can
      // never burn the bridge's 15 s wait without an answer.
      const readyPromise = (async (): Promise<SnapshotStore | null> => {
        const ready = await preflightOwner.storePromise;
        await ws.indexReady;
        return ready;
      })();
      const readyBudgetMs = Math.max(0, remainingBudget());
      const ready = await Promise.race([
        readyPromise.then((readyStore) => ({ ok: true as const, readyStore })),
        new Promise<{ ok: false }>((resolve) => {
          setTimeout(() => resolve({ ok: false }), readyBudgetMs);
        }),
      ]);
      if (!ready.ok) {
        // The bootstrap keeps running without the lease; its outcome
        // reaches later preflights through storePromise/indexReady.
        readyPromise.then(
          () => undefined,
          () => undefined,
        );
        failHeldPreflight("preflight deadline exceeded while waiting for the snapshot store");
        return;
      }
      store = ready.readyStore;
      markStage("store");
    } catch (err) {
      // Store/index bootstrap can fail after the lease is acquired (for
      // example when the Rust core exits). Never strand that workspace lease.
      failHeldPreflight(err instanceof Error ? err.message : String(err));
      return;
    }
    if (remainingBudget() <= 0) {
      failHeldPreflight("preflight deadline exceeded while waiting for the snapshot store");
      return;
    }
    if (!store) {
      // Recording unavailable (no Git): the run proceeds without a token.
      this.releaseWriteLease(ws.id, leaseRequester);
      this.writeAck(inst.id, requestId, { ok: true, token: null });
      report("ok");
      return;
    }
    try {
      // The retained-blob budget (WORLDLINES §9): no new states past it.
      if ((ws.retainedBlobBytes ?? 0) > 256 * 1024 * 1024) {
        this.releaseWriteLease(ws.id, leaseRequester);
        this.setRecorderState(inst, "budget", expected);
        this.writeAck(inst.id, requestId, { ok: true, token: null });
        report("ok");
        return;
      }
      // gitHead is a single-flight core op: awaiting it outside the race
      // would let a busy core burn the bridge's wait with the lease held.
      const capturePromise = (async () => store.capture(await gitHead(ws.root), ws.lastStateCommit ?? null))();
      const budgetMs = Math.max(0, remainingBudget());
      const captured = await Promise.race([
        capturePromise.then((state) => ({ ok: true as const, state })),
        new Promise<{ ok: false }>((resolve) => {
          setTimeout(() => resolve({ ok: false }), budgetMs);
        }),
      ]);
      if (!captured.ok) {
        // Answer the producer now so the tailer can drop backpressure. The
        // in-flight capture keeps the lease until it returns; it must not
        // hold the sidecar queue or appends stall and the engine quarantines.
        acknowledgeFailure("preflight deadline exceeded while capturing the workspace");
        this.trackRecordingTask(capturePromise.then(
          () => undefined,
          () => undefined,
        ).then(() => {
          this.releaseWriteLease(ws.id, leaseRequester);
        }));
        return;
      }
      const state = captured.state;
      markStage("capture");
      this.setWorkspaceState(ws, state.commit);
      ws.retainedBlobBytes = (ws.retainedBlobBytes ?? 0) + state.newBlobBytes;
      if (remainingBudget() <= 0) {
        failHeldPreflight("preflight deadline exceeded while capturing the workspace");
        return;
      }
      // Trust hashing queues behind every other core op on the shared
      // single-flight client: bound it so a busy core cannot burn the
      // bridge's wait without an answer either.
      const trustPromise = this.computeTrustHashes(preflightOwner);
      const trustBudgetMs = Math.max(0, remainingBudget());
      const trusted = await Promise.race([
        trustPromise.then((hashes) => ({ ok: true as const, hashes })),
        new Promise<{ ok: false }>((resolve) => {
          setTimeout(() => resolve({ ok: false }), trustBudgetMs);
        }),
      ]);
      if (!trusted.ok) {
        trustPromise.then(
          () => undefined,
          () => undefined,
        );
        failHeldPreflight("preflight deadline exceeded while hashing trust-sensitive files");
        return;
      }
      const trustHashes = trusted.hashes;
      markStage("trust");
      if (remainingBudget() <= 0) {
        failHeldPreflight("preflight deadline exceeded while hashing trust-sensitive files");
        return;
      }
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
        trustHashes,
      };
      this.pendingPreflights.set(token, pending);
      this.writeAck(inst.id, requestId, { ok: true, token });
      report("ok");
    } catch (err) {
      failHeldPreflight(err instanceof Error ? err.message : String(err));
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
  private async coupleRunStart(inst: AgentTerminalInstance, event: AgentStartEvent): Promise<void> {
    const token = String(event.preflightToken ?? "");
    const pending = token ? this.pendingPreflights.get(token) : undefined;
    const ws = this.workspaceOfTerminal(inst);
    const owner = this.projectOfTerminal(inst.id);
    if (owner) await this.initWorldlines(owner);
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
        promptEntryId: event.entryId ?? null,
        promptParentEntryId: event.parentEntryId ?? null,
        settledEntryId: null,
        sessionFile: event.sessionFile ?? null,
        sessionBranchFile: null,
        uncertainSessionFile: null,
        trustHashes: pending ? pending.trustHashes : null,
        model: event.model ?? null,
        thinkingLevel: event.thinkingLevel ?? null,
        replayable: true,
        reason: null,
        interrupted: false,
        steering: false,
        overlap: this.overlapInWorkspace(inst.workspaceId),
        unownedEdits: 0,
        startedAt: Date.now(),
        settledAt: null,
        engine: "core",
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
        promptEntryId: event.entryId ?? null,
        promptParentEntryId: event.parentEntryId ?? null,
        settledEntryId: null,
        sessionFile: event.sessionFile ?? null,
        sessionBranchFile: null,
        uncertainSessionFile: null,
        trustHashes: pending ? pending.trustHashes : null,
        model: event.model ?? null,
        thinkingLevel: event.thinkingLevel ?? null,
        replayable: false,
        reason: "the run started without a start preflight",
        interrupted: false,
        steering: false,
        overlap: false,
        unownedEdits: 0,
        startedAt: Date.now(),
        settledAt: null,
        engine: "core",
      };
      this.markOverlappingAgents(inst, run);
      this.pushRun(inst, run, manager);
    }
    const startedSessionId = String(event.sessionId ?? "") || inst.sessionId;
    if (inst.persist) {
      if (startedSessionId && isCoreSessionId(startedSessionId)) {
        const startedCoreFile = await this.coreSessionFile(startedSessionId, inst.cwd);
        if (startedSessionId === inst.sessionId || !this.sessionFileInUse(startedCoreFile)) {
          inst.sessionId = startedSessionId;
          inst.sessionFile = startedCoreFile;
        }
      }
    }
    const rosterOwner = this.projectOfTerminal(inst.id);
    if (inst.persist && rosterOwner) this.saveTerminalRoster(rosterOwner);
    // The staged prompt belongs to one run start. Clear it so a later
    // retry cannot reuse the previous run's payload.
    inst.pendingPrompt = null;
  }

  /** Mark this run and every other open agent in the same workspace. */
  private markOverlappingAgents(inst: AgentTerminalInstance, run: RunRecord): void {
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
  private pushRun(inst: AgentTerminalInstance, run: RunRecord, manager: WorldlineManager | null): void {
    inst.currentRun = run;
    manager?.recordRun(run);
  }

  private async cleanupPromptPayloads(inst: AgentTerminalInstance): Promise<void> {
    const keep = this.projectOfTerminal(inst.id)?.worldlines?.promptPayloadsOf(inst.id) ?? new Set<string>();
    const dir = this.eventsDirOf(inst);
    const root = this.eventsBindingOf(inst);
    if (!root) return;
    try {
      const entries = await boundPromotionListEntries({ root: dir, rootIdentity: root });
      for (const entry of entries) {
        const file = entry.name;
        if (entry.kind !== "file" && entry.kind !== "symlink") continue;
        if (file.startsWith(`prompt-${inst.id}-`) && !keep.has(file)) {
          await this.removeBoundEventLeaf(dir, root, file, entry.identity);
        }
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
  private async handleCheckpointRequest(
    inst: AgentTerminalInstance,
    requestId: string,
    kind: string,
    entryId: string,
    expected?: PtyRendererSendTarget | null,
  ): Promise<void> {
    if (!requestId) return;
    const ws = this.workspaceOfTerminal(inst);
    if (!ws || (!ws.lastStateCommit && !ws.primary)) {
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
      if (!ws.primary) await checkpointOwner?.worldlines?.updateHeadState(inst.id, state.commit);
      this.writeAck(inst.id, requestId, { ok: true, stateId: state.commit });
      if (kind === "settled" && inst.currentRun && !inst.currentRun.settledAt) {
        const runStartStateId = inst.currentRun.startStateId;
        const model = inst.currentRun.model;
        // Session-branch copy can outlive the sidecar ack. Do not hold the
        // tailer's in-flight slot (and producer backpressure) on it.
        this.trackRecordingTask((async () => {
          await this.finalizeRun(inst, state, entryId, expected);
          this.pushTimeline(inst, {
            t: "agent_settled",
            stateId: state.commit,
            entryId: entryId || null,
            model,
            runStartStateId,
          }, expected);
        })());
      }
    } catch (err) {
      this.writeAck(inst.id, requestId, { ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.releaseWriteLease(ws.id, leaseRequester);
    }
  }

  /**
   * Capture only after the watcher reports a debounced idle boundary, then
   * reject any raw activity or generation change across capture. Two bounded
   * attempts prevent a continuously changing source from waiting forever.
   */
  private async captureStable(store: SnapshotStore, ws: WorkspaceState): Promise<SourceState> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const watcher = ws.watcher;
      if (!watcher) throw new Error("source watcher is not available");
      const idleRevision = await watcher.waitForIdle(CHECKPOINT_IDLE_WAIT_MS);
      if (idleRevision === null) continue;
      const gen = ws.generation;
      if ((ws.retainedBlobBytes ?? 0) > 256 * 1024 * 1024) {
        throw new Error("the retained-blob budget is exhausted");
      }
      const state = await store.capture(await gitHead(ws.root), ws.lastStateCommit ?? null);
      ws.retainedBlobBytes = (ws.retainedBlobBytes ?? 0) + state.newBlobBytes;
      if (ws.generation === gen && watcher.isIdleAt(idleRevision)) return state;
    }
    throw new Error("the source changed during capture");
  }

  // -------------------------------------------------- fork any moment ----

  private static readonly MAX_FORK_POINTS = 100;
  private static readonly MAX_PROGRESS_PATHS = 8;



  private addPendingHint(inst: AgentTerminalInstance, relPath: string): void {
    if (inst.pendingHints.has(relPath)) return;
    if (inst.pendingHints.size >= TerminaApp.MAX_PENDING_HINTS) {
      const oldest = inst.pendingHints.values().next().value;
      if (oldest !== undefined) inst.pendingHints.delete(oldest);
    }
    inst.pendingHints.add(relPath);
  }

  /** Debounce a moment capture: sibling tools coalesce into one state. */
  private scheduleMomentCapture(inst: AgentTerminalInstance, expected?: PtyRendererSendTarget | null): void {
    if (!inst.currentRun) return;
    const ws = this.workspaceOfTerminal(inst);
    // Candidate workspaces record moments too (nested worldlines): their
    // chain was seeded with the root base at creation.
    if (!ws || (!ws.primary && !ws.lastStateCommit)) return;
    if (inst.captureTimer) clearTimeout(inst.captureTimer);
    inst.captureTimer = setTimeout(() => {
      inst.captureTimer = null;
      if (this.disposed || this.projectIsSwitching(this.projectOfTerminal(inst.id)?.id)) return;
      const rendererTarget = expected === undefined ? this.captureRendererSendTarget() : expected;
      this.trackRecordingTask(this.runMomentCapture(inst, ws, rendererTarget));
    }, 200);
  }

  /**
   * One incremental capture for the dots since the last one. The watcher
   * hints are the delta; the watcher cache reconciles missed events.
   * Queue is per workspace: later terminals wait and the next job drains
   * every sibling's hints so two incrementals never share a parent.
   */
  private runMomentCapture(
    inst: AgentTerminalInstance,
    ws: WorkspaceState,
    expected?: PtyRendererSendTarget | null,
  ): Promise<void> {
    const previous = ws.momentCapturePromise ?? Promise.resolve();
    let current: Promise<void>;
    current = previous
      .catch(() => undefined)
      .then(() => this.captureMomentNow(inst, ws, expected))
      .finally(() => {
        if (ws.momentCapturePromise === current) ws.momentCapturePromise = null;
      });
    ws.momentCapturePromise = current;
    return current;
  }

  private async captureMomentNow(
    inst: AgentTerminalInstance,
    ws: WorkspaceState,
    expected?: PtyRendererSendTarget | null,
  ): Promise<void> {
    const members = this.terminalsOnWorkspace(ws);
    if (!members.some((member) => member.id === inst.id)
      && (!inst.closed || inst.momentDots.length > 0 || inst.pendingHints.size > 0)) {
      members.push(inst);
    }
    const hasWork = members.some((member) => member.momentDots.length > 0 || member.pendingHints.size > 0);
    if (!hasWork) return;
    const momentOwner = this.projectOfTerminal(inst.id) ?? this.projectOfWorkspace(ws.id);
    const store = await momentOwner?.storePromise;
    if (!store || (!ws.lastStateCommit && !ws.primary)) {
      for (const member of members) {
        if (member.momentDots.length > 0 || member.pendingHints.size > 0) {
          this.setRecorderState(member, "paused", expected);
        }
      }
      return;
    }
    // The retained-blob budget (WORLDLINES §9): pause recording beyond it.
    if ((ws.retainedBlobBytes ?? 0) > 256 * 1024 * 1024) {
      for (const member of members) {
        if (member.momentDots.length === 0 && member.pendingHints.size === 0) continue;
        member.pendingHints.clear();
        member.momentDots = [];
        this.setRecorderState(member, "budget", expected);
      }
      return;
    }
    // Promote (and other writers) hold this lease while the tree is torn.
    // Bail rather than snapshot a tree another writer owns. Dots and hints
    // stay on their terminals for the next queued job.
    const leaseRequester = `moment:${ws.id}`;
    if (ws.writerId !== null && ws.writerId !== leaseRequester) {
      return;
    }
    const lease = await this.acquireWriteLease(ws.id, leaseRequester, 0);
    if (!lease.ok) {
      return;
    }
    const jobs: Array<{ inst: AgentTerminalInstance; batch: TimelineEvent[]; hints: string[] }> = [];
    const hints = new Set<string>();
    try {
      for (const member of this.terminalsOnWorkspace(ws)) {
        if (member.momentDots.length === 0 && member.pendingHints.size === 0) continue;
        const hintList = [...member.pendingHints];
        jobs.push({ inst: member, batch: member.momentDots, hints: hintList });
        member.momentDots = [];
        member.pendingHints.clear();
        for (const hint of hintList) hints.add(hint);
      }
      if (!jobs.some((job) => job.inst.id === inst.id)
        && (inst.momentDots.length > 0 || inst.pendingHints.size > 0)) {
        const hintList = [...inst.pendingHints];
        jobs.push({ inst, batch: inst.momentDots, hints: hintList });
        inst.momentDots = [];
        inst.pendingHints.clear();
        for (const hint of hintList) hints.add(hint);
      }
      if (jobs.length === 0) return;
      // Reconcile: the watcher's precomputed blob oids catch changes the
      // hints missed. Shipping hashes instead of contents keeps the request
      // small and skips a re-hash of the whole cache per capture. Bound the
      // walk so a huge cache cannot stall the capture.
      const oids = ws.watcher?.lastOids;
      const reconcile: Array<{ relPath: string; oid: string }> = [];
      // ProjectWatcher stores canonical absolute paths. Resolve the workspace
      // root once for this bounded walk instead of realpath'ing it for every
      // cached file.
      const canonicalRoot = await this.canonicalPath(ws.root);
      let walked = 0;
      for (const [path, pair] of oids ?? []) {
        if (walked >= 2000) break;
        walked++;
        const rel = relative(canonicalRoot, path);
        if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
        if (hints.has(rel)) continue;
        if (this.ignoredSegmentIn(rel)) continue;
        reconcile.push({ relPath: rel, oid: store.objectFormat === "sha256" ? pair.sha256 : pair.sha1 });
      }
      try {
        // A candidate workspace captures its OWN tree (the source override).
        const source = ws.primary ? undefined : { root: ws.root, gitDir: (await gitCommonDir(ws.root)) ?? ws.root };
        const parent = ws.lastStateCommit;
        const state = parent
          ? await store.captureIncremental(parent, [...hints], reconcile, {}, {}, source)
          : await store.capture(await gitHead(ws.root), null);
        this.setWorkspaceState(ws, state.commit);
        if (!parent) ws.lastReseedMs = Date.now();
        ws.retainedBlobBytes = (ws.retainedBlobBytes ?? 0) + state.newBlobBytes;
        if (!ws.primary) {
          for (const job of jobs) {
            await momentOwner?.worldlines?.updateHeadState(job.inst.id, state.commit);
          }
        }
        for (const job of jobs) {
          this.attachMomentState(job.inst, state.commit, job.batch, expected);
          this.setRecorderState(job.inst, "ready", expected);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[main] moment capture failed: ${message}`);
        // A dangling base (rebuilt store) fails every incremental capture
        // forever. Re-seed primary workspaces with one full capture, at most
        // once a minute; candidates keep their creation-seeded chain.
        if (ws.primary && Date.now() - ws.lastReseedMs > 60_000) {
          try {
            const reseeded = await store.capture(await gitHead(ws.root), null);
            this.setWorkspaceState(ws, reseeded.commit);
            ws.lastReseedMs = Date.now();
            for (const job of jobs) {
              this.attachMomentState(job.inst, reseeded.commit, job.batch, expected);
              this.setRecorderState(job.inst, "ready", expected);
            }
            return;
          } catch (reseedErr) {
            console.warn(`[main] moment reseed failed: ${reseedErr instanceof Error ? reseedErr.message : String(reseedErr)}`);
          }
        }
        // Keep the batch so a later lease-release or tool event can retry.
        for (const job of jobs) {
          job.inst.momentDots = [...job.batch, ...job.inst.momentDots];
          for (const hint of job.hints) this.addPendingHint(job.inst, hint);
          this.setRecorderState(job.inst, "degraded", expected, message.slice(0, 160));
        }
      }
    } finally {
      this.releaseWriteLease(ws.id, leaseRequester);
    }
  }

  /** Attach the captured state to every dot of the batch and push it. */
  private attachMomentState(
    inst: AgentTerminalInstance,
    stateId: string,
    batch = inst.momentDots,
    expected?: PtyRendererSendTarget | null,
  ): void {
    if (batch === inst.momentDots) inst.momentDots = [];
    const liveSeqs = new Set(inst.timeline.map((event) => event.seq));
    const liveBatch = batch.filter((event) => liveSeqs.has(event.seq));
    for (const ev of liveBatch) {
      ev.stateId = stateId;
      if (ev.runStartStateId === undefined) ev.runStartStateId = inst.currentRun?.startStateId ?? null;
    }
    this.evictForkPoints(inst, expected);
    for (const ev of liveBatch) {
      if (!ev.entryId || !ev.stateId || ev.evicted) continue;
      const pub = { ...ev };
      delete (pub as Partial<TimelineEvent>).content;
      this.send("timeline:event", { terminalId: inst.id, event: pub }, expected);
    }
  }

  /**
   * Budget: keep at most 100 forkable points per terminal. Evicted dots
   * lose their dots and their store states together.
   */
  private evictForkPoints(inst: AgentTerminalInstance, expected?: PtyRendererSendTarget | null): void {
    const forkable = inst.timeline.filter((e) => e.stateId);
    if (forkable.length <= TerminaApp.MAX_FORK_POINTS) return;
    let excess = forkable.length - TerminaApp.MAX_FORK_POINTS;
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
    }
    if (evicted.length > 0) {
      this.send("timeline:evict", { terminalId: inst.id, seqs: evicted }, expected);
      this.setRecorderState(inst, "budget", expected);
    }
  }

  /** Push the recorder state label (WORLDLINES §6). */
  private setRecorderState(inst: AgentTerminalInstance, state: RecorderState, expected?: PtyRendererSendTarget | null, detail?: string | null): void {
    if (state === "degraded" && detail !== undefined) inst.recorderDetail = detail;
    if (state !== "degraded") inst.recorderDetail = null;
    // Degraded resends: each failed batch carries the latest error for the
    // tooltip. Other states send once per transition.
    if (inst.recorderState === state && (state !== "degraded" || inst.recorderDetail === inst.lastSentRecorderDetail)) return;
    inst.recorderState = state;
    inst.lastSentRecorderDetail = inst.recorderDetail;
    this.send("timeline:recorder-state", { terminalId: inst.id, state, detail: inst.recorderDetail }, expected);
  }

  private ignoredSegmentIn(rel: string): boolean {
    return rel.split(/[\\/]/).some((seg) => IGNORED_SEGMENTS.has(seg) || seg === ".git");
  }

  /** Attach the settled state, copy the session branch, mark eligibility. */
  private async finalizeRun(
    inst: AgentTerminalInstance,
    state: SourceState,
    entryId: string,
    expected?: PtyRendererSendTarget | null,
  ): Promise<void> {
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
    // Materialize the session branch into app-private storage.
    if (run.sessionFile) {
      try {
        if (run.engine !== "core") throw new Error("core is the only engine");
        const through = Number(entryId);
        if (!Number.isInteger(through) || through < 1) throw new Error("the settled session address is missing");
        // Core uncertainty is recovery evidence: it lives outside the
        // launch scratch directory, which start() is allowed to remove.
        const reserveBytes = await this.sessionRetention.estimateForkedSessionBytes(run.sessionFile!);
        const transaction = await this.sessionRetention.transact(run.id, (destinationSessionFile, retentionLease) =>
          this.sessionFork.forkCore({
            sourceSessionFile: run.sessionFile!,
            destinationSessionFile,
            throughSeq: through,
            retentionLease,
          }),
          { reserveBytes },
        );
        const target = transaction.destinationSessionFile;
        const forked = transaction.result;
        if (!forked.ok) {
          run.uncertainSessionFile = forked.sessionFile;
          throw new Error(`commit uncertain at ${forked.sessionFile}: ${forked.error}`);
        }
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
    this.send("worldline:runs-changed", { terminalId: inst.id }, expected);
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
  private closeRunOnExit(inst: AgentTerminalInstance): void {
    const run = inst.currentRun;
    if (run && !run.settledAt) {
      run.replayable = false;
      run.reason = "the terminal exited mid-run";
      run.settledAt = Date.now();
      inst.currentRun = null;
    }
  }

  private async toolSnapshot(
    inst: AgentTerminalInstance,
    path: string,
    toolName: string,
    edits: unknown,
    ev: Omit<TimelineEvent, "seq" | "ts">,
  ): Promise<{ content?: string; status?: "created" | "modified" }> {
    const status = toolName === "write" ? await this.classifyWrite(path) : "modified";
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
  private preRunContent(inst: AgentTerminalInstance, path: string): string | null | undefined {
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
  private timelinePrefixOf(inst: AgentTerminalInstance | undefined): TimelinePrefix {
    if (!inst) return { terminalId: "", ok: 0, error: 0, open: 0 };
    let ok = 0;
    let error = 0;
    for (const v of inst.toolOutcomes.values()) {
      if (v === "ok") ok++;
      else error++;
    }
    return { terminalId: inst.id, ok, error, open: inst.pendingFileTools.size };
  }

  private sendTimelinePrefix(inst: AgentTerminalInstance, expected?: PtyRendererSendTarget | null): void {
    const payload = this.timelinePrefixOf(inst);
    const key = `${payload.ok}:${payload.error}:${payload.open}`;
    if (inst.lastTimelinePrefixKey === key) return;
    inst.lastTimelinePrefixKey = key;
    this.send("timeline:prefix", payload, expected);
  }

  private isNewCommand(text: string): boolean {
    const t = text.trim();
    return t === "/clear" || t.startsWith("/clear ") || t === "/new" || t.startsWith("/new ");
  }

  /** Track only interactive-sized input for /clear (/new alias) detection. Bulk input is a
   * paste, not a slash command, and must not synchronously split/scan MBs. */
  private trackNewCommandInput(id: string, data: string): void {
    if (data.length > 1024 || data.includes("\x1b[200~")) {
      this.newCommandBuffers.set(id, "");
      return;
    }
    const buf = (this.newCommandBuffers.get(id) ?? "") + data;
    if (buf.includes("\r") || buf.includes("\n")) {
      const lines = buf.split(/\r|\n/);
      this.newCommandBuffers.set(id, (lines.pop() ?? "").slice(-200));
      for (const line of lines) {
        if (this.isNewCommand(line)) {
          void this.clearForNewSession(id).catch((err) => {
            console.warn(`[main] session clear failed: ${(err as Error)?.message ?? err}`);
          });
          break;
        }
      }
      return;
    }
    this.newCommandBuffers.set(id, buf.slice(-200));
  }

  /**
   * Reset session-scoped state for a slash-command reset (/clear, alias /new). The
   * timeline, plan, and worldline comparisons reflect the abandoned run;\n   * the workspace source and modified files reflect real disk changes and\n   * persist.\n   */
  private async clearForNewSession(terminalId: string, expected?: PtyRendererSendTarget | null): Promise<void> {
    const inst = this.terminals.get(terminalId);
    if (!inst) return;
    // A fresh session orphans the owner's background runs: terminate them.
    // Their killed-result notes still land in the mailbox so the new
    // session sees what happened instead of waiting on dead runs.
    this.subagents.killOwner(terminalId, "terminal cleared");
    // Cancel spawns that have not launched yet: a sidecar record queued
    // just before this clear would otherwise launch into the new session.
    // (A clear landing between the host's task read and child launch stays
    // a visible, attributable stray — accepted, not silent.)
    try {
      for (const name of await readdir(this.eventsDirOf(inst))) {
        if (name.startsWith(`subagent-${terminalId}-`) && name.endsWith(".task.json")) {
          await this.removeEventLeaf(inst, name).catch(() => undefined);
        }
      }
    } catch {
      /* Best-effort pre-launch cancellation. */
    }
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
    this.send("timeline:clear", { terminalId }, expected);
    this.sendTimelinePrefix(inst, expected);
    // Plan: fresh board for the new session.
    inst.plan = [];
    inst.touched = new Set();
    inst.pendingFileTools.clear();
    inst.toolOutcomes.clear();
    this.sendPlan(inst, expected);
    // The open run is abandoned by /clear. Mark it non-replayable so a later
    // token-less agent_start does not treat it as a retry.
    if (inst.currentRun && !inst.currentRun.settledAt) {
      inst.currentRun.replayable = false;
      inst.currentRun.reason = inst.currentRun.reason ?? "session reset by /clear";
      inst.currentRun = null;
    }
    // Modified files and their original baselines intentionally survive /clear:
    // they describe real workspace changes still present on disk. The next
    // agent_start refreshes baselines only for files not already in the list.
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
  private startStateForMoment(inst: AgentTerminalInstance, ev: TimelineEvent): string | null {
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
        paths: changes.slice(0, TerminaApp.MAX_PROGRESS_PATHS).map((c) => c.relPath),
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
  private pushTimeline(
    inst: AgentTerminalInstance,
    ev: Omit<TimelineEvent, "seq" | "ts">,
    expected?: PtyRendererSendTarget | null,
  ): TimelineEvent {
    const event = ev as TimelineEvent;
    event.seq = ++inst.timelineSeq;
    event.ts = Date.now();
    inst.timeline.push(event);
    if (inst.timeline.length > MAX_TIMELINE_EVENTS) {
      const removed = inst.timeline.splice(0, inst.timeline.length - MAX_TIMELINE_EVENTS);
      const seqs = removed.map((old) => old.seq);
      const removedSeqs = new Set(seqs);
      inst.momentDots = inst.momentDots.filter((dot) => !removedSeqs.has(dot.seq));
      for (const old of removed) {
        if (old.stateId) void this.releaseStateIfUnused(old.stateId, inst.id, old.seq);
      }
      // Hidden failed captures still consume the internal cap. Explicitly
      // remove any displaced visible dots so renderer and main cannot diverge.
      this.send("timeline:evict", { terminalId: inst.id, seqs }, expected);
    }
    this.trimTimelineContent(inst);
    if (inst.currentRun && (event.t === "tool" || event.t === "change")) {
      inst.momentDots.push(event);
      if (inst.momentDots.length > MAX_TIMELINE_EVENTS) inst.momentDots.shift();
      event.runStartStateId = inst.currentRun.startStateId;
    }
    if (event.stateId) this.evictForkPoints(inst, expected);
    if (event.stateId && event.entryId && !event.evicted) {
      const { content: _content, ...pub } = event;
      this.send("timeline:event", { terminalId: inst.id, event: pub }, expected);
    }
    return event;
  }

  /** Keep snapshot memory bounded per terminal: drop content from the OLDEST
   *  events first (the dots remain; clicking them explains why). */
  private trimTimelineContent(inst: AgentTerminalInstance): void {
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

  private async classifyWrite(path: string): Promise<"created" | "modified"> {
    try {
      await stat(path);
      return "modified";
    } catch {
      return "created";
    }
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

  private prepareRunBaselines(inst: AgentTerminalInstance, source: Map<string, string> | undefined): void {
    // A terminal's modified list is cumulative until the user clears it. Keep
    // those files anchored to their first pre-change content across turns.
    const retained = new Map<string, string | null>();
    for (const path of inst.modified.keys()) {
      if (inst.baselines.has(path)) retained.set(path, inst.baselines.get(path)!);
    }

    inst.baselines.clear();
    inst.baselineBytes = 0;
    if (source) {
      for (const [path, content] of source) {
        if (!inst.modified.has(path)) this.setBaseline(inst, path, content);
      }
    }
    // Insert retained entries last so the bounded cache evicts speculative
    // untouched-file snapshots before baselines backing visible review items.
    for (const [path, content] of retained) this.setBaseline(inst, path, content);
  }

  private setBaseline(inst: AgentTerminalInstance, path: string, value: string | null): void {
    const previous = inst.baselines.get(path);
    if (previous !== undefined && previous !== null) inst.baselineBytes -= Buffer.byteLength(previous, "utf8");
    inst.baselines.set(path, value);
    if (value !== null) inst.baselineBytes += Buffer.byteLength(value, "utf8");
    while (inst.baselines.size > TerminaApp.MAX_BASELINE_FILES || inst.baselineBytes > TerminaApp.MAX_BASELINE_BYTES) {
      const oldest = inst.baselines.keys().next().value;
      if (oldest === undefined) break;
      this.deleteBaseline(inst, oldest);
    }
  }

  private deleteBaseline(inst: AgentTerminalInstance, path: string): void {
    const previous = inst.baselines.get(path);
    if (previous !== undefined && previous !== null) inst.baselineBytes -= Buffer.byteLength(previous, "utf8");
    inst.baselines.delete(path);
  }

  private setRunSnapshot(inst: AgentTerminalInstance, path: string, content: string): void {
    const previous = inst.runSnapshots.get(path);
    if (previous !== undefined) inst.runSnapshotBytes -= Buffer.byteLength(previous, "utf8");
    inst.runSnapshots.set(path, content);
    inst.runSnapshotBytes += Buffer.byteLength(content, "utf8");
    while (inst.runSnapshots.size > TerminaApp.MAX_RUN_SNAPSHOTS || inst.runSnapshotBytes > TerminaApp.MAX_RUN_SNAPSHOT_BYTES) {
      const oldest = inst.runSnapshots.keys().next().value;
      if (oldest === undefined) break;
      const value = inst.runSnapshots.get(oldest);
      if (value !== undefined) inst.runSnapshotBytes -= Buffer.byteLength(value, "utf8");
      inst.runSnapshots.delete(oldest);
    }
  }

  /** Run one lazy baseline capture and remember it. Change Review waits
   *  for the fill so an early diff open does not show a missing baseline. */
  private fillBaseline(inst: AgentTerminalInstance, path: string, status: "created" | "modified"): Promise<void> {
    const task = this.fillBaselineFromState(inst, path, status)
      .catch(() => undefined)
      .finally(() => {
        if (inst.baselineFills.get(path) === task) inst.baselineFills.delete(path);
      });
    inst.baselineFills.set(path, task);
    return task;
  }

  private async fillBaselineFromState(inst: AgentTerminalInstance, path: string, status: "created" | "modified"): Promise<void> {
    if (inst.baselines.has(path) || status === "created") {
      if (status === "created" && !inst.baselines.has(path)) this.setBaseline(inst, path, null);
      return;
    }
    const stateId = inst.currentRun?.startStateId;
    const workspace = this.workspaceOfTerminal(inst);
    const store = await this.projectOfTerminal(inst.id)?.storePromise;
    if (!stateId || !workspace || !store) return;
    const relPath = relative(await this.canonicalPath(workspace.root), path);
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

  private async recordModified(inst: AgentTerminalInstance, absPath: string, status: "created" | "modified"): Promise<void> {
    const p = await this.canonicalPath(absPath);
    const existing = inst.modified.get(p);
    if (existing) {
      // Status is relative to the cumulative review baseline, not merely the
      // latest watcher transition. A file created earlier in the session
      // remains "created" when a later turn modifies it again.
      existing.status = inst.baselines.get(p) === null || existing.status === "created" ? "created" : "modified";
    } else {
      const workspace = this.workspaceOfTerminal(inst);
      if (!workspace) return;
      this.setBounded(inst.modified, p, { path: p, relPath: await this.rel(p, workspace.root), status }, TerminaApp.MAX_MODIFIED_FILES);
    }
  }

  private async recordDeleted(
    inst: AgentTerminalInstance,
    absPath: string,
    expected?: PtyRendererSendTarget | null,
  ): Promise<void> {
    const p = await this.canonicalPath(absPath);
    const baseline = inst.baselines.get(p);
    if (baseline !== undefined && baseline !== null) {
      // A pre-existing file was deleted and a baseline can restore it: keep
      // the entry so the user can revert.
      const entry = inst.modified.get(p);
      if (entry) {
        entry.status = "deleted";
      } else {
        const workspace = this.workspaceOfTerminal(inst);
        if (!workspace) return;
        this.setBounded(inst.modified, p, { path: p, relPath: await this.rel(p, workspace.root), status: "deleted" }, TerminaApp.MAX_MODIFIED_FILES);
      }
    } else {
      // Nothing to restore (created this run, or no baseline): drop the entry.
      inst.modified.delete(p);
    }
    this.send("modified:list", { instanceId: inst.id, files: [...inst.modified.values()] }, expected);
  }

  // ------------------------------------------------------------- project -----

  /**
   * Ask the renderer to Save / Discard / Cancel dirty editor buffers.
   * Save reuses flushAll → file:save. Cancel aborts the close or quit.
   */
  async confirmUnsavedEditorBuffers(projectId?: string): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> {
    const rendererTarget = this.captureRendererSendTarget();
    return new Promise((resolve) => {
      const requestId = `unsaved-${++this.unsavedSeq}`;
      const timer = setTimeout(() => {
        this.unsavedWaiters.delete(requestId);
        resolve({ ok: false, cancelled: true });
      }, 5 * 60 * 1000);
      this.unsavedWaiters.set(requestId, { resolve, timer });
      const sent = this.send("editor:unsaved-confirm", { requestId, projectId: projectId ?? null }, rendererTarget);
      if (sent) return;
      clearTimeout(timer);
      this.unsavedWaiters.delete(requestId);
      const win = this.win;
      if (win && !win.isDestroyed()) resolve({ ok: false, error: "editor is unavailable" });
      else resolve({ ok: true });
    });
  }

  /**
   * Shared close/quit gate: unsaved editor buffers, then live worldline
   * candidates. Cancel at either step aborts.
   */
  async confirmClose(projectId?: string): Promise<boolean> {
    const unsaved = await this.confirmUnsavedEditorBuffers(projectId);
    if (!unsaved.ok) return false;
    return this.confirmDiscardActiveCandidates(projectId);
  }

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
    const rendererTarget = this.captureRendererSendTarget();
    if (!this.win || this.win.isDestroyed()) return { cancelled: true };
    const result = await dialog.showOpenDialog(this.win, {
      title: "Open a project folder",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return { cancelled: true };
    const cwd = result.filePaths[0];
    // Claim the selection slot as soon as the user chooses a folder. Path
    // canonicalization can yield; a later activation/close must fence this
    // request rather than allowing it to reclaim the active project.
    const selectionAction = this.beginProjectSelectionAction();
    // One tab per folder: reactivate an already-open project.
    const canonical = await this.canonicalPath(cwd);
    for (const existing of this.projects.values()) {
      if (existing.canonicalRoot === canonical) {
        return (await this.activateProject(existing.id, rendererTarget, selectionAction)) ? { cwd } : { cancelled: true };
      }
    }
    const project = await this.openProject(cwd, selectionAction, rendererTarget);
    return project ? { cwd } : { cancelled: true };
  }

  /** Open or reactivate the project at a path (the dialog-free path). */
  async openProjectAt(cwd: string): Promise<{ cwd: string } | { cancelled: true }> {
    if (this.initialRestorePromise) await this.initialRestorePromise;
    const rendererTarget = this.captureRendererSendTarget();
    // Reserve the selection slot before any path I/O. A later open/activate
    // action therefore fences this request even when canonicalPath resolves
    // in the opposite order.
    const selectionAction = this.beginProjectSelectionAction();
    const canonical = await this.canonicalPath(cwd);
    for (const existing of this.projects.values()) {
      if (existing.canonicalRoot === canonical) {
        return (await this.activateProject(existing.id, rendererTarget, selectionAction)) ? { cwd } : { cancelled: true };
      }
    }
    const project = await this.openProject(cwd, selectionAction, rendererTarget);
    return project ? { cwd } : { cancelled: true };
  }

  /** Create a project, start its watcher and store, and activate it. */
  private async openProject(
    cwd: string,
    selectionAction = this.beginProjectSelectionAction(),
    expected?: PtyRendererSendTarget | null,
  ): Promise<ProjectState | null> {
    const rendererTarget = expected === undefined ? this.captureRendererSendTarget() : expected;
    const id = `proj-${++projectSeq}`;
    this.switchingProjects.add(id);
    try {
      const canonicalRoot = await this.canonicalPath(cwd);
      const primaryRootInfo = await lstat(canonicalRoot, { bigint: true });
      if (!primaryRootInfo.isDirectory() || primaryRootInfo.isSymbolicLink()) {
        throw new Error("project root is not a real directory");
      }
      const project: ProjectState = {
        id,
        cwd,
        canonicalRoot,
        primaryRootIdentity: { dev: String(primaryRootInfo.dev), ino: String(primaryRootInfo.ino) },
        workspaces: new Map(),
        storePromise: null,
        storeDir: null,
        mineFiles: new Set(),
        mineCommit: Promise.resolve(),
        worldlines: null,
        terminalIds: new Set(),
        unrestoredTerminals: [],
        activationGeneration: 0,
      };
      this.projects.set(id, project);
      // Project construction may overlap a newer selection. Only the latest
      // request may claim the active slot and receive a folder push.
      const activationGeneration = this.projectSelectionAction === selectionAction
        ? this.nextProjectActivationGeneration()
        : 0;
      if (activationGeneration > 0) {
        this.activeProjectId = id;
        project.activationGeneration = activationGeneration;
      }
      // Finish or roll back any pending promotion journal BEFORE the
      // primary watcher starts: the restored bytes must not attribute to
      // a user edit.
      await recoverPromotionJournals(this.worldsRoot, {
        primaryRoot: project.canonicalRoot,
      });
      this.createWorkspace(project, cwd, true);
      await this.loadMineFiles(project);
      await this.initWorldlines(project);
      // Spawn the terminal before folder:opened so the renderer can show
      // that pane when it switches the project view.
      await this.restoreProjectTerminals(project);
      // A close can select this project as the replacement while its own
      // asynchronous open is still restoring terminals. In that ordering
      // close's immediate folder push has no workspace yet; publish once the
      // workspace exists, using the newer selection epoch rather than the
      // stale open request's action.
      const publishGeneration = activationGeneration > 0
        ? activationGeneration
        : this.activeProjectId === id && project.activationGeneration === this.projectActivationGeneration
          ? project.activationGeneration
          : 0;
      const publishAction = activationGeneration > 0 ? selectionAction : this.projectSelectionAction;
      if (publishGeneration > 0) {
        await this.sendFolderOpened(
          cwd,
          id,
          this.primaryWorkspace(project)?.id ?? "",
          publishGeneration,
          publishAction,
          rendererTarget,
        );
      }
      this.persistOpenProjects();
      return project;
    } finally {
      this.switchingProjects.delete(id);
    }
  }

  /** Switch the renderer to another open project. Nothing is torn down. */
  private async activateProject(
    projectId: string,
    expected?: PtyRendererSendTarget | null,
    expectedSelectionAction?: number,
  ): Promise<boolean> {
    const rendererTarget = expected === undefined ? this.captureRendererSendTarget() : expected;
    const project = this.projects.get(projectId);
    if (!project || this.projectIsSwitching(projectId)) return false;
    const selectionAction = expectedSelectionAction ?? this.beginProjectSelectionAction();
    if (expectedSelectionAction !== undefined && this.projectSelectionAction !== expectedSelectionAction) return false;
    const activationGeneration = this.nextProjectActivationGeneration();
    this.activeProjectId = projectId;
    project.activationGeneration = activationGeneration;
    const sent = await this.sendFolderOpened(
      project.cwd,
      project.id,
      this.primaryWorkspace(project)?.id ?? "",
      activationGeneration,
      selectionAction,
      rendererTarget,
    );
    if (sent) void this.persistOpenProjects();
    return sent;
  }

  /** Push folder:opened with a login hint flag. The renderer never reads auth.json. */
  private async sendFolderOpened(
    cwd: string,
    projectId: string,
    workspaceId: string,
    activationGeneration: number,
    selectionAction = this.projectSelectionAction,
    expected?: PtyRendererSendTarget | null,
  ): Promise<boolean> {
    const rendererTarget = expected === undefined ? this.captureRendererSendTarget() : expected;
    const project = this.projects.get(projectId);
    const current = () => !this.disposed
      && !!workspaceId
      && this.projects.get(projectId) === project
      && this.activeProjectId === projectId
      && project?.activationGeneration === activationGeneration
      && this.projectActivationGeneration === activationGeneration
      && this.projectSelectionAction === selectionAction;
    if (!current()) return false;
    const needsLogin = await this.agentNeedsLogin();
    // Auth I/O is asynchronous. Re-check every active-project fence before
    // publishing; an earlier request must never resurrect a closed/hidden tab.
    if (!current()) return false;
    this.send("folder:opened", { cwd, projectId, workspaceId, activationGeneration, needsLogin }, rendererTarget);
    return true;
  }

  /**
   * True when the agent has no provider in core auth.json or in the process environment.
   * The check is boolean only. It never sends credentials to the renderer.
   */
  private async agentNeedsLogin(): Promise<boolean> {
    if (envHasAgentProvider(process.env)) return false;
    const authPath = join(homedir(), ".termina", "agent", "auth.json");
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
      const needsLogin = !authJsonHasCoreCredential(JSON.parse(await readFile(authPath, "utf8")));
      this.loginHint = { mtimeMs: info.mtimeMs, size: info.size, needsLogin };
      return needsLogin;
    } catch {
      this.loginHint = null;
      return true;
    }
  }

  /** After `/login` writes auth.json, drop the chrome hint without re-opening the folder. */
  private startLoginHintWatch(): void {
    const agentDir = join(homedir(), ".termina", "agent");
    try {
      mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    } catch {
      return;
    }
    try {
      this.loginHintWatcher?.close();
      this.loginHintWatcher = watch(agentDir, { persistent: false }, (_event, filename) => {
        const name = filename ?? "";
        if (name && name !== "auth.json") return;
        this.loginHint = null;
        if (this.loginHintTimer) clearTimeout(this.loginHintTimer);
        this.loginHintTimer = setTimeout(() => {
          this.loginHintTimer = null;
          void this.publishLoginHint();
        }, 50);
      });
    } catch {
      this.loginHintWatcher = null;
    }
  }

  private async publishLoginHint(): Promise<void> {
    if (this.disposed) return;
    const needsLogin = await this.agentNeedsLogin();
    if (this.disposed) return;
    this.send("auth:login-hint", { needsLogin });
  }

  /** Coalesce one project's close confirmation and teardown transaction. */
  private closeProject(projectId: string): Promise<{ ok: boolean; error?: string; cancelled?: boolean }> {
    const pending = this.projectClosePromises.get(projectId);
    if (pending) return pending;
    const promise = this.closeProjectOnce(projectId);
    this.projectClosePromises.set(projectId, promise);
    void promise.then(
      () => {
        if (this.projectClosePromises.get(projectId) === promise) this.projectClosePromises.delete(projectId);
      },
      () => {
        if (this.projectClosePromises.get(projectId) === promise) this.projectClosePromises.delete(projectId);
      },
    );
    return promise;
  }

  /** Tear down one project: manager, terminals, watchers, and store. */
  private async closeProjectOnce(projectId: string): Promise<{ ok: boolean; error?: string; cancelled?: boolean }> {
    const project = this.projects.get(projectId);
    if (!project) return { ok: false, error: "project not found" };
    const rendererTarget = this.captureRendererSendTarget();
    // An opening project is not teardown-safe yet. Let that request finish so
    // close cannot delete a partially initialized project that its opener is
    // still mutating.
    if (this.projectIsSwitching(projectId)) return { ok: false, error: "project is still opening" };
    const wasActiveAtStart = this.activeProjectId === projectId;
    const closeSelectionAction = wasActiveAtStart ? this.beginProjectSelectionAction() : this.projectSelectionAction;
    const closeActivationGeneration = wasActiveAtStart
      ? this.nextProjectActivationGeneration()
      : this.projectActivationGeneration;
    const restoreActive = async (): Promise<void> => {
      if (!wasActiveAtStart || this.projects.get(projectId) !== project || this.activeProjectId !== projectId) return;
      if (this.projectSelectionAction !== closeSelectionAction || this.projectActivationGeneration !== closeActivationGeneration) return;
      project.activationGeneration = closeActivationGeneration;
      await this.sendFolderOpened(
        project.cwd,
        project.id,
        this.primaryWorkspace(project)?.id ?? "",
        closeActivationGeneration,
        closeSelectionAction,
        rendererTarget,
      );
    };
    if (!(await this.confirmClose(projectId))) {
      await restoreActive();
      return { ok: false, cancelled: true };
    }
    this.switchingProjects.add(projectId);
    // Capture the project's ids before teardown removes candidate workspaces
    // and exited terminals leave the sets.
    const closingWorkspaceIds = new Set(project.workspaces.keys());
    const closingRoots = await Promise.all([...project.workspaces.values()].map((ws) => this.canonicalPath(ws.root)));
    const closingIds = [...project.terminalIds];
    const closeLeaseRequester = `close:${projectId}`;
    let closeLeaseWorkspaceId: string | null = null;
    try {
      await this.drainVerifyJobs(closingIds);
      await this.drainSidecarQueues(closingIds);
      await project.mineCommit.catch(() => undefined);
      const primary = this.primaryWorkspace(project);
      if (primary) {
        const lease = await this.acquireWriteLease(primary.id, closeLeaseRequester, 8000);
        if (!lease.ok) {
          await restoreActive();
          return { ok: false, error: lease.error ?? "the project workspace is busy" };
        }
        closeLeaseWorkspaceId = primary.id;
      }
      await project.worldlines?.drainEvidence();
      await project.worldlines?.dispose().catch(() => undefined);
      project.worldlines = null;
      await this.clearMineFiles(project);
      // Drain only this project's terminals. Other open projects keep running.
      for (const id of closingIds) {
        this.tailer.stopWatching(id);
        this.worldlineTailers.get(id)?.stop();
        this.worldlineTailers.delete(id);
        this.closeTerminal(id);
      }
      await this.drainTerminals(closingIds);
      await this.drainSidecarQueues(closingIds);
      this.clearSidecarQueues(closingIds);
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
      await this.teardownRecording(project, closingWorkspaceIds, closingIds);
      const projectIds = [...this.projects.keys()];
      const closingIndex = projectIds.indexOf(projectId);
      this.projects.delete(projectId);
      let nextSelectionAction = closeSelectionAction;
      let nextActivationGeneration = closeActivationGeneration;
      if (this.activeProjectId === projectId) {
        const remaining = [...this.projects.keys()];
        const next = closingIndex > 0 ? (remaining[closingIndex - 1] ?? remaining[0]) : remaining[0];
        // If another selection happened while teardown was in flight, the
        // target project may have become active after close was requested.
        // Its removal still needs a fresh recovery epoch, and the old send
        // must remain fenced.
        if (
          !wasActiveAtStart
          || this.projectSelectionAction !== closeSelectionAction
          || this.projectActivationGeneration !== closeActivationGeneration
        ) {
          nextSelectionAction = this.beginProjectSelectionAction();
          nextActivationGeneration = this.nextProjectActivationGeneration();
        }
        this.activeProjectId = next ?? null;
        if (next) {
          const nextProject = this.projects.get(next)!;
          nextProject.activationGeneration = nextActivationGeneration;
        }
      }
      // Persist after the replacement is fronted: the stored focus must be
      // the tab the user actually sees, not the project being torn down.
      this.persistOpenProjects();
      // The close event advances the renderer's stale-event watermark even
      // when no replacement project exists. It is emitted before the next
      // folder push to preserve the existing teardown ordering.
      this.send("project:closed", { projectId, activationGeneration: nextActivationGeneration }, rendererTarget);
      if (this.activeProjectId) {
        const nextProject = this.projects.get(this.activeProjectId);
        if (nextProject) {
          await this.sendFolderOpened(
            nextProject.cwd,
            nextProject.id,
            this.primaryWorkspace(nextProject)?.id ?? "",
            nextActivationGeneration,
            nextSelectionAction,
            rendererTarget,
          );
        }
      }
      return { ok: true };
    } finally {
      if (closeLeaseWorkspaceId) this.releaseWriteLease(closeLeaseWorkspaceId, closeLeaseRequester);
      this.switchingProjects.delete(projectId);
    }
  }

  /**
   * Tear down the snapshot store and worker of the previous project.
   * The store is app-owned and deleted with its project session.
   */
  private async teardownRecording(project: ProjectState, closingWorkspaceIds: Set<string>, closingTerminalIds: Iterable<string>): Promise<void> {
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
    let store: SnapshotStore | null = null;
    try {
      store = promise ? await promise : null;
    } catch (err) {
      console.warn(`[main] snapshot store initialization failed during cleanup: ${String(err)}`);
    }
    const storeDir = project.storeDir;
    project.storeDir = null;
    if (store && storeDir) {
      try {
        await store.destroy();
      } catch (err) {
        console.warn(`[main] snapshot store removal failed: ${String(err)}`);
      }
    }
    const ackPrefixes = [...closingTerminalIds].map((id) => `ack-${id}-`);
    try {
      const root = this.eventsDirBinding;
      if (root) {
        const entries = await boundPromotionListEntries({ root: this.eventsDir, rootIdentity: root });
        for (const entry of entries) {
          const f = entry.name;
          if (!ackPrefixes.some((prefix) => f.startsWith(prefix))) continue;
          // The primary root is still owned by this app. Candidate roots are
          // cleaned by their worldline binding before its manager is released.
          if (entry.kind === "file" || entry.kind === "symlink") {
            await this.removeBoundEventLeaf(this.eventsDir, root, f, entry.identity);
          }
        }
      }
    } catch {
      /* The events directory can be absent. */
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
      if (target === null || target.has(inst.id)) {
        inst.pty.killGroup("SIGKILL");
        inst.pty.kill("SIGKILL");
      }
    }
  }

  // -------------------------------------------------------------- watcher ---

  /** Start the watcher of one workspace. Returns the watcher. */
  private startWatcher(ws: WorkspaceState): ProjectWatcher {
    const watcher = new ProjectWatcher(ws.root, (p) => this.canonicalPath(p));
    // The workspace root is stable for the lifetime of this watcher. Keep its
    // canonical form in flight once so each filesystem event only resolves the
    // changed path.
    const canonicalRootPromise = this.canonicalPath(ws.root);
    const workspaceTerminals = (): AgentTerminalInstance[] =>
      [...ws.terminalIds].map((id) => this.terminals.get(id)).filter((t): t is AgentTerminalInstance => t !== undefined);
    watcher.onChange = async (change) => {
      const rendererTarget = this.captureRendererSendTarget();
      const owner = this.projectOfWorkspace(ws.id);
      if (this.disposed || !owner || this.projectIsSwitching(owner.id)) return;
      const path = await this.canonicalPath(change.path);
      const canonicalRoot = await canonicalRootPromise;
      const relPath = relative(canonicalRoot, path);
      if (!relPath || relPath.startsWith("..") || isAbsolute(relPath)) return;
      // Keep the Quick Open inventory current. Only creates and modifications
      // arrive here; deletions come through onFileDeleted below. A watcher
      // overflow replays every observed path through these same callbacks, so
      // the index re-syncs rather than drifting. The root scopes the patch to
      // the indexed project; background workspaces never touch it.
      this.pathIndex.noteAdded(canonicalRoot, relPath);
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
      if (this.lastWatchChange.size > TerminaApp.LAST_WATCH_MAX) {
        const oldest = this.lastWatchChange.keys().next().value;
        if (oldest !== undefined) this.lastWatchChange.delete(oldest);
      }
      if (isDupWatch) return;
      // Keep per-turn project snapshots near live state without a walk per
      // event: one debounced refresh per burst.
      this.scheduleProjectSnapshot(ws.id);
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
      const owners: AgentTerminalInstance[] = [];
      const unowned: AgentTerminalInstance[] = [];
      for (const inst of busy) {
        const at = inst.lastToolAt.get(path);
        const mine = at !== undefined && now - at < TOOL_CHANGE_DEDUP_MS;
        (mine ? owners : unowned).push(inst);
      }
      if (owners.length > 0) {
        for (const inst of owners) {
          await this.recordModified(inst, path, change.status);
          // Fork Any Moment: the path joins the terminal's next capture.
          this.addPendingHint(inst, relPath);
          this.scheduleMomentCapture(inst, rendererTarget);
          const last = inst.timeline.at(-1);
          if (last && last.t === "tool" && last.path === path && this.contentSizeOk(change.content)) {
            last.content = change.content;
            this.setRunSnapshot(inst, path, change.content);
          }
        }
      } else if (!verifyInWorkspace) {
        for (const inst of unowned) {
          await this.recordModified(inst, path, change.status);
          this.addPendingHint(inst, relPath);
          this.scheduleMomentCapture(inst, rendererTarget);
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
            this.send("timeline:event", { terminalId: inst.id, event: pub }, rendererTarget);
          } else {
            this.pushTimeline(inst, { t: "change", path, relPath, content, status: change.status }, rendererTarget);
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
        this.setBounded(ws.changeLines, path, changedLines, TerminaApp.MAX_MODIFIED_FILES);
      } else {
        ws.changeLines.delete(path);
      }
      this.send("file:changed", { projectId: owner.id, workspaceId: ws.id, path, relPath, content: liveContent, status: change.status, changedLines }, rendererTarget);
    };
    watcher.onFileTouched = async (path, status) => {
      const owner = this.projectOfWorkspace(ws.id);
      if (this.disposed || !owner || this.projectIsSwitching(owner.id)) return;
      const canonical = await this.canonicalPath(path);
      const relPath = relative(await this.canonicalPath(ws.root), canonical);
      if (!relPath || relPath.startsWith("..") || isAbsolute(relPath)) return;
      ws.generation++;
      this.markCandidateEvidenceStale(ws.comparisonId);
      for (const inst of workspaceTerminals()) {
        if (inst.busy) await this.recordModified(inst, canonical, status);
      }
    };
    watcher.onFileDeleted = async (path) => {
      const rendererTarget = this.captureRendererSendTarget();
      const owner = this.projectOfWorkspace(ws.id);
      if (this.disposed || !owner || this.projectIsSwitching(owner.id)) return;
      const p = await this.canonicalPath(path);
      const canonicalRoot = await this.canonicalPath(ws.root);
      const relPath = relative(canonicalRoot, p);
      if (!relPath || relPath.startsWith("..") || isAbsolute(relPath)) return;
      this.pathIndex.noteRemoved(canonicalRoot, relPath);
      ws.generation++;
      this.markCandidateEvidenceStale(ws.comparisonId);
      this.send("file:deleted", { projectId: owner.id, workspaceId: ws.id, path: p }, rendererTarget);
      for (const inst of workspaceTerminals()) await this.recordDeleted(inst, p, rendererTarget);
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

  private async canonicalPath(p: string): Promise<string> {
    let tail = "";
    let cur = p;
    while (true) {
      try {
        const real = await fsRealpath(cur);
        return tail ? join(real, tail) : real;
      } catch {
        const parent = dirname(cur);
        if (parent === cur) return p;
        tail = tail ? join(basename(cur), tail) : basename(cur);
        cur = parent;
      }
    }
  }

  private async withinRoot(absPath: string, root: string): Promise<boolean> {
    if (!root) return false;
    const rel = relative(await this.canonicalPath(root), await this.canonicalPath(absPath));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  }

  private async rel(absPath: string, root: string): Promise<string> {
    const p = await this.canonicalPath(absPath);
    return relative(await this.canonicalPath(root), p);
  }

  private explorerWorkspace(projectId: unknown): { project: ProjectState; workspace: WorkspaceState } | { error: string } {
    if (typeof projectId !== "string") return { error: "invalid project" };
    const project = this.projects.get(projectId);
    if (!project || this.projectIsSwitching(projectId)) return { error: "project is not open" };
    const workspace = this.primaryWorkspace(project);
    if (!workspace) return { error: "project workspace is not available" };
    return { project, workspace };
  }

  /** The project/workspace must still be owned and open before a write commits. */
  private explorerWorkspaceIsLive(projectId: string, project: ProjectState, workspace: WorkspaceState, requester: string): boolean {
    return !this.projectIsSwitching(projectId)
      && this.projects.get(projectId) === project
      && project.workspaces.get(workspace.id) === workspace
      && this.workspaceOwners.get(workspace.id) === projectId
      && workspace.writerId === requester;
  }

  /** Serialize one Explorer mutation with capture, close, and other writers. */
  private async mutateExplorer(
    projectId: unknown,
    mutation: (workspace: WorkspaceState, live: () => boolean) => Promise<{ ok: boolean; error?: string; name?: string }>,
  ): Promise<{ ok: boolean; error?: string; name?: string }> {
    const target = this.explorerWorkspace(projectId);
    if ("error" in target) return { ok: false, error: target.error };
    const requester = `explorer:${target.project.id}:${randomUUID()}`;
    const lease = await this.acquireWriteLease(target.workspace.id, requester, 5000);
    if (!lease.ok) return { ok: false, error: lease.error ?? "the project workspace is busy" };
    try {
      const live = () => this.explorerWorkspaceIsLive(target.project.id, target.project, target.workspace, requester);
      if (!live()) return { ok: false, error: "project is not open" };
      return await mutation(target.workspace, live);
    } finally {
      this.releaseWriteLease(target.workspace.id, requester);
    }
  }

  private async projectAbs(workspace: WorkspaceState, relPath: string): Promise<string> {
    const abs = isAbsolute(relPath) ? relPath : join(workspace.root, relPath);
    if (await this.hasDanglingSymlink(abs)) throw new Error(`path outside project: ${relPath}`);
    const [root, path] = await Promise.all([this.canonicalPath(workspace.root), this.canonicalPath(abs)]);
    const rel = relative(root, path);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`path outside project: ${relPath}`);
    }
    return path;
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

  private async listDir(projectId: unknown, absPath: string): Promise<{ entries: ExplorerEntry[]; error?: string; truncated?: boolean }> {
    const target = this.explorerWorkspace(projectId);
    if ("error" in target) return { entries: [], error: target.error };
    try {
      if (await this.hasDanglingSymlink(absPath)) return { entries: [], error: "path outside the project workspace" };
      const [rootCanon, dir] = await Promise.all([
        this.canonicalPath(target.workspace.root),
        this.canonicalPath(absPath),
      ]);
      const dirRel = relative(rootCanon, dir);
      if (dirRel.startsWith("..") || isAbsolute(dirRel)) return { entries: [], error: "path outside the project workspace" };
      const dirents = await readdir(dir, { withFileTypes: true });
      const visible = dirents.filter((ent) => !IGNORED_SEGMENTS.has(ent.name) && !ent.name.startsWith("."));
      visible.sort((a, b) => {
        const aDir = a.isDirectory() ? 0 : 1;
        const bDir = b.isDirectory() ? 0 : 1;
        if (aDir !== bDir) return aDir - bDir;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });
      const entries: ExplorerEntry[] = [];
      let truncated = false;
      for (const ent of visible) {
        if (entries.length >= MAX_EXPLORER_ENTRIES) {
          truncated = true;
          break;
        }
        const full = join(dir, ent.name);
        let child = full;
        let isDir = ent.isDirectory();
        if (ent.isSymbolicLink()) {
          try {
            // A symlink is the only entry that can resolve anywhere but here:
            // `dir` is the output of canonicalPath, so a plain child is already
            // canonical and needs no realpath walk. Resolving the link once
            // yields both the path to report and, via stat, whether it is a
            // directory — the same value canonicalPath would have returned.
            child = await fsRealpath(full);
            const st = await stat(full);
            isDir = st.isDirectory();
          } catch {
            continue;
          }
        }
        const relPath = relative(rootCanon, child);
        if (!relPath || relPath.startsWith("..") || isAbsolute(relPath)) continue;
        entries.push({
          name: ent.name,
          path: child,
          relPath,
          type: isDir ? "dir" : "file",
        });
      }
      return truncated ? { entries, truncated: true } : { entries };
    } catch (err) {
      return { entries: [], error: (err as Error).message };
    }
  }

  // ------------------------------------------------------------------ IPC ---

  /** Capture the exact outbound owner before an async callback yields. */
  private captureRendererSendTarget(): PtyRendererSendTarget | null {
    const win = this.win;
    if (!win) return null;
    try {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return null;
      return {
        window: win,
        webContents: win.webContents,
        windowGeneration: this.rendererWindowGeneration,
        rendererGeneration: this.rendererGeneration,
        nonce: this.rendererDocumentNonce,
      };
    } catch {
      // BrowserWindow/WebContents teardown can race target capture. A
      // missing target is safer than handing an async callback a partial one.
      return null;
    }
  }

  /**
   * Push one generic state update only to the document that owns it. A caller
   * that crosses an await captures its target before yielding; a synchronous
   * send failure is contained and cannot escape a watcher/menu callback.
   */
  private send(channel: string, payload: unknown, expected?: PtyRendererSendTarget | null): boolean {
    // `undefined` means a synchronous caller wants the current document;
    // an explicit null is a captured teardown and must stay a no-op rather
    // than accidentally retargeting a replacement document.
    const target = expected === undefined ? this.captureRendererSendTarget() : expected;
    if (!target) return false;
    const current = this.captureRendererSendTarget();
    const sent = sendPtyRendererMessage(current, target, this.rendererReady, channel, payload);
    if (sent) return true;
    if (!current) {
      // A destroyed current WebContents may make target capture return null.
      // Fence only when the target is still the app's exact document; an
      // old callback must never mutate a replacement renderer's scheduler.
      try {
        if (
          this.win === target.window
          && this.rendererWindowGeneration === target.windowGeneration
          && this.rendererGeneration === target.rendererGeneration
        ) {
          this.rendererReady = false;
          this.ptyEgress.setRendererReady(target.windowGeneration, target.rendererGeneration, false);
        }
      } catch {
        /* Teardown already fenced the document. */
      }
      return false;
    }
    // A stale target or a renderer that is already fenced is a no-op. In
    // particular, this branch must not reload or otherwise touch replacement
    // document state.
    if (!isPtyRendererSendTargetCurrent(current, target) || !this.rendererReady) return false;

    // Keep the PTY replay gate aligned with a current-document failure. The
    // Lifecycle listeners own normal crash handling; this branch fences and
    // reloads the current PTY document when WebContents.send failed before
    // Chromium delivered its render-process-gone event. A stale target never
    // reaches this branch, so an old callback cannot reload a replacement.
    try {
      if (!target.window.isDestroyed() && !target.webContents.isDestroyed()) {
        this.rendererReady = false;
        this.ptyEgress.setRendererReady(target.windowGeneration, target.rendererGeneration, false);
        this.reloadPtyDocument(target.window as BrowserWindow, target.windowGeneration);
      }
    } catch {
      /* Teardown already fenced the document. */
    }
    return false;
  }

  /** Deliver one bounded PTY chunk only to the current loaded renderer. */
  private sendPtyChunk(
    id: string,
    terminalGeneration: number,
    windowGeneration: number,
    rendererGeneration: number,
    sequence: number,
    data: string,
  ): boolean {
    const win = this.win;
    if (
      !win
      || !this.rendererReady
      || !this.isCurrentPtyDocument(win, windowGeneration, rendererGeneration)
    ) return false;
    try {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return false;
      if (win.webContents.isCrashed()) {
        this.reloadPtyDocument(win, windowGeneration);
        return false;
      }
      win.webContents.send("pty:data", {
        id,
        generation: terminalGeneration,
        windowGeneration,
        rendererGeneration,
        sequence,
        data,
      });
      return true;
    } catch {
      // render-process-gone/destroy can race the readiness check. Returning
      // false leaves the chunk queued; invalidate the exact current document
      // and let its replacement navigation mint the next frame/nonce pair.
      this.reloadPtyDocument(win, windowGeneration);
      return false;
    }
  }

  /** Deliver the sequenced natural-exit marker through the same ledger as data. */
  private sendPtyExit(
    id: string,
    terminalGeneration: number,
    windowGeneration: number,
    rendererGeneration: number,
    sequence: number,
    code: number,
  ): boolean {
    const win = this.win;
    if (
      !win
      || !this.rendererReady
      || !this.isCurrentPtyDocument(win, windowGeneration, rendererGeneration)
    ) return false;
    try {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return false;
      if (win.webContents.isCrashed()) {
        this.reloadPtyDocument(win, windowGeneration);
        return false;
      }
      win.webContents.send("pty:exit", {
        id,
        generation: terminalGeneration,
        windowGeneration,
        rendererGeneration,
        sequence,
        code,
      });
      return true;
    } catch {
      this.reloadPtyDocument(win, windowGeneration);
      return false;
    }
  }

  /** Enqueue PTY output in the single fair, lossless delivery path. */
  private sendPtyData(id: string, terminalGeneration: number, data: string): boolean {
    const inst = this.terminals.get(id);
    if (this.disposed || !inst || inst.closed || inst.generation !== terminalGeneration) return false;
    return this.ptyEgress.enqueue(id, terminalGeneration, data);
  }

  private registerIpc(): void {
    // Keep the existing registration surface, but make every invoke handler
    // pass through the one capability gate. `on` remains available only for
    // the PTY handshake messages, which apply the same gate explicitly below.
    const ipcMain = {
      handle: (channel: string, listener: (...args: any[]) => any) => this.handleIpc(channel, listener),
      on: electronIpcMain.on.bind(electronIpcMain),
    };
    electronIpcMain.on("renderer:capability", (event) => {
      event.returnValue = this.rendererCapabilityFor(event);
    });

    // ---- Project tabs ----
    ipcMain.handle("project:list", async () => {
      if (this.initialRestorePromise) await this.initialRestorePromise;
      const needsLogin = await this.agentNeedsLogin();
      return [...this.projects.values()].map((p) => ({
        id: p.id,
        cwd: p.cwd,
        workspaceId: this.primaryWorkspace(p)?.id ?? "",
        active: p.id === this.activeProjectId,
        terminals: p.terminalIds.size,
        needsLogin,
        activationGeneration: p.activationGeneration,
      }));
    });
    ipcMain.handle("project:open", async () => {
      if (this.initialRestorePromise) await this.initialRestorePromise;
      return this.openFolder();
    });
    ipcMain.handle("project:open-path", async (_e, cwd: unknown) => {
      if (this.initialRestorePromise) await this.initialRestorePromise;
      if (app.isPackaged && process.env.TERMINA_E2E !== "1") return { cancelled: true };
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
      return { ok: await this.activateProject(projectId) };
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
      else if (command === "cut") this.win.webContents.cut();
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
    ipcMain.handle("update:check", async () => {
      return (await this.appUpdater?.check()) ?? { status: "disabled" as const, currentVersion: app.getVersion() };
    });
    ipcMain.handle("update:install", () => this.installAppUpdate());

    ipcMain.handle("terminals:create", async (_e, opts?: unknown) => {
      let type: "agent" | "shell" | undefined;
      let shell: string | undefined;
      let engine: "core" | undefined;
      let fromTerminalId: string | undefined;
      let projectId: string | undefined;
      if (opts !== undefined) {
        if (typeof opts !== "object" || opts === null) return { ok: false, error: "invalid terminal options" };
        const rec = opts as { type?: unknown; shell?: unknown; engine?: unknown; fromTerminalId?: unknown; projectId?: unknown };
        if (rec.type !== undefined && rec.type !== "agent" && rec.type !== "shell") {
          return { ok: false, error: "invalid terminal type" };
        }
        if (rec.engine !== undefined && rec.engine !== "core") {
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
        if (rec.projectId != null) {
          if (typeof rec.projectId !== "string" || rec.projectId.length > 64) {
            return { ok: false, error: "invalid project" };
          }
          const pid = rec.projectId.trim();
          if (pid) projectId = pid;
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
        const t = await this.createTerminal(undefined, { type, shell, engine, fromTerminalId, projectId });
        return { ok: true, id: t.id };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });
    ipcMain.handle("terminals:shells", () => detectShells());
    // PTY delivery control is deliberately a single typed preload path. The
    // sender and capability checks fence delayed messages from a renderer that
    // has crashed or been replaced, while the terminal generation fences id reuse.
    ipcMain.on("pty:ready", (event, id: unknown, generation: unknown, capability: unknown) => {
      if (!this.isTrustedRenderer(event, capability)) return;
      if (typeof id !== "string" || typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) return;
      const rendererCapability = this.parseRendererCapability(capability);
      const frameIdentity = this.readIpcFrameIdentity(event);
      const current = this.currentPtyLifecycle();
      // A ready message is a capability proof for one concrete document and
      // one concrete main frame. A stale process/frame pair cannot borrow the
      // new document's nonce through the same WebContents.
      if (
        this.rendererAwaitingNewFrame
        || !frameIdentity
        || !current
        || !rendererCapability
        || current.processId < 1
        || current.frameRoutingId < 1
        || !isPtyReadyHandshakeCurrent(
          current,
          current,
          rendererCapability.nonce,
          frameIdentity.processId,
          frameIdentity.frameRoutingId,
        )
      ) return;
      // The preload's nonce is issued by main for this exact document. It is
      // a stronger final proof than a frame-finish callback (which has no
      // document token), so a delayed failure/finish callback cannot strand a
      // valid replacement before hydration.
      if (this.rendererLoadPending || !this.rendererReady) {
        this.rendererLoadPending = false;
        this.rendererPendingLoad = null;
        this.rendererReady = true;
        this.ptyEgress.setRendererReady(this.rendererWindowGeneration, this.rendererGeneration, true);
      }
      this.ptyEgress.hydrateTerminal(
        id,
        generation,
        this.rendererWindowGeneration,
        this.rendererGeneration,
      );
    });
    ipcMain.on("pty:ack", (event, payload: unknown, capability: unknown) => {
      if (!this.isTrustedRenderer(event, capability)) return;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
      const p = payload as Record<string, unknown>;
      if (
        typeof p.id !== "string"
        || typeof p.generation !== "number"
        || !Number.isSafeInteger(p.generation)
        || p.generation < 1
        || typeof p.windowGeneration !== "number"
        || !Number.isSafeInteger(p.windowGeneration)
        || p.windowGeneration < 1
        || typeof p.rendererGeneration !== "number"
        || !Number.isSafeInteger(p.rendererGeneration)
        || p.rendererGeneration < 1
        || typeof p.sequence !== "number"
        || !Number.isSafeInteger(p.sequence)
        || p.sequence < 1
      ) return;
      this.ptyEgress.acknowledge(
        p.id,
        p.generation,
        p.windowGeneration,
        p.rendererGeneration,
        p.sequence,
      );
    });
    ipcMain.handle("terminals:close", (event, id: unknown, generation: unknown) => {
      if (event.sender !== this.win?.webContents) return;
      if (typeof id !== "string" || typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) return;
      const inst = this.terminals.get(id);
      if (!inst || inst.generation !== generation) return;
      this.closeUserTerminal(id);
    });
    ipcMain.handle("terminals:write", (_e, id: unknown, data: unknown) => {
      if (typeof id !== "string" || typeof data !== "string") return;
      const inst = this.terminals.get(id);
      if (!inst) return;
      // Detect /clear (/new alias) slash command before it reaches the pty. The bridge also
      // catches it via the prompt payload, but /clear may reset the session
      // without a prompt/before_agent_start cycle.
      if (inst.type === "agent") this.trackNewCommandInput(id, data);
      // Keystrokes are tiny. Skip the UTF-8 scan until the payload is large.
      let text = data;
      if (data.length > 4096 && Buffer.byteLength(data, "utf8") > MAX_CLIPBOARD_BYTES) {
        text = capUtf8(data, MAX_CLIPBOARD_BYTES);
      }
      if (text === "\x03") {
        inst.interruptedAt = Date.now();
        inst.pty.interrupt();
      } else {
        inst.pty.write(text);
      }
    });
    ipcMain.handle("terminals:resize", (_e, id: unknown, cols: unknown, rows: unknown) => {
      if (typeof id !== "string" || !Number.isFinite(cols) || !Number.isFinite(rows)) return;
      this.terminals.get(id)?.pty.resize(Math.max(2, Math.floor(Number(cols))), Math.max(2, Math.floor(Number(rows))));
    });
    ipcMain.handle("terminals:list", async () => {
      if (this.initialRestorePromise) await this.initialRestorePromise;
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
    ipcMain.handle("worldline:list", (_e, projectId: unknown) => {
      if (typeof projectId !== "string") return [];
      return this.projects.get(projectId)?.worldlines?.listWithEvidence() ?? [];
    });
    ipcMain.handle("worldline:promote", (_e, comparisonId: string, label: "A" | "B", force?: boolean) => {
      if (force !== undefined && force !== true && force !== false) return { ok: false, error: "invalid force" };
      const manager = this.projectOfComparison(comparisonId)?.worldlines;
      if (!manager) return Promise.resolve({ ok: false, error: "candidate not found" });
      return manager.promote(comparisonId, label, force === true);
    });
    ipcMain.handle("worldline:export", (_e, comparisonId: string, label: "A" | "B") => {
      if (label !== "A" && label !== "B") return { ok: false, error: "invalid candidate" };
      const manager = this.projectOfComparison(comparisonId)?.worldlines;
      if (!manager) return Promise.resolve({ ok: false, error: "candidate not found" });
      return manager.exportCandidate(comparisonId, label);
    });
    ipcMain.handle("worldline:challenge", async (_e, runId: string, profile: unknown) => {
      if (!isChallengeProfile(profile)) return { ok: false, error: "invalid challenge profile" };
      const manager = this.projectForRun(runId)?.worldlines;
      if (!manager) return { ok: false, error: "run not found" };
      return manager.challenge(runId, profile);
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
      await this.initWorldlines(owner);
      const ev = inst.timeline.find((e) => e.seq === seq) ?? null;
      return owner.worldlines!.forkPoint(terminalId, ev);
    });
    const wlOf = (comparisonId: string) => this.projectOfComparison(comparisonId)?.worldlines ?? null;
    ipcMain.handle("worldline:details", (_e, comparisonId: string, label: "A" | "B") => wlOf(comparisonId)?.details(comparisonId, label) ?? { ok: false, error: "worldlines unavailable" });
    ipcMain.handle("worldline:challenge-candidate", (_e, comparisonId: string, label: "A" | "B", profile: unknown) => {
      if (!isChallengeProfile(profile)) return { ok: false, error: "invalid challenge profile" };
      return wlOf(comparisonId)?.challengeFromCandidate(comparisonId, label, profile) ?? { ok: false, error: "worldlines unavailable" };
    });
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
    ipcMain.handle("editor:unsaved-report", (_e, requestId: unknown, result: unknown) => {
      if (typeof requestId !== "string") return;
      if (!isUnsavedConfirmResult(result)) return;
      const waiter = this.unsavedWaiters.get(requestId);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.unsavedWaiters.delete(requestId);
      waiter.resolve(result);
    });
    /** The flush saves go through the lease holder (the preflight). */
    ipcMain.handle("file:flush-save", async (_e, absPath: string, content: string, writerId: string, owner: unknown) => {
      if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_OPEN_FILE_SIZE) return { ok: false, error: "file content is too large" };
      const target = this.projectWorkspace(owner);
      if (!target) return { ok: false, error: "invalid project workspace" };
      const managed = await this.managedPath(absPath, target.workspace.id);
      if (!managed || managed.workspace.id !== target.workspace.id) return { ok: false, error: "path is outside the project workspace" };
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

    // ---- Verify & Iterate ----
    ipcMain.handle("verify:detect", (_e, terminalId?: string) => {
      // A candidate terminal detects from its own isolated tree.
      if (terminalId !== undefined) {
        if (typeof terminalId !== "string") return null;
        const inst = this.terminals.get(terminalId);
        return inst ? detectTestCommand(inst.cwd) : null;
      }
      return detectTestCommand(this.terminalCwd());
    });
    ipcMain.handle("verify:run", (_e, terminalId: string) => this.runVerify(terminalId));
    ipcMain.handle("verify:cancel", (_e, terminalId: string) => this.cancelVerify(terminalId));

    // ---- Mine ----
    ipcMain.handle("mine:set", (_e, path: string, mine: boolean, owner: unknown) => this.setMineFile(path, mine, owner));
    ipcMain.handle("mine:list", (_e, owner: unknown) => {
      const target = this.projectWorkspace(owner);
      if (!target || !target.workspace.primary) return [];
      return [...target.project.mineFiles];
    });

    // ---- Dispatch ----
    ipcMain.handle("dispatch:run", (_e, terminalId: string, taskText?: string) =>
      this.dispatchRun(terminalId, typeof taskText === "string" ? taskText : undefined),
    );

    // ---- Session Search ----
    ipcMain.handle("session:search", (_e, query: unknown) => this.searchSessions(typeof query === "string" ? query : ""));
    ipcMain.handle("file:search", (_e, query: unknown, source: unknown) => this.searchProjectFiles(typeof query === "string" ? query : "", source));
    ipcMain.handle("file:record-recent", (_e, projectId: unknown, relPath: unknown) => this.rememberFile(projectId, relPath));
    ipcMain.handle("content:search", (_e, pattern: unknown, source: unknown) => this.searchProjectContent(pattern, source));

    // ---- Plan Board ----
    ipcMain.handle("plan:get", (_e, terminalId: string) => this.terminals.get(terminalId)?.plan ?? []);

    // ---- Session Timeline ----
    ipcMain.handle("timeline:get", (_e, terminalId: string) => {
      const tl = this.terminals.get(terminalId)?.timeline ?? [];
      return tl
        .filter((event) => !!event.stateId && !!event.entryId && !event.evicted)
        .map(({ content: _content, ...pub }) => pub);
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
      const managed = inst ? await this.managedPath(path, inst.workspaceId) : null;
      if (!inst || !managed || managed.workspace.id !== inst.workspaceId) return { status: "modified", baseline: undefined };
      // A lazy capture can still be in flight when the user clicks the
      // modified entry. Wait for it so the diff does not show a false
      // "no baseline" state.
      if (!inst.baselines.has(managed.path)) {
        const pending = inst.baselineFills.get(managed.path);
        if (pending) await Promise.race([pending, new Promise((r) => setTimeout(r, 2000))]);
      }
      const status = inst.modified.get(managed.path)?.status;
      const b = inst.baselines.get(managed.path);
      if (b === undefined) return { status: status === "deleted" ? "deleted" : "modified", baseline: undefined };
      if (b === null) return { status: "created", baseline: null };
      return { status: status === "deleted" ? "deleted" : "modified", baseline: b };
    });
    ipcMain.handle("review:revert", async (_e, terminalId: string, path: string) => {
      const inst = this.terminals.get(terminalId);
      if (!inst) return { ok: false, error: "terminal not found" };
      const blocked = this.assertWorkspaceWritable(inst.workspaceId);
      if (blocked) return { ok: false, error: blocked };
      const managed = await this.managedPath(path, inst.workspaceId);
      if (!managed || managed.workspace.id !== inst.workspaceId) return { ok: false, error: "path is outside the terminal workspace" };
      const p = managed.path;
      const b = inst.baselines.get(p);
      if (b === undefined) return { ok: false, error: "no baseline captured for this file" };
      try {
        if (b === null) {
          // The agent created the file. Delete it.
          await rm(p, { force: true });
        } else {
          // The file's parent may have been deleted with it.
          await mkdir(dirname(p), { recursive: true });
          await writeFile(p, b, "utf8");
        }
        this.deleteBaseline(inst, p);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    ipcMain.handle("file:open", (_e, absPath: unknown, owner: unknown) => {
      if (typeof absPath !== "string") return { ok: false, path: "", error: "invalid path" };
      return this.openFileInEditor(absPath, owner);
    });
    ipcMain.handle("file:save", async (_e, absPath: unknown, content: unknown, owner: unknown) => {
      if (typeof absPath !== "string") return { ok: false, error: "invalid path" };
      if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_OPEN_FILE_SIZE) return { ok: false, error: "file content is too large" };
      const target = this.projectWorkspace(owner);
      if (!target) return { ok: false, error: "invalid project workspace" };
      const managed = await this.managedPath(absPath, target.workspace.id);
      if (!managed || managed.workspace.id !== target.workspace.id) return { ok: false, error: "path is outside the project workspace" };
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

    ipcMain.handle("explorer:list-dir", (_e, projectId: unknown, absPath: unknown) => {
      if (typeof projectId !== "string" || typeof absPath !== "string") return { entries: [], error: "invalid path" };
      return this.listDir(projectId, absPath);
    });
    ipcMain.handle("explorer:create", async (_e, projectId: unknown, relPath: unknown, kind: unknown) => {
      if (typeof relPath !== "string") return { ok: false, error: "invalid path" };
      if (kind !== "file" && kind !== "dir") return { ok: false, error: "kind must be file or dir" };
      return this.mutateExplorer(projectId, async (workspace, live) => {
        const abs = await this.projectAbs(workspace, relPath);
        if (!live()) return { ok: false, error: "project is not open" };
        if (kind === "dir") {
          await mkdir(abs, { recursive: true });
        } else {
          await mkdir(dirname(abs), { recursive: true });
          if (!live()) return { ok: false, error: "project is not open" };
          await writeFile(abs, "", "utf8");
        }
        return { ok: true };
      }).catch((err) => ({ ok: false, error: (err as Error).message }));
    });
    ipcMain.handle("explorer:rename", async (_e, projectId: unknown, relPath: unknown, newName: unknown) => {
      if (typeof relPath !== "string") return { ok: false, error: "invalid path" };
      if (typeof newName !== "string" || !newName || newName.includes("/") || newName === "." || newName === "..") {
        return { ok: false, error: "invalid name" };
      }
      return this.mutateExplorer(projectId, async (workspace, live) => {
        const abs = await this.projectAbs(workspace, relPath);
        if (!live()) return { ok: false, error: "project is not open" };
        await fsRename(abs, join(dirname(abs), newName));
        return { ok: true };
      }).catch((err) => ({ ok: false, error: (err as Error).message }));
    });
    ipcMain.handle("explorer:delete", async (_e, projectId: unknown, relPath: unknown) => {
      if (typeof relPath !== "string") return { ok: false, error: "invalid path" };
      return this.mutateExplorer(projectId, async (workspace, live) => {
        const abs = await this.projectAbs(workspace, relPath);
        if (!live()) return { ok: false, error: "project is not open" };
        await rm(abs, { recursive: true, force: true });
        return { ok: true };
      }).catch((err) => ({ ok: false, error: (err as Error).message }));
    });

    // Explorer clipboard paste. Copies (or moves, for a cut entry) the source
    // under the target directory; a name collision gets " copy" / " copy N".
    // An empty targetDirRel means the project root itself.
    ipcMain.handle("explorer:paste", async (_e, projectId: unknown, targetDirRel: unknown, srcRel: unknown, move: unknown) => {
      if (typeof targetDirRel !== "string" || typeof srcRel !== "string" || typeof move !== "boolean") {
        return { ok: false, error: "invalid arguments" };
      }
      if (!srcRel || srcRel === ".") return { ok: false, error: "invalid source" };
      return this.mutateExplorer(projectId, async (workspace, live) => {
        const src = await this.projectAbs(workspace, srcRel);
        let dirAbs: string;
        if (targetDirRel === "" || targetDirRel === ".") {
          dirAbs = await this.canonicalPath(workspace.root);
        } else {
          dirAbs = await this.projectAbs(workspace, targetDirRel);
        }
        // The paste target must be a directory.
        try {
          if (!(await stat(dirAbs)).isDirectory()) return { ok: false, error: "paste target is not a folder" };
        } catch {
          return { ok: false, error: "paste target is not a folder" };
        }
        // A folder cannot be pasted into itself or one of its descendants.
        if (dirAbs === src || dirAbs.startsWith(src + sep)) {
          return { ok: false, error: "cannot paste a folder into itself" };
        }
        const dest = this.unusedCopyDest(dirAbs, basename(src));
        if (!dest) return { ok: false, error: "destination already exists" };
        if (!live()) return { ok: false, error: "project is not open" };
        if (move) await fsRename(src, dest);
        else await cp(src, dest, { recursive: true });
        return { ok: true, name: basename(dest) };
      }).catch((err) => ({ ok: false, error: (err as Error).message }));
    });
  }

  private async openFileInEditor(absPath: string, owner: unknown): Promise<{ ok: true; path: string; content: string; changedLines?: number[] } | { ok: false; path: string; error: string }> {
    const target = this.projectWorkspace(owner);
    if (!target) return { ok: false, path: absPath, error: "invalid project workspace" };
    const managed = await this.managedPath(absPath, target.workspace.id);
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

  /**
   * Parse a folder or file argument passed via CLI (e.g. `termina .` or `termina /path/to/folder`).
   * Ignores Electron switches and macOS process flags (e.g. -psn_...).
   */
  parseTargetCwdFromArgv(argv: string[], fallbackCwd = process.cwd()): string | null {
    return parseTargetCwdFromArgv(argv, fallbackCwd, app.isPackaged);
  }

  // ---------------------------------------------------------------- boot ----

  async start(): Promise<void> {
    // An e2e run must not take over the Dock either; the window stays hidden.
    if (E2E_HIDDEN_WINDOW) app.dock?.hide();
    // Core session admission is descriptor-bound and intentionally refuses to
    // create its own root. Establish the app-owned root before any restored
    // core terminal or session fork can inspect it.
    await mkdir(this.coreSessionRoot(), { recursive: true, mode: 0o700 });
    this.preferences = await this.preferencesStore.load();
    this.shortcutMap = { ...this.preferences.shortcuts };
    this.appUpdater = createAppUpdater({
      send: (state) => {
        this.send("update:state", state);
        this.applyUpdateMenu();
      },
    });
    this.registerIpc();
    this.startLoginHintWatch();
    void detectShells();
    // The launch scratch cleanup is native-bound and asynchronous.  A
    // changed events root/ancestor is retained until provenance is repaired.
    await this.prepareEventsDir();
    await this.cleanupStaleDispatchFiles();
    // Check if a directory was passed via CLI (`termina .`), open-file, or test fixture.
    const cliTarget = this.parseTargetCwdFromArgv(process.argv);
    const initial = cliTarget ?? pendingOpenPath ?? process.env.TERMINA_INITIAL_CWD;
    pendingOpenPath = null;
    const initialCwd = initial && existsSync(initial) ? initial : null;
    this.tailer.onEvent = (id, event) => this.enqueueSidecarEvent(id, event);
    this.tailer.start();
    this.schedules.start();
    // Publish the restoration barrier before yielding to the renderer's
    // project:list / terminals:list requests during window loading. The
    // window still opens immediately; only hydration waits for restoration.
    const windowReady = this.createWindow().then(() => { this.appUpdater?.start(); });
    this.initialRestorePromise = windowReady.then(() => this.restoreInitialProjects(initialCwd, cliTarget));
    await windowReady;
  }

  /** Asynchronously restore open projects and their terminals on boot. */
  private async restoreInitialProjects(initialCwd: string | null, cliTarget: string | null): Promise<void> {
    try {
      if (initialCwd) {
        if (process.env.TERMINA_INITIAL_CWD && !cliTarget) {
          await this.openProject(initialCwd);
        } else {
          const canonicalInitial = await this.canonicalPath(initialCwd);
          const stored: { root: string; canonical: string }[] = [];
          for (const root of this.preferences.openProjects) {
            try {
              if (!(await stat(root)).isDirectory()) continue;
              stored.push({ root, canonical: await this.canonicalPath(root) });
            } catch {
              continue;
            }
          }
          if (stored.some((s) => s.canonical === canonicalInitial)) {
            // Reopen in stored order so tab order survives, then refocus the target.
            for (const s of stored) {
              try {
                await this.openProject(s.root);
              } catch {
                continue;
              }
            }
            const focus = [...this.projects.values()].find((p) => p.canonicalRoot === canonicalInitial);
            if (focus && focus.id !== this.activeProjectId) {
              try {
                await this.activateProject(focus.id);
              } catch (err) {
                console.warn(`[main] could not refocus project ${focus.id}: ${(err as Error).message}`);
              }
            }
          } else {
            for (const s of stored) {
              try {
                await this.openProject(s.root);
              } catch {
                continue;
              }
            }
            await this.openProject(initialCwd);
          }
        }
      } else {
        // Restore the projects from the last session before the window loads.
        // Missing or non-directory paths are skipped: they may be unmounted
        // volumes or hand-edited entries. Tabs reopen in stored order; the
        // stored focus is applied afterwards so order and focus stay stable.
        for (const root of this.preferences.openProjects) {
          try {
            if (!(await stat(root)).isDirectory()) continue;
          } catch {
            continue;
          }
          try {
            await this.openProject(root);
          } catch (err) {
            console.warn(`[main] could not restore project ${root}: ${(err as Error).message}`);
          }
        }
        const focusRoot = this.preferences.activeProject;
        if (focusRoot) {
          const focus = [...this.projects.values()].find((p) => p.canonicalRoot === focusRoot);
          if (focus && focus.id !== this.activeProjectId) {
            try {
              await this.activateProject(focus.id);
            } catch (err) {
              console.warn(`[main] could not refocus project ${focusRoot}: ${(err as Error).message}`);
            }
          }
        }
      }
    } finally {
      this.sendInstances();
    }
  }

  /** Record the open projects so the next launch restores them. */
  private persistOpenProjects(): Promise<void> {
    // Stored in tab order; focus rides separately so a relaunch keeps both.
    const activeRoot = this.activeProjectId ? this.projects.get(this.activeProjectId)?.canonicalRoot ?? null : null;
    const ordered = [...this.projects.values()].map((p) => p.canonicalRoot);
    if (JSON.stringify(ordered) === JSON.stringify(this.preferences.openProjects)
      && activeRoot === this.preferences.activeProject) return Promise.resolve();
    return this.commitPreferencePatch({ openProjects: ordered, activeProject: activeRoot }, false).then(
      () => undefined,
      (err) => {
        console.warn(`[main] project list save failed: ${(err as Error).message}`);
      },
    );
  }

  private async checkAppUpdateFromMenu(): Promise<void> {
    const win = this.win && !this.win.isDestroyed() ? this.win : undefined;
    if (!app.isPackaged) {
      const payload = {
        type: "info" as const,
        title: "Check for Updates",
        message: `Termina ${app.getVersion()} is up to date`,
        detail: "This launch does not auto-update. Install Termina from GitHub Releases to receive packaged updates.",
      };
      if (win) await dialog.showMessageBox(win, payload);
      else await dialog.showMessageBox(payload);
      return;
    }

    const state = await this.appUpdater?.check();
    if (!state) return;
    if (state.status === "current") {
      const payload = {
        type: "info" as const,
        title: "Check for Updates",
        message: "You're up to date!",
        detail: `Termina ${state.currentVersion} is currently the newest version available.`,
      };
      if (win) await dialog.showMessageBox(win, payload);
      else await dialog.showMessageBox(payload);
    } else if (state.status === "available" || state.status === "downloading") {
      const payload = {
        type: "info" as const,
        title: "Update Available",
        message: `Termina ${state.version} is available`,
        detail: "Downloading update in the background…",
      };
      if (win) await dialog.showMessageBox(win, payload);
      else await dialog.showMessageBox(payload);
    } else if (state.status === "ready") {
      const res = await dialog.showMessageBox(win ?? ({} as Electron.BrowserWindow), {
        type: "info",
        title: "Update Ready",
        message: `Termina ${state.version} is ready to install`,
        detail: "Restart Termina to apply the update.",
        buttons: ["Restart and Install", "Later"],
        defaultId: 0,
        cancelId: 1,
      });
      if (res.response === 0) {
        void this.installAppUpdate();
      }
    } else if (state.status === "error") {
      const payload = {
        type: "warning" as const,
        title: "Check for Updates",
        message: "Could not check for updates",
        detail: state.message,
      };
      if (win) await dialog.showMessageBox(win, payload);
      else await dialog.showMessageBox(payload);
    }
  }

  private async installAppUpdate(): Promise<{ ok: boolean; error?: string }> {
    const updater = this.appUpdater;
    if (!updater) return { ok: false, error: "No update is ready." };
    const current = updater.getState();
    if (current.status !== "ready") return updater.install();
    if (this.installingUpdate) return { ok: false, error: "The update is already installing." };
    this.installingUpdate = true;
    if (!(await this.confirmClose())) {
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
    if (this.loginHintTimer) {
      clearTimeout(this.loginHintTimer);
      this.loginHintTimer = null;
    }
    this.loginHintWatcher?.close();
    this.loginHintWatcher = null;
    if (this.initialRestorePromise) {
      await this.initialRestorePromise.catch(() => undefined);
    }
    await this.rosterStore.drain();
    // Shutdown is an intentional cancellation boundary: no queued bytes or
    // exit notifications may be delivered after the app has begun teardown.
    this.ptyEgress.dispose();
    this.appUpdater?.dispose();
    this.schedules.stop();
    await this.persistOpenProjects();
    await this.preferenceCommits;
    await this.preferencesStore.flush();
    await this.drainVerifyJobs(null);
    this.tailer.stop();
    await this.drainSidecarQueues();
    this.sidecarQueues.clear();
    await Promise.all(this.ackWrites);
    await Promise.all([...this.projects.values()].map((project) => project.mineCommit.catch(() => undefined)));
    await Promise.all([...this.projects.values()].map((project) => project.worldlines?.drainEvidence() ?? Promise.resolve()));
    // Finalization can enqueue a core session fork; settle those recording
    // tasks and the shared worker before worldline teardown removes any dirs.
    await this.drainRecordingTasks();
    await this.sessionRetention.drain();
    await Promise.all([...this.projects.values()].map((project) => project.worldlines?.drainSessionForks() ?? Promise.resolve()));
    // Worldline disposal clears completed runs and therefore may enqueue
    // retained session-bundle discards. Keep the session worker alive until
    // those exact cleanup requests have drained; disposing it first would
    // silently retain every finalized branch at app shutdown.
    await Promise.all([...this.projects.values()].map((project) => project.worldlines?.dispose().catch(() => undefined) ?? Promise.resolve()));
    await this.sessionFork.dispose();
    await this.evidenceHomes.dispose();
    for (const project of this.projects.values()) {
      project.worldlines = null;
      for (const ws of project.workspaces.values()) ws.watcher?.stop();
    }
    for (const inst of this.terminals.values()) {
      if (inst.captureTimer) {
        clearTimeout(inst.captureTimer);
        inst.captureTimer = null;
      }
    }
    await Promise.all([...this.projects.values()].map((project) => project.storePromise?.catch(() => null) ?? Promise.resolve(null)));
    disposeWorldlineGitCore();
    for (const inst of this.terminals.values()) {
      inst.pty.killGroup("SIGTERM");
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
    for (const waiter of this.unsavedWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve({ ok: false, cancelled: true });
    }
    this.unsavedWaiters.clear();
    this.projects.clear();
    this.terminals.clear();
    for (const tailer of this.worldlineTailers.values()) tailer.stop();
    this.worldlineTailers.clear();
    this.stopPaintWatchdog();
  }

  focusWindow(): void {
    // An e2e run must never pull focus off whatever the user is doing.
    if (E2E_HIDDEN_WINDOW) return;
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isMinimized()) this.win.restore();
      this.win.focus();
    }
  }

  reloadWindow(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    this.reloadPtyDocument(win, this.rendererWindowGeneration);
  }

  private startPaintWatchdog(): void {
    this.stopPaintWatchdog();
    let blankCount = 0;
    let healthy = false;
    let lastCheck = 0;
    this.paintWatchdog = setInterval(() => {
      const win = this.win;
      if (!win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) return;
      const windowGeneration = this.rendererWindowGeneration;
      const rendererGeneration = this.rendererGeneration;
      const nonce = this.rendererDocumentNonce;
      if (!this.isCurrentPtyDocument(win, windowGeneration, rendererGeneration, nonce)) return;
      // A blank first paint is a startup problem. Check every 3 seconds
      // until the window paints content once. Then check every 15 seconds
      // to catch a stalled renderer.
      const cadence = healthy ? 15000 : 3000;
      const now = Date.now();
      if (now - lastCheck < cadence) return;
      lastCheck = now;
      void (async () => {
        if (!this.isCurrentPtyDocument(win, windowGeneration, rendererGeneration, nonce) || win.webContents.isDestroyed()) return;
        let img: Electron.NativeImage | null = null;
        try {
          img = await Promise.race([
            win.webContents.capturePage(),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("capture timeout")), 2500)),
          ]);
        } catch {
          img = null;
        }
        // capturePage is asynchronous; the window or document may have been
        // replaced while it was in flight. Never let that stale callback
        // update watchdog state or reload the replacement.
        if (!this.isCurrentPtyDocument(win, windowGeneration, rendererGeneration, nonce) || win.webContents.isDestroyed()) return;
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
            this.reloadPtyDocument(win, windowGeneration);
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

const appState = new TerminaApp();

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

let pendingOpenPath: string | null = null;

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  try {
    const target = existsSync(filePath) && statSync(filePath).isFile() ? dirname(filePath) : filePath;
    if (existsSync(target) && statSync(target).isDirectory()) {
      if (app.isReady()) {
        appState.focusWindow();
        void appState.openProjectAt(target);
      } else {
        pendingOpenPath = target;
      }
    }
  } catch {
    // Ignore unresolvable paths
  }
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv, workingDirectory) => {
    appState.focusWindow();
    const targetCwd = appState.parseTargetCwdFromArgv(argv, workingDirectory);
    if (targetCwd) {
      void appState.openProjectAt(targetCwd);
    }
  });
  // Boot the app when Electron is ready. Without this line the window
  // never opens: every handler above only reacts to events.
  app.whenReady().then(() => void appState.start().catch((err) => console.error("[main] fatal startup error:", err)));
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void appState.createWindow();
});

app.on("before-quit", (event) => {
  if (cleanupComplete || process.env.NODE_ENV === "test") return;
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
    .confirmClose()
    .catch(() => false)
    .then((ok) => {
      cleanupStarted = false;
      if (!ok) return;
      quitConfirmed = true;
      app.quit();
    });
});

const handleTerminationSignal = (signal: string) => {
  if (cleanupStarted) return;
  cleanupStarted = true;
  console.log(`[main] received ${signal}, initiating cleanup...`);
  void appState
    .dispose()
    .catch((err) => {
      console.warn(`[main] dispose failed on ${signal}: ${(err as Error).message}`);
    })
    .finally(() => {
      process.exit(0);
    });
};

process.on("SIGINT", () => handleTerminationSignal("SIGINT"));
process.on("SIGTERM", () => handleTerminationSignal("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  console.warn("[main] unhandled rejection:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[main] uncaught exception:", error);
});
