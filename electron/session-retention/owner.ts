/**
 * Session retention owner.
 *
 * Owns the SessionRetentionOwner transaction lifecycle. Split from
 * electron/session-retention.ts (issue #38).
 */
import { coreSessionFile, isCoreSessionId, parseSessionBundlePath } from "../../agent-core/session.js";
import { errorCode } from "../../shared/guards.js";
import { acquireSessionRetentionLock, releaseSessionRetentionLock, type SessionRetentionLock } from "../../shared/session-retention-lock.js";
import { boundPromotionOpenDirectory, disposeWorldlineGitCore } from "../worldline-git.js";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { isUncertainRetentionResult, readRetainedClaimAsync, removeRetainedClaim, removeRetainedEntry, retainedClaimName, writeRetainedClaim } from "./claims.js";
import type { RetainedClaimRemovalTestHook, RetainedSessionClaim } from "./claims.js";
import { accountingFromEntries, addRetainedTransactionEntries, claimLedgerEntry, expectedLedgerNames, loadRetainedUsageLedger, persistRetainedLedgerAfterRemoval, retainedLedgerFileIdentity, retainedRootEntries, writeRetainedUsageLedger } from "./ledger.js";
import { discardOwnedRetainedStaging, measureRetainedBundle, measureRetainedClaimTree, measureRetainedStaging } from "./measure.js";
import { MAX_RETAINED_SESSION_BUNDLES, MAX_RETAINED_SESSION_BUNDLE_BYTES, MAX_RETAINED_SESSION_BYTES, RETAINED_CLAIM_BYTES, RETENTION_QUEUE_HIGH_WATER, bindRetainedRoot, identityOf, inspectPath, sameIdentity, usageAdd } from "./primitives.js";
import type { RetainedIdentity, RetainedLedgerEntry, RetainedRootBinding, RetainedUsageLedger } from "./primitives.js";


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
                await removeRetainedEntry(root, runId, await lstat(destinationPath), lock, this.testHooks?.beforeBundleRemoval);
              }
              await removeRetainedClaim(root, runId, lock, this.testHooks?.beforeClaimRemoval);
              return { ok: true };
            }
            const destination = await inspectPath(join(root, runId));
            if (destination === null) return { ok: true };
            if (destination.isSymbolicLink() || !destination.isDirectory()) return { ok: false, error: "retained session bundle is not a proven directory" };
            const measured = await measureRetainedBundle(join(root, runId));
            if (!measured.ok) return { ok: false, error: measured.error };
            await removeRetainedEntry(root, runId, await lstat(join(root, runId)), lock, this.testHooks?.beforeBundleRemoval);
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
              const destinationInfo = await lstat(destinationPath);
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
              const destinationInfo = await lstat(destinationPath);
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
      await lstat(destinationBundle);
      throw new Error("the retained session destination already exists");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const claim = join(root, retainedClaimName(runId));
    try {
      await lstat(claim);
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
