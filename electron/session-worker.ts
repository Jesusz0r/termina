/**
 * Session worker entry (worker_threads).
 *
 * Performs all core session-bundle work off the Electron main thread.
 * Forking a candidate session runs here: materialize the bundle slice into
 * the candidate session directory. Session parsing and durable writes never
 * run on Electron's main thread.
 *
 * Keep session-fork as a type-only import: a runtime import would load the
 * client (and nested Worker) inside this thread.
 */
import { parentPort } from "node:worker_threads";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  inspectEmptySessionBundle,
  writeForkedSession,
} from "../agent-core/session.js";
import {
  isProjectFileInRoot,
  searchSessionFiles,
  type SessionFileEntry,
} from "./session-search.js";
import {
  MAX_EXPORT_FILES,
  buildUnifiedPatch,
  type ExportPatchFile,
} from "./worldlines/export.js";
import {
  boundPromotionRemoveTree,
  disposeWorldlineGitCore,
} from "./worldline-git.js";
import type {
  CoreSessionForkRequest,
  CoreSessionDiscardRequest,
  ExportPatchRequest,
  SessionForkReply,
  SessionSearchRequest,
  SessionWorkerRequest,
} from "./session-fork.js";

function post(msg: SessionForkReply): void {
  parentPort?.postMessage(msg);
}

const activeCoreForks = new Map<string, AbortController>();
/** Live session searches by request id (read-only; run outside the fork queue). */
const activeSearches = new Map<string, AbortController>();

/**
 * Sync mirror of the main-process canonical path (total: resolves existing
 * prefixes, never throws). The admission policy itself stays single-owner in
 * session-search.ts (`isProjectFileInRoot`).
 */
function workerCanonicalize(absPath: string): string {
  let tail = "";
  let cur = absPath;
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail ? join(real, tail) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return absPath;
      tail = tail ? join(basename(cur), tail) : basename(cur);
      cur = parent;
    }
  }
}

function workerIsProjectFile(relPath: string, projectCwd: string): Promise<boolean> {
  return isProjectFileInRoot(relPath, projectCwd, workerCanonicalize, (abs) => {
    try {
      return statSync(abs).isFile();
    } catch {
      return false;
    }
  });
}

/** Search past session files. Read-only, so searches run concurrently. */
async function searchSessions(msg: SessionSearchRequest): Promise<void> {
  const controller = new AbortController();
  activeSearches.set(msg.requestId, controller);
  try {
    const files: SessionFileEntry[] = Array.isArray(msg.files)
      ? msg.files.filter((f): f is SessionFileEntry =>
        !!f && typeof f.path === "string" && typeof f.name === "string" && typeof f.mtimeMs === "number")
      : [];
    const hits = await searchSessionFiles({
      query: typeof msg.query === "string" ? msg.query : "",
      files,
      projectCwd: typeof msg.projectCwd === "string" ? msg.projectCwd : "",
      canonicalize: (absPath) => workerCanonicalize(absPath),
      isProjectFile: (relPath, root) => workerIsProjectFile(relPath, root),
      shouldStop: () => controller.signal.aborted,
    });
    if (controller.signal.aborted) {
      post({
        op: "search-sessions-result",
        requestId: msg.requestId,
        ok: false,
        error: { code: "cancelled", message: "session search cancelled" },
      });
      return;
    }
    post({ op: "search-sessions-result", requestId: msg.requestId, ok: true, hits });
  } catch (err) {
    post({
      op: "search-sessions-result",
      requestId: msg.requestId,
      ok: false,
      error: {
        code: controller.signal.aborted ? "cancelled" : "failed",
        message: err instanceof Error ? err.message : String(err),
      },
    });
  } finally {
    activeSearches.delete(msg.requestId);
  }
}

/** Build an export patch. Pure CPU over caller contents; runs concurrently. */
async function exportPatch(msg: ExportPatchRequest): Promise<void> {
  try {
    const files: ExportPatchFile[] = (Array.isArray(msg.files) ? msg.files : [])
      .filter((f): f is ExportPatchFile =>
        !!f && typeof f.relPath === "string" &&
        (typeof f.before === "string" || f.before === null) &&
        (typeof f.after === "string" || f.after === null))
      .slice(0, MAX_EXPORT_FILES);
    // buildUnifiedPatch stubs oversized/binary files itself; the slice above
    // bounds the file count the builder ever sees.
    post({ op: "export-patch-result", requestId: msg.requestId, ok: true, patch: buildUnifiedPatch(files) });
  } catch (err) {
    post({
      op: "export-patch-result",
      requestId: msg.requestId,
      ok: false,
      error: {
        code: "failed",
        message: err instanceof Error ? err.message : String(err),
      },
    });
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
    disposeWorldlineGitCore();
    parentPort?.close();
    return;
  }
  if (msg.op === "cancel") {
    activeCoreForks.get(msg.requestId)?.abort();
    activeSearches.get(msg.requestId)?.abort();
    return;
  }
  if (msg.op === "discard-core-empty") {
    enqueueWorkerOp(() => discardCoreEmptySession(msg));
    return;
  }
  if (msg.op === "fork-core") {
    enqueueWorkerOp(() => forkCoreSession(msg));
    return;
  }
  if (msg.op === "search-sessions") {
    // Read-only: runs concurrently with forks instead of queueing behind them.
    void searchSessions(msg);
  }
  if (msg.op === "export-patch") {
    // Pure CPU: runs concurrently; no shared worker state to serialize.
    void exportPatch(msg);
  }
});
