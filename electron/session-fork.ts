/**
 * Session-fork client (WORLDLINES §6.7).
 *
 * Request plumbing over the session worker thread. Core session bundle
 * forks stay in session-worker.ts so session parsing, hashing, and durable
 * writes never run on Electron's main thread. Requests are serialized:
 * session files are not concurrent-safe.
 */
import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionRetentionLock } from "../shared/session-retention-lock.js";
import type { SessionHit } from "../shared/types.js";
import type { ExportPatchFile } from "./worldlines/export.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
/** Bound retained operations so a slow worker cannot retain an unbounded chain of closures. */
const SESSION_WORKER_QUEUE_HIGH_WATER = 128;

export interface CoreSessionForkOpts {
  sourceSessionFile: string;
  destinationSessionFile: string;
  throughSeq?: number;
  /** Focused worker test seam; rejected by the session owner outside test mode. */
  testOnlyPostRenameDelayMs?: number;
  /** Lease held by SessionRetentionOwner while the worker materializes the bundle. */
  retentionLease?: SessionRetentionLock;
}

export interface CoreSessionDiscardOpts {
  sessionFile: string;
}

/** One session-search file entry (mirrors SessionFileEntry in session-search.ts). */
export interface SessionSearchFile {
  path: string;
  name: string;
  mtimeMs: number;
  segments?: string[];
}

export interface SessionSearchOpts {
  query: string;
  files: SessionSearchFile[];
  projectCwd: string;
}

export type SessionSearchResult =
  | { ok: true; hits: SessionHit[] }
  | { ok: false; error: string };

export interface ExportPatchOpts {
  files: ExportPatchFile[];
}

export type ExportPatchResult =
  | { ok: true; patch: string }
  | { ok: false; error: string };

export type CoreSessionForkResult =
  | { ok: true; sessionFile: string; kept: number }
  | { ok: false; sessionFile: string; commit: "uncertain"; error: string };

export type CoreSessionDiscardResult =
  | { ok: true; removed: boolean }
  | { ok: false; error: string };

export interface CoreSessionForkRequest extends CoreSessionForkOpts {
  op: "fork-core";
  requestId: string;
}

export interface CoreSessionDiscardRequest extends CoreSessionDiscardOpts {
  op: "discard-core-empty";
  requestId: string;
}

export interface SessionSearchRequest extends SessionSearchOpts {
  op: "search-sessions";
  requestId: string;
}

export interface ExportPatchRequest extends ExportPatchOpts {
  op: "export-patch";
  requestId: string;
}

export interface SessionForkCancelRequest {
  op: "cancel";
  requestId: string;
}

export interface SessionWorkerShutdownRequest {
  op: "shutdown";
}

export type SessionWorkerRequest = CoreSessionForkRequest | CoreSessionDiscardRequest | SessionSearchRequest | ExportPatchRequest | SessionForkCancelRequest | SessionWorkerShutdownRequest;

export type SessionForkFailure = {
  requestId: string;
  ok: false;
  error: { code: "failed" | "cancelled" | "uncertain"; message: string };
};

export type SessionForkReply =
  | { op: "fork-core-result"; requestId: string; ok: true; sessionFile: string; kept: number }
  | (SessionForkFailure & { op: "fork-core-result" })
  | { op: "discard-core-empty-result"; requestId: string; ok: true; removed: boolean }
  | (SessionForkFailure & { op: "discard-core-empty-result" })
  | { op: "search-sessions-result"; requestId: string; ok: true; hits: SessionHit[] }
  | (SessionForkFailure & { op: "search-sessions-result" })
  | { op: "export-patch-result"; requestId: string; ok: true; patch: string }
  | (SessionForkFailure & { op: "export-patch-result" });

export type SessionForkCallOptions = {
  signal?: AbortSignal;
};

type PendingRequest = {
  kind: "fork-core" | "discard-core-empty" | "search-sessions" | "export-patch";
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  removeAbortListener?: () => void;
  destinationSessionFile?: string;
};

function abortError(message = "session fork cancelled"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export class SessionForkClient {
  private worker: Worker | null = null;
  private pending = new Map<string, PendingRequest>();
  private queue: Promise<void> = Promise.resolve();
  private queuedOperations = 0;
  private seq = 0;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  private idleWaiters = new Set<() => void>();

  /** Fork a segmented agent-core bundle entirely inside the session worker. */
  forkCore(opts: CoreSessionForkOpts, callOptions?: SessionForkCallOptions): Promise<CoreSessionForkResult> {
    return this.enqueue(() => {
      if (callOptions?.signal?.aborted) throw abortError();
      return this.dispatchCore(opts, callOptions?.signal);
    });
  }

  /** Reclaim an empty core-session bundle through native bound cleanup. */
  discardEmptyCoreSession(sessionFile: string): Promise<CoreSessionDiscardResult> {
    return this.enqueue(() => this.dispatchDiscardCore({ sessionFile }));
  }

  /**
   * Search past session files off the main thread. Bypasses the client queue
   * so keystroke searches stay responsive behind long forks; the worker runs
   * searches concurrently (read-only) with its own abort map. Stale results
   * are dropped by the caller's seq fence.
   */
  searchSessions(opts: SessionSearchOpts, callOptions?: SessionForkCallOptions): Promise<SessionSearchResult> {
    if (this.disposed) return Promise.reject(new Error("session worker disposed"));
    if (callOptions?.signal?.aborted) return Promise.reject(abortError());
    return this.dispatchSearch(opts, callOptions?.signal);
  }

  /**
   * Build an export patch off the main thread. Pure CPU over
   * caller-supplied contents; runs concurrently like search (no shared
   * worker state). Exports are explicit user actions, so no abort lane.
   */
  exportPatch(opts: ExportPatchOpts): Promise<ExportPatchResult> {
    if (this.disposed) return Promise.reject(new Error("session worker disposed"));
    return this.dispatchExportPatch(opts);
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = this.disposeWorker();
    return this.disposePromise;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("session worker disposed"));
    if (this.queuedOperations >= SESSION_WORKER_QUEUE_HIGH_WATER) {
      return Promise.reject(new Error("session worker queue is at its high-water mark; retry after pending work drains"));
    }
    this.queuedOperations += 1;
    const run = this.queue.then(() => {
      if (this.disposed) throw new Error("session worker disposed");
      return operation();
    });
    const settled = run.finally(() => {
      this.queuedOperations -= 1;
    });
    this.queue = settled.then(
      () => undefined,
      () => undefined,
    );
    return settled;
  }

  private dispatchCore(payload: CoreSessionForkOpts, signal?: AbortSignal): Promise<CoreSessionForkResult> {
    return new Promise((resolve, reject) => {
      const requestId = `fork-core-${++this.seq}`;
      const worker = this.ensure();
      const cancel = (): void => {
        if (!this.pending.has(requestId) || this.worker !== worker) return;
        const msg: SessionForkCancelRequest = { op: "cancel", requestId };
        try {
          worker.postMessage(msg);
        } catch {
          // A worker failure/exit rejects the same pending request.
        }
      };
      const pending: PendingRequest = {
        kind: "fork-core",
        resolve: (value) => resolve(value as CoreSessionForkResult),
        reject,
        destinationSessionFile: payload.destinationSessionFile,
        ...(signal ? { removeAbortListener: () => signal.removeEventListener("abort", cancel) } : {}),
      };
      this.pending.set(requestId, pending);
      if (signal) signal.addEventListener("abort", cancel, { once: true });
      try {
        const msg: CoreSessionForkRequest = { ...payload, op: "fork-core", requestId };
        worker.postMessage(msg);
        if (signal?.aborted) cancel();
      } catch (err) {
        this.takePending(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private dispatchDiscardCore(payload: CoreSessionDiscardOpts): Promise<CoreSessionDiscardResult> {
    return new Promise((resolve, reject) => {
      const requestId = `discard-core-empty-${++this.seq}`;
      const worker = this.ensure();
      this.pending.set(requestId, {
        kind: "discard-core-empty",
        resolve: (value) => resolve(value as CoreSessionDiscardResult),
        reject,
      });
      try {
        const msg: CoreSessionDiscardRequest = { ...payload, op: "discard-core-empty", requestId };
        worker.postMessage(msg);
      } catch (err) {
        this.takePending(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private dispatchSearch(payload: SessionSearchOpts, signal?: AbortSignal): Promise<SessionSearchResult> {
    return new Promise((resolve, reject) => {
      const requestId = `search-sessions-${++this.seq}`;
      const worker = this.ensure();
      const cancel = (): void => {
        if (!this.pending.has(requestId) || this.worker !== worker) return;
        const msg: SessionForkCancelRequest = { op: "cancel", requestId };
        try {
          worker.postMessage(msg);
        } catch {
          // A worker failure/exit rejects the same pending request.
        }
      };
      const pending: PendingRequest = {
        kind: "search-sessions",
        resolve: (value) => resolve(value as SessionSearchResult),
        reject,
        ...(signal ? { removeAbortListener: () => signal.removeEventListener("abort", cancel) } : {}),
      };
      this.pending.set(requestId, pending);
      if (signal) signal.addEventListener("abort", cancel, { once: true });
      try {
        const msg: SessionSearchRequest = { ...payload, op: "search-sessions", requestId };
        worker.postMessage(msg);
        if (signal?.aborted) cancel();
      } catch (err) {
        this.takePending(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private dispatchExportPatch(payload: ExportPatchOpts): Promise<ExportPatchResult> {
    return new Promise((resolve, reject) => {
      const requestId = `export-patch-${++this.seq}`;
      const worker = this.ensure();
      this.pending.set(requestId, {
        kind: "export-patch",
        resolve: (value) => resolve(value as ExportPatchResult),
        reject,
      });
      try {
        const msg: ExportPatchRequest = { ...payload, op: "export-patch", requestId };
        worker.postMessage(msg);
      } catch (err) {
        this.takePending(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private ensure(): Worker {
    if (this.disposed) throw new Error("session worker disposed");
    if (this.worker) return this.worker;
    const worker = new Worker(join(__dirname, "session-worker.mjs"));
    this.worker = worker;
    worker.on("message", (msg: SessionForkReply) => {
      if (this.worker !== worker || !msg?.requestId) return;
      const pending = this.pending.get(msg.requestId);
      if (!pending) return;
      const matches =
        (pending.kind === "fork-core" && msg.op === "fork-core-result") ||
        (pending.kind === "discard-core-empty" && msg.op === "discard-core-empty-result") ||
        (pending.kind === "search-sessions" && msg.op === "search-sessions-result") ||
        (pending.kind === "export-patch" && msg.op === "export-patch-result");
      if (!matches) return;
      this.takePending(msg.requestId);
      if (msg.ok) pending.resolve(msg);
      else if (msg.error.code === "uncertain" && pending.kind === "fork-core" && pending.destinationSessionFile) {
        pending.resolve({
          ok: false,
          sessionFile: pending.destinationSessionFile,
          commit: "uncertain",
          error: msg.error.message,
        } satisfies CoreSessionForkResult);
      } else if (msg.error.code === "cancelled") pending.reject(abortError(msg.error.message));
      else if (pending.kind === "discard-core-empty") pending.resolve({ ok: false, error: msg.error.message });
      else pending.reject(new Error(msg.error.message));
    });
    const fail = (error: Error): void => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.reconcilePending(error);
    };
    worker.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
    worker.on("exit", (code) => {
      if (this.worker !== worker) return;
      if (this.pending.size === 0) {
        this.worker = null;
        return;
      }
      fail(new Error(`session worker exited (${code ?? "unknown"})`));
    });
    return worker;
  }

  private takePending(requestId: string): PendingRequest | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;
    this.pending.delete(requestId);
    pending.removeAbortListener?.();
    if (this.pending.size === 0) {
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    }
    return pending;
  }

  private reconcilePending(error: Error): void {
    for (const requestId of [...this.pending.keys()]) {
      const pending = this.takePending(requestId);
      if (!pending) continue;
      if (pending.kind === "fork-core" && pending.destinationSessionFile && existsSync(pending.destinationSessionFile)) {
        pending.resolve({
          ok: false,
          sessionFile: pending.destinationSessionFile,
          commit: "uncertain",
          error: `${error.message}; worker ended after the destination appeared`,
        } satisfies CoreSessionForkResult);
      } else if (pending.kind === "discard-core-empty") {
        pending.resolve({ ok: false, error: `${error.message}; cleanup was not proven and was retained` });
      } else if (pending.kind === "search-sessions") {
        pending.reject(new Error(`${error.message}; session search was not completed`));
      } else if (pending.kind === "export-patch") {
        pending.reject(new Error(`${error.message}; export patch was not completed`));
      } else {
        pending.reject(error);
      }
    }
  }

  private async disposeWorker(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    for (const [requestId] of this.pending) {
      try {
        const cancel: SessionForkCancelRequest = { op: "cancel", requestId };
        worker.postMessage(cancel);
      } catch {
        /* worker exit reconciliation below owns the terminal result */
      }
    }
    if (this.pending.size > 0) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.idleWaiters.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, 2_000);
        this.idleWaiters.add(finish);
        if (this.pending.size === 0) finish();
      });
    }
    // Give the worker a chance to dispose the native core client it may have
    // loaded for macOS/Windows bound scratch cleanup. Terminate only if the
    // explicit shutdown cannot complete promptly.
    const exited = new Promise<void>((resolve) => {
      worker.once("exit", () => resolve());
    });
    try {
      worker.postMessage({ op: "shutdown" } satisfies SessionWorkerShutdownRequest);
    } catch {
      /* termination below owns an already-dead worker */
    }
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 250))]);
    if (this.worker === worker) this.worker = null;
    await worker.terminate().catch(() => undefined);
    if (this.pending.size > 0) this.reconcilePending(new Error("session worker disposed before cleanup completed"));
  }
}
