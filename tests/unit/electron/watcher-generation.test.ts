import { describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectWatcher } from "../../../electron/watcher.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Watcher generation discipline (#57): the workspace generation is the
 * preflight/promotion fence, so it must move exactly once per real tree
 * change — never on a duplicate event, never twice for one emit.
 */
describe("Watcher generation", () => {
  const main = readFileSync("electron/main.ts", "utf8");
  const changeBlock = main.slice(
    main.indexOf("watcher.onChange ="),
    main.indexOf("watcher.onFileTouched ="),
  );
  const touchedBlock = main.slice(
    main.indexOf("watcher.onFileTouched ="),
    main.indexOf("watcher.onFileUncached ="),
  );
  const uncachedBlock = main.slice(
    main.indexOf("watcher.onFileUncached ="),
    main.indexOf("watcher.onFileDeleted ="),
  );
  const deletedBlock = main.slice(
    main.indexOf("watcher.onFileDeleted ="),
    main.indexOf("watcher.start();"),
  );

  it("bumps generation only after the duplicate-content filter", () => {
    const dupReturn = changeBlock.indexOf("if (isDupWatch) return;");
    const bump = changeBlock.indexOf("ws.generation++;");
    assert.notEqual(dupReturn, -1, "onChange lost its duplicate filter");
    assert.notEqual(bump, -1, "onChange lost its generation bump");
    assert.ok(bump > dupReturn, "onChange bumps generation before the duplicate filter");
    // One bump per real change: a second increment in this block would trip
    // the preflight/promotion fences on a single write.
    assert.equal(changeBlock.split("ws.generation++;").length - 1, 1);
  });

  it("does not bump generation again on the touch callback", () => {
    assert.doesNotMatch(touchedBlock, /ws\.generation\+\+;/);
    // The touch callback still records the file for review.
    assert.match(touchedBlock, /recordModified/);
  });

  it("still bumps on real tree moves (uncached, deleted)", () => {
    assert.match(uncachedBlock, /ws\.generation\+\+;/);
    assert.match(deletedBlock, /ws\.generation\+\+;/);
  });

  it("keeps hint delivery on the real-change path", () => {
    assert.match(changeBlock, /this\.addPendingHint\(inst, relPath\);/);
    assert.match(changeBlock, /this\.scheduleMomentCapture\(inst, rendererTarget\);/);
  });

  it("fires onChange before onFileTouched once per emit", async () => {
    // The double-callback contract: one emit runs onChange first, so onChange
    // owns the single generation bump and onFileTouched must not add another.
    const root = mkdtempSync(join(tmpdir(), "termina-watcher-generation-"));
    const fakeWatch = (..._args: any[]) => Object.assign(new EventEmitter(), { close() {} }) as any;
    const watcher = new ProjectWatcher(root, undefined, fakeWatch as any, {
      maxPendingItems: 8,
      maxPendingBytes: 4096,
      maxInFlight: 2,
    });
    const internals = watcher as any;
    const order: string[] = [];
    watcher.onChange = async () => {
      order.push("change");
    };
    watcher.onFileTouched = async () => {
      order.push("touched");
    };
    try {
      watcher.start();
      await sleep(150);
      writeFileSync(join(root, "note.txt"), "hello");
      internals.schedule("note.txt", internals.generation);
      const deadline = Date.now() + 5000;
      while (order.length < 2 && Date.now() < deadline) await sleep(25);
      expect(order).toEqual(["change", "touched"]);
    } finally {
      watcher.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
