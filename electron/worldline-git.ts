/**
 * App-owned snapshot store client.
 *
 * The store is a bare Git repository outside the source repository. It
 * captures the source working-tree bytes byte-for-byte and reads source
 * objects through a read-only alternate. It never writes the user's Git
 * directory.
 *
 * Every operation runs in the Rust snapshot core. This module is the sole
 * public TypeScript interface to that core; process and protocol plumbing
 * stays private under electron/worldline-git/. It never spawns Git.
 */

// Split into ./worldline-git/ modules (issue #38). This entry re-exports the public surface.
export { captureRootInRepo, disposeWorldlineGitCore, gitCommitFile, gitCommitTree, gitCommittedChanges, gitCommonDir, gitHead, gitIgnoredFiles, gitObjectFormat, gitTopLevel, gitTrackedFiles, gitWorkingChanges, trustResourceHashes } from "./worldline-git/git-reads.js";
export type { GitFileChange, GitTreeEntry } from "./worldline-git/git-reads.js";
export { SnapshotStore } from "./worldline-git/snapshot-store.js";
export type { SnapshotStoreDirectoryIdentity, SnapshotStoreGitLayout, SnapshotStoreLifecycle, SourceState } from "./worldline-git/snapshot-store.js";
export { boundPromotionCopyFile, boundPromotionCopyTree, boundPromotionCreateDirectory, boundPromotionCreateSymlink, boundPromotionEnsureDirectory, boundPromotionInstallDirectory, boundPromotionListDirectories, boundPromotionListEntries, boundPromotionOpenDirectory, boundPromotionPrepareDirectory, boundPromotionReadFile, boundPromotionRemoveTree, boundPromotionTransition, boundPromotionWriteFile, readBoundPromotionJournal } from "./worldline-git/bound-promotion.js";
export type { BoundPromotionDirectoryResult, BoundPromotionExpectedLeaf, BoundPromotionExpectedMissing, BoundPromotionExpectedState, BoundPromotionJournalRead, BoundPromotionLeafResult, BoundPromotionTransitionRequest, BoundPromotionTransitionResult, PromotionFsIdentity } from "./worldline-git/bound-promotion.js";
export { bindOwnedDirectory, bindOwnedEntry, boundPromotionWriteJsonFile, createOwnedDirectory, removeBoundOwnedDirectory, removeBoundOwnedEntry, writeBoundOwnedFile } from "./worldline-git/bound-owned.js";
export type { BoundOwnedDirectory, BoundOwnedEntry } from "./worldline-git/bound-owned.js";
export { MIN_WORLDS_FREE_BYTES, freeDiskBytes, platformHasCopyOnWrite, platformHasRecursiveWatcher, platformHasSandboxExec } from "./worldline-git/platform.js";
