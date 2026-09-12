/**
 * Auth file lock and descriptor-bound path core.
 *
 * Owns the auth lock state machine and the descriptor-bound auth path
 * binding it validates. Split from agent-core/auth.ts (issue #38).
 */
import { errorCode, isRecord } from "../../shared/guards.ts";
import { readSystemProcessIdentity } from "../../shared/process-identity.js";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";


const MAX_AUTH_LOCK_BYTES = 1024;

const AUTH_LOCK_EMPTY_GRACE_MS = 250;

const AUTH_LOCK_CANDIDATE_PREFIX = ".auth-lock-candidate-";


const CURRENT_AUTH_PROCESS_IDENTITY = readSystemProcessIdentity(process.pid)
  ?? `self:${randomBytes(16).toString("hex")}`;


function observedAuthProcessIdentity(pid: number): string | null {
  return pid === process.pid ? CURRENT_AUTH_PROCESS_IDENTITY : readSystemProcessIdentity(pid);
}


type AuthLockOwner = {
  pid: number;
  token: string;
  startedAt: number;
  processIdentity: string;
  dev: number;
  ino: number;
};


type AuthLockDirectory = {
  dev: number;
  ino: number;
};


type AuthLockHandle = {
  owner: AuthLockOwner;
  directory: AuthLockDirectory;
  ownerPath: string;
  guardPath: string;
  witnessFd: number | null;
  guardPresent: boolean;
};


type AuthLockTransitionPhase = "released" | "recovered";


type AuthLockTransition = {
  phase: AuthLockTransitionPhase;
  owner: AuthLockOwner;
  directory: AuthLockDirectory;
  recordPath: string;
  guardPath: string;
  guardPresent: boolean;
};


function authLockOwner(value: unknown): AuthLockOwner | null {
  if (!isRecord(value)) return null;
  const pid = value.pid;
  const token = value.token;
  const startedAt = value.startedAt;
  const processIdentity = value.processIdentity;
  const dev = value.dev;
  const ino = value.ino;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(token)) return null;
  if (typeof startedAt !== "number" || !Number.isSafeInteger(startedAt) || startedAt < 0) return null;
  if (typeof processIdentity !== "string" || !/^[\x20-\x7e]{1,256}$/.test(processIdentity)) return null;
  if (typeof dev !== "number" || !Number.isSafeInteger(dev) || dev < 0) return null;
  if (typeof ino !== "number" || !Number.isSafeInteger(ino) || ino < 0) return null;
  return { pid, token, startedAt, processIdentity, dev, ino };
}


function authLockOwnerEntry(owner: Pick<AuthLockOwner, "token" | "dev" | "ino">): string {
  return `.record-${owner.token}-${owner.dev}-${owner.ino}`;
}


function authLockOwnerPath(lock: string, owner: Pick<AuthLockOwner, "token" | "dev" | "ino">): string {
  return join(lock, authLockOwnerEntry(owner));
}


function authLockGuardPath(lock: string, owner: Pick<AuthLockOwner, "token" | "dev" | "ino">): string {
  return join(lock, `.owner-${owner.token}-${owner.dev}-${owner.ino}`);
}


function authLockWitnessPath(lock: string, owner: Pick<AuthLockOwner, "token" | "dev" | "ino">): string {
  return join(authLockGuardPath(lock, owner), "witness");
}


function authLockCandidatePath(lock: string, token: string): string {
  return join(dirname(lock), `${AUTH_LOCK_CANDIDATE_PREFIX}${process.pid}-${token}`);
}


export function authLockNoFollowFlags(base: number): number {
  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== "number") throw new Error("auth lock requires O_NOFOLLOW support");
  return base | noFollow;
}


export function authDirectoryOpenFlags(): number {
  const directory = fsConstants.O_DIRECTORY;
  if (typeof directory !== "number") throw new Error("auth lock requires directory descriptor support");
  return authLockNoFollowFlags(fsConstants.O_RDONLY | directory);
}


type AuthLockGuardState = "missing" | "empty" | "present" | "invalid";


function authLockGuardState(path: string): AuthLockGuardState {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return "invalid";
    const entries = readdirSync(path);
    if (entries.length === 0) return "empty";
    if (entries.length !== 1 || entries[0] !== "witness") return "invalid";
    const witness = lstatSync(join(path, "witness"));
    if (
      !witness.isFIFO()
      || witness.isSymbolicLink()
      || witness.nlink !== 1
      || (witness.mode & 0o777) !== 0o600
    ) return "invalid";
    return "present";
  } catch (error) {
    return errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR" ? "missing" : "invalid";
  }
}


function authLockTransitionGuardPath(
  lock: string,
  phase: AuthLockTransitionPhase,
  owner: Pick<AuthLockOwner, "token" | "dev" | "ino">,
): string {
  return join(lock, `.${phase}-holder-${owner.token}-${owner.dev}-${owner.ino}`);
}


function removeAuthLockWitness(guardPath: string): void {
  const witnessPath = join(guardPath, "witness");
  const witness = lstatSync(witnessPath);
  if (
    !witness.isFIFO()
    || witness.isSymbolicLink()
    || witness.nlink !== 1
    || (witness.mode & 0o777) !== 0o600
  ) throw new Error("auth lock witness changed while releasing");
  unlinkSync(witnessPath);
}


function createAuthLockWitness(path: string): number {
  execFileSync("/usr/bin/mkfifo", ["-m", "0600", path], { stdio: "ignore" });
  let fd: number | null = null;
  let keep = false;
  try {
    fd = openSync(path, authLockNoFollowFlags(fsConstants.O_RDONLY | fsConstants.O_NONBLOCK));
    const descriptor = fstatSync(fd);
    const entry = lstatSync(path);
    if (
      !descriptor.isFIFO()
      || !entry.isFIFO()
      || entry.isSymbolicLink()
      || (descriptor.mode & 0o777) !== 0o600
      || (entry.mode & 0o777) !== 0o600
      || descriptor.dev !== entry.dev
      || descriptor.ino !== entry.ino
    ) throw new Error("auth lock witness is not a private FIFO");
    const result = fd;
    fd = null;
    keep = true;
    return result;
  } finally {
    if (fd !== null) closeSync(fd);
    if (!keep) {
      try {
        const entry = lstatSync(path);
        if (entry.isFIFO() && entry.nlink === 1 && (entry.mode & 0o777) === 0o600) unlinkSync(path);
      } catch {
        /* Leave an unproven witness in place rather than unlinking another object. */
      }
    }
  }
}


function probeAuthLockWitnessPath(path: string): boolean | null {
  try {
    const entry = lstatSync(path);
    if (
      !entry.isFIFO()
      || entry.isSymbolicLink()
      || entry.nlink !== 1
      || (entry.mode & 0o777) !== 0o600
    ) return null;
    const fd = openSync(path, authLockNoFollowFlags(fsConstants.O_WRONLY | fsConstants.O_NONBLOCK));
    try {
      const descriptor = fstatSync(fd);
      return descriptor.isFIFO() && descriptor.dev === entry.dev && descriptor.ino === entry.ino;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ENXIO") return false;
    return null;
  }
}


function probeAuthLockWitness(
  lock: string,
  owner: AuthLockOwner,
  guardPath = authLockGuardPath(lock, owner),
): boolean | null {
  return probeAuthLockWitnessPath(join(guardPath, "witness"));
}


function authLockTransitionEntry(
  phase: AuthLockTransitionPhase,
  owner: Pick<AuthLockOwner, "token" | "dev" | "ino">,
): string {
  return `.${phase}-${owner.token}-${owner.dev}-${owner.ino}`;
}


function authLockTransitionPath(
  lock: string,
  phase: AuthLockTransitionPhase,
  owner: Pick<AuthLockOwner, "token" | "dev" | "ino">,
): string {
  return join(lock, authLockTransitionEntry(phase, owner));
}


function parseAuthLockOwnerEntry(name: string): Pick<AuthLockOwner, "token" | "dev" | "ino"> | null {
  const match = /^\.record-([A-Za-z0-9_-]{1,128})-(\d+)-(\d+)$/.exec(name);
  if (match === null) return null;
  const dev = Number(match[2]);
  const ino = Number(match[3]);
  if (!Number.isSafeInteger(dev) || dev < 0 || !Number.isSafeInteger(ino) || ino < 0) return null;
  return { token: match[1], dev, ino };
}


function parseAuthLockTransitionEntry(name: string): {
  phase: AuthLockTransitionPhase;
  token: string | null;
  dev: number | null;
  ino: number | null;
  entry: string;
} | null {
  if (name.startsWith(".released-holder-") || name.startsWith(".recovered-holder-")) return null;
  const generation = /^\.(released|recovered)-([A-Za-z0-9_-]{1,128})-(\d+)-(\d+)$/.exec(name);
  if (generation === null) return null;
  const dev = Number(generation[3]);
  const ino = Number(generation[4]);
  if (!Number.isSafeInteger(dev) || dev < 0 || !Number.isSafeInteger(ino) || ino < 0) return null;
  return { phase: generation[1] as AuthLockTransitionPhase, token: generation[2], dev, ino, entry: name };
}


function authLockDirectory(lock: string): AuthLockDirectory | null {
  try {
    const stat = lstatSync(lock);
    return stat.isDirectory() ? { dev: stat.dev, ino: stat.ino } : null;
  } catch {
    return null;
  }
}


function readAuthLockOwner(path: string): AuthLockOwner | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_AUTH_LOCK_BYTES) return null;
    const raw = readFileSync(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_AUTH_LOCK_BYTES) return null;
    return authLockOwner(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}


export function inspectAuthLock(lock: string): AuthLockHandle | null {
  const directory = authLockDirectory(lock);
  if (directory === null) return null;
  try {
    const entries = readdirSync(lock).sort();
    const ownerEntries = entries.map(parseAuthLockOwnerEntry).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    if (ownerEntries.length !== 1) return null;
    const ownerEntry = ownerEntries[0];
    const ownerPath = authLockOwnerPath(lock, ownerEntry);
    const owner = readAuthLockOwner(ownerPath);
    const guardPath = authLockGuardPath(lock, ownerEntry);
    const guardEntry = guardPath.slice(lock.length + 1);
    const guardPresent =
      entries.length === 2
      && entries.includes(guardEntry)
      && authLockGuardState(guardPath) === "present";
    if (
      owner === null
      || owner.token !== ownerEntry.token
      || owner.dev !== ownerEntry.dev
      || owner.ino !== ownerEntry.ino
      || owner.dev !== directory.dev
      || owner.ino !== directory.ino
      || !guardPresent
    ) return null;
    return { owner, directory, ownerPath, guardPath, witnessFd: null, guardPresent };
  } catch {
    return null;
  }
}


function inspectAuthLockTransition(lock: string): AuthLockTransition | null {
  const directory = authLockDirectory(lock);
  if (directory === null) return null;
  try {
    const entries = readdirSync(lock).sort();
    const transitions = entries.map(parseAuthLockTransitionEntry).filter(
      (entry): entry is NonNullable<typeof entry> => entry !== null,
    );
    if (transitions.length !== 1) return null;
    const transition = transitions[0];
    const recordPath = join(lock, transition.entry);
    const owner = readAuthLockOwner(recordPath);
    if (owner === null || owner.dev !== directory.dev || owner.ino !== directory.ino) return null;
    if (
      transition.token !== null
      && (owner.token !== transition.token || owner.dev !== transition.dev || owner.ino !== transition.ino)
    ) return null;
    const guardPath = authLockGuardPath(lock, owner);
    const holderPath = authLockTransitionGuardPath(lock, transition.phase, owner);
    const guardCandidates = [guardPath, holderPath].filter((candidate) => entries.includes(candidate.slice(lock.length + 1)));
    if (entries.length === 1) {
      return { phase: transition.phase, owner, directory, recordPath, guardPath, guardPresent: false };
    }
    if (entries.length !== 2 || guardCandidates.length !== 1) return null;
    const actualGuardPath = guardCandidates[0];
    const guardState = authLockGuardState(actualGuardPath);
    if (guardState !== "present" && guardState !== "empty") return null;
    return {
      phase: transition.phase,
      owner,
      directory,
      recordPath,
      guardPath: actualGuardPath,
      guardPresent: guardState === "present",
    };
  } catch {
    return null;
  }
}


function sameAuthLockOwner(left: AuthLockOwner, right: AuthLockOwner): boolean {
  return (
    left.pid === right.pid
    && left.token === right.token
    && left.startedAt === right.startedAt
    && left.processIdentity === right.processIdentity
    && left.dev === right.dev
    && left.ino === right.ino
  );
}


function sameAuthLockDirectory(left: AuthLockDirectory, right: AuthLockDirectory): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}


export function authLockOwnerAlive(
  lock: string,
  owner: AuthLockOwner,
  guardPath = authLockGuardPath(lock, owner),
): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
  const actualIdentity = observedAuthProcessIdentity(owner.pid);
  // An unreadable birth identity is uncertainty, not proof of death.
  if (actualIdentity === null) return true;
  if (actualIdentity !== owner.processIdentity) return false;
  // The process-birth token is only a coarse fallback on macOS (ps lstart has
  // one-second resolution). A holder FIFO is the generation-bound proof that
  // this process still owns this exact lock; a reused PID cannot satisfy it.
  const witness = probeAuthLockWitness(lock, owner, guardPath);
  return witness !== false;
}


type AuthLockCrashStage =
  | "release-before-guard-removal"
  | "release-after-guard-removal"
  | "recover-before-guard-removal"
  | "recover-after-guard-removal";


function maybeCrashAuthLock(stage: AuthLockCrashStage): void {
  if (process.env.TERMINA_CORE_TEST !== "1" || process.env.TERMINA_AUTH_LOCK_CRASH !== stage) return;
  process.kill(process.pid, "SIGKILL");
}


function maybePauseAuthLock(stage: "before-publish"): void {
  if (process.env.TERMINA_CORE_TEST !== "1" || process.env.TERMINA_AUTH_LOCK_PAUSE !== stage) return;
  const marker = process.env.TERMINA_AUTH_LOCK_PAUSED?.trim();
  const resume = process.env.TERMINA_AUTH_LOCK_RESUME?.trim();
  if (!marker || !resume) throw new Error("auth lock pause requires marker and resume paths");
  writeFileSync(marker, "paused\n", { mode: 0o600, flag: "wx" });
  while (!existsSync(resume)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}


function removeEmptyAuthLock(lock: string, directory: AuthLockDirectory): boolean {
  const currentDirectory = authLockDirectory(lock);
  if (currentDirectory === null) return true;
  if (!sameAuthLockDirectory(currentDirectory, directory)) return false;
  try {
    if (readdirSync(lock).length !== 0) return false;
    rmdirSync(lock);
    return true;
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
}


function recoverEmptyAuthLock(lock: string): boolean {
  const directory = authLockDirectory(lock);
  if (directory === null) return false;
  let birthtimeMs: number;
  let ctimeMs: number;
  try {
    const initial = lstatSync(lock);
    if (!initial.isDirectory() || initial.isSymbolicLink() || readdirSync(lock).length !== 0) return false;
    birthtimeMs = initial.birthtimeMs;
    ctimeMs = initial.ctimeMs;
    if (!Number.isFinite(birthtimeMs) || !Number.isFinite(ctimeMs)) return false;
    const age = Date.now() - Math.max(birthtimeMs, ctimeMs);
    if (age < AUTH_LOCK_EMPTY_GRACE_MS) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, AUTH_LOCK_EMPTY_GRACE_MS - Math.max(0, age));
    }
  } catch {
    return false;
  }
  try {
    const current = lstatSync(lock);
    if (
      !current.isDirectory()
      || current.isSymbolicLink()
      || current.dev !== directory.dev
      || current.ino !== directory.ino
      || current.birthtimeMs !== birthtimeMs
      || current.ctimeMs !== ctimeMs
      || readdirSync(lock).length !== 0
    ) return false;
  } catch {
    return false;
  }
  return removeEmptyAuthLock(lock, directory);
}


function cleanupAuthLockTransition(lock: string, expected: AuthLockTransition, witnessFd: number | null = null): boolean {
  const current = inspectAuthLockTransition(lock);
  if (
    current === null
    || current.phase !== expected.phase
    || !sameAuthLockDirectory(current.directory, expected.directory)
    || !sameAuthLockOwner(current.owner, expected.owner)
    || current.recordPath !== expected.recordPath
  ) return false;
  let heldWitnessFd = witnessFd;
  try {
    const guardState = authLockGuardState(current.guardPath);
    if (guardState === "present") {
      removeAuthLockWitness(current.guardPath);
      if (heldWitnessFd !== null) {
        closeSync(heldWitnessFd);
        heldWitnessFd = null;
      }
      rmdirSync(current.guardPath);
    } else if (guardState === "empty") {
      if (heldWitnessFd !== null) {
        closeSync(heldWitnessFd);
        heldWitnessFd = null;
      }
      rmdirSync(current.guardPath);
    } else if (guardState !== "missing") {
      return false;
    }
    const afterGuard = inspectAuthLockTransition(lock);
    if (afterGuard === null) return removeEmptyAuthLock(lock, expected.directory);
    if (
      afterGuard.guardPresent
      || authLockGuardState(afterGuard.guardPath) !== "missing"
      || afterGuard.phase !== expected.phase
      || !sameAuthLockDirectory(afterGuard.directory, expected.directory)
      || !sameAuthLockOwner(afterGuard.owner, expected.owner)
      || afterGuard.recordPath !== expected.recordPath
    ) return false;
    unlinkSync(afterGuard.recordPath);
    return removeEmptyAuthLock(lock, expected.directory);
  } catch (error) {
    return errorCode(error) === "ENOENT" && removeEmptyAuthLock(lock, expected.directory);
  } finally {
    if (heldWitnessFd !== null) {
      try { closeSync(heldWitnessFd); } catch { /* best effort after a failed cleanup */ }
    }
  }
}


export function resumeAuthLock(lock: string): boolean {
  const transition = inspectAuthLockTransition(lock);
  if (transition !== null) {
    if (authLockOwnerAlive(lock, transition.owner, transition.guardPath)) return false;
    return cleanupAuthLockTransition(lock, transition);
  }
  return recoverEmptyAuthLock(lock);
}


export function releaseAuthLock(lock: string, handle: AuthLockHandle): void {
  const { owner, directory } = handle;
  try {
    const current = inspectAuthLock(lock);
    if (
      current === null
      || !sameAuthLockDirectory(current.directory, directory)
      || !sameAuthLockOwner(current.owner, owner)
      || current.ownerPath !== handle.ownerPath
    ) return;
    if (!current.guardPresent) {
      unlinkSync(current.ownerPath);
      removeEmptyAuthLock(lock, directory);
      return;
    }
    const releasedOwner = authLockTransitionPath(lock, "released", owner);
    renameSync(current.ownerPath, releasedOwner);
    const moved = readAuthLockOwner(releasedOwner);
    if (moved === null || !sameAuthLockOwner(moved, owner)) return;
    const transition: AuthLockTransition = {
      phase: "released",
      owner,
      directory,
      recordPath: releasedOwner,
      guardPath: authLockTransitionGuardPath(lock, "released", owner),
      guardPresent: true,
    };
    maybeCrashAuthLock("release-before-guard-removal");
    renameSync(current.guardPath, transition.guardPath);
    maybeCrashAuthLock("release-after-guard-removal");
    handle.guardPresent = true;
    cleanupAuthLockTransition(lock, transition, handle.witnessFd);
    handle.witnessFd = null;
  } catch {
    /* A replacement or extra entry leaves the lock in place. */
  }
}


export function recoverAuthLock(lock: string, stale: AuthLockHandle): boolean {
  if (!sameAuthLockDirectory(authLockDirectory(lock) ?? { dev: -1, ino: -1 }, stale.directory)) return false;
  const recoveredOwner = authLockTransitionPath(lock, "recovered", stale.owner);
  try {
    renameSync(stale.ownerPath, recoveredOwner);
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
  const moved = readAuthLockOwner(recoveredOwner);
  const currentDirectory = authLockDirectory(lock);
  if (
    moved === null
    || !sameAuthLockOwner(moved, stale.owner)
    || currentDirectory === null
    || !sameAuthLockDirectory(currentDirectory, stale.directory)
  ) return false;
  const transition: AuthLockTransition = {
    phase: "recovered",
    owner: stale.owner,
    directory: stale.directory,
    recordPath: recoveredOwner,
    guardPath: authLockTransitionGuardPath(lock, "recovered", stale.owner),
    guardPresent: stale.guardPresent,
  };
  try {
    maybeCrashAuthLock("recover-before-guard-removal");
    if (stale.guardPresent) renameSync(stale.guardPath, transition.guardPath);
    maybeCrashAuthLock("recover-after-guard-removal");
  } catch {
    return false;
  }
  return cleanupAuthLockTransition(lock, transition);
}


function cleanupAuthLockCandidate(
  candidate: string,
  directory: AuthLockDirectory,
  owner: AuthLockOwner,
  witnessFd: number | null,
): void {
  if (witnessFd !== null) {
    try { closeSync(witnessFd); } catch { /* best effort before exact path cleanup */ }
  }
  try {
    const currentDirectory = authLockDirectory(candidate);
    if (currentDirectory === null || !sameAuthLockDirectory(currentDirectory, directory)) return;
    const guardPath = authLockGuardPath(candidate, owner);
    const guardState = authLockGuardState(guardPath);
    if (guardState === "present") removeAuthLockWitness(guardPath);
    if (guardState === "present" || guardState === "empty") rmdirSync(guardPath);
    const ownerPath = authLockOwnerPath(candidate, owner);
    const currentOwner = readAuthLockOwner(ownerPath);
    if (currentOwner !== null && sameAuthLockOwner(currentOwner, owner)) unlinkSync(ownerPath);
    removeEmptyAuthLock(candidate, directory);
  } catch {
    /* Never remove a path whose ownership cannot be proven. */
  }
}


export function tryAcquireAuthLock(lock: string, binding: AuthPathBinding): AuthLockHandle | null {
  let candidate: string;
  let candidateToken: string;
  for (;;) {
    candidateToken = randomBytes(16).toString("hex");
    candidate = authLockCandidatePath(lock, candidateToken);
    try {
      mkdirSync(candidate, { mode: 0o700 });
      break;
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      throw error;
    }
  }

  const directory = authLockDirectory(candidate);
  if (directory === null) throw new Error("auth file busy");
  const owner: AuthLockOwner = {
    pid: process.pid,
    token: randomBytes(16).toString("hex"),
    startedAt: Date.now(),
    processIdentity: CURRENT_AUTH_PROCESS_IDENTITY,
    dev: directory.dev,
    ino: directory.ino,
  };
  const ownerPath = authLockOwnerPath(candidate, owner);
  const guardPath = authLockGuardPath(candidate, owner);
  let witnessFd: number | null = null;
  let published = false;
  let handedOff = false;
  try {
    validateAuthPathBinding(binding);
    writeFileSync(ownerPath, JSON.stringify(owner), { mode: 0o600, flag: "wx" });
    mkdirSync(guardPath, { mode: 0o700 });
    witnessFd = createAuthLockWitness(authLockWitnessPath(candidate, owner));
    maybePauseAuthLock("before-publish");
    validateAuthPathBinding(binding);
    try {
      renameSync(candidate, lock);
    } catch (error) {
      const code = errorCode(error);
      if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EISDIR" || code === "ENOTDIR") return null;
      throw error;
    }
    published = true;
    const inspected = inspectAuthLock(lock);
    if (
      inspected === null
      || !sameAuthLockDirectory(inspected.directory, directory)
      || !sameAuthLockOwner(inspected.owner, owner)
    ) throw new Error("auth file busy");
    handedOff = true;
    return {
      owner,
      directory,
      ownerPath: authLockOwnerPath(lock, owner),
      guardPath: authLockGuardPath(lock, owner),
      witnessFd,
      guardPresent: true,
    };
  } finally {
    if (!handedOff) {
      if (!published) {
        cleanupAuthLockCandidate(candidate, directory, owner, witnessFd);
      } else if (witnessFd !== null) {
        try { closeSync(witnessFd); } catch { /* leave the published generation fail-closed */ }
      }
      witnessFd = null;
    }
  }
}


export type AuthPathIdentity = {
  dev: number;
  ino: number;
};


export type AuthPathBinding = {
  path: string;
  parent: string;
  root: string;
  parentIdentity: AuthPathIdentity;
  rootIdentity: AuthPathIdentity;
};


export function authPathDirectoryIdentity(path: string, label: string): AuthPathIdentity {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`auth ${label} must be a real directory`);
  return { dev: stat.dev, ino: stat.ino };
}


export function sameAuthPathIdentity(left: AuthPathIdentity, right: AuthPathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}


export function authPathBinding(path: string): AuthPathBinding {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  const root = dirname(parent);
  return {
    path: absolute,
    parent,
    root,
    parentIdentity: authPathDirectoryIdentity(parent, "parent"),
    rootIdentity: authPathDirectoryIdentity(root, "root"),
  };
}


export function validateAuthPathBinding(binding: AuthPathBinding): void {
  const parentIdentity = authPathDirectoryIdentity(binding.parent, "parent");
  const rootIdentity = authPathDirectoryIdentity(binding.root, "root");
  if (
    !sameAuthPathIdentity(parentIdentity, binding.parentIdentity)
    || !sameAuthPathIdentity(rootIdentity, binding.rootIdentity)
  ) throw new Error("auth path parent changed while writing");
}
