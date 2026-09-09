/**
 * Candidate export builders (WORLDLINES PR/CI export v1).
 *
 * Pure functions: unified patch generation plus the export bundle markdown.
 * The manager gathers file contents and writes the bundle; nothing here
 * touches disk. No `git` CLI anywhere: contents come from the snapshot
 * core (base blobs) and the candidate working tree.
 */

/** One file for the patch: null content means absent on that side. */
export interface ExportPatchFile {
  relPath: string;
  before: string | null;
  after: string | null;
}

/** Files over this size (or with NUL bytes) export as stubs, not hunks. */
export const MAX_EXPORT_FILE_BYTES = 256 * 1024;
/** Export bundles retained under worlds/exports. */
export const MAX_EXPORT_BUNDLES = 20;
/** Candidate files per export: extra files stay listed, never patched. */
export const MAX_EXPORT_FILES = 200;
/** Files over this many lines export as stubs: the O(n*m) diff is bounded. */
export const MAX_EXPORT_FILE_LINES = 2000;
const EXPORT_CONTEXT_LINES = 3;

function splitLines(text: string): string[] {
  return text.split("\n");
}

type Edit = { kind: "equal" | "del" | "add"; line: string };

function diffLines(before: string[], after: string[]): Edit[] {
  // Full table backtrack; capped file sizes keep it bounded.
  const m = before.length;
  const n = after.length;
  const table: Uint16Array[] = [new Uint16Array(n + 1)];
  for (let i = 1; i <= m; i++) {
    const row = new Uint16Array(n + 1);
    for (let j = 1; j <= n; j++) {
      row[j] = before[i - 1] === after[j - 1] ? table[i - 1][j - 1] + 1 : Math.max(table[i - 1][j], row[j - 1]);
    }
    table.push(row);
  }
  const edits: Edit[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && before[i - 1] === after[j - 1]) {
      edits.push({ kind: "equal", line: before[i - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || table[i][j - 1] >= table[i - 1][j])) {
      edits.push({ kind: "add", line: after[j - 1]! });
      j--;
    } else {
      edits.push({ kind: "del", line: before[i - 1]! });
      i--;
    }
  }
  return edits.reverse();
}

function hunkHeader(aStart: number, aCount: number, bStart: number, bCount: number): string {
  const range = (start: number, count: number): string => (count === 1 ? `${start}` : `${start},${count}`);
  return `@@ -${range(aStart, aCount)} +${range(bStart, bCount)} @@`;
}

/** Unified diff hunks for one file pair. Empty when identical. */
export function unifiedFileDiff(before: string | null, after: string | null): string[] {
  const beforeText = before ?? "";
  const afterText = after ?? "";
  if (beforeText === afterText) return [];
  const beforeLines = before === null ? [] : splitLines(beforeText);
  const afterLines = after === null ? [] : splitLines(afterText);
  // Drop the artifact empty tail that a trailing newline produces.
  if (before !== null && beforeText.endsWith("\n")) beforeLines.pop();
  if (after !== null && afterText.endsWith("\n")) afterLines.pop();
  const edits = diffLines(beforeLines, afterLines);
  // Group changed edit indices; a gap of context-or-less merges hunks.
  const groups: number[][] = [];
  let current: number[] = [];
  let lastChange = -Infinity;
  for (let idx = 0; idx < edits.length; idx++) {
    if (edits[idx]!.kind === "equal") continue;
    if (idx - lastChange > EXPORT_CONTEXT_LINES * 2 && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(idx);
    lastChange = idx;
  }
  if (current.length > 0) groups.push(current);
  const out: string[] = [];
  for (const group of groups) {
    const start = Math.max(0, group[0]! - EXPORT_CONTEXT_LINES);
    const end = Math.min(edits.length, group[group.length - 1]! + EXPORT_CONTEXT_LINES + 1);
    let aNum = 1;
    let bNum = 1;
    for (let idx = 0; idx < start; idx++) {
      const edit = edits[idx]!;
      if (edit.kind !== "add") aNum++;
      if (edit.kind !== "del") bNum++;
    }
    const body: string[] = [];
    let aCount = 0;
    let bCount = 0;
    for (let idx = start; idx < end; idx++) {
      const edit = edits[idx]!;
      if (edit.kind === "equal") {
        body.push(` ${edit.line}`);
        aCount++;
        bCount++;
      } else if (edit.kind === "del") {
        body.push(`-${edit.line}`);
        aCount++;
      } else {
        body.push(`+${edit.line}`);
        bCount++;
      }
    }
    out.push(hunkHeader(aCount === 0 ? aNum - 1 : aNum, aCount, bCount === 0 ? bNum - 1 : bNum, bCount));
    out.push(...body);
  }
  return out;
}

function isBinary(text: string): boolean {
  return text.includes("\0");
}

/** Full unified patch for a candidate file set, sorted by path. */
export function buildUnifiedPatch(files: ExportPatchFile[]): string {
  const out: string[] = [];
  const sorted = [...files].sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
  for (const file of sorted) {
    const devNull = "/dev/null";
    const from = file.before === null ? devNull : `a/${file.relPath}`;
    const to = file.after === null ? devNull : `b/${file.relPath}`;
    const beforeSize = file.before === null ? 0 : Buffer.byteLength(file.before, "utf8");
    const afterSize = file.after === null ? 0 : Buffer.byteLength(file.after, "utf8");
    const beforeLines = file.before === null ? 0 : splitLines(file.before).length;
    const afterLines = file.after === null ? 0 : splitLines(file.after).length;
    const stub =
      (file.before !== null && (isBinary(file.before) || beforeSize > MAX_EXPORT_FILE_BYTES || beforeLines > MAX_EXPORT_FILE_LINES)) ||
      (file.after !== null && (isBinary(file.after) || afterSize > MAX_EXPORT_FILE_BYTES || afterLines > MAX_EXPORT_FILE_LINES));
    out.push(`diff --git ${from} ${to}`);
    if (stub) {
      out.push(`Binary file changed (${beforeSize} -> ${afterSize} bytes)`);
      continue;
    }
    if (file.before === null) out.push("new file mode 100644");
    if (file.after === null) out.push("deleted file mode 100644");
    out.push(`--- ${from}`);
    out.push(`+++ ${to}`);
    out.push(...unifiedFileDiff(file.before, file.after));
  }
  return out.length > 0 ? `${out.join("\n")}\n` : "";
}

export interface ExportEvidenceEntry {
  kind: string;
  status: string;
  reason: string | null;
}

export interface ExportBundleInput {
  comparisonId: string;
  label: string;
  role: string;
  model: string | null;
  baseCommit: string | null;
  exportedAt: string;
  files: Array<{ relPath: string; status: string }>;
  evidence: ExportEvidenceEntry[];
  profiles: Array<{ profile: string; winner: string }>;
  /** Files listed but left out of the patch by the file cap. */
  truncatedFiles?: number;
  /** True when the candidate ran again after the evidence. */
  evidenceStale?: boolean;
}

/** PR-body markdown: what changed, what the evidence says. */
export function buildExportMarkdown(input: ExportBundleInput): string {
  const lines = [
    `# Candidate ${input.label} export — ${input.comparisonId}`,
    ``,
    `- Role: ${input.role}`,
    `- Model: ${input.model ?? "unknown"}`,
    `- Base commit: ${input.baseCommit ?? "unknown"}`,
    `- Exported: ${input.exportedAt}`,
    ``,
    `## Files (${input.files.length})`,
    ``,
  ];
  for (const file of input.files) {
    lines.push(`- \`${file.relPath}\` (${file.status})`);
  }
  if ((input.truncatedFiles ?? 0) > 0) {
    lines.push(`- …and ${input.truncatedFiles} more files listed only (patch file cap).`);
  }
  lines.push(``, `## Evidence`, ``);
  if (input.evidenceStale) {
    lines.push(`> Stale: the candidate ran again after this evidence. Re-run evidence before relying on it.`, ``);
  }
  if (input.evidence.length === 0) {
    lines.push(`No evidence records.`);
  } else {
    lines.push(`| Kind | Status | Reason |`);
    lines.push(`| --- | --- | --- |`);
    for (const record of input.evidence) {
      lines.push(`| ${record.kind} | ${record.status} | ${record.reason ?? "—"} |`);
    }
  }
  if (input.profiles.length > 0) {
    lines.push(``, `## Challenge profiles`, ``);
    for (const profile of input.profiles) {
      lines.push(`- ${profile.profile}: ${profile.winner}`);
    }
  }
  lines.push(``);
  return lines.join("\n");
}
