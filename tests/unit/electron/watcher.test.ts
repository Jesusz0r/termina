import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      const idle = await watcher.waitForIdle(3000);
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
      const hugeDeadline = Date.now() + 15000;
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
  }, 30_000);
});
