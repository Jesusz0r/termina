/**
 * Durable sidecar tailer.
 *
 * Owns cursors, sealed/retained segment handling, and the SidecarTailer
 * watch/poll lifecycle. Split from electron/sidecar.ts (issue #38).
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, type FSWatcher, watch } from "node:fs";
import { link as linkFile, open as openFile, readdir as readDirectory, rename as renameFile, stat as statFile, unlink as unlinkFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isValidTerminalId } from "../../agent-core/main/sidecar.js";
import { durableAtomicWrite } from "../../shared/durable-write.js";
import { syncDirectory, syncDirectoryAsync } from "../../shared/fsync.js";
import { isRecord } from "../../shared/guards.js";
import { MAX_SIDECAR_BYTES, MAX_SIDECAR_RECORD_BYTES, SIDECAR_BACKPRESSURE_FILE_PREFIX, SIDECAR_CURSOR_VERSION, SIDECAR_DRAIN_FILE_TOKEN, SIDECAR_FINAL_GUARD_FILE_TOKEN, SIDECAR_MAX_SEQUENCE_GAP_POLLS, SIDECAR_PROOF_MAX_BYTES, SIDECAR_QUARANTINE_FILE_PREFIX, SIDECAR_RETAINED_FILE_TOKEN, SIDECAR_SEALED_FILE_SUFFIX, SIDECAR_SEALED_PROOF_SUFFIX, SIDECAR_TAIL_READ_BYTES, SIDECAR_VERIFY_MAX_READS, SIDECAR_VERIFY_READ_CHUNK_BYTES } from "./events.js";
import type { SidecarEvent, SidecarMeta } from "./events.js";
import { parseSidecarRecord, sidecarEnvelope, sidecarEventBody } from "./parse.js";
import type { SidecarEventDelivery } from "./queue.js";


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


interface SidecarSegmentNames {
  sealed: string[];
  retained: string[];
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


/**
 * Atomic cursor publish without durability syncs. Markers and anchors use
 * shared/durable-write.ts (written rarely). Cursors live in the OS temp
 * dir and every delivery persists before the stream advances (a redelivery
 * window of one event, which non-idempotent consumers such as run-state
 * resets depend on), so rename atomicity — not sync durability — is the
 * load-bearing property here: an app crash sees the old or the new complete
 * cursor via the surviving page cache, while an OS crash may additionally
 * replay the unflushed dirty window (duplication-bounded, never corrupting:
 * consumers degrade to duplicate dots/runs; wiped tmp recovers clean).
 * Skipping the two fsyncs lifts drain throughput from ~91
 * events/s toward the syscall floor without widening the app-crash
 * redelivery window.
 */
async function atomicWriteFile(path: string, content: string): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof openFile>> | undefined;
  try {
    handle = await openFile(temp, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.close();
    handle = undefined;
    await renameFile(temp, path);
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


/** Async parent-dir sync via the canonical fsync owner (shared/fsync.ts has
 * no async parent-dir helper, so adapt its async directory sync here). */
async function syncParentDirectory(path: string): Promise<void> {
  await syncDirectoryAsync(dirname(path));
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


/** True when a cursor persist would rewrite identical bytes. Selection plus
 * offsets plus stream ownership all match; skipping the write keeps idle
 * terminals quiet instead of fsyncing every poll. */
function sameDurableSidecarCursor(left: DurableSidecarCursor, right: DurableSidecarCursor): boolean {
  return left.offset === right.offset
    && (left.bridgeId ?? undefined) === (right.bridgeId ?? undefined)
    && (left.sequence ?? undefined) === (right.sequence ?? undefined)
    && (left.sealedSegment ?? undefined) === (right.sealedSegment ?? undefined)
    && (left.sealedOffset ?? undefined) === (right.sealedOffset ?? undefined)
    && (left.sealedIdentity ?? undefined) === (right.sealedIdentity ?? undefined);
}


let cachedBootId: string | null | undefined;
/** Best-effort stable boot identity for launch-scoping quarantine markers.
 * Linux reads the kernel boot id file; macOS reads kern.boottime; anything
 * else (or any failure) yields null and markers fall back to pid-only
 * binding. Cached: a process never crosses a reboot. */
function currentBootId(): string | null {
  if (cachedBootId !== undefined) return cachedBootId;
  cachedBootId = null;
  try {
    if (process.platform === "linux") {
      const raw = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().toLowerCase();
      if (/^[0-9a-f-]{8,128}$/.test(raw)) cachedBootId = raw;
    } else if (process.platform === "darwin") {
      for (const sysctl of ["/usr/sbin/sysctl", "sysctl"]) {
        try {
          const raw = execFileSync(sysctl, ["-n", "kern.boottime"], { encoding: "utf8", timeout: 5000 }).trim();
          if (raw.length > 0 && raw.length <= 256) {
            cachedBootId = raw;
            break;
          }
        } catch {
          /* Try the next sysctl candidate. */
        }
      }
    }
  } catch {
    cachedBootId = null;
  }
  return cachedBootId;
}


/** True when pid names a live process. EPERM means it exists under another user. */
function isProducerAlive(pid: number): boolean {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
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
  /** A source is quarantined when it is not restart-safe or exceeds the anchor cap. */
  private quarantined = new Set<string>();
  /** Every retired pathname retains one durable identity anchor: POSIX cannot
   * prove that an escaped descriptor will not append after verification. */
  private retainedSegments = new Map<string, string>();
  /** A second link keeps a retired inode observable while an old descriptor
   * finishes an append during the unlink syscall. Set only while a reclaim
   * chain is mid-flight; cleared once the retained anchor settles (a settled
   * drain link IS the anchor path, so join() resolution is identical). */
  private segmentDrainPaths = new Map<string, string>();
  private durableCursors = new Map<string, DurableSidecarCursor>();
  private streams = new Map<string, StreamState>();
  /** Bound for the watch lifecycle, even if the active file is truncated. */
  private producerPids = new Map<string, number>();
  private expectedProducerPids = new Map<string, number>();
  private bridgeIds = new Map<string, Set<string>>();
  private partialRecords = new Map<string, Buffer>();
  private segmentPartialRecords = new Map<string, Buffer>();
  private oversizedRecords = new Map<string, OversizedRecord>();
  /** Diagnostic-only shared record for skipped over-cap active lines. Unlike
   * source-state oversized entries, it never stops a pass; cleared per
   * lifecycle so a later flood warns again. */
  private oversizedSkipDiagnostics = new Map<string, OversizedRecord>();
  private segmentOversizedRecords = new Map<string, OversizedRecord>();
  private segmentEmptyPolls = new Map<string, number>();
  /** Bounded retries while an older identity may still fill a sequence gap. */
  private sequenceGapPolls = new Map<string, number>();
  /** A source deferred during this tail pass; other identities still drain. */
  private sequenceGapDeferred = new Set<string>();
  private cursorWrites = new Map<string, Promise<boolean>>();
  /** Ids whose in-memory durable cursor is proven present on disk. A fresh
   * watch seeds memory without writing, so the no-op persist skip below must
   * not treat unmaterialized memory as durable across a restart. */
  private persistedCursors = new Set<string>();
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
  /** Terminals with possibly-unread bytes since the last tail pass. Set by
   * the watcher path; the recovery poll only tails dirty ids (or every live
   * id while the watcher is down). */
  private dirty = new Set<string>();
  /** Watcher-driven vs poll-driven tail dispatches, for wakeup attribution. */
  private wakeCounts = { poll: 0, watch: 0 };
  /** Lifecycles owed one bootstrap tail so anchor binding and structural
   * quarantine checks run at least once even when every probe is quiet. */
  private untailedSinceWatch = new Set<string>();
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
  /** Quarantine or producer backpressure paused this source. */
  onHold: (terminalId: string, held: boolean) => void = () => {};
  private lastHold = new Map<string, boolean>();

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

  /** Test seam: watch vs poll wake attribution. Production uses delivery, not these counts. */
  tailWakeCounts(): { poll: number; watch: number } {
    return { ...this.wakeCounts };
  }

  /** Owner id for unpublished sealed generations: `.<id>.jsonl.<gen>.sealed`.
   * Retained/draining/final anchors are revisit-gated below, and proof
   * (`.sealed.owner`) and cursor files never match this suffix. A sealed
   * name lingers across the multi-pass drain/retire chain, so its presence
   * keeps re-dirtying until the chain unlinks it. */
  private segmentOwnerId(name: string): string | null {
    if (!name.endsWith(SIDECAR_SEALED_FILE_SUFFIX)) return null;
    return name.match(/^\.([^.]+)\.jsonl\.(.+)$/)?.[1] ?? null;
  }

  /** Internal segment work that only advances inside a pass. Drain links are
   * transient by design; a set link means the retirement chain is mid-flight
   * (or hit a transient failure it must retry). Empty-poll countdowns gate
   * sealed retirement the same way. Settled retained anchors stay out of the
   * countdowns (they would pin idle tails forever) and are observed by a
   * cheap size probe instead: quiet while drained, tailed on late appends. */
  private needsSegmentRevisit(id: string): boolean {
    if (this.segmentDrainPaths.has(id)) return true;
    const prefix = `${id}\u0000`;
    for (const key of this.segmentEmptyPolls.keys()) {
      if (!key.startsWith(prefix)) continue;
      // Countdowns for vanished segments clean themselves instead of
      // pinning the old tick cadence on a name that can never progress.
      try {
        statSync(join(this.dir, key.slice(prefix.length)));
        return true;
      } catch {
        this.segmentEmptyPolls.delete(key);
      }
    }
    const anchor = this.retainedSegments.get(id);
    if (anchor !== undefined) {
      try {
        if (statSync(join(this.dir, anchor)).size !== (this.segmentOffsets.get(this.segmentStateKey(id, anchor)) ?? 0)) return true;
      } catch {
        // A vanished anchor must fail closed in readTail, not idle quietly.
        return true;
      }
    }
    return false;
  }

  /** Cheap missed-event probe for the active file. Segment transitions
   * rename inside the watched dir and arrive via schedule(); appends move
   * the size away from the read cursor, truncation the other way. */
  private activeMoved(id: string): boolean {
    try {
      return statSync(join(this.dir, `${id}.jsonl`)).size !== this.offsets.get(id);
    } catch {
      // A missing active file matters only when the cursor claims bytes.
      return (this.offsets.get(id) ?? 0) > 0;
    }
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.sweepStaleTempFiles();
    this.armWatch();
    this.timer = setInterval(() => {
      // Recovery poll: catch events the watcher missed. Also re-arm the
      // watcher when the directory did not exist yet. Live ids stay clean
      // while the watcher runs, so idle terminals cost no tail pass here.
      if (!this.watcher) this.armWatch();
      void this.pollTick();
    }, 300);
  }

  /** Sweep crash-littered sidecar publish tmps. Tailer tmps carry the owner
   * pid (`<path>.<pid>.<uuid>.tmp`): sweep when the owner is dead. Writer
   * tmps carry no pid: sweep only past the age gate, so a live writer
   * mid-publish is never unlinked. Restricted to sidecar-publish shapes so
   * other subsystems' tmps are untouched. Best effort; litter is cosmetic
   * and the next startup retries. */
  private sweepStaleTempFiles(): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    let swept = 0;
    const now = Date.now();
    for (const name of names) {
      if (!name.endsWith(".tmp")) continue;
      if (!name.includes(".cursor-") && !name.includes(".backpressure-") && !name.includes(".quarantine-") && !name.includes(".jsonl.")) continue;
      const pid = name.match(/\.(\d+)\.[0-9a-f-]{8,}\.tmp$/)?.[1];
      let stale: boolean;
      if (pid !== undefined) {
        stale = !isProducerAlive(Number(pid));
      } else {
        try {
          stale = statSync(join(this.dir, name)).mtimeMs < now - 60_000;
        } catch {
          continue;
        }
      }
      if (!stale) continue;
      try {
        rmSync(join(this.dir, name), { force: true });
        swept++;
      } catch {
        /* Litter is cosmetic; the next startup retries. */
      }
    }
    if (swept > 0) {
      try {
        syncDirectory(this.dir);
      } catch {
        /* Best effort; the unlink itself already landed for readers. */
      }
    }
  }

  private async pollTick(): Promise<void> {
    // One directory sweep per tick catches segment renames a live-but-lossy
    // watcher may drop. The active-size probe below cannot see sealed
    // sources, and a rotation with a quiet new active file would otherwise
    // stall retirement until unrelated bytes arrive.
    if (this.watcher) {
      try {
        for (const name of await readDirectory(this.dir)) {
          const owner = this.segmentOwnerId(String(name));
          if (owner !== null && this.offsets.has(owner)) this.dirty.add(owner);
        }
      } catch {
        // Unlistable directory: tail live ids below instead of stalling.
        for (const id of this.offsets.keys()) this.dirty.add(id);
      }
    }
    for (const id of this.offsets.keys()) {
      const generation = this.terminalGenerations.get(id);
      if (generation === undefined) continue;
      if (this.quarantined.has(id)) continue;
      if (!this.isLive(id, generation)) continue;
      if (this.paused.has(id)) void this.checkBacklog(id, undefined, generation);
      else if (
        !this.watcher || this.dirty.has(id) || this.inFlight.has(id) ||
        this.sequenceGapDeferred.has(id) || this.untailedSinceWatch.has(id) ||
        this.needsSegmentRevisit(id) || this.activeMoved(id)
      ) {
        this.dirty.delete(id);
        this.wakeCounts.poll++;
        void this.tail(id, generation);
      }
    }
  }

  /** Watch the events directory; a new line triggers an immediate tail. */
  private armWatch(): void {
    try {
      this.watcher?.close();
      this.watcher = this.watchTree(this.dir, (_ev, name) => {
        if (!name) return;
        const fileName = String(name);
        const active = fileName.match(/^([^.]+)\.jsonl$/);
        // Segment files carry a ts-pid-uuid infix between `.jsonl.` and the
        // sealed/retained/draining/final token, so match the dotted prefix
        // rather than the token position.
        const generation = fileName.match(/^\.([^.]+)\.jsonl\./);
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
    this.dirty.add(id);
    const existing = this.pendingTails.get(id);
    if (existing) clearTimeout(existing);
    this.pendingTails.set(
      id,
      setTimeout(() => {
        this.pendingTails.delete(id);
        if (this.isLive(id, generation)) {
          this.wakeCounts.watch++;
          this.dirty.delete(id);
          void this.tail(id, generation);
        }
      }, 10),
    );
  }

  /** Only main's launched process may replace a recovered producer. */
  setExpectedProducer(id: string, pid: number): void {
    if (Number.isSafeInteger(pid) && pid > 0) this.expectedProducerPids.set(id, pid);
  }

  /** Start tailing a terminal's event file. Events written before this call
   *  belong to previous app sessions (the file is global) — start from the
   *  current size so a fresh instance does not replay old history. */
  watch(id: string): void {
    // Validate before any path join: the writer enforces this contract and
    // the tailer must not stat, read, or publish cursors outside the events
    // directory for a malformed id.
    if (!isValidTerminalId(id)) return;
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
    // A quarantine marker bound to a live producer is durable evidence that
    // an unsafe source transition was observed. Keep this lifecycle
    // fail-closed until the source set is explicitly replaced or cleaned. A
    // marker from a dead producer is previous-launch residue: terminal ids
    // restart every launch, so it must not stop a brand-new terminal.
    const persistedQuarantine = this.hasLiveQuarantineMarkerSync(id) || wasQuarantined;
    this.sealedSegments.delete(id);
    this.retainedSegments.delete(id);
    this.segmentDrainPaths.delete(id);
    const file = join(this.dir, `${id}.jsonl`);
    let start = 0;
    let fileSize = 0;
    this.cleanupOrphanProofs(id);
    const sealedNames = this.listSealedSegmentsSync(id);
    const retainedNames = this.listRetainedSegmentsSync(id);
    // A lifecycle that starts with segments is owed one bootstrap tail so
    // anchor binding and structural quarantine checks run at least once even
    // when every probe is quiet. Segment-free watches stay lazy.
    if (sealedNames.length > 0 || retainedNames.length > 0) this.untailedSinceWatch.add(id);
    else this.untailedSinceWatch.delete(id);
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
      this.persistedCursors.delete(id);
      this.cursorInitializations.set(id, this.persistCursor(id, initialCursor, generation));
    } else {
      this.persistedCursors.add(id);
      this.cursorInitializations.delete(id);
    }
    this.streams.delete(id);
    this.producerPids.delete(id);
    this.expectedProducerPids.delete(id);
    this.bridgeIds.delete(id);
    const cursorSequence = cursor?.sequence;
    if (cursor?.bridgeId && cursorSequence !== undefined && Number.isSafeInteger(cursorSequence) && cursorSequence >= 1) {
      this.streams.set(id, { bridgeId: cursor.bridgeId, sequence: cursorSequence });
      this.bridgeIds.set(id, new Set([cursor.bridgeId]));
    }
    this.partialRecords.delete(id);
    this.oversizedRecords.delete(id);
    this.oversizedSkipDiagnostics.delete(id);
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
    } else if (existsSync(this.quarantinePath(id))) {
      // A stale previous-launch marker gates the writer (which refuses all
      // appends beside any marker file) even though this lifecycle ignores
      // it for inheritance. Sweep the residue so the recycled terminal's
      // producer can append; a persisting race re-quarantines at once with
      // a fresh live-bound marker. Live markers and re-quarantined
      // lifecycles never reach this branch, so no fresh marker is raced.
      void this.clearQuarantineMarker(id);
    }
    void this.checkBacklog(id, undefined, generation);
    const resumeTimer = this.resumeTimers.get(id);
    if (resumeTimer) clearTimeout(resumeTimer);
    this.resumeTimers.delete(id);
    const wasHeld = this.lastHold.get(id) === true;
    this.lastHold.delete(id);
    if (this.isHeld(id) || wasHeld) this.notifyHold(id);
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
    const wasQuarantined = this.quarantined.has(id) || this.hasLiveQuarantineMarkerSync(id);
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
    this.persistedCursors.delete(id);
    this.streams.delete(id);
    this.producerPids.delete(id);
    this.expectedProducerPids.delete(id);
    this.bridgeIds.delete(id);
    this.partialRecords.delete(id);
    this.oversizedRecords.delete(id);
    this.oversizedSkipDiagnostics.delete(id);
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
    this.lastHold.delete(id);
    this.dirty.delete(id);
    this.untailedSinceWatch.delete(id);
    void this.clearBackpressureMarker(id, generation, true);
    // Quarantine is durable admission state. Keep a live marker across
    // lifecycle teardown so a restart cannot resume after an identity-bound
    // source was lost; a stale previous-launch marker is cleared instead.
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
    this.lastHold.clear();
    this.quarantined.clear();
    this.untailedSinceWatch.clear();
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
    this.persistedCursors.clear();
    this.streams.clear();
    this.producerPids.clear();
    this.expectedProducerPids.clear();
    this.bridgeIds.clear();
    this.partialRecords.clear();
    this.segmentPartialRecords.clear();
    this.oversizedRecords.clear();
    this.oversizedSkipDiagnostics.clear();
    this.segmentOversizedRecords.clear();
    this.segmentEmptyPolls.clear();
    this.sequenceGapPolls.clear();
    this.sequenceGapDeferred.clear();
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

  isHeld(id: string): boolean {
    return this.paused.has(id) || this.quarantined.has(id);
  }

  private notifyHold(id: string): void {
    const held = this.isHeld(id);
    if (this.lastHold.get(id) === held) return;
    this.lastHold.set(id, held);
    this.onHold(id, held);
  }

  private isLive(id: string, generation: number | undefined): generation is number {
    return generation !== undefined
      && !this.stopping
      && this.timer !== null
      && this.terminalGenerations.get(id) === generation
      && this.offsets.has(id);
  }

  private async tail(id: string, generation = this.terminalGenerations.get(id)): Promise<void> {
    if (!this.isLive(id, generation)) return;
    this.untailedSinceWatch.delete(id);
    if (this.paused.has(id)) return;
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
      await this.readTail(id, generation);
    } finally {
      if (this.inFlight.get(id) === generation) this.inFlight.delete(id);
    }
  }

  private async readTail(id: string, generation: number): Promise<void> {
    if (!this.isLive(id, generation) || this.quarantined.has(id)) return;
    // One directory listing serves the whole pass (anchor bind, candidates,
    // backlog accounting). The seal gate in readSource deliberately re-lists:
    // a pass-stale gate could admit active bytes ahead of a mid-pass rotation
    // and silently skip the sealed source as duplicates.
    const segmentNames = await this.listSegmentNames(id);
    const retainedNames = segmentNames.retained;
    if (retainedNames.length > 0) {
      const retainedName = await this.bindRetainedAnchor(id, generation, retainedNames, segmentNames.sealed);
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
    const retainedCandidateName = this.retainedSegments.get(id) ?? retainedName;
    if (retainedCandidateName && !retainedNames.includes(retainedCandidateName)) retainedNames.push(retainedCandidateName);
    for (const name of retainedNames) candidates.push({ name, retained: true });
    for (const sealedName of segmentNames.sealed) {
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
      await this.checkBacklog(id, undefined, generation, segmentNames);
      return;
    }
    if (!this.isLive(id, generation)) return;

    await this.readSource(id, false, undefined, generation);
    if (this.quarantined.has(id)) return;
    if (this.sequenceGapDeferred.has(id)) {
      this.pause(id, generation);
      return;
    }
    await this.checkBacklog(id, undefined, generation, segmentNames);
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
    return (await this.listSegmentNames(id)).sealed;
  }

  private async listSegmentNames(id: string): Promise<SidecarSegmentNames> {
    try {
      const names = await readDirectory(this.dir);
      return {
        sealed: names.filter((name) => this.isSealedSegmentName(id, name)).sort(),
        retained: names.filter((name) => this.isRetainedSegmentName(id, name)).sort(),
      };
    } catch {
      return { sealed: [], retained: [] };
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
  private async bindRetainedAnchor(id: string, generation: number, names: string[], sealedNames: string[]): Promise<string | false | null> {
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
    this.sealedSegments.set(id, selected);
    this.retainedSegments.set(id, selected);

    // A prior lifecycle may have left a first drain link, final guard, and
    // retained link to the same inode. Keep one survivor and unlink only the
    // redundant names whose identity was just proven equal. Prune the pass
    // listing as names are removed so later candidates never chase ghosts.
    for (const entry of entries) {
      if (entry.name === selected) continue;
      try {
        await durableUnlink(join(this.dir, entry.name));
      } catch {
        this.quarantine(id, generation, `retained sidecar alias ${entry.name} could not be retired safely`);
        return false;
      }
      const pruned = names.indexOf(entry.name);
      if (pruned >= 0) names.splice(pruned, 1);
      const key = this.segmentStateKey(id, entry.name);
      this.segmentOffsets.delete(key);
      this.segmentIdentities.delete(key);
      this.segmentPartialRecords.delete(key);
      this.segmentOversizedRecords.delete(key);
      this.segmentEmptyPolls.delete(key);
    }

    // If the crash happened before the first sealed unlink, the published
    // name is another hard link to this same inode. Remove only that proven
    // duplicate. A different sealed identity is a newer generation beside
    // our settled anchor: chain it. Keep both; the scheduler drains the
    // older anchor first by sequence order, and the newer seal's reclaim
    // retires the older anchor once both generations prove fully drained.
    for (const sealedName of [...sealedNames]) {
      let sealedIdentity: string;
      try {
        sealedIdentity = this.fileIdentity(await statFile(join(this.dir, sealedName)));
      } catch {
        this.quarantine(id, generation, `sealed generation ${sealedName} could not be reconciled`);
        return false;
      }
      if (sealedIdentity !== identity) continue;
      try {
        await durableUnlink(join(this.dir, sealedName));
      } catch {
        this.quarantine(id, generation, `sealed generation ${sealedName} could not be reconciled`);
        return false;
      }
      const prunedSealed = sealedNames.indexOf(sealedName);
      if (prunedSealed >= 0) sealedNames.splice(prunedSealed, 1);
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
    // The anchor is settled: the only drain link that could exist IS this
    // anchor path, so join() resolution is identical. Clear it so idle polls
    // stop re-binding this anchor and the mid-flight guards below only fire
    // while a reclaim is genuinely in flight.
    this.segmentDrainPaths.delete(id);
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
    // An active read is administratively blocked while any sealed generation
    // exists (see readSource's seal gate), so scheduling it can only no-op.
    // Worse, a stale active partial from before the rotation would rank
    // active first and end the pass, starving the sealed source forever.
    // Active reads cannot run while a seal exists, so any active offset or
    // partial now predates the rotation: no active byte has been delivered,
    // and the pre-rotation bytes live in the seal while stream ownership
    // stays. Reset to the start of the post-rotation inode and drain sealed
    // candidates first; without the offset reset a stale offset at or past
    // the new file size would hide the new bytes forever.
    if ([...pending.values()].some((candidate) => !candidate.retained && !candidate.active)) {
      this.partialRecords.delete(id);
      this.oversizedRecords.delete(id);
      this.offsets.set(id, 0);
      for (const [name, candidate] of pending) {
        if (candidate.active) pending.delete(name);
      }
    }
    while (pending.size > 0) {
      if (!this.isLive(id, generation) || this.quarantined.has(id)) return;
      if (this.segmentDrainPaths.has(id) && [...pending.values()].some((candidate) => !candidate.retained && !candidate.active)) {
        // A reclaim chain is mid-flight (settled anchors clear their drain
        // link and chain via bindRetainedAnchor instead). A later sealed
        // pathname cannot be admitted beside a mid-flight chain without
        // proving both identities and their order; keep the sealed bytes and
        // fail closed before any source can overtake it.
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
        // A second canonical generation beside a mid-flight reclaim chain
        // cannot be ordered or safely discarded. Preserve it and stop
        // admission. (Settled anchors chain instead of quarantining.)
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

    // The active path may skip an over-cap line once its newline is observed.
    // Segment identities use the fail-closed branches below instead
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
        // Skipped over-cap lines share one stored diagnostic per lifecycle so
        // a flood warns once instead of once per line. Diagnostic-only: it
        // never enters source state, so skipping never stops the pass.
        let skipped = this.oversizedSkipDiagnostics.get(id);
        if (!skipped) {
          skipped = { bytes: recordBytes, diagnosticEmitted: false };
          this.oversizedSkipDiagnostics.set(id, skipped);
        }
        this.reportOversizedRecord(id, skipped);
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

  private hasLiveQuarantineMarkerSync(id: string): boolean {
    let raw: string;
    try {
      const size = statSync(this.quarantinePath(id)).size;
      if (size <= 0 || size > SIDECAR_PROOF_MAX_BYTES) return false;
      raw = readFileSync(this.quarantinePath(id), "utf8");
    } catch {
      return false;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!isRecord(parsed)) return false;
    // Terminal ids restart every launch while the events dir persists, so a
    // marker from a dead producer (or without any binding) is stale
    // previous-launch residue and must not stop a brand-new terminal.
    // Re-validation still re-quarantines a persisting race at once.
    if (parsed.state !== "quarantined") return false;
    if (!isProducerAlive(parsed.producerPid as number)) return false;
    const boot = parsed.bootId;
    if (boot !== undefined && boot !== null) {
      if (typeof boot !== "string") return false;
      const current = currentBootId();
      if (current !== null && boot !== current) return false;
    }
    return true;
  }

  /**
   * Permanently stop this terminal's source admission for the current
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
    this.notifyHold(id);
    if (first) {
      const marker = this.quarantinePath(id);
      void durableAtomicWrite(marker, JSON.stringify({ version: 1, state: "quarantined", terminalId: id, reason: reason.slice(0, 256), producerPid: process.pid, bootId: currentBootId() }) + "\n").catch((error) => {
        if (this.isLive(id, generation)) {
          console.warn(`[sidecar] could not publish ${id} quarantine: ${error instanceof Error ? error.message : String(error)}`);
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
  private async maybeReclaimSegment(id: string, name: string, offset: number, generation: number): Promise<void> {
    if (!this.isLive(id, generation) || !this.isSealedSegmentName(id, name)) return;
    const segment = join(this.dir, name);
    const segmentKey = this.segmentStateKey(id, name);
    let size: number;
    let identity: string;
    try {
      const stats = await statFile(segment);
      size = stats.size;
      identity = this.fileIdentity(stats);
    } catch {
      return;
    }
    if (!this.isLive(id, generation)) return;
    if (size !== offset) {
      this.segmentEmptyPolls.set(segmentKey, 0);
      return;
    }
    const emptyPolls = (this.segmentEmptyPolls.get(segmentKey) ?? 0) + 1;
    this.segmentEmptyPolls.set(segmentKey, emptyPolls);
    if (emptyPolls < 2) return;
    if (!(await this.setBackpressureMarker(id, offset, generation)) || !this.isLive(id, generation)) return;

    let drainPath: string | undefined;
    let verificationPath: string | undefined;
    try {
      const afterStats = await statFile(segment);
      const after = afterStats.size;
      if (!this.isLive(id, generation)) return;
      if (this.fileIdentity(afterStats) !== identity) {
        this.segmentEmptyPolls.set(segmentKey, 0);
        return;
      }
      if (after !== (this.segmentOffsets.get(segmentKey) ?? offset)) {
        this.segmentEmptyPolls.set(segmentKey, 0);
        return;
      }
      // Generation chaining: this newer generation is proven fully drained
      // (size == offset across two empty polls). Retire a settled older
      // anchor whose bytes are all delivered-or-skipped. If the older anchor
      // still has undelivered bytes, wait: normal passes drain it first by
      // sequence order, and a later pass retries this reclaim.
      const olderAnchor = this.retainedSegments.get(id);
      if (olderAnchor !== undefined && olderAnchor !== name) {
        const olderKey = this.segmentStateKey(id, olderAnchor);
        let olderSize: number;
        try {
          olderSize = (await statFile(join(this.dir, olderAnchor))).size;
        } catch {
          this.quarantine(id, generation, `retained sidecar anchor ${olderAnchor} disappeared`);
          return;
        }
        const olderDrained = olderSize === (this.segmentOffsets.get(olderKey) ?? 0)
          && !this.segmentPartialRecords.has(olderKey)
          && !this.segmentOversizedRecords.has(olderKey);
        if (!olderDrained) return;
        try {
          await durableUnlink(join(this.dir, olderAnchor));
        } catch {
          this.quarantine(id, generation, `retained sidecar anchor ${olderAnchor} could not be retired`);
          return;
        }
        this.segmentOffsets.delete(olderKey);
        this.segmentIdentities.delete(olderKey);
        this.segmentPartialRecords.delete(olderKey);
        this.segmentOversizedRecords.delete(olderKey);
        this.segmentEmptyPolls.delete(olderKey);
        this.sequenceGapPolls.delete(olderKey);
        this.retainedSegments.delete(id);
        if (this.sealedSegments.get(id) === olderAnchor) this.sealedSegments.delete(id);
      }
      if (!(await this.persistCursor(id, {
        offset: this.offsets.get(id) ?? 0,
        sealedOffset: after,
        sealedIdentity: identity,
        sealedSegment: name,
      }, generation)) || !this.isLive(id, generation)) return;

      // link() is the proof that the inode remains reachable after the
      // published sealed pathname is removed. If the platform cannot create
      // it, fail closed and leave the sealed generation untouched.
      drainPath = `${segment}.draining-${randomUUID()}`;
      await linkFile(segment, drainPath);
      await syncParentDirectory(drainPath);
      if (!this.isLive(id, generation)) return;
      this.segmentDrainPaths.set(id, drainPath);
      await durableUnlink(segment);
      if (!this.isLive(id, generation)) return;

      // The delayed-unlink window is deliberately drained through the hard
      // link. This also catches an append from a retired descriptor which was
      // opened before the writer published the sealed generation.
      await this.readSource(id, true, name, generation, false);
      if (!this.isLive(id, generation)) return;
      for (let pass = 0; pass < 3; pass++) {
        const latest = (await statFile(drainPath)).size;
        const current = this.segmentOffsets.get(segmentKey) ?? 0;
        if (latest !== current) {
          await this.readSource(id, true, name, generation, false);
          if (!this.isLive(id, generation)) return;
          continue;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        if ((await statFile(drainPath)).size !== latest) continue;
        break;
      }
      const finalOffset = this.segmentOffsets.get(segmentKey) ?? 0;
      if (this.segmentPartialRecords.has(segmentKey) || this.segmentOversizedRecords.has(segmentKey)) return;
      if (!(await this.persistCursor(id, {
        offset: this.offsets.get(id) ?? 0,
        sealedOffset: finalOffset,
        sealedIdentity: identity,
        sealedSegment: name,
      }, generation)) || !this.isLive(id, generation)) return;

      // A final guard link ensures the first retirement unlink cannot make an
      // inode unreachable while a descriptor is still being drained.
      const finalGuard = `${drainPath}.final-${randomUUID()}`;
      await linkFile(drainPath, finalGuard);
      await syncParentDirectory(finalGuard);
      await durableUnlink(drainPath);
      if (!this.isLive(id, generation)) return;
      this.segmentDrainPaths.set(id, finalGuard);
      await this.readSource(id, true, name, generation, false);
      if (!this.isLive(id, generation)) return;
      const afterGuard = (await statFile(finalGuard)).size;
      if (afterGuard !== (this.segmentOffsets.get(segmentKey) ?? finalOffset)) {
        this.segmentEmptyPolls.set(segmentKey, 0);
        return;
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
      if (!this.isLive(id, generation)) return;
      this.segmentDrainPaths.set(id, verificationPath);
      await this.readSource(id, true, name, generation, false);
      if (!this.isLive(id, generation)) return;
      const verified = await this.verifySealedPublication(name, verificationPath, identity);
      if (!verified) {
        console.warn(`[sidecar] ${id} sealed generation ${name} failed publication verification; keeping retained anchor`);
      }
      if (!this.isLive(id, generation)) return;

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
      } else {
        // The anchor is settled: the drain link IS the retained path, so
        // join() resolution is identical. Clear it so idle polls stop
        // re-binding this anchor until the next rotation lands.
        this.segmentDrainPaths.delete(id);
      }
      return;
    } catch {
      /* Keep flow control asserted until a later poll can retry reclaim. */
      return;
    }
  }

  private pause(id: string, generation = this.terminalGenerations.get(id)): void {
    if (!this.isLive(id, generation)) return;
    this.paused.add(id);
    this.notifyHold(id);
    // Assert producer flow control immediately on admission failure, rather
    // than waiting for the next 300 ms poll to discover an 8 MiB overflow.
    // This keeps a paused sidecar a bounded spool even when its producer is
    // much faster than the recovery poll.
    void this.setBackpressureMarker(id, 0, generation);
    void this.checkBacklog(id, undefined, generation);
    if (this.resumeTimers.has(id)) return;
    // Pause auto-retries after 300 ms. It remains paused between retries,
    // so a hot producer cannot create one read task per polling tick.
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
      this.notifyHold(id);
      void this.tail(id, generation);
    }, 300);
    this.resumeTimers.set(id, timer);
  }

  private async checkBacklog(
    id: string,
    knownRetained?: number,
    generation = this.terminalGenerations.get(id),
    segmentNames?: SidecarSegmentNames,
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
      const names = segmentNames ?? await this.listSegmentNames(id);
      for (const name of names.sealed) {
        await count(join(this.dir, name), name === activeSegment ? (this.segmentOffset(id, name) ?? 0) : 0);
      }
      for (const name of names.retained) {
        await count(join(this.dir, name), name === activeSegment ? (this.segmentOffset(id, name) ?? 0) : 0);
      }
      const drainPath = this.segmentDrainPaths.get(id);
      if (drainPath) await count(drainPath, this.segmentOffset(id, activeSegment) ?? 0);
    }
    if (!this.isLive(id, generation)) return undefined;
    const holdProducer = this.paused.has(id) || this.quarantined.has(id);
    if (holdProducer) void this.setBackpressureMarker(id, retained, generation);
    // Overflow is a held-terminal signal (see maxBacklogBytes docs): an
    // unpaused terminal over a large sealed segment is draining, not stuck,
    // so a fresh watch must not warn spuriously. The retained-anchor bound
    // stays unconditioned: an escaped descriptor growing the anchor behind
    // the drain trips it while unpaused, and losing that breaker would turn
    // runaway retained growth into a silent stall. A crash restart with a
    // huge undrained remainder can trip it spuriously; bytes are preserved
    // and the marker is loud. Progress-aware overflow is future work.
    if (retained > this.maxBacklogBytes) {
      if (holdProducer) this.reportBacklogOverflow(id, retained, generation);
      else if (this.retainedSegments.has(id)) {
        this.quarantine(id, generation, "retained sidecar source exceeded bounded backlog");
      }
    } else if (!holdProducer) {
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
      if (previous && this.persistedCursors.has(id) && sameDurableSidecarCursor(previous, cursor)) return true;
      try {
        await atomicWriteFile(this.cursorPath(id), JSON.stringify(cursor));
        if (!this.isLive(id, generation)) return false;
        this.durableCursors.set(id, cursor);
        this.persistedCursors.add(id);
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
    const known = this.bridgeIds.get(id) ?? new Set<string>();
    known.add(envelope.bridgeId);
    while (known.size > 8) known.delete(known.values().next().value!);
    this.bridgeIds.set(id, known);
    this.streams.set(id, { bridgeId: envelope.bridgeId, sequence: envelope.seq });
    if (envelope.producerPid !== undefined) this.producerPids.set(id, envelope.producerPid);
    return true;
  }

  private canAcceptEvent(id: string, envelope: SidecarMeta, kind: unknown): boolean {
    const previous = this.streams.get(id);
    // A session_ready from a child is not authority to replace the live
    // producer. Older on-disk records may lack a PID; once bound, require it.
    const producerPid = this.producerPids.get(id);
    if (producerPid !== undefined && envelope.producerPid !== producerPid) {
      if (kind !== "session_ready" || envelope.producerPid === undefined
        || envelope.producerPid !== this.expectedProducerPids.get(id)) return false;
    }
    const known = this.bridgeIds.get(id) ?? new Set<string>();
    if (previous?.bridgeId !== envelope.bridgeId) {
      if (known.has(envelope.bridgeId)) return false;
      if (previous && kind !== "session_ready") return false;
    }
    if (previous?.bridgeId === envelope.bridgeId && envelope.seq <= previous.sequence) return false;
    return true;
  }
}
