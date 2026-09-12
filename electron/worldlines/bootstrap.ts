/**
 * WorldlineManager construction helpers: the fork preflight, candidate head
 * captures, and sandbox read paths. Pure over explicit inputs; main supplies
 * live project state at call time and keeps the manager wiring.
 */
import { dirname } from "node:path";
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
  } else {
    // No store: the folder is not a recordable repository.
    const top = opts.primaryRoot ? await gitTopLevel(opts.primaryRoot).catch(() => null) : null;
    if (!top) reasons.push("the opened folder is not inside a Git repository");
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
