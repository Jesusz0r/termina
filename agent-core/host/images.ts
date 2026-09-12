/**
 * Pending-image lock and transaction core.
 *
 * Owns image constants/types, the pending-image lock, producer
 * transactions, and claim records. Split from agent-core/host.ts (issue #38).
 */
import { isErrno } from "../../shared/guards.ts";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { ACK_ID, OPEN_NOFOLLOW_READ } from "./context.ts";


export const MAX_PENDING_IMAGES = 4;

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export const MAX_PENDING_IMAGE_BATCH_BYTES = MAX_PENDING_IMAGES * MAX_IMAGE_BYTES;

export const PENDING_IMAGE_NAME = /^image-[A-Za-z0-9._-]+\.(png|jpe?g|webp|gif)$/;

export const STORED_IMAGE_NAME = /^[A-Za-z0-9._-]+-img-[1-9][0-9]{0,3}\.(png|jpe?g|webp|gif)$/;

const STAGE_IMAGE_NAME = /^image-[A-Za-z0-9._-]+\.(png|jpe?g|webp|gif)\.stage-[A-Za-z0-9_-]+$/;

const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const IMAGE_LOCK_WAIT_MS = 250;

const IMAGE_LOCK_STALE_MS = 5_000;

const MAX_IMAGE_RECORD_BYTES = 16 * 1024;

const IMAGE_CLEANUP_MAX = 32;

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

export type ProducerTx = {
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


export function extForMedia(mediaType: string): string {
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/webp") return "webp";
  if (mediaType === "image/gif") return "gif";
  return "png";
}


export function queueFail(error: string): never {
  throw new PendingImageError(error);
}


export function queueError(err: unknown): { ok: false; error: string } {
  if (err instanceof PendingImageError) return { ok: false, error: err.message };
  return { ok: false, error: "image queue is invalid" };
}


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


export function isAllowedMediaType(value: string): value is PendingImageMediaType {
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


export function isClaimName(name: string, terminalId: string): boolean {
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


export async function writeExclusiveFile(path: string, data: Buffer | string): Promise<void> {
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


export async function readImageRecord(
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


export async function unlinkRegular(path: string): Promise<boolean> {
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


export async function pathExists(path: string): Promise<boolean> {
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


export async function queuedImageCount(eventsDir: string, terminalId: string): Promise<number> {
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


export async function cleanupStaleRecords(eventsDir: string, terminalId: string): Promise<void> {
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


export async function rollbackTransaction(eventsDir: string, tx: ProducerTx, txPath: string): Promise<void> {
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


export async function loadClaimImage(eventsDir: string, name: string): Promise<Buffer> {
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


export function emptyClaim(): PendingImageClaim {
  return { claimId: "", images: [] };
}


export async function listAdoptableClaims(eventsDir: string, terminalId: string): Promise<Array<{ name: string; createdAt: number }>> {
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
