import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectWatcher } from "../../../electron/watcher.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
};

describe("Project Watcher Bounded-Emitter & Backpressure", () => {
  it("enforces queue limits, backpressure controls, and idle certification", async () => {
    const root = mkdtempSync(join(tmpdir(), "termina-watcher-backpressure-"));
    const rawCallbacks: any[] = [];
    const fakeWatch = (...args: any[]) => {
      if (typeof args[2] === "function") rawCallbacks.push(args[2]);
      return Object.assign(new EventEmitter(), { close() {} }) as any;
    };

    const watcher = new ProjectWatcher(root, undefined, fakeWatch as any, {
      maxPendingItems: 2,
      maxPendingBytes: 512,
      maxInFlight: 1,
    });
    const internals = watcher as any;
    const gate = deferred();
    const changes: Array<{ relPath: string; content?: string }> = [];
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
      await sleep(100);
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
      expect(maxInFlight).toBe(1);
      expect(watcher.queueStats().pendingItems <= 2).toBe(true);
      expect(watcher.queueStats().pendingBytes <= 512).toBe(true);
      expect(watcher.isPaused()).toBe(true);
      expect(ticks).toBeGreaterThan(5);
      gate.resolve();
      const idle = await watcher.waitForIdle(10_000);
      clearInterval(interval);
      expect(idle).not.toBeNull();
      expect(new Set(changes.map((change) => change.relPath)).size).toBe(6);
      expect(
        changes.filter((change) => change.relPath === "burst-5.txt").at(-1),
      ).toEqual({ relPath: "burst-5.txt", content: "final-5" });

      const duplicate = join(root, "same-path.txt");
      writeFileSync(duplicate, "old");
      internals.schedule("same-path.txt", internals.generation);
      await sleep(20);
      writeFileSync(duplicate, "latest");
      internals.schedule("same-path.txt", internals.generation);
      expect(await watcher.waitForIdle(3000)).not.toBeNull();
      expect(changes.filter((change) => change.relPath === "same-path.txt").at(-1)).toEqual({
        relPath: "same-path.txt",
        content: "latest",
      });

      const raceRoot = mkdtempSync(join(tmpdir(), "termina-watcher-reconcile-race-"));
      writeFileSync(join(raceRoot, "a.txt"), "before");
      const raceWatcher = new ProjectWatcher(raceRoot, undefined, fakeWatch as any, {
        maxPendingItems: 4,
        maxPendingBytes: 1024,
        maxInFlight: 1,
      });
      const raceInternals = raceWatcher as any;
      const raceChanges: string[] = [];
      let raceCreated = false;
      raceWatcher.onChange = async (change) => {
        raceChanges.push(change.relPath);
        if (change.relPath === "a.txt" && !raceCreated) {
          raceCreated = true;
          writeFileSync(join(raceRoot, "new.txt"), "during-reconcile");
        }
      };
      raceWatcher.start();
      await sleep(180);
      writeFileSync(join(raceRoot, "a.txt"), "changed-before-reconcile");
      raceInternals.requestReconcile(raceInternals.generation);
      expect(await raceWatcher.waitForIdle(3000)).not.toBeNull();
      expect(raceChanges.includes("new.txt")).toBe(true);
      raceWatcher.stop();
      rmSync(raceRoot, { recursive: true, force: true });

      const hugeRoot = mkdtempSync(join(tmpdir(), "termina-watcher-100001-"));
      const syntheticEntries = Array.from({ length: 100001 }, (_, i) => ({
        name: `synthetic-${i}.txt`,
        isDirectory: () => false,
        isFile: () => true,
      }));
      const syntheticReadDirectory = async () => syntheticEntries as any;
      const hugeWatcher = new ProjectWatcher(hugeRoot, undefined, fakeWatch as any, {
        maxPendingItems: 8,
        maxPendingBytes: 4096,
        maxInFlight: 2,
      }, syntheticReadDirectory);
      const hugeInternals = hugeWatcher as any;
      hugeWatcher.start();
      hugeInternals.requestReconcile(hugeInternals.generation);
      const hugeDeadline = Date.now() + 25000;
      while (hugeInternals.reconcileAttempts < 2 && Date.now() < hugeDeadline) await sleep(25);
      expect(hugeInternals.healthy).toBe(true);
      expect(hugeInternals.reconcileAttempts >= 2).toBe(true);
      expect(hugeInternals.reconciledPathCount >= 100001).toBe(true);
      hugeWatcher.stop();
      rmSync(hugeRoot, { recursive: true, force: true });

      const scanFailureRoot = mkdtempSync(join(tmpdir(), "termina-watcher-scan-retry-"));
      let scanReads = 0;
      const scanReadDirectory = async () => {
        scanReads += 1;
        if (scanReads === 1) throw new Error("synthetic scan failure");
        return [];
      };
      const scanFailureWatcher = new ProjectWatcher(scanFailureRoot, undefined, fakeWatch as any, { maxPendingItems: 4, maxPendingBytes: 1024, maxInFlight: 1 }, scanReadDirectory);
      const scanFailureInternals = scanFailureWatcher as any;
      scanFailureWatcher.start();
      scanFailureInternals.requestReconcile(scanFailureInternals.generation);
      const scanRetryDeadline = Date.now() + 5000;
      while (scanFailureInternals.reconcileAttempts < 2 && Date.now() < scanRetryDeadline) await sleep(25);
      expect(scanFailureInternals.reconcileAttempts >= 2).toBe(true);
      while ((scanFailureInternals.reconcileRunning || scanFailureInternals.overflowed) && Date.now() < scanRetryDeadline + 5000) await sleep(25);
      expect(await scanFailureWatcher.waitForIdle(4000)).not.toBeNull();
      scanFailureWatcher.stop();
      rmSync(scanFailureRoot, { recursive: true, force: true });

      const callbackFailureRoot = mkdtempSync(join(tmpdir(), "termina-watcher-callback-retry-"));
      const callbackFailureWatcher = new ProjectWatcher(callbackFailureRoot, undefined, fakeWatch as any, { maxPendingItems: 4, maxPendingBytes: 1024, maxInFlight: 1 });
      const callbackFailureInternals = callbackFailureWatcher as any;
      const callbackAttempts: any[] = [];
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
      expect(callbackAttempts.length >= 2).toBe(true);
      expect(callbackAttempts.at(-1)).toBe("final-state");
      expect(await callbackFailureWatcher.waitForIdle(4000)).not.toBeNull();
      callbackFailureWatcher.stop();
      rmSync(callbackFailureRoot, { recursive: true, force: true });

      const shutdownRoot = mkdtempSync(join(tmpdir(), "termina-watcher-shutdown-"));
      const shutdownWatcher = new ProjectWatcher(shutdownRoot, undefined, fakeWatch as any, { maxPendingItems: 2, maxInFlight: 1 });
      const shutdownGate = deferred();
      const shutdownChanges: string[] = [];
      const shutdownInternals = shutdownWatcher as any;
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
      expect(shutdownChanges).toEqual(["stopped.txt"]);
      rmSync(shutdownRoot, { recursive: true, force: true });
    } finally {
      watcher.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);

  it("reports deleted directories so the explorer drops the row", async () => {
    const root = mkdtempSync(join(tmpdir(), "termina-watcher-dirdelete-"));
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "inner.txt"), "x");
    const fakeWatch = (...args: any[]) => {
      if (typeof args[2] === "function") return Object.assign(new EventEmitter(), { close() {} }) as any;
      return Object.assign(new EventEmitter(), { close() {} }) as any;
    };
    const watcher = new ProjectWatcher(root, undefined, fakeWatch as any, {
      maxPendingItems: 8,
      maxPendingBytes: 4096,
      maxInFlight: 2,
    });
    const internals = watcher as any;
    const deleted: string[] = [];
    watcher.onFileDeleted = async (path: string) => {
      deleted.push(path);
    };
    const waitFor = async (pred: () => boolean, ms: number): Promise<boolean> => {
      const deadline = Date.now() + ms;
      while (!pred() && Date.now() < deadline) await sleep(25);
      return pred();
    };
    try {
      watcher.start();
      // A seeded subdirectory vanishes: the delete must fire, not drop silently.
      expect(await waitFor(() => internals.seenDirs.has("sub"), 5000)).toBe(true);
      rmSync(join(root, "sub"), { recursive: true, force: true });
      internals.schedule("sub", internals.generation);
      expect(await waitFor(() => deleted.includes(join(root, "sub")), 5000)).toBe(true);
      // A directory created after start is tracked the same way.
      mkdirSync(join(root, "fresh"));
      internals.schedule("fresh", internals.generation);
      expect(await waitFor(() => internals.seenDirs.has("fresh"), 5000)).toBe(true);
      rmSync(join(root, "fresh"), { recursive: true, force: true });
      internals.schedule("fresh", internals.generation);
      expect(await waitFor(() => deleted.includes(join(root, "fresh")), 5000)).toBe(true);
    } finally {
      watcher.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("reports oversized and binary files without caching content", async () => {
    const root = mkdtempSync(join(tmpdir(), "termina-watcher-uncached-"));
    const fakeWatch = (..._args: any[]) => Object.assign(new EventEmitter(), { close() {} }) as any;
    const watcher = new ProjectWatcher(root, undefined, fakeWatch as any, {
      maxPendingItems: 8,
      maxPendingBytes: 4096,
      maxInFlight: 2,
    });
    const internals = watcher as any;
    const uncached: Array<{ path: string; status: string }> = [];
    const changed: string[] = [];
    watcher.onFileUncached = async (path: string, status: "created" | "modified") => {
      uncached.push({ path, status });
    };
    watcher.onChange = async (change) => {
      changed.push(change.relPath);
    };
    const waitFor = async (pred: () => boolean, ms: number): Promise<boolean> => {
      const deadline = Date.now() + ms;
      while (!pred() && Date.now() < deadline) await sleep(25);
      return pred();
    };
    try {
      watcher.start();
      // Seed on an empty root, then create: the first report reads "created".
      await sleep(150);
      writeFileSync(join(root, "blob.bin"), Buffer.from([0x89, 0x00, 0xff, 0x41]));
      internals.schedule("blob.bin", internals.generation);
      expect(await waitFor(() => uncached.some((u) => u.path === join(root, "blob.bin")), 5000)).toBe(true);
      expect(uncached.find((u) => u.path === join(root, "blob.bin"))?.status).toBe("created");
      expect(changed).not.toContain("blob.bin");
      expect(watcher.lastContents.has(join(root, "blob.bin"))).toBe(false);
      // A second write reads "modified": the skip path tracks seen state.
      writeFileSync(join(root, "blob.bin"), Buffer.from([0x89, 0x00, 0xff, 0x42]));
      internals.schedule("blob.bin", internals.generation);
      expect(await waitFor(() => uncached.filter((u) => u.path === join(root, "blob.bin")).length >= 2, 5000)).toBe(true);
      expect(uncached.filter((u) => u.path === join(root, "blob.bin")).at(-1)?.status).toBe("modified");
      // Oversized text is reported the same way, without caching 2 MiB+.
      writeFileSync(join(root, "huge.txt"), "x".repeat(2 * 1024 * 1024 + 1));
      internals.schedule("huge.txt", internals.generation);
      expect(await waitFor(() => uncached.some((u) => u.path === join(root, "huge.txt")), 5000)).toBe(true);
      expect(changed).not.toContain("huge.txt");
      expect(watcher.lastContents.has(join(root, "huge.txt"))).toBe(false);
      // A text file that turns binary evicts its stale cache entry.
      writeFileSync(join(root, "flip.txt"), "plain text");
      internals.schedule("flip.txt", internals.generation);
      expect(await waitFor(() => changed.includes("flip.txt"), 5000)).toBe(true);
      expect(watcher.lastContents.has(join(root, "flip.txt"))).toBe(true);
      writeFileSync(join(root, "flip.txt"), Buffer.from([0x00, 0x01, 0x02]));
      internals.schedule("flip.txt", internals.generation);
      expect(await waitFor(() => uncached.some((u) => u.path === join(root, "flip.txt")), 5000)).toBe(true);
      expect(watcher.lastContents.has(join(root, "flip.txt"))).toBe(false);
      expect(watcher.lastOids.has(join(root, "flip.txt"))).toBe(false);
    } finally {
      watcher.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
