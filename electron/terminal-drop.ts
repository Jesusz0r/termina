/**
 * Privileged drop helpers used only by the main process.
 * The renderer never reads these paths.
 */
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_IMAGE_BYTES, MAX_PENDING_IMAGES, type PendingImageMediaType } from "../agent-core/host.ts";
import type { FileHandle } from "node:fs/promises";

const MAX_DROP_PATHS = 16;
const MAX_PATH_BYTES = 4096;
const MAX_PATH_TOTAL_BYTES = 64 * 1024;
const MAX_BATCH_BYTES = MAX_PENDING_IMAGES * MAX_IMAGE_BYTES;
const OPEN_NOFOLLOW_READ = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff]);
const GIF87 = Buffer.from("GIF87a");
const GIF89 = Buffer.from("GIF89a");

export type DropImage = { bytes: Buffer; mediaType: PendingImageMediaType; id: string };
export type DropFailure = { ok: false; error: string };

function isErrno(err: unknown, code: string): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code: unknown }).code === code);
}

export function normalizeDroppedPaths(raw: unknown): { ok: true; paths: string[] } | DropFailure {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "no files" };
  if (raw.length > MAX_DROP_PATHS) return { ok: false, error: "too many files" };
  let total = 0;
  for (const item of raw) {
    if (typeof item !== "string" || item.length === 0) return { ok: false, error: "invalid dropped file" };
    const bytes = Buffer.byteLength(item, "utf8");
    if (bytes > MAX_PATH_BYTES) return { ok: false, error: "path is too long" };
    total += bytes;
    if (total > MAX_PATH_TOTAL_BYTES) return { ok: false, error: "paths are too large" };
    if (item.includes("\0") || item.includes("\r") || item.includes("\n")) return { ok: false, error: "invalid dropped file" };
    if (!isAbsolute(item)) return { ok: false, error: "invalid dropped file" };
  }
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const item of raw as string[]) {
    const normalized = normalize(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    paths.push(normalized);
  }
  if (paths.length === 0) return { ok: false, error: "no files" };
  return { ok: true, paths };
}

export async function validatePathDropTargets(paths: readonly string[]): Promise<{ ok: true } | DropFailure> {
  for (const path of paths) {
    try {
      await lstat(path);
    } catch {
      return { ok: false, error: "file not found" };
    }
  }
  return { ok: true };
}

export function quotePosixPaths(paths: readonly string[], platform: NodeJS.Platform): { ok: true; text: string } | DropFailure {
  if (platform !== "darwin" && platform !== "linux") return { ok: false, error: "unsupported platform" };
  const quoted = paths.map((path) => `'${path.replaceAll("'", "'\\''")}'`);
  return { ok: true, text: quoted.join(" ") };
}

export async function readStableImage(
  handle: Pick<FileHandle, "stat" | "read">,
  expectedSize: number,
): Promise<{ ok: true; bytes: Buffer } | DropFailure> {
  if (!Number.isInteger(expectedSize) || expectedSize <= 0 || expectedSize > MAX_IMAGE_BYTES) {
    return { ok: false, error: "image is too large" };
  }
  const bytes = Buffer.alloc(expectedSize);
  let offset = 0;
  while (offset < expectedSize) {
    const { bytesRead } = await handle.read(bytes, offset, expectedSize - offset, offset);
    if (bytesRead === 0) return { ok: false, error: "image changed while reading" };
    offset += bytesRead;
  }
  const probe = Buffer.alloc(1);
  const extra = await handle.read(probe, 0, 1, expectedSize);
  if (extra.bytesRead > 0) return { ok: false, error: "image changed while reading" };
  const after = await handle.stat();
  if (after.size !== expectedSize) return { ok: false, error: "image changed while reading" };
  return { ok: true, bytes };
}

function mediaTypeFor(name: string, bytes: Buffer): PendingImageMediaType | null {
  const lower = name.toLowerCase();
  const ext = lower.endsWith(".jpeg") || lower.endsWith(".jpg")
    ? "jpeg"
    : lower.endsWith(".png")
      ? "png"
      : lower.endsWith(".webp")
        ? "webp"
        : lower.endsWith(".gif")
          ? "gif"
          : null;
  if (!ext) return null;
  if (ext === "png") return bytes.subarray(0, 8).equals(PNG_SIG) ? "image/png" : null;
  if (ext === "jpeg") return bytes.length >= 3 && bytes.subarray(0, 3).equals(JPEG_SIG) ? "image/jpeg" : null;
  if (ext === "gif") {
    const head = bytes.subarray(0, 6);
    return head.equals(GIF87) || head.equals(GIF89) ? "image/gif" : null;
  }
  if (bytes.length < 12) return null;
  if (bytes.subarray(0, 4).toString("ascii") !== "RIFF") return null;
  if (bytes.subarray(8, 12).toString("ascii") !== "WEBP") return null;
  return "image/webp";
}

export async function readDroppedImages(
  paths: readonly string[],
  remaining: number,
): Promise<{ ok: true; images: DropImage[] } | DropFailure> {
  if (!Number.isInteger(remaining) || remaining < 0 || remaining > MAX_PENDING_IMAGES) {
    return { ok: false, error: "too many pending images" };
  }
  if (remaining === 0) return { ok: false, error: "too many pending images" };
  const opened: Array<{ handle: FileHandle; path: string; size: number; id: string }> = [];
  const seen = new Set<string>();
  try {
    for (const path of paths) {
      let handle: FileHandle;
      try {
        handle = await open(path, OPEN_NOFOLLOW_READ);
      } catch (err) {
        if (isErrno(err, "ELOOP") || isErrno(err, "EPERM")) return { ok: false, error: "invalid dropped file" };
        return { ok: false, error: "file not found" };
      }
      try {
        const st = await handle.stat();
        if (!st.isFile()) {
          await handle.close();
          return { ok: false, error: "invalid dropped file" };
        }
        if (st.size === 0) {
          await handle.close();
          return { ok: false, error: "image is empty" };
        }
        if (st.size > MAX_IMAGE_BYTES) {
          await handle.close();
          return { ok: false, error: "image is too large" };
        }
        const identity = `${st.dev}:${st.ino}`;
        if (seen.has(identity)) {
          await handle.close();
          continue;
        }
        seen.add(identity);
        opened.push({ handle, path, size: st.size, id: identity });
      } catch (err) {
        await handle.close().catch(() => undefined);
        throw err;
      }
    }
    if (opened.length > remaining) return { ok: false, error: "too many pending images" };
    let total = 0;
    for (const item of opened) total += item.size;
    if (total > MAX_BATCH_BYTES) return { ok: false, error: "image is too large" };
    const images: DropImage[] = [];
    for (const item of opened) {
      const read = await readStableImage(item.handle, item.size);
      if (!read.ok) return read;
      const mediaType = mediaTypeFor(item.path, read.bytes);
      if (!mediaType) return { ok: false, error: "unsupported image type" };
      images.push({ bytes: read.bytes, mediaType, id: randomUUID() });
    }
    return { ok: true, images };
  } catch {
    return { ok: false, error: "invalid dropped file" };
  } finally {
    for (const item of opened) await item.handle.close().catch(() => undefined);
  }
}

export function isAuthorizedDropSender(
  event: Pick<Electron.IpcMainInvokeEvent, "sender" | "senderFrame">,
  win: Electron.BrowserWindow | null,
): boolean {
  try {
    if (!win || win.isDestroyed()) return false;
    if (win.webContents.isDestroyed() || event.sender !== win.webContents) return false;
    const frame = event.senderFrame;
    if (!frame) return false;
    return frame === win.webContents.mainFrame;
  } catch {
    return false;
  }
}
