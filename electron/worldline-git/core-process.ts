/**
 * The Rust snapshot core client.
 *
 * Spawns the termina-core binary and speaks the JSON-lines protocol over
 * stdio. Every app-owned Git operation runs in that process, never on the
 * Electron main thread. Requests are serialized: the store writes one
 * capture at a time. A failed op does not block later ops.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/** A hung core op times out and the core respawns on the next request. */
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Admission limits cover requests waiting behind the one serialized native
 * operation.  The in-flight limit is explicit even though the current core
 * protocol is intentionally single-flight: response ids must never be
 * ambiguous and a bounded queue must fail closed rather than grow forever.
 */
export const CORE_REQUEST_QUEUE_HIGH_WATER_ITEMS = 64;
const CORE_REQUEST_QUEUE_HIGH_WATER_BYTES = 32 * 1024 * 1024;
const CORE_REQUEST_IN_FLIGHT_HIGH_WATER = 1;

/** Retain only enough core stderr for a useful failure diagnostic. */
const STDERR_TAIL_BYTES = 8 * 1024;

/** The binary path: env override, the packaged resources, the bundle
 *  dir, then the repo targets. */
function resolveCoreBin(): string {
  const override = process.env.TERMINA_CORE_BIN;
  if (override) return override;
  const resources = typeof process.resourcesPath === "string" ? process.resourcesPath : null;
  const candidates = [
    ...(resources ? [join(resources, "termina-core")] : []),
    join(__dirname, "termina-core"),
    join(process.cwd(), "core", "target", "release", "termina-core"),
    join(process.cwd(), "core", "target", "debug", "termina-core"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

type CoreProcess = {
  child: ReturnType<typeof spawn>;
  buffer: string;
  stderrTail: Buffer;
};

type PendingRequest = {
  process: CoreProcess;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

type QueuedRequest = {
  requestId: string;
  encoded: string;
  bytes: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export interface CoreRequestQueueStats {
  /** All retained requests, including the one sent to core. */
  items: number;
  bytes: number;
  inFlight: number;
  inFlightBytes: number;
}

function appendStderrTail(tail: Buffer, chunk: Buffer): Buffer {
  if (chunk.length >= STDERR_TAIL_BYTES) return Buffer.from(chunk.subarray(chunk.length - STDERR_TAIL_BYTES));
  const prefix = tail.subarray(Math.max(0, tail.length - (STDERR_TAIL_BYTES - chunk.length)));
  return Buffer.concat([prefix, chunk]);
}

export class CoreClient {
  private process: CoreProcess | null = null;
  private pending = new Map<string, PendingRequest>();
  private queue: QueuedRequest[] = [];
  private queuedBytes = 0;
  private inFlight = 0;
  private inFlightBytes = 0;
  private seq = 0;
  private disposed = false;

  private withProcessStderr(err: Error, process: CoreProcess): Error {
    const tail = process.stderrTail.toString("utf8").trim();
    return tail ? new Error(`${err.message}\ncore stderr (tail): ${tail}`) : err;
  }

  private ensure(): CoreProcess {
    if (this.process) return this.process;
    const child = spawn(resolveCoreBin(), [], { stdio: ["pipe", "pipe", "pipe"] });
    const process: CoreProcess = { child, buffer: "", stderrTail: Buffer.alloc(0) };
    this.process = process;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (this.process !== process) return;
      process.buffer += chunk;
      // A runaway core must not grow the buffer without bound.
      if (process.buffer.length > 64 * 1024 * 1024) {
        child.kill();
        return;
      }
      let nl = process.buffer.indexOf("\n");
      while (nl !== -1) {
        const line = process.buffer.slice(0, nl);
        process.buffer = process.buffer.slice(nl + 1);
        if (line.trim()) {
          try {
            this.handleMessage(process, JSON.parse(line));
          } catch {
            /* malformed line — skip */
          }
        }
        nl = process.buffer.indexOf("\n");
      }
    });
    const failAll = (err: Error) => {
      if (this.process !== process) return;
      const diagnostic = this.withProcessStderr(err, process);
      for (const [requestId, pending] of this.pending) {
        if (pending.process !== process) continue;
        this.pending.delete(requestId);
        pending.reject(diagnostic);
      }
      process.buffer = "";
      process.stderrTail = Buffer.alloc(0);
      this.process = null;
    };
    child.on("error", failAll);
    child.on("exit", () => failAll(new Error("snapshot core exited")));
    // A killed core makes in-flight writes fail with an async EPIPE. Without
    // listeners those become uncaught exceptions; the exit handler above
    // already rejects every pending request.
    const ignoreStreamError = () => {
      if (this.process !== process) return;
    };
    child.stdin?.on("error", ignoreStreamError);
    child.stdout?.on("error", ignoreStreamError);
    child.stderr?.on("error", ignoreStreamError);
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (this.process !== process) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      process.stderrTail = appendStderrTail(process.stderrTail, bytes);
    });
    return process;
  }

  /** The core answers every op with <op>-result. */
  private handleMessage(process: CoreProcess, msg: { op?: string; requestId?: string; ok?: boolean; error?: string; state?: unknown }): void {
    // A core-side parse failure replies without a request id. The queue
    // holds one request at a time: fail it.
    if (msg.op === "error" && !msg.requestId) {
      const first = [...this.pending.entries()].find(([, pending]) => pending.process === process);
      if (first) {
        this.pending.delete(first[0]);
        first[1].reject(this.withProcessStderr(new Error(msg.error ?? "snapshot core could not parse the request"), process));
      }
      return;
    }
    if (!msg.requestId) return;
    const pending = this.pending.get(msg.requestId);
    if (!pending || pending.process !== process) return;
    this.pending.delete(msg.requestId);
    if (msg.ok) pending.resolve(msg.state ?? msg);
    else pending.reject(new Error(msg.error ?? "snapshot core op failed"));
  }

  /**
   * Admit one request without creating an unbounded Promise chain.  All core
   * operations are authoritative, so a full queue rejects rather than
   * coalescing or dropping a request.
   */
  request(payload: Record<string, unknown>): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("snapshot core is disposed"));
    const requestId = `cap-${++this.seq}`;
    let encoded: string;
    try {
      // Include the id before admission so the exact wire payload is retained
      // and written once.  The queue byte bound therefore covers the payload
      // that the core actually receives, rather than a pre-id estimate.
      encoded = JSON.stringify({ ...payload, requestId });
    } catch (error) {
      return Promise.reject(new Error(`snapshot core request payload is not serializable: ${error instanceof Error ? error.message : String(error)}`));
    }
    if (typeof encoded !== "string") return Promise.reject(new Error("snapshot core request payload is not serializable"));
    const bytes = Buffer.byteLength(encoded, "utf8") + 128;
    if (!Number.isSafeInteger(bytes) || bytes > CORE_REQUEST_QUEUE_HIGH_WATER_BYTES) {
      return Promise.reject(new Error("snapshot core request exceeds the queue byte high-water mark"));
    }
    if (
      this.queue.length + this.inFlight >= CORE_REQUEST_QUEUE_HIGH_WATER_ITEMS
      || this.queuedBytes + this.inFlightBytes + bytes > CORE_REQUEST_QUEUE_HIGH_WATER_BYTES
    ) {
      return Promise.reject(new Error("snapshot core request queue is at its high-water mark; retry after pending work drains"));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ requestId, encoded, bytes, resolve, reject });
      this.queuedBytes += bytes;
      this.pump();
    });
  }

  queueStats(): CoreRequestQueueStats {
    return {
      items: this.queue.length + this.inFlight,
      bytes: this.queuedBytes + this.inFlightBytes,
      inFlight: this.inFlight,
      inFlightBytes: this.inFlightBytes,
    };
  }

  private pump(): void {
    while (!this.disposed && this.inFlight < CORE_REQUEST_IN_FLIGHT_HIGH_WATER && this.queue.length > 0) {
      const request = this.queue.shift()!;
      this.queuedBytes -= request.bytes;
      this.inFlight++;
      this.inFlightBytes += request.bytes;
      void this.dispatch(request).then(request.resolve, request.reject).finally(() => {
        this.inFlight--;
        this.inFlightBytes -= request.bytes;
        this.pump();
      });
    }
  }

  private dispatch(request: QueuedRequest): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("snapshot core is disposed"));
    return new Promise((resolve, reject) => {
      const process = this.ensure();
      const { requestId } = request;
      // A hung core must not stall the queue forever. Kill it on timeout:
      // the exit handler rejects pending requests and the next op respawns.
      const timer = setTimeout(() => {
        if (!this.pending.delete(requestId)) return;
        process.buffer = "";
        process.child.kill();
        reject(this.withProcessStderr(new Error("snapshot core request timed out"), process));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, {
        process,
        resolve: (v: unknown) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        // The payload carries its own op (capture, template, apply-state).
        process.child.stdin?.write(`${request.encoded}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** The trust-sensitive resource hashes, off the main thread (section 6.7). */
  trustHashes(agentDir: string, projectRoot: string | null): Promise<Record<string, string>> {
    return this.request({ op: "trust-hashes", agentDir, projectRoot }) as Promise<Record<string, string>>;
  }

  /** The tracked file paths of a source repository. */
  lsTracked(root: string): Promise<string[]> {
    return this.request({ op: "ls-tracked", root }) as Promise<string[]>;
  }

  /** The ignored untracked files of a candidate repo. */
  lsIgnored(root: string): Promise<string[]> {
    return this.request({ op: "ls-ignored", root }) as Promise<string[]>;
  }

  /** The working-directory changes of a candidate repo (staged, unstaged, untracked). */
  repoStatus(root: string): Promise<Array<{ relPath: string; status: "created" | "modified" | "deleted" }>> {
    return this.request({ op: "repo-status", root }).then((res) => (res as { changes: Array<{ relPath: string; status: "created" | "modified" | "deleted" }> }).changes);
  }

  /** The committed changes between two refs of a candidate repo. */
  repoDiff(root: string, from: string, to: string): Promise<Array<{ relPath: string; status: "created" | "modified" | "deleted" }>> {
    return this.request({ op: "repo-diff", root, from, to }).then((res) => (res as { changes: Array<{ relPath: string; status: "created" | "modified" | "deleted" }> }).changes);
  }

  /** The recursive tree of a candidate commit with blob sizes. */
  repoTree(root: string, commit: string): Promise<Array<{ path: string; mode: string; size: number }>> {
    return this.request({ op: "repo-tree", root, commit }).then((res) => (res as { entries: Array<{ path: string; mode: string; size: number }> }).entries);
  }

  /** One file of a candidate commit, or null when absent. */
  repoFile(root: string, commit: string, path: string): Promise<Buffer | null> {
    return this.request({ op: "repo-file", root, commit, path }).then((res) => {
      const content = (res as { content: string | null }).content;
      return content === null ? null : Buffer.from(content, "base64");
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const queued = this.queue.splice(0);
    this.queuedBytes = 0;
    for (const request of queued) request.reject(new Error("snapshot core is disposed"));
    for (const pending of this.pending.values()) pending.reject(new Error("snapshot core is disposed"));
    this.pending.clear();
    const process = this.process;
    this.process = null;
    process?.child.kill();
  }
}

/** The shared core process for the whole app. */
export const coreClient = new CoreClient();
