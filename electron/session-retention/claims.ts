/**
 * Retained-session claim files.
 *
 * Owns claim read/write/remove. Split from
 * electron/session-retention.ts (issue #38).
 */
import { isCoreSessionId } from "../../agent-core/session.js";
import { syncDirectoryAsync } from "../../shared/fsync.js";
import { errorCode } from "../../shared/guards.js";
import { validateSessionRetentionLease, type SessionRetentionLock } from "../../shared/session-retention-lock.js";
import { boundPromotionRemoveTree, boundPromotionWriteJsonFile } from "../worldline-git.js";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RETAINED_CLAIM, RETAINED_CLAIM_BYTES } from "./primitives.js";
import type { RetainedRootBinding } from "./primitives.js";


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


export type RetainedClaimRemovalTestHook = {
  stage: string;
  readyPath: string;
  releasePath: string;
};


export function retainedClaimName(runId: string): string {
  return `.termina-retained-claim-${runId}.json`;
}


export async function readRetainedClaimAsync(root: string, name: string): Promise<{ record: RetainedClaimRecord; bytes: number } | null> {
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


export async function removeRetainedEntry(
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
  await syncDirectoryAsync(root);
}


export async function writeRetainedClaim(root: string, runId: string, retentionLock: SessionRetentionLock, rootBinding: RetainedRootBinding): Promise<string> {
  const name = retainedClaimName(runId);
  const finalPath = join(root, name);
  try {
    await lstat(finalPath);
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


export async function removeRetainedClaim(
  root: string,
  runId: string,
  retentionLock: SessionRetentionLock,
  testHook?: RetainedClaimRemovalTestHook,
): Promise<void> {
  const path = join(root, retainedClaimName(runId));
  let info;
  try {
    info = await lstat(path);
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


export function isUncertainRetentionResult(value: unknown): boolean {
  return value !== null && typeof value === "object" && "ok" in value && (value as { ok?: unknown }).ok === false;
}
