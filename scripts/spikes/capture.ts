/**
 * Phase 0 spike: byte-exact source capture.
 *
 * Proves that the app-owned snapshot store captures working-tree bytes
 * byte-for-byte across staged, unstaged, untracked, binary, executable,
 * symlink, renamed, and deleted files, without touching the user's Git
 * repository. Also proves round-trip materialization, unborn HEAD support,
 * content-filter preflight rejection, budgets, blob dedupe, and mid-read
 * change detection (WORLDLINES §7 Phase 0, §10 worldline-capture-test).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotStore, gitHead, gitObjectFormat, gitTopLevel, gitCommonDir } from "../../electron/worldline-git.js";

export default async function run(log: (msg: string) => void) {
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, ok: boolean, detail = "") => {
    results.push({ name, ok, detail });
    log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  };

  const work = mkdtempSync(join(tmpdir(), "wline-capture-"));
  const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const storeGit = (store: SnapshotStore, args: string[]) => execFileSync("git", args, { env: { ...process.env, GIT_DIR: store.gitDir } });

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
  await store.materialize(state.commit, restored);
  let roundTrip = true;
  for (const [rel, exp] of Object.entries(expected)) {
    const full = join(restored, rel);
    if (!existsSync(full)) {
      roundTrip = false;
      check(`materialized ${rel}`, false, "missing");
      continue;
    }
    const st = lstatSync(full);
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
  writeFileSync(join(attr, ".gitattributes"), "*.bin filter=lfs\n");
  git(["add", "-A"], attr);
  git(["commit", "-qm", "attrs"], attr);
  const attrStore = await SnapshotStore.create(join(work, "store-attr"), attr, join(attr, ".git"), "sha1");
  stores.push(attrStore);
  const pfAttr = await attrStore.preflightRepo();
  check("transform .gitattributes fails preflight", !pfAttr.ok && pfAttr.reasons.some((r) => r.includes("gitattributes")), pfAttr.reasons.join("; "));

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
      onBeforeRead: (p) => {
        if (p.endsWith("target.txt")) writeFileSync(p, "changed while read\n");
      },
    });
  } catch (err) {
    raceCaught = String(err);
  }
  check("a file changed during read aborts the capture", /changed while captured/.test(raceCaught), raceCaught);

  // ------------------------------------------------------------------ summary
  const failed = results.filter((r) => !r.ok).length;
  log(`\ncapture spike: ${results.length - failed}/${results.length} passed`);
  for (const s of stores) await s.destroy();
  rmSync(work, { recursive: true, force: true });
  if (failed > 0) process.exitCode = 1;
}