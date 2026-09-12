/**
 * Promotion journal recovery and rollback.
 *
 * Owns journal recovery, applied-promotion completion, and rollback.
 * Split from promotion-recovery.ts (issue #38).
 */
import { parseSessionBundlePath } from "../../../agent-core/session.js";
import { boundPromotionCopyFile, boundPromotionCreateSymlink, boundPromotionInstallDirectory, boundPromotionListDirectories, boundPromotionOpenDirectory, boundPromotionPrepareDirectory, boundPromotionTransition, boundPromotionWriteFile, disposeWorldlineGitCore, readBoundPromotionJournal, type BoundPromotionExpectedLeaf, type PromotionFsIdentity } from "../../worldline-git.js";
import { promotionIdentityOf } from "../bindings.js";
import { errnoCode, isInside } from "../guards.js";
import { promotionJournalAdmissionOwnerFor, releasePromotionJournalAdmissionOwner } from "../promotion-journal.js";
import { type BoundPromotionDirectory, type CanonicalPath, type PromotionArtifactManifest, type PromotionDirectoryPlan, type PromotionEntryState, type PromotionJournalBinding, type PromotionRecoveryContext } from "../types.js";
import { randomUUID } from "node:crypto";
import { lstat as lstatPath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { assertBoundPromotionDirectory, ensureBoundDirectory, ensureBoundRelativeDirectory, existingPromotionDirectoryIdentity, filesystemCanonicalPath, probePromotionDirectory } from "./bound-dirs.js";
import { assertPromotionState, boundPromotionExpectedLeaf, promotionDestination, promotionDestinationComponents, promotionParentComponents, promotionParentIdentity, promotionSourceComponents, promotionStatesEqual, readPromotionEntry } from "./entry-state.js";
import { createPromotionArtifactManifest, parsePromotionArtifactManifest, runPromotionRecoveryTestHook, validatePromotionJournalHeader, validatePromotionJournalPaths, validatePromotionRollbackTemps, writePromotionJournal } from "./journals.js";
import type { PromotionRollbackTemp } from "./journals.js";
import { sha256Hex, withPromotionTransaction } from "./primitives.js";


async function verifyInstalledBundleAgainstManifest(bundleDir: string, manifest: PromotionArtifactManifest): Promise<boolean> {
  if (manifest.status !== "created") return true;
  if (resolve(manifest.path) !== resolve(bundleDir)) return false;
  let recomputed: PromotionArtifactManifest;
  try {
    recomputed = await createPromotionArtifactManifest(bundleDir);
  } catch {
    return false;
  }
  if (recomputed.status !== "created") return false;
  if (recomputed.entries.length !== manifest.entries.length) return false;
  const currentByRel = new Map(recomputed.entries.map((entry) => [entry.rel, entry]));
  for (const expected of manifest.entries) {
    const actual = currentByRel.get(expected.rel);
    if (!actual) return false;
    if (actual.dev !== expected.dev || actual.ino !== expected.ino) return false;
    if (!promotionStatesEqual(actual.state, expected.state)) return false;
  }
  return true;
}


/**
 * Crash-complete an `applied` journal without a session worker.
 *
 * The merged tree is already durable when phase is `applied`. When every
 * journaled path still equals its after-state and the installed bundle is
 * already present (or the staged bundle can be moved into place), leave the
 * merged tree and report completion. Any other shape is impossible without a
 * fork, so the caller falls back to rollback.
 */
async function tryCompleteAppliedPromotion(
  journalDir: string,
  journal: Record<string, unknown>,
  primaryRoot: string,
  canonicalPath: CanonicalPath,
  journalBinding: PromotionJournalBinding,
): Promise<boolean> {
  try {
    if (String(journal.phase) !== "applied") return false;
    validatePromotionJournalHeader(journal, primaryRoot);
    const paths = validatePromotionJournalPaths(journal);
    const uncertain = journal.uncertainSessionArtifacts;
    if (Array.isArray(uncertain) && uncertain.length > 0) return false;
    const stagedSession = journal.stagedSession;
    const installedSession = journal.installedSession;
    if (typeof stagedSession !== "string" || typeof installedSession !== "string") return false;
    const sessionRootPath = join(journalDir, "session");
    if (!isInside(resolve(sessionRootPath), resolve(stagedSession))) return false;
    const parsed = parseSessionBundlePath(installedSession);
    if (!parsed) return false;
    const manifest = parsePromotionArtifactManifest(journal.installedSessionManifest, "installedSession");
    if (!manifest) return false;
    if (resolve(manifest.path) !== resolve(parsed.bundleDir)) return false;
    const canonicalRoot = await canonicalPath(primaryRoot);
    for (const entry of paths) {
      const abs = await promotionDestination(primaryRoot, canonicalRoot, entry.rel, canonicalPath);
      const current = (await readPromotionEntry(abs)).state;
      if (!promotionStatesEqual(current, entry.afterState!)) return false;
    }
    try {
      const installedInfo = await lstatPath(parsed.bundleDir);
      if (installedInfo.isDirectory() && !installedInfo.isSymbolicLink()) {
        const installedState = (await readPromotionEntry(installedSession)).state;
        if (installedState.type === "file") {
          if (manifest.status === "created" && !(await verifyInstalledBundleAgainstManifest(parsed.bundleDir, manifest))) return false;
          return true;
        }
        return false;
      }
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") return false;
    }
    if (manifest.status !== "planned") return false;
    const stagedBundleDir = join(sessionRootPath, parsed.sessionId);
    const sessionRootPlan = await probePromotionDirectory(journalBinding.directory, sessionRootPath, "promotion recovery session root");
    if (!sessionRootPlan.identity) return false;
    const stagedPlan = await probePromotionDirectory(journalBinding.directory, stagedBundleDir, "promotion recovery staged bundle");
    if (!stagedPlan.identity) return false;
    let stagedInfo;
    try {
      stagedInfo = await lstatPath(stagedBundleDir, { bigint: true });
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return false;
      return false;
    }
    if (!stagedInfo.isDirectory() || stagedInfo.isSymbolicLink()) return false;
    if (String(stagedInfo.dev) !== stagedPlan.identity.dev || String(stagedInfo.ino) !== stagedPlan.identity.ino) return false;
    const stagedState = (await readPromotionEntry(join(stagedBundleDir, "current", "session.jsonl"))).state;
    if (stagedState.type !== "file") return false;
    let destInfo;
    try {
      destInfo = await lstatPath(parsed.projectDir, { bigint: true });
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return false;
      return false;
    }
    if (!destInfo.isDirectory() || destInfo.isSymbolicLink()) return false;
    let destIdentity: PromotionFsIdentity;
    try {
      destIdentity = await boundPromotionOpenDirectory({
        path: parsed.projectDir,
        expectedIdentity: { dev: String(destInfo.dev), ino: String(destInfo.ino) },
      });
    } catch {
      return false;
    }
    const sourceRootBinding: BoundPromotionDirectory = {
      path: sessionRootPath,
      dev: sessionRootPlan.identity.dev,
      ino: sessionRootPlan.identity.ino,
      capability: sessionRootPlan.identity.capability,
    };
    const destRootBinding: BoundPromotionDirectory = {
      path: parsed.projectDir,
      dev: destIdentity.dev,
      ino: destIdentity.ino,
      capability: destIdentity.capability,
    };
    try {
      const moved = await boundPromotionInstallDirectory({
        sourceRoot: sourceRootBinding.path,
        sourceRootIdentity: promotionIdentityOf(sourceRootBinding),
        sourceComponents: [parsed.sessionId],
        sourceParentIdentity: promotionIdentityOf(sourceRootBinding),
        expectedSource: {
          identity: { dev: stagedPlan.identity.dev, ino: stagedPlan.identity.ino },
          mode: Number(stagedInfo.mode & 0o777n),
        },
        destinationRoot: destRootBinding.path,
        destinationRootIdentity: promotionIdentityOf(destRootBinding),
        destinationComponents: [parsed.sessionId],
        destinationParentIdentity: promotionIdentityOf(destRootBinding),
      });
      if (moved.outcome !== "applied" || !moved.durable) return false;
    } catch {
      return false;
    }
    try {
      const installedInfo = await lstatPath(parsed.bundleDir);
      if (!installedInfo.isDirectory() || installedInfo.isSymbolicLink()) return false;
      if ((await readPromotionEntry(installedSession)).state.type !== "file") return false;
    } catch {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}


async function rollbackPromotionPaths(
  journalDir: string,
  journal: Record<string, unknown>,
  primaryRoot: string,
  canonicalPath: CanonicalPath,
  journalBinding?: PromotionJournalBinding,
  primaryRootBinding?: BoundPromotionDirectory,
  readonlyJournal = false,
): Promise<boolean> {
  const persistJournal = async (): Promise<void> => {
    if (readonlyJournal) return;
    if (!journalBinding) throw new Error("promotion journal binding is missing");
    await writePromotionJournal(journalBinding, journal);
  };
  const persistConflict = async (value: unknown): Promise<void> => {
    if (readonlyJournal) return;
    if (!journalBinding) throw new Error("promotion journal binding is missing");
    await boundPromotionWriteFile({
      root: journalBinding.directory.path,
      rootIdentity: promotionIdentityOf(journalBinding.directory),
      components: ["conflict.json"],
      parentIdentity: promotionIdentityOf(journalBinding.directory),
      expectedDestination: { state: { type: "missing" } },
      content: Buffer.from(JSON.stringify(value, null, 2)),
      mode: 0o600,
    });
  };
  if (journalBinding) assertBoundPromotionDirectory(journalBinding.directory);
  validatePromotionJournalHeader(journal, primaryRoot);
  const paths = validatePromotionJournalPaths(journal);
  validatePromotionRollbackTemps(journal);
  // Bind the recovery root and every currently-existing destination parent
  // before reading mutable primary entries.  Recovery must not turn a journal
  // path into a fresh trust decision after an ancestor swap.
  const primaryRootBindingResolved = primaryRootBinding ?? await ensureBoundDirectory(primaryRoot, "promotion recovery primary root");
  const parentPlans = new Map<string, PromotionDirectoryPlan>();
  for (const path of paths) {
    const parentPath = resolve(dirname(join(primaryRoot, path.rel)));
    if (!parentPlans.has(parentPath)) {
      parentPlans.set(parentPath, await probePromotionDirectory(primaryRootBindingResolved, parentPath, "promotion recovery parent"));
    }
  }
  const canonicalRoot = await canonicalPath(primaryRoot);
  // Rollback temps are retained evidence. Removing one by pathname after an
  // identity check is a check-to-use race and can delete a replacement; the
  // native exchange/retire boundary below preserves both operands instead.
  const conflictPaths: string[] = [];
  for (const p of paths) {
    let restoreTmp: string | null = null;
    let restoreRecord: PromotionRollbackTemp | null = null;
    let restoreExpected: BoundPromotionExpectedLeaf | null = null;
    try {
      const beforeState = p.beforeState!;
      const afterState = p.afterState!;
      let abs = await promotionDestination(primaryRoot, canonicalRoot, p.rel, canonicalPath);
      const current = (await readPromotionEntry(abs)).state;
      if (promotionStatesEqual(current, beforeState)) continue;
      if (!promotionStatesEqual(current, afterState)) throw new Error(`filesystem state conflicts at ${p.rel}`);

      let beforeExpected: BoundPromotionExpectedLeaf | null = null;
      if (beforeState.type === "file") {
        const savedPath = join(journalDir, "before", p.rel);
        if (!journalBinding) throw new Error(`before-image journal binding is missing at ${p.rel}`);
        assertBoundPromotionDirectory(journalBinding.directory);
        if (p.beforeImageIdentity && p.beforeImageSize) {
          beforeExpected = {
            identity: p.beforeImageIdentity,
            state: {
              type: "file",
              mode: beforeState.mode ?? 0o644,
              size: p.beforeImageSize,
              sha256: beforeState.hash,
            },
          };
        } else {
          // Journals written before the native evidence boundary have no
          // persisted image identity. Read only to derive a one-time expected
          // descriptor; the native copy below still rejects a replacement.
          const saved = await readPromotionEntry(savedPath);
          if (saved.state.type !== "file" || saved.state.hash !== beforeState.hash || !saved.bytes) throw new Error(`before-image is corrupt at ${p.rel}`);
          beforeExpected = await boundPromotionExpectedLeaf(savedPath, beforeState, `before-image ${p.rel}`);
        }
      }
      if (beforeState.type === "file" || beforeState.type === "symlink") {
        const parentPlan = parentPlans.get(resolve(dirname(abs)));
        if (!parentPlan) throw new Error(`promotion recovery parent was not pre-bound: ${dirname(abs)}`);
        const parent = await promotionParentIdentity(abs, canonicalRoot, canonicalPath, parentPlan);
        restoreTmp = join(parent.path, `.termina-promotion-${randomUUID()}.tmp`);
        restoreRecord = { status: "planned", rel: p.rel, path: restoreTmp, parent: parent.path, parentDev: parent.dev, parentIno: parent.ino };
        journal.rollbackTemps = [restoreRecord];
        await persistJournal();
        const primaryRootInfo = primaryRootBindingResolved;
        const primaryParent: BoundPromotionDirectory = { path: parent.path, dev: String(parent.dev), ino: String(parent.ino) };
        const tempComponents = [...promotionParentComponents(primaryRoot, parent.path), basename(restoreTmp)];
        if (beforeState.type === "file") {
          if (!beforeExpected || !journalBinding) throw new Error(`before-image expectation is missing at ${p.rel}`);
          const beforeParent = await ensureBoundRelativeDirectory(journalBinding.directory, ["before", ...promotionSourceComponents(p.rel).slice(0, -1)], "before-image rollback parent");
          restoreExpected = await boundPromotionCopyFile({
            sourceRoot: journalBinding.directory.path,
            sourceRootIdentity: promotionIdentityOf(journalBinding.directory),
            sourceComponents: ["before", ...promotionSourceComponents(p.rel)],
            sourceParentIdentity: promotionIdentityOf(beforeParent),
            expectedSource: beforeExpected,
            destinationRoot: primaryRootInfo.path,
            destinationRootIdentity: promotionIdentityOf(primaryRootInfo),
            destinationComponents: tempComponents,
            destinationParentIdentity: promotionIdentityOf(primaryParent),
          });
        } else {
          const created = await boundPromotionCreateSymlink({
            root: primaryRootInfo.path,
            rootIdentity: promotionIdentityOf(primaryRootInfo),
            components: tempComponents,
            parentIdentity: promotionIdentityOf(primaryParent),
            target: beforeState.target,
          });
          restoreExpected = created;
        }
        if (!restoreExpected) throw new Error(`rollback temp was not created at ${p.rel}`);
        const restoreState: PromotionEntryState = restoreExpected.state.type === "file"
          ? { type: "file", mode: restoreExpected.state.mode, hash: restoreExpected.state.sha256 }
          : { type: "symlink", target: restoreExpected.state.target };
        restoreRecord = { ...restoreRecord, status: "created", dev: Number(restoreExpected.identity.dev), ino: Number(restoreExpected.identity.ino), state: restoreState };
        journal.rollbackTemps = [restoreRecord];
        await persistJournal();
      }

      abs = await promotionDestination(primaryRoot, canonicalRoot, p.rel, canonicalPath);
      const finalParentPlan = parentPlans.get(resolve(dirname(abs)));
      if (!finalParentPlan) throw new Error(`promotion recovery parent was not pre-bound: ${dirname(abs)}`);
      const finalParent = await promotionParentIdentity(abs, canonicalRoot, canonicalPath, finalParentPlan);
      if (restoreRecord && (finalParent.path !== restoreRecord.parent || finalParent.dev !== restoreRecord.parentDev || finalParent.ino !== restoreRecord.parentIno)) {
        throw new Error(`promotion parent changed before rollback at ${p.rel}`);
      }
      if (beforeState.type === "missing") {
        await assertPromotionState(abs, afterState, `filesystem state changed before rollback at ${p.rel}`);
        const rootIdentity = promotionIdentityOf(primaryRootBindingResolved);
        const parentIdentity = { dev: String(finalParent.dev), ino: String(finalParent.ino) };
        const retainedName = basename(p.retainedName ?? `.termina-promotion-retained-${sha256Hex(Buffer.from(`${journal.opId ?? "promotion"}:${p.rel}`)).slice(0, 24)}.tmp`);
        if (!p.retainedName) {
          p.retainedName = retainedName;
          journal.paths = paths;
          await persistJournal();
        }
        const result = await boundPromotionTransition({
          primaryRoot,
          primaryRootIdentity: rootIdentity,
          destinationComponents: promotionDestinationComponents(primaryRoot, finalParent.path, p.rel),
          parentIdentity,
          transition: {
            kind: "retire",
            retainedName,
            expectedDestination: await boundPromotionExpectedLeaf(abs, afterState, `promotion destination ${p.rel}`),
          },
        });
        if (result.outcome !== "applied" || !result.durable) throw new Error(result.error ?? `promotion retire conflict at ${p.rel}`);
        p.retainedName = retainedName;
      } else if (restoreTmp) {
        if (!restoreRecord || restoreRecord.status !== "created") throw new Error(`rollback temp was not committed at ${p.rel}`);
        await assertPromotionState(abs, afterState, `filesystem state changed before rollback at ${p.rel}`);
        const rootIdentity = promotionIdentityOf(primaryRootBindingResolved);
        const parentIdentity = { dev: String(finalParent.dev), ino: String(finalParent.ino) };
        if (!restoreExpected) throw new Error(`rollback temp expectation is missing at ${p.rel}`);
        const expectedSource = restoreExpected;
        const result = afterState.type === "missing"
          ? await boundPromotionTransition({
              primaryRoot,
              primaryRootIdentity: rootIdentity,
              destinationComponents: promotionDestinationComponents(primaryRoot, finalParent.path, p.rel),
              parentIdentity,
              transition: {
                kind: "install",
                sourceRoot: primaryRoot,
                sourceRootIdentity: rootIdentity,
                sourceComponents: promotionSourceComponents(relative(primaryRoot, restoreTmp)),
                sourceParentIdentity: parentIdentity,
                expectedSource,
                expectedDestination: { state: { type: "missing" } },
              },
            })
          : await boundPromotionTransition({
              primaryRoot,
              primaryRootIdentity: rootIdentity,
              destinationComponents: promotionDestinationComponents(primaryRoot, finalParent.path, p.rel),
              parentIdentity,
              transition: {
                kind: "exchange",
                sourceName: basename(restoreTmp),
                expectedSource,
                expectedDestination: await boundPromotionExpectedLeaf(abs, afterState, `promotion destination ${p.rel}`),
              },
            });
        if (result.outcome !== "applied" || !result.durable) throw new Error(result.error ?? `promotion exchange conflict at ${p.rel}`);
      } else {
        throw new Error(`unsupported before-state at ${p.rel}`);
      }
      await assertPromotionState(abs, beforeState, `rollback verification failed at ${p.rel}`);
    } catch {
      conflictPaths.push(typeof p.rel === "string" ? p.rel : "<invalid path>");
    }
  }
  const conflicted = conflictPaths.length > 0;
  if (conflicted) {
    journal.phase = "conflict";
    await persistJournal();
    await persistConflict({ at: Date.now(), paths: conflictPaths });
    return false;
  }
  return true;
}


export async function rollbackPromotion(
  journalDir: string,
  journal: Record<string, unknown>,
  primaryRoot: string,
  canonicalPath: CanonicalPath,
  journalBinding?: PromotionJournalBinding,
  primaryRootBinding?: BoundPromotionDirectory,
): Promise<boolean> {
  const phase = String(journal.phase ?? "prepared");
  if (!["prepared", "applying", "applied"].includes(phase)) {
    // A failed live promotion retains unexpected-phase evidence as well. The
    // directory pathname is not deletion provenance once control left the
    // creation step; only the successful completion path removes its own
    // freshly created journal.
    return false;
  }
  // Live failure after `applied` still rolls back: the synchronous session
  // install already failed, so files and session stay atomic by restoring the
  // before-images. Crash recovery (`recoverPromotionJournals`) instead tries
  // `tryCompleteAppliedPromotion` first and only rolls back when completion
  // is impossible.
  return rollbackPromotionPaths(journalDir, journal, primaryRoot, canonicalPath, journalBinding, primaryRootBinding);
}


/** Startup recovery: finish or roll back every pending promotion journal. */
export async function recoverPromotionJournals(worldsRoot: string, context: PromotionRecoveryContext): Promise<void> {
  const binding = await ensureBoundDirectory(worldsRoot, "worlds root");
  const owner = promotionJournalAdmissionOwnerFor(binding);
  const releaseOwner = owner.register();
  try {
    return await withPromotionTransaction(() => owner.withLock(() => recoverPromotionJournalsUnderTransaction(worldsRoot, context)));
  } finally {
    releaseOwner();
    releasePromotionJournalAdmissionOwner(owner);
  }
}


/**
 * Establish the current-format promotion roots for a freshly-created fixture.
 *
 * This deliberately delegates to the same strict binder used by startup and
 * recovery: missing leaves are created below a trusted parent and receive a
 * persisted identity; an existing unproven leaf is rejected. Production
 * startup never calls this setup helper.
 */
export async function ensurePromotionRoots(worldsRoot: string, primaryRoot: string): Promise<void> {
  return withPromotionTransaction(async () => {
    const worldsRootBinding = await ensureBoundDirectory(worldsRoot, "worlds root");
    await ensureBoundDirectory(primaryRoot, "primary root", worldsRootBinding);
  });
}


/** Stop the shared native helper when a focused Worldline harness exits. */
export function disposeWorldlineCoreClient(): void {
  disposeWorldlineGitCore();
}


async function recoverPromotionJournalsUnderTransaction(worldsRoot: string, context: PromotionRecoveryContext): Promise<void> {
  let root: BoundPromotionDirectory;
  let primaryRootBinding: BoundPromotionDirectory;
  let entries: Array<{ name: string; identity: PromotionFsIdentity }>;
  try {
    // Bind the app-owned worlds root from its trusted parent first. The
    // recovery journal itself is then opened as a child of that capability;
    // no first identity is accepted from a mutable journal pathname.
    const worldsRootBinding = await ensureBoundDirectory(worldsRoot, "worlds root");
    const primaryIdentity = await existingPromotionDirectoryIdentity(
      context.primaryRoot,
      "promotion recovery primary root",
    );
    if (!primaryIdentity) throw new Error("promotion recovery primary root is missing");
    primaryRootBinding = await ensureBoundDirectory(
      context.primaryRoot,
      "promotion recovery primary root",
      worldsRootBinding,
      { initialIdentity: primaryIdentity },
    );
    const rootPath = join(worldsRootBinding.path, "promotion-journal");
    const identity = await boundPromotionPrepareDirectory({
      root: worldsRootBinding.path,
      rootIdentity: promotionIdentityOf(worldsRootBinding),
      components: ["promotion-journal"],
      createMissing: true,
    });
    if (!identity.identity) return;
    root = {
      path: rootPath,
      dev: identity.identity.dev,
      ino: identity.identity.ino,
      capability: identity.identity.capability,
    };
    entries = await boundPromotionListDirectories({
      root: root.path,
      rootIdentity: promotionIdentityOf(root),
    });
  } catch (error) {
    console.warn(`[worldline] promotion root bind failed closed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  for (const entry of entries) {
    let dir: BoundPromotionDirectory;
    try {
      assertBoundPromotionDirectory(root);
      dir = { path: join(root.path, entry.name), dev: entry.identity.dev, ino: entry.identity.ino };
    } catch {
      continue;
    }
    let journal: Record<string, unknown> | null = null;
    try {
      assertBoundPromotionDirectory(dir);
      await runPromotionRecoveryTestHook("after-journal-validation", dir.path);
      const journalBytes = await readBoundPromotionJournal({
        journalRoot: root.path,
        journalRootIdentity: promotionIdentityOf(root),
        operationName: basename(dir.path),
        operationIdentity: { dev: dir.dev, ino: dir.ino },
      });
      journal = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(journalBytes)) as Record<string, unknown>;
    } catch {
      // Recovery never writes a marker into a journal-selected path. A bound
      // directory can still be swapped after a path identity check, and Node
      // offers no descriptor-relative atomic marker creation here.
      console.warn(`[worldline] unreadable promotion journal retained: ${dir.path}`);
      continue;
    }
    try {
      const phase = String(journal.phase ?? "prepared");
      const primaryRoot = String(journal.primaryRoot ?? "");
      if (primaryRoot !== context.primaryRoot) continue;
      if (!["prepared", "applying", "applied"].includes(phase)) {
        if (phase === "conflict") continue;
        if (phase === "done" || phase === "rolled-back") continue;
        console.warn(`[worldline] promotion journal with unknown phase retained: ${dir.path}`);
        continue;
      }
      const recoveryBinding: PromotionJournalBinding = {
        root,
        directory: dir,
        name: entry.name,
        journalFile: null,
      };
      if (phase === "applied") {
        const completed = await tryCompleteAppliedPromotion(dir.path, journal, primaryRoot, filesystemCanonicalPath, recoveryBinding);
        if (completed) {
          console.warn(`[worldline] promotion journal completed with artifacts retained: ${dir.path}`);
          continue;
        }
      }
      const rolledBack = await rollbackPromotionPaths(
        dir.path,
        journal,
        primaryRoot,
        filesystemCanonicalPath,
        recoveryBinding,
        primaryRootBinding,
        true,
      );
      if (rolledBack) {
        // Do not delete installed sessions, rollback temps, or the journal in
        // recovery. Journal-provided paths/manifests are not sufficient
        // provenance to destroy a live agent session, and Node cannot make
        // the final remove sink descriptor-relative.
        console.warn(`[worldline] promotion journal recovered with artifacts retained: ${dir.path}`);
      } else {
        console.warn(`[worldline] promotion recovery conflict: ${dir.path} — kept every version`);
      }
    } catch {
      console.warn(`[worldline] promotion recovery failed closed: ${dir.path}`);
    }
  }
}
