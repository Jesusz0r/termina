/**
 * One terminal tab: the live PTY plus the agent session state main tracks
 * for it (timeline, baselines, verify, plan board, recorder). Plain state
 * holder; lifecycle and IPC stay in main.
 */
import { PtyTerminal } from "./pty-terminal.js";
import type { RunRecord } from "./worldlines/index.js";
import type {
  ModifiedFile,
  PlanTask,
  RecorderState,
  TimelineEvent,
  VerifyInfo,
} from "../shared/types.js";

let terminalGenerationSeq = 0;

export class AgentTerminalInstance {
  readonly id: string;
  /** Monotonic generation fencing this PTY from a later id reuse. */
  readonly generation = ++terminalGenerationSeq;
  pty: PtyTerminal;
  cwd: string;
  /** The workspace this terminal works in (empty when no folder is open). */
  workspaceId: string;
  /** The project that owns this terminal, or null. */
  projectId: string | null = null;
  type: "agent" | "shell";
  /** The engine for an agent terminal. Shells leave this unset. */
  engine?: "core";
  /** Persist this tab in the project roster (user terminals, not dispatch or candidates). */
  persist = true;
  /** Harness session id for resume. */
  sessionId: string | null = null;
  /** Absolute session file used to resume this harness. */
  sessionFile: string | null = null;
  /** The live model of this agent, provider-qualified when known. */
  model: string | null = null;
  /** The live thinking level of this agent. */
  thinkingLevel: string | null = null;
  /** The live usage/cache line of this agent, formatted by agent-core. */
  usage: string | null = null;
  shellName?: string;
  /** Absolute shell binary, for roster resume. */
  shellPath?: string;
  /** User/project teardown invalidated this terminal's pending delivery. */
  closed = false;
  /** Fences forced timeout cleanup from a late native PTY exit callback. */
  exitHandled = false;
  busy = false;
  modified = new Map<string, ModifiedFile>();
  /** Pre-run content per path (Change Review): string = baseline, null = created. */
  baselines = new Map<string, string | null>();
  /** Run-start state anchoring each baseline; revert reads bytes from it. */
  baselineStates = new Map<string, string>();
  baselineBytes = 0;
  /** In-flight lazy baseline captures per path (Change Review waits for them). */
  baselineFills = new Map<string, Promise<void>>();
  /** Verify & Iterate: last test run attached to this terminal. */
  verify: VerifyInfo = { state: "untested", command: null, summary: null };
  /** Plan Board: the tasks of the current run. */
  plan: PlanTask[] = [];
  /** Paths this run touched, relative to the project (for task progress). */
  touched = new Set<string>();
  /** In-flight file tools: tool call id to the relative path. */
  pendingFileTools = new Map<string, string>();
  /** Last file-tool outcome per relative path. */
  toolOutcomes = new Map<string, "ok" | "error">();
  /** Last prefix payload sent, so identical tool_end events skip IPC. */
  lastTimelinePrefixKey = "";
  /** When the user sent an interrupt (\x03) into this terminal. */
  interruptedAt?: number;
  /** Session Timeline: ordered points with file snapshots. */
  timeline: TimelineEvent[] = [];
  /** Per-path content as of the last snapshot in this run (for edit math). */
  runSnapshots = new Map<string, string>();
  runSnapshotBytes = 0;
  /** Recent file-tool paths. Watcher changes on these paths join the tool
   *  dot instead of adding a second change dot. */
  lastToolAt = new Map<string, number>();
  timelineSeq = 0;
  /** Watcher hint paths since the last moment capture (Phase 6). */
  pendingHints = new Set<string>();
  /** Debounced moment-capture timer. */
  captureTimer: ReturnType<typeof setTimeout> | null = null;
  /** Dots waiting for their captured source state. */
  momentDots: TimelineEvent[] = [];
  /** The recorder state of this terminal's timeline. */
  recorderState: RecorderState = "paused";
  /** The last capture failure, shown in the timeline tooltip while degraded. */
  recorderDetail: string | null = null;
  /** The recorder detail last pushed (dedupes degraded resends). */
  lastSentRecorderDetail: string | null = null;
  /** The prompt payload reported by before_agent_start. */
  pendingPrompt: { file: string; text: string; images: number } | null = null;
  /** The open run record of this terminal, or null. */
  currentRun: RunRecord | null = null;

  constructor(
    id: string,
    cwd: string,
    workspaceId: string,
    type: "agent" | "shell",
    shellName: string | undefined,
    cmd: string,
    args: string[],
    env: Record<string, string | undefined>,
    cols: number,
    rows: number,
  ) {
    this.id = id;
    this.cwd = cwd;
    this.workspaceId = workspaceId;
    this.type = type;
    this.shellName = shellName;
    this.pty = new PtyTerminal({ id, cwd, cmd, args, env, cols, rows });
  }
}
