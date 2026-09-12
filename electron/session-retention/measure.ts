/**
 * Retained-tree measurement and staging probes.
 *
 * Owns bundle/staging/segment measurement and owned-staging discovery.
 * Split from electron/session-retention.ts (issue #38).
 */
import { MAX_SESSION_BUNDLE_BYTES, RETAINED_STAGING_OWNER_NAME, SESSION_ACTIVE_NAME, SESSION_CURRENT_DIR, isCoreSessionId } from "../../agent-core/session.js";
import { errorCode } from "../../shared/guards.js";
import { type SessionRetentionLock } from "../../shared/session-retention-lock.js";
import { createReadStream, type BigIntStats, type Stats } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { removeRetainedEntry } from "./claims.js";
import { MAX_RETAINED_BUNDLE_ENTRIES, MAX_RETAINED_ROOT_ENTRIES, MAX_RETAINED_SCAN_DEPTH, MAX_RETAINED_SCAN_PENDING, MAX_RETAINED_SCAN_WORK_BYTES, MAX_RETAINED_SESSION_BYTES, RETAINED_STAGING, RETAINED_STAGING_OWNER_BYTES, SESSION_ARCHIVE, SESSION_PART, STORED_IMAGE, boundedDirectoryEntries, inspectPath, usageAdd, usageZero } from "./primitives.js";
import type { RetainedMeasurement } from "./primitives.js";


/** Measure a claim's destination even when its tree is only partially
 * materialized. A valid canonical bundle uses the schema-aware scanner; an
 * invalid but claimed tree is still app-owned evidence and is counted
 * recursively so it cannot hide bytes behind a malformed shape. */
export async function measureClaimedDestination(root: string, runId: string): Promise<RetainedMeasurement> {
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
export async function measureRetainedClaimTree(path: string): Promise<RetainedMeasurement> {
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
export async function measureRetainedStaging(path: string): Promise<RetainedMeasurement> {
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


export async function measureRetainedBundle(path: string): Promise<RetainedMeasurement> {
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


export async function discardOwnedRetainedStaging(root: string, runId: string, lock: SessionRetentionLock): Promise<string[]> {
  const removed: string[] = [];
  for (const staging of await findOwnedRetainedStaging(root, runId)) {
    await removeRetainedEntry(root, staging.name, staging.info, lock);
    removed.push(staging.name);
  }
  return removed;
}
