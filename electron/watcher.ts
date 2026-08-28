/**
 * Recursive project watcher.
 *
 * Feeds the live editor: whenever a file the agent touches changes on disk
 * (via write/edit/bash...), the watcher reads it and pushes the new content to
 * the renderer so Monaco updates in real time. It also feeds the "modified
 * files" panel for files changed outside of explicit write/edit tool calls.
 */
import { watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  IGNORED_SEGMENTS,
  matchGitignore,
  parseGitignore,
  type GitignoreRules,
} from "../shared/gitignore.js";

// Live .gitignore files stay on the watcher. The compiler lives in shared/gitignore.ts.

export { IGNORED_SEGMENTS, matchGitignore, parseGitignore };
export type { GitignoreRule, GitignoreRules } from "../shared/gitignore.js";

/** The precomputed Git blob oids of one cached content string. */
export interface CachedOids {
  sha1: string;
  sha256: string;
}

/** The Git blob oid of a content string in one object format. */
export function blobOid(content: string, algorithm: "sha1" | "sha256"): string {
  const header = Buffer.from(`blob ${Buffer.byteLength(content)}\0`);
  return createHash(algorithm).update(header).update(content, "utf8").digest("hex");
}

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

const MAX_FILE_SIZE = 2 * 1024 * 1024; // do not read huge files into Monaco
const DEBOUNCE_MS = 120;

export class ProjectWatcher {
  private watcher: FSWatcher | null = null;
  private timers = new Map<string, NodeJS.Timeout>();
  private seen = new Set<string>();
  /** Rules of every loaded .gitignore, keyed by directory. */
  private gitignoreRules: GitignoreRules = new Map();

  /**
   * Rolling cache of the last known content for every watched text file.
   * Used as the pre-run baseline for the Change Review feature: at
   * agent_start we snapshot this map, so diffs compare the run's start
   * state against the current file.
   */
  lastContents = new Map<string, string>();
  /** Blob oids of the cached contents, hashed once per file version.
   *  The moment capture ships these instead of the contents themselves,
   *  so the core compares hashes without re-hashing every file. */
  lastOids = new Map<string, CachedOids>();
  private static readonly CACHE_LIMIT = 5000;
  /** Byte budget for the cache — count alone can reach gigabytes with big files. */
  private static readonly CACHE_BYTES = 64 * 1024 * 1024;
  /** The debounce map cap for change bursts. */
  private static readonly MAX_PENDING_TIMERS = 2000;
  private cacheBytes = 0;
  private generation = 0;

  /** Fired with the new file content whenever a watched text file changes. */
  onChange: (change: FileChange) => void | Promise<void> = () => {};
  /** Fired with just the path (used for the modified-files list). */
  onFileTouched: (path: string, status: "created" | "modified") => void | Promise<void> = () => {};
  /** Fired when a previously-seen file disappears (tabs and list entries clean up). */
  onFileDeleted: (path: string) => void | Promise<void> = () => {};

  /**
   * @param root watched directory
   * @param canonicalize optional path normalizer (for example realpath)
   *        applied to cache keys, so lookups with canonical paths always hit.
   */
  constructor(
    private root: string,
    private canonicalize?: (p: string) => string | Promise<string>,
  ) {}

  start(): void {
    this.stop();
    const generation = this.generation;
    // macOS/Windows support recursive watching; on Linux this throws and we degrade.
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (filename) this.schedule(filename.toString(), generation);
      });
    } catch (err) {
      console.warn(`[watcher] recursive watch unavailable: ${(err as Error).message}`);
    }
    // Seed the seen-set with existing files so the first real edit reads as
    // "modified" rather than "created" (files the agent creates are new to us).
    void this.seedExisting(generation);
  }

  stop(): void {
    this.generation++;
    this.seen.clear();
    this.lastContents.clear();
    this.lastOids.clear();
    this.cacheBytes = 0;
    this.gitignoreRules.clear();
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

  private schedule(relPath: string, generation: number): void {
    if (generation !== this.generation || this.isIgnored(relPath)) return;
    // Bound the debounce map: a build storm must not hold thousands of
    // timers. Flush the oldest entry first so no change gets lost.
    if (!this.timers.has(relPath) && this.timers.size >= ProjectWatcher.MAX_PENDING_TIMERS) {
      const oldest = this.timers.keys().next().value;
      if (oldest !== undefined) {
        const timer = this.timers.get(oldest);
        if (timer) clearTimeout(timer);
        this.timers.delete(oldest);
        void this.emit(oldest, generation).catch((err) => console.warn(`[watcher] change failed: ${(err as Error).message}`));
      }
    }
    const existing = this.timers.get(relPath);
    if (existing) clearTimeout(existing);
    this.timers.set(
      relPath,
      setTimeout(() => {
        if (generation !== this.generation) return;
        this.timers.delete(relPath);
        void this.emit(relPath, generation).catch((err) => console.warn(`[watcher] change failed: ${(err as Error).message}`));
      }, DEBOUNCE_MS),
    );
  }

  private isIgnored(relPath: string): boolean {
    const segments = relPath.split(sep);
    if (segments.some((s) => IGNORED_SEGMENTS.has(s))) return true;
    return this.gitignoreRules.size > 0 && matchGitignore(this.gitignoreRules, segments.join("/"));
  }

  /** The directory key of one .gitignore path (platform separators in,
   *  POSIX-style key out; "" is the root). */
  private gitignoreDirKey(relPath: string): string {
    const norm = relPath.split(sep).join("/");
    const cut = norm.lastIndexOf("/");
    return cut === -1 ? "" : norm.slice(0, cut);
  }

  /** Read one .gitignore and store its rules under its directory key. */
  private async loadGitignore(absPath: string, relPath: string, generation: number): Promise<void> {
    let source: string;
    try {
      source = await readFile(absPath, "utf8");
    } catch {
      return;
    }
    if (generation !== this.generation) return;
    this.gitignoreRules.set(this.gitignoreDirKey(relPath), parseGitignore(source));
  }

  private async emit(relPath: string, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    const abs = this.root.endsWith(sep) ? this.root + relPath : `${this.root}${sep}${relPath}`;

    // Stat first so a vanished file is reported as a deletion (not a read error).
    let st;
    try {
      st = await stat(abs);
    } catch {
      if (generation === this.generation && this.seen.has(relPath)) {
        this.seen.delete(relPath);
        if (relPath.split(sep).pop() === ".gitignore") {
          this.gitignoreRules.delete(this.gitignoreDirKey(relPath));
        }
        await this.onFileDeleted(abs);
      }
      return;
    }
    if (generation !== this.generation || !st.isFile()) return;
    if (st.size > MAX_FILE_SIZE) {
      // A file can grow past the cap. Mark it seen so a later small read
      // reports "modified", and drop the stale cached content.
      this.seen.add(relPath);
      const key = this.canonicalize ? await this.canonicalize(abs) : abs;
      const evicted = this.lastContents.get(key);
      if (evicted !== undefined) {
        this.cacheBytes -= Buffer.byteLength(evicted, "utf8");
        this.lastContents.delete(key);
        this.lastOids.delete(key);
      }
      return;
    }

    let content: string;
    try {
      const buf = await readFile(abs);
      // NUL bytes do not appear in text. Check the buffer, not the decoded
      // string: valid text can contain the replacement character.
      if (buf.includes(0)) return;
      content = buf.toString("utf8");
    } catch {
      return; // transient read error — leave as-is
    }
    if (generation !== this.generation) return;

    // A changed .gitignore refreshes the rules before the next event uses
    // them. The file itself still flows through as a normal change.
    const baseName = relPath.split(sep).pop();
    if (baseName === ".gitignore") await this.loadGitignore(abs, relPath, generation);
    if (generation !== this.generation) return;

    const status: "created" | "modified" = this.seen.has(relPath) ? "modified" : "created";
    this.seen.add(relPath);
    // Update the rolling content cache (evict oldest when over the limit).
    // Keys are canonicalized so lookups from anywhere in the app hit.
    const key = this.canonicalize ? await this.canonicalize(abs) : abs;
    const prev = this.lastContents.get(key); // pre-change content, for baselines
    this.putCached(key, content);
    const change: FileChange = { path: abs, relPath, content, status, prev };
    await this.onChange(change);
    if (generation === this.generation) await this.onFileTouched(abs, status);
  }

  /** Add one file version to the content cache and evict when over budget. */
  private putCached(key: string, content: string): void {
    const previous = this.lastContents.get(key);
    this.cacheBytes += Buffer.byteLength(content, "utf8") - (previous ? Buffer.byteLength(previous, "utf8") : 0);
    this.lastContents.set(key, content);
    this.lastOids.set(key, { sha1: blobOid(content, "sha1"), sha256: blobOid(content, "sha256") });
    while (this.lastContents.size > 1 && (this.lastContents.size > ProjectWatcher.CACHE_LIMIT || this.cacheBytes > ProjectWatcher.CACHE_BYTES)) {
      const oldest = this.lastContents.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.lastContents.get(oldest);
      this.cacheBytes -= evicted ? Buffer.byteLength(evicted, "utf8") : 0;
      this.lastContents.delete(oldest);
      this.lastOids.delete(oldest);
    }
  }

  /** Walk the project and mark existing files as seen. Their content is
   *  cached too, so the first change of a file still carries the pre-change
   *  content: editor highlights and run baselines need it. */
  private async seedExisting(generation: number): Promise<void> {
    const active = (): boolean => generation === this.generation;
    const walk = async (dir: string): Promise<void> => {
      if (!active()) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      if (!active()) return;
      for (const ent of entries) {
        if (!active() || this.seen.size > 100_000) return;
        if (IGNORED_SEGMENTS.has(ent.name)) continue;
        const full = join(dir, ent.name);
        if (ent.isDirectory()) {
          await walk(full);
        } else if (ent.isFile()) {
          const relPath = relative(this.root, full);
          if (ent.name === ".gitignore") await this.loadGitignore(full, relPath, generation);
          if (!active()) return;
          this.seen.add(relPath);
          // Cache the content within the existing byte budget. Ignored and
          // oversized files stay seen-only: emit never reports them.
          if (this.cacheBytes >= ProjectWatcher.CACHE_BYTES) continue;
          if (this.isIgnored(relPath)) continue;
          try {
            const st = await stat(full);
            if (!active()) return;
            if (!st.isFile() || st.size > MAX_FILE_SIZE) continue;
            const buf = await readFile(full);
            if (!active()) return;
            if (buf.includes(0)) continue; // binary
            const key = this.canonicalize ? await this.canonicalize(full) : full;
            if (!this.lastContents.has(key)) this.putCached(key, buf.toString("utf8"));
          } catch {
            /* unreadable — seen-only is enough */
          }
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
