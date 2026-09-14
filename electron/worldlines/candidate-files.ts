/**
 * Candidate file-listing helpers (worldlines owner).
 *
 * Pure against manager state: the manager passes comparison/candidate state
 * in and renders the results. Listings are capped at MAX_CHANGED_FILES with
 * a truncated flag and uncapped total so details counts stay honest.
 */
import { isAbsolute } from "node:path";
import {
  gitCommittedChanges,
  gitCommitTree,
  gitWorkingChanges,
} from "../worldline-git.js";
import type { WorldlineChangedFile } from "../../shared/types.js";
import type { CandidateState, ComparisonState } from "./types.js";

/** Bound for the changed-file listing sent over IPC (details + export listing). */
export const MAX_CHANGED_FILES = 500;

export function isSafeRelativePath(relPath: string): boolean {
  return relPath.length > 0 && relPath !== "." && relPath.indexOf("\0") === -1 && !isAbsolute(relPath) && !relPath.startsWith("/") && !relPath.split(/[\\/]/).includes("..");
}

/** Files differing from the base plus head-tree source statistics. */
export async function changedFiles(cmp: ComparisonState, cand: CandidateState): Promise<{
  files: WorldlineChangedFile[];
  sourceFiles: number;
  sourceBytes: number;
  truncated: boolean;
  total: number;
}> {
  // The export call site passes comparisons with no base guard of its own.
  if (!cmp.baseCommit) throw new Error("the comparison base is missing");
  // Working tree vs HEAD: staged, unstaged, and untracked changes.
  const working = await gitWorkingChanges(cand.dir);
  // Committed changes since the shared base (A's settled apply and any
  // agent commits; B usually has none).
  const committed = await gitCommittedChanges(cand.dir, cmp.baseCommit, "HEAD");
  const tree = await gitCommitTree(cand.dir, "HEAD");
  const byPath = new Map<string, WorldlineChangedFile>();
  // Committed first, working tree last: both consumers (comparison details
  // and export) read the live working tree, so the working-tree state wins
  // every collision — including a re-created file over a committed deletion.
  for (const change of committed) {
    byPath.set(change.relPath, { relPath: change.relPath, status: change.status });
  }
  for (const change of working) {
    byPath.set(change.relPath, { relPath: change.relPath, status: change.status });
  }
  let sourceFiles = tree.length;
  let sourceBytes = 0;
  for (const entry of tree) {
    sourceBytes += entry.size;
  }
  const files = [...byPath.values()].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  const truncated = files.length > MAX_CHANGED_FILES;
  return {
    files: truncated ? files.slice(0, MAX_CHANGED_FILES) : files,
    sourceFiles,
    sourceBytes,
    truncated,
    total: files.length,
  };
}
