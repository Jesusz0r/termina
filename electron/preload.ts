/**
 * Preload script: exposes the typed `window.pi` bridge to the renderer.
 */
import { contextBridge, ipcRenderer as electronIpcRenderer, webUtils } from "electron";
import type {
  MenuCommand,
  PiBridge,
  TerminalPasteResult,
  FileChangedPayload,
  ToolTargetPayload,
  FileDeletedPayload,
  ModifiedListPayload,
  BusyPayload,
  InstanceSummary,
  ExplorerEntry,
  RecorderState,
  VerifyInfo,
  TimelineEvent,
  TimelinePrefix,
  PlanPayload,
  WorldlineUpdatePayload,
  WorldlineRemovedPayload,
  WorldlineEvidencePayload,
  AppPreferences,
  PreferenceUpdate,
  ShortcutMap,
  FolderOpenedPayload,
  AppUpdateState,
  ProjectWorkspaceRef,
  PtyDataPayload,
  PtyExitPayload,
  RendererIpcCapability,
} from "../shared/types.js";

// Main issues this capability synchronously for the exact main frame that is
// running this preload. Keep it in the preload closure so renderer code cannot
// substitute a nonce/generation from another document. Every invoke/send below
// goes through the local facade, which appends this proof as an internal final
// argument; the renderer never receives a way to mint or update it.
const rendererCapability = electronIpcRenderer.sendSync("renderer:capability") as RendererIpcCapability | null;
const ipcRenderer = {
  invoke: (channel: string, ...args: unknown[]) => {
    try {
      return electronIpcRenderer.invoke(channel, ...args, rendererCapability);
    } catch (error) {
      return Promise.reject(error);
    }
  },
  send: (channel: string, ...args: unknown[]) => {
    try {
      electronIpcRenderer.send(channel, ...args, rendererCapability);
    } catch {
      // A destroyed/replaced renderer cannot complete an IPC send. The main
      // process owns replay for PTY output; generic state pushes are safely
      // dropped at this document boundary.
    }
  },
  on: electronIpcRenderer.on.bind(electronIpcRenderer),
};

const bridge: PiBridge = {
  // ---- push events ----
  onPtyData: (cb) => {
    ipcRenderer.on("pty:data", (_e, p: PtyDataPayload) => cb(p));
  },
  onPtyExit: (cb) => {
    ipcRenderer.on("pty:exit", (_e, p: PtyExitPayload) => cb(p));
  },
  onMenuCommand: (cb) => {
    ipcRenderer.on("menu:command", (_e, cmd: { command: MenuCommand }) => cb(cmd));
  },
  onToolTarget: (cb) => {
    ipcRenderer.on("tool:target", (_e, p: ToolTargetPayload) => cb(p));
  },
  onFileChanged: (cb) => {
    ipcRenderer.on("file:changed", (_e, p: FileChangedPayload) => cb(p));
  },
  onFileDeleted: (cb) => {
    ipcRenderer.on("file:deleted", (_e, p: FileDeletedPayload) => cb(p));
  },
  onModifiedList: (cb) => {
    ipcRenderer.on("modified:list", (_e, p: ModifiedListPayload) => cb(p));
  },
  onBusy: (cb) => {
    ipcRenderer.on("busy", (_e, p: BusyPayload) => cb(p));
  },
  onPlanUpdate: (cb) => {
    ipcRenderer.on("plan:update", (_e, p: PlanPayload) => cb(p));
  },
  onVerifyState: (cb) => {
    ipcRenderer.on("verify:state", (_e, p: { terminalId: string; verify: VerifyInfo }) => cb(p));
  },
  onTimelineEvent: (cb) => {
    ipcRenderer.on("timeline:event", (_e, p: { terminalId: string; event: TimelineEvent }) => cb(p));
  },
  onTimelineEvict: (cb) => {
    ipcRenderer.on("timeline:evict", (_e, p: { terminalId: string; seqs: number[] }) => cb(p));
  },
  onTimelineClear: (cb) => {
    ipcRenderer.on("timeline:clear", (_e, p: { terminalId: string }) => cb(p));
  },
  onTimelinePrefix: (cb) => {
    ipcRenderer.on("timeline:prefix", (_e, p: TimelinePrefix) => cb(p));
  },
  onRecorderState: (cb) => {
    ipcRenderer.on("timeline:recorder-state", (_e, p: { terminalId: string; state: RecorderState }) => cb(p));
  },
  onFolderOpened: (cb) => {
    ipcRenderer.on("folder:opened", (_e, e: FolderOpenedPayload) => cb(e));
  },
  onFlushRequest: (cb) => {
    ipcRenderer.on("editor:flush-request", (_e, p: { requestId: string; writerId: string; projectId: string; workspaceId: string }) => cb(p));
  },
  onUpdateState: (cb) => {
    ipcRenderer.on("update:state", (_e, state: AppUpdateState) => cb(state));
  },
  onInstances: (cb) => {
    ipcRenderer.on("instances:list", (_e, list: InstanceSummary[]) => cb(list));
  },

  // ---- terminals ----
  createTerminal: (opts) => ipcRenderer.invoke("terminals:create", opts),
  getShells: () => ipcRenderer.invoke("terminals:shells"),
  readyTerminal: (id, generation) => ipcRenderer.send("pty:ready", id, generation),
  acknowledgePtyData: (payload) => ipcRenderer.send("pty:ack", payload),
  closeTerminal: (id, generation) => ipcRenderer.invoke("terminals:close", id, generation),
  writeTerminal: (id, data) => ipcRenderer.invoke("terminals:write", id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.invoke("terminals:resize", id, cols, rows),
  getInstances: (): Promise<InstanceSummary[]> => ipcRenderer.invoke("terminals:list"),
  writeClipboard: (text) => ipcRenderer.invoke("clipboard:write", text),
  readClipboard: () => ipcRenderer.invoke("clipboard:read"),
  editClipboard: (command) => ipcRenderer.invoke("clipboard:edit", command),
  pasteTerminal: (id) => ipcRenderer.invoke("terminals:paste", id),
  dropTerminalFiles: (id, files): Promise<TerminalPasteResult> => {
    if (!Array.isArray(files) || files.length === 0) return Promise.resolve({ ok: false, error: "no files" });
    if (files.length > 16) return Promise.resolve({ ok: false, error: "too many files" });
    try {
      const paths = files.map((file) => webUtils.getPathForFile(file));
      if (paths.some((path) => typeof path !== "string" || path.length === 0)) {
        return Promise.resolve({ ok: false, error: "invalid dropped file" });
      }
      return ipcRenderer.invoke("terminals:drop-files", id, paths);
    } catch {
      return Promise.resolve({ ok: false, error: "invalid dropped file" });
    }
  },
  detectTest: (terminalId) => ipcRenderer.invoke("verify:detect", terminalId),
  runVerify: (terminalId) => ipcRenderer.invoke("verify:run", terminalId),
  cancelVerify: (terminalId) => ipcRenderer.invoke("verify:cancel", terminalId),
  getPreferences: (): Promise<AppPreferences> => ipcRenderer.invoke("settings:get"),
  updatePreferences: (update: PreferenceUpdate): Promise<AppPreferences> =>
    ipcRenderer.invoke("settings:update", update),
  setKeyboardShortcuts: (shortcuts: ShortcutMap) => ipcRenderer.invoke("settings:shortcuts", shortcuts),
  getTimeline: (terminalId) => ipcRenderer.invoke("timeline:get", terminalId),
  getTimelinePrefix: (terminalId) => ipcRenderer.invoke("timeline:prefix", terminalId),
  getTimelineProgress: (terminalId, seq) => ipcRenderer.invoke("timeline:progress", terminalId, seq),
  getPlan: (terminalId) => ipcRenderer.invoke("plan:get", terminalId),
  searchSessions: (query) => ipcRenderer.invoke("session:search", query),
  getRuns: (terminalId) => ipcRenderer.invoke("worldline:runs", terminalId),
  reportFlush: (requestId, result) => ipcRenderer.invoke("editor:flush-report", requestId, result),
  flushSave: (path, content, writerId, owner: ProjectWorkspaceRef) => ipcRenderer.invoke("file:flush-save", path, content, writerId, owner),
  getWorldlines: (projectId) => ipcRenderer.invoke("worldline:list", projectId),
  getWorldlineDetails: (comparisonId, label) => ipcRenderer.invoke("worldline:details", comparisonId, label),
  getWorldlineFile: (comparisonId, label, relPath) => ipcRenderer.invoke("worldline:file", comparisonId, label, relPath),
  getWorldlineBaseFile: (comparisonId, relPath) => ipcRenderer.invoke("worldline:base-file", comparisonId, relPath),
  forkRun: (runId) => ipcRenderer.invoke("worldline:fork-run", runId),
  cancelWorldline: (comparisonId) => ipcRenderer.invoke("worldline:cancel", comparisonId),
  discardWorldline: (comparisonId) => ipcRenderer.invoke("worldline:discard", comparisonId),
  openWorldlineTerminal: (comparisonId, label) => ipcRenderer.invoke("worldline:open-terminal", comparisonId, label),
  forkPoint: (terminalId, seq) => ipcRenderer.invoke("worldline:fork-point", terminalId, seq),
  challengeRun: (runId, profile) => ipcRenderer.invoke("worldline:challenge", runId, profile),
  challengeCandidate: (comparisonId, label, profile) => ipcRenderer.invoke("worldline:challenge-candidate", comparisonId, label, profile),
  runEvidence: (comparisonId) => ipcRenderer.invoke("worldline:evidence", comparisonId),
  promoteWorldline: (comparisonId, label, force) => ipcRenderer.invoke("worldline:promote", comparisonId, label, force),
  onWorldlineUpdate: (cb) => {
    ipcRenderer.on("worldline:update", (_e, event: WorldlineUpdatePayload) => cb(event));
  },
  onWorldlineRemoved: (cb) => {
    ipcRenderer.on("worldline:removed", (_e, event: WorldlineRemovedPayload) => cb(event));
  },
  onWorldlineRunsChanged: (cb) => {
    ipcRenderer.on("worldline:runs-changed", (_e, e: { terminalId: string }) => cb(e));
  },
  onEvidenceUpdate: (cb) => {
    ipcRenderer.on("worldline:evidence-update", (_e, event: WorldlineEvidencePayload) => cb(event));
  },
  onPromotionOpened: (cb) => {
    ipcRenderer.on("promotion:opened", (_e, e: { terminalId: string }) => cb(e));
  },
  dispatchRun: (terminalId, taskText) => ipcRenderer.invoke("dispatch:run", terminalId, taskText),
  setMineFile: (path, mine, owner: ProjectWorkspaceRef) => ipcRenderer.invoke("mine:set", path, mine, owner),
  getMineFiles: (owner: ProjectWorkspaceRef) => ipcRenderer.invoke("mine:list", owner),
  getTimelineContent: (terminalId, seq) => ipcRenderer.invoke("timeline:content", terminalId, seq),
  clearModified: (terminalId) => ipcRenderer.invoke("modified:clear", terminalId),
  reviewBaseline: (terminalId, path) => ipcRenderer.invoke("review:baseline", terminalId, path),
  reviewRevert: (terminalId, path) => ipcRenderer.invoke("review:revert", terminalId, path),

  // ---- project / files ----
  projectList: () => ipcRenderer.invoke("project:list"),
  projectOpen: () => ipcRenderer.invoke("project:open"),
  projectOpenPath: (cwd) => ipcRenderer.invoke("project:open-path", cwd),
  onProjectClosed: (cb) => {
    ipcRenderer.on("project:closed", (_e, p: { projectId: string; activationGeneration: number }) => cb(p));
  },
  projectActivate: (projectId) => ipcRenderer.invoke("project:activate", projectId),
  projectClose: (projectId) => ipcRenderer.invoke("project:close", projectId),
  openFile: (path, owner: ProjectWorkspaceRef) => ipcRenderer.invoke("file:open", path, owner),
  saveFile: (path, content, owner: ProjectWorkspaceRef) => ipcRenderer.invoke("file:save", path, content, owner),

  // ---- file explorer ----
  listDir: (projectId, absPath): Promise<{ entries: ExplorerEntry[]; error?: string; truncated?: boolean }> => ipcRenderer.invoke("explorer:list-dir", projectId, absPath),
  createEntry: (projectId, relPath, kind) => ipcRenderer.invoke("explorer:create", projectId, relPath, kind),
  renameEntry: (projectId, relPath, newName) => ipcRenderer.invoke("explorer:rename", projectId, relPath, newName),
  deleteEntry: (projectId, relPath) => ipcRenderer.invoke("explorer:delete", projectId, relPath),
  pasteEntry: (projectId, targetDirRel, srcRel, move) => ipcRenderer.invoke("explorer:paste", projectId, targetDirRel, srcRel, move),
  getUpdateState: (): Promise<AppUpdateState> => ipcRenderer.invoke("update:get"),
  checkUpdate: (): Promise<AppUpdateState> => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
};

// A foreign or stale document may still execute this preload during a
// navigation race, but it must not receive even a callable bridge surface.
// Main has already failed closed by returning no capability for that frame.
if (rendererCapability) contextBridge.exposeInMainWorld("pi", bridge);
