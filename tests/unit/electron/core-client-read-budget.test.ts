import { describe, it, expect } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { coreClient } from "../../../electron/core-client.ts";
import { parseNativeByteBound } from "../../test-support.ts";

process.env.TERMINA_CORE_BIN ??= resolve("core/target/release/termina-core");

describe("Core Client Read Budget & Native Bound Invariants", () => {
  it("enforces native read budget limits and fails closed on overflow", async () => {
    const root = mkdtempSync(join(tmpdir(), "termina-core-read-budget-"));
const repo = join(root, "repo");
const store = join(root, "store");
const rawAtNativeLimit = 47 * 1024 * 1024;
const rawOverNativeLimit = 48 * 1024 * 1024;

function git(...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function gitAt(directory, ...args) {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
}

async function waitForMarker(path) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(`timed out waiting for marker ${path}`);
}

try {
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "small.txt"), "small\n");
  writeFileSync(join(repo, "blob-at-native-limit.bin"), Buffer.alloc(rawAtNativeLimit, 0x61));
  writeFileSync(join(repo, "blob-over-native-limit.bin"), Buffer.alloc(rawOverNativeLimit, 0x62));
  git("init", "--quiet");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Termina test");
  git("add", ".");
  git("commit", "--quiet", "-m", "read budget fixture");
  const commit = git("rev-parse", "HEAD");

  const created = await coreClient.request({ op: "store-create", storeDir: store, sourceRoot: repo, sourceGitDir: join(repo, ".git"), objectFormat: "sha1" });
  const storeLifecycle = {
    storeGeneration: created.storeGeneration,
    storeIdentity: created.storeIdentity,
    storeGitIdentity: created.storeGitIdentity,
    storeGitObjectsIdentity: created.storeGitObjectsIdentity,
    storeGitObjectsInfoIdentity: created.storeGitObjectsInfoIdentity,
    storeGitObjectsPackIdentity: created.storeGitObjectsPackIdentity,
    storeGitRefsIdentity: created.storeGitRefsIdentity,
    storeGitRefsHeadsIdentity: created.storeGitRefsHeadsIdentity,
    storeGitRefsTagsIdentity: created.storeGitRefsTagsIdentity,
  };
  const storeRequest = (extra) => ({
    storeDir: store,
    sourceRoot: repo,
    sourceGitDir: join(repo, ".git"),
    objectFormat: "sha1",
    ...extra,
    ...storeLifecycle,
  });
  const captured = await coreClient.request(storeRequest({
    op: "capture",
    head: commit,
    parentCommit: null,
    budget: { maxFileBytes: 64 * 1024 * 1024, maxNewBlobBytes: 200 * 1024 * 1024 },
  }));
  const state = captured.commit;

  // macOS exposes /var as a fixed system alias for /private/var. Exercise
  // both spellings through the no-follow capture boundary; this is deliberately
  // not a general realpath walk for caller-controlled symlink components.
  if (process.platform === "darwin") {
    const canonicalRoot = realpathSync(root);
    if (canonicalRoot.startsWith("/private/var/") || canonicalRoot === "/private/var") {
      const aliasRoot = canonicalRoot.replace(/^\/private\/var(?=\/|$)/, "/var");
      const canonicalRepo = join(canonicalRoot, "repo");
      const canonicalStore = join(canonicalRoot, "store");
      const aliasRepo = join(aliasRoot, "repo");
      const aliasStore = join(aliasRoot, "store");
      const canonicalCapture = await coreClient.request(storeRequest({
        op: "capture",
        sourceRoot: canonicalRepo,
        sourceGitDir: join(canonicalRepo, ".git"),
        storeDir: canonicalStore,
        head: commit,
        parentCommit: null,
        budget: { maxFileBytes: 64 * 1024 * 1024, maxNewBlobBytes: 200 * 1024 * 1024 },
      }));
      assert.ok(canonicalCapture.commit, "canonical /private/var capture returned no state");
      if (repo !== aliasRepo || store !== aliasStore) {
        const aliasCapture = await coreClient.request(storeRequest({
          op: "capture",
          sourceRoot: aliasRepo,
          sourceGitDir: join(aliasRepo, ".git"),
          storeDir: aliasStore,
          head: commit,
          parentCommit: null,
          budget: { maxFileBytes: 64 * 1024 * 1024, maxNewBlobBytes: 200 * 1024 * 1024 },
        }));
        assert.ok(aliasCapture.commit, "aliased /var capture returned no state");
      }
      console.log("PASS exact /var and /private/var capture spellings bind the same root safely");
    } else {
      console.log("SKIP exact /var and /private/var probe: temporary root is outside /private/var");
    }
  }

  const readBlob = async (relPath) => coreClient.request(storeRequest({ op: "read-blob", stateId: state, relPath }));
  const repoFile = async (path) => coreClient.request({ op: "repo-file", root: repo, commit, path });
  const blobAtLimit = await readBlob("blob-at-native-limit.bin");
  assert.equal(Buffer.from(blobAtLimit.content, "base64").byteLength, rawAtNativeLimit);
  const fileAtLimit = await repoFile("blob-at-native-limit.bin");
  assert.equal(Buffer.from(fileAtLimit.content, "base64").byteLength, rawAtNativeLimit);
  console.log("PASS native-limit read-blob and repo-file payloads round-trip through CoreClient");

  async function rejectAtNativeReadBound(operation, label) {
    let failure;
    try {
      await operation();
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, `${label} did not reject an over-bound payload`);
    return parseNativeByteBound(failure?.message ?? failure);
  }

  const blobBound = await rejectAtNativeReadBound(
    () => readBlob("blob-over-native-limit.bin"),
    "read-blob",
  );
  const fileBound = await rejectAtNativeReadBound(
    () => repoFile("blob-over-native-limit.bin"),
    "repo-file",
  );
  assert.equal(blobBound, rawAtNativeLimit, "read-blob error should expose the native boundary used by the fixture");
  assert.equal(fileBound, blobBound, "repo-file and read-blob should expose the same native boundary");
  assert.equal((await readBlob("small.txt")).content, Buffer.from("small\n").toString("base64"));
  assert.equal((await repoFile("small.txt")).content, Buffer.from("small\n").toString("base64"));
  console.log("PASS over-bound read rejections expose the native byte limit and the same CoreClient survives");

  // A caller-controlled symlink remains rejected even when its path starts
  // with the macOS /var spelling accepted above.
  const arbitraryLink = join(root, "arbitrary-root-link");
  symlinkSync(repo, arbitraryLink);
  await assert.rejects(
    coreClient.request(storeRequest({
      op: "capture",
      sourceRoot: arbitraryLink,
      sourceGitDir: join(arbitraryLink, ".git"),
      head: commit,
      parentCommit: null,
      budget: { maxFileBytes: 64 * 1024 * 1024, maxNewBlobBytes: 200 * 1024 * 1024 },
    })),
    /capture root|symlink|component|ELOOP/,
  );
  rmSync(arbitraryLink, { force: true });
  console.log("PASS arbitrary symlinked capture roots remain rejected");

  // Hold the capture-root capability, then replace its ancestor with another
  // repository before libgit2 is allowed to open the pathname. The request
  // must fail closed and retain the previously committed source evidence.
  const ancestorOriginal = join(root, "ancestor-original");
  const ancestorReplacement = join(root, "ancestor-replacement");
  const ancestorRepo = join(ancestorOriginal, "repo");
  const replacementRepo = join(ancestorReplacement, "repo");
  for (const [directory, contents] of [[ancestorRepo, "ancestor-A\n"], [replacementRepo, "ancestor-B\n"]]) {
    mkdirSync(directory, { recursive: true });
    gitAt(directory, "init", "--quiet");
    gitAt(directory, "config", "user.email", "test@example.invalid");
    gitAt(directory, "config", "user.name", "Termina test");
    writeFileSync(join(directory, "payload.txt"), contents);
    gitAt(directory, "add", "payload.txt");
    gitAt(directory, "commit", "--quiet", "-m", "ancestor fixture");
  }
  const ancestorStore = join(root, "ancestor-store");
  const ancestorGitDir = join(ancestorRepo, ".git");
  const ancestorCreated = await coreClient.request({
    op: "store-create",
    storeDir: ancestorStore,
    sourceRoot: ancestorRepo,
    sourceGitDir: ancestorGitDir,
    objectFormat: "sha1",
  });
  const ancestorLifecycle = {
    storeGeneration: ancestorCreated.storeGeneration,
    storeIdentity: ancestorCreated.storeIdentity,
    storeGitIdentity: ancestorCreated.storeGitIdentity,
    storeGitObjectsIdentity: ancestorCreated.storeGitObjectsIdentity,
    storeGitObjectsInfoIdentity: ancestorCreated.storeGitObjectsInfoIdentity,
    storeGitObjectsPackIdentity: ancestorCreated.storeGitObjectsPackIdentity,
    storeGitRefsIdentity: ancestorCreated.storeGitRefsIdentity,
    storeGitRefsHeadsIdentity: ancestorCreated.storeGitRefsHeadsIdentity,
    storeGitRefsTagsIdentity: ancestorCreated.storeGitRefsTagsIdentity,
  };
  const ancestorRequest = (extra) => ({
    storeDir: ancestorStore,
    sourceRoot: ancestorRepo,
    sourceGitDir: ancestorGitDir,
    objectFormat: "sha1",
    ...extra,
    ...ancestorLifecycle,
  });
  const ancestorCommit = gitAt(ancestorRepo, "rev-parse", "HEAD");
  const ancestorBase = await coreClient.request(ancestorRequest({
    op: "capture",
    head: ancestorCommit,
    parentCommit: null,
    budget: { maxFileBytes: 64 * 1024 * 1024, maxNewBlobBytes: 200 * 1024 * 1024 },
  }));
  const ancestorReady = join(root, "ancestor-swap-ready");
  const ancestorRelease = join(root, "ancestor-swap-release");
  const ancestorBackup = join(root, "ancestor-original-backup");
  const ancestorCapture = coreClient.request(ancestorRequest({
    op: "capture",
    head: ancestorCommit,
    parentCommit: ancestorBase.commit,
    budget: { maxFileBytes: 64 * 1024 * 1024, maxNewBlobBytes: 200 * 1024 * 1024 },
    hooks: { pauseAfterCaptureRootOpen: { readyPath: ancestorReady, releasePath: ancestorRelease } },
  }));
  await waitForMarker(ancestorReady);
  renameSync(ancestorOriginal, ancestorBackup);
  renameSync(ancestorReplacement, ancestorOriginal);
  writeFileSync(ancestorRelease, "release");
  await assert.rejects(ancestorCapture, /capture root|worktree|identity|repository|Git directory/);
  rmSync(ancestorOriginal, { recursive: true, force: true });
  renameSync(ancestorBackup, ancestorOriginal);
  const retainedAncestor = await coreClient.request(ancestorRequest({
    op: "read-blob",
    stateId: ancestorBase.commit,
    relPath: "payload.txt",
  }));
  assert.equal(Buffer.from(retainedAncestor.content, "base64").toString(), "ancestor-A\n");
    } finally {
      coreClient.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
