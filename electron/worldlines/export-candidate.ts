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
  MAX_EXPORT_BUNDLES,
  MAX_EXPORT_FILES,
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
  ): Promise<{ ok: boolean; content?: string; error?: string }>;
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
  for (const file of capped) {
    if (!isSafeRelativePath(file.relPath)) continue;
    // Patch format cannot represent newline names; they stay listed only.
    if (file.relPath.includes("\n")) continue;
    let before: string | null = null;
    let after: string | null = null;
    if (file.status !== "created") {
      const base = await ctx.baseFileOf(comparisonId, file.relPath);
      if (base.ok) before = base.content ?? null;
    }
    if (file.status !== "deleted") {
      const head = await ctx.fileOf(comparisonId, label, file.relPath);
      if (head.ok) after = head.content ?? null;
    }
    // Unreadable on both sides: listed in the summary, absent from the patch.
    if (before === null && after === null) continue;
    patchFiles.push({ relPath: file.relPath, before, after });
  }
  if (patchFiles.length === 0) return { ok: false, error: "no exportable file contents" };
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
    evidenceStale: evidence?.stale === true,
  });
  let patch: string;
  try {
    patch = await ctx.buildExportPatch(patchFiles);
  } catch (err) {
    return { ok: false, error: `could not build the export patch: ${err instanceof Error ? err.message : String(err)}` };
  }
  // The gather + patch window is long: refuse to write a bundle for a
  // candidate that was discarded while it ran.
  const fresh = ctx.comparisons.get(comparisonId)?.candidates.get(label);
  if (!fresh || fresh.state === "discarded" || fresh.state === "error") {
    return { ok: false, error: "the candidate was discarded during export" };
  }
  const exportsRoot = join(ctx.worldsRoot, "exports");
  const dir = join(exportsRoot, `${comparisonId}-${label}`);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Confine the bundle inside the app-owned exports root even if a
    // same-user actor planted a symlink along the path.
    const [canonicalRoot, canonicalDir] = await Promise.all([realpath(exportsRoot), realpath(dir)]);
    if (!isInside(canonicalRoot, canonicalDir)) return { ok: false, error: "export bundle escaped its directory" };
    await writeFile(join(canonicalDir, "candidate.patch"), patch, { mode: 0o600 });
    await writeFile(join(canonicalDir, "pr-body.md"), bundle, { mode: 0o600 });
    await writeFile(join(canonicalDir, "metadata.json"), JSON.stringify({
      comparisonId,
      label,
      role: cand.role,
      model: cmp.model,
      baseCommit: cmp.baseCommit,
      exportedAt: new Date().toISOString(),
      files: changed.length,
      truncatedFiles: changed.length > capped.length ? changed.length - capped.length : 0,
    }, null, 2), { mode: 0o600 });
    await pruneExportBundles(canonicalRoot, canonicalDir);
  } catch (err) {
    return { ok: false, error: `could not write the export bundle: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, path: dir };
}

/** Keep only the newest export bundles. Best-effort; never fails export. */
export async function pruneExportBundles(exportsRoot: string, keepDir: string): Promise<void> {
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
