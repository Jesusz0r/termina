/**
 * Bounded trace-v2 writer for agent-core.
 *
 * The runtime owns only trace record construction and persistence.  It does
 * not infer task class, cache state, or provider usage from prompts; callers
 * supply those facts (or explicit nulls) and the writer preserves them.
 * Files are written through a temporary file and rename so a reader never
 * observes a partially-written JSON record.
 */

// Split into ./trace/ modules (issue #38). This entry re-exports the public surface.
export { DEFAULT_TRACE_RETENTION_CAP, TRACE_SCHEMA_VERSION } from "./trace/schema.ts";
export type { TraceAttemptIndexEntry, TraceAttemptInput, TraceCacheInput, TraceCostInput, TraceLinkIndex, TraceRole, TraceWriteFailure, TraceWriteOutcome } from "./trace/schema.ts";
export { createAttemptRecord, createTaskSettledRecord, sanitizeProviderError, validTraceLinkIndex } from "./trace/records.ts";
export { TraceRuntime, createTraceRuntime } from "./trace/runtime.ts";
export {
  isRetriableProviderTermination,
  isTerminalTraceAttemptStatus,
  storageSeqRange,
  traceWriteDisposition,
} from "./trace/disposition.ts";
