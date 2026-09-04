/**
 * Preload script: exposes the typed `window.pi` bridge to the renderer.
 */
import { contextBridge, ipcRenderer as electronIpcRenderer, webUtils } from "electron";
import type {
  PiBridge,
  TerminalPasteResult,
  InstanceSummary,
  ExplorerEntry,
  AppPreferences,
  PreferenceUpdate,
  ShortcutMap,
  AppUpdateState,
  ProjectWorkspaceRef,
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

function bindPushEvent<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, p: T) => cb(p);
  electronIpcRenderer.on(channel, handler);
  return () => {
    electronIpcRenderer.removeListener(channel, handler);
  };
}

const bridge: PiBridge = {
  // ---- push events ----
  onPtyData: (cb) => bindPushEvent("pty:data", cb),
  onPtyExit: (cb) => bindPushEvent("pty:exit", cb),
  onMenuCommand: (cb) => bindPushEvent("menu:command", cb),
  onToolTarget: (cb) => bindPushEvent("tool:target", cb),
  onFileChanged: (cb) => bindPushEvent("file:changed", cb),
  onFileDeleted: (cb) => bindPushEvent("file:deleted", cb),
  onModifiedList: (cb) => bindPushEvent("modified:list", cb),
  onBusy: (cb) => bindPushEvent("busy", cb),
  onPlanUpdate: (cb) => bindPushEvent("plan:update", cb),
  onVerifyState: (cb) => bindPushEvent("verify:state", cb),
  onTimelineEvent: (cb) => bindPushEvent("timeline:event", cb),
  onTimelineEvict: (cb) => bindPushEvent("timeline:evict", cb),
  onTimelineClear: (cb) => bindPushEvent("timeline:clear", cb),
  onTimelinePrefix: (cb) => bindPushEvent("timeline:prefix", cb),
  onRecorderState: (cb) => bindPushEvent("timeline:recorder-state", cb),
  onFolderOpened: (cb) => bindPushEvent("folder:opened", cb),
  onFlushRequest: (cb) => bindPushEvent("editor:flush-request", cb),
  onUpdateState: (cb) => bindPushEvent("update:state", cb),
  onInstances: (cb) => bindPushEvent("instances:list", cb),

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
  onWorldlineUpdate: (cb) => bindPushEvent("worldline:update", cb),
  onWorldlineRemoved: (cb) => bindPushEvent("worldline:removed", cb),
  onWorldlineRunsChanged: (cb) => bindPushEvent("worldline:runs-changed", cb),
  onEvidenceUpdate: (cb) => bindPushEvent("worldline:evidence-update", cb),
  onPromotionOpened: (cb) => bindPushEvent("promotion:opened", cb),
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
  onProjectClosed: (cb) => bindPushEvent("project:closed", cb),
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
