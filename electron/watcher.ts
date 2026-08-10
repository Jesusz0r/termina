/**
 * Recursive project watcher.
 *
 * Feeds the live editor: whenever a file the agent touches changes on disk
 * (via write/edit/bash...), the watcher reads it and pushes the new content to
 * the renderer so Monaco updates in real time. It also feeds the "modified
 * files" panel for files changed outside of explicit write/edit tool calls.
 */
import { watch, type FSWatcher } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

interface FileChange {
  /** Absolute path. */
  path: string;
  /** Path relative to the watched root. */
  relPath: string;
  content: string;
  status: "created" | "modified";
  /** The cached content BEFORE this change (absent on the first touch). */
  prev?: string;
}

const IGNORED_SEGMENTS = new Set([
  "node_modules",
  ".git",
  ".pi",
  ".agents",
  ".next",
  ".nuxt",
  ".cache",
  ".parcel-cache",
  ".turbo",
  ".yarn",
  ".venv",
  "venv",
  "dist",
  "out",
  "build",
  "coverage",
  ".DS_Store",
  "vendor",
  ".idea",
  ".vscode",
  ".hg",
  ".svn",
  ".terraform",
  ".serverless",
  ".expo",
  ".android",
  ".ios",
]);

const MAX_FILE_SIZE = 2 * 1024 * 1024; // do not read huge files into Monaco
const DEBOUNCE_MS = 120;

export { IGNORED_SEGMENTS };

export class ProjectWatcher {
  private watcher: FSWatcher | null = null;
  private timers = new Map<string, NodeJS.Timeout>();
  private seen = new Set<string>();

  /**
   * Rolling cache of the last known content for every watched text file.
   * Used as the pre-run baseline for the Change Review feature: at
   * agent_start we snapshot this map, so diffs compare the run's start
   * state against the current file.
   */
  lastContents = new Map<string, string>();
  private static readonly CACHE_LIMIT = 5000;
  /** Byte budget for the cache — count alone can reach gigabytes with big files. */
  private static readonly CACHE_BYTES = 64 * 1024 * 1024;
  private cacheBytes = 0;

  /** Fired with the new file content whenever a watched text file changes. */
  onChange: (change: FileChange) => void = () => {};
  /** Fired with just the path (used for the modified-files list). */
  onFileTouched: (path: string, status: "created" | "modified") => void = () => {};
  /** Fired when a previously-seen file disappears (so tabs/list entries can be cleaned up). */
  onFileDeleted: (path: string) => void = () => {};

  /**
   * @param root watched directory
   * @param canonicalize optional path normalizer (e.g. realpath) applied to
   *        cache keys, so lookups with canonical paths always hit.
   */
  constructor(
    private root: string,
    private canonicalize?: (p: string) => string,
  ) {}

  start(): void {
    this.stop();
    this.seen.clear();
    // macOS/Windows support recursive watching; on Linux this throws and we degrade.
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (filename) this.schedule(filename.toString());
      });
    } catch (err) {
      console.warn(`[watcher] recursive watch unavailable: ${(err as Error).message}`);
    }
    // Seed the seen-set with existing files so the first real edit reads as
    // "modified" rather than "created" (files the agent creates are new to us).
    void this.seedExisting();
  }

  stop(): void {
    this.lastContents.clear();
    this.cacheBytes = 0;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* ignore */
      }
      this.watcher = null;
    }
  }

  private schedule(relPath: string): void {
    if (this.isIgnored(relPath)) return;
    const existing = this.timers.get(relPath);
    if (existing) clearTimeout(existing);
    this.timers.set(
      relPath,
      setTimeout(() => {
        this.timers.delete(relPath);
        void this.emit(relPath);
      }, DEBOUNCE_MS),
    );
  }

  private isIgnored(relPath: string): boolean {
    const segments = relPath.split(sep);
    return segments.some((s) => IGNORED_SEGMENTS.has(s));
  }

  private async emit(relPath: string): Promise<void> {
    const abs = this.root.endsWith(sep) ? this.root + relPath : `${this.root}${sep}${relPath}`;

    // Stat first so a vanished file is reported as a deletion (not a read error).
    let st;
    try {
      st = await stat(abs);
    } catch {
      if (this.seen.has(relPath)) {
        this.seen.delete(relPath);
        this.onFileDeleted(abs);
      }
      return;
    }
    if (!st.isFile() || st.size > MAX_FILE_SIZE) return;

    let content: string;
    try {
      const buf = await readFile(abs);
      content = buf.toString("utf8");
      // Detect binary files by the replacement character.
      if (content.includes("\uFFFD")) return;
    } catch {
      return; // transient read error — leave as-is
    }

    const status: "created" | "modified" = this.seen.has(relPath) ? "modified" : "created";
    this.seen.add(relPath);
    // Update the rolling content cache (evict oldest when over the limit).
    // Keys are canonicalized so lookups from anywhere in the app hit.
    const key = this.canonicalize ? this.canonicalize(abs) : abs;
    const prev = this.lastContents.get(key); // pre-change content, for baselines
    this.cacheBytes += Buffer.byteLength(content, "utf8") - (prev ? Buffer.byteLength(prev, "utf8") : 0);
    this.lastContents.set(key, content);
    while (this.lastContents.size > 1 && (this.lastContents.size > ProjectWatcher.CACHE_LIMIT || this.cacheBytes > ProjectWatcher.CACHE_BYTES)) {
      const oldest = this.lastContents.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.lastContents.get(oldest);
      this.cacheBytes -= evicted ? Buffer.byteLength(evicted, "utf8") : 0;
      this.lastContents.delete(oldest);
    }
    const change: FileChange = { path: abs, relPath, content, status, prev };
    this.onChange(change);
    this.onFileTouched(abs, status);
  }

  /** Walk the project (ignoring noise) and mark existing files as seen. */
  private async seedExisting(): Promise<void> {
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (this.seen.size > 100_000) return;
        if (IGNORED_SEGMENTS.has(ent.name)) continue;
        const full = join(dir, ent.name);
        if (ent.isDirectory()) {
          await walk(full);
        } else if (ent.isFile()) {
          this.seen.add(relative(this.root, full));
        }
      }
    };
    try {
      await walk(this.root);
    } catch {
      /* non-fatal */
    }
  }
}