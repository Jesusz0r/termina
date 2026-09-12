/**
 * Candidate file-listing helpers (worldlines owner).
 *
 * Pure against manager state: the manager passes comparison/candidate state
 * in and renders the results. Extracted from manager.ts (issue #38) with no
 * behavior change.
 */
import { isAbsolute } from "node:path";
import {
  gitCommittedChanges,
  gitCommitTree,
  gitWorkingChanges,
} from "../worldline-git.js";
import type { WorldlineChangedFile } from "../../shared/types.js";
import type { CandidateState, ComparisonState } from "./types.js";

export function isSafeRelativePath(relPath: string): boolean {
  return relPath.length > 0 && relPath !== "." && relPath.indexOf("\0") === -1 && !isAbsolute(relPath) && !relPath.startsWith("/") && !relPath.split(/[\\/]/).includes("..");
}

/** Files differing from the base plus head-tree source statistics. */
export async function changedFiles(cmp: ComparisonState, cand: CandidateState): Promise<{ files: WorldlineChangedFile[]; sourceFiles: number; sourceBytes: number }> {
  // Working tree vs HEAD: staged, unstaged, and untracked changes.
  const status = await gitWorkingChanges(cand.dir);
  // Committed changes since the shared base (A's settled apply and any
  // agent commits; B usually has none).
  const committed = await gitCommittedChanges(cand.dir, cmp.baseCommit!, "HEAD");
  const tree = await gitCommitTree(cand.dir, "HEAD");
  const byPath = new Map<string, WorldlineChangedFile>();
  const set = (relPath: string, status: "created" | "modified" | "deleted"): void => {
    const prev = byPath.get(relPath);
    // A later state wins: deleted beats modified, created beats deleted.
    if (!prev || (status === "deleted" && prev.status !== "deleted") || (status === "created" && prev.status !== "deleted")) {
      byPath.set(relPath, { relPath, status });
    }
  };
  for (const change of status) {
    set(change.relPath, change.status);
  }
  for (const change of committed) {
    set(change.relPath, change.status);
  }
  let sourceFiles = tree.length;
  let sourceBytes = 0;
  for (const entry of tree) {
    sourceBytes += entry.size;
  }
  const files = [...byPath.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { files, sourceFiles, sourceBytes };
}
