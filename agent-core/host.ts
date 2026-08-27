/**
 * Termina host adapter for agent-core.
 *
 * Same sidecar file names as the app bridge: ack, prompt payload,
 * verify/edits/mine/mailbox context, startup-control. The parser stays
 * electron/sidecar.ts. This module is the kernel writer of that protocol.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { HAS_UNCHECKED_PLAN_TASK } from "../shared/plan-task.ts";

const ACK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CONTEXT_FILES = ["verify", "edits", "mine", "mailbox"] as const;
const PLAN_TEXT_CAP = 4000;
export const HOST_CONTEXT_BYTES = 64 * 1024;

export function ackPath(eventsDir: string, terminalId: string, requestId: string): string {
  return join(eventsDir, `ack-${terminalId}-${requestId}.json`);
}

export async function waitForAck(
  eventsDir: string,
  terminalId: string,
  requestId: string,
  timeoutMs: number,
  bridgeId: string,
  opts?: { shouldStop?: () => boolean },
): Promise<Record<string, unknown> | null> {
  if (!eventsDir || !terminalId || !ACK_ID.test(requestId) || !ACK_ID.test(terminalId)) return null;
  const target = ackPath(eventsDir, terminalId, requestId);
  const claimed = `${target}.claimed-${bridgeId}`;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (opts?.shouldStop?.()) return null;
    try {
      renameSync(target, claimed);
      try {
        const raw = readFileSync(claimed, "utf8");
        return JSON.parse(raw) as Record<string, unknown>;
      } finally {
        rmSync(claimed, { force: true });
      }
    } catch {
      /* not written yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

export function readContextFiles(eventsDir: string, terminalId: string): string {
  if (!eventsDir || !terminalId) return "";
  const parts: string[] = [];
  const separator = "\n\n---\n\n";
  let remaining = HOST_CONTEXT_BYTES;
  let truncated = false;
  for (const kind of CONTEXT_FILES) {
    if (remaining <= 0) break;
    const path = join(eventsDir, `${kind}-${terminalId}.md`);
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      if (parts.length > 0) remaining -= Buffer.byteLength(separator);
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const fileSize = fstatSync(fd).size;
      const size = Math.min(fileSize, remaining);
      if (fileSize > size) truncated = true;
      const buf = Buffer.alloc(size);
      const read = size > 0 ? readSync(fd, buf, 0, size, 0) : 0;
      const text = buf.subarray(0, read).toString("utf8");
      if (text) parts.push(text);
      remaining -= read;
    } catch {
      /* missing context file */
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  const text = parts.join(separator);
  if (!truncated) return text;
  const marker = Buffer.from("\n[host context truncated]", "utf8");
  const body = Buffer.from(text, "utf8");
  return Buffer.concat([body.subarray(0, Math.max(0, HOST_CONTEXT_BYTES - marker.length)), marker]).toString("utf8");
}

export function writePromptPayload(
  eventsDir: string,
  terminalId: string,
  fileName: string,
  payload: { prompt: string; context: string; images?: unknown[] },
): string | null {
  if (!eventsDir || !terminalId || !fileName || fileName.includes("/") || fileName.includes("\\")) return null;
  try {
    mkdirSync(eventsDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(eventsDir, fileName),
      JSON.stringify({ prompt: payload.prompt, images: payload.images ?? [], context: payload.context }),
      { mode: 0o600 },
    );
    return fileName;
  } catch {
    return null;
  }
}

export function promptFileName(terminalId: string, bridgeId: string, stamp: string): string {
  return `prompt-${terminalId}-${bridgeId.slice(0, 8)}-${stamp}.json`;
}

export type StartupControl = {
  opId: string;
  action: string;
  text?: string;
  content?: unknown;
};

function parseControl(raw: string): StartupControl | null {
  let rec: unknown;
  try {
    rec = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
  const obj = rec as Record<string, unknown>;
  return {
    opId: typeof obj.opId === "string" ? obj.opId : "",
    action: typeof obj.action === "string" ? obj.action : "",
    text: typeof obj.text === "string" ? obj.text : undefined,
    content: obj.content,
  };
}

function claimControlFile(path: string, bridgeId: string): StartupControl | null {
  const claimed = `${path}.claimed-${bridgeId}`;
  try {
    renameSync(path, claimed);
  } catch {
    return null;
  }
  try {
    return parseControl(readFileSync(claimed, "utf8"));
  } catch {
    return null;
  } finally {
    rmSync(claimed, { force: true });
  }
}

/** Consume startup-control-<id>.json, then startup-control.json. */
export function consumeStartupControl(
  eventsDir: string,
  terminalId: string,
  bridgeId: string,
): StartupControl | null {
  if (!eventsDir || !terminalId) return null;
  return (
    claimControlFile(join(eventsDir, `startup-control-${terminalId}.json`), bridgeId) ??
    claimControlFile(join(eventsDir, "startup-control.json"), bridgeId)
  );
}

export function structuredStartupText(control: StartupControl): string {
  if (Array.isArray(control.content)) {
    const parts: string[] = [];
    for (const item of control.content) {
      if (typeof item === "string" && item) parts.push(item);
      else if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
        const text = (item as { text: string }).text;
        if (text) parts.push(text);
      }
    }
    return parts.join("\n");
  }
  return control.text ?? "";
}

export function visibleAssistantText(blocks: Array<{ type?: string; text?: string }>): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "thinking" || b.type === "reasoning" || b.type === "redacted_thinking") continue;
    if (typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

export function firstPlanText(text: string): string | null {
  if (!text.trim() || !HAS_UNCHECKED_PLAN_TASK.test(text)) return null;
  return text.slice(0, PLAN_TEXT_CAP);
}

export function planTextIfChanged(text: string, lastEmitted: string): string | null {
  const plan = firstPlanText(text);
  if (!plan || plan === lastEmitted) return null;
  return plan;
}

export const MAX_PENDING_IMAGES = 4;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const PENDING_IMAGE_NAME = /^image-[A-Za-z0-9._-]+\.(png|jpe?g|webp|gif)$/;
const STORED_IMAGE_NAME = /^[A-Za-z0-9._-]+-img-[1-9][0-9]{0,3}\.(png|jpe?g|webp|gif)$/;

export type ImageRef = { name: string; mediaType: string };
export type LoadedImage = ImageRef & { bytes: Buffer };

export function isSafeImageName(name: string): boolean {
  return PENDING_IMAGE_NAME.test(name) || STORED_IMAGE_NAME.test(name);
}

export function mediaTypeOfName(name: string): string {
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

export function pendingImagesPath(eventsDir: string, terminalId: string): string {
  return join(eventsDir, `images-${terminalId}.json`);
}

function readImageList(path: string): ImageRef[] {
  try {
    const rec = JSON.parse(readFileSync(path, "utf8")) as { images?: unknown };
    if (!Array.isArray(rec.images)) return [];
    const out: ImageRef[] = [];
    for (const item of rec.images) {
      if (!item || typeof item !== "object") continue;
      const name = (item as { name?: unknown }).name;
      const mediaType = (item as { mediaType?: unknown }).mediaType;
      if (typeof name !== "string" || !isSafeImageName(name)) continue;
      out.push({
        name,
        mediaType: typeof mediaType === "string" && mediaType.startsWith("image/") ? mediaType : mediaTypeOfName(name),
      });
      if (out.length >= MAX_PENDING_IMAGES) break;
    }
    return out;
  } catch {
    return [];
  }
}

export function peekPendingImages(eventsDir: string, terminalId: string): ImageRef[] {
  if (!eventsDir || !terminalId) return [];
  return readImageList(pendingImagesPath(eventsDir, terminalId));
}

export function peekPendingImageCount(eventsDir: string, terminalId: string): number {
  return peekPendingImages(eventsDir, terminalId).length;
}

function extForMedia(mediaType: string): string {
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/webp") return "webp";
  if (mediaType === "image/gif") return "gif";
  return "png";
}

/** Append one clipboard image to the pending list. Main is the writer. */
export function appendPendingImage(
  eventsDir: string,
  terminalId: string,
  bytes: Buffer,
  mediaType: string,
  id: string,
): { ok: true; count: number; name: string } | { ok: false; error: string } {
  if (!eventsDir || !terminalId) return { ok: false, error: "no events directory" };
  if (!ACK_ID.test(terminalId) || !ACK_ID.test(id)) return { ok: false, error: "invalid id" };
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return { ok: false, error: "image is too large" };
  const kind = mediaType.startsWith("image/") ? mediaType : "image/png";
  const name = `image-${terminalId}-${id}.${extForMedia(kind)}`;
  if (!PENDING_IMAGE_NAME.test(name)) return { ok: false, error: "invalid image name" };
  try {
    mkdirSync(eventsDir, { recursive: true, mode: 0o700 });
    const listPath = pendingImagesPath(eventsDir, terminalId);
    const list = readImageList(listPath);
    if (list.length >= MAX_PENDING_IMAGES) return { ok: true, count: list.length, name: list[list.length - 1]!.name };
    writeFileSync(join(eventsDir, name), bytes, { mode: 0o600 });
    list.push({ name, mediaType: kind });
    const tmp = `${listPath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ images: list }), { mode: 0o600 });
    renameSync(tmp, listPath);
    return { ok: true, count: list.length, name };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function loadImageBytes(dir: string, name: string): Buffer | null {
  if (!isSafeImageName(name)) return null;
  try {
    const realDir = realpathSync(dir);
    const realFile = realpathSync(join(dir, name));
    const rel = relative(realDir, realFile);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    const info = statSync(realFile);
    if (!info.isFile() || info.size === 0 || info.size > MAX_IMAGE_BYTES) return null;
    return readFileSync(realFile);
  } catch {
    return null;
  }
}

export function consumePendingImages(eventsDir: string, terminalId: string): LoadedImage[] {
  if (!eventsDir || !terminalId) return [];
  const listPath = pendingImagesPath(eventsDir, terminalId);
  const list = readImageList(listPath);
  const out: LoadedImage[] = [];
  for (const ref of list) {
    const bytes = loadImageBytes(eventsDir, ref.name);
    if (bytes) out.push({ ...ref, bytes });
  }
  try {
    rmSync(listPath, { force: true });
  } catch {
    /* ignore */
  }
  return out;
}

export function removePendingImageFiles(eventsDir: string, names: string[]): void {
  if (!eventsDir) return;
  for (const name of names) {
    if (!isSafeImageName(name)) continue;
    try {
      rmSync(join(eventsDir, name), { force: true });
    } catch {
      /* ignore */
    }
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
): ImageRef {
  if (!sessionFile || index < 1) return { name: img.name, mediaType: img.mediaType };
  if (STORED_IMAGE_NAME.test(img.name)) return { name: img.name, mediaType: img.mediaType };
  const dir = dirname(sessionFile);
  const stem = basename(sessionFile, ".jsonl") || "session";
  const ext = extForMedia(img.mediaType);
  let n = Math.max(1, index);
  let name = `${stem}-img-${n}.${ext}`;
  while (existsSync(join(dir, name)) && n < 99) {
    n += 1;
    name = `${stem}-img-${n}.${ext}`;
  }
  if (!STORED_IMAGE_NAME.test(name) || existsSync(join(dir, name))) {
    return { name: img.name, mediaType: img.mediaType };
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, name), img.bytes, { mode: 0o600 });
    return { name, mediaType: img.mediaType };
  } catch {
    return { name: img.name, mediaType: img.mediaType };
  }
}

export function persistLoadedImages(sessionFile: string | null, images: LoadedImage[]): ImageRef[] {
  return images.map((img, i) => persistSessionImage(sessionFile, img, i + 1));
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


