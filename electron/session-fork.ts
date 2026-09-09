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

export interface SessionForkCancelRequest {
  op: "cancel";
  requestId: string;
}

export interface SessionWorkerShutdownRequest {
  op: "shutdown";
}

export type SessionWorkerRequest = CoreSessionForkRequest | CoreSessionDiscardRequest | SessionForkCancelRequest | SessionWorkerShutdownRequest;

export type SessionForkFailure = {
  requestId: string;
  ok: false;
  error: { code: "failed" | "cancelled" | "uncertain"; message: string };
};

export type SessionForkReply =
  | { op: "fork-core-result"; requestId: string; ok: true; sessionFile: string; kept: number }
  | (SessionForkFailure & { op: "fork-core-result" })
  | { op: "discard-core-empty-result"; requestId: string; ok: true; removed: boolean }
  | (SessionForkFailure & { op: "discard-core-empty-result" });

export type SessionForkCallOptions = {
  signal?: AbortSignal;
};

type PendingRequest = {
  kind: "fork-core" | "discard-core-empty";
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
        (pending.kind === "discard-core-empty" && msg.op === "discard-core-empty-result");
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
