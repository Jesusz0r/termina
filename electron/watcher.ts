/**
 * Recursive project watcher.
 *
 * Feeds the live editor: whenever a file the agent touches changes on disk
 * (via write/edit/bash...), the watcher reads it and pushes the new content to
 * the renderer so Monaco updates in real time. It also feeds the "modified
 * files" panel for files changed outside of explicit write/edit tool calls.
 */
import { watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  IGNORED_SEGMENTS,
  matchGitignore,
  parseGitignore,
  type GitignoreRules,
} from "../shared/gitignore.js";

// Live .gitignore files stay on the watcher. The compiler lives in shared/gitignore.ts.

export { IGNORED_SEGMENTS, matchGitignore, parseGitignore };
export type { GitignoreRule, GitignoreRules } from "../shared/gitignore.js";

/** The precomputed Git blob oids of one cached content string. */
export interface CachedOids {
  sha1: string;
  sha256: string;
}

/** The Git blob oid of a content string in one object format. */
export function blobOid(content: string, algorithm: "sha1" | "sha256"): string {
  const header = Buffer.from(`blob ${Buffer.byteLength(content)}\0`);
  return createHash(algorithm).update(header).update(content, "utf8").digest("hex");
}

interface FileChange {
  /** Absolute path. */
  path: string;
  /** Path relative to the watched root. */
  relPath: string;
  content: string;
  status: "created" | "modified";
  /** The cached content BEFORE this change (absent on the first touch). */
  prev?: string;
}

const MAX_FILE_SIZE = 2 * 1024 * 1024; // do not read huge files into Monaco
const DEBOUNCE_MS = 120;

/** Admission bounds for pending watcher paths and callback fanout. */
const WATCHER_EVENT_QUEUE_HIGH_WATER_ITEMS = 2000;
const WATCHER_EVENT_QUEUE_HIGH_WATER_BYTES = 4 * 1024 * 1024;
const WATCHER_EVENT_IN_FLIGHT_HIGH_WATER = 8;

export interface ProjectWatcherAdmissionLimits {
  maxPendingItems?: number;
  maxPendingBytes?: number;
  maxInFlight?: number;
}

export interface ProjectWatcherQueueStats {
  pendingItems: number;
  pendingBytes: number;
  inFlight: number;
}

type WatcherReadDirectory = (
  path: string,
  options: { withFileTypes: true },
) => Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>>;

interface FailedWatcherPath {
  generation: number;
  reconcile: boolean;
  attempts: number;
}

export class ProjectWatcher {
  private watcher: FSWatcher | null = null;
  private timers = new Map<string, NodeJS.Timeout>();
  /** Bytes retained by debounce timers. */
  private timerBytes = 0;
  /** Ready paths waiting for a bounded callback slot. */
  private ready = new Map<string, { generation: number; reconcile: boolean; bytes: number }>();
  private readyBytes = 0;
  private activePaths = new Set<string>();
  /** Paths whose callback or final-state read failed and must be retried. */
  private failedPaths = new Map<string, FailedWatcherPath>();
  private failedRetryTimers = new Map<string, NodeJS.Timeout>();
  private failedBytes = 0;
  private readonly maxPendingItems: number;
  private readonly maxPendingBytes: number;
  private readonly maxInFlight: number;
  private overflowed = false;
  private reconcileRunning = false;
  private watcherPaused = false;
  /** Relevant native notifications observed while a scan is overlapping. */
  private reconcileJournal = new Set<string>();
  private reconcileJournalBytes = 0;
  private reconcileJournalOverflowed = false;
  private reconcileRetryTimer: NodeJS.Timeout | null = null;
  private reconcileAttempts = 0;
  /** Diagnostic count: paths visited by the bounded reconciliation walker. */
  private reconciledPathCount = 0;
  private readonly readDirectory: WatcherReadDirectory;
  private capacityWaiters: Array<{ generation: number; relPath?: string; bytes: number; resolve: (ok: boolean) => void }> = [];
  private drainWaiters: Array<{ generation: number; resolve: (ok: boolean) => void }> = [];
  /** Increments on every relevant raw fs notification, before debounce. */
  private rawRevision = 0;
  /** Changes whenever watcher observation becomes available or unavailable. */
  private healthRevision = 0;
  /** A failed watcher must never certify a checkpoint as stable. */
  private healthy = false;
  /** Debounced emits still running their callbacks. */
  private emitting = 0;
  private seen = new Set<string>();
  /** Rules of every loaded .gitignore, keyed by directory. */
  private gitignoreRules: GitignoreRules = new Map();

  /**
   * Rolling cache of the last known content for every watched text file.
   * Used as the pre-run baseline for the Change Review feature: at
   * agent_start we snapshot this map, so diffs compare the run's start
   * state against the current file.
   */
  lastContents = new Map<string, string>();
  /** Blob oids of the cached contents, hashed once per file version.
   *  The moment capture ships these instead of the contents themselves,
   *  so the core compares hashes without re-hashing every file. */
  lastOids = new Map<string, CachedOids>();
  private static readonly CACHE_LIMIT = 5000;
  /** Byte budget for the cache — count alone can reach gigabytes with big files. */
  private static readonly CACHE_BYTES = 64 * 1024 * 1024;
  private cacheBytes = 0;
  private generation = 0;

  /** Fired with the new file content whenever a watched text file changes. */
  onChange: (change: FileChange) => void | Promise<void> = () => {};
  /** Fired with just the path (used for the modified-files list). */
  onFileTouched: (path: string, status: "created" | "modified") => void | Promise<void> = () => {};
  /** Fired when a previously-seen file disappears (tabs and list entries clean up). */
  onFileDeleted: (path: string) => void | Promise<void> = () => {};

  /**
   * @param root watched directory
   * @param canonicalize optional path normalizer (for example realpath)
   *        applied to cache keys, so lookups with canonical paths always hit.
   */
  constructor(
    private root: string,
    private canonicalize?: (p: string) => string | Promise<string>,
    private watchTree: typeof watch = watch,
    limits: ProjectWatcherAdmissionLimits = {},
    readDirectory: WatcherReadDirectory = readdir as unknown as WatcherReadDirectory,
  ) {
    this.maxPendingItems = limits.maxPendingItems ?? WATCHER_EVENT_QUEUE_HIGH_WATER_ITEMS;
    this.maxPendingBytes = limits.maxPendingBytes ?? WATCHER_EVENT_QUEUE_HIGH_WATER_BYTES;
    this.maxInFlight = limits.maxInFlight ?? WATCHER_EVENT_IN_FLIGHT_HIGH_WATER;
    this.readDirectory = readDirectory;
    if (!Number.isSafeInteger(this.maxPendingItems) || this.maxPendingItems < 1) throw new Error("invalid watcher item high-water mark");
    if (!Number.isSafeInteger(this.maxPendingBytes) || this.maxPendingBytes < 1) throw new Error("invalid watcher byte high-water mark");
    if (!Number.isSafeInteger(this.maxInFlight) || this.maxInFlight < 1) throw new Error("invalid watcher in-flight high-water mark");
  }

  start(): void {
    this.stop();
    const generation = this.generation;
    this.armWatcher(generation);
    // Seed the seen-set with existing files so the first real edit reads as
    // "modified" rather than "created" (files the agent creates are new to us).
    void this.seedExisting(generation);
  }

  private armWatcher(generation: number, announceHealth = true): void {
    // macOS/Windows support recursive watching; on Linux this throws and we degrade.
    try {
      const watcher = this.watchTree(this.root, { recursive: true }, (_event, filename) => {
        if (generation !== this.generation) return;
        // Node can report a native change without a usable filename. It is
        // still raw activity: invalidate any idle barrier, but never invent a
        // path or read a made-up file.
        this.rawRevision++;
        const rawFilename: unknown = filename;
        if (typeof rawFilename === "string") {
          if (rawFilename) this.schedule(rawFilename, generation, true);
          return;
        }
        if (!Buffer.isBuffer(rawFilename) || rawFilename.length === 0) return;
        const relPath = rawFilename.toString("utf8");
        if (!relPath || !Buffer.from(relPath, "utf8").equals(rawFilename)) return;
        this.schedule(relPath, generation, true);
      });
      watcher.on("error", (err) => {
        if (this.watcher !== watcher) return;
        try {
          watcher.close();
        } catch {
          /* already closed */
        }
        this.watcher = null;
        this.markUnhealthy();
        console.warn(`[watcher] watch failed: ${(err as Error).message}`);
      });
      this.watcher = watcher;
      this.watcherPaused = false;
      if (announceHealth) this.markHealthy();
      else this.healthy = true;
    } catch (err) {
      this.watcher = null;
      this.markUnhealthy();
      console.warn(`[watcher] recursive watch unavailable: ${(err as Error).message}`);
    }
  }

  stop(): void {
    this.generation++;
    this.rawRevision++;
    this.healthy = false;
    this.healthRevision++;
    this.overflowed = false;
    this.reconcileRunning = false;
    this.watcherPaused = false;
    if (this.reconcileRetryTimer) clearTimeout(this.reconcileRetryTimer);
    this.reconcileRetryTimer = null;
    this.clearReconcileJournal();
    this.reconcileJournalOverflowed = false;
    this.reconciledPathCount = 0;
    this.seen.clear();
    this.lastContents.clear();
    this.lastOids.clear();
    this.cacheBytes = 0;
    this.gitignoreRules.clear();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.timerBytes = 0;
    this.ready.clear();
    this.readyBytes = 0;
    for (const timer of this.failedRetryTimers.values()) clearTimeout(timer);
    this.failedRetryTimers.clear();
    this.failedPaths.clear();
    this.failedBytes = 0;
    this.resolveCapacityWaiters(false);
    this.resolveDrainWaiters(false);
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* ignore */
      }
      this.watcher = null;
    }
  }

  private schedule(relPath: string, generation: number, rawObserved = false): void {
    if (generation !== this.generation || this.isIgnored(relPath)) return;
    if (!rawObserved) this.rawRevision++;
    if (this.reconcileRunning || this.overflowed) {
      this.recordReconcileNotification(relPath);
      return;
    }
    const failed = this.failedPaths.get(relPath);
    if (failed) {
      failed.reconcile = true;
      return;
    }
    const pathBytes = this.pathBytes(relPath);

    // A newer notification supersedes a ready-but-not-started notification of
    // the same path.  Re-arm its debounce window without adding another item.
    const ready = this.ready.get(relPath);
    if (ready) {
      this.ready.delete(relPath);
      this.readyBytes -= ready.bytes;
      this.armPathTimer(relPath, generation, pathBytes);
    }

    const existing = this.timers.get(relPath);
    if (existing) {
      clearTimeout(existing);
      this.timers.set(relPath, this.createPathTimer(relPath, generation));
      return;
    }

    // Do not evict a path when the admission budget is full.  Pause native
    // notifications and reconcile the final filesystem state after the
    // bounded emitter drains, so every path still reaches its latest state.
    if (!this.hasPendingCapacity(pathBytes)) {
      this.requestReconcile(generation);
      return;
    }

    this.armPathTimer(relPath, generation, pathBytes);
  }

  private pathBytes(relPath: string): number {
    return Buffer.byteLength(relPath, "utf8") + 1;
  }

  private createPathTimer(relPath: string, generation: number): NodeJS.Timeout {
    return setTimeout(() => {
      if (generation !== this.generation) return;
      this.timers.delete(relPath);
      this.timerBytes -= this.pathBytes(relPath);
      this.enqueueReady(relPath, generation, false);
    }, DEBOUNCE_MS);
  }

  private armPathTimer(relPath: string, generation: number, pathBytes: number): void {
    const existing = this.timers.get(relPath);
    if (existing) clearTimeout(existing);
    if (!existing) this.timerBytes += pathBytes;
    this.timers.set(relPath, this.createPathTimer(relPath, generation));
  }

  private enqueueReady(relPath: string, generation: number, reconcile: boolean): boolean {
    if (generation !== this.generation) return false;
    const existing = this.ready.get(relPath);
    if (existing) {
      existing.reconcile ||= reconcile;
      return true;
    }
    const bytes = this.pathBytes(relPath);
    if (!this.hasPendingCapacity(bytes, relPath)) {
      this.requestReconcile(generation);
      return false;
    }
    this.ready.set(relPath, { generation, reconcile, bytes });
    this.readyBytes += bytes;
    this.pumpEmitter();
    return true;
  }

  private hasPendingCapacity(additionalBytes = 0, replacingFailedPath?: string): boolean {
    let pendingItems = this.timers.size + this.ready.size + this.failedPaths.size;
    let pendingBytes = this.timerBytes + this.readyBytes + this.failedBytes;
    for (const [relPath, failed] of this.failedPaths) {
      if (!failed || !this.ready.has(relPath)) continue;
      pendingItems--;
      pendingBytes -= this.pathBytes(relPath);
    }
    if (replacingFailedPath && this.failedPaths.has(replacingFailedPath) && !this.ready.has(replacingFailedPath)) {
      pendingItems--;
      pendingBytes -= this.pathBytes(replacingFailedPath);
    }
    return pendingItems < this.maxPendingItems && pendingBytes + additionalBytes <= this.maxPendingBytes;
  }

  private requestReconcile(generation: number): void {
    if (generation !== this.generation) return;
    if (!this.overflowed) {
      this.overflowed = true;
      this.pauseWatcher();
    }
    this.maybeStartReconcile();
  }

  private pauseWatcher(): void {
    this.watcherPaused = true;
    // Keep the native observer open during reconciliation. Closing it creates
    // a scan/re-arm gap in which a mutation can be neither journaled nor
    // rediscovered. The callback below journals overlapping notifications;
    // the bounded two-pass scan also catches files whose native notification
    // arrives after the directory snapshot.
  }

  private recordReconcileNotification(relPath: string): void {
    if (this.reconcileJournal.has(relPath)) return;
    const limit = Math.max(1024, this.maxPendingItems * 4);
    const bytes = this.pathBytes(relPath);
    if (this.reconcileJournal.size >= limit || this.reconcileJournalBytes + bytes > this.maxPendingBytes) {
      this.reconcileJournalOverflowed = true;
      return;
    }
    this.reconcileJournal.add(relPath);
    this.reconcileJournalBytes += bytes;
  }

  private clearReconcileJournal(): void {
    this.reconcileJournal.clear();
    this.reconcileJournalBytes = 0;
  }

  private pumpEmitter(): void {
    while (this.emitting < this.maxInFlight && this.ready.size > 0) {
      let selected: [string, { generation: number; reconcile: boolean; bytes: number }] | undefined;
      for (const entry of this.ready) {
        if (!this.activePaths.has(entry[0])) {
          selected = entry;
          break;
        }
      }
      if (!selected) break;
      const [relPath, pending] = selected;
      this.ready.delete(relPath);
      this.readyBytes -= pending.bytes;
      this.activePaths.add(relPath);
      this.emitting++;
      void this.emit(relPath, pending.generation, pending.reconcile)
        .then(() => {
          if (pending.generation !== this.generation) return;
          this.clearFailedPath(relPath, pending.generation);
          // A transient callback/read failure is recoverable while the native
          // observer remains open. Restore health only after the retry has
          // actually completed.
          if (this.watcher && !this.healthy) this.markHealthy();
        })
        .catch((err) => {
          if (pending.generation === this.generation) {
            this.markUnhealthy();
            this.scheduleFailedPath(relPath, pending.generation, pending.reconcile);
          }
          console.warn(`[watcher] change failed: ${(err as Error).message}`);
        })
        .finally(() => {
          this.activePaths.delete(relPath);
          this.emitting--;
          this.resolveCapacityWaiters(true);
          this.resolveDrainWaiters(true);
          this.pumpEmitter();
          this.maybeStartReconcile();
        });
    }
    this.resolveCapacityWaiters(true);
    this.resolveDrainWaiters(true);
    this.maybeStartReconcile();
  }

  private scheduleFailedPath(relPath: string, generation: number, reconcile: boolean): void {
    if (generation !== this.generation) return;
    const previous = this.failedPaths.get(relPath);
    if (!previous && (this.failedPaths.size >= this.maxPendingItems || this.failedBytes + this.pathBytes(relPath) > this.maxPendingBytes)) {
      // Keep the failed path observable through the overlap scan instead of
      // growing a second unbounded retry map. The filesystem is authoritative
      // and the overflow journal/scan will rediscover its final state.
      this.requestReconcile(generation);
      return;
    }
    const failed: FailedWatcherPath = {
      generation,
      reconcile: previous?.reconcile === true || reconcile,
      attempts: (previous?.attempts ?? 0) + 1,
    };
    this.failedPaths.set(relPath, failed);
    if (!previous) this.failedBytes += this.pathBytes(relPath);
    this.rawRevision++;
    if (this.failedRetryTimers.has(relPath)) return;
    const delay = Math.min(2000, 100 * 2 ** Math.min(failed.attempts - 1, 4));
    const timer = setTimeout(() => {
      this.failedRetryTimers.delete(relPath);
      if (generation !== this.generation || !this.failedPaths.has(relPath)) return;
      if (!this.enqueueReady(relPath, generation, true)) this.requestReconcile(generation);
    }, delay);
    this.failedRetryTimers.set(relPath, timer);
  }

  private clearFailedPath(relPath: string, generation: number): void {
    const failed = this.failedPaths.get(relPath);
    if (!failed || failed.generation !== generation) return;
    this.failedPaths.delete(relPath);
    this.failedBytes = Math.max(0, this.failedBytes - this.pathBytes(relPath));
    const timer = this.failedRetryTimers.get(relPath);
    if (timer) clearTimeout(timer);
    this.failedRetryTimers.delete(relPath);
  }

  private markHealthy(): void {
    this.healthy = true;
    this.healthRevision++;
    this.rawRevision++;
  }

  private markUnhealthy(): void {
    this.healthy = false;
    this.healthRevision++;
    this.rawRevision++;
  }

  /**
   * Wait for a full debounce interval with no relevant raw notification, and
   * for every queued callback to complete. The returned revision lets a
   * caller reject a capture if new raw activity starts after this barrier.
   */
  async waitForIdle(timeoutMs: number): Promise<number | null> {
    if (!this.healthy) return null;
    const deadline = Date.now() + timeoutMs;
    let revision = this.rawRevision;
    const healthRevision = this.healthRevision;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await new Promise((resolve) => setTimeout(resolve, Math.min(DEBOUNCE_MS, remaining)));
      if (!this.healthy || this.healthRevision !== healthRevision) return null;
      if (this.rawRevision !== revision) {
        revision = this.rawRevision;
        continue;
      }
      if (this.timers.size === 0 && this.ready.size === 0 && this.emitting === 0 && this.failedPaths.size === 0 && !this.reconcileRunning && !this.overflowed) return revision;
    }
  }

  /** True only if no raw event, debounce timer, or callback started since an idle barrier. */
  isIdleAt(revision: number): boolean {
    return this.healthy
      && this.rawRevision === revision
      && this.timers.size === 0
      && this.ready.size === 0
      && this.emitting === 0
      && this.failedPaths.size === 0
      && !this.reconcileRunning
      && !this.overflowed;
  }

  /** True while native notifications are paused for overflow recovery. */
  isPaused(): boolean {
    return this.watcherPaused;
  }

  queueStats(): ProjectWatcherQueueStats {
    let duplicateFailed = 0;
    let duplicateFailedBytes = 0;
    for (const relPath of this.failedPaths.keys()) {
      if (!this.ready.has(relPath)) continue;
      duplicateFailed++;
      duplicateFailedBytes += this.pathBytes(relPath);
    }
    return {
      pendingItems: this.timers.size + this.ready.size + this.failedPaths.size - duplicateFailed,
      pendingBytes: this.timerBytes + this.readyBytes + this.failedBytes - duplicateFailedBytes,
      inFlight: this.emitting,
    };
  }

  private resolveCapacityWaiters(ok: boolean): void {
    if (this.capacityWaiters.length === 0) return;
    const waiting = this.capacityWaiters;
    this.capacityWaiters = [];
    for (const waiter of waiting) {
      if (waiter.generation !== this.generation) waiter.resolve(false);
      else if (ok && this.hasPendingCapacity(waiter.bytes, waiter.relPath)) waiter.resolve(true);
      else this.capacityWaiters.push(waiter);
    }
  }

  private resolveDrainWaiters(ok: boolean): void {
    if (this.drainWaiters.length === 0) return;
    const waiting = this.drainWaiters;
    this.drainWaiters = [];
    for (const waiter of waiting) {
      if (waiter.generation !== this.generation) waiter.resolve(false);
      else if (!ok || (this.timers.size === 0 && this.ready.size === 0 && this.emitting === 0)) {
        waiter.resolve(ok);
      }
      else this.drainWaiters.push(waiter);
    }
  }

  private waitForCapacity(generation: number, bytes: number, relPath?: string): Promise<boolean> {
    if (generation !== this.generation) return Promise.resolve(false);
    if (bytes > this.maxPendingBytes) return Promise.resolve(false);
    if (this.hasPendingCapacity(bytes, relPath)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => this.capacityWaiters.push({ generation, relPath, bytes, resolve }));
  }

  private waitForDrain(generation: number): Promise<boolean> {
    if (generation !== this.generation) return Promise.resolve(false);
    if (this.timers.size === 0 && this.ready.size === 0 && this.emitting === 0) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => this.drainWaiters.push({ generation, resolve }));
  }

  private maybeStartReconcile(): void {
    if (!this.overflowed || this.reconcileRunning || this.reconcileRetryTimer || this.timers.size !== 0 || this.ready.size !== 0 || this.emitting !== 0) return;
    const generation = this.generation;
    if (!this.watcher) this.armWatcher(generation, false);
    this.reconcileRunning = true;
    this.reconcileAttempts++;
    // Native observation remains open while the scan overlaps it. Do not
    // clear overflow until the post-scan quiet barrier proves the final
    // state was observed.
    void this.reconcile(generation)
      .then((recovered) => {
        if (generation !== this.generation) return;
        if (recovered) {
          this.overflowed = false;
          this.watcherPaused = false;
          this.clearReconcileJournal();
          this.reconcileJournalOverflowed = false;
          return;
        }
        this.overflowed = true;
        this.scheduleReconcileRetry(generation);
      })
      .catch((error: unknown) => {
        if (generation !== this.generation) return;
        this.overflowed = true;
        this.markUnhealthy();
        console.warn(`[watcher] overflow reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
        this.scheduleReconcileRetry(generation);
      })
      .finally(() => {
        if (generation !== this.generation) return;
        this.reconcileRunning = false;
        this.resolveCapacityWaiters(true);
        this.resolveDrainWaiters(true);
        this.pumpEmitter();
      });
  }

  private scheduleReconcileRetry(generation: number): void {
    if (generation !== this.generation || this.reconcileRetryTimer) return;
    const delay = Math.min(2000, 100 * Math.max(1, Math.min(this.reconcileAttempts, 20)));
    this.reconcileRetryTimer = setTimeout(() => {
      this.reconcileRetryTimer = null;
      if (generation === this.generation) this.maybeStartReconcile();
    }, delay);
  }

  /** Reconcile final filesystem state after an overflow without retaining a
   *  second unbounded event list.  The ready emitter remains the sole fanout
   *  path and waits for capacity between scan entries. */
  private async reconcile(generation: number): Promise<boolean> {
    // Three complete passes provide an overlap window even when a platform
    // watcher coalesces or omits a notification. The native watcher remains
    // open, and every notification during a pass is journaled by schedule().
    const passCount = 3;
    for (let pass = 0; pass < passCount; pass++) {
      if (generation !== this.generation) return false;
      const scanRevision = this.rawRevision;
      this.clearReconcileJournal();
      this.reconcileJournalOverflowed = false;
      const observed = new Set<string>();
      let observedLimitExceeded = false;
      let scanAborted = false;
      const walk = async (dir: string): Promise<void> => {
        if (generation !== this.generation || scanAborted) return;
        const entries = await this.readDirectory(dir, { withFileTypes: true });
        for (const ent of entries) {
          if (generation !== this.generation || scanAborted) return;
          if (IGNORED_SEGMENTS.has(ent.name)) continue;
          const full = join(dir, ent.name);
          if (ent.isDirectory()) {
            await walk(full);
            continue;
          }
          if (!ent.isFile()) continue;
          const relPath = relative(this.root, full);
          if (!relPath || this.isIgnored(relPath)) continue;
          this.reconciledPathCount++;
          // Keep the deletion set bounded. Every final path still goes
          // through the bounded emitter; above the cap we fail closed for
          // deletion certification and retry instead of becoming unhealthy.
          if (observed.size < 100_000) observed.add(relPath);
          else observedLimitExceeded = true;
          const bytes = this.pathBytes(relPath);
          if (!(await this.waitForCapacity(generation, bytes, relPath))) {
            scanAborted = true;
            return;
          }
          if (!this.enqueueReady(relPath, generation, true)) {
            scanAborted = true;
            return;
          }
        }
      };
      await walk(this.root);
      if (generation !== this.generation) return false;
      // A path larger than the pending-byte budget (or a generation stop)
      // must never turn an incomplete scan into a false healthy/idle result.
      if (scanAborted) return false;
      if (!observedLimitExceeded) {
        for (const relPath of this.seen) {
          if (observed.has(relPath)) continue;
          const bytes = this.pathBytes(relPath);
          if (!(await this.waitForCapacity(generation, bytes, relPath))) return false;
          if (!this.enqueueReady(relPath, generation, true)) return false;
        }
      }
      if (!(await this.waitForDrain(generation))) return false;
      if (generation !== this.generation) return false;
      if (observedLimitExceeded) {
        return false;
      }

      // A scan is not a certification point until the native journal and a
      // full debounce interval are both quiet. The follow-up passes are
      // deliberate: they catch mutations made by an onChange callback after
      // an earlier pass has read its directory but before its drain completes.
      if (this.rawRevision !== scanRevision || this.reconcileJournal.size > 0 || this.reconcileJournalOverflowed) {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS));
      if (generation !== this.generation) return false;
      if (this.rawRevision !== scanRevision || this.reconcileJournal.size > 0 || this.reconcileJournalOverflowed) {
        continue;
      }
      if (pass === passCount - 1) {
        if (this.failedPaths.size > 0) return false;
        if (!this.watcher) return false;
        if (!this.healthy) this.markHealthy();
        return true;
      }
    }
    // Repeated activity during every bounded pass never certifies idle. Keep
    // overflow asserted so the retry/backoff path remains observable.
    return false;
  }

  private isIgnored(relPath: string): boolean {
    const segments = relPath.split(sep);
    if (segments.some((s) => IGNORED_SEGMENTS.has(s))) return true;
    return this.gitignoreRules.size > 0 && matchGitignore(this.gitignoreRules, segments.join("/"));
  }

  /** The directory key of one .gitignore path (platform separators in,
   *  POSIX-style key out; "" is the root). */
  private gitignoreDirKey(relPath: string): string {
    const norm = relPath.split(sep).join("/");
    const cut = norm.lastIndexOf("/");
    return cut === -1 ? "" : norm.slice(0, cut);
  }

  /** Read one .gitignore and store its rules under its directory key. */
  private async loadGitignore(absPath: string, relPath: string, generation: number): Promise<void> {
    let source: string;
    try {
      source = await readFile(absPath, "utf8");
    } catch {
      return;
    }
    if (generation !== this.generation) return;
    this.gitignoreRules.set(this.gitignoreDirKey(relPath), parseGitignore(source));
  }

  private async emit(relPath: string, generation: number, reconcileOnly = false): Promise<void> {
    if (generation !== this.generation) return;
    const abs = this.root.endsWith(sep) ? this.root + relPath : `${this.root}${sep}${relPath}`;

    // Stat first so a vanished file is reported as a deletion (not a read error).
    let st;
    try {
      st = await stat(abs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      if (generation === this.generation && this.seen.has(relPath)) {
        await this.onFileDeleted(abs);
        if (generation === this.generation) {
          this.seen.delete(relPath);
          if (relPath.split(sep).pop() === ".gitignore") {
            this.gitignoreRules.delete(this.gitignoreDirKey(relPath));
          }
        }
      }
      return;
    }
    if (generation !== this.generation || !st.isFile()) return;
    if (st.size > MAX_FILE_SIZE) {
      // A file can grow past the cap. Mark it seen so a later small read
      // reports "modified", and drop the stale cached content.
      this.seen.add(relPath);
      const key = this.canonicalize ? await this.canonicalize(abs) : abs;
      const evicted = this.lastContents.get(key);
      if (evicted !== undefined) {
        this.cacheBytes -= Buffer.byteLength(evicted, "utf8");
        this.lastContents.delete(key);
        this.lastOids.delete(key);
      }
      return;
    }

    let content: string;
    try {
      const buf = await readFile(abs);
      // NUL bytes do not appear in text. Check the buffer, not the decoded
      // string: valid text can contain the replacement character.
      if (buf.includes(0)) return;
      content = buf.toString("utf8");
    } catch (error) {
      throw error;
    }
    if (generation !== this.generation) return;

    // A changed .gitignore refreshes the rules before the next event uses
    // them. The file itself still flows through as a normal change.
    const baseName = relPath.split(sep).pop();
    if (baseName === ".gitignore") await this.loadGitignore(abs, relPath, generation);
    if (generation !== this.generation) return;

    const wasSeen = this.seen.has(relPath);
    const status: "created" | "modified" = wasSeen ? "modified" : "created";
    // Update the rolling content cache (evict oldest when over the limit).
    // Keys are canonicalized so lookups from anywhere in the app hit.
    const key = this.canonicalize ? await this.canonicalize(abs) : abs;
    const prev = this.lastContents.get(key); // pre-change content, for baselines
    // Reconciliation walks every final path, so an unchanged file must not
    // fan out another editor/baseline notification.
    if (reconcileOnly && wasSeen && prev === content) return;
    const change: FileChange = { path: abs, relPath, content, status, prev };
    await this.onChange(change);
    if (generation === this.generation) await this.onFileTouched(abs, status);
    if (generation === this.generation) {
      this.seen.add(relPath);
      this.putCached(key, content);
    }
  }

  /** Add one file version to the content cache and evict when over budget. */
  private putCached(key: string, content: string): void {
    const previous = this.lastContents.get(key);
    this.cacheBytes += Buffer.byteLength(content, "utf8") - (previous ? Buffer.byteLength(previous, "utf8") : 0);
    this.lastContents.set(key, content);
    this.lastOids.set(key, { sha1: blobOid(content, "sha1"), sha256: blobOid(content, "sha256") });
    while (this.lastContents.size > 1 && (this.lastContents.size > ProjectWatcher.CACHE_LIMIT || this.cacheBytes > ProjectWatcher.CACHE_BYTES)) {
      const oldest = this.lastContents.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.lastContents.get(oldest);
      this.cacheBytes -= evicted ? Buffer.byteLength(evicted, "utf8") : 0;
      this.lastContents.delete(oldest);
      this.lastOids.delete(oldest);
    }
  }

  /** Walk the project and mark existing files as seen. Their content is
   *  cached too, so the first change of a file still carries the pre-change
   *  content: editor highlights and run baselines need it. */
  private async seedExisting(generation: number): Promise<void> {
    const active = (): boolean => generation === this.generation;
    const walk = async (dir: string): Promise<void> => {
      if (!active()) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      if (!active()) return;
      for (const ent of entries) {
        if (!active() || this.seen.size > 100_000) return;
        if (IGNORED_SEGMENTS.has(ent.name)) continue;
        const full = join(dir, ent.name);
        if (ent.isDirectory()) {
          await walk(full);
        } else if (ent.isFile()) {
          const relPath = relative(this.root, full);
          if (ent.name === ".gitignore") await this.loadGitignore(full, relPath, generation);
          if (!active()) return;
          this.seen.add(relPath);
          // Cache the content within the existing byte budget. Ignored and
          // oversized files stay seen-only: emit never reports them.
          if (this.cacheBytes >= ProjectWatcher.CACHE_BYTES) continue;
          if (this.isIgnored(relPath)) continue;
          try {
            const st = await stat(full);
            if (!active()) return;
            if (!st.isFile() || st.size > MAX_FILE_SIZE) continue;
            const buf = await readFile(full);
            if (!active()) return;
            if (buf.includes(0)) continue; // binary
            const key = this.canonicalize ? await this.canonicalize(full) : full;
            if (!this.lastContents.has(key)) this.putCached(key, buf.toString("utf8"));
          } catch {
            /* unreadable — seen-only is enough */
          }
        }
      }
    };
    try {
      await walk(this.root);
    } catch {
      /* non-fatal */
    }
  }
}
