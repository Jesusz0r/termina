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
  instanceId: string;
  isStreaming: boolean;
  model: ModelInfo | null;
  thinkingLevel: string | null;
  cwd: string | null;
  sessionId: string | null;
  models: ModelInfo[];
  levels: string[];
  /** True once a real project folder is opened (not the home-dir placeholder). */
  hasProject: boolean;
}

export interface InstanceSummary {
  id: string;
  cwd: string;
  model: string | null;
  isStreaming: boolean;
  modifiedCount: number;
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
  instanceId: string;
  /** Files modified in this run (for the terminal summary). */
  runFiles: ModifiedFile[];
  /** All files modified in this session (for the panel). */
  allFiles: ModifiedFile[];
  durationMs: number;
}

export interface FileDeletedPayload {
  path: string;
}

export interface ModifiedListPayload {
  instanceId: string;
  files: ModifiedFile[];
}

export interface PiBridge {
  // push events (main → renderer)
  onEvent(cb: (event: { instanceId: string } & Record<string, unknown>) => void): void;
  onFileChanged(cb: (p: FileChangedPayload) => void): void;
  onToolTarget(cb: (p: ToolTargetPayload) => void): void;
  onSettled(cb: (p: SettledPayload) => void): void;
  onFileDeleted(cb: (p: FileDeletedPayload) => void): void;
  onModifiedList(cb: (p: ModifiedListPayload) => void): void;
  onState(cb: (s: PiState) => void): void;
  onError(cb: (e: { instanceId: string; message: string }) => void): void;
  onFolderOpened(cb: (e: { cwd: string }) => void): void;
  onStderr(cb: (e: { instanceId: string; line: string }) => void): void;
  onInstances(cb: (list: InstanceSummary[]) => void): void;

  // instance management
  createInstance(): Promise<{ id: string }>;
  closeInstance(id: string): Promise<void>;
  getInstances(): Promise<InstanceSummary[]>;

  // commands (renderer → main) — all scoped to an instance
  prompt(instanceId: string, text: string, opts?: { streamingBehavior?: "steer" | "followUp" }): Promise<{ ok: boolean; error?: string }>;
  abort(instanceId: string): Promise<unknown>;
  newSession(instanceId: string): Promise<unknown>;
  setModel(instanceId: string, provider: string, modelId: string): Promise<unknown>;
  setThinking(instanceId: string, level: string): Promise<unknown>;
  getState(instanceId: string): Promise<PiState>;
  getModifiedFiles(instanceId: string): Promise<ModifiedFile[]>;
  clearModified(instanceId: string): Promise<void>;

  // shared (project-level)
  openFolder(): Promise<{ cwd: string } | { cancelled: true }>;
  openFile(path: string): Promise<{ path: string; content: string } | { path: string; error: string }>;
  saveFile(path: string, content: string): Promise<{ ok: boolean; error?: string }>;
  respondUi(instanceId: string, id: string, payload: Record<string, unknown>): void;
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