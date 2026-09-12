/**
 * Session image persistence and expansion.
 *
 * Owns image loading, session persistence, and startup/image-source
 * expansion. Split from agent-core/host.ts (issue #38).
 */
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { OPEN_NOFOLLOW_READ, structuredStartupText } from "./context.ts";
import type { StartupControl } from "./context.ts";
import { MAX_IMAGE_BYTES, STORED_IMAGE_NAME, extForMedia, isSafeImageName, mediaTypeOfName } from "./images.ts";
import type { ImageRef, LoadedImage } from "./images.ts";


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


export function persistSessionImage(
  sessionFile: string | null,
  img: LoadedImage,
  index: number,
): ImageRef | null {
  if (!sessionFile || index < 1) return { name: img.name, mediaType: img.mediaType };
  const dir = dirname(sessionFile);
  if (STORED_IMAGE_NAME.test(img.name)) {
    try {
      if (lstatSync(join(dir, img.name)).isFile()) return { name: img.name, mediaType: img.mediaType };
    } catch {
      /* Copy the loaded bytes to a new stored image. */
    }
  }
  const stem = basename(sessionFile, ".jsonl") || "session";
  const ext = extForMedia(img.mediaType);
  let n = Math.max(1, index);
  let name = `${stem}-img-${n}.${ext}`;
  while (existsSync(join(dir, name)) && n < 99) {
    n += 1;
    name = `${stem}-img-${n}.${ext}`;
  }
  if (!STORED_IMAGE_NAME.test(name) || existsSync(join(dir, name))) {
    return null;
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, name), img.bytes, { flag: "wx", mode: 0o600 });
    return { name, mediaType: img.mediaType };
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
    const ref = persistSessionImage(sessionFile, images[i]!, i + 1);
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
    if (sessionFile && ref.name !== images[i]!.name) created.push(ref.name);
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
