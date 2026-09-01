/**
 * Phase 0 spike: byte-exact source capture.
 *
 * Proves that the app-owned snapshot store captures working-tree bytes
 * byte-for-byte across staged, unstaged, untracked, binary, executable,
 * symlink, renamed, and deleted files, without touching the user's Git
 * repository. Also proves round-trip materialization, unborn HEAD support,
 * content-filter preflight rejection, budgets, blob dedupe, mid-read change
 * detection, and identity-bound repository/worktree swaps
 * (WORLDLINES §7 Phase 0, §10 worldline-capture-test).
 */
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SnapshotStore, boundPromotionOpenDirectory, captureRootInRepo, gitHead, gitObjectFormat, gitTopLevel, gitCommonDir } from "../../electron/worldline-git.js";

export default async function run(log: (msg: string) => void) {
  const STORE_OBJECT_BATCH_BOUNDARY = 4_096;
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, ok: boolean, detail = "") => {
    results.push({ name, ok, detail });
    log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  };

  const work = mkdtempSync(join(tmpdir(), "wline-capture-"));
  const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const storeGit = (store: SnapshotStore, args: string[]) => execFileSync("git", args, { env: { ...process.env, GIT_DIR: store.gitDir } });
  const coreBin = process.env.TERMINA_CORE_BIN ?? join(process.cwd(), "core", "target", "release", "termina-core");
  const promotionIdentity = (path: string): { dev: string; ino: string } => {
    const info = lstatSync(path, { bigint: true });
    return { dev: String(info.dev), ino: String(info.ino) };
  };
  const materializeState = async (store: SnapshotStore, state: string, target: string) => {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const binding = await boundPromotionOpenDirectory({ path: target, expectedIdentity: promotionIdentity(target) });
    await store.materialize(state, target, { boundRootIdentity: binding });
  };
  const corePayload = (store: SnapshotStore, op: string, extra: Record<string, unknown> = {}) => ({
    op,
    storeDir: store.dir,
    sourceRoot: store.sourceRoot,
    sourceGitDir: store.sourceGitDir,
    objectFormat: store.objectFormat,
    ...extra,
    storeGeneration: store.lifecycle.generation,
    storeIdentity: store.lifecycle.identity,
    storeGitIdentity: store.lifecycle.git.git,
    storeGitObjectsIdentity: store.lifecycle.git.objects,
    storeGitObjectsInfoIdentity: store.lifecycle.git.objectsInfo,
    storeGitObjectsPackIdentity: store.lifecycle.git.objectsPack,
    storeGitRefsIdentity: store.lifecycle.git.refs,
    storeGitRefsHeadsIdentity: store.lifecycle.git.refsHeads,
    storeGitRefsTagsIdentity: store.lifecycle.git.refsTags,
  });
  const startCoreRequest = (payload: Record<string, unknown>) => {
    const child = spawn(coreBin, [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const settled = new Promise<Record<string, unknown>>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", () => {
        const line = stdout.trim().split("\n").filter(Boolean).at(-1);
        if (!line) return reject(new Error(`core returned no response: ${stderr}`));
        const response = JSON.parse(line) as Record<string, unknown>;
        if (response.ok === true) resolve(response);
        else reject(new Error(String(response.error ?? stderr ?? "core request failed")));
      });
    });
    child.stdin.end(`${JSON.stringify({ ...payload, requestId: `capture-spike-${Date.now()}-${Math.random()}` })}\n`);
    return { child, settled };
  };
  const requestCore = (payload: Record<string, unknown>) => startCoreRequest(payload).settled;
  const waitForMarker = async (path: string) => {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if (existsSync(path)) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`timed out waiting for marker ${path}`);
  };
  const blobOid = (bytes: Buffer) => createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex");
  const looseBlobPath = (store: SnapshotStore, oid: string) => join(store.gitDir, "objects", oid.slice(0, 2), oid.slice(2));
  const looseObjectSet = (store: SnapshotStore) => {
    const objects = join(store.gitDir, "objects");
    const result: string[] = [];
    for (const fanout of readdirSync(objects, { withFileTypes: true })) {
      if (!fanout.isDirectory() || !/^[0-9a-f]{2}$/.test(fanout.name)) continue;
      for (const object of readdirSync(join(objects, fanout.name), { withFileTypes: true })) {
        if (object.isFile() && /^[0-9a-f]+$/.test(object.name)) result.push(`${fanout.name}${object.name}`);
      }
    }
    return result.sort();
  };
  const storeRefSet = (store: SnapshotStore) =>
    storeGit(store, ["for-each-ref", "--format=%(refname):%(objectname)", "refs/termina"])
      .toString("utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .sort();
  const replaceOnlyIndexOid = (repoDir: string, oid: string) => {
    const indexPath = join(repoDir, ".git", "index");
    const index = readFileSync(indexPath);
    if (index.toString("ascii", 0, 4) !== "DIRC" || index.readUInt32BE(4) !== 2 || index.readUInt32BE(8) !== 1) {
      throw new Error("forged-index fixture requires one version-2 index entry");
    }
    Buffer.from(oid, "hex").copy(index, 12 + 40);
    createHash("sha1").update(index.subarray(0, -20)).digest().copy(index, index.length - 20);
    writeFileSync(indexPath, index);
  };

  // ------------------------------------------------------------------ setup
  const repo = join(work, "repo");
  mkdirSync(repo);
  git(["init", "-q"], repo);
  git(["config", "user.email", "t@t"], repo);
  git(["config", "user.name", "t"], repo);
  git(["config", "commit.gpgsign", "false"], repo);

  // Committed baseline.
  writeFileSync(join(repo, "tracked.txt"), "v1\n");
  writeFileSync(join(repo, "staged.txt"), "s1\n");
  writeFileSync(join(repo, "exec.sh"), "#!/bin/sh\necho one\n");
  writeFileSync(join(repo, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
  writeFileSync(join(repo, "deleted.txt"), "old\n");
  writeFileSync(join(repo, "renamed-old.txt"), "rename me\n");
  mkdirSync(join(repo, "nested", "dir"), { recursive: true });
  writeFileSync(join(repo, "nested", "dir", "file.ts"), "export const x = 1;\n");
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(repo, "ignored.txt"), "never captured\n");
  git(["add", "-A"], repo);
  git(["commit", "-qm", "base"], repo);

  // Working-tree chaos: unstaged edit, staged edit, untracked, exec bit,
  // symlink, staged rename, deleted tracked file.
  writeFileSync(join(repo, "tracked.txt"), "v2\n"); // unstaged
  writeFileSync(join(repo, "staged.txt"), "s2\n"); // staged
  git(["add", "staged.txt"], repo);
  writeFileSync(join(repo, "untracked.txt"), "u1\n"); // untracked
  git(["update-index", "--chmod=+x", "exec.sh"], repo);
  chmodSync(join(repo, "exec.sh"), 0o755); // the disk bit is the capture truth
  writeFileSync(join(repo, "exec.sh"), "#!/bin/sh\necho three\n"); // content after chmod
  symlinkSync("tracked.txt", join(repo, "link.txt"));
  symlinkSync("missing-target", join(repo, "dangling-link.txt"));
  git(["mv", "renamed-old.txt", "renamed-new.txt"], repo); // staged rename
  rmSync(join(repo, "deleted.txt")); // tracked, deleted from disk

  const expected: Record<string, { mode: string; bytes?: Buffer; symlink?: string }> = {
    ".gitignore": { mode: "100644", bytes: Buffer.from("ignored.txt\n") },
    "tracked.txt": { mode: "100644", bytes: Buffer.from("v2\n") },
    "staged.txt": { mode: "100644", bytes: Buffer.from("s2\n") },
    "untracked.txt": { mode: "100644", bytes: Buffer.from("u1\n") },
    "exec.sh": { mode: "100755", bytes: Buffer.from("#!/bin/sh\necho three\n") },
    "blob.bin": { mode: "100644", bytes: Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]) },
    "link.txt": { mode: "120000", symlink: "tracked.txt" },
    "dangling-link.txt": { mode: "120000", symlink: "missing-target" },
    "nested/dir/file.ts": { mode: "100644", bytes: Buffer.from("export const x = 1;\n") },
    "renamed-new.txt": { mode: "100644", bytes: Buffer.from("rename me\n") },
  };

  // ------------------------------------------------------------ user repo state
  const sha256 = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
  const repoState = () => ({
    head: git(["rev-parse", "HEAD"], repo),
    status: git(["--no-optional-locks", "status", "--porcelain"], repo),
    indexSha: sha256(join(repo, ".git", "index")),
    refs: git(["for-each-ref"], repo),
    objects: git(["count-objects", "-v"], repo),
  });
  const before = repoState();

  // ------------------------------------------------------------------ capture
  const root = await gitTopLevel(repo);
  const gitDir = await gitCommonDir(repo);
  const head = await gitHead(repo);
  const fmt = await gitObjectFormat(repo);
  if (!root || !gitDir) {
    check("fixture repo resolves", false, "gitTopLevel or gitCommonDir returned null");
    return;
  }
  const store = await SnapshotStore.create(join(work, "store"), root, gitDir, fmt);
  const stores: SnapshotStore[] = [store];

  const pf = await store.preflightRepo();
  check("preflight passes on a clean repo", pf.ok, pf.reasons.join("; "));

  const state = await store.capture(head, null);
  check("capture returns a commit and tree", !!state.commit && !!state.tree);
  check("capture reports the expected path count", state.pathCount === Object.keys(expected).length, `got ${state.pathCount}`);
  check(
    "a successful capture state ref resolves to its returned commit",
    storeGit(store, ["rev-parse", `refs/termina/state/${state.commit}`]).toString("utf8").trim() === state.commit,
  );

  // Byte-exact tree: every expected path has the right mode and blob bytes.
  const treeRecords = storeGit(store, ["ls-tree", "-r", "-z", state.tree]).toString("utf8").split("\0").filter(Boolean);
  const treeMap = new Map();
  for (const rec of treeRecords) {
    const tab = rec.indexOf("\t");
    const meta = rec.slice(0, tab).split(" ");
    treeMap.set(rec.slice(tab + 1), { mode: meta[0], oid: meta[2] });
  }
  check("tree has exactly the expected paths", treeRecords.length === Object.keys(expected).length, `got ${treeRecords.length}`);
  let byteExact = true;
  for (const [rel, exp] of Object.entries(expected)) {
    const ent = treeMap.get(rel);
    if (!ent || ent.mode !== exp.mode) {
      byteExact = false;
      check(`mode for ${rel}`, false, `expected ${exp.mode}, got ${ent?.mode ?? "missing"}`);
      continue;
    }
    const raw = storeGit(store, ["cat-file", "blob", ent.oid]);
    if (exp.symlink !== undefined) {
      if (raw.toString("utf8") !== exp.symlink) {
        byteExact = false;
        check(`symlink target for ${rel}`, false);
      }
      continue;
    }
    if (exp.bytes !== undefined && !raw.equals(exp.bytes)) {
      byteExact = false;
      check(`bytes for ${rel}`, false);
    }
  }
  check("every captured file is byte-exact with mode", byteExact);

  // The absent paths must not appear in the tree.
  for (const gone of ["deleted.txt", "renamed-old.txt", "ignored.txt"]) {
    if (treeMap.has(gone)) check(`deleted/ignored path absent: ${gone}`, false);
  }
  check("deleted, renamed-away, and ignored paths are absent", !treeMap.has("deleted.txt") && !treeMap.has("renamed-old.txt") && !treeMap.has("ignored.txt"));

  // ------------------------------------------------------- user repo untouched
  const after = repoState();
  check("HEAD unchanged", before.head === after.head);
  check("git status unchanged", before.status === after.status);
  check("index bytes unchanged", before.indexSha === after.indexSha);
  check("refs unchanged", before.refs === after.refs);
  check("object count unchanged", before.objects === after.objects);

  // ------------------------------------------------------------ materialize
  const restored = join(work, "restored");
  mkdirSync(restored, { recursive: true });
  writeFileSync(join(restored, "stale.txt"), "stale\n");
  writeFileSync(join(restored, "exec.sh"), "wrong\n");
  mkdirSync(join(restored, "stale-dir"));
  writeFileSync(join(restored, "stale-dir", "nested.txt"), "stale\n");
  symlinkSync("wrong-target", join(restored, "tracked.txt"));
  chmodSync(join(restored, "exec.sh"), 0o644);
  await materializeState(store, state.commit, restored);
  let roundTrip = true;
  for (const [rel, exp] of Object.entries(expected)) {
    const full = join(restored, rel);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      roundTrip = false;
      check(`materialized ${rel}`, false, "missing");
      continue;
    }
    if (exp.symlink !== undefined) {
      if (!st.isSymbolicLink() || readlinkSync(full) !== exp.symlink) {
        roundTrip = false;
        check(`materialized ${rel}`, false, "symlink mismatch");
      }
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      roundTrip = false;
      check(`materialized ${rel}`, false, "wrong type");
      continue;
    }
    const modeOk = exp.mode === "100755" ? (st.mode & 0o111) !== 0 : (st.mode & 0o111) === 0;
    if (!modeOk) {
      roundTrip = false;
      check(`materialized mode ${rel}`, false);
    }
    if (exp.bytes !== undefined && !readFileSync(full).equals(exp.bytes)) {
      roundTrip = false;
      check(`materialized bytes ${rel}`, false);
    }
  }
  check("materialize round-trips bytes, modes, and symlinks", roundTrip);
  check(
    "materialize removes stale paths and replaces wrong types",
    !existsSync(join(restored, "stale.txt")) &&
      !existsSync(join(restored, "stale-dir")) &&
      lstatSync(join(restored, "tracked.txt")).isFile() &&
      (lstatSync(join(restored, "exec.sh")).mode & 0o111) !== 0,
  );

  // ------------------------------------------------------------ blob dedupe
  writeFileSync(join(repo, "dup-a.txt"), "same bytes\n");
  writeFileSync(join(repo, "dup-b.txt"), "same bytes\n");
  const dedup = await store.capture(head, state.commit);
  const dedupTree = storeGit(store, ["ls-tree", "-r", "-z", dedup.tree]).toString("utf8").split("\0").filter(Boolean);
  const dupA = dedupTree.find((r) => r.endsWith("\tdup-a.txt"));
  const dupB = dedupTree.find((r) => r.endsWith("\tdup-b.txt"));
  const oidA = dupA?.slice(0, dupA.indexOf("\t")).split(" ")[2];
  const oidB = dupB?.slice(0, dupB.indexOf("\t")).split(" ")[2];
  check("identical blobs deduplicate to one object", oidA === oidB && !!oidA, `a=${oidA} b=${oidB}`);
  check("second capture chains from the first", dedup.parentCommit === state.commit);

  // ----------------------------------------------- candidate cache ownership
  const candidate = join(work, "candidate");
  mkdirSync(candidate, { recursive: true, mode: 0o700 });
  const candidateIdentity = await boundPromotionOpenDirectory({ path: candidate, expectedIdentity: promotionIdentity(candidate) });
  await store.template({ stateId: state.commit, targetDir: candidate, sourceObjectsDir: join(gitDir, "objects"), boundRootIdentity: candidateIdentity });
  const candidateBytes = Buffer.from("candidate-only staged bytes\n");
  const candidatePath = join(candidate, "candidate-only.txt");
  writeFileSync(candidatePath, candidateBytes);
  const oldTime = new Date(Date.now() - 5_000);
  utimesSync(candidatePath, oldTime, oldTime);
  git(["add", "candidate-only.txt"], candidate);
  const candidateOid = git(["rev-parse", ":candidate-only.txt"], candidate);
  const candidateState = await store.capture(await gitHead(candidate), state.commit, {}, {}, { root: candidate, gitDir: join(candidate, ".git") });
  const candidateLoose = join(store.gitDir, "objects", candidateOid.slice(0, 2), candidateOid.slice(2));
  check("a candidate stat-cache blob is owned by the canonical store", existsSync(candidateLoose), candidateLoose);
  let candidateRead: Buffer | null = null;
  let candidateReadError = "";
  try {
    candidateRead = await store.readBlob(candidateState.commit, "candidate-only.txt");
  } catch (err) {
    candidateReadError = String(err);
  }
  check("a candidate stat-cache blob remains readable from its state", candidateRead?.equals(candidateBytes) === true, candidateReadError);
  const candidateRestored = join(work, "candidate-restored");
  let candidateMaterializeError = "";
  try {
    await materializeState(store, candidateState.commit, candidateRestored);
  } catch (err) {
    candidateMaterializeError = String(err);
  }
  check(
    "a candidate stat-cache state materializes without candidate object access",
    existsSync(join(candidateRestored, "candidate-only.txt")) && readFileSync(join(candidateRestored, "candidate-only.txt")).equals(candidateBytes),
    candidateMaterializeError,
  );
  const cacheRacePath = join(candidate, "cache-race.txt");
  const cacheRaceTime = new Date(Date.now() - 10_000);
  writeFileSync(cacheRacePath, "staged-A\n");
  utimesSync(cacheRacePath, cacheRaceTime, cacheRaceTime);
  git(["add", "cache-race.txt"], candidate);
  writeFileSync(cacheRacePath, "live---B\n");
  utimesSync(cacheRacePath, cacheRaceTime, cacheRaceTime);
  const cacheRaceState = await store.capture(await gitHead(candidate), candidateState.commit, {}, {}, { root: candidate, gitDir: join(candidate, ".git") });
  const cacheRaceBytes = await store.readBlob(cacheRaceState.commit, "cache-race.txt");
  check("the stat cache rejects a same-length rewrite with restored mtime", cacheRaceBytes?.equals(Buffer.from("live---B\n")) === true);
  const cacheHookPath = join(candidate, "cache-hook-race.txt");
  const cacheHookTime = new Date(Date.now() - 15_000);
  writeFileSync(cacheHookPath, "cache-old\n");
  utimesSync(cacheHookPath, cacheHookTime, cacheHookTime);
  git(["add", "cache-hook-race.txt"], candidate);
  let cacheHookRaceError = "no error thrown";
  try {
    await store.capture(
      await gitHead(candidate),
      cacheRaceState.commit,
      {},
      { afterCache: [{ path: "cache-hook-race.txt", content: "cache-new\n" }] },
      { root: candidate, gitDir: join(candidate, ".git") },
    );
  } catch (err) {
    cacheHookRaceError = String(err);
  }
  check("a stat-cache leaf changed after approval aborts capture", /changed while captured|replaced while captured/.test(cacheHookRaceError), cacheHookRaceError);
  const cacheHookOldOid = blobOid(Buffer.from("cache-old\n"));
  check("a rejected stat-cache copy leaves no request-created blob", !existsSync(looseBlobPath(store, cacheHookOldOid)), looseBlobPath(store, cacheHookOldOid));
  check("cache-race rollback preserves a blob from an earlier successful state", existsSync(candidateLoose), candidateLoose);

  // ---------------------------------------------- ancestor symlink rejection
  const makeAncestorFixture = (name: string) => {
    const dir = join(work, name);
    mkdirSync(join(dir, "src"), { recursive: true });
    git(["init", "-q"], dir);
    git(["config", "user.email", "t@t"], dir);
    git(["config", "user.name", "t"], dir);
    writeFileSync(join(dir, "src", "file.txt"), "inside bytes\n");
    git(["add", "src/file.txt"], dir);
    writeFileSync(join(dir, ".gitignore"), "src/\n");
    git(["add", ".gitignore"], dir);
    git(["commit", "-qm", "base"], dir);
    return dir;
  };
  const replaceAncestorWithLink = (dir: string, name: string) => {
    const outside = join(work, `${name}-outside`);
    mkdirSync(outside);
    const sentinel = Buffer.from(`${name} outside sentinel\n`);
    writeFileSync(join(outside, "file.txt"), sentinel);
    rmSync(join(dir, "src"), { recursive: true });
    symlinkSync(outside, join(dir, "src"));
    return sentinel;
  };

  const fullAncestor = makeAncestorFixture("full-ancestor");
  const fullAncestorStore = await SnapshotStore.create(join(work, "store-full-ancestor"), fullAncestor, join(fullAncestor, ".git"), "sha1");
  stores.push(fullAncestorStore);
  const fullSentinel = replaceAncestorWithLink(fullAncestor, "full");
  let fullAncestorError = "no error thrown";
  let fullAncestorBytes: Buffer | null = null;
  try {
    const captured = await fullAncestorStore.capture(await gitHead(fullAncestor), null);
    fullAncestorBytes = await fullAncestorStore.readBlob(captured.commit, "src/file.txt");
  } catch (err) {
    fullAncestorError = String(err);
  }
  check("full capture rejects a symlinked ancestor", /ancestor symlink|symlinked-directory/.test(fullAncestorError), fullAncestorError);
  check("full capture never stores bytes reached through an ancestor symlink", !fullAncestorBytes?.equals(fullSentinel));

  const incrementalAncestor = makeAncestorFixture("incremental-ancestor");
  const incrementalAncestorStore = await SnapshotStore.create(join(work, "store-incremental-ancestor"), incrementalAncestor, join(incrementalAncestor, ".git"), "sha1");
  stores.push(incrementalAncestorStore);
  const incrementalBase = await incrementalAncestorStore.capture(await gitHead(incrementalAncestor), null);
  const incrementalSentinel = replaceAncestorWithLink(incrementalAncestor, "incremental");
  let incrementalAncestorError = "no error thrown";
  let incrementalAncestorBytes: Buffer | null = null;
  try {
    const captured = await incrementalAncestorStore.captureIncremental(incrementalBase.commit, ["src/file.txt"], []);
    incrementalAncestorBytes = await incrementalAncestorStore.readBlob(captured.commit, "src/file.txt");
  } catch (err) {
    incrementalAncestorError = String(err);
  }
  check("incremental capture rejects a symlinked ancestor", /ancestor symlink|symlinked-directory/.test(incrementalAncestorError), incrementalAncestorError);
  check("incremental capture never stores bytes reached through an ancestor symlink", !incrementalAncestorBytes?.equals(incrementalSentinel));

  // ------------------------------------------------------------ unborn repo
  const unborn = join(work, "unborn");
  mkdirSync(unborn);
  git(["init", "-q"], unborn);
  git(["config", "user.email", "t@t"], unborn);
  git(["config", "user.name", "t"], unborn);
  writeFileSync(join(unborn, "a.txt"), "alpha\n");
  const unbornStore = await SnapshotStore.create(join(work, "store-unborn"), unborn, join(unborn, ".git"), "sha1");
  stores.push(unbornStore);
  const unbornState = await unbornStore.capture(null, null);
  const unbornTree = storeGit(unbornStore, ["ls-tree", "-r", "-z", unbornState.tree]).toString("utf8").split("\0").filter(Boolean);
  check("unborn repo captures untracked files", unbornTree.length === 1 && unbornTree[0].endsWith("a.txt"), JSON.stringify(unbornTree));

  // A fully empty repo captures the empty tree.
  const emptyRepo = join(work, "empty");
  mkdirSync(emptyRepo);
  git(["init", "-q"], emptyRepo);
  git(["config", "user.email", "t@t"], emptyRepo);
  git(["config", "user.name", "t"], emptyRepo);
  const emptyStore = await SnapshotStore.create(join(work, "store-empty"), emptyRepo, join(emptyRepo, ".git"), "sha1");
  stores.push(emptyStore);
  const emptyState = await emptyStore.capture(null, null);
  const emptyTree = storeGit(emptyStore, ["ls-tree", "-r", "-z", emptyState.tree]).toString("utf8").split("\0").filter(Boolean);
  check("empty repo captures the empty tree", emptyState.pathCount === 0 && emptyTree.length === 0 && emptyState.tree === "4b825dc642cb6eb9a060e54bf8d69288fbee4904", emptyState.tree);

  // ------------------------------------------------------------ preflight rejects
  const makeRepo = (name: string) => {
    const dir = join(work, name);
    mkdirSync(dir);
    git(["init", "-q"], dir);
    git(["config", "user.email", "t@t"], dir);
    git(["config", "user.name", "t"], dir);
    writeFileSync(join(dir, "f.txt"), "x\n");
    git(["add", "-A"], dir);
    git(["commit", "-qm", "base"], dir);
    return dir;
  };

  const bad = makeRepo("bad");
  git(["config", "core.autocrlf", "true"], bad);
  const badStore = await SnapshotStore.create(join(work, "store-bad"), bad, join(bad, ".git"), "sha1");
  stores.push(badStore);
  const pfBad = await badStore.preflightRepo();
  check("core.autocrlf=true fails preflight", !pfBad.ok && pfBad.reasons.some((r) => r.includes("autocrlf")), pfBad.reasons.join("; "));

  const attr = makeRepo("attr");
  writeFileSync(join(attr, ".gitattributes"), "* text=auto\n");
  git(["add", "-A"], attr);
  git(["commit", "-qm", "attrs"], attr);
  const attrStore = await SnapshotStore.create(join(work, "store-attr"), attr, join(attr, ".git"), "sha1");
  stores.push(attrStore);
  const pfAttr = await attrStore.preflightRepo();
  check("transform .gitattributes fails preflight", !pfAttr.ok && pfAttr.reasons.some((r) => r.includes("gitattributes")), pfAttr.reasons.join("; "));

  const lfs = makeRepo("lfs");
  writeFileSync(join(lfs, ".gitattributes"), "*.bin filter=lfs\n");
  git(["add", "-A"], lfs);
  git(["commit", "-qm", "lfs"], lfs);
  const lfsStore = await SnapshotStore.create(join(work, "store-lfs"), lfs, join(lfs, ".git"), "sha1");
  stores.push(lfsStore);
  const pfLfs = await lfsStore.preflightRepo();
  check("Git LFS attributes do not fail preflight", pfLfs.ok, pfLfs.reasons.join("; "));

  const sub = makeRepo("sub");
  const subCommit = git(["rev-parse", "HEAD"], sub);
  git(["update-index", "--add", "--cacheinfo", `160000,${subCommit},modules/lib`], sub);
  const subStore = await SnapshotStore.create(join(work, "store-sub"), sub, join(sub, ".git"), "sha1");
  stores.push(subStore);
  const pfSub = await subStore.preflightRepo();
  check("submodule fails preflight", !pfSub.ok && pfSub.reasons.some((r) => r.includes("submodule")), pfSub.reasons.join("; "));

  // ------------------------------------------------------------ budgets
  const tiny = join(work, "tiny");
  mkdirSync(tiny);
  git(["init", "-q"], tiny);
  git(["config", "user.email", "t@t"], tiny);
  git(["config", "user.name", "t"], tiny);
  writeFileSync(join(tiny, "a.txt"), "a\n");
  writeFileSync(join(tiny, "b.txt"), "b\n");
  writeFileSync(join(tiny, "c.txt"), "c\n");
  const tinyStore = await SnapshotStore.create(join(work, "store-tiny"), tiny, join(tiny, ".git"), "sha1");
  stores.push(tinyStore);
  let budgetFailed = false;
  try {
    await tinyStore.capture(null, null, { maxPaths: 2 });
  } catch (err) {
    budgetFailed = /path budget/.test(String(err));
  }
  check("path budget aborts the capture", budgetFailed);

  // --------------------------------------------- blob budget/no-orphan checks
  const fullBudgetRepo = join(work, "full-budget");
  mkdirSync(fullBudgetRepo);
  git(["init", "-q"], fullBudgetRepo);
  git(["config", "user.email", "t@t"], fullBudgetRepo);
  git(["config", "user.name", "t"], fullBudgetRepo);
  const preexistingBytes = Buffer.from("pre-existing deduplicated blob\n");
  const preexistingOid = blobOid(preexistingBytes);
  writeFileSync(join(fullBudgetRepo, "preexisting.txt"), preexistingBytes);
  const fullBudgetStore = await SnapshotStore.create(join(work, "store-full-budget"), fullBudgetRepo, join(fullBudgetRepo, ".git"), "sha1");
  stores.push(fullBudgetStore);
  const fullBudgetBase = await fullBudgetStore.capture(null, null);
  check("a successful capture persists its canonical blob", existsSync(looseBlobPath(fullBudgetStore, preexistingOid)), looseBlobPath(fullBudgetStore, preexistingOid));
  writeFileSync(join(fullBudgetRepo, "deduplicated.txt"), preexistingBytes);
  const fullBudgetA = Buffer.from("full aggregate blob A\n");
  const fullBudgetB = Buffer.from("full aggregate blob B is distinct\n");
  const fullBudgetAOid = blobOid(fullBudgetA);
  const fullBudgetBOid = blobOid(fullBudgetB);
  writeFileSync(join(fullBudgetRepo, "a-fit.txt"), fullBudgetA);
  writeFileSync(join(fullBudgetRepo, "z-over.txt"), fullBudgetB);
  const fullAggregateLimit = fullBudgetA.length + fullBudgetB.length - 1;
  let fullBudgetError = "no error thrown";
  try {
    await fullBudgetStore.capture(null, fullBudgetBase.commit, { maxNewBlobBytes: fullAggregateLimit });
  } catch (err) {
    fullBudgetError = String(err);
  }
  check("full capture rejects before an over-budget blob write", /new-blob byte budget/.test(fullBudgetError), fullBudgetError);
  check(
    "full aggregate rejection rolls back every request-created blob",
    !existsSync(looseBlobPath(fullBudgetStore, fullBudgetAOid)) && !existsSync(looseBlobPath(fullBudgetStore, fullBudgetBOid)),
    `${looseBlobPath(fullBudgetStore, fullBudgetAOid)} ${looseBlobPath(fullBudgetStore, fullBudgetBOid)}`,
  );
  check(
    "full rollback never removes a pre-existing deduplicated blob",
    existsSync(looseBlobPath(fullBudgetStore, preexistingOid)),
    looseBlobPath(fullBudgetStore, preexistingOid),
  );
  const fullBudgetSuccess = await fullBudgetStore.capture(null, fullBudgetBase.commit, {
    maxNewBlobBytes: fullBudgetA.length + fullBudgetB.length,
  });
  check(
    "successful full capture publishes every request-created blob",
    !!fullBudgetSuccess.commit && existsSync(looseBlobPath(fullBudgetStore, fullBudgetAOid)) && existsSync(looseBlobPath(fullBudgetStore, fullBudgetBOid)),
  );

  const incrementalBudgetRepo = join(work, "incremental-budget");
  mkdirSync(incrementalBudgetRepo);
  git(["init", "-q"], incrementalBudgetRepo);
  git(["config", "user.email", "t@t"], incrementalBudgetRepo);
  git(["config", "user.name", "t"], incrementalBudgetRepo);
  const incrementalBudgetStore = await SnapshotStore.create(join(work, "store-incremental-budget"), incrementalBudgetRepo, join(incrementalBudgetRepo, ".git"), "sha1");
  stores.push(incrementalBudgetStore);
  const incrementalBudgetBase = await incrementalBudgetStore.capture(null, null);
  const incrementalBudgetA = Buffer.from("incremental aggregate blob A\n");
  const incrementalBudgetB = Buffer.from("incremental aggregate blob B distinct\n");
  const incrementalBudgetAOid = blobOid(incrementalBudgetA);
  const incrementalBudgetBOid = blobOid(incrementalBudgetB);
  writeFileSync(join(incrementalBudgetRepo, "a-fit.txt"), incrementalBudgetA);
  writeFileSync(join(incrementalBudgetRepo, "z-over.txt"), incrementalBudgetB);
  const incrementalAggregateLimit = incrementalBudgetA.length + incrementalBudgetB.length - 1;
  let incrementalBudgetError = "no error thrown";
  try {
    await incrementalBudgetStore.captureIncremental(
      incrementalBudgetBase.commit,
      ["a-fit.txt", "z-over.txt"],
      [],
      { maxNewBlobBytes: incrementalAggregateLimit },
    );
  } catch (err) {
    incrementalBudgetError = String(err);
  }
  check("incremental capture rejects before an over-budget blob write", /new-blob byte budget/.test(incrementalBudgetError), incrementalBudgetError);
  check(
    "incremental aggregate rejection rolls back every request-created blob",
    !existsSync(looseBlobPath(incrementalBudgetStore, incrementalBudgetAOid)) && !existsSync(looseBlobPath(incrementalBudgetStore, incrementalBudgetBOid)),
    `${looseBlobPath(incrementalBudgetStore, incrementalBudgetAOid)} ${looseBlobPath(incrementalBudgetStore, incrementalBudgetBOid)}`,
  );
  const incrementalBudgetSuccess = await incrementalBudgetStore.captureIncremental(
    incrementalBudgetBase.commit,
    ["a-fit.txt", "z-over.txt"],
    [],
    { maxNewBlobBytes: incrementalBudgetA.length + incrementalBudgetB.length },
  );
  check(
    "successful incremental capture publishes every request-created blob",
    !!incrementalBudgetSuccess.commit &&
      existsSync(looseBlobPath(incrementalBudgetStore, incrementalBudgetAOid)) &&
      existsSync(looseBlobPath(incrementalBudgetStore, incrementalBudgetBOid)),
  );

  // --------------------------------------- request-transactional object sets
  const transactionRepo = join(work, "transactional-objects");
  mkdirSync(transactionRepo);
  git(["init", "-q"], transactionRepo);
  git(["config", "user.email", "t@t"], transactionRepo);
  git(["config", "user.name", "t"], transactionRepo);
  mkdirSync(join(transactionRepo, "nested"));
  writeFileSync(join(transactionRepo, "nested", "late.txt"), "late failure bytes\n");
  const transactionStore = await SnapshotStore.create(
    join(work, "store-transactional-objects"),
    transactionRepo,
    join(transactionRepo, ".git"),
    "sha1",
  );
  stores.push(transactionStore);
  const missingParentBefore = looseObjectSet(transactionStore);
  const missingParentRefsBefore = storeRefSet(transactionStore);
  let missingParentError = "no error thrown";
  try {
    await transactionStore.capture(null, "1111111111111111111111111111111111111111");
  } catch (err) {
    missingParentError = String(err);
  }
  const missingParentAfter = looseObjectSet(transactionStore);
  check("a valid but missing parent aborts full capture", /not found|could not find|odb/.test(missingParentError), missingParentError);
  check(
    "a missing-parent failure leaves the complete loose-object set unchanged",
    JSON.stringify(missingParentAfter) === JSON.stringify(missingParentBefore),
    JSON.stringify({ before: missingParentBefore, after: missingParentAfter }),
  );
  check(
    "a missing-parent failure leaves the complete ref set unchanged",
    JSON.stringify(storeRefSet(transactionStore)) === JSON.stringify(missingParentRefsBefore),
  );

  const fullRefBefore = looseObjectSet(transactionStore);
  const fullRefRefsBefore = storeRefSet(transactionStore);
  let fullRefError = "no error thrown";
  try {
    await transactionStore.capture(null, null, {}, { failStateRef: true });
  } catch (err) {
    fullRefError = String(err);
  }
  const fullRefAfter = looseObjectSet(transactionStore);
  check("the full state-ref failure seam aborts capture", /injected state-ref failure/.test(fullRefError), fullRefError);
  check(
    "full state-ref failure rolls back blobs, trees, and commits",
    JSON.stringify(fullRefAfter) === JSON.stringify(fullRefBefore),
    JSON.stringify({ before: fullRefBefore, after: fullRefAfter }),
  );
  check(
    "full state-ref failure leaves the complete ref set unchanged",
    JSON.stringify(storeRefSet(transactionStore)) === JSON.stringify(fullRefRefsBefore),
  );

  const transactionBase = await transactionStore.capture(null, null);
  writeFileSync(join(transactionRepo, "nested", "late.txt"), "incremental ref failure bytes\n");
  const incrementalRefBefore = looseObjectSet(transactionStore);
  const incrementalRefRefsBefore = storeRefSet(transactionStore);
  let incrementalRefError = "no error thrown";
  try {
    await transactionStore.captureIncremental(
      transactionBase.commit,
      ["nested/late.txt"],
      [],
      {},
      { failStateRef: true },
    );
  } catch (err) {
    incrementalRefError = String(err);
  }
  const incrementalRefAfter = looseObjectSet(transactionStore);
  check("the incremental state-ref failure seam aborts capture", /injected state-ref failure/.test(incrementalRefError), incrementalRefError);
  check(
    "incremental state-ref failure rolls back blobs, trees, and commits",
    JSON.stringify(incrementalRefAfter) === JSON.stringify(incrementalRefBefore),
    JSON.stringify({ before: incrementalRefBefore, after: incrementalRefAfter }),
  );
  check(
    "incremental state-ref failure leaves the complete ref set unchanged",
    JSON.stringify(storeRefSet(transactionStore)) === JSON.stringify(incrementalRefRefsBefore),
  );
  const transactionSuccess = await transactionStore.captureIncremental(
    transactionBase.commit,
    ["nested/late.txt"],
    [],
  );
  const transactionRestored = join(work, "transaction-success-restored");
  await materializeState(transactionStore, transactionSuccess.commit, transactionRestored);
  check(
    "successful transactional capture keeps every object needed by its ref",
    storeGit(transactionStore, ["rev-parse", `refs/termina/state/${transactionSuccess.commit}`]).toString("utf8").trim() ===
      transactionSuccess.commit &&
      existsSync(looseBlobPath(transactionStore, transactionSuccess.commit)) &&
      existsSync(looseBlobPath(transactionStore, transactionSuccess.tree)) &&
      readFileSync(join(transactionRestored, "nested", "late.txt"), "utf8") === "incremental ref failure bytes\n",
  );

  // -------------------------------------- crash recovery + partial ref write
  const crashRepo = join(work, "crash-recovery");
  mkdirSync(join(crashRepo, "nested"), { recursive: true });
  git(["init", "-q"], crashRepo);
  git(["config", "user.email", "t@t"], crashRepo);
  git(["config", "user.name", "t"], crashRepo);
  writeFileSync(join(crashRepo, "nested", "crash.txt"), "full crash bytes\n");
  const crashStore = await SnapshotStore.create(
    join(work, "store-crash-recovery"),
    crashRepo,
    join(crashRepo, ".git"),
    "sha1",
  );
  stores.push(crashStore);

  const fullCrashObjectsBefore = looseObjectSet(crashStore);
  const fullCrashRefsBefore = storeRefSet(crashStore);
  const fullCrashReady = join(work, "full-crash-ready");
  const fullCrashRelease = join(work, "full-crash-release");
  const fullCrash = startCoreRequest(
    corePayload(crashStore, "capture", {
      head: null,
      parentCommit: null,
      budget: {},
      hooks: { pauseBeforeStateRef: { readyPath: fullCrashReady, releasePath: fullCrashRelease } },
    }),
  );
  const fullCrashOutcome = fullCrash.settled.then(
    () => "unexpected success",
    () => "killed",
  );
  await waitForMarker(fullCrashReady);
  fullCrash.child.kill("SIGKILL");
  await fullCrashOutcome;
  check("a killed full capture publishes objects before recovery", looseObjectSet(crashStore).length > fullCrashObjectsBefore.length);
  await requestCore(corePayload(crashStore, "unref", { commit: "2222222222222222222222222222222222222222" }));
  check(
    "the next mutator recovers a killed full capture's exact loose-object set",
    JSON.stringify(looseObjectSet(crashStore)) === JSON.stringify(fullCrashObjectsBefore),
    JSON.stringify({ before: fullCrashObjectsBefore, after: looseObjectSet(crashStore) }),
  );
  check(
    "the next mutator recovers a killed full capture's exact ref set",
    JSON.stringify(storeRefSet(crashStore)) === JSON.stringify(fullCrashRefsBefore),
    JSON.stringify({ before: fullCrashRefsBefore, after: storeRefSet(crashStore) }),
  );
  check(
    "full crash recovery clears the durable journal and request staging",
    !existsSync(join(crashStore.dir, "termina-object-transaction.json")) &&
      !existsSync(join(crashStore.dir, "termina-object-transaction")),
  );

  const crashBase = await crashStore.capture(null, null);
  const staleJournalTemp = join(crashStore.dir, ".termina-object-transaction.json.tmp-stale");
  const staleObjectTemp = join(dirname(looseBlobPath(crashStore, crashBase.commit)), "tmp-stale-request");
  writeFileSync(staleJournalTemp, "stale journal temp");
  writeFileSync(staleObjectTemp, "stale object temp");
  await requestCore(corePayload(crashStore, "unref", { commit: "5555555555555555555555555555555555555555" }));
  check(
    "the next mutator removes stale journal and loose-object temp files",
    !existsSync(staleJournalTemp) && !existsSync(staleObjectTemp),
  );
  writeFileSync(join(crashRepo, "nested", "crash.txt"), "incremental crash bytes\n");
  const incrementalCrashObjectsBefore = looseObjectSet(crashStore);
  const incrementalCrashRefsBefore = storeRefSet(crashStore);
  const incrementalCrashReady = join(work, "incremental-crash-ready");
  const incrementalCrashRelease = join(work, "incremental-crash-release");
  const incrementalCrash = startCoreRequest(
    corePayload(crashStore, "capture-incremental", {
      parentCommit: crashBase.commit,
      hints: ["nested/crash.txt"],
      reconcile: [],
      budget: {},
      hooks: { pauseBeforeStateRef: { readyPath: incrementalCrashReady, releasePath: incrementalCrashRelease } },
    }),
  );
  const incrementalCrashOutcome = incrementalCrash.settled.then(
    () => "unexpected success",
    () => "killed",
  );
  await waitForMarker(incrementalCrashReady);
  incrementalCrash.child.kill("SIGKILL");
  await incrementalCrashOutcome;
  check(
    "a killed incremental capture publishes objects before recovery",
    looseObjectSet(crashStore).length > incrementalCrashObjectsBefore.length,
  );
  await requestCore(corePayload(crashStore, "unref", { commit: "3333333333333333333333333333333333333333" }));
  check(
    "the next mutator recovers a killed incremental capture's exact loose-object set",
    JSON.stringify(looseObjectSet(crashStore)) === JSON.stringify(incrementalCrashObjectsBefore),
    JSON.stringify({ before: incrementalCrashObjectsBefore, after: looseObjectSet(crashStore) }),
  );
  check(
    "the next mutator recovers a killed incremental capture's exact ref set",
    JSON.stringify(storeRefSet(crashStore)) === JSON.stringify(incrementalCrashRefsBefore),
    JSON.stringify({ before: incrementalCrashRefsBefore, after: storeRefSet(crashStore) }),
  );
  check(
    "incremental crash recovery clears the durable journal and request staging",
    !existsSync(join(crashStore.dir, "termina-object-transaction.json")) &&
      !existsSync(join(crashStore.dir, "termina-object-transaction")),
  );

  writeFileSync(join(crashRepo, "nested", "crash.txt"), "visible ref crash bytes\n");
  const visibleCrashRefsBefore = storeRefSet(crashStore);
  const visibleCrashReady = join(work, "visible-ref-crash-ready");
  const visibleCrashRelease = join(work, "visible-ref-crash-release");
  const visibleCrash = startCoreRequest(
    corePayload(crashStore, "capture-incremental", {
      parentCommit: crashBase.commit,
      hints: ["nested/crash.txt"],
      reconcile: [],
      budget: {},
      hooks: { pauseAfterStateRef: { readyPath: visibleCrashReady, releasePath: visibleCrashRelease } },
    }),
  );
  const visibleCrashOutcome = visibleCrash.settled.then(
    () => "unexpected success",
    () => "killed",
  );
  await waitForMarker(visibleCrashReady);
  const visibleCrashObjects = looseObjectSet(crashStore);
  const visibleCrashRefs = storeRefSet(crashStore);
  const newVisibleRef = visibleCrashRefs.find((ref) => !visibleCrashRefsBefore.includes(ref));
  check("the after-ref crash seam exposes exactly one new durable state ref", !!newVisibleRef, JSON.stringify(visibleCrashRefs));
  visibleCrash.child.kill("SIGKILL");
  await visibleCrashOutcome;
  await requestCore(corePayload(crashStore, "unref", { commit: "4444444444444444444444444444444444444444" }));
  check(
    "recovery retains the exact object and ref sets of a visible intended state",
    JSON.stringify(looseObjectSet(crashStore)) === JSON.stringify(visibleCrashObjects) &&
      JSON.stringify(storeRefSet(crashStore)) === JSON.stringify(visibleCrashRefs),
  );
  const visibleCrashCommit = newVisibleRef?.split(":").at(-1);
  const visibleCrashTarget = join(work, "visible-ref-crash-restored");
  if (visibleCrashCommit) await materializeState(crashStore, visibleCrashCommit, visibleCrashTarget);
  check(
    "a recovered visible intended ref keeps its full materializable closure",
    !!visibleCrashCommit && readFileSync(join(visibleCrashTarget, "nested", "crash.txt"), "utf8") === "visible ref crash bytes\n",
  );

  writeFileSync(join(crashRepo, "nested", "crash.txt"), "post-rename state bytes\n");
  const postRenameStateMarker = join(work, "post-rename-state-ref-error");
  const postRenameState = await crashStore.captureIncremental(
    crashBase.commit,
    ["nested/crash.txt"],
    [],
    {},
    { failStateRefAfterWrite: { markerPath: postRenameStateMarker } },
  );
  const postRenameTarget = join(work, "post-rename-state-restored");
  await materializeState(crashStore, postRenameState.commit, postRenameTarget);
  check("the post-rename state-ref error seam executed", existsSync(postRenameStateMarker));
  check(
    "a visible state ref survives a post-rename ref error with its object closure",
    storeGit(crashStore, ["rev-parse", `refs/termina/state/${postRenameState.commit}`]).toString("utf8").trim() === postRenameState.commit &&
      readFileSync(join(postRenameTarget, "nested", "crash.txt"), "utf8") === "post-rename state bytes\n",
  );

  // A failure at the durability boundary is not committed-clean. The request
  // returns an error, then Drop recovery makes the already-visible exact ref
  // durable and retains its complete object closure before clearing the
  // transaction journal.
  writeFileSync(join(crashRepo, "nested", "crash.txt"), "ref durability recovery bytes\n");
  const durabilityRefsBefore = storeRefSet(crashStore);
  const durabilityMarker = join(work, "state-ref-durability-error");
  let durabilityError = "no error thrown";
  try {
    await requestCore(
      corePayload(crashStore, "capture-incremental", {
        parentCommit: crashBase.commit,
        hints: ["nested/crash.txt"],
        reconcile: [],
        budget: {},
        hooks: { failStateRefDurability: { markerPath: durabilityMarker } },
      }),
    );
  } catch (err) {
    durabilityError = String(err);
  }
  const durabilityRefsAfter = storeRefSet(crashStore);
  const durabilityRef = durabilityRefsAfter.find((ref) => !durabilityRefsBefore.includes(ref));
  const durabilityCommit = durabilityRef?.split(":").at(-1);
  const durabilityTarget = join(work, "state-ref-durability-restored");
  if (durabilityCommit) await materializeState(crashStore, durabilityCommit, durabilityTarget);
  check(
    "a state-ref durability failure is reported instead of committed-clean",
    /injected state ref durability failure/.test(durabilityError) && existsSync(durabilityMarker),
    durabilityError,
  );
  check(
    "durability-error recovery retains the visible ref's materializable closure",
    !!durabilityCommit &&
      readFileSync(join(durabilityTarget, "nested", "crash.txt"), "utf8") === "ref durability recovery bytes\n",
  );
  check(
    "durability-error recovery clears the journal only after reconciling the visible ref",
    !existsSync(join(crashStore.dir, "termina-object-transaction.json")) &&
      !existsSync(join(crashStore.dir, "termina-object-transaction")),
  );

  // Structural performance gate: file-count growth must not amplify journal
  // rewrites or staging-directory syncs. Counters are deterministic across CI
  // filesystems, unlike a wall-clock threshold.
  const captureMetrics = async (count: number) => {
    const metricsRepo = join(work, `metrics-${count}`);
    mkdirSync(metricsRepo);
    git(["init", "-q"], metricsRepo);
    git(["config", "user.email", "t@t"], metricsRepo);
    git(["config", "user.name", "t"], metricsRepo);
    for (let index = 0; index < count; index += 1) {
      writeFileSync(join(metricsRepo, `tiny-${index.toString().padStart(4, "0")}.txt`), `${index}\n`);
    }
    const metricsStore = await SnapshotStore.create(
      join(work, `store-metrics-${count}`),
      metricsRepo,
      join(metricsRepo, ".git"),
      "sha1",
    );
    stores.push(metricsStore);
    const metricsPath = join(work, `capture-metrics-${count}.json`);
    const captureStartedAt = Date.now();
    const response = await requestCore(
      corePayload(metricsStore, "capture", {
        head: null,
        parentCommit: null,
        budget: {},
        hooks: { transactionMetricsPath: metricsPath },
      }),
    );
    const elapsedMs = Date.now() - captureStartedAt;
    const metrics = existsSync(metricsPath)
      ? (JSON.parse(readFileSync(metricsPath, "utf8")) as Record<string, number>)
      : {};
    const state = response.state as { pathCount?: number } | undefined;
    const expectedStageDirectorySyncs = Math.ceil((count + 1) / STORE_OBJECT_BATCH_BOUNDARY) + 1;
    check(
      `${count}-file capture uses a bounded transaction ledger and batched directory syncs`,
      state?.pathCount === count &&
        metrics.publishedObjects! >= count &&
        metrics.journalWrites! <= 2 &&
        metrics.journalBytesWritten! <= 1_024 &&
        metrics.stagingDirectorySyncs === expectedStageDirectorySyncs &&
        metrics.canonicalDirectorySyncs! <= expectedStageDirectorySyncs * 257 &&
        metrics.refFileSyncs === 1,
      JSON.stringify({ state, metrics, elapsedMs }),
    );
    return { metrics, elapsedMs, store: metricsStore };
  };
  const run100 = await captureMetrics(100);
  const run1000 = await captureMetrics(1000);
  const metrics100 = run100.metrics;
  const metrics1000 = run1000.metrics;
  check(
    "10x more tiny files does not increase journal writes or staging-directory syncs",
    metrics1000.journalWrites === metrics100.journalWrites &&
      metrics1000.stagingDirectorySyncs === metrics100.stagingDirectorySyncs,
    JSON.stringify({ metrics100, metrics1000 }),
  );
  const run4097 = await captureMetrics(STORE_OBJECT_BATCH_BOUNDARY + 1);
  check(
    "a capture beyond one production batch keeps header writes bounded and cleans its ledger",
    run4097.metrics.journalWrites === 2 &&
      run4097.metrics.stagingDirectorySyncs === 3 &&
      run4097.metrics.journalBytesWritten! <= 1_024 &&
      !existsSync(join(run4097.store.dir, "termina-object-transaction.json")) &&
      !existsSync(join(run4097.store.dir, "termina-object-transaction")),
    JSON.stringify({ metrics: run4097.metrics, elapsedMs: run4097.elapsedMs }),
  );

  // The private staging directory itself is part of the ownership proof. If
  // it is replaced after a crash, recovery must fail closed instead of
  // treating attacker-chosen hard links as request-owned objects.
  const ledgerRepo = join(work, "ledger-replacement");
  mkdirSync(ledgerRepo);
  git(["init", "-q"], ledgerRepo);
  git(["config", "user.email", "t@t"], ledgerRepo);
  git(["config", "user.name", "t"], ledgerRepo);
  writeFileSync(join(ledgerRepo, "protected.txt"), "protected base bytes\n");
  const ledgerStore = await SnapshotStore.create(
    join(work, "store-ledger-replacement"),
    ledgerRepo,
    join(ledgerRepo, ".git"),
    "sha1",
  );
  stores.push(ledgerStore);
  const ledgerBase = await ledgerStore.capture(null, null);
  const protectedObject = looseBlobPath(ledgerStore, ledgerBase.commit);
  writeFileSync(join(ledgerRepo, "protected.txt"), "uncommitted transaction bytes\n");
  const ledgerReady = join(work, "ledger-replacement-ready");
  const ledgerRelease = join(work, "ledger-replacement-release");
  const ledgerCapture = startCoreRequest(
    corePayload(ledgerStore, "capture-incremental", {
      parentCommit: ledgerBase.commit,
      hints: ["protected.txt"],
      reconcile: [],
      budget: {},
      hooks: { pauseBeforeStateRef: { readyPath: ledgerReady, releasePath: ledgerRelease } },
    }),
  );
  const ledgerCaptureOutcome = ledgerCapture.settled.then(
    () => "unexpected success",
    () => "killed",
  );
  await waitForMarker(ledgerReady);
  ledgerCapture.child.kill("SIGKILL");
  await ledgerCaptureOutcome;
  const ledgerStage = join(ledgerStore.dir, "termina-object-transaction");
  const originalLedgerStage = join(ledgerStore.dir, "termina-object-transaction-original");
  renameSync(ledgerStage, originalLedgerStage);
  mkdirSync(ledgerStage);
  linkSync(protectedObject, join(ledgerStage, ledgerBase.commit));
  let replacedLedgerError = "no error thrown";
  try {
    await requestCore(corePayload(ledgerStore, "unref", { commit: "6666666666666666666666666666666666666666" }));
  } catch (error) {
    replacedLedgerError = String(error);
  }
  check(
    "recovery rejects a replaced staging-directory ledger without deleting a pre-existing object",
    /transaction staging directory changed/.test(replacedLedgerError) &&
      existsSync(protectedObject) &&
      existsSync(join(ledgerStore.dir, "termina-object-transaction.json")),
    replacedLedgerError,
  );
  rmSync(ledgerStage, { recursive: true, force: true });
  if (existsSync(originalLedgerStage)) renameSync(originalLedgerStage, ledgerStage);
  if (existsSync(join(ledgerStore.dir, "termina-object-transaction.json"))) {
    await requestCore(corePayload(ledgerStore, "unref", { commit: "7777777777777777777777777777777777777777" }));
  }
  const ledgerBaseTarget = join(work, "ledger-base-restored");
  if (existsSync(protectedObject)) await materializeState(ledgerStore, ledgerBase.commit, ledgerBaseTarget);
  check(
    "restoring the original ledger permits exact rollback and preserves the prior state",
    existsSync(protectedObject) &&
      readFileSync(join(ledgerBaseTarget, "protected.txt"), "utf8") === "protected base bytes\n",
  );

  const forgedRepo = join(work, "forged-cache");
  mkdirSync(forgedRepo);
  git(["init", "-q"], forgedRepo);
  git(["config", "user.email", "t@t"], forgedRepo);
  git(["config", "user.name", "t"], forgedRepo);
  const forgedLive = Buffer.from("tiny\n");
  const forgedTime = new Date(Date.now() - 20_000);
  writeFileSync(join(forgedRepo, "only.txt"), forgedLive);
  utimesSync(join(forgedRepo, "only.txt"), forgedTime, forgedTime);
  git(["add", "only.txt"], forgedRepo);
  const forgedBlob = Buffer.from("forged cached object is much larger than the live file and its per-file budget\n");
  const forgedOid = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: forgedRepo, input: forgedBlob, encoding: "utf8" }).trim();
  replaceOnlyIndexOid(forgedRepo, forgedOid);
  const forgedStore = await SnapshotStore.create(join(work, "store-forged-cache"), forgedRepo, join(forgedRepo, ".git"), "sha1");
  stores.push(forgedStore);
  let forgedError = "no error thrown";
  try {
    await forgedStore.capture(null, null, { maxFileBytes: forgedLive.length });
  } catch (err) {
    forgedError = String(err);
  }
  check("a cached blob must match the live/index size and per-file budget", /cached source blob.*size|file byte budget/.test(forgedError), forgedError);
  check("an invalid cached blob is not copied into the canonical store", !existsSync(looseBlobPath(forgedStore, forgedOid)), looseBlobPath(forgedStore, forgedOid));

  // ------------------------------------------------------------ mid-read change
  const race = join(work, "race");
  mkdirSync(race);
  git(["init", "-q"], race);
  git(["config", "user.email", "t@t"], race);
  git(["config", "user.name", "t"], race);
  writeFileSync(join(race, "target.txt"), "original bytes here\n");
  writeFileSync(join(race, "other.txt"), "other\n");
  const raceStore = await SnapshotStore.create(join(work, "store-race"), race, join(race, ".git"), "sha1");
  stores.push(raceStore);
  let raceCaught = "no error thrown";
  try {
    await raceStore.capture(null, null, {}, {
      beforeRead: [{ path: "target.txt", content: "changed while read\n" }],
    });
  } catch (err) {
    raceCaught = String(err);
  }
  check("a file changed during read aborts the capture", /changed while captured/.test(raceCaught), raceCaught);

  writeFileSync(join(race, "same-length.txt"), "before!!\n");
  let restoredMtimeRaceCaught = "no error thrown";
  try {
    await raceStore.capture(null, null, {}, {
      beforeRead: [{ path: "same-length.txt", content: "after!!!\n", restoreMtime: true }],
    });
  } catch (err) {
    restoredMtimeRaceCaught = String(err);
  }
  check("a same-length rewrite with restored mtime aborts the capture", /changed while captured/.test(restoredMtimeRaceCaught), restoredMtimeRaceCaught);

  // ---------------------------------------- identity-bound Git capture probes
  // A full capture binds the root descriptor before libgit2 opens the
  // repository.  Keep one already-captured state in each fixture and assert
  // that every rejected swap leaves its refs/objects (and therefore retained
  // evidence) untouched.
  const makeRepoAt = (dir: string, content: string) => {
    mkdirSync(dir, { recursive: true });
    git(["init", "-q"], dir);
    git(["config", "user.email", "t@t"], dir);
    git(["config", "user.name", "t"], dir);
    writeFileSync(join(dir, "payload.txt"), content);
    git(["add", "payload.txt"], dir);
    git(["commit", "-qm", "base"], dir);
    return dir;
  };
  const waitAndRelease = async (
    request: ReturnType<typeof startCoreRequest>,
    readyPath: string,
    releasePath: string,
    mutate: () => void,
  ) => {
    await waitForMarker(readyPath);
    mutate();
    writeFileSync(releasePath, "release");
    let error = "no error thrown";
    let response: Record<string, unknown> | null = null;
    try {
      response = await request.settled;
    } catch (err) {
      error = String(err);
    }
    return { error, response };
  };
  const bindingStoreState = async (store: SnapshotStore, root: string) => {
    const base = await store.capture(await gitHead(root), null);
    return {
      base,
      objects: looseObjectSet(store),
      refs: storeRefSet(store),
    };
  };
  const bindingEvidenceUnchanged = (store: SnapshotStore, beforeBinding: { objects: string[]; refs: string[] }) =>
    JSON.stringify(looseObjectSet(store)) === JSON.stringify(beforeBinding.objects) &&
    JSON.stringify(storeRefSet(store)) === JSON.stringify(beforeBinding.refs);

  const rootSwapRepo = makeRepoAt(join(work, "binding-root-swap"), "root-A\n");
  const rootSwapStore = await SnapshotStore.create(
    join(work, "store-binding-root-swap"),
    rootSwapRepo,
    join(rootSwapRepo, ".git"),
    "sha1",
  );
  stores.push(rootSwapStore);
  const rootSwapState = await bindingStoreState(rootSwapStore, rootSwapRepo);
  const rootSwapReplacement = makeRepoAt(join(work, "binding-root-swap-replacement"), "root-B\n");
  const rootSwapBackup = join(work, "binding-root-swap-original");
  const rootSwapReady = join(work, "binding-root-swap-ready");
  const rootSwapRelease = join(work, "binding-root-swap-release");
  const rootSwapRequest = startCoreRequest(
    corePayload(rootSwapStore, "capture", {
      head: rootSwapState.base.head,
      parentCommit: rootSwapState.base.commit,
      hooks: { pauseAfterCaptureRootOpen: { readyPath: rootSwapReady, releasePath: rootSwapRelease } },
    }),
  );
  const rootSwapError = await waitAndRelease(rootSwapRequest, rootSwapReady, rootSwapRelease, () => {
    renameSync(rootSwapRepo, rootSwapBackup);
    renameSync(rootSwapReplacement, rootSwapRepo);
  });
  rmSync(rootSwapRepo, { recursive: true, force: true });
  renameSync(rootSwapBackup, rootSwapRepo);
  check(
    "full capture rejects a repository-root swap after opening the root descriptor",
    /capture root|worktree|identity|repository/.test(rootSwapError.error),
    rootSwapError.error,
  );
  check(
    "repository-root rejection preserves prior refs and objects",
    bindingEvidenceUnchanged(rootSwapStore, rootSwapState),
  );

  const gitDirSwapRepo = makeRepoAt(join(work, "binding-gitdir-swap"), "gitdir-A\n");
  const gitDirSwapStore = await SnapshotStore.create(
    join(work, "store-binding-gitdir-swap"),
    gitDirSwapRepo,
    join(gitDirSwapRepo, ".git"),
    "sha1",
  );
  stores.push(gitDirSwapStore);
  const gitDirSwapState = await bindingStoreState(gitDirSwapStore, gitDirSwapRepo);
  const gitDirReplacement = makeRepoAt(join(work, "binding-gitdir-replacement"), "gitdir-B\n");
  const gitDirBackup = join(work, "binding-gitdir-original");
  const gitDirReady = join(work, "binding-gitdir-swap-ready");
  const gitDirRelease = join(work, "binding-gitdir-swap-release");
  const gitDirRequest = startCoreRequest(
    corePayload(gitDirSwapStore, "capture", {
      head: gitDirSwapState.base.head,
      parentCommit: gitDirSwapState.base.commit,
      hooks: { pauseAfterCaptureGitDirOpen: { readyPath: gitDirReady, releasePath: gitDirRelease } },
    }),
  );
  const gitDirSwapError = await waitAndRelease(gitDirRequest, gitDirReady, gitDirRelease, () => {
    renameSync(join(gitDirSwapRepo, ".git"), gitDirBackup);
    renameSync(join(gitDirReplacement, ".git"), join(gitDirSwapRepo, ".git"));
  });
  rmSync(join(gitDirSwapRepo, ".git"), { recursive: true, force: true });
  renameSync(gitDirBackup, join(gitDirSwapRepo, ".git"));
  check(
    "full capture rejects a .git directory swap after binding the Git capability",
    /Git directory|\.git|repository/.test(gitDirSwapError.error),
    gitDirSwapError.error,
  );
  check(
    ".git rejection preserves prior refs and objects",
    bindingEvidenceUnchanged(gitDirSwapStore, gitDirSwapState),
  );

  const worktreeBase = makeRepoAt(join(work, "binding-worktree-base"), "worktree-A\n");
  const worktreeRoot = join(work, "binding-linked-worktree");
  git(["worktree", "add", "--detach", "-q", worktreeRoot, "HEAD"], worktreeBase);
  const worktreeGitDir = await gitCommonDir(worktreeRoot);
  if (!worktreeGitDir) throw new Error("linked worktree has no common Git directory");
  const worktreeStore = await SnapshotStore.create(
    join(work, "store-binding-worktree"),
    worktreeRoot,
    worktreeGitDir,
    "sha1",
  );
  stores.push(worktreeStore);
  const worktreeState = await bindingStoreState(worktreeStore, worktreeRoot);
  const worktreeReplacement = join(work, "binding-worktree-replacement");
  mkdirSync(worktreeReplacement);
  writeFileSync(join(worktreeReplacement, "payload.txt"), "worktree-B\n");
  const worktreeBackup = join(work, "binding-worktree-original");
  const worktreeReady = join(work, "binding-worktree-swap-ready");
  const worktreeRelease = join(work, "binding-worktree-swap-release");
  const worktreeRequest = startCoreRequest(
    corePayload(worktreeStore, "capture", {
      head: worktreeState.base.head,
      parentCommit: worktreeState.base.commit,
      captureRoot: worktreeRoot,
      captureGitDir: worktreeGitDir,
      hooks: { pauseAfterSourceRepoOpen: { readyPath: worktreeReady, releasePath: worktreeRelease } },
    }),
  );
  const worktreeSwapError = await waitAndRelease(worktreeRequest, worktreeReady, worktreeRelease, () => {
    renameSync(worktreeRoot, worktreeBackup);
    renameSync(worktreeReplacement, worktreeRoot);
  });
  rmSync(worktreeRoot, { recursive: true, force: true });
  renameSync(worktreeBackup, worktreeRoot);
  check(
    "full capture rejects a linked-worktree swap after libgit2 opens the repository",
    /capture root|worktree|identity|repository/.test(worktreeSwapError.error),
    worktreeSwapError.error,
  );
  check(
    "worktree rejection preserves prior refs and objects",
    bindingEvidenceUnchanged(worktreeStore, worktreeState),
  );

  const ancestorOriginal = join(work, "binding-ancestor-original");
  const ancestorReplacement = join(work, "binding-ancestor-replacement");
  const ancestorRepo = makeRepoAt(join(ancestorOriginal, "repo"), "ancestor-A\n");
  makeRepoAt(join(ancestorReplacement, "repo"), "ancestor-B\n");
  const ancestorStore = await SnapshotStore.create(
    join(work, "store-binding-ancestor"),
    ancestorRepo,
    join(ancestorRepo, ".git"),
    "sha1",
  );
  stores.push(ancestorStore);
  const ancestorState = await bindingStoreState(ancestorStore, ancestorRepo);
  const ancestorBackup = join(work, "binding-ancestor-original-backup");
  const ancestorReady = join(work, "binding-ancestor-aba-ready");
  const ancestorRelease = join(work, "binding-ancestor-aba-release");
  const ancestorRequest = startCoreRequest(
    corePayload(ancestorStore, "capture", {
      head: ancestorState.base.head,
      parentCommit: ancestorState.base.commit,
      hooks: { pauseAfterSourceBinding: { readyPath: ancestorReady, releasePath: ancestorRelease } },
    }),
  );
  const ancestorError = await waitAndRelease(ancestorRequest, ancestorReady, ancestorRelease, () => {
    renameSync(ancestorOriginal, ancestorBackup);
    renameSync(ancestorReplacement, ancestorOriginal);
    // Return the original ancestor before releasing the binding.  The core's
    // retained descriptors must still capture A, even across this ABA path.
    renameSync(ancestorOriginal, ancestorReplacement);
    renameSync(ancestorBackup, ancestorOriginal);
  });
  const ancestorCaptured = ancestorError.error === "no error thrown";
  check("full capture survives an ancestor ABA swap without mixed Git state", ancestorCaptured, ancestorError.error);
  let ancestorBytes: Buffer | null = null;
  if (ancestorCaptured) {
    const responseState = ancestorError.response?.state as { commit?: string } | undefined;
    if (responseState?.commit) ancestorBytes = await ancestorStore.readBlob(responseState.commit, "payload.txt");
  }
  check(
    "ancestor ABA evidence remains the original source state",
    ancestorBytes?.equals(Buffer.from("ancestor-A\n")) === true && bindingEvidenceUnchanged(ancestorStore, ancestorState),
    ancestorError.error,
  );

  const top = "/private/tmp/repo";
  check("capture root may be the Git top-level", captureRootInRepo(top, top));
  check("capture root may be a Git subdirectory", captureRootInRepo(`${top}/packages/app`, top));
  check("a sibling of the Git top-level is not inside the repo", !captureRootInRepo(`${top}-other`, top));

  // ------------------------------------------------------------------ summary
  const failed = results.filter((r) => !r.ok).length;
  log(`\ncapture spike: ${results.length - failed}/${results.length} passed`);
  for (const s of stores) await s.destroy();
  rmSync(work, { recursive: true, force: true });
  if (failed > 0) process.exitCode = 1;
}
