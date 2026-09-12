/**
 * Auth file store.
 *
 * Owns locked auth file reads, descriptor-bound writes, and provider
 * entry mutation. Split from agent-core/auth.ts (issue #38).
 */
import { errorCode, isRecord } from "../../shared/guards.ts";
import { randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { authPath } from "./endpoints.ts";
import { authDirectoryOpenFlags, authLockNoFollowFlags, authLockOwnerAlive, authPathBinding, authPathDirectoryIdentity, inspectAuthLock, recoverAuthLock, releaseAuthLock, resumeAuthLock, sameAuthPathIdentity, tryAcquireAuthLock, validateAuthPathBinding } from "./lock.ts";
import type { AuthPathBinding, AuthPathIdentity } from "./lock.ts";


type AuthFile = Record<string, unknown>;


let cached: { path: string; mtimeMs: number; data: AuthFile } | null = null;

export const refreshFlights = new Map<string, Promise<{ ok: true } | { ok: false; error: string }>>();


function withLock<T>(fn: (binding: AuthPathBinding) => T): T {
  const path = resolve(authPath());
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const binding = authPathBinding(path);
  const lock = `${path}.lock`;
  for (;;) {
    try {
      validateAuthPathBinding(binding);
      const acquired = tryAcquireAuthLock(lock, binding);
      if (acquired !== null) {
        try {
          return fn(binding);
        } finally {
          releaseAuthLock(lock, acquired);
        }
      }
    } catch (error) {
      if (errorCode(error) !== null || error instanceof Error) {
        if (!(error instanceof Error) || error.message !== "auth file busy") throw error;
      } else {
        throw error;
      }
    }
    const inspected = inspectAuthLock(lock);
    if (inspected === null) {
      if (resumeAuthLock(lock)) continue;
      throw new Error("auth file busy");
    }
    if (inspected.owner.pid === process.pid || authLockOwnerAlive(lock, inspected.owner)) {
      throw new Error("auth file busy");
    }
    if (!recoverAuthLock(lock, inspected)) throw new Error("auth file busy");
  }
}


export function readAuth(): { ok: true; data: AuthFile } | { ok: false; reason: "missing" | "corrupt" } {
  const path = resolve(authPath());
  if (!existsSync(path)) {
    cached = null;
    return { ok: false, reason: "missing" };
  }
  try {
    const st = statSync(path);
    if (cached && cached.path === path && cached.mtimeMs === st.mtimeMs) return { ok: true, data: cached.data };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      cached = null;
      return { ok: false, reason: "corrupt" };
    }
    cached = { path, mtimeMs: st.mtimeMs, data: parsed };
    return { ok: true, data: parsed };
  } catch {
    cached = null;
    return { ok: false, reason: "corrupt" };
  }
}


type AuthPathAnchors = {
  rootFd: number;
  parentFd: number;
  rootIdentity: AuthPathIdentity;
  parentIdentity: AuthPathIdentity;
};


function authDescriptorPath(fd: number): string {
  if (process.platform === "linux") return `/proc/self/fd/${fd}`;
  if (process.platform === "darwin") return `/dev/fd/${fd}`;
  throw new Error("auth path descriptor anchoring is unavailable");
}


function authAnchoredChildPath(fd: number, child: string): string {
  const directory = authDescriptorPath(fd);
  return child ? join(directory, child) : directory;
}


function authChildPath(binding: AuthPathBinding, anchors: AuthPathAnchors, child: string): string {
  // Linux exposes a traversable procfs descriptor namespace. macOS's fdescfs
  // permits duplicating /dev/fd/N but does not permit traversing it, so retain
  // the parent descriptor and revalidate the pathname around each operation.
  return process.platform === "linux"
    ? authAnchoredChildPath(anchors.parentFd, child)
    : join(binding.parent, child);
}


function authDirectoryDescriptorIdentity(fd: number, label: string): AuthPathIdentity {
  const stat = fstatSync(fd);
  if (!stat.isDirectory()) throw new Error(`auth ${label} descriptor is not a directory`);
  return { dev: stat.dev, ino: stat.ino };
}


function validateAuthPathAnchors(binding: AuthPathBinding, anchors: AuthPathAnchors): void {
  const rootDescriptor = authDirectoryDescriptorIdentity(anchors.rootFd, "root");
  const parentDescriptor = authDirectoryDescriptorIdentity(anchors.parentFd, "parent");
  const rootPath = authPathDirectoryIdentity(binding.root, "root");
  const parentPath = authPathDirectoryIdentity(binding.parent, "parent");
  const parentFromRootStat = lstatSync(
    process.platform === "linux"
      ? authAnchoredChildPath(anchors.rootFd, basename(binding.parent))
      : binding.parent,
  );
  if (
    !sameAuthPathIdentity(rootDescriptor, binding.rootIdentity)
    || !sameAuthPathIdentity(parentDescriptor, binding.parentIdentity)
    || !sameAuthPathIdentity(rootPath, binding.rootIdentity)
    || !sameAuthPathIdentity(parentPath, binding.parentIdentity)
    || !parentFromRootStat.isDirectory()
    || parentFromRootStat.isSymbolicLink()
    || parentFromRootStat.dev !== binding.parentIdentity.dev
    || parentFromRootStat.ino !== binding.parentIdentity.ino
  ) throw new Error("auth path parent changed while writing");
}


function openAuthPathAnchors(binding: AuthPathBinding): AuthPathAnchors {
  let rootFd: number | null = null;
  let parentFd: number | null = null;
  try {
    rootFd = openSync(binding.root, authDirectoryOpenFlags());
    const rootIdentity = authDirectoryDescriptorIdentity(rootFd, "root");
    parentFd = openSync(
      process.platform === "linux"
        ? authAnchoredChildPath(rootFd, basename(binding.parent))
        : binding.parent,
      authDirectoryOpenFlags(),
    );
    const parentIdentity = authDirectoryDescriptorIdentity(parentFd, "parent");
    const anchors = { rootFd, parentFd, rootIdentity, parentIdentity };
    validateAuthPathAnchors(binding, anchors);
    return anchors;
  } catch (error) {
    if (parentFd !== null) closeSync(parentFd);
    if (rootFd !== null) closeSync(rootFd);
    throw error;
  }
}


function closeAuthPathAnchors(anchors: AuthPathAnchors): void {
  try { closeSync(anchors.parentFd); } finally { closeSync(anchors.rootFd); }
}


function validateAuthTempDescriptor(
  fd: number,
  tempPath: string,
  binding: AuthPathBinding,
  anchors: AuthPathAnchors,
  expected: AuthPathIdentity | null,
): AuthPathIdentity {
  validateAuthPathAnchors(binding, anchors);
  const descriptor = fstatSync(fd);
  if (!descriptor.isFile()) throw new Error("auth temporary file is not regular");
  if (descriptor.nlink !== 1) throw new Error("auth temp has unexpected hard links");
  if ((descriptor.mode & 0o777) !== 0o600) throw new Error("auth temporary file permissions changed");
  const identity = { dev: descriptor.dev, ino: descriptor.ino };
  if (expected !== null && !sameAuthPathIdentity(identity, expected)) {
    throw new Error("auth temporary file changed while writing");
  }
  const entry = lstatSync(tempPath);
  if (
    !entry.isFile()
    || entry.isSymbolicLink()
    || entry.nlink !== 1
    || (entry.mode & 0o777) !== 0o600
    || entry.dev !== identity.dev
    || entry.ino !== identity.ino
  ) throw new Error("auth temporary file changed while writing");
  return identity;
}


function truncateAuthDescriptor(fd: number): void {
  try {
    ftruncateSync(fd, 0);
    fsyncSync(fd);
  } catch {
    /* Keep the original descriptor open for exact cleanup; callers fail closed. */
  }
}


type AuthWriteTestStage = "after-open" | "after-fsync" | "after-temp";


function maybeCrashAuthWrite(stage: AuthWriteTestStage): void {
  if (process.env.TERMINA_CORE_TEST !== "1" || process.env.TERMINA_AUTH_WRITE_CRASH !== stage) return;
  process.kill(process.pid, "SIGKILL");
}


function maybePauseAuthWrite(stage: AuthWriteTestStage): void {
  if (process.env.TERMINA_CORE_TEST !== "1" || process.env.TERMINA_AUTH_WRITE_PAUSE !== stage) return;
  const marker = process.env.TERMINA_AUTH_WRITE_PAUSED?.trim();
  const resume = process.env.TERMINA_AUTH_WRITE_RESUME?.trim();
  if (!marker || !resume) throw new Error("auth write pause requires marker and resume paths");
  writeFileSync(marker, "paused\n", { mode: 0o600, flag: "wx" });
  while (!existsSync(resume)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}


function writeAuth(data: AuthFile, binding: AuthPathBinding): void {
  const path = binding.path;
  validateAuthPathBinding(binding);
  const tmp = join(binding.parent, `.${basename(path)}.tmp-${process.pid}-${randomBytes(16).toString("hex")}`);
  const anchoredTempName = basename(tmp);
  const anchoredDestinationName = basename(path);
  const bytes = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, "utf8");
  const anchors = openAuthPathAnchors(binding);
  const tempPath = authChildPath(binding, anchors, anchoredTempName);
  const destinationPath = authChildPath(binding, anchors, anchoredDestinationName);
  let fd: number | null = null;
  let tempCreated = false;
  let tempIdentity: AuthPathIdentity | null = null;
  let published = false;
  try {
    fd = openSync(
      tempPath,
      authLockNoFollowFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL),
      0o600,
    );
    tempCreated = true;
    tempIdentity = validateAuthTempDescriptor(fd, tempPath, binding, anchors, null);
    maybePauseAuthWrite("after-open");
    tempIdentity = validateAuthTempDescriptor(fd, tempPath, binding, anchors, tempIdentity);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error("auth temporary file write made no progress");
      offset += written;
    }
    fsyncSync(fd);
    maybeCrashAuthWrite("after-fsync");
    maybePauseAuthWrite("after-temp");
    validateAuthTempDescriptor(fd, tempPath, binding, anchors, tempIdentity);
    renameSync(tempPath, destinationPath);
    validateAuthPathAnchors(binding, anchors);
    const destination = lstatSync(destinationPath);
    const afterPublish = fstatSync(fd);
    if (
      !destination.isFile()
      || destination.isSymbolicLink()
      || destination.nlink !== 1
      || (destination.mode & 0o777) !== 0o600
      || tempIdentity === null
      || destination.dev !== tempIdentity.dev
      || destination.ino !== tempIdentity.ino
      || !afterPublish.isFile()
      || afterPublish.nlink !== 1
      || afterPublish.dev !== tempIdentity.dev
      || afterPublish.ino !== tempIdentity.ino
    ) throw new Error("auth published file identity changed");
    published = true;
  } finally {
    if (fd !== null && !published) truncateAuthDescriptor(fd);
    if (tempCreated && !published && tempIdentity !== null) {
      try {
        const current = lstatSync(tempPath);
        if (
          current.isFile()
          && !current.isSymbolicLink()
          && current.dev === tempIdentity.dev
          && current.ino === tempIdentity.ino
        ) unlinkSync(tempPath);
      } catch {
        /* Leave an unproven residue in place rather than unlinking another object. */
      }
    }
    if (fd !== null) closeSync(fd);
    closeAuthPathAnchors(anchors);
  }
  try {
    const st = statSync(path);
    cached = { path, mtimeMs: st.mtimeMs, data };
  } catch {
    cached = { path, mtimeMs: Date.now(), data };
  }
}


export function modifyProvider(id: string, fn: (current: unknown) => unknown | null): void {
  withLock((binding) => {
    const got = readAuth();
    if (!got.ok && got.reason === "corrupt") {
      throw new Error("auth.json is unreadable — refusing to write");
    }
    const data: AuthFile = got.ok ? { ...got.data } : {};
    const next = fn(data[id]);
    if (next === null) delete data[id];
    else data[id] = next;
    writeAuth(data, binding);
  });
}


/** Test helper: drop the in-memory file cache. */
export function resetAuthCache(): void {
  cached = null;
  refreshFlights.clear();
}
