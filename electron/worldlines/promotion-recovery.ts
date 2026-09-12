/**
 * Promotion durability engine (`electron/worldlines/`).
 * Bound-directory IO, comparison manifests, journal validation and
 * rollback, retained roots, recovery, and the promotion transaction.
 */

// Split into ./promotion-recovery/ modules (issue #38). This entry re-exports the public surface.
export { awaitAbortable, processStartMatches, readProcessStart, sha256Hex, waitBounded, withPromotionTransaction } from "./promotion-recovery/primitives.js";
export { createPromotionArtifactManifest, setPromotionRecoveryTestHookForTest, writePromotionJournal } from "./promotion-recovery/journals.js";
export { readComparisonManifestBound, writeComparisonManifestBound, writeComparisonMarkerBound } from "./promotion-recovery/manifests.js";
export { copyBoundPrivateFile, createSnapshotTemplateDirectory, ensureBoundChildDirectory, ensureBoundDirectory, ensureBoundRetainedRoot, materializePromotionDirectoryPlan, probePromotionDirectory, refreshComparisonBindings } from "./promotion-recovery/bound-dirs.js";
export { boundPromotionExpectedLeaf, copyBoundBeforeImage, isMaterializedPromotionState, isRestorablePromotionState, promotionDestination, promotionDestinationComponents, promotionParentIdentity, promotionSourceComponents, promotionStateHash, promotionStatesEqual, readPromotionEntry } from "./promotion-recovery/entry-state.js";
export { disposeWorldlineCoreClient, ensurePromotionRoots, recoverPromotionJournals, rollbackPromotion } from "./promotion-recovery/recovery.js";
