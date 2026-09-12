/**
 * Durable trace runtime.
 *
 * Owns the TraceRuntime lock/manifest/index/queue lifecycle. Split from
 * agent-core/trace.ts (issue #38).
 */
import { syncDirectoryAsync } from "../../shared/fsync.ts";
import { errorCode, isRecord } from "../../shared/guards.ts";
import { mkdir, open as openFile, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { freezeDeep } from "./normalize.ts";
import { compositeKey, countTurnFiles, createAttemptRecord, createTaskSettledRecord, emptyExistingScan, emptyManifestLinkIndex, freezeManifest, inspectExisting, newestTurnFiles, nonnegativeCounter, normalizeNamespace, processAlive, retryableFailureKind, stableError, taskKey, timestamp, traceTurnFromName, validPriorManifest, validTraceLinkIndex } from "./records.ts";
import type { ExistingScan } from "./records.ts";
import { DEFAULT_TRACE_MAX_RECORD_BYTES, DEFAULT_TRACE_MAX_SCAN_FILES, DEFAULT_TRACE_RETENTION_CAP, LINK_INDEX_FILE, MANIFEST_FILE, MAX_TRACE_INDEX_BYTES, MAX_TRACE_INDEX_ENTRIES, MAX_TRACE_MANIFEST_BYTES, TRACE_SCHEMA_VERSION } from "./schema.ts";
import type { FrozenTraceAttempt, FrozenTraceManifest, FrozenTraceTaskSettled, TraceAttempt, TraceAttemptIndexEntry, TraceAttemptInput, TraceLinkIndex, TraceManifest, TraceManifestOutcome, TraceManifestReset, TraceRole, TraceRuntimeOptions, TraceSettlementIndexEntry, TraceStartupResult, TraceTaskSettled, TraceTaskSettledInput, TraceWriteFailure, TraceWriteFailureKind, TraceWriteOutcome } from "./schema.ts";

let atomicFileCounter = 0;


type AtomicWriteResult = { ok: true } | { ok: false; error: string; renamed: boolean };


async function atomicWrite(path: string, textValue: string): Promise<AtomicWriteResult> {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${++atomicFileCounter}`;
  let handle: Awaited<ReturnType<typeof openFile>> | null = null;
  let renamed = false;
  try {
    handle = await openFile(temporary, "wx", 0o600);
    await handle.writeFile(textValue, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    renamed = true;
    await syncDirectoryAsync(dirname(path));
    return { ok: true };
  } catch (error) {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        /* best effort */
      }
    }
    try {
      await unlink(temporary);
    } catch {
      /* best effort */
    }
    return { ok: false, error: stableError(error), renamed };
  }
}


export class TraceRuntime {
  readonly directory: string;
  readonly retentionCap: number;
  readonly maxRecordBytes: number;
  readonly namespace: string;
  readonly maxQueueDepth: number;
  readonly ready: Promise<TraceStartupResult>;

  private readonly now: () => string | number | Date;
  private readonly manifestPath: string;
  private readonly indexPath: string;
  private readonly lockPath: string;
  private readonly lockToken: string;
  private initialized = false;
  private closed = false;
  private nextTraceTurn = 1;
  private manifestValue: TraceManifest;
  private startupResult: TraceStartupResult | null = null;
  private lockHandle: Awaited<ReturnType<typeof openFile>> | null = null;
  private readonly attempts = new Map<string, {
    runId: string;
    taskId: string;
    attemptId: string;
    role: TraceRole;
    retained: boolean;
    traceTurn: number | null;
    unknown: boolean;
  }>();
  private readonly settlements = new Map<string, {
    runId: string;
    taskId: string;
    attemptIds: string[];
    summaryAttemptIds: string[];
    finalAttemptId: string | null;
    retained: boolean;
    traceTurn: number | null;
    unknown: boolean;
  }>();
  private readonly recordsByTurn = new Map<number, { attemptKey?: string; settlementKey?: string }>();
  private linkIndexComplete = false;
  private linkIndexError: string | null = null;
  private linkIndexWriteFailures = 0;
  private queueTail: Promise<void> = Promise.resolve();
  private queueLength = 0;
  private closePromise: Promise<TraceManifestOutcome> | null = null;

  constructor(options: TraceRuntimeOptions) {
    if (!options || typeof options.directory !== "string" || options.directory.length === 0) {
      throw new Error("trace runtime directory is required");
    }
    this.directory = options.directory;
    this.retentionCap = options.retentionCap ?? DEFAULT_TRACE_RETENTION_CAP;
    this.maxRecordBytes = options.maxRecordBytes ?? DEFAULT_TRACE_MAX_RECORD_BYTES;
    if (!Number.isSafeInteger(this.retentionCap) || this.retentionCap < 1) {
      throw new Error("trace retentionCap must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxRecordBytes) || this.maxRecordBytes < 1) {
      throw new Error("trace maxRecordBytes must be a positive safe integer");
    }
    this.maxQueueDepth = options.maxQueueDepth ?? 128;
    if (!Number.isSafeInteger(this.maxQueueDepth) || this.maxQueueDepth < 1) {
      throw new Error("trace maxQueueDepth must be a positive safe integer");
    }
    this.namespace = normalizeNamespace(options.namespace, options.directory);
    this.now = options.now ?? (() => new Date());
    this.manifestPath = join(this.directory, MANIFEST_FILE);
    this.indexPath = join(this.directory, LINK_INDEX_FILE);
    this.lockPath = join(this.directory, "trace.lock");
    this.lockToken = `trace-${process.pid}-${Date.now()}-${++atomicFileCounter}`;
    this.manifestValue = this.emptyManifest({
      requested: options.reset === true,
      applied: false,
      omittedRecords: 0,
      failedRecords: 0,
    }, "trace runtime is starting");
    this.ready = this.initialize(options.reset === true, options.maxScanFiles ?? DEFAULT_TRACE_MAX_SCAN_FILES);
  }

  get startup(): Readonly<TraceStartupResult> | null {
    return this.startupResult;
  }

  get manifest(): FrozenTraceManifest {
    return freezeManifest(this.manifestValue);
  }

  /** Flush the current accounting manifest and return the storage outcome. */
  flushManifest(): Promise<TraceManifestOutcome> {
    if (this.closed) return Promise.resolve(this.manifestFailure("trace runtime is closed", "closed"));
    return this.enqueue(
      () => this.ready.then(async () => {
        const index = await this.persistLinkIndex();
        if (!index.ok) return this.manifestFailure(index.error, index.kind);
        return this.persistManifest();
      }),
      () => this.manifestFailure("trace write queue is full", "queue-full"),
    );
  }

  writeAttempt(input: TraceAttemptInput | TraceAttempt): Promise<TraceWriteOutcome> {
    let record: FrozenTraceAttempt;
    try {
      record = createAttemptRecord(input as TraceAttemptInput);
    } catch (error) {
      return Promise.resolve(this.invalidOutcome(stableError(error)));
    }
    if (this.closed) return Promise.resolve(this.closedOutcome(record));
    return this.enqueue(
      () => this.ready.then(() => this.writeRecord(record)),
      () => this.queueFailure(record),
    );
  }

  writeTaskSettled(input: TraceTaskSettledInput | TraceTaskSettled): Promise<TraceWriteOutcome> {
    let record: FrozenTraceTaskSettled;
    try {
      record = createTaskSettledRecord(input as TraceTaskSettledInput);
    } catch (error) {
      return Promise.resolve(this.invalidOutcome(stableError(error)));
    }
    if (this.closed) return Promise.resolve(this.closedOutcome(record));
    return this.enqueue(
      () => this.ready.then(() => this.writeRecord(record)),
      () => this.queueFailure(record),
    );
  }

  close(): Promise<TraceManifestOutcome> {
    if (this.closePromise !== null) return this.closePromise;
    this.closed = true;
    const closeRun = this.queueTail.then(async () => {
      await this.ready;
      let result: TraceManifestOutcome;
      if (this.initialized) {
        const index = await this.persistLinkIndex();
        result = index.ok ? await this.persistManifest() : this.manifestFailure(index.error, index.kind);
      } else {
        result = this.manifestFailure(this.startupResult?.error ?? "trace runtime is not initialized", "closed");
      }
      await this.releaseLock();
      this.initialized = false;
      return result;
    }, async (error) => {
      await this.ready;
      await this.releaseLock();
      this.initialized = false;
      return this.manifestFailure(stableError(error), "closed");
    });
    this.queueTail = closeRun.then(() => undefined, () => undefined);
    this.closePromise = closeRun;
    return closeRun;
  }

  private initialize(reset: boolean, maxScanFiles: number): Promise<TraceStartupResult> {
    return this.initializeAsync(reset, maxScanFiles);
  }

  private async initializeAsync(reset: boolean, maxScanFiles: number): Promise<TraceStartupResult> {
    const scanLimit = Number.isSafeInteger(maxScanFiles) && maxScanFiles > 0 ? maxScanFiles : DEFAULT_TRACE_MAX_SCAN_FILES;
    const resetState = {
      requested: reset,
      applied: false,
      omittedRecords: 0,
      failedRecords: 0,
    };
    let existing = emptyExistingScan();
    let startupError: string | null = null;
    let priorManifest: TraceManifest | null = null;
    let priorManifestError: string | null = null;
    let priorIndex: TraceLinkIndex | null = null;
    let priorIndexError: string | null = null;
    let existingLinkErrors = 0;
    let lockAcquired = false;
    try {
      try {
        const info = await stat(this.directory);
        if (!info.isDirectory()) throw new Error("trace directory path is not a directory");
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
      }
      const lock = await this.acquireLock();
      if (!lock.ok) throw new Error(lock.error);
      lockAcquired = true;
      const previous = await this.readPreviousManifest();
      priorManifest = previous.manifest;
      priorManifestError = previous.error;
      const previousIndex = await this.readPreviousIndex();
      priorIndex = previousIndex.index;
      priorIndexError = previousIndex.error;
      this.linkIndexWriteFailures = priorManifest?.indexWriteFailures ?? 0;
      existing = await inspectExisting(this.directory, scanLimit, this.maxRecordBytes);
      this.loadLinkIndex(priorIndex, reset);
      this.linkIndexError = priorIndexError;
      if (!reset && priorIndex === null && priorManifestError === null && (priorManifest?.omittedRecords ?? 0) === 0 && existing.scanOmittedRecords === 0) {
        this.linkIndexComplete = true;
      }
      if (existing.scanOmittedRecords > 0) this.linkIndexComplete = false;
      this.reconcileIndexWithFiles(existing);
      let maxTurn = existing.maxTurn;
      if (reset) {
        let failed = 0;
        for (const name of existing.names) {
          try {
            await unlink(join(this.directory, name));
            resetState.omittedRecords++;
          } catch {
            failed++;
          }
        }
        resetState.failedRecords = failed;
        resetState.applied = failed === 0;
        const remaining = await newestTurnFiles(this.directory);
        maxTurn = remaining.at(-1)?.turn ?? 0;
        if (failed > 0) startupError = `trace reset failed for ${failed} file(s)`;
      }
      this.nextTraceTurn = maxTurn + 1;
      existingLinkErrors = this.loadExistingLinks(existing, reset);
      const retainedBeforeRetention = await countTurnFiles(this.directory);
      const priorGap = priorManifest === null
        ? 0
        : Math.max(0, priorManifest.lastTraceTurn - priorManifest.retainedRecords);
      const currentGap = Math.max(0, existing.maxTurn - retainedBeforeRetention);
      const inferredOmitted = reset ? 0 : Math.max(0, currentGap - priorGap);
      const previousOmitted = priorManifest?.omittedRecords ?? 0;
      const previousWriteFailures = priorManifest?.writeFailures ?? 0;
      const previousRetentionFailures = priorManifest?.retentionFailures ?? 0;
      const previousManifestFailures = priorManifest?.manifestWriteFailures ?? 0;
      const previousIndexFailures = priorManifest?.indexWriteFailures ?? 0;
      this.manifestValue = this.emptyManifest(resetState, startupError, {
        retainedRecords: retainedBeforeRetention,
        omittedRecords: previousOmitted + inferredOmitted + resetState.omittedRecords,
        writeFailures: previousWriteFailures,
        malformedRecords: existing.malformedRecords + existingLinkErrors,
        partialRecords: existing.partialRecords,
        scanOmittedRecords: existing.scanOmittedRecords,
        manifestErrors: (priorManifest?.manifestErrors ?? 0) + (priorManifestError === null ? 0 : 1),
        retentionFailures: previousRetentionFailures,
        manifestWriteFailures: previousManifestFailures,
        indexWriteFailures: previousIndexFailures,
        lastTraceTurn: Math.max(0, this.nextTraceTurn - 1),
        preexistingRecords: existing.names.length,
        preexistingMalformedRecords: existing.malformedRecords + existingLinkErrors,
        preexistingPartialRecords: existing.partialRecords,
        preexistingScanOmittedRecords: existing.scanOmittedRecords,
      });
      this.initialized = true;
      const indexResult = await this.persistLinkIndex();
      if (!indexResult.ok) startupError ??= indexResult.error;
      if (indexResult.ok) {
        const retention = await this.applyRetention();
        if (!retention.ok) startupError ??= retention.error;
        const retainedIndex = await this.persistLinkIndex();
        if (!retainedIndex.ok) startupError ??= retainedIndex.error;
      }
      const manifestResult = await this.persistManifest();
      if (!manifestResult.ok) startupError ??= manifestResult.error;
    } catch (error) {
      startupError = stableError(error);
      this.manifestValue = this.emptyManifest(resetState, startupError, {
        retainedRecords: 0,
        omittedRecords: resetState.omittedRecords,
        writeFailures: 1,
        malformedRecords: existing.malformedRecords + existingLinkErrors,
        partialRecords: existing.partialRecords,
        scanOmittedRecords: existing.scanOmittedRecords,
        manifestErrors: (priorManifest?.manifestErrors ?? 0) + (priorManifestError === null ? 0 : 1),
        retentionFailures: 0,
        manifestWriteFailures: 1,
        indexWriteFailures: priorManifest?.indexWriteFailures ?? 0,
        lastTraceTurn: 0,
        preexistingRecords: existing.names.length,
        preexistingMalformedRecords: existing.malformedRecords + existingLinkErrors,
        preexistingPartialRecords: existing.partialRecords,
        preexistingScanOmittedRecords: existing.scanOmittedRecords,
      });
    }
    if (startupError !== null) {
      this.initialized = false;
      if (lockAcquired) await this.releaseLock();
    }
    const startup = {
      ok: startupError === null,
      directory: this.directory,
      namespace: this.namespace,
      reset: resetState,
      malformedRecords: existing.malformedRecords + existingLinkErrors,
      partialRecords: existing.partialRecords,
      scanOmittedRecords: existing.scanOmittedRecords,
      manifestErrors: (priorManifest?.manifestErrors ?? 0) + (priorManifestError === null ? 0 : 1),
      retainedRecords: await countTurnFiles(this.directory),
      error: startupError,
    };
    this.startupResult = freezeDeep(startup);
    return this.startupResult;
  }

  private async readPreviousManifest(): Promise<{ manifest: TraceManifest | null; error: string | null }> {
    try {
      const info = await stat(this.manifestPath);
      if (!info.isFile()) return { manifest: null, error: "trace manifest path is not a file" };
      if (info.size > MAX_TRACE_MANIFEST_BYTES) return { manifest: null, error: `trace manifest exceeds ${MAX_TRACE_MANIFEST_BYTES} bytes` };
      const value = JSON.parse(await readFile(this.manifestPath, "utf8")) as unknown;
      return validPriorManifest(value)
        ? { manifest: value, error: null }
        : { manifest: null, error: "trace manifest failed schema validation" };
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { manifest: null, error: null };
      return { manifest: null, error: stableError(error) };
    }
  }

  private emptyManifest(
    reset: TraceManifestReset,
    error: string | null,
    values: Partial<Pick<TraceManifest, "retainedRecords" | "omittedRecords" | "writeFailures" | "malformedRecords" | "partialRecords" | "scanOmittedRecords" | "manifestErrors" | "retentionFailures" | "manifestWriteFailures" | "indexWriteFailures" | "lastTraceTurn">> & {
      preexistingRecords?: number;
      preexistingMalformedRecords?: number;
      preexistingPartialRecords?: number;
      preexistingScanOmittedRecords?: number;
    } = {},
  ): TraceManifest {
    const now = timestamp(this.now);
    return freezeDeep({
      schemaVersion: TRACE_SCHEMA_VERSION,
      kind: "trace-manifest",
      startup: {
        namespace: this.namespace,
        startedAt: now,
        reset,
        preexistingRecords: values.preexistingRecords ?? values.retainedRecords ?? 0,
        preexistingMalformedRecords: values.preexistingMalformedRecords ?? values.malformedRecords ?? 0,
        preexistingPartialRecords: values.preexistingPartialRecords ?? values.partialRecords ?? 0,
        preexistingScanOmittedRecords: values.preexistingScanOmittedRecords ?? values.scanOmittedRecords ?? 0,
        error,
      },
      retainedRecords: values.retainedRecords ?? 0,
      omittedRecords: values.omittedRecords ?? 0,
      writeFailures: values.writeFailures ?? 0,
      malformedRecords: values.malformedRecords ?? 0,
      partialRecords: values.partialRecords ?? 0,
      scanOmittedRecords: values.scanOmittedRecords ?? 0,
      manifestErrors: values.manifestErrors ?? 0,
      retentionFailures: values.retentionFailures ?? 0,
      manifestWriteFailures: values.manifestWriteFailures ?? 0,
      indexWriteFailures: values.indexWriteFailures ?? 0,
      lastTraceTurn: values.lastTraceTurn ?? 0,
      linkIndex: {
        ...emptyManifestLinkIndex(this.indexPath),
        complete: this.linkIndexComplete,
        attempts: this.attempts.size,
        settlements: this.settlements.size,
        unknown: this.countUnknownLinks(),
        writeFailures: this.linkIndexWriteFailures,
        error: this.linkIndexError,
      },
      updatedAt: now,
    });
  }

  private async acquireLock(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const handle = await openFile(this.lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token: this.lockToken, startedAt: timestamp(this.now) }), { encoding: "utf8" });
        await handle.sync();
        await syncDirectoryAsync(this.directory);
        this.lockHandle = handle;
        return { ok: true };
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(this.lockPath).catch(() => undefined);
        await syncDirectoryAsync(this.directory).catch(() => undefined);
        return { ok: false, error: stableError(error) };
      }
    } catch (error) {
      if (errorCode(error) !== "EEXIST") return { ok: false, error: stableError(error) };
      let lockOwner: unknown = null;
      try {
        lockOwner = JSON.parse(await readFile(this.lockPath, "utf8")) as unknown;
      } catch {
        return { ok: false, error: "trace directory is already locked" };
      }
      const ownerPid = isRecord(lockOwner) && nonnegativeCounter(lockOwner.pid) && lockOwner.pid > 0 ? lockOwner.pid : null;
      if (ownerPid === null || ownerPid === process.pid || processAlive(ownerPid)) {
        return { ok: false, error: "trace directory is already locked" };
      }
      try {
        await unlink(this.lockPath);
        await syncDirectoryAsync(this.directory);
      } catch {
        return { ok: false, error: "trace directory is already locked" };
      }
      try {
        const handle = await openFile(this.lockPath, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, token: this.lockToken, startedAt: timestamp(this.now) }), { encoding: "utf8" });
          await handle.sync();
          await syncDirectoryAsync(this.directory);
          this.lockHandle = handle;
          return { ok: true };
        } catch (retryError) {
          await handle.close().catch(() => undefined);
          await unlink(this.lockPath).catch(() => undefined);
          await syncDirectoryAsync(this.directory).catch(() => undefined);
          return { ok: false, error: stableError(retryError) };
        }
      } catch (retryError) {
        return { ok: false, error: errorCode(retryError) === "EEXIST" ? "trace directory is already locked" : stableError(retryError) };
      }
    }
  }

  private async releaseLock(): Promise<void> {
    const handle = this.lockHandle;
    if (handle === null) return;
    this.lockHandle = null;
    let ownsPath = false;
    try {
      const owner = JSON.parse(await readFile(this.lockPath, "utf8")) as unknown;
      ownsPath = isRecord(owner) && owner.token === this.lockToken;
    } catch {
      /* The path may already have been removed; closing our handle is enough. */
    }
    if (ownsPath) await unlink(this.lockPath).catch(() => undefined);
    await handle.close().catch(() => undefined);
    await syncDirectoryAsync(this.directory).catch(() => undefined);
  }

  private countUnknownLinks(): number {
    let count = 0;
    for (const attempt of this.attempts.values()) if (attempt.unknown) count++;
    for (const settlement of this.settlements.values()) if (settlement.unknown) count++;
    return count;
  }

  private buildLinkIndex(updatedAt = timestamp(this.now)): TraceLinkIndex {
    return this.buildLinkIndexFrom(this.attempts.values(), this.settlements.values(), updatedAt);
  }

  private buildLinkIndexFrom(
    attemptEntries: Iterable<TraceAttemptIndexEntry>,
    settlementEntries: Iterable<TraceSettlementIndexEntry>,
    updatedAt = timestamp(this.now),
  ): TraceLinkIndex {
    const attempts = [...attemptEntries]
      .sort((left, right) => compositeKey(left.runId, left.attemptId).localeCompare(compositeKey(right.runId, right.attemptId)))
      .map((attempt) => ({
        runId: attempt.runId,
        taskId: attempt.taskId,
        attemptId: attempt.attemptId,
        role: attempt.role,
        retained: attempt.retained,
        traceTurn: attempt.traceTurn,
        unknown: attempt.unknown,
      }));
    const settlements = [...settlementEntries]
      .sort((left, right) => taskKey(left.runId, left.taskId).localeCompare(taskKey(right.runId, right.taskId)))
      .map((settlement) => ({
        runId: settlement.runId,
        taskId: settlement.taskId,
        attemptIds: settlement.attemptIds.slice(),
        summaryAttemptIds: settlement.summaryAttemptIds.slice(),
        finalAttemptId: settlement.finalAttemptId,
        retained: settlement.retained,
        traceTurn: settlement.traceTurn,
        unknown: settlement.unknown,
      }));
    return freezeDeep({
      schemaVersion: TRACE_SCHEMA_VERSION,
      kind: "trace-link-index",
      complete: this.linkIndexComplete,
      updatedAt,
      attempts,
      settlements,
    });
  }

  private prospectiveLinkIndex(record: FrozenTraceAttempt | FrozenTraceTaskSettled, updatedAt = timestamp(this.now)): TraceLinkIndex {
    const attempts = new Map<string, TraceAttemptIndexEntry>();
    const settlements = new Map<string, TraceSettlementIndexEntry>();
    for (const attempt of this.attempts.values()) attempts.set(compositeKey(attempt.runId, attempt.attemptId), { ...attempt });
    for (const settlement of this.settlements.values()) settlements.set(taskKey(settlement.runId, settlement.taskId), {
      ...settlement,
      attemptIds: settlement.attemptIds.slice(),
      summaryAttemptIds: settlement.summaryAttemptIds.slice(),
    });
    if (record.recordType === "attempt") {
      attempts.set(compositeKey(record.runId, record.attemptId), {
        runId: record.runId,
        taskId: record.taskId,
        attemptId: record.attemptId,
        role: record.role,
        retained: true,
        traceTurn: this.nextTraceTurn,
        unknown: false,
      });
      if (this.linkIndexComplete === false) {
        for (const parentId of [record.parentAttemptId, record.retryOfAttemptId]) {
          if (parentId === null) continue;
          const key = compositeKey(record.runId, parentId);
          if (!attempts.has(key)) attempts.set(key, {
            runId: record.runId,
            taskId: record.taskId,
            attemptId: parentId,
            role: "main",
            retained: false,
            traceTurn: null,
            unknown: true,
          });
        }
      }
    } else {
      for (const attemptId of record.attemptIds) {
        const key = compositeKey(record.runId, attemptId);
        if (!attempts.has(key)) attempts.set(key, {
          runId: record.runId,
          taskId: record.taskId,
          attemptId,
          role: "main",
          retained: false,
          traceTurn: null,
          unknown: true,
        });
      }
      for (const attemptId of record.summaryAttemptIds) {
        const key = compositeKey(record.runId, attemptId);
        const current = attempts.get(key);
        if (current === undefined) {
          attempts.set(key, {
            runId: record.runId,
            taskId: record.taskId,
            attemptId,
            role: "summary",
            retained: false,
            traceTurn: null,
            unknown: true,
          });
        } else if (current.unknown) {
          attempts.set(key, { ...current, role: "summary" });
        }
      }
      const unknown = record.attemptIds.some((attemptId) => attempts.get(compositeKey(record.runId, attemptId))?.unknown === true) ||
        record.summaryAttemptIds.some((attemptId) => attempts.get(compositeKey(record.runId, attemptId))?.unknown === true);
      settlements.set(taskKey(record.runId, record.taskId), {
        runId: record.runId,
        taskId: record.taskId,
        attemptIds: record.attemptIds.slice(),
        summaryAttemptIds: record.summaryAttemptIds.slice(),
        finalAttemptId: record.finalAttemptId,
        retained: true,
        traceTurn: this.nextTraceTurn,
        unknown,
      });
    }
    return this.buildLinkIndexFrom(attempts.values(), settlements.values(), updatedAt);
  }

  private async readPreviousIndex(): Promise<{ index: TraceLinkIndex | null; error: string | null }> {
    try {
      const info = await stat(this.indexPath);
      if (!info.isFile()) return { index: null, error: "trace link index path is not a file" };
      if (info.size > MAX_TRACE_INDEX_BYTES) return { index: null, error: `trace link index exceeds ${MAX_TRACE_INDEX_BYTES} bytes` };
      const value = JSON.parse(await readFile(this.indexPath, "utf8")) as unknown;
      return validTraceLinkIndex(value)
        ? { index: value, error: null }
        : { index: null, error: "trace link index failed schema validation" };
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { index: null, error: null };
      return { index: null, error: stableError(error) };
    }
  }

  private loadLinkIndex(index: TraceLinkIndex | null, reset: boolean): void {
    this.attempts.clear();
    this.settlements.clear();
    this.recordsByTurn.clear();
    this.linkIndexComplete = reset || index?.complete === true;
    this.linkIndexError = null;
    if (reset || index === null) return;
    for (const item of index.attempts) {
      const key = compositeKey(item.runId, item.attemptId);
      this.attempts.set(key, {
        runId: item.runId,
        taskId: item.taskId,
        attemptId: item.attemptId,
        role: item.role,
        retained: item.retained,
        traceTurn: item.traceTurn,
        unknown: item.unknown,
      });
      if (item.retained && item.traceTurn !== null) this.recordsByTurn.set(item.traceTurn, { attemptKey: key });
    }
    for (const item of index.settlements) {
      const key = taskKey(item.runId, item.taskId);
      this.settlements.set(key, {
        runId: item.runId,
        taskId: item.taskId,
        attemptIds: item.attemptIds.slice(),
        summaryAttemptIds: item.summaryAttemptIds.slice(),
        finalAttemptId: item.finalAttemptId,
        retained: item.retained,
        traceTurn: item.traceTurn,
        unknown: item.unknown,
      });
      if (item.retained && item.traceTurn !== null) this.recordsByTurn.set(item.traceTurn, { settlementKey: key });
    }
  }

  private reconcileIndexWithFiles(existing: ExistingScan): void {
    const retainedTurns = new Set(existing.names.map((name) => traceTurnFromName(name)).filter((turn): turn is number => turn !== null));
    for (const attempt of this.attempts.values()) {
      if (attempt.retained && attempt.traceTurn !== null && !retainedTurns.has(attempt.traceTurn)) {
        attempt.retained = false;
        this.recordsByTurn.delete(attempt.traceTurn);
      }
    }
    for (const settlement of this.settlements.values()) {
      if (settlement.retained && settlement.traceTurn !== null && !retainedTurns.has(settlement.traceTurn)) {
        settlement.retained = false;
        this.recordsByTurn.delete(settlement.traceTurn);
      }
    }
  }

  private ensureUnknownAttempt(runId: string, taskId: string, attemptId: string, role: TraceRole): boolean {
    const key = compositeKey(runId, attemptId);
    const current = this.attempts.get(key);
    if (current !== undefined) {
      if (current.taskId !== taskId) return false;
      if (current.unknown) current.role = role;
      return current.role === role || current.unknown;
    }
    this.attempts.set(key, {
      runId,
      taskId,
      attemptId,
      role,
      retained: false,
      traceTurn: null,
      unknown: true,
    });
    return true;
  }

  private loadExistingLinks(existing: ExistingScan, reset: boolean): number {
    if (reset) {
      this.attempts.clear();
      this.settlements.clear();
      this.recordsByTurn.clear();
      this.linkIndexComplete = true;
      this.linkIndexError = null;
      return 0;
    }
    let errors = 0;
    for (const attempt of existing.attempts) {
      const key = compositeKey(attempt.runId, attempt.attemptId);
      const current = this.attempts.get(key);
      if (current !== undefined) {
        if (current.taskId !== attempt.taskId || current.role !== attempt.role ||
          (!current.unknown && !current.retained) ||
          (!current.unknown && current.retained && current.traceTurn !== null && current.traceTurn !== attempt.turn)) {
          errors++;
          continue;
        }
        if (current.traceTurn !== null && current.traceTurn !== attempt.turn) this.recordsByTurn.delete(current.traceTurn);
        current.retained = true;
        current.traceTurn = attempt.turn;
        current.unknown = false;
      } else {
        this.attempts.set(key, {
          runId: attempt.runId,
          taskId: attempt.taskId,
          attemptId: attempt.attemptId,
          role: attempt.role,
          retained: true,
          traceTurn: attempt.turn,
          unknown: false,
        });
      }
      this.recordsByTurn.set(attempt.turn, { attemptKey: key });
    }
    for (const attempt of existing.attempts) {
      const current = this.attempts.get(compositeKey(attempt.runId, attempt.attemptId));
      if (!current) continue;
      for (const parentId of [attempt.parentAttemptId, attempt.retryOfAttemptId]) {
        if (parentId === null) continue;
        const parent = this.attempts.get(compositeKey(attempt.runId, parentId));
        if (parent === undefined && this.linkIndexComplete === false) {
          if (!this.ensureUnknownAttempt(attempt.runId, attempt.taskId, parentId, "main")) errors++;
        } else if (!parent || parent.taskId !== attempt.taskId) {
          errors++;
        }
      }
    }
    for (const settlement of existing.settlements) {
      const key = taskKey(settlement.runId, settlement.taskId);
      const current = this.settlements.get(key);
      if (current !== undefined) {
        if ((!current.unknown && !current.retained) ||
          (!current.unknown && current.retained && current.traceTurn !== null && current.traceTurn !== settlement.turn)) {
          errors++;
          continue;
        }
        if (current.traceTurn !== null && current.traceTurn !== settlement.turn) this.recordsByTurn.delete(current.traceTurn);
      }
      let valid = true;
      let unknown = false;
      const ids = new Set<string>();
      for (const idValue of settlement.attemptIds) {
        if (ids.has(idValue)) valid = false;
        ids.add(idValue);
        let attempt = this.attempts.get(compositeKey(settlement.runId, idValue));
        if (!attempt && this.linkIndexComplete === false) {
          if (this.ensureUnknownAttempt(settlement.runId, settlement.taskId, idValue, "main")) {
            attempt = this.attempts.get(compositeKey(settlement.runId, idValue));
            unknown = true;
          } else valid = false;
        }
        if (!attempt || attempt.taskId !== settlement.taskId) valid = false;
        if (attempt?.unknown) unknown = true;
      }
      for (const idValue of settlement.summaryAttemptIds) {
        if (!ids.has(idValue)) valid = false;
        let attempt = this.attempts.get(compositeKey(settlement.runId, idValue));
        if (!attempt && this.linkIndexComplete === false) {
          if (this.ensureUnknownAttempt(settlement.runId, settlement.taskId, idValue, "summary")) {
            attempt = this.attempts.get(compositeKey(settlement.runId, idValue));
            unknown = true;
          } else valid = false;
        }
        if (!attempt || attempt.taskId !== settlement.taskId || attempt.role !== "summary") valid = false;
        if (attempt?.unknown) unknown = true;
      }
      if (settlement.finalAttemptId !== null) {
        if (!ids.has(settlement.finalAttemptId)) valid = false;
        const finalAttempt = this.attempts.get(compositeKey(settlement.runId, settlement.finalAttemptId));
        if (finalAttempt?.unknown) unknown = true;
      }
      if (!valid) errors++;
      this.settlements.set(key, {
        runId: settlement.runId,
        taskId: settlement.taskId,
        attemptIds: settlement.attemptIds.slice(),
        summaryAttemptIds: settlement.summaryAttemptIds.slice(),
        finalAttemptId: settlement.finalAttemptId,
        retained: true,
        traceTurn: settlement.turn,
        unknown,
      });
      this.recordsByTurn.set(settlement.turn, { settlementKey: key });
    }
    return errors;
  }

  private refreshManifestLinkIndex(error: string | null = this.linkIndexError): void {
    this.manifestValue = freezeDeep({
      ...this.manifestValue,
      linkIndex: {
        path: this.indexPath,
        complete: this.linkIndexComplete,
        attempts: this.attempts.size,
        settlements: this.settlements.size,
        unknown: this.countUnknownLinks(),
        writeFailures: this.linkIndexWriteFailures,
        error,
      },
      updatedAt: timestamp(this.now),
    });
  }

  private attemptIndexEntry(attempt: TraceAttemptIndexEntry): TraceAttemptIndexEntry {
    return {
      runId: attempt.runId,
      taskId: attempt.taskId,
      attemptId: attempt.attemptId,
      role: attempt.role,
      retained: attempt.retained,
      traceTurn: attempt.traceTurn,
      unknown: attempt.unknown,
    };
  }

  private settlementIndexEntry(settlement: TraceSettlementIndexEntry): TraceSettlementIndexEntry {
    return {
      runId: settlement.runId,
      taskId: settlement.taskId,
      attemptIds: settlement.attemptIds.slice(),
      summaryAttemptIds: settlement.summaryAttemptIds.slice(),
      finalAttemptId: settlement.finalAttemptId,
      retained: settlement.retained,
      traceTurn: settlement.traceTurn,
      unknown: settlement.unknown,
    };
  }

  private reservationPlan(record: FrozenTraceAttempt | FrozenTraceTaskSettled | null): {
    attemptUpdates: Map<string, TraceAttemptIndexEntry>;
    settlementUpdates: Map<string, TraceSettlementIndexEntry>;
    protectedTasks: Set<string>;
  } {
    const attemptUpdates = new Map<string, TraceAttemptIndexEntry>();
    const settlementUpdates = new Map<string, TraceSettlementIndexEntry>();
    const protectedTasks = new Set<string>();
    if (record === null) return { attemptUpdates, settlementUpdates, protectedTasks };
    protectedTasks.add(taskKey(record.runId, record.taskId));
    const protectKnownAttempt = (attemptId: string): void => {
      const existing = this.attempts.get(compositeKey(record.runId, attemptId));
      if (existing !== undefined) protectedTasks.add(taskKey(existing.runId, existing.taskId));
    };
    if (record.recordType === "attempt") {
      const key = compositeKey(record.runId, record.attemptId);
      attemptUpdates.set(key, {
        runId: record.runId,
        taskId: record.taskId,
        attemptId: record.attemptId,
        role: record.role,
        retained: true,
        traceTurn: this.nextTraceTurn,
        unknown: false,
      });
      for (const parentId of [record.parentAttemptId, record.retryOfAttemptId]) {
        if (parentId === null) continue;
        protectKnownAttempt(parentId);
        const parentKey = compositeKey(record.runId, parentId);
        if (this.linkIndexComplete === false && !this.attempts.has(parentKey)) attemptUpdates.set(parentKey, {
          runId: record.runId,
          taskId: record.taskId,
          attemptId: parentId,
          role: "main",
          retained: false,
          traceTurn: null,
          unknown: true,
        });
      }
    } else {
      for (const attemptId of record.attemptIds) {
        protectKnownAttempt(attemptId);
        const key = compositeKey(record.runId, attemptId);
        if (!this.attempts.has(key)) attemptUpdates.set(key, {
          runId: record.runId,
          taskId: record.taskId,
          attemptId,
          role: "main",
          retained: false,
          traceTurn: null,
          unknown: true,
        });
      }
      for (const attemptId of record.summaryAttemptIds) {
        protectKnownAttempt(attemptId);
        const key = compositeKey(record.runId, attemptId);
        const current = attemptUpdates.get(key) ?? this.attempts.get(key);
        if (current === undefined) {
          attemptUpdates.set(key, {
            runId: record.runId,
            taskId: record.taskId,
            attemptId,
            role: "summary",
            retained: false,
            traceTurn: null,
            unknown: true,
          });
        } else if (current.unknown) {
          attemptUpdates.set(key, { ...current, role: "summary" });
        }
      }
      const unknown = record.attemptIds.some((attemptId) => attemptUpdates.get(compositeKey(record.runId, attemptId))?.unknown === true ||
        this.attempts.get(compositeKey(record.runId, attemptId))?.unknown === true) ||
        record.summaryAttemptIds.some((attemptId) => attemptUpdates.get(compositeKey(record.runId, attemptId))?.unknown === true ||
          this.attempts.get(compositeKey(record.runId, attemptId))?.unknown === true);
      settlementUpdates.set(taskKey(record.runId, record.taskId), {
        runId: record.runId,
        taskId: record.taskId,
        attemptIds: record.attemptIds.slice(),
        summaryAttemptIds: record.summaryAttemptIds.slice(),
        finalAttemptId: record.finalAttemptId,
        retained: true,
        traceTurn: this.nextTraceTurn,
        unknown,
      });
    }
    return { attemptUpdates, settlementUpdates, protectedTasks };
  }

  private indexSummary(plan: ReturnType<TraceRuntime["reservationPlan"]>, updatedAt: string): {
    attempts: number;
    settlements: number;
    attemptBytes: number;
    settlementBytes: number;
    bytes: number;
  } {
    let attempts = 0;
    let settlements = 0;
    let attemptBytes = 0;
    let settlementBytes = 0;
    for (const [key, attempt] of this.attempts) {
      attempts++;
      attemptBytes += Buffer.byteLength(JSON.stringify(plan.attemptUpdates.get(key) ?? this.attemptIndexEntry(attempt)), "utf8");
    }
    for (const [key, attempt] of plan.attemptUpdates) {
      if (this.attempts.has(key)) continue;
      attempts++;
      attemptBytes += Buffer.byteLength(JSON.stringify(attempt), "utf8");
    }
    for (const [key, settlement] of this.settlements) {
      settlements++;
      settlementBytes += Buffer.byteLength(JSON.stringify(plan.settlementUpdates.get(key) ?? this.settlementIndexEntry(settlement)), "utf8");
    }
    for (const [key, settlement] of plan.settlementUpdates) {
      if (this.settlements.has(key)) continue;
      settlements++;
      settlementBytes += Buffer.byteLength(JSON.stringify(settlement), "utf8");
    }
    const emptyIndexBytes = Buffer.byteLength(JSON.stringify({
      schemaVersion: TRACE_SCHEMA_VERSION,
      kind: "trace-link-index",
      complete: this.linkIndexComplete,
      updatedAt,
      attempts: [],
      settlements: [],
    }), "utf8");
    return {
      attempts,
      settlements,
      attemptBytes,
      settlementBytes,
      bytes: emptyIndexBytes + attemptBytes + settlementBytes + Math.max(0, attempts - 1) + Math.max(0, settlements - 1),
    };
  }

  private compactionCandidates(protectedTasks: ReadonlySet<string>): Array<{
    key: string;
    attempts: TraceAttemptIndexEntry[];
    settlement: TraceSettlementIndexEntry;
    attemptBytes: number;
    settlementBytes: number;
    oldestTurn: number;
  }> {
    const groups = new Map<string, {
      attempts: TraceAttemptIndexEntry[];
      attemptIds: Set<string>;
      settlement: TraceSettlementIndexEntry | null;
      attemptBytes: number;
      settlementBytes: number;
      oldestTurn: number;
    }>();
    const groupFor = (runId: string, taskId: string) => {
      const key = taskKey(runId, taskId);
      let group = groups.get(key);
      if (group === undefined) {
        group = { attempts: [], attemptIds: new Set(), settlement: null, attemptBytes: 0, settlementBytes: 0, oldestTurn: Number.MAX_SAFE_INTEGER };
        groups.set(key, group);
      }
      return { key, group };
    };
    for (const attempt of this.attempts.values()) {
      const { group } = groupFor(attempt.runId, attempt.taskId);
      const entry = this.attemptIndexEntry(attempt);
      group.attempts.push(entry);
      group.attemptIds.add(entry.attemptId);
      group.attemptBytes += Buffer.byteLength(JSON.stringify(entry), "utf8");
      group.oldestTurn = Math.min(group.oldestTurn, entry.traceTurn ?? Number.MAX_SAFE_INTEGER);
    }
    for (const settlement of this.settlements.values()) {
      const { group } = groupFor(settlement.runId, settlement.taskId);
      const entry = this.settlementIndexEntry(settlement);
      group.settlement = entry;
      group.settlementBytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
      group.oldestTurn = Math.min(group.oldestTurn, entry.traceTurn ?? Number.MAX_SAFE_INTEGER);
    }
    return [...groups].flatMap(([key, group]) => {
      const settlement = group.settlement;
      if (settlement === null || protectedTasks.has(key) || settlement.retained || settlement.unknown ||
        !settlement.attemptIds.every((attemptId) => group.attemptIds.has(attemptId)) ||
        !settlement.summaryAttemptIds.every((attemptId) => group.attemptIds.has(attemptId)) ||
        !group.attempts.every((attempt) => !attempt.retained && !attempt.unknown)) return [];
      return [{ key, attempts: group.attempts, settlement, attemptBytes: group.attemptBytes, settlementBytes: group.settlementBytes, oldestTurn: group.oldestTurn }];
    }).sort((left, right) => left.oldestTurn - right.oldestTurn || left.key.localeCompare(right.key));
  }

  private removeCandidateFromSummary(
    summary: { attempts: number; settlements: number; attemptBytes: number; settlementBytes: number; bytes: number },
    candidate: { attempts: TraceAttemptIndexEntry[]; attemptBytes: number; settlementBytes: number },
  ): void {
    const attemptCommas = Math.max(0, summary.attempts - 1) - Math.max(0, summary.attempts - candidate.attempts.length - 1);
    const settlementCommas = Math.max(0, summary.settlements - 1) - Math.max(0, summary.settlements - 2);
    summary.attempts -= candidate.attempts.length;
    summary.settlements--;
    summary.attemptBytes -= candidate.attemptBytes;
    summary.settlementBytes -= candidate.settlementBytes;
    summary.bytes -= candidate.attemptBytes + candidate.settlementBytes + attemptCommas + settlementCommas;
  }

  private summaryExceedsCapacity(summary: { attempts: number; settlements: number; bytes: number }): boolean {
    return summary.attempts + summary.settlements > MAX_TRACE_INDEX_ENTRIES || summary.bytes > MAX_TRACE_INDEX_BYTES;
  }

  private summaryCapacityError(summary: { attempts: number; settlements: number; bytes: number }): string {
    return summary.attempts + summary.settlements > MAX_TRACE_INDEX_ENTRIES
      ? `trace link index exceeds ${MAX_TRACE_INDEX_ENTRIES} entries`
      : `trace link index exceeds ${MAX_TRACE_INDEX_BYTES} bytes`;
  }

  private indexCapacityError(index: TraceLinkIndex): string | null {
    if (index.attempts.length + index.settlements.length > MAX_TRACE_INDEX_ENTRIES) {
      return `trace link index exceeds ${MAX_TRACE_INDEX_ENTRIES} entries`;
    }
    if (Buffer.byteLength(JSON.stringify(index), "utf8") > MAX_TRACE_INDEX_BYTES) {
      return `trace link index exceeds ${MAX_TRACE_INDEX_BYTES} bytes`;
    }
    return null;
  }

  private reserveLinkIndexCapacity(
    record: FrozenTraceAttempt | FrozenTraceTaskSettled | null,
    updatedAt: string,
  ): { ok: true } | { ok: false; error: string } {
    const plan = this.reservationPlan(record);
    const summary = this.indexSummary(plan, updatedAt);
    if (!this.summaryExceedsCapacity(summary)) return { ok: true };
    const initialError = this.summaryCapacityError(summary);
    const candidates = this.compactionCandidates(plan.protectedTasks);
    const selected: typeof candidates = [];
    for (const candidate of candidates) {
      if (selected.length === 0 && this.linkIndexComplete) summary.bytes++;
      this.removeCandidateFromSummary(summary, candidate);
      selected.push(candidate);
      if (!this.summaryExceedsCapacity(summary)) break;
    }
    if (this.summaryExceedsCapacity(summary)) return { ok: false, error: initialError };
    for (const candidate of selected) {
      for (const attempt of candidate.attempts) this.attempts.delete(compositeKey(attempt.runId, attempt.attemptId));
      this.settlements.delete(candidate.key);
    }
    this.linkIndexComplete = false;
    this.linkIndexError = null;
    const final = record === null ? this.buildLinkIndex(updatedAt) : this.prospectiveLinkIndex(record, updatedAt);
    const error = this.indexCapacityError(final);
    return error === null ? { ok: true } : { ok: false, error };
  }

  private async persistLinkIndex(updatedAt = timestamp(this.now)): Promise<{ ok: true } | { ok: false; kind: "index-write-failure" | "index-full"; error: string }> {
    const capacity = this.reserveLinkIndexCapacity(null, updatedAt);
    if (!capacity.ok) return { ...capacity, kind: "index-full" };
    if (!this.initialized && this.lockHandle === null) {
      return { ok: false, kind: "index-write-failure", error: "trace runtime is not initialized" };
    }
    let json: string;
    try {
      json = JSON.stringify(this.buildLinkIndex(updatedAt));
    } catch (error) {
      this.recordIndexFailure(stableError(error));
      return { ok: false, kind: "index-write-failure", error: stableError(error) };
    }
    if (Buffer.byteLength(json, "utf8") > MAX_TRACE_INDEX_BYTES) {
      this.linkIndexError = `trace link index exceeds ${MAX_TRACE_INDEX_BYTES} bytes`;
      this.refreshManifestLinkIndex(this.linkIndexError);
      return { ok: false, kind: "index-full", error: this.linkIndexError };
    }
    const result = await atomicWrite(this.indexPath, json);
    if (!result.ok) {
      this.recordIndexFailure(result.error);
      return { ok: false, kind: "index-write-failure", error: result.error };
    }
    this.linkIndexError = null;
    this.refreshManifestLinkIndex(null);
    return { ok: true };
  }

  private recordIndexFailure(error: string): void {
    this.linkIndexError = error;
    this.linkIndexWriteFailures++;
    this.manifestValue = freezeDeep({
      ...this.manifestValue,
      writeFailures: this.manifestValue.writeFailures + 1,
      indexWriteFailures: this.manifestValue.indexWriteFailures + 1,
      updatedAt: timestamp(this.now),
    });
    this.refreshManifestLinkIndex(error);
  }

  private enqueue<T>(work: () => Promise<T>, overflow: () => T): Promise<T> {
    if (this.queueLength >= this.maxQueueDepth) return Promise.resolve(overflow());
    this.queueLength++;
    const run = this.queueTail.then(work, work);
    this.queueTail = run.then(() => undefined, () => undefined);
    return run.finally(() => {
      this.queueLength--;
    });
  }

  private writeFailure(
    kind: TraceWriteFailureKind,
    error: string,
    record: FrozenTraceAttempt | FrozenTraceTaskSettled | null = null,
    path: string | null = null,
    traceTurn: number | null = null,
    persisted = false,
  ): TraceWriteFailure {
    return {
      ok: false,
      kind,
      retryable: retryableFailureKind(kind),
      persisted,
      path,
      traceTurn,
      record,
      error,
      omittedRecords: this.manifestValue.omittedRecords,
      retentionFailures: this.manifestValue.retentionFailures,
      manifest: this.manifest,
    };
  }

  private invalidOutcome(error: string): TraceWriteFailure {
    return this.writeFailure("invalid-record", error);
  }

  private queueFailure(record: FrozenTraceAttempt | FrozenTraceTaskSettled | null = null): TraceWriteFailure {
    return this.writeFailure("queue-full", "trace write queue is full", record);
  }

  private closedOutcome(record: FrozenTraceAttempt | FrozenTraceTaskSettled): TraceWriteFailure {
    return this.writeFailure("closed", "trace runtime is closed", record);
  }

  private manifestFailure(
    error: string,
    kind: "manifest-write-failure" | "index-write-failure" | "index-full" | "queue-full" | "closed" = "manifest-write-failure",
  ): TraceManifestOutcome {
    return { ok: false, kind, path: this.manifestPath, manifest: this.manifest, error };
  }

  private validateRecord(record: FrozenTraceAttempt | FrozenTraceTaskSettled): TraceWriteFailure | null {
    if (record.recordType === "attempt") {
      const key = compositeKey(record.runId, record.attemptId);
      const existingAttempt = this.attempts.get(key);
      if (existingAttempt !== undefined) {
        if (!existingAttempt.unknown || existingAttempt.taskId !== record.taskId || existingAttempt.role !== record.role) {
          return this.writeFailure("duplicate-attempt", `attemptId already exists: ${record.attemptId}`, record);
        }
      }
      for (const parentId of [record.parentAttemptId, record.retryOfAttemptId]) {
        if (parentId === null) continue;
        if (parentId === record.attemptId) {
          return this.writeFailure("invalid-link", `attempt cannot link to itself: ${parentId}`, record);
        }
        const parent = this.attempts.get(compositeKey(record.runId, parentId));
        if (!parent && this.linkIndexComplete === false) continue;
        if (!parent || parent.taskId !== record.taskId) {
          return this.writeFailure("invalid-link", `attempt link does not resolve: ${parentId}`, record);
        }
      }
      return null;
    }
    const key = taskKey(record.runId, record.taskId);
    if (this.settlements.has(key)) return this.writeFailure("duplicate-settlement", `task is already settled: ${record.taskId}`, record);
    const ids = new Set<string>();
    for (const attemptId of record.attemptIds) {
      if (ids.has(attemptId)) return this.writeFailure("invalid-link", `settlement repeats attemptId: ${attemptId}`, record);
      ids.add(attemptId);
      const attempt = this.attempts.get(compositeKey(record.runId, attemptId));
      if (!attempt && this.linkIndexComplete === false) continue;
      if (!attempt || attempt.taskId !== record.taskId) {
        return this.writeFailure("invalid-link", `settlement attempt does not resolve: ${attemptId}`, record);
      }
    }
    for (const summaryId of record.summaryAttemptIds) {
      const attempt = this.attempts.get(compositeKey(record.runId, summaryId));
      if (!ids.has(summaryId) || (!attempt && this.linkIndexComplete === true) ||
        (attempt !== undefined && attempt.role !== "summary" && !attempt.unknown)) {
        return this.writeFailure("invalid-link", `settlement summary does not resolve: ${summaryId}`, record);
      }
    }
    if (record.finalAttemptId !== null && !ids.has(record.finalAttemptId)) {
      return this.writeFailure("invalid-link", `settlement final attempt does not resolve: ${record.finalAttemptId}`, record);
    }
    if (record.attemptCount < record.attemptIds.length) {
      return this.writeFailure("invalid-link", "settlement attemptCount is smaller than attemptIds.length", record);
    }
    return null;
  }

  private registerRecord(record: FrozenTraceAttempt | FrozenTraceTaskSettled, traceTurn: number): void {
    if (record.recordType === "attempt") {
      const key = compositeKey(record.runId, record.attemptId);
      const current = this.attempts.get(key);
      if (current?.traceTurn !== null && current?.traceTurn !== undefined) this.recordsByTurn.delete(current.traceTurn);
      if (this.linkIndexComplete === false) {
        for (const parentId of [record.parentAttemptId, record.retryOfAttemptId]) {
          if (parentId !== null && !this.attempts.has(compositeKey(record.runId, parentId))) {
            this.ensureUnknownAttempt(record.runId, record.taskId, parentId, "main");
          }
        }
      }
      this.attempts.set(key, {
        runId: record.runId,
        taskId: record.taskId,
        attemptId: record.attemptId,
        role: record.role,
        retained: true,
        traceTurn,
        unknown: false,
      });
      this.recordsByTurn.set(traceTurn, { attemptKey: key });
    } else {
      const key = taskKey(record.runId, record.taskId);
      const unknownAttemptIds: string[] = [];
      for (const attemptId of record.attemptIds) {
        let attempt = this.attempts.get(compositeKey(record.runId, attemptId));
        if (!attempt && this.linkIndexComplete === false) {
          this.ensureUnknownAttempt(record.runId, record.taskId, attemptId, "main");
          attempt = this.attempts.get(compositeKey(record.runId, attemptId));
        }
        if (attempt?.unknown) unknownAttemptIds.push(attemptId);
      }
      for (const attemptId of record.summaryAttemptIds) {
        let attempt = this.attempts.get(compositeKey(record.runId, attemptId));
        if (!attempt && this.linkIndexComplete === false) {
          this.ensureUnknownAttempt(record.runId, record.taskId, attemptId, "summary");
          attempt = this.attempts.get(compositeKey(record.runId, attemptId));
        } else if (attempt?.unknown) {
          attempt.role = "summary";
        }
        if (attempt?.unknown) unknownAttemptIds.push(attemptId);
      }
      const current = this.settlements.get(key);
      if (current?.traceTurn !== null && current?.traceTurn !== undefined) this.recordsByTurn.delete(current.traceTurn);
      this.settlements.set(key, {
        runId: record.runId,
        taskId: record.taskId,
        attemptIds: record.attemptIds.slice(),
        summaryAttemptIds: record.summaryAttemptIds.slice(),
        finalAttemptId: record.finalAttemptId,
        retained: true,
        traceTurn,
        unknown: unknownAttemptIds.length > 0 || record.attemptIds.some((attemptId) => this.attempts.get(compositeKey(record.runId, attemptId))?.unknown === true),
      });
      this.recordsByTurn.set(traceTurn, { settlementKey: key });
    }
    this.manifestValue = freezeDeep({
      ...this.manifestValue,
      lastTraceTurn: Math.max(this.manifestValue.lastTraceTurn, traceTurn),
      updatedAt: timestamp(this.now),
    });
  }

  private markOmitted(traceTurn: number): void {
    const metadata = this.recordsByTurn.get(traceTurn);
    if (metadata?.attemptKey) {
      const attempt = this.attempts.get(metadata.attemptKey);
      if (attempt) attempt.retained = false;
    }
    if (metadata?.settlementKey) {
      const settlement = this.settlements.get(metadata.settlementKey);
      if (settlement) settlement.retained = false;
    }
    this.recordsByTurn.delete(traceTurn);
  }

  private async writeRecord(record: FrozenTraceAttempt | FrozenTraceTaskSettled): Promise<TraceWriteOutcome> {
    if (!this.initialized) {
      return this.writeFailure("write-failure", this.startupResult?.error ?? "trace runtime is not initialized", record);
    }
    const validation = this.validateRecord(record);
    if (validation !== null) return validation;
    let json: string;
    try {
      json = JSON.stringify(record);
    } catch (error) {
      await this.accountWriteFailure();
      return this.writeFailure("invalid-record", stableError(error), record);
    }
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > this.maxRecordBytes) {
      await this.accountWriteFailure();
      return this.writeFailure("record-too-large", `record is ${bytes} bytes; maximum is ${this.maxRecordBytes}`, record);
    }
    const indexUpdatedAt = timestamp(this.now);
    const capacity = this.reserveLinkIndexCapacity(record, indexUpdatedAt);
    if (!capacity.ok) return this.writeFailure("index-full", capacity.error, record);
    const traceTurn = this.nextTraceTurn;
    const path = join(this.directory, `turn-${traceTurn}.json`);
    const result = await atomicWrite(path, json);
    if (!result.ok) {
      this.manifestValue = freezeDeep({
        ...this.manifestValue,
        writeFailures: this.manifestValue.writeFailures + 1,
        updatedAt: timestamp(this.now),
      });
      if (result.renamed) {
        this.nextTraceTurn = traceTurn + 1;
        this.registerRecord(record, traceTurn);
        return this.finalizePersistedRecord(record, traceTurn, path, indexUpdatedAt, result.error, "write-failure");
      }
      return this.writeFailure("write-failure", result.error, record, path, null, false);
    }
    this.nextTraceTurn = traceTurn + 1;
    this.registerRecord(record, traceTurn);
    return this.finalizePersistedRecord(record, traceTurn, path, indexUpdatedAt);
  }

  private async finalizePersistedRecord(
    record: FrozenTraceAttempt | FrozenTraceTaskSettled,
    traceTurn: number,
    path: string,
    indexUpdatedAt: string,
    initialError: string | null = null,
    initialKind: "write-failure" | null = null,
  ): Promise<TraceWriteOutcome> {
    const indexResult = await this.persistLinkIndex(indexUpdatedAt);
    if (!indexResult.ok) {
      const manifestResult = await this.persistManifest();
      const detail = [initialError, indexResult.error, manifestResult.ok ? null : manifestResult.error]
        .filter((value): value is string => value !== null)
        .join("; ");
      return this.writeFailure(initialKind ?? indexResult.kind, detail || "trace link index write failed", record, path, traceTurn, true);
    }
    const retention = await this.applyRetention();
    const retainedIndex = await this.persistLinkIndex(indexUpdatedAt);
    const manifestResult = await this.persistManifest();
    if (initialKind !== null || !retention.ok || !retainedIndex.ok || !manifestResult.ok) {
      const failureKind: TraceWriteFailureKind = initialKind !== null
        ? initialKind
        : !retainedIndex.ok ? "index-write-failure" : !manifestResult.ok ? "manifest-write-failure" : "retention-failure";
      const failureError = [initialError, !retention.ok ? retention.error : null, !retainedIndex.ok ? retainedIndex.error : null, !manifestResult.ok ? manifestResult.error : null]
        .filter((value): value is string => value !== null)
        .join("; ");
      return this.writeFailure(failureKind, failureError || "trace persistence failed", record, path, traceTurn, true);
    }
    return {
      ok: true,
      kind: "record-written",
      persisted: true,
      record,
      path,
      traceTurn,
      omittedRecords: this.manifestValue.omittedRecords,
      retentionFailures: this.manifestValue.retentionFailures,
      manifest: this.manifest,
    };
  }

  private async applyRetention(): Promise<{ ok: true } | { ok: false; error: string }> {
    const files = await newestTurnFiles(this.directory);
    let error: string | null = null;
    let removed = false;
    while (files.length > this.retentionCap) {
      const oldest = files.shift()!;
      try {
        await unlink(join(this.directory, oldest.name));
        removed = true;
        this.markOmitted(oldest.turn);
        this.manifestValue = freezeDeep({
          ...this.manifestValue,
          omittedRecords: this.manifestValue.omittedRecords + 1,
          updatedAt: timestamp(this.now),
        });
      } catch (caught) {
        if (errorCode(caught) === "ENOENT") {
          removed = true;
          this.markOmitted(oldest.turn);
          this.manifestValue = freezeDeep({
            ...this.manifestValue,
            omittedRecords: this.manifestValue.omittedRecords + 1,
            updatedAt: timestamp(this.now),
          });
          continue;
        }
        this.manifestValue = freezeDeep({
          ...this.manifestValue,
          retentionFailures: this.manifestValue.retentionFailures + 1,
          updatedAt: timestamp(this.now),
        });
        error = stableError(caught);
        break;
      }
    }
    if (removed) {
      try {
        await syncDirectoryAsync(this.directory);
      } catch (caught) {
        this.manifestValue = freezeDeep({
          ...this.manifestValue,
          retentionFailures: this.manifestValue.retentionFailures + 1,
          updatedAt: timestamp(this.now),
        });
        error ??= stableError(caught);
      }
    }
    this.manifestValue = freezeDeep({
      ...this.manifestValue,
      retainedRecords: await countTurnFiles(this.directory),
      updatedAt: timestamp(this.now),
    });
    return error === null ? { ok: true } : { ok: false, error };
  }

  private async accountWriteFailure(): Promise<void> {
    this.manifestValue = freezeDeep({
      ...this.manifestValue,
      writeFailures: this.manifestValue.writeFailures + 1,
      updatedAt: timestamp(this.now),
    });
    await this.persistManifest();
  }

  private async persistManifest(): Promise<TraceManifestOutcome> {
    if (!this.initialized && this.lockHandle === null) {
      return this.manifestFailure(this.startupResult?.error ?? "trace runtime is not initialized", "closed");
    }
    this.manifestValue = freezeDeep({
      ...this.manifestValue,
      retainedRecords: await countTurnFiles(this.directory),
      updatedAt: timestamp(this.now),
    });
    this.refreshManifestLinkIndex(this.linkIndexError);
    const json = JSON.stringify(this.manifestValue);
    if (Buffer.byteLength(json, "utf8") > MAX_TRACE_MANIFEST_BYTES) {
      this.manifestValue = freezeDeep({
        ...this.manifestValue,
        writeFailures: this.manifestValue.writeFailures + 1,
        manifestWriteFailures: this.manifestValue.manifestWriteFailures + 1,
        updatedAt: timestamp(this.now),
      });
      return this.manifestFailure(`trace manifest exceeds ${MAX_TRACE_MANIFEST_BYTES} bytes`);
    }
    const result = await atomicWrite(this.manifestPath, json);
    if (!result.ok) {
      this.manifestValue = freezeDeep({
        ...this.manifestValue,
        writeFailures: this.manifestValue.writeFailures + 1,
        manifestWriteFailures: this.manifestValue.manifestWriteFailures + 1,
        updatedAt: timestamp(this.now),
      });
      return this.manifestFailure(result.error);
    }
    return {
      ok: true,
      kind: "manifest-written",
      path: this.manifestPath,
      manifest: this.manifest,
      error: null,
    };
  }
}


export function createTraceRuntime(options: TraceRuntimeOptions): TraceRuntime {
  return new TraceRuntime(options);
}
