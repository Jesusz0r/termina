// @ts-nocheck
/**
 * Prepare the packaged resources: the node runtime and the core binary.
 *
 * The bundle ships its own node because pi's cli.js starts with a node
 * shebang and pi spawns node itself. The node version must satisfy pi's
 * engines (>= 22.19). The core binary comes from the release build or the
 * local cargo build.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync, closeSync, constants as fsConstants, copyFileSync, existsSync, fstatSync,
  lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildCore, stageCoreBinary } from "./build-core.ts";
import { readSystemProcessIdentity } from "../shared/process-identity.js";

const RESOURCES = join(process.cwd(), "resources");
const MAX_NODE_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_NODE_LOCK_BYTES = 1024;
const DEFAULT_NODE_LOCK_TIMEOUT_MS = 120_000;
const DEFAULT_NODE_LOCK_POLL_MS = 50;
const NODE_LOCK_NAME = ".node-prepare.lock";
const NODE_LOCK_CLAIM_PATTERN = /^\.claim-(\d+)-([a-f0-9]{32})-([a-f0-9]{32})$/;
const NODE_LOCK_OWNER_PATTERN = /^\.record-([a-f0-9]{32})-(\d+)-(\d+)$/;

export const PINNED_NODE_VERSION = "v22.23.2";

// Copied from Node.js's official signed release checksum list:
// https://nodejs.org/dist/v22.23.2/SHASUMS256.txt
const NODE_ARCHIVE_SHA256 = Object.freeze({
  "darwin-arm64": "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
  "darwin-x64": "58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026",
  "linux-arm64": "013b59cfd2819703a6f4a14ab891fc46fc2a4e3f5bcd92de3fb4929b43e35b30",
  "linux-x64": "b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a",
});

function errorCode(error) {
  return error && typeof error === "object" && typeof error.code === "string" ? error.code : null;
}
function directoryIdentity(path) {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() && permissions(stat) === 0o700
      ? { dev: stat.dev, ino: stat.ino }
      : null;
  } catch {
    return null;
  }
}
function sameDirectory(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
function permissions(stat) {
  return stat.mode & 0o777;
}
function validLockOwner(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { pid, token, startedAt, processIdentity, dev, ino } = value;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (typeof token !== "string" || !/^[a-f0-9]{32}$/.test(token)) return null;
  if (!Number.isSafeInteger(startedAt) || startedAt < 0) return null;
  if (typeof processIdentity !== "string"
      || processIdentity.length === 0
      || processIdentity.length > 256
      || !/^[\x20-\x7e]+$/.test(processIdentity)) return null;
  if (!Number.isSafeInteger(dev) || dev < 0 || !Number.isSafeInteger(ino) || ino < 0) return null;
  return { pid, token, startedAt, processIdentity, dev, ino };
}
function sameLockOwner(left, right) {
  return left.pid === right.pid
    && left.token === right.token
    && left.startedAt === right.startedAt
    && left.processIdentity === right.processIdentity
    && left.dev === right.dev
    && left.ino === right.ino;
}
const CURRENT_PROCESS_IDENTITY = readSystemProcessIdentity(process.pid)
  ?? `self:${randomBytes(16).toString("hex")}`;
const CURRENT_PROCESS_FINGERPRINT = createHash("sha256")
  .update(CURRENT_PROCESS_IDENTITY)
  .digest("hex")
  .slice(0, 32);
function observedProcessIdentity(pid) {
  return pid === process.pid ? CURRENT_PROCESS_IDENTITY : readSystemProcessIdentity(pid);
}
function identityFingerprint(identity) {
  return createHash("sha256").update(identity).digest("hex").slice(0, 32);
}
function lockWitnessPath(containerPath, token) {
  return join(lockGuardPath(containerPath, token), "witness");
}
function startNodeLockWitness(containerPath, token) {
  const path = lockWitnessPath(containerPath, token);
  execFileSync("/usr/bin/mkfifo", ["-m", "0600", path], { stdio: "ignore" });
  let fd = null;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW);
    const descriptor = fstatSync(fd);
    const entry = lstatSync(path);
    if (!descriptor.isFIFO()
        || !entry.isFIFO()
        || entry.isSymbolicLink()
        || permissions(entry) !== 0o600
        || descriptor.dev !== entry.dev
        || descriptor.ino !== entry.ino) {
      throw new Error("failed to create Node runtime lock witness");
    }
    return { fd, path, token, dev: descriptor.dev, ino: descriptor.ino, closed: false };
  } catch (error) {
    if (fd !== null) closeSync(fd);
    rmSync(path, { force: true });
    throw error;
  }
}
function stopNodeLockWitness(witness) {
  if (witness.closed) return;
  witness.closed = true;
  try {
    closeSync(witness.fd);
  } catch (error) {
    if (errorCode(error) !== "EBADF") throw error;
  }
}
function lockWitnessHeld(witness) {
  if (witness.closed) return false;
  try {
    const descriptor = fstatSync(witness.fd);
    const entry = lstatSync(witness.path);
    return descriptor.isFIFO()
      && entry.isFIFO()
      && !entry.isSymbolicLink()
      && permissions(entry) === 0o600
      && descriptor.dev === witness.dev
      && descriptor.ino === witness.ino
      && entry.dev === witness.dev
      && entry.ino === witness.ino;
  } catch {
    return false;
  }
}
function probeNodeLockWitness(containerPath, token) {
  const path = lockWitnessPath(containerPath, token);
  try {
    const entry = lstatSync(path);
    if (!entry.isFIFO() || entry.isSymbolicLink() || permissions(entry) !== 0o600) return false;
    const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW);
    try {
      const descriptor = fstatSync(fd);
      return descriptor.isFIFO()
        && descriptor.dev === entry.dev
        && descriptor.ino === entry.ino;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ENXIO") return false;
    return null;
  }
}

function lockOwnerEntry(owner) {
  return `.record-${owner.token}-${owner.dev}-${owner.ino}`;
}
function lockOwnerPath(lockPath, owner) {
  return join(lockPath, lockOwnerEntry(owner));
}
function parseLockOwnerEntry(name) {
  const match = NODE_LOCK_OWNER_PATTERN.exec(name);
  if (match === null) return null;
  const dev = Number(match[2]);
  const ino = Number(match[3]);
  if (!Number.isSafeInteger(dev) || dev < 0 || !Number.isSafeInteger(ino) || ino < 0) return null;
  return { name, token: match[1], dev, ino };
}
function lockGuardPath(lockPath, token) {
  return join(lockPath, `.owner-${token}`);
}
function lockGuardValid(lockPath, token) {
  try {
    const guard = lstatSync(lockGuardPath(lockPath, token));
    return guard.isDirectory() && !guard.isSymbolicLink() && permissions(guard) === 0o700;
  } catch {
    return false;
  }
}
function readLockOwner(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()
        || stat.isSymbolicLink()
        || permissions(stat) !== 0o600
        || stat.size <= 0
        || stat.size > MAX_NODE_LOCK_BYTES) return null;
    const raw = readFileSync(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_NODE_LOCK_BYTES) return null;
    return validLockOwner(JSON.parse(raw));
  } catch {
    return null;
  }
}
function inspectNodeLock(lockPath) {
  const directory = directoryIdentity(lockPath);
  if (directory === null) return null;
  let records;
  try {
    records = readdirSync(lockPath).map(parseLockOwnerEntry).filter((entry) => entry !== null);
  } catch {
    return null;
  }
  if (records.length !== 1) return null;
  const record = records[0];
  const owner = readLockOwner(join(lockPath, record.name));
  if (owner === null
      || owner.token !== record.token
      || owner.dev !== record.dev
      || owner.ino !== record.ino
      || owner.dev !== directory.dev
      || owner.ino !== directory.ino) return null;
  if (!lockGuardValid(lockPath, owner.token)) return null;
  if (!lockEntriesMatch(lockPath, owner, record.name)) return null;
  return { owner, directory, ownerEntry: record.name, guardPresent: true };
}
function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}
function lockOwnerAlive(containerPath, owner) {
  if (!processExists(owner.pid)) return false;
  const actualIdentity = observedProcessIdentity(owner.pid);
  if (actualIdentity !== null && actualIdentity !== owner.processIdentity) return false;
  return probeNodeLockWitness(containerPath, owner.token) !== false;
}
function lockClaimantAlive(resourcesDir, lockPath, claimed) {
  const { claimant } = claimed;
  if (!processExists(claimant.pid)) return false;
  const actualIdentity = observedProcessIdentity(claimant.pid);
  if (actualIdentity !== null
      && identityFingerprint(actualIdentity) !== claimant.processFingerprint) return false;
  let witnessContainer = lockPath;
  if (claimant.token !== claimed.owner.token) {
    witnessContainer = join(resourcesDir, `.node-lock-candidate-${claimant.pid}-${claimant.token}`);
    const candidate = inspectNodeLockCandidate(witnessContainer, claimant.pid, claimant.token);
    if (candidate === null
        || identityFingerprint(candidate.owner.processIdentity) !== claimant.processFingerprint) return false;
  }
  return probeNodeLockWitness(witnessContainer, claimant.token) !== false;
}

function recoverOwnedArtifacts(resourcesDir, token) {
  const targetDir = join(resourcesDir, "node");
  const backupDir = join(resourcesDir, `.node-backup-${token}`);
  if (pathEntryExists(backupDir)) {
    if (pathEntryExists(targetDir)) rmSync(backupDir, { recursive: true, force: true });
    else renameSync(backupDir, targetDir);
  }

  const stagePattern = new RegExp(`^\\.node-stage-${token}-[A-Za-z0-9]{6}$`);
  for (const name of readdirSync(resourcesDir)) {
    if (stagePattern.test(name)) rmSync(join(resourcesDir, name), { recursive: true, force: true });
  }
}
function inspectNodeLockCandidate(candidatePath, pid, token) {
  try {
    const stat = lstatSync(candidatePath);
    if (!stat.isDirectory() || stat.isSymbolicLink() || permissions(stat) !== 0o700) return null;
    const directory = { dev: stat.dev, ino: stat.ino };
    const owner = readLockOwner(lockOwnerPath(candidatePath, { token, ...directory }));
    if (owner === null
        || owner.pid !== pid
        || owner.token !== token
        || owner.dev !== directory.dev
        || owner.ino !== directory.ino
        || !lockGuardValid(candidatePath, token)
        || !lockEntriesMatch(candidatePath, owner)) return null;
    return { owner, directory };
  } catch {
    return null;
  }
}
function removablePartialLockCandidate(candidatePath, pid, token) {
  if (processExists(pid)) return false;
  try {
    const stat = lstatSync(candidatePath);
    if (!stat.isDirectory() || stat.isSymbolicLink() || permissions(stat) !== 0o700) return false;
    const guardName = `.owner-${token}`;
    const ownerName = lockOwnerEntry({ token, dev: stat.dev, ino: stat.ino });
    const entries = readdirSync(candidatePath).sort();
    if (entries.length === 0) return true;
    if (entries.length > 2 || entries[0] !== guardName || (entries.length === 2 && entries[1] !== ownerName)) {
      return false;
    }
    if (!lockGuardValid(candidatePath, token)) return false;
    const guardEntries = readdirSync(lockGuardPath(candidatePath, token));
    if (guardEntries.length > 1 || (guardEntries.length === 1 && guardEntries[0] !== "witness")) return false;
    if (guardEntries.length === 1) {
      const witness = lstatSync(lockWitnessPath(candidatePath, token));
      if (!witness.isFIFO() || witness.isSymbolicLink() || permissions(witness) !== 0o600) return false;
    }
    if (entries.length === 2) {
      const owner = lstatSync(join(candidatePath, ownerName));
      if (!owner.isFile()
          || owner.isSymbolicLink()
          || permissions(owner) !== 0o600
          || owner.size > MAX_NODE_LOCK_BYTES) return false;
    }
    return true;
  } catch {
    return false;
  }
}
function sweepDeadLockCandidates(resourcesDir) {
  const pattern = /^\.node-lock-candidate-(\d+)-([a-f0-9]{32})$/;
  for (const name of readdirSync(resourcesDir)) {
    const match = pattern.exec(name);
    if (match === null) continue;
    const candidatePath = join(resourcesDir, name);
    const pid = Number(match[1]);
    const token = match[2];
    const candidate = inspectNodeLockCandidate(candidatePath, pid, token);
    if (candidate !== null) {
      if (!lockOwnerAlive(candidatePath, candidate.owner)) {
        rmSync(candidatePath, { recursive: true, force: true });
      }
    } else if (removablePartialLockCandidate(candidatePath, pid, token)) {
      rmSync(candidatePath, { recursive: true, force: true });
    }
  }
}
function lockEntriesMatch(lockPath, owner, ownerEntry = lockOwnerEntry(owner), guardPresent = true) {
  try {
    const actual = readdirSync(lockPath).sort();
    const expected = guardPresent ? [`.owner-${owner.token}`, ownerEntry].sort() : [ownerEntry];
    return actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);
  } catch {
    return false;
  }
}
function parseLockClaimName(name) {
  const match = NODE_LOCK_CLAIM_PATTERN.exec(name);
  if (match === null) return null;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return { name, pid, processFingerprint: match[2], token: match[3] };
}
function inspectClaimedNodeLock(lockPath) {
  const directory = directoryIdentity(lockPath);
  if (directory === null) return null;
  try {
    const entries = readdirSync(lockPath).sort();
    const claims = entries.map(parseLockClaimName).filter((claim) => claim !== null);
    if (claims.length !== 1) return null;
    const claimant = claims[0];
    const owner = readLockOwner(join(lockPath, claimant.name));
    if (owner === null || owner.dev !== directory.dev || owner.ino !== directory.ino) return null;
    const guardName = `.owner-${owner.token}`;
    const guardPresent = entries.includes(guardName);
    if (!lockEntriesMatch(lockPath, owner, claimant.name, guardPresent)) return null;
    if (guardPresent && !lockGuardValid(lockPath, owner.token)) return null;
    return { owner, directory, ownerEntry: claimant.name, guardPresent, claimant };
  } catch {
    return null;
  }
}
function sameClaimant(left, right) {
  return left.name === right.name
    && left.pid === right.pid
    && left.processFingerprint === right.processFingerprint
    && left.token === right.token;
}
function inspectMatchingClaim(lockPath, expected) {
  const current = inspectClaimedNodeLock(lockPath);
  if (current === null
      || !sameDirectory(current.directory, expected.directory)
      || !sameLockOwner(current.owner, expected.owner)
      || !sameClaimant(current.claimant, expected.claimant)) return null;
  return current;
}
function claimNodeLock(lockPath, observed, witness) {
  if (!lockWitnessHeld(witness)
      || !lockEntriesMatch(
    lockPath,
    observed.owner,
    observed.ownerEntry,
    observed.guardPresent,
  )) return null;

  const claimName = `.claim-${process.pid}-${CURRENT_PROCESS_FINGERPRINT}-${witness.token}`;
  const source = join(lockPath, observed.ownerEntry);
  const destination = join(lockPath, claimName);
  try {
    renameSync(source, destination);
  } catch {
    return null;
  }

  const claimed = inspectClaimedNodeLock(lockPath);
  if (claimed === null
      || !sameDirectory(claimed.directory, observed.directory)
      || !sameLockOwner(claimed.owner, observed.owner)
      || claimed.claimant.name !== claimName
      || claimed.claimant.pid !== process.pid
      || claimed.claimant.processFingerprint !== CURRENT_PROCESS_FINGERPRINT
      || claimed.claimant.token !== witness.token) return null;
  return claimed;
}

function finishNodeLockClaim(resourcesDir, lockPath, claimed) {
  let current = inspectMatchingClaim(lockPath, claimed);
  if (current === null) return false;

  recoverOwnedArtifacts(resourcesDir, claimed.owner.token);
  current = inspectMatchingClaim(lockPath, claimed);
  if (current === null) return false;

  if (current.guardPresent) {
    const guardPath = lockGuardPath(lockPath, claimed.owner.token);
    const guardEntries = readdirSync(guardPath);
    if (guardEntries.length > 1 || (guardEntries.length === 1 && guardEntries[0] !== "witness")) return false;
    const witnessPath = lockWitnessPath(lockPath, claimed.owner.token);
    if (guardEntries.length === 1) {
      const witness = lstatSync(witnessPath);
      if (witness.isDirectory() && !witness.isSymbolicLink()) return false;
      unlinkSync(witnessPath);
      current = inspectMatchingClaim(lockPath, claimed);
      if (current === null || !current.guardPresent) return false;
    }
    rmdirSync(guardPath);
    current = inspectMatchingClaim(lockPath, claimed);
    if (current === null || current.guardPresent) return false;
  }

  unlinkSync(join(lockPath, claimed.ownerEntry));
  const directory = directoryIdentity(lockPath);
  if (directory === null
      || !sameDirectory(directory, claimed.directory)
      || readdirSync(lockPath).length !== 0) return false;
  rmdirSync(lockPath);
  return true;
}
function recoverNodeLock(resourcesDir, lockPath, observed, witness) {
  const claimed = claimNodeLock(lockPath, observed, witness);
  return claimed !== null && finishNodeLockClaim(resourcesDir, lockPath, claimed);
}
function releaseNodeLock(resourcesDir, lockPath, handle) {
  const current = inspectNodeLock(lockPath);
  if (current === null
      || !sameDirectory(current.directory, handle.directory)
      || !sameLockOwner(current.owner, handle.owner)
      || !lockEntriesMatch(lockPath, handle.owner)) return;
  const claimed = claimNodeLock(lockPath, current, handle.witness);
  if (claimed === null) return;
  try {
    finishNodeLockClaim(resourcesDir, lockPath, claimed);
  } catch {
    // A resumable claim stays in place and is recoverable when this process exits.
  }
}
function assertNodeLockHeld(handle) {
  const current = inspectNodeLock(handle.lockPath);
  if (!lockWitnessHeld(handle.witness)
      || current === null
      || !sameDirectory(current.directory, handle.directory)
      || !sameLockOwner(current.owner, handle.owner)
      || !lockEntriesMatch(handle.lockPath, handle.owner)) {
    throw new Error("node runtime lock lost");
  }
}
function boundedMilliseconds(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || value > 10 * 60_000) throw new Error(`invalid ${name}`);
  return Math.floor(value);
}

function waitMilliseconds(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function acquireNodeLock(resourcesDir, { lockTimeoutMs, lockPollMs }) {
  const timeoutMs = boundedMilliseconds(lockTimeoutMs, DEFAULT_NODE_LOCK_TIMEOUT_MS, "node lock timeout");
  const pollMs = boundedMilliseconds(lockPollMs, DEFAULT_NODE_LOCK_POLL_MS, "node lock poll interval");
  const lockPath = join(resourcesDir, NODE_LOCK_NAME);
  const token = randomBytes(16).toString("hex");
  const candidatePath = join(resourcesDir, `.node-lock-candidate-${process.pid}-${token}`);
  let witness = null;
  let moved = false;
  try {
    mkdirSync(candidatePath, { mode: 0o700 });
    chmodSync(candidatePath, 0o700);
    const directory = directoryIdentity(candidatePath);
    if (directory === null) throw new Error("failed to create Node runtime lock candidate");
    mkdirSync(lockGuardPath(candidatePath, token), { mode: 0o700 });
    chmodSync(lockGuardPath(candidatePath, token), 0o700);
    witness = startNodeLockWitness(candidatePath, token);
    const owner = {
      pid: process.pid,
      token,
      startedAt: Date.now(),
      processIdentity: CURRENT_PROCESS_IDENTITY,
      ...directory,
    };
    writeFileSync(lockOwnerPath(candidatePath, owner), JSON.stringify(owner), { mode: 0o600, flag: "wx" });
    chmodSync(lockOwnerPath(candidatePath, owner), 0o600);

    const deadline = performance.now() + timeoutMs;
    for (;;) {
      try {
        renameSync(candidatePath, lockPath);
        moved = true;
        witness.path = lockWitnessPath(lockPath, token);
        return { lockPath, owner, directory, witness };
      } catch (error) {
        const code = errorCode(error);
        if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      }
      const current = inspectNodeLock(lockPath);
      if (current !== null && !lockOwnerAlive(lockPath, current.owner)) {
        if (recoverNodeLock(resourcesDir, lockPath, current, witness)) continue;
      }
      if (current === null) {
        const claimed = inspectClaimedNodeLock(lockPath);
        if (claimed !== null && !lockClaimantAlive(resourcesDir, lockPath, claimed)) {
          if (recoverNodeLock(resourcesDir, lockPath, claimed, witness)) continue;
        }
      }
      if (performance.now() >= deadline) throw new Error("node runtime busy");
      await waitMilliseconds(Math.max(1, Math.min(pollMs, deadline - performance.now())));
    }
  } finally {
    if (!moved) {
      if (witness !== null) stopNodeLockWitness(witness);
      rmSync(candidatePath, { recursive: true, force: true });
    }
  }
}

async function withNodeLock(resourcesDir, options, operation) {
  const handle = await acquireNodeLock(resourcesDir, options);
  try {
    sweepDeadLockCandidates(resourcesDir);
    return await operation(handle);
  } finally {
    try {
      releaseNodeLock(resourcesDir, handle.lockPath, handle);
    } finally {
      stopNodeLockWitness(handle.witness);
    }
  }
}

/** Resolve only intentionally supported, checksum-pinned release archives. */
export function nodeReleaseFor(targetPlatform, targetArch) {
  const platformArch = `${targetPlatform}-${targetArch}`;
  const sha256 = NODE_ARCHIVE_SHA256[platformArch];
  if (!sha256) {
    throw new Error(`unsupported Node runtime platform: ${platformArch}`);
  }
  const archiveName = `node-${PINNED_NODE_VERSION}-${platformArch}.tar.gz`;
  return {
    version: PINNED_NODE_VERSION,
    platformArch,
    archiveName,
    directoryName: archiveName.slice(0, -".tar.gz".length),
    sha256,
    url: `https://nodejs.org/dist/${PINNED_NODE_VERSION}/${archiveName}`,
  };
}

async function fetchWithRetry(url, label, { fetchImpl = globalThis.fetch, logger = console } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`${label} failed: ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt === 2) break;
      const delay = 2000 * 2 ** attempt;
      logger.warn(`${label}: ${err instanceof Error ? err.message : err}; retry in ${delay}ms`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    }
  }
  throw lastErr;
}

/** Stream one archive to a new file and retain it only when its hash matches. */
export async function downloadVerifiedArchive({
  url,
  destination,
  sha256,
  fetchImpl = globalThis.fetch,
  maxBytes = MAX_NODE_ARCHIVE_BYTES,
  logger = console,
}) {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("invalid expected Node archive SHA-256");

  const response = await fetchWithRetry(url, "node download", { fetchImpl, logger });
  if (!response.body) throw new Error("node download returned no body");
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body.cancel().catch(() => {});
    throw new Error(`node download exceeds ${maxBytes} bytes`);
  }

  const file = await open(destination, "wx", 0o600);
  const reader = response.body.getReader();
  const hash = createHash("sha256");
  let byteCount = 0;
  let verified = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      byteCount += chunk.length;
      if (byteCount > maxBytes) throw new Error(`node download exceeds ${maxBytes} bytes`);
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
        if (bytesWritten === 0) throw new Error("node archive write made no progress");
        offset += bytesWritten;
      }
    }

    const actual = hash.digest();
    const expected = Buffer.from(sha256, "hex");
    if (!timingSafeEqual(actual, expected)) {
      throw new Error(`node archive checksum mismatch: expected ${sha256}, got ${actual.toString("hex")}`);
    }
    await file.sync();
    verified = true;
    return { byteCount, sha256 };
  } finally {
    if (!verified) await reader.cancel().catch(() => {});
    await file.close();
    if (!verified) rmSync(destination, { force: true });
  }
}

function extractNodeArchive({ archive, destinationDir }) {
  execFileSync("/usr/bin/tar", ["-xf", archive, "-C", destinationDir], { stdio: "inherit" });
}

function validatedNodeVersion(nodeBin, runNode) {
  return String(runNode(nodeBin, ["--version"], { encoding: "utf8" })).trim();
}

function validateExtractedRuntime(extractedDir, release, runNode) {
  if (!existsSync(extractedDir)) throw new Error(`node archive did not contain ${release.directoryName}`);
  const rootStat = lstatSync(extractedDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`node archive has an invalid ${release.directoryName} root`);
  }

  const binDir = join(extractedDir, "bin");
  if (!existsSync(binDir)) throw new Error("node archive is missing bin/");
  const binStat = lstatSync(binDir);
  if (!binStat.isDirectory() || binStat.isSymbolicLink()) throw new Error("node archive bin/ is not a regular directory");

  const nodeBin = join(binDir, "node");
  if (!existsSync(nodeBin)) throw new Error("node archive is missing bin/node");
  const nodeStat = lstatSync(nodeBin);
  if (!nodeStat.isFile() || nodeStat.isSymbolicLink()) throw new Error("node archive bin/node is not a regular file");
  chmodSync(nodeBin, 0o755);

  const version = validatedNodeVersion(nodeBin, runNode);
  if (version !== release.version) {
    throw new Error(`extracted Node version ${version || "<empty>"} does not match ${release.version}`);
  }
}

/** Install a fully validated directory, restoring the prior target on failure. */
function replaceNodeDirectory(extractedDir, targetDir, ownerToken) {
  const hadTarget = pathEntryExists(targetDir);
  const backupDir = join(dirname(targetDir), `.node-backup-${ownerToken}`);
  if (pathEntryExists(backupDir)) throw new Error("owned Node runtime backup already exists");
  if (hadTarget) renameSync(targetDir, backupDir);

  try {
    renameSync(extractedDir, targetDir);
  } catch (installError) {
    if (hadTarget) {
      try {
        renameSync(backupDir, targetDir);
      } catch (rollbackError) {
        throw new AggregateError(
          [installError, rollbackError],
          `failed to install Node and restore the prior runtime; prior runtime remains at ${backupDir}`,
        );
      }
    }
    throw installError;
  }

  if (hadTarget) rmSync(backupDir, { recursive: true, force: true });
}

/** Download, verify, validate, and atomically stage the pinned Node runtime. */
export async function prepareNode({
  resourcesDir = RESOURCES,
  targetPlatform = platform(),
  targetArch = process.arch,
  fetchImpl = globalThis.fetch,
  downloadArchive = downloadVerifiedArchive,
  extractArchive = extractNodeArchive,
  runNode = execFileSync,
  logger = console,
  lockTimeoutMs,
  lockPollMs,
} = {}) {
  // Resolve first so unsupported platforms never touch the filesystem or network.
  const release = nodeReleaseFor(targetPlatform, targetArch);
  const targetDir = join(resourcesDir, "node");
  mkdirSync(resourcesDir, { recursive: true });
  const resourcesStat = lstatSync(resourcesDir);
  if (!resourcesStat.isDirectory() || resourcesStat.isSymbolicLink()) {
    throw new Error("resources directory must be a real directory, not a symlink");
  }
  return withNodeLock(resourcesDir, { lockTimeoutMs, lockPollMs }, async (lock) => {
    logger.log(`↓ node ${release.version} (${release.platformArch})`);
    const stagingDir = mkdtempSync(join(resourcesDir, `.node-stage-${lock.owner.token}-`));
    const archive = join(stagingDir, release.archiveName);
    try {
      await downloadArchive({
        url: release.url,
        destination: archive,
        sha256: release.sha256,
        fetchImpl,
        logger,
      });
      assertNodeLockHeld(lock);
      extractArchive({ archive, destinationDir: stagingDir, release });
      const extractedDir = join(stagingDir, release.directoryName);
      validateExtractedRuntime(extractedDir, release, runNode);
      assertNodeLockHeld(lock);
      replaceNodeDirectory(extractedDir, targetDir, lock.owner.token);
      logger.log(`✓ node ${release.version} staged`);
      assertNodeLockHeld(lock);
      return "staged";
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  });
}

/** Copy the release core binary into resources/termina-core. */
export function prepareCore() {
  if (process.env.TERMINA_SKIP_CORE_BUILD !== "1") buildCore();
  mkdirSync(RESOURCES, { recursive: true });
  stageCoreBinary(join(process.cwd(), "dist-electron", "termina-core"), join(RESOURCES, "termina-core"));
  console.log("✓ termina-core staged");
}

/** Stage the CLI launcher into resources/bin/termina. */
export function prepareBin(resourcesDir = RESOURCES) {
  const binDir = join(resourcesDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const src = join(process.cwd(), "bin", "termina");
  const dest = join(binDir, "termina");
  if (existsSync(src)) {
    copyFileSync(src, dest);
    chmodSync(dest, 0o755);
    console.log("✓ bin/termina staged");
  }
}

async function main() {
  await prepareNode();
  prepareCore();
  prepareBin();
  console.log(`resources ready in ${RESOURCES}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
