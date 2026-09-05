/**
 * Durable owner for core session artifacts retained after finalization.
 *
 * Admission, accounting, and publication are one transaction. The in-process
 * queue covers all finalizations in this app; the app-owned lock protects the
 * same user-data root if a second process is started around a crash. No
 * eviction is performed here: unproven evidence is never deleted.
 */
import {
  createReadStream,
  lstatSync,
} from "node:fs";
import { lstat, opendir, readFile, open } from "node:fs/promises";
import type { BigIntStats, Stats } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  acquireSessionRetentionLock,
  releaseSessionRetentionLock,
  RETAINED_SESSION_ADMISSION_LOCK,
  validateSessionRetentionLease,
  type SessionRetentionLock,
} from "../shared/session-retention-lock.js";
export { RETAINED_SESSION_ADMISSION_LOCK } from "../shared/session-retention-lock.js";
import {
  boundPromotionOpenDirectory,
  boundPromotionRemoveTree,
  boundPromotionWriteJsonFile,
  disposeWorldlineGitCore,
  type PromotionFsIdentity,
} from "./worldline-git.js";
import { ensureBoundRetainedRoot } from "./worldlines.js";
import {
  MAX_SESSION_BUNDLE_BYTES,
  SESSION_ACTIVE_NAME,
  SESSION_CURRENT_DIR,
  RETAINED_STAGING_OWNER_NAME,
  coreSessionFile,
  isCoreSessionId,
  parseSessionBundlePath,
} from "../agent-core/session.js";

export const MAX_RETAINED_SESSION_BUNDLES = 128;
export const MAX_RETAINED_SESSION_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_RETAINED_SESSION_BUNDLE_BYTES = 64 * 1024 * 1024;
const RETAINED_SESSION_ROOT_MARKER = ".termina-retained-session-root";
/** Atomic per-root usage ledger. The file itself is never counted as evidence. */
export const RETAINED_SESSION_USAGE_LEDGER = ".termina-retained-session-usage.json";

const SESSION_PART = /^part-([0-9]{6})\.jsonl$/;
const SESSION_ARCHIVE = /^(?:archive|bad)-[A-Za-z0-9._:-]+$/;
const STORED_IMAGE = /^[A-Za-z0-9._-]+-img-[1-9][0-9]{0,3}\.(png|jpe?g|webp|gif)$/;
const RETAINED_STAGING = /^t-[0-9a-f]{32}$/;
const RETAINED_STAGING_OWNER_BYTES = 512;
const RETAINED_CLAIM = /^\.termina-retained-claim-([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/;
const RETAINED_CLAIM_BYTES = 4096;
const MAX_RETAINED_BUNDLE_ENTRIES = 250_000;
/** Bound root-directory enumeration before allocating a names array. */
const MAX_RETAINED_ROOT_ENTRIES = MAX_RETAINED_SESSION_BUNDLES * 4;
/** Bounds every asynchronous retained-tree stack independently of bytes. */
const MAX_RETAINED_SCAN_DEPTH = 64;
const MAX_RETAINED_SCAN_PENDING = MAX_RETAINED_BUNDLE_ENTRIES;
const MAX_RETAINED_SCAN_WORK_BYTES = 128 * 1024 * 1024;
const RETAINED_USAGE_LEDGER_VERSION = 1;
const RETAINED_USAGE_LEDGER_TEMP = /^\.termina-retained-session-usage\.json\.tmp-[A-Za-z0-9-]+$/;
/** Bound serialized admission closures while a retention operation is slow. */
const RETENTION_QUEUE_HIGH_WATER = 128;

type RetainedClaimRecord = {
  runId: string;
  createdAt: number;
};

export type RetainedSessionClaim = {
  runId: string;
  claimPath: string;
  destinationBundle: string;
  kind: "staging" | "bundle";
  bytes: number | null;
};

type RetainedClaimRemovalTestHook = {
  stage: string;
  readyPath: string;
  releasePath: string;
};

export type SessionRetentionOwnerOptions = {
  testHooks?: {
    beforeRootBinding?: { stage: string; readyPath: string; releasePath: string };
    beforeClaimRemoval?: RetainedClaimRemovalTestHook;
    beforeBundleRemoval?: RetainedClaimRemovalTestHook;
  };
};

export type SessionRetentionTransactionOptions = {
  /**
   * Exact/conservative full-tree bytes reserved before the worker publishes.
   * Production finalization supplies the source bundle's recursive byte
   * envelope, including images and unknown files.
   */
  reserveBytes?: number;
};

export type RetainedSessionTransaction<T> = {
  destinationSessionFile: string;
  result: T;
};

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}

function usageZero(): RetainedUsage {
  return { bytes: 0, entries: 0, images: 0, unknowns: 0 };
}

function identityOf(info: BigIntStats): RetainedIdentity {
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    size: String(info.size),
    mtimeNs: String(info.mtimeNs),
    ctimeNs: String(info.ctimeNs),
  };
}

function sameIdentity(left: RetainedIdentity | null, right: RetainedIdentity | null): boolean {
  if (left === null || right === null) return left === right;
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function usageAdd(left: RetainedUsage, right: RetainedUsage): RetainedMeasurement {
  if (
    ![left.bytes, left.entries, left.images, left.unknowns, right.bytes, right.entries, right.images, right.unknowns]
      .every((value) => Number.isSafeInteger(value) && value >= 0)
    || left.bytes > MAX_RETAINED_SESSION_BYTES - right.bytes
  ) {
    return { ok: false, error: "retained session evidence exceeds its 4 GB bound; resolve or export it before retrying" };
  }
  const entries = left.entries + right.entries;
  const images = left.images + right.images;
  const unknowns = left.unknowns + right.unknowns;
  if (![entries, images, unknowns].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    return { ok: false, error: "retained session evidence accounting overflow; resolve or export it before retrying" };
  }
  return { ok: true, bytes: left.bytes + right.bytes, entries, images, unknowns };
}

/** Enumerate one directory without first allocating an unbounded readdir array. */
async function boundedDirectoryEntries(path: string, limit: number, errorMessage: string): Promise<string[]> {
  let directory;
  try {
    directory = await opendir(path);
  } catch {
    throw new Error(errorMessage);
  }
  const names: string[] = [];
  let nameBytes = 0;
  try {
    for await (const entry of directory) {
      const addedNameBytes = Buffer.byteLength(entry.name, "utf8");
      if (nameBytes > MAX_RETAINED_SCAN_WORK_BYTES - addedNameBytes) {
        throw new Error("retained session directory enumeration exceeded its bounded work budget");
      }
      if (names.length >= limit) throw new Error(`retained session root contains too many entries; resolve or export it before retrying`);
      nameBytes += addedNameBytes;
      names.push(entry.name);
      if ((names.length & 63) === 0) await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    }
    return names;
  } catch (error) {
    if (error instanceof Error && /too many entries/.test(error.message)) throw error;
    throw new Error(errorMessage);
  } finally {
    try {
      await directory.close();
    } catch {
      /* the iterator may already have closed the descriptor */
    }
  }
}

type RetainedTreeProof = string;

/**
 * Hash every owned node's relative name, type, and native identity. The
 * proof is intentionally metadata-only: accounting depends on names/types/
 * sizes, while ctime/mtime/inode changes catch nested replacement or writes.
 * The async walk yields regularly so a recovery rebuild never monopolizes the
 * Electron main loop.
 */
async function retainedTreeProof(path: string): Promise<RetainedTreeProof> {
  const digest = createHash("sha256");
  const initialWorkBytes = Buffer.byteLength(path, "utf8") + 1;
  if (initialWorkBytes > MAX_RETAINED_SCAN_WORK_BYTES) throw new Error("retained session evidence path exceeds its bounded work budget; resolve or export it before retrying");
  const pending: Array<{ path: string; relative: string; depth: number; workBytes: number }> = [{ path, relative: ".", depth: 0, workBytes: initialWorkBytes }];
  let pendingWorkBytes = initialWorkBytes;
  let entries = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    pendingWorkBytes -= current.workBytes;
    if (current.depth > MAX_RETAINED_SCAN_DEPTH) throw new Error("retained session evidence exceeds its depth bound; resolve or export it before retrying");
    const info = await lstat(current.path, { bigint: true });
    entries++;
    if (entries > MAX_RETAINED_BUNDLE_ENTRIES) throw new Error("retained session evidence contains too many entries; resolve or export it before retrying");
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error("retained session evidence contains an unsupported entry; resolve or export it before retrying");
    if (info.isFile()) {
      if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("retained session evidence byte count overflow; resolve or export it before retrying");
      const size = Number(info.size);
      if (bytes > MAX_RETAINED_SESSION_BYTES - size) throw new Error("retained session evidence exceeds its 4 GB bound; resolve or export it before retrying");
      bytes += size;
    }
    digest.update(`${current.relative}\0${info.isDirectory() ? "d" : "f"}\0${JSON.stringify(identityOf(info))}\n`);
    if (info.isDirectory()) {
      const names = await boundedDirectoryEntries(current.path, MAX_RETAINED_BUNDLE_ENTRIES, "retained session evidence contains too many entries; resolve or export it before retrying");
      names.sort().reverse();
      for (const name of names) {
        if (pending.length >= MAX_RETAINED_SCAN_PENDING) throw new Error("retained session evidence contains too many pending entries; resolve or export it before retrying");
        const childPath = join(current.path, name);
        const childRelative = current.relative === "." ? name : `${current.relative}/${name}`;
        const workBytes = Buffer.byteLength(childPath, "utf8") + Buffer.byteLength(childRelative, "utf8");
        if (workBytes > MAX_RETAINED_SCAN_WORK_BYTES || pendingWorkBytes > MAX_RETAINED_SCAN_WORK_BYTES - workBytes) {
          throw new Error("retained session evidence scan exceeded its bounded work budget; resolve or export it before retrying");
        }
        pending.push({ path: childPath, relative: childRelative, depth: current.depth + 1, workBytes });
        pendingWorkBytes += workBytes;
      }
    }
    if ((entries & 63) === 0) await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  }
  return digest.digest("hex");
}

async function inspectPath(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
type RetainedRootBinding = {
  path: string;
  identity: PromotionFsIdentity;
};

const retainedRootBindingPromises = new Map<string, Promise<RetainedRootBinding>>();

/** Establish the native capability before any claim or ledger publication. */
function bindRetainedRoot(
  rootPath: string,
  testHook?: { stage: string; readyPath: string; releasePath: string },
): Promise<RetainedRootBinding> {
  const key = resolve(rootPath);
  const existing = retainedRootBindingPromises.get(key);
  if (existing) return existing;
  const promise = bindRetainedRootOnce(rootPath, testHook);
  retainedRootBindingPromises.set(key, promise);
  void promise.catch(() => {
    if (retainedRootBindingPromises.get(key) === promise) retainedRootBindingPromises.delete(key);
  });
  return promise;
}

async function bindRetainedRootOnce(
  rootPath: string,
  testHook?: { stage: string; readyPath: string; releasePath: string },
): Promise<RetainedRootBinding> {
  const bound = await ensureBoundRetainedRoot(
    rootPath,
    "retained session root",
    {
      name: RETAINED_SESSION_ROOT_MARKER,
      content: Buffer.from(`${RETAINED_SESSION_ROOT_MARKER}\n`),
      mode: 0o600,
    },
    testHook,
  );
  return { path: bound.path, identity: { dev: bound.dev, ino: bound.ino, ...(bound.capability ? { capability: bound.capability } : {}) } };
}

type RetainedUsage = {
  bytes: number;
  entries: number;
  images: number;
  unknowns: number;
};

type RetainedAccounting = RetainedUsage & {
  bundleCount: number;
  stagingCount: number;
};

type RetainedMeasurement =
  | ({ ok: true } & RetainedUsage)
  | { ok: false; error: string };

type RetainedIdentity = {
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
};

type RetainedRootIdentity = {
  dev: string;
  ino: string;
};

type RetainedLedgerDestination = {
  name: string;
  identity: RetainedIdentity;
  usage: RetainedUsage;
  proof: RetainedTreeProof;
  kind: "staging" | "bundle";
  discardable: boolean;
};

type RetainedLedgerEntry = {
  name: string;
  kind: "bundle" | "staging" | "claim";
  identity: RetainedIdentity;
  usage: RetainedUsage;
  proof: RetainedTreeProof;
  discardable: boolean;
  destinationKind?: "staging" | "bundle";
  destination?: RetainedLedgerDestination;
};

type RetainedUsageLedger = {
  version: 1;
  root: RetainedRootIdentity;
  entries: RetainedLedgerEntry[];
  accounting: RetainedAccounting;
};

function retainedClaimName(runId: string): string {
  return `.termina-retained-claim-${runId}.json`;
}

async function readRetainedClaimAsync(root: string, name: string): Promise<{ record: RetainedClaimRecord; bytes: number } | null> {
  const match = RETAINED_CLAIM.exec(name);
  if (!match || !isCoreSessionId(match[1]!)) return null;
  const path = join(root, name);
  try {
    const info = await lstat(path, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0n || info.size > BigInt(RETAINED_CLAIM_BYTES)) return null;
    const raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > RETAINED_CLAIM_BYTES) return null;
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2 ||
      typeof record.runId !== "string" ||
      record.runId !== match[1] ||
      !isCoreSessionId(record.runId) ||
      typeof record.createdAt !== "number" ||
      !Number.isSafeInteger(record.createdAt) ||
      record.createdAt <= 0
    ) return null;
    return { record: { runId: record.runId, createdAt: record.createdAt }, bytes: Number(info.size) };
  } catch {
    return null;
  }
}

async function removeRetainedEntry(
  root: string,
  name: string,
  expectedIdentity: { dev: number; ino: number },
  retentionLock: SessionRetentionLock,
  testHook?: RetainedClaimRemovalTestHook,
): Promise<void> {
  if (validateSessionRetentionLease(root, retentionLock) === null) {
    throw new Error("retained session admission lock changed before cleanup");
  }
  const rootIdentity = {
    dev: String(retentionLock.rootIdentity.dev),
    ino: String(retentionLock.rootIdentity.ino),
  };
  await boundPromotionRemoveTree({
    root,
    // Carry the persisted lock identity as the restart-valid trust proof. The
    // native remove opens the root and parent descriptor-relatively, then
    // validates this identity before it can quarantine the leaf.
    rootIdentity,
    components: [name],
    parentIdentity: rootIdentity,
    expectedIdentity: { dev: String(expectedIdentity.dev), ino: String(expectedIdentity.ino) },
    ...(testHook ? { testHook } : {}),
  });
  await syncDirectory(root);
}

async function writeRetainedClaim(root: string, runId: string, retentionLock: SessionRetentionLock, rootBinding: RetainedRootBinding): Promise<string> {
  const name = retainedClaimName(runId);
  const finalPath = join(root, name);
  try {
    lstatSync(finalPath);
    throw new Error("the retained session destination has an unresolved claim");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  if (validateSessionRetentionLease(root, retentionLock) === null) throw new Error("retained session admission lock changed before claim publication");
  if (String(retentionLock.rootIdentity.dev) !== rootBinding.identity.dev || String(retentionLock.rootIdentity.ino) !== rootBinding.identity.ino) {
    throw new Error("retained session root identity changed before claim publication");
  }
  await boundPromotionWriteJsonFile({
    root: rootBinding.path,
    rootIdentity: rootBinding.identity,
    components: [name],
    parentIdentity: rootBinding.identity,
    value: { runId, createdAt: Date.now() },
    maxBytes: RETAINED_CLAIM_BYTES,
    mode: 0o600,
  });
  return finalPath;
}

async function removeRetainedClaim(
  root: string,
  runId: string,
  retentionLock: SessionRetentionLock,
  testHook?: RetainedClaimRemovalTestHook,
): Promise<void> {
  const path = join(root, retainedClaimName(runId));
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  const claim = await readRetainedClaimAsync(root, retainedClaimName(runId));
  if (claim === null) throw new Error("retained session claim is malformed or unreadable");
  // The admission lock serializes app owners, while the native primitive
  // binds the root, claim parent, and claim leaf across the final removal.
  // Node's pathname unlink would reopen the leaf after this proof and could
  // delete a same-UID replacement during an ABA or ancestor swap.
  await removeRetainedEntry(root, retainedClaimName(runId), info, retentionLock, testHook);
}

function isUncertainRetentionResult(value: unknown): boolean {
  return value !== null && typeof value === "object" && "ok" in value && (value as { ok?: unknown }).ok === false;
}

/** Measure a claim's destination even when its tree is only partially
 * materialized. A valid canonical bundle uses the schema-aware scanner; an
 * invalid but claimed tree is still app-owned evidence and is counted
 * recursively so it cannot hide bytes behind a malformed shape. */
async function measureClaimedDestination(root: string, runId: string): Promise<RetainedMeasurement> {
  const path = join(root, runId);
  let info: BigIntStats | null;
  try {
    info = await inspectPath(path);
  } catch {
    return { ok: false, error: "retained session claim contains an unreadable or partial tree; resolve or export it before retrying" };
  }
  if (info === null) return { ok: true, ...usageZero() };
  if (info.isSymbolicLink()) {
    return { ok: false, error: "retained session claim contains a symbolic link; resolve or export it before retrying" };
  }
  const canonical = await measureRetainedBundle(path);
  return canonical.ok ? canonical : measureRetainedClaimTree(path);
}

type RetainedStagingOwner = {
  runId: string;
  dev: number;
  ino: number;
};

async function readRetainedStagingOwner(path: string): Promise<RetainedStagingOwner | null> {
  const markerPath = join(path, RETAINED_STAGING_OWNER_NAME);
  try {
    const info = await lstat(markerPath, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0n || info.size > BigInt(RETAINED_STAGING_OWNER_BYTES)) return null;
    const raw = await readFile(markerPath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > RETAINED_STAGING_OWNER_BYTES) return null;
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).length !== 3
      || typeof record.runId !== "string"
      || !isCoreSessionId(record.runId)
      || typeof record.dev !== "number"
      || !Number.isSafeInteger(record.dev)
      || record.dev < 0
      || typeof record.ino !== "number"
      || !Number.isSafeInteger(record.ino)
      || record.ino < 0
    ) return null;
    return { runId: record.runId, dev: record.dev, ino: record.ino };
  } catch {
    return null;
  }
}

/** Count every regular file in an app-owned unresolved claim, including
 * partially materialized session trees and files not yet known to the schema. */
async function measureRetainedClaimTree(path: string): Promise<RetainedMeasurement> {
  const initialWorkBytes = Buffer.byteLength(path, "utf8");
  if (initialWorkBytes > MAX_RETAINED_SCAN_WORK_BYTES) {
    return { ok: false, error: "retained session claim path exceeds its bounded work budget; resolve or export it before retrying" };
  }
  const pending: Array<{ path: string; depth: number; workBytes: number }> = [{ path, depth: 0, workBytes: initialWorkBytes }];
  let pendingWorkBytes = initialWorkBytes;
  let entries = 0;
  let total = 0;
  let images = 0;
  let unknowns = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    pendingWorkBytes -= current.workBytes;
    if (current.depth > MAX_RETAINED_SCAN_DEPTH) {
      return { ok: false, error: "retained session claim exceeds its depth bound; resolve or export it before retrying" };
    }
    let info: BigIntStats;
    try {
      info = await lstat(current.path, { bigint: true });
    } catch {
      return { ok: false, error: "retained session claim contains an unreadable or partial tree; resolve or export it before retrying" };
    }
    if (info.isSymbolicLink()) {
      return { ok: false, error: "retained session claim contains a symbolic link; resolve or export it before retrying" };
    }
    entries++;
    if (entries > MAX_RETAINED_BUNDLE_ENTRIES) {
      return { ok: false, error: "retained session claim contains too many entries; resolve or export it before retrying" };
    }
    if (info.isDirectory()) {
      let children: string[];
      try {
        children = await boundedDirectoryEntries(current.path, MAX_RETAINED_BUNDLE_ENTRIES, "retained session claim contains an unreadable or partial tree; resolve or export it before retrying");
      } catch {
        return { ok: false, error: "retained session claim contains an unreadable or partial tree; resolve or export it before retrying" };
      }
      for (const child of children) {
        if (pending.length >= MAX_RETAINED_SCAN_PENDING) {
          return { ok: false, error: "retained session claim contains too many pending entries; resolve or export it before retrying" };
        }
        const childPath = join(current.path, child);
        const workBytes = Buffer.byteLength(childPath, "utf8");
        if (workBytes > MAX_RETAINED_SCAN_WORK_BYTES || pendingWorkBytes > MAX_RETAINED_SCAN_WORK_BYTES - workBytes) {
          return { ok: false, error: "retained session claim scan exceeded its bounded work budget; resolve or export it before retrying" };
        }
        pending.push({ path: childPath, depth: current.depth + 1, workBytes });
        pendingWorkBytes += workBytes;
      }
      if ((entries & 63) === 0) await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      continue;
    }
    if (!info.isFile()) {
      return { ok: false, error: "retained session claim contains an unsupported entry; resolve or export it before retrying" };
    }
    if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, error: "retained session claim byte count overflow; resolve or export it before retrying" };
    const size = Number(info.size);
    if (!Number.isSafeInteger(size) || total > MAX_RETAINED_SESSION_BYTES - size) {
      return { ok: false, error: "retained session evidence exceeds its 4 GB bound; resolve or export it before retrying" };
    }
    total += size;
    if (STORED_IMAGE.test(current.path.slice(current.path.lastIndexOf("/") + 1))) images++;
    else unknowns++;
    if ((entries & 63) === 0) await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  }
  return { ok: true, bytes: total, entries, images, unknowns };
}

async function parseRetainedJsonlAsync(path: string, size: number): Promise<RetainedMeasurement> {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SESSION_BUNDLE_BYTES) {
    return { ok: false, error: "retained session evidence contains an oversized session segment; resolve or export it before retrying" };
  }
  if (size === 0) return { ok: true, ...usageZero(), bytes: size };
  const input = createReadStream(path, { encoding: "utf8" });
  const maxRecordBytes = 1 * 1024 * 1024;
  let buffered = "";
  let records = 0;
  const parseLine = async (line: string): Promise<void> => {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line || Buffer.byteLength(line, "utf8") > maxRecordBytes) throw new Error("invalid session record");
    const record = JSON.parse(line) as unknown;
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("invalid session record");
    records++;
    if ((records & 63) === 0) await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  };
  try {
    for await (const chunk of input) {
      buffered += String(chunk);
      if (Buffer.byteLength(buffered, "utf8") > maxRecordBytes && !buffered.includes("\n")) throw new Error("oversized session record");
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        await parseLine(line);
        newline = buffered.indexOf("\n");
      }
      if (Buffer.byteLength(buffered, "utf8") > maxRecordBytes) throw new Error("oversized session record");
      if ((records & 63) === 0) await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    }
    if (buffered.length > 0) throw new Error("partial session record");
    return { ok: true, ...usageZero(), bytes: size };
  } catch {
    return { ok: false, error: "retained session evidence contains a malformed or partial session segment; resolve or export it before retrying" };
  } finally {
    input.destroy();
  }
}

async function measureRetainedSegment(path: string, entryBudget: { value: number }, allowEmpty = false): Promise<RetainedMeasurement> {
  let info: BigIntStats;
  try {
    info = await lstat(path, { bigint: true });
  } catch {
    return { ok: false, error: "retained session evidence contains an unreadable or partial bundle; resolve or export it before retrying" };
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    return { ok: false, error: "retained session evidence contains an unexpected entry; resolve or export it before retrying" };
  }
  let names: string[];
  try {
    names = await boundedDirectoryEntries(path, MAX_RETAINED_BUNDLE_ENTRIES, "retained session evidence contains an unreadable or partial bundle; resolve or export it before retrying");
  } catch {
    return { ok: false, error: "retained session evidence contains an unreadable or partial bundle; resolve or export it before retrying" };
  }
  let total = usageZero();
  let active = false;
  const partNumbers = new Set<number>();
  for (const name of names) {
    entryBudget.value++;
    if (entryBudget.value > MAX_RETAINED_BUNDLE_ENTRIES) {
      return { ok: false, error: "retained session evidence contains too many entries; resolve or export it before retrying" };
    }
    const child = join(path, name);
    let childInfo: BigIntStats;
    try {
      childInfo = await lstat(child, { bigint: true });
    } catch {
      return { ok: false, error: "retained session evidence contains an unreadable or partial bundle; resolve or export it before retrying" };
    }
    if (childInfo.isSymbolicLink()) {
      return { ok: false, error: "retained session evidence contains a symbolic link; resolve or export it before retrying" };
    }
    const part = SESSION_PART.exec(name);
    const isJsonl = name === SESSION_ACTIVE_NAME || part !== null;
    if (isJsonl) {
      if (!childInfo.isFile()) {
        return { ok: false, error: "retained session evidence contains an unexpected session entry; resolve or export it before retrying" };
      }
      if (name === SESSION_ACTIVE_NAME) {
        if (active) return { ok: false, error: "retained session evidence contains duplicate active segments; resolve or export it before retrying" };
        active = true;
      } else {
        const number = Number(part![1]);
        if (!Number.isSafeInteger(number) || number < 1 || partNumbers.has(number)) {
          return { ok: false, error: "retained session evidence contains invalid session parts; resolve or export it before retrying" };
        }
        partNumbers.add(number);
      }
      if (childInfo.size > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, error: "retained session evidence byte count overflow; resolve or export it before retrying" };
      const parsed = await parseRetainedJsonlAsync(child, Number(childInfo.size));
      if (!parsed.ok) return parsed;
      const added = usageAdd(total, { bytes: parsed.bytes, entries: 1, images: 0, unknowns: 0 });
      if (!added.ok) return added;
      total = added;
      continue;
    }
    if (STORED_IMAGE.test(name)) {
      if (!childInfo.isFile()) {
        return { ok: false, error: "retained session evidence contains an unexpected image entry; resolve or export it before retrying" };
      }
      if (childInfo.size > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, error: "retained session evidence byte count overflow; resolve or export it before retrying" };
      const added = usageAdd(total, { bytes: Number(childInfo.size), entries: 1, images: 1, unknowns: 0 });
      if (!added.ok) return added;
      total = added;
      continue;
    }
    return { ok: false, error: "retained session evidence contains an unknown bundle entry; resolve or export it before retrying" };
  }
  if (!active && !(allowEmpty && names.length === 0)) {
    return { ok: false, error: "retained session evidence is missing its active session segment; resolve or export it before retrying" };
  }
  const sortedPartNumbers = [...partNumbers].sort((left, right) => left - right);
  for (let index = 0; index < sortedPartNumbers.length; index++) {
    if (sortedPartNumbers[index] !== index + 1) {
      return { ok: false, error: "retained session evidence contains non-contiguous session parts; resolve or export it before retrying" };
    }
  }
  return { ok: true, ...total };
}

/**
 * The core session owner may leave a named t-* staging sibling after a
 * successful install when descriptor-bound recursive cleanup is unavailable.
 * It is app-owned evidence, not a durable session bundle: recognize only the
 * exact current-only shape and account every child under the same byte bound.
 */
async function measureRetainedStaging(path: string): Promise<RetainedMeasurement> {
  let info: BigIntStats;
  try {
    info = await lstat(path, { bigint: true });
  } catch {
    return { ok: false, error: "retained session evidence contains an unreadable or partial staging bundle; resolve or export it before retrying" };
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    return { ok: false, error: "retained session evidence contains an unexpected staging entry; resolve or export it before retrying" };
  }
  let names: string[];
  try {
    names = await boundedDirectoryEntries(path, MAX_RETAINED_BUNDLE_ENTRIES, "retained session evidence contains an unreadable or partial staging bundle; resolve or export it before retrying");
  } catch {
    return { ok: false, error: "retained session evidence contains an unreadable or partial staging bundle; resolve or export it before retrying" };
  }
  if (names.length === 0) return { ok: true, ...usageZero() };
  const hasOwner = names.includes(RETAINED_STAGING_OWNER_NAME);
  if (names.some((name) => name !== SESSION_CURRENT_DIR && name !== RETAINED_STAGING_OWNER_NAME)) {
    return { ok: false, error: "retained session evidence contains an unknown staging entry; resolve or export it before retrying" };
  }
  let ownerBytes = 0;
  let owner: RetainedStagingOwner | null = null;
  if (hasOwner) {
    const ownerInfo = await lstat(join(path, RETAINED_STAGING_OWNER_NAME), { bigint: true });
    owner = await readRetainedStagingOwner(path);
    if (!owner || String(owner.dev) !== String(info.dev) || String(owner.ino) !== String(info.ino)) {
      return { ok: false, error: "retained session evidence contains an unreadable staging owner marker; resolve or export it before retrying" };
    }
    if (ownerInfo.size > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, error: "retained session evidence byte count overflow; resolve or export it before retrying" };
    ownerBytes = Number(ownerInfo.size);
  }
  // Successful installation moves `current/` into the destination bundle,
  // leaving a marker-only t-* sibling. The marker is the durable ownership
  // proof for explicit reclaim; requiring current/ here would classify every
  // real worker finalize as malformed evidence and make it unreclaimable.
  if (!names.includes(SESSION_CURRENT_DIR)) {
    return hasOwner
      ? usageAdd(usageZero(), { bytes: ownerBytes, entries: 1, images: 0, unknowns: 0 })
      : { ok: false, error: "retained session evidence contains an incomplete staging bundle; resolve or export it before retrying" };
  }
  const current = join(path, SESSION_CURRENT_DIR);
  try {
    const currentInfo = await lstat(current, { bigint: true });
    if (!currentInfo.isDirectory() || currentInfo.isSymbolicLink()) {
      return { ok: false, error: "retained session evidence contains an unexpected staging current directory; resolve or export it before retrying" };
    }
  } catch {
    return { ok: false, error: "retained session evidence contains an unreadable or partial staging bundle; resolve or export it before retrying" };
  }
  const entryBudget = { value: hasOwner ? 2 : 1 };
  const measured = await measureRetainedSegment(current, entryBudget, true);
  if (!measured.ok) return measured;
  const withOwner = usageAdd(measured, { bytes: ownerBytes, entries: hasOwner ? 1 : 0, images: 0, unknowns: 0 });
  return withOwner;
}

async function measureRetainedBundle(path: string): Promise<RetainedMeasurement> {
  let info: BigIntStats;
  try {
    info = await lstat(path, { bigint: true });
  } catch {
    return { ok: false, error: "retained session evidence contains an unreadable or partial bundle; resolve or export it before retrying" };
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    return { ok: false, error: "retained session evidence contains an unexpected entry; resolve or export it before retrying" };
  }
  let names: string[];
  try {
    names = await boundedDirectoryEntries(path, MAX_RETAINED_BUNDLE_ENTRIES, "retained session evidence contains an unreadable or partial bundle; resolve or export it before retrying");
  } catch {
    return { ok: false, error: "retained session evidence contains an unreadable or partial bundle; resolve or export it before retrying" };
  }
  let currentCount = 0;
  let total = usageZero();
  const entryBudget = { value: 0 };
  for (const name of names) {
    entryBudget.value++;
    if (entryBudget.value > MAX_RETAINED_BUNDLE_ENTRIES) {
      return { ok: false, error: "retained session evidence contains too many entries; resolve or export it before retrying" };
    }
    const child = join(path, name);
    let childInfo: BigIntStats;
    try {
      childInfo = await lstat(child, { bigint: true });
    } catch {
      return { ok: false, error: "retained session evidence contains an unreadable or partial bundle; resolve or export it before retrying" };
    }
    if (childInfo.isSymbolicLink()) {
      return { ok: false, error: "retained session evidence contains a symbolic link; resolve or export it before retrying" };
    }
    if (name === SESSION_CURRENT_DIR || SESSION_ARCHIVE.test(name)) {
      if (!childInfo.isDirectory()) {
        return { ok: false, error: "retained session evidence contains an unexpected bundle directory; resolve or export it before retrying" };
      }
      if (name === SESSION_CURRENT_DIR) currentCount++;
      const measured = await measureRetainedSegment(child, entryBudget);
      if (!measured.ok) return measured;
      const added = usageAdd(total, measured);
      if (!added.ok) return added;
      total = added;
      continue;
    }
    return { ok: false, error: "retained session evidence contains an unknown bundle entry; resolve or export it before retrying" };
  }
  if (currentCount !== 1) {
    return { ok: false, error: "retained session evidence must contain exactly one current directory; resolve or export it before retrying" };
  }
  return { ok: true, ...total };
}

type RetainedStagingEntry = {
  name: string;
  path: string;
  info: Stats;
};

/** Find only staging siblings durably attributed to one finalized run. */
async function findOwnedRetainedStaging(root: string, runId: string): Promise<RetainedStagingEntry[]> {
  const owned: RetainedStagingEntry[] = [];
  let names: string[];
  try {
    names = await boundedDirectoryEntries(root, MAX_RETAINED_ROOT_ENTRIES, "retained session root contains too many entries; resolve or export it before retrying");
  } catch {
    throw new Error("retained session root is unreadable; resolve or export it before retrying");
  }
  for (const name of names) {
    if (!RETAINED_STAGING.test(name)) continue;
    const path = join(root, name);
    let info: Stats;
    try {
      info = await lstat(path);
    } catch {
      throw new Error("retained staging evidence is unreadable; resolve or export it before retrying");
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("retained staging evidence is not a directory; resolve or export it before retrying");
    }
    const owner = await readRetainedStagingOwner(path);
    if (owner === null) {
      try {
        await lstat(join(path, RETAINED_STAGING_OWNER_NAME));
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        throw new Error("retained staging owner marker is unreadable; resolve or export it before retrying");
      }
      throw new Error("retained staging owner marker is malformed or changed; resolve or export it before retrying");
    }
    if (owner.dev !== info.dev || owner.ino !== info.ino) {
      throw new Error("retained staging owner marker is malformed or changed; resolve or export it before retrying");
    }
    if (owner.runId !== runId) continue;
    const measured = await measureRetainedStaging(path);
    if (!measured.ok) throw new Error(measured.error);
    owned.push({ name, path, info });
  }
  return owned;
}

async function discardOwnedRetainedStaging(root: string, runId: string, lock: SessionRetentionLock): Promise<string[]> {
  const removed: string[] = [];
  for (const staging of await findOwnedRetainedStaging(root, runId)) {
    await removeRetainedEntry(root, staging.name, staging.info, lock);
    removed.push(staging.name);
  }
  return removed;
}

function isRetainedLedgerMetadata(name: string): boolean {
  return name === RETAINED_SESSION_ROOT_MARKER
    || name === RETAINED_SESSION_ADMISSION_LOCK
    || name === RETAINED_SESSION_USAGE_LEDGER
    || RETAINED_USAGE_LEDGER_TEMP.test(name);
}

async function retainedRootEntries(root: string): Promise<string[]> {
  const names = await boundedDirectoryEntries(
    root,
    MAX_RETAINED_ROOT_ENTRIES,
    "retained session root contains too many entries; resolve or export it before retrying",
  );
  return names.filter((name) => !isRetainedLedgerMetadata(name)).sort();
}

function validUsage(value: unknown, maxEntries = MAX_RETAINED_BUNDLE_ENTRIES): value is RetainedUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!["bytes", "entries", "images", "unknowns"].every((key) => {
    const item = record[key];
    return typeof item === "number" && Number.isSafeInteger(item) && item >= 0;
  })) return false;
  const bytes = record.bytes as number;
  const entries = record.entries as number;
  const images = record.images as number;
  const unknowns = record.unknowns as number;
  return bytes <= MAX_RETAINED_SESSION_BYTES
    && entries <= maxEntries
    && images <= entries
    && unknowns <= entries;
}

function validIdentity(value: unknown): value is RetainedIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every((key) => typeof record[key] === "string" && /^\d+$/.test(record[key] as string));
}

function validRootIdentity(value: unknown): value is RetainedRootIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.dev === "string" && /^\d+$/.test(record.dev)
    && typeof record.ino === "string" && /^\d+$/.test(record.ino);
}

function validLedgerEntry(value: unknown): value is RetainedLedgerEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || (!RETAINED_CLAIM.test(record.name) && !RETAINED_STAGING.test(record.name) && !isCoreSessionId(record.name))) return false;
  if (record.kind !== "bundle" && record.kind !== "staging" && record.kind !== "claim") return false;
  const maxUsageEntries = record.kind === "claim" ? MAX_RETAINED_BUNDLE_ENTRIES + 1 : MAX_RETAINED_BUNDLE_ENTRIES;
  if (!validIdentity(record.identity) || !validUsage(record.usage, maxUsageEntries) || typeof record.proof !== "string" || !/^[0-9a-f]{64}$/.test(record.proof) || typeof record.discardable !== "boolean") return false;
  if (record.kind !== "claim") return record.destination === undefined && record.destinationKind === undefined;
  const claimMatch = RETAINED_CLAIM.exec(record.name);
  if (!claimMatch || !isCoreSessionId(claimMatch[1]!)) return false;
  if (record.destinationKind !== "bundle" && record.destinationKind !== "staging") return false;
  if (record.destination !== undefined) {
    const destination = record.destination as Record<string, unknown>;
    if (typeof destination.name !== "string" || destination.name !== claimMatch[1]) return false;
    if (destination.kind !== record.destinationKind || !validIdentity(destination.identity) || !validUsage(destination.usage) || typeof destination.proof !== "string" || !/^[0-9a-f]{64}$/.test(destination.proof) || typeof destination.discardable !== "boolean") return false;
  }
  return true;
}

function accountingFromEntries(entries: RetainedLedgerEntry[]): RetainedAccounting {
  let usage = usageZero();
  let bundleCount = 0;
  let stagingCount = 0;
  for (const entry of entries) {
    const added = usageAdd(usage, entry.usage);
    if (!added.ok) throw new Error(added.error);
    usage = added;
    const kind = entry.kind === "claim" ? entry.destinationKind ?? "staging" : entry.kind;
    if (kind === "bundle") bundleCount++;
    else stagingCount++;
  }
  if (bundleCount + stagingCount > MAX_RETAINED_SESSION_BUNDLES) {
    throw new Error(`retained session evidence exceeds its ${MAX_RETAINED_SESSION_BUNDLES}-bundle bound; resolve or export it before retrying`);
  }
  return { ...usage, bundleCount, stagingCount };
}

function sameAccounting(left: RetainedAccounting, right: RetainedAccounting): boolean {
  return left.bytes === right.bytes
    && left.entries === right.entries
    && left.images === right.images
    && left.unknowns === right.unknowns
    && left.bundleCount === right.bundleCount
    && left.stagingCount === right.stagingCount;
}

function sameUsage(left: RetainedUsage, right: RetainedUsage): boolean {
  return left.bytes === right.bytes
    && left.entries === right.entries
    && left.images === right.images
    && left.unknowns === right.unknowns;
}

function sameRetainedLedgerDestination(left: RetainedLedgerDestination, right: RetainedLedgerDestination): boolean {
  return left.name === right.name
    && left.kind === right.kind
    && left.discardable === right.discardable
    && sameIdentity(left.identity, right.identity)
    && sameUsage(left.usage, right.usage)
    && left.proof === right.proof;
}

function sameRetainedLedgerEntry(left: RetainedLedgerEntry, right: RetainedLedgerEntry): boolean {
  const destinationsMatch = left.destination === undefined
    ? right.destination === undefined
    : right.destination !== undefined && sameRetainedLedgerDestination(left.destination, right.destination);
  return left.name === right.name
    && left.kind === right.kind
    && left.discardable === right.discardable
    && left.destinationKind === right.destinationKind
    && sameIdentity(left.identity, right.identity)
    && sameUsage(left.usage, right.usage)
    && left.proof === right.proof
    && destinationsMatch;
}

function expectedLedgerNames(entries: RetainedLedgerEntry[]): string[] {
  const names = new Set<string>();
  for (const entry of entries) {
    names.add(entry.name);
    if (entry.kind === "claim" && entry.destination) names.add(entry.destination.name);
  }
  return [...names].sort();
}

function retainedLedgerPath(root: string): string {
  return join(root, RETAINED_SESSION_USAGE_LEDGER);
}

async function writeRetainedUsageLedger(root: RetainedRootBinding, ledger: RetainedUsageLedger): Promise<void> {
  await boundPromotionWriteJsonFile({
    root: root.path,
    rootIdentity: root.identity,
    components: [RETAINED_SESSION_USAGE_LEDGER],
    parentIdentity: root.identity,
    value: ledger,
    maxBytes: 8 * 1024 * 1024,
    mode: 0o600,
  });
}

async function readRetainedUsageLedger(root: string): Promise<RetainedUsageLedger | null> {
  const path = retainedLedgerPath(root);
  let info: BigIntStats | null;
  try {
    info = await inspectPath(path);
  } catch {
    return null;
  }
  if (info === null) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8n * 1024n * 1024n) return null;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== RETAINED_USAGE_LEDGER_VERSION || !validRootIdentity(record.root) || !Array.isArray(record.entries) || record.entries.length > MAX_RETAINED_ROOT_ENTRIES || !record.entries.every(validLedgerEntry)) return null;
  const entries = record.entries as RetainedLedgerEntry[];
  let accounting: RetainedAccounting;
  try {
    accounting = accountingFromEntries(entries);
  } catch {
    return null;
  }
  if (!record.accounting || typeof record.accounting !== "object" || !sameAccounting(accounting, record.accounting as RetainedAccounting)) return null;
  // A destination is represented inside its claim while the claim is live;
  // accepting both that nested destination and a second top-level entry would
  // double-count one root path and make a forged ledger look internally
  // consistent. Duplicate top-level names are likewise never a valid build.
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) return null;
  const topLevelNames = new Set(entries.map((entry) => entry.name));
  for (const entry of entries) {
    if (entry.kind === "claim" && entry.destination && topLevelNames.has(entry.destination.name)) return null;
  }

  const rootInfo = await inspectPath(root);
  if (rootInfo === null || !rootInfo.isDirectory() || rootInfo.isSymbolicLink() || String(rootInfo.dev) !== record.root.dev || String(rootInfo.ino) !== record.root.ino) return null;
  const names = await retainedRootEntries(root);
  if (JSON.stringify(names) !== JSON.stringify(expectedLedgerNames(entries))) return null;
  for (const entry of entries) {
    let measured: RetainedLedgerEntry;
    try {
      measured = await measureRetainedLedgerEntry(root, entry);
    } catch {
      return null;
    }
    // The proof authenticates the tree shape/identities, but it is not a
    // substitute for the schema-aware measurement. Compare every stored
    // usage field (including image/unknown classification and claim
    // destination accounting) against a fresh measurement before admission.
    if (!sameRetainedLedgerEntry(entry, measured)) return null;
  }
  return { version: 1, root: { dev: record.root.dev, ino: record.root.ino }, entries, accounting };
}

async function claimLedgerEntry(root: string, name: string): Promise<RetainedLedgerEntry> {
  const claim = await readRetainedClaimAsync(root, name);
  if (claim === null) throw new Error("retained session claim is malformed or unreadable");
  const claimInfo = await lstat(join(root, name), { bigint: true });
  if (claimInfo.isSymbolicLink() || !claimInfo.isFile()) throw new Error("retained session claim is malformed or unreadable");
  const claimProof = await retainedTreeProof(join(root, name));
  const destinationPath = join(root, claim.record.runId);
  const destinationInfo = await inspectPath(destinationPath);
  const destination = await measureClaimedDestination(root, claim.record.runId);
  if (!destination.ok) throw new Error(destination.error);
  let destinationKind: "staging" | "bundle" = "staging";
  let discardable = destinationInfo === null;
  let destinationEntry: RetainedLedgerDestination | undefined;
  let destinationProof: RetainedTreeProof | undefined;
  if (destinationInfo !== null) {
    if (destinationInfo.isSymbolicLink()) throw new Error("retained session claim contains a symbolic link; resolve or export it before retrying");
    const canonical = destinationInfo.isDirectory() ? await measureRetainedBundle(destinationPath) : { ok: false as const, error: "not a canonical bundle" };
    if (canonical.ok) {
      destinationKind = "bundle";
      discardable = true;
    } else {
      const staging = await measureRetainedStaging(destinationPath);
    if (staging.ok) {
        destinationKind = "staging";
        discardable = true;
      }
    }
    destinationProof = await retainedTreeProof(destinationPath);
    destinationEntry = {
      name: claim.record.runId,
      identity: identityOf(destinationInfo),
      usage: destination,
      proof: destinationProof,
      kind: destinationKind,
      discardable,
    };
  }
  const withClaim = usageAdd(
    { ...usageZero(), bytes: claim.bytes, entries: 1 },
    destination,
  );
  if (!withClaim.ok) throw new Error(withClaim.error);
  return {
    name,
    kind: "claim",
    identity: identityOf(claimInfo),
    usage: withClaim,
    proof: claimProof,
    discardable,
    destinationKind,
    ...(destinationEntry ? { destination: destinationEntry } : {}),
  };
}

async function measureRetainedLedgerEntry(root: string, entry: RetainedLedgerEntry): Promise<RetainedLedgerEntry> {
  if (entry.kind === "claim") return claimLedgerEntry(root, entry.name);
  const path = join(root, entry.name);
  const info = await inspectPath(path);
  if (info === null) throw new Error("retained session evidence changed while verifying its usage");
  const measured = entry.kind === "bundle" ? await measureRetainedBundle(path) : await measureRetainedStaging(path);
  if (!measured.ok) throw new Error(measured.error);
  return {
    name: entry.name,
    kind: entry.kind,
    identity: identityOf(info),
    usage: measured,
    proof: await retainedTreeProof(path),
    discardable: entry.kind === "bundle",
  };
}

async function buildRetainedUsageLedger(root: string, rootBinding: RetainedRootBinding, persist = true): Promise<RetainedUsageLedger> {
  const rootInfo = await inspectPath(root);
  if (rootInfo === null || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("the retained session root is not a private app-owned directory");
  if (String(rootInfo.dev) !== rootBinding.identity.dev || String(rootInfo.ino) !== rootBinding.identity.ino) {
    throw new Error("retained session root identity changed while accounting");
  }
  const names = await retainedRootEntries(root);
  const claimedRunIds = new Set<string>();
  const entries: RetainedLedgerEntry[] = [];
  for (const name of names) {
    if (RETAINED_CLAIM.test(name)) {
      const entry = await claimLedgerEntry(root, name);
      claimedRunIds.add(entry.destination?.name ?? RETAINED_CLAIM.exec(name)![1]!);
      entries.push(entry);
      continue;
    }
    // A claim can temporarily own a t-* staging destination. It is already
    // represented by the claim entry (including its destination usage), so
    // never account that same path a second time as a root sibling.
    if (claimedRunIds.has(name)) continue;
    if (RETAINED_STAGING.test(name)) {
      const path = join(root, name);
      const info = await lstat(path, { bigint: true });
      const measured = await measureRetainedStaging(path);
      if (!measured.ok) throw new Error(measured.error);
      entries.push({ name, kind: "staging", identity: identityOf(info), usage: measured, proof: await retainedTreeProof(path), discardable: false });
      continue;
    }
    if (!isCoreSessionId(name)) throw new Error("retained session evidence contains an unexpected entry; resolve it before retrying");
    const path = join(root, name);
    const info = await lstat(path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("retained session evidence contains an unexpected entry; resolve it before retrying");
    const children = await boundedDirectoryEntries(path, MAX_RETAINED_BUNDLE_ENTRIES, "retained session evidence contains an unreadable or partial bundle; resolve or export it before retrying");
    if (children.length === 0) {
      entries.push({ name, kind: "staging", identity: identityOf(info), usage: usageZero(), proof: await retainedTreeProof(path), discardable: false });
      continue;
    }
    const measured = await measureRetainedBundle(path);
    if (!measured.ok) throw new Error(measured.error);
    entries.push({ name, kind: "bundle", identity: identityOf(info), usage: measured, proof: await retainedTreeProof(path), discardable: true });
  }
  const accounting = accountingFromEntries(entries);
  const stableNames = await retainedRootEntries(root);
  if (JSON.stringify(stableNames) !== JSON.stringify(expectedLedgerNames(entries))) throw new Error("retained session evidence changed while accounting; retry after it settles");
  for (const entry of entries) {
    const current = await inspectPath(join(root, entry.name));
    if (current === null || !sameIdentity(identityOf(current), entry.identity)) throw new Error("retained session evidence changed while accounting; retry after it settles");
  }
  const ledger: RetainedUsageLedger = {
    version: 1,
    root: { dev: String(rootInfo.dev), ino: String(rootInfo.ino) },
    entries,
    accounting,
  };
  if (persist) await writeRetainedUsageLedger(rootBinding, ledger);
  return ledger;
}

async function loadRetainedUsageLedger(
  root: string,
  rootBinding: RetainedRootBinding,
  options: { persist?: boolean } = {},
): Promise<RetainedUsageLedger> {
  const existing = await readRetainedUsageLedger(root);
  return existing ?? buildRetainedUsageLedger(root, rootBinding, options.persist !== false);
}

async function retainedLedgerFileIdentity(root: string): Promise<RetainedIdentity | null> {
  const info = await inspectPath(retainedLedgerPath(root));
  return info === null ? null : identityOf(info);
}

function ledgerWithoutNames(ledger: RetainedUsageLedger, names: ReadonlySet<string>): RetainedUsageLedger {
  const entries = ledger.entries.filter((entry) => !names.has(entry.name));
  return { ...ledger, entries, accounting: accountingFromEntries(entries) };
}

async function persistRetainedLedgerAfterRemoval(root: string, rootBinding: RetainedRootBinding, ledger: RetainedUsageLedger, removedNames: ReadonlySet<string>): Promise<void> {
  const next = ledgerWithoutNames(ledger, removedNames);
  const names = await retainedRootEntries(root);
  if (JSON.stringify(names) !== JSON.stringify(expectedLedgerNames(next.entries))) {
    throw new Error("retained session evidence changed during cleanup; resolve it before retrying");
  }
  for (const entry of next.entries) {
    const current = await inspectPath(join(root, entry.name));
    if (current === null || !sameIdentity(identityOf(current), entry.identity)) {
      throw new Error("retained session evidence changed during cleanup; resolve it before retrying");
    }
    if (await retainedTreeProof(join(root, entry.name)) !== entry.proof) {
      throw new Error("retained session evidence changed during cleanup; resolve it before retrying");
    }
  }
  await writeRetainedUsageLedger(rootBinding, next);
}

async function addRetainedTransactionEntries(root: string, ledger: RetainedUsageLedger, claimEntry: RetainedLedgerEntry): Promise<RetainedUsageLedger> {
  const names = await retainedRootEntries(root);
  const known = new Set(expectedLedgerNames(ledger.entries));
  known.add(claimEntry.name);
  if (claimEntry.destination) known.add(claimEntry.destination.name);
  const entries = [...ledger.entries.filter((entry) => entry.name !== claimEntry.name), claimEntry];
  for (const name of names) {
    if (known.has(name)) continue;
    if (!RETAINED_STAGING.test(name)) throw new Error("retained session evidence contains an unexpected entry; resolve it before retrying");
    const path = join(root, name);
    const info = await lstat(path, { bigint: true });
    const measured = await measureRetainedStaging(path);
    if (!measured.ok) throw new Error(measured.error);
    entries.push({ name, kind: "staging", identity: identityOf(info), usage: measured, proof: await retainedTreeProof(path), discardable: false });
    known.add(name);
  }
  const next = {
    ...ledger,
    entries,
    accounting: accountingFromEntries(entries),
  } satisfies RetainedUsageLedger;
  if (JSON.stringify(names) !== JSON.stringify(expectedLedgerNames(entries))) throw new Error("retained session evidence changed while publishing; resolve it before retrying");
  return next;
}

export class SessionRetentionOwner {
  private queueTail: Promise<void> = Promise.resolve();
  private queuedOperations = 0;
  private readonly testHooks?: SessionRetentionOwnerOptions["testHooks"];
  private rootBindingPromise: Promise<RetainedRootBinding> | null = null;

  constructor(private readonly rootPath: string, options: SessionRetentionOwnerOptions = {}) {
    if (options.testHooks && process.env.TERMINA_CORE_TEST !== "1") {
      throw new Error("test-only session retention controls are unavailable");
    }
    this.testHooks = options.testHooks;
  }

  /** Re-open the descriptor-bound root because issued capabilities expire on restart. */
  private async rootBinding(): Promise<RetainedRootBinding> {
    this.rootBindingPromise ??= bindRetainedRoot(this.rootPath, this.testHooks?.beforeRootBinding);
    const bound = await this.rootBindingPromise;
    try {
      const identity = await boundPromotionOpenDirectory({
        path: bound.path,
        expectedIdentity: { dev: bound.identity.dev, ino: bound.identity.ino },
        ...(bound.identity.capability ? { capability: bound.identity.capability } : {}),
      });
      return { path: bound.path, identity };
    } catch {
      const identity = await boundPromotionOpenDirectory({
        path: bound.path,
        expectedIdentity: { dev: bound.identity.dev, ino: bound.identity.ino },
      });
      return { path: bound.path, identity };
    }
  }

  private assertLockRoot(lock: SessionRetentionLock, root: RetainedRootBinding): void {
    if (String(lock.rootIdentity.dev) !== root.identity.dev || String(lock.rootIdentity.ino) !== root.identity.ino) {
      throw new Error("retained session root identity changed before admission");
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.queuedOperations >= RETENTION_QUEUE_HIGH_WATER) {
      return Promise.reject(new Error("session retention queue is at its high-water mark; retry after pending work drains"));
    }
    this.queuedOperations += 1;
    const run = this.queueTail.then(operation, operation);
    const settled = run.finally(() => {
      this.queuedOperations -= 1;
    });
    this.queueTail = settled.then(
      () => undefined,
      () => undefined,
    );
    return settled;
  }

  /**
   * Admit and publish one retained core bundle as a single serialized
   * transaction. The callback must await the canonical session worker; its
   * result (including commit uncertainty) is returned unchanged.
   */
  transact<T>(
    runId: string,
    publish: (destinationSessionFile: string, lease: SessionRetentionLock) => Promise<T>,
    options: SessionRetentionTransactionOptions = {},
  ): Promise<RetainedSessionTransaction<T>> {
    return this.enqueue(() => this.runTransaction(runId, publish, options));
  }

  /**
   * Return a fail-closed recursive byte envelope for a source core bundle.
   * Fork output is a subset of this tree (selected records plus referenced
   * images), so reserving the envelope before publication cannot undercount a
   * durable image or unknown source entry. Claim metadata is included too.
   */
  async estimateForkedSessionBytes(sourceSessionFile: string): Promise<number> {
    const parsed = parseSessionBundlePath(sourceSessionFile);
    if (!parsed) throw new Error("the source path is not a core session bundle");
    const measured = await measureRetainedClaimTree(parsed.bundleDir);
    if (!measured.ok) throw new Error(measured.error);
    const withClaim = usageAdd(measured, { bytes: RETAINED_CLAIM_BYTES, entries: 1, images: 0, unknowns: 0 });
    if (!withClaim.ok) throw new Error(withClaim.error);
    return withClaim.bytes;
  }

  /** Wait for all admission transactions, including rejected outcomes. */
  async drain(): Promise<void> {
    await this.queueTail;
  }

  /** List durable uncertain claims without opening or deleting their data. */
  list(): Promise<RetainedSessionClaim[]> {
    return this.enqueue(async () => {
      const rootBinding = await this.rootBinding();
      const root = rootBinding.path;
      const preparedFileIdentity = await retainedLedgerFileIdentity(root);
      const preparedLedger = await loadRetainedUsageLedger(root, rootBinding, { persist: false });
      const lock = acquireSessionRetentionLock(root);
      this.assertLockRoot(lock, rootBinding);
      try {
        const currentFileIdentity = await retainedLedgerFileIdentity(root);
        const ledger = sameIdentity(preparedFileIdentity, currentFileIdentity)
          ? preparedLedger
          : await loadRetainedUsageLedger(root, rootBinding);
        const claims: RetainedSessionClaim[] = [];
        for (const entry of ledger.entries) {
          if (entry.kind !== "claim") continue;
          if (claims.length >= MAX_RETAINED_SESSION_BUNDLES) {
            throw new Error(`retained session claims exceed their ${MAX_RETAINED_SESSION_BUNDLES}-bundle bound; resolve or export them before retrying`);
          }
          const claim = await readRetainedClaimAsync(root, entry.name);
          if (claim === null) throw new Error("retained session claim is malformed or unreadable");
          const runId = claim.record.runId;
          claims.push({
            runId,
            claimPath: join(root, entry.name),
            destinationBundle: join(root, runId),
            kind: entry.destinationKind ?? "staging",
            bytes: entry.usage.bytes,
          });
        }
        return claims;
      } finally {
        releaseSessionRetentionLock(lock);
      }
    });
  }

  /**
   * Explicitly discard a durable claim or a proven successful bundle. Every
   * removal is native, identity-bound, and preservation-first; malformed or
   * unreadable evidence remains available for recovery.
   */
  discard(runId: string): Promise<{ ok: boolean; error?: string }> {
    return this.enqueue(async () => {
      if (!isCoreSessionId(runId)) return { ok: false, error: "the run id is not a safe retained session id" };
      const rootBinding = await this.rootBinding();
      const root = rootBinding.path;
      let preparedFileIdentity: RetainedIdentity | null = null;
      let preparedLedger: RetainedUsageLedger | null = null;
      try {
        preparedFileIdentity = await retainedLedgerFileIdentity(root);
        preparedLedger = await loadRetainedUsageLedger(root, rootBinding, { persist: false });
      } catch {
        // The identity-bound cleanup fallback below can still remove one
        // explicitly requested claim, but it never publishes a replacement
        // ledger when the full proof cannot be rebuilt.
      }
      const lock = acquireSessionRetentionLock(root);
      this.assertLockRoot(lock, rootBinding);
      try {
        let ledger: RetainedUsageLedger | null;
        try {
          const currentFileIdentity = await retainedLedgerFileIdentity(root);
          ledger = preparedLedger !== null && sameIdentity(preparedFileIdentity, currentFileIdentity)
            ? preparedLedger
            : await loadRetainedUsageLedger(root, rootBinding);
        } catch {
          // An unrelated orphan (for example, the preserved side of an ABA
          // replacement) must not prevent an identity-bound discard of a
          // separately valid claim. Admissions still fail closed on that
          // orphan; this narrow cleanup fallback deliberately writes no
          // replacement ledger until the root can be rebuilt safely.
          ledger = null;
        }
        try {
          if (ledger === null) {
            const claimName = retainedClaimName(runId);
            const claim = await readRetainedClaimAsync(root, claimName);
            if (claim !== null) {
              const destinationPath = join(root, runId);
              const destination = await inspectPath(destinationPath);
              if (destination !== null) {
                if (destination.isSymbolicLink() || !destination.isDirectory()) return { ok: false, error: "retained session claim contains a non-discardable destination" };
                const canonical = await measureRetainedBundle(destinationPath);
                const staging = canonical.ok ? canonical : await measureRetainedStaging(destinationPath);
                if (!staging.ok) return { ok: false, error: staging.error };
                await removeRetainedEntry(root, runId, lstatSync(destinationPath), lock, this.testHooks?.beforeBundleRemoval);
              }
              await removeRetainedClaim(root, runId, lock, this.testHooks?.beforeClaimRemoval);
              return { ok: true };
            }
            const destination = await inspectPath(join(root, runId));
            if (destination === null) return { ok: true };
            if (destination.isSymbolicLink() || !destination.isDirectory()) return { ok: false, error: "retained session bundle is not a proven directory" };
            const measured = await measureRetainedBundle(join(root, runId));
            if (!measured.ok) return { ok: false, error: measured.error };
            await removeRetainedEntry(root, runId, lstatSync(join(root, runId)), lock, this.testHooks?.beforeBundleRemoval);
            return { ok: true };
          }
          const claimName = retainedClaimName(runId);
          const claimEntry = ledger.entries.find((entry) => entry.name === claimName && entry.kind === "claim");
          const destinationPath = join(root, runId);
          const removedNames = new Set<string>();
          if (claimEntry) {
            const claim = await readRetainedClaimAsync(root, claimName);
            if (claim === null) return { ok: false, error: "retained session claim is malformed or unreadable" };
            const destination = await inspectPath(destinationPath);
            if (destination !== null) {
              if (!claimEntry.destination || !sameIdentity(identityOf(destination), claimEntry.destination.identity) || !claimEntry.discardable) {
                return { ok: false, error: "retained session claim contains a non-discardable or changed destination" };
              }
              if (destination.isSymbolicLink() || !destination.isDirectory()) return { ok: false, error: "retained session claim contains a non-discardable destination" };
              const destinationInfo = lstatSync(destinationPath);
              await removeRetainedEntry(root, runId, destinationInfo, lock, this.testHooks?.beforeBundleRemoval);
              removedNames.add(runId);
            }
            await removeRetainedClaim(root, runId, lock, this.testHooks?.beforeClaimRemoval);
            removedNames.add(claimName);
          } else {
            const directEntry = ledger.entries.find((entry) => entry.name === runId && entry.kind !== "claim");
            const destination = await inspectPath(destinationPath);
            if (destination !== null) {
              if (!directEntry || !directEntry.discardable || !sameIdentity(identityOf(destination), directEntry.identity)) {
                return { ok: false, error: "retained session bundle is not a proven directory" };
              }
              if (destination.isSymbolicLink() || !destination.isDirectory()) return { ok: false, error: "retained session bundle is not a proven directory" };
              const destinationInfo = lstatSync(destinationPath);
              await removeRetainedEntry(root, runId, destinationInfo, lock, this.testHooks?.beforeBundleRemoval);
              removedNames.add(runId);
            } else if (directEntry) {
              return { ok: false, error: "retained session bundle is unreadable" };
            }
          }
          for (const name of await discardOwnedRetainedStaging(root, runId, lock)) removedNames.add(name);
          await persistRetainedLedgerAfterRemoval(root, rootBinding, ledger, removedNames);
          return { ok: true };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      } finally {
        releaseSessionRetentionLock(lock);
      }
    });
  }

  private async runTransaction<T>(
    runId: string,
    publish: (destinationSessionFile: string, lease: SessionRetentionLock) => Promise<T>,
    options: SessionRetentionTransactionOptions,
  ): Promise<RetainedSessionTransaction<T>> {
    const rootBinding = await this.rootBinding();
    const root = rootBinding.path;
    const preparedFileIdentity = await retainedLedgerFileIdentity(root);
    const preparedLedger = await loadRetainedUsageLedger(root, rootBinding, { persist: false });
    const lock = acquireSessionRetentionLock(root);
    this.assertLockRoot(lock, rootBinding);
    try {
      const currentFileIdentity = await retainedLedgerFileIdentity(root);
      const ledger = sameIdentity(preparedFileIdentity, currentFileIdentity)
        ? preparedLedger
        : await loadRetainedUsageLedger(root, rootBinding);
      const admitted = await this.admit(root, runId, options.reserveBytes, ledger);
      const destination = admitted.destination;
      await writeRetainedClaim(root, runId, lock, rootBinding);
      const initialClaim = await claimLedgerEntry(root, retainedClaimName(runId));
      const claimedLedger = await addRetainedTransactionEntries(root, admitted.ledger, initialClaim);
      await writeRetainedUsageLedger(rootBinding, claimedLedger);
      let result: T;
      try {
        // Carry the transaction run identity through the canonical worker
        // call so any retained t-* cleanup sibling can be reclaimed only by
        // this run's explicit discard after restart.
        result = await publish(destination, { ...lock, retentionRunId: runId });
      } catch (error) {
        // A rejected worker call can have crossed the durable commit boundary;
        // leave the claim for restart/list/discard recovery.
        throw error;
      }
      let publishedClaim: RetainedLedgerEntry;
      try {
        publishedClaim = await claimLedgerEntry(root, retainedClaimName(runId));
        const publishedLedger = await addRetainedTransactionEntries(root, claimedLedger, publishedClaim);
        await writeRetainedUsageLedger(rootBinding, publishedLedger);
        if (isUncertainRetentionResult(result)) return { destinationSessionFile: destination, result };
        await removeRetainedClaim(root, runId, lock, this.testHooks?.beforeClaimRemoval);
        const finalEntries = publishedLedger.entries.filter((entry) => entry.name !== retainedClaimName(runId));
        if (publishedClaim.destination) {
          finalEntries.push({
            name: runId,
            kind: publishedClaim.destination.kind,
            identity: publishedClaim.destination.identity,
            usage: publishedClaim.destination.usage,
            proof: publishedClaim.destination.proof,
            discardable: publishedClaim.destination.discardable,
          });
        }
        const finalLedger: RetainedUsageLedger = {
          ...publishedLedger,
          entries: finalEntries,
          accounting: accountingFromEntries(finalEntries),
        };
        const finalNames = await retainedRootEntries(root);
        if (JSON.stringify(finalNames) !== JSON.stringify(expectedLedgerNames(finalEntries))) throw new Error("retained session evidence changed after publication; destination claim retained for recovery");
        await writeRetainedUsageLedger(rootBinding, finalLedger);
      } catch (error) {
        if (isUncertainRetentionResult(result)) {
          // An uncertain result is already represented by the durable claim;
          // leave it in place even when a post-commit measurement cannot be
          // proven yet. Recovery will rebuild or fail closed on the next read.
          return { destinationSessionFile: destination, result };
        }
        throw error;
      }
      return { destinationSessionFile: destination, result };
    } finally {
      releaseSessionRetentionLock(lock);
    }
  }

  private async admit(root: string, runId: string, requestedBytes: number | undefined, ledger: RetainedUsageLedger): Promise<{ destination: string; ledger: RetainedUsageLedger }> {
    if (!isCoreSessionId(runId)) throw new Error("the run id is not a safe retained session id");
    const reserveBytes = requestedBytes ?? MAX_RETAINED_SESSION_BUNDLE_BYTES;
    if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 0 || reserveBytes > MAX_RETAINED_SESSION_BYTES) {
      throw new Error("retained session admission reservation is invalid or exceeds its 4 GB bound");
    }
    const accounting = ledger.accounting;
    if (accounting.bundleCount + accounting.stagingCount >= MAX_RETAINED_SESSION_BUNDLES) {
      throw new Error(`retained session evidence is at capacity (${MAX_RETAINED_SESSION_BUNDLES} bundles); resolve or export it before retrying`);
    }
    if (accounting.bytes > MAX_RETAINED_SESSION_BYTES || accounting.bytes > MAX_RETAINED_SESSION_BYTES - reserveBytes) {
      throw new Error("retained session evidence would exceed its 4 GB bound; resolve or export it before retrying");
    }
    const destinationBundle = join(root, runId);
    try {
      lstatSync(destinationBundle);
      throw new Error("the retained session destination already exists");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const claim = join(root, retainedClaimName(runId));
    try {
      lstatSync(claim);
      throw new Error("the retained session destination has an unresolved claim");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    return { destination: coreSessionFile(root, runId), ledger };
  }

}

/** Stop the shared native helper when a focused retention harness exits. */
export function disposeSessionRetentionCoreClient(): void {
  disposeWorldlineGitCore();
}
