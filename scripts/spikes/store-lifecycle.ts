/**
 * Deterministic snapshot-store lifecycle ABA probes.
 *
 * A stale request is admitted while the previous generation is live, waits
 * behind a store-create that installs a replacement generation, and must
 * fail before it opens or mutates the replacement.  The same protocol is
 * then exercised through CoreClient to prove the native error propagates and
 * a following request still succeeds.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotStore, type SnapshotStoreLifecycle } from "../../electron/worldline-git.js";
import { coreClient } from "../../electron/worldline-git/core-process.js";

type Lifecycle = SnapshotStoreLifecycle;

export default async function run(log: (msg: string) => void) {
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, ok: boolean, detail = "") => {
    results.push({ name, ok, detail });
    log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };
  const work = mkdtempSync(join(tmpdir(), "termina-store-lifecycle-"));
  const repo = join(work, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "payload.txt"), "generation-one\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Termina test"], { cwd: repo });
  execFileSync("git", ["add", "payload.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const coreBin = process.env.TERMINA_CORE_BIN ?? join(process.cwd(), "core", "target", "release", "termina-core");
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitForMarker = async (path: string) => {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if (existsSync(path)) return;
      await delay(5);
    }
    throw new Error(`timed out waiting for marker ${path}`);
  };
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
      child.stdin.end(`${JSON.stringify({ ...payload, requestId: `lifecycle-${Date.now()}-${Math.random()}` })}\n`);
    });
  const payload = (storeDir: string, lifecycle: Lifecycle, op: string, extra: Record<string, unknown> = {}) => ({
    op,
    storeDir,
    sourceRoot: repo,
    sourceGitDir: join(repo, ".git"),
    objectFormat: "sha1",
    ...extra,
    storeGeneration: lifecycle.generation,
    storeIdentity: lifecycle.identity,
    storeGitIdentity: lifecycle.git.git,
    storeGitObjectsIdentity: lifecycle.git.objects,
    storeGitObjectsInfoIdentity: lifecycle.git.objectsInfo,
    storeGitObjectsPackIdentity: lifecycle.git.objectsPack,
    storeGitRefsIdentity: lifecycle.git.refs,
    storeGitRefsHeadsIdentity: lifecycle.git.refsHeads,
    storeGitRefsTagsIdentity: lifecycle.git.refsTags,
  });
  const lifecycleFrom = (value: Record<string, unknown>): Lifecycle => {
    const generation = value.storeGeneration;
    const identity = value.storeIdentity;
    const git = value.storeGitIdentity;
    if (typeof generation !== "string" || !identity || typeof identity !== "object" || !git || typeof git !== "object") {
      throw new Error("store-create returned no lifecycle");
    }
    const { dev, ino } = identity as Record<string, unknown>;
    const directory = (raw: unknown, field: string) => {
      if (!raw || typeof raw !== "object") throw new Error(`store-create returned an invalid ${field}`);
      const value = raw as Record<string, unknown>;
      if (typeof value.dev !== "string" || typeof value.ino !== "string" || value.type !== "directory") throw new Error(`store-create returned an invalid ${field}`);
      return { dev: value.dev, ino: value.ino, type: "directory" as const };
    };
    if (typeof dev !== "string" || typeof ino !== "string") throw new Error("store-create returned an invalid identity");
    return {
      generation,
      identity: directory(identity, "storeIdentity"),
      git: {
        git: directory(value.storeGitIdentity, "storeGitIdentity"),
        objects: directory(value.storeGitObjectsIdentity, "storeGitObjectsIdentity"),
        objectsInfo: directory(value.storeGitObjectsInfoIdentity, "storeGitObjectsInfoIdentity"),
        objectsPack: directory(value.storeGitObjectsPackIdentity, "storeGitObjectsPackIdentity"),
        refs: directory(value.storeGitRefsIdentity, "storeGitRefsIdentity"),
        refsHeads: directory(value.storeGitRefsHeadsIdentity, "storeGitRefsHeadsIdentity"),
        refsTags: directory(value.storeGitRefsTagsIdentity, "storeGitRefsTagsIdentity"),
      },
    };
  };

  const storeDir = join(work, "store");
  const store = await SnapshotStore.create(storeDir, repo, join(repo, ".git"), "sha1");
  const oldLifecycle = store.lifecycle;
  const baseline = await store.capture(head, null);
  const recreateReady = join(work, "recreate-ready");
  const recreateRelease = join(work, "recreate-release");
  const recreateAttempt = join(work, "recreate-attempt");
  const staleAttempt = join(work, "stale-attempt");
  const recreateRequest = requestCore({
    op: "store-create",
    storeDir,
    sourceGitDir: join(repo, ".git"),
    objectFormat: "sha1",
    hooks: {
      mutationLockAttemptPath: recreateAttempt,
      pauseAfterStoreGeneration: { readyPath: recreateReady, releasePath: recreateRelease },
    },
  });
  await waitForMarker(recreateReady);
  const staleDestroy = requestCore(
    payload(storeDir, oldLifecycle, "store-destroy", { hooks: { mutationLockAttemptPath: staleAttempt } }),
  ).then(
    () => ({ ok: true as const, error: "" }),
    (error) => ({ ok: false as const, error: String(error) }),
  );
  await waitForMarker(staleAttempt);
  writeFileSync(recreateRelease, "release");
  const recreated = lifecycleFrom(await recreateRequest);
  const staleDestroyResult = await staleDestroy;
  check(
    "a waited destroy rejects after the store generation is recreated",
    !staleDestroyResult.ok && /lifecycle|generation|stale|changed/.test(staleDestroyResult.error),
    staleDestroyResult.error,
  );
  check("the stale destroy leaves the replacement store present", existsSync(storeDir));
  check("store-create returns a distinct lifecycle generation", recreated.generation !== oldLifecycle.generation);

  const validCapture = await requestCore(
    payload(storeDir, recreated, "capture", { head, parentCommit: null }),
  );
  check("the replacement generation remains usable after stale destroy error", typeof (validCapture.state as Record<string, unknown>)?.commit === "string");

  const staleCoreClientRequest = coreClient.request(payload(storeDir, oldLifecycle, "read-blob", {
    stateId: baseline.commit,
    relPath: "payload.txt",
  }));
  let propagatedError = "no error";
  try {
    await staleCoreClientRequest;
  } catch (error) {
    propagatedError = String(error);
  }
  check("CoreClient propagates the native stale-generation error", /lifecycle|generation|stale|changed/.test(propagatedError), propagatedError);
  const survivingRead = await coreClient.request(payload(storeDir, recreated, "read-blob", {
    stateId: (validCapture.state as Record<string, unknown>).commit,
    relPath: "payload.txt",
  }));
  check("CoreClient remains usable after a stale lifecycle rejection", typeof (survivingRead as Record<string, unknown>).content === "string");

  // Keep the store root and generation marker unchanged while replacing the
  // child bare repository.  The capture has already opened the old child;
  // its result must be rejected after the replacement rather than completing
  // against the new pathname.
  const childStoreDir = join(work, "child-aba-store");
  const childStore = await SnapshotStore.create(childStoreDir, repo, join(repo, ".git"), "sha1");
  const childBaseline = await childStore.capture(head, null);
  const childReady = join(work, "child-aba-ready");
  const childRelease = join(work, "child-aba-release");
  const childCapture = requestCore(payload(childStoreDir, childStore.lifecycle, "capture", {
    head,
    parentCommit: null,
    hooks: { pauseAfterCaptureRootOpen: { readyPath: childReady, releasePath: childRelease } },
  })).then(
    () => ({ ok: true as const, error: "" }),
    (error) => ({ ok: false as const, error: String(error) }),
  );
  await waitForMarker(childReady);
  const parkedGit = join(work, "child-aba-git-parked");
  renameSync(join(childStoreDir, "git"), parkedGit);
  execFileSync("git", ["init", "--bare", "-q", join(childStoreDir, "git")]);
  writeFileSync(childRelease, "release");
  const childResult = await childCapture;
  check(
    "a child-Git replacement rejects an already-open operation before its result",
    !childResult.ok && /lifecycle|generation|stale|changed/.test(childResult.error),
    childResult.error,
  );
  check("child-Git replacement remains intact after stale-result rejection", existsSync(join(childStoreDir, "git", "objects")));
  rmSync(join(childStoreDir, "git"), { recursive: true, force: true });
  renameSync(parkedGit, join(childStoreDir, "git"));

  // Repeat the same proof for a stable internal object-directory child while
  // the bare repository inode and root lifecycle remain unchanged.
  const objects = join(childStoreDir, "git", "objects");
  const parkedObjects = join(work, "child-aba-objects-parked");
  renameSync(objects, parkedObjects);
  mkdirSync(objects, { recursive: true });
  mkdirSync(join(objects, "info"));
  mkdirSync(join(objects, "pack"));
  let internalError = "";
  try {
    await requestCore(payload(childStoreDir, childStore.lifecycle, "tree-paths", { stateId: childBaseline.commit }));
  } catch (error) {
    internalError = String(error);
  }
  check(
    "a store object-directory replacement rejects before opening the repository",
    /lifecycle|generation|stale|changed/.test(internalError),
    internalError,
  );
  rmSync(objects, { recursive: true, force: true });
  renameSync(parkedObjects, objects);
  await requestCore(payload(childStoreDir, childStore.lifecycle, "store-destroy")).catch(() => undefined);

  await requestCore(payload(storeDir, recreated, "store-destroy")).catch(() => undefined);
  let idempotentDestroy = true;
  try {
    await store.destroy();
  } catch {
    idempotentDestroy = false;
  }
  check("destroy remains idempotent after the pathname is absent", idempotentDestroy);

  // Exercise every store mutator through the same deterministic lock-wait /
  // replacement boundary.  This is deliberately direct protocol traffic so
  // each waiter is a separate core process and cannot be hidden by the
  // in-process CoreClient queue.
  const staleCases: Array<{ name: string; op: string; extra: Record<string, unknown> }> = [
    { name: "capture", op: "capture", extra: { head, parentCommit: null } },
    { name: "capture-incremental", op: "capture-incremental", extra: { parentCommit: "BASELINE", hints: ["payload.txt"], reconcile: [] } },
    { name: "merge3", op: "merge3", extra: { ours: "BASELINE", theirs: "BASELINE" } },
    { name: "unref", op: "unref", extra: { commit: "BASELINE" } },
    { name: "store-destroy", op: "store-destroy", extra: {} },
  ];
  for (const staleCase of staleCases) {
    const caseDir = join(work, `store-${staleCase.name}`);
    const caseStore = await SnapshotStore.create(caseDir, repo, join(repo, ".git"), "sha1");
    const caseBaseline = await caseStore.capture(head, null);
    const caseReady = join(work, `${staleCase.name}-recreate-ready`);
    const caseRelease = join(work, `${staleCase.name}-recreate-release`);
    const caseRecreateAttempt = join(work, `${staleCase.name}-recreate-attempt`);
    const caseStaleAttempt = join(work, `${staleCase.name}-stale-attempt`);
    const caseRecreate = requestCore({
      op: "store-create",
      storeDir: caseDir,
      sourceGitDir: join(repo, ".git"),
      objectFormat: "sha1",
      hooks: {
        mutationLockAttemptPath: caseRecreateAttempt,
        pauseAfterStoreGeneration: { readyPath: caseReady, releasePath: caseRelease },
      },
    });
    await waitForMarker(caseReady);
    const caseExtra = { ...staleCase.extra };
    for (const [key, value] of Object.entries(caseExtra)) {
      if (value === "BASELINE") caseExtra[key] = caseBaseline.commit;
    }
    const caseStale = requestCore(
      payload(caseDir, caseStore.lifecycle, staleCase.op, {
        ...caseExtra,
        hooks: { mutationLockAttemptPath: caseStaleAttempt },
      }),
    ).then(
      () => ({ ok: true as const, error: "" }),
      (error) => ({ ok: false as const, error: String(error) }),
    );
    await waitForMarker(caseStaleAttempt);
    writeFileSync(caseRelease, "release");
    const caseReplacement = lifecycleFrom(await caseRecreate);
    const caseResult = await caseStale;
    check(
      `waited ${staleCase.name} rejects after destroy/recreate replacement`,
      !caseResult.ok && /lifecycle|generation|stale|changed/.test(caseResult.error),
      caseResult.error,
    );
    check(`stale ${staleCase.name} leaves the replacement pathname intact`, existsSync(caseDir));
    await requestCore(payload(caseDir, caseReplacement, "store-destroy")).catch(() => undefined);
  }

  // Pause after the destroy lifecycle's final validation and replace the
  // public pathname from outside Termina's mutation lock. A pathname rename
  // would delete the replacement; the native owner must fail closed while
  // preserving both the original (parked) store and the replacement.
  const destroyRaceDir = join(work, "store-destroy-race");
  const destroyRaceStore = await SnapshotStore.create(destroyRaceDir, repo, join(repo, ".git"), "sha1");
  await destroyRaceStore.capture(head, null);
  const replacementSeedDir = join(work, "store-destroy-race-replacement");
  const replacementSeed = await SnapshotStore.create(replacementSeedDir, repo, join(repo, ".git"), "sha1");
  const replacementState = await replacementSeed.capture(head, null);
  const destroyRaceReady = join(work, "store-destroy-race-ready");
  const destroyRaceRelease = join(work, "store-destroy-race-release");
  const destroyRace = requestCore(payload(destroyRaceDir, destroyRaceStore.lifecycle, "store-destroy", {
    hooks: {
      pauseBeforeStoreDestroyRename: {
        readyPath: destroyRaceReady,
        releasePath: destroyRaceRelease,
      },
    },
  })).then(
    () => ({ ok: true as const, error: "" }),
    (error) => ({ ok: false as const, error: String(error) }),
  );
  await waitForMarker(destroyRaceReady);
  const parkedDestroyRace = join(work, "store-destroy-race-original");
  renameSync(destroyRaceDir, parkedDestroyRace);
  renameSync(replacementSeedDir, destroyRaceDir);
  writeFileSync(destroyRaceRelease, "release");
  const destroyRaceResult = await destroyRace;
  check(
    "store-destroy fails closed when its validated pathname is replaced",
    !destroyRaceResult.ok && /identity|lifecycle|changed|replacement|stale|race/.test(destroyRaceResult.error),
    destroyRaceResult.error,
  );
  check("store-destroy race preserves the replacement store", existsSync(join(destroyRaceDir, "git", "objects")));
  check("store-destroy race preserves the original store", existsSync(join(parkedDestroyRace, "git", "objects")));
  let replacementRead = false;
  try {
    const response = await requestCore(payload(destroyRaceDir, replacementSeed.lifecycle, "read-blob", {
      stateId: replacementState.commit,
      relPath: "payload.txt",
    }));
    replacementRead = typeof response.content === "string";
  } catch {
    replacementRead = false;
  }
  check("store-destroy race leaves the replacement usable", replacementRead);
  await replacementSeed.destroy().catch(() => undefined);
  rmSync(parkedDestroyRace, { recursive: true, force: true });

  // The quarantine claim itself is also paused. Replacing the public leaf
  // after the descriptor-relative rename must retain the claimed original in
  // quarantine and reject before recursive cleanup, while the new store stays
  // visible and usable at the public pathname.
  const postClaimDir = join(work, "post-claim-destroy-race");
  const postClaimStore = await SnapshotStore.create(postClaimDir, repo, join(repo, ".git"), "sha1");
  await postClaimStore.capture(head, null);
  const postClaimReplacementDir = join(work, "post-claim-destroy-replacement");
  const postClaimReplacement = await SnapshotStore.create(postClaimReplacementDir, repo, join(repo, ".git"), "sha1");
  const postClaimState = await postClaimReplacement.capture(head, null);
  const postClaimReady = join(work, "post-claim-destroy-ready");
  const postClaimRelease = join(work, "post-claim-destroy-release");
  const postClaimDestroy = requestCore(payload(postClaimDir, postClaimStore.lifecycle, "store-destroy", {
    hooks: {
      pauseAfterStoreDestroyRename: {
        readyPath: postClaimReady,
        releasePath: postClaimRelease,
      },
    },
  })).then(
    () => ({ ok: true as const, error: "" }),
    (error) => ({ ok: false as const, error: String(error) }),
  );
  await waitForMarker(postClaimReady);
  renameSync(postClaimReplacementDir, postClaimDir);
  writeFileSync(postClaimRelease, "release");
  const postClaimResult = await postClaimDestroy;
  const retainedClaim = readdirSync(work).some((name) => name.startsWith(".post-claim-destroy-race.termina-destroy-"));
  check(
    "store-destroy rejects a public replacement after its quarantine claim",
    !postClaimResult.ok && /replaced|retained|changed|store/i.test(postClaimResult.error),
    postClaimResult.error,
  );
  check("post-claim destroy preserves the replacement pathname", existsSync(join(postClaimDir, "git", "objects")));
  check("post-claim destroy retains the claimed original quarantine", retainedClaim);
  let postClaimRead = false;
  try {
    const response = await requestCore(payload(postClaimDir, postClaimReplacement.lifecycle, "read-blob", {
      stateId: postClaimState.commit,
      relPath: "payload.txt",
    }));
    postClaimRead = typeof response.content === "string";
  } catch {
    postClaimRead = false;
  }
  check("post-claim replacement remains usable after stale destroy rejection", postClaimRead);

  rmSync(work, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  log(`\nstore-lifecycle spike: ${results.length - failed}/${results.length} passed`);
  if (failed > 0) process.exitCode = 1;
}
