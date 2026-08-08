/**
 * Preload script: exposes the typed `window.pi` bridge to the renderer.
 */
import { contextBridge, ipcRenderer } from "electron";
import type {
  MenuCommand,
  PiBridge,
  FileChangedPayload,
  ToolTargetPayload,
  FileDeletedPayload,
  ModifiedListPayload,
  BusyPayload,
  InstanceSummary,
  ExplorerEntry,
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
  onFolderOpened: (cb) => {
    ipcRenderer.on("folder:opened", (_e, e: { cwd: string }) => cb(e));
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

  // ---- project / files ----
  openFolder: () => ipcRenderer.invoke("folder:open"),
  openFile: (path) => ipcRenderer.invoke("file:open", path),
  saveFile: (path, content) => ipcRenderer.invoke("file:save", path, content),

  // ---- file explorer ----
  listDir: (absPath): Promise<{ entries: ExplorerEntry[]; error?: string }> => ipcRenderer.invoke("explorer:list-dir", absPath),
  createEntry: (relPath, kind) => ipcRenderer.invoke("explorer:create", relPath, kind),
  renameEntry: (relPath, newName) => ipcRenderer.invoke("explorer:rename", relPath, newName),
  deleteEntry: (relPath) => ipcRenderer.invoke("explorer:delete", relPath),
};

contextBridge.exposeInMainWorld("pi", bridge);