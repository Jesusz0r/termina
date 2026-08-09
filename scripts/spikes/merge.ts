/**
 * Phase 0 spike: three-way merge semantics.
 *
 * Proves that `git merge-tree --write-tree` gives the promotion semantics
 * Worldlines needs: clean merges preserve unrelated primary edits, conflicts
 * (text, binary, type, symlink, file-directory, rename) are detected with
 * zero primary writes, and the merged tree materializes byte-for-byte
 * (WORLDLINES §7 Phase 0, §10 worldline-promote-test).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotStore, gitHead, gitObjectFormat, gitTopLevel, gitCommonDir, type SourceState } from "../../electron/worldline-git.js";

export default async function run(log: (msg: string) => void) {
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, ok: boolean, detail = "") => {
    results.push({ name, ok, detail });
    log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  };

  const work = mkdtempSync(join(tmpdir(), "wline-merge-"));
  const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  /** One independent scenario: a fresh repo with a base commit and store. */
  async function scenario(name: string): Promise<{ repo: string; store: SnapshotStore; R: SourceState }> {
    const repo = join(work, name);
    mkdirSync(repo);
    git(["init", "-q"], repo);
    git(["config", "user.email", "t@t"], repo);
    git(["config", "user.name", "t"], repo);
    git(["config", "commit.gpgsign", "false"], repo);
    writeFileSync(join(repo, "shared.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(repo, "ours-only.txt"), "ours base\n");
    writeFileSync(join(repo, "theirs-only.txt"), "theirs base\n");
    writeFileSync(join(repo, "blob.bin"), Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    mkdirSync(join(repo, "sub"), { recursive: true });
    writeFileSync(join(repo, "sub", "nested.txt"), "nested base\n");
    git(["add", "-A"], repo);
    git(["commit", "-qm", "base"], repo);
    const root = await gitTopLevel(repo);
    const gitDir = await gitCommonDir(repo);
    const head = await gitHead(repo);
    const fmt = await gitObjectFormat(repo);
    if (!root || !gitDir) throw new Error("fixture repo did not resolve");
    const store = await SnapshotStore.create(join(work, `store-${name}`), root, gitDir, fmt);
    const R = await store.capture(head, null);
    return { repo, store, R };
  }

  const stores: SnapshotStore[] = [];

  // ------------------------------------------------------------- clean merge
  {
    const { repo, store, R } = await scenario("clean");
    stores.push(store);
    // Ours: edit line 1, add a file, delete theirs-only.txt, flip the binary.
    writeFileSync(join(repo, "shared.txt"), "OURS LINE\ntwo\nthree\n");
    writeFileSync(join(repo, "ours-added.txt"), "added by ours\n");
    rmSync(join(repo, "theirs-only.txt"));
    writeFileSync(join(repo, "blob.bin"), Buffer.from([0x01, 0x02, 0x03]));
    const W = await store.capture(await gitHead(repo), R.commit);
    // Theirs: edit line 3, add a different file, edit nested.txt.
    writeFileSync(join(repo, "shared.txt"), "one\ntwo\nTHEIRS LINE\n");
    writeFileSync(join(repo, "theirs-added.txt"), "added by theirs\n");
    writeFileSync(join(repo, "sub", "nested.txt"), "nested changed by theirs\n");
    const P = await store.capture(await gitHead(repo), R.commit);

    const clean = await store.merge3(W.commit, P.commit);
    check("clean merge reports ok", clean.ok, clean.reason ?? clean.conflicts.join(","));
    check("clean merge returns a tree", !!clean.tree);
    check("clean merge reports no conflicts", clean.conflicts.length === 0, JSON.stringify(clean.conflicts));

    const merged = join(work, "merged-clean");
    if (clean.tree) await store.materialize(clean.tree, merged);
    check("merged keeps both disjoint edits", readFileSync(join(merged, "shared.txt"), "utf8") === "OURS LINE\ntwo\nTHEIRS LINE\n");
    check("merged keeps ours addition", existsSync(join(merged, "ours-added.txt")));
    check("merged keeps theirs addition", existsSync(join(merged, "theirs-added.txt")));
    check("merged keeps ours deletion", !existsSync(join(merged, "theirs-only.txt")));
    check("merged takes ours binary", Buffer.from([0x01, 0x02, 0x03]).equals(readFileSync(join(merged, "blob.bin"))));
    check("merged takes theirs nested edit", readFileSync(join(merged, "sub", "nested.txt"), "utf8") === "nested changed by theirs\n");
  }

  // --------------------------------------------------------- text conflict
  {
    const { repo, store, R } = await scenario("text");
    stores.push(store);
    writeFileSync(join(repo, "shared.txt"), "one\nCONFLICT OURS\nthree\n");
    const W = await store.capture(await gitHead(repo), R.commit);
    writeFileSync(join(repo, "shared.txt"), "one\nCONFLICT THEIRS\nthree\n");
    const P = await store.capture(await gitHead(repo), R.commit);
    const conflict = await store.merge3(W.commit, P.commit);
    check("text conflict detected", !conflict.ok && conflict.conflicts.includes("shared.txt"), JSON.stringify(conflict.conflicts));
  }

  // ------------------------------------------------------- binary conflict
  {
    const { repo, store, R } = await scenario("binary");
    stores.push(store);
    writeFileSync(join(repo, "blob.bin"), Buffer.from([0xaa]));
    const W = await store.capture(await gitHead(repo), R.commit);
    writeFileSync(join(repo, "blob.bin"), Buffer.from([0xbb]));
    const P = await store.capture(await gitHead(repo), R.commit);
    const binConflict = await store.merge3(W.commit, P.commit);
    check("binary conflict detected", !binConflict.ok && binConflict.conflicts.includes("blob.bin"), JSON.stringify(binConflict.conflicts));
  }

  // --------------------------------------------------------- type conflict
  {
    const { repo, store, R } = await scenario("type");
    stores.push(store);
    // Ours: shared.txt becomes a symlink.
    rmSync(join(repo, "shared.txt"));
    symlinkSync("theirs-only.txt", join(repo, "shared.txt"));
    const W = await store.capture(await gitHead(repo), R.commit);
    // Theirs: shared.txt gains a line.
    rmSync(join(repo, "shared.txt"));
    writeFileSync(join(repo, "shared.txt"), "one\ntwo\nthree\nfour\n");
    const P = await store.capture(await gitHead(repo), R.commit);
    const typeConflict = await store.merge3(W.commit, P.commit);
    check("type (file vs symlink) conflict detected", !typeConflict.ok && typeConflict.conflicts.includes("shared.txt"), JSON.stringify(typeConflict.conflicts));
  }

  // ------------------------------------------------- file-directory conflict
  {
    const { repo, store, R } = await scenario("filedir");
    stores.push(store);
    // Ours: sub/ becomes a regular file.
    rmSync(join(repo, "sub", "nested.txt"));
    rmSync(join(repo, "sub"), { recursive: true });
    writeFileSync(join(repo, "sub"), "i am a file now\n");
    const W = await store.capture(await gitHead(repo), R.commit);
    // Theirs: edits sub/nested.txt.
    rmSync(join(repo, "sub"), { recursive: true });
    mkdirSync(join(repo, "sub"));
    writeFileSync(join(repo, "sub", "nested.txt"), "nested changed again\n");
    const P = await store.capture(await gitHead(repo), R.commit);
    const dirConflict = await store.merge3(W.commit, P.commit);
    check("file-directory conflict detected", !dirConflict.ok, JSON.stringify(dirConflict.conflicts));
  }

  // --------------------------------------------------------- rename + edit
  {
    const { repo, store, R } = await scenario("rename");
    stores.push(store);
    // Ours: rename shared.txt → renamed.txt, then edit it there.
    git(["mv", "shared.txt", "renamed.txt"], repo);
    writeFileSync(join(repo, "renamed.txt"), "renamed content\n");
    const W = await store.capture(await gitHead(repo), R.commit);
    // Theirs: edit shared.txt in place.
    writeFileSync(join(repo, "shared.txt"), "one\ntwo\nthree\nTHEIRS\n");
    const P = await store.capture(await gitHead(repo), R.commit);
    const merge = await store.merge3(W.commit, P.commit);
    // A rename+edit can auto-merge cleanly (the edit follows the rename).
    // The gate: a clean result must contain the edit on the renamed path;
    // anything else must be a reported conflict. Never a silent wrong merge.
    if (merge.ok && merge.tree) {
      const rn = join(work, "merged-rename");
      await store.materialize(merge.tree, rn);
      const contentOk =
        existsSync(join(rn, "renamed.txt")) &&
        !existsSync(join(rn, "shared.txt")) &&
        readFileSync(join(rn, "renamed.txt"), "utf8") === "renamed content\nTHEIRS\n";
      check("rename+edit merges cleanly with both sides kept", contentOk, readFileSync(join(rn, "renamed.txt"), "utf8"));
    } else {
      check("rename+edit conflict reported", !merge.ok, JSON.stringify(merge.conflicts));
    }
  }

  // ------------------------------------------- no writes to the user repo
  {
    const { repo, store } = await scenario("verify");
    stores.push(store);
    // The fixture's own untracked write is part of the baseline status.
    writeFileSync(join(repo, "a.txt"), "a\n");
    const statusBefore = git(["--no-optional-locks", "status", "--porcelain"], repo);
    const refsBefore = git(["for-each-ref"], repo);
    const headBefore = await gitHead(repo);
    // Run a clean merge and a conflicting merge against this untouched repo.
    const W = await store.capture(await gitHead(repo), null);
    writeFileSync(join(repo, "a.txt"), "b\n");
    const P = await store.capture(await gitHead(repo), W.commit);
    await store.merge3(W.commit, P.commit);
    writeFileSync(join(repo, "a.txt"), "c\n");
    const P2 = await store.capture(await gitHead(repo), W.commit);
    await store.merge3(P.commit, P2.commit);
    // The merges above must not change the working tree or index: status
    // still shows exactly the fixture's own a.txt write.
    const statusAfter = git(["--no-optional-locks", "status", "--porcelain"], repo);
    const refsAfter = git(["for-each-ref"], repo);
    const headAfter = await gitHead(repo);
    check("status unchanged after merges", statusBefore === statusAfter, JSON.stringify({ before: statusBefore, after: statusAfter }));
    check("no refs created in the user repo", refsBefore === refsAfter);
    check("HEAD unchanged after merges", headBefore === headAfter);
  }

  const failed = results.filter((r) => !r.ok).length;
  log(`\nmerge spike: ${results.length - failed}/${results.length} passed`);
  for (const s of stores) await s.destroy();
  rmSync(work, { recursive: true, force: true });
  if (failed > 0) process.exitCode = 1;
}