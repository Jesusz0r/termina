import { describe, it } from "vitest";
/** Regression tests for reproducible, fail-closed Node runtime staging. */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";


describe("Node Runtime Staging & Preparation Invariants", () => {
  it("verifies fail-closed staging invariants", async () => {
const sourceUrl = new URL("../../../scripts/prepare-resources.mjs", import.meta.url);
const {
  PINNED_NODE_VERSION,
  downloadVerifiedArchive,
  nodeReleaseFor,
  prepareNode,
} = await import(sourceUrl.href);

assert.equal(PINNED_NODE_VERSION, "v22.23.2");
assert.deepEqual(
  [
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["linux", "arm64"],
    ["linux", "x64"],
  ].map(([os, arch]) => {
    const release = nodeReleaseFor(os, arch);
    return [release.archiveName, release.url, release.sha256];
  }),
  [
    ["node-v22.23.2-darwin-arm64.tar.gz", "https://nodejs.org/dist/v22.23.2/node-v22.23.2-darwin-arm64.tar.gz", "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6"],
    ["node-v22.23.2-darwin-x64.tar.gz", "https://nodejs.org/dist/v22.23.2/node-v22.23.2-darwin-x64.tar.gz", "58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026"],
    ["node-v22.23.2-linux-arm64.tar.gz", "https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-arm64.tar.gz", "013b59cfd2819703a6f4a14ab891fc46fc2a4e3f5bcd92de3fb4929b43e35b30"],
    ["node-v22.23.2-linux-x64.tar.gz", "https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.gz", "b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a"],
  ],
  "the checked-in archive map must retain the official Node.js SHA-256 values",
);
const fixtureBytes = Buffer.from("verified-node-archive");
const fixtureDigest = "8ccea8c25445345293d645a4d78127527f6367e7a8b21b6a397759ed51066e96";
const roots = [];
function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "termina-node-runtime-test-"));
  roots.push(root);
  return root;
}

function quietLogger() {
  return { log() {}, warn() {} };
}
function lockOwnerRecordName(owner) {
  return `.record-${owner.token}-${owner.dev}-${owner.ino}`;
}
function writeLockOwner(lockPath, owner) {
  const name = lockOwnerRecordName(owner);
  writeFileSync(join(lockPath, name), JSON.stringify(owner), { mode: 0o600 });
  return name;
}
function readLockOwner(lockPath) {
  const names = readdirSync(lockPath).filter((name) => /^\.record-[a-f0-9]{32}-\d+-\d+$/.test(name));
  assert.equal(names.length, 1, "a published lock must have one inode-bound owner record");
  const raw = readFileSync(join(lockPath, names[0]), "utf8");
  return { name: names[0], raw, owner: JSON.parse(raw) };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const fixtureRoot = tempRoot();
const fixtureRelease = nodeReleaseFor("linux", "x64");
const fixtureSource = join(fixtureRoot, "source");
const fixtureRuntime = join(fixtureSource, fixtureRelease.directoryName);
mkdirSync(join(fixtureRuntime, "bin"), { recursive: true });
writeFileSync(join(fixtureRuntime, "bin", "node"), `#!/bin/sh\nprintf '${PINNED_NODE_VERSION}\\n'\n`);
chmodSync(join(fixtureRuntime, "bin", "node"), 0o755);
writeFileSync(join(fixtureRuntime, "origin"), "verified-fixture");
const fixtureArchive = join(fixtureRoot, fixtureRelease.archiveName);
execFileSync("/usr/bin/tar", ["-czf", fixtureArchive, "-C", fixtureSource, fixtureRelease.directoryName]);
const fixtureArchiveBytes = readFileSync(fixtureArchive);
const fixtureArchiveDigest = createHash("sha256").update(fixtureArchiveBytes).digest("hex");

function downloadFixture({ destination, logger }) {
  return downloadVerifiedArchive({
    url: "https://fixture.invalid/node.tar.gz",
    destination,
    sha256: fixtureArchiveDigest,
    fetchImpl: async () => new Response(fixtureArchiveBytes),
    logger,
  });
}

function concurrentChildCode() {
  return `
    import { copyFileSync, existsSync, writeFileSync } from "node:fs";
    const { prepareNode } = await import(${JSON.stringify(sourceUrl.href)});
    const wait = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
    await prepareNode({
      resourcesDir: process.env.TERMINA_NODE_TEST_RESOURCES,
      targetPlatform: "linux",
      targetArch: "x64",
      lockTimeoutMs: 5_000,
      lockPollMs: 5,
      async downloadArchive({ destination }) {
        writeFileSync(process.env.TERMINA_NODE_TEST_ENTERED, "entered");
        const release = process.env.TERMINA_NODE_TEST_RELEASE;
        while (release && !existsSync(release)) await wait(5);
        copyFileSync(process.env.TERMINA_NODE_TEST_ARCHIVE, destination);
      },
      logger: { log() {}, warn() {} },
    });
    process.stdout.write("ok");
  `;
}

function startConcurrentChild(env) {
  const child = spawn(process.execPath, ["-e", concurrentChildCode()], {
    cwd: resolve("."),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = once(child, "close");
  return {
    child,
    async result() {
      const [code, signal] = await closed;
      return { code, signal, stdout, stderr };
    },
  };
}

async function waitForFile(path, message) {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
}

try {
  {
    const root = tempRoot();
    const archive = join(root, "verified.tar.gz");
    await downloadVerifiedArchive({
      url: "https://fixture.invalid/node.tar.gz",
      destination: archive,
      sha256: fixtureDigest,
      fetchImpl: async () => new Response(fixtureBytes),
      logger: quietLogger(),
    });
    assert.deepEqual(readFileSync(archive), fixtureBytes);
    console.log("PASS a known correct SHA-256 is accepted");
  }
  {
    const root = tempRoot();
    const destination = join(root, "too-large-by-header.tar.gz");
    await assert.rejects(
      downloadVerifiedArchive({
        url: "https://fixture.invalid/node.tar.gz",
        destination,
        sha256: fixtureDigest,
        maxBytes: fixtureBytes.length,
        fetchImpl: async () => new Response(fixtureBytes, {
          headers: { "content-length": String(fixtureBytes.length + 1) },
        }),
        logger: quietLogger(),
      }),
      /exceeds/i,
    );
    assert.equal(existsSync(destination), false, "a rejected Content-Length must not create an archive");
    console.log("PASS the declared archive size cap fails before file creation");
  }
  {
    const root = tempRoot();
    const destination = join(root, "too-large-stream.tar.gz");
    await assert.rejects(
      downloadVerifiedArchive({
        url: "https://fixture.invalid/node.tar.gz",
        destination,
        sha256: fixtureDigest,
        maxBytes: fixtureBytes.length - 1,
        fetchImpl: async () => new Response(fixtureBytes),
        logger: quietLogger(),
      }),
      /exceeds/i,
    );
    assert.equal(existsSync(destination), false, "an over-cap partial archive must be deleted");
    console.log("PASS the streamed archive size cap deletes partial bytes");
  }

  {
    const root = tempRoot();
    const resourcesDir = join(root, "resources");
    const oldNode = join(resourcesDir, "node", "bin", "node");
    mkdirSync(join(resourcesDir, "node", "bin"), { recursive: true });
    writeFileSync(oldNode, "prior-runtime");
    let extractCalled = false;

    await assert.rejects(
      prepareNode({
        resourcesDir,
        targetPlatform: "darwin",
        targetArch: "arm64",
        fetchImpl: async () => new Response(Buffer.concat([fixtureBytes, Buffer.from("!")])),
        downloadArchive({ destination, fetchImpl, logger }) {
          return downloadVerifiedArchive({
            url: "https://fixture.invalid/node.tar.gz",
            destination,
            sha256: fixtureDigest,
            fetchImpl,
            logger,
          });
        },
        extractArchive() {
          extractCalled = true;
        },
        runNode(binary) {
          return binary === oldNode ? "v22.22.0\n" : `${PINNED_NODE_VERSION}\n`;
        },
        logger: quietLogger(),
      }),
      /checksum mismatch/i,
    );
    assert.equal(extractCalled, false, "checksum mismatch must abort before extraction");
    assert.equal(readFileSync(oldNode, "utf8"), "prior-runtime", "checksum mismatch must preserve the staged runtime");
    assert.deepEqual(readdirSync(resourcesDir), ["node"], "a rejected archive and its unique staging directory must be removed");
    console.log("PASS a one-byte mismatch fails before extraction or replacement");
  }

  {
    const root = tempRoot();
    let fetchCalls = 0;
    assert.throws(() => nodeReleaseFor("win32", "x64"), /unsupported Node runtime platform/i);
    await assert.rejects(
      prepareNode({
        resourcesDir: join(root, "resources"),
        targetPlatform: "freebsd",
        targetArch: "x64",
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response(fixtureBytes);
        },
        logger: quietLogger(),
      }),
      /unsupported Node runtime platform/i,
    );
    assert.equal(fetchCalls, 0, "unsupported targets must fail before network access");
    console.log("PASS unsupported platforms fail closed before download");
  }

  {
    const root = tempRoot();
    const externalResources = join(root, "external-resources");
    mkdirSync(externalResources);
    const resourcesDir = join(root, "resources");
    symlinkSync(externalResources, resourcesDir, "dir");
    let downloads = 0;
    await assert.rejects(
      prepareNode({
        resourcesDir,
        targetPlatform: "linux",
        targetArch: "x64",
        async downloadArchive() { downloads += 1; },
        logger: quietLogger(),
      }),
      /resources directory.*symlink|real directory/i,
    );
    assert.equal(downloads, 0, "a symlinked resources root must fail before download");
    assert.deepEqual(readdirSync(externalResources), [], "the symlink target must not be modified");
    console.log("PASS a symlinked resources root fails closed before network or writes");
  }

  {
    const root = tempRoot();
    const resourcesDir = join(root, "resources");
    const entered = deferred();
    const release = deferred();
    const holder = prepareNode({
      resourcesDir,
      targetPlatform: "linux",
      targetArch: "x64",
      async downloadArchive({ destination }) {
        entered.resolve();
        await release.promise;
        writeFileSync(destination, fixtureBytes);
      },
      extractArchive({ destinationDir, release: nodeRelease }) {
        const stagedBin = join(destinationDir, nodeRelease.directoryName, "bin", "node");
        mkdirSync(join(destinationDir, nodeRelease.directoryName, "bin"), { recursive: true });
        writeFileSync(stagedBin, "verified-holder");
      },
      runNode() { return `${PINNED_NODE_VERSION}\n`; },
      logger: quietLogger(),
    });
    await entered.promise;
    try {
      await assert.rejects(
        prepareNode({
          resourcesDir,
          targetPlatform: "linux",
          targetArch: "x64",
          lockTimeoutMs: 40,
          lockPollMs: 5,
          async downloadArchive() {
            throw new Error("contender reached download without holding the lock");
          },
          logger: quietLogger(),
        }),
        /node runtime busy/i,
      );
    } finally {
      release.resolve();
      await holder;
    }
    console.log("PASS a live owner is respected with bounded lock waiting");
  }

  {
    const root = tempRoot();
    const resourcesDir = join(root, "resources");
    const firstEntered = join(root, "first-entered");
    const secondEntered = join(root, "second-entered");
    const releaseFirst = join(root, "release-first");
    const first = startConcurrentChild({
      TERMINA_NODE_TEST_RESOURCES: resourcesDir,
      TERMINA_NODE_TEST_ARCHIVE: fixtureArchive,
      TERMINA_NODE_TEST_ENTERED: firstEntered,
      TERMINA_NODE_TEST_RELEASE: releaseFirst,
    });
    let second;
    try {
      await waitForFile(firstEntered, "first preparer never entered its download");
      second = startConcurrentChild({
        TERMINA_NODE_TEST_RESOURCES: resourcesDir,
        TERMINA_NODE_TEST_ARCHIVE: fixtureArchive,
        TERMINA_NODE_TEST_ENTERED: secondEntered,
      });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      assert.equal(existsSync(secondEntered), false, "the second process entered before the first released its lock");
      writeFileSync(releaseFirst, "release");
      const [firstResult, secondResult] = await Promise.all([first.result(), second.result()]);
      for (const [name, result] of [["first", firstResult], ["second", secondResult]]) {
        assert.equal(result.code, 0, `${name} preparer failed (${result.signal}): ${result.stderr}`);
        assert.equal(result.stdout, "ok", `${name} preparer did not complete`);
      }
    } finally {
      if (first.child.exitCode === null) first.child.kill("SIGKILL");
      if (second?.child.exitCode === null) second.child.kill("SIGKILL");
    }
    assert.deepEqual(readdirSync(resourcesDir), ["node"], "concurrent prepares must leave no lock/stage/backup artifacts");
    assert.equal(readFileSync(join(resourcesDir, "node", "origin"), "utf8"), "verified-fixture");
    console.log("PASS two processes serialize complete offline preparations");
  }

  {
    const root = tempRoot();
    const resourcesDir = join(root, "resources");
    const oldNode = join(resourcesDir, "node", "bin", "node");
    mkdirSync(dirname(oldNode), { recursive: true });
    writeFileSync(oldNode, "prior-runtime");
    const lockPath = join(resourcesDir, ".node-prepare.lock");
    let replacementOwner;

    await assert.rejects(
      prepareNode({
        resourcesDir,
        targetPlatform: "linux",
        targetArch: "x64",
        async downloadArchive({ destination }) {
          const published = readLockOwner(lockPath);
          replacementOwner = published.owner;
          rmSync(lockPath, { recursive: true, force: true });
          mkdirSync(lockPath, { mode: 0o700 });
          mkdirSync(join(lockPath, `.owner-${replacementOwner.token}`), { mode: 0o700 });
          writeFileSync(join(lockPath, published.name), published.raw, { mode: 0o600 });
          copyFileSync(fixtureArchive, destination);
        },
        logger: quietLogger(),
      }),
      /node runtime lock lost/i,
    );
    assert.equal(readFileSync(oldNode, "utf8"), "prior-runtime", "a lost lock must abort before target mutation");
    assert.equal(readLockOwner(lockPath).raw, JSON.stringify(replacementOwner));
    assert.equal(existsSync(join(lockPath, `.owner-${replacementOwner.token}`)), true);
    console.log("PASS lock replacement aborts mutation and is never deleted by the former owner");
  }

  {
    const root = tempRoot();
    const resourcesDir = join(root, "resources");
    const oldNode = join(resourcesDir, "node", "bin", "node");
    mkdirSync(dirname(oldNode), { recursive: true });
    writeFileSync(oldNode, "prior-runtime");
    const lockPath = join(resourcesDir, ".node-prepare.lock");
    let copiedOwner;

    await assert.rejects(
      prepareNode({
        resourcesDir,
        targetPlatform: "linux",
        targetArch: "x64",
        downloadArchive: downloadFixture,
        logger: {
          warn() {},
          log(message) {
            if (!String(message).includes("staged")) return;
            const published = readLockOwner(lockPath);
            copiedOwner = published.owner;
            rmSync(lockPath, { recursive: true, force: true });
            mkdirSync(lockPath, { mode: 0o700 });
            mkdirSync(join(lockPath, `.owner-${copiedOwner.token}`), { mode: 0o700 });
            writeFileSync(join(lockPath, published.name), published.raw, { mode: 0o600 });
          },
        },
      }),
      /node runtime lock lost/i,
    );
    assert.equal(readFileSync(join(resourcesDir, "node", "origin"), "utf8"), "verified-fixture");
    assert.equal(readLockOwner(lockPath).raw, JSON.stringify(copiedOwner));
    console.log("PASS ownership loss after installation is reported without deleting the replacement lock");
  }

  {
    const root = tempRoot();
    const resourcesDir = join(root, "resources");
    const targetDir = join(resourcesDir, "node");
    const oldNode = join(targetDir, "bin", "node");
    mkdirSync(join(targetDir, "bin"), { recursive: true });
    writeFileSync(oldNode, "prior-runtime");

    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    assert.equal(dead.status, 0);
    const token = "0123456789abcdef0123456789abcdef";
    const lockPath = join(resourcesDir, ".node-prepare.lock");
    mkdirSync(lockPath, { mode: 0o700 });
    const lockStat = lstatSync(lockPath);
    const owner = {
      pid: Number(dead.stdout),
      token,
      startedAt: 1,
      processIdentity: "dead-owner-instance",
      dev: lockStat.dev,
      ino: lockStat.ino,
    };
    mkdirSync(join(lockPath, `.owner-${token}`), { mode: 0o700 });
    writeLockOwner(lockPath, owner);
    const staleStage = join(resourcesDir, `.node-stage-${token}-ABC123`);
    mkdirSync(staleStage);
    writeFileSync(join(staleStage, "partial"), "stale");
    const candidateToken = "abcdef0123456789abcdef0123456789";
    const deadCandidate = join(resourcesDir, `.node-lock-candidate-${dead.stdout}-${candidateToken}`);
    mkdirSync(deadCandidate, { mode: 0o700 });
    const candidateStat = lstatSync(deadCandidate);
    const candidateOwner = {
      pid: Number(dead.stdout),
      token: candidateToken,
      startedAt: 1,
      processIdentity: "dead-candidate-instance",
      dev: candidateStat.dev,
      ino: candidateStat.ino,
    };
    mkdirSync(join(deadCandidate, `.owner-${candidateToken}`), { mode: 0o700 });
    writeLockOwner(deadCandidate, candidateOwner);
    const staleBackup = join(resourcesDir, `.node-backup-${token}`);
    renameSync(targetDir, staleBackup);

    await assert.rejects(
      prepareNode({
        resourcesDir,
        targetPlatform: "linux",
        targetArch: "x64",
        lockTimeoutMs: 80,
        lockPollMs: 5,
        async downloadArchive() { throw new Error("offline download failed"); },
        logger: quietLogger(),
      }),
      /offline download failed/,
    );
    assert.equal(readFileSync(oldNode, "utf8"), "prior-runtime", "a stale backup must be restored before retrying");
    assert.equal(existsSync(staleStage), false, "a dead owner's exact stage must be swept");
    assert.equal(existsSync(deadCandidate), false, "a fully identified dead lock candidate must be swept");
    assert.equal(existsSync(staleBackup), false, "the restored stale backup name must be removed");
    assert.equal(existsSync(lockPath), false, "the recovered lock must be released after the failed retry");
    assert.deepEqual(readdirSync(resourcesDir), ["node"]);
    console.log("PASS a dead owner is recovered without losing its prior runtime");
  }

  const reusedPidProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
  await once(reusedPidProcess, "spawn");
  try {
    {
      const root = tempRoot();
      const resourcesDir = join(root, "resources");
      const targetDir = join(resourcesDir, "node");
      const oldNode = join(targetDir, "bin", "node");
      mkdirSync(dirname(oldNode), { recursive: true });
      writeFileSync(oldNode, "prior-runtime");

      const token = "33333333333333333333333333333333";
      const lockPath = join(resourcesDir, ".node-prepare.lock");
      mkdirSync(lockPath, { mode: 0o700 });
      const lockStat = lstatSync(lockPath);
      const owner = {
        pid: reusedPidProcess.pid, token, startedAt: 1, processIdentity: "stale-reused-pid-instance",
        dev: lockStat.dev, ino: lockStat.ino,
      };
      mkdirSync(join(lockPath, `.owner-${token}`), { mode: 0o700 });
      const externalWitness = join(root, "external-witness");
      writeFileSync(externalWitness, "untouched");
      symlinkSync(externalWitness, join(lockPath, `.owner-${token}`, "witness"));
      writeLockOwner(lockPath, owner);
      const staleBackup = join(resourcesDir, `.node-backup-${token}`);
      renameSync(targetDir, staleBackup);

      await assert.rejects(
        prepareNode({
          resourcesDir,
          targetPlatform: "linux",
          targetArch: "x64",
          lockTimeoutMs: 80,
          lockPollMs: 5,
          async downloadArchive() { throw new Error("offline download failed"); },
          logger: quietLogger(),
        }),
        /offline download failed/,
      );
      assert.equal(readFileSync(oldNode, "utf8"), "prior-runtime", "PID reuse recovery must restore the prior runtime");
      assert.equal(existsSync(staleBackup), false);
      assert.equal(existsSync(lockPath), false);
      assert.equal(readFileSync(externalWitness, "utf8"), "untouched", "witness cleanup must not follow symlinks");
      console.log("PASS a reused PID cannot impersonate the dead process instance");
    }

    for (const [guardPresent, reusedClaimantPid] of [[true, false], [false, false], [true, true]]) {
      const root = tempRoot();
      const resourcesDir = join(root, "resources");
      const oldNode = join(resourcesDir, "node", "bin", "node");
      mkdirSync(dirname(oldNode), { recursive: true });
      writeFileSync(oldNode, "prior-runtime");

      const deadOwner = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
      const deadClaimant = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
      assert.equal(deadOwner.status, 0);
      assert.equal(deadClaimant.status, 0);
      assert.notEqual(deadOwner.stdout, deadClaimant.stdout);
      const claimantPid = reusedClaimantPid ? reusedPidProcess.pid : Number(deadClaimant.stdout);

      const ownerToken = "11111111111111111111111111111111";
      const claimToken = "22222222222222222222222222222222";
      const lockPath = join(resourcesDir, ".node-prepare.lock");
      mkdirSync(lockPath, { mode: 0o700 });
      const lockStat = lstatSync(lockPath);
      const owner = {
        pid: Number(deadOwner.stdout), token: ownerToken, startedAt: 1,
        processIdentity: "dead-original-owner-instance", dev: lockStat.dev, ino: lockStat.ino,
      };
      if (guardPresent) mkdirSync(join(lockPath, `.owner-${ownerToken}`), { mode: 0o700 });
      const claimName = `.claim-${claimantPid}-44444444444444444444444444444444-${claimToken}`;
      writeFileSync(join(lockPath, claimName), JSON.stringify(owner), { mode: 0o600 });
      const staleStage = join(resourcesDir, `.node-stage-${ownerToken}-ABC123`);
      mkdirSync(staleStage);
      writeFileSync(join(staleStage, "partial"), "stale");
      const staleBackup = join(resourcesDir, `.node-backup-${ownerToken}`);
      renameSync(join(resourcesDir, "node"), staleBackup);

      await assert.rejects(
        prepareNode({
          resourcesDir,
          targetPlatform: "linux",
          targetArch: "x64",
          lockTimeoutMs: 80,
          lockPollMs: 5,
          async downloadArchive() { throw new Error("offline download failed"); },
          logger: quietLogger(),
        }),
        /offline download failed/,
      );
      assert.equal(readFileSync(oldNode, "utf8"), "prior-runtime");
      assert.equal(existsSync(staleStage), false, "a resumed cleanup must sweep its original owner's stage");
      assert.equal(existsSync(staleBackup), false, "a resumed cleanup must restore its original owner's backup");
      assert.equal(existsSync(lockPath), false, "a crashed cleanup claim must not strand the lock");
      console.log(`PASS a ${reusedClaimantPid ? "PID-reused" : "dead"} cleanup claimant is recovered ${guardPresent ? "before" : "after"} guard removal`);
    }
  } finally {
    const closed = once(reusedPidProcess, "close");
    reusedPidProcess.kill("SIGKILL");
    await closed;
  }

  {
    const root = tempRoot();
    const resourcesDir = join(root, "resources");
    const nodeBin = join(resourcesDir, "node", "bin", "node");
    const executed = join(root, "old-executed");
    mkdirSync(join(resourcesDir, "node", "bin"), { recursive: true });
    writeFileSync(nodeBin, `#!/bin/sh\nprintf '${PINNED_NODE_VERSION}\\n'\nprintf executed > ${JSON.stringify(executed)}\n`);
    chmodSync(nodeBin, 0o755);
    const result = await prepareNode({
      resourcesDir,
      targetPlatform: "linux",
      targetArch: "x64",
      downloadArchive: downloadFixture,
      logger: quietLogger(),
    });
    assert.equal(result, "staged");
    assert.equal(existsSync(executed), false, "an unverified existing runtime must never be executed");
    assert.equal(readFileSync(join(resourcesDir, "node", "origin"), "utf8"), "verified-fixture");
    assert.equal(execFileSync(nodeBin, ["--version"], { encoding: "utf8" }).trim(), PINNED_NODE_VERSION);
    console.log("PASS an existing version-spoofing runtime is replaced without execution");
  }

  {
    const root = tempRoot();
    const resourcesDir = join(root, "resources");
    const hostileBin = join(root, "hostile-bin");
    const invoked = join(root, "hostile-tar-invoked");
    mkdirSync(hostileBin);
    const hostileTar = join(hostileBin, "tar");
    writeFileSync(hostileTar, `#!/bin/sh\nprintf invoked > ${JSON.stringify(invoked)}\nexit 23\n`);
    chmodSync(hostileTar, 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${hostileBin}:${savedPath ?? ""}`;
    try {
      await prepareNode({
        resourcesDir,
        targetPlatform: "linux",
        targetArch: "x64",
        downloadArchive: downloadFixture,
        logger: quietLogger(),
      });
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
    assert.equal(existsSync(invoked), false, "archive extraction must not resolve tar through a mutable PATH");
    assert.equal(readFileSync(join(resourcesDir, "node", "origin"), "utf8"), "verified-fixture");
    console.log("PASS extraction uses the supported platform's absolute system tar");
  }

  {
    const root = tempRoot();
    const resourcesDir = join(root, "resources");
    const oldNode = join(resourcesDir, "node", "bin", "node");
    mkdirSync(join(resourcesDir, "node", "bin"), { recursive: true });
    writeFileSync(oldNode, "prior-runtime");

    await assert.rejects(
      prepareNode({
        resourcesDir,
        targetPlatform: "linux",
        targetArch: "x64",
        async downloadArchive({ destination }) {
          writeFileSync(destination, fixtureBytes);
        },
        extractArchive({ destinationDir, release }) {
          const stagedBin = join(destinationDir, release.directoryName, "bin", "node");
          mkdirSync(join(destinationDir, release.directoryName, "bin"), { recursive: true });
          writeFileSync(stagedBin, "invalid-runtime");
        },
        runNode(binary) {
          return binary === oldNode ? "v22.22.0\n" : "v0.0.0\n";
        },
        logger: quietLogger(),
      }),
      /extracted Node version/i,
    );
    assert.equal(readFileSync(oldNode, "utf8"), "prior-runtime", "bad extraction must not destroy the prior runtime");
    assert.deepEqual(
      readFileSync(join(resourcesDir, "node", "bin", "node"), "utf8"),
      "prior-runtime",
      "the target path must still resolve to the prior runtime",
    );
    console.log("PASS invalid extraction preserves the prior runtime");
  }

  {
    const root = tempRoot();
    const resourcesDir = join(root, "resources");
    const oldNode = join(resourcesDir, "node", "bin", "node");
    mkdirSync(dirname(oldNode), { recursive: true });
    writeFileSync(oldNode, "prior-runtime");
    await assert.rejects(
      prepareNode({
        resourcesDir,
        targetPlatform: "linux",
        targetArch: "x64",
        async downloadArchive({ destination }) { writeFileSync(destination, fixtureBytes); },
        extractArchive() { throw new Error("fixture extraction failed"); },
        logger: quietLogger(),
      }),
      /fixture extraction failed/,
    );
    assert.equal(readFileSync(oldNode, "utf8"), "prior-runtime");
    assert.deepEqual(readdirSync(resourcesDir), ["node"], "an extraction failure must clean its owned stage and lock");
    console.log("PASS extraction failure preserves the prior runtime and cleans staging");
  }

  {
    const root = tempRoot();
    const resourcesDir = join(root, "resources");
    const oldNode = join(resourcesDir, "node", "bin", "node");
    mkdirSync(dirname(oldNode), { recursive: true });
    writeFileSync(oldNode, "prior-runtime");
    await assert.rejects(
      prepareNode({
        resourcesDir,
        targetPlatform: "linux",
        targetArch: "x64",
        downloadArchive: downloadFixture,
        runNode(binary, args, options) {
          const version = execFileSync(binary, args, options);
          rmSync(dirname(dirname(binary)), { recursive: true, force: true });
          return version;
        },
        logger: quietLogger(),
      }),
      /ENOENT|no such file/i,
    );
    assert.equal(readFileSync(oldNode, "utf8"), "prior-runtime", "install failure must roll the old target back");
    assert.deepEqual(readdirSync(resourcesDir), ["node"], "rollback must not leak backup, lock, or stage paths");
    console.log("PASS install rename failure rolls back the prior runtime");
  }

  {
    const root = tempRoot();
    const resourcesDir = join(root, "resources");
    const externalNode = join(root, "external-node");
    mkdirSync(join(externalNode, "bin"), { recursive: true });
    writeFileSync(join(externalNode, "bin", "node"), "external-runtime");
    writeFileSync(join(externalNode, "keep"), "external-marker");
    mkdirSync(resourcesDir);
    symlinkSync(externalNode, join(resourcesDir, "node"), "dir");
    await prepareNode({
      resourcesDir,
      targetPlatform: "linux",
      targetArch: "x64",
      downloadArchive: downloadFixture,
      logger: quietLogger(),
    });
    assert.equal(lstatSync(join(resourcesDir, "node")).isSymbolicLink(), false);
    assert.equal(readFileSync(join(resourcesDir, "node", "origin"), "utf8"), "verified-fixture");
    assert.equal(readFileSync(join(externalNode, "keep"), "utf8"), "external-marker");
    assert.equal(readFileSync(join(externalNode, "bin", "node"), "utf8"), "external-runtime");
    console.log("PASS a symlinked old target is replaced without following or mutating it");
  }

  {
    const root = tempRoot();
    const resourcesDir = join(root, "resources");
    const externalBin = join(root, "external-bin");
    mkdirSync(externalBin);
    writeFileSync(join(externalBin, "node"), "external-runtime");
    mkdirSync(join(resourcesDir, "node"), { recursive: true });
    symlinkSync(externalBin, join(resourcesDir, "node", "bin"), "dir");
    await prepareNode({
      resourcesDir,
      targetPlatform: "linux",
      targetArch: "x64",
      downloadArchive: downloadFixture,
      logger: quietLogger(),
    });
    assert.equal(lstatSync(join(resourcesDir, "node", "bin")).isSymbolicLink(), false);
    assert.equal(readFileSync(join(resourcesDir, "node", "origin"), "utf8"), "verified-fixture");
    assert.equal(readFileSync(join(externalBin, "node"), "utf8"), "external-runtime");
    console.log("PASS a symlinked component in the old target is never followed during replacement");
  }

  {
    const root = tempRoot();
    const resourcesDir = join(root, "resources");
    const oldNode = join(resourcesDir, "node", "bin", "node");
    const externalBin = join(root, "external-bin");
    mkdirSync(dirname(oldNode), { recursive: true });
    writeFileSync(oldNode, "prior-runtime");
    mkdirSync(externalBin);
    writeFileSync(join(externalBin, "node"), "external-runtime");
    await assert.rejects(
      prepareNode({
        resourcesDir,
        targetPlatform: "linux",
        targetArch: "x64",
        async downloadArchive({ destination }) { writeFileSync(destination, fixtureBytes); },
        extractArchive({ destinationDir, release }) {
          const extractedDir = join(destinationDir, release.directoryName);
          mkdirSync(extractedDir);
          symlinkSync(externalBin, join(extractedDir, "bin"), "dir");
        },
        logger: quietLogger(),
      }),
      /bin\/.*regular directory|bin\/ is not a regular directory/i,
    );
    assert.equal(readFileSync(oldNode, "utf8"), "prior-runtime");
    assert.equal(readFileSync(join(externalBin, "node"), "utf8"), "external-runtime");
    console.log("PASS a symlinked component in the extracted runtime is rejected");
  }
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

  }, 120_000);
});
