/**
 * App-owned snapshot store client.
 *
 * The store is a bare Git repository outside the source repository. It
 * captures the source working-tree bytes byte-for-byte and reads source
 * objects through a read-only alternate. It never writes the user's Git
 * directory.
 *
 * Every operation runs in the Rust snapshot core (core-client.ts). This
 * module keeps only the paths, the object format, and the request
 * plumbing. It never spawns Git.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { coreClient } from "./core-client.js";

/** One captured source state in the store. */
export interface SourceState {
  /** The synthetic commit oid in the store. */
  commit: string;
  /** The captured tree oid. */
  tree: string;
  /** The source HEAD the capture started from, or null when unborn. */
  head: string | null;
  /** The number of captured paths. */
  pathCount: number;
  /** New blob bytes written by this capture. */
  newBlobBytes: number;
  /** The lineage parent commit, or null for the root state. */
  parentCommit: string | null;
  /** Captured at. */
  ts: number;
}

interface CaptureBudget {
  maxPaths?: number;
  maxFileBytes?: number;
  maxNewBlobBytes?: number;
}

interface MaterializeOptions {
  preserveTopLevel?: string[];
}

/** Test seams for capture. The seams fire only in the spike suites. */
interface CaptureHooks {
  /** Rewrite a file after the core opens it, before the core reads it. */
  beforeRead?: Array<{ path: string; content: string }>;
}

/** The result of a three-way merge (WORLDLINES section 6.10). */
interface MergeResult {
  ok: boolean;
  /** The merged tree oid (valid only when ok). */
  tree: string | null;
  /** Conflicted paths, relative to the Git root. */
  conflicts: string[];
  /** The reason the merge was rejected before running. */
  reason?: string;
}

/** The result of a repository preflight (WORLDLINES section 4). */
interface PreflightResult {
  ok: boolean;
  reasons: string[];
}

/**
 * The app-owned snapshot store for one opened project session.
 */
export class SnapshotStore {
  readonly dir: string;
  /** The bare Git directory of the store. */
  readonly gitDir: string;
  /** The canonical source Git root this store serves. */
  readonly sourceRoot: string;
  /** The canonical common Git directory of the source repository. */
  readonly sourceGitDir: string;
  readonly objectFormat: "sha1" | "sha256";

  private constructor(dir: string, sourceRoot: string, sourceGitDir: string, objectFormat: "sha1" | "sha256") {
    this.dir = dir;
    this.gitDir = join(dir, "git");
    this.sourceRoot = sourceRoot;
    this.sourceGitDir = sourceGitDir;
    this.objectFormat = objectFormat;
  }

  /** Create the store and link a read-only alternate to the source objects. */
  static async create(dir: string, sourceRoot: string, sourceGitDir: string, objectFormat: "sha1" | "sha256"): Promise<SnapshotStore> {
    await coreClient.request({
      op: "store-create",
      storeDir: dir,
      sourceGitDir,
      objectFormat,
    });
    return new SnapshotStore(dir, sourceRoot, sourceGitDir, objectFormat);
  }

  /** The request payload shared by every store op. */
  private payload(op: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { op, storeDir: this.dir, sourceRoot: this.sourceRoot, sourceGitDir: this.sourceGitDir, objectFormat: this.objectFormat, ...extra };
  }

  /**
   * Capture the source working tree byte-for-byte.
   * Reads tracked, staged, unstaged, and non-ignored untracked files.
   * Accepts only regular files and symlinks.
   * Returns a synthetic commit in the store.
   */
  async capture(
    head: string | null,
    parentCommit: string | null,
    budget: CaptureBudget = {},
    hooks: CaptureHooks = {},
    source?: { root: string; gitDir: string },
  ): Promise<SourceState> {
    return coreClient.request(
      this.payload("capture", {
        head,
        parentCommit,
        budget,
        hooks,
        captureRoot: source?.root,
        captureGitDir: source?.gitDir,
      }),
    ) as Promise<SourceState>;
  }

  /**
   * Incremental capture (WORLDLINES section 6.4): reuse the parent tree
   * and update only the hinted paths. The watcher hints are the delta;
   * the reconcile map catches missed events by comparing precomputed
   * blob hashes against the parent tree.
   */
  async captureIncremental(
    parentCommit: string,
    hints: string[],
    reconcile: Array<{ relPath: string; oid: string }>,
    budget: CaptureBudget = {},
    hooks: CaptureHooks = {},
    source?: { root: string; gitDir: string },
  ): Promise<SourceState> {
    return coreClient.request(
      this.payload("capture-incremental", {
        parentCommit,
        hints,
        reconcile,
        budget,
        hooks,
        captureRoot: source?.root,
        captureGitDir: source?.gitDir,
      }),
    ) as Promise<SourceState>;
  }

  /**
   * Materialize a captured state into a directory.
   * Remove stale source paths and preserve only the requested runtime paths.
   */
  async materialize(stateCommit: string, targetDir: string, options: MaterializeOptions = {}): Promise<void> {
    await coreClient.request(this.payload("materialize", { stateId: stateCommit, targetDir, preserveTopLevel: options.preserveTopLevel }));
  }

  /**
   * Three-way merge of the candidate head into the current primary state.
   * The commit graph provides the base: every state chains from the root
   * primary state, so its LCA is that root (WORLDLINES section 6.10).
   * Detects conflicts without writing any primary path.
   */
  async merge3(candidateCommit: string, primaryCommit: string): Promise<MergeResult> {
    const res = (await coreClient.request(this.payload("merge3", { ours: candidateCommit, theirs: primaryCommit }))) as { result: MergeResult };
    return res.result;
  }

  /** The changed paths between two store states. */
  async diffTree(stateA: string, stateB: string): Promise<Array<{ relPath: string; status: "created" | "modified" | "deleted" }>> {
    const res = (await coreClient.request(this.payload("diff-tree", { stateA, stateB }))) as { changes: Array<{ relPath: string; status: "created" | "modified" | "deleted" }> };
    return res.changes;
  }

  /** The tree paths of a state (for deletion detection). */
  async treePaths(state: string): Promise<Set<string>> {
    const res = (await coreClient.request(this.payload("tree-paths", { stateId: state }))) as { paths: string[] };
    return new Set(res.paths);
  }

  /** The target of a symlink at a state path, or null when not a link. */
  async symlinkTarget(state: string, relPath: string): Promise<string | null> {
    const res = (await coreClient.request(this.payload("symlink-target", { stateId: state, relPath }))) as { target: string | null };
    return res.target;
  }

  /** Read one blob from a state as bytes, or null when the path is absent. */
  async readBlob(state: string, relPath: string): Promise<Buffer | null> {
    const res = (await coreClient.request(this.payload("read-blob", { stateId: state, relPath }))) as { content: string | null };
    if (res.content === null) return null;
    return Buffer.from(res.content, "base64");
  }

  /** Remove a store-local state ref (eviction). */
  async unref(commit: string): Promise<void> {
    await coreClient.request(this.payload("unref", { commit }));
  }

  /**
   * Preflight the source repository for byte-exact capture.
   * Returns every failing condition with a stable reason string.
   */
  async preflightRepo(opts: { worldsRoot?: string } = {}): Promise<PreflightResult> {
    const res = (await coreClient.request({
      op: "preflight",
      sourceRoot: this.sourceRoot,
      sourceGitDir: this.sourceGitDir,
      worldsRoot: opts.worldsRoot ?? null,
    })) as { result: PreflightResult };
    return res.result;
  }

  /** Create the comparison template (init, base bytes, commit, pack). */
  async template(opts: { stateId: string; targetDir: string; sourceObjectsDir: string }): Promise<void> {
    await coreClient.request(this.payload("template", opts));
  }

  /** Apply a state over a candidate directory and commit it. */
  async applyState(opts: { stateId: string; targetDir: string; preserveTopLevel?: string[] }): Promise<void> {
    await coreClient.request(this.payload("apply-state", opts));
  }

  /** Delete the whole store. Idempotent. */
  async destroy(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
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

/** Pair-creation disk reserve for Worldline candidates. */
export const MIN_WORLDS_FREE_BYTES = 512 * 1024 * 1024;

/** Free disk bytes on the volume that holds `path`. Returns null on error. */
export async function freeDiskBytes(path: string): Promise<number | null> {
  try {
    const out = await new Promise<string>((res) => {
      execFile("df", ["-k", path], { encoding: "utf8", maxBuffer: 1024 * 1024 }, (_err, stdout) => res(stdout));
    });
    const lines = out.trim().split("\n");
    const header = lines[0]?.split(/\s+/) ?? [];
    // macOS says "Available"; Linux says "Avail".
    const availIdx = header.findIndex((h) => h.startsWith("Avail"));
    const row = lines[1]?.split(/\s+/) ?? [];
    const avail = Number(row[availIdx]);
    return Number.isFinite(avail) ? avail * 1024 : null;
  } catch {
    return null;
  }
}

/** True when the platform provides a reliable recursive watcher. */
export function platformHasRecursiveWatcher(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}

/** True when the platform binary `sandbox-exec` exists (macOS). */
export function platformHasSandboxExec(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    readFileSync("/usr/bin/sandbox-exec");
    return true;
  } catch {
    return false;
  }
}

/** True when the platform provides copy-on-write clones (`cp -c`). */
export function platformHasCopyOnWrite(): boolean {
  return process.platform === "darwin";
}
