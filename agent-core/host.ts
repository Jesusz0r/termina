/**
 * Termina host adapter for agent-core.
 *
 * Same sidecar file names as the app bridge: ack, prompt payload,
 * verify/edits/mailbox context, machine-only Mine policy, startup-control. The parser stays
 * electron/sidecar.ts. This module is the kernel writer of that protocol.
 */

// Split into ./host/ modules (issue #38). This entry re-exports the public surface.
export { HOST_CONTEXT_BYTES, ackPath, consumeStartupControl, firstPlanText, planTextIfChanged, promptFileName, readContextFiles, readContextFilesResult, readProtectedPaths, structuredStartupText, visibleAssistantText, waitForAck, writePromptPayload } from "./host/context.ts";
export type { ReadContextFilesOptions, StartupControl } from "./host/context.ts";
export { MAX_IMAGE_BYTES, MAX_PENDING_IMAGES, MAX_PENDING_IMAGE_BATCH_BYTES, isSafeImageName, mediaTypeOfName, pendingImagesPath, withPendingImageLock } from "./host/images.ts";
export type { ImageRef, LoadedImage, PendingImageClaim, PendingImageClaimResult, PendingImageInput, PendingImageMediaType, PendingImageResult, PendingImageStateResult } from "./host/images.ts";
export { acknowledgePendingImages, appendPendingImages, claimPendingImages, pendingImageState } from "./host/image-queue.ts";
export { expandFileImageSource, loadImageFromRoots, persistLoadedImages, persistSessionImage, structuredStartup } from "./host/image-store.ts";
