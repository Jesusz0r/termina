/**
 * Preload script: exposes the typed `window.pi` bridge to the renderer.
 * Runs in an isolated context; only explicit channels are exposed.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { PiBridge, PiState, ModifiedFile, FileChangedPayload, ToolTargetPayload, SettledPayload, ModelInfo } from "../shared/types.js";

const bridge: PiBridge = {
  // ---- push events ----
  onEvent: (cb) => {
    ipcRenderer.on("pi:event", (_e, event: Record<string, unknown>) => cb(event));
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
  onState: (cb) => {
    ipcRenderer.on("pi:state", (_e, s: PiState) => cb(s));
  },
  onError: (cb) => {
    ipcRenderer.on("pi:error", (_e, e: { message: string }) => cb(e));
  },
  onFolderOpened: (cb) => {
    ipcRenderer.on("folder:opened", (_e, e: { cwd: string }) => cb(e));
  },
  onStderr: (cb) => {
    ipcRenderer.on("pi:stderr", (_e, e: { line: string }) => cb(e));
  },

  // ---- commands ----
  prompt: (text, opts) => ipcRenderer.invoke("pi:prompt", text, opts),
  abort: () => ipcRenderer.invoke("pi:abort"),
  newSession: () => ipcRenderer.invoke("pi:new-session"),
  setModel: (provider, modelId) => ipcRenderer.invoke("pi:set-model", provider, modelId),
  setThinking: (level) => ipcRenderer.invoke("pi:set-thinking", level),
  getState: () => ipcRenderer.invoke("pi:get-state"),
  openFolder: () => ipcRenderer.invoke("folder:open"),
  openFile: (path) => ipcRenderer.invoke("file:open", path),
  saveFile: (path, content) => ipcRenderer.invoke("file:save", path, content),
  getModifiedFiles: (): Promise<ModifiedFile[]> => ipcRenderer.invoke("modified:get"),
  clearModified: () => ipcRenderer.invoke("modified:clear"),
  respondUi: (id, payload) => {
    void ipcRenderer.invoke("pi:ui-response", id, payload);
  },
  getModels: (): Promise<ModelInfo[]> => ipcRenderer.invoke("pi:get-state").then((s: PiState) => s.models),
};

contextBridge.exposeInMainWorld("pi", bridge);