/**
 * In-process terminal lifecycle.
 *
 * Owns the live instance map, PTY spawn/exit, the egress ledger, the primary
 * events dir + tailer, candidate sidecar tailers (distinct events dirs), the
 * roster file store, sidecar watch/queue, generation fencing, and the viewer
 * registry. Viewers subscribe; none own the session triple (PTY + sidecar +
 * core bundle). Main is a client: it validates IPC, folds activity, and owns
 * projects/leases/snapshots. Renderer attach stays `readyTerminal` /
 * `acknowledgePtyData` — this module does not add IPC.
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
  type LoadedRoster,
  type RosterTerminal,
  type TerminalRosterHost,
} from "./roster-store.js";
import type { TerminalRosterEntry } from "./terminal-roster.js";
import { AgentTerminalInstance } from "./terminal-instance.js";

/** Exit teardown waits this long for the renderer to acknowledge the PTY
 *  tail before cancelling it: crash/reload cycles finish well inside, while
 *  a wedged renderer cannot stall teardown (and subagent cleanup) forever. */
const PTY_EXIT_DRAIN_TIMEOUT_MS = 10_000;

/** Tailer surface the runtime watches and stops. SidecarTailer is assignable. */
export interface RuntimeSidecarTailer {
  watch(id: string): void;
  stopWatching(id: string): void;
  setExpectedProducer(id: string, pid: number): void;
  /** Dedicated candidate tailers shut down their watcher/timer here. */
  stop?(): void;
  start?(): void;
  watchReady?(id: string): Promise<boolean>;
}

interface SidecarWatch {
  tailer: RuntimeSidecarTailer;
  generation: number;
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
  /** Revoke live authority on close/exit, before output drain. May be repeated.
   * Optional: hosts without live-authority consumers (e.g. no computer
   * control) simply omit it. */
  onPtyStopping?(inst: AgentTerminalInstance): void;
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
  /** Modifier reporting or application cursor keys changed on queued output. */
  onPtyKeyboardMode?(id: string, generation: number): void;
}

export interface TerminalRuntimeOptions extends PtyEgressSchedulerOptions {
  /** Primary sidecar root. `TERMINA_EVENTS_DIR` stays configurable at the caller. */
  eventsDir?: string;
  /** Present when this runtime persists the terminal roster file. */
  rosterHost?: TerminalRosterHost;
}

/** Renderer pane. Detach drops this viewer; it does not pause the PTY. */
const RENDERER_VIEWER_ID = "renderer";

export function worldlineViewerId(comparisonId: string, label: string): string {
  return `worldline:${comparisonId}:${label}`;
}

export function dispatchViewerId(ownerId: string): string {
  return `dispatch:${ownerId}`;
}

export function subagentViewerId(runId: string): string {
  return `subagent:${runId}`;
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
  /** Main's synchronous admission boundary, before a child process exists. */
  beforeSpawn?: (target: { id: string; generation: number }) => void;
  /** Mutate the instance before it enters the live map. */
  setup?: (inst: AgentTerminalInstance) => void;
}

/**
 * One in-process owner for every live PTY. Clients attach and detach by
 * `terminalId` + generation; a missing viewer never pauses PTY, sidecar, or
 * the session. A separate process is still conditional and is not this module.
 */
export class TerminalRuntime {
  private windowGeneration = 0;
  private windowClosing = false;
  private rendererAttached = false;
  private quitting = false;
  private readonly mutations = new Map<string, { owner: AgentTerminalInstance; streamId: string; release: (() => void) | null }>();
  private readonly closeWaiters = new Set<() => void>();
  private terminalSeq = 0;
  private readonly terminals = new Map<string, AgentTerminalInstance>();
  /** A forced logical release does not complete node-pty's native callback. */
  private readonly nativeExits = new Set<AgentTerminalInstance>();
  private egressDisposed = false;
  private readonly pendingSourceDrains = new Map<AgentTerminalInstance, () => void>();
  private readonly sidecarQueues = new Map<string, SidecarEventQueue>();
  private readonly sidecarSources = new Map<string, SidecarWatch>();
  /** Distinct candidate tailers (own events dirs). Never the primary tailer. */
  private readonly candidateSidecars = new Map<string, RuntimeSidecarTailer>();
  /** Watch generation bound to a live instance so a recycled term-N cannot
   *  cancel a later worldline's watch. */
  private readonly instanceSidecarGenerations = new WeakMap<AgentTerminalInstance, number>();
  private sidecarWatchSeq = 0;
  /** Live viewers per terminal. Empty does not pause PTY, sidecar, or session. */
  private readonly viewers = new Map<string, Set<string>>();
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

  openWindow(generation: number): void {
    if (this.quitting || generation <= this.windowGeneration) return;
    this.windowGeneration = generation;
    this.windowClosing = false;
  }

  /** Finish already admitted actions before the UI disappears; admit no new ones. */
  prepareWindowClose(generation: number): Promise<void> {
    if (generation !== this.windowGeneration || this.quitting) return Promise.resolve();
    this.windowClosing = true;
    if (this.mutations.size === 0) return Promise.resolve();
    return new Promise(resolve => { this.closeWaiters.add(resolve); });
  }

  private mutationViewerPresent(owner: AgentTerminalInstance): boolean {
    return !this.quitting && !this.windowClosing && !this.host.isDisposed()
      && !owner.closed && !owner.pty.hasExited && this.terminals.get(owner.id) === owner
      && this.rendererAttached;
  }

  /** Main supplies the canonical workspace lease. Other subscribers cannot approve writes. */
  async admitMutation(
    owner: AgentTerminalInstance,
    streamId: string,
    requestId: string,
    acquire: () => Promise<(() => void) | null>,
  ): Promise<{ ok: true } | { ok: false; needsApproval?: true; error: string }> {
    const detached = () => ({ ok: false as const, needsApproval: true as const, error: "Reopen the window and approve this action to continue." });
    if (!this.mutationViewerPresent(owner)) return detached();
    const key = JSON.stringify([streamId, requestId]);
    if (this.mutations.has(key)) return { ok: false, error: "action is already admitted" };
    const action = { owner, streamId, release: null as (() => void) | null };
    this.mutations.set(key, action);
    try {
      const release = await acquire();
      if (!release) return { ok: false, error: "the source files are busy or no longer available" };
      action.release = release;
      if (this.mutations.get(key) !== action || !this.mutationViewerPresent(owner)) return detached();
      return { ok: true };
    } finally {
      if (action.release === null || this.mutations.get(key) !== action || !this.mutationViewerPresent(owner)) {
        action.release?.();
        action.release = null;
        if (this.mutations.get(key) === action) this.mutations.delete(key);
        this.resolveWindowClose();
      }
    }
  }

  finishMutation(streamId: string, requestId?: string): void {
    for (const [key, action] of this.mutations) {
      if (action.streamId !== streamId || (requestId !== undefined && key !== JSON.stringify([streamId, requestId]))) continue;
      this.mutations.delete(key);
      action.release?.();
      action.release = null;
    }
    this.resolveWindowClose();
  }

  private resolveWindowClose(): void {
    if (this.mutations.size > 0) return;
    for (const resolve of this.closeWaiters) resolve();
    this.closeWaiters.clear();
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

  /** Includes logically released instances until their native exit arrives. */
  nativeValues(): IterableIterator<AgentTerminalInstance> {
    return this.nativeExits.values();
  }

  private trackNativeExit(inst: AgentTerminalInstance): void {
    if (this.nativeExits.has(inst)) return;
    this.nativeExits.add(inst);
    inst.pty.onNativeExit = () => {
      this.nativeExits.delete(inst);
      this.finishMutation(inst.id);
    };
  }

  clear(): void {
    for (const id of [...this.sidecarSources.keys()]) this.stopSidecar(id);
    this.sidecarSources.clear();
    for (const [id, tailer] of this.candidateSidecars) {
      tailer.stopWatching(id);
      tailer.stop?.();
    }
    this.candidateSidecars.clear();
    this.terminals.clear();
    this.viewers.clear();
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
      opts.type === "agent" ? { ...opts.env, TERMINA_HOST_PID: String(process.pid) } : opts.env,
      opts.cols ?? 80,
      opts.rows ?? 24,
      opts.beforeSpawn,
    );
    this.trackNativeExit(inst);
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
    this.trackNativeExit(inst);
    const completeNativeExit = inst.pty.onNativeExit;
    this.terminals.set(inst.id, inst);
    const terminalGeneration = inst.generation;
    inst.pty.onData = (data) => this.acceptOutput(inst.id, terminalGeneration, data);
    this.egress.register(inst.id, terminalGeneration, {
      pause: () => inst.pty.pause(),
      resume: () => inst.pty.resume(),
    });
    const rendererTarget = opts.rendererTarget;
    let exitDeadline: number | null = null;
    let sourceTailCancelled = false;
    let sourceDrainTimer: ReturnType<typeof setTimeout> | null = null;
    inst.pty.onNativeExit = () => {
      completeNativeExit();
      if (inst.exitHandled || exitDeadline !== null || this.terminals.get(inst.id) !== inst) return;
      exitDeadline = Date.now() + PTY_EXIT_DRAIN_TIMEOUT_MS;
      this.host.onPtyStopping?.(inst);
      // Do not finish egress yet: that closes admission to the source tail.
      // Cancel the unadmitted tail only when the shared deadline expires.
      const cancelTail = () => {
        sourceTailCancelled = true;
        inst.pty.cancelOutput();
      };
      if (this.egressDisposed) cancelTail();
      else {
        this.pendingSourceDrains.set(inst, cancelTail);
        sourceDrainTimer = setTimeout(cancelTail, PTY_EXIT_DRAIN_TIMEOUT_MS);
      }
    };
    inst.pty.onExit = async (code: number, origin: "native" | "forced" = "native") => {
      if (inst.exitHandled) return;
      inst.exitHandled = true;
      if (exitDeadline === null) this.host.onPtyStopping?.(inst);
      if (sourceDrainTimer !== null) clearTimeout(sourceDrainTimer);
      this.pendingSourceDrains.delete(inst);
      const remaining = exitDeadline === null ? PTY_EXIT_DRAIN_TIMEOUT_MS : Math.max(0, exitDeadline - Date.now());
      const egressDrained = await this.egress.finish(inst.id, terminalGeneration, code, remaining);
      const drained = egressDrained && !sourceTailCancelled;
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
    this.bindInstanceSidecar(inst, opts.tailer, opts.skipSidecarWatch === true);
    const source = this.sidecarSources.get(inst.id)?.tailer ?? opts.tailer;
    if (inst.type === "agent") source.setExpectedProducer(inst.id, inst.pty.pid);
  }

  /** Enqueue PTY output in the single fair, lossless delivery path. */
  acceptOutput(id: string, terminalGeneration: number, data: string): boolean {
    const inst = this.terminals.get(id);
    if (this.host.isDisposed() || !inst || inst.closed || inst.generation !== terminalGeneration) return false;
    const accepted = this.egress.enqueue(id, terminalGeneration, data);
    if (accepted && inst.notePtyOutput(data)) this.host.onPtyKeyboardMode?.(id, terminalGeneration);
    return accepted;
  }

  markClosed(id: string): AgentTerminalInstance | undefined {
    const inst = this.terminals.get(id);
    if (!inst || inst.closed) return inst;
    inst.closed = true;
    this.host.onPtyStopping?.(inst);
    this.egress.cancel(id, inst.generation);
    inst.pty.cancelOutput();
    return inst;
  }

  /** Bind the current renderer document so per-terminal attach can hydrate. */
  attachViewer(windowGeneration: number, rendererGeneration: number): boolean {
    const accepted = this.egress.setRendererReady(windowGeneration, rendererGeneration, true);
    if (accepted) this.rendererAttached = true;
    return accepted;
  }

  /**
   * Drop the renderer document. The PTY keeps writing the ledger, the
   * sidecar stays on its durable cursor, and the session bundle keeps
   * appending. Next attach replays from those cursors. Never calls
   * stopWatching — that is destroy-only.
   */
  detachViewer(windowGeneration: number, rendererGeneration: number): boolean {
    if (!this.egress.setRendererReady(windowGeneration, rendererGeneration, false)) return false;
    this.rendererAttached = false;
    this.unsubscribeViewer(RENDERER_VIEWER_ID);
    return true;
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
    const hydrated = this.egress.hydrateTerminal(terminalId, terminalGeneration, windowGeneration, rendererGeneration);
    if (hydrated) this.subscribe(terminalId, RENDERER_VIEWER_ID);
    return hydrated;
  }

  /** Register a viewer. Missing terminals refuse; an empty set never pauses the session. */
  subscribe(terminalId: string, viewerId: string): boolean {
    const inst = this.terminals.get(terminalId);
    if (!viewerId || !inst || inst.closed) return false;
    let set = this.viewers.get(terminalId);
    if (!set) {
      set = new Set();
      this.viewers.set(terminalId, set);
    }
    set.add(viewerId);
    return true;
  }

  unsubscribe(terminalId: string, viewerId: string): boolean {
    const set = this.viewers.get(terminalId);
    if (!set || !set.delete(viewerId)) return false;
    if (set.size === 0) this.viewers.delete(terminalId);
    return true;
  }

  unsubscribeViewer(viewerId: string): void {
    for (const [terminalId, set] of this.viewers) {
      set.delete(viewerId);
      if (set.size === 0) this.viewers.delete(terminalId);
    }
  }

  saveRoster(path: string, terminals: RosterTerminal[], unrestored: TerminalRosterEntry[]): void {
    if (!this.rosterStore) throw new Error("terminal runtime has no roster store");
    this.rosterStore.save(path, terminals, unrestored);
  }

  loadRoster(path: string): Promise<LoadedRoster> {
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

  disposeEgress(): void {
    this.quitting = true;
    this.egressDisposed = true;
    this.egress.dispose();
    for (const cancelTail of this.pendingSourceDrains.values()) cancelTail();
    for (const inst of this.terminals.values()) inst.pty.cancelOutput();
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

  /**
   * Create and start a candidate-owned tailer for a distinct events dir.
   * Does not watch; call watchCandidateReady before spawn so the cursor is
   * durable. Never merges into the primary tailer.
   */
  startCandidateSidecar(id: string, eventsDir: string): SidecarTailer {
    if (!eventsDir) throw new Error("candidate events directory is missing");
    if (this.terminals.has(id)) throw new Error(`terminal ${id} already exists`);
    const tailer = new SidecarTailer(eventsDir);
    this.ownCandidateSidecar(id, tailer);
    return tailer;
  }

  /**
   * Own a distinct candidate tailer. Tests pass a fake; production uses
   * startCandidateSidecar. Does not call watch() — watchCandidateReady arms
   * the cursor, or adopt({ skipSidecarWatch: true }) keeps it.
   */
  ownCandidateSidecar(id: string, tailer: RuntimeSidecarTailer): void {
    if (this.terminals.has(id)) throw new Error(`terminal ${id} already exists`);
    if (this.sidecarSources.has(id) || this.candidateSidecars.has(id)) this.stopSidecar(id);
    this.candidateSidecars.set(id, tailer);
    this.installSidecarSource(id, tailer);
    tailer.start?.();
  }

  hasCandidateSidecar(id: string): boolean {
    return this.candidateSidecars.has(id);
  }

  /** Establish a durable startup cursor on the candidate-owned tailer. */
  watchCandidateReady(id: string): Promise<boolean> {
    const tailer = this.candidateSidecars.get(id);
    if (!tailer) return Promise.resolve(false);
    if (tailer.watchReady) return tailer.watchReady(id);
    tailer.watch(id);
    return Promise.resolve(true);
  }

  /**
   * Tail a sidecar id that has no PTY instance (child streams). Defaults to
   * the primary tailer. Destroy via stopSidecar — never a second stopWatching.
   */
  watchSidecar(id: string, tailer?: RuntimeSidecarTailer): void {
    const source = tailer ?? this.tailer;
    if (!source) return;
    this.installSidecarSource(id, source);
    source.watch(id);
  }

  /**
   * Destroy-path only. Viewer detach must never call this.
   * Pass `generation` after a recycle-prone await so a stale close cannot
   * cancel a later watch on the same term-N. Omit it only for intentional
   * destroy of the current watch (clear, replace, unique child ids).
   */
  stopSidecar(id: string, generation?: number): void {
    this.stopSidecarWatch(id, generation);
  }

  /** Current sidecar watch generation, or undefined when this id is not watched. */
  sidecarWatchGeneration(id: string): number | undefined {
    return this.sidecarSources.get(id)?.generation;
  }

  private installSidecarSource(id: string, tailer: RuntimeSidecarTailer): number {
    const generation = ++this.sidecarWatchSeq;
    this.sidecarSources.set(id, { tailer, generation });
    return generation;
  }

  private bindInstanceSidecar(inst: AgentTerminalInstance, tailer: RuntimeSidecarTailer, skipWatch: boolean): void {
    const existing = this.sidecarSources.get(inst.id);
    if (existing) {
      // Keep the armed cursor. A candidate watchReady already owns this id.
      this.instanceSidecarGenerations.set(inst, existing.generation);
      return;
    }
    const generation = this.installSidecarSource(inst.id, tailer);
    this.instanceSidecarGenerations.set(inst, generation);
    if (!skipWatch) tailer.watch(inst.id);
  }

  /**
   * Stop the current watch for `id`, or no-op when `generation` no longer
   * owns it (recycled term-N). Dedicated candidate tailers are stop()'d.
   */
  private stopSidecarWatch(id: string, generation?: number): void {
    const watch = this.sidecarSources.get(id);
    if (!watch) {
      const leftover = this.candidateSidecars.get(id);
      if (leftover && generation === undefined) {
        this.candidateSidecars.delete(id);
        leftover.stop?.();
      }
      return;
    }
    if (generation !== undefined && watch.generation !== generation) return;
    this.sidecarSources.delete(id);
    const dedicated = this.candidateSidecars.get(id);
    if (dedicated === watch.tailer) this.candidateSidecars.delete(id);
    watch.tailer.stopWatching(id);
    if (dedicated === watch.tailer) dedicated.stop?.();
  }

  private release(inst: AgentTerminalInstance): void {
    const generation = this.instanceSidecarGenerations.get(inst);
    if (this.terminals.get(inst.id) === inst) {
      this.terminals.delete(inst.id);
      this.viewers.delete(inst.id);
      this.sidecarQueues.delete(inst.id);
      this.egress.cancel(inst.id, inst.generation);
    }
    this.stopSidecarWatch(inst.id, generation);
  }
}
