/**
 * Core session fork entry point.
 *
 * Owns forked-session materialization and install. Split from agent-core/session.ts (issue #38).
 */
import { isRecord } from "../../shared/guards.ts";
import { closeSync, mkdirSync } from "node:fs";
import { rename } from "node:fs/promises";
import { basename, join } from "node:path";
import { retainUnboundCleanup } from "./bundles.ts";
import { anchoredChildPath, fsyncDirectoryDescriptor, openDirectoryAnchor } from "./descriptors.ts";
import { SessionWriter } from "./lifecycle.ts";
import { CURRENT_DIR, MAX_RETAINED_TEMP_BYTES, YIELD_EVERY_RECORDS, cancellation, cloneJson, errMsg, inspectEntry, parseSessionBundlePath, recoveryKey, sessionBundleLimit, yieldToEventLoop } from "./primitives.ts";
import type { ForkSessionResult, ReplayContent, ReplayMessage, ReplayRecovery, ReplayState, SessionBundlePaths, SessionOperationOptions, SessionReclaimReceiptTarget, SessionResult } from "./primitives.ts";
import { recoverSessionBlocks, replaySessionBundle } from "./replay.ts";
import { closeTempBundle, copyReferencedImages, createSecureTempBundle, referencedImageNames, releaseTempRetentionLock, removeEmptyAppOwnedClaim, retainedTempUsage, validateCommittedDestination, validateForkDestination, validateTempBundle } from "./temp-bundles.ts";
import type { TempBundle } from "./temp-bundles.ts";
export async function writeForkedSession(
  sourcePath: string,
  destPath: string,
  throughSeq?: number,
  options?: SessionOperationOptions,
): Promise<ForkSessionResult> {
  if (throughSeq !== undefined && (!Number.isInteger(throughSeq) || throughSeq < 0)) {
    return { ok: false, error: "invalid throughSeq" };
  }
  const source = parseSessionBundlePath(sourcePath);
  const dest = parseSessionBundlePath(destPath);
  if (!source) return { ok: false, error: "source path is not a core session bundle" };
  if (!dest) return { ok: false, error: "destination path is not a core session bundle" };
  if (source.bundleDir === dest.bundleDir) return { ok: false, error: "source and destination session bundles must differ" };
  const limit = sessionBundleLimit(options);
  if (!limit.ok) return limit;
  const cancelledBeforeFork = cancellation(options?.signal);
  if (cancelledBeforeFork) return cancelledBeforeFork;
  const validDestination = validateForkDestination(dest);
  if (!validDestination.ok) return validDestination;
  const replayed = await replaySessionBundle(source.sessionFile, {
    ...(throughSeq === undefined ? {} : { throughSeq }),
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.testOnlyMaxBundleBytes === undefined
      ? {}
      : { testOnlyMaxBundleBytes: options.testOnlyMaxBundleBytes }),
    ...(options?.testHooks ? { testHooks: options.testHooks } : {}),
    ...(options?.testOnlyPostRenameDelayMs === undefined
      ? {}
      : { testOnlyPostRenameDelayMs: options.testOnlyPostRenameDelayMs }),
  });
  if (!replayed.ok) return replayed;
  const targetSeq = throughSeq ?? replayed.maxSeq;
  if (targetSeq === 0) return materializeEmptyFork(dest, options);
  if (targetSeq > replayed.maxSeq && !replayed.stopped) return { ok: false, error: "fork point is beyond the source maximum" };
  const images = referencedImageNames(replayed.messages);
  if (!images.ok) return images;
  return materializeVisibleFork(
    source,
    dest,
    replayed.state,
    replayed.messages,
    targetSeq,
    images.names,
    replayed.sourceFingerprint,
    options,
  );
}
async function materializeEmptyFork(dest: SessionBundlePaths, options?: SessionOperationOptions): Promise<ForkSessionResult> {
  const created = createSecureTempBundle(dest, options);
  if (!created.ok) return created;
  const temp = created.temp;
  try {
    const cancelledBeforeCreate = cancellation(options?.signal);
    if (cancelledBeforeCreate) return cancelledBeforeCreate;
    const stable = validateTempBundle(temp);
    if (!stable.ok) return stable;
    const currentSynced = fsyncDirectoryDescriptor(temp.current.fd);
    if (!currentSynced.ok) return currentSynced;
    const tempSynced = fsyncDirectoryDescriptor(temp.temp.fd);
    if (!tempSynced.ok) return tempSynced;
    const installed = await installTempBundle(temp, dest.bundleDir, options);
    if (!installed.ok) return installed;
    return { ok: true, kept: 0 };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  } finally {
    closeTempBundle(temp);
    retainUnboundCleanup(temp.path, options?.testHooks?.beforeTemporaryCleanupMutation, options?.retentionLease?.retentionRunId);
    releaseTempRetentionLock(temp);
  }
}
async function materializeVisibleFork(
  source: SessionBundlePaths,
  dest: SessionBundlePaths,
  sourceState: ReplayState,
  messages: ReplayMessage[],
  throughSeq: number,
  imageNames: string[],
  sourceFingerprint: string,
  options?: SessionOperationOptions,
): Promise<ForkSessionResult> {
  const created = createSecureTempBundle(dest, options);
  if (!created.ok) return created;
  const temp = created.temp;
  try {
    const cancelledBeforeMaterialize = cancellation(options?.signal);
    if (cancelledBeforeMaterialize) return cancelledBeforeMaterialize;
    const stableBeforeWrite = validateTempBundle(temp);
    if (!stableBeforeWrite.ok) return stableBeforeWrite;
    const visibleSseqs = new Set(messages.map((message) => message.sseq));
    const visibleRecoveries = [...sourceState.recoveries.values()].filter((recovery) => visibleSseqs.has(recovery.sseq));
    const recoveredBlocks = await recoverSessionBlocks(source.sessionFile, visibleRecoveries, sourceFingerprint, options);
    if (!recoveredBlocks.ok) {
      return recoveredBlocks;
    }
    const recoveriesBySseq = new Map<number, ReplayRecovery[]>();
    for (const recovery of visibleRecoveries) {
      const entries = recoveriesBySseq.get(recovery.sseq) ?? [];
      entries.push(recovery);
      recoveriesBySseq.set(recovery.sseq, entries);
    }
    const childReceipts = new Map<string, { revisionSeq: number; targets: SessionReclaimReceiptTarget[] }>();
    const opened = SessionWriter.open(temp.sessionFile, 0, { testHooks: options?.testHooks });
    if (!opened.ok) {
      return opened;
    }
    try {
      for (let i = 0; i < messages.length; i++) {
        const cancelledBeforeRecord = cancellation(options?.signal);
        if (cancelledBeforeRecord) {
          opened.writer.close();
          return cancelledBeforeRecord;
        }
        const m = messages[i]!;
        const childSseq = i + 1;
        let content: ReplayContent = typeof m.content === "string" ? m.content : m.content.map((block) => cloneJson(block));
        if (typeof content !== "string") {
          const messageRecoveries = recoveriesBySseq.get(m.sseq) ?? [];
          const byRevision = new Map<number, ReplayRecovery[]>();
          for (const recovery of messageRecoveries) {
            const entries = byRevision.get(recovery.revisionSeq) ?? [];
            entries.push(recovery);
            byRevision.set(recovery.revisionSeq, entries);
          }
          // Undo revisions newest-first.  This restores the exact pre-prune
          // index before the child writes the message, including drop targets
          // whose indexes shifted after an earlier revision.
          const revisions = [...byRevision.entries()].sort((a, b) => b[0] - a[0]);
          for (const [, revisionsTargets] of revisions) {
            revisionsTargets.sort((a, b) => a.blockIndex - b.blockIndex);
            for (const recovery of revisionsTargets) {
              const original = recoveredBlocks.blocks.get(recoveryKey(recovery));
              if (!original) {
                opened.writer?.close();
                return { ok: false, error: "missing source record" };
              }
              const restored = cloneJson(original);
              if (recovery.action === "drop") {
                if (recovery.blockIndex > content.length) {
                  opened.writer?.close();
                  return { ok: false, error: "stale recovery target" };
                }
                content.splice(recovery.blockIndex, 0, restored);
              } else {
                if (recovery.blockIndex >= content.length || !isRecord(content[recovery.blockIndex])) {
                  opened.writer?.close();
                  return { ok: false, error: "stale recovery target" };
                }
                content[recovery.blockIndex] = restored;
              }
            }
          }
          for (const recovery of messageRecoveries) {
            const group = childReceipts.get(recovery.revisionId) ?? { revisionSeq: recovery.revisionSeq, targets: [] };
            group.targets.push({
              sseq: childSseq,
              sourceSseq: recovery.sourceSseq ?? recovery.sseq,
              blockIndex: recovery.blockIndex,
              action: recovery.action,
              original: { ...recovery.original },
              reclaimedTokens: recovery.reclaimedTokens,
              ...(recovery.tool === undefined ? {} : { tool: recovery.tool }),
              ...(recovery.repro === undefined ? {} : { repro: recovery.repro }),
              fallback: "full-read",
              revisionId: recovery.revisionId,
              recovery: { ...recovery.recovery },
            });
            childReceipts.set(recovery.revisionId, group);
          }
        }
        const written = opened.writer.appendRecord({
          storageSeq: childSseq,
          type: "message",
          message: { role: m.role, content },
        });
        if (!written.ok) {
          opened.writer.close();
          return written;
        }
        if (i % YIELD_EVERY_RECORDS === YIELD_EVERY_RECORDS - 1) {
          await yieldToEventLoop();
          const cancelledAfterYield = cancellation(options?.signal);
          if (cancelledAfterYield) {
            opened.writer.close();
            return cancelledAfterYield;
          }
        }
      }
      let nextStorageSeq = messages.length + 1;
      const orderedChildReceipts = [...childReceipts.entries()].sort((a, b) => a[1].revisionSeq - b[1].revisionSeq);
      for (const [revisionId, group] of orderedChildReceipts) {
        const targets = group.targets.slice().sort((a, b) => a.sseq - b.sseq || b.blockIndex - a.blockIndex);
        if (nextStorageSeq > throughSeq) {
          opened.writer.close();
          return { ok: false, error: "fork recovery mapping exceeds fork point" };
        }
        const written = opened.writer.appendRecord({
          storageSeq: nextStorageSeq,
          type: "revision",
          kind: "prune",
          revisionId,
          targets,
        });
        nextStorageSeq += 1;
        if (!written.ok) {
          opened.writer.close();
          return written;
        }
      }
      if (throughSeq >= nextStorageSeq) {
        const written = opened.writer.appendRecord({ storageSeq: throughSeq, type: "checkpoint" });
        if (!written.ok) {
          opened.writer.close();
          return written;
        }
      }
    } finally {
      opened.writer.close();
    }
    const stableAfterWrite = validateTempBundle(temp);
    if (!stableAfterWrite.ok) return stableAfterWrite;
    if (imageNames.length > 0) {
      // Session records were written after the admission scan. Refresh the
      // lock-scoped baseline once before image copies so their aggregate
      // check includes the staged session bytes without rescanning per image.
      const retainedBeforeImages = retainedTempUsage(dest.projectDir);
      if (!retainedBeforeImages.ok) return retainedBeforeImages;
      temp.retainedBytes = retainedBeforeImages.bytes;
    }
    const copied = await copyReferencedImages(source.currentDir, temp, imageNames, options);
    if (!copied.ok) {
      return copied;
    }
    const currentSynced = fsyncDirectoryDescriptor(temp.current.fd);
    if (!currentSynced.ok) return currentSynced;
    const tempSynced = fsyncDirectoryDescriptor(temp.temp.fd);
    if (!tempSynced.ok) return tempSynced;
    const retainedBeforeInstall = retainedTempUsage(dest.projectDir);
    if (!retainedBeforeInstall.ok) return retainedBeforeInstall;
    if (retainedBeforeInstall.bytes > MAX_RETAINED_TEMP_BYTES) {
      return { ok: false, error: `retained temporary sessions exceed ${MAX_RETAINED_TEMP_BYTES} bytes` };
    }
    const installed = await installTempBundle(temp, dest.bundleDir, options);
    if (!installed.ok) return installed;
    return { ok: true, kept: messages.length };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  } finally {
    closeTempBundle(temp);
    retainUnboundCleanup(temp.path, options?.testHooks?.beforeTemporaryCleanupMutation, options?.retentionLease?.retentionRunId);
    releaseTempRetentionLock(temp);
  }
}
async function installTempBundle(
  temp: TempBundle,
  destBundle: string,
  options?: SessionOperationOptions,
): Promise<SessionResult<{ committed: true }> | { ok: false; error: string; commit: "uncertain" }> {
  const stable = validateTempBundle(temp);
  if (!stable.ok) return stable;
  const cancelledBeforeInstall = cancellation(options?.signal);
  if (cancelledBeforeInstall) return cancelledBeforeInstall;
  try {
    options?.testHooks?.beforeDestinationClaim?.(destBundle);
    mkdirSync(anchoredChildPath(temp.parent, basename(destBundle), destBundle), { recursive: false, mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      const destination = inspectEntry(destBundle);
      return {
        ok: false,
        error: destination?.kind === "symlink" ? "destination session bundle is a symlink" : "destination session bundle already exists",
      };
    }
    return { ok: false, error: errMsg(err) };
  }
  const claimed = openDirectoryAnchor(
    destBundle,
    "claimed destination session bundle",
    anchoredChildPath(temp.parent, basename(destBundle), destBundle),
  );
  if (!claimed.ok) return claimed;
  const committed = claimed.anchor;
  try {
    options?.testHooks?.afterDestinationClaim?.(destBundle);
    options?.testHooks?.beforeDestinationCurrentInstall?.(destBundle);
    await rename(
      anchoredChildPath(temp.temp, CURRENT_DIR, temp.currentDir),
      anchoredChildPath(committed, CURRENT_DIR, join(destBundle, CURRENT_DIR)),
    );
    temp.current.path = join(destBundle, CURRENT_DIR);
  } catch (err) {
    const cleaned = removeEmptyAppOwnedClaim(destBundle, temp.parent, committed, options);
    closeSync(committed.fd);
    if (cleaned.ok) return { ok: false, error: errMsg(err) };
    return {
      ok: false,
      error: `${errMsg(err)}; destination claim cleanup could not be proven: ${cleaned.error}`,
      commit: "uncertain",
    };
  }
  try {
    options?.testHooks?.afterDestinationRename?.(destBundle);
    if (options?.testOnlyPostRenameDelayMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, options.testOnlyPostRenameDelayMs));
    }
    // Rename is the commit point. A late cancellation cannot turn a durable
    // commit into a reported failure; disposal waits for this terminal reply.
    const destinationSynced = fsyncDirectoryDescriptor(committed.fd);
    if (!destinationSynced.ok) throw new Error(destinationSynced.error);
    options?.testHooks?.beforeDestinationParentSync?.(destBundle);
    const parentSynced = fsyncDirectoryDescriptor(temp.parent.fd);
    if (!parentSynced.ok) throw new Error(parentSynced.error);
    options?.testHooks?.beforeDestinationVerify?.(destBundle);
    const installed = validateCommittedDestination(temp, committed);
    if (!installed.ok) throw new Error(installed.error);
    return { ok: true, committed: true };
  } catch (err) {
    // Once current is installed, never recursively roll back through a
    // pathname. Keep the installed or replacement destination intact and
    // expose the commit ambiguity to the caller.
    return {
      ok: false,
      error: `${errMsg(err)}; committed destination was preserved`,
      commit: "uncertain",
    };
  } finally {
    try {
      closeSync(committed.fd);
    } catch {
      /* already closed */
    }
  }
}