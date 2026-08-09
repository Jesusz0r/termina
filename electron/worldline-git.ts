/**
 * App-owned snapshot store.
 *
 * A bare Git repository outside the source repository. It captures the
 * source working-tree bytes byte-for-byte and reads source objects through
 * a read-only alternate. It never writes to the user's Git directory.
 *
 * The store runs Git as argument arrays without a shell. Every command uses
 * a fixed C locale, disabled hooks, disabled pagers, disabled prompts, and
 * no optional locks. The store never runs maintenance in the user's repo.
 */
import { execFile, spawn } from "node:child_process";
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { deflateSync } from "node:zlib";

/** The minimum Git version proven for `merge-tree` (WORLDLINES §4). */
export const MIN_GIT_VERSION = [2, 38, 0];

/** The app identity used for synthetic commits. */
const APP_AUTHOR = "pi-ditor";
const APP_EMAIL = "dev@pi-ditor.local";

/** The empty tree oid (unborn HEAD base). */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Default capture budgets (WORLDLINES §9). */
export const BUDGETS = {
  maxPaths: 100_000,
  maxFileBytes: 64 * 1024 * 1024,
  maxNewBlobBytes: 256 * 1024 * 1024,
} as const;

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

export interface CaptureBudget {
  maxPaths?: number;
  maxFileBytes?: number;
  maxNewBlobBytes?: number;
}

/** Test seams for capture. The hooks fire only in the spike suites. */
export interface CaptureHooks {
  /** Fired after a file is read and verified. */
  onFileRead?: (path: string) => void;
  /** Fired after the file is opened, before its bytes are read. */
  onBeforeRead?: (path: string) => void;
}

/** The result of a three-way merge (WORLDLINES §6.10). */
export interface MergeResult {
  ok: boolean;
  /** The merged tree oid (valid only when ok). */
  tree: string | null;
  /** Conflicted paths, relative to the Git root. */
  conflicts: string[];
  /** The reason the merge was rejected before running. */
  reason?: string;
}

/** The result of a repository preflight (WORLDLINES §4). */
export interface PreflightResult {
  ok: boolean;
  reasons: string[];
}

interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export type { GitResult };

/** Run Git in a directory with the store's safe environment. */
export function runGitIn(dir: string, args: string[], extraEnv: Record<string, string> = {}): Promise<GitResult> {
  return runGit(args, { cwd: dir, env: extraEnv });
}

/** The environment for every store Git command. */
function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_EDITOR: "true",
    GIT_ASKPASS: "true",
    GIT_SSH: "true",
    GIT_EXTERNAL_DIFF: "true",
    GIT_AUTHOR_NAME: APP_AUTHOR,
    GIT_AUTHOR_EMAIL: APP_EMAIL,
    GIT_COMMITTER_NAME: APP_AUTHOR,
    GIT_COMMITTER_EMAIL: APP_EMAIL,
    LC_ALL: "C",
    LANG: "C",
    ...extra,
  };
}

/** Run Git as an argument array without a shell. */
function runGit(args: string[], opts: { cwd?: string; env?: Record<string, string>; input?: Buffer | string } = {}): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...gitEnv(opts.env) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => stdout.push(d));
    child.stderr.on("data", (d: Buffer) => stderr.push(d));
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
    child.on("error", (err) => resolvePromise({ code: -1, stdout: Buffer.alloc(0), stderr: err.message }));
    child.on("close", (code) =>
      resolvePromise({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8") }),
    );
  });
}

/** Parse "2.53.0" style versions. Returns null on an unparsable string. */
function parseGitVersion(raw: string): number[] | null {
  const m = raw.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), m[3] !== undefined ? Number(m[3]) : 0];
}

/** True when versionA >= versionB. */
function versionAtLeast(a: number[], b: number[]): boolean {
  for (let i = 0; i < b.length; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return true;
}

/** The current Git version, or null when Git is missing or unparsable. */
export async function gitVersion(): Promise<number[] | null> {
  const r = await runGit(["--version"]);
  if (r.code !== 0) return null;
  return parseGitVersion(r.stdout.toString("utf8"));
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

/** Resolve a Git directory that may be relative to `cwd`. */
function resolveGitDir(cwd: string, gitDir: string): string {
  return isAbsolute(gitDir) ? resolve(gitDir) : resolve(cwd, gitDir);
}

/** True when the path is inside the app-owned worlds root. */
function insideWorldsRoot(path: string, worldsRoot: string | undefined): boolean {
  if (!worldsRoot) return false;
  if (path === worldsRoot) return true;
  return path.startsWith(worldsRoot + sep);
}

/**
 * The app-owned snapshot store for one opened project session.
 */
export class SnapshotStore {
  readonly dir: string;
  /** The bare Git directory of the store. */
  readonly gitDir: string;
  /** The canonical source Git root this store was created for. */
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
    const store = new SnapshotStore(dir, sourceRoot, sourceGitDir, objectFormat);
    await mkdir(dir, { recursive: true });
    const init = await runGit(["init", "--bare", "--object-format", objectFormat, store.gitDir]);
    if (init.code !== 0) throw new Error(`snapshot store init failed: ${init.stderr}`);
    // Disable gc: the store keeps objects that a gc run would prune.
    await runGit(["config", "gc.auto", "0"], { env: { GIT_DIR: store.gitDir } });
    // Read-only object access to the source repository.
    const altDir = join(store.gitDir, "objects", "info");
    await mkdir(altDir, { recursive: true });
    await writeFile(join(altDir, "alternates"), sourceGitDir + sep + "objects" + "\n", "utf8");
    return store;
  }

  /** Open an existing store without initializing it (worker side). */
  static open(dir: string, sourceRoot: string, sourceGitDir: string, objectFormat: "sha1" | "sha256"): SnapshotStore {
    return new SnapshotStore(dir, sourceRoot, sourceGitDir, objectFormat);
  }

  /** Run Git against the store. */
  private async git(args: string[], opts: { input?: Buffer | string } = {}): Promise<GitResult> {
    return runGit(args, { env: { GIT_DIR: this.gitDir }, input: opts.input });
  }

  /** Run a read-only Git command against the source repository. */
  private async sourceGit(args: string[]): Promise<GitResult> {
    return runGit(args, { cwd: this.sourceRoot });
  }

  /**
   * Preflight the source repository for byte-exact capture.
   * Returns every failing condition with a stable reason string.
   */
  async preflightRepo(opts: { worldsRoot?: string } = {}): Promise<PreflightResult> {
    const reasons: string[] = [];
    const version = await gitVersion();
    if (!version) reasons.push("git is not installed or its version is unparsable");
    else if (!versionAtLeast(version, MIN_GIT_VERSION)) reasons.push(`git ${version.join(".")} is older than the minimum ${MIN_GIT_VERSION.join(".")}`);

    const cwd = this.sourceRoot;
    const top = await this.sourceGit(["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) {
      reasons.push("the opened folder is not inside a Git repository");
      return { ok: reasons.length === 0, reasons };
    }
    // Git reports canonical paths (/private/var/...). Compare canonical forms.
    let cwdCanon = resolve(cwd);
    try {
      cwdCanon = realpathSync(cwd);
    } catch {
      /* the folder vanished — keep the resolved form */
    }
    const topLevel = resolve(top.stdout.toString("utf8").trim());
    if (topLevel !== cwdCanon) reasons.push("the opened folder is not the Git top-level directory");
    if (insideWorldsRoot(cwdCanon, opts.worldsRoot)) reasons.push("the opened folder is inside the app-owned worlds root");

    // Active merge/rebase/cherry-pick/revert state.
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"]) {
      try {
        await stat(join(this.sourceGitDir, marker));
        reasons.push(`the repository has an active ${marker.replace(/_/g, "-").toLowerCase()} operation`);
      } catch {
        /* no marker */
      }
    }
    for (const dir of ["rebase-merge", "rebase-apply"]) {
      try {
        await stat(join(this.sourceGitDir, dir));
        reasons.push("the repository has an active rebase");
        break;
      } catch {
        /* no marker */
      }
    }

    // Unresolved index entries (unmerged paths).
    const unmerged = await this.sourceGit(["ls-files", "-u"]);
    if (unmerged.code === 0 && unmerged.stdout.length > 0) reasons.push("the repository has unresolved index entries");

    // Submodules and gitlinks in the index.
    const staged = await this.sourceGit(["ls-files", "-s"]);
    if (staged.code === 0) {
      const lines = staged.stdout.toString("utf8").split("\n");
      if (lines.some((l) => l.startsWith("160000"))) reasons.push("the project contains a submodule");
    }

    // Sparse checkout and partial clones.
    const sparse = await this.sourceGit(["config", "--get", "core.sparseCheckout"]);
    if (sparse.code === 0 && sparse.stdout.toString("utf8").trim() !== "false") reasons.push("a sparse checkout is active");
    const partial = await this.sourceGit(["config", "--get", "extensions.partialClone"]);
    if (partial.code === 0) reasons.push("a partial clone is active");

    // A source object alternate in the user's repository.
    try {
      await stat(join(this.sourceGitDir, "objects", "info", "alternates"));
      reasons.push("a source object alternate is active");
    } catch {
      /* none */
    }

    // Content-transforming settings that break byte-exact materialization.
    const autocrlf = await this.sourceGit(["config", "--get", "core.autocrlf"]);
    if (autocrlf.code === 0 && autocrlf.stdout.toString("utf8").trim() !== "false") reasons.push("core.autocrlf is not false");
    const eol = await this.sourceGit(["config", "--get", "core.eol"]);
    if (eol.code === 0 && eol.stdout.toString("utf8").trim() !== "native") reasons.push("core.eol is configured");
    const filters = await this.sourceGit(["config", "--get-regexp", "^filter\\."]);
    if (filters.code === 0) reasons.push("a Git clean/smudge filter is configured");
    const diffDrivers = await this.sourceGit(["config", "--get-regexp", "^diff\\."]);
    if (diffDrivers.code === 0) reasons.push("a Git LFS or diff driver is configured");
    const mergeDrivers = await this.sourceGit(["config", "--get-regexp", "^merge\\."]);
    if (mergeDrivers.code === 0) reasons.push("a custom merge driver is configured");

    // Transform-bearing attributes in any tracked .gitattributes file.
    const transformAttrs = /(^|\s)(filter|eol|working-tree-encoding|ident|text|export-subst)(=|\s|$)/;
    const attrFiles = await this.sourceGit(["ls-files", "-z", "--", "*.gitattributes", ".gitattributes", "**/.gitattributes"]);
    if (attrFiles.code === 0 && attrFiles.stdout.length > 0) {
      for (const file of attrFiles.stdout.toString("utf8").split("\0")) {
        if (!file) continue;
        try {
          const content = await readFile(join(this.sourceRoot, file), "utf8");
          if (transformAttrs.test(content)) {
            reasons.push("a .gitattributes file contains content-transforming entries");
            break;
          }
        } catch {
          /* unreadable attributes file — leave as-is */
        }
      }
    }

    return { ok: reasons.length === 0, reasons };
  }

  /**
   * Capture the source working tree byte-for-byte.
   * Reads tracked, staged, unstaged, and non-ignored untracked files.
   * Accepts only regular files and symlinks.
   * Returns a synthetic commit in the store.
   *
   * @param head the current HEAD oid, or null when unborn
   * @param parentCommit the lineage parent for the new commit, or null
   * @param hooks test seams for the spike suites
   */
  async capture(
    head: string | null,
    parentCommit: string | null,
    budget: CaptureBudget = {},
    hooks: CaptureHooks = {},
    source?: { root: string; gitDir: string },
  ): Promise<SourceState> {
    const maxPaths = budget.maxPaths ?? BUDGETS.maxPaths;
    const maxFileBytes = budget.maxFileBytes ?? BUDGETS.maxFileBytes;
    const maxNewBlobBytes = budget.maxNewBlobBytes ?? BUDGETS.maxNewBlobBytes;
    // A promotion captures the candidate head from the candidate tree; the
    // store still owns the synthetic commits. The default is the primary.
    const cwd = source?.root ?? this.sourceRoot;
    const gitCmd = source
      ? (args: string[]) => runGitIn(cwd, args)
      : (args: string[]) => this.sourceGit(args);

    // Enumerate the capture domain: tracked paths plus non-ignored untracked.
    const [tracked, untracked] = await Promise.all([
      gitCmd(["ls-files", "-z"]),
      gitCmd(["ls-files", "-z", "--others", "--exclude-standard"]),
    ]);
    if (tracked.code !== 0 || untracked.code !== 0) {
      throw new Error(`source enumeration failed: ${tracked.stderr || untracked.stderr}`);
    }
    const paths = new Set<string>();
    for (const buf of [tracked.stdout, untracked.stdout]) {
      for (const p of buf.toString("utf8").split("\0")) {
        if (!p) continue;
        if (p.split(sep).some((seg) => seg === ".git")) throw new Error(`nested repository in capture domain: ${p}`);
        paths.add(p);
      }
    }
    if (paths.size > maxPaths) throw new Error(`capture exceeds the ${maxPaths} path budget (${paths.size} paths)`);

    // Hash every file and build the tree entry list.
    const entries: string[] = [];
    const expected = new Map<string, { mode: string; oid: string }>();
    let newBlobBytes = 0;
    // Git sorts tree entries by raw bytes; sort the same way.
    const sorted = [...paths].sort((a, b) => Buffer.from(a, "utf8").compare(Buffer.from(b, "utf8")));
    for (const relPath of sorted) {
      const abs = join(cwd, relPath);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue; // deleted between enumeration and capture — not in the tree
      }
      if (st.isSymbolicLink()) {
        const target = readlinkSync(abs);
        const oid = await this.hashBytes(target);
        newBlobBytes += Buffer.byteLength(target, "utf8");
        entries.push(`120000 blob ${oid}\t${relPath}`);
        expected.set(relPath, { mode: "120000", oid });
        continue;
      }
      if (!st.isFile()) throw new Error(`unsupported file type in capture domain: ${relPath}`);
      if (st.size > maxFileBytes) throw new Error(`file exceeds the ${maxFileBytes} byte budget: ${relPath}`);

      // Open without following symlinks. Verify the file did not change
      // while it was read, and that the path still names the open file.
      let fd: number;
      try {
        fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch {
        continue; // vanished — not in the tree
      }
      const mode = st.mode & 0o111 ? "100755" : "100644";
      const oid = await this.hashFileWithCheck(fd, abs, hooks.onBeforeRead);
      newBlobBytes += st.size;
      entries.push(`${mode} blob ${oid}\t${relPath}`);
      expected.set(relPath, { mode, oid });
      hooks.onFileRead?.(abs);
    }
    if (newBlobBytes > maxNewBlobBytes) throw new Error(`capture exceeds the ${maxNewBlobBytes} new-blob byte budget (${newBlobBytes} bytes)`);

    // Build the tree through a temporary index, then the synthetic commit.
    const tree = await this.writeTree(entries);
    const commit = await this.commitTree(tree, parentCommit);
    await this.updateRef(commit);

    // Read the tree back and verify every expected entry.
    const verify = await this.git(["ls-tree", "-r", "-z", tree]);
    if (verify.code !== 0) throw new Error(`tree verification failed: ${verify.stderr}`);
    const seen = new Map<string, { mode: string; oid: string }>();
    for (const rec of verify.stdout.toString("utf8").split("\0")) {
      if (!rec) continue;
      const tab = rec.indexOf("\t");
      if (tab === -1) continue;
      const meta = rec.slice(0, tab).split(" ");
      seen.set(rec.slice(tab + 1), { mode: meta[0] ?? "", oid: meta[2] ?? "" });
    }
    if (seen.size !== expected.size) throw new Error(`tree verification size mismatch: ${seen.size} vs ${expected.size}`);
    for (const [p, exp] of expected) {
      const got = seen.get(p);
      if (!got || got.mode !== exp.mode || got.oid !== exp.oid) throw new Error(`tree verification mismatch for ${p}`);
    }

    return { commit, tree, head, pathCount: entries.length, newBlobBytes, parentCommit, ts: Date.now() };
  }

  /**
   * Incremental capture (WORLDLINES §6.4): reuse the parent tree and update
   * only the hinted paths. The watcher hints are the delta; the optional
   * reconcile map (watcher cache entries, path → content) catches missed
   * events by comparing git blob hashes against the parent tree.
   */
  async captureIncremental(
    parentCommit: string,
    hints: string[],
    reconcile: Array<{ relPath: string; content: string }>,
    budget: CaptureBudget = {},
    hooks: CaptureHooks = {},
    source?: { root: string; gitDir: string },
  ): Promise<SourceState> {
    const maxFileBytes = budget.maxFileBytes ?? BUDGETS.maxFileBytes;
    const maxNewBlobBytes = budget.maxNewBlobBytes ?? BUDGETS.maxNewBlobBytes;
    const cwd = source?.root ?? this.sourceRoot;
    const parentTree = await this.resolveTree(parentCommit);

    // The capture set: hints plus reconciled cache entries whose git blob
    // differs from the parent tree (missed watcher events).
    const changed = new Map<string, "created" | "modified" | "deleted">();
    for (const h of hints) changed.set(h, changed.has(h) ? changed.get(h)! : "modified");
    if (reconcile.length > 0) {
      // One path-limited ls-tree answers every cached path at once.
      const args = ["ls-tree", parentTree, "-z", "--", ...reconcile.map((r) => r.relPath)];
      const r = await this.git(args);
      const parentBlobs = new Map<string, string>();
      for (const rec of r.stdout.toString("utf8").split("\0")) {
        if (!rec) continue;
        const tab = rec.indexOf("\t");
        if (tab === -1) continue;
        const meta = rec.slice(0, tab).split(" ");
        if (meta[1] === "blob") parentBlobs.set(rec.slice(tab + 1), meta[2]);
      }
      let newBlobBytes = 0;
      for (const { relPath, content } of reconcile) {
        const parentOid = parentBlobs.get(relPath);
        if (parentOid === undefined) continue; // not in the capture domain
        const oid = await this.hashBytes(content);
        if (oid !== parentOid) {
          changed.set(relPath, "modified");
          newBlobBytes += Buffer.byteLength(content, "utf8");
        }
      }
      if (newBlobBytes > maxNewBlobBytes) {
        throw new Error(`capture exceeds the ${maxNewBlobBytes} new-blob byte budget (${newBlobBytes} bytes)`);
      }
    }
    if (changed.size === 0) return { commit: parentCommit, tree: parentTree, head: null, pathCount: 0, newBlobBytes: 0, parentCommit, ts: Date.now() };

    // Seed the temp index from the parent tree, then apply the delta.
    const indexPath = join(this.dir, "tmp", `index-${Math.random().toString(36).slice(2)}`);
    const env = { GIT_DIR: this.gitDir, GIT_INDEX_FILE: indexPath };
    const expected = new Map<string, { mode: string; oid: string }>();
    let newBlobBytes = 0;
    try {
      await mkdir(dirname(indexPath), { recursive: true });
      const rt = await runGit(["read-tree", parentTree], { env });
      if (rt.code !== 0) throw new Error(`read-tree failed: ${rt.stderr}`);
      const entries: string[] = [];
      for (const relPath of changed.keys()) {
        const abs = join(cwd, relPath);
        let st;
        try {
          st = lstatSync(abs);
        } catch {
          changed.set(relPath, "deleted");
        }
        if (st) {
          if (st.isSymbolicLink()) {
            const target = readlinkSync(abs);
            const oid = await this.hashBytes(target);
            newBlobBytes += Buffer.byteLength(target, "utf8");
            entries.push(`120000 blob ${oid}\t${relPath}`);
            expected.set(relPath, { mode: "120000", oid });
            continue;
          }
          if (!st.isFile()) throw new Error(`unsupported file type in capture domain: ${relPath}`);
          if (st.size > maxFileBytes) throw new Error(`file exceeds the ${maxFileBytes} byte budget: ${relPath}`);
          let fd: number;
          try {
            fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
          } catch {
            changed.set(relPath, "deleted");
            continue;
          }
          const mode = st.mode & 0o111 ? "100755" : "100644";
          const oid = await this.hashFileWithCheck(fd, abs, hooks.onBeforeRead);
          newBlobBytes += st.size;
          entries.push(`${mode} blob ${oid}\t${relPath}`);
          expected.set(relPath, { mode, oid });
          hooks.onFileRead?.(abs);
        }
      }
      if (newBlobBytes > maxNewBlobBytes) {
        throw new Error(`capture exceeds the ${maxNewBlobBytes} new-blob byte budget (${newBlobBytes} bytes)`);
      }
      // Apply the delta to the temp index: writes via index-info, removals
      // via force-remove.
      if (entries.length > 0) {
        const up = await runGit(["update-index", "--index-info"], { env, input: entries.join("\n") + "\n" });
        if (up.code !== 0) throw new Error(`update-index failed: ${up.stderr}`);
      }
      const removes = [...changed.keys()].filter((p) => !expected.has(p));
      for (const relPath of removes) {
        const rmRes = await runGit(["update-index", "--force-remove", "--", relPath], { env });
        if (rmRes.code !== 0) throw new Error(`update-index --force-remove failed: ${rmRes.stderr}`);
      }
      const tree = await runGit(["write-tree"], { env });
      if (tree.code !== 0) throw new Error(`write-tree failed: ${tree.stderr}`);
      const treeOid = tree.stdout.toString("utf8").trim();
      const commit = await this.commitTree(treeOid, parentCommit);
      await this.updateRef(commit);

      // Verify every changed entry against the new tree.
      if (expected.size > 0) {
        const verify = await this.git(["ls-tree", "-z", treeOid, "--", ...expected.keys()]);
        if (verify.code !== 0) throw new Error(`tree verification failed: ${verify.stderr}`);
        const seen = new Map<string, { mode: string; oid: string }>();
        for (const rec of verify.stdout.toString("utf8").split("\0")) {
          if (!rec) continue;
          const tab = rec.indexOf("\t");
          if (tab === -1) continue;
          const meta = rec.slice(0, tab).split(" ");
          seen.set(rec.slice(tab + 1), { mode: meta[0] ?? "", oid: meta[2] ?? "" });
        }
        if (seen.size !== expected.size) throw new Error(`tree verification size mismatch: ${seen.size} vs ${expected.size}`);
        for (const [p, exp] of expected) {
          const got = seen.get(p);
          if (!got || got.mode !== exp.mode || got.oid !== exp.oid) throw new Error(`tree verification mismatch for ${p}`);
        }
      }
      return { commit, tree: treeOid, head: null, pathCount: entries.length, newBlobBytes, parentCommit, ts: Date.now() };
    } finally {
      await rm(indexPath, { force: true });
    }
  }

  /**
   * Write raw bytes as a loose blob object in the store.
   * The loose format is zlib(header + bytes); the oid is the hash of
   * header + bytes. Writing objects directly avoids one git spawn per
   * file; the capture spike verifies the format byte-for-byte.
   */
  private async writeBlob(bytes: Buffer): Promise<string> {
    const header = Buffer.from(`blob ${bytes.length}\0`, "utf8");
    const hash = createHash(this.objectFormat === "sha256" ? "sha256" : "sha1");
    hash.update(header);
    hash.update(bytes);
    const oid = hash.digest("hex");
    const loose = join(this.gitDir, "objects", oid.slice(0, 2), oid.slice(2));
    if (!existsSync(loose)) {
      await mkdir(dirname(loose), { recursive: true });
      const tmp = `${loose}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
      await writeFile(tmp, deflateSync(Buffer.concat([header, bytes])), { mode: 0o600 });
      await rename(tmp, loose);
    }
    return oid;
  }

  /** Hash a byte string into a new store blob. */
  private async hashBytes(content: string): Promise<string> {
    return this.writeBlob(Buffer.from(content, "utf8"));
  }

  /**
   * Read an open file descriptor, verify it with fstat before and after,
   * and hash the bytes into the store. Returns the blob oid.
   */
  private async hashFileWithCheck(fd: number, abs: string, onBeforeRead?: (path: string) => void): Promise<string> {
    try {
      const before = fstatSync(fd);
      onBeforeRead?.(abs);
      const { readFileSync } = await import("node:fs");
      const bytes = readFileSync(fd);
      const after = fstatSync(fd);
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error(`file changed while captured: ${abs}`);
      }
      // The path must still name the open file.
      let pathSt;
      try {
        pathSt = lstatSync(abs);
      } catch {
        throw new Error(`file vanished while captured: ${abs}`);
      }
      if (pathSt.dev !== after.dev || pathSt.ino !== after.ino) throw new Error(`file replaced while captured: ${abs}`);
      return this.writeBlob(bytes);
    } finally {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }

  /**
   * Build a tree from flat entries through a temporary index.
   * Handles nested paths; writes one tree object.
   */
  private async writeTree(entries: string[]): Promise<string> {
    const indexPath = join(this.dir, "tmp", `index-${Math.random().toString(36).slice(2)}`);
    await mkdir(dirname(indexPath), { recursive: true });
    try {
      const env = { GIT_DIR: this.gitDir, GIT_INDEX_FILE: indexPath };
      const add = await runGit(["update-index", "--index-info"], { env, input: entries.length ? entries.join("\n") + "\n" : "" });
      if (add.code !== 0) throw new Error(`update-index failed: ${add.stderr}`);
      const wt = await runGit(["write-tree"], { env });
      if (wt.code !== 0) throw new Error(`write-tree failed: ${wt.stderr}`);
      return wt.stdout.toString("utf8").trim();
    } finally {
      await rm(indexPath, { force: true });
    }
  }

  /** Create the synthetic state commit. */
  private async commitTree(tree: string, parent: string | null): Promise<string> {
    const args = ["commit-tree", tree, "-m", "pi-ditor source state"];
    if (parent) args.push("-p", parent);
    const r = await this.git(args);
    if (r.code !== 0) throw new Error(`commit-tree failed: ${r.stderr}`);
    return r.stdout.toString("utf8").trim();
  }

  /** Pin a state commit with a store-local ref so gc never prunes it. */
  private async updateRef(commit: string): Promise<void> {
    const r = await this.git(["update-ref", `refs/pi-ditor/state/${commit}`, commit]);
    if (r.code !== 0) throw new Error(`update-ref failed: ${r.stderr}`);
  }

  /**
   * Materialize a captured state into an empty target directory.
   * Writes raw bytes, symlinks, and the executable bit. No filters run.
   */
  async materialize(stateCommit: string, targetDir: string): Promise<void> {
    const tree = await this.resolveTree(stateCommit);
    const list = await this.git(["ls-tree", "-r", "-z", tree]);
    if (list.code !== 0) throw new Error(`ls-tree failed: ${list.stderr}`);
    const records: Array<{ mode: string; type: string; oid: string; path: string }> = [];
    for (const rec of list.stdout.toString("utf8").split("\0")) {
      if (!rec) continue;
      const tab = rec.indexOf("\t");
      if (tab === -1) continue;
      const meta = rec.slice(0, tab).split(" ");
      if (meta[1] === "tree") continue;
      records.push({ mode: meta[0] ?? "", type: meta[1] ?? "", oid: meta[2] ?? "", path: rec.slice(tab + 1) });
    }
    await mkdir(targetDir, { recursive: true });
    // Read every blob through one batch process.
    const blobs = new Map<string, Buffer>();
    const want = records.filter((r) => r.type === "blob").map((r) => r.oid);
    if (want.length > 0) {
      const all = await this.catFileBatch(want);
      all.forEach((buf, oid) => blobs.set(oid, buf));
    }
    for (const rec of records) {
      const full = join(targetDir, rec.path);
      await mkdir(dirname(full), { recursive: true });
      if (rec.mode === "120000") {
        const target = blobs.get(rec.oid)?.toString("utf8") ?? "";
        await symlink(target, full);
        continue;
      }
      const content = blobs.get(rec.oid);
      if (content === undefined) throw new Error(`missing blob ${rec.oid} while materializing ${rec.path}`);
      await writeFile(full, content, { mode: rec.mode === "100755" ? 0o755 : 0o644 });
    }
  }

  /** Resolve a state commit to its tree oid. */
  private async resolveTree(commit: string): Promise<string> {
    const r = await this.git(["rev-parse", `${commit}^{tree}`]);
    if (r.code !== 0) throw new Error(`resolve tree failed: ${r.stderr}`);
    return r.stdout.toString("utf8").trim();
  }

  /** Read many blobs from the store with one batch process. */
  private async catFileBatch(oids: string[]): Promise<Map<string, Buffer>> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn("git", ["cat-file", "--batch"], { env: { ...process.env, ...gitEnv({ GIT_DIR: this.gitDir }) } });
      const out: Buffer[] = [];
      child.stdout.on("data", (d: Buffer) => out.push(d));
      child.on("error", (err) => reject(err));
      child.on("close", () => {
        const map = new Map<string, Buffer>();
        const buf = Buffer.concat(out);
        let pos = 0;
        while (pos < buf.length) {
          const nl = buf.indexOf(0x0a, pos);
          if (nl === -1) break;
          const header = buf.subarray(pos, nl).toString("utf8");
          const parts = header.split(" ");
          if (parts.length < 3 || parts[1] === "missing") {
            pos = nl + 1;
            continue;
          }
          const size = Number(parts[2]);
          const start = nl + 1;
          map.set(parts[0], buf.subarray(start, start + size));
          pos = start + size + 1; // skip the trailing newline
        }
        resolvePromise(map);
      });
      child.stdin.write(oids.map((o) => `${o}\n`).join(""));
      child.stdin.end();
    });
  }

  /**
   * Three-way merge of the candidate head into the current primary state.
   * The commit graph provides the base: every state chains from the root
   * primary state, so its LCA is that root (WORLDLINES §6.10).
   * Detects conflicts without writing any primary path.
   */
  async merge3(candidateCommit: string, primaryCommit: string): Promise<MergeResult> {
    const r = await this.git(["merge-tree", "--write-tree", "--name-only", "-z", "--no-messages", candidateCommit, primaryCommit]);
    if (r.code !== 0 && r.code !== 1) return { ok: false, tree: null, conflicts: [], reason: `merge-tree failed: ${r.stderr}` };
    const tokens = r.stdout.toString("utf8").split("\0").filter((t) => t.length > 0);
    const tree = tokens[0] ?? null;
    const conflicts = tokens.slice(1);
    return { ok: r.code === 0, tree, conflicts };
  }

  /** Remove a store-local state ref (eviction). */
  async unref(commit: string): Promise<void> {
    await this.git(["update-ref", "-d", `refs/pi-ditor/state/${commit}`]);
  }

  /** The changed paths between two store states (name-status). */
  async diffTree(stateA: string, stateB: string): Promise<Array<{ relPath: string; status: "created" | "modified" | "deleted" }>> {
    const r = await this.git(["diff-tree", "-r", "--name-status", "-z", stateA, stateB]);
    if (r.code !== 0) throw new Error(`diff-tree failed: ${r.stderr}`);
    const out: Array<{ relPath: string; status: "created" | "modified" | "deleted" }> = [];
    const tokens = r.stdout.toString("utf8").split("\0").filter((t) => t.length > 0);
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const kind = tokens[i];
      const path = tokens[i + 1];
      if (kind.startsWith("D")) out.push({ relPath: path, status: "deleted" });
      else if (kind.startsWith("A")) out.push({ relPath: path, status: "created" });
      else if (kind.startsWith("R")) {
        const [oldPath, newPath] = path.split("\t");
        if (newPath) {
          out.push({ relPath: newPath, status: "created" });
          out.push({ relPath: oldPath, status: "deleted" });
        } else out.push({ relPath: path, status: "modified" });
      } else out.push({ relPath: path, status: "modified" });
    }
    return out;
  }

  /** The tree paths of a state (for deletion detection). */
  async treePaths(state: string): Promise<Set<string>> {
    const tree = await this.resolveTree(state);
    const r = await this.git(["ls-tree", "-r", "-z", tree]);
    if (r.code !== 0) throw new Error(`ls-tree failed: ${r.stderr}`);
    const out = new Set<string>();
    for (const rec of r.stdout.toString("utf8").split("\0")) {
      if (!rec) continue;
      const tab = rec.indexOf("\t");
      if (tab === -1) continue;
      if (rec.slice(0, tab).split(" ")[1] === "tree") continue;
      out.add(rec.slice(tab + 1));
    }
    return out;
  }

  /** The target of a symlink at a state path, or null when not a link. */
  async symlinkTarget(state: string, relPath: string): Promise<string | null> {
    const tree = await this.resolveTree(state);
    const r = await this.git(["ls-tree", tree, "--", relPath]);
    if (r.code !== 0) return null;
    const line = r.stdout.toString("utf8").trim();
    if (!line) return null;
    const parts = line.split(/\s+/);
    if (parts[1] !== "blob" || parts[0] !== "120000") return null;
    const map = await this.catFileBatch([parts[2]]);
    return map.get(parts[2])?.toString("utf8") ?? null;
  }

  /** Read one blob from a state (for example a symlink target). */
  async readBlob(state: string, relPath: string): Promise<Buffer | null> {
    const tree = await this.resolveTree(state);
    const r = await this.git(["ls-tree", tree, "--", relPath]);
    if (r.code !== 0 || !r.stdout.toString("utf8").trim()) return null;
    const meta = r.stdout.toString("utf8").trim().split(/\s+/);
    if (meta[1] !== "blob") return null;
    const map = await this.catFileBatch([meta[2]]);
    return map.get(meta[2]) ?? null;
  }

  /** Delete the whole store. Idempotent. */
  async destroy(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}

/** Convenience: the canonical Git top-level directory of a folder. */
export async function gitTopLevel(root: string): Promise<string | null> {
  const r = await runGit(["rev-parse", "--show-toplevel"], { cwd: root });
  if (r.code !== 0) return null;
  return r.stdout.toString("utf8").trim();
}

/** Convenience: the canonical common Git directory of a folder. */
export async function gitCommonDir(root: string): Promise<string | null> {
  const r = await runGit(["rev-parse", "--git-common-dir"], { cwd: root });
  if (r.code !== 0) return null;
  return resolveGitDir(root, r.stdout.toString("utf8").trim());
}

/** Convenience: the current HEAD oid, or null when the repo is unborn. */
export async function gitHead(root: string): Promise<string | null> {
  const r = await runGit(["rev-parse", "HEAD"], { cwd: root });
  if (r.code !== 0) return null;
  return r.stdout.toString("utf8").trim();
}

/** Convenience: the object format of a repository. */
export async function gitObjectFormat(root: string): Promise<"sha1" | "sha256"> {
  const r = await runGit(["rev-parse", "--show-object-format"], { cwd: root });
  if (r.code !== 0) return "sha1";
  return r.stdout.toString("utf8").trim() === "sha256" ? "sha256" : "sha1";
}
