/**
 * Bounded trace-v2 writer for agent-core.
 *
 * The runtime owns only trace record construction and persistence.  It does
 * not infer task class, correctness, cache state, or provider usage from
 * prompts; callers supply those facts (or explicit nulls) and the writer
 * preserves them.  Files are written through a temporary file and rename so
 * a reader never observes a partially-written JSON record.
 */
import {
  mkdir,
  open as openFile,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const TRACE_SCHEMA_VERSION = 2 as const;
export const DEFAULT_TRACE_RETENTION_CAP = 64;
export const DEFAULT_TRACE_MAX_RECORD_BYTES = 256 * 1024;
const MAX_TRACE_MANIFEST_BYTES = 64 * 1024;
const DEFAULT_TRACE_MAX_SCAN_FILES = 10_000;
const TRACE_FILE_PATTERN = /^turn-(\d+)\.json$/;
const MANIFEST_FILE = "trace-manifest.json";
const LINK_INDEX_FILE = "trace-index.json";
const MAX_ID_CHARS = 512;
const MAX_STRING_CHARS = 16_384;
const MAX_ARRAY_ITEMS = 4_096;
const MAX_TRACE_INDEX_ENTRIES = 4_096;
const MAX_TRACE_INDEX_BYTES = 1 * 1024 * 1024;
const MAX_TOOL_OUTCOMES = 256;
const MAX_RECLAIM_TARGETS = 256;
let atomicFileCounter = 0;

export type TraceRole = "main" | "summary";

export interface TraceUsage {
  readonly input: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly output: number | null;
  readonly reasoning: number | null;
}

export interface TraceCost {
  readonly usd: number | null;
  readonly source: string | null;
  readonly version: string | null;
  readonly lookedUpAt: string | null;
  readonly knownFields: readonly string[];
  readonly unknownFields: readonly string[];
  readonly unknownReasons: readonly string[];
  readonly scope: TraceCostScope | null;
  readonly units: TraceCostUnits | null;
  readonly components: TraceCostComponents;
  readonly rates: TraceCostComponents;
  readonly cacheWriteTtlClass: string | null;
  readonly reasoningBilling: string | null;
}

export interface TraceCostScope {
  readonly provider: string;
  readonly protocol: string;
  readonly model: string;
  readonly route: string;
  readonly role: TraceRole;
}

export interface TraceCostUnits {
  readonly input: string | null;
  readonly cacheRead: string | null;
  readonly cacheWrite: string | null;
  readonly output: string | null;
  readonly reasoning: string | null;
  readonly storage: string | null;
}

export interface TraceCostComponents {
  readonly input: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly output: number | null;
  readonly reasoning: number | null;
  readonly storage: number | null;
}

export interface TraceCacheMissAttribution {
  readonly attributed: boolean | null;
  readonly primary: string | null;
  readonly contributing: readonly string[];
  readonly missedTokens: number | null;
  readonly gapMs: number | null;
  readonly missingFields: readonly string[];
  readonly noiseFloorTokens: number | null;
}

export interface TraceCachePolicy {
  readonly mode: string | null;
  readonly ttlMs: number | null;
  readonly namespace: string | null;
  readonly markerCount: number | null;
  readonly markerPositions: readonly number[] | null;
  readonly rejected: boolean | null;
  readonly fallbackReason: string | null;
}

export interface TraceCache {
  readonly namespace: string | null;
  readonly requested: TraceCachePolicy;
  readonly effective: TraceCachePolicy;
  readonly markerCount: number | null;
  readonly markerPositions: readonly number[] | null;
  readonly rejected: boolean | null;
  readonly fallbackReason: string | null;
  readonly cacheKeyHash: string | null;
  readonly modelSettingsHash: string | null;
  readonly toolsHash: string | null;
  /** Hash and byte size of the exact serialized tool schema, when reported. */
  readonly serializedToolsHash: string | null;
  readonly serializedToolsBytes: number | null;
  readonly stablePrefixHash: string | null;
  readonly reusablePrefixHash: string | null;
  readonly messagePrefixHash: string | null;
  readonly workingSetHash: string | null;
  readonly workingSetChanged: boolean | null;
  readonly retryPromptIdentical: boolean | null;
  readonly codexTurnStateUsed: boolean | null;
  readonly missAttribution: TraceCacheMissAttribution;
}

export interface TraceBoundedToolOutput {
  readonly state: string | null;
  readonly direction: string | null;
  readonly limitBytes: number | null;
  readonly inputBytes: number | null;
  readonly retainedBytes: number | null;
  readonly omittedBytes: number | null;
  readonly outputBytes: number | null;
  readonly truncated: boolean | null;
}

export interface TraceContinuation {
  readonly server: string | null;
  readonly tool: string | null;
  readonly guidance: string | null;
}

export interface TraceToolOutcome {
  readonly toolName: string | null;
  readonly toolCallId: string | null;
  readonly isError: boolean | null;
  readonly bounded: TraceBoundedToolOutput | null;
  readonly cancellationScope: string | null;
  readonly continuation: TraceContinuation | null;
  readonly repro: string | null;
  readonly stdout: TraceBoundedToolOutput | null;
  readonly stderr: TraceBoundedToolOutput | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export interface TraceReclaimTarget {
  readonly sseq: number | null;
  readonly sourceSseq: number | null;
  readonly blockIndex: number | null;
  readonly action: string | null;
  readonly originalType: string | null;
  readonly originalChars: number | null;
  readonly originalBytes: number | null;
  readonly originalSha256: string | null;
  readonly stubSha256: string | null;
  readonly reclaimedTokens: number | null;
  readonly tool: string | null;
  readonly repro: string | null;
  readonly recovery: string | null;
  readonly result: string | null;
}

export interface TraceReclaimEvidence {
  readonly attempted: boolean | null;
  readonly planned: boolean | null;
  readonly applied: boolean | null;
  readonly recovered: boolean | null;
  readonly revisionId: string | null;
  readonly targetCount: number | null;
  readonly reclaimedBytes: number | null;
  readonly reclaimedTokens: number | null;
  readonly source: string | null;
  readonly recovery: string | null;
  readonly error: string | null;
  readonly targets: readonly TraceReclaimTarget[];
}

export interface TraceRevisions {
  readonly count: number | null;
  readonly kinds: readonly string[];
}

export interface TraceAttempt {
  readonly schemaVersion: typeof TRACE_SCHEMA_VERSION;
  readonly recordType: "attempt";
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly parentAttemptId: string | null;
  readonly retryOfAttemptId: string | null;
  readonly role: TraceRole;
  readonly provider: string;
  readonly protocol: string;
  readonly route: string | null;
  readonly model: string;
  readonly taskClass: string | null;
  readonly requestedEffort: string | null;
  readonly effectiveEffort: string | null;
  readonly status: string;
  readonly retryCount: number | null;
  readonly fallbackReason: string | null;
  readonly storageSeqRange: readonly [number, number] | null;
  readonly toolNames: readonly string[];
  /** Caller-supplied absolute start time; null means it was not observed. */
  readonly startedAtMs: number | null;
  /** Caller-supplied absolute end time; null means it was not observed. */
  readonly endedAtMs: number | null;
  readonly ttftMs: number | null;
  /** Duration supplied by the caller for this attempt. */
  readonly turnMs: number | null;
  readonly usage: TraceUsage;
  readonly cost: TraceCost;
  readonly cache: TraceCache;
  readonly toolOutcomes: readonly TraceToolOutcome[];
  readonly reclaimEvidence: TraceReclaimEvidence | null;
  readonly revisions: TraceRevisions;
  readonly wasteTokens: number | null;
  readonly wasteCause: string | null;
}

export interface TraceTaskOutcome {
  readonly status: string | null;
  readonly correctness: string | null;
  readonly criteriaHash: string | null;
}

export interface TraceTaskSettled {
  readonly schemaVersion: typeof TRACE_SCHEMA_VERSION;
  readonly recordType: "task-settled";
  readonly runId: string;
  readonly taskId: string;
  readonly taskClass: string | null;
  readonly attemptCount: number;
  readonly finalAttemptId: string | null;
  readonly attemptIds: readonly string[];
  readonly summaryAttemptIds: readonly string[];
  readonly outcome: TraceTaskOutcome;
}

export type TraceRecord = TraceAttempt | TraceTaskSettled;
export type FrozenTraceAttempt = Readonly<TraceAttempt>;
export type FrozenTraceTaskSettled = Readonly<TraceTaskSettled>;

export interface TraceUsageInput {
  readonly input?: unknown;
  readonly cacheRead?: unknown;
  readonly cacheWrite?: unknown;
  readonly output?: unknown;
  readonly reasoning?: unknown;
}

export interface TraceCostInput {
  readonly usd?: unknown;
  readonly source?: unknown;
  readonly version?: unknown;
  readonly lookedUpAt?: unknown;
  readonly knownFields?: readonly unknown[];
  readonly unknownFields?: readonly unknown[];
  readonly unknownReasons?: readonly unknown[];
  readonly scope?: unknown;
  readonly units?: unknown;
  readonly components?: unknown;
  readonly rates?: unknown;
  readonly cacheWriteTtlClass?: unknown;
  readonly reasoningBilling?: unknown;
}

export interface TraceCachePolicyInput {
  readonly mode?: unknown;
  readonly ttlMs?: unknown;
  readonly namespace?: unknown;
  readonly markerCount?: unknown;
  readonly markerPositions?: readonly unknown[] | null;
  readonly rejected?: unknown;
  readonly fallbackReason?: unknown;
}

export interface TraceCacheInput {
  readonly namespace?: unknown;
  readonly requested?: TraceCachePolicyInput | null;
  readonly effective?: TraceCachePolicyInput | null;
  readonly markerCount?: unknown;
  readonly markerPositions?: readonly unknown[] | null;
  readonly rejected?: unknown;
  readonly fallbackReason?: unknown;
  readonly cacheKeyHash?: unknown;
  readonly modelSettingsHash?: unknown;
  readonly toolsHash?: unknown;
  readonly serializedToolsHash?: unknown;
  readonly serializedToolsBytes?: unknown;
  readonly stablePrefixHash?: unknown;
  readonly reusablePrefixHash?: unknown;
  readonly messagePrefixHash?: unknown;
  readonly workingSetHash?: unknown;
  readonly workingSetChanged?: unknown;
  readonly retryPromptIdentical?: unknown;
  readonly codexTurnStateUsed?: unknown;
  readonly missAttribution?: {
    readonly attributed?: unknown;
    readonly primary?: unknown;
    readonly contributing?: readonly unknown[];
    readonly missedTokens?: unknown;
    readonly gapMs?: unknown;
    readonly missingFields?: readonly unknown[];
    readonly noiseFloorTokens?: unknown;
  } | null;
}

export interface TraceRevisionsInput {
  readonly count?: unknown;
  readonly kinds?: readonly unknown[];
}

export interface TraceAttemptInput {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly parentAttemptId?: string | null;
  readonly retryOfAttemptId?: string | null;
  readonly role: TraceRole;
  readonly provider: string;
  readonly protocol: string;
  readonly route?: string | null;
  readonly model: string;
  readonly taskClass?: string | null;
  readonly requestedEffort?: string | null;
  readonly effectiveEffort?: string | null;
  readonly status: string;
  readonly retryCount?: unknown;
  readonly fallbackReason?: string | null;
  readonly storageSeqRange?: readonly [unknown, unknown] | null;
  readonly toolNames?: readonly unknown[];
  readonly startedAtMs?: unknown;
  readonly endedAtMs?: unknown;
  readonly ttftMs?: unknown;
  readonly turnMs?: unknown;
  readonly usage?: TraceUsageInput | null;
  readonly cost?: TraceCostInput | null;
  readonly cache?: TraceCacheInput | null;
  readonly toolOutcomes?: readonly unknown[];
  readonly reclaimEvidence?: unknown;
  readonly revisions?: TraceRevisionsInput | number | null;
  readonly wasteTokens?: unknown;
  readonly wasteCause?: string | null;
}

export interface TraceTaskSettledInput {
  readonly runId: string;
  readonly taskId: string;
  readonly taskClass?: string | null;
  readonly attemptCount?: unknown;
  readonly finalAttemptId?: string | null;
  readonly attemptIds?: readonly unknown[];
  readonly summaryAttemptIds?: readonly unknown[];
  readonly outcome?: {
    readonly status?: unknown;
    readonly correctness?: unknown;
    readonly criteriaHash?: unknown;
  } | null;
}

export interface TraceManifestReset {
  readonly requested: boolean;
  readonly applied: boolean;
  readonly omittedRecords: number;
  readonly failedRecords: number;
}

export interface TraceManifestStartup {
  readonly namespace: string;
  readonly startedAt: string;
  readonly reset: TraceManifestReset;
  readonly preexistingRecords: number;
  readonly preexistingMalformedRecords: number;
  readonly preexistingPartialRecords: number;
  readonly preexistingScanOmittedRecords: number;
  readonly error: string | null;
}

/** Durable identity/tombstone information kept after turn-file retention. */
export interface TraceAttemptIndexEntry {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly role: TraceRole;
  readonly retained: boolean;
  readonly traceTurn: number | null;
  /** True when the identity came from an omitted/unscanned reference. */
  readonly unknown: boolean;
}

export interface TraceSettlementIndexEntry {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptIds: readonly string[];
  readonly summaryAttemptIds: readonly string[];
  readonly finalAttemptId: string | null;
  readonly retained: boolean;
  readonly traceTurn: number | null;
  /** True when at least one referenced identity was not retained/observed. */
  readonly unknown: boolean;
}

export interface TraceLinkIndex {
  readonly schemaVersion: typeof TRACE_SCHEMA_VERSION;
  readonly kind: "trace-link-index";
  readonly complete: boolean;
  readonly updatedAt: string;
  readonly attempts: readonly TraceAttemptIndexEntry[];
  readonly settlements: readonly TraceSettlementIndexEntry[];
}

export interface TraceManifestLinkIndex {
  readonly path: string;
  readonly complete: boolean;
  readonly attempts: number;
  readonly settlements: number;
  readonly unknown: number;
  readonly writeFailures: number;
  readonly error: string | null;
}

export interface TraceManifest {
  readonly schemaVersion: typeof TRACE_SCHEMA_VERSION;
  readonly kind: "trace-manifest";
  readonly startup: TraceManifestStartup;
  readonly retainedRecords: number;
  readonly omittedRecords: number;
  readonly writeFailures: number;
  readonly malformedRecords: number;
  readonly partialRecords: number;
  readonly scanOmittedRecords: number;
  readonly manifestErrors: number;
  readonly retentionFailures: number;
  readonly manifestWriteFailures: number;
  readonly indexWriteFailures: number;
  readonly lastTraceTurn: number;
  readonly linkIndex: TraceManifestLinkIndex;
  readonly updatedAt: string;
}

export interface TraceStartupResult {
  readonly ok: boolean;
  readonly directory: string;
  readonly namespace: string;
  readonly reset: TraceManifestReset;
  readonly malformedRecords: number;
  readonly partialRecords: number;
  readonly scanOmittedRecords: number;
  readonly manifestErrors: number;
  readonly retainedRecords: number;
  readonly error: string | null;
}

export type TraceWriteFailureKind = "write-failure" | "manifest-write-failure" | "retention-failure" | "index-write-failure" | "index-full" | "record-too-large" | "invalid-record" | "queue-full" | "closed" | "duplicate-attempt" | "duplicate-settlement" | "invalid-link";

export interface TraceWriteSuccess {
  readonly ok: true;
  readonly kind: "record-written";
  readonly persisted: true;
  readonly record: FrozenTraceAttempt | FrozenTraceTaskSettled;
  readonly path: string;
  readonly traceTurn: number;
  readonly omittedRecords: number;
  readonly retentionFailures: number;
  readonly manifest: FrozenTraceManifest;
}

export interface TraceWriteFailure {
  readonly ok: false;
  readonly kind: TraceWriteFailureKind;
  /** Storage/queue failures can be retried; semantic failures cannot. */
  readonly retryable: boolean;
  readonly persisted: boolean;
  readonly path: string | null;
  readonly traceTurn: number | null;
  readonly record: FrozenTraceAttempt | FrozenTraceTaskSettled | null;
  readonly error: string;
  readonly omittedRecords: number;
  readonly retentionFailures: number;
  readonly manifest: FrozenTraceManifest;
}

export type TraceWriteOutcome = TraceWriteSuccess | TraceWriteFailure;
export type FrozenTraceManifest = Readonly<TraceManifest>;

export interface TraceRuntimeOptions {
  readonly directory: string;
  /** A caller-supplied startup namespace; it is written only to the manifest. */
  readonly namespace?: string;
  /** Deliberately remove current turn files, recording the omissions. */
  readonly reset?: boolean;
  readonly retentionCap?: number;
  readonly maxRecordBytes?: number;
  readonly maxScanFiles?: number;
  readonly maxQueueDepth?: number;
  readonly now?: () => string | number | Date;
}

export interface TraceManifestOutcome {
  readonly ok: boolean;
  readonly kind: "manifest-written" | "manifest-write-failure" | "index-write-failure" | "index-full" | "queue-full" | "closed";
  readonly path: string;
  readonly manifest: FrozenTraceManifest;
  readonly error: string | null;
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    if (Array.isArray(value)) {
      for (const item of value) freezeDeep(item);
    } else {
      for (const item of Object.values(value as Record<string, unknown>)) freezeDeep(item);
    }
    Object.freeze(value);
  }
  return value;
}

function text(value: unknown, name: string, required = false): string | null {
  if (value === null || value === undefined) {
    if (required) throw new Error(`${name} is required`);
    return null;
  }
  if (typeof value !== "string") throw new Error(`${name} must be a string or null`);
  if (value.length > MAX_STRING_CHARS) throw new Error(`${name} exceeds ${MAX_STRING_CHARS} characters`);
  if ([...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  })) throw new Error(`${name} contains a control character`);
  const normalized = required ? value.trim() : value;
  if (required && normalized.length === 0) throw new Error(`${name} must not be empty`);
  return normalized || (required ? null : null);
}

function id(value: unknown, name: string): string {
  const normalized = text(value, name, true)!;
  if (normalized.length > MAX_ID_CHARS) throw new Error(`${name} exceeds ${MAX_ID_CHARS} characters`);
  return normalized;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function nullableInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function requiredInteger(value: unknown, name: string): number {
  const normalized = nullableInteger(value);
  if (normalized === null) throw new Error(`${name} must be a nonnegative safe integer`);
  return normalized;
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function optionalText(value: unknown, name: string): string | null {
  if (value === null || value === undefined || typeof value !== "string") return null;
  try {
    return text(value, name);
  } catch {
    return null;
  }
}

function stringArray(value: readonly unknown[] | null | undefined, name: string): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  if (value.length > MAX_ARRAY_ITEMS) throw new Error(`${name} exceeds ${MAX_ARRAY_ITEMS} items`);
  return value.map((item, index) => text(item, `${name}[${index}]`, true)!).filter((item) => item.length > 0);
}

function numberArray(value: readonly unknown[] | null | undefined, name: string): number[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  if (value.length > 256 || value.some((item) => !Number.isSafeInteger(item) || (item as number) < 0)) return null;
  return value.slice() as number[];
}

function emptyCostComponents(): TraceCostComponents {
  return { input: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null, storage: null };
}

function costComponents(value: unknown): TraceCostComponents {
  if (!isRecord(value)) return emptyCostComponents();
  return {
    input: nullableNumber(value.input),
    cacheRead: nullableNumber(value.cacheRead),
    cacheWrite: nullableNumber(value.cacheWrite),
    output: nullableNumber(value.output),
    reasoning: nullableNumber(value.reasoning),
    storage: nullableNumber(value.storage),
  };
}

function costScope(value: unknown): TraceCostScope | null {
  if (!isRecord(value)) return null;
  const provider = optionalText(value.provider, "cost scope provider");
  const protocol = optionalText(value.protocol, "cost scope protocol");
  const model = optionalText(value.model, "cost scope model");
  const route = optionalText(value.route, "cost scope route");
  const role = value.role === "main" || value.role === "summary" ? value.role : null;
  if (provider === null || protocol === null || model === null || route === null || role === null) return null;
  return freezeDeep({ provider, protocol, model, route, role });
}

function costUnits(value: unknown): TraceCostUnits | null {
  if (!isRecord(value)) return null;
  return freezeDeep({
    input: optionalText(value.input, "cost units input"),
    cacheRead: optionalText(value.cacheRead, "cost units cacheRead"),
    cacheWrite: optionalText(value.cacheWrite, "cost units cacheWrite"),
    output: optionalText(value.output, "cost units output"),
    reasoning: optionalText(value.reasoning, "cost units reasoning"),
    storage: optionalText(value.storage, "cost units storage"),
  });
}

function missAttribution(value: TraceCacheInput["missAttribution"] | null | undefined): TraceCacheMissAttribution {
  if (!isRecord(value)) {
    return freezeDeep({
      attributed: null,
      primary: null,
      contributing: [],
      missedTokens: null,
      gapMs: null,
      missingFields: [],
      noiseFloorTokens: null,
    });
  }
  let contributing: string[] = [];
  let missingFields: string[] = [];
  try {
    contributing = stringArray(value.contributing as readonly unknown[] | null | undefined, "cache miss contributing");
    missingFields = stringArray(value.missingFields as readonly unknown[] | null | undefined, "cache miss missingFields");
  } catch {
    /* Unknown provider diagnostics remain empty rather than breaking the trace. */
  }
  return freezeDeep({
    attributed: nullableBoolean(value.attributed),
    primary: optionalText(value.primary, "cache miss primary"),
    contributing,
    missedTokens: nullableNumber(value.missedTokens),
    gapMs: nullableNumber(value.gapMs),
    missingFields,
    noiseFloorTokens: nullableNumber(value.noiseFloorTokens),
  });
}

function boundedToolOutput(value: unknown): TraceBoundedToolOutput | null {
  if (!isRecord(value)) return null;
  return freezeDeep({
    state: optionalText(value.state, "tool output state"),
    direction: optionalText(value.direction, "tool output direction"),
    limitBytes: nullableInteger(value.limitBytes),
    inputBytes: nullableInteger(value.inputBytes),
    retainedBytes: nullableInteger(value.retainedBytes),
    omittedBytes: nullableInteger(value.omittedBytes),
    outputBytes: nullableInteger(value.outputBytes ?? value.bytes),
    truncated: nullableBoolean(value.truncated),
  });
}

function continuation(value: unknown): TraceContinuation | null {
  if (!isRecord(value)) return null;
  return freezeDeep({
    server: optionalText(value.server, "continuation server"),
    tool: optionalText(value.tool, "continuation tool"),
    guidance: optionalText(value.guidance, "continuation guidance"),
  });
}

function toolOutcome(value: unknown): TraceToolOutcome | null {
  if (!isRecord(value)) return null;
  return freezeDeep({
    toolName: optionalText(value.toolName ?? value.name ?? value.tool, "tool outcome name"),
    toolCallId: optionalText(value.toolCallId ?? value.callId, "tool outcome call id"),
    isError: nullableBoolean(value.isError),
    bounded: boundedToolOutput(value.bounded ?? value),
    cancellationScope: optionalText(value.cancellationScope, "tool cancellation scope"),
    continuation: continuation(value.continuation),
    repro: optionalText(value.repro, "tool reproduction"),
    stdout: boundedToolOutput(value.stdout),
    stderr: boundedToolOutput(value.stderr),
    exitCode: nullableInteger(value.exitCode),
    signal: optionalText(value.signal, "tool signal"),
  });
}

function toolOutcomes(value: readonly unknown[] | null | undefined): TraceToolOutcome[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_TOOL_OUTCOMES)
    .map((item) => toolOutcome(item))
    .filter((item): item is TraceToolOutcome => item !== null);
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function reclaimTarget(value: unknown): TraceReclaimTarget | null {
  if (!isRecord(value)) return null;
  const original = nestedRecord(value.original);
  const fallback = nestedRecord(value.fallback) ?? nestedRecord(value.recovery);
  return freezeDeep({
    sseq: nullableInteger(value.sseq),
    sourceSseq: nullableInteger(value.sourceSseq),
    blockIndex: nullableInteger(value.blockIndex),
    action: optionalText(value.action ?? value.kind, "reclaim action"),
    originalType: optionalText(value.originalType ?? original?.type, "reclaim original type"),
    originalChars: nullableInteger(value.originalChars ?? original?.chars),
    originalBytes: nullableInteger(value.originalBytes ?? original?.bytes),
    originalSha256: optionalText(value.originalSha256 ?? value.originalHash ?? original?.sha256 ?? original?.hash, "reclaim original hash"),
    stubSha256: optionalText(value.stubSha256 ?? value.stubHash, "reclaim stub hash"),
    reclaimedTokens: nullableInteger(value.reclaimedTokens),
    tool: optionalText(value.tool ?? fallback?.tool, "reclaim tool"),
    repro: optionalText(value.repro ?? fallback?.repro, "reclaim reproduction"),
    recovery: optionalText(value.recovery ?? fallback?.source, "reclaim recovery"),
    result: optionalText(value.result ?? value.status, "reclaim result"),
  });
}

function reclaimEvidence(value: unknown): TraceReclaimEvidence | null {
  if (!isRecord(value)) return null;
  const rawTargets = Array.isArray(value.targets) ? value.targets : Array.isArray(value.receipts) ? value.receipts : [];
  const targets = rawTargets.slice(0, MAX_RECLAIM_TARGETS)
    .map((item) => reclaimTarget(item))
    .filter((item): item is TraceReclaimTarget => item !== null);
  return freezeDeep({
    attempted: nullableBoolean(value.attempted ?? value.planned),
    planned: nullableBoolean(value.planned),
    applied: nullableBoolean(value.applied),
    recovered: nullableBoolean(value.recovered),
    revisionId: optionalText(value.revisionId, "reclaim revision id"),
    targetCount: nullableInteger(value.targetCount) ?? (rawTargets.length > 0 ? rawTargets.length : null),
    reclaimedBytes: nullableInteger(value.reclaimedBytes ?? value.bytes),
    reclaimedTokens: nullableInteger(value.reclaimedTokens ?? value.tokens),
    source: optionalText(value.source, "reclaim source"),
    recovery: optionalText(value.recovery, "reclaim recovery"),
    error: optionalText(value.error, "reclaim error"),
    targets,
  });
}

function pair(value: readonly [unknown, unknown] | null | undefined, name: string): [number, number] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${name} must contain two integers`);
  const first = requiredInteger(value[0], `${name}[0]`);
  const second = requiredInteger(value[1], `${name}[1]`);
  if (second < first) throw new Error(`${name} must be ordered`);
  return [first, second];
}

function policy(value: TraceCachePolicyInput | null | undefined): TraceCachePolicy {
  return freezeDeep({
    mode: text(value?.mode, "cache policy mode"),
    ttlMs: nullableNumber(value?.ttlMs),
    namespace: text(value?.namespace, "cache policy namespace"),
    markerCount: nullableInteger(value?.markerCount),
    markerPositions: numberArray(value?.markerPositions, "cache policy markerPositions"),
    rejected: nullableBoolean(value?.rejected),
    fallbackReason: text(value?.fallbackReason, "cache policy fallback reason"),
  });
}

function usage(value: TraceUsageInput | null | undefined): TraceUsage {
  return freezeDeep({
    input: nullableNumber(value?.input),
    cacheRead: nullableNumber(value?.cacheRead),
    cacheWrite: nullableNumber(value?.cacheWrite),
    output: nullableNumber(value?.output),
    reasoning: nullableNumber(value?.reasoning),
  });
}

function cost(value: TraceCostInput | null | undefined): TraceCost {
  return freezeDeep({
    usd: nullableNumber(value?.usd),
    source: text(value?.source, "cost source"),
    version: text(value?.version, "cost version"),
    lookedUpAt: text(value?.lookedUpAt, "cost lookup timestamp"),
    knownFields: stringArray(value?.knownFields, "cost knownFields"),
    unknownFields: stringArray(value?.unknownFields, "cost unknownFields"),
    unknownReasons: stringArray(value?.unknownReasons, "cost unknownReasons"),
    scope: costScope(value?.scope),
    units: costUnits(value?.units),
    components: costComponents(value?.components),
    rates: costComponents(value?.rates),
    cacheWriteTtlClass: optionalText(value?.cacheWriteTtlClass, "cost cacheWriteTtlClass"),
    reasoningBilling: optionalText(value?.reasoningBilling, "cost reasoningBilling"),
  });
}

function cache(value: TraceCacheInput | null | undefined): TraceCache {
  const requested = policy(value?.requested);
  const effective = policy(value?.effective);
  return freezeDeep({
    namespace: text(value?.namespace, "cache namespace"),
    requested,
    effective,
    markerCount: nullableInteger(value?.markerCount),
    markerPositions: numberArray(value?.markerPositions, "cache markerPositions"),
    rejected: nullableBoolean(value?.rejected),
    fallbackReason: text(value?.fallbackReason, "cache fallback reason"),
    cacheKeyHash: text(value?.cacheKeyHash, "cache key hash"),
    modelSettingsHash: text(value?.modelSettingsHash, "model settings hash"),
    toolsHash: text(value?.toolsHash, "tools hash"),
    serializedToolsHash: optionalText(value?.serializedToolsHash, "serialized tools hash"),
    serializedToolsBytes: nullableInteger(value?.serializedToolsBytes),
    stablePrefixHash: text(value?.stablePrefixHash, "stable prefix hash"),
    reusablePrefixHash: text(value?.reusablePrefixHash, "reusable prefix hash"),
    messagePrefixHash: text(value?.messagePrefixHash, "message prefix hash"),
    workingSetHash: text(value?.workingSetHash, "working set hash"),
    workingSetChanged: nullableBoolean(value?.workingSetChanged),
    retryPromptIdentical: nullableBoolean(value?.retryPromptIdentical),
    codexTurnStateUsed: typeof value?.codexTurnStateUsed === "boolean" ? value.codexTurnStateUsed : null,
    missAttribution: missAttribution(value?.missAttribution),
  });
}

function revisions(value: TraceRevisionsInput | number | null | undefined): TraceRevisions {
  if (typeof value === "number") return freezeDeep({ count: nullableInteger(value), kinds: [] });
  return freezeDeep({
    count: nullableInteger(value?.count),
    kinds: stringArray(value?.kinds, "revision kinds"),
  });
}

/** Construct one immutable provider-call attempt without inventing task facts. */
export function createAttemptRecord(input: TraceAttemptInput): FrozenTraceAttempt {
  if (input.role !== "main" && input.role !== "summary") {
    throw new Error("role must be main or summary");
  }
  const record: TraceAttempt = {
    schemaVersion: TRACE_SCHEMA_VERSION,
    recordType: "attempt",
    runId: id(input.runId, "runId"),
    taskId: id(input.taskId, "taskId"),
    attemptId: id(input.attemptId, "attemptId"),
    parentAttemptId: input.parentAttemptId === null || input.parentAttemptId === undefined ? null : id(input.parentAttemptId, "parentAttemptId"),
    retryOfAttemptId: input.retryOfAttemptId === null || input.retryOfAttemptId === undefined ? null : id(input.retryOfAttemptId, "retryOfAttemptId"),
    role: input.role,
    provider: id(input.provider, "provider"),
    protocol: id(input.protocol, "protocol"),
    route: input.route === null || input.route === undefined ? null : text(input.route, "route"),
    model: id(input.model, "model"),
    taskClass: input.taskClass === null || input.taskClass === undefined ? null : text(input.taskClass, "taskClass"),
    requestedEffort: input.requestedEffort === null || input.requestedEffort === undefined ? null : text(input.requestedEffort, "requestedEffort"),
    effectiveEffort: input.effectiveEffort === null || input.effectiveEffort === undefined ? null : text(input.effectiveEffort, "effectiveEffort"),
    status: id(input.status, "status"),
    retryCount: nullableInteger(input.retryCount),
    fallbackReason: input.fallbackReason === null || input.fallbackReason === undefined ? null : text(input.fallbackReason, "fallbackReason"),
    storageSeqRange: pair(input.storageSeqRange, "storageSeqRange"),
    toolNames: stringArray(input.toolNames, "toolNames"),
    startedAtMs: nullableNumber(input.startedAtMs),
    endedAtMs: nullableNumber(input.endedAtMs),
    ttftMs: nullableNumber(input.ttftMs),
    turnMs: nullableNumber(input.turnMs),
    usage: usage(input.usage),
    cost: cost(input.cost),
    cache: cache(input.cache),
    toolOutcomes: toolOutcomes(input.toolOutcomes),
    reclaimEvidence: reclaimEvidence(input.reclaimEvidence),
    revisions: revisions(input.revisions),
    wasteTokens: nullableNumber(input.wasteTokens),
    wasteCause: input.wasteCause === null || input.wasteCause === undefined ? null : text(input.wasteCause, "wasteCause"),
  };
  return freezeDeep(record);
}

/** Construct one immutable logical task outcome; correctness is caller-supplied. */
export function createTaskSettledRecord(input: TraceTaskSettledInput): FrozenTraceTaskSettled {
  const attemptIds = stringArray(input.attemptIds, "attemptIds");
  const summaryAttemptIds = stringArray(input.summaryAttemptIds, "summaryAttemptIds");
  if (new Set(attemptIds).size !== attemptIds.length) throw new Error("attemptIds must contain unique IDs");
  if (new Set(summaryAttemptIds).size !== summaryAttemptIds.length) throw new Error("summaryAttemptIds must contain unique IDs");
  const attemptCount = input.attemptCount === undefined
    ? attemptIds.length
    : nullableInteger(input.attemptCount);
  if (attemptCount === null) throw new Error("attemptCount must be a nonnegative safe integer");
  const record: TraceTaskSettled = {
    schemaVersion: TRACE_SCHEMA_VERSION,
    recordType: "task-settled",
    runId: id(input.runId, "runId"),
    taskId: id(input.taskId, "taskId"),
    taskClass: input.taskClass === null || input.taskClass === undefined ? null : text(input.taskClass, "taskClass"),
    attemptCount,
    finalAttemptId: input.finalAttemptId === null || input.finalAttemptId === undefined ? null : id(input.finalAttemptId, "finalAttemptId"),
    attemptIds,
    summaryAttemptIds,
    outcome: freezeDeep({
      status: text(input.outcome?.status, "outcome status"),
      correctness: text(input.outcome?.correctness, "outcome correctness"),
      criteriaHash: text(input.outcome?.criteriaHash, "outcome criteria hash"),
    }),
  };
  return freezeDeep(record);
}

function timestamp(now: (() => string | number | Date) | undefined): string {
  const value = now ? now() : new Date();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? new Date(0).toISOString() : value.toISOString();
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
  }
  return typeof value === "string" && validExistingId(value) ? value : new Date(0).toISOString();
}

function traceTurnFromName(name: string): number | null {
  const match = TRACE_FILE_PATTERN.exec(name);
  if (!match) return null;
  const turn = Number(match[1]);
  return Number.isSafeInteger(turn) && turn > 0 ? turn : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function likelyPartial(textValue: string): boolean {
  const value = textValue.trim();
  if (value.length === 0) return true;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let rootComplete = false;
  for (const character of value) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (rootComplete && !/\s/.test(character)) return false;
    if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      if (rootComplete) return false;
      stack.push(character);
    } else if (character === "}" || character === "]") {
      const opening = stack.pop();
      if ((character === "}" && opening !== "{") || (character === "]" && opening !== "[")) return false;
      if (stack.length === 0) rootComplete = true;
    }
  }
  if (inString || escaped) return true;
  if (stack.length === 0) return false;
  const last = value[value.length - 1]!;
  return "{[,:}]".includes(last) || /[0-9eE+\-\.]/.test(last) || /[tTfFnNuUrRaAlLsSe]/.test(last);
}

type ExistingFileInfo = {
  readonly names: string[];
  readonly maxTurn: number;
  readonly malformedRecords: number;
  readonly partialRecords: number;
  readonly scanOmittedRecords: number;
  readonly validRecords: number;
};

type ExistingAttempt = {
  readonly turn: number;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly role: TraceRole;
  readonly parentAttemptId: string | null;
  readonly retryOfAttemptId: string | null;
};

type ExistingSettlement = {
  readonly turn: number;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptIds: readonly string[];
  readonly summaryAttemptIds: readonly string[];
  readonly finalAttemptId: string | null;
};

type ExistingScan = ExistingFileInfo & {
  readonly attempts: readonly ExistingAttempt[];
  readonly settlements: readonly ExistingSettlement[];
};

function existingStringArray(value: unknown): { valid: boolean; values: string[] } {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) return { valid: false, values: [] };
  const values: string[] = [];
  for (const item of value) {
    if (!validExistingId(item)) return { valid: false, values: [] };
    values.push(item);
  }
  return { valid: true, values };
}

function validTraceTurn(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

function validTraceLinkIndex(value: unknown): value is TraceLinkIndex {
  if (!isRecord(value) || value.schemaVersion !== TRACE_SCHEMA_VERSION || value.kind !== "trace-link-index" ||
    typeof value.complete !== "boolean" || !validExistingId(value.updatedAt) ||
    !Array.isArray(value.attempts) || !Array.isArray(value.settlements) ||
    value.attempts.length > MAX_TRACE_INDEX_ENTRIES || value.settlements.length > MAX_TRACE_INDEX_ENTRIES ||
    value.attempts.length + value.settlements.length > MAX_TRACE_INDEX_ENTRIES) return false;
  const attemptKeys = new Set<string>();
  for (const item of value.attempts) {
    if (!isRecord(item) || !validExistingId(item.runId) || !validExistingId(item.taskId) || !validExistingId(item.attemptId) ||
      (item.role !== "main" && item.role !== "summary") || typeof item.retained !== "boolean" ||
      !validTraceTurn(item.traceTurn) || typeof item.unknown !== "boolean") return false;
    const key = compositeKey(item.runId, item.attemptId);
    if (attemptKeys.has(key)) return false;
    attemptKeys.add(key);
  }
  const settlementKeys = new Set<string>();
  for (const item of value.settlements) {
    const attemptIds = existingStringArray(item && isRecord(item) ? item.attemptIds : undefined);
    const summaryAttemptIds = existingStringArray(item && isRecord(item) ? item.summaryAttemptIds : undefined);
    if (!isRecord(item) || !validExistingId(item.runId) || !validExistingId(item.taskId) ||
      !attemptIds.valid || !summaryAttemptIds.valid ||
      (item.finalAttemptId !== null && item.finalAttemptId !== undefined && !validExistingId(item.finalAttemptId)) ||
      typeof item.retained !== "boolean" || !validTraceTurn(item.traceTurn) || typeof item.unknown !== "boolean") return false;
    if (new Set(attemptIds.values).size !== attemptIds.values.length ||
      new Set(summaryAttemptIds.values).size !== summaryAttemptIds.values.length ||
      summaryAttemptIds.values.some((idValue) => !attemptIds.values.includes(idValue)) ||
      (item.finalAttemptId !== null && item.finalAttemptId !== undefined && !attemptIds.values.includes(item.finalAttemptId))) return false;
    const key = taskKey(item.runId, item.taskId);
    if (settlementKeys.has(key)) return false;
    settlementKeys.add(key);
  }
  return true;
}

async function inspectExisting(directory: string, maxScanFiles: number, maxRecordBytes: number): Promise<ExistingScan> {
  let names: string[];
  try {
    names = (await readdir(directory))
      .map((name) => ({ name, turn: traceTurnFromName(name) }))
      .filter((item): item is { name: string; turn: number } => item.turn !== null)
      .sort((left, right) => left.turn - right.turn || left.name.localeCompare(right.name))
      .map((item) => item.name);
  } catch {
    return { names: [], maxTurn: 0, malformedRecords: 0, partialRecords: 0, scanOmittedRecords: 0, validRecords: 0, attempts: [], settlements: [] };
  }
  const selected = names.slice(-maxScanFiles);
  const scanOmittedRecords = Math.max(0, names.length - selected.length);
  let malformedRecords = 0;
  let partialRecords = 0;
  let validRecords = 0;
  const attempts: ExistingAttempt[] = [];
  const settlements: ExistingSettlement[] = [];
  for (const name of selected) {
    try {
      const file = join(directory, name);
      if ((await stat(file)).size > maxRecordBytes) {
        malformedRecords++;
        continue;
      }
      const textValue = await readFile(file, "utf8");
      const value = JSON.parse(textValue) as unknown;
      if (!isRecord(value) || value.schemaVersion !== TRACE_SCHEMA_VERSION ||
        (value.recordType !== "attempt" && value.recordType !== "task-settled") ||
        !validExistingId(value.runId) || !validExistingId(value.taskId)) {
        malformedRecords++;
        continue;
      }
      if (value.recordType === "attempt") {
        const parentAttemptId = value.parentAttemptId === null || value.parentAttemptId === undefined
          ? null
          : validExistingId(value.parentAttemptId) ? value.parentAttemptId : undefined;
        const retryOfAttemptId = value.retryOfAttemptId === null || value.retryOfAttemptId === undefined
          ? null
          : validExistingId(value.retryOfAttemptId) ? value.retryOfAttemptId : undefined;
        if (!validExistingId(value.attemptId) || (value.role !== "main" && value.role !== "summary") ||
          parentAttemptId === undefined || retryOfAttemptId === undefined) {
          malformedRecords++;
          continue;
        }
        validRecords++;
        attempts.push({
          turn: traceTurnFromName(name)!,
          runId: value.runId,
          taskId: value.taskId,
          attemptId: value.attemptId,
          role: value.role,
          parentAttemptId,
          retryOfAttemptId,
        });
      } else {
        const attemptIds = existingStringArray(value.attemptIds);
        const summaryAttemptIds = existingStringArray(value.summaryAttemptIds);
        const finalAttemptId = value.finalAttemptId === null || value.finalAttemptId === undefined
          ? null
          : validExistingId(value.finalAttemptId) ? value.finalAttemptId : undefined;
        if (!attemptIds.valid || !summaryAttemptIds.valid || finalAttemptId === undefined) {
          malformedRecords++;
          continue;
        }
        validRecords++;
        settlements.push({
          turn: traceTurnFromName(name)!,
          runId: value.runId,
          taskId: value.taskId,
          attemptIds: attemptIds.values,
          summaryAttemptIds: summaryAttemptIds.values,
          finalAttemptId,
        });
      }
    } catch (error) {
      malformedRecords++;
      /* Syntax errors are the only errors for which truncation is knowable. */
      if (error instanceof SyntaxError) {
        try {
          const textValue = await readFile(join(directory, name), "utf8");
          if (likelyPartial(textValue)) partialRecords++;
        } catch {
          /* The malformed file remains accounted for even when it disappears. */
        }
      }
    }
  }
  const maxTurn = names.reduce((max, name) => Math.max(max, traceTurnFromName(name) ?? 0), 0);
  return { names, maxTurn, malformedRecords, partialRecords, scanOmittedRecords, validRecords, attempts, settlements };
}

function stableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retryableFailureKind(kind: TraceWriteFailureKind): boolean {
  return kind === "write-failure" || kind === "manifest-write-failure" || kind === "retention-failure" ||
    kind === "index-write-failure" || kind === "queue-full";
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof openFile>> | null = null;
  try {
    handle = await openFile(directory, "r");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

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
    await syncDirectory(dirname(path));
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

async function countTurnFiles(directory: string): Promise<number> {
  try {
    return (await readdir(directory)).reduce((count, name) => count + (traceTurnFromName(name) === null ? 0 : 1), 0);
  } catch {
    return 0;
  }
}

async function newestTurnFiles(directory: string): Promise<Array<{ name: string; turn: number }>> {
  try {
    return (await readdir(directory))
      .map((name) => ({ name, turn: traceTurnFromName(name) }))
      .filter((item): item is { name: string; turn: number } => item.turn !== null)
      .sort((left, right) => left.turn - right.turn || left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

function normalizeNamespace(value: string | undefined, directory: string): string {
  const candidate = (value ?? basename(directory)) || "trace";
  return id(candidate, "namespace");
}

function emptyManifestLinkIndex(path: string): TraceManifestLinkIndex {
  return {
    path,
    complete: false,
    attempts: 0,
    settlements: 0,
    unknown: 0,
    writeFailures: 0,
    error: null,
  };
}

function freezeManifest(manifest: TraceManifest): FrozenTraceManifest {
  return freezeDeep(manifest);
}

function emptyExistingScan(): ExistingScan {
  return {
    names: [],
    maxTurn: 0,
    malformedRecords: 0,
    partialRecords: 0,
    scanOmittedRecords: 0,
    validRecords: 0,
    attempts: [],
    settlements: [],
  };
}

function compositeKey(runId: string, idValue: string): string {
  return `${runId}\u0000${idValue}`;
}

function taskKey(runId: string, taskId: string): string {
  return compositeKey(runId, taskId);
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function validExistingId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || (code >= 0x7f && code <= 0x9f);
    });
}

function nonnegativeCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validPriorManifest(value: unknown): value is TraceManifest {
  if (!isRecord(value) || value.schemaVersion !== TRACE_SCHEMA_VERSION || value.kind !== "trace-manifest") return false;
  for (const field of [
    "retainedRecords",
    "omittedRecords",
    "writeFailures",
    "malformedRecords",
    "partialRecords",
    "scanOmittedRecords",
    "manifestErrors",
    "retentionFailures",
    "manifestWriteFailures",
    "indexWriteFailures",
    "lastTraceTurn",
  ]) {
    if (!nonnegativeCounter(value[field])) return false;
  }
  if (!validExistingId(value.updatedAt)) return false;
  if (!isRecord(value.startup) || !validExistingId(value.startup.namespace) ||
    !validExistingId(value.startup.startedAt) || !isRecord(value.startup.reset) ||
    typeof value.startup.reset.requested !== "boolean" || typeof value.startup.reset.applied !== "boolean" ||
    !nonnegativeCounter(value.startup.reset.omittedRecords) || !nonnegativeCounter(value.startup.reset.failedRecords) ||
    !nonnegativeCounter(value.startup.preexistingRecords) ||
    !nonnegativeCounter(value.startup.preexistingMalformedRecords) ||
    !nonnegativeCounter(value.startup.preexistingPartialRecords) ||
    !nonnegativeCounter(value.startup.preexistingScanOmittedRecords) ||
    (value.startup.error !== null && typeof value.startup.error !== "string")) return false;
  if (!isRecord(value.linkIndex) || typeof value.linkIndex.path !== "string" || value.linkIndex.path.length === 0 ||
    typeof value.linkIndex.complete !== "boolean" || !nonnegativeCounter(value.linkIndex.attempts) ||
    !nonnegativeCounter(value.linkIndex.settlements) || !nonnegativeCounter(value.linkIndex.unknown) ||
    !nonnegativeCounter(value.linkIndex.writeFailures) ||
    (value.linkIndex.error !== null && typeof value.linkIndex.error !== "string")) return false;
  return true;
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
        await syncDirectory(this.directory);
        this.lockHandle = handle;
        return { ok: true };
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(this.lockPath).catch(() => undefined);
        await syncDirectory(this.directory).catch(() => undefined);
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
        await syncDirectory(this.directory);
      } catch {
        return { ok: false, error: "trace directory is already locked" };
      }
      try {
        const handle = await openFile(this.lockPath, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, token: this.lockToken, startedAt: timestamp(this.now) }), { encoding: "utf8" });
          await handle.sync();
          await syncDirectory(this.directory);
          this.lockHandle = handle;
          return { ok: true };
        } catch (retryError) {
          await handle.close().catch(() => undefined);
          await unlink(this.lockPath).catch(() => undefined);
          await syncDirectory(this.directory).catch(() => undefined);
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
    await syncDirectory(this.directory).catch(() => undefined);
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
        await syncDirectory(this.directory);
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
