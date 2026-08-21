/**
 * Session-fork client (WORLDLINES §6.7).
 *
 * Request plumbing over the session worker thread. SessionManager work
 * stays in session-worker.ts so the pi package never loads on the main
 * thread. Requests are serialized: session files are not concurrent-safe.
 */
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export interface SessionForkOpts {
  sourceSessionFile: string;
  /** The entry to branch at. Null forks the whole leaf (promotion). */
  entryId: string | null;
  sessionWorkspaceDir: string;
  candidateRoot: string;
  candidateSessionDir: string;
  relocationNote?: string;
  contextText?: string;
}

export interface SessionForkResult {
  ok: boolean;
  sessionFile: string | null;
  entryCount: number;
  leafId: string | null;
}

export interface SessionForkRequest extends SessionForkOpts {
  op: "fork";
  requestId: string;
}

export type SessionForkReply =
  | (SessionForkResult & { op: "fork-result"; requestId: string; ok: true })
  | { op: "fork-result"; requestId: string; ok: false; error: string };

export class SessionForkClient {
  private worker: Worker | null = null;
  private pending = new Map<string, { resolve: (v: SessionForkResult) => void; reject: (e: Error) => void }>();
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;

  /** Fork a candidate session: branch at the entry, fork into the dir. */
  fork(opts: SessionForkOpts): Promise<SessionForkResult> {
    const run = this.queue.then(() => this.dispatch(opts));
    this.queue = run.catch(() => undefined);
    return run;
  }

  dispose(): void {
    this.failPending(new Error("session worker disposed"));
    this.worker?.terminate();
    this.worker = null;
  }

  private dispatch(payload: SessionForkOpts): Promise<SessionForkResult> {
    return new Promise((resolve, reject) => {
      const requestId = `fork-${++this.seq}`;
      this.pending.set(requestId, { resolve, reject });
      try {
        const msg: SessionForkRequest = { ...payload, op: "fork", requestId };
        this.ensure().postMessage(msg);
      } catch (err) {
        this.pending.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private ensure(): Worker {
    if (this.worker) return this.worker;
    this.worker = new Worker(join(__dirname, "session-worker.mjs"));
    this.worker.on("message", (msg: SessionForkReply) => {
      if (msg.op !== "fork-result" || !msg.requestId) return;
      const p = this.pending.get(msg.requestId);
      if (!p) return;
      this.pending.delete(msg.requestId);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(msg.error ?? "session fork failed"));
    });
    const fail = (err: Error): void => {
      this.failPending(err);
      this.worker = null;
    };
    this.worker.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
    this.worker.on("exit", (code) => {
      if (this.pending.size === 0) {
        this.worker = null;
        return;
      }
      fail(new Error(`session worker exited (${code ?? "unknown"})`));
    });
    return this.worker;
  }

  private failPending(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
