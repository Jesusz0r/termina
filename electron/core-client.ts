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

class CoreClient {
  private child: ReturnType<typeof spawn> | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private buffer = "";

  private ensure(): ReturnType<typeof spawn> {
    if (this.child) return this.child;
    this.child = spawn(resolveCoreBin(), [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      // A runaway core must not grow the buffer without bound.
      if (this.buffer.length > 64 * 1024 * 1024) {
        this.child?.kill();
        return;
      }
      let nl = this.buffer.indexOf("\n");
      while (nl !== -1) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (line.trim()) {
          try {
            this.handleMessage(JSON.parse(line));
          } catch {
            /* malformed line — skip */
          }
        }
        nl = this.buffer.indexOf("\n");
      }
    });
    const failAll = (err: Error) => {
      for (const pending of this.pending.values()) pending.reject(err);
      this.pending.clear();
      this.buffer = "";
      this.child = null;
    };
    this.child.on("error", failAll);
    this.child.on("exit", () => failAll(new Error("snapshot core exited")));
    return this.child;
  }

  /** The core answers every op with <op>-result. */
  private handleMessage(msg: { op?: string; requestId?: string; ok?: boolean; error?: string; state?: unknown }): void {
    if (!msg.requestId) return;
    const pending = this.pending.get(msg.requestId);
    if (!pending) return;
    this.pending.delete(msg.requestId);
    if (msg.ok) pending.resolve(msg.state ?? msg);
    else pending.reject(new Error(msg.error ?? "snapshot core op failed"));
  }

  /** Serialize captures. A failed capture does not block later captures. */
  request(payload: Record<string, unknown>): Promise<unknown> {
    const run = this.queue.then(() => this.dispatch(payload));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private dispatch(payload: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const requestId = `cap-${++this.seq}`;
      this.pending.set(requestId, { resolve, reject });
      try {
        // The payload carries its own op (capture, template, apply-state).
        this.ensure().stdin?.write(JSON.stringify({ ...payload, requestId }) + "\n");
      } catch (err) {
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
    this.child?.kill();
    this.child = null;
  }
}

/** The shared core process for the whole app. */
export const coreClient = new CoreClient();
