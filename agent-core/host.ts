/**
 * Termina host adapter for agent-core.
 *
 * Same sidecar file names as the app bridge: ack, prompt payload,
 * verify/edits/mailbox context, machine-only Mine policy, startup-control. The parser stays
 * electron/sidecar.ts. This module is the kernel writer of that protocol.
 */
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync, constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { HAS_PLAN_TASK } from "../shared/plan-task.ts";
import type { FileHandle } from "node:fs/promises";
import { BoundedTextAccumulator, type BoundedText, type BoundedTextMarkerDetails, type CompletionState } from "./tool-output.ts";

const ACK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CONTEXT_FILES = ["verify", "edits", "mailbox"] as const;
const PROTECTED_PATHS_BYTES = 64 * 1024;
const PLAN_TEXT_CAP = 4000;
export const HOST_CONTEXT_BYTES = 64 * 1024;
const HOST_CONTEXT_READ_CHUNK_BYTES = 16 * 1024;

export type ReadContextFilesOptions = {
  shouldStop?: () => boolean;
};

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

function hostContextMarker(details: BoundedTextMarkerDetails): string {
  return details.state === "complete"
    ? "[host context truncated]"
    : `[host context incomplete: ${details.state}]`;
}

function mergeContextState(current: CompletionState, next: CompletionState): CompletionState {
  if (current === "interrupted" || next === "interrupted") return "interrupted";
  if (current === "failed" || next === "failed") return "failed";
  if (current === "unreadable" || next === "unreadable") return "unreadable";
  return "complete";
}

function probeContextStop(options: ReadContextFilesOptions | undefined): "continue" | CompletionState {
  if (!options?.shouldStop) return "continue";
  try {
    return options.shouldStop() ? "interrupted" : "continue";
  } catch {
    return "failed";
  }
}

function withKnownContextInput(result: BoundedText, inputBytes: number): BoundedText {
  if (result.inputBytes === inputBytes) return result;
  return Object.freeze({
    ...result,
    inputBytes,
    omittedBytes: Math.max(0, inputBytes - result.retainedBytes),
    truncated: result.truncated || inputBytes > result.retainedBytes,
  });
}

/** Read all available host context while keeping the rendered result bounded. */
export function readContextFilesResult(
  eventsDir: string,
  terminalId: string,
  options?: ReadContextFilesOptions,
): BoundedText {
  const accumulator = new BoundedTextAccumulator({
    maxBytes: HOST_CONTEXT_BYTES,
    direction: "head",
    marker: hostContextMarker,
  });
  if (!eventsDir || !terminalId) return accumulator.finish();

  const separator = "\n\n---\n\n";
  const separatorBytes = Buffer.byteLength(separator, "utf8");
  let state: CompletionState = "complete";
  const files: Array<{ fd: number; size: number }> = [];

  const closeFiles = (): void => {
    for (const file of files.splice(0)) {
      try {
        closeSync(file.fd);
      } catch {
        state = mergeContextState(state, "unreadable");
      }
    }
  };

  if (OPEN_NOFOLLOW_READ === null) return accumulator.finish("unreadable");

  // Stat every readable context entry first. This gives the bounded reader an
  // exact remaining-byte count without scanning a multi-gigabyte file.
  for (const kind of CONTEXT_FILES) {
    const initialProbe = probeContextStop(options);
    if (initialProbe !== "continue") {
      state = mergeContextState(state, initialProbe);
      break;
    }

    let fd: number | undefined;
    try {
      fd = openSync(join(eventsDir, `${kind}-${terminalId}.md`), OPEN_NOFOLLOW_READ);
      const info = fstatSync(fd);
      if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 0) {
        state = mergeContextState(state, "unreadable");
        continue;
      }
      files.push({ fd, size: info.size });
      fd = undefined;
    } catch (error) {
      if (!isErrno(error, "ENOENT")) state = mergeContextState(state, "unreadable");
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          state = mergeContextState(state, "unreadable");
        }
      }
    }
    if (state === "interrupted" || state === "failed") break;
  }

  if (state === "interrupted" || state === "failed") {
    closeFiles();
    return accumulator.finish(state);
  }

  let knownInputBytes = 0;
  let nonEmptyFiles = 0;
  for (const file of files) {
    if (file.size <= 0) continue;
    if (nonEmptyFiles > 0) knownInputBytes += separatorBytes;
    knownInputBytes += file.size;
    nonEmptyFiles += 1;
  }

  const needsBoundedRead = knownInputBytes > HOST_CONTEXT_BYTES;
  // Read only a few bytes beyond the output budget. The extra bytes let the
  // canonical accumulator observe omission even when the cap falls exactly on
  // a UTF-8 boundary or at the end of a context file.
  const prefixReadLimit = HOST_CONTEXT_BYTES + separatorBytes + 4;
  let streamedBytes = 0;
  let hasContent = false;

  try {
    outer: for (const file of files) {
      let fileHadBytes = false;
      let readOffset = 0;
      while (readOffset < file.size) {
        const probe = probeContextStop(options);
        if (probe !== "continue") {
          state = mergeContextState(state, probe);
          break outer;
        }
        if (needsBoundedRead && streamedBytes >= prefixReadLimit) break outer;

        if (!fileHadBytes && hasContent) {
          accumulator.push(separator);
          streamedBytes += separatorBytes;
        }
        const remainingPrefix = needsBoundedRead ? Math.max(0, prefixReadLimit - streamedBytes) : file.size - readOffset;
        if (remainingPrefix <= 0) break outer;
        const want = Math.min(HOST_CONTEXT_READ_CHUNK_BYTES, file.size - readOffset, remainingPrefix);
        const buf = Buffer.allocUnsafe(want);
        const read = readSync(file.fd, buf, 0, want, readOffset);
        if (read <= 0) {
          state = mergeContextState(state, "failed");
          break outer;
        }
        accumulator.push(buf.subarray(0, read));
        fileHadBytes = true;
        hasContent = true;
        readOffset += read;
        streamedBytes += read;
      }

      if (state === "complete" && readOffset === file.size) {
        try {
          if (fstatSync(file.fd).size !== file.size) state = mergeContextState(state, "failed");
        } catch {
          state = mergeContextState(state, "unreadable");
        }
      }
      if (state === "interrupted" || state === "failed") break;
    }
  } finally {
    closeFiles();
  }

  const result = accumulator.finish(state);
  // The accumulator only sees the bounded prefix. For a complete read, stats
  // provide the exact source-byte total without retaining or scanning the
  // omitted suffix.
  return state === "complete" ? withKnownContextInput(result, knownInputBytes) : result;
}

/** Existing bridge contract: callers that only need text get the bounded view. */
export function readContextFiles(eventsDir: string, terminalId: string): string {
  return readContextFilesResult(eventsDir, terminalId).text;
}

/** Read the machine-only Mine policy used by mutation tool gates. */
export function readProtectedPaths(eventsDir: string, terminalId: string): ReadonlySet<string> {
  const paths = new Set<string>();
  if (!eventsDir || !ACK_ID.test(terminalId) || OPEN_NOFOLLOW_READ === null) return paths;
  let fd: number | undefined;
  try {
    fd = openSync(join(eventsDir, `mine-${terminalId}.json`), OPEN_NOFOLLOW_READ);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size <= 0 || info.size > PROTECTED_PATHS_BYTES) return paths;
    const data = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < data.length) {
      const count = readSync(fd, data, offset, data.length - offset, offset);
      if (count <= 0) return new Set();
      offset += count;
    }
    if (fstatSync(fd).size !== info.size) return new Set();
    const parsed = JSON.parse(data.toString("utf8"));
    if (!Array.isArray(parsed)) return paths;
    for (const value of parsed) {
      if (typeof value === "string" && isAbsolute(value) && value.length <= 4096) paths.add(value);
    }
  } catch {
    return new Set();
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
  return paths;
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
  if (!text.trim() || !HAS_PLAN_TASK.test(text)) return null;
  return text.slice(0, PLAN_TEXT_CAP);
}

export function planTextIfChanged(text: string, lastEmitted: string): string | null {
  const plan = firstPlanText(text);
  if (!plan || plan === lastEmitted) return null;
  return plan;
}

export const MAX_PENDING_IMAGES = 4;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_PENDING_IMAGE_BATCH_BYTES = MAX_PENDING_IMAGES * MAX_IMAGE_BYTES;
const PENDING_IMAGE_NAME = /^image-[A-Za-z0-9._-]+\.(png|jpe?g|webp|gif)$/;
const STORED_IMAGE_NAME = /^[A-Za-z0-9._-]+-img-[1-9][0-9]{0,3}\.(png|jpe?g|webp|gif)$/;
const STAGE_IMAGE_NAME = /^image-[A-Za-z0-9._-]+\.(png|jpe?g|webp|gif)\.stage-[A-Za-z0-9_-]+$/;
const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const IMAGE_LOCK_WAIT_MS = 250;
const IMAGE_LOCK_STALE_MS = 5_000;
const MAX_IMAGE_RECORD_BYTES = 16 * 1024;
const IMAGE_CLEANUP_MAX = 32;
const OPEN_NOFOLLOW_READ: number | null = typeof fsConstants.O_NOFOLLOW === "number"
  ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
  : null;
const OPEN_EXCL_WRITE = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;
const NAMED_NONCE = "([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[A-Za-z_][A-Za-z0-9_]*)";
const OWNER_NAME = new RegExp(`^images-owner-(.+?)-([0-9]+)-([0-9]+)-${NAMED_NONCE}$`);
const CLAIM_NAME = new RegExp(`^images-claim-(.+?)-([0-9]+)-([0-9]+)-${NAMED_NONCE}\\.json$`);
const TX_NAME = new RegExp(`^images-tx-(.+?)-([0-9]+)-([0-9]+)-${NAMED_NONCE}\\.json$`);
const MANIFEST_TMP_NAME = /^images-[A-Za-z0-9_-]+\.json\.tmp-[A-Za-z0-9_-]+$/;
const QUARANTINE_NAME = /^images-[A-Za-z0-9_-]+\.quarantine-[A-Za-z0-9_-]+$/;

export type ImageRef = { name: string; mediaType: string };
export type LoadedImage = ImageRef & { bytes: Buffer };
export type PendingImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";
export type PendingImageInput = { bytes: Buffer; mediaType: PendingImageMediaType; id: string };
export type PendingImageResult =
  | { ok: true; count: number; names: string[] }
  | { ok: false; error: string };
export type PendingImageClaim = { claimId: string; images: LoadedImage[] };
export type PendingImageStateResult =
  | { ok: true; count: number; hasImages: boolean }
  | { ok: false; error: string };
export type PendingImageClaimResult =
  | { ok: true; claim: PendingImageClaim }
  | { ok: false; error: string };

type OwnerRecord = { pid: number; createdAt: number; nonce: string };
type ProducerTx = {
  terminalId: string;
  pid: number;
  createdAt: number;
  nonce: string;
  staged: string[];
  final: string[];
};
type NamedParts = { terminalId: string; pid: number; createdAt: number; nonce: string };

class PendingImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PendingImageError";
  }
}

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

function extForMedia(mediaType: string): string {
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/webp") return "webp";
  if (mediaType === "image/gif") return "gif";
  return "png";
}

function isErrno(err: unknown, code: string): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code: unknown }).code === code);
}

function queueFail(error: string): never {
  throw new PendingImageError(error);
}

function queueError(err: unknown): { ok: false; error: string } {
  if (err instanceof PendingImageError) return { ok: false, error: err.message };
  return { ok: false, error: "image queue is invalid" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAllowedMediaType(value: string): value is PendingImageMediaType {
  return MEDIA_TYPES.has(value);
}

function parseNamedParts(name: string, re: RegExp): NamedParts | null {
  const m = re.exec(name);
  if (!m) return null;
  const terminalId = m[1] ?? "";
  const pid = Number(m[2]);
  const createdAt = Number(m[3]);
  const nonce = m[4] ?? "";
  if (!ACK_ID.test(terminalId) || !ACK_ID.test(nonce)) return null;
  if (!Number.isInteger(pid) || pid < 0 || !Number.isInteger(createdAt) || createdAt < 0) return null;
  return { terminalId, pid, createdAt, nonce };
}

function lockPath(eventsDir: string, terminalId: string): string {
  return join(eventsDir, `images-${terminalId}.lock`);
}

function isStageName(name: string): boolean {
  return STAGE_IMAGE_NAME.test(name);
}

function isClaimName(name: string, terminalId: string): boolean {
  const parsed = parseNamedParts(name, CLAIM_NAME);
  return Boolean(parsed && parsed.terminalId === terminalId);
}

function isOwnerName(name: string, terminalId?: string): boolean {
  const parsed = parseNamedParts(name, OWNER_NAME);
  if (!parsed) return false;
  return terminalId ? parsed.terminalId === terminalId : ACK_ID.test(parsed.terminalId);
}

function isCleanupName(name: string, terminalId: string): boolean {
  if (isOwnerName(name, terminalId) || isStageName(name)) return true;
  if (MANIFEST_TMP_NAME.test(name) && name.startsWith(`images-${terminalId}.json.tmp-`)) return true;
  if (QUARANTINE_NAME.test(name) && name.startsWith(`images-${terminalId}.quarantine-`)) return true;
  const tx = parseNamedParts(name, TX_NAME);
  return Boolean(tx && tx.terminalId === terminalId);
}

function isDeadPid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return isErrno(err, "ESRCH");
  }
}

async function openNoFollow(path: string): Promise<FileHandle> {
  if (OPEN_NOFOLLOW_READ === null) throw new Error("secure no-follow reads unavailable");
  return open(path, OPEN_NOFOLLOW_READ);
}

async function writeExclusiveFile(path: string, data: Buffer | string): Promise<void> {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const fh = await open(path, OPEN_EXCL_WRITE, 0o600);
  try {
    let offset = 0;
    while (offset < buf.length) {
      const { bytesWritten } = await fh.write(buf, offset, buf.length - offset, offset);
      if (bytesWritten === 0) queueFail("image queue is invalid");
      offset += bytesWritten;
    }
    await fh.sync();
  } catch (err) {
    await fh.close().catch(() => undefined);
    await unlinkRegular(path);
    throw err;
  }
  await fh.close();
}

async function readCappedRecord(path: string): Promise<{ ok: true; raw: string } | { ok: false; reason: "missing" | "invalid" }> {
  let fh: FileHandle | undefined;
  try {
    fh = await openNoFollow(path);
    const st = await fh.stat();
    if (!st.isFile()) return { ok: false, reason: "invalid" };
    if (st.size > MAX_IMAGE_RECORD_BYTES) return { ok: false, reason: "invalid" };
    const buf = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < st.size) {
      const { bytesRead } = await fh.read(buf, offset, st.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== st.size) return { ok: false, reason: "invalid" };
    return { ok: true, raw: buf.toString("utf8") };
  } catch (err) {
    if (isErrno(err, "ENOENT")) return { ok: false, reason: "missing" };
    return { ok: false, reason: "invalid" };
  } finally {
    if (fh) await fh.close().catch(() => undefined);
  }
}

function parseImageRefs(raw: string): ImageRef[] | null {
  let rec: unknown;
  try {
    rec = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
  const images = (rec as { images?: unknown }).images;
  if (!Array.isArray(images) || images.length > MAX_PENDING_IMAGES) return null;
  const out: ImageRef[] = [];
  for (const item of images) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const name = (item as { name?: unknown }).name;
    const mediaType = (item as { mediaType?: unknown }).mediaType;
    if (typeof name !== "string" || !isSafeImageName(name)) return null;
    if (typeof mediaType !== "string" || !mediaType.startsWith("image/")) return null;
    out.push({ name, mediaType });
  }
  return out;
}

function parseOwnerRecord(raw: string): OwnerRecord | null {
  let rec: unknown;
  try {
    rec = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
  const pid = (rec as { pid?: unknown }).pid;
  const createdAt = (rec as { createdAt?: unknown }).createdAt;
  const nonce = (rec as { nonce?: unknown }).nonce;
  if (!Number.isInteger(pid) || (pid as number) < 0) return null;
  if (!Number.isInteger(createdAt) || (createdAt as number) < 0) return null;
  if (typeof nonce !== "string" || !ACK_ID.test(nonce)) return null;
  return { pid: pid as number, createdAt: createdAt as number, nonce };
}

function parseTxRecord(raw: string, terminalId: string): ProducerTx | null {
  let rec: unknown;
  try {
    rec = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
  const obj = rec as Record<string, unknown>;
  if (obj.terminalId !== terminalId || typeof obj.terminalId !== "string") return null;
  if (!Number.isInteger(obj.pid) || (obj.pid as number) < 0) return null;
  if (!Number.isInteger(obj.createdAt) || (obj.createdAt as number) < 0) return null;
  if (typeof obj.nonce !== "string" || !ACK_ID.test(obj.nonce)) return null;
  if (!Array.isArray(obj.staged) || !Array.isArray(obj.final)) return null;
  const staged: string[] = [];
  const final: string[] = [];
  for (const name of obj.staged) {
    if (typeof name !== "string" || !isStageName(name)) return null;
    staged.push(name);
  }
  for (const name of obj.final) {
    if (typeof name !== "string" || !isSafeImageName(name)) return null;
    final.push(name);
  }
  return {
    terminalId,
    pid: obj.pid as number,
    createdAt: obj.createdAt as number,
    nonce: obj.nonce,
    staged,
    final,
  };
}

async function quarantineRecord(eventsDir: string, terminalId: string, path: string): Promise<void> {
  const dest = join(eventsDir, `images-${terminalId}.quarantine-${randomUUID()}`);
  try {
    await rename(path, dest);
  } catch {
    /* The next locked operation retries quarantine. */
  }
}

async function readImageRecord(
  eventsDir: string,
  terminalId: string,
  path: string,
): Promise<{ images: ImageRef[] } | "missing"> {
  const got = await readCappedRecord(path);
  if (got.ok === false) {
    if (got.reason === "missing") return "missing";
    await quarantineRecord(eventsDir, terminalId, path);
    queueFail("image queue is invalid");
  }
  const images = parseImageRefs(got.raw);
  if (!images) {
    await quarantineRecord(eventsDir, terminalId, path);
    queueFail("image queue is invalid");
  }
  return { images };
}

async function sameFileIdentity(a: string, b: string): Promise<boolean> {
  let fa: FileHandle | undefined;
  let fb: FileHandle | undefined;
  try {
    fa = await openNoFollow(a);
    fb = await openNoFollow(b);
    const sa = await fa.stat();
    const sb = await fb.stat();
    return sa.isFile() && sb.isFile() && sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  } finally {
    if (fa) await fa.close().catch(() => undefined);
    if (fb) await fb.close().catch(() => undefined);
  }
}

async function unlinkRegular(path: string): Promise<boolean> {
  let fh: FileHandle | undefined;
  try {
    fh = await openNoFollow(path);
    const st = await fh.stat();
    if (!st.isFile()) return false;
  } catch (err) {
    return isErrno(err, "ENOENT");
  } finally {
    if (fh) await fh.close().catch(() => undefined);
  }
  try {
    await unlink(path);
    return true;
  } catch (err) {
    return isErrno(err, "ENOENT");
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    return !isErrno(err, "ENOENT");
  }
}

async function tryStealLock(lockFile: string): Promise<"stolen" | "busy" | "invalid"> {
  const first = await readCappedRecord(lockFile);
  if (first.ok === false) return first.reason === "missing" ? "stolen" : "invalid";
  const owner = parseOwnerRecord(first.raw);
  if (!owner) return "invalid";
  let fh: FileHandle | undefined;
  let ino: bigint | number | undefined;
  let dev: number | undefined;
  try {
    fh = await openNoFollow(lockFile);
    const st = await fh.stat();
    if (!st.isFile()) return "invalid";
    ino = st.ino;
    dev = st.dev;
  } catch {
    return "busy";
  } finally {
    if (fh) await fh.close().catch(() => undefined);
  }
  const second = await readCappedRecord(lockFile);
  if (second.ok === false) return second.reason === "missing" ? "stolen" : "invalid";
  const again = parseOwnerRecord(second.raw);
  if (!again || again.nonce !== owner.nonce) return "busy";
  let fh2: FileHandle | undefined;
  try {
    fh2 = await openNoFollow(lockFile);
    const st2 = await fh2.stat();
    if (!st2.isFile() || st2.ino !== ino || st2.dev !== dev) return "busy";
  } catch {
    return "busy";
  } finally {
    if (fh2) await fh2.close().catch(() => undefined);
  }
  if (Date.now() - owner.createdAt < IMAGE_LOCK_STALE_MS) return "busy";
  if (!isDeadPid(owner.pid)) return "busy";
  return (await unlinkRegular(lockFile)) ? "stolen" : "busy";
}

async function assertLockHeld(ownerFile: string, lockFile: string): Promise<void> {
  if (!(await sameFileIdentity(ownerFile, lockFile))) queueFail("image queue busy");
}

async function listDir(eventsDir: string): Promise<string[]> {
  try {
    return await readdir(eventsDir);
  } catch {
    return [];
  }
}

async function referencedFinalNames(eventsDir: string, terminalId: string): Promise<Set<string>> {
  const names = new Set<string>();
  const live = await readImageRecord(eventsDir, terminalId, pendingImagesPath(eventsDir, terminalId));
  if (live !== "missing") for (const ref of live.images) names.add(ref.name);
  for (const name of await listDir(eventsDir)) {
    if (!isClaimName(name, terminalId)) continue;
    const rec = await readImageRecord(eventsDir, terminalId, join(eventsDir, name));
    if (rec === "missing") continue;
    for (const ref of rec.images) names.add(ref.name);
  }
  return names;
}

async function queuedImageCount(eventsDir: string, terminalId: string): Promise<number> {
  const live = await readImageRecord(eventsDir, terminalId, pendingImagesPath(eventsDir, terminalId));
  let count = live === "missing" ? 0 : live.images.length;
  for (const name of await listDir(eventsDir)) {
    if (!isClaimName(name, terminalId)) continue;
    const rec = await readImageRecord(eventsDir, terminalId, join(eventsDir, name));
    if (rec !== "missing") count += rec.images.length;
  }
  return count;
}

async function recoverProducerTransactions(eventsDir: string, terminalId: string): Promise<void> {
  const referenced = await referencedFinalNames(eventsDir, terminalId);
  for (const name of await listDir(eventsDir)) {
    const parsed = parseNamedParts(name, TX_NAME);
    if (!parsed || parsed.terminalId !== terminalId) continue;
    const path = join(eventsDir, name);
    const got = await readCappedRecord(path);
    if (got.ok === false) {
      if (got.reason === "missing") continue;
      await quarantineRecord(eventsDir, terminalId, path);
      queueFail("image queue is invalid");
    }
    const tx = parseTxRecord(got.raw, terminalId);
    if (!tx) {
      await quarantineRecord(eventsDir, terminalId, path);
      queueFail("image queue is invalid");
    }
    let incomplete = false;
    for (const staged of tx.staged) {
      const target = join(eventsDir, staged);
      if (!(await unlinkRegular(target)) && (await pathExists(target))) incomplete = true;
    }
    for (const final of tx.final) {
      if (referenced.has(final)) continue;
      const target = join(eventsDir, final);
      if (!(await unlinkRegular(target)) && (await pathExists(target))) incomplete = true;
    }
    if (incomplete) queueFail("image queue is invalid");
    if (!(await unlinkRegular(path))) queueFail("image queue is invalid");
  }
}

async function cleanupStaleRecords(eventsDir: string, terminalId: string): Promise<void> {
  const names = await listDir(eventsDir);
  let examined = 0;
  const staleBefore = Date.now() - IMAGE_LOCK_STALE_MS;
  for (const name of names) {
    if (examined >= IMAGE_CLEANUP_MAX) break;
    if (!isCleanupName(name, terminalId)) continue;
    examined += 1;
    const path = join(eventsDir, name);
    let fh: FileHandle | undefined;
    try {
      fh = await openNoFollow(path);
      const st = await fh.stat();
      if (!st.isFile() || st.mtimeMs > staleBefore) continue;
    } catch {
      continue;
    } finally {
      if (fh) await fh.close().catch(() => undefined);
    }
    if (isOwnerName(name, terminalId)) {
      if (await sameFileIdentity(path, lockPath(eventsDir, terminalId))) continue;
    }
    if (parseNamedParts(name, TX_NAME)) continue;
    await unlinkRegular(path);
  }
}

export async function withPendingImageLock<T>(
  eventsDir: string,
  terminalId: string,
  fn: (assertHeld: () => Promise<void>) => Promise<T>,
): Promise<T> {
  if (!eventsDir) queueFail("no events directory");
  if (!ACK_ID.test(terminalId)) queueFail("invalid id");
  await mkdir(eventsDir, { recursive: true, mode: 0o700 });
  const pid = process.pid;
  const createdAt = Date.now();
  const nonce = randomUUID();
  const ownerFile = join(eventsDir, `images-owner-${terminalId}-${pid}-${createdAt}-${nonce}`);
  const lockFile = lockPath(eventsDir, terminalId);
  await writeExclusiveFile(ownerFile, JSON.stringify({ pid, createdAt, nonce }));
  const deadline = Date.now() + IMAGE_LOCK_WAIT_MS;
  let acquired = false;
  try {
    while (!acquired) {
      try {
        await link(ownerFile, lockFile);
        acquired = true;
        break;
      } catch (err) {
        if (isErrno(err, "EXDEV") || isErrno(err, "ENOSYS") || isErrno(err, "ENOTSUP")) {
          queueFail("image queue is invalid");
        }
        if (!isErrno(err, "EEXIST")) queueFail("image queue is invalid");
        const steal = await tryStealLock(lockFile);
        if (steal === "invalid") queueFail("image queue is invalid");
        if (steal === "stolen") continue;
        if (Date.now() >= deadline) queueFail("image queue busy");
        await sleep(Math.min(20, Math.max(1, deadline - Date.now())));
      }
    }
    const assertHeld = () => assertLockHeld(ownerFile, lockFile);
    await recoverProducerTransactions(eventsDir, terminalId);
    return await fn(assertHeld);
  } finally {
    if (acquired) {
      try {
        if (await sameFileIdentity(ownerFile, lockFile)) await unlink(lockFile);
      } catch {
        /* A successor may already own the lock. */
      }
    }
    await unlinkRegular(ownerFile);
  }
}

async function rollbackTransaction(eventsDir: string, tx: ProducerTx, txPath: string): Promise<void> {
  let incomplete = false;
  for (const staged of tx.staged) {
    const target = join(eventsDir, staged);
    if (!(await unlinkRegular(target)) && (await pathExists(target))) incomplete = true;
  }
  for (const final of tx.final) {
    const target = join(eventsDir, final);
    if (!(await unlinkRegular(target)) && (await pathExists(target))) incomplete = true;
  }
  if (!incomplete) await unlinkRegular(txPath);
}

async function loadClaimImage(eventsDir: string, name: string): Promise<Buffer> {
  if (!isSafeImageName(name)) queueFail("image queue is invalid");
  let fh: FileHandle | undefined;
  try {
    fh = await openNoFollow(join(eventsDir, name));
    const first = await fh.stat();
    if (!first.isFile() || first.size === 0 || first.size > MAX_IMAGE_BYTES) queueFail("image queue is invalid");
    const buf = Buffer.alloc(first.size);
    let offset = 0;
    while (offset < first.size) {
      const { bytesRead } = await fh.read(buf, offset, first.size - offset, offset);
      if (bytesRead === 0) queueFail("image queue is invalid");
      offset += bytesRead;
    }
    const probe = Buffer.alloc(1);
    const extra = await fh.read(probe, 0, 1, first.size);
    if (extra.bytesRead > 0) queueFail("image queue is invalid");
    const second = await fh.stat();
    if (second.size !== first.size) queueFail("image queue is invalid");
    return buf;
  } catch (err) {
    if (err instanceof PendingImageError) throw err;
    throw new PendingImageError("image queue is invalid");
  } finally {
    if (fh) await fh.close().catch(() => undefined);
  }
}

function emptyClaim(): PendingImageClaim {
  return { claimId: "", images: [] };
}

async function listAdoptableClaims(eventsDir: string, terminalId: string): Promise<Array<{ name: string; createdAt: number }>> {
  const out: Array<{ name: string; createdAt: number }> = [];
  for (const name of await listDir(eventsDir)) {
    const parsed = parseNamedParts(name, CLAIM_NAME);
    if (!parsed || parsed.terminalId !== terminalId) continue;
    if (parsed.pid !== process.pid && !isDeadPid(parsed.pid)) continue;
    out.push({ name, createdAt: parsed.createdAt });
  }
  out.sort((a, b) => a.createdAt - b.createdAt || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

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
