/**
 * Merge-workload construction for scripts/perf-compare.ts (issue #138).
 *
 * Git and Termina must receive the same trees. Ranges and names live here so
 * tests can prove disjoint inputs and reject non-equivalent comparisons
 * without running the full benchmark.
 */

export const MERGE_OURS = { lo: 0, hi: 50 } as const;
export const MERGE_THEIRS = { lo: 50, hi: 100 } as const;

export function mergeFileName(index: number): string {
  return `file-${index}.ts`;
}

export function mergeChangedNames(lo: number, hi: number): string[] {
  return Array.from({ length: hi - lo }, (_, k) => mergeFileName(lo + k));
}

/** Sorted name lists must match exactly or the comparison is rejected. */
export function assertSameNames(label: string, actual: string[], expected: string[]): void {
  const a = [...actual].sort();
  const e = [...expected].sort();
  if (a.length !== e.length || a.some((name, k) => name !== e[k])) {
    throw new Error(`${label} worktree diverged from its branch: ${a.length} changed files`);
  }
}

/** Tree oids must match or the comparison is rejected. */
export function assertSameTree(actual: string | null, expected: string, message: string): void {
  if (actual !== expected) throw new Error(message);
}
