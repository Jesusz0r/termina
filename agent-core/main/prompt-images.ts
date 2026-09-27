import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { acknowledgePendingImages, claimPendingImages, loadImageFromRoots, persistLoadedImages } from "../host.ts";

export const RUN_IMAGE_CAP = 4;

export function droppedRunImageCount(loadedCount: number, extrasCount: number): number {
  return Math.max(0, loadedCount + extrasCount - RUN_IMAGE_CAP);
}

type ImageRef = { name: string; mediaType: string };
type PreparedImages = {
  ok: true;
  images: ImageRef[];
  dropped: number;
  /** Call only after the user message is durably appended. */
  acknowledge: () => Promise<{ ok: true } | { ok: false; error: string }>;
};

/** One preparer per terminal, shared by initial prompts and steering. */
export function createPromptImagePreparer(sessionFile: string | null, eventsDir: string, terminalId: string) {
  let unacknowledged: PreparedImages["acknowledge"] | null = null;
  return async (extraImages: ImageRef[] = []): Promise<PreparedImages | { ok: false; error: string }> => {
    // The preceding message is already durable. Retry its cleanup, not its
    // delivery, before adopting any claim for another message.
    if (unacknowledged) {
      const ack = await unacknowledged();
      if (!ack.ok) return ack;
      unacknowledged = null;
    }
    const claimResult = eventsDir && terminalId
      ? await claimPendingImages(eventsDir, terminalId)
      : { ok: true as const, claim: { claimId: "", images: [] } };
    if (!claimResult.ok) return claimResult;
    const claim = claimResult.claim;
    const loaded = claim.images;
    if (loaded.length && !sessionFile) return { ok: false, error: "pending images require session storage" };
    const imageRoots = [sessionFile ? dirname(sessionFile) : "", eventsDir].filter(Boolean);
    const extras = extraImages
      .map(ref => loadImageFromRoots(ref, imageRoots))
      .filter((img): img is NonNullable<typeof img> => img !== null);
    const persisted = persistLoadedImages(sessionFile, [...loaded, ...extras].slice(0, RUN_IMAGE_CAP));
    if (!persisted.ok) return persisted;
    const persistedPendingNames: string[] = [];
    if (eventsDir && terminalId && claim.claimId && sessionFile) {
      const sessionDir = dirname(sessionFile);
      for (let i = 0; i < loaded.length && i < persisted.images.length; i++) {
        const ref = persisted.images[i]!;
        const src = loaded[i]!;
        if (ref.name === src.name) continue;
        if (existsSync(join(sessionDir, ref.name))) persistedPendingNames.push(src.name);
      }
    }
    const acknowledge = (): ReturnType<PreparedImages["acknowledge"]> => eventsDir && terminalId && claim.claimId
      ? acknowledgePendingImages(eventsDir, terminalId, claim.claimId, persistedPendingNames)
      : Promise.resolve({ ok: true });
    return {
      ok: true,
      images: persisted.images,
      dropped: droppedRunImageCount(loaded.length, extras.length),
      acknowledge: async () => {
        unacknowledged = acknowledge;
        const ack = await acknowledge();
        if (ack.ok) unacknowledged = null;
        return ack;
      },
    };
  };
}
