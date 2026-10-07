import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, opendir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { durableAtomicWrite } from "../shared/durable-write.ts";
import { syncDirectoryAsync } from "../shared/fsync.ts";
import { isErrno, isRecord } from "../shared/guards.ts";
import { readEditorBytes } from "./main/editor-file.ts";

export const MAX_EDITOR_DRAFT_BYTES = 2 * 1024 * 1024;
export const MAX_EDITOR_DRAFTS = 64;
// JSON can expand a single content byte to six bytes. Metadata is separately bounded.
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = MAX_EDITOR_DRAFT_BYTES * 6 + MAX_METADATA_BYTES;
const RECORD_NAME = /^[a-f0-9]{64}\.json$/;

export interface EditorDraft {
  root: string;
  path: string;
  content: string;
}

interface PendingDraft {
  root: string;
  path: string;
  content: string | null;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function recordName(root: string, path: string): string {
  // This hash identifies a private storage key, not source content or a Git object.
  return `${createHash("sha256").update(`${root}\0${path}`).digest("hex")}.json`;
}

function validateIdentity(root: string, path: string): void {
  if (!isAbsolute(root) || !isAbsolute(path) || root.includes("\0") || path.includes("\0")) {
    throw new Error("Editor draft root and path must be absolute paths without null bytes");
  }
  if (Buffer.byteLength(JSON.stringify({ root, path, content: "" }), "utf8") > MAX_METADATA_BYTES) {
    throw new Error("Editor draft path metadata exceeds the storage limit");
  }
}

/** One main-process owner. Project authorization and write leases belong to main. */
export class EditorDraftStore {
  private readonly directory: string;
  private readonly pending = new Map<string, PendingDraft>();
  private readonly pendingDirectorySyncs = new Set<string>();
  private active: PendingDraft | null = null;
  private running = false;

  constructor(directory: string) {
    this.directory = resolve(directory);
    this.pendingDirectorySyncs.add(dirname(this.directory));
  }

  async get(root: string, path: string): Promise<EditorDraft | null> {
    validateIdentity(root, path);
    await this.flush();
    if (!await this.checkDirectory()) return null;
    return this.readRecord(recordName(root, path));
  }

  async list(root: string): Promise<{ paths: string[]; unreadable: number }> {
    await this.flush();
    if (!await this.checkDirectory()) return { paths: [], unreadable: 0 };
    const paths: string[] = [];
    let unreadable = 0;
    for (const name of await this.recordNames()) {
      let draft: EditorDraft | null;
      try {
        draft = await this.readRecord(name);
      } catch {
        unreadable++;
        continue;
      }
      if (draft?.root === root) paths.push(draft.path);
    }
    return { paths: paths.sort(), unreadable };
  }

  put(root: string, path: string, content: string | null): Promise<void> {
    try {
      validateIdentity(root, path);
      if (content !== null && Buffer.byteLength(content, "utf8") > MAX_EDITOR_DRAFT_BYTES) {
        throw new Error(`Editor draft content exceeds the ${MAX_EDITOR_DRAFT_BYTES}-byte limit`);
      }
      const key = recordName(root, path);
      const existing = this.pending.get(key);
      if (existing) {
        existing.content = content;
        return existing.promise;
      }
      if (this.pending.size >= MAX_EDITOR_DRAFTS) {
        throw new Error(`Editor draft queue exceeds the ${MAX_EDITOR_DRAFTS}-record limit`);
      }
      let resolveBatch!: () => void;
      let rejectBatch!: (error: unknown) => void;
      const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolveBatch = resolvePromise;
        rejectBatch = rejectPromise;
      });
      // Keep an unattended batch rejection from becoming an unhandled rejection.
      // The original promise still rejects for every caller and flush observer.
      void promise.catch(() => undefined);
      this.pending.set(key, { root, path, content, promise, resolve: resolveBatch, reject: rejectBatch });
      if (!this.running) {
        this.running = true;
        void Promise.resolve().then(() => this.drain());
      }
      return promise;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** Wait for all batches accepted before this call; report their failures after all settle. */
  async flush(): Promise<void> {
    const batches = [...this.pending.values()].map((entry) => entry.promise);
    if (this.active) batches.push(this.active.promise);
    const results = await Promise.allSettled(batches);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending.size > 0) {
        const [key, batch] = this.pending.entries().next().value!;
        this.pending.delete(key);
        this.active = batch;
        try {
          await this.persist(key, batch);
          batch.resolve();
        } catch (error) {
          batch.reject(new Error(`Editor draft for ${batch.path} could not be persisted: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
        } finally {
          this.active = null;
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async persist(key: string, batch: PendingDraft): Promise<void> {
    await this.ensureDirectory();
    // Refuse replacement AND removal if recovery data cannot be validated.
    const previous = await this.readRecord(key);
    const destination = join(this.directory, key);
    if (batch.content === null) {
      if (previous) await unlink(destination);
      // Sync even when absent: a previous unlink may have failed its directory sync.
      await syncDirectoryAsync(this.directory);
      return;
    }
    if (!previous && (await this.recordNames()).length >= MAX_EDITOR_DRAFTS) {
      throw new Error(`Editor draft store exceeds the ${MAX_EDITOR_DRAFTS}-record limit; remove a draft first`);
    }
    await durableAtomicWrite(destination, JSON.stringify({ root: batch.root, path: batch.path, content: batch.content }));
  }

  private async checkDirectory(): Promise<boolean> {
    try {
      const info = await lstat(this.directory);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error("Editor draft store directory must be a real directory, not a symlink");
      }
      return true;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
  }

  private async ensureDirectory(): Promise<void> {
    if (!await this.checkDirectory()) {
      const firstCreated = await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await this.checkDirectory();
      if (firstCreated) {
        // Make each new directory entry durable, including the topmost new parent.
        let current = this.directory;
        while (true) {
          this.pendingDirectorySyncs.add(dirname(current));
          if (current === resolve(firstCreated)) break;
          current = dirname(current);
        }
      }
    }
    await chmod(this.directory, 0o700);
    // Retain unsynchronized creation entries if a sync fails so the next batch retries them.
    for (const directory of this.pendingDirectorySyncs) {
      await syncDirectoryAsync(directory);
      this.pendingDirectorySyncs.delete(directory);
    }
  }

  private async recordNames(): Promise<string[]> {
    const names: string[] = [];
    const directory = await opendir(this.directory);
    for await (const entry of directory) {
      // Atomic-write temporary files are not committed recovery records.
      if (!entry.name.endsWith(".json")) continue;
      if (!RECORD_NAME.test(entry.name)) throw new Error(`Editor draft has an invalid storage key: ${entry.name}`);
      names.push(entry.name);
      if (names.length > MAX_EDITOR_DRAFTS) {
        throw new Error(`Editor draft store exceeds the ${MAX_EDITOR_DRAFTS}-record limit`);
      }
    }
    return names;
  }

  private async readRecord(name: string): Promise<EditorDraft | null> {
    const file = join(this.directory, name);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
        throw new Error("Editor draft must be a regular private file, not a symlink or hard link");
      }
      const flags = constants.O_RDONLY | constants.O_NOFOLLOW
        | (process.platform === "win32" ? 0 : constants.O_NONBLOCK);
      handle = await open(file, flags);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1) throw new Error("Editor draft must be a regular private file");
      const bytes = await readEditorBytes(handle, MAX_RECORD_BYTES);
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!isRecord(parsed) || typeof parsed.root !== "string" || typeof parsed.path !== "string" || typeof parsed.content !== "string") {
        throw new Error("Editor draft record is corrupt");
      }
      validateIdentity(parsed.root, parsed.path);
      if (Buffer.byteLength(parsed.content, "utf8") > MAX_EDITOR_DRAFT_BYTES) {
        throw new Error("Editor draft content exceeds the byte limit");
      }
      if (recordName(parsed.root, parsed.path) !== name) throw new Error("Editor draft record has the wrong storage key");
      return { root: parsed.root, path: parsed.path, content: parsed.content };
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw new Error(`Editor draft record ${name} could not be read: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      await handle?.close();
    }
  }
}
