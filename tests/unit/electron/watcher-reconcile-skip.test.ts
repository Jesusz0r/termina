import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectWatcher } from "../../../electron/watcher.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reconcile must survive an unreadable directory: one EACCES/ENOENT readdir
 * used to abort the whole pass, wedging the watcher overflowed + unhealthy
 * with a retry storm until the directory became readable again.
 */
describe("Watcher reconcile unreadable directories", () => {
  it("skips an unreadable directory and still certifies the pass", async () => {
    const root = mkdtempSync(join(tmpdir(), "termina-watcher-reconcile-skip-"));
    mkdirSync(join(root, "noaccess"));
    writeFileSync(join(root, "ok.txt"), "hello");
    writeFileSync(join(root, "noaccess", "hidden.txt"), "shh");
    const fakeWatch = (..._args: any[]) => Object.assign(new EventEmitter(), { close() {} }) as any;
    const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const readDirectory = (async (dir: string, opts: any) => {
      if (dir === join(root, "noaccess")) throw eacces;
      return readdir(dir, opts);
    }) as any;
    const watcher = new ProjectWatcher(root, undefined, fakeWatch as any, {
      maxPendingItems: 64,
      maxPendingBytes: 65536,
      maxInFlight: 4,
    }, readDirectory);
    const internals = watcher as any;
    try {
      watcher.start();
      await sleep(150);
      internals.requestReconcile(internals.generation);
      const deadline = Date.now() + 8000;
      while (internals.overflowed && Date.now() < deadline) await sleep(50);
      expect(internals.overflowed).toBe(false);
      expect(internals.watcherPaused).toBe(false);
      expect(internals.healthy).toBe(true);
      expect(await watcher.waitForIdle(2000)).not.toBeNull();
    } finally {
      watcher.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("still reports a directory that vanishes mid-scan as deleted", async () => {
    const root = mkdtempSync(join(tmpdir(), "termina-watcher-reconcile-enoent-"));
    mkdirSync(join(root, "gone"));
    writeFileSync(join(root, "gone", "old.txt"), "bye");
    const fakeWatch = (..._args: any[]) => Object.assign(new EventEmitter(), { close() {} }) as any;
    let failGone = false;
    const readDirectory = (async (dir: string, opts: any) => {
      if (failGone && dir === join(root, "gone")) {
        throw Object.assign(new Error("ENOENT: no such directory"), { code: "ENOENT" });
      }
      return readdir(dir, opts);
    }) as any;
    const watcher = new ProjectWatcher(root, undefined, fakeWatch as any, {
      maxPendingItems: 64,
      maxPendingBytes: 65536,
      maxInFlight: 4,
    }, readDirectory);
    const internals = watcher as any;
    const deleted: string[] = [];
    watcher.onFileDeleted = async (abs: string) => {
      deleted.push(abs);
    };
    try {
      watcher.start();
      await sleep(150);
      // Seed the file, then delete it while its directory listing fails:
      // the skip must not abort the pass, and the seen-but-unobserved
      // inference must still report the real deletion.
      internals.schedule("gone/old.txt", internals.generation);
      await sleep(300);
      rmSync(join(root, "gone", "old.txt"), { force: true });
      failGone = true;
      internals.requestReconcile(internals.generation);
      const deadline = Date.now() + 8000;
      while (internals.overflowed && Date.now() < deadline) await sleep(50);
      expect(internals.overflowed).toBe(false);
      expect(deleted).toContain(join(root, "gone", "old.txt"));
    } finally {
      watcher.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
