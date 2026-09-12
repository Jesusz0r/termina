/**
 * Bounded trace-v2 writer for agent-core.
 *
 * The runtime owns only trace record construction and persistence.  It does
 * not infer task class, correctness, cache state, or provider usage from
 * prompts; callers supply those facts (or explicit nulls) and the writer
 * preserves them.  Files are written through a temporary file and rename so
 * a reader never observes a partially-written JSON record.
 */

// Split into ./trace/ modules (issue #38). This entry re-exports the public surface.
export { DEFAULT_TRACE_MAX_RECORD_BYTES, DEFAULT_TRACE_RETENTION_CAP, TRACE_SCHEMA_VERSION } from "./trace/schema.ts";
export type { FrozenTraceAttempt, FrozenTraceManifest, FrozenTraceTaskSettled, TraceAttempt, TraceAttemptIndexEntry, TraceAttemptInput, TraceBoundedToolOutput, TraceCache, TraceCacheInput, TraceCacheMissAttribution, TraceCachePolicy, TraceCachePolicyInput, TraceContinuation, TraceCost, TraceCostComponents, TraceCostInput, TraceCostScope, TraceCostUnits, TraceLinkIndex, TraceManifest, TraceManifestLinkIndex, TraceManifestOutcome, TraceManifestReset, TraceManifestStartup, TraceReclaimEvidence, TraceReclaimTarget, TraceRecord, TraceRevisions, TraceRevisionsInput, TraceRole, TraceRuntimeOptions, TraceSettlementIndexEntry, TraceStartupResult, TraceTaskOutcome, TraceTaskSettled, TraceTaskSettledInput, TraceToolOutcome, TraceUsage, TraceUsageInput, TraceWriteFailure, TraceWriteFailureKind, TraceWriteOutcome, TraceWriteSuccess } from "./trace/schema.ts";
export { createAttemptRecord, createTaskSettledRecord, sanitizeProviderError, validTraceLinkIndex } from "./trace/records.ts";
export { TraceRuntime, createTraceRuntime } from "./trace/runtime.ts";
