/**
 * Cross-process admission lock for retained session roots.
 *
 * The lock is a directory generation with a small owner record and a guard
 * directory.  Every transition carries the lock directory identity and owner
 * token, so stale recovery and release fail closed across ABA/path swaps.
 * This module is dependency-neutral because both agent-core staging and the
 * Electron durable retention owner must use the same admission boundary.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export const RETAINED_SESSION_ADMISSION_LOCK = ".termina-retained-session-admission.lock";

const MAX_LOCK_BYTES = 1024;
const LOCK_TOKEN = /^[A-Za-z0-9_-]{1,128}$/;

type LockOwner = {
  pid: number;
  token: string;
  startedAt: number;
  dev: number;
  ino: number;
};

type LockDirectory = {
  dev: number;
  ino: number;
};

export type SessionRetentionLock = {
  path: string;
  owner: LockOwner;
  directory: LockDirectory;
  rootIdentity: LockDirectory;
  ownerPath: string;
  guardPath: string;
  guardPresent: boolean;
  /** Run identity carried only through the canonical retention transaction. */
  retentionRunId?: string;
};

type LockTransitionPhase = "released" | "recovered";

type LockTransition = {
  phase: LockTransitionPhase;
  owner: LockOwner;
  directory: LockDirectory;
  recordPath: string;
  guardPath: string;
  guardPresent: boolean;
};

type SessionRetentionLockState = Omit<SessionRetentionLock, "rootIdentity">;

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH is the only proof that the owner is gone. Treat permission and
    // platform/lookup errors as live so uncertain lock state is never claimed.
    return errorCode(error) !== "ESRCH";
  }
}

function parseLockOwner(value: unknown): LockOwner | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.pid !== "number" ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.token !== "string" ||
    !LOCK_TOKEN.test(record.token) ||
    typeof record.startedAt !== "number" ||
    !Number.isSafeInteger(record.startedAt) ||
    record.startedAt < 0 ||
    typeof record.dev !== "number" ||
    !Number.isSafeInteger(record.dev) ||
    record.dev < 0 ||
    typeof record.ino !== "number" ||
    !Number.isSafeInteger(record.ino) ||
    record.ino < 0
  ) return null;
  return { pid: record.pid, token: record.token, startedAt: record.startedAt, dev: record.dev, ino: record.ino };
}

function syncDirectory(path: string): void {
  const fd = openSync(path, fsConstants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function lockOwnerEntry(owner: Pick<LockOwner, "token" | "dev" | "ino">): string {
  return `.record-${owner.token}-${owner.dev}-${owner.ino}`;
}

function lockOwnerPath(lock: string, owner: Pick<LockOwner, "token" | "dev" | "ino">): string {
  return join(lock, lockOwnerEntry(owner));
}

function lockGuardPath(lock: string, owner: Pick<LockOwner, "token" | "dev" | "ino">): string {
  return join(lock, `.owner-${owner.token}-${owner.dev}-${owner.ino}`);
}

function lockTransitionPath(
  lock: string,
  phase: LockTransitionPhase,
  owner: Pick<LockOwner, "token" | "dev" | "ino">,
): string {
  return join(lock, `.${phase}-${owner.token}-${owner.dev}-${owner.ino}`);
}

function parseLockOwnerEntry(name: string): Pick<LockOwner, "token" | "dev" | "ino"> | null {
  const match = /^\.record-([A-Za-z0-9_-]{1,128})-(\d+)-(\d+)$/.exec(name);
  if (match === null) return null;
  const dev = Number(match[2]);
  const ino = Number(match[3]);
  if (!Number.isSafeInteger(dev) || dev < 0 || !Number.isSafeInteger(ino) || ino < 0) return null;
  return { token: match[1], dev, ino };
}

function parseLockTransitionEntry(name: string): {
  phase: LockTransitionPhase;
  token: string;
  dev: number;
  ino: number;
  entry: string;
} | null {
  const match = /^\.(released|recovered)-([A-Za-z0-9_-]{1,128})-(\d+)-(\d+)$/.exec(name);
  if (match === null) return null;
  const dev = Number(match[3]);
  const ino = Number(match[4]);
  if (!Number.isSafeInteger(dev) || dev < 0 || !Number.isSafeInteger(ino) || ino < 0) return null;
  return { phase: match[1] as LockTransitionPhase, token: match[2], dev, ino, entry: name };
}

function lockDirectory(lock: string): LockDirectory | null {
  try {
    const info = lstatSync(lock);
    return info.isDirectory() ? { dev: info.dev, ino: info.ino } : null;
  } catch {
    return null;
  }
}

function readLockOwner(path: string): LockOwner | null {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_LOCK_BYTES) return null;
    const raw = readFileSync(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_LOCK_BYTES) return null;
    return parseLockOwner(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function sameLockOwner(left: LockOwner, right: LockOwner): boolean {
  return (
    left.pid === right.pid &&
    left.token === right.token &&
    left.startedAt === right.startedAt &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function sameLockDirectory(left: LockDirectory, right: LockDirectory): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function inspectLock(lock: string): SessionRetentionLockState | null {
  const directory = lockDirectory(lock);
  if (directory === null) return null;
  try {
    const entries = readdirSync(lock).sort();
    const ownerEntries = entries.map(parseLockOwnerEntry).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    if (ownerEntries.length !== 1) return null;
    const ownerEntry = ownerEntries[0]!;
    const ownerPath = lockOwnerPath(lock, ownerEntry);
    const owner = readLockOwner(ownerPath);
    const guardPath = lockGuardPath(lock, ownerEntry);
    const guardEntry = guardPath.slice(lock.length + 1);
    const guardPresent = entries.length === 2 && entries.includes(guardEntry) && lstatSync(guardPath).isDirectory();
    if (
      owner === null ||
      owner.token !== ownerEntry.token ||
      owner.dev !== ownerEntry.dev ||
      owner.ino !== ownerEntry.ino ||
      owner.dev !== directory.dev ||
      owner.ino !== directory.ino ||
      (entries.length !== 1 && !guardPresent)
    ) return null;
    return { path: lock, owner, directory, ownerPath, guardPath, guardPresent };
  } catch {
    return null;
  }
}

function inspectLockTransition(lock: string): LockTransition | null {
  const directory = lockDirectory(lock);
  if (directory === null) return null;
  try {
    const entries = readdirSync(lock).sort();
    const transitions = entries.map(parseLockTransitionEntry).filter(
      (entry): entry is NonNullable<typeof entry> => entry !== null,
    );
    if (transitions.length !== 1) return null;
    const transition = transitions[0]!;
    const recordPath = join(lock, transition.entry);
    const owner = readLockOwner(recordPath);
    if (
      owner === null ||
      owner.token !== transition.token ||
      owner.dev !== transition.dev ||
      owner.ino !== transition.ino ||
      owner.dev !== directory.dev ||
      owner.ino !== directory.ino
    ) return null;
    const guardPath = lockGuardPath(lock, owner);
    const guardEntry = guardPath.slice(lock.length + 1);
    const guardPresent = entries.length === 2 && entries.includes(guardEntry) && lstatSync(guardPath).isDirectory();
    if (entries.length !== 1 && !guardPresent) return null;
    return { phase: transition.phase, owner, directory, recordPath, guardPath, guardPresent };
  } catch {
    return null;
  }
}

function removeEmptyLock(lock: string, directory: LockDirectory): boolean {
  const current = lockDirectory(lock);
  if (current === null) return true;
  if (!sameLockDirectory(current, directory)) return false;
  try {
    if (readdirSync(lock).length !== 0) return false;
    const beforeRemove = lockDirectory(lock);
    if (beforeRemove === null || !sameLockDirectory(beforeRemove, directory) || readdirSync(lock).length !== 0) return false;
    rmdirSync(lock);
    syncDirectory(resolve(lock, ".."));
    return true;
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
}

function cleanupLockTransition(lock: string, expected: LockTransition): boolean {
  const current = inspectLockTransition(lock);
  if (
    current === null ||
    current.phase !== expected.phase ||
    !sameLockDirectory(current.directory, expected.directory) ||
    !sameLockOwner(current.owner, expected.owner) ||
    current.recordPath !== expected.recordPath
  ) return false;
  try {
    if (current.guardPresent) {
      rmdirSync(current.guardPath);
      syncDirectory(lock);
    }
    const afterGuard = inspectLockTransition(lock);
    if (afterGuard === null) return removeEmptyLock(lock, expected.directory);
    if (
      afterGuard.guardPresent ||
      afterGuard.phase !== expected.phase ||
      !sameLockDirectory(afterGuard.directory, expected.directory) ||
      !sameLockOwner(afterGuard.owner, expected.owner) ||
      afterGuard.recordPath !== expected.recordPath
    ) return false;
    unlinkSync(afterGuard.recordPath);
    syncDirectory(lock);
    return removeEmptyLock(lock, expected.directory);
  } catch (error) {
    return errorCode(error) === "ENOENT" && removeEmptyLock(lock, expected.directory);
  }
}

function resumeLock(lock: string): boolean {
  const transition = inspectLockTransition(lock);
  if (transition !== null) {
    if (processAlive(transition.owner.pid)) return false;
    return cleanupLockTransition(lock, transition);
  }
  // An empty or malformed lock is an unproven acquisition boundary. Retain it
  // rather than allowing a contender to steal a process preempted mid-write.
  return false;
}

function recoverLock(lock: string, stale: SessionRetentionLockState): boolean {
  const currentDirectory = lockDirectory(lock);
  if (currentDirectory === null || !sameLockDirectory(currentDirectory, stale.directory)) return false;
  const recoveredOwner = lockTransitionPath(lock, "recovered", stale.owner);
  try {
    renameSync(stale.ownerPath, recoveredOwner);
  } catch (error) {
    // A different stale contender may have claimed this exact generation.
    // Let the caller inspect the next generation rather than unlinking it.
    return errorCode(error) === "ENOENT";
  }
  const moved = readLockOwner(recoveredOwner);
  const afterRenameDirectory = lockDirectory(lock);
  if (
    moved === null ||
    !sameLockOwner(moved, stale.owner) ||
    afterRenameDirectory === null ||
    !sameLockDirectory(afterRenameDirectory, stale.directory)
  ) return false;
  const transition: LockTransition = {
    phase: "recovered",
    owner: stale.owner,
    directory: stale.directory,
    recordPath: recoveredOwner,
    guardPath: stale.guardPath,
    guardPresent: stale.guardPresent,
  };
  return cleanupLockTransition(lock, transition);
}

/** Acquire the shared app-owned retained-session admission lock. */
export function acquireSessionRetentionLock(root: string): SessionRetentionLock {
  const canonicalRoot = realpathSync(resolve(root));
  const rootEntry = lstatSync(canonicalRoot);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) throw new Error("retained session root is not a directory");
  const rootIdentity = { dev: rootEntry.dev, ino: rootEntry.ino };
  const path = join(canonicalRoot, RETAINED_SESSION_ADMISSION_LOCK);
  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const inspected = inspectLock(path);
      if (inspected === null) {
        if (resumeLock(path)) continue;
        throw new Error("retained session admission lock is unreadable");
      }
      if (inspected.owner.pid === process.pid || processAlive(inspected.owner.pid)) {
        throw new Error("retained session root is busy");
      }
      if (!recoverLock(path, inspected)) throw new Error("retained session root is busy");
      continue;
    }
    const directory = lockDirectory(path);
    if (directory === null) throw new Error("retained session admission lock is unreadable");
    const owner: LockOwner = {
      pid: process.pid,
      token: randomUUID(),
      startedAt: Date.now(),
      dev: directory.dev,
      ino: directory.ino,
    };
    const lock: SessionRetentionLock = {
      path,
      owner,
      directory,
      rootIdentity,
      ownerPath: lockOwnerPath(path, owner),
      guardPath: lockGuardPath(path, owner),
      guardPresent: false,
    };
    try {
      writeFileSync(lock.ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
      const ownerFd = openSync(lock.ownerPath, fsConstants.O_RDONLY);
      try {
        fsyncSync(ownerFd);
      } finally {
        closeSync(ownerFd);
      }
      mkdirSync(lock.guardPath, { mode: 0o700 });
      lock.guardPresent = true;
      syncDirectory(path);
      syncDirectory(canonicalRoot);
      return lock;
    } catch (error) {
      // This process owns the exact generation. Cleanup is identity-bound and
      // leaves any unexpected replacement in place.
      try {
        const current = inspectLock(path);
        if (
          current !== null
          && sameLockDirectory(current.directory, directory)
          && sameLockOwner(current.owner, owner)
          && current.ownerPath === lock.ownerPath
        ) releaseSessionRetentionLock({ ...current, rootIdentity });
      } catch {
        /* preserve an unproven generation for recovery */
      }
      throw error;
    }
  }
}

/**
 * Validate a lease handed across the canonical retention call chain. The
 * caller may use the lease while its owner keeps the lock held, but may not
 * release it: the random owner token and lock-directory generation must still
 * match the live on-disk record.
 */
export function validateSessionRetentionLease(root: string, lease: SessionRetentionLock): SessionRetentionLock | null {
  let canonicalRoot: string;
  let rootEntry;
  try {
    canonicalRoot = realpathSync(resolve(root));
    rootEntry = lstatSync(canonicalRoot);
  } catch {
    return null;
  }
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) return null;
  const expectedPath = join(canonicalRoot, RETAINED_SESSION_ADMISSION_LOCK);
  if (lease.path !== expectedPath || lease.owner.pid !== process.pid) return null;
  const rootIdentity = { dev: rootEntry.dev, ino: rootEntry.ino };
  if (!sameLockDirectory(rootIdentity, lease.rootIdentity)) return null;
  const current = inspectLock(expectedPath);
  if (
    current === null ||
    !current.guardPresent ||
    !sameLockDirectory(current.directory, lease.directory) ||
    !sameLockOwner(current.owner, lease.owner) ||
    current.ownerPath !== lease.ownerPath ||
    current.guardPath !== lease.guardPath
  ) return null;
  return {
    ...current,
    rootIdentity,
    ...(lease.retentionRunId === undefined ? {} : { retentionRunId: lease.retentionRunId }),
  };
}

/** Release only the exact lock generation returned by acquisition. */
export function releaseSessionRetentionLock(lock: SessionRetentionLock): void {
  const path = lock.path;
  try {
    const current = inspectLock(path);
    if (
      current === null ||
      !sameLockDirectory(current.directory, lock.directory) ||
      !sameLockOwner(current.owner, lock.owner) ||
      current.ownerPath !== lock.ownerPath
    ) return;
    const releasedOwner = lockTransitionPath(path, "released", lock.owner);
    try {
      renameSync(current.ownerPath, releasedOwner);
    } catch {
      return;
    }
    const moved = readLockOwner(releasedOwner);
    if (moved === null || !sameLockOwner(moved, lock.owner)) return;
    syncDirectory(path);
    const transition: LockTransition = {
      phase: "released",
      owner: lock.owner,
      directory: lock.directory,
      recordPath: releasedOwner,
      guardPath: current.guardPath,
      guardPresent: current.guardPresent,
    };
    cleanupLockTransition(path, transition);
  } catch {
    // A replacement or unreadable lock is retained rather than deleting a
    // path that may belong to another process.
  }
}
