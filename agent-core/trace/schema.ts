/**
 * Trace schema v2: budgets, records, manifest, and outcome shapes.
 *
 * Owns every interface/type plus file/bound constants. Split from
 * agent-core/trace.ts (issue #38).
 */


export const TRACE_SCHEMA_VERSION = 2 as const;

export const DEFAULT_TRACE_RETENTION_CAP = 64;

export const DEFAULT_TRACE_MAX_RECORD_BYTES = 256 * 1024;

export const MAX_TRACE_MANIFEST_BYTES = 64 * 1024;

export const DEFAULT_TRACE_MAX_SCAN_FILES = 10_000;

export const TRACE_FILE_PATTERN = /^turn-(\d+)\.json$/;

export const MANIFEST_FILE = "trace-manifest.json";

export const LINK_INDEX_FILE = "trace-index.json";

export const MAX_ID_CHARS = 512;

export const MAX_STRING_CHARS = 16_384;

export const MAX_ARRAY_ITEMS = 4_096;

export const MAX_TRACE_INDEX_ENTRIES = 4_096;

export const MAX_TRACE_INDEX_BYTES = 1 * 1024 * 1024;

export const MAX_TOOL_OUTCOMES = 256;

export const MAX_RECLAIM_TARGETS = 256;


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
  readonly reusablePrefixItems: number | null;
  readonly comparedPrefixHash: string | null;
  readonly comparedPrefixItems: number | null;
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
  /** Raw provider failure message for this attempt; null when not observed. */
  readonly providerError: string | null;
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
  readonly reusablePrefixItems?: unknown;
  readonly comparedPrefixHash?: unknown;
  readonly comparedPrefixItems?: unknown;
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
  /** Raw provider failure message for this attempt; null when not observed. */
  readonly providerError?: string | null;
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
