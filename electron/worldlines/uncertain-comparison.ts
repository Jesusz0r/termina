/**
 * Uncertain-comparison recovery evidence (`electron/worldlines/`).
 * Manifest parsing, tree measurement, usage ledgers, and the admission
 * owner that bounds recovery evidence per worlds root. Never auto-deletes.
 */
import { errnoCode, objectRecord } from "./guards.js";

import { randomUUID, createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat as lstatPath, opendir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { boundPromotionWriteJsonFile } from "../worldline-git.js";
import { promotionIdentityOf, refreshBoundPromotionDirectory } from "./bindings.js";
import {
  acquireSessionRetentionLock,
  releaseSessionRetentionLock,
  type SessionRetentionLock,
} from "../../shared/session-retention-lock.js";
import {
  MARKER,
  MAX_PROMOTION_SCAN_WORK_BYTES,
  MAX_UNCERTAIN_COMPARISONS,
  MAX_UNCERTAIN_COMPARISON_BYTES,
  MAX_UNCERTAIN_COMPARISON_ENTRIES,
  MAX_UNCERTAIN_COMPARISON_ROOT_ENTRIES,
  MAX_UNCERTAIN_SCAN_DEPTH,
  MAX_UNCERTAIN_SCAN_PENDING,
  MAX_UNCERTAIN_SCAN_WORK_BYTES,
  MIN_UNCERTAIN_COMPARISON_RESERVATION_BYTES,
  UNCERTAIN_COMPARISON_USAGE_LEDGER,
  UNCERTAIN_COMPARISON_USAGE_LEDGER_VERSION,
} from "./limits.js";
import type {
  BoundPromotionDirectory,
  ComparisonManifest,
  ComparisonManifestCandidate,
  ComparisonManifestStatus,
  ComparisonState,
  UncertainComparisonAdmissionOwnerResult,
  UncertainComparisonIdentity,
  UncertainComparisonLedgerEntry,
  UncertainComparisonLedgerReservation,
  UncertainComparisonMeasurement,
  UncertainComparisonParticipant,
  UncertainComparisonUsage,
  UncertainComparisonUsageLedger,
} from "./types.js";


/**
 * Extract the errno code from an unknown caught value, or null.
 */

/** Parse only a complete manifest shape; null is deliberately fail-closed. */

/** Parse only a complete manifest shape; null is deliberately fail-closed. */
export function parseComparisonManifest(value: unknown): ComparisonManifest | null {
  const record = objectRecord(value);
  if (!record || typeof record.id !== "string" || record.id.length === 0 || typeof record.sourceRunId !== "string" || record.sourceRunId.length === 0) return null;
  if (typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt) || record.createdAt <= 0) return null;
  if (record.status !== "creating" && record.status !== "complete" && record.status !== "uncertain") return null;
  if (record.expectedCandidates !== 1 && record.expectedCandidates !== 2) return null;
  const candidatesRecord = objectRecord(record.candidates);
  if (!candidatesRecord) return null;
  const candidates: Record<string, ComparisonManifestCandidate> = {};
  for (const [label, rawCandidate] of Object.entries(candidatesRecord)) {
    if (label !== "A" && label !== "B") return null;
    const candidate = objectRecord(rawCandidate);
    if (!candidate || (typeof candidate.pid !== "number" && candidate.pid !== null) || (typeof candidate.pid === "number" && (!Number.isInteger(candidate.pid) || candidate.pid < 0))) return null;
    if (typeof candidate.lstart !== "string" && candidate.lstart !== null) return null;
    if (!Array.isArray(candidate.paths) || candidate.paths.length === 0 || candidate.paths.some((path) => typeof path !== "string" || !isAbsolute(path))) return null;
    candidates[label] = { pid: candidate.pid as number | null, lstart: candidate.lstart as string | null, paths: [...candidate.paths] as string[] };
  }
  if (Object.keys(candidates).length > record.expectedCandidates) return null;
  if (!Array.isArray(record.uncertainSessionArtifacts)) return null;
  const uncertainSessionArtifacts: Array<{ path: string; error: string }> = [];
  for (const rawArtifact of record.uncertainSessionArtifacts) {
    const artifact = objectRecord(rawArtifact);
    if (!artifact || typeof artifact.path !== "string" || !isAbsolute(artifact.path) || artifact.path.length === 0 || typeof artifact.error !== "string" || artifact.error.length === 0) return null;
    uncertainSessionArtifacts.push({ path: artifact.path, error: artifact.error });
  }
  if (record.status === "complete" && (Object.keys(candidates).length !== record.expectedCandidates || uncertainSessionArtifacts.length > 0)) return null;
  if (record.status === "uncertain" && uncertainSessionArtifacts.length === 0) return null;
  return {
    id: record.id,
    sourceRunId: record.sourceRunId,
    createdAt: record.createdAt,
    status: record.status,
    expectedCandidates: record.expectedCandidates,
    candidates,
    uncertainSessionArtifacts,
  };
}

export function comparisonManifestFor(cmp: ComparisonState, status: ComparisonManifestStatus = "creating"): ComparisonManifest {
  const candidates: Record<string, ComparisonManifestCandidate> = {};
  for (const [label, cand] of cmp.candidates) {
    candidates[label] = { pid: cand.pid, lstart: cand.lstart, paths: [cand.dir, cand.supportDir] };
  }
  return {
    id: cmp.id,
    sourceRunId: cmp.sourceRunId,
    createdAt: cmp.createdAt,
    status,
    expectedCandidates: cmp.expectedCandidates,
    candidates,
    uncertainSessionArtifacts: [...cmp.uncertainSessionArtifacts],
  };
}

function readComparisonManifest(dir: string): ComparisonManifest | null {
  try {
    return parseComparisonManifest(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
  } catch {
    return null;
  }
}


/** Count every entry in an uncertain comparison tree, including files that
 * are not part of the normal candidate/session schema. Symlinks, special
 * entries, unreadable paths, and arithmetic overflow fail closed. */
async function measureUncertainComparisonTree(root: string): Promise<UncertainComparisonMeasurement> {
  const digest = createHash("sha256");
  const initialWorkBytes = Buffer.byteLength(root, "utf8") + 1;
  if (initialWorkBytes > MAX_UNCERTAIN_SCAN_WORK_BYTES) {
    return { ok: false, error: "uncertain comparison evidence path exceeds its bounded work budget; explicitly discard or export it before retrying" };
  }
  const pending: Array<{ path: string; relative: string; depth: number; workBytes: number }> = [{ path: root, relative: ".", depth: 0, workBytes: initialWorkBytes }];
  let pendingWorkBytes = initialWorkBytes;
  let entries = 0;
  let bytes = 0n;
  const limit = BigInt(MAX_UNCERTAIN_COMPARISON_BYTES);
  while (pending.length > 0) {
    const current = pending.pop()!;
    pendingWorkBytes -= current.workBytes;
    if (current.depth > MAX_UNCERTAIN_SCAN_DEPTH) {
      return { ok: false, error: "uncertain comparison evidence exceeds its depth bound; explicitly discard or export it before retrying" };
    }
    let info;
    try {
      info = await lstatPath(current.path, { bigint: true });
    } catch {
      return { ok: false, error: "uncertain comparison evidence is unreadable or partial; explicitly discard or export it before retrying" };
    }
    entries++;
    if (entries > MAX_UNCERTAIN_COMPARISON_ENTRIES) {
      return { ok: false, error: "uncertain comparison evidence contains too many entries; explicitly discard or export it before retrying" };
    }
    if (info.isSymbolicLink()) {
      return { ok: false, error: "uncertain comparison evidence contains a symbolic link; explicitly discard or export it before retrying" };
    }
    if (!info.isDirectory() && !info.isFile()) {
      return { ok: false, error: "uncertain comparison evidence contains an unsupported entry; explicitly discard or export it before retrying" };
    }
    bytes += info.size;
    if (bytes > limit) {
      return { ok: false, error: "uncertain comparison evidence exceeds its 4 GB bound; explicitly discard or export it before retrying" };
    }
    digest.update(`${current.relative}\0${info.isDirectory() ? "d" : "f"}\0${JSON.stringify(uncertainIdentityOf(info))}\n`);
    if (!info.isDirectory()) {
      if ((entries & 63) === 0) await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      continue;
    }
    let directory;
    try {
      directory = await opendir(current.path);
    } catch {
      return { ok: false, error: "uncertain comparison evidence is unreadable or partial; explicitly discard or export it before retrying" };
    }
    try {
      const children: string[] = [];
      let childNameBytes = 0;
      for await (const child of directory) {
        const nameBytes = Buffer.byteLength(child.name, "utf8");
        if (childNameBytes > MAX_UNCERTAIN_SCAN_WORK_BYTES - nameBytes) {
          return { ok: false, error: "uncertain comparison evidence scan exceeded its bounded work budget; explicitly discard or export it before retrying" };
        }
        childNameBytes += nameBytes;
        children.push(child.name);
        if (children.length > MAX_UNCERTAIN_COMPARISON_ENTRIES) {
          return { ok: false, error: "uncertain comparison evidence contains too many entries; explicitly discard or export it before retrying" };
        }
      }
      children.sort().reverse();
      for (const name of children) {
        if (pending.length >= MAX_UNCERTAIN_SCAN_PENDING) {
          return { ok: false, error: "uncertain comparison evidence contains too many pending entries; explicitly discard or export it before retrying" };
        }
        const childPath = join(current.path, name);
        const childRelative = current.relative === "." ? name : `${current.relative}/${name}`;
        const workBytes = Buffer.byteLength(childPath, "utf8") + Buffer.byteLength(childRelative, "utf8");
        if (workBytes > MAX_UNCERTAIN_SCAN_WORK_BYTES || pendingWorkBytes > MAX_UNCERTAIN_SCAN_WORK_BYTES - workBytes) {
          return { ok: false, error: "uncertain comparison evidence scan exceeded its bounded work budget; explicitly discard or export it before retrying" };
        }
        pending.push({
          path: childPath,
          relative: childRelative,
          depth: current.depth + 1,
          workBytes,
        });
        pendingWorkBytes += workBytes;
      }
    } catch {
      return { ok: false, error: "uncertain comparison evidence is unreadable or partial; explicitly discard or export it before retrying" };
    } finally {
      try {
        await directory.close();
      } catch {
        /* iterator close is best effort */
      }
    }
  }
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { ok: false, error: "uncertain comparison evidence byte count overflow; explicitly discard or export it before retrying" };
  }
  return { ok: true, bytes: Number(bytes), entries, proof: digest.digest("hex") };
}

export async function boundedWorldlineEntries(path: string, limit: number, message: string): Promise<string[]> {
  let directory;
  try {
    directory = await opendir(path);
  } catch {
    throw new Error(message);
  }
  const names: string[] = [];
  let nameBytes = 0;
  try {
    for await (const entry of directory) {
      const addedNameBytes = Buffer.byteLength(entry.name, "utf8");
      if (nameBytes > MAX_PROMOTION_SCAN_WORK_BYTES - addedNameBytes) throw new Error(message);
      nameBytes += addedNameBytes;
      names.push(entry.name);
      if (names.length > limit) throw new Error(message);
      if ((names.length & 63) === 0) await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    }
    return names;
  } catch (error) {
    if (error instanceof Error && error.message === message) throw error;
    throw new Error(message);
  } finally {
    try {
      await directory.close();
    } catch {
      /* iterator close is best effort */
    }
  }
}

function isSafeComparisonId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function uncertainIdentityOf(info: BigIntStats): UncertainComparisonIdentity {
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    size: String(info.size),
    mtimeNs: String(info.mtimeNs),
    ctimeNs: String(info.ctimeNs),
  };
}

function sameUncertainIdentity(left: UncertainComparisonIdentity, right: UncertainComparisonIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function uncertainComparisonRootNames(root: string): Promise<string[]> {
  const names = await boundedWorldlineEntries(
    root,
    MAX_UNCERTAIN_COMPARISON_ROOT_ENTRIES,
    `uncertain comparison evidence root contains too many entries (${MAX_UNCERTAIN_COMPARISON_ROOT_ENTRIES}); explicitly discard retained recovery evidence before retrying`,
  );
  const marked: string[] = [];
  for (const name of names) {
    const dir = join(root, name);
    let info: BigIntStats;
    try {
      info = await lstatPath(dir, { bigint: true });
    } catch (error) {
      if (errnoCode(error) === "ENOENT") continue;
      throw new Error("uncertain comparison evidence root is unreadable; explicitly discard retained recovery evidence before retrying");
    }
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    try {
      await lstatPath(join(dir, MARKER), { bigint: true });
      marked.push(name);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw new Error("uncertain comparison marker is unreadable; explicitly discard retained recovery evidence before retrying");
    }
  }
  return marked.sort();
}

function uncertainComparisonIsSafe(root: string, name: string, safeIds: ReadonlySet<string>): boolean {
  if (!safeIds.has(name)) return false;
  const dir = join(root, name);
  let marker;
  try {
    marker = lstatSync(join(dir, MARKER));
  } catch {
    return false;
  }
  if (!marker.isFile() || marker.isSymbolicLink()) return false;
  const manifest = readComparisonManifest(dir);
  return manifest !== null && manifest.status !== "uncertain" && manifest.uncertainSessionArtifacts.length === 0;
}

async function buildUncertainComparisonLedgerEntry(root: string, name: string, safeIds: ReadonlySet<string>): Promise<UncertainComparisonLedgerEntry | null> {
  let info: BigIntStats;
  try {
    info = await lstatPath(join(root, name), { bigint: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw new Error("uncertain comparison evidence is unreadable or partial; explicitly discard retained recovery evidence before retrying");
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return null;
  try {
    await lstatPath(join(root, name, MARKER), { bigint: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw new Error("uncertain comparison marker is unreadable; explicitly discard retained recovery evidence before retrying");
  }
  if (uncertainComparisonIsSafe(root, name, safeIds)) {
    return { name, identity: uncertainIdentityOf(info), counted: false, bytes: 0, entries: 0, proof: "0".repeat(64) };
  }
  const measured = await measureUncertainComparisonTree(join(root, name));
  if (!measured.ok) throw new Error(measured.error);
  return { name, identity: uncertainIdentityOf(info), counted: true, bytes: measured.bytes, entries: measured.entries, proof: measured.proof };
}

function uncertainComparisonUsageFromEntries(entries: readonly UncertainComparisonLedgerEntry[]): UncertainComparisonUsage {
  let count = 0;
  let bytes = 0;
  let entryCount = 0;
  for (const entry of entries) {
    if (!entry.counted) continue;
    count++;
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || bytes > MAX_UNCERTAIN_COMPARISON_BYTES - entry.bytes) {
      throw new Error("uncertain comparison evidence exceeds its 4 GB bound; explicitly discard retained recovery evidence before retrying");
    }
    bytes += entry.bytes;
    if (!Number.isSafeInteger(entry.entries) || entry.entries < 0 || entryCount > MAX_UNCERTAIN_COMPARISON_ENTRIES - entry.entries) {
      throw new Error("uncertain comparison evidence contains too many entries; explicitly discard retained recovery evidence before retrying");
    }
    entryCount += entry.entries;
  }
  if (count > MAX_UNCERTAIN_COMPARISONS) {
    throw new Error(`uncertain comparisons are at capacity (${MAX_UNCERTAIN_COMPARISONS}); explicitly discard retained recovery evidence before retrying`);
  }
  return { count, bytes, entries: entryCount };
}

function validUncertainLedgerIdentity(value: unknown): value is UncertainComparisonIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every((key) => typeof record[key] === "string" && /^\d+$/.test(record[key] as string));
}

function validUncertainLedgerEntry(value: unknown): value is UncertainComparisonLedgerEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string"
    || !isSafeComparisonId(record.name)
    || !validUncertainLedgerIdentity(record.identity)
    || typeof record.counted !== "boolean"
    || typeof record.bytes !== "number"
    || !Number.isSafeInteger(record.bytes)
    || record.bytes < 0
    || record.bytes > MAX_UNCERTAIN_COMPARISON_BYTES
    || typeof record.entries !== "number"
    || !Number.isSafeInteger(record.entries)
    || record.entries < 0
    || record.entries > MAX_UNCERTAIN_COMPARISON_ENTRIES
    || typeof record.proof !== "string"
    || !/^[0-9a-f]{64}$/.test(record.proof)) return false;
  return record.counted
    ? (record.bytes > 0 || record.entries > 0)
    : record.bytes === 0 && record.entries === 0;
}

function validUncertainLedgerReservation(value: unknown): value is UncertainComparisonLedgerReservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.token === "string"
    && record.token.length > 0
    && record.token.length <= 128
    && typeof record.pid === "number"
    && Number.isSafeInteger(record.pid)
    && record.pid > 0
    && typeof record.bytes === "number"
    && Number.isSafeInteger(record.bytes)
    && record.bytes >= 0
    && record.bytes <= MAX_UNCERTAIN_COMPARISON_BYTES;
}

function validUncertainUsage(value: unknown): value is UncertainComparisonUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.count === "number" && Number.isSafeInteger(record.count) && record.count >= 0 && record.count <= MAX_UNCERTAIN_COMPARISONS
    && typeof record.bytes === "number" && Number.isSafeInteger(record.bytes) && record.bytes >= 0 && record.bytes <= MAX_UNCERTAIN_COMPARISON_BYTES
    && typeof record.entries === "number" && Number.isSafeInteger(record.entries) && record.entries >= 0 && record.entries <= MAX_UNCERTAIN_COMPARISON_ENTRIES;
}

async function writeUncertainComparisonUsageLedger(root: BoundPromotionDirectory, ledger: UncertainComparisonUsageLedger): Promise<void> {
  await boundPromotionWriteJsonFile({
    root: root.path,
    rootIdentity: promotionIdentityOf(root),
    components: [UNCERTAIN_COMPARISON_USAGE_LEDGER],
    parentIdentity: promotionIdentityOf(root),
    value: ledger,
    maxBytes: 8 * 1024 * 1024,
    mode: 0o600,
  });
}

async function readUncertainComparisonUsageLedger(root: string, safeIds: ReadonlySet<string>): Promise<UncertainComparisonUsageLedger | null> {
  const path = join(root, UNCERTAIN_COMPARISON_USAGE_LEDGER);
  let info: BigIntStats;
  try {
    info = await lstatPath(path, { bigint: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    return null;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8n * 1024n * 1024n) return null;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== UNCERTAIN_COMPARISON_USAGE_LEDGER_VERSION
    || !record.root || typeof record.root !== "object" || Array.isArray(record.root)
    || typeof (record.root as Record<string, unknown>).dev !== "string"
    || !/^\d+$/.test((record.root as Record<string, unknown>).dev as string)
    || typeof (record.root as Record<string, unknown>).ino !== "string"
    || !/^\d+$/.test((record.root as Record<string, unknown>).ino as string)
    || !Array.isArray(record.entries)
    || record.entries.length > MAX_UNCERTAIN_COMPARISON_ROOT_ENTRIES
    || !record.entries.every(validUncertainLedgerEntry)
    || !Array.isArray(record.reservations)
    || record.reservations.length > 1
    || !record.reservations.every(validUncertainLedgerReservation)
    || record.reservations.length !== 0
    || !validUncertainUsage(record.usage)) return null;
  const entries = record.entries as UncertainComparisonLedgerEntry[];
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) return null;
  let usage: UncertainComparisonUsage;
  try {
    usage = uncertainComparisonUsageFromEntries(entries);
  } catch {
    return null;
  }
  if (JSON.stringify(usage) !== JSON.stringify(record.usage)) return null;
  const rootInfo = await lstatPath(root, { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return null;
  const rootRecord = record.root as Record<string, unknown>;
  if (String(rootInfo.dev) !== rootRecord.dev || String(rootInfo.ino) !== rootRecord.ino) return null;
  const markedNames = await uncertainComparisonRootNames(root);
  if (JSON.stringify(markedNames) !== JSON.stringify(entries.map((entry) => entry.name).sort())) return null;
  for (const entry of entries) {
    let current: BigIntStats;
    try {
      current = await lstatPath(join(root, entry.name), { bigint: true });
    } catch {
      return null;
    }
    const safe = uncertainComparisonIsSafe(root, entry.name, safeIds);
    if (entry.counted !== !safe) return null;
    if (!entry.counted) {
      if (entry.proof !== "0".repeat(64)) return null;
      continue;
    }
    if (!sameUncertainIdentity(uncertainIdentityOf(current), entry.identity)) return null;
    const measured = await measureUncertainComparisonTree(join(root, entry.name));
    if (!measured.ok || measured.bytes !== entry.bytes || measured.entries !== entry.entries || measured.proof !== entry.proof) return null;
  }
  return {
    version: 1,
    root: { dev: rootRecord.dev as string, ino: rootRecord.ino as string },
    entries,
    reservations: [],
    usage,
  };
}

async function buildUncertainComparisonUsageLedger(root: string, safeIds: ReadonlySet<string>, rootBinding: BoundPromotionDirectory, persist = true): Promise<UncertainComparisonUsageLedger> {
  const rootInfo = await lstatPath(root, { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("uncertain comparison evidence root is not an owned directory");
  const names = await uncertainComparisonRootNames(root);
  const entries: UncertainComparisonLedgerEntry[] = [];
  for (const name of names) {
    const entry = await buildUncertainComparisonLedgerEntry(root, name, safeIds);
    if (entry) entries.push(entry);
  }
  const usage = uncertainComparisonUsageFromEntries(entries);
  const ledger: UncertainComparisonUsageLedger = {
    version: 1,
    root: { dev: String(rootInfo.dev), ino: String(rootInfo.ino) },
    entries,
    reservations: [],
    usage,
  };
  if (persist) await writeUncertainComparisonUsageLedger(rootBinding, ledger);
  return ledger;
}

async function loadUncertainComparisonUsageLedger(
  root: string,
  safeIds: ReadonlySet<string>,
  rootBinding: BoundPromotionDirectory,
  options: { persist?: boolean } = {},
): Promise<UncertainComparisonUsageLedger> {
  const existing = await readUncertainComparisonUsageLedger(root, safeIds);
  return existing ?? buildUncertainComparisonUsageLedger(root, safeIds, rootBinding, options.persist !== false);
}

async function uncertainLedgerFileIdentity(root: string): Promise<UncertainComparisonIdentity | null> {
  try {
    return uncertainIdentityOf(await lstatPath(join(root, UNCERTAIN_COMPARISON_USAGE_LEDGER), { bigint: true }));
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

function sameUncertainLedgerFileIdentity(left: UncertainComparisonIdentity | null, right: UncertainComparisonIdentity | null): boolean {
  if (left === null || right === null) return left === right;
  return sameUncertainIdentity(left, right);
}


/**
 * One admission owner for one worlds root. The queue is shared by every
 * WorldlineManager in this process and the durable generation lock extends
 * the same transaction across a second process. A manager contributes only
 * its known live, uncertainty-free comparison ids; every other marked tree,
 * including an orphan or malformed manifest, remains accounted fail-closed.
 */
export class UncertainComparisonAdmissionOwner {
  private queueTail: Promise<void> = Promise.resolve();
  private participants = new Set<UncertainComparisonParticipant>();

  constructor(private rootBinding: BoundPromotionDirectory) {}

  register(participant: UncertainComparisonParticipant): () => void {
    this.participants.add(participant);
    return () => this.participants.delete(participant);
  }

  hasParticipants(): boolean {
    return this.participants.size > 0;
  }

  private safeIds(): Set<string> {
    const safeIds = new Set<string>();
    for (const participant of this.participants) {
      for (const id of participant()) safeIds.add(id);
    }
    return safeIds;
  }

  async acquire(isClosing: () => boolean): Promise<UncertainComparisonAdmissionOwnerResult> {
    const previous = this.queueTail;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      releaseGate = resolveGate;
    });
    this.queueTail = previous.then(() => gate, () => gate);
    await previous;
    const finishWithoutLease = () => releaseGate();
    if (isClosing()) {
      finishWithoutLease();
      return { ok: false, error: "worldline manager disposed" };
    }
    let lock: SessionRetentionLock;
    let rootBinding: BoundPromotionDirectory;
    let preparedLedger: UncertainComparisonUsageLedger;
    let preparedFileIdentity: UncertainComparisonIdentity | null;
    try {
      rootBinding = await refreshBoundPromotionDirectory(this.rootBinding);
      this.rootBinding = rootBinding;
      const safeIds = this.safeIds();
      // Rebuild/prove outside the global lock. If another process commits
      // while this work is in flight, the ledger file identity check below
      // selects its already-durable result instead of rescanning under lock.
      preparedFileIdentity = await uncertainLedgerFileIdentity(rootBinding.path);
      preparedLedger = await loadUncertainComparisonUsageLedger(rootBinding.path, safeIds, rootBinding, { persist: false });
    } catch (error) {
      finishWithoutLease();
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    try {
      // The lock is held until the returned lease is released. No second
      // manager/process can publish against a stale root binding.
      lock = acquireSessionRetentionLock(rootBinding.path);
      if (String(lock.rootIdentity.dev) !== rootBinding.dev || String(lock.rootIdentity.ino) !== rootBinding.ino) {
        throw new Error("uncertain comparison worlds root identity changed before admission");
      }
    } catch (error) {
      finishWithoutLease();
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    let held = true;
    const releaseLock = () => {
      if (!held) return;
      held = false;
      releaseSessionRetentionLock(lock);
    };
    try {
      const currentFileIdentity = await uncertainLedgerFileIdentity(rootBinding.path);
      const ledger = sameUncertainLedgerFileIdentity(preparedFileIdentity, currentFileIdentity)
        ? preparedLedger
        : await loadUncertainComparisonUsageLedger(rootBinding.path, this.safeIds(), rootBinding);
      const usage = ledger.usage;
      if (usage.count >= MAX_UNCERTAIN_COMPARISONS) {
        releaseLock();
        finishWithoutLease();
        return { ok: false, error: `uncertain comparisons are at capacity (${MAX_UNCERTAIN_COMPARISONS}); explicitly discard retained recovery evidence before retrying` };
      }
      if (usage.bytes > MAX_UNCERTAIN_COMPARISON_BYTES - MIN_UNCERTAIN_COMPARISON_RESERVATION_BYTES) {
        releaseLock();
        finishWithoutLease();
        return { ok: false, error: "uncertain comparison evidence exceeds its 4 GB bound; explicitly discard retained recovery evidence before retrying" };
      }
      const token = randomUUID();
      const reservation: UncertainComparisonLedgerReservation = {
        token,
        pid: process.pid,
        bytes: MIN_UNCERTAIN_COMPARISON_RESERVATION_BYTES,
      };
      const reservedLedger: UncertainComparisonUsageLedger = {
        ...ledger,
        reservations: [reservation],
      };
      await writeUncertainComparisonUsageLedger(rootBinding, reservedLedger);
      let boundComparisonId: string | null = null;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        void this.reconcileRelease(rootBinding, ledger, reservation, () => boundComparisonId, this.safeIds())
          .catch(() => undefined)
          .finally(() => {
            releaseLock();
            finishWithoutLease();
          });
      };
      return {
        ok: true,
        lease: {
          bind: (comparisonId: string) => {
            if (!released && isSafeComparisonId(comparisonId)) boundComparisonId = comparisonId;
          },
          release,
        },
      };
    } catch (error) {
      releaseLock();
      finishWithoutLease();
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async reconcileRelease(
    initialRootBinding: BoundPromotionDirectory,
    base: UncertainComparisonUsageLedger,
    reservation: UncertainComparisonLedgerReservation,
    boundId: () => string | null,
    safeIds: ReadonlySet<string>,
  ): Promise<void> {
    const rootBinding = await refreshBoundPromotionDirectory(initialRootBinding);
    this.rootBinding = rootBinding;
    const root = rootBinding.path;
    const names = await uncertainComparisonRootNames(root);
    const entriesByName = new Map(base.entries.map((entry) => [entry.name, entry]));
    const id = boundId();
    // A lease that is not bound to a manager-created comparison is the
    // low-level recovery seam used during crash/ABA checks. Re-measure every
    // existing uncertain tree there so out-of-band evidence changes cannot be
    // hidden behind a shallow directory identity. Normal creators bind their
    // newly allocated id; only that new tree is measured at release.
    const rescanExisting = id === null;
    if (id !== null) {
      const entry = await buildUncertainComparisonLedgerEntry(root, id, safeIds);
      if (entry) entriesByName.set(id, entry);
    }
    for (const name of names) {
      const existing = entriesByName.get(name);
      if (!existing) {
        const entry = await buildUncertainComparisonLedgerEntry(root, name, safeIds);
        if (entry) entriesByName.set(name, entry);
        continue;
      }
      if (name === id) continue;
      let current: BigIntStats;
      try {
        current = await lstatPath(join(root, name), { bigint: true });
      } catch {
        entriesByName.delete(name);
        continue;
      }
      const safe = uncertainComparisonIsSafe(root, name, safeIds);
      if (safe) {
        entriesByName.set(name, { name, identity: uncertainIdentityOf(current), counted: false, bytes: 0, entries: 0, proof: "0".repeat(64) });
      } else if (rescanExisting || !existing.counted || !sameUncertainIdentity(uncertainIdentityOf(current), existing.identity)) {
        const entry = await buildUncertainComparisonLedgerEntry(root, name, safeIds);
        if (entry) entriesByName.set(name, entry);
        else entriesByName.delete(name);
      }
    }
    for (const name of [...entriesByName.keys()]) {
      if (!names.includes(name)) entriesByName.delete(name);
    }
    const entries = [...entriesByName.values()].sort((left, right) => left.name.localeCompare(right.name));
    const next: UncertainComparisonUsageLedger = {
      version: 1,
      root: base.root,
      entries,
      reservations: [],
      usage: uncertainComparisonUsageFromEntries(entries),
    };
    // The reservation is intentionally consumed only after the committed
    // comparison has been reconciled. If this write fails, the old durable
    // reservation remains and the next admission rebuilds fail-closed.
    void reservation;
    await writeUncertainComparisonUsageLedger(rootBinding, next);
  }

  async drain(): Promise<void> {
    await this.queueTail;
  }
}

const uncertainComparisonAdmissionOwners = new Map<string, UncertainComparisonAdmissionOwner>();

export function uncertainComparisonAdmissionOwnerFor(rootBinding: BoundPromotionDirectory): UncertainComparisonAdmissionOwner {
  const root = realpathSync(resolve(rootBinding.path));
  let owner = uncertainComparisonAdmissionOwners.get(root);
  if (!owner) {
    owner = new UncertainComparisonAdmissionOwner(rootBinding);
    uncertainComparisonAdmissionOwners.set(root, owner);
  }
  return owner;
}

export function releaseUncertainComparisonAdmissionOwner(owner: UncertainComparisonAdmissionOwner): void {
  if (owner.hasParticipants()) return;
  for (const [root, current] of uncertainComparisonAdmissionOwners) {
    if (current !== owner) continue;
    uncertainComparisonAdmissionOwners.delete(root);
    return;
  }
}
