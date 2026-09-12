/**
 * Pending-image queue API.
 *
 * Owns append/state/claim/acknowledge for pending images. Split from
 * agent-core/host.ts (issue #38).
 */
import { randomUUID } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { ACK_ID } from "./context.ts";
import { MAX_IMAGE_BYTES, MAX_PENDING_IMAGES, MAX_PENDING_IMAGE_BATCH_BYTES, PENDING_IMAGE_NAME, cleanupStaleRecords, emptyClaim, extForMedia, isAllowedMediaType, isClaimName, isSafeImageName, listAdoptableClaims, loadClaimImage, pathExists, pendingImagesPath, queueError, queueFail, queuedImageCount, readImageRecord, rollbackTransaction, unlinkRegular, withPendingImageLock, writeExclusiveFile } from "./images.ts";
import type { ImageRef, LoadedImage, PendingImageClaimResult, PendingImageInput, PendingImageMediaType, PendingImageResult, PendingImageStateResult, ProducerTx } from "./images.ts";


export async function appendPendingImages(
  eventsDir: string,
  terminalId: string,
  images: readonly PendingImageInput[],
  options?: { canCommit?: () => boolean | Promise<boolean> },
): Promise<PendingImageResult> {
  try {
    if (!eventsDir) return { ok: false, error: "no events directory" };
    if (!ACK_ID.test(terminalId)) return { ok: false, error: "invalid id" };
    if (!Array.isArray(images) || images.length === 0) return { ok: false, error: "no images" };
    if (images.length > MAX_PENDING_IMAGES) return { ok: false, error: "too many pending images" };
    const seen = new Set<string>();
    let total = 0;
    for (const img of images) {
      if (!img || !ACK_ID.test(img.id)) return { ok: false, error: "invalid id" };
      if (seen.has(img.id)) return { ok: false, error: "duplicate image id" };
      seen.add(img.id);
      if (!isAllowedMediaType(img.mediaType)) return { ok: false, error: "unsupported media type" };
      if (!Buffer.isBuffer(img.bytes) || img.bytes.length === 0) return { ok: false, error: "image is empty" };
      if (img.bytes.length > MAX_IMAGE_BYTES) return { ok: false, error: "image is too large" };
      total += img.bytes.length;
    }
    if (total > MAX_PENDING_IMAGE_BATCH_BYTES) return { ok: false, error: "image is too large" };
    await mkdir(eventsDir, { recursive: true, mode: 0o700 });
    const staged: Array<{ stageName: string; finalName: string; mediaType: PendingImageMediaType }> = [];
    const dropStaged = async (): Promise<void> => {
      for (const item of staged) await unlinkRegular(join(eventsDir, item.stageName));
    };
    try {
      for (const img of images) {
        const finalName = `image-${terminalId}-${img.id}.${extForMedia(img.mediaType)}`;
        if (!PENDING_IMAGE_NAME.test(finalName)) {
          await dropStaged();
          return { ok: false, error: "invalid image name" };
        }
        const stageName = `${finalName}.stage-${randomUUID()}`;
        await writeExclusiveFile(join(eventsDir, stageName), img.bytes);
        staged.push({ stageName, finalName, mediaType: img.mediaType });
      }
      return await withPendingImageLock(eventsDir, terminalId, async (assertHeld) => {
        const livePath = pendingImagesPath(eventsDir, terminalId);
        const live = await readImageRecord(eventsDir, terminalId, livePath);
        const current = live === "missing" ? [] : live.images;
        const queued = await queuedImageCount(eventsDir, terminalId);
        if (queued + staged.length > MAX_PENDING_IMAGES) {
          await dropStaged();
          return { ok: false, error: "too many pending images" };
        }
        const pid = process.pid;
        const createdAt = Date.now();
        const nonce = randomUUID();
        const tx: ProducerTx = {
          terminalId,
          pid,
          createdAt,
          nonce,
          staged: staged.map((item) => item.stageName),
          final: staged.map((item) => item.finalName),
        };
        const txPath = join(eventsDir, `images-tx-${terminalId}-${pid}-${createdAt}-${nonce}.json`);
        await writeExclusiveFile(txPath, JSON.stringify(tx));
        try {
          await assertHeld();
          for (const item of staged) {
            const dest = join(eventsDir, item.finalName);
            if (await pathExists(dest)) queueFail("image queue is invalid");
            await rename(join(eventsDir, item.stageName), dest);
          }
          const merged = [...current, ...staged.map((item) => ({ name: item.finalName, mediaType: item.mediaType }))];
          const tmpName = `images-${terminalId}.json.tmp-${randomUUID()}`;
          const tmpPath = join(eventsDir, tmpName);
          await writeExclusiveFile(tmpPath, JSON.stringify({ images: merged }));
          await assertHeld();
          const allowed = options?.canCommit ? await options.canCommit() : true;
          if (!allowed) {
            await unlinkRegular(tmpPath);
            await rollbackTransaction(eventsDir, tx, txPath);
            return { ok: false, error: "terminal closed" };
          }
          await assertHeld();
          await rename(tmpPath, livePath);
          await unlinkRegular(txPath);
          try {
            await cleanupStaleRecords(eventsDir, terminalId);
          } catch {
            /* Cleanup is maintenance after a committed attachment. */
          }
          return { ok: true, count: merged.length, names: staged.map((item) => item.finalName) };
        } catch (err) {
          await rollbackTransaction(eventsDir, tx, txPath);
          throw err;
        }
      });
    } catch (err) {
      await dropStaged();
      return queueError(err);
    }
  } catch (err) {
    return queueError(err);
  }
}


export async function pendingImageState(eventsDir: string, terminalId: string): Promise<PendingImageStateResult> {
  try {
    return await withPendingImageLock(eventsDir, terminalId, async () => {
      const count = await queuedImageCount(eventsDir, terminalId);
      await cleanupStaleRecords(eventsDir, terminalId);
      return { ok: true, count, hasImages: count > 0 };
    });
  } catch (err) {
    return queueError(err);
  }
}


export async function claimPendingImages(eventsDir: string, terminalId: string): Promise<PendingImageClaimResult> {
  try {
    const claimed = await withPendingImageLock(eventsDir, terminalId, async () => {
      const adoptable = await listAdoptableClaims(eventsDir, terminalId);
      for (const item of adoptable) {
        const rec = await readImageRecord(eventsDir, terminalId, join(eventsDir, item.name));
        if (rec === "missing") continue;
        await cleanupStaleRecords(eventsDir, terminalId);
        return { claimId: item.name, images: rec.images };
      }
      const livePath = pendingImagesPath(eventsDir, terminalId);
      const live = await readImageRecord(eventsDir, terminalId, livePath);
      if (live === "missing" || live.images.length === 0) {
        if (live !== "missing" && live.images.length === 0) await unlinkRegular(livePath);
        await cleanupStaleRecords(eventsDir, terminalId);
        return emptyClaim();
      }
      const createdAt = Date.now();
      const claimId = `images-claim-${terminalId}-${process.pid}-${createdAt}-${randomUUID()}.json`;
      await rename(livePath, join(eventsDir, claimId));
      await cleanupStaleRecords(eventsDir, terminalId);
      return { claimId, images: live.images };
    });
    if (!claimed.claimId || claimed.images.length === 0) {
      return { ok: true, claim: { claimId: claimed.claimId, images: [] } };
    }
    const loaded: LoadedImage[] = [];
    for (const ref of claimed.images) {
      loaded.push({ ...ref, bytes: await loadClaimImage(eventsDir, ref.name) });
    }
    return { ok: true, claim: { claimId: claimed.claimId, images: loaded } };
  } catch (err) {
    return queueError(err);
  }
}


export async function acknowledgePendingImages(
  eventsDir: string,
  terminalId: string,
  claimId: string,
  persistedNames: readonly string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (!persistedNames.length) return { ok: true };
    if (!ACK_ID.test(terminalId) || !isClaimName(claimId, terminalId) || claimId.includes("/") || claimId.includes("\\")) {
      return { ok: false, error: "image queue is invalid" };
    }
    const wanted = new Set(persistedNames.filter((name) => isSafeImageName(name)));
    return await withPendingImageLock(eventsDir, terminalId, async () => {
      const path = join(eventsDir, claimId);
      const rec = await readImageRecord(eventsDir, terminalId, path);
      if (rec === "missing") queueFail("image queue is invalid");
      const kept: ImageRef[] = [];
      const done: ImageRef[] = [];
      for (const ref of rec.images) {
        if (wanted.has(ref.name)) done.push(ref);
        else kept.push(ref);
      }
      if (kept.length === 0) {
        await unlinkRegular(path);
      } else {
        const tmp = join(eventsDir, `images-${terminalId}.json.tmp-${randomUUID()}`);
        await writeExclusiveFile(tmp, JSON.stringify({ images: kept }));
        await rename(tmp, path);
      }
      for (const ref of done) await unlinkRegular(join(eventsDir, ref.name));
      await cleanupStaleRecords(eventsDir, terminalId);
      return { ok: true as const };
    });
  } catch (err) {
    return queueError(err);
  }
}
