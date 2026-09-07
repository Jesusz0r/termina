/**
 * Promotion-journal admission (`electron/worldlines/`).
 * Tree measurement, retention accounting, and the admission owner that
 * bounds retained promotion evidence per worlds root.
 */
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat as lstatPath, opendir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { boundPromotionWriteJsonFile } from "../worldline-git.js";
import {
  acquireSessionRetentionLock,
  releaseSessionRetentionLock,
  type SessionRetentionLock,
} from "../../shared/session-retention-lock.js";
import {
  MAX_PROMOTION_JOURNALS,
  MAX_PROMOTION_JOURNAL_BYTES,
  MAX_PROMOTION_JOURNAL_OVERHEAD_BYTES,
  MAX_PROMOTION_JOURNAL_ROOT_ENTRIES,
  MAX_PROMOTION_OPERATION_BYTES,
  MAX_PROMOTION_SCAN_DEPTH,
  MAX_PROMOTION_SCAN_ENTRIES,
  MAX_PROMOTION_SCAN_PENDING,
  MAX_PROMOTION_SCAN_WORK_BYTES,
  MAX_SESSION_BYTES,
  PROMOTION_JOURNAL_USAGE_LEDGER,
  PROMOTION_JOURNAL_USAGE_LEDGER_VERSION,
} from "./limits.js";
import type {
  BoundPromotionDirectory,
  PromotionJournalAdmissionResult,
  PromotionJournalUsageLedger,
  PromotionOperationBudget,
  PromotionRetentionUsage,
} from "./types.js";
import { boundedWorldlineEntries, errnoCode } from "./uncertain-comparison.js";
import { promotionIdentityOf, refreshBoundPromotionDirectory } from "./bindings.js";

async function measurePromotionTreeBytes(path: string, limit: bigint): Promise<bigint> {
  let bytes = 0n;
  let visited = 0;
  const initialWorkBytes = Buffer.byteLength(path, "utf8");
  if (initialWorkBytes > MAX_PROMOTION_SCAN_WORK_BYTES) throw new Error("promotion journal retention scan path exceeds its bounded work budget");
  const pending: Array<{ path: string; depth: number; workBytes: number }> = [{ path, depth: 0, workBytes: initialWorkBytes }];
  let pendingWorkBytes = initialWorkBytes;
  while (pending.length > 0 && bytes < limit) {
    const current = pending.pop()!;
    pendingWorkBytes -= current.workBytes;
    if (current.depth > MAX_PROMOTION_SCAN_DEPTH) throw new Error(`promotion journal retention scan exceeded its ${MAX_PROMOTION_SCAN_DEPTH}-level depth bound`);
    visited++;
    if (visited > MAX_PROMOTION_SCAN_ENTRIES) throw new Error(`promotion journal retention scan exceeded its ${MAX_PROMOTION_SCAN_ENTRIES}-entry bound`);
    const info = await lstatPath(current.path, { bigint: true });
    bytes = bytes >= limit - info.size ? limit : bytes + info.size;
    if (info.isSymbolicLink() || !info.isDirectory() || bytes >= limit) continue;
    let directory: Awaited<ReturnType<typeof opendir>>;
    try {
      directory = await opendir(current.path);
    } catch (error) {
      throw new Error(`promotion journal retention scan could not open a child directory: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      for await (const entry of directory) {
        const childPath = join(current.path, entry.name);
        const workBytes = Buffer.byteLength(childPath, "utf8");
        if (workBytes > MAX_PROMOTION_SCAN_WORK_BYTES || pendingWorkBytes > MAX_PROMOTION_SCAN_WORK_BYTES - workBytes) {
          throw new Error("promotion journal retention scan exceeded its bounded work budget");
        }
        if (pending.length >= MAX_PROMOTION_SCAN_PENDING) {
          throw new Error(`promotion journal retention scan exceeded its ${MAX_PROMOTION_SCAN_PENDING}-entry pending bound`);
        }
        pending.push({ path: childPath, depth: current.depth + 1, workBytes });
        pendingWorkBytes += workBytes;
      }
    } finally {
      try {
        await directory.close();
      } catch {
        /* iterator close is best effort */
      }
    }
  }
  return bytes;
}

/**
 * Measure app-owned promotion evidence without following any symlink. This is
 * admission accounting only: no unresolved journal is ever removed here.
 * Once the byte ceiling is crossed, the scan saturates because the caller
 * already has to fail closed.
 */
export async function measurePromotionRetention(worldsRoot: string): Promise<PromotionRetentionUsage> {
  const root = resolve(worldsRoot, "promotion-journal");
  let rootInfo;
  try {
    rootInfo = await lstatPath(root, { bigint: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { journalCount: 0, bytes: 0n };
    throw error;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("promotion journal root is not an owned directory");

  const limit = BigInt(MAX_PROMOTION_JOURNAL_BYTES + MAX_PROMOTION_OPERATION_BYTES);
  let bytes = rootInfo.size;
  const entries = await boundedWorldlineEntries(
    root,
    MAX_PROMOTION_JOURNAL_ROOT_ENTRIES,
    `promotion journal root contains too many entries (${MAX_PROMOTION_JOURNAL_ROOT_ENTRIES})`,
  );
  for (const name of entries) {
    const child = join(root, name);
    const remaining = limit > bytes ? limit - bytes : 0n;
    bytes += await measurePromotionTreeBytes(child, remaining);
    if (bytes >= limit) break;
  }
  return { journalCount: entries.length, bytes };
}


/**
 * One admission owner for one worlds root. The in-process queue prevents
 * managers in this Electron process from overlapping; the durable root lock
 * extends that same critical section across processes sharing the root.
 * Journal usage is rebuilt from the directory on every acquisition, so a
 * process crash cannot leave a stale reservation that is mistaken for live
 * evidence (or silently free a reservation for a journal that did publish).
 */
export class PromotionJournalAdmissionOwner {
  private queueTail: Promise<void> = Promise.resolve();
  private participants = 0;

  constructor(private rootBinding: BoundPromotionDirectory) {}

  register(): () => void {
    this.participants += 1;
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      this.participants -= 1;
    };
  }

  hasParticipants(): boolean {
    return this.participants > 0;
  }

  private async currentUsage(root: string): Promise<PromotionRetentionUsage> {
    const rootInfo = await lstatPath(root, { bigint: true });
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error("promotion worlds root is not an owned directory");
    }
    return measurePromotionRetention(root);
  }

  private async writeLedger(
    root: BoundPromotionDirectory,
    usage: PromotionRetentionUsage,
    reservation: PromotionJournalUsageLedger["reservation"],
  ): Promise<void> {
    const ledger: PromotionJournalUsageLedger = {
      version: PROMOTION_JOURNAL_USAGE_LEDGER_VERSION,
      root: { dev: root.dev, ino: root.ino },
      usage: { journalCount: usage.journalCount, bytes: usage.bytes.toString() },
      reservation,
    };
    await boundPromotionWriteJsonFile({
      root: root.path,
      rootIdentity: promotionIdentityOf(root),
      components: [PROMOTION_JOURNAL_USAGE_LEDGER],
      parentIdentity: promotionIdentityOf(root),
      value: ledger,
      maxBytes: 8 * 1024 * 1024,
      mode: 0o600,
    });
  }

  private async enter(): Promise<{ binding: BoundPromotionDirectory; leave: () => void }> {
    const previous = this.queueTail;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      releaseGate = resolveGate;
    });
    this.queueTail = previous.then(() => gate, () => gate);
    await previous;
    let binding: BoundPromotionDirectory;
    let lock: SessionRetentionLock;
    try {
      binding = await refreshBoundPromotionDirectory(this.rootBinding);
      this.rootBinding = binding;
      lock = acquireSessionRetentionLock(binding.path);
      if (String(lock.rootIdentity.dev) !== binding.dev || String(lock.rootIdentity.ino) !== binding.ino) {
        throw new Error("promotion worlds root identity changed before admission");
      }
    } catch (error) {
      releaseGate();
      throw error;
    }
    let released = false;
    return { binding, leave: () => {
      if (released) return;
      released = true;
      releaseSessionRetentionLock(lock);
      releaseGate();
    } };
  }

  async acquire(): Promise<PromotionJournalAdmissionResult> {
    let leave: (() => void) | null = null;
    let binding: BoundPromotionDirectory | null = null;
    try {
      const entered = await this.enter();
      leave = entered.leave;
      binding = entered.binding;
      const usage = await this.currentUsage(binding.path);
      const projectedBytes = usage.bytes + BigInt(MAX_PROMOTION_OPERATION_BYTES);
      if (usage.journalCount >= MAX_PROMOTION_JOURNALS || projectedBytes > BigInt(MAX_PROMOTION_JOURNAL_BYTES)) {
        leave();
        leave = null;
        return {
          ok: false,
          error: `promotion recovery evidence is at capacity (${usage.journalCount}/${MAX_PROMOTION_JOURNALS} journals, ${promotionRetentionBytes(usage.bytes)}/${promotionRetentionBytes(BigInt(MAX_PROMOTION_JOURNAL_BYTES))}); resolve or export retained/conflicting journals under ${resolve(binding.path, "promotion-journal")} before retrying`,
        };
      }
      const reservation = {
        token: randomUUID(),
        pid: process.pid,
        journalCount: 1,
        bytes: BigInt(MAX_PROMOTION_OPERATION_BYTES).toString(),
      };
      // Persist the reservation before the caller is allowed to create the
      // journal root/operation. A second process cannot enter until release.
      await this.writeLedger(binding, usage, reservation);
      let done = false;
      const release = async (): Promise<void> => {
        if (done) return;
        done = true;
        try {
          // Re-measure actual journals: a successful operation has removed its
          // journal, while a failed/uncertain operation remains accounted.
          const actual = await this.currentUsage(binding!.path);
          await this.writeLedger(binding!, actual, null);
        } finally {
          leave?.();
          leave = null;
        }
      };
      return { ok: true, lease: { release } };
    } catch (error) {
      leave?.();
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Serialize recovery/ledger reconciliation without reserving a new op. */
  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const entered = await this.enter();
    const { binding, leave } = entered;
    try {
      return await operation();
    } finally {
      try {
        const actual = await this.currentUsage(binding.path);
        await this.writeLedger(binding, actual, null);
      } finally {
        leave();
      }
    }
  }

  async drain(): Promise<void> {
    await this.queueTail;
  }
}

const promotionJournalAdmissionOwners = new Map<string, PromotionJournalAdmissionOwner>();

export function promotionJournalAdmissionOwnerFor(rootBinding: BoundPromotionDirectory): PromotionJournalAdmissionOwner {
  const root = realpathSync(resolve(rootBinding.path));
  let owner = promotionJournalAdmissionOwners.get(root);
  if (!owner) {
    owner = new PromotionJournalAdmissionOwner(rootBinding);
    promotionJournalAdmissionOwners.set(root, owner);
  }
  return owner;
}

export function releasePromotionJournalAdmissionOwner(owner: PromotionJournalAdmissionOwner): void {
  if (owner.hasParticipants()) return;
  for (const [root, current] of promotionJournalAdmissionOwners) {
    if (current !== owner) continue;
    promotionJournalAdmissionOwners.delete(root);
    return;
  }
}

export function promotionRetentionBytes(bytes: bigint): string {
  return `${Number(bytes / 1_048_576n).toLocaleString()} MiB`;
}


/** Reserve the new promotion's bounded merged tree/session/evidence envelope. */
export async function createPromotionOperationBudget(mergedDir: string): Promise<PromotionOperationBudget> {
  const max = BigInt(MAX_PROMOTION_OPERATION_BYTES);
  const mergedBytes = await measurePromotionTreeBytes(mergedDir, max);
  const reserved = mergedBytes + BigInt(MAX_SESSION_BYTES + MAX_PROMOTION_JOURNAL_OVERHEAD_BYTES);
  if (reserved > max) {
    throw new Error(`promotion recovery evidence for this operation exceeds its ${promotionRetentionBytes(max)} bound; reduce the promotion size and retry`);
  }
  return { used: reserved, max };
}

export function reservePromotionOperationBytes(budget: PromotionOperationBudget, bytes: number, label: string): void {
  const next = budget.used + BigInt(bytes);
  if (next > budget.max) {
    throw new Error(`promotion recovery evidence for ${label} exceeds its ${promotionRetentionBytes(budget.max)} bound; resolve retained evidence before retrying`);
  }
  budget.used = next;
}
