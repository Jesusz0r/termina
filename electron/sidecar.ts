/**
 * Sidecar protocol: JSONL events the engine writes and the app tails.
 *
 * Two writers emit this protocol: the Pi bridge and agent-core. This
 * module is the only parser and the only tailer of sidecar JSONL.
 */
import { watch, type FSWatcher } from "node:fs";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { link as linkFile, open as openFile, readdir as readDirectory, rename as renameFile, stat as statFile, unlink as unlinkFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const MAX_SIDECAR_BYTES = 8 * 1024 * 1024;
/** A complete JSONL record may span bounded tail reads, but never grows
 *  without a decision. Records above this cap are explicitly skipped. */
const MAX_SIDECAR_RECORD_BYTES = MAX_SIDECAR_BYTES;
const SIDECAR_TAIL_READ_BYTES = 1024 * 1024;
/** Producer-side flow-control marker; writers wait while it exists. */
const SIDECAR_BACKPRESSURE_FILE_PREFIX = ".backpressure-";
/** Terminal-local fail-closed admission marker for unrecoverable source races. */
const SIDECAR_QUARANTINE_FILE_PREFIX = ".quarantine-";
/** Canonical writer-owned sealed generation suffix. */
const SIDECAR_SEALED_FILE_SUFFIX = ".sealed";
/** Marker published by a canonical writer after it has closed the old
 * pathname and created the next active inode.  A sealed generation without
 * this marker is unproven and must retain an inode anchor. */
export const SIDECAR_SEALED_PROOF_SUFFIX = ".owner";
/** A retained inode whose producer provenance is unknown. */
const SIDECAR_RETAINED_FILE_TOKEN = ".retained-";
const SIDECAR_DRAIN_FILE_TOKEN = ".draining-";
const SIDECAR_FINAL_GUARD_FILE_TOKEN = ".final-";
const SIDECAR_CURSOR_VERSION = 1;
/** Owner metadata is protocol-generated and intentionally tiny. */
const SIDECAR_PROOF_MAX_BYTES = 64 * 1024;
/** Verification never allocates beyond one bounded sidecar generation. */
const SIDECAR_VERIFY_READ_CHUNK_BYTES = 64 * 1024;
/** A hostile short-read/append loop must not monopolize the async tail. */
const SIDECAR_VERIFY_MAX_READS = 4096;
/** A missing sequence is never guessed closed. After this bounded
 * retry budget the terminal is quarantined instead of allowing a later
 * source to overtake it forever. */
const SIDECAR_MAX_SEQUENCE_GAP_POLLS = 80;

export type ToolEdits = Array<{ oldText?: string; newText?: string }>;

interface SidecarMeta {
  bridgeId: string;
  seq: number;
  /** Immutable producer generation, present on canonical records. */
  generation?: string;
}

export type SidecarEvent =
  | (SidecarMeta & { t: "preflight_request"; requestId?: string; hasImages?: boolean; deadlineAt?: number })
  | (SidecarMeta & { t: "preflight_cancel"; requestId?: string })
  | (SidecarMeta & { t: "prompt"; file?: string; hasPreflight?: boolean })
  | (SidecarMeta & { t: "steer_input"; behavior?: string })
  | (SidecarMeta & { t: "checkpoint_request"; requestId?: string; kind?: string; entryId?: string | null })
  | (SidecarMeta & { t: "checkpoint_result"; requestId?: string; ok?: boolean; error?: string | null })
  | (SidecarMeta & { t: "session_ready"; opId?: string; ok?: boolean; error?: string | null })
  | (SidecarMeta & {
      t: "agent_start";
      preflightRequestId?: string | null;
      preflightToken?: string | null;
      sessionFile?: string | null;
      sessionId?: string | null;
      entryId?: string | null;
      parentEntryId?: string | null;
      trusted?: boolean;
      model?: string | null;
      thinkingLevel?: string | null;
    })
  | (SidecarMeta & { t: "agent_settled"; error?: string | null })
  | (SidecarMeta & { t: "agent_settings"; model?: string | null; thinkingLevel?: string | null })
  | (SidecarMeta & { t: "plan"; text?: string })
  | (SidecarMeta & {
      t: "tool";
      toolName?: string;
      path?: string;
      edits?: ToolEdits;
      /** Producer retained a bounded preview instead of dropping the tool boundary. */
      editsTruncated?: boolean;
      editsBytes?: number;
      editsCount?: number;
      editsSha256?: string;
      toolCallId?: string;
      entryId?: string | null;
    })
  | (SidecarMeta & { t: "tool_end"; toolCallId?: string; isError?: boolean });

export type AgentStartEvent = Extract<SidecarEvent, { t: "agent_start" }>;

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

const SIDECAR_KINDS = new Set<SidecarEvent["t"]>([
  "preflight_request",
  "preflight_cancel",
  "prompt",
  "steer_input",
  "checkpoint_request",
  "checkpoint_result",
  "session_ready",
  "agent_start",
  "agent_settled",
  "agent_settings",
  "plan",
  "tool",
  "tool_end",
]);

/** One JSONL object. Arrays, primitives, and malformed JSON are not records. */
export function parseSidecarRecord(line: string): Record<string, unknown> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

/** bridgeId plus a monotonic seq. Unknown kinds still occupy this slot. */
function sidecarEnvelope(rec: Record<string, unknown>): SidecarMeta | null {
  const bridgeId = rec.bridgeId;
  const seq = rec.seq;
  const generation = rec.generation;
  if (typeof bridgeId !== "string" || bridgeId.length === 0) return null;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) return null;
  return {
    bridgeId,
    seq,
    ...(typeof generation === "string" && generation.length > 0 && generation.length <= 256 ? { generation } : {}),
  };
}

export function sidecarEventFromRecord(rec: Record<string, unknown>): SidecarEvent | null {
  const envelope = sidecarEnvelope(rec);
  if (!envelope) return null;
  return sidecarEventBody(envelope, rec);
}

function isSidecarKind(t: string): t is SidecarEvent["t"] {
  return SIDECAR_KINDS.has(t as SidecarEvent["t"]);
}

function sidecarEventBody(meta: SidecarMeta, rec: Record<string, unknown>): SidecarEvent | null {
  const t = rec.t;
  if (typeof t !== "string" || !isSidecarKind(t)) return null;
  switch (t) {
    case "preflight_request":
      return {
        ...meta,
        t: "preflight_request",
        requestId: optionalString(rec.requestId),
        hasImages: optionalBoolean(rec.hasImages),
        deadlineAt: optionalSafeInteger(rec.deadlineAt),
      };
    case "preflight_cancel":
      return { ...meta, t: "preflight_cancel", requestId: optionalString(rec.requestId) };
    case "prompt":
      return { ...meta, t: "prompt", file: optionalString(rec.file), hasPreflight: optionalBoolean(rec.hasPreflight) };
    case "steer_input":
      return { ...meta, t: "steer_input", behavior: optionalString(rec.behavior) };
    case "checkpoint_request":
      return {
        ...meta,
        t: "checkpoint_request",
        requestId: optionalString(rec.requestId),
        kind: optionalString(rec.kind),
        entryId: optionalStringOrNull(rec.entryId),
      };
    case "checkpoint_result":
      return {
        ...meta,
        t: "checkpoint_result",
        requestId: optionalString(rec.requestId),
        ok: optionalBoolean(rec.ok),
        error: optionalStringOrNull(rec.error),
      };
    case "session_ready":
      return {
        ...meta,
        t: "session_ready",
        opId: optionalString(rec.opId),
        ok: optionalBoolean(rec.ok),
        error: optionalStringOrNull(rec.error),
      };
    case "agent_start":
      return {
        ...meta,
        t: "agent_start",
        preflightRequestId: optionalStringOrNull(rec.preflightRequestId),
        preflightToken: optionalStringOrNull(rec.preflightToken),
        sessionFile: optionalStringOrNull(rec.sessionFile),
        sessionId: optionalStringOrNull(rec.sessionId),
        entryId: optionalStringOrNull(rec.entryId),
        parentEntryId: optionalStringOrNull(rec.parentEntryId),
        trusted: optionalBoolean(rec.trusted),
        model: optionalStringOrNull(rec.model),
        thinkingLevel: optionalStringOrNull(rec.thinkingLevel),
      };
    case "agent_settled":
      return { ...meta, t: "agent_settled", error: optionalStringOrNull(rec.error) };
    case "agent_settings":
      return {
        ...meta,
        t: "agent_settings",
        model: optionalStringOrNull(rec.model),
        thinkingLevel: optionalStringOrNull(rec.thinkingLevel),
      };
    case "plan":
      return { ...meta, t: "plan", text: optionalString(rec.text) };
    case "tool":
      return {
        ...meta,
        t: "tool",
        toolName: optionalString(rec.toolName),
        path: optionalString(rec.path),
        edits: optionalEdits(rec.edits),
        editsTruncated: optionalBoolean(rec.editsTruncated),
        editsBytes: optionalSafeInteger(rec.editsBytes),
        editsCount: optionalSafeInteger(rec.editsCount),
        editsSha256: optionalString(rec.editsSha256),
        toolCallId: optionalString(rec.toolCallId),
        entryId: optionalStringOrNull(rec.entryId),
      };
    case "tool_end":
      return { ...meta, t: "tool_end", toolCallId: optionalString(rec.toolCallId), isError: optionalBoolean(rec.isError) };
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalStringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function optionalEdits(value: unknown): ToolEdits | undefined {
  if (!Array.isArray(value)) return undefined;
  const edits: ToolEdits = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const oldText = optionalString(rec.oldText);
    const newText = optionalString(rec.newText);
    if (oldText === undefined && newText === undefined) continue;
    edits.push({ ...(oldText !== undefined ? { oldText } : {}), ...(newText !== undefined ? { newText } : {}) });
  }
  return edits;
}

interface StreamState {
  bridgeId: string;
  sequence: number;
}

export interface SidecarTailerOptions {
  /** Maximum retained bytes from a paused terminal before overflow reporting. */
  maxBacklogBytes?: number;
  /** Maximum complete/partial JSONL record size. */
  maxRecordBytes?: number;
  /** Called once when a paused durable file exceeds maxBacklogBytes. */
  onBacklogOverflow?: (terminalId: string, retainedBytes: number) => void;
}

interface OversizedRecord {
  bytes: number;
  diagnosticEmitted: boolean;
}

interface DurableSidecarCursor {
  version: typeof SIDECAR_CURSOR_VERSION;
  offset: number;
  bridgeId?: string;
  sequence?: number;
  sealedSegment?: string;
  sealedOffset?: number;
  sealedIdentity?: string;
}

type DurableSidecarCursorUpdate = Omit<DurableSidecarCursor, "version" | "sealedSegment" | "sealedOffset" | "sealedIdentity"> & {
  sealedSegment?: string | null;
  sealedOffset?: number | null;
  sealedIdentity?: string | null;
};

interface SourceState {
  offset: number;
  partial: Buffer;
  oversized?: OversizedRecord;
}

interface MarkerState {
  generation: number;
  cancelled: boolean;
  desiredPresent: boolean;
  desiredBytes: number;
  actualPresent: boolean | null;
  actualBytes: number;
  running: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  operation: Promise<void> | null;
  waiters: Array<{ present: boolean; resolve: (ok: boolean) => void }>;
}

interface SegmentCandidate {
  name: string;
  /** A canonical identity anchor retained after publication verification. */
  retained?: boolean;
  /** The live pathname is a candidate too; source order is global. */
  active?: boolean;
}

interface PeekedSegmentRecord {
  envelope: SidecarMeta | null;
  hasBytes: boolean;
  /** The first record has no newline yet but is still within the cap. */
  incomplete?: boolean;
  /** The first record reached the hard cap without a newline. */
  oversized?: boolean;
}

/**
 * A writer publication is only verification-authoritative when it binds the
 * sealed pathname to one immutable writer/generation identity and declares
 * the final sequence that was durably closed. Presence of an old `.owner`
 * file, or a matching byte length, is deliberately not enough to remove the
 * final identity anchor.
 */
interface SealedRetirementProof {
  writerId: string;
  generation: string;
  sealedName: string;
  identity: string;
  lastSeq: number;
}

/** Publish small sidecar metadata without blocking Electron's main thread. */
async function durableAtomicWrite(path: string, content: string): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof openFile>> | undefined;
  try {
    handle = await openFile(temp, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameFile(temp, path);
    await syncParentDirectory(path);
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      /* best effort cleanup */
    }
    try {
      await unlinkFile(temp);
    } catch {
      /* best effort cleanup */
    }
    throw error;
  }
}

async function durableUnlink(path: string): Promise<void> {
  try {
    await unlinkFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  try {
    await syncParentDirectory(path);
  } catch (error) {
    // Cleanup after shutdown can race removal of the events directory. The
    // requested state is already absent in that case, so ENOENT is success.
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
}

async function syncParentDirectory(path: string): Promise<void> {
  const directory = await openFile(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Read a file incrementally with a hard post-TOCTOU byte cap. */
async function readBoundedText(path: string, maxBytes: number): Promise<string> {
  const handle = await openFile(path, "r");
  const chunks: Buffer[] = [];
  let total = 0;
  let position = 0;
  let reads = 0;
  try {
    for (;;) {
      if (++reads > SIDECAR_VERIFY_MAX_READS) throw new Error("bounded sidecar read exceeded its operation budget");
      const remaining = maxBytes - total;
      if (remaining <= 0) {
        const stats = await statFile(path);
        if (stats.size > position) throw new Error("bounded sidecar read exceeded its cap");
        break;
      }
      // Read only within the hard cap. Growth past the cap is detected by the
      // post-read stat below; no sentinel byte is admitted past the boundary.
      const buffer = Buffer.alloc(Math.min(SIDECAR_VERIFY_READ_CHUNK_BYTES, remaining));
      const result = await handle.read(buffer, 0, buffer.length, position);
      if (result.bytesRead === 0) {
        // A concurrent append can race an EOF read. Re-stat and continue only
        // while the source remains within the hard cap.
        const stats = await statFile(path);
        if (stats.size > position) continue;
        break;
      }
      if (total + result.bytesRead > maxBytes) throw new Error("bounded sidecar read exceeded its cap");
      chunks.push(buffer.subarray(0, result.bytesRead));
      total += result.bytesRead;
      position += result.bytesRead;
      if (result.bytesRead < buffer.length) {
        const stats = await statFile(path);
        if (stats.size <= position) break;
      }
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

export class SidecarTailer {
  /** Pending scan cursor; durableCursors is advanced only after delivery ack. */
  private offsets = new Map<string, number>();
  /** Pending scan cursor for the retained pre-rotation inode. */
  private segmentOffsets = new Map<string, number>();
  /** Segment state is keyed by terminal and immutable source basename. */
  private segmentIdentities = new Map<string, string>();
  /** Published writer-owned generation currently being drained. */
  private sealedSegments = new Map<string, string>();
  /** A compatibility source is not restart-safe or exceeds the anchor cap. */
  private quarantined = new Set<string>();
  /** Every retired pathname retains one durable identity anchor: POSIX cannot
   * prove that an escaped descriptor will not append after verification. */
  private retainedSegments = new Map<string, string>();
  /** A second link keeps a retired inode observable while an old descriptor
   *  finishes an append during the unlink syscall. */
  private segmentDrainPaths = new Map<string, string>();
  private durableCursors = new Map<string, DurableSidecarCursor>();
  private streams = new Map<string, StreamState>();
  private bridgeIds = new Map<string, Set<string>>();
  private partialRecords = new Map<string, Buffer>();
  private segmentPartialRecords = new Map<string, Buffer>();
  private oversizedRecords = new Map<string, OversizedRecord>();
  private segmentOversizedRecords = new Map<string, OversizedRecord>();
  private segmentEmptyPolls = new Map<string, number>();
  /** Bounded retries while an older identity may still fill a sequence gap. */
  private sequenceGapPolls = new Map<string, number>();
  /** A source deferred during this tail pass; other identities still drain. */
  private sequenceGapDeferred = new Set<string>();
  /** A segment was reclaimed before its cursor-clear publish completed. */
  private pendingSegmentCursorClears = new Map<string, number>();
  private cursorWrites = new Map<string, Promise<boolean>>();
  private cursorInitializations = new Map<string, Promise<boolean>>();
  private markerStates = new Map<string, MarkerState>();
  private markerCleanups = new Map<string, Promise<void>>();
  private inFlight = new Map<string, number>();
  private lifecycleGeneration = 0;
  private terminalGenerations = new Map<string, number>();
  private stopping = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private watcher: FSWatcher | null = null;
  private pendingTails = new Map<string, ReturnType<typeof setTimeout>>();
  /** A rejected delivery pauses reads so the durable file remains the queue. */
  private paused = new Set<string>();
  /** Accepted records whose handler acknowledgement has not settled. */
  private pendingDeliveries = new Set<string>();
  private resumeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private backlogOverflowed = new Set<string>();
  private readonly maxBacklogBytes: number;
  private readonly maxRecordBytes: number;
  private readonly onBacklogOverflow: (terminalId: string, retainedBytes: number) => void;

  /** Return false to apply backpressure; the same record is retried later. */
  onEvent: (
    terminalId: string,
    event: SidecarEvent,
  ) => SidecarEventDelivery | boolean | void | Promise<SidecarEventDelivery | boolean | void> = () => {};

  constructor(private dir: string, private watchTree: typeof watch = watch, options: SidecarTailerOptions = {}) {
    this.maxBacklogBytes = options.maxBacklogBytes ?? MAX_SIDECAR_BYTES;
    const configuredMaxRecordBytes = options.maxRecordBytes ?? MAX_SIDECAR_RECORD_BYTES;
    this.onBacklogOverflow = options.onBacklogOverflow ?? ((terminalId, retainedBytes) => {
      console.warn(`[sidecar] ${terminalId} paused backlog exceeds ${this.maxBacklogBytes} bytes (${retainedBytes} retained)`);
    });
    if (!Number.isSafeInteger(this.maxBacklogBytes) || this.maxBacklogBytes < 1) throw new Error("invalid sidecar backlog byte high-water mark");
    if (!Number.isSafeInteger(configuredMaxRecordBytes) || configuredMaxRecordBytes < 1) throw new Error("invalid sidecar record byte high-water mark");
    this.maxRecordBytes = Math.min(configuredMaxRecordBytes, MAX_SIDECAR_RECORD_BYTES);
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.armWatch();
    this.timer = setInterval(() => {
      // Recovery poll: catch events the watcher missed. Also re-arm the
      // watcher when the directory did not exist yet.
      if (!this.watcher) this.armWatch();
      for (const id of this.offsets.keys()) {
        const generation = this.terminalGenerations.get(id);
        if (generation === undefined) continue;
        if (this.quarantined.has(id)) continue;
        if (this.paused.has(id)) void this.checkBacklog(id, undefined, generation);
        else void this.tail(id, generation);
      }
    }, 300);
  }

  /** Watch the events directory; a new line triggers an immediate tail. */
  private armWatch(): void {
    try {
      this.watcher?.close();
      this.watcher = this.watchTree(this.dir, (_ev, name) => {
        if (!name) return;
        const fileName = String(name);
        const active = fileName.match(/^([^.]+)\.jsonl$/);
        const generation = fileName.match(/^\.([^.]+)\.jsonl\.(?:sealed|retained-|draining-|final-)/);
        const id = active?.[1] ?? generation?.[1];
        if (id && this.offsets.has(id)) this.schedule(id);
      });
    } catch {
      this.watcher = null; // directory missing — retry on the next poll
    }
  }

  /** Debounce tails so a burst of appends tails once. */
  private schedule(id: string): void {
    if (!this.timer || this.stopping) return;
    const generation = this.terminalGenerations.get(id);
    if (generation === undefined) return;
    const existing = this.pendingTails.get(id);
    if (existing) clearTimeout(existing);
    this.pendingTails.set(
      id,
      setTimeout(() => {
        this.pendingTails.delete(id);
        if (this.isLive(id, generation)) void this.tail(id, generation);
      }, 10),
    );
  }

  /** Start tailing a terminal's event file. Events written before this call
   *  belong to previous app sessions (the file is global) — start from the
   *  current size so a fresh instance does not replay old history. */
  watch(id: string): void {
    const previousGeneration = this.terminalGenerations.get(id);
    const wasQuarantined = this.quarantined.has(id);
    if (previousGeneration !== undefined) {
      void this.clearBackpressureMarker(id, previousGeneration, true);
      this.quarantined.delete(id);
      this.inFlight.delete(id);
      const pendingTail = this.pendingTails.get(id);
      if (pendingTail) clearTimeout(pendingTail);
      this.pendingTails.delete(id);
      const resumeTimer = this.resumeTimers.get(id);
      if (resumeTimer) clearTimeout(resumeTimer);
      this.resumeTimers.delete(id);
    }
    const generation = ++this.lifecycleGeneration;
    this.terminalGenerations.set(id, generation);
    // A new lifecycle must not inherit an old generation's transient maps.
    // Cursor writes remain serialized in cursorWrites, but their generation
    // check prevents a late completion from repopulating these maps.
    this.clearSegmentState(id);
    // A marker left by a previous process is itself durable evidence that an
    // unsafe compatibility transition was observed. Keep this lifecycle
    // fail-closed until the source set is explicitly replaced/cleaned.
    const persistedQuarantine = this.hasQuarantineMarkerSync(id) || wasQuarantined;
    this.sealedSegments.delete(id);
    this.retainedSegments.delete(id);
    this.segmentDrainPaths.delete(id);
    this.pendingSegmentCursorClears.delete(id);
    const file = join(this.dir, `${id}.jsonl`);
    let start = 0;
    let fileSize = 0;
    this.cleanupOrphanProofs(id);
    const sealedNames = this.listSealedSegmentsSync(id);
    const retainedNames = this.listRetainedSegmentsSync(id);
    const cursor = this.loadCursor(id);
    const cursorSource = cursor?.sealedSegment
      ? sealedNames.find((name) => name === cursor.sealedSegment)
        ?? retainedNames.find((name) => this.isRetainedAliasFor(name, cursor.sealedSegment!))
      : undefined;
    const selectedSegment = cursorSource ?? sealedNames[0] ?? retainedNames[0];
    const selectedSource = selectedSegment;
    let segmentSize: number | null = null;
    let segmentIdentity: string | undefined;
    if (selectedSource) {
      try {
        const stats = statSync(join(this.dir, selectedSource));
        segmentSize = stats.size;
        segmentIdentity = this.fileIdentity(stats);
      } catch {
        segmentSize = null;
      }
    }
    try {
      fileSize = statSync(file).size;
    } catch {
      /* The file does not exist yet. */
    }
    const cursorFitsActive = cursor && cursor.offset >= 0 && cursor.offset <= fileSize;
    if (segmentSize !== null) {
      const identityMatches = !cursor?.sealedIdentity || cursor.sealedIdentity === segmentIdentity;
      const segmentStart = Math.min(segmentSize, Math.max(0, identityMatches ? cursor?.sealedOffset ?? 0 : 0));
      const sourceKey = this.segmentStateKey(id, selectedSource!);
      this.segmentOffsets.set(sourceKey, segmentStart);
      if (segmentIdentity) this.segmentIdentities.set(sourceKey, segmentIdentity);
      this.sealedSegments.set(id, selectedSource!);
      if (this.isRetainedSegmentName(id, selectedSource!)) this.retainedSegments.set(id, selectedSource!);
      this.segmentEmptyPolls.set(sourceKey, 0);
      start = this.cursorMatchesSegment(cursor?.sealedSegment, selectedSource) && cursorFitsActive ? cursor.offset : 0;
    } else if (cursorFitsActive) {
      start = cursor.offset;
    } else {
      // A new terminal skips history from a previous app session, but the
      // initial cursor is written before tailing. If the app dies after this
      // point, the next tailer can resume the bytes appended after start.
      start = fileSize;
    }
    this.offsets.set(id, start);
    const initialCursor: DurableSidecarCursor = segmentSize !== null
      ? {
        version: SIDECAR_CURSOR_VERSION,
        offset: start,
        sealedOffset: this.segmentOffset(id, selectedSource),
        sealedSegment: selectedSource,
        sealedIdentity: segmentIdentity,
      }
      : { version: SIDECAR_CURSOR_VERSION, offset: start };
    const durable = cursorFitsActive ? cursor! : initialCursor;
    this.durableCursors.set(id, durable);
    if (!cursorFitsActive || (segmentSize !== null && (
      cursor?.sealedOffset === undefined
      || !this.cursorMatchesSegment(cursor.sealedSegment, selectedSource)
      || (cursor.sealedIdentity !== undefined && cursor.sealedIdentity !== segmentIdentity)
    ))) {
      this.cursorInitializations.set(id, this.persistCursor(id, initialCursor, generation));
    } else {
      this.cursorInitializations.delete(id);
    }
    this.streams.delete(id);
    this.bridgeIds.delete(id);
    const cursorSequence = cursor?.sequence;
    if (cursor?.bridgeId && cursorSequence !== undefined && Number.isSafeInteger(cursorSequence) && cursorSequence >= 1) {
      this.streams.set(id, { bridgeId: cursor.bridgeId, sequence: cursorSequence });
      this.bridgeIds.set(id, new Set([cursor.bridgeId]));
    }
    this.partialRecords.delete(id);
    this.oversizedRecords.delete(id);
    this.paused.delete(id);
    this.pendingDeliveries.delete(id);
    this.backlogOverflowed.delete(id);
    if (persistedQuarantine) {
      if (retainedNames.length > 0 || sealedNames.length > 0) {
        this.quarantine(id, generation, "persisted sidecar quarantine");
      } else {
        this.quarantined.delete(id);
        void this.clearQuarantineMarker(id);
        void this.clearBackpressureMarker(id, generation);
      }
    }
    void this.checkBacklog(id, undefined, generation);
    const resumeTimer = this.resumeTimers.get(id);
    if (resumeTimer) clearTimeout(resumeTimer);
    this.resumeTimers.delete(id);
  }

  /** Establish a new lifecycle and wait until its initial cursor is durable.
   * Candidate processes use this stronger boundary before spawn so a startup
   * record cannot be mistaken for pre-existing history. Ordinary terminals
   * retain the fire-and-forget watch() API. */
  async watchReady(id: string): Promise<boolean> {
    this.watch(id);
    const generation = this.terminalGenerations.get(id);
    const initialization = this.cursorInitializations.get(id);
    if (!initialization) return this.isLive(id, generation);
    const durable = await initialization;
    if (this.cursorInitializations.get(id) === initialization) this.cursorInitializations.delete(id);
    return durable && this.isLive(id, generation);
  }

  stopWatching(id: string): void {
    const generation = this.terminalGenerations.get(id);
    const wasQuarantined = this.quarantined.has(id) || this.hasQuarantineMarkerSync(id);
    this.lifecycleGeneration++;
    this.terminalGenerations.delete(id);
    this.inFlight.delete(id);
    this.offsets.delete(id);
    this.clearSegmentState(id);
    this.quarantined.delete(id);
    this.sealedSegments.delete(id);
    this.retainedSegments.delete(id);
    this.segmentDrainPaths.delete(id);
    this.durableCursors.delete(id);
    this.streams.delete(id);
    this.bridgeIds.delete(id);
    this.partialRecords.delete(id);
    this.oversizedRecords.delete(id);
    this.pendingSegmentCursorClears.delete(id);
    this.cursorInitializations.delete(id);
    this.pendingDeliveries.delete(id);
    this.backlogOverflowed.delete(id);
    const t = this.pendingTails.get(id);
    if (t) clearTimeout(t);
    this.pendingTails.delete(id);
    const resumeTimer = this.resumeTimers.get(id);
    if (resumeTimer) clearTimeout(resumeTimer);
    this.resumeTimers.delete(id);
    this.paused.delete(id);
    void this.clearBackpressureMarker(id, generation, true);
    // A compatibility quarantine is durable admission state. Keep its
    // marker across lifecycle teardown so a restart cannot resume after an
    // identity-bound source was lost; normal terminals have no marker.
    if (!wasQuarantined) void this.clearQuarantineMarker(id);
  }

  stop(): void {
    this.stopping = true;
    this.lifecycleGeneration++;
    const generations = new Map(this.terminalGenerations);
    this.terminalGenerations.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
    for (const t of this.pendingTails.values()) clearTimeout(t);
    this.pendingTails.clear();
    for (const t of this.resumeTimers.values()) clearTimeout(t);
    this.resumeTimers.clear();
    this.paused.clear();
    this.quarantined.clear();
    this.pendingDeliveries.clear();
    const markerIds = new Set([...this.offsets.keys(), ...this.markerStates.keys()]);
    for (const id of markerIds) {
      void this.clearBackpressureMarker(id, generations.get(id), true);
    }
    this.offsets.clear();
    this.segmentOffsets.clear();
    this.segmentIdentities.clear();
    this.sealedSegments.clear();
    this.retainedSegments.clear();
    this.segmentDrainPaths.clear();
    this.durableCursors.clear();
    this.streams.clear();
    this.bridgeIds.clear();
    this.partialRecords.clear();
    this.segmentPartialRecords.clear();
    this.oversizedRecords.clear();
    this.segmentOversizedRecords.clear();
    this.segmentEmptyPolls.clear();
    this.sequenceGapPolls.clear();
    this.sequenceGapDeferred.clear();
    this.pendingSegmentCursorClears.clear();
    this.cursorInitializations.clear();
    for (const state of this.markerStates.values()) {
      if (state.retryTimer) clearTimeout(state.retryTimer);
    }
    // Marker states with an in-flight filesystem operation are retained until
    // their cancellation-aware pump settles; otherwise a late failure could
    // install an orphan retry timer after teardown.
    for (const [id, state] of this.markerStates) {
      if (!state.running) this.markerStates.delete(id);
    }
    this.backlogOverflowed.clear();
  }

  /** Resume a terminal after its consumer has drained below its high-water. */
  resume(id: string): void {
    const generation = this.terminalGenerations.get(id);
    if (!this.isLive(id, generation)) return;
    if (this.quarantined.has(id)) return;
    this.paused.delete(id);
    const timer = this.resumeTimers.get(id);
    if (timer) clearTimeout(timer);
    this.resumeTimers.delete(id);
    this.schedule(id);
  }

  isPaused(id: string): boolean {
    return this.paused.has(id);
  }

  isBacklogOverflowed(id: string): boolean {
    return this.backlogOverflowed.has(id);
  }

  private isLive(id: string, generation: number | undefined): generation is number {
    return generation !== undefined
      && !this.stopping
      && this.timer !== null
      && this.terminalGenerations.get(id) === generation
      && this.offsets.has(id);
  }

  private async tail(id: string, generation = this.terminalGenerations.get(id)): Promise<void> {
    if (!this.isLive(id, generation) || this.paused.has(id)) return;
    if (this.inFlight.has(id)) {
      // A slow acknowledgement still needs a periodic marker refresh if a
      // prior marker write failed; never let a hung consumer grow the spool.
      void this.checkBacklog(id, undefined, generation);
      return;
    }
    this.inFlight.set(id, generation);
    try {
      const initialization = this.cursorInitializations.get(id);
      if (initialization) {
        const durable = await initialization;
        this.cursorInitializations.delete(id);
        if (!this.isLive(id, generation)) return;
        if (!durable) {
          this.pause(id, generation);
          return;
        }
      }
      const pendingClear = this.pendingSegmentCursorClears.get(id);
      if (pendingClear !== undefined) {
        if (!(await this.persistCursor(id, {
          offset: this.offsets.get(id) ?? pendingClear,
          sealedOffset: null,
          sealedIdentity: null,
          sealedSegment: null,
        }, generation))) {
          this.pause(id, generation);
          return;
        }
        if (!this.isLive(id, generation)) return;
        this.pendingSegmentCursorClears.delete(id);
      }
      await this.readTail(id, generation);
    } finally {
      if (this.inFlight.get(id) === generation) this.inFlight.delete(id);
    }
  }

  private async readTail(id: string, generation: number): Promise<void> {
    if (!this.isLive(id, generation) || this.quarantined.has(id)) return;
    let retainedNames = await this.listRetainedSegments(id);
    if (retainedNames.length > 0) {
      const retainedName = await this.adoptRetainedAnchor(id, generation, retainedNames);
      if (retainedName === false || !this.isLive(id, generation) || this.quarantined.has(id)) return;
    }
    const retainedName = this.retainedSegments.get(id)
      ?? (this.segmentDrainPaths.has(id) ? this.sealedSegments.get(id) : undefined);
    if (this.segmentDrainPaths.has(id)) {
      // A retained identity must never disappear silently between directory
      // scans. If its only pathname vanished, stop before active bytes can
      // overtake the unrecoverable source.
      if (!retainedName) {
        this.quarantine(id, generation, "retained sidecar anchor lost its identity-bound pathname");
        return;
      }
      try {
        await statFile(this.sourcePath(id, retainedName));
      } catch {
        this.quarantine(id, generation, `retained sidecar anchor ${retainedName} disappeared`);
        return;
      }
    }

    const candidates: SegmentCandidate[] = [];
    retainedNames = await this.listRetainedSegments(id);
    const retainedCandidateName = this.retainedSegments.get(id) ?? retainedName;
    if (retainedCandidateName && !retainedNames.includes(retainedCandidateName)) retainedNames.push(retainedCandidateName);
    for (const name of retainedNames) candidates.push({ name, retained: true });
    for (const sealedName of await this.listSealedSegments(id)) {
      candidates.push({ name: sealedName });
    }
    // Active is a first-class candidate so source ordering is global rather
    // than segmented by pathname class. A final active read below still
    // catches an append racing the peek phase.
    candidates.push({ name: `${id}.jsonl`, active: true });
    this.sequenceGapDeferred.delete(id);
    await this.drainSegmentCandidates(id, candidates, generation);
    if (!this.isLive(id, generation) || this.quarantined.has(id)) return;
    if (this.sequenceGapDeferred.has(id)) return;
    if (candidates.some((candidate) => candidate.active
      ? this.partialRecords.has(id) || this.oversizedRecords.has(id)
      : this.segmentPartialRecords.has(this.segmentStateKey(id, candidate.name))
        || this.segmentOversizedRecords.has(this.segmentStateKey(id, candidate.name)))) {
      await this.checkBacklog(id, undefined, generation);
      return;
    }
    if (this.pendingSegmentCursorClears.has(id)) {
      await this.checkBacklog(id, undefined, generation);
      return;
    }
    if (!this.isLive(id, generation)) return;

    await this.readSource(id, false, undefined, generation);
    if (this.quarantined.has(id)) return;
    if (this.sequenceGapDeferred.has(id)) {
      this.pause(id, generation);
      return;
    }
    await this.checkBacklog(id, undefined, generation);
  }

  private segmentStateKey(id: string, name: string): string {
    return `${id}\u0000${name}`;
  }

  private segmentOffset(id: string, name = this.sealedSegments.get(id)): number | undefined {
    return name ? this.segmentOffsets.get(this.segmentStateKey(id, name)) : undefined;
  }

  private hasSegmentState(id: string): boolean {
    const prefix = `${id}\u0000`;
    for (const key of this.segmentOffsets.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  private clearSegmentState(id: string): void {
    const prefix = `${id}\u0000`;
    for (const map of [
      this.segmentOffsets,
      this.segmentIdentities,
      this.segmentPartialRecords,
      this.segmentOversizedRecords,
      this.segmentEmptyPolls,
      this.sequenceGapPolls,
    ]) {
      for (const key of map.keys()) {
        if (key.startsWith(prefix)) map.delete(key);
      }
    }
    this.sequenceGapDeferred.delete(id);
  }

  private fileIdentity(stats: { dev: unknown; ino: unknown }): string {
    return `${String(stats.dev)}:${String(stats.ino)}`;
  }

  private isSealedSegmentName(id: string, name: string): boolean {
    return name.startsWith(`.${id}.jsonl.`) && name.endsWith(SIDECAR_SEALED_FILE_SUFFIX);
  }

  private isRetainedSegmentName(id: string, name: string): boolean {
    return name.startsWith(`.${id}.jsonl.`)
      && (name.includes(SIDECAR_RETAINED_FILE_TOKEN)
        || name.includes(SIDECAR_DRAIN_FILE_TOKEN)
        || name.includes(SIDECAR_FINAL_GUARD_FILE_TOKEN));
  }

  private cursorMatchesSegment(cursorName: string | undefined, selectedName: string | undefined): boolean {
    if (!cursorName || !selectedName) return false;
    return cursorName === selectedName
      || this.isRetainedAliasFor(selectedName, cursorName)
;
  }

  private isRetainedAliasFor(name: string, sourceName: string): boolean {
    return [SIDECAR_RETAINED_FILE_TOKEN, SIDECAR_DRAIN_FILE_TOKEN, SIDECAR_FINAL_GUARD_FILE_TOKEN]
      .some((token) => name.startsWith(`${sourceName}${token}`));
  }

  private sealedProofPath(name: string): string {
    return join(this.dir, `${name}${SIDECAR_SEALED_PROOF_SUFFIX}`);
  }

  /** Remove only a proof whose matching sealed pathname is absent. */
  private cleanupOrphanProofs(id: string): void {
    try {
      for (const name of readdirSync(this.dir)) {
        if (!name.startsWith(`.${id}.jsonl.`) || !name.endsWith(`${SIDECAR_SEALED_FILE_SUFFIX}${SIDECAR_SEALED_PROOF_SUFFIX}`)) continue;
        const sealedName = name.slice(0, -SIDECAR_SEALED_PROOF_SUFFIX.length);
        if (existsSync(join(this.dir, sealedName))) continue;
        void durableUnlink(join(this.dir, name));
      }
    } catch {
      /* The directory may not exist until the producer starts. */
    }
  }

  private async sealedRetirementProof(name: string, identity: string): Promise<SealedRetirementProof | null> {
    try {
      const raw = JSON.parse(await readBoundedText(this.sealedProofPath(name), SIDECAR_PROOF_MAX_BYTES)) as Record<string, unknown>;
      const writerId = typeof raw.writerId === "string"
        ? raw.writerId
        : typeof raw.bridgeId === "string" ? raw.bridgeId : undefined;
      if (
        raw.version !== 2
        || raw.state !== "closed"
        || raw.sealedName !== name
        || typeof raw.generation !== "string"
        || raw.generation.length === 0
        || raw.generation.length > 256
        || typeof writerId !== "string"
        || writerId.length === 0
        || writerId.length > 256
        || raw.identity !== identity
        || typeof raw.lastSeq !== "number"
        || !Number.isSafeInteger(raw.lastSeq)
        || raw.lastSeq < 1
      ) return null;
      return {
        writerId,
        generation: raw.generation,
        sealedName: name,
        identity,
        lastSeq: raw.lastSeq,
      };
    } catch {
      return null;
    }
  }

  /**
   * Verify the proof against the immutable inode contents, not just marker
   * metadata. Every complete record in a proven generation must carry the
   * same writer generation and end at the writer's declared sequence. This
   * catches an external descriptor append in the final retirement window:
   * the temporary verification anchor is scanned after the published names
   * are unlinked, while the inode is still reachable.
   */
  private async verifySealedPublication(
    name: string,
    path: string,
    identity: string,
  ): Promise<boolean> {
    const proof = await this.sealedRetirementProof(name, identity);
    if (!proof) return false;
    try {
      const stats = await statFile(path);
      if (this.fileIdentity(stats) !== identity || stats.size <= 0 || stats.size > MAX_SIDECAR_BYTES) return false;
      const text = await readBoundedText(path, MAX_SIDECAR_BYTES);
      if (!text.endsWith("\n")) return false;
      let previousSeq = 0;
      let records = 0;
      let lineStart = 0;
      while (lineStart < text.length) {
        const lineEnd = text.indexOf("\n", lineStart);
        if (lineEnd < 0) return false;
        const line = text.slice(lineStart, lineEnd);
        lineStart = lineEnd + 1;
        if (!line) continue;
        const rec = parseSidecarRecord(line);
        if (!rec) return false;
        const envelope = sidecarEnvelope(rec);
        if (!envelope || envelope.bridgeId !== proof.writerId || rec.generation !== proof.generation) return false;
        if (envelope.seq <= previousSeq) return false;
        previousSeq = envelope.seq;
        records++;
      }
      return records > 0 && previousSeq === proof.lastSeq;
    } catch {
      return false;
    }
  }

  private listSealedSegmentsSync(id: string): string[] {
    try {
      return readdirSync(this.dir)
        .filter((name) => this.isSealedSegmentName(id, name))
        .sort();
    } catch {
      return [];
    }
  }

  private listRetainedSegmentsSync(id: string): string[] {
    try {
      return readdirSync(this.dir)
        .filter((name) => this.isRetainedSegmentName(id, name))
        .sort();
    } catch {
      return [];
    }
  }

  private async listSealedSegments(id: string): Promise<string[]> {
    try {
      const names = await readDirectory(this.dir);
      return names.filter((name) => this.isSealedSegmentName(id, name)).sort();
    } catch {
      return [];
    }
  }

  private async listRetainedSegments(id: string): Promise<string[]> {
    try {
      const names = await readDirectory(this.dir);
      return names.filter((name) => this.isRetainedSegmentName(id, name)).sort();
    } catch {
      return [];
    }
  }

  private retainedBaseName(id: string, name: string): string | null {
    for (const token of [SIDECAR_RETAINED_FILE_TOKEN, SIDECAR_DRAIN_FILE_TOKEN, SIDECAR_FINAL_GUARD_FILE_TOKEN]) {
      const index = name.indexOf(token);
      if (index <= 0) continue;
      const base = name.slice(0, index);
      if (this.isSealedSegmentName(id, base)) return base;
    }
    return null;
  }

  /**
   * Recover a tailer-created hard-link chain after a crash. Multiple aliases
   * are safe to collapse only when stat() proves they are the same inode;
   * distinct identities are an ambiguous generation boundary and quarantine
   * the terminal. The surviving alias is then the sole descriptor-safe source
   * used by the normal retained drain path.
   */
  private async adoptRetainedAnchor(id: string, generation: number, names: string[]): Promise<string | false | null> {
    if (names.length === 0) return null;
    if (!this.isLive(id, generation)) return false;
    if (names.some((name) => this.retainedBaseName(id, name) === null)) {
      this.quarantine(id, generation, "retained sidecar anchor has no sealed generation provenance");
      return false;
    }
    const entries: Array<{ name: string; identity: string }> = [];
    for (const name of names) {
      try {
        entries.push({ name, identity: this.fileIdentity(await statFile(join(this.dir, name))) });
      } catch {
        this.quarantine(id, generation, `retained sidecar anchor ${name} disappeared`);
        return false;
      }
    }
    const identities = new Set(entries.map((entry) => entry.identity));
    if (identities.size !== 1) {
      this.quarantine(id, generation, "retained sidecar anchors have different identities");
      return false;
    }
    const identity = entries[0].identity;
    const currentDrain = this.segmentDrainPaths.get(id);
    const preferred = this.retainedSegments.get(id)
      ?? (currentDrain ? basename(currentDrain) : undefined);
    const selected = entries.find((entry) => entry.name === preferred)?.name ?? entries[0].name;
    const selectedKey = this.segmentStateKey(id, selected);
    const priorName = this.sealedSegments.get(id);
    // `sealedSegments` is also the scheduler's last-selected source. A
    // retired identity may be selected after a retained canonical anchor has
    // already delivered its records; it is not an ABA replacement of that
    // retained inode and must not invalidate the retired cursor.
    const priorIsRetained = priorName !== undefined && this.isRetainedSegmentName(id, priorName);
    const priorKey = priorIsRetained ? this.segmentStateKey(id, priorName) : undefined;
    const priorIdentity = priorKey ? this.segmentIdentities.get(priorKey) : undefined;
    if (priorIdentity && priorIdentity !== identity) {
      this.quarantine(id, generation, "retained sidecar anchor changed identity");
      return false;
    }
    if (!this.segmentOffsets.has(selectedKey)) {
      const cursor = this.durableCursors.get(id);
      const offset = (priorKey ? this.segmentOffsets.get(priorKey) : undefined)
        ?? (cursor?.sealedSegment && this.cursorMatchesSegment(cursor.sealedSegment, selected) ? cursor.sealedOffset : undefined)
        ?? 0;
      this.segmentOffsets.set(selectedKey, offset);
      const priorPartial = priorKey ? this.segmentPartialRecords.get(priorKey) : undefined;
      if (priorPartial) this.segmentPartialRecords.set(selectedKey, priorPartial);
      const priorOversized = priorKey ? this.segmentOversizedRecords.get(priorKey) : undefined;
      if (priorOversized) this.segmentOversizedRecords.set(selectedKey, priorOversized);
    }
    if (priorKey && priorKey !== selectedKey) {
      this.segmentOffsets.delete(priorKey);
      this.segmentIdentities.delete(priorKey);
      this.segmentPartialRecords.delete(priorKey);
      this.segmentOversizedRecords.delete(priorKey);
      this.segmentEmptyPolls.delete(priorKey);
    }
    this.segmentIdentities.set(selectedKey, identity);
    this.segmentEmptyPolls.set(selectedKey, 0);
    this.sealedSegments.set(id, selected);
    this.retainedSegments.set(id, selected);
    this.segmentDrainPaths.set(id, join(this.dir, selected));

    // A prior lifecycle may have left a first drain link, final guard, and
    // retained link to the same inode. Keep one survivor and unlink only the
    // redundant names whose identity was just proven equal.
    for (const entry of entries) {
      if (entry.name === selected) continue;
      try {
        await durableUnlink(join(this.dir, entry.name));
      } catch {
        this.quarantine(id, generation, `retained sidecar alias ${entry.name} could not be retired safely`);
        return false;
      }
      const key = this.segmentStateKey(id, entry.name);
      this.segmentOffsets.delete(key);
      this.segmentIdentities.delete(key);
      this.segmentPartialRecords.delete(key);
      this.segmentOversizedRecords.delete(key);
      this.segmentEmptyPolls.delete(key);
    }

    // If the crash happened before the first sealed unlink, the published
    // name is another hard link to this same inode. Remove only that proven
    // duplicate; a different sealed identity is an unprocessed generation.
    for (const sealedName of await this.listSealedSegments(id)) {
      try {
        const sealedIdentity = this.fileIdentity(await statFile(join(this.dir, sealedName)));
        if (sealedIdentity !== identity) {
          this.quarantine(id, generation, "sealed generation appeared beside a retained anchor");
          return false;
        }
        await durableUnlink(join(this.dir, sealedName));
      } catch {
        this.quarantine(id, generation, `sealed generation ${sealedName} could not be reconciled`);
        return false;
      }
    }
    if (!(await this.persistCursor(id, {
      offset: this.offsets.get(id) ?? 0,
      sealedOffset: this.segmentOffsets.get(selectedKey) ?? 0,
      sealedIdentity: identity,
      sealedSegment: selected,
    }, generation))) {
      this.quarantine(id, generation, "retained sidecar cursor could not be persisted");
      return false;
    }
    return selected;
  }

  private sourcePath(id: string, name: string): string {
    const drainPath = this.segmentDrainPaths.get(id);
    const retainedName = this.retainedSegments.get(id);
    // A retained canonical inode and retired ABA anchors can coexist. Only
    // the retained name resolves through the drain link; candidate retired
    // names must continue to resolve to their own identity-bound path.
    if (drainPath && (name === retainedName || (!retainedName && name === this.sealedSegments.get(id)))) return drainPath;
    return join(this.dir, name);
  }

  private sourceState(id: string, segment: boolean, segmentName?: string): SourceState {
    const key = segment && segmentName ? this.segmentStateKey(id, segmentName) : undefined;
    return {
      offset: segment ? (this.segmentOffsets.get(key!) ?? 0) : (this.offsets.get(id) ?? 0),
      partial: segment ? (this.segmentPartialRecords.get(key!) ?? Buffer.alloc(0)) : (this.partialRecords.get(id) ?? Buffer.alloc(0)),
      oversized: segment ? this.segmentOversizedRecords.get(key!) : this.oversizedRecords.get(id),
    };
  }

  private storeSourceState(id: string, segment: boolean, state: SourceState, segmentName?: string): void {
    if (segment) {
      const key = this.segmentStateKey(id, segmentName!);
      this.segmentOffsets.set(key, state.offset);
      if (state.partial.length > 0) this.segmentPartialRecords.set(key, state.partial);
      else this.segmentPartialRecords.delete(key);
      if (state.oversized) this.segmentOversizedRecords.set(key, state.oversized);
      else this.segmentOversizedRecords.delete(key);
    } else {
      this.offsets.set(id, state.offset);
      if (state.partial.length > 0) this.partialRecords.set(id, state.partial);
      else this.partialRecords.delete(id);
      if (state.oversized) this.oversizedRecords.set(id, state.oversized);
      else this.oversizedRecords.delete(id);
    }
  }

  /** Peek only the next complete enveloped record for source scheduling. */
  private async peekSegmentRecord(
    id: string,
    name: string,
    generation: number,
    segment = true,
  ): Promise<PeekedSegmentRecord> {
    if (!this.isLive(id, generation)) return { envelope: null, hasBytes: false };
    const state = this.sourceState(id, segment, name);
    const file = segment ? this.sourcePath(id, name) : join(this.dir, `${id}.jsonl`);
    let identity: string | undefined;
    let initialSize = 0;
    try {
      const initial = await statFile(file);
      identity = this.fileIdentity(initial);
      initialSize = initial.size;
    } catch {
      return { envelope: null, hasBytes: false };
    }
    const readOffset = state.oversized ? state.offset : state.offset + state.partial.length;
    const hasInitialBytes = state.partial.length > 0 || initialSize > readOffset;
    if (state.oversized) return { envelope: null, hasBytes: hasInitialBytes, oversized: true };

    // Keep only the current logical line. It is bounded by maxRecordBytes;
    // chunks are released as soon as a complete line is parsed. This avoids
    // the old one-megabyte peek truncating a valid multi-megabyte envelope.
    let lineParts: Buffer[] = state.partial.length > 0 ? [state.partial] : [];
    let lineBytes = state.partial.length;
    let position = readOffset;
    let hasBytes = hasInitialBytes;
    let handle: Awaited<ReturnType<typeof openFile>> | undefined;
    try {
      handle = await openFile(file, "r");
      if (this.fileIdentity(await handle.stat()) !== identity) {
        // The pathname changed between stat and open. Let the normal source
        // reader handle a segment identity mismatch before any later source
        // can overtake bytes from the replaced inode.
        return { envelope: null, hasBytes: true, incomplete: true };
      }
      for (;;) {
        const remaining = this.maxRecordBytes - lineBytes;
        if (remaining <= 0) {
          // A newline would make this record larger than the hard cap.
          return { envelope: null, hasBytes: true, oversized: true };
        }
        const buffer = Buffer.alloc(Math.min(SIDECAR_TAIL_READ_BYTES, remaining));
        const result = await handle.read(buffer, 0, buffer.length, position);
        if (result.bytesRead === 0) {
          // EOF is racy with an append. Re-stat before deciding that the
          // nonempty logical line is incomplete and must block later sources.
          const latest = await statFile(file);
          if (this.fileIdentity(latest) !== identity) return { envelope: null, hasBytes: true, incomplete: true };
          if (latest.size > position) continue;
          return { envelope: null, hasBytes, incomplete: lineBytes > 0 };
        }
        hasBytes = true;
        const chunk = buffer.subarray(0, result.bytesRead);
        let cursor = 0;
        while (cursor < chunk.length) {
          const lineEnd = chunk.indexOf(0x0a, cursor);
          if (lineEnd < 0) {
            const piece = chunk.subarray(cursor);
            lineParts.push(piece);
            lineBytes += piece.length;
            break;
          }
          const piece = chunk.subarray(cursor, lineEnd);
          if (piece.length > 0) {
            lineParts.push(piece);
            lineBytes += piece.length;
          }
          const line = lineBytes > 0 ? Buffer.concat(lineParts, lineBytes).toString("utf8") : "";
          lineParts = [];
          lineBytes = 0;
          cursor = lineEnd + 1;
          if (!line.trim()) continue;
          const rec = parseSidecarRecord(line);
          const envelope = rec ? sidecarEnvelope(rec) : null;
          if (envelope) return { envelope, hasBytes };
        }
        position += result.bytesRead;
        if (lineBytes >= this.maxRecordBytes) {
          return { envelope: null, hasBytes: true, oversized: true };
        }
        // A short read can be an EOF or a concurrent append. The next loop
        // handles the latter after a bounded stat; full chunks continue
        // directly, still capped by maxRecordBytes.
        if (result.bytesRead < buffer.length) {
          const latest = await statFile(file);
          if (this.fileIdentity(latest) !== identity) return { envelope: null, hasBytes: true, incomplete: true };
          if (latest.size <= position) return { envelope: null, hasBytes, incomplete: lineBytes > 0 };
        }
      }
    } catch {
      // A nonempty source that cannot be completely peeked is unsafe to let
      // a later candidate overtake. Keep it ahead of active data and retry.
      return { envelope: null, hasBytes: hasBytes || lineBytes > 0, incomplete: hasBytes || lineBytes > 0 };
    } finally {
      try {
        await handle?.close();
      } catch {
        /* A failed peek is retried by the bounded tail loop. */
      }
    }
  }

  /** Drain segment identities in next-sequence order, not pathname order. */
  private async drainSegmentCandidates(id: string, candidates: SegmentCandidate[], generation: number): Promise<void> {
    const pending = new Map<string, SegmentCandidate>();
    for (const candidate of candidates) {
      if (!pending.has(candidate.name)) pending.set(candidate.name, candidate);
    }
    while (pending.size > 0) {
      if (!this.isLive(id, generation) || this.quarantined.has(id)) return;
      if (this.segmentDrainPaths.has(id) && [...pending.values()].some((candidate) => !candidate.retained && !candidate.active)) {
        // A retained identity is already the last safe anchor for an older
        // canonical generation. A later sealed pathname cannot be admitted
        // beside it without proving both identities and their order; keep the
        // sealed bytes and fail closed before any source can overtake it.
        this.quarantine(id, generation, "canonical generation appeared beside a retained identity anchor");
        return;
      }
      const ranked: Array<{ candidate: SegmentCandidate; peek: PeekedSegmentRecord; rank: number }> = [];
      for (const candidate of pending.values()) {
        const peek = await this.peekSegmentRecord(id, candidate.name, generation, !candidate.active);
        if (peek.oversized && !candidate.active) {
          // A segment source cannot safely skip an over-cap record: its
          // sequence is unknowable and active data must not overtake it. Keep
          // an explicit in-memory state for the lifecycle and persist the
          // terminal-local quarantine before any cursor advancement.
          const state = this.sourceState(id, true, candidate.name);
          state.oversized ??= { bytes: this.maxRecordBytes, diagnosticEmitted: false };
          this.reportOversizedRecord(id, state.oversized);
          this.storeSourceState(id, true, state, candidate.name);
          this.quarantine(id, generation, `sidecar source ${candidate.name} exceeded the ${this.maxRecordBytes}-byte record cap`);
          return;
        }
        const expected = this.streams.get(id)?.sequence;
        const next = expected === undefined ? undefined : expected + 1;
        const isNext = next !== undefined && peek.envelope?.seq === next;
        ranked.push({
          candidate,
          peek,
          // An incomplete first line is an unknown earlier record. It must
          // remain ahead of every complete later candidate until the line is
          // completed or the hard cap proves it oversized.
          // An oversized line is ranked first so readSource can reject it at
          // its bounded first chunk; a later active sequence cannot overtake
          // an unterminated over-cap source.
          rank: peek.oversized ? -2 : peek.incomplete ? -1 : isNext ? 0 : peek.envelope ? 1 : peek.hasBytes ? 2 : 3,
        });
      }
      if (!this.isLive(id, generation) || this.quarantined.has(id)) return;
      ranked.sort((left, right) => {
        if (left.rank !== right.rank) return left.rank - right.rank;
        const leftSeq = left.peek.envelope?.seq ?? Number.MAX_SAFE_INTEGER;
        const rightSeq = right.peek.envelope?.seq ?? Number.MAX_SAFE_INTEGER;
        if (leftSeq !== rightSeq) return leftSeq - rightSeq;
        if (left.candidate.retained !== right.candidate.retained) return left.candidate.retained ? -1 : 1;
        return left.candidate.name < right.candidate.name ? -1 : left.candidate.name > right.candidate.name ? 1 : 0;
      });
      const chosen = ranked[0]!.candidate;
      if (chosen.active) {
        await this.readSource(id, false, undefined, generation, false);
      } else {
        this.sealedSegments.set(id, chosen.name);
        await this.readSource(id, true, chosen.name, generation, !chosen.retained);
      }
      if (!this.isLive(id, generation) || this.quarantined.has(id)) return;
      const chosenKey = chosen.active ? `${id}\u0000<active>` : this.segmentStateKey(id, chosen.name);
      const chosenOversized = chosen.active
        ? this.oversizedRecords.has(id)
        : this.segmentOversizedRecords.has(chosenKey);
      if (chosenOversized && !chosen.active) {
        this.quarantine(id, generation, `sidecar source ${chosen.name} exceeded the ${this.maxRecordBytes}-byte record cap without a bounded terminating newline`);
        return;
      }
      pending.delete(chosen.name);
      if (this.segmentDrainPaths.has(id) && [...pending.values()].some((candidate) => !candidate.retained && !candidate.active)) {
        // A second canonical generation beside a retained identity cannot be
        // ordered or safely discarded. Preserve it and stop admission.
        this.quarantine(id, generation, "canonical generation appeared beside a retained identity anchor");
        return;
      }
      const key = chosenKey;
      const deferred = this.sequenceGapPolls.has(key);
      const hasPartial = chosen.active
        ? this.partialRecords.has(id) || this.oversizedRecords.has(id)
        : this.segmentPartialRecords.has(key) || this.segmentOversizedRecords.has(key);
      if (hasPartial && !deferred) {
        await this.checkBacklog(id, undefined, generation);
        return;
      }
    }
    if (this.sequenceGapDeferred.has(id)) this.pause(id, generation);
  }

  private async readSource(
    id: string,
    segment: boolean,
    segmentName?: string,
    generation = this.terminalGenerations.get(id),
    reclaim = true,
  ): Promise<void> {
    if (!this.isLive(id, generation)) return;
    const resolvedSegmentName = segmentName ?? this.sealedSegments.get(id);
    if (segment && !resolvedSegmentName) return;
    const sourceName = resolvedSegmentName ?? "";
    const file = segment ? this.sourcePath(id, sourceName) : join(this.dir, `${id}.jsonl`);
    const segmentKey = segment ? this.segmentStateKey(id, sourceName) : undefined;
    const state = this.sourceState(id, segment, sourceName);
    let size: number;
    let identity: string | undefined;
    try {
      const stats = await statFile(file);
      size = stats.size;
      identity = this.fileIdentity(stats);
    } catch {
      if (segment) {
        // A segment/anchor disappearing is not evidence that it was drained:
        // an external cleanup may have removed the only name for an inode.
        // Never clear its cursor and advance active bytes in that case.
        this.quarantine(id, generation, `sidecar source ${sourceName} disappeared`);
      }
      return;
    }
    if (segment && identity) {
      const priorIdentity = this.segmentIdentities.get(segmentKey!);
      if (priorIdentity && priorIdentity !== identity) {
        if (this.isRetainedSegmentName(id, sourceName) || this.isSealedSegmentName(id, sourceName)) {
          // An anchor pathname changing identity is an ABA replacement of the
          // very provenance record that made the cursor restart-safe. Resetting
          // it by size would skip an entire generation; stop before active
          // bytes can overtake the unknown inode.
          this.quarantine(id, generation, `sidecar anchor ${sourceName} changed identity`);
          return;
        }
        state.offset = 0;
        state.partial = Buffer.alloc(0);
        state.oversized = undefined;
        this.segmentPartialRecords.delete(segmentKey!);
        this.segmentOversizedRecords.delete(segmentKey!);
        this.segmentEmptyPolls.delete(segmentKey!);
      }
      this.segmentIdentities.set(segmentKey!, identity);
    }
    if (!this.isLive(id, generation)) return;
    if (!segment && (await this.listSealedSegments(id)).length > 0) return;
    if (size < state.offset) {
      state.offset = 0;
      state.partial = Buffer.alloc(0);
      state.oversized = undefined;
      if (!segment) {
        // A canonical rotation replaces the active pathname while its prior
        // identity is still being drained. Keep stream sequence ownership in
        // that case; resetting it would let active seq4 overtake a retained
        // retired/canonical seq3. A truncation without any segment state is a
        // genuine new active stream and may reset ownership.
        if (!this.hasSegmentState(id)) {
          this.streams.delete(id);
          this.bridgeIds.delete(id);
        }
        if (!(await this.persistCursor(id, { offset: 0 }, generation))) {
          this.storeSourceState(id, false, state);
          this.pause(id, generation);
          return;
        }
      } else if (!(await this.persistCursor(id, {
        offset: this.offsets.get(id) ?? 0,
        sealedOffset: 0,
        sealedIdentity: identity,
        sealedSegment: sourceName,
      }, generation))) {
        this.storeSourceState(id, true, state, sourceName);
        this.pause(id, generation);
        return;
      }
    }
    if (!this.isLive(id, generation)) return;

    const partial = state.partial;
    const oversized = state.oversized;
    // Read from the end of a retained partial record. The durable cursor
    // remains at the beginning of that record until its newline is handled.
    const readOffset = oversized ? state.offset : state.offset + partial.length;
    let chunk = Buffer.alloc(0);
    if (size > readOffset) {
      const want = size - readOffset;
      // Keep normal tail reads responsive, but never concatenate more than
      // one byte beyond the configured record cap while classifying a line.
      // That byte distinguishes an exact-cap line from an over-cap line
      // without allocating an unbounded complete oversized record.
      const continuationCap = oversized
        ? SIDECAR_TAIL_READ_BYTES
        : Math.max(1, this.maxRecordBytes - partial.length + 1);
      const cap = Math.min(want, SIDECAR_TAIL_READ_BYTES, continuationCap);
      try {
        const handle = await openFile(file, "r");
        try {
          // The active pathname may have been atomically replaced between
          // its initial stat and open(). Never read a new active inode under
          // the old cursor: its records could overtake a sealed identity.
          if (this.fileIdentity(await handle.stat()) !== identity) return;
          const buffer = Buffer.alloc(cap);
          const result = await handle.read(buffer, 0, cap, readOffset);
          chunk = buffer.subarray(0, result.bytesRead);
        } finally {
          await handle.close();
        }
      } catch {
        return;
      }
    } else if (partial.length === 0 && !oversized) {
      this.storeSourceState(id, segment, state, sourceName);
      if (segment && reclaim && !this.segmentDrainPaths.has(id) && !this.isRetainedSegmentName(id, sourceName) && this.isSealedSegmentName(id, sourceName)) {
        await this.maybeReclaimSegment(id, sourceName, state.offset, generation);
      }
      return;
    }
    if (!this.isLive(id, generation)) return;

    // Active-path compatibility may skip an over-cap line once its newline is
    // observed. Segment identities use the fail-closed branches below instead
    // of advancing a durable cursor without delivering an event.
    let data = oversized ? chunk : (partial.length > 0 ? Buffer.concat([partial, chunk]) : chunk);
    let baseOffset = state.offset;
    let cursor = 0;
    if (oversized) {
      const newline = data.indexOf(0x0a);
      if (newline === -1) {
        oversized.bytes += data.length;
        state.offset += data.length;
        this.reportOversizedRecord(id, oversized);
        this.storeSourceState(id, segment, state, sourceName);
        if (segment) this.quarantine(id, generation, `sidecar source ${sourceName} exceeded the ${this.maxRecordBytes}-byte record cap without a bounded terminating newline`);
        return;
      }
      oversized.bytes += newline + 1;
      if (segment) {
        // The line is now complete, but it was already proven over-cap. Do
        // not turn a delayed newline into permission to advance a durable
        // segment cursor or admit active records.
        this.reportOversizedRecord(id, oversized);
        this.storeSourceState(id, true, state, sourceName);
        this.quarantine(id, generation, `sidecar source ${sourceName} exceeded the ${this.maxRecordBytes}-byte record cap`);
        return;
      }
      state.offset += newline + 1;
      state.oversized = undefined;
      data = data.subarray(newline + 1);
      baseOffset = state.offset;
    }

    let committedOffset = state.offset;
    for (;;) {
      const lineEnd = data.indexOf(0x0a, cursor);
      if (lineEnd < 0) break;
      const lineBytes = data.subarray(cursor, lineEnd);
      const nextOffset = baseOffset + lineEnd + 1;
      const recordBytes = lineBytes.length + 1;
      if (recordBytes > this.maxRecordBytes) {
        if (segment) {
          // Segment identities are the only recoverable source for a retired
          // or retired generation. An over-cap complete line has no safe
          // sequence semantics; retain its cursor at the line start and
          // quarantine the identity rather than silently advancing past it.
          state.oversized = { bytes: recordBytes, diagnosticEmitted: false };
          this.reportOversizedRecord(id, state.oversized);
          this.storeSourceState(id, true, state, sourceName);
          this.quarantine(id, generation, `sidecar source ${sourceName} exceeded the ${this.maxRecordBytes}-byte record cap`);
          return;
        }
        this.reportOversizedRecord(id, { bytes: recordBytes, diagnosticEmitted: false });
        committedOffset = nextOffset;
        cursor = lineEnd + 1;
        state.offset = committedOffset;
        continue;
      }
      const line = lineBytes.toString("utf8");
      if (!this.offsets.has(id)) return;
      if (!line.trim()) {
        committedOffset = nextOffset;
        cursor = lineEnd + 1;
        state.offset = committedOffset;
        continue;
      }
      const rec = parseSidecarRecord(line);
      if (!rec) {
        committedOffset = nextOffset;
        cursor = lineEnd + 1;
        state.offset = committedOffset;
        continue;
      }
      const envelope = sidecarEnvelope(rec);
      if (!envelope) {
        committedOffset = nextOffset;
        cursor = lineEnd + 1;
        state.offset = committedOffset;
        continue;
      }
      const disposition = this.eventDisposition(id, envelope, rec.t, segment);
      if (disposition === "defer") {
        // A newer source cannot overtake an older identity with a sequence
        // gap. Keep the exact line at the source cursor and retry after the
        // old descriptor's append becomes visible. There is no safe way to
        // infer that an external descriptor is closed, so quarantine after a
        // bounded retry budget instead of retrying forever.
        const gapKey = segment ? this.segmentStateKey(id, sourceName) : `${id}\u0000<active>`;
        const gapPolls = (this.sequenceGapPolls.get(gapKey) ?? 0) + 1;
        this.sequenceGapPolls.set(gapKey, gapPolls);
        this.sequenceGapDeferred.add(id);
        state.partial = data.subarray(cursor);
        this.storeSourceState(id, segment, state, sourceName);
        if (gapPolls >= SIDECAR_MAX_SEQUENCE_GAP_POLLS) {
          this.quarantine(id, generation, "retired source sequence gap did not close within the bounded retry budget");
          return;
        }
        return;
      }
      const gapKey = segment ? this.segmentStateKey(id, sourceName) : `${id}\u0000<active>`;
      this.sequenceGapPolls.delete(gapKey);
      this.sequenceGapDeferred.delete(id);
      if (disposition === "skip") {
        committedOffset = nextOffset;
        cursor = lineEnd + 1;
        state.offset = committedOffset;
        continue;
      }
      const event = sidecarEventBody(envelope, rec);
      if (event) {
        let delivery: SidecarEventDelivery | boolean | void | Promise<SidecarEventDelivery | boolean | void> = true;
        try {
          delivery = this.onEvent(id, event);
          if (delivery && typeof delivery === "object" && "then" in delivery && typeof delivery.then === "function") {
            this.pendingDeliveries.add(id);
          }
          delivery = await Promise.resolve(delivery);
        } catch {
          this.pendingDeliveries.delete(id);
          delivery = false;
        }
        const accepted = delivery !== false
          && delivery !== null
          && !(typeof delivery === "object" && delivery.accepted === false);
        if (!accepted) {
          this.pendingDeliveries.delete(id);
          if (!this.isLive(id, generation)) return;
          state.partial = data.subarray(cursor);
          this.storeSourceState(id, segment, state, sourceName);
          this.pause(id, generation);
          return;
        }
        if (typeof delivery === "object" && delivery !== null && delivery.completed) {
          this.pendingDeliveries.add(id);
          try {
            await delivery.completed;
          } catch {
            this.pendingDeliveries.delete(id);
            if (!this.isLive(id, generation)) return;
            state.partial = data.subarray(cursor);
            this.storeSourceState(id, segment, state, sourceName);
            this.pause(id, generation);
            return;
          }
          this.pendingDeliveries.delete(id);
          if (!this.isLive(id, generation)) return;
        } else {
          this.pendingDeliveries.delete(id);
        }
      }
      if (!this.isLive(id, generation)) return;
      const cursorNext: DurableSidecarCursor = segment
        ? {
          version: SIDECAR_CURSOR_VERSION,
          offset: this.offsets.get(id) ?? 0,
          sealedOffset: nextOffset,
          sealedIdentity: identity,
          bridgeId: envelope.bridgeId,
          sequence: envelope.seq,
        }
        : {
          version: SIDECAR_CURSOR_VERSION,
          offset: nextOffset,
          ...(this.hasSegmentState(id) ? { sealedOffset: this.segmentOffset(id) } : {}),
          bridgeId: envelope.bridgeId,
          sequence: envelope.seq,
        };
      if (!(await this.persistCursor(id, {
        ...cursorNext,
        ...(segment ? { sealedSegment: resolvedSegmentName } : {}),
      }, generation))) {
        if (!this.isLive(id, generation)) return;
        state.partial = data.subarray(cursor);
        this.storeSourceState(id, segment, state, sourceName);
        this.pause(id, generation);
        return;
      }
      if (!this.isLive(id, generation)) return;
      // Unknown-but-enveloped records still advance stream ownership and
      // occupy their sequence slot, while a rejected valid event does not.
      this.acceptEvent(id, envelope, rec.t);
      committedOffset = nextOffset;
      cursor = lineEnd + 1;
      state.offset = committedOffset;
    }

    const trailing = data.subarray(cursor);
    state.partial = Buffer.alloc(0);
    if (trailing.length > 0) {
      if (trailing.length > this.maxRecordBytes) {
        state.oversized = { bytes: trailing.length, diagnosticEmitted: false };
        // Drop only an explicitly over-cap record's retained prefix. The
        // cursor resumes at the end of the bytes we have classified.
        state.offset = baseOffset + data.length;
        this.reportOversizedRecord(id, state.oversized);
      } else {
        state.partial = Buffer.from(trailing);
        state.offset = committedOffset;
      }
    }
    if (!this.isLive(id, generation)) return;
    this.storeSourceState(id, segment, state, sourceName);

    if (segment && reclaim && !state.partial.length && !state.oversized && !this.segmentDrainPaths.has(id) && !this.isRetainedSegmentName(id, sourceName) && this.isSealedSegmentName(id, sourceName)) {
      await this.maybeReclaimSegment(id, sourceName, state.offset, generation);
    }
  }

  private quarantinePath(id: string): string {
    return join(this.dir, `${SIDECAR_QUARANTINE_FILE_PREFIX}${id}`);
  }

  private hasQuarantineMarkerSync(id: string): boolean {
    try {
      return existsSync(this.quarantinePath(id));
    } catch {
      return false;
    }
  }

  /**
   * Permanently stop this terminal's compatibility admission for the current
   * lifecycle. A missing identity-bound anchor cannot be repaired by polling;
   * retaining the active cursor would be a silent data-loss choice. The
   * terminal-local marker lets synchronous producers fail fast rather than
   * spin forever behind a stale sealed generation. A new lifecycle rechecks
   * the on-disk source set before it can clear this state.
   */
  private quarantine(id: string, generation: number, reason: string): void {
    if (!this.isLive(id, generation)) return;
    const first = !this.quarantined.has(id);
    this.quarantined.add(id);
    this.paused.add(id);
    if (first) {
      const marker = this.quarantinePath(id);
      void durableAtomicWrite(marker, JSON.stringify({ version: 1, state: "quarantined", terminalId: id, reason: reason.slice(0, 256) }) + "\n").catch((error) => {
        if (this.isLive(id, generation)) {
          console.warn(`[sidecar] could not publish ${id} compatibility quarantine: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    }
    void this.setBackpressureMarker(id, 0, generation);
  }

  private async clearQuarantineMarker(id: string): Promise<void> {
    try {
      await durableUnlink(this.quarantinePath(id));
    } catch {
      /* Lifecycle teardown is best effort; the next watch revalidates sources. */
    }
  }

  /**
   * Retire the published names of a canonical generation while retaining one
   * durable identity anchor. A temporary hard link keeps the inode reachable
   * while the original link is removed, and the retained link is never
   * removed because POSIX cannot prove that an escaped descriptor will not
   * append after a verification read. Retired `.segment` files never enter
   * this method and are intentionally left in place.
   */
  private async maybeReclaimSegment(id: string, name: string, offset: number, generation: number): Promise<boolean> {
    if (!this.isLive(id, generation) || !this.isSealedSegmentName(id, name)) return false;
    const segment = join(this.dir, name);
    const segmentKey = this.segmentStateKey(id, name);
    let size: number;
    let identity: string;
    try {
      const stats = await statFile(segment);
      size = stats.size;
      identity = this.fileIdentity(stats);
    } catch {
      return false;
    }
    if (!this.isLive(id, generation)) return false;
    if (size !== offset) {
      this.segmentEmptyPolls.set(segmentKey, 0);
      return false;
    }
    const emptyPolls = (this.segmentEmptyPolls.get(segmentKey) ?? 0) + 1;
    this.segmentEmptyPolls.set(segmentKey, emptyPolls);
    if (emptyPolls < 2) return false;
    if (!(await this.setBackpressureMarker(id, offset, generation)) || !this.isLive(id, generation)) return false;

    let drainPath: string | undefined;
    let verificationPath: string | undefined;
    try {
      const afterStats = await statFile(segment);
      const after = afterStats.size;
      if (!this.isLive(id, generation)) return false;
      if (this.fileIdentity(afterStats) !== identity) {
        this.segmentEmptyPolls.set(segmentKey, 0);
        return false;
      }
      if (after !== (this.segmentOffsets.get(segmentKey) ?? offset)) {
        this.segmentEmptyPolls.set(segmentKey, 0);
        return false;
      }
      if (!(await this.persistCursor(id, {
        offset: this.offsets.get(id) ?? 0,
        sealedOffset: after,
        sealedIdentity: identity,
        sealedSegment: name,
      }, generation)) || !this.isLive(id, generation)) return false;

      // link() is the proof that the inode remains reachable after the
      // published sealed pathname is removed. If the platform cannot create
      // it, fail closed and leave the sealed generation untouched.
      drainPath = `${segment}.draining-${randomUUID()}`;
      await linkFile(segment, drainPath);
      await syncParentDirectory(drainPath);
      if (!this.isLive(id, generation)) return false;
      this.segmentDrainPaths.set(id, drainPath);
      await durableUnlink(segment);
      if (!this.isLive(id, generation)) return false;

      // The delayed-unlink window is deliberately drained through the hard
      // link. This also catches an append from a retired descriptor which was
      // opened before the writer published the sealed generation.
      await this.readSource(id, true, name, generation, false);
      if (!this.isLive(id, generation)) return false;
      for (let pass = 0; pass < 3; pass++) {
        const latest = (await statFile(drainPath)).size;
        const current = this.segmentOffsets.get(segmentKey) ?? 0;
        if (latest !== current) {
          await this.readSource(id, true, name, generation, false);
          if (!this.isLive(id, generation)) return false;
          continue;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        if ((await statFile(drainPath)).size !== latest) continue;
        break;
      }
      const finalOffset = this.segmentOffsets.get(segmentKey) ?? 0;
      if (this.segmentPartialRecords.has(segmentKey) || this.segmentOversizedRecords.has(segmentKey)) return false;
      if (!(await this.persistCursor(id, {
        offset: this.offsets.get(id) ?? 0,
        sealedOffset: finalOffset,
        sealedIdentity: identity,
        sealedSegment: name,
      }, generation)) || !this.isLive(id, generation)) return false;

      // A final guard link ensures the first retirement unlink cannot make an
      // inode unreachable while a descriptor is still being drained.
      const finalGuard = `${drainPath}.final-${randomUUID()}`;
      await linkFile(drainPath, finalGuard);
      await syncParentDirectory(finalGuard);
      await durableUnlink(drainPath);
      if (!this.isLive(id, generation)) return false;
      this.segmentDrainPaths.set(id, finalGuard);
      await this.readSource(id, true, name, generation, false);
      if (!this.isLive(id, generation)) return false;
      const afterGuard = (await statFile(finalGuard)).size;
      if (afterGuard !== (this.segmentOffsets.get(segmentKey) ?? finalOffset)) {
        this.segmentEmptyPolls.set(segmentKey, 0);
        return false;
      }

      // Keep a verification anchor for *every* publication, including a
      // writer-marked one. The anchor is made before the final guard is
      // unlinked and scanned afterwards. A content check can catch an
      // escaped-descriptor append that is already visible, but POSIX gives us
      // no proof that another descriptor will not append immediately after
      // the check. Therefore this anchor is never the last link we remove.
      verificationPath = `${segment}${SIDECAR_RETAINED_FILE_TOKEN}${randomUUID()}`;
      await linkFile(finalGuard, verificationPath);
      await syncParentDirectory(verificationPath);
      await durableUnlink(finalGuard);
      if (!this.isLive(id, generation)) return false;
      this.segmentDrainPaths.set(id, verificationPath);
      await this.readSource(id, true, name, generation, false);
      if (!this.isLive(id, generation)) return false;
      await this.verifySealedPublication(name, verificationPath, identity);
      if (!this.isLive(id, generation)) return false;

      // `verified` is useful provenance/health evidence, but it is not a
      // close acknowledgement: an escaped descriptor can append after this
      // function returns. Keep the same durable anchor for proven and
      // unproven publications, and let bounded admission/quarantine govern
      // subsequent rotations.
      const retainedName = basename(verificationPath);
      const retainedKey = this.segmentStateKey(id, retainedName);
      const retainedOffset = this.segmentOffsets.get(segmentKey) ?? finalOffset;
      this.segmentOffsets.set(retainedKey, retainedOffset);
      this.segmentIdentities.set(retainedKey, identity);
      this.retainedSegments.set(id, retainedName);
      this.sealedSegments.set(id, retainedName);
      this.segmentPartialRecords.delete(segmentKey);
      this.segmentOversizedRecords.delete(segmentKey);
      this.segmentEmptyPolls.delete(segmentKey);
      this.segmentOffsets.delete(segmentKey);
      this.segmentIdentities.delete(segmentKey);
      // Persist the retained source name before the active file is allowed
      // to advance. The cursor and anchor are the restart proof for every
      // late append, including one that happens after verification returns.
      if (!(await this.persistCursor(id, {
        offset: this.offsets.get(id) ?? 0,
        sealedOffset: retainedOffset,
        sealedIdentity: identity,
        sealedSegment: retainedName,
      }, generation))) {
        this.pause(id, generation);
      }
      return false;
    } catch {
      /* Keep flow control asserted until a later poll can retry reclaim. */
      return false;
    }
  }

  private pause(id: string, generation = this.terminalGenerations.get(id)): void {
    if (!this.isLive(id, generation)) return;
    this.paused.add(id);
    // Assert producer flow control immediately on admission failure, rather
    // than waiting for the next 300 ms poll to discover an 8 MiB overflow.
    // This keeps a paused sidecar a bounded spool even when its producer is
    // much faster than the recovery poll.
    void this.setBackpressureMarker(id, 0, generation);
    void this.checkBacklog(id, undefined, generation);
    if (this.resumeTimers.has(id)) return;
    // A retry is a safety net for consumers which do not explicitly call
    // resume.  It remains paused between retries, so a hot producer cannot
    // create one read task per polling tick.
    const timer = setTimeout(async () => {
      this.resumeTimers.delete(id);
      if (!this.isLive(id, generation)) return;
      const retained = await this.checkBacklog(id, undefined, generation);
      if (!this.isLive(id, generation)) return;
      if (retained !== undefined && retained > this.maxBacklogBytes) {
        this.pause(id, generation);
        return;
      }
      this.paused.delete(id);
      void this.tail(id, generation);
    }, 300);
    this.resumeTimers.set(id, timer);
  }

  private async checkBacklog(
    id: string,
    knownRetained?: number,
    generation = this.terminalGenerations.get(id),
  ): Promise<number | undefined> {
    if (!this.isLive(id, generation)) return undefined;
    let retained = knownRetained;
    if (retained === undefined) {
      retained = 0;
      const seen = new Set<string>();
      const seenIdentities = new Set<string>();
      const count = async (path: string, offset: number): Promise<void> => {
        if (seen.has(path)) return;
        seen.add(path);
        try {
          const stats = await statFile(path);
          const identity = this.fileIdentity(stats);
          if (seenIdentities.has(identity)) return;
          seenIdentities.add(identity);
          retained! += Math.max(0, stats.size - offset);
        } catch {
          /* The producer may not have created this generation yet. */
        }
      };
      await count(join(this.dir, `${id}.jsonl`), this.offsets.get(id) ?? 0);
      const activeSegment = this.sealedSegments.get(id);
      for (const name of await this.listSealedSegments(id)) {
        await count(join(this.dir, name), name === activeSegment ? (this.segmentOffset(id, name) ?? 0) : 0);
      }
      for (const name of await this.listRetainedSegments(id)) {
        await count(join(this.dir, name), name === activeSegment ? (this.segmentOffset(id, name) ?? 0) : 0);
      }
      const drainPath = this.segmentDrainPaths.get(id);
      if (drainPath) await count(drainPath, this.segmentOffset(id, activeSegment) ?? 0);
    }
    if (!this.isLive(id, generation)) return undefined;
    const holdProducer = this.paused.has(id) || this.quarantined.has(id);
    if (holdProducer) void this.setBackpressureMarker(id, retained, generation);
    if (retained > this.maxBacklogBytes) this.reportBacklogOverflow(id, retained, generation);
    else if (!holdProducer) {
      this.backlogOverflowed.delete(id);
      void this.clearBackpressureMarker(id, generation);
    }
    return retained;
  }

  private reportBacklogOverflow(id: string, retainedBytes: number, generation = this.terminalGenerations.get(id)): void {
    if (!this.isLive(id, generation)) return;
    const first = !this.backlogOverflowed.has(id);
    this.backlogOverflowed.add(id);
    // Retry the marker write on every observed overflow. A transient fs
    // failure must not turn the advisory marker into silent unbounded growth.
    void this.setBackpressureMarker(id, retainedBytes, generation);
    if (!first) return;
    try {
      this.onBacklogOverflow(id, retainedBytes);
    } catch {
      /* Diagnostics must never break the durable tail. */
    }
    if (this.retainedSegments.has(id)) {
      this.quarantine(id, generation, "retained sidecar source exceeded bounded backlog");
    }
  }

  private setBackpressureMarker(
    id: string,
    retainedBytes: number,
    generation = this.terminalGenerations.get(id),
  ): Promise<boolean> {
    return this.requestBackpressureMarker(id, true, retainedBytes, generation);
  }

  private reportOversizedRecord(id: string, record: OversizedRecord): void {
    if (record.diagnosticEmitted) return;
    record.diagnosticEmitted = true;
    console.warn(`[sidecar] ${id} JSONL record exceeds ${this.maxRecordBytes} bytes; skipping until newline (${record.bytes} bytes)`);
  }

  private clearBackpressureMarker(
    id: string,
    generation = this.terminalGenerations.get(id),
    force = false,
  ): Promise<boolean> {
    if (force) return this.cleanupBackpressureMarker(id);
    return this.requestBackpressureMarker(id, false, 0, generation);
  }

  private requestBackpressureMarker(
    id: string,
    present: boolean,
    retainedBytes: number,
    generation = this.terminalGenerations.get(id),
  ): Promise<boolean> {
    if (!this.isLive(id, generation)) return Promise.resolve(false);
    let state = this.markerStates.get(id);
    if (state && (state.cancelled || state.generation !== generation)) {
      this.cancelMarkerState(id, state);
      state = undefined;
    }
    if (!state) {
      state = {
        generation: generation!,
        cancelled: false,
        desiredPresent: present,
        desiredBytes: retainedBytes,
        actualPresent: null,
        actualBytes: 0,
        running: false,
        retryTimer: null,
        operation: null,
        waiters: [],
      };
      this.markerStates.set(id, state);
    } else {
      state.desiredPresent = present;
      state.desiredBytes = retainedBytes;
    }
    // Marker presence is the flow-control contract; the byte count is only a
    // diagnostic. Avoid rewriting/fsyncing the same edge on every poll.
    if (!state.running && state.actualPresent === present) return Promise.resolve(true);
    const requested = new Promise<boolean>((resolve) => state!.waiters.push({ present, resolve }));
    const cleanup = this.markerCleanups.get(id);
    if (cleanup) {
      void cleanup.catch(() => undefined).then(() => {
        if (this.isLive(id, generation) && this.markerStates.get(id) === state && !state!.cancelled) {
          this.startMarkerPump(id, state!);
        }
      });
    } else {
      this.startMarkerPump(id, state);
    }
    return requested;
  }

  private cancelMarkerState(id: string, state: MarkerState): void {
    state.cancelled = true;
    if (state.retryTimer) clearTimeout(state.retryTimer);
    state.retryTimer = null;
    const waiters = state.waiters.splice(0);
    for (const waiter of waiters) waiter.resolve(false);
    if (!state.running && this.markerStates.get(id) === state) this.markerStates.delete(id);
  }

  private startMarkerPump(id: string, state: MarkerState): void {
    if (state.running || state.operation) return;
    const operation = this.pumpBackpressureMarker(id, state);
    state.operation = operation;
    void operation.finally(() => {
      if (state.operation === operation) state.operation = null;
      if ((state.cancelled || !this.isLive(id, state.generation)) && this.markerStates.get(id) === state) {
        this.markerStates.delete(id);
      }
    });
  }

  /** Remove a marker after lifecycle invalidation, serialized behind a write. */
  private async cleanupBackpressureMarker(id: string): Promise<boolean> {
    const state = this.markerStates.get(id);
    if (state) this.cancelMarkerState(id, state);
    const priorCleanup = this.markerCleanups.get(id) ?? Promise.resolve();
    const cleanup = priorCleanup.catch(() => undefined).then(async () => {
      try {
        await state?.operation?.catch(() => undefined);
        await durableUnlink(join(this.dir, `${SIDECAR_BACKPRESSURE_FILE_PREFIX}${id}`));
      } catch {
        // Shutdown cleanup is best effort and intentionally silent. In
        // particular, a removed events directory is equivalent to no marker.
      }
    });
    this.markerCleanups.set(id, cleanup);
    try {
      await cleanup;
      return true;
    } finally {
      if (this.markerCleanups.get(id) === cleanup) this.markerCleanups.delete(id);
      if (state && this.markerStates.get(id) === state && !state.running) this.markerStates.delete(id);
    }
  }

  private async pumpBackpressureMarker(id: string, state: MarkerState): Promise<void> {
    if (state.running) return;
    state.running = true;
    try {
      for (;;) {
        if (state.cancelled || !this.isLive(id, state.generation)) {
          const cancelledWaiters = state.waiters.splice(0);
          for (const waiter of cancelledWaiters) waiter.resolve(false);
          return;
        }
        const present = state.desiredPresent;
        const retainedBytes = state.desiredBytes;
        let ok = true;
        try {
          const path = join(this.dir, `${SIDECAR_BACKPRESSURE_FILE_PREFIX}${id}`);
          if (present) await durableAtomicWrite(path, `${retainedBytes}\n`);
          else await durableUnlink(path);
          state.actualPresent = present;
          state.actualBytes = retainedBytes;
        } catch (error) {
          ok = false;
          if (!state.cancelled && this.isLive(id, state.generation)) {
            console.warn(`[sidecar] could not ${present ? "publish" : "clear"} ${id} backpressure marker: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const waiters = state.waiters.splice(0);
        for (const waiter of waiters) {
          if (state.cancelled || !this.isLive(id, state.generation)) waiter.resolve(false);
          else if (waiter.present === present) waiter.resolve(ok);
          else if (waiter.present !== state.desiredPresent) waiter.resolve(false);
          else state.waiters.push(waiter);
        }
        if (!ok) {
          if (!state.cancelled && this.isLive(id, state.generation) && !state.retryTimer) {
            state.retryTimer = setTimeout(() => {
              state!.retryTimer = null;
              if (!state!.cancelled && this.isLive(id, state!.generation) && this.markerStates.get(id) === state) {
                this.startMarkerPump(id, state!);
              }
            }, 500);
          }
          return;
        }
        if (state.desiredPresent === present) return;
      }
    } finally {
      state.running = false;
      if (state.cancelled) {
        const cancelledWaiters = state.waiters.splice(0);
        for (const waiter of cancelledWaiters) waiter.resolve(false);
      }
    }
  }

  private cursorPath(id: string): string {
    return join(this.dir, `.cursor-${id}.json`);
  }

  private loadCursor(id: string): DurableSidecarCursor | null {
    try {
      const raw = JSON.parse(readFileSync(this.cursorPath(id), "utf8")) as Record<string, unknown>;
      const allowed = new Set(["version", "offset", "bridgeId", "sequence", "sealedSegment", "sealedOffset", "sealedIdentity"]);
      if (
        !raw
        || typeof raw !== "object"
        || Object.keys(raw).some((key) => !allowed.has(key))
        || raw.version !== SIDECAR_CURSOR_VERSION
        || typeof raw.offset !== "number"
        || !Number.isSafeInteger(raw.offset)
        || raw.offset < 0
      ) return null;
      const hasStream = raw.bridgeId !== undefined || raw.sequence !== undefined;
      if (hasStream && (
        typeof raw.bridgeId !== "string"
        || raw.bridgeId.length === 0
        || raw.bridgeId.length > 256
        || typeof raw.sequence !== "number"
        || !Number.isSafeInteger(raw.sequence)
        || raw.sequence < 1
      )) return null;
      const hasSealed = raw.sealedSegment !== undefined || raw.sealedOffset !== undefined || raw.sealedIdentity !== undefined;
      if (hasSealed && (
        typeof raw.sealedSegment !== "string"
        || (!this.isSealedSegmentName(id, raw.sealedSegment) && !this.isRetainedSegmentName(id, raw.sealedSegment))
        || typeof raw.sealedOffset !== "number"
        || !Number.isSafeInteger(raw.sealedOffset)
        || raw.sealedOffset < 0
        || typeof raw.sealedIdentity !== "string"
        || raw.sealedIdentity.length === 0
        || raw.sealedIdentity.length > 256
      )) return null;
      return {
        version: SIDECAR_CURSOR_VERSION,
        offset: raw.offset,
        ...(hasStream ? { bridgeId: raw.bridgeId as string, sequence: raw.sequence as number } : {}),
        ...(hasSealed ? {
          sealedSegment: raw.sealedSegment as string,
          sealedOffset: raw.sealedOffset as number,
          sealedIdentity: raw.sealedIdentity as string,
        } : {}),
      };
    } catch {
      return null;
    }
  }

  /** Persist a cursor before the in-memory stream advances. */
  private persistCursor(
    id: string,
    next: DurableSidecarCursorUpdate,
    generation = this.terminalGenerations.get(id),
  ): Promise<boolean> {
    const previousWrite = this.cursorWrites.get(id) ?? Promise.resolve(true);
    const write = previousWrite.catch(() => false).then(async () => {
      if (!this.isLive(id, generation)) return false;
      const previous = this.durableCursors.get(id);
      const sealedOffset = next.sealedOffset === null ? undefined : next.sealedOffset ?? previous?.sealedOffset;
      const sealedIdentity = next.sealedIdentity === null || next.sealedSegment === null
        ? undefined
        : next.sealedIdentity ?? previous?.sealedIdentity;
      const sealedSegment = next.sealedSegment === null ? undefined : next.sealedSegment ?? previous?.sealedSegment;
      const cursor: DurableSidecarCursor = {
        version: SIDECAR_CURSOR_VERSION,
        offset: next.offset,
        ...(next.bridgeId ? { bridgeId: next.bridgeId } : previous?.bridgeId ? { bridgeId: previous.bridgeId } : {}),
        ...(next.sequence !== undefined ? { sequence: next.sequence } : previous?.sequence !== undefined ? { sequence: previous.sequence } : {}),
        ...(sealedSegment ? { sealedSegment } : {}),
        ...(sealedOffset !== undefined ? { sealedOffset } : {}),
        ...(sealedIdentity ? { sealedIdentity } : {}),
      };
      try {
        await durableAtomicWrite(this.cursorPath(id), JSON.stringify(cursor));
        if (!this.isLive(id, generation)) return false;
        this.durableCursors.set(id, cursor);
        return true;
      } catch (error) {
        if (this.isLive(id, generation)) {
          console.warn(`[sidecar] could not persist ${id} cursor: ${error instanceof Error ? error.message : String(error)}`);
        }
        return false;
      }
    });
    const tracked = write.catch(() => false);
    this.cursorWrites.set(id, tracked);
    void tracked.finally(() => {
      if (this.cursorWrites.get(id) === tracked) this.cursorWrites.delete(id);
    });
    return write;
  }

  private eventDisposition(
    id: string,
    envelope: SidecarMeta,
    kind: unknown,
    _segment: boolean,
  ): "accept" | "skip" | "defer" {
    if (!this.canAcceptEvent(id, envelope, kind)) return "skip";
    const previous = this.streams.get(id);
    // A retained/retired inode is the only durable source that can fill a
    // sequence gap in the active inode. Leave the active line at its cursor
    // until that source has been scanned; otherwise a late descriptor append
    // could be skipped after the active boundary advances.
    if (
      previous?.bridgeId === envelope.bridgeId
      && envelope.seq > previous.sequence + 1
      && this.hasSegmentState(id)
    ) return "defer";
    return "accept";
  }

  private acceptEvent(id: string, envelope: SidecarMeta, kind: unknown): boolean {
    if (!this.canAcceptEvent(id, envelope, kind)) return false;
    const previous = this.streams.get(id);
    const known = this.bridgeIds.get(id) ?? new Set<string>();
    if (previous?.bridgeId !== envelope.bridgeId) {
      if (known.has(envelope.bridgeId)) return false;
      // A terminal stream has one active bridge. Child processes can inherit
      // the sidecar environment and append diagnostics with another bridgeId;
      // only the protocol's session boundary may take ownership.
      if (previous && kind !== "session_ready") return false;
    }
    if (previous?.bridgeId === envelope.bridgeId && envelope.seq <= previous.sequence) return false;
    known.add(envelope.bridgeId);
    while (known.size > 8) known.delete(known.values().next().value!);
    this.bridgeIds.set(id, known);
    this.streams.set(id, { bridgeId: envelope.bridgeId, sequence: envelope.seq });
    return true;
  }

  private canAcceptEvent(id: string, envelope: SidecarMeta, kind: unknown): boolean {
    const previous = this.streams.get(id);
    const known = this.bridgeIds.get(id) ?? new Set<string>();
    if (previous?.bridgeId !== envelope.bridgeId) {
      if (known.has(envelope.bridgeId)) return false;
      if (previous && kind !== "session_ready") return false;
    }
    if (previous?.bridgeId === envelope.bridgeId && envelope.seq <= previous.sequence) return false;
    return true;
  }
}
