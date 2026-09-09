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

export async function searchProjectFiles(
  root: string,
  rawQuery: string,
  opts?: { shouldStop?: () => boolean },
): Promise<{ entries: QuickOpenEntry[]; truncated: boolean }> {
  const query = rawQuery.trim().toLowerCase().slice(0, MAX_QUICK_OPEN_QUERY);
  if (query.includes("\0")) return { entries: [], truncated: false };
  const scored: Array<{ relPath: string; score: number }> = [];
  const plain: string[] = [];
  let dirs = 0;
  let files = 0;
  let truncated = false;
  const seen = new Set<string>([root]);
  const queue: string[] = [root];
  let head = 0;
  const push = (relPath: string): void => {
    if (query) {
      const score = fuzzyScore(query, relPath);
      if (score === null) return;
      scored.push({ relPath, score });
    } else if (plain.length < MAX_QUICK_OPEN_RESULTS) {
      plain.push(relPath);
    }
  };
  while (head < queue.length) {
    if (opts?.shouldStop?.()) return { entries: [], truncated: false };
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
          push(relative(root, full));
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
        push(relative(root, full));
        continue;
      }
      queue.push(full);
    }
    if (truncated) break;
  }
  if (query) {
    scored.sort((a, b) => b.score - a.score || (a.relPath < b.relPath ? -1 : 1));
    return { entries: scored.slice(0, MAX_QUICK_OPEN_RESULTS).map(({ relPath }) => ({ relPath })), truncated };
  }
  plain.sort();
  return { entries: plain.slice(0, MAX_QUICK_OPEN_RESULTS).map((relPath) => ({ relPath })), truncated };
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
