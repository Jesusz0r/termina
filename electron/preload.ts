/**
 * Preload script: exposes the typed `window.pi` bridge to the renderer.
 * Runs in an isolated context; only explicit channels are exposed.
 */
import { contextBridge, ipcRenderer } from "electron";
import type {
  PiBridge,
  PiState,
  ModifiedFile,
  FileChangedPayload,
  ToolTargetPayload,
  SettledPayload,
  FileDeletedPayload,
  ModifiedListPayload,
  InstanceSummary,
  ExplorerEntry,
  MenuCommand,
} from "../shared/types.js";

const bridge: PiBridge = {
  // ---- push events ----
  onEvent: (cb) => {
    ipcRenderer.on("pi:event", (_e, event: { instanceId: string } & Record<string, unknown>) => cb(event));
  },
  onMenuCommand: (cb) => {
    ipcRenderer.on("menu:command", (_e, cmd: { command: MenuCommand }) => cb(cmd));
  },
  onFileChanged: (cb) => {
    ipcRenderer.on("file:changed", (_e, p: FileChangedPayload) => cb(p));
  },
  onToolTarget: (cb) => {
    ipcRenderer.on("tool:target", (_e, p: ToolTargetPayload) => cb(p));
  },
  onSettled: (cb) => {
    ipcRenderer.on("agent:settled", (_e, p: SettledPayload) => cb(p));
  },
  onFileDeleted: (cb) => {
    ipcRenderer.on("file:deleted", (_e, p: FileDeletedPayload) => cb(p));
  },
  onModifiedList: (cb) => {
    ipcRenderer.on("modified:list", (_e, p: ModifiedListPayload) => cb(p));
  },
  onState: (cb) => {
    ipcRenderer.on("pi:state", (_e, s: PiState) => cb(s));
  },
  onError: (cb) => {
    ipcRenderer.on("pi:error", (_e, e: { instanceId: string; message: string }) => cb(e));
  },
  onFolderOpened: (cb) => {
    ipcRenderer.on("folder:opened", (_e, e: { cwd: string }) => cb(e));
  },
  onStderr: (cb) => {
    ipcRenderer.on("pi:stderr", (_e, e: { instanceId: string; line: string }) => cb(e));
  },
  onInstances: (cb) => {
    ipcRenderer.on("instances:list", (_e, list: InstanceSummary[]) => cb(list));
  },

  // ---- instance management ----
  createInstance: () => ipcRenderer.invoke("instances:create"),
  closeInstance: (id) => ipcRenderer.invoke("instances:close", id),
  getInstances: (): Promise<InstanceSummary[]> => ipcRenderer.invoke("instances:list"),

  // ---- commands (instance-scoped) ----
  prompt: (instanceId, text, opts) => ipcRenderer.invoke("pi:prompt", instanceId, text, opts),
  abort: (instanceId) => ipcRenderer.invoke("pi:abort", instanceId),
  newSession: (instanceId) => ipcRenderer.invoke("pi:new-session", instanceId),
  setModel: (instanceId, provider, modelId) => ipcRenderer.invoke("pi:set-model", instanceId, provider, modelId),
  setThinking: (instanceId, level) => ipcRenderer.invoke("pi:set-thinking", instanceId, level),
  getState: (instanceId): Promise<PiState> => ipcRenderer.invoke("pi:get-state", instanceId),
  getCommands: (instanceId) => ipcRenderer.invoke("pi:get-commands", instanceId),
  getModifiedFiles: (instanceId): Promise<ModifiedFile[]> => ipcRenderer.invoke("modified:get", instanceId),
  clearModified: (instanceId) => ipcRenderer.invoke("modified:clear", instanceId),

  // ---- shared (project-level) ----
  openFolder: () => ipcRenderer.invoke("folder:open"),
  openFile: (path) => ipcRenderer.invoke("file:open", path),
  saveFile: (path, content) => ipcRenderer.invoke("file:save", path, content),
  respondUi: (instanceId, id, payload) => {
    void ipcRenderer.invoke("pi:ui-response", instanceId, id, payload);
  },

  // ---- file explorer ----
  listDir: (absPath): Promise<{ entries: ExplorerEntry[]; error?: string }> => ipcRenderer.invoke("explorer:list-dir", absPath),
  createEntry: (relPath, kind) => ipcRenderer.invoke("explorer:create", relPath, kind),
  renameEntry: (relPath, newName) => ipcRenderer.invoke("explorer:rename", relPath, newName),
  deleteEntry: (relPath) => ipcRenderer.invoke("explorer:delete", relPath),
};

contextBridge.exposeInMainWorld("pi", bridge);