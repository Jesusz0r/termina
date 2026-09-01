/**
 * Session-fork client (WORLDLINES §6.7).
 *
 * Request plumbing over the session worker thread. Both Pi SessionManager
 * forks and core session bundle forks stay in session-worker.ts so session
 * parsing, hashing, and durable writes never run on Electron's main thread.
 * Requests are serialized: session files are not concurrent-safe.
 */
import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionRetentionLock } from "../shared/session-retention-lock.js";
import type { PiSessionCopyIdentity } from "../agent-core/session.js";
export type { PiSessionCopyIdentity } from "../agent-core/session.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export interface SessionForkOpts {
  sourceSessionFile: string;
  /** Identity published with a finalized Pi branch; required for replay. */
  sourceSessionIdentity?: PiSessionCopyIdentity;
  /** The entry to branch at. Null forks the whole leaf (promotion). */
  entryId: string | null;
  sessionWorkspaceDir: string;
  candidateRoot: string;
  candidateSessionDir: string;
  relocationNote?: string;
  contextText?: string;
  /** Focused smaller bound for Pi copy admission tests. */
  testOnlyMaxBytes?: number;
  testOnlyMaxCount?: number;
  testOnlyMaxWorkBytes?: number;
}

export interface SessionForkResult {
  ok: boolean;
  sessionFile: string | null;
  entryCount: number;
  leafId: string | null;
}

export interface CoreSessionForkOpts {
  sourceSessionFile: string;
  destinationSessionFile: string;
  throughSeq?: number;
  /** Focused worker test seam; rejected by the session owner outside test mode. */
  testOnlyPostRenameDelayMs?: number;
  /** Lease held by SessionRetentionOwner while the worker materializes the bundle. */
  retentionLease?: SessionRetentionLock;
}

export interface PiSessionCopyOpts {
  sourceSessionFile: string;
  sessionWorkspaceDir: string;
  /** Optional direct child destination; the worker generates a unique one by default. */
  destinationSessionFile?: string;
  /** Focused smaller bounds; unavailable outside TERMINA_CORE_TEST. */
  testOnlyMaxBytes?: number;
  testOnlyMaxCount?: number;
  testOnlyMaxWorkBytes?: number;
}

export interface PiSessionDiscardOpts {
  sessionFile: string;
  sessionWorkspaceDir: string;
  identity: PiSessionCopyIdentity;
}

export interface CoreSessionDiscardOpts {
  sessionFile: string;
}

export type PiSessionCopyResult =
  | { ok: true; sessionFile: string; bytes: number; workBytes: number; identity: PiSessionCopyIdentity }
  | { ok: false; error: string; path?: string; commit?: "uncertain" };

export type CoreSessionForkResult =
  | { ok: true; sessionFile: string; kept: number }
  | { ok: false; sessionFile: string; commit: "uncertain"; error: string };

export type PiSessionDiscardResult =
  | { ok: true; removed: boolean }
  | { ok: false; error: string };

export type CoreSessionDiscardResult =
  | { ok: true; removed: boolean }
  | { ok: false; error: string };

export interface SessionForkRequest extends SessionForkOpts {
  op: "fork";
  requestId: string;
}

export interface CoreSessionForkRequest extends CoreSessionForkOpts {
  op: "fork-core";
  requestId: string;
}

export interface PiSessionCopyRequest extends PiSessionCopyOpts {
  op: "copy-pi";
  requestId: string;
}

export interface PiSessionDiscardRequest extends PiSessionDiscardOpts {
  op: "discard-pi";
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

export type SessionWorkerRequest = SessionForkRequest | CoreSessionForkRequest | PiSessionCopyRequest | PiSessionDiscardRequest | CoreSessionDiscardRequest | SessionForkCancelRequest | SessionWorkerShutdownRequest;

export type SessionForkFailure = {
  requestId: string;
  ok: false;
  error: { code: "failed" | "cancelled" | "uncertain"; message: string };
};

export type SessionForkReply =
  | (SessionForkResult & { op: "fork-result"; requestId: string; ok: true })
  | (SessionForkFailure & { op: "fork-result" })
  | { op: "fork-core-result"; requestId: string; ok: true; sessionFile: string; kept: number }
  | (SessionForkFailure & { op: "fork-core-result" })
  | { op: "copy-pi-result"; requestId: string; ok: true; sessionFile: string; bytes: number; workBytes: number; identity: PiSessionCopyIdentity }
  | (SessionForkFailure & { op: "copy-pi-result" })
  | { op: "discard-pi-result"; requestId: string; ok: true; removed: boolean }
  | (SessionForkFailure & { op: "discard-pi-result" })
  | { op: "discard-core-empty-result"; requestId: string; ok: true; removed: boolean }
  | (SessionForkFailure & { op: "discard-core-empty-result" });

export type SessionForkCallOptions = {
  signal?: AbortSignal;
};

type PendingRequest = {
  kind: "fork" | "fork-core" | "copy-pi" | "discard-pi" | "discard-core-empty";
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
  private seq = 0;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  private idleWaiters = new Set<() => void>();

  /** Fork a Pi candidate session: branch at the entry, fork into the dir. */
  fork(opts: SessionForkOpts, callOptions?: SessionForkCallOptions): Promise<SessionForkResult> {
    return this.enqueue(() => {
      if (callOptions?.signal?.aborted) throw abortError();
      return this.dispatchPi(opts, callOptions?.signal);
    });
  }

  /** Fork a segmented agent-core bundle entirely inside the session worker. */
  forkCore(opts: CoreSessionForkOpts, callOptions?: SessionForkCallOptions): Promise<CoreSessionForkResult> {
    return this.enqueue(() => {
      if (callOptions?.signal?.aborted) throw abortError();
      return this.dispatchCore(opts, callOptions?.signal);
    });
  }

  /** Copy a settled Pi session through the bounded worker admission boundary. */
  copyPi(opts: PiSessionCopyOpts, callOptions?: SessionForkCallOptions): Promise<PiSessionCopyResult> {
    return this.enqueue(() => {
      if (callOptions?.signal?.aborted) throw abortError();
      return this.dispatchCopyPi(opts, callOptions?.signal);
    });
  }

  /** Discard one finalized Pi branch through the identity-bound worker owner. */
  discardPi(opts: PiSessionDiscardOpts): Promise<PiSessionDiscardResult> {
    return this.enqueue(() => this.dispatchDiscardPi(opts));
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
    const run = this.queue.then(() => {
      if (this.disposed) throw new Error("session worker disposed");
      return operation();
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private dispatchPi(payload: SessionForkOpts, signal?: AbortSignal): Promise<SessionForkResult> {
    return new Promise((resolve, reject) => {
      const requestId = `fork-${++this.seq}`;
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
      this.pending.set(requestId, {
        kind: "fork",
        resolve: (value) => resolve(value as SessionForkResult),
        reject,
        ...(signal ? { removeAbortListener: () => signal.removeEventListener("abort", cancel) } : {}),
      });
      if (signal) signal.addEventListener("abort", cancel, { once: true });
      try {
        const msg: SessionForkRequest = { ...payload, op: "fork", requestId };
        worker.postMessage(msg);
        if (signal?.aborted) cancel();
      } catch (err) {
        this.takePending(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
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

  private dispatchCopyPi(payload: PiSessionCopyOpts, signal?: AbortSignal): Promise<PiSessionCopyResult> {
    return new Promise((resolve, reject) => {
      const requestId = `copy-pi-${++this.seq}`;
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
        kind: "copy-pi",
        resolve: (value) => resolve(value as PiSessionCopyResult),
        reject,
        ...(payload.destinationSessionFile ? { destinationSessionFile: payload.destinationSessionFile } : {}),
        ...(signal ? { removeAbortListener: () => signal.removeEventListener("abort", cancel) } : {}),
      };
      this.pending.set(requestId, pending);
      if (signal) signal.addEventListener("abort", cancel, { once: true });
      try {
        const msg: PiSessionCopyRequest = { ...payload, op: "copy-pi", requestId };
        worker.postMessage(msg);
        if (signal?.aborted) cancel();
      } catch (err) {
        this.takePending(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private dispatchDiscardPi(payload: PiSessionDiscardOpts): Promise<PiSessionDiscardResult> {
    return new Promise((resolve, reject) => {
      const requestId = `discard-pi-${++this.seq}`;
      const worker = this.ensure();
      this.pending.set(requestId, {
        kind: "discard-pi",
        resolve: (value) => resolve(value as PiSessionDiscardResult),
        reject,
      });
      try {
        const msg: PiSessionDiscardRequest = { ...payload, op: "discard-pi", requestId };
        worker.postMessage(msg);
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
        (pending.kind === "fork" && msg.op === "fork-result") ||
        (pending.kind === "fork-core" && msg.op === "fork-core-result") ||
        (pending.kind === "copy-pi" && msg.op === "copy-pi-result") ||
        (pending.kind === "discard-pi" && msg.op === "discard-pi-result") ||
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
      else if (pending.kind === "discard-pi" || pending.kind === "discard-core-empty") pending.resolve({ ok: false, error: msg.error.message });
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
      } else if (pending.kind === "discard-pi" || pending.kind === "discard-core-empty") {
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
