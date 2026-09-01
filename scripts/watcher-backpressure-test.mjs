import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
};

const root = mkdtempSync(join(tmpdir(), "termina-watcher-backpressure-"));
const bundle = join(root, "watcher.mjs");
await build({ entryPoints: ["electron/watcher.ts"], bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent" });
const { ProjectWatcher } = await import(`${pathToFileURL(bundle).href}?${Date.now()}`);
const rawCallbacks = [];
const fakeWatch = (...args) => {
  if (typeof args[2] === "function") rawCallbacks.push(args[2]);
  return Object.assign(new EventEmitter(), { close() {} });
};

const watcher = new ProjectWatcher(root, undefined, fakeWatch, {
  maxPendingItems: 2,
  maxPendingBytes: 512,
  maxInFlight: 1,
});
const internals = watcher;
const gate = deferred();
const changes = [];
let inFlight = 0;
let maxInFlight = 0;
watcher.onChange = async (change) => {
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    if (changes.length === 0) await gate.promise;
    changes.push({ relPath: change.relPath, content: change.content });
  } finally {
    inFlight -= 1;
  }
};

try {
  watcher.start();
  for (let i = 0; i < 6; i += 1) {
    const relPath = `burst-${i}.txt`;
    writeFileSync(join(root, relPath), `final-${i}`);
    internals.schedule(relPath, internals.generation);
  }
  let ticks = 0;
  const interval = setInterval(() => { ticks += 1; }, 10);
  const inFlightDeadline = Date.now() + 3000;
  while (maxInFlight === 0 && Date.now() < inFlightDeadline) await sleep(20);
  await sleep(60);
  assert.equal(maxInFlight, 1, "slow watcher consumers are bounded to one callback");
  assert.equal(watcher.queueStats().pendingItems <= 2, true, "pending watcher items stay under the item high-water mark");
  assert.equal(watcher.queueStats().pendingBytes <= 512, true, "pending watcher paths stay under the byte high-water mark");
  assert.equal(watcher.isPaused(), true, "overflow pauses native observation until reconciliation");
  assert.ok(ticks > 5, "a blocked watcher callback does not block the event loop");
  gate.resolve();
  const idle = await watcher.waitForIdle(3000);
  clearInterval(interval);
  assert.notEqual(idle, null);
  assert.equal(new Set(changes.map((change) => change.relPath)).size, 6, "overflow recovery preserves every final path");
  assert.deepEqual(
    changes.filter((change) => change.relPath === "burst-5.txt").at(-1),
    { relPath: "burst-5.txt", content: "final-5" },
  );

  const duplicate = join(root, "same-path.txt");
  writeFileSync(duplicate, "old");
  internals.schedule("same-path.txt", internals.generation);
  await sleep(20);
  writeFileSync(duplicate, "latest");
  internals.schedule("same-path.txt", internals.generation);
  assert.notEqual(await watcher.waitForIdle(3000), null);
  assert.deepEqual(changes.filter((change) => change.relPath === "same-path.txt").at(-1), {
    relPath: "same-path.txt",
    content: "latest",
  });

  const raceRoot = mkdtempSync(join(tmpdir(), "termina-watcher-reconcile-race-"));
  writeFileSync(join(raceRoot, "a.txt"), "before");
  const raceWatcher = new ProjectWatcher(raceRoot, undefined, fakeWatch, {
    maxPendingItems: 4,
    maxPendingBytes: 1024,
    maxInFlight: 1,
  });
  const raceInternals = raceWatcher;
  const raceChanges = [];
  let raceCreated = false;
  raceWatcher.onChange = async (change) => {
    raceChanges.push(change.relPath);
    // This runs after reconciliation's directory snapshot but before its
    // drain/re-arm barrier. A closed watcher loses this mutation.
    if (change.relPath === "a.txt" && !raceCreated) {
      raceCreated = true;
      writeFileSync(join(raceRoot, "new.txt"), "during-reconcile");
    }
  };
  raceWatcher.start();
  await sleep(180);
  writeFileSync(join(raceRoot, "a.txt"), "changed-before-reconcile");
  raceInternals.requestReconcile(raceInternals.generation);
  assert.notEqual(await raceWatcher.waitForIdle(3000), null, "reconciliation race returns to a certifiable idle state");
  assert.equal(raceChanges.includes("new.txt"), true, "a mutation during reconciliation is emitted after overlap recovery");
  raceWatcher.stop();
  rmSync(raceRoot, { recursive: true, force: true });

  const hugeRoot = mkdtempSync(join(tmpdir(), "termina-watcher-100001-"));
  const syntheticEntries = Array.from({ length: 100001 }, (_, i) => ({
    name: `synthetic-${i}.txt`,
    isDirectory: () => false,
    isFile: () => true,
  }));
  const syntheticReadDirectory = async () => syntheticEntries;
  const hugeWatcher = new ProjectWatcher(hugeRoot, undefined, fakeWatch, {
    maxPendingItems: 8,
    maxPendingBytes: 4096,
    maxInFlight: 2,
  }, syntheticReadDirectory);
  const hugeInternals = hugeWatcher;
  hugeWatcher.start();
  hugeInternals.requestReconcile(hugeInternals.generation);
  const hugeDeadline = Date.now() + 15000;
  while (hugeInternals.reconcileAttempts < 2 && Date.now() < hugeDeadline) await sleep(25);
  assert.equal(hugeInternals.healthy, true, "a 100001-path reconciliation remains observable without permanently poisoning watcher health");
  assert.equal(hugeInternals.reconcileAttempts >= 2, true, "an over-cap reconciliation retries with bounded recovery");
  assert.equal(hugeInternals.reconciledPathCount >= 100001, true, "all over-cap paths remain visible to the reconciliation walker");
  hugeWatcher.stop();
  rmSync(hugeRoot, { recursive: true, force: true });

  const scanFailureRoot = mkdtempSync(join(tmpdir(), "termina-watcher-scan-retry-"));
  let scanReads = 0;
  const scanReadDirectory = async () => {
    scanReads += 1;
    if (scanReads === 1) throw new Error("synthetic scan failure");
    return [];
  };
  const scanFailureWatcher = new ProjectWatcher(scanFailureRoot, undefined, fakeWatch, { maxPendingItems: 4, maxPendingBytes: 1024, maxInFlight: 1 }, scanReadDirectory);
  const scanFailureInternals = scanFailureWatcher;
  scanFailureWatcher.start();
  scanFailureInternals.requestReconcile(scanFailureInternals.generation);
  const scanRetryDeadline = Date.now() + 5000;
  while (scanFailureInternals.reconcileAttempts < 2 && Date.now() < scanRetryDeadline) await sleep(25);
  assert.equal(scanFailureInternals.reconcileAttempts >= 2, true, "a failed scan remains dirty and retries");
  while ((scanFailureInternals.reconcileRunning || scanFailureInternals.overflowed) && Date.now() < scanRetryDeadline + 5000) await sleep(25);
  assert.notEqual(await scanFailureWatcher.waitForIdle(4000), null, "a later successful scan restores certifiable observation");
  scanFailureWatcher.stop();
  rmSync(scanFailureRoot, { recursive: true, force: true });

  const callbackFailureRoot = mkdtempSync(join(tmpdir(), "termina-watcher-callback-retry-"));
  const callbackFailureWatcher = new ProjectWatcher(callbackFailureRoot, undefined, fakeWatch, { maxPendingItems: 4, maxPendingBytes: 1024, maxInFlight: 1 });
  const callbackFailureInternals = callbackFailureWatcher;
  const callbackAttempts = [];
  let callbackFailed = false;
  callbackFailureWatcher.onChange = async (change) => {
    callbackAttempts.push(change.content);
    if (!callbackFailed) {
      callbackFailed = true;
      throw new Error("synthetic callback failure");
    }
  };
  callbackFailureWatcher.start();
  await callbackFailureWatcher.waitForIdle(1000);
  writeFileSync(join(callbackFailureRoot, "retry.txt"), "final-state");
  callbackFailureInternals.schedule("retry.txt", callbackFailureInternals.generation);
  const callbackRetryDeadline = Date.now() + 10_000;
  while (callbackAttempts.length < 2 && Date.now() < callbackRetryDeadline) await sleep(25);
  assert.equal(callbackAttempts.length >= 2, true, `a callback failure is retried while observation remains open (attempts=${callbackAttempts.length})`);
  assert.equal(callbackAttempts.at(-1), "final-state", "callback retry preserves the final file state");
  assert.notEqual(await callbackFailureWatcher.waitForIdle(4000), null, "callback recovery eventually certifies idle");
  callbackFailureWatcher.stop();
  rmSync(callbackFailureRoot, { recursive: true, force: true });

  const shutdownRoot = mkdtempSync(join(tmpdir(), "termina-watcher-shutdown-"));
  const shutdownWatcher = new ProjectWatcher(shutdownRoot, undefined, fakeWatch, { maxPendingItems: 2, maxInFlight: 1 });
  const shutdownGate = deferred();
  const shutdownChanges = [];
  const shutdownInternals = shutdownWatcher;
  shutdownWatcher.onChange = async (change) => {
    await shutdownGate.promise;
    shutdownChanges.push(change.relPath);
  };
  shutdownWatcher.start();
  writeFileSync(join(shutdownRoot, "stopped.txt"), "stopped");
  shutdownInternals.schedule("stopped.txt", shutdownInternals.generation);
  await sleep(180);
  shutdownWatcher.stop();
  shutdownGate.resolve();
  await sleep(100);
  assert.deepEqual(shutdownChanges, ["stopped.txt"], "shutdown lets in-flight work settle but drops queued fanout");
  rmSync(shutdownRoot, { recursive: true, force: true });
  console.log("watcher bounded-emitter checks passed");
} finally {
  watcher.stop();
  rmSync(root, { recursive: true, force: true });
}
