/**
 * Phase 0 spike: three-way merge semantics.
 *
 * Proves that `git merge-tree --write-tree` gives the promotion semantics
 * Worldlines needs: clean merges preserve unrelated primary edits, conflicts
 * (text, binary, type, symlink, file-directory, rename) are detected with
 * zero primary writes, and the merged tree materializes byte-for-byte
 * (WORLDLINES §7 Phase 0, §10 worldline-promote-test).
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { SnapshotStore, boundPromotionOpenDirectory, gitHead, gitObjectFormat, gitTopLevel, gitCommonDir, type SourceState } from "../../electron/worldline-git.js";

export default async function run(log: (msg: string) => void) {
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, ok: boolean, detail = "") => {
    results.push({ name, ok, detail });
    log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  };

  const work = mkdtempSync(join(tmpdir(), "wline-merge-"));
  const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const coreBin = process.env.TERMINA_CORE_BIN ?? join(process.cwd(), "core", "target", "release", "termina-core");
  const requestCore = (payload: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = spawn(coreBin, [], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.on("error", reject);
      child.on("exit", () => {
        const line = stdout.trim().split("\n").filter(Boolean).at(-1);
        if (!line) return reject(new Error(`core returned no response: ${stderr}`));
        const response = JSON.parse(line) as Record<string, unknown>;
        if (response.ok === true) resolve(response);
        else reject(new Error(String(response.error ?? stderr ?? "core request failed")));
      });
      child.stdin.end(`${JSON.stringify({ ...payload, requestId: `merge-spike-${Date.now()}-${Math.random()}` })}\n`);
    });
  const payload = (store: SnapshotStore, op: string, extra: Record<string, unknown> = {}) => ({
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
  const materializeState = async (store: SnapshotStore, state: string, target: string) => {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const binding = await boundPromotionOpenDirectory({ path: target, expectedIdentity: {
      dev: String(statSync(target, { bigint: true }).dev),
      ino: String(statSync(target, { bigint: true }).ino),
    } });
    await store.materialize(state, target, { boundRootIdentity: binding });
  };
  const waitForMarker = async (path: string) => {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if (existsSync(path)) return;
      await delay(5);
    }
    throw new Error(`timed out waiting for marker ${path}`);
  };

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
    if (clean.tree) await materializeState(store, clean.tree, merged);
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
      await materializeState(store, merge.tree, rn);
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

  // ------------------------------------ cross-process store mutation locking
  {
    const { repo, store, R } = await scenario("post-rename-merge-ref");
    stores.push(store);
    writeFileSync(join(repo, "ours-only.txt"), "ours post-rename\n");
    const W = await store.capture(await gitHead(repo), R.commit);
    writeFileSync(join(repo, "ours-only.txt"), "ours base\n");
    writeFileSync(join(repo, "theirs-only.txt"), "theirs post-rename\n");
    const P = await store.capture(await gitHead(repo), R.commit);
    const marker = join(work, "post-rename-merge-ref-error");
    const response = await requestCore(
      payload(store, "merge3", {
        ours: W.commit,
        theirs: P.commit,
        hooks: { failMergeRefAfterWrite: { markerPath: marker } },
      }),
    );
    const result = response.result as { ok: boolean; tree: string | null };
    const target = join(work, "post-rename-merge-target");
    if (result.tree) await materializeState(store, result.tree, target);
    check("the post-rename merge-ref error seam executed", existsSync(marker));
    check(
      "a visible merge ref survives a post-rename ref error with its object closure",
      result.ok &&
        result.tree !== null &&
        readFileSync(join(target, "ours-only.txt"), "utf8") === "ours post-rename\n" &&
        readFileSync(join(target, "theirs-only.txt"), "utf8") === "theirs post-rename\n",
    );
  }

  {
    const { repo, store, R } = await scenario("merge-lock");
    stores.push(store);
    writeFileSync(join(repo, "ours-only.txt"), "ours changed\n");
    const W = await store.capture(await gitHead(repo), R.commit);
    writeFileSync(join(repo, "ours-only.txt"), "ours base\n");
    writeFileSync(join(repo, "theirs-only.txt"), "theirs changed\n");
    const P = await store.capture(await gitHead(repo), R.commit);
    const ready = join(work, "merge-lock-ready");
    const release = join(work, "merge-lock-release");
    const unrefAttempt = join(work, "merge-lock-unref-attempt");
    const mergeRequest = requestCore(
      payload(store, "merge3", {
        ours: W.commit,
        theirs: P.commit,
        hooks: { pauseBeforeMergeRef: { readyPath: ready, releasePath: release } },
      }),
    );
    await waitForMarker(ready);
    let unrefSettled = false;
    const unrefRequest = requestCore(
      payload(store, "unref", {
        commit: R.commit,
        hooks: { mutationLockAttemptPath: unrefAttempt },
      }),
    ).then(
      (value) => {
        unrefSettled = true;
        return { ok: true, value };
      },
      (error) => {
        unrefSettled = true;
        return { ok: false, error };
      },
    );
    await waitForMarker(unrefAttempt);
    await delay(200);
    check("a second core unref blocks while merge owns the store mutation lock", !unrefSettled);
    writeFileSync(release, "release");
    const mergeResponse = await mergeRequest;
    await unrefRequest;
    const mergeResult = mergeResponse.result as { ok: boolean; tree: string | null };
    const mergeTarget = join(work, "merge-lock-materialized");
    if (mergeResult.tree) await materializeState(store, mergeResult.tree, mergeTarget);
    check(
      "concurrent merge and unref return a resolvable pinned tree",
      mergeResult.ok &&
        mergeResult.tree !== null &&
        readFileSync(join(mergeTarget, "ours-only.txt"), "utf8") === "ours changed\n" &&
        readFileSync(join(mergeTarget, "theirs-only.txt"), "utf8") === "theirs changed\n",
    );
  }

  {
    const { repo, store, R } = await scenario("store-create-lock");
    stores.push(store);
    writeFileSync(join(repo, "capture-during-create.txt"), "captured bytes\n");
    const ready = join(work, "capture-lock-ready");
    const release = join(work, "capture-lock-release");
    const createAttempt = join(work, "capture-lock-create-attempt");
    const captureRequest = requestCore(
      payload(store, "capture", {
        head: await gitHead(repo),
        parentCommit: R.commit,
        hooks: { pauseBeforeStateRef: { readyPath: ready, releasePath: release } },
      }),
    );
    await waitForMarker(ready);
    let createSettled = false;
    const createRequest = requestCore(
      payload(store, "store-create", {
        sourceGitDir: store.sourceGitDir,
        hooks: { mutationLockAttemptPath: createAttempt },
      }),
    ).then(
      (value) => {
        createSettled = true;
        return { ok: true as const, value };
      },
      (error) => {
        createSettled = true;
        return { ok: false as const, error };
      },
    );
    await waitForMarker(createAttempt);
    await delay(200);
    check("a second core store-create blocks while capture owns the store mutation lock", !createSettled);
    writeFileSync(release, "release");
    const captureResponse = await captureRequest;
    const createResult = await createRequest;
    const captured = captureResponse.state as SourceState;
    const resolved = execFileSync("git", ["rev-parse", `refs/termina/state/${captured.commit}`], {
      env: { ...process.env, GIT_DIR: store.gitDir },
      encoding: "utf8",
    }).trim();
    check(
      "a contended store-create reports the stable-lock contention",
      !createResult.ok && /changed while store-create waited/.test(String(createResult.error)),
      createResult.ok ? "unexpected success" : String(createResult.error),
    );
    check("concurrent store-create never invalidates a returned capture ref", resolved === captured.commit);
  }

  {
    const { repo, store, R } = await scenario("store-destroy-lock");
    stores.push(store);
    const lifecycleLock = join(dirname(store.dir), `.${basename(store.dir)}.termina-store.lock`);
    const lockBefore = statSync(lifecycleLock);
    const lockIdentity = `${lockBefore.dev}:${lockBefore.ino}`;
    writeFileSync(join(repo, "capture-during-destroy.txt"), "destroy lock bytes\n");
    const ready = join(work, "destroy-capture-ready");
    const release = join(work, "destroy-capture-release");
    const destroyAttempt = join(work, "destroy-lock-attempt");
    const captureRequest = requestCore(
      payload(store, "capture", {
        head: await gitHead(repo),
        parentCommit: R.commit,
        hooks: { pauseBeforeStateRef: { readyPath: ready, releasePath: release } },
      }),
    );
    await waitForMarker(ready);
    let destroySettled = false;
    const destroyRequest = requestCore(
      payload(store, "store-destroy", {
        hooks: { mutationLockAttemptPath: destroyAttempt },
      }),
    ).then(
      (value) => {
        destroySettled = true;
        return value;
      },
      (error) => {
        destroySettled = true;
        throw error;
      },
    );
    await waitForMarker(destroyAttempt);
    await delay(200);
    check("a second core destroy blocks while capture owns the stable lifecycle lock", !destroySettled);
    writeFileSync(release, "release");
    await captureRequest;
    await destroyRequest;
    check("store-destroy removes the store only after the in-flight capture settles", !existsSync(store.dir));
    check("store-destroy leaves the stable lifecycle lock linked", existsSync(lifecycleLock));

    const recreatedStore = await SnapshotStore.create(store.dir, store.sourceRoot, store.sourceGitDir, store.objectFormat);
    stores[stores.length - 1] = recreatedStore;
    const lockAfter = statSync(lifecycleLock);
    check("destroy/recreate serializes on the same lifecycle lock inode", `${lockAfter.dev}:${lockAfter.ino}` === lockIdentity);
    const recreated = await recreatedStore.capture(await gitHead(repo), null);
    const recreatedTarget = join(work, "destroy-recreated-target");
    await materializeState(recreatedStore, recreated.commit, recreatedTarget);
    check(
      "destroy/recreate serialization returns a resolvable state",
      readFileSync(join(recreatedTarget, "capture-during-destroy.txt"), "utf8") === "destroy lock bytes\n",
    );
  }

  {
    const nonStore = join(work, "not-a-snapshot-store");
    const sentinel = join(nonStore, "sentinel.txt");
    mkdirSync(nonStore);
    writeFileSync(sentinel, "must survive an invalid destroy request\n");
    let destroyError = "no error thrown";
    try {
      await requestCore({
        op: "store-destroy",
        storeDir: nonStore,
        objectFormat: "sha1",
      });
    } catch (error) {
      destroyError = String(error);
    }
    check(
      "store-destroy rejects a non-store directory without deleting its contents",
      /not a valid snapshot store/.test(destroyError) &&
        existsSync(sentinel) &&
        readFileSync(sentinel, "utf8") === "must survive an invalid destroy request\n",
      destroyError,
    );

    const survivingStore = stores.find((candidate) => existsSync(candidate.dir));
    if (!survivingStore) throw new Error("destroy hardening fixture needs one live snapshot store");
    const symlinkedStore = join(work, "symlinked-git-store-wrapper");
    const symlinkedSentinel = join(symlinkedStore, "sentinel.txt");
    mkdirSync(symlinkedStore);
    symlinkSync(survivingStore.gitDir, join(symlinkedStore, "git"), "dir");
    writeFileSync(symlinkedSentinel, "wrapper must survive a borrowed git directory\n");
    let symlinkedDestroyError = "no error thrown";
    try {
      await requestCore({
        op: "store-destroy",
        storeDir: symlinkedStore,
        objectFormat: survivingStore.objectFormat,
      });
    } catch (error) {
      symlinkedDestroyError = String(error);
    }
    check(
      "store-destroy rejects a wrapper that borrows another store through a git symlink",
      /not a valid snapshot store/.test(symlinkedDestroyError) && existsSync(symlinkedSentinel),
      symlinkedDestroyError,
    );
  }

  const failed = results.filter((r) => !r.ok).length;
  log(`\nmerge spike: ${results.length - failed}/${results.length} passed`);
  for (const s of stores) await s.destroy();
  rmSync(work, { recursive: true, force: true });
  if (failed > 0) process.exitCode = 1;
}
