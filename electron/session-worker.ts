/**
 * Session worker entry (worker_threads).
 *
 * Performs all SessionManager work off the Electron main thread
 * (WORLDLINES §6.7). Forking a candidate session runs here: copy the
 * source session to an app-private workspace, open the copy, verify the
 * entry chain, extract the path, and fork it into the candidate session
 * directory.
 *
 * Keep session-fork as a type-only import: a runtime import would load the
 * client (and nested Worker) inside this thread.
 */
import { parentPort } from "node:worker_threads";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  copyPiSessionFile,
  inspectEmptySessionBundle,
  removePiSessionCopy,
  writeForkedSession,
  type PiSessionCopyIdentity,
  type PiSessionCopyResult,
} from "../agent-core/session.js";
import { coreClient } from "./core-client.js";
import {
  boundPromotionCreateDirectory,
  boundPromotionOpenDirectory,
  boundPromotionRemoveTree,
} from "./worldline-git.js";
import type {
  CoreSessionForkRequest,
  CoreSessionDiscardRequest,
  PiSessionCopyRequest,
  SessionForkReply,
  SessionForkRequest,
  SessionWorkerRequest,
} from "./session-fork.js";

function post(msg: SessionForkReply): void {
  parentPort?.postMessage(msg);
}

const activeCoreForks = new Map<string, AbortController>();
const activePiForks = new Map<string, AbortController>();
const activePiCopies = new Map<string, AbortController>();

type CleanupResult =
  | { ok: true; removed: boolean }
  | { ok: false; error: string };

function samePiCopyLeaf(info: BigIntStats, expected: PiSessionCopyIdentity): boolean {
  if (!info.isFile() || info.isSymbolicLink()) return false;
  return String(info.dev) === expected.dev
    && String(info.ino) === expected.ino
    && (expected.nlink === undefined || String(info.nlink) === expected.nlink)
    && (expected.size === undefined || String(info.size) === expected.size)
    && (expected.mtimeNs === undefined || String(info.mtimeNs) === expected.mtimeNs)
    && (expected.ctimeNs === undefined || String(info.ctimeNs) === expected.ctimeNs);
}

/**
 * Node's descriptor-relative unlink is Linux-only. On other hosts the
 * canonical session owner deliberately retains the file; use the existing
 * native bound quarantine primitive when the worker has enough provenance to
 * hand cleanup back to the Rust owner. Any proof failure leaves evidence.
 */
async function cleanupPiCopy(path: string, workspaceDir: string, expected: PiSessionCopyIdentity): Promise<CleanupResult> {
  const cleanup = await removePiSessionCopy(path, workspaceDir, expected);
  if (cleanup.ok) return cleanup;
  if (!cleanup.error.includes("descriptor-bound Pi session cleanup is unavailable")) return cleanup;
  if (expected.rootDev === undefined || expected.rootIno === undefined) {
    return { ok: false, error: "Pi session copy cleanup has no workspace provenance; retained" };
  }
  let root: string;
  try {
    // The native descriptor walker intentionally rejects symlink ancestors;
    // hand it the canonical path that the shared lock admitted (macOS uses
    // /var as a symlink to /private/var).
    root = realpathSync(resolve(workspaceDir));
  } catch {
    return { ok: false, error: "Pi session workspace could not be reopened; retained" };
  }
  const leafPath = join(root, basename(path));
  let rootInfo: BigIntStats;
  let leafInfo: BigIntStats;
  try {
    rootInfo = lstatSync(root, { bigint: true });
    leafInfo = lstatSync(leafPath, { bigint: true });
  } catch {
    return { ok: false, error: "Pi session workspace or leaf could not be proven; retained" };
  }
  if (
    !rootInfo.isDirectory()
    || rootInfo.isSymbolicLink()
    || String(rootInfo.dev) !== expected.rootDev
    || String(rootInfo.ino) !== expected.rootIno
    || (expected.rootBirthtimeNs !== undefined && String(rootInfo.birthtimeNs) !== expected.rootBirthtimeNs)
    || !samePiCopyLeaf(leafInfo, expected)
  ) return { ok: false, error: "Pi session copy cleanup target changed; retained" };
  try {
    await boundPromotionRemoveTree({
      root,
      rootIdentity: { dev: String(rootInfo.dev), ino: String(rootInfo.ino) },
      components: [basename(leafPath)],
      parentIdentity: { dev: String(rootInfo.dev), ino: String(rootInfo.ino) },
      expectedIdentity: { dev: String(leafInfo.dev), ino: String(leafInfo.ino) },
    });
    return { ok: true, removed: true };
  } catch {
    // Native uncertainty is retained evidence; never fall back to pathname rm.
    return { ok: false, error: "native Pi session copy cleanup was not proven; retained" };
  }
}

/**
 * Establish the app-private scratch root through the existing native
 * descriptor owner before the agent-core copy owner opens it. This is the
 * only first-create path: agent-core receives the resulting identity and
 * fails closed if the pathname is replaced before admission.
 */
async function preparePiSessionWorkspace(path: string): Promise<{ dev: string; ino: string; birthtimeNs: string }> {
  const workspace = resolve(path);
  const parent = dirname(workspace);
  const name = basename(workspace);
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error("Pi session workspace has an invalid name");
  }
  let parentInfo: BigIntStats;
  try {
    parentInfo = lstatSync(parent, { bigint: true });
  } catch (error) {
    throw new Error(`Pi session workspace parent could not be opened: ${String(error)}`);
  }
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error("Pi session workspace parent is not a real directory");
  const parentIdentity = await boundPromotionOpenDirectory({
    path: parent,
    expectedIdentity: { dev: String(parentInfo.dev), ino: String(parentInfo.ino) },
  });
  const childIdentity = await boundPromotionCreateDirectory({
    root: parent,
    rootIdentity: parentIdentity,
    components: [name],
    parentIdentity,
  });
  const verifiedParent = await boundPromotionOpenDirectory({
    path: parent,
    expectedIdentity: { dev: parentIdentity.dev, ino: parentIdentity.ino },
  });
  if (verifiedParent.dev !== parentIdentity.dev || verifiedParent.ino !== parentIdentity.ino) {
    throw new Error("Pi session workspace parent changed while it was created");
  }
  let childInfo: BigIntStats;
  try {
    childInfo = lstatSync(workspace, { bigint: true });
  } catch (error) {
    throw new Error(`Pi session workspace could not be reopened: ${String(error)}`);
  }
  if (!childInfo.isDirectory() || childInfo.isSymbolicLink()) throw new Error("Pi session workspace is not a real directory");
  if (String(childInfo.dev) !== childIdentity.dev || String(childInfo.ino) !== childIdentity.ino) {
    throw new Error("Pi session workspace identity changed while it was created");
  }
  const verifiedChild = await boundPromotionOpenDirectory({
    path: workspace,
    expectedIdentity: { dev: childIdentity.dev, ino: childIdentity.ino },
  });
  if (verifiedChild.dev !== childIdentity.dev || verifiedChild.ino !== childIdentity.ino) {
    throw new Error("Pi session workspace identity changed while it was opened");
  }
  return { dev: String(childInfo.dev), ino: String(childInfo.ino), birthtimeNs: String(childInfo.birthtimeNs) };
}

async function forkPiSession(msg: SessionForkRequest, controller: AbortController): Promise<void> {
  const copyPath = join(msg.sessionWorkspaceDir, `fork-${msg.requestId}.jsonl`);
  let copied: PiSessionCopyResult | null = null;
  let branchPath: string | null = null;
  let reply: SessionForkReply | undefined;
  try {
    if (controller.signal.aborted) throw new Error("session fork cancelled");
    const workspaceIdentity = await preparePiSessionWorkspace(msg.sessionWorkspaceDir);
    // Copy the source file first; the branch and fork never touch it. The
    // canonical copy owner admits and pre-allocates the destination before
    // reading any source bytes.
    copied = await copyPiSessionFile(msg.sourceSessionFile, copyPath, {
      workspaceDir: msg.sessionWorkspaceDir,
      expectedWorkspaceIdentity: workspaceIdentity,
      signal: controller.signal,
      ...(msg.sourceSessionIdentity === undefined ? {} : { expectedSourceIdentity: msg.sourceSessionIdentity }),
      ...(msg.sourceSessionIdentity === undefined ? {} : { expectedSourceWorkspaceDir: dirname(msg.sourceSessionFile) }),
      ...(msg.testOnlyMaxBytes === undefined ? {} : { testOnlyMaxBytes: msg.testOnlyMaxBytes }),
      ...(msg.testOnlyMaxCount === undefined ? {} : { testOnlyMaxCount: msg.testOnlyMaxCount }),
      ...(msg.testOnlyMaxWorkBytes === undefined ? {} : { testOnlyMaxWorkBytes: msg.testOnlyMaxWorkBytes }),
    });
    if (!copied.ok) throw new Error(copied.error);
    if (msg.entryId) {
      const opened = SessionManager.open(copied.sessionFile);
      const entry = opened.getEntry(msg.entryId);
      if (!entry) throw new Error(`entry ${msg.entryId} not found in the session branch`);
      // Extract the path root → entry. pi writes the branched file only
      // when the path contains an assistant message; otherwise the file is
      // deferred to the first append. The doc's root-prompt case uses an
      // empty candidate session, so check the file really exists.
      branchPath = opened.createBranchedSession(msg.entryId) ?? null;
    } else {
      // Promotion: fork the whole current leaf of the candidate session.
      branchPath = copied.sessionFile;
    }
    let forked: SessionManager;
    if (branchPath && existsSync(branchPath)) {
      forked = SessionManager.forkFrom(branchPath, msg.candidateRoot, msg.candidateSessionDir);
    } else {
      forked = SessionManager.create(msg.candidateRoot, msg.candidateSessionDir);
    }
    if (msg.relocationNote) {
      forked.appendCustomMessageEntry("termina-relocation", msg.relocationNote, false);
    }
    if (msg.contextText) {
      forked.appendCustomMessageEntry("termina-context", msg.contextText, false);
    }
    if (controller.signal.aborted) throw new Error("session fork cancelled");
    reply = {
      op: "fork-result",
      requestId: msg.requestId,
      ok: true,
      sessionFile: forked.getSessionFile() ?? null,
      entryCount: forked.getEntries().length,
      leafId: forked.getLeafId(),
    };
  } catch (err) {
    reply = {
      op: "fork-result",
      requestId: msg.requestId,
      ok: false,
      error: {
        code: controller.signal.aborted ? "cancelled" : "failed",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  } finally {
    // Only the canonical copy owner returns a durable leaf identity. A
    // SessionManager branched pathname has no descriptor/capability to prove
    // its original inode after creation, so retain that sibling rather than
    // guessing and deleting a replacement. The workspace admission bound
    // makes this fail-closed evidence finite.
    const cleanupPaths = new Set<string>();
    const copiedIdentity = copied?.ok ? copied.identity : null;
    const copiedPath = copied?.ok ? copied.sessionFile : null;
    if (copiedPath) cleanupPaths.add(copiedPath);
    for (const path of cleanupPaths) {
      try {
        if (copiedIdentity) await cleanupPiCopy(path, msg.sessionWorkspaceDir, copiedIdentity);
      } catch {
        // Unproven worker scratch remains bounded retained evidence.
      }
    }
  }
  if (reply) post(reply);
}

async function copyPiSession(msg: PiSessionCopyRequest, controller: AbortController): Promise<void> {
  const destination = msg.destinationSessionFile ?? join(msg.sessionWorkspaceDir, `pi-copy-${msg.requestId}.jsonl`);
  try {
    const workspaceIdentity = await preparePiSessionWorkspace(msg.sessionWorkspaceDir);
    const result = await copyPiSessionFile(msg.sourceSessionFile, destination, {
      workspaceDir: msg.sessionWorkspaceDir,
      expectedWorkspaceIdentity: workspaceIdentity,
      signal: controller.signal,
      ...(msg.testOnlyMaxBytes === undefined ? {} : { testOnlyMaxBytes: msg.testOnlyMaxBytes }),
      ...(msg.testOnlyMaxCount === undefined ? {} : { testOnlyMaxCount: msg.testOnlyMaxCount }),
      ...(msg.testOnlyMaxWorkBytes === undefined ? {} : { testOnlyMaxWorkBytes: msg.testOnlyMaxWorkBytes }),
    });
    if (!result.ok) {
      post({
        op: "copy-pi-result",
        requestId: msg.requestId,
        ok: false,
        error: {
          code: result.commit === "uncertain" ? "uncertain" : controller.signal.aborted ? "cancelled" : "failed",
          message: result.error,
        },
      });
      return;
    }
    post({
      op: "copy-pi-result",
      requestId: msg.requestId,
      ok: true,
      sessionFile: result.sessionFile,
      bytes: result.bytes,
      workBytes: result.workBytes,
      identity: result.identity,
    });
  } catch (err) {
    post({
      op: "copy-pi-result",
      requestId: msg.requestId,
      ok: false,
      error: {
        code: controller.signal.aborted ? "cancelled" : "failed",
        message: err instanceof Error ? err.message : String(err),
      },
    });
  } finally {
    activePiCopies.delete(msg.requestId);
  }
}

/**
 * Reclaim an empty core-session bundle only after the canonical session owner
 * has proved its shape and identities.  The native remover revalidates the
 * project root and bundle leaf immediately before its descriptor-bound
 * quarantine; there is no pathname-recursive fallback here.
 */
async function discardCoreEmptySession(msg: CoreSessionDiscardRequest): Promise<void> {
  const inspected = await inspectEmptySessionBundle(msg.sessionFile);
  if (!inspected.ok) {
    post({
      op: "discard-core-empty-result",
      requestId: msg.requestId,
      ok: false,
      error: { code: "failed", message: inspected.error },
    });
    return;
  }
  if (!inspected.empty) {
    post({ op: "discard-core-empty-result", requestId: msg.requestId, ok: true, removed: false });
    return;
  }
  try {
    const proof = inspected.proof;
    // A terminal can race the initial read-only inspection while it is
    // closing. Re-prove the exact empty shape immediately before handing the
    // identities to native cleanup; any newly written content is retained.
    const rechecked = await inspectEmptySessionBundle(msg.sessionFile);
    if (!rechecked.ok) throw new Error(rechecked.error);
    if (!rechecked.empty) {
      post({ op: "discard-core-empty-result", requestId: msg.requestId, ok: true, removed: false });
      return;
    }
    if (
      rechecked.proof.rootIdentity.dev !== proof.rootIdentity.dev
      || rechecked.proof.rootIdentity.ino !== proof.rootIdentity.ino
      || rechecked.proof.bundleIdentity.dev !== proof.bundleIdentity.dev
      || rechecked.proof.bundleIdentity.ino !== proof.bundleIdentity.ino
    ) throw new Error("core session bundle identity changed; retained");
    const root = realpathSync(resolve(proof.projectDir));
    const rootInfo = lstatSync(root, { bigint: true });
    const bundlePath = join(root, basename(proof.bundleDir));
    const bundleInfo = lstatSync(bundlePath, { bigint: true });
    if (
      rootInfo.isSymbolicLink()
      || !rootInfo.isDirectory()
      || String(rootInfo.dev) !== proof.rootIdentity.dev
      || String(rootInfo.ino) !== proof.rootIdentity.ino
      || String(rootInfo.birthtimeNs) !== proof.rootIdentity.birthtimeNs
      || bundleInfo.isSymbolicLink()
      || !bundleInfo.isDirectory()
      || String(bundleInfo.dev) !== proof.bundleIdentity.dev
      || String(bundleInfo.ino) !== proof.bundleIdentity.ino
    ) {
      throw new Error("core session bundle identity changed; retained");
    }
    await boundPromotionRemoveTree({
      root,
      rootIdentity: { dev: String(rootInfo.dev), ino: String(rootInfo.ino) },
      components: [basename(bundlePath)],
      parentIdentity: { dev: String(rootInfo.dev), ino: String(rootInfo.ino) },
      expectedIdentity: { dev: String(bundleInfo.dev), ino: String(bundleInfo.ino) },
    });
    post({ op: "discard-core-empty-result", requestId: msg.requestId, ok: true, removed: true });
  } catch (err) {
    post({
      op: "discard-core-empty-result",
      requestId: msg.requestId,
      ok: false,
      error: { code: "failed", message: err instanceof Error ? err.message : String(err) },
    });
  }
}

async function forkCoreSession(msg: CoreSessionForkRequest): Promise<void> {
  const controller = new AbortController();
  activeCoreForks.set(msg.requestId, controller);
  try {
    const result = await writeForkedSession(
      msg.sourceSessionFile,
      msg.destinationSessionFile,
      msg.throughSeq,
      {
        signal: controller.signal,
        ...(msg.retentionLease === undefined ? {} : { retentionLease: msg.retentionLease }),
        ...(msg.testOnlyPostRenameDelayMs === undefined
          ? {}
          : { testOnlyPostRenameDelayMs: msg.testOnlyPostRenameDelayMs }),
      },
    );
    if (!result.ok) {
      post({
        op: "fork-core-result",
        requestId: msg.requestId,
        ok: false,
        error: {
          code: result.commit === "uncertain" ? "uncertain" : controller.signal.aborted ? "cancelled" : "failed",
          message: result.error,
        },
      });
      return;
    }
    post({
      op: "fork-core-result",
      requestId: msg.requestId,
      ok: true,
      sessionFile: msg.destinationSessionFile,
      kept: result.kept,
    });
  } catch (err) {
    post({
      op: "fork-core-result",
      requestId: msg.requestId,
      ok: false,
      error: {
        code: controller.signal.aborted ? "cancelled" : "failed",
        message: err instanceof Error ? err.message : String(err),
      },
    });
  } finally {
    activeCoreForks.delete(msg.requestId);
  }
}

let workerQueue: Promise<void> = Promise.resolve();
function enqueueWorkerOp(op: () => Promise<void>): void {
  workerQueue = workerQueue.then(op, op);
}

parentPort?.on("message", (msg: SessionWorkerRequest) => {
  if (msg.op === "shutdown") {
    coreClient.dispose();
    parentPort?.close();
    return;
  }
  if (msg.op === "cancel") {
    activeCoreForks.get(msg.requestId)?.abort();
    activePiForks.get(msg.requestId)?.abort();
    activePiCopies.get(msg.requestId)?.abort();
    return;
  }
  if (msg.op === "fork") {
    const controller = new AbortController();
    activePiForks.set(msg.requestId, controller);
    enqueueWorkerOp(() => forkPiSession(msg, controller).finally(() => activePiForks.delete(msg.requestId)));
    return;
  }
  if (msg.op === "copy-pi") {
    const controller = new AbortController();
    activePiCopies.set(msg.requestId, controller);
    enqueueWorkerOp(() => copyPiSession(msg, controller));
    return;
  }
  if (msg.op === "discard-pi") {
    enqueueWorkerOp(async () => {
      const result = await cleanupPiCopy(msg.sessionFile, msg.sessionWorkspaceDir, msg.identity);
      if (result.ok) {
        post({ op: "discard-pi-result", requestId: msg.requestId, ok: true, removed: result.removed });
      } else {
        post({
          op: "discard-pi-result",
          requestId: msg.requestId,
          ok: false,
          error: { code: "failed", message: result.error },
        });
      }
    });
    return;
  }
  if (msg.op === "discard-core-empty") {
    enqueueWorkerOp(() => discardCoreEmptySession(msg));
    return;
  }
  if (msg.op === "fork-core") {
    enqueueWorkerOp(() => forkCoreSession(msg));
  }
});
