/**
 * Candidate export runner (worldlines owner).
 *
 * Gathers an exportable patch bundle for one live candidate. The manager
 * owns comparison state; this module owns the gather/write/prune flow and
 * takes a narrow context so it never reaches back into the manager.
 * Extracted from manager.ts (issue #38) with no behavior change.
 */
import { lstat as lstatPath, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildExportMarkdown,
  buildSkippedFilesText,
  MAX_EXPORT_BUNDLES,
  MAX_EXPORT_FILES,
  partitionExportPatchFiles,
  type ExportPatchFile,
} from "./export.js";
import { changedFiles, isSafeRelativePath } from "./candidate-files.js";
import { isInside } from "./guards.js";
import type { EvidenceSummary, WorldlineChangedFile } from "../../shared/types.js";
import type { ComparisonState } from "./types.js";

/** Narrow manager context for one export run. */
export interface ExportCandidateContext {
  comparisons: Map<string, ComparisonState>;
  evidenceByComparison: Map<string, EvidenceSummary>;
  buildExportPatch(files: ExportPatchFile[]): Promise<string>;
  worldsRoot: string;
  baseFileOf(comparisonId: string, relPath: string): Promise<{ ok: boolean; content?: string; error?: string }>;
  fileOf(
    comparisonId: string,
    label: "A" | "B",
    relPath: string,
  ): Promise<{ ok: boolean; content?: string; mode?: string; error?: string }>;
  /** Pin the candidate worktree head (a store capture, like details). */
  captureHead(
    comparisonId: string,
    label: "A" | "B",
  ): Promise<{ ok: boolean; commit?: string; tree?: string; error?: string }>;
}

/**
 * Export one candidate as a patch bundle: unified diff plus an evidence
 * summary for a PR body. No git mutation, no network — the bundle lands
 * in the app-owned exports directory for review, `git apply`, or paste.
 */
export async function exportCandidateRun(
  ctx: ExportCandidateContext,
  comparisonId: string,
  label: "A" | "B",
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const cmp = ctx.comparisons.get(comparisonId);
  const cand = cmp?.candidates.get(label);
  if (!cmp || !cand) return { ok: false, error: "candidate not found" };
  if (cand.state === "discarded" || cand.state === "error") {
    return { ok: false, error: "only a live candidate can be exported" };
  }
  // The directory name derives from renderer input: allow only the
  // manager-generated id shape even though lookup already gates it.
  if (!/^cmp-[0-9]+$/.test(comparisonId)) return { ok: false, error: "invalid comparison" };
  // Pin the worktree head before any gather read: a running candidate can
  // move mid-gather and mix moments into one bundle. Stillness is proven by
  // the content-addressed tree: synthetic capture commits embed wall-clock
  // timestamps, so two captures of identical bytes never share a commit.
  const startHead = await ctx.captureHead(comparisonId, label);
  if (!startHead.ok || !startHead.commit || !startHead.tree) {
    return { ok: false, error: `could not pin the candidate head: ${startHead.error ?? "unknown error"}` };
  }
  let changed: WorldlineChangedFile[];
  try {
    changed = (await changedFiles(cmp, cand)).files;
  } catch (err) {
    return { ok: false, error: `could not list candidate changes: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (changed.length === 0) return { ok: false, error: "the candidate has no changes to export" };
  // Bound per-file round-trips and patch size: extra files stay listed in
  // the summary but leave the patch.
  const capped = changed.slice(0, MAX_EXPORT_FILES);
  const patchFiles: ExportPatchFile[] = [];
  // Gather with bounded concurrency: hundreds of sequential round-trips
  // would stretch the torn-read window for a running candidate.
  const EXPORT_GATHER_CONCURRENCY = 8;
  const gathered: Array<ExportPatchFile | null> = new Array(capped.length).fill(null);
  let nextFile = 0;
  const gatherOne = async (file: WorldlineChangedFile): Promise<ExportPatchFile | null> => {
    if (!isSafeRelativePath(file.relPath)) return null;
    // Patch format cannot represent newline names; they stay listed only.
    if (file.relPath.includes("\n")) return null;
    let before: string | null = null;
    let after: string | null = null;
    let mode: string | undefined;
    if (file.status !== "created") {
      const base = await ctx.baseFileOf(comparisonId, file.relPath);
      if (base.ok) before = base.content ?? null;
    }
    if (file.status !== "deleted") {
      const head = await ctx.fileOf(comparisonId, label, file.relPath);
      if (head.ok) {
        after = head.content ?? null;
        mode = head.mode;
      }
    }
    // Unreadable on both sides: listed in the summary, absent from the patch.
    if (before === null && after === null) return null;
    return file.status === "created" ? { relPath: file.relPath, before, after, mode } : { relPath: file.relPath, before, after };
  };
  await Promise.all(
    Array.from({ length: Math.min(EXPORT_GATHER_CONCURRENCY, capped.length) }, async () => {
      while (nextFile < capped.length) {
        const index = nextFile++;
        gathered[index] = await gatherOne(capped[index]!);
      }
    }),
  );
  for (const entry of gathered) {
    if (entry) patchFiles.push(entry);
  }
  if (patchFiles.length === 0) return { ok: false, error: "no exportable file contents" };
  // Stubs never enter candidate.patch (git apply rejects the whole patch
  // when a stub line is followed by another file); they ship as a listing.
  const { patchable, stubs } = partitionExportPatchFiles(patchFiles);
  const evidence = ctx.evidenceByComparison.get(comparisonId);
  const records = evidence?.byCandidate[label] ?? [];
  const bundle = buildExportMarkdown({
    comparisonId,
    label,
    role: cand.role,
    model: cmp.model,
    baseCommit: cmp.baseCommit,
    exportedAt: new Date().toISOString(),
    files: changed.map((file) => ({ relPath: file.relPath, status: file.status })),
    evidence: records.map((record) => ({ kind: record.kind, status: record.status, reason: record.reason })),
    profiles: (evidence?.profiles ?? []).map((profile) => ({ profile: profile.profile, winner: profile.winner })),
    truncatedFiles: changed.length > capped.length ? changed.length - capped.length : 0,
    skippedFiles: stubs.length,
    evidenceStale: evidence?.stale === true,
  });
  let patch: string;
  if (patchable.length === 0) {
    patch = "";
  } else {
    try {
      patch = await ctx.buildExportPatch(patchable);
    } catch (err) {
      return { ok: false, error: `could not build the export patch: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  // The gather + patch window is long: refuse to write a bundle for a
  // candidate that was discarded while it ran, or whose head moved (a
  // running candidate mixes moments across the per-file reads).
  const fresh = ctx.comparisons.get(comparisonId)?.candidates.get(label);
  if (!fresh || fresh.state === "discarded" || fresh.state === "error") {
    return { ok: false, error: "the candidate was discarded during export" };
  }
  const endHead = await ctx.captureHead(comparisonId, label);
  if (!endHead.ok || !endHead.commit || !endHead.tree) {
    return { ok: false, error: `could not re-verify the candidate head: ${endHead.error ?? "unknown error"}` };
  }
  if (endHead.tree !== startHead.tree) {
    return { ok: false, error: "the candidate changed during export; retry when it settles" };
  }
  const exportsRoot = join(ctx.worldsRoot, "exports");
  const dir = join(exportsRoot, `${comparisonId}-${label}`);
  // Return the confined canonical path the bundle was actually written to.
  let bundleDir = dir;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Confine the bundle inside the app-owned exports root even if a
    // same-user actor planted a symlink along the path.
    const [canonicalRoot, canonicalDir] = await Promise.all([realpath(exportsRoot), realpath(dir)]);
    if (!isInside(canonicalRoot, canonicalDir)) return { ok: false, error: "export bundle escaped its directory" };
    bundleDir = canonicalDir;
    await writeFile(join(canonicalDir, "candidate.patch"), patch, { mode: 0o600 });
    await writeFile(join(canonicalDir, "pr-body.md"), bundle, { mode: 0o600 });
    if (stubs.length > 0) {
      await writeFile(join(canonicalDir, "skipped-files.txt"), buildSkippedFilesText(stubs), { mode: 0o600 });
    }
    await writeFile(join(canonicalDir, "metadata.json"), JSON.stringify({
      comparisonId,
      label,
      role: cand.role,
      model: cmp.model,
      baseCommit: cmp.baseCommit,
      headStateId: startHead.commit,
      headTree: startHead.tree,
      exportedAt: new Date().toISOString(),
      files: changed.length,
      truncatedFiles: changed.length > capped.length ? changed.length - capped.length : 0,
      skippedFiles: stubs.length,
    }, null, 2), { mode: 0o600 });
    await pruneExportBundles(canonicalRoot, canonicalDir);
  } catch (err) {
    return { ok: false, error: `could not write the export bundle: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, path: bundleDir };
}

/** Keep only the newest export bundles. Best-effort; never fails export. */
async function pruneExportBundles(exportsRoot: string, keepDir: string): Promise<void> {
  try {
    const names = await readdir(exportsRoot);
    if (names.length <= MAX_EXPORT_BUNDLES) return;
    const stamped: Array<{ dir: string; mtimeMs: number }> = [];
    for (const name of names) {
      // Only manager-generated bundle names are ever removed.
      if (!/^cmp-[0-9]+-[AB]$/.test(name)) continue;
      const full = join(exportsRoot, name);
      if (full === keepDir) continue;
      try {
        // lstat, not stat: a symlink never qualifies as a directory here.
        const info = await lstatPath(full);
        if (!info.isDirectory()) continue;
        stamped.push({ dir: full, mtimeMs: info.mtimeMs });
      } catch {
        continue;
      }
    }
    stamped.sort((a, b) => a.mtimeMs - b.mtimeMs);
    while (stamped.length >= MAX_EXPORT_BUNDLES) {
      const oldest = stamped.shift();
      if (!oldest) break;
      await rm(oldest.dir, { recursive: true, force: true });
    }
  } catch {
    /* Retention is best-effort. */
  }
}
