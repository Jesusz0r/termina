/**
 * WorldlineManager construction helpers: the fork preflight, candidate head
 * captures, and sandbox read paths. Pure over explicit inputs; main supplies
 * live project state at call time and keeps the manager wiring.
 */
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isErrno } from "../../shared/guards.js";
import { PathLookup } from "../path-lookup.js";
import { sandboxResourceLimitPreflight } from "../sandbox.js";
import {
  MIN_WORLDS_FREE_BYTES,
  freeDiskBytes,
  gitHead,
  gitTopLevel,
  platformHasRecursiveWatcher,
  platformHasSandboxExec,
  type SnapshotStore,
} from "../worldline-git.js";

/** The opened folder has no Git marker that we can see. */
export const GIT_NOT_A_REPO_REASON = "the opened folder is not inside a Git repository";
/** Core/protocol failure or a present `.git` that could not be opened. */
export const GIT_UNREADABLE_REASON = "the Git repository could not be opened";

export type OpenedGitRoot =
  | { ok: true; top: string }
  | { ok: false; reason: typeof GIT_NOT_A_REPO_REASON | typeof GIT_UNREADABLE_REASON };

/**
 * Classify git-top-level for recording/preflight. Core may still collapse
 * corrupt repos to null; a thrown error or a present `.git` is not "not a repo".
 */
export async function classifyOpenedGitRoot(root: string): Promise<OpenedGitRoot> {
  let top: string | null = null;
  try {
    top = await gitTopLevel(root);
  } catch (err) {
    console.warn(`[worldlines] git-top-level failed: ${(err as Error).message}`);
    return { ok: false, reason: GIT_UNREADABLE_REASON };
  }
  if (top) return { ok: true, top };
  if (await gitDirLooksPresent(root)) return { ok: false, reason: GIT_UNREADABLE_REASON };
  return { ok: false, reason: GIT_NOT_A_REPO_REASON };
}

/** True when `.git` exists (or is unreadable) at `root` or an ancestor. */
export async function gitDirLooksPresent(start: string): Promise<boolean> {
  let dir = start;
  for (;;) {
    try {
      await lstat(join(dir, ".git"));
      return true;
    } catch (err) {
      // Missing marker: keep walking. Any other failure means we cannot
      // honestly say this is not a repository.
      if (!isErrno(err, "ENOENT")) return true;
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** Read-only load paths for the sandboxed core (agent-core copy + electron + node). */
export function worldlineAppReadPaths(corePath: string, paths: PathLookup): string[] {
  const out: string[] = [];
  out.push(process.execPath);
  out.push(dirname(dirname(process.execPath)));
  out.push(corePath, dirname(corePath));
  const node = paths.findOnPath("node") ?? process.execPath;
  out.push(node, dirname(node));
  try {
    out.push(paths.cachedRealpath(node));
  } catch {
    /* The configured node path can disappear between checks. */
  }
  return [...new Set(out)];
}

/** The fork preflight (WORLDLINES §4): repository, platform, disk. */
export async function worldlinePreflight(opts: {
  storePromise: Promise<SnapshotStore | null> | null;
  worldsRoot: string;
  primaryRoot: string;
}): Promise<{ ok: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  const store = await opts.storePromise;
  if (store) {
    const repo = await store.preflightRepo({ worldsRoot: opts.worldsRoot });
    reasons.push(...repo.reasons);
  } else if (!opts.primaryRoot) {
    reasons.push(GIT_NOT_A_REPO_REASON);
  } else {
    const classified = await classifyOpenedGitRoot(opts.primaryRoot);
    if (!classified.ok) reasons.push(classified.reason);
  }
  if (!platformHasSandboxExec()) reasons.push("the platform has no sandbox-exec");
  const resourceLimitReason = sandboxResourceLimitPreflight();
  if (resourceLimitReason) reasons.push(resourceLimitReason);
  if (!platformHasRecursiveWatcher()) reasons.push("the platform has no reliable recursive watcher");
  const free = await freeDiskBytes(opts.worldsRoot);
  if (free !== null && free < MIN_WORLDS_FREE_BYTES) {
    reasons.push(`free disk space is below the 512 MB minimum (${Math.floor(free / (1024 * 1024))} MB)`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** Capture a candidate head off the main thread. */
export async function worldlineCaptureHead(
  storePromise: Promise<SnapshotStore | null> | null,
  root: string,
  gitDir: string,
  parent: string | null,
): Promise<{ commit: string; tree: string }> {
  const store = await storePromise;
  if (!store) throw new Error("recording is not available");
  const state = await store.capture(await gitHead(root), parent, {}, {}, { root, gitDir });
  return { commit: state.commit, tree: state.tree };
}

/** Capture the current primary state (details conflict status). */
export async function worldlineCapturePrimary(
  storePromise: Promise<SnapshotStore | null> | null,
  primary: { root: string; lastStateCommit: string | null } | null,
): Promise<string | null> {
  const store = await storePromise;
  if (!primary || !store) return null;
  try {
    const state = await store.capture(await gitHead(primary.root), primary.lastStateCommit);
    return state.commit;
  } catch {
    return null;
  }
}
