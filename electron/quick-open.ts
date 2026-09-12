/**
 * Quick Open workspace file search (HARNESS-BACKLOG #2).
 *
 * Single owner for walking the active project tree and fuzzy-matching
 * relative paths. Visibility: hidden segments, dotfiles, and .gitignore
 * matches (root and nested) are skipped. Symlinked directories are
 * followed only when they resolve inside the project root; visited
 * directories are tracked by realpath so cycles terminate.
 */
import { readdir, readFile, realpath as fsRealpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { IGNORED_SEGMENTS, matchGitignore, parseGitignore, type GitignoreRules } from "../shared/gitignore.ts";

export interface QuickOpenEntry {
  relPath: string;
  /** Matched character indices into relPath, for result highlighting. */
  matches?: number[];
}

const MAX_QUICK_OPEN_DIRS = 8000;
const MAX_QUICK_OPEN_FILES = 30000;
const MAX_QUICK_OPEN_RESULTS = 50;
const MAX_QUICK_OPEN_QUERY = 256;

/**
 * Subsequence fuzzy match. Null when the query is not a subsequence of the
 * candidate. Higher score is better: basename matches outrank directory
 * matches, consecutive and segment-start runs outrank scatters.
 *
 * The walk addresses the ORIGINAL candidate (comparing lowercased per
 * character), so the returned indices always index the caller's string — a
 * lowercased copy could shift positions on case-expanding characters.
 */
export function fuzzyMatch(query: string, candidate: string): { score: number; indices: number[] } | null {
  const q = query.toLowerCase();
  if (!q) return null;
  let qi = 0;
  let score = 0;
  let run = 0;
  let lastIdx = -2;
  const indices: number[] = [];
  const baseStart = candidate.lastIndexOf("/") + 1;
  for (let ci = 0; ci < candidate.length && qi < q.length; ci++) {
    if (candidate[ci]!.toLowerCase() !== q[qi]) {
      run = 0;
      continue;
    }
    const consecutive = ci === lastIdx + 1;
    run = consecutive ? run + 1 : 1;
    score += 10 + run * 5;
    if (ci === 0 || candidate[ci - 1] === "/" || candidate[ci - 1] === "." || candidate[ci - 1] === "-" || candidate[ci - 1] === "_") score += 8;
    if (ci >= baseStart) score += 6;
    indices.push(ci);
    lastIdx = ci;
    qi++;
  }
  if (qi < q.length) return null;
  // Shorter candidates win ties; exact basename match wins outright.
  score -= candidate.length * 0.1;
  const base = candidate.slice(baseStart).toLowerCase();
  if (base === q) score += 100;
  return { score, indices };
}

/**
 * Subsequence fuzzy score. Null when the query is not a subsequence of the
 * candidate. One walk: the score is fuzzyMatch's, without the indices.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  return fuzzyMatch(query, candidate)?.score ?? null;
}

function visibleDirent(name: string): boolean {
  return !IGNORED_SEGMENTS.has(name) && !name.startsWith(".");
}

function isGitignoreRelPath(relPath: string): boolean {
  const norm = relPath.split(sep).join("/");
  return norm === ".gitignore" || norm.endsWith("/.gitignore");
}

/**
 * Load ancestor .gitignore files for one directory. Same nested-load as
 * content-search `ensureGitignoreChain`: each directory is read once,
 * parse/match stay in shared/gitignore.ts.
 */
async function ensureGitignoreChain(
  rules: GitignoreRules,
  loaded: Set<string>,
  root: string,
  posixDir: string,
): Promise<void> {
  let dir = posixDir;
  for (;;) {
    if (!loaded.has(dir)) {
      loaded.add(dir);
      const abs = dir === "" ? join(root, ".gitignore") : join(root, ...dir.split("/"), ".gitignore");
      try {
        rules.set(dir, parseGitignore(await readFile(abs, "utf8")));
      } catch {
        /* no gitignore here */
      }
    }
    if (dir === "") return;
    const slash = dir.lastIndexOf("/");
    dir = slash === -1 ? "" : dir.slice(0, slash);
  }
}

/** True when matchGitignore excludes this path. A directory uses the `/x`
 *  probe so directory-only rules (`ignored/`) prune the folder itself. */
function gitignored(rules: GitignoreRules, posixRel: string, isDir: boolean): boolean {
  return matchGitignore(rules, posixRel) || (isDir && matchGitignore(rules, `${posixRel}/x`));
}

/**
 * Relative paths of every visible project file, in breadth-first walk order.
 *
 * The single owner of "what files exist in the project": the search and the
 * path index both read this rather than each walking on their own. Bounds are
 * the caller-visible caps; `truncated` means the tree exceeded them and the
 * list is a prefix, not the whole project.
 *
 * An ignored directory is never enqueued: like Git, nothing inside it can
 * come back through a deeper negation.
 */
export async function listProjectPaths(
  root: string,
  opts?: { shouldStop?: () => boolean },
): Promise<{ paths: string[]; truncated: boolean }> {
  const paths: string[] = [];
  let dirs = 0;
  let files = 0;
  let truncated = false;
  const seen = new Set<string>([root]);
  const queue: string[] = [root];
  const rules: GitignoreRules = new Map();
  const loaded = new Set<string>();
  let head = 0;
  while (head < queue.length) {
    if (opts?.shouldStop?.()) return { paths: [], truncated: false };
    const dir = queue[head++]!;
    if (++dirs > MAX_QUICK_OPEN_DIRS) {
      truncated = true;
      break;
    }
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const dirPosix = relative(root, dir).split(sep).join("/");
    await ensureGitignoreChain(rules, loaded, root, dirPosix);
    for (const ent of dirents) {
      if (!visibleDirent(ent.name)) continue;
      const full = join(dir, ent.name);
      const posixRel = dirPosix ? `${dirPosix}/${ent.name}` : ent.name;
      const isDir = ent.isDirectory();
      if (ent.isSymbolicLink()) {
        let real: string;
        try {
          real = await fsRealpath(full);
        } catch {
          continue;
        }
        const rel = relative(root, real);
        if (!rel || rel.startsWith("..") || rel.startsWith(sep)) continue;
        if (seen.has(real)) continue;
        let realIsDir: boolean;
        try {
          realIsDir = (await stat(real)).isDirectory();
        } catch {
          continue;
        }
        if (gitignored(rules, posixRel, realIsDir)) continue;
        if (!realIsDir) {
          // A symlinked file inside the project is a searchable result.
          if (++files > MAX_QUICK_OPEN_FILES) {
            truncated = true;
            break;
          }
          paths.push(relative(root, full));
          continue;
        }
        seen.add(real);
        queue.push(real);
        continue;
      }
      if (gitignored(rules, posixRel, isDir)) continue;
      if (!isDir) {
        if (++files > MAX_QUICK_OPEN_FILES) {
          truncated = true;
          break;
        }
        paths.push(relative(root, full));
        continue;
      }
      queue.push(full);
    }
    if (truncated) break;
  }
  return { paths, truncated };
}

/**
 * Rank candidate paths against a query. Pure: no filesystem access, so the path
 * index can feed it a cached list and tests can feed it a fixture.
 *
 * `recent` (most-recent-first relPaths, already scoped to this project by the
 * caller) orders the empty query: files still in the tree lead, then the
 * standard fill. Entries carry their matched indices for highlighting.
 */
export function rankProjectPaths(
  candidates: Iterable<string>,
  rawQuery: string,
  truncated: boolean,
  recent: readonly string[] = [],
): { entries: QuickOpenEntry[]; truncated: boolean } {
  const query = rawQuery.trim().toLowerCase().slice(0, MAX_QUICK_OPEN_QUERY);
  if (query.includes("\0")) return { entries: [], truncated: false };
  if (!query) {
    // No query: recents first (most recent first), then the first N in walk
    // order (shallow first), alphabetized — the pre-recents behavior.
    const all = [...candidates];
    const membership = new Set(all);
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const relPath of recent) {
      if (ordered.length >= MAX_QUICK_OPEN_RESULTS) break;
      if (!membership.has(relPath) || seen.has(relPath)) continue;
      seen.add(relPath);
      ordered.push(relPath);
    }
    const fill: string[] = [];
    for (const relPath of all) {
      if (ordered.length + fill.length >= MAX_QUICK_OPEN_RESULTS) break;
      if (seen.has(relPath)) continue;
      seen.add(relPath);
      fill.push(relPath);
    }
    fill.sort();
    return { entries: [...ordered, ...fill].map((relPath) => ({ relPath })), truncated };
  }
  const scored: Array<{ relPath: string; score: number; indices: number[] }> = [];
  for (const relPath of candidates) {
    const match = fuzzyMatch(query, relPath);
    if (match === null) continue;
    scored.push({ relPath, score: match.score, indices: match.indices });
  }
  scored.sort((a, b) => b.score - a.score || (a.relPath < b.relPath ? -1 : 1));
  return {
    entries: scored.slice(0, MAX_QUICK_OPEN_RESULTS).map(({ relPath, indices }) => ({ relPath, matches: indices })),
    truncated,
  };
}

/**
 * Per-caller cancellation generations for project search. Each caller owns a
 * lane: same-lane searches supersede each other, cross-lane searches never
 * abort. Unknown sources share the default lane, so a compromised or
 * outdated renderer cannot grow the lane set.
 */
export class SearchGenerations<Lane extends string> {
  private seq = new Map<Lane, number>();

  constructor(
    private readonly lanes: readonly Lane[],
    private readonly defaultLane: Lane,
  ) {}

  /** Allocate the next generation for the caller's lane. */
  next(source: unknown): { source: Lane; seq: number } {
    const lane = (this.lanes as readonly unknown[]).includes(source) ? (source as Lane) : this.defaultLane;
    const seq = (this.seq.get(lane) ?? 0) + 1;
    this.seq.set(lane, seq);
    return { source: lane, seq };
  }

  /** True while no newer same-lane search has started. */
  current(source: Lane, seq: number): boolean {
    return (this.seq.get(source) ?? 0) === seq;
  }
}

/**
 * Search the project for a query. Walks when the caller has no candidate list;
 * a cached list (the path index) is scored directly.
 */
export async function searchProjectFiles(
  root: string,
  rawQuery: string,
  opts?: { shouldStop?: () => boolean; candidates?: { paths: readonly string[]; truncated: boolean }; recent?: readonly string[] },
): Promise<{ entries: QuickOpenEntry[]; truncated: boolean }> {
  const listed = opts?.candidates ?? await listProjectPaths(root, opts);
  // A cancelled walk must not be ranked as though it were complete.
  if (opts?.shouldStop?.()) return { entries: [], truncated: false };
  return rankProjectPaths(listed.paths, rawQuery, listed.truncated, opts?.recent);
}

/**
 * Cached project file inventory for repeated searches.
 *
 * This keeps the file list between queries and patches it from watcher events,
 * so only the first search pays for the walk. The candidate list is ranked by
 * `rankProjectPaths`, so scoring and visibility rules stay owned by the walk above.
 * A created, changed, or deleted `.gitignore` invalidates the cache so the next
 * search rebuilds under the new rules.
 *
 * Order is preserved from the walk: the empty-query result is the first N paths
 * encountered (shallow first), which a set would not reproduce.
 */
export class ProjectPathIndex {
  private root: string | null = null;
  private paths: string[] = [];
  private membership = new Set<string>();
  private truncated = false;
  private built = false;
  private building: Promise<void> | null = null;
  private generation = 0;

  /** Candidate list for a query, building the index on first use. */
  async candidates(root: string, shouldStop?: () => boolean): Promise<{ paths: readonly string[]; truncated: boolean }> {
    if (this.root !== root) this.reset(root);
    if (!this.built) {
      const build = this.building ?? (this.building = this.build(root, shouldStop, this.generation));
      await build;
    }
    return { paths: this.paths, truncated: this.truncated };
  }

  private async build(root: string, shouldStop: (() => boolean) | undefined, generation: number): Promise<void> {
    try {
      const listed = await listProjectPaths(root, { shouldStop });
      // Cancelled, invalidated, or superseded: leave the index unbuilt so the
      // next search retries rather than caching a partial or stale tree.
      if (this.root !== root || generation !== this.generation || shouldStop?.()) return;
      this.paths = listed.paths;
      this.membership = new Set(listed.paths);
      this.truncated = listed.truncated;
      this.built = true;
    } finally {
      // Only clear our own in-flight marker: an invalidation may have started
      // a newer build while this one was still running.
      if (generation === this.generation) this.building = null;
    }
  }

  /**
   * A watcher-reported create for one workspace root. Events from any other
   * root are ignored so a background project never patches the foreground
   * index. Ignored until the index exists (nothing to patch).
   */
  noteAdded(root: string, relPath: string): void {
    if (this.root !== root) return;
    if (!relPath) return;
    if (isGitignoreRelPath(relPath)) {
      this.invalidate();
      return;
    }
    if (!this.built || this.membership.has(relPath)) return;
    this.paths.push(relPath);
    this.membership.add(relPath);
  }

  /**
   * A watcher-reported removal for one workspace root. Events from any other
   * root are ignored so a background project never patches the foreground
   * index.
   *
   * Removes the path *and anything under it*. A deleted directory fires one
   * event for the directory itself, not one per descendant, so a prefix match is
   * what keeps the index from continuing to offer files that are gone. For a
   * file path the prefix can only ever match the path itself.
   */
  noteRemoved(root: string, relPath: string): void {
    if (this.root !== root) return;
    if (!relPath) return;
    if (isGitignoreRelPath(relPath)) {
      this.invalidate();
      return;
    }
    if (!this.built) return;
    const prefix = `${relPath}/`;
    const keep: string[] = [];
    for (const path of this.paths) {
      if (path === relPath || path.startsWith(prefix)) {
        this.membership.delete(path);
        continue;
      }
      keep.push(path);
    }
    if (keep.length !== this.paths.length) this.paths = keep;
  }

  /** Discard the index; the next search rebuilds it. */
  invalidate(): void {
    this.generation++;
    this.built = false;
    this.building = null;
  }

  /** Point the index at a different root, dropping the previous tree. */
  reset(root: string | null = null): void {
    this.generation++;
    this.root = root;
    this.paths = [];
    this.membership = new Set();
    this.truncated = false;
    this.built = false;
    this.building = null;
  }
}

/** Snapshot entries for one agent turn: most projects fit, huge ones truncate. */
export const MAX_PROJECT_SNAPSHOT_ENTRIES = 400;
/** Directory visits per snapshot: empty-dir trees cannot force a full walk. */
const MAX_PROJECT_SNAPSHOT_DIRS = 2000;

/**
 * Breadth-first project inventory for the per-turn project snapshot:
 * directories with a trailing slash, files as relative paths, top levels
 * first. Same visibility rule as search: hidden segments, dotfiles,
 * .gitignore matches, and escaping/cyclic symlinks are skipped. Stops
 * early at the entry cap so a huge tree costs one shallow walk, not a
 * full one.
 */
export async function listProjectSnapshot(
  root: string,
  opts?: { maxEntries?: number; shouldStop?: () => boolean },
): Promise<{ entries: string[]; truncated: boolean }> {
  const maxEntries = opts?.maxEntries ?? MAX_PROJECT_SNAPSHOT_ENTRIES;
  const entries: string[] = [];
  let truncated = false;
  let dirs = 0;
  const seen = new Set<string>([root]);
  const queue: string[] = [root];
  const rules: GitignoreRules = new Map();
  const loaded = new Set<string>();
  let head = 0;
  while (head < queue.length) {
    if (opts?.shouldStop?.()) return { entries: [], truncated: false };
    const dir = queue[head++]!;
    if (++dirs > MAX_PROJECT_SNAPSHOT_DIRS) {
      truncated = true;
      break;
    }
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const dirPosix = relative(root, dir).split(sep).join("/");
    await ensureGitignoreChain(rules, loaded, root, dirPosix);
    dirents.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const ent of dirents) {
      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
      if (!visibleDirent(ent.name)) continue;
      const full = join(dir, ent.name);
      const posixRel = dirPosix ? `${dirPosix}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) {
        let real: string;
        try {
          real = await fsRealpath(full);
        } catch {
          continue;
        }
        const rel = relative(root, real);
        if (!rel || rel.startsWith("..") || rel.startsWith(sep)) continue;
        if (seen.has(real)) continue;
        let realIsDir: boolean;
        try {
          realIsDir = (await stat(real)).isDirectory();
        } catch {
          continue;
        }
        if (gitignored(rules, posixRel, realIsDir)) continue;
        if (!realIsDir) {
          entries.push(relative(root, full));
          continue;
        }
        seen.add(real);
        queue.push(real);
        continue;
      }
      if (gitignored(rules, posixRel, ent.isDirectory())) continue;
      if (ent.isDirectory()) {
        entries.push(`${relative(root, full)}/`);
        queue.push(full);
        continue;
      }
      entries.push(relative(root, full));
    }
    if (truncated) break;
  }
  return { entries, truncated };
}
