/**
 * Background subagent host (SUBAGENTS-PLAN.md Phase 2).
 *
 * Single owner for headless child runs: task validation, child launch with
 * piped stdio (never node-pty), framed-result capture, retry with backoff,
 * kill, durable result files, and the owner mailbox note. The parent core
 * process owns spawn validation and registry truth; this host owns
 * everything from the `subagent_spawn` sidecar record onward.
 *
 * Out of scope here (slice 2b): tailing bg-N streams for timeline dots,
 * toasts, `/clear` kills, and startup sweeps of orphaned handoff files.
 */

import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import { coreSessionFile, parseSessionBundlePath, sessionBundleExists } from "../agent-core/session.js";
import {
  MAX_SUBAGENT_RESULT_CHARS,
  MAX_SUBAGENT_TOUCHED,
  SUBAGENT_RESULT_PREFIX,
  anchorClaimPath,
  parseSubagentTaskFile,
  parseSubagentResultFrame,
  scanSubagentOutput,
  subagentChildTid,
  subagentPathsOverlap,
  subagentResultFileName,
  truncateUtf8,
  type SubagentOutcome,
  type SubagentTaskFile,
} from "../agent-core/subagents.js";

/** At most 4 child processes at once (Anthropic rule, host-wide). */
export const MAX_SUBAGENT_HOST_CHILDREN = 4;
/** Pre-child launch attempts per run before reporting failure. */
export const SUBAGENT_MAX_ATTEMPTS = 3;
/** Backoff between failed launches (attempts 2 and 3); never replay started work. */
export const SUBAGENT_RETRY_BACKOFF_MS = [1000, 2000];
/** Wall clock per attempt before the child is killed as timed out. */
export const SUBAGENT_WALL_TIMEOUT_MS = 10 * 60_000;
/** Stdout cap: transcript plus one framed line; the host takes the last frame. */
export const SUBAGENT_STDOUT_CAP_BYTES = 256 * 1024;
/** Stderr is evidence only, kept small. */
export const SUBAGENT_STDERR_CAP_BYTES = 8 * 1024;
/** Result text carried in the mailbox note; the file holds the full text. */
export const SUBAGENT_NOTE_RESULT_CHARS = 4000;
/** Task text carried in the mailbox note; the file holds the full task. */
export const SUBAGENT_NOTE_TASK_CHARS = 2000;

export interface SubagentHostSinks {
  /** Owning terminal's events dir; null when the terminal is gone. */
  eventsDirFor(terminalId: string): string | null;
  /** Sanitized base environment (session pins stripped by the owner). */
  baseEnv(): Record<string, string | undefined>;
  /** Absolute path of the bundled agent-core entry. */
  coreBinary(): string;
  /** Project session root for a cwd (child bundles live beside parents'). */
  sessionRootFor(cwd: string): Promise<string>;
  /** Existing owner-mailbox path. The host never writes mailbox files itself. */
  appendMailboxNote(terminalId: string, note: string): void;
  /** Tail a child sidecar stream on the shared tailer. */
  watchStream(terminalId: string): void;
  /** Release a child sidecar stream (stop tailing, drop its queue). */
  releaseStream(terminalId: string): void;
  /** Canonical in-flight dispatch path keys plus their root (spawn-time veto). */
  dispatchKeysFor(ownerId: string): Promise<{ keys: Set<string>; root: string }>;
  /** Canonical absolute path (total: resolves existing prefixes, never throws). */
  canonicalPath(p: string): Promise<string>;
}

export interface SubagentChildEvents {
  onData(callback: (chunk: Buffer) => void): void;
}

export interface SubagentChild {
  readonly pid: number | undefined;
  readonly stdout: SubagentChildEvents;
  readonly stderr: SubagentChildEvents;
  onExit(callback: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  killChild(signal: NodeJS.Signals): void;
  /** Terminate the whole process group (POSIX); falls back to the child. */
  killGroup(signal: NodeJS.Signals): void;
}

export type SubagentLauncher = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string | undefined> },
) => SubagentChild;

export interface SubagentHostOptions {
  launch?: SubagentLauncher;
  /** Override for tests. */
  wallMs?: number;
  maxChildren?: number;
  maxAttempts?: number;
  backoffMs?: number[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface HostRun {
  key: string;
  parentTerminalId: string;
  runId: string;
  task: SubagentTaskFile;
  taskFile: string;
  childTid: string;
  attempts: number;
  stop: { kind: "kill"; reason: string } | { kind: "timeout" } | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  wallTimer: ReturnType<typeof setTimeout> | null;
  child: SubagentChild | null;
  stdout: string;
  stdoutTruncated: boolean;
  stderr: string;
  settled: boolean;
  /** Latest attempt's session bundle, retained after settle for resume. */
  sessionFile: string | null;
  /** Absolute touched paths from tailed tool events (merge evidence). */
  touched: Set<string>;
}

/** Settled-run session bundles available for resume (bounded, same-parent only). */
const MAX_SUBAGENT_PAST_SESSIONS = 32;

/** Settled-run touched memory for sibling merge detection (bounded). */
const MAX_SUBAGENT_PAST_TOUCHED = 20;

function defaultLauncher(cmd: string, args: string[], opts: { cwd: string; env: Record<string, string | undefined> }): SubagentChild {
  const child: ChildProcess = spawnProcess(cmd, args, {
    cwd: opts.cwd,
    env: opts.env as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  // Spawn errors also emit close. Handle error now so a missing executable or
  // cwd cannot crash Electron; settlement waits for stdio to finish draining.
  child.once("error", () => {});
  const wrap = (stream: NodeJS.ReadableStream | null): SubagentChildEvents => ({
    onData: (callback: (chunk: Buffer) => void) => {
      stream?.on("data", callback);
    },
  });
  return {
    pid: child.pid,
    stdout: wrap(child.stdout),
    stderr: wrap(child.stderr),
    onExit: (callback) => {
      child.once("close", (code, signal) => callback(code, signal));
    },
    killChild: (signal) => {
      try {
        child.kill(signal);
      } catch {
        /* Already exited; exit handling resolves the run. */
      }
    },
    killGroup: (signal) => {
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          /* Fall through to the direct kill. */
        }
      }
      try {
        child.kill(signal);
      } catch {
        /* Already exited; exit handling resolves the run. */
      }
    },
  };
}

function truncateUtf8Tail(text: string, cap: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= cap) return text;
  let start = buf.length - cap;
  // Move forward over continuation bytes to the lead byte of a character.
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start += 1;
  return buf.toString("utf8", start);
}

function appendCapped(current: string, chunk: Buffer, cap: number): { text: string; truncated: boolean } {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") <= cap) return { text: next, truncated: false };
  // Keep the tail: the host takes the LAST framed line, and stderr evidence
  // is read via tailLines. Head-truncation dropped both.
  return { text: truncateUtf8Tail(next, cap), truncated: true };
}

export class SubagentHost {
  private readonly runs = new Map<string, HostRun>();
  /** Child sidecar streams tailed for liveness (booted/activity). No UI surface in v1. */
  private readonly streams = new Map<string, { key: string; booted: boolean; lastActivityAt: number }>();
  /** Settled runs' touched paths for sibling merge detection (bounded, same-parent only). */
  private pastTouched: Array<{ runId: string; parentTerminalId: string; touched: string[] }> = [];
  /** Settled runs' session bundles for resume (bounded, keyed by parent/run). */
  private pastSessions = new Map<string, string>();
  private readonly launch: SubagentLauncher;
  private readonly wallMs: number;
  private readonly maxChildren: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number[];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly sinks: SubagentHostSinks,
    opts: SubagentHostOptions = {},
  ) {
    this.launch = opts.launch ?? defaultLauncher;
    this.wallMs = opts.wallMs ?? SUBAGENT_WALL_TIMEOUT_MS;
    this.maxChildren = opts.maxChildren ?? MAX_SUBAGENT_HOST_CHILDREN;
    this.maxAttempts = opts.maxAttempts ?? SUBAGENT_MAX_ATTEMPTS;
    this.backoffMs = opts.backoffMs ?? SUBAGENT_RETRY_BACKOFF_MS;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  activeCount(): number {
    return this.runs.size;
  }

  /** True while a child stream is tailed (admission for the shared tailer). */
  hasStream(childTid: string): boolean {
    return this.streams.has(childTid);
  }

  /** Liveness signal from the shared tailer. Unknown streams are ignored. */
  noteChildEvent(childTid: string, kind: string, path?: string): void {
    const stream = this.streams.get(childTid);
    if (!stream) return;
    stream.lastActivityAt = this.now();
    if (kind === "agent_start") stream.booted = true;
    // Touched paths are merge evidence, not a manifest: tool records carry
    // file paths for file tools only (bash side effects are untracked).
    // Relative paths anchor at the run cwd so siblings compare identically.
    if (kind === "tool" && typeof path === "string" && path) {
      const run = this.runs.get(stream.key);
      if (run && run.touched.size < MAX_SUBAGENT_TOUCHED) {
        const clean = path.replace(/\/{2,}/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
        if (clean) run.touched.add(isAbsolute(clean) ? clean : join(run.task.cwd, clean));
      }
    }
  }

  /** Live claim holds for dispatch overlap checks (Phase 4 unified claims). */
  claimsForOwner(parentTerminalId: string): Array<{ path: string; cwd: string }> {
    const out: Array<{ path: string; cwd: string }> = [];
    for (const run of this.runs.values()) {
      if (run.parentTerminalId !== parentTerminalId) continue;
      for (const p of run.task.paths) out.push({ path: p, cwd: run.task.cwd });
    }
    return out;
  }

  streamInfo(childTid: string): { runId: string; parentTerminalId: string; booted: boolean; lastActivityAt: number } | null {
    const stream = this.streams.get(childTid);
    if (!stream) return null;
    const run = this.runs.get(stream.key);
    if (!run) return null;
    return { runId: run.runId, parentTerminalId: run.parentTerminalId, booted: stream.booted, lastActivityAt: stream.lastActivityAt };
  }

  /** Terminate one run. The exit handler writes the killed result; no retry. */
  kill(parentTerminalId: string, runId: string, reason: string): boolean {
    const run = this.runs.get(`${parentTerminalId}/${runId}`);
    if (!run || run.settled) return false;
    run.stop = { kind: "kill", reason };
    if (run.retryTimer) {
      clearTimeout(run.retryTimer);
      run.retryTimer = null;
    }
    if (!run.child) {
      // Between attempts: no child exists, resolve immediately.
      void this.finishKilled(run, reason);
      return true;
    }
    if (run.wallTimer) {
      clearTimeout(run.wallTimer);
      run.wallTimer = null;
    }
    this.terminateChild(run);
    return true;
  }

  /** Both explicit cancellation and wall timeout use the same bounded stop. */
  private terminateChild(run: HostRun): void {
    const child = run.child;
    if (!child) return;
    child.killGroup("SIGTERM");
    if (run.retryTimer) clearTimeout(run.retryTimer);
    run.retryTimer = setTimeout(() => {
      run.retryTimer = null;
      if (!run.settled && run.child === child) child.killGroup("SIGKILL");
    }, 5000);
  }

  /** Terminate every run owned by a terminal (e.g. `/clear`). Returns the count. */
  killOwner(parentTerminalId: string, reason: string): number {
    let count = 0;
    for (const run of [...this.runs.values()]) {
      if (run.parentTerminalId === parentTerminalId && this.kill(parentTerminalId, run.runId, reason)) count += 1;
    }
    // A cleared session starts a new main task: old touched history would
    // merge-note against unrelated new runs.
    this.pastTouched = this.pastTouched.filter((p) => p.parentTerminalId !== parentTerminalId);
    return count;
  }

  /**
   * Launch the child for a validated parent spawn. Never throws: every path
   * ends in a durable result file plus a mailbox note, so the parent's
   * reconcile frees the slot exactly once.
   */
  async handleSpawn(sourceTerminalId: string, runId: unknown, taskFile: unknown): Promise<void> {
    try {
      await this.spawnInner(sourceTerminalId, runId, taskFile);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.finishFailed(sourceTerminalId, typeof runId === "string" ? runId : "bg-?", null, `host error: ${message}`);
    }
  }

  private runKey(parentTerminalId: string, runId: string): string {
    return `${parentTerminalId}/${runId}`;
  }

  private async spawnInner(sourceTerminalId: string, runId: unknown, taskFile: unknown): Promise<void> {
    if (typeof runId !== "string" || !/^bg-\d{1,10}$/.test(runId)) return;
    if (typeof taskFile !== "string" || !taskFile || taskFile.includes("/") || taskFile.includes("\\") || taskFile.includes("..")) {
      // Valid run id but malformed handoff name: the parent holds an active
      // run that reconcile can only free via a result file, so fail loudly
      // instead of returning silently. An invalid run id cannot be addressed
      // to any parent run and stays silent above.
      if (typeof runId === "string") await this.finishFailed(sourceTerminalId, runId, null, "invalid subagent handoff identity");
      return;
    }
    if (!taskFile.endsWith(".task.json")) {
      if (typeof runId === "string") await this.finishFailed(sourceTerminalId, runId, null, "invalid subagent handoff identity");
      return;
    }
    const key = this.runKey(sourceTerminalId, runId);
    if (this.runs.has(key)) return;
    const dir = this.sinks.eventsDirFor(sourceTerminalId);
    if (!dir) return;
    let task: SubagentTaskFile;
    try {
      task = mustParseTask(JSON.parse(readFileSync(join(dir, basename(taskFile)), "utf8")));
    } catch {
      await this.finishFailed(sourceTerminalId, runId, null, "invalid subagent task file");
      return;
    }
    if (task.parentTerminalId !== sourceTerminalId) {
      await this.finishFailed(sourceTerminalId, runId, task, "subagent task parent mismatch");
      return;
    }
    // Cross-terminal sibling overlap: registries are per-process, so two
    // parents on one tree can claim the same paths. Same canonical cwd plus
    // overlapping relpaths rejects, exactly like the single-parent rule.
    // Fail closed: an unresolvable cwd cannot prove non-overlap.
    let cwdKey: string;
    try {
      cwdKey = await this.sinks.canonicalPath(task.cwd);
    } catch {
      await this.finishFailed(sourceTerminalId, runId, task, "cannot verify path overlap (cwd)");
      return;
    }
    for (const other of this.runs.values()) {
      let otherCwd: string;
      try {
        otherCwd = await this.sinks.canonicalPath(other.task.cwd);
      } catch {
        await this.finishFailed(sourceTerminalId, runId, task, "cannot verify path overlap (sibling cwd)");
        return;
      }
      if (otherCwd !== cwdKey) continue;
      for (const p of task.paths) {
        const hit = other.task.paths.find((q) => subagentPathsOverlap(p, q));
        if (hit) {
          await this.finishFailed(
            sourceTerminalId,
            runId,
            task,
            `paths overlap running subagent ${other.runId} (${hit})`,
          );
          return;
        }
      }
    }
    // One continuation at a time: two live children appending to the same
    // replayed bundle would interleave its session file.
    if (task.resumeRunId) {
      const rival = [...this.runs.values()].find(
        (other) => other.parentTerminalId === sourceTerminalId && other.task.resumeRunId === task.resumeRunId,
      );
      if (rival) {
        await this.finishFailed(
          sourceTerminalId,
          runId,
          task,
          `${task.resumeRunId} is already being continued by ${rival.runId}`,
        );
        return;
      }
    }
    // Dispatch interplay (unified claims): a live dispatch worker on an
    // overlapping path fails the spawn before any child exists. Both sides
    // anchor at the dispatch root so subdir terminals key identically.
    // Fail closed: unverifiable dispatch claims or paths reject the spawn.
    let dispatch: { keys: Set<string>; root: string };
    try {
      dispatch = await this.sinks.dispatchKeysFor(sourceTerminalId);
    } catch {
      await this.finishFailed(sourceTerminalId, runId, task, "cannot verify dispatch claims");
      return;
    }
    if (dispatch.keys.size > 0 && task.paths.length > 0) {
      for (const p of task.paths) {
        const anchored = anchorClaimPath(task.cwd, p, dispatch.root || task.cwd);
        let key: string;
        try {
          key = await this.sinks.canonicalPath(join(anchored.root, anchored.rel));
        } catch {
          await this.finishFailed(sourceTerminalId, runId, task, `cannot verify dispatch overlap (${p})`);
          return;
        }
        if (key && dispatch.keys.has(key)) {
          await this.finishFailed(sourceTerminalId, runId, task, `path overlaps a dispatch worker (${p})`);
          return;
        }
      }
    }
    if (this.runs.size >= this.maxChildren) {
      await this.finishFailed(sourceTerminalId, runId, task, `subagent host at capacity (${this.maxChildren} runs)`);
      return;
    }
    let cwdStat: { isDirectory(): boolean } | null = null;
    try {
      cwdStat = statSync(task.cwd);
    } catch {
      cwdStat = null;
    }
    if (!cwdStat?.isDirectory()) {
      await this.finishFailed(sourceTerminalId, runId, task, "subagent cwd unavailable");
      return;
    }
    const childTid = subagentChildTid(sourceTerminalId, runId);
    if (!childTid) {
      await this.finishFailed(sourceTerminalId, runId, task, "bad subagent stream identity");
      return;
    }
    const run: HostRun = {
      key,
      parentTerminalId: sourceTerminalId,
      runId,
      task,
      taskFile: basename(taskFile),
      childTid,
      attempts: 0,
      stop: null,
      retryTimer: null,
      wallTimer: null,
      child: null,
      stdout: "",
      stdoutTruncated: false,
      stderr: "",
      settled: false,
      sessionFile: null,
      touched: new Set<string>(),
    };
    this.runs.set(key, run);
    await this.startAttempt(run);
  }

  private async startAttempt(run: HostRun): Promise<void> {
    const dir = this.sinks.eventsDirFor(run.parentTerminalId);
    if (!dir) {
      this.runs.delete(run.key);
      return;
    }
    run.attempts += 1;
    run.stdout = "";
    run.stdoutTruncated = false;
    run.stderr = "";
    run.stop = null;
    // A resume replays the prior run's bundle instead of starting a fresh
    // session. The bundle must still exist (host restart or cleanup drops
    // it); otherwise fail closed without spawning — retrying cannot help.
    let resumeFile: string | null = null;
    if (run.task.resumeRunId) {
      const retained = this.pastSessions.get(this.runKey(run.parentTerminalId, run.task.resumeRunId));
      // The bundle may have vanished since (retention sweep, disk cleanup):
      // check the filesystem, not just host memory, before spawning.
      const usable = retained && sessionBundleExists(retained) ? retained : null;
      if (!usable) {
        await this.finishFailed(
          run.parentTerminalId,
          run.runId,
          run.task,
          `cannot resume ${run.task.resumeRunId}: its session is gone; spawn a fresh brief instead`,
        );
        return;
      }
      resumeFile = usable;
    }
    const sessionId = `core-${randomUUID()}`;
    let sessionFile: string;
    let resumeSessionId: string | null = null;
    if (resumeFile) {
      sessionFile = resumeFile;
      // Keep addressing coherent with the bundle being replayed: the session
      // id seeds the child's cache identity, so a resumed child must reuse
      // the prior id rather than minting a cold one.
      resumeSessionId = parseSessionBundlePath(resumeFile)?.sessionId ?? null;
      if (!resumeSessionId) {
        await this.finishFailed(
          run.parentTerminalId,
          run.runId,
          run.task,
          `cannot resume ${run.task.resumeRunId}: its session address is invalid; spawn a fresh brief instead`,
        );
        return;
      }
    } else {
      try {
        const root = await this.sinks.sessionRootFor(run.task.cwd);
        sessionFile = coreSessionFile(root, sessionId);
        mkdirSync(dirname(sessionFile), { recursive: true });
      } catch (err) {
        await this.finishFailed(run.parentTerminalId, run.runId, run.task, `subagent session unavailable: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    run.sessionFile = sessionFile;
    const env: Record<string, string | undefined> = { ...this.sinks.baseEnv() };
    env.TERMINA_TERMINAL_ID = run.childTid;
    env.TERMINA_EVENTS_DIR = dir;
    env.TERMINA_CORE_SESSION_ID = resumeSessionId ?? sessionId;
    env.TERMINA_CORE_SESSION_FILE = sessionFile;
    env.TERMINA_CORE_SUBAGENT_DEPTH = String(run.task.depth);
    env.ELECTRON_RUN_AS_NODE = "1";
    delete env.TERMINA_CORE_MODEL;
    delete env.TERMINA_CORE_PROVIDER;
    delete env.TERMINA_CORE_SUMMARY_MODEL;
    // Inherit the parent's permission mode and nothing more: `always` alone
    // auto-approves. Every other mode fails closed headless (ask denies).
    if (run.task.permissionMode === "always") env.TERMINA_CORE_APPROVE = "all";
    else delete env.TERMINA_CORE_APPROVE;
    let child: SubagentChild;
    try {
      child = this.launch(process.execPath, [this.sinks.coreBinary(), "--subagent-task", join(dir, run.taskFile)], {
        cwd: run.task.cwd,
        env,
      });
    } catch (err) {
      await this.retryLaunch(run, `spawn failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // The task file was consumed at spawn; attempts rebuild from the run.
    run.child = child;
    if (!this.streams.has(run.childTid)) {
      this.streams.set(run.childTid, { key: run.key, booted: false, lastActivityAt: this.now() });
      try {
        this.sinks.watchStream(run.childTid);
      } catch {
        /* Tailing is liveness only; the piped exit stays authoritative. */
      }
    } else {
      // Retry in the same stream: a new process, so boot state resets but
      // the tail cursor (owned by the shared tailer) keeps flowing.
      const stream = this.streams.get(run.childTid)!;
      stream.booted = false;
      stream.lastActivityAt = this.now();
    }
    child.stdout.onData((chunk) => {
      const next = appendCapped(run.stdout, chunk, SUBAGENT_STDOUT_CAP_BYTES);
      run.stdout = next.text;
      run.stdoutTruncated = next.truncated;
    });
    child.stderr.onData((chunk) => {
      const next = appendCapped(run.stderr, chunk, SUBAGENT_STDERR_CAP_BYTES);
      run.stderr = next.text;
    });
    run.wallTimer = setTimeout(() => {
      run.wallTimer = null;
      if (run.settled || !run.child) return;
      run.stop = { kind: "timeout" };
      this.terminateChild(run);
    }, this.wallMs);
    child.onExit((code, signal) => {
      void this.onChildExit(run, code, signal);
    });
  }

  private async onChildExit(run: HostRun, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (run.settled) return;
    if (run.wallTimer) clearTimeout(run.wallTimer);
    if (run.retryTimer) clearTimeout(run.retryTimer);
    run.wallTimer = null;
    run.retryTimer = null;
    run.child = null;
    if (run.stop?.kind === "kill") {
      await this.finishKilled(run, run.stop.reason);
      return;
    }
    const frame = lastResultFrame(run.stdout);
    if (frame && !frame.ok) {
      // The engine deliberately exits 1 for a failed run. This is a result,
      // not a transient launch failure that is safe to replay from scratch.
      await this.finishFailed(run.parentTerminalId, run.runId, run.task, `child reported failure: ${frame.error ?? "unknown"}`);
      return;
    }
    if (code === 0 && frame?.ok) {
      const scanned = scanSubagentOutput(truncateUtf8(frame.result ?? "", MAX_SUBAGENT_RESULT_CHARS));
      await this.finishSettled(run, scanned.text, scanned.flags);
      return;
    }
    // Once spawned, the child may have performed side effects even if the
    // sidecar tailer has not observed agent_start yet. Never replay implicitly.
    const recovery = "not restarted: work may already have executed; inspect the project and explicitly resume if needed";
    if (run.stop?.kind === "timeout") {
      await this.finishKilled(run, `wall timeout exceeded; ${recovery}`);
      return;
    }
    const reason = signal ? `crashed (${signal})` : code === 0 ? "child exited without a result frame" : `exit ${code ?? "?"}`;
    await this.finishFailed(run.parentTerminalId, run.runId, run.task, `${reason}${run.stderr ? `: ${tailLines(run.stderr, 3)}` : ""}; ${recovery}`);
  }

  /** Retry only a synchronous launch failure: no child exists to have done work. */
  private async retryLaunch(run: HostRun, reason: string): Promise<void> {
    if (run.settled) return;
    if (run.attempts < this.maxAttempts) {
      const wait = this.backoffMs[Math.min(run.attempts - 1, this.backoffMs.length - 1)] ?? 1000;
      await this.sleep(wait);
      if (run.settled) return;
      if (run.stop?.kind === "kill") {
        await this.finishKilled(run, run.stop.reason);
        return;
      }
      await this.startAttempt(run);
      return;
    }
    await this.finishFailed(run.parentTerminalId, run.runId, run.task, reason);
  }

  private async finishSettled(run: HostRun, result: string, flags: string[]): Promise<void> {
    await this.finish(run, "settled", result, flags, null);
  }

  private async finishKilled(run: HostRun, reason: string): Promise<void> {
    await this.finish(run, "killed", "", [], reason);
  }

  private async finishFailed(
    parentTerminalId: string,
    runId: string,
    task: SubagentTaskFile | null,
    error: string,
  ): Promise<void> {
    const key = this.runKey(parentTerminalId, runId);
    const run = this.runs.get(key);
    if (run) {
      if (run.settled) return;
      await this.finish(run, "failed", "", [], error);
      return;
    }
    // No child ever existed (validation/capacity failure): still write the
    // result so the parent's reconcile frees the slot exactly once.
    await this.writeResult(parentTerminalId, runId, "failed", "", [], error, task);
  }

  private async finish(
    run: HostRun,
    outcome: SubagentOutcome,
    result: string,
    flags: string[],
    error: string | null,
  ): Promise<void> {
    if (run.settled) return;
    run.settled = true;
    // Retain the bundle for resume: a later sibling run can replay it as a
    // follow-up. Bounded and same-parent keyed; a host restart drops it all.
    // Eviction also removes the bundle directory from disk, so retained
    // sessions cannot leak storage. A bundle still referenced by another
    // retained key (resume reuses one file) is never deleted.
    if (run.sessionFile) {
      this.pastSessions.set(this.runKey(run.parentTerminalId, run.runId), run.sessionFile);
      const evicted: string[] = [];
      while (this.pastSessions.size > MAX_SUBAGENT_PAST_SESSIONS) {
        const oldest = this.pastSessions.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        const removed = this.pastSessions.get(oldest);
        this.pastSessions.delete(oldest);
        if (removed) evicted.push(removed);
      }
      const live = new Set(this.pastSessions.values());
      for (const run of this.runs.values()) {
        if (run.sessionFile) live.add(run.sessionFile);
      }
      for (const path of evicted) {
        if (live.has(path)) continue;
        const bundleDir = parseSessionBundlePath(path)?.bundleDir;
        if (!bundleDir) continue;
        try {
          rmSync(bundleDir, { recursive: true, force: true });
        } catch {
          /* Orphaned bundles are host evidence; a later eviction retries. */
        }
      }
    }
    if (run.retryTimer) {
      clearTimeout(run.retryTimer);
      run.retryTimer = null;
    }
    if (run.wallTimer) {
      clearTimeout(run.wallTimer);
      run.wallTimer = null;
    }
    this.runs.delete(run.key);
    this.streams.delete(run.childTid);
    try {
      this.sinks.releaseStream(run.childTid);
    } catch {
      /* Best-effort tailer release. */
    }
    // The task file served every attempt; remove it so a stale handoff can
    // never launch a second run. A host crash before this leaves an orphan
    // for the startup sweep.
    try {
      const dir = this.sinks.eventsDirFor(run.parentTerminalId);
      if (dir) rmSync(join(dir, run.taskFile));
    } catch {
      /* Leftovers are startup-sweep evidence. */
    }
    // Sibling merge detection: compare this run's touched paths against
    // settled siblings of the same parent. Same-tree absolute paths match
    // exactly (different trees never collide); the parent merges.
    const merges: Array<{ runId: string; paths: string[] }> = [];
    for (const prev of this.pastTouched) {
      if (prev.parentTerminalId !== run.parentTerminalId) continue;
      const hit = [...run.touched].filter((p) => prev.touched.includes(p)).slice(0, 10);
      if (hit.length > 0) merges.push({ runId: prev.runId, paths: hit });
    }
    this.pastTouched.push({
      runId: run.runId,
      parentTerminalId: run.parentTerminalId,
      touched: [...run.touched],
    });
    while (this.pastTouched.length > MAX_SUBAGENT_PAST_TOUCHED) this.pastTouched.shift();
    await this.writeResult(run.parentTerminalId, run.runId, outcome, result, flags, error, run.task, [...run.touched], merges);
  }

  private async writeResult(
    parentTerminalId: string,
    runId: string,
    outcome: SubagentOutcome,
    result: string,
    flags: string[],
    error: string | null,
    task: SubagentTaskFile | null,
    touched: string[] = [],
    merges: Array<{ runId: string; paths: string[] }> = [],
  ): Promise<void> {
    const dir = this.sinks.eventsDirFor(parentTerminalId);
    const name = subagentResultFileName(parentTerminalId, runId);
    const body = JSON.stringify({
      version: 1,
      runId,
      outcome,
      result,
      flags,
      touched: touched.slice(0, MAX_SUBAGENT_TOUCHED),
      settledAt: this.now(),
    });
    if (dir && name) {
      const target = join(dir, name);
      const temp = `${target}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temp, body, { mode: 0o600 });
        renameSync(temp, target);
      } catch {
        /* The mailbox note below still carries the outcome. */
        try {
          rmSync(temp);
        } catch {
          /* Orphaned temps match the sweep predicate. */
        }
      }
    }
    const headline = outcome === "settled"
      ? `## Subagent ${runId} settled`
      : outcome === "killed"
        ? `## Subagent ${runId} killed`
        : `## Subagent ${runId} failed`;
    const lines = [headline, ""];
    if (task) {
      // Quote the full brief up to a bounded budget. A hard cut once made a
      // complete brief read as a truncated spawn ("...cd apps/backend\n3"),
      // and the parent diagnosed the spawn instead of the failure.
      const brief = task.task.length > SUBAGENT_NOTE_TASK_CHARS
        ? `${task.task.slice(0, SUBAGENT_NOTE_TASK_CHARS)}\n…[truncated]`
        : task.task;
      lines.push(`Task: ${brief}`, "");
    }
    if (task?.resumeRunId) lines.push(`Continued from ${task.resumeRunId}; its session history was replayed.`, "");
    if (outcome === "settled") {
      const text = result.length > SUBAGENT_NOTE_RESULT_CHARS ? `${result.slice(0, SUBAGENT_NOTE_RESULT_CHARS)}\n…[truncated]` : result;
      lines.push(text);
      if (flags.length > 0) lines.push("", `Scan flags: ${flags.join(", ")}`);
      // Force grounding: the parent must digest this result before continuing,
      // never poll a finished run or duplicate its work.
      lines.push("", "Summarize this result and state your next step explicitly. The result above is complete; do not poll the run.");
    } else if (error) {
      lines.push(`${outcome === "killed" ? "Reason" : "Error"}: ${error.slice(0, 1000)}`);
      // A failed identical brief will fail identically: rewrite the task or
      // dismiss the run instead of respawning it unchanged. Killed runs
      // (timeouts) are exempt: retrying with an adjusted budget is legitimate.
      if (outcome === "failed") {
        lines.push("", "Do not respawn this exact brief. Rewrite the task or dismiss the run.");
      }
    }
    // Parent merge task: siblings that touched the same files. The parent
    // merges; siblings never negotiate with each other.
    for (const merge of merges) {
      lines.push("", `## Merge needed: ${merge.paths.map((p) => `\`${p}\``).join(", ")} also touched by ${merge.runId} — merge both results before trusting either.`);
    }
    try {
      this.sinks.appendMailboxNote(parentTerminalId, lines.join("\n"));
    } catch {
      /* Mailbox delivery is best-effort; the result file is durable. */
    }
  }
}

function mustParseTask(raw: unknown): SubagentTaskFile {
  const checked = parseSubagentTaskFile(raw);
  if (!checked.ok) throw new Error(checked.error);
  return checked.file;
}

/** Last framed stdout line; null when the child never framed a result. */
export function lastResultFrame(stdout: string): { ok: boolean; result?: string; error?: string } | null {
  const start = stdout.lastIndexOf(SUBAGENT_RESULT_PREFIX);
  if (start < 0) return null;
  const lineEnd = stdout.indexOf("\n", start);
  const line = lineEnd < 0 ? stdout.slice(start) : stdout.slice(start, lineEnd);
  return parseSubagentResultFrame(line);
}

function tailLines(text: string, count: number): string {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  return lines.slice(-count).join(" / ").slice(0, 500);
}
