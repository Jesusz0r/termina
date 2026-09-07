/**
 * Worldline owner barrel (WORLDLINES §6.5, §6.6).
 *
 * Public API of the worldline owner (`electron/worldlines/`). One owner,
 * one public surface; lifecycle units live in the sibling modules.
 */
export { WorldlineManager } from "./manager.js";
export type { WorldlineDeps } from "./manager.js";
export { dirBytes } from "./promotion-journal.js";
export { quoteShellArg } from "../../shared/terminal-control.js";
export type { WorldlineState, WorldlineSummary } from "../../shared/types.js";
export type {
  BoundPromotionDirectory,
  PromoteSeed,
  PromotionRecoveryContext,
  RunRecord,
} from "./types.js";
export { UNCERTAIN_COMPARISON_USAGE_LEDGER } from "./limits.js";
export {
  disposeWorldlineCoreClient,
  ensurePromotionRoots,
  ensureBoundRetainedRoot,
  recoverPromotionJournals,
  setPromotionRecoveryTestHookForTest,
  withPromotionTransaction,
} from "./promotion-recovery.js";
