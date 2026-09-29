/**
 * Session image persistence and expansion.
 *
 * Owns image loading, session persistence, and startup/image-source
 * expansion. Split from agent-core/host.ts (issue #38).
 */
import { closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isErrno } from "../../shared/guards.ts";
import { syncDirectory, syncParentDir } from "../../shared/fsync.ts";
import { evictOldest } from "../../shared/evict-oldest.ts";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { OPEN_NOFOLLOW_READ, structuredStartupText } from "./context.ts";
import type { StartupControl } from "./context.ts";
import { MAX_IMAGE_BYTES, STORED_IMAGE_NAME, extForMedia, isAllowedMediaType, isSafeImageName, mediaTypeOfName } from "./image-types.ts";
import type { ImageRef, LoadedImage } from "./image-types.ts";


function loadImageBytes(dir: string, name: string): Buffer | null {
  if (!isSafeImageName(name) || OPEN_NOFOLLOW_READ === null) return null;
  try {
    const realDir = realpathSync(dir);
    const candidate = join(dir, name);
    const realFile = realpathSync(candidate);
    const rel = relative(realDir, realFile);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    const fd = openSync(candidate, OPEN_NOFOLLOW_READ);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size === 0 || info.size > MAX_IMAGE_BYTES) return null;
      const bytes = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < info.size) {
        const read = readSync(fd, bytes, offset, info.size - offset, offset);
        if (read <= 0) return null;
        offset += read;
      }
      if (fstatSync(fd).size !== info.size) return null;
      return bytes;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}


export function loadImageFromRoots(ref: ImageRef, roots: string[]): LoadedImage | null {
  for (const root of roots) {
    if (!root) continue;
    const bytes = loadImageBytes(root, ref.name);
    if (bytes) return { ...ref, bytes };
  }
  return null;
}


// A bounded cursor avoids probing every prior observation on every write.
// Exclusive creation, rather than this hint, arbitrates concurrent writers.
const nextImageIndexes = new Map<string, number>();

function persistSessionImage(
  sessionFile: string | null,
  img: LoadedImage,
  index: number,
  created: string[],
): ImageRef | null {
  if (!Buffer.isBuffer(img.bytes) || img.bytes.length === 0 || img.bytes.length > MAX_IMAGE_BYTES || !isAllowedMediaType(img.mediaType)) return null;
  if (!sessionFile) return isSafeImageName(img.name) ? { name: img.name, mediaType: img.mediaType } : null;
  const dir = dirname(resolve(sessionFile));
  if (STORED_IMAGE_NAME.test(img.name) && mediaTypeOfName(img.name) === img.mediaType) {
    const existing = loadImageBytes(dir, img.name);
    if (existing?.equals(img.bytes) && OPEN_NOFOLLOW_READ !== null) {
      try {
        const fd = openSync(join(dir, img.name), OPEN_NOFOLLOW_READ);
        try { fsyncSync(fd); } finally { closeSync(fd); }
        syncDirectory(dir);
        return { name: img.name, mediaType: img.mediaType };
      } catch {
        return null;
      }
    }
  }
  const stem = basename(sessionFile, ".jsonl") || "session";
  const ext = extForMedia(img.mediaType);
  try {
    const createdDir = mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (createdDir) {
      for (let directory = dir; ; directory = dirname(directory)) {
        syncDirectory(directory);
        if (directory === createdDir) break;
      }
      syncParentDir(createdDir);
    }
    for (let n = Math.max(1, index, nextImageIndexes.get(sessionFile) ?? 1); ; n++) {
      const name = `${stem}-img-${n}.${ext}`;
      if (!STORED_IMAGE_NAME.test(name)) return null;
      let fd: number;
      try {
        fd = openSync(join(dir, name), "wx", 0o600);
      } catch (err) {
        if (isErrno(err, "EEXIST")) continue;
        throw err;
      }
      nextImageIndexes.set(sessionFile, n + 1);
      evictOldest(nextImageIndexes, 64);
      try {
        try {
          writeFileSync(fd, img.bytes);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        syncDirectory(dir);
        created.push(name);
        return { name, mediaType: img.mediaType };
      } catch (err) {
        rmSync(join(dir, name), { force: true });
        throw err;
      }
    }
  } catch {
    return null;
  }
}


export function persistLoadedImages(
  sessionFile: string | null,
  images: LoadedImage[],
): { ok: true; images: ImageRef[] } | { ok: false; error: string } {
  const stored: ImageRef[] = [];
  const created: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const ref = persistSessionImage(sessionFile, images[i]!, i + 1, created);
    if (!ref) {
      if (sessionFile) {
        for (const name of created) {
          try {
            rmSync(join(dirname(sessionFile), name), { force: true });
          } catch {
            /* The failed prompt does not reference this file. */
          }
        }
      }
      return { ok: false, error: "could not persist a session image" };
    }
    stored.push(ref);
  }
  return { ok: true, images: stored };
}


export function structuredStartup(control: StartupControl): { text: string; images: ImageRef[] } {
  const text = structuredStartupText(control);
  const images: ImageRef[] = [];
  if (!Array.isArray(control.content)) return { text, images };
  for (const item of control.content) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.name === "string" && isSafeImageName(rec.name)) {
      images.push({
        name: rec.name,
        mediaType: typeof rec.mediaType === "string" ? rec.mediaType : mediaTypeOfName(rec.name),
      });
      continue;
    }
    if (rec.type !== "image" || !rec.source || typeof rec.source !== "object") continue;
    const src = rec.source as Record<string, unknown>;
    if (typeof src.name !== "string" || !isSafeImageName(src.name)) continue;
    images.push({
      name: src.name,
      mediaType: typeof src.media_type === "string" ? src.media_type : mediaTypeOfName(src.name),
    });
  }
  return { text, images };
}


export function expandFileImageSource(
  source: Record<string, unknown>,
  roots: string[],
): { type: "base64"; media_type: string; data: string } | null {
  if (source.type === "base64" && typeof source.data === "string" && typeof source.media_type === "string") {
    if (source.data.length === 0 || source.data.length > MAX_IMAGE_BYTES * 2) return null;
    // Cap decoded bytes, not encoded chars: the 8 MB encoded ceiling admits
    // ~6 MB decoded, 50% over the 4 MB file path. Empty decodes are useless.
    const decodedBytes = Buffer.from(source.data, "base64").byteLength;
    if (decodedBytes === 0 || decodedBytes > MAX_IMAGE_BYTES) return null;
    return { type: "base64", media_type: source.media_type, data: source.data };
  }
  if (source.type !== "file" || typeof source.name !== "string" || !isSafeImageName(source.name)) return null;
  const media = typeof source.media_type === "string" ? source.media_type : mediaTypeOfName(source.name);
  for (const root of roots) {
    if (!root) continue;
    const bytes = loadImageBytes(root, source.name);
    if (!bytes) continue;
    return { type: "base64", media_type: media, data: bytes.toString("base64") };
  }
  return null;
}
