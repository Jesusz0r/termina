/**
 * Types shared between the Electron main process, preload and renderer.
 */

export interface ModifiedFile {
  path: string;
  relPath: string;
  status: "created" | "modified" | "deleted";
}

export interface InstanceSummary {
  id: string;
  cwd: string;
  busy: boolean;
  type: "agent" | "shell";
  shellName?: string;
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

export interface FileDeletedPayload {
  path: string;
}

export interface ModifiedListPayload {
  instanceId: string;
  files: ModifiedFile[];
}

export interface BusyPayload {
  instanceId: string;
  busy: boolean;
}

/** One task on the Plan Board (parsed from the agent's plan message). */
export interface PlanTask {
  /** The task line text. */
  text: string;
  /** File paths mentioned in the task (relative to the project). */
  paths: string[];
  state: "pending" | "active" | "done";
}

export interface PlanPayload {
  instanceId: string;
  tasks: PlanTask[];
}

/** One point on the Session Timeline (the "time machine" strip). */
export interface TimelineEvent {
  seq: number;
  t: "agent_start" | "agent_settled" | "tool" | "change";
  ts: number;
  toolName?: string;
  /** Canonical absolute path (tool/change events). */
  path?: string;
  relPath?: string;
  /** File content snapshot right after this event (capped; may be absent). */
  content?: string;
  status?: "created" | "modified";
}

export type VerifyState = "untested" | "running" | "pass" | "fail" | "timeout";

/** Verify & Iterate: the last test run attached to a terminal. */
export interface VerifyInfo {
  state: VerifyState;
  /** Human label of the detected test command, e.g. "npm run test". */
  command: string | null;
  /** One-line result summary for the badge. */
  summary: string | null;
  /** Id of the worker shell terminal that ran the tests (when running/done). */
  workerId?: string;
}

export interface InstanceSummary {
  id: string;
  cwd: string;
  busy: boolean;
  type: "agent" | "shell";
  shellName?: string;
  /** True when this terminal is a verify worker running tests. */
  verifyWorker?: boolean;
  /** Verify state for agent terminals; null for plain shells. */
  verify?: VerifyInfo | null;
}

export interface ExplorerEntry {
  name: string;
  /** Absolute path. */
  path: string;
  /** Path relative to the project root. */
  relPath: string;
  type: "file" | "dir";
}

export type MenuCommand =
  | "new-file"
  | "new-folder"
  | "rename"
  | "delete"
  | "refresh"
  | "layout-terminal-left"
  | "layout-terminal-right"
  | "layout-terminal-top"
  | "layout-terminal-bottom"
  | "layout-terminal-fullscreen"
  | "toggle-explorer"
  | "toggle-modified"
  | "toggle-editor";

export interface PiBridge {
  // push events (main → renderer)
  onPtyData(cb: (e: { id: string; data: string }) => void): void;
  onPtyExit(cb: (e: { id: string; code: number }) => void): void;
  onMenuCommand(cb: (cmd: { command: MenuCommand }) => void): void;
  onToolTarget(cb: (p: ToolTargetPayload) => void): void;
  onFileChanged(cb: (p: FileChangedPayload) => void): void;
  onFileDeleted(cb: (p: FileDeletedPayload) => void): void;
  onModifiedList(cb: (p: ModifiedListPayload) => void): void;
  onBusy(cb: (p: BusyPayload) => void): void;
  onPlanUpdate(cb: (p: PlanPayload) => void): void;
  onTimelineEvent(cb: (p: { terminalId: string; event: TimelineEvent }) => void): void;
  onVerifyState(cb: (p: { terminalId: string; verify: VerifyInfo }) => void): void;
  onFolderOpened(cb: (e: { cwd: string }) => void): void;
  onInstances(cb: (list: InstanceSummary[]) => void): void;

  // terminals (agent = pi TUI, shell = a real shell like zsh)
  createTerminal(opts?: { type?: "agent" | "shell"; shell?: string }): Promise<{ id?: string; error?: string }>;
  getShells(): Promise<{ name: string; path: string }[]>;
  getPiStatus(): Promise<{ available: boolean; bin: string; message?: string }>;
  closeTerminal(id: string): Promise<void>;
  writeTerminal(id: string, data: string): Promise<void>;
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
  getInstances(): Promise<InstanceSummary[]>;
  abortTerminal(id: string): Promise<void>; // sends Ctrl+C into the pty

  // Verify & Iterate
  detectTest(): Promise<{ command: string; label: string } | null>;
  runVerify(terminalId: string): Promise<{ ok: boolean; error?: string }>;

  // Session Timeline
  getTimeline(terminalId: string): Promise<TimelineEvent[]>;
  /** The current run's plan tasks (Plan Board). */
  getPlan(terminalId: string): Promise<PlanTask[]>;
  /** Fetch a snapshot's content on demand (only when a dot is clicked). */
  getTimelineContent(
    terminalId: string,
    seq: number,
  ): Promise<{ ok: boolean; seq: number; path?: string; relPath?: string; content?: string; ts?: number; toolName?: string }>;
  reviewBaseline(terminalId: string, path: string): Promise<{ status: "created" | "modified"; baseline: string | null }>;
  reviewRevert(terminalId: string, path: string): Promise<{ ok: boolean; error?: string }>;

  // project / files
  openFolder(): Promise<{ cwd: string } | { cancelled: true }>;
  openFile(path: string): Promise<{ path: string; content: string } | { path: string; error: string }>;
  saveFile(path: string, content: string): Promise<{ ok: boolean; error?: string }>;

  // file explorer
  listDir(absPath: string): Promise<{ entries: ExplorerEntry[]; error?: string }>;
  createEntry(relPath: string, kind: "file" | "dir"): Promise<{ ok: boolean; error?: string }>;
  renameEntry(relPath: string, newName: string): Promise<{ ok: boolean; error?: string }>;
  deleteEntry(relPath: string): Promise<{ ok: boolean; error?: string }>;
}