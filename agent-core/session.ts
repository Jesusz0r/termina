/**
 * Segmented append-only agent-core session bundle.
 *
 * Layout:
 *   <project-session-dir>/<session-id>/
 *     current/{part-NNNNNN.jsonl, session.jsonl, images}
 *     archive-<stamp>/
 *     bad-<stamp>/
 *
 * sessionFile is the stable address of the active JSONL segment:
 *   .../<session-id>/current/session.jsonl
 *
 * Worldlines and Session Search call these helpers. They do not read or
 * copy core session JSONL themselves.
 */

// Split into ./session/ modules (issue #38). This entry re-exports the public surface.
export { listCurrentSegments, sessionBundleBytes, sessionBundleExists, sessionBundleHasContent } from "./session/bundles.ts";
export { writeForkedSession } from "./session/fork.ts";
export { SessionWriter, clearSessionBundle, ensureSessionBundle, inspectEmptySessionBundle, listLogicalSessions, prepareFreshSession, quarantineSessionBundle, removeEmptySessionBundle } from "./session/lifecycle.ts";
export { MAX_RETAINED_EMPTY_SESSION_BUNDLES, MAX_RETAINED_TEMP_BUNDLES, MAX_RETAINED_TEMP_BYTES, MAX_SESSION_BUNDLE_BYTES, MAX_SESSION_RECORD_BYTES, MAX_SESSION_SEGMENT_BYTES, RETAINED_STAGING_OWNER_NAME, coreSessionFile, formatStub, isCoreSessionBundleFile, isCoreSessionId, parseSessionBundlePath, resolveSessionFile, sessionBlockBytes, sessionBlockHash, sessionRotateStamp, validateSessionReclaimReceipt } from "./session/primitives.ts";
export type { EmptySessionBundleInspection, EmptySessionBundleProof, ForkSessionResult, LogicalSessionEntry, ReplayContent, ReplayMessage, ReplayRecovery, ReplaySessionBundleOptions, ReplayState, SessionBundlePaths, SessionOperationOptions, SessionReclaimOriginal, SessionReclaimReceipt, SessionReclaimReceiptTarget, SessionReclaimRecovery, SessionResult, SessionTestHooks } from "./session/primitives.ts";
export { ACTIVE_NAME as SESSION_ACTIVE_NAME, CURRENT_DIR as SESSION_CURRENT_DIR } from "./session/primitives.ts";
export { applySessionRecord, createReplayState, isSessionModel, recoverSessionBlock, replaySessionBundle, replaySessionRecords } from "./session/replay.ts";
export type { SessionRecoveryTarget } from "./session/replay.ts";
