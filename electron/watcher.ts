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

// ---- .gitignore support ----
//
// Every path the project ignores through .gitignore files is noise too.
// The rules live on the watcher next to IGNORED_SEGMENTS. Modified-file
// discovery, baselines, and moment captures all flow through this gate.
// Escaped literals such as a leading "\!" stay unsupported.

/** One compiled pattern line of a .gitignore file. */
export interface GitignoreRule {
  /** True for a "!" pattern. A match re-includes the path. */
  negated: boolean;
  /** True for a pattern with a trailing "/". Only directories match. */
  dirOnly: boolean;
  /** Matches the path relative to the .gitignore directory. */
  re: RegExp;
}

/** Parsed rules of every known .gitignore. The key is the directory of the
 *  file relative to the root ("/"-separated; "" is the root itself). */
export type GitignoreRules = Map<string, GitignoreRule[]>;

/** Translate one pattern segment. Wildcards stay inside one segment. */
function translateSegment(seg: string): string {
  return seg
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
}

/** Compile one pattern body (no "!", no trailing "/") into a path regex.
 *  Returns null for an invalid pattern; one bad line drops out alone. */
function compilePattern(body: string, anchored: boolean): RegExp | null {
  const segs = body.split("/");
  let src = "";
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    if (seg === "**") {
      // A lone "**" matches everything. A trailing "**" matches the
      // contents only. Any other "**" absorbs whole directories.
      if (segs.length === 1) src += ".+";
      else if (last) src += "/.*";
      else src += "(?:[^/]+/)*";
      continue;
    }
    src += translateSegment(seg);
    if (!last && segs[i + 1] !== "**") src += "/";
  }
  try {
    return new RegExp(`${anchored ? "^" : "^(?:.*/)?"}${src}$`);
  } catch {
    return null;
  }
}

/** Parse one .gitignore source into ordered rules. Comments, blank lines,
 *  and invalid patterns drop out. */
export function parseGitignore(source: string): GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const rest = negated ? line.slice(1) : line;
    const dirOnly = rest.endsWith("/");
    const body = dirOnly ? rest.slice(0, -1) : rest;
    if (!body || body === "/") continue;
    // A "/" anywhere anchors the pattern to this directory.
    const anchored = body.includes("/");
    const stripped = anchored && body.startsWith("/") ? body.slice(1) : body;
    if (!stripped) continue;
    const re = compilePattern(stripped, anchored);
    if (re) rules.push({ negated, dirOnly, re });
  }
  return rules;
}

/** Match a root-relative POSIX path against every known rule set.
 *  Rules apply from the shallowest directory to the deepest, so a deeper
 *  .gitignore overrides a shallower one. Within one file the last
 *  matching pattern wins. Directory-only rules match the path prefixes;
 *  they never match the final file segment itself. Like Git, traversal
 *  stops at an excluded directory: nothing inside it can come back. */
export function matchGitignore(rules: GitignoreRules, posixRelPath: string): boolean {
  if (rules.size === 0 || posixRelPath.length === 0) return false;
  const segs = posixRelPath.split("/");
  // Collect the rule sets of every ancestor directory once, shallow first.
  const layers: Array<{ offset: number; rules: GitignoreRule[] }> = [];
  for (let d = 0; d < segs.length; d++) {
    const base = d === 0 ? "" : segs.slice(0, d).join("/");
    const set = rules.get(base);
    if (set) layers.push({ offset: base.length === 0 ? 0 : base.length + 1, rules: set });
  }
  if (layers.length === 0) return false;
  let ignored = false;
  for (let d = 0; d < segs.length; d++) {
    const isDir = d < segs.length - 1;
    const prefix = segs.slice(0, d + 1).join("/");
    for (const layer of layers) {
      // A rule set never matches its own directory.
      if (layer.offset >= prefix.length) continue;
      const sub = layer.offset === 0 ? prefix : prefix.slice(layer.offset);
      if (sub.length === 0) continue;
      for (const rule of layer.rules) {
        if (rule.dirOnly && !isDir) continue;
        if (rule.re.test(sub)) ignored = !rule.negated;
      }
    }
    if (ignored && isDir) return true;
  }
  return ignored;
}

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

  /** Fired with the new file content whenever a watched text file changes. */
  onChange: (change: FileChange) => void = () => {};
  /** Fired with just the path (used for the modified-files list). */
  onFileTouched: (path: string, status: "created" | "modified") => void = () => {};
  /** Fired when a previously-seen file disappears (tabs and list entries clean up). */
  onFileDeleted: (path: string) => void = () => {};

  /**
   * @param root watched directory
   * @param canonicalize optional path normalizer (for example realpath)
   *        applied to cache keys, so lookups with canonical paths always hit.
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

  private schedule(relPath: string): void {
    if (this.isIgnored(relPath)) return;
    // Bound the debounce map: a build storm must not hold thousands of
    // timers. Flush the oldest entry first so no change gets lost.
    if (!this.timers.has(relPath) && this.timers.size >= ProjectWatcher.MAX_PENDING_TIMERS) {
      const oldest = this.timers.keys().next().value;
      if (oldest !== undefined) {
        const timer = this.timers.get(oldest);
        if (timer) clearTimeout(timer);
        this.timers.delete(oldest);
        void this.emit(oldest);
      }
    }
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
  private async loadGitignore(absPath: string, relPath: string): Promise<void> {
    let source: string;
    try {
      source = await readFile(absPath, "utf8");
    } catch {
      return;
    }
    this.gitignoreRules.set(this.gitignoreDirKey(relPath), parseGitignore(source));
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
        if (relPath.split(sep).pop() === ".gitignore") {
          this.gitignoreRules.delete(this.gitignoreDirKey(relPath));
        }
        this.onFileDeleted(abs);
      }
      return;
    }
    if (!st.isFile()) return;
    if (st.size > MAX_FILE_SIZE) {
      // A file can grow past the cap. Mark it seen so a later small read
      // reports "modified", and drop the stale cached content.
      this.seen.add(relPath);
      const key = this.canonicalize ? this.canonicalize(abs) : abs;
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

    // A changed .gitignore refreshes the rules before the next event uses
    // them. The file itself still flows through as a normal change.
    const baseName = relPath.split(sep).pop();
    if (baseName === ".gitignore") await this.loadGitignore(abs, relPath);

    const status: "created" | "modified" = this.seen.has(relPath) ? "modified" : "created";
    this.seen.add(relPath);
    // Update the rolling content cache (evict oldest when over the limit).
    // Keys are canonicalized so lookups from anywhere in the app hit.
    const key = this.canonicalize ? this.canonicalize(abs) : abs;
    const prev = this.lastContents.get(key); // pre-change content, for baselines
    this.cacheBytes += Buffer.byteLength(content, "utf8") - (prev ? Buffer.byteLength(prev, "utf8") : 0);
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
          if (ent.name === ".gitignore") await this.loadGitignore(full, relative(this.root, full));
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