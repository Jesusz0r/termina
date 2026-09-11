/**
 * Quick Open workspace file search (HARNESS-BACKLOG #2).
 *
 * Single owner for walking the active project tree and fuzzy-matching
 * relative paths. Same visibility rule as the explorer: hidden segments
 * and dotfiles are skipped. Symlinked directories are followed only when
 * they resolve inside the project root; visited directories are tracked
 * by realpath so cycles terminate.
 */
import { readdir, realpath as fsRealpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { IGNORED_SEGMENTS } from "../shared/gitignore.ts";

export interface QuickOpenEntry {
  relPath: string;
}

const MAX_QUICK_OPEN_DIRS = 8000;
const MAX_QUICK_OPEN_FILES = 30000;
const MAX_QUICK_OPEN_RESULTS = 50;
const MAX_QUICK_OPEN_QUERY = 256;

/**
 * Subsequence fuzzy score. Null when the query is not a subsequence of the
 * candidate. Higher is better: basename matches outrank directory matches,
 * consecutive and segment-start runs outrank scatters.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  if (!q) return null;
  let qi = 0;
  let score = 0;
  let run = 0;
  let lastIdx = -2;
  const baseStart = c.lastIndexOf("/") + 1;
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] !== q[qi]) {
      run = 0;
      continue;
    }
    const consecutive = ci === lastIdx + 1;
    run = consecutive ? run + 1 : 1;
    score += 10 + run * 5;
    if (ci === 0 || c[ci - 1] === "/" || c[ci - 1] === "." || c[ci - 1] === "-" || c[ci - 1] === "_") score += 8;
    if (ci >= baseStart) score += 6;
    lastIdx = ci;
    qi++;
  }
  if (qi < q.length) return null;
  // Shorter candidates win ties; exact basename match wins outright.
  score -= candidate.length * 0.1;
  const base = c.slice(baseStart);
  if (base === q) score += 100;
  return score;
}

function visibleDirent(name: string): boolean {
  return !IGNORED_SEGMENTS.has(name) && !name.startsWith(".");
}

/**
 * Relative paths of every visible project file, in breadth-first walk order.
 *
 * The single owner of "what files exist in the project": the search and the
 * path index both read this rather than each walking on their own. Bounds are
 * the caller-visible caps; `truncated` means the tree exceeded them and the
 * list is a prefix, not the whole project.
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
    for (const ent of dirents) {
      if (!visibleDirent(ent.name)) continue;
      const full = join(dir, ent.name);
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
 */
export function rankProjectPaths(
  candidates: Iterable<string>,
  rawQuery: string,
  truncated: boolean,
): { entries: QuickOpenEntry[]; truncated: boolean } {
  const query = rawQuery.trim().toLowerCase().slice(0, MAX_QUICK_OPEN_QUERY);
  if (query.includes("\0")) return { entries: [], truncated: false };
  if (!query) {
    // No query: the first N in walk order (shallow first), then alphabetized.
    const plain: string[] = [];
    for (const relPath of candidates) {
      if (plain.length >= MAX_QUICK_OPEN_RESULTS) break;
      plain.push(relPath);
    }
    plain.sort();
    return { entries: plain.map((relPath) => ({ relPath })), truncated };
  }
  const scored: Array<{ relPath: string; score: number }> = [];
  for (const relPath of candidates) {
    const score = fuzzyScore(query, relPath);
    if (score === null) continue;
    scored.push({ relPath, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.relPath < b.relPath ? -1 : 1));
  return { entries: scored.slice(0, MAX_QUICK_OPEN_RESULTS).map(({ relPath }) => ({ relPath })), truncated };
}

/**
 * Search the project for a query. Walks when the caller has no candidate list;
 * a cached list (the path index) is scored directly.
 */
export async function searchProjectFiles(
  root: string,
  rawQuery: string,
  opts?: { shouldStop?: () => boolean; candidates?: { paths: readonly string[]; truncated: boolean } },
): Promise<{ entries: QuickOpenEntry[]; truncated: boolean }> {
  const listed = opts?.candidates ?? await listProjectPaths(root, opts);
  // A cancelled walk must not be ranked as though it were complete.
  if (opts?.shouldStop?.()) return { entries: [], truncated: false };
  return rankProjectPaths(listed.paths, rawQuery, listed.truncated);
}

/**
 * Cached project file inventory for repeated searches.
 *
 * Quick Open runs a full walk per keystroke; this keeps the file list between
 * queries and patches it from watcher events, so only the first search pays for
 * the walk. The candidate list is ranked by `rankProjectPaths`, so scoring and
 * visibility rules stay owned by the walk above.
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

  /** Candidate list for a query, building the index on first use. */
  async candidates(root: string, shouldStop?: () => boolean): Promise<{ paths: readonly string[]; truncated: boolean }> {
    if (this.root !== root) this.reset(root);
    if (!this.built) {
      const build = this.building ?? (this.building = this.build(root, shouldStop));
      await build;
    }
    return { paths: this.paths, truncated: this.truncated };
  }

  private async build(root: string, shouldStop?: () => boolean): Promise<void> {
    try {
      const listed = await listProjectPaths(root, { shouldStop });
      // Cancelled or superseded: leave the index unbuilt so the next search
      // retries rather than caching a partial tree.
      if (this.root !== root || shouldStop?.()) return;
      this.paths = listed.paths;
      this.membership = new Set(listed.paths);
      this.truncated = listed.truncated;
      this.built = true;
    } finally {
      this.building = null;
    }
  }

  /** A watcher-reported create. Ignored until the index exists (nothing to patch). */
  noteAdded(relPath: string): void {
    if (!this.built || !relPath || this.membership.has(relPath)) return;
    this.paths.push(relPath);
    this.membership.add(relPath);
  }

  /**
   * A watcher-reported removal.
   *
   * Removes the path *and anything under it*. A deleted directory fires one
   * event for the directory itself, not one per descendant, so a prefix match is
   * what keeps the index from continuing to offer files that are gone. For a
   * file path the prefix can only ever match the path itself.
   */
  noteRemoved(relPath: string): void {
    if (!this.built || !relPath) return;
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
    this.built = false;
    this.building = null;
  }

  /** Point the index at a different root, dropping the previous tree. */
  reset(root: string | null = null): void {
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
 * first. Same visibility rule as search: hidden segments, dotfiles, and
 * escaping/cyclic symlinks are skipped. Stops early at the entry cap so a
 * huge tree costs one shallow walk, not a full one.
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
    dirents.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const ent of dirents) {
      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
      if (!visibleDirent(ent.name)) continue;
      const full = join(dir, ent.name);
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
        if (!realIsDir) {
          entries.push(relative(root, full));
          continue;
        }
        seen.add(real);
        queue.push(real);
        continue;
      }
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
