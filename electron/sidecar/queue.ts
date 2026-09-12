/**
 * Bounded ordered sidecar event queue.
 *
 * Owns event classification and the SidecarEventQueue delivery pump.
 * Split from electron/sidecar.ts (issue #38).
 */
import type { SidecarEvent } from "./events.js";


/**
 * Sidecar delivery is lossless for boundary events.  The queue is allowed to
 * replace adjacent progress snapshots, but a full queue rejects admission so
 * the tailer can leave the record on disk and retry it later.
 */
const SIDECAR_EVENT_QUEUE_HIGH_WATER_ITEMS = 256;

const SIDECAR_EVENT_QUEUE_HIGH_WATER_BYTES = 32 * 1024 * 1024;

const SIDECAR_EVENT_QUEUE_IN_FLIGHT_HIGH_WATER = 1;


export type SidecarEventClass = "boundary" | "replaceable";


const REPLACEABLE_SIDECAR_KINDS = new Set<SidecarEvent["t"]>([
  // These are latest-state snapshots.  Adjacent snapshots can be replaced;
  // boundaries between them remain in the queue and preserve their order.
  "agent_settings",
  "plan",
]);


function sidecarEventClass(event: SidecarEvent): SidecarEventClass {
  return REPLACEABLE_SIDECAR_KINDS.has(event.t) ? "replaceable" : "boundary";
}


export interface SidecarEventQueueOptions {
  maxItems?: number;
  maxBytes?: number;
  maxInFlight?: number;
  onError?: (error: Error, event: SidecarEvent) => void;
}


export interface SidecarEventQueueStats {
  /** All retained items, including the currently running item. */
  items: number;
  /** UTF-8 bytes retained by waiting and running items. */
  bytes: number;
  inFlight: number;
  inFlightBytes: number;
}


export interface SidecarEventDelivery {
  /** False means the caller must leave the durable record at its cursor. */
  accepted: boolean;
  /** Resolves only after the handler has completed successfully. */
  completed?: Promise<void>;
}


interface QueuedSidecarEvent {
  event: SidecarEvent;
  bytes: number;
  class: SidecarEventClass;
  key: SidecarEvent["t"];
  attempts: number;
  resolve: () => void;
  reject: (error: Error) => void;
}


const SIDECAR_HANDLER_RETRY_MS = 50;


function sidecarEventBytes(event: SidecarEvent): number {
  // Events are already parsed and bounded by the tail read.  Keep admission
  // accounting byte-accurate for multibyte prompt/model/path values.
  return Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
}


/** One ordered, bounded event queue for one terminal. */
export class SidecarEventQueue {
  private readonly maxItems: number;
  private readonly maxBytes: number;
  private readonly maxInFlight: number;
  private readonly queue: QueuedSidecarEvent[] = [];
  private queuedBytes = 0;
  private inFlight = 0;
  private inFlightBytes = 0;
  private disposed = false;
  private drainWaiters: Array<() => void> = [];
  private activeItems = new Set<QueuedSidecarEvent>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly handler: (event: SidecarEvent) => void | Promise<void>,
    options: SidecarEventQueueOptions = {},
  ) {
    this.maxItems = options.maxItems ?? SIDECAR_EVENT_QUEUE_HIGH_WATER_ITEMS;
    this.maxBytes = options.maxBytes ?? SIDECAR_EVENT_QUEUE_HIGH_WATER_BYTES;
    this.maxInFlight = options.maxInFlight ?? SIDECAR_EVENT_QUEUE_IN_FLIGHT_HIGH_WATER;
    if (!Number.isSafeInteger(this.maxItems) || this.maxItems < 1) throw new Error("invalid sidecar queue item high-water mark");
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new Error("invalid sidecar queue byte high-water mark");
    if (!Number.isSafeInteger(this.maxInFlight) || this.maxInFlight < 1) throw new Error("invalid sidecar queue in-flight high-water mark");
    this.onError = options.onError ?? (() => {});
  }

  private readonly onError: (error: Error, event: SidecarEvent) => void;

  /** Admit one event. False means the caller must retry the same event. */
  enqueue(event: SidecarEvent): boolean {
    return this.enqueueTracked(event).accepted;
  }

  /** Admit one event and expose the handler-completion acknowledgement. */
  enqueueTracked(event: SidecarEvent): SidecarEventDelivery {
    if (this.disposed) return { accepted: false };
    let bytes: number;
    try {
      bytes = sidecarEventBytes(event);
    } catch {
      return { accepted: false };
    }
    if (!Number.isSafeInteger(bytes) || bytes > this.maxBytes) return { accepted: false };

    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const completed = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    // Queue-only callers use enqueue() and cannot observe completion. Keep a
    // rejection handler attached so shutdown never creates an unhandled one.
    void completed.catch(() => {});
    const item = (className: SidecarEventClass = sidecarEventClass(event)): QueuedSidecarEvent => ({
      event,
      bytes,
      class: className,
      key: event.t,
      attempts: 0,
      resolve,
      reject,
    });

    const eventClass = sidecarEventClass(event);
    const previous = this.queue.at(-1);
    // Coalesce only adjacent latest-state snapshots.  Crossing a boundary
    // would move a newer state before that boundary and corrupt ordering.
    if (previous && previous.class === "replaceable" && eventClass === "replaceable" && previous.key === event.t) {
      const nextBytes = this.queuedBytes - previous.bytes + bytes;
      if (this.inFlightBytes + nextBytes > this.maxBytes) return { accepted: false };
      // The previous snapshot is intentionally superseded. It is safe to
      // acknowledge that record because it is not a state-mutating boundary.
      previous.resolve();
      this.queuedBytes = nextBytes;
      this.queue[this.queue.length - 1] = item(eventClass);
      this.pump();
      return { accepted: true, completed };
    }
    if (this.queue.length + this.inFlight >= this.maxItems || this.queuedBytes + this.inFlightBytes + bytes > this.maxBytes) return { accepted: false };
    this.queue.push(item(eventClass));
    this.queuedBytes += bytes;
    this.pump();
    return { accepted: true, completed };
  }

  stats(): SidecarEventQueueStats {
    return {
      items: this.queue.length + this.inFlight,
      bytes: this.queuedBytes + this.inFlightBytes,
      inFlight: this.inFlight,
      inFlightBytes: this.inFlightBytes,
    };
  }

  async drain(): Promise<void> {
    if (this.queue.length === 0 && this.inFlight === 0) return;
    await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const error = new Error("sidecar event queue is disposed");
    for (const item of this.queue) item.reject(error);
    for (const item of this.activeItems) item.reject(error);
    this.queue.length = 0;
    this.queuedBytes = 0;
    // A shutdown cannot await an uncooperative handler. The active callback
    // is not cancelled, but no caller remains blocked on this queue; its
    // completion acknowledgement has already been rejected above.
    const waiters = this.drainWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private pump(): void {
    if (this.retryTimer) return;
    while (!this.disposed && this.inFlight < this.maxInFlight && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.queuedBytes -= item.bytes;
      this.inFlight++;
      this.inFlightBytes += item.bytes;
      this.activeItems.add(item);
      void Promise.resolve()
        .then(() => this.handler(item.event))
        .then(() => {
          this.activeItems.delete(item);
          this.inFlight--;
          this.inFlightBytes -= item.bytes;
          item.resolve();
          this.resolveDrainWaiters();
          this.pump();
        })
        .catch((error: unknown) => {
          const normalized = error instanceof Error ? error : new Error(String(error));
          try {
            this.onError(normalized, item.event);
          } catch {
            /* Diagnostics must never break queue recovery. */
          }
          this.inFlight--;
          this.inFlightBytes -= item.bytes;
          this.activeItems.delete(item);
          if (this.disposed) {
            item.reject(normalized);
          } else {
            // Put the exact item back at the head. A later boundary may
            // never pass a failed one, and the tailer's durable cursor stays
            // behind until this acknowledgement succeeds.
            this.queue.unshift(item);
            this.queuedBytes += item.bytes;
            item.attempts++;
            this.scheduleRetry(item.attempts);
          }
          this.resolveDrainWaiters();
        });
    }
  }

  private scheduleRetry(attempts: number): void {
    if (this.retryTimer || this.disposed) return;
    const delay = Math.min(2000, SIDECAR_HANDLER_RETRY_MS * 2 ** Math.min(attempts - 1, 5));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.pump();
    }, delay);
  }

  private resolveDrainWaiters(): void {
    if (this.queue.length !== 0 || this.inFlight !== 0) return;
    const waiters = this.drainWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}
