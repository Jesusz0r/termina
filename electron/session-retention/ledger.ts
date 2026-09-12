/**
 * Retained usage ledger.
 *
 * Owns ledger validation, building, loading, and post-removal
 * persistence. Split from electron/session-retention.ts (issue #38).
 */
import { isCoreSessionId } from "../../agent-core/session.js";
import { RETAINED_SESSION_ADMISSION_LOCK } from "../../shared/session-retention-lock.js";
import { boundPromotionWriteJsonFile } from "../worldline-git.js";
import { type BigIntStats } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readRetainedClaimAsync } from "./claims.js";
import { measureClaimedDestination, measureRetainedBundle, measureRetainedStaging } from "./measure.js";
import { MAX_RETAINED_BUNDLE_ENTRIES, MAX_RETAINED_ROOT_ENTRIES, MAX_RETAINED_SESSION_BUNDLES, MAX_RETAINED_SESSION_BYTES, RETAINED_CLAIM, RETAINED_SESSION_ROOT_MARKER, RETAINED_SESSION_USAGE_LEDGER, RETAINED_STAGING, RETAINED_USAGE_LEDGER_TEMP, RETAINED_USAGE_LEDGER_VERSION, boundedDirectoryEntries, identityOf, inspectPath, retainedTreeProof, sameIdentity, usageAdd, usageZero } from "./primitives.js";
import type { RetainedAccounting, RetainedIdentity, RetainedLedgerDestination, RetainedLedgerEntry, RetainedRootBinding, RetainedRootIdentity, RetainedTreeProof, RetainedUsage, RetainedUsageLedger } from "./primitives.js";


function isRetainedLedgerMetadata(name: string): boolean {
  return name === RETAINED_SESSION_ROOT_MARKER
    || name === RETAINED_SESSION_ADMISSION_LOCK
    || name === RETAINED_SESSION_USAGE_LEDGER
    || RETAINED_USAGE_LEDGER_TEMP.test(name);
}


export async function retainedRootEntries(root: string): Promise<string[]> {
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


export function accountingFromEntries(entries: RetainedLedgerEntry[]): RetainedAccounting {
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


export function expectedLedgerNames(entries: RetainedLedgerEntry[]): string[] {
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


export async function writeRetainedUsageLedger(root: RetainedRootBinding, ledger: RetainedUsageLedger): Promise<void> {
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


export async function claimLedgerEntry(root: string, name: string): Promise<RetainedLedgerEntry> {
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


export async function loadRetainedUsageLedger(
  root: string,
  rootBinding: RetainedRootBinding,
  options: { persist?: boolean } = {},
): Promise<RetainedUsageLedger> {
  const existing = await readRetainedUsageLedger(root);
  return existing ?? buildRetainedUsageLedger(root, rootBinding, options.persist !== false);
}


export async function retainedLedgerFileIdentity(root: string): Promise<RetainedIdentity | null> {
  const info = await inspectPath(retainedLedgerPath(root));
  return info === null ? null : identityOf(info);
}


function ledgerWithoutNames(ledger: RetainedUsageLedger, names: ReadonlySet<string>): RetainedUsageLedger {
  const entries = ledger.entries.filter((entry) => !names.has(entry.name));
  return { ...ledger, entries, accounting: accountingFromEntries(entries) };
}


export async function persistRetainedLedgerAfterRemoval(root: string, rootBinding: RetainedRootBinding, ledger: RetainedUsageLedger, removedNames: ReadonlySet<string>): Promise<void> {
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


export async function addRetainedTransactionEntries(root: string, ledger: RetainedUsageLedger, claimEntry: RetainedLedgerEntry): Promise<RetainedUsageLedger> {
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
