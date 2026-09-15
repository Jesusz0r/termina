/**
 * Worldline owner barrel (WORLDLINES §6.5, §6.6).
 *
 * Public API of the worldline owner (`electron/worldlines/`). One owner,
 * one public surface; lifecycle units live in the sibling modules.
 */
export { WorldlineManager } from "./manager.js";
export type { WorldlineDeps } from "./manager.js";
export type { RunRecord } from "./types.js";
export { UNCERTAIN_COMPARISON_USAGE_LEDGER } from "./limits.js";
export { disposeWorldlineGitCore } from "../worldline-git.js";
export {
  ensurePromotionRoots,
  ensureBoundRetainedRoot,
  recoverPromotionJournals,
} from "./promotion-recovery.js";
