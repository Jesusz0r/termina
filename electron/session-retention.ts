/**
 * Durable owner for core session artifacts retained after finalization.
 *
 * Admission, accounting, and publication are one transaction. The in-process
 * queue covers all finalizations in this app; the app-owned lock protects the
 * same user-data root if a second process is started around a crash. No
 * eviction is performed here: unproven evidence is never deleted.
 */

// Split into ./session-retention/ modules (issue #38). This entry re-exports the public surface.
export { RETAINED_SESSION_ADMISSION_LOCK } from "../shared/session-retention-lock.js";
export { MAX_RETAINED_SESSION_BUNDLES, MAX_RETAINED_SESSION_BUNDLE_BYTES, MAX_RETAINED_SESSION_BYTES, RETAINED_SESSION_USAGE_LEDGER } from "./session-retention/primitives.js";
export type { RetainedSessionClaim } from "./session-retention/claims.js";
export { SessionRetentionOwner, disposeSessionRetentionCoreClient } from "./session-retention/owner.js";
export type { RetainedSessionTransaction, SessionRetentionOwnerOptions, SessionRetentionTransactionOptions } from "./session-retention/owner.js";
