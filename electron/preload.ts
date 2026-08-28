/**
 * Preload script: exposes the typed `window.pi` bridge to the renderer.
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";
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
  EvidenceSummary,
  TimelineEvent,
  TimelinePrefix,
  PlanPayload,
  WorldlineSummary,
  AppPreferences,
  PreferenceUpdate,
  ShortcutMap,
  FolderOpenedPayload,
  AppUpdateState,
} from "../shared/types.js";

const bridge: PiBridge = {
  // ---- push events ----
  onPtyData: (cb) => {
    ipcRenderer.on("pty:data", (_e, p: { id: string; data: string }) => cb(p));
  },
  onPtyExit: (cb) => {
    ipcRenderer.on("pty:exit", (_e, p: { id: string; code: number }) => cb(p));
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
    ipcRenderer.on("editor:flush-request", (_e, p: { requestId: string; writerId: string }) => cb(p));
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
  getPiStatus: () => ipcRenderer.invoke("app:pi-status"),
  closeTerminal: (id) => ipcRenderer.invoke("terminals:close", id),
  writeTerminal: (id, data) => ipcRenderer.invoke("terminals:write", id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.invoke("terminals:resize", id, cols, rows),
  getInstances: (): Promise<InstanceSummary[]> => ipcRenderer.invoke("terminals:list"),
  abortTerminal: (id) => ipcRenderer.invoke("terminals:abort", id),
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
  exportState: (runId, kind) => ipcRenderer.invoke("worldline:export-state", runId, kind),
  reportFlush: (requestId, result) => ipcRenderer.invoke("editor:flush-report", requestId, result),
  flushSave: (path, content, writerId) => ipcRenderer.invoke("file:flush-save", path, content, writerId),
  getWorldlines: () => ipcRenderer.invoke("worldline:list"),
  getWorldlineDetails: (comparisonId, label) => ipcRenderer.invoke("worldline:details", comparisonId, label),
  getWorldlineFile: (comparisonId, label, relPath) => ipcRenderer.invoke("worldline:file", comparisonId, label, relPath),
  getWorldlineBaseFile: (comparisonId, relPath) => ipcRenderer.invoke("worldline:base-file", comparisonId, relPath),
  forkRun: (runId) => ipcRenderer.invoke("worldline:fork-run", runId),
  cancelWorldline: (comparisonId) => ipcRenderer.invoke("worldline:cancel", comparisonId),
  discardWorldline: (comparisonId) => ipcRenderer.invoke("worldline:discard", comparisonId),
  openWorldlineTerminal: (comparisonId, label) => ipcRenderer.invoke("worldline:open-terminal", comparisonId, label),
  forkPoint: (terminalId, seq) => ipcRenderer.invoke("worldline:fork-point", terminalId, seq),
  challengeRun: (runId) => ipcRenderer.invoke("worldline:challenge", runId),
  challengeCandidate: (comparisonId, label) => ipcRenderer.invoke("worldline:challenge-candidate", comparisonId, label),
  runEvidence: (comparisonId) => ipcRenderer.invoke("worldline:evidence", comparisonId),
  promoteWorldline: (comparisonId, label, force) => ipcRenderer.invoke("worldline:promote", comparisonId, label, force),
  onWorldlineUpdate: (cb) => {
    ipcRenderer.on("worldline:update", (_e, summary: WorldlineSummary) => cb(summary));
  },
  onWorldlineRemoved: (cb) => {
    ipcRenderer.on("worldline:removed", (_e, e: { comparisonId: string }) => cb(e));
  },
  onWorldlineRunsChanged: (cb) => {
    ipcRenderer.on("worldline:runs-changed", (_e, e: { terminalId: string }) => cb(e));
  },
  onEvidenceUpdate: (cb) => {
    ipcRenderer.on("worldline:evidence-update", (_e, e: EvidenceSummary) => cb(e));
  },
  onPromotionOpened: (cb) => {
    ipcRenderer.on("promotion:opened", (_e, e: { terminalId: string }) => cb(e));
  },
  dispatchRun: (terminalId, taskText) => ipcRenderer.invoke("dispatch:run", terminalId, taskText),
  setMineFile: (path, mine) => ipcRenderer.invoke("mine:set", path, mine),
  getMineFiles: () => ipcRenderer.invoke("mine:list"),
  getTimelineContent: (terminalId, seq) => ipcRenderer.invoke("timeline:content", terminalId, seq),
  clearModified: (terminalId) => ipcRenderer.invoke("modified:clear", terminalId),
  reviewBaseline: (terminalId, path) => ipcRenderer.invoke("review:baseline", terminalId, path),
  reviewRevert: (terminalId, path) => ipcRenderer.invoke("review:revert", terminalId, path),

  // ---- project / files ----
  projectList: () => ipcRenderer.invoke("project:list"),
  projectOpen: () => ipcRenderer.invoke("project:open"),
  projectOpenPath: (cwd) => ipcRenderer.invoke("project:open-path", cwd),
  onProjectClosed: (cb) => {
    ipcRenderer.on("project:closed", (_e, p: { projectId: string }) => cb(p));
  },
  projectActivate: (projectId) => ipcRenderer.invoke("project:activate", projectId),
  projectClose: (projectId) => ipcRenderer.invoke("project:close", projectId),
  openFile: (path) => ipcRenderer.invoke("file:open", path),
  saveFile: (path, content) => ipcRenderer.invoke("file:save", path, content),

  // ---- file explorer ----
  listDir: (absPath): Promise<{ entries: ExplorerEntry[]; error?: string; truncated?: boolean }> => ipcRenderer.invoke("explorer:list-dir", absPath),
  createEntry: (relPath, kind) => ipcRenderer.invoke("explorer:create", relPath, kind),
  renameEntry: (relPath, newName) => ipcRenderer.invoke("explorer:rename", relPath, newName),
  deleteEntry: (relPath) => ipcRenderer.invoke("explorer:delete", relPath),
  pasteEntry: (targetDirRel, srcRel, move) => ipcRenderer.invoke("explorer:paste", targetDirRel, srcRel, move),
  getUpdateState: (): Promise<AppUpdateState> => ipcRenderer.invoke("update:get"),
  checkUpdate: (): Promise<AppUpdateState> => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
};

contextBridge.exposeInMainWorld("pi", bridge);