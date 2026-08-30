/**
 * Types shared between the Electron main process, preload and renderer.
 */

export interface ModifiedFile {
  path: string;
  relPath: string;
  status: "created" | "modified" | "deleted";
}

export interface FileChangedPayload {
  path: string;
  relPath: string;
  /** Present only when the file fits the live-sync budget. Fetch large
   *  files on demand. */
  content?: string;
  status: "created" | "modified";
  /** 1-based lines of the last watcher transition, diffed from the
   *  pre-change cache. Absent on the first touch of a file. */
  changedLines?: number[];
}

export interface ToolTargetPayload {
  path: string;
  relPath: string;
  toolName: string;
}

export interface FileDeletedPayload {
  path: string;
}

/** Packaged-app update status pushed by main. */
export type AppUpdateState =
  | { status: "disabled"; currentVersion: string }
  | { status: "checking"; currentVersion: string }
  | { status: "current"; currentVersion: string }
  | { status: "available"; currentVersion: string; version: string }
  | { status: "downloading"; currentVersion: string; version: string; percent: number }
  | { status: "ready"; currentVersion: string; version: string }
  | { status: "error"; currentVersion: string; message: string };

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
  /** Dispatch worker terminal id when this task is assigned. */
  workerId?: string;
  /** Files this worker claimed. Empty when the task is not dispatched. */
  claimed?: string[];
}

export interface PlanPayload {
  instanceId: string;
  tasks: PlanTask[];
}

/** One search hit inside a past session file. */
export interface SessionHit {
  /** The session file name (its timestamp is embedded in it). */
  sessionFile: string;
  /** 1-based line number in the session file. */
  line: number;
  /** The matching line, capped. */
  text: string;
  /** One line of context before the hit. */
  before: string;
  /** One line of context after the hit. */
  after: string;
  /** The session start time (from the file name, or mtime for core files). */
  ts: number;
  /** A project file the hit mentions, resolved against disk (when any). */
  filePath?: string;
}

/** One point on the Session Timeline strip. */
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
  /** The captured source state of this moment (forkable when set). */
  stateId?: string | null;
  /** The session entry of the tool call (the fork context anchor). */
  entryId?: string | null;
  /** The bridge tool call id (correlates the tool result). */
  toolCallId?: string | null;
  /** The model of the run that produced this moment. */
  model?: string | null;
  /** True when the dot's source state was evicted (no longer forkable). */
  evicted?: boolean;
  /** The run-start store state. Progress diffs this against stateId. */
  runStartStateId?: string | null;
}

/** Last-tool counts for the Timeline strip header (current run). */
export interface TimelinePrefix {
  terminalId: string;
  ok: number;
  error: number;
  open: number;
}

/** On-demand source diff of one forkable timeline moment. */
export interface TimelineProgress {
  ok: boolean;
  seq: number;
  files?: number;
  created?: number;
  modified?: number;
  deleted?: number;
  /** Up to eight changed paths. Never the full tree. */
  paths?: string[];
}

/** The recording state shown outside the dot strip (WORLDLINES §6). */
export type RecorderState = "indexing" | "ready" | "paused" | "degraded" | "budget";

export type VerifyState = "untested" | "running" | "pass" | "fail" | "timeout" | "cancelled";
/** Verify & Iterate: the last test run attached to a terminal. */
export interface VerifyInfo {
  state: VerifyState;
  /** Human label of the detected test command, for example "npm run test". */
  command: string | null;
  /** One-line result summary for the badge. */
  summary: string | null;
}

export interface InstanceSummary {
  id: string;
  cwd: string;
  busy: boolean;
  type: "agent" | "shell";
  /** The agent harness. Unset for shells. */
  engine?: "pi" | "core";
  shellName?: string;
  /** The workspace this terminal works in ("" when no folder is open). */
  workspaceId: string;
  /** The project tab that owns this terminal. */
  projectId?: string;
  /** True when this terminal runs a dispatched plan task. */
  dispatchWorker?: boolean;
  /** The dispatched task text (for the tab title). */
  dispatchTask?: string;
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

export const THEME_IDS = ["dark", "light", "high-contrast", "atom"] as const;
export type ThemeId = (typeof THEME_IDS)[number];

/** Fallback stack used when a chosen family is missing on the machine. */
export const DEFAULT_CODE_FONT_STACK = "'Departure Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

/** Named families the settings window offers. Empty means the default stack. */
export const CODE_FONT_FAMILIES = [
  "",
  "Departure Mono",
  "SF Mono",
  "Menlo",
  "Monaco",
  "JetBrains Mono",
  "Cascadia Code",
  "Cascadia Mono",
  "Fira Code",
  "IBM Plex Mono",
  "Source Code Pro",
  "Consolas",
  "Courier New",
] as const;

export type CodeFontFamily = (typeof CODE_FONT_FAMILIES)[number];

export function cssFontFamily(family: string): string {
  if (!family) return DEFAULT_CODE_FONT_STACK;
  return `'${family}', ${DEFAULT_CODE_FONT_STACK}`;
}

/** The last path segment, for either POSIX or Windows separators.
 *  Hand-rolled on purpose: this module also bundles into the renderer,
 *  where node:path is unavailable. Do not swap for node:path.basename. */
export function pathBasename(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

export type CanonicalizePath = (absPath: string) => string | Promise<string>;

import {
  DEFAULT_SHORTCUTS,
  type MenuCommand,
  type ShortcutMap,
} from "./commands";

export * from "./commands";

export interface AppPreferences {
  theme: ThemeId;
  editorFontSize: number;
  terminalFontSize: number;
  fontFamily: CodeFontFamily;
  wordWrap: boolean;
  minimap: boolean;
  shortcuts: ShortcutMap;
  /** Canonical project roots to reopen on launch. Main owns this field. */
  openProjects: string[];
  /** Show provider-supplied thinking in core terminals. */
  showThinking: boolean;
}

export type UserPreferencePatch = Partial<Omit<AppPreferences, "openProjects">>;
export type PreferenceUpdate = { patch: UserPreferencePatch; activateShortcuts: boolean };

export function defaultAppPreferences(): AppPreferences {
  return {
    theme: "dark",
    editorFontSize: 13,
    terminalFontSize: 13,
    fontFamily: "",
    wordWrap: false,
    minimap: true,
    shortcuts: { ...DEFAULT_SHORTCUTS },
    openProjects: [],
    showThinking: true,
  };
}

/** One recorded run (WORLDLINES §6.5) — metadata only, no blobs. */
export interface RunSummary {
  id: string;
  terminalId: string;
  workspaceId: string;
  /** The app-owned snapshot commit of the run start. */
  startStateId: string | null;
  /** The app-owned snapshot commit of the settled state. */
  settledStateId: string | null;
  /** The effective prompt text, capped. */
  promptText: string | null;
  promptEntryId: string | null;
  promptParentEntryId: string | null;
  settledEntryId: string | null;
  /** The source session file of the run. */
  sessionFile: string | null;
  /** The app-private copy of the session branch. */
  sessionBranchFile: string | null;
  /** True when Fork Run may offer this run. */
  replayable: boolean;
  /** Why the run is not replayable, when it is not. */
  reason: string | null;
  interrupted: boolean;
  steering: boolean;
  overlap: boolean;
  unownedEdits: number;
  trusted: boolean | null;
  /** The selected model and thinking level of the run. */
  model: string | null;
  thinkingLevel: string | null;
  startedAt: number;
  settledAt: number | null;
}

/** One worldline candidate (WORLDLINES §6.1) — metadata only. */
export interface WorldlineSummary {
  id: string;
  comparisonId: string;
  label: "A" | "B";
  role: "reference" | "alternative" | "challenge" | "moment";
  comparisonBaseStateId: string | null;
  promotionBaseStateId: string | null;
  headStateId: string | null;
  sourceRunId: string;
  terminalId: string | null;
  version: number;
  state:
    | "creating"
    | "ready"
    | "running"
    | "settled"
    | "verifying"
    | "promoting"
    | "conflict"
    | "cancelled"
    | "error"
    | "discarding"
    | "discarded"
    | "promoted";
  error: string | null;
  root: string;
  sessionFile: string | null;
  /** The model of the source run (Candidate B replays it). */
  model: string | null;
  /** The thinking level of the source run. */
  thinkingLevel: string | null;
  /** When the comparison pair started (ms epoch). */
  createdAt: number;
}

/** One file a candidate changed against its comparison base. */
export interface WorldlineChangedFile {
  /** Path relative to the candidate root. */
  relPath: string;
  status: "created" | "modified" | "deleted";
}

/** A declared dependency difference between base and candidate head. */
export interface DependencyChange {
  file: string;
  added: string[];
  removed: string[];
  changed: string[];
}

/** One measured evidence record for one candidate (WORLDLINES §6.8). */
export interface EvidenceRecord {
  kind: "verify" | "dependencies" | "api" | "footprint" | "benchmark" | "trajectory";
  stateId: string;
  baseStateId: string;
  status: "pass" | "fail" | "unavailable";
  result: Record<string, unknown>;
  reason: string | null;
}

/** The verdict of one fixed challenge profile. */
export interface ProfileVerdict {
  profile: "fewer-dependencies" | "preserve-api" | "simpler-implementation" | "performance-first";
  winner: "A" | "B" | "tie" | "unavailable";
  reason: string;
  eligibility: Record<string, string>;
}

/** The evidence summary of one comparison (pushed after each run). */
export interface EvidenceSummary {
  comparisonId: string;
  ts: number;
  byCandidate: Record<"A" | "B", EvidenceRecord[]>;
  profiles: ProfileVerdict[];
  error: string | null;
  /** True when a candidate ran again after the evidence (stale). */
  stale?: boolean;
}

/** Candidate details, computed on demand (WORLDLINES §6.9). */
export interface WorldlineDetails {
  id: string;
  comparisonId: string;
  label: "A" | "B";
  state: WorldlineSummary["state"];
  error: string | null;
  /** Provenance: the source run and the states it compares. */
  sourceRunId: string;
  comparisonBaseStateId: string | null;
  promotionBaseStateId: string | null;
  headStateId: string | null;
  model: string | null;
  thinkingLevel: string | null;
  createdAt: number;
  /** Source statistics of the candidate head tree. */
  sourceFiles: number;
  sourceBytes: number;
  /** Files differing from the comparison base. */
  changedFiles: WorldlineChangedFile[];
  /** Declared dependency changes (base vs head). */
  dependencies: DependencyChange[];
  /** Age of the candidate pair in ms. */
  ageMs: number;
  /** Unowned edits of the source run (collaborative provenance). */
  unownedEdits: number;
  /** Ignored/generated writes (metadata only). */
  ignoredFiles: number;
  ignoredBytes: number;
  /** Merge conflicts against the current primary source. */
  primaryConflicts: string[];
}

export interface FolderOpenedPayload {
  cwd: string;
  projectId: string;
  /** True when pi has no provider in auth.json or in the process environment. */
  needsLogin: boolean;
}

export interface ProjectListItem {
  id: string;
  cwd: string;
  active: boolean;
  terminals: number;
  needsLogin: boolean;
}

export type TerminalPasteResult =
  | { ok: true; kind: "text"; text: string }
  | { ok: true; kind: "image"; count: number; queued: boolean }
  | { ok: false; error: string };

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
  /** Push: dots whose source states were evicted (budget). */
  onTimelineEvict(cb: (p: { terminalId: string; seqs: number[] }) => void): void;
  /** Push: timeline cleared for a fresh session (e.g. /new). */
  onTimelineClear(cb: (p: { terminalId: string }) => void): void;
  /** Push: last-tool counts for the Timeline header. */
  onTimelinePrefix(cb: (p: TimelinePrefix) => void): void;
  /** Push: the recorder state of a terminal's timeline. */
  onRecorderState(cb: (p: { terminalId: string; state: RecorderState }) => void): void;
  onVerifyState(cb: (p: { terminalId: string; verify: VerifyInfo }) => void): void;
  onFolderOpened(cb: (e: FolderOpenedPayload) => void): void;
  onInstances(cb: (list: InstanceSummary[]) => void): void;
  /** Main asks the renderer to save every dirty model (run-start preflight). */
  onFlushRequest(cb: (p: { requestId: string; writerId: string }) => void): void;
  onUpdateState(cb: (state: AppUpdateState) => void): void;

  // terminals (agent = pi TUI, shell = a real shell like zsh)
  createTerminal(opts?: { type?: "agent" | "shell"; shell?: string; engine?: "pi" | "core"; fromTerminalId?: string; projectId?: string }): Promise<{ ok: boolean; id?: string; error?: string }>;
  getShells(): Promise<{ name: string; path: string }[]>;
  getPiStatus(): Promise<{ available: boolean; bin: string; message?: string }>;
  closeTerminal(id: string): Promise<void>;
  writeTerminal(id: string, data: string): Promise<void>;
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
  getInstances(): Promise<InstanceSummary[]>;
  abortTerminal(id: string): Promise<void>; // sends Ctrl+C into the pty
  writeClipboard(text: string): Promise<{ ok: boolean; error?: string }>;
  readClipboard(): Promise<string>;
  editClipboard(command: "copy" | "paste"): Promise<void>;
  /** Paste into a terminal. Core tabs attach clipboard images as files. */
  pasteTerminal(id: string): Promise<TerminalPasteResult>;
  /** Drop Finder files into a terminal. Core tabs attach images; others paste quoted paths. */
  dropTerminalFiles(id: string, files: readonly File[]): Promise<TerminalPasteResult>;

  // Verify & Iterate
  runVerify(terminalId: string): Promise<{ ok: boolean; error?: string }>;
  cancelVerify(terminalId: string): Promise<{ ok: boolean; error?: string }>;

  // Settings
  getPreferences(): Promise<AppPreferences>;
  updatePreferences(update: PreferenceUpdate): Promise<AppPreferences>;
  setKeyboardShortcuts(shortcuts: ShortcutMap): Promise<ShortcutMap>;

  // Session Timeline
  getTimeline(terminalId: string): Promise<TimelineEvent[]>;
  /** Last-tool counts for the Timeline header (current run). */
  getTimelinePrefix(terminalId: string): Promise<TimelinePrefix>;
  /** Source diff of one forkable moment versus its run start. On demand. */
  getTimelineProgress(terminalId: string, seq: number): Promise<TimelineProgress>;
  /** The current run's plan tasks (Plan Board). */
  getPlan(terminalId: string): Promise<PlanTask[]>;
  /** Full-text search over the project's past sessions. */
  searchSessions(query: string): Promise<SessionHit[]>;

  // Worldlines: run records
  /** The recorded runs of a terminal (or every terminal). */
  getRuns(terminalId?: string): Promise<RunSummary[]>;
  /** Detect the test command of a terminal (its own cwd when given). */
  detectTest(terminalId?: string): Promise<{ command: string; label: string } | null>;
  /** Candidate details for one card, computed on demand. */
  getWorldlineDetails(comparisonId: string, label: "A" | "B"): Promise<{ ok: boolean; details?: WorldlineDetails; error?: string }>;
  /** Read one candidate file from its isolated tree. */
  getWorldlineFile(comparisonId: string, label: "A" | "B", relPath: string): Promise<{ ok: boolean; content?: string; error?: string }>;
  /** Read one file from the comparison base (shared by A and B). */
  getWorldlineBaseFile(comparisonId: string, relPath: string): Promise<{ ok: boolean; content?: string; error?: string }>;
  /** Materialize a run's start or settled source state for inspection. */
  exportState(runId: string, kind: "start" | "settled"): Promise<{ ok: boolean; dir?: string; error?: string }>;
  /** The renderer's answer to a flush request. */
  reportFlush(requestId: string, result: { ok: boolean; failed: string[] }): Promise<void>;
  /** Save a dirty model on behalf of the write-lease holder (the flush). */
  flushSave(path: string, content: string, writerId: string): Promise<{ ok: boolean; error?: string }>;

  // Worldlines: candidates
  /** The live worldline candidates. */
  getWorldlines(): Promise<WorldlineSummary[]>;
  /** Fork a completed run into Candidate A and Candidate B. */
  forkRun(runId: string): Promise<{ ok: boolean; comparisonId?: string; error?: string }>;
  /** Cancel pair creation (all-or-nothing cleanup). */
  cancelWorldline(comparisonId: string): Promise<{ ok: boolean; error?: string }>;
  /** Discard a live comparison. */
  discardWorldline(comparisonId: string): Promise<{ ok: boolean; error?: string }>;
  /** Reopen a candidate's Pi terminal. */
  openWorldlineTerminal(comparisonId: string, label: "A" | "B"): Promise<{ ok: boolean; error?: string; terminalId?: string }>;
  /** Fork one candidate from a timeline moment (WORLDLINES §6). */
  forkPoint(terminalId: string, seq: number): Promise<{ ok: boolean; comparisonId?: string; error?: string }>;
  /** Launch the challenger of a completed run (WORLDLINES §6.9). */
  challengeRun(runId: string): Promise<{ ok: boolean; comparisonId?: string; error?: string }>;
  /** Challenge an existing candidate (snapshot as reference + challenger). */
  challengeCandidate(comparisonId: string, label: "A" | "B"): Promise<{ ok: boolean; comparisonId?: string; error?: string }>;
  /** Compute evidence for both candidates of a comparison. */
  runEvidence(comparisonId: string): Promise<{ ok: boolean; error?: string }>;
  /** Push: the evidence summary of a comparison changed. */
  onEvidenceUpdate(cb: (e: EvidenceSummary) => void): void;
  /** Promote a candidate into the primary project (WORLDLINES §6.10). */
  promoteWorldline(comparisonId: string, label: "A" | "B", force?: boolean): Promise<{ ok: boolean; error?: string; terminalId?: string; confirm?: string }>;
  /** Push: one worldline changed. */
  onWorldlineUpdate(cb: (summary: WorldlineSummary) => void): void;
  /** Push: a comparison was removed. */
  onWorldlineRemoved(cb: (e: { comparisonId: string }) => void): void;
  /** Push: a terminal's run records changed (Fork Run refresh). */
  onWorldlineRunsChanged(cb: (e: { terminalId: string }) => void): void;
  /** Push: a promotion opened its primary terminal. */
  onPromotionOpened(cb: (e: { terminalId: string }) => void): void;

  // Dispatch (parallel agents)
  /** Dispatch plan tasks to parallel workers. Pass task text to send one row. */
  dispatchRun(terminalId: string, taskText?: string): Promise<{ ok: boolean; error?: string; dispatched?: number }>;

  // Mine (file ownership)
  /** Mark a file as the user's own (the agent is told not to modify it). */
  setMineFile(path: string, mine: boolean): Promise<void>;
  /** The absolute paths of the files marked as the user's own. */
  getMineFiles(): Promise<string[]>;
  /** Fetch a snapshot's content on demand (only when a dot is clicked). */
  getTimelineContent(
    terminalId: string,
    seq: number,
  ): Promise<{ ok: boolean; seq: number; path?: string; relPath?: string; content?: string; ts?: number; toolName?: string }>;
  /** Clear the terminal's modified-file list. Main owns the list; the
   *  next change re-adds only files that change after the clear. */
  clearModified(terminalId: string): Promise<{ ok: boolean; error?: string }>;
  reviewBaseline(terminalId: string, path: string): Promise<{ status: "created" | "modified"; baseline: string | null | undefined }>;
  reviewRevert(terminalId: string, path: string): Promise<{ ok: boolean; error?: string }>;

  // project / files
  /** One open project tab. */
  projectList(): Promise<ProjectListItem[]>;
  projectOpen(): Promise<{ cwd: string } | { cancelled: true }>;
  /** Open a project by path (the test suites cannot drive the dialog). */
  projectOpenPath(cwd: string): Promise<{ cwd: string } | { cancelled: true }>;
  projectActivate(projectId: string): Promise<{ ok: boolean }>;
  projectClose(projectId: string): Promise<{ ok: boolean; error?: string; cancelled?: boolean }>;
  onProjectClosed(cb: (e: { projectId: string }) => void): void;
  openFile(path: string): Promise<{ ok: true; path: string; content: string; changedLines?: number[] } | { ok: false; path: string; error: string }>;
  saveFile(path: string, content: string): Promise<{ ok: boolean; error?: string }>;

  // file explorer
  listDir(absPath: string): Promise<{ entries: ExplorerEntry[]; error?: string; truncated?: boolean }>;
  createEntry(relPath: string, kind: "file" | "dir"): Promise<{ ok: boolean; error?: string }>;
  renameEntry(relPath: string, newName: string): Promise<{ ok: boolean; error?: string }>;
  deleteEntry(relPath: string): Promise<{ ok: boolean; error?: string }>;
  /** Explorer clipboard paste: copy (or move, for a cut entry) srcRel under
   *  the target directory. Collisions get a " copy" / " copy N" suffix. */
  pasteEntry(targetDirRel: string, srcRel: string, move: boolean): Promise<{ ok: boolean; error?: string; name?: string }>;
  getUpdateState(): Promise<AppUpdateState>;
  checkUpdate(): Promise<AppUpdateState>;
  installUpdate(): Promise<{ ok: boolean; error?: string }>;
}