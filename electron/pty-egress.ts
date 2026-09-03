/**
 * Lossless PTY output delivery from Electron's main process to its renderer.
 *
 * The renderer is an explicitly hydrated consumer. Every admitted PTY
 * quantum has a terminal-local sequence number and remains owned by this
 * scheduler until the renderer acknowledges that xterm has consumed it.
 * Consequently the source high-water mark covers both queued and in-flight
 * bytes: Chromium cannot silently become an unbounded second queue while a
 * renderer is slow or wedged.
 */

export const PTY_EGRESS_CHUNK_BYTES = 64 * 1024;
export const PTY_EGRESS_QUEUE_HIGH_WATER_BYTES = 2 * 1024 * 1024;
export const PTY_EGRESS_QUEUE_HIGH_WATER_CHUNKS = 128;
/** Maximum work sent by one scheduler turn before yielding to Electron. */
const PTY_EGRESS_BATCH_BYTES = 256 * 1024;
const PTY_EGRESS_BATCH_CHUNKS = 16;

/** Identity captured by a renderer lifecycle callback. */
export interface PtyDocumentIdentity {
  window: object;
  windowGeneration: number;
  rendererGeneration: number;
  nonce: string;
}

/** Identity captured by a same-WebContents lifecycle callback. */
export interface PtyLifecycleIdentity extends PtyDocumentIdentity {
  loadGeneration: number;
  processId: number;
  frameRoutingId: number;
}

/** Minimal WebContents surface used by the generic renderer send guard. */
export interface PtyRendererWebContents {
  isDestroyed(): boolean;
  isCrashed(): boolean;
  send(channel: string, payload: unknown): void;
}

/** Exact outbound owner for one renderer document. */
export interface PtyRendererSendTarget {
  window: { isDestroyed(): boolean } & object;
  webContents: PtyRendererWebContents;
  windowGeneration: number;
  rendererGeneration: number;
  nonce: string;
}

/** Exact identity check for a generic main-to-renderer callback. */
export function isPtyRendererSendTargetCurrent(
  current: PtyRendererSendTarget | null,
  expected: PtyRendererSendTarget,
): boolean {
  return current !== null
    && current.window === expected.window
    && current.webContents === expected.webContents
    && current.windowGeneration === expected.windowGeneration
    && current.rendererGeneration === expected.rendererGeneration
    && current.nonce === expected.nonce;
}

/**
 * Deliver one generic renderer push only while its exact document is live.
 * BrowserWindow/WebContents teardown can race the checks, so all destruction
 * probes and the synchronous send are deliberately contained by one catch.
 */
export function sendPtyRendererMessage(
  current: PtyRendererSendTarget | null,
  expected: PtyRendererSendTarget,
  ready: boolean,
  channel: string,
  payload: unknown,
): boolean {
  if (!ready || !isPtyRendererSendTargetCurrent(current, expected)) return false;
  try {
    if (expected.window.isDestroyed() || expected.webContents.isDestroyed() || expected.webContents.isCrashed()) return false;
    expected.webContents.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}

/** Exact identity check used to fence delayed BrowserWindow callbacks. */
export function isPtyDocumentCurrent(current: PtyDocumentIdentity | null, expected: PtyDocumentIdentity): boolean {
  return current !== null
    && current.window === expected.window
    && current.windowGeneration === expected.windowGeneration
    && current.rendererGeneration === expected.rendererGeneration
    && current.nonce === expected.nonce;
}

/** Exact identity check for load/crash callbacks on one BrowserWindow. */
export function isPtyLifecycleCurrent(current: PtyLifecycleIdentity | null, expected: PtyLifecycleIdentity): boolean {
  if (!current || !isPtyDocumentCurrent(current, expected)) return false;
  return current.loadGeneration === expected.loadGeneration
    && current.processId === expected.processId
    && current.frameRoutingId === expected.frameRoutingId;
}

/**
 * Validate a main-frame lifecycle event against the pending navigation.  The
 * event-specific process/routing pair is part of the predicate rather than a
 * separate caller convention, so a frame event cannot accidentally complete
 * or fail a different document load.
 */
export function isPtyFrameEventCurrent(
  current: PtyLifecycleIdentity | null,
  expected: PtyLifecycleIdentity,
  processId: number,
  frameRoutingId: number,
): boolean {
  return Number.isSafeInteger(processId)
    && processId >= 1
    && Number.isSafeInteger(frameRoutingId)
    && frameRoutingId >= 1
    && isPtyLifecycleCurrent(current, expected)
    && expected.processId === processId
    && expected.frameRoutingId === frameRoutingId;
}

/**
 * The only readiness proof that carries a per-document capability. Generic
 * WebContents finish/failure events cannot provide this nonce and therefore
 * must never be used as an alternative readiness transition.
 */
export function isPtyReadyHandshakeCurrent(
  current: PtyLifecycleIdentity | null,
  expected: PtyLifecycleIdentity,
  providedNonce: unknown,
  processId: number,
  frameRoutingId: number,
): boolean {
  return isPtyFrameEventCurrent(current, expected, processId, frameRoutingId)
    && isPtyDocumentNonce(expected.nonce, providedNonce);
}

/** Validate the main-issued document capability carried by pty:ready. */
export function isPtyDocumentNonce(expected: string, provided: unknown): provided is string {
  return expected.length > 0 && typeof provided === "string" && provided.length === expected.length && provided === expected;
}

export interface PtyEgressSource {
  /** Stop reading from the PTY until the queue crosses low-water. */
  pause(): void;
  /** Resume reading after the queue crosses low-water. */
  resume(): void;
}

export interface PtyEgressTransport {
  /**
   * Deliver one already-bounded chunk to the current renderer document.
   * Returning false means that the renderer did not accept the IPC message;
   * the chunk remains owned by the scheduler and is retried after reload.
   */
  send(
    terminalId: string,
    terminalGeneration: number,
    windowGeneration: number,
    rendererGeneration: number,
    sequence: number,
    data: string,
  ): boolean | void;
  /** Deliver the terminal's ordered, replayable natural-exit marker. */
  sendExit(
    terminalId: string,
    terminalGeneration: number,
    windowGeneration: number,
    rendererGeneration: number,
    sequence: number,
    code: number,
  ): boolean | void;
}

export interface PtyEgressSchedulerOptions {
  maxQueueBytes?: number;
  maxQueueChunks?: number;
  lowWaterBytes?: number;
  lowWaterChunks?: number;
  batchBytes?: number;
  batchChunks?: number;
  /** Delay before the next bounded batch. Zero still yields a macrotask. */
  yieldMs?: number;
}

export interface PtyEgressQueueStats {
  /** Bytes/chunks waiting for IPC admission. */
  queuedBytes: number;
  queuedChunks: number;
  /** Bytes/chunks accepted by IPC but awaiting renderer acknowledgement. */
  inFlightBytes: number;
  inFlightChunks: number;
  /** The only memory bound that matters to downstream IPC. */
  retainedBytes: number;
  retainedChunks: number;
  paused: boolean;
  closing: boolean;
  hydrated: boolean;
  terminalGeneration: number;
  windowGeneration: number;
  rendererGeneration: number;
}

interface QueuedChunk {
  kind: "data";
  data: string;
  bytes: number;
  sequence: number;
}

interface ExitMarker {
  kind: "exit";
  code: number;
  bytes: 0;
  sequence: number;
}

type EgressRecord = QueuedChunk | ExitMarker;

interface TerminalQueue {
  id: string;
  terminalGeneration: number;
  source: PtyEgressSource;
  chunks: EgressRecord[];
  queuedBytes: number;
  inFlight: Map<number, EgressRecord>;
  inFlightBytes: number;
  nextSequence: number;
  paused: boolean;
  closing: boolean;
  hydrated: boolean;
  finishCode: number | null;
  exitQueued: boolean;
  finishWaiters: Array<(delivered: boolean) => void>;
}

interface DrainWaiter {
  terminalId?: string;
  resolve: () => void;
}

function asPositiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`invalid PTY egress ${name}`);
  return result;
}

/**
 * Split by UTF-8 byte budget without splitting a surrogate pair. PTY output
 * is decoded to a JavaScript string before it reaches this boundary, so a
 * renderer chunk never turns a code point into replacement characters.
 *
 * This is a generator deliberately: an oversized native onData callback is
 * split before queue admission and does not first become an unbounded array
 * of chunks. PtyTerminal uses the same helper at the source boundary.
 */
export function* splitPtyData(data: string, maxBytes = PTY_EGRESS_CHUNK_BYTES): Generator<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("invalid PTY egress chunk size");
  let start = 0;
  while (start < data.length) {
    let end = start;
    let bytes = 0;
    while (end < data.length) {
      const codePoint = data.codePointAt(end);
      if (codePoint === undefined) break;
      const width = codePoint > 0xffff ? 2 : 1;
      const codeBytes = Buffer.byteLength(data.slice(end, end + width), "utf8");
      if (end > start && bytes + codeBytes > maxBytes) break;
      end += width;
      bytes += codeBytes;
    }
    // maxBytes is normally much larger than the largest UTF-8 code point,
    // but retain a defensive progress guarantee for tiny test budgets.
    if (end === start) end = Math.min(data.length, start + 1);
    yield data.slice(start, end);
    start = end;
  }
}

/** One shared fair, bounded scheduler for all live PTY terminals. */
export class PtyEgressScheduler {
  private readonly maxQueueBytes: number;
  private readonly maxQueueChunks: number;
  private readonly lowWaterBytes: number;
  private readonly lowWaterChunks: number;
  private readonly batchBytes: number;
  private readonly batchChunks: number;
  private readonly yieldMs: number;
  private readonly queues = new Map<string, TerminalQueue>();
  private order: string[] = [];
  private cursor = 0;
  private rendererReady = false;
  private windowGeneration = 0;
  private rendererGeneration = 0;
  private disposed = false;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private pumping = false;
  private drainWaiters: DrainWaiter[] = [];

  constructor(
    private readonly transport: PtyEgressTransport,
    options: PtyEgressSchedulerOptions = {},
  ) {
    this.maxQueueBytes = asPositiveInteger(options.maxQueueBytes, PTY_EGRESS_QUEUE_HIGH_WATER_BYTES, "byte high-water mark");
    this.maxQueueChunks = asPositiveInteger(options.maxQueueChunks, PTY_EGRESS_QUEUE_HIGH_WATER_CHUNKS, "chunk high-water mark");
    this.lowWaterBytes = asPositiveInteger(options.lowWaterBytes, Math.floor(this.maxQueueBytes / 2), "byte low-water mark");
    this.lowWaterChunks = asPositiveInteger(options.lowWaterChunks, Math.floor(this.maxQueueChunks / 2), "chunk low-water mark");
    if (this.lowWaterBytes >= this.maxQueueBytes || this.lowWaterChunks >= this.maxQueueChunks) {
      throw new Error("PTY egress low-water marks must be below high-water marks");
    }
    this.batchBytes = asPositiveInteger(options.batchBytes, PTY_EGRESS_BATCH_BYTES, "batch byte budget");
    this.batchChunks = asPositiveInteger(options.batchChunks, PTY_EGRESS_BATCH_CHUNKS, "batch chunk budget");
    const yieldMs = options.yieldMs ?? 0;
    if (!Number.isSafeInteger(yieldMs) || yieldMs < 0) throw new Error("invalid PTY egress yield delay");
    this.yieldMs = yieldMs;
  }

  /** Register exactly one source owner for a terminal id/generation pair. */
  register(terminalId: string, terminalGeneration: number, source: PtyEgressSource): void {
    if (this.disposed) return;
    if (!terminalId || !Number.isSafeInteger(terminalGeneration) || terminalGeneration < 1) {
      throw new Error("invalid PTY egress terminal generation");
    }
    if (this.queues.has(terminalId)) throw new Error("PTY egress terminal is already registered");
    const queue: TerminalQueue = {
      id: terminalId,
      terminalGeneration,
      source,
      chunks: [],
      queuedBytes: 0,
      inFlight: new Map(),
      inFlightBytes: 0,
      nextSequence: 1,
      paused: false,
      closing: false,
      hydrated: false,
      finishCode: null,
      exitQueued: false,
      finishWaiters: [],
    };
    this.queues.set(terminalId, queue);
    this.order.push(terminalId);
    if (!this.canDeliver(queue)) this.pauseSource(queue);
  }

  /**
   * Admit one source quantum. PtyTerminal splits native callbacks before
   * calling this method; the defensive size check ensures an accidental
   * oversized callback can never bypass the queue high-water mark.
   *
   * A false result means the source violated its pause contract and must
   * retry the same quantum after observing resume(). No bytes are dropped.
   */
  enqueue(terminalId: string, terminalGeneration: number, data: string): boolean {
    const queue = this.queues.get(terminalId);
    if (
      this.disposed
      || !queue
      || queue.terminalGeneration !== terminalGeneration
      || queue.closing
      || typeof data !== "string"
    ) return false;
    if (data.length === 0) return true;
    if (Buffer.byteLength(data, "utf8") > PTY_EGRESS_CHUNK_BYTES) {
      // The source adapter owns splitting. Rejecting rather than admitting
      // this quantum is what keeps one callback from bypassing high-water.
      this.pauseSource(queue);
      return false;
    }
    const bytes = Buffer.byteLength(data, "utf8");
    const retainedBytes = this.retainedBytes(queue);
    const retainedChunks = this.retainedChunks(queue);
    if (retainedBytes + bytes > this.maxQueueBytes || retainedChunks + 1 > this.maxQueueChunks) {
      this.pauseSource(queue);
      return false;
    }
    queue.chunks.push({ kind: "data", data, bytes, sequence: queue.nextSequence++ });
    queue.queuedBytes += bytes;
    if (this.retainedBytes(queue) >= this.maxQueueBytes || this.retainedChunks(queue) >= this.maxQueueChunks) {
      this.pauseSource(queue);
    }
    this.schedulePump();
    return true;
  }

  /**
   * Mark a naturally exited PTY. Its ordered exit marker is queued only after
   * every accepted output chunk has been acknowledged, and the terminal is
   * retained until that marker is acknowledged by the hydrated renderer.
   */
  finish(terminalId: string, terminalGeneration: number, code = 0): Promise<boolean> {
    const queue = this.queues.get(terminalId);
    if (this.disposed || !queue || queue.terminalGeneration !== terminalGeneration) return Promise.resolve(false);
    if (!queue.closing) {
      queue.closing = true;
      queue.finishCode = Number.isSafeInteger(code) ? code : 0;
      this.pauseSource(queue);
    }
    this.maybeQueueExit(queue);
    return new Promise<boolean>((resolve) => {
      queue.finishWaiters.push(resolve);
      this.maybeFinishQueue(queue);
      this.schedulePump();
    });
  }

  /** Cancel a terminal whose close is user-initiated or part of teardown. */
  cancel(terminalId: string, terminalGeneration: number): void {
    const queue = this.queues.get(terminalId);
    if (!queue || queue.terminalGeneration !== terminalGeneration) return;
    this.removeQueue(queue, false);
    this.resolveDrainWaiters();
  }

  /**
   * Set the current renderer document. Both generations are required:
   * windowGeneration fences delayed events from an old BrowserWindow, while
   * rendererGeneration fences acknowledgements from an old reload/crash.
   * Switching documents replays every unacknowledged chunk in sequence order.
   */
  setRendererReady(windowGeneration: number, rendererGeneration: number, ready: boolean): boolean {
    if (
      this.disposed
      || !Number.isSafeInteger(windowGeneration)
      || windowGeneration < 1
      || !Number.isSafeInteger(rendererGeneration)
      || rendererGeneration < 1
    ) return false;
    if (windowGeneration < this.windowGeneration) return false;
    if (windowGeneration === this.windowGeneration && rendererGeneration < this.rendererGeneration) return false;

    const changed = windowGeneration !== this.windowGeneration || rendererGeneration !== this.rendererGeneration;
    if (changed) {
      this.windowGeneration = windowGeneration;
      this.rendererGeneration = rendererGeneration;
      this.replayInFlight();
      for (const queue of this.queues.values()) queue.hydrated = false;
    }
    this.rendererReady = ready;
    if (!ready) {
      this.replayInFlight();
      for (const queue of this.queues.values()) {
        // Readiness loss can be reported without a generation transition
        // (for example did-fail-load). Do not let the old document's
        // hydration gate survive that lifecycle boundary.
        queue.hydrated = false;
        this.pauseSource(queue);
      }
      if (this.pumpTimer !== null) {
        clearTimeout(this.pumpTimer);
        this.pumpTimer = null;
      }
      return true;
    }
    for (const queue of this.queues.values()) this.maybeResumeSource(queue);
    for (const queue of [...this.queues.values()]) this.maybeFinishQueue(queue);
    this.schedulePump();
    return true;
  }

  /** Explicit per-terminal hydration handshake from the renderer. */
  hydrateTerminal(
    terminalId: string,
    terminalGeneration: number,
    windowGeneration: number,
    rendererGeneration: number,
  ): boolean {
    const queue = this.queues.get(terminalId);
    if (
      this.disposed
      || !this.rendererReady
      || !queue
      || queue.terminalGeneration !== terminalGeneration
      || windowGeneration !== this.windowGeneration
      || rendererGeneration !== this.rendererGeneration
    ) return false;
    queue.hydrated = true;
    this.maybeResumeSource(queue);
    this.maybeFinishQueue(queue);
    this.schedulePump();
    return true;
  }

  /** A renderer acknowledgement retires exactly one retained sequence. */
  acknowledge(
    terminalId: string,
    terminalGeneration: number,
    windowGeneration: number,
    rendererGeneration: number,
    sequence: number,
  ): boolean {
    const queue = this.queues.get(terminalId);
    if (
      this.disposed
      || !this.rendererReady
      || !queue
      || queue.terminalGeneration !== terminalGeneration
      || windowGeneration !== this.windowGeneration
      || rendererGeneration !== this.rendererGeneration
      || !Number.isSafeInteger(sequence)
    ) return false;
    const chunk = queue.inFlight.get(sequence);
    if (!chunk) return false;
    queue.inFlight.delete(sequence);
    queue.inFlightBytes -= chunk.bytes;
    this.maybeResumeSource(queue);
    this.maybeFinishQueue(queue);
    this.resolveDrainWaiters();
    if (this.rendererReady && this.hasDeliverableChunks()) this.schedulePump();
    return true;
  }

  stats(terminalId?: string): PtyEgressQueueStats | {
    terminalCount: number;
    queuedBytes: number;
    queuedChunks: number;
    inFlightBytes: number;
    inFlightChunks: number;
    retainedBytes: number;
    retainedChunks: number;
    rendererReady: boolean;
    windowGeneration: number;
    rendererGeneration: number;
  } {
    if (terminalId !== undefined) {
      const queue = this.queues.get(terminalId);
      if (!queue) {
        return {
          queuedBytes: 0,
          queuedChunks: 0,
          inFlightBytes: 0,
          inFlightChunks: 0,
          retainedBytes: 0,
          retainedChunks: 0,
          paused: false,
          closing: false,
          hydrated: false,
          terminalGeneration: 0,
          windowGeneration: this.windowGeneration,
          rendererGeneration: this.rendererGeneration,
        };
      }
      return {
        queuedBytes: queue.queuedBytes,
        queuedChunks: queue.chunks.length,
        inFlightBytes: queue.inFlightBytes,
        inFlightChunks: queue.inFlight.size,
        retainedBytes: this.retainedBytes(queue),
        retainedChunks: this.retainedChunks(queue),
        paused: queue.paused,
        closing: queue.closing,
        hydrated: queue.hydrated && this.rendererReady,
        terminalGeneration: queue.terminalGeneration,
        windowGeneration: this.windowGeneration,
        rendererGeneration: this.rendererGeneration,
      };
    }
    let queuedBytes = 0;
    let queuedChunks = 0;
    let inFlightBytes = 0;
    let inFlightChunks = 0;
    for (const queue of this.queues.values()) {
      queuedBytes += queue.queuedBytes;
      queuedChunks += queue.chunks.length;
      inFlightBytes += queue.inFlightBytes;
      inFlightChunks += queue.inFlight.size;
    }
    return {
      terminalCount: this.queues.size,
      queuedBytes,
      queuedChunks,
      inFlightBytes,
      inFlightChunks,
      retainedBytes: queuedBytes + inFlightBytes,
      retainedChunks: queuedChunks + inFlightChunks,
      rendererReady: this.rendererReady,
      windowGeneration: this.windowGeneration,
      rendererGeneration: this.rendererGeneration,
    };
  }

  /** Wait until accepted output is acknowledged (or cancelled on shutdown). */
  async drain(terminalId?: string): Promise<void> {
    if (this.isDrained(terminalId)) return;
    await new Promise<void>((resolve) => this.drainWaiters.push({ terminalId, resolve }));
  }

  /** Stop all delivery and release retained output during app shutdown. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pumpTimer !== null) clearTimeout(this.pumpTimer);
    this.pumpTimer = null;
    for (const queue of [...this.queues.values()]) this.removeQueue(queue, false);
    this.resolveDrainWaiters();
    this.queues.clear();
    this.order = [];
    this.cursor = 0;
  }

  private pauseSource(queue: TerminalQueue): void {
    if (queue.paused) return;
    queue.paused = true;
    try {
      queue.source.pause();
    } catch {
      /* A concurrently exiting PTY already provides equivalent backpressure. */
    }
  }

  private maybeResumeSource(queue: TerminalQueue): void {
    if (!queue.paused || queue.closing || !this.canDeliver(queue)) return;
    if (this.retainedBytes(queue) > this.lowWaterBytes || this.retainedChunks(queue) > this.lowWaterChunks) return;
    queue.paused = false;
    try {
      queue.source.resume();
    } catch {
      /* A concurrently exiting PTY has no more data to resume. */
    }
  }

  private canDeliver(queue: TerminalQueue): boolean {
    return this.rendererReady && queue.hydrated;
  }

  private schedulePump(): void {
    if (this.disposed || !this.rendererReady || this.pumpTimer !== null || this.pumping || !this.hasDeliverableChunks()) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, this.yieldMs);
  }

  private pump(): void {
    if (this.disposed || !this.rendererReady || this.pumping) return;
    this.pumping = true;
    let sentBytes = 0;
    let sentChunks = 0;
    try {
      while (sentChunks < this.batchChunks && this.rendererReady) {
        const queue = this.nextQueuedQueue();
        if (!queue || !this.canDeliver(queue)) break;
        const record = queue.chunks.shift();
        if (!record) break;
        if (sentChunks > 0 && sentBytes + record.bytes > this.batchBytes) {
          queue.chunks.unshift(record);
          break;
        }
        queue.queuedBytes -= record.bytes;
        // Move into retained in-flight storage before calling transport so a
        // synchronous acknowledgement is valid and a reentrant crash can
        // replay this exact sequence or exit marker without loss.
        queue.inFlight.set(record.sequence, record);
        queue.inFlightBytes += record.bytes;
        const sendWindowGeneration = this.windowGeneration;
        const sendRendererGeneration = this.rendererGeneration;
        let sent = true;
        try {
          sent = record.kind === "exit"
            ? this.transport.sendExit(
              queue.id,
              queue.terminalGeneration,
              this.windowGeneration,
              this.rendererGeneration,
              record.sequence,
              record.code,
            ) !== false
            : this.transport.send(
              queue.id,
              queue.terminalGeneration,
              this.windowGeneration,
              this.rendererGeneration,
              record.sequence,
              record.data,
            ) !== false;
        } catch {
          sent = false;
        }
        if (!sent) {
          const ownedBeforeFailure = queue.inFlight.get(record.sequence) === record;
          this.requeueRecord(queue, record);
          if (this.rendererReady && ownedBeforeFailure) {
            this.setRendererReady(this.windowGeneration, this.rendererGeneration, false);
          }
          break;
        }
        sentBytes += record.bytes;
        sentChunks += 1;
        this.maybeResumeSource(queue);
        this.maybeFinishQueue(queue);
        // A send callback can synchronously observe a renderer crash. Never
        // continue a batch after that callback changes readiness, generation,
        // or ownership. In particular, a reentrant ready transition may have
        // replayed this record into `chunks`; sending it again in this same
        // turn would duplicate its sequence.
        if (
          !this.rendererReady
          || this.windowGeneration !== sendWindowGeneration
          || this.rendererGeneration !== sendRendererGeneration
          || queue.inFlight.get(record.sequence) !== record
        ) break;
      }
    } finally {
      this.pumping = false;
    }
    this.resolveDrainWaiters();
    if (this.rendererReady && this.hasDeliverableChunks()) this.schedulePump();
  }

  private nextQueuedQueue(): TerminalQueue | null {
    if (this.order.length === 0) return null;
    const count = this.order.length;
    for (let offset = 0; offset < count; offset += 1) {
      if (this.order.length === 0) return null;
      const index = (this.cursor + offset) % this.order.length;
      const queue = this.queues.get(this.order[index]!);
      if (queue && queue.chunks.length > 0 && this.canDeliver(queue)) {
        this.cursor = (index + 1) % this.order.length;
        return queue;
      }
    }
    return null;
  }

  private hasDeliverableChunks(): boolean {
    for (const queue of this.queues.values()) {
      if (queue.chunks.length > 0 && this.canDeliver(queue)) return true;
    }
    return false;
  }

  private retainedBytes(queue: TerminalQueue): number {
    return queue.queuedBytes + queue.inFlightBytes;
  }

  private retainedChunks(queue: TerminalQueue): number {
    return queue.chunks.length + queue.inFlight.size;
  }

  private maybeFinishQueue(queue: TerminalQueue): void {
    this.maybeQueueExit(queue);
    if (queue.closing && queue.exitQueued && this.retainedChunks(queue) === 0 && this.canDeliver(queue)) {
      this.removeQueue(queue, true);
    }
  }

  /**
   * Append the exit marker only after every data record has been acknowledged.
   * It therefore cannot overtake the PTY tail, while still sharing the same
   * sequence/in-flight/replay ledger as ordinary output.
   */
  private maybeQueueExit(queue: TerminalQueue): void {
    if (!queue.closing || queue.exitQueued || queue.finishCode === null) return;
    if (queue.chunks.some((record) => record.kind === "data")) return;
    for (const record of queue.inFlight.values()) {
      if (record.kind === "data") return;
    }
    queue.exitQueued = true;
    queue.chunks.push({
      kind: "exit",
      code: queue.finishCode,
      bytes: 0,
      sequence: queue.nextSequence++,
    });
  }

  private isDrained(terminalId?: string): boolean {
    if (terminalId !== undefined) {
      const queue = this.queues.get(terminalId);
      return !queue || this.retainedChunks(queue) === 0;
    }
    for (const queue of this.queues.values()) if (this.retainedChunks(queue) > 0) return false;
    return true;
  }

  private requeueRecord(queue: TerminalQueue, record: EgressRecord): void {
    // The transport call is re-entrant: a synchronous throw can cause main to
    // fence the renderer, and that readiness transition may already have
    // replayed this record into `chunks`.  It can also synchronously ack or
    // cancel the terminal.  Only the in-flight owner may transition back to
    // queued; every other state means another callback already completed the
    // transition.  This keeps one sequence in exactly one ledger location.
    if (queue.inFlight.get(record.sequence) !== record) return;
    queue.inFlight.delete(record.sequence);
    queue.inFlightBytes -= record.bytes;
    if (queue.chunks.some((candidate) => candidate.sequence === record.sequence)) return;
    queue.chunks.unshift(record);
    queue.queuedBytes += record.bytes;
  }

  /** Move all unacknowledged chunks back to the ordered queue for replay. */
  private replayInFlight(): void {
    for (const queue of this.queues.values()) {
      if (queue.inFlight.size === 0) continue;
      const replay = [...queue.inFlight.values()].sort((a, b) => a.sequence - b.sequence);
      queue.inFlight.clear();
      queue.inFlightBytes = 0;
      queue.chunks = [...replay, ...queue.chunks];
      for (const record of replay) queue.queuedBytes += record.bytes;
    }
  }

  private removeQueue(queue: TerminalQueue, delivered: boolean): void {
    if (this.queues.get(queue.id) !== queue) return;
    if (!delivered) this.pauseSource(queue);
    this.queues.delete(queue.id);
    const index = this.order.indexOf(queue.id);
    if (index >= 0) {
      this.order.splice(index, 1);
      if (index < this.cursor) this.cursor -= 1;
      if (this.cursor >= this.order.length) this.cursor = 0;
    }
    queue.chunks.length = 0;
    queue.queuedBytes = 0;
    queue.inFlight.clear();
    queue.inFlightBytes = 0;
    const finishWaiters = queue.finishWaiters.splice(0);
    for (const resolve of finishWaiters) resolve(delivered);
  }

  private resolveDrainWaiters(): void {
    if (this.drainWaiters.length === 0) return;
    const remaining: DrainWaiter[] = [];
    for (const waiter of this.drainWaiters) {
      if (this.isDrained(waiter.terminalId)) waiter.resolve();
      else remaining.push(waiter);
    }
    this.drainWaiters = remaining;
  }
}
