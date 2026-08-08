/**
 * Types shared between the Electron main process, preload and renderer.
 */

export interface ModifiedFile {
  path: string;
  relPath: string;
  status: "created" | "modified";
}

export type TerminalType = "agent" | "shell";

export interface InstanceSummary {
  id: string;
  cwd: string;
  busy: boolean;
  type: TerminalType;
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
  onFolderOpened(cb: (e: { cwd: string }) => void): void;
  onInstances(cb: (list: InstanceSummary[]) => void): void;

  // terminals (agent = pi TUI, shell = a real shell like zsh)
  createTerminal(opts?: { type?: TerminalType; shell?: string }): Promise<{ id?: string; error?: string }>;
  getShells(): Promise<{ name: string; path: string }[]>;
  getPiStatus(): Promise<{ available: boolean; bin: string; message?: string }>;
  closeTerminal(id: string): Promise<void>;
  writeTerminal(id: string, data: string): Promise<void>;
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
  getInstances(): Promise<InstanceSummary[]>;
  abortTerminal(id: string): Promise<void>; // sends Ctrl+C into the pty

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