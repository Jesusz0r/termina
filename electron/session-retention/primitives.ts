/**
 * Retention primitives: bounds, identity, and usage math.
 *
 * Owns budgets, retained-tree identity/binding, usage accounting, and
 * bounded directory reads. Split from electron/session-retention.ts (issue #38).
 */
import { errorCode } from "../../shared/guards.js";
import { type PromotionFsIdentity } from "../worldline-git.js";
import { ensureBoundRetainedRoot } from "../worldlines/index.js";
import { createHash } from "node:crypto";
import { type BigIntStats } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { join, resolve } from "node:path";


export const MAX_RETAINED_SESSION_BUNDLES = 128;

export const MAX_RETAINED_SESSION_BYTES = 4 * 1024 * 1024 * 1024;

export const MAX_RETAINED_SESSION_BUNDLE_BYTES = 64 * 1024 * 1024;

export const RETAINED_SESSION_ROOT_MARKER = ".termina-retained-session-root";

/** Atomic per-root usage ledger. The file itself is never counted as evidence. */
export const RETAINED_SESSION_USAGE_LEDGER = ".termina-retained-session-usage.json";


export const SESSION_PART = /^part-([0-9]{6})\.jsonl$/;

export const SESSION_ARCHIVE = /^(?:archive|bad)-[A-Za-z0-9._:-]+$/;

export const STORED_IMAGE = /^[A-Za-z0-9._-]+-img-[1-9][0-9]{0,3}\.(png|jpe?g|webp|gif)$/;

export const RETAINED_STAGING = /^t-[0-9a-f]{32}$/;

export const RETAINED_STAGING_OWNER_BYTES = 512;

export const RETAINED_CLAIM = /^\.termina-retained-claim-([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/;

export const RETAINED_CLAIM_BYTES = 4096;

export const MAX_RETAINED_BUNDLE_ENTRIES = 250_000;

/** Bound root-directory enumeration before allocating a names array. */
export const MAX_RETAINED_ROOT_ENTRIES = MAX_RETAINED_SESSION_BUNDLES * 4;

/** Bounds every asynchronous retained-tree stack independently of bytes. */
export const MAX_RETAINED_SCAN_DEPTH = 64;

export const MAX_RETAINED_SCAN_PENDING = MAX_RETAINED_BUNDLE_ENTRIES;

export const MAX_RETAINED_SCAN_WORK_BYTES = 128 * 1024 * 1024;

export const RETAINED_USAGE_LEDGER_VERSION = 1;

export const RETAINED_USAGE_LEDGER_TEMP = /^\.termina-retained-session-usage\.json\.tmp-[A-Za-z0-9-]+$/;

/** Bound serialized admission closures while a retention operation is slow. */
export const RETENTION_QUEUE_HIGH_WATER = 128;


export function usageZero(): RetainedUsage {
  return { bytes: 0, entries: 0, images: 0, unknowns: 0 };
}


export function identityOf(info: BigIntStats): RetainedIdentity {
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    size: String(info.size),
    mtimeNs: String(info.mtimeNs),
    ctimeNs: String(info.ctimeNs),
  };
}


export function sameIdentity(left: RetainedIdentity | null, right: RetainedIdentity | null): boolean {
  if (left === null || right === null) return left === right;
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}


export function usageAdd(left: RetainedUsage, right: RetainedUsage): RetainedMeasurement {
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
export async function boundedDirectoryEntries(path: string, limit: number, errorMessage: string): Promise<string[]> {
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


export type RetainedTreeProof = string;


/**
 * Hash every owned node's relative name, type, and native identity. The
 * proof is intentionally metadata-only: accounting depends on names/types/
 * sizes, while ctime/mtime/inode changes catch nested replacement or writes.
 * The async walk yields regularly so a recovery rebuild never monopolizes the
 * Electron main loop.
 */
export async function retainedTreeProof(path: string): Promise<RetainedTreeProof> {
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


export async function inspectPath(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}


export type RetainedRootBinding = {
  path: string;
  identity: PromotionFsIdentity;
};


const retainedRootBindingPromises = new Map<string, Promise<RetainedRootBinding>>();


/** Establish the native capability before any claim or ledger publication. */
export function bindRetainedRoot(
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


export type RetainedUsage = {
  bytes: number;
  entries: number;
  images: number;
  unknowns: number;
};


export type RetainedAccounting = RetainedUsage & {
  bundleCount: number;
  stagingCount: number;
};


export type RetainedMeasurement =
  | ({ ok: true } & RetainedUsage)
  | { ok: false; error: string };


export type RetainedIdentity = {
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
};


export type RetainedRootIdentity = {
  dev: string;
  ino: string;
};


export type RetainedLedgerDestination = {
  name: string;
  identity: RetainedIdentity;
  usage: RetainedUsage;
  proof: RetainedTreeProof;
  kind: "staging" | "bundle";
  discardable: boolean;
};


export type RetainedLedgerEntry = {
  name: string;
  kind: "bundle" | "staging" | "claim";
  identity: RetainedIdentity;
  usage: RetainedUsage;
  proof: RetainedTreeProof;
  discardable: boolean;
  destinationKind?: "staging" | "bundle";
  destination?: RetainedLedgerDestination;
};


export type RetainedUsageLedger = {
  version: 1;
  root: RetainedRootIdentity;
  entries: RetainedLedgerEntry[];
  accounting: RetainedAccounting;
};
