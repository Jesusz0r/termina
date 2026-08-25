/**
 * Line-level after-document changes. The live editor paints these lines
 * when the agent writes a file.
 */

const MAX_PAINT_LINES = 500;
const MAX_LCS_CELLS = 400_000;

function splitLines(text: string): string[] {
  if (text.length === 0) return [""];
  return text.split(/\r\n|\n|\r/);
}

/**
 * 1-based line numbers in `after` that the agent inserted or replaced.
 * A pure deletion marks the next surviving line so the gutter still moves.
 */
export function changedLinesInAfter(before: string, after: string): number[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let aEnd = a.length;
  let bEnd = b.length;
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }
  if (start === aEnd && start === bEnd) return [];

  const aMid = a.slice(start, aEnd);
  const bMid = b.slice(start, bEnd);
  if (bMid.length === 0) {
    const next = start < b.length ? start + 1 : b.length;
    return next > 0 ? [next] : [];
  }

  const inserted = insertedIndices(aMid, bMid);
  const lines: number[] = [];
  for (const i of inserted) {
    lines.push(start + i + 1);
    if (lines.length >= MAX_PAINT_LINES) break;
  }
  if (lines.length === 0) {
    const next = start < b.length ? start + 1 : b.length;
    if (next > 0) lines.push(next);
  }
  return lines;
}

function insertedIndices(a: string[], b: string[]): number[] {
  if (a.length === 0) return b.map((_, i) => i);
  if (a.length * b.length <= MAX_LCS_CELLS) return insertedByLcs(a, b);
  return insertedByGreedy(a, b);
}

/** LCS backtrack: every `b` line that is not in the LCS is a change. */
function insertedByLcs(a: string[], b: string[]): number[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1];
    const row = dp[i];
    const prev = dp[i - 1];
    for (let j = 1; j <= m; j++) {
      row[j] = ai === b[j - 1] ? prev[j - 1] + 1 : prev[j] > row[j - 1] ? prev[j] : row[j - 1];
    }
  }
  const inserted: number[] = [];
  let i = n;
  let j = m;
  while (j > 0) {
    if (i > 0 && a[i - 1] === b[j - 1] && dp[i][j] === dp[i - 1][j - 1] + 1) {
      i--;
      j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j]) {
      i--;
    } else {
      inserted.push(j - 1);
      j--;
    }
  }
  inserted.reverse();
  return inserted;
}

/**
 * Ordered greedy match for files too large for an LCS table. Each `b` line
 * takes the next unused equal `a` line. Unmatched `b` lines are changes.
 */
function insertedByGreedy(a: string[], b: string[]): number[] {
  const positions = new Map<string, number[]>();
  for (let i = 0; i < a.length; i++) {
    const list = positions.get(a[i]);
    if (list) list.push(i);
    else positions.set(a[i], [i]);
  }
  const cursor = new Map<string, number>();
  let lastA = -1;
  const inserted: number[] = [];
  for (let j = 0; j < b.length; j++) {
    const line = b[j];
    const list = positions.get(line);
    if (!list) {
      inserted.push(j);
      continue;
    }
    let k = cursor.get(line) ?? 0;
    while (k < list.length && list[k] <= lastA) k++;
    cursor.set(line, k);
    if (k >= list.length) {
      inserted.push(j);
      continue;
    }
    lastA = list[k];
    cursor.set(line, k + 1);
  }
  return inserted;
}
