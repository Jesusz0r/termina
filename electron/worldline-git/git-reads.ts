/**
 * Core git reads.
 *
 * Owns resource hashing, tracked/ignored/working/committed reads,
 * and repository location. Split from electron/worldline-git.ts (issue #38).
 */
import { coreClient } from "./core-process.js";
import { sep } from "node:path";


export type GitFileChange = { relPath: string; status: "created" | "modified" | "deleted" };

export type GitTreeEntry = { path: string; mode: string; size: number };


/** Hash the trust-sensitive agent and project resources in the native core. */
export function trustResourceHashes(agentDir: string, projectRoot: string | null): Promise<Record<string, string>> {
  return coreClient.trustHashes(agentDir, projectRoot);
}


/** List source paths tracked by Git. */
export function gitTrackedFiles(root: string): Promise<string[]> {
  return coreClient.lsTracked(root);
}


/** List ignored, untracked candidate paths according to Git. */
export function gitIgnoredFiles(root: string): Promise<string[]> {
  return coreClient.lsIgnored(root);
}


/** Read working-tree changes, including staged and untracked paths. */
export function gitWorkingChanges(root: string): Promise<GitFileChange[]> {
  return coreClient.repoStatus(root);
}


/** Read committed changes between two revisions. */
export function gitCommittedChanges(root: string, from: string, to: string): Promise<GitFileChange[]> {
  return coreClient.repoDiff(root, from, to);
}


/** Read the recursive file tree of a commit. */
export function gitCommitTree(root: string, commit: string): Promise<GitTreeEntry[]> {
  return coreClient.repoTree(root, commit);
}


/** Read one committed file, or null when it is absent. */
export function gitCommitFile(root: string, commit: string, path: string): Promise<Buffer | null> {
  return coreClient.repoFile(root, commit, path);
}


/** Stop this process's shared native core helper. */
export function disposeWorldlineGitCore(): void {
  coreClient.dispose();
}


/** True when the capture root is the Git top-level or a folder inside it. */
export function captureRootInRepo(captureRoot: string, gitTopLevel: string): boolean {
  return captureRoot === gitTopLevel || captureRoot.startsWith(gitTopLevel + sep);
}


/** Convenience: the canonical Git top-level directory of a folder. */
export async function gitTopLevel(root: string): Promise<string | null> {
  const res = (await coreClient.request({ op: "git-top-level", root })) as { root: string | null };
  return res.root;
}


/** Convenience: the canonical common Git directory of a folder. */
export async function gitCommonDir(root: string): Promise<string | null> {
  const res = (await coreClient.request({ op: "git-common-dir", root })) as { gitDir: string | null };
  return res.gitDir;
}


/** Convenience: the current HEAD oid, or null when the repo is unborn. */
export async function gitHead(root: string): Promise<string | null> {
  const res = (await coreClient.request({ op: "git-head", root })) as { head: string | null };
  return res.head;
}


/** Convenience: the object format of a repository. */
export async function gitObjectFormat(root: string): Promise<"sha1" | "sha256"> {
  const res = (await coreClient.request({ op: "git-object-format", root })) as { format: "sha1" | "sha256" };
  return res.format;
}
