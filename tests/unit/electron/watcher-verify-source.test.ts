import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, type FSWatcher, type watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectWatcher } from "../../../electron/watcher.ts";
import { isVerifySourceCurrent } from "../../../electron/main/verify-source.ts";
import type { VerifySource } from "../../../shared/types.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "termina-verify-observer-"));
  writeFileSync(join(root, ".gitignore"), "/stages.jsonl\nvendor/\n");
  mkdirSync(join(root, "vendor"));
  writeFileSync(join(root, "vendor", "input.ts"), "export const input = 1;\n");
  let notify!: (event: string, path: string | null) => void;
  let emitter!: EventEmitter;
  const fakeWatch = ((_root: string, _options: unknown, listener: typeof notify) => {
    notify = listener;
    const native = new EventEmitter();
    emitter = native;
    return Object.assign(native, { close() { native.emit("close"); } }) as FSWatcher;
  }) as typeof watch;
  const watcher = new ProjectWatcher(root, undefined, fakeWatch);
  return {
    watcher, root, native: () => emitter,
    notify: (path: string | null) => notify("change", path),
    error: () => emitter.emit("error", new Error("observation lost")),
    close: () => emitter.emit("close"),
  };
}

function source(watcher: ProjectWatcher): VerifySource {
  const version = watcher.sourceVersion()!;
  return { root: "/project", workspaceId: "ws-1", tree: "a".repeat(40), generation: 1, revision: version.revision, observationEpoch: version.observationEpoch };
}

describe("Verify source observation", () => {
  it("observes captured inputs in editor-ignored folders without treating ignored output as an input", async () => {
    const f = fixture();
    let notifications = 0;
    f.watcher.onSourceChanged = () => { notifications++; };
    try {
      f.watcher.start();
      expect(await f.watcher.waitForIdle(3000)).not.toBeNull();
      await f.watcher.observeCapturedSourcePaths(new Set(["vendor/input.ts"]));
      const before = source(f.watcher);
      const count = notifications;
      f.notify("stages.jsonl");
      expect(source(f.watcher).revision).toBe(before.revision);
      expect(notifications).toBeGreaterThan(count);
      // Same captured bytes alone do not certify a run if an input was touched.
      f.notify("vendor/input.ts");
      expect(isVerifySourceCurrent(before, source(f.watcher))).toBe(false);
      const after = source(f.watcher);
      f.notify("vendor");
      expect(source(f.watcher).revision).toBeGreaterThan(after.revision);
    } finally {
      f.watcher.stop();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("observes new source files in editor-hidden folders that Git does not ignore", async () => {
    const f = fixture();
    writeFileSync(join(f.root, ".gitignore"), "/stages.jsonl\n");
    try {
      f.watcher.start();
      expect(await f.watcher.waitForIdle(3000)).not.toBeNull();
      await f.watcher.observeCapturedSourcePaths(new Set(["vendor/input.ts"]));
      expect(f.watcher.isIgnored("vendor/new.ts")).toBe(true);
      const before = source(f.watcher);
      writeFileSync(join(f.root, "vendor", "new.ts"), "export const added = true;\n");
      f.notify("vendor/new.ts");
      expect(isVerifySourceCurrent(before, source(f.watcher))).toBe(false);
    } finally {
      f.watcher.stop();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.each(["error", "close"] as const)("invalidates observation on native %s and does not resurrect a certification after recovery", async (loss) => {
    const f = fixture();
    let losses = 0;
    f.watcher.onObservationLost = () => { losses++; };
    try {
      f.watcher.start();
      expect(await f.watcher.waitForIdle(3000)).not.toBeNull();
      const before = source(f.watcher);
      const beforeLosses = losses;
      f[loss]();
      expect(losses).toBe(beforeLosses + 1);
      expect(f.watcher.sourceVersion()).toBeNull();
      expect(await f.watcher.waitForIdle(3000)).toBeNull();
      const epoch = before.observationEpoch;
      f.watcher.stop();
      expect(f.watcher.sourceVersion()).toBeNull();
      f.watcher.start();
      expect(await f.watcher.waitForIdle(3000)).not.toBeNull();
      expect(source(f.watcher).observationEpoch).toBeGreaterThan(epoch);
      expect(isVerifySourceCurrent(before, source(f.watcher))).toBe(false);
    } finally {
      f.watcher.stop();
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it("ignores a late close from a replaced native observer", async () => {
    const f = fixture();
    let losses = 0;
    f.watcher.onObservationLost = () => { losses++; };
    try {
      f.watcher.start();
      expect(await f.watcher.waitForIdle(3000)).not.toBeNull();
      const previous = f.native();
      f.watcher.start();
      expect(await f.watcher.waitForIdle(3000)).not.toBeNull();
      const current = f.watcher.sourceVersion();
      const beforeLosses = losses;
      previous.emit("close");
      expect(f.watcher.sourceVersion()).toEqual(current);
      expect(losses).toBe(beforeLosses);
    } finally {
      f.watcher.stop();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
