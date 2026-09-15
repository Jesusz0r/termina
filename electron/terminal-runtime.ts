/**
 * In-process terminal lifecycle.
 *
 * Owns the live instance map, PTY spawn/exit, the egress ledger, the primary
 * events dir + tailer, the roster file store, sidecar watch/queue, generation
 * fencing, and viewer attach/detach. Main is a client: it validates IPC,
 * folds activity, and owns projects/leases/snapshots. Renderer attach stays
 * `readyTerminal` / `acknowledgePtyData` — this module does not add IPC.
 */
import { PtyEgressScheduler, type PtyEgressSchedulerOptions, type PtyRendererSendTarget } from "./pty-egress.js";
import {
  SidecarEventQueue,
  SidecarTailer,
  type SidecarEvent,
  type SidecarEventDelivery,
} from "./sidecar.js";
import {
  TerminalRosterStore,
  loadRosterFile,
  type RosterTerminal,
  type TerminalRosterHost,
} from "./roster-store.js";
import type { TerminalRosterEntry } from "./terminal-roster.js";
import { AgentTerminalInstance } from "./terminal-instance.js";

/** Exit teardown waits this long for the renderer to acknowledge the PTY
 *  tail before cancelling it: crash/reload cycles finish well inside, while
 *  a wedged renderer cannot stall teardown (and subagent cleanup) forever. */
export const PTY_EXIT_DRAIN_TIMEOUT_MS = 10_000;

/** Tailer surface the runtime watches and stops. SidecarTailer is assignable. */
export interface RuntimeSidecarTailer {
  watch(id: string): void;
  stopWatching(id: string): void;
  setExpectedProducer(id: string, pid: number): void;
}

export interface TerminalRuntimeHost {
  sendChunk(
    terminalId: string,
    terminalGeneration: number,
    windowGeneration: number,
    rendererGeneration: number,
    sequence: number,
    data: string,
  ): boolean | void;
  sendExit(
    terminalId: string,
    terminalGeneration: number,
    windowGeneration: number,
    rendererGeneration: number,
    sequence: number,
    code: number,
  ): boolean | void;
  /** Fence PTY admission the same way sendPtyData used to: once dispose begins. */
  isDisposed(): boolean;
  /** Admission besides "id is live": disposed, project switch, subagent streams. */
  shouldAdmitSidecar(terminalId: string): boolean;
  onSidecarEvent(terminalId: string, event: SidecarEvent): void | Promise<void>;
  onSidecarError(error: Error, event: SidecarEvent): void;
  /** Still in the map: capture owner, expire preflights, fold exit, discard session. */
  onPtyExitBeforeRelease(
    inst: AgentTerminalInstance,
    rendererTarget: PtyRendererSendTarget | null,
    details: { code: number; origin: "native" | "forced"; drained: boolean },
  ): void | Promise<void>;
  /** Map/watch/queue/egress already released. */
  onPtyExitAfterRelease(
    inst: AgentTerminalInstance,
    rendererTarget: PtyRendererSendTarget | null,
    details: { code: number; origin: "native" | "forced"; drained: boolean },
  ): void | Promise<void>;
}

export interface TerminalRuntimeOptions extends PtyEgressSchedulerOptions {
  /** Primary sidecar root. `TERMINA_EVENTS_DIR` stays configurable at the caller. */
  eventsDir?: string;
  /** Present when this runtime persists the terminal roster file. */
  rosterHost?: TerminalRosterHost;
}

export interface TerminalRuntimeSpawnOptions {
  id: string;
  cwd: string;
  workspaceId: string;
  type: "agent" | "shell";
  shellName?: string;
  cmd: string;
  args: string[];
  env: Record<string, string | undefined>;
  cols?: number;
  rows?: number;
  tailer: RuntimeSidecarTailer;
  /** Candidate watchReady already armed this id; do not reset its cursor. */
  skipSidecarWatch?: boolean;
  rendererTarget: PtyRendererSendTarget | null;
  /** Mutate the instance before it enters the live map. */
  setup?: (inst: AgentTerminalInstance) => void;
}

/**
 * One in-process owner for every live PTY. Clients attach and detach by
 * `terminalId` + generation; a missing viewer never pauses PTY, sidecar, or
 * the session. A separate process is still conditional and is not this module.
 */
export class TerminalRuntime {
  private terminalSeq = 0;
  private readonly terminals = new Map<string, AgentTerminalInstance>();
  private readonly sidecarQueues = new Map<string, SidecarEventQueue>();
  private readonly sidecarSources = new Map<string, RuntimeSidecarTailer>();
  private readonly egress: PtyEgressScheduler;
  readonly eventsDir: string;
  readonly tailer: SidecarTailer | null;
  private readonly rosterStore: TerminalRosterStore | null;

  constructor(
    private readonly host: TerminalRuntimeHost,
    options: TerminalRuntimeOptions = {},
  ) {
    const { eventsDir, rosterHost, ...egressOptions } = options;
    this.eventsDir = eventsDir ?? "";
    this.tailer = eventsDir ? new SidecarTailer(eventsDir) : null;
    this.rosterStore = rosterHost ? new TerminalRosterStore(rosterHost) : null;
    this.egress = new PtyEgressScheduler({
      send: (terminalId, terminalGeneration, windowGeneration, rendererGeneration, sequence, data) =>
        this.host.sendChunk(terminalId, terminalGeneration, windowGeneration, rendererGeneration, sequence, data),
      sendExit: (terminalId, terminalGeneration, windowGeneration, rendererGeneration, sequence, code) =>
        this.host.sendExit(terminalId, terminalGeneration, windowGeneration, rendererGeneration, sequence, code),
    }, egressOptions);
  }

  get(id: string): AgentTerminalInstance | undefined {
    return this.terminals.get(id);
  }

  has(id: string): boolean {
    return this.terminals.has(id);
  }

  values(): IterableIterator<AgentTerminalInstance> {
    return this.terminals.values();
  }

  keys(): IterableIterator<string> {
    return this.terminals.keys();
  }

  get size(): number {
    return this.terminals.size;
  }

  clear(): void {
    for (const [id, tailer] of this.sidecarSources) tailer.stopWatching(id);
    this.sidecarSources.clear();
    this.terminals.clear();
  }

  allocateId(): string {
    return `term-${++this.terminalSeq}`;
  }

  noteId(id: string): void {
    const m = /^term-(\d+)$/.exec(id);
    if (!m) return;
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > this.terminalSeq) this.terminalSeq = n;
  }

  /**
   * Construct the PTY, run setup, then install map/egress/watch. Setup runs
   * before the map insert so a candidate session_ready published during the
   * constructor stays on disk until projectId and session fields exist.
   */
  spawn(opts: TerminalRuntimeSpawnOptions): AgentTerminalInstance {
    const inst = new AgentTerminalInstance(
      opts.id,
      opts.cwd,
      opts.workspaceId,
      opts.type,
      opts.shellName,
      opts.cmd,
      opts.args,
      opts.env,
      opts.cols ?? 80,
      opts.rows ?? 24,
    );
    try {
      opts.setup?.(inst);
      this.adopt(inst, opts);
      return inst;
    } catch (error) {
      if (this.terminals.get(inst.id) === inst) this.release(inst);
      inst.pty.killGroup("SIGKILL");
      inst.pty.kill("SIGKILL");
      throw error;
    }
  }

  /**
   * Install a constructed instance. Production goes through spawn(); tests
   * use this to avoid a real PTY.
   */
  adopt(inst: AgentTerminalInstance, opts: Pick<TerminalRuntimeSpawnOptions, "tailer" | "skipSidecarWatch" | "rendererTarget">): void {
    if (this.terminals.has(inst.id)) throw new Error(`terminal ${inst.id} already exists`);
    this.terminals.set(inst.id, inst);
    const terminalGeneration = inst.generation;
    inst.pty.onData = (data) => this.acceptOutput(inst.id, terminalGeneration, data);
    this.egress.register(inst.id, terminalGeneration, {
      pause: () => inst.pty.pause(),
      resume: () => inst.pty.resume(),
    });
    const rendererTarget = opts.rendererTarget;
    inst.pty.onExit = async (code: number, origin: "native" | "forced" = "native") => {
      if (inst.exitHandled) return;
      inst.exitHandled = true;
      const drained = await this.egress.finish(inst.id, terminalGeneration, code, PTY_EXIT_DRAIN_TIMEOUT_MS);
      if (!drained) this.egress.cancel(inst.id, terminalGeneration);
      const details = { code, origin, drained };
      let beforeError: unknown;
      try {
        await this.host.onPtyExitBeforeRelease(inst, rendererTarget, details);
      } catch (error) {
        beforeError = error;
      } finally {
        this.release(inst);
      }
      try {
        await this.host.onPtyExitAfterRelease(inst, rendererTarget, details);
      } catch (error) {
        if (beforeError) {
          console.warn(`[main] terminal ${inst.id} after-release failed: ${(error as Error).message}`);
          throw beforeError;
        }
        throw error;
      }
      if (beforeError) throw beforeError;
    };
    this.sidecarSources.set(inst.id, opts.tailer);
    if (!opts.skipSidecarWatch) opts.tailer.watch(inst.id);
    if (inst.type === "agent") opts.tailer.setExpectedProducer(inst.id, inst.pty.pid);
  }

  /** Enqueue PTY output in the single fair, lossless delivery path. */
  acceptOutput(id: string, terminalGeneration: number, data: string): boolean {
    const inst = this.terminals.get(id);
    if (this.host.isDisposed() || !inst || inst.closed || inst.generation !== terminalGeneration) return false;
    const accepted = this.egress.enqueue(id, terminalGeneration, data);
    if (accepted) inst.notePtyOutput(data);
    return accepted;
  }

  markClosed(id: string): AgentTerminalInstance | undefined {
    const inst = this.terminals.get(id);
    if (!inst || inst.closed) return inst;
    inst.closed = true;
    this.egress.cancel(id, inst.generation);
    return inst;
  }

  /** Bind the current renderer document so per-terminal attach can hydrate. */
  attachViewer(windowGeneration: number, rendererGeneration: number): boolean {
    return this.egress.setRendererReady(windowGeneration, rendererGeneration, true);
  }

  /**
   * Drop the renderer document. The PTY keeps writing the ledger, the
   * sidecar stays on its durable cursor, and the session bundle keeps
   * appending. Next attach replays from those cursors.
   */
  detachViewer(windowGeneration: number, rendererGeneration: number): boolean {
    return this.egress.setRendererReady(windowGeneration, rendererGeneration, false);
  }

  /**
   * Hydrate one terminal for the current viewer. Replays the PTY ledger
   * from the unacked cursor. Does not call watch() — that would start a
   * new sidecar lifecycle and drop the durable cursor.
   */
  attach(
    terminalId: string,
    terminalGeneration: number,
    windowGeneration: number,
    rendererGeneration: number,
  ): boolean {
    const inst = this.terminals.get(terminalId);
    if (!inst || inst.closed || inst.generation !== terminalGeneration) return false;
    return this.egress.hydrateTerminal(terminalId, terminalGeneration, windowGeneration, rendererGeneration);
  }

  saveRoster(path: string, terminals: RosterTerminal[], unrestored: TerminalRosterEntry[]): void {
    if (!this.rosterStore) throw new Error("terminal runtime has no roster store");
    this.rosterStore.save(path, terminals, unrestored);
  }

  loadRoster(path: string): Promise<{ exists: boolean; entries: TerminalRosterEntry[] }> {
    return loadRosterFile(path);
  }

  drainRoster(): Promise<void> {
    if (!this.rosterStore) throw new Error("terminal runtime has no roster store");
    return this.rosterStore.drain();
  }

  acknowledge(
    terminalId: string,
    terminalGeneration: number,
    windowGeneration: number,
    rendererGeneration: number,
    sequence: number,
  ): boolean {
    return this.egress.acknowledge(terminalId, terminalGeneration, windowGeneration, rendererGeneration, sequence);
  }

  cancel(terminalId: string, terminalGeneration: number): void {
    this.egress.cancel(terminalId, terminalGeneration);
  }

  disposeEgress(): void {
    this.egress.dispose();
  }

  enqueueSidecar(terminalId: string, event: SidecarEvent): SidecarEventDelivery {
    if (!this.host.shouldAdmitSidecar(terminalId)) return { accepted: false };
    let queue = this.sidecarQueues.get(terminalId);
    if (!queue) {
      queue = new SidecarEventQueue(
        (queuedEvent) => this.host.onSidecarEvent(terminalId, queuedEvent),
        { onError: (error, failedEvent) => this.host.onSidecarError(error, failedEvent) },
      );
      this.sidecarQueues.set(terminalId, queue);
    }
    return queue.enqueueTracked(event);
  }

  async drainSidecarQueues(ids?: Iterable<string>): Promise<void> {
    const target = ids === undefined ? null : new Set(ids);
    while (true) {
      const pending = [...this.sidecarQueues]
        .filter(([id]) => target === null || target.has(id))
        .filter(([, queue]) => {
          const stats = queue.stats();
          return stats.items > 0 || stats.inFlight > 0;
        })
        .map(([, queue]) => queue.drain());
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }

  clearSidecarQueues(ids?: Iterable<string>): void {
    if (ids === undefined) {
      this.sidecarQueues.clear();
      return;
    }
    for (const id of ids) this.sidecarQueues.delete(id);
  }

  deleteSidecarQueue(id: string): void {
    this.sidecarQueues.delete(id);
  }

  stopSidecar(id: string): void {
    this.sidecarSources.get(id)?.stopWatching(id);
  }

  private release(inst: AgentTerminalInstance): void {
    this.terminals.delete(inst.id);
    this.sidecarSources.get(inst.id)?.stopWatching(inst.id);
    this.sidecarSources.delete(inst.id);
    this.sidecarQueues.delete(inst.id);
    this.egress.cancel(inst.id, inst.generation);
  }
}
