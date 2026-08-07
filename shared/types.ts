/**
 * Types shared between the Electron main process, preload and renderer.
 */

export interface ModifiedFile {
  path: string;
  relPath: string;
  status: "created" | "modified";
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

export interface PiState {
  isStreaming: boolean;
  model: ModelInfo | null;
  thinkingLevel: string | null;
  cwd: string | null;
  sessionId: string | null;
  models: ModelInfo[];
  levels: string[];
}

export interface FileChangedPayload {
  path: string;
  relPath: string;
  content: string;
  status: "created" | "modified";
}

export interface ToolTargetPayload {
  path: string;
  relPath: string;
  toolName: string;
}

export interface SettledPayload {
  modifiedFiles: ModifiedFile[];
  durationMs: number;
}

export interface PiBridge {
  // push events (main → renderer)
  onEvent(cb: (event: Record<string, unknown>) => void): void;
  onFileChanged(cb: (p: FileChangedPayload) => void): void;
  onToolTarget(cb: (p: ToolTargetPayload) => void): void;
  onSettled(cb: (p: SettledPayload) => void): void;
  onState(cb: (s: PiState) => void): void;
  onError(cb: (e: { message: string }) => void): void;
  onFolderOpened(cb: (e: { cwd: string }) => void): void;
  onStderr(cb: (e: { line: string }) => void): void;

  // commands (renderer → main)
  prompt(text: string, opts?: { streamingBehavior?: "steer" | "followUp" }): Promise<{ ok: boolean; error?: string }>;
  abort(): Promise<unknown>;
  newSession(): Promise<unknown>;
  setModel(provider: string, modelId: string): Promise<unknown>;
  setThinking(level: string): Promise<unknown>;
  getState(): Promise<PiState>;
  openFolder(): Promise<{ cwd: string } | { cancelled: true }>;
  openFile(path: string): Promise<{ path: string; content: string } | { path: string; error: string }>;
  saveFile(path: string, content: string): Promise<{ ok: boolean; error?: string }>;
  getModifiedFiles(): Promise<ModifiedFile[]>;
  clearModified(): Promise<void>;
  respondUi(id: string, payload: Record<string, unknown>): void;
  getModels(): Promise<ModelInfo[]>;
}

export interface ToolCallInfo {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

/** Extension UI request (dialog/notification) from the agent. */
export interface ExtensionUiRequest {
  type: "extension_ui_request";
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  notifyType?: string;
}