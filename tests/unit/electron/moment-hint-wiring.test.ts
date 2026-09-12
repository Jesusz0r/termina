import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Source-level probes for incremental moment hints (#45): sidecar tool
 * paths, watcher deletes, and oversized/binary files must all join the
 * next incremental capture, and a capture that races the watcher must
 * retry instead of stamping the parent onto the dots.
 */
describe("Incremental Moment Hints", () => {
  const main = readFileSync("electron/main.ts", "utf8");
  const watcher = readFileSync("electron/watcher.ts", "utf8");

  it("hints sidecar tool paths at tool start, minus watcher-filtered paths", () => {
    assert.match(main, /if \(rel && !toolWs\.watcher\?\.isIgnored\(rel\)\) this\.addPendingHint\(inst, rel\);/);
    assert.match(watcher, /isIgnored\(relPath: string\): boolean \{/);
  });

  it("hints deletes so the next incremental drops the path", () => {
    const deletedBlock = main.slice(
      main.indexOf("watcher.onFileDeleted"),
      main.indexOf("watcher.start();"),
    );
    assert.match(deletedBlock, /this\.addPendingHint\(inst, relPath\);/);
    assert.match(deletedBlock, /this\.scheduleMomentCapture\(inst, rendererTarget\);/);
  });

  it("hints oversized and binary files without caching content", () => {
    assert.match(watcher, /onFileUncached: \(path: string, status: "created" \| "modified"\)/);
    assert.match(watcher, /await this\.reportUncached\(abs, relPath, generation\);/);
    const uncachedBlock = main.slice(
      main.indexOf("watcher.onFileUncached"),
      main.indexOf("watcher.onFileDeleted"),
    );
    assert.match(uncachedBlock, /ws\.generation\+\+;/);
    assert.match(uncachedBlock, /this\.addPendingHint\(inst, relPath\);/);
    assert.match(uncachedBlock, /this\.scheduleMomentCapture\(inst, rendererTarget\);/);
  });

  it("retries an incremental that returns the parent while hints are pending", () => {
    const captureBlock = main.slice(
      main.indexOf("private async captureMomentNow("),
      main.indexOf("private attachMomentState("),
    );
    assert.match(captureBlock, /hints\.size > 0 && state\.commit === parent/);
    assert.match(captureBlock, /momentUnsettledRetries/);
    assert.match(captureBlock, /job\.inst\.momentDots = \[\.\.\.job\.batch, \.\.\.job\.inst\.momentDots\]/);
    assert.match(captureBlock, /this\.scheduleMomentCapture\(job\.inst, expected\);/);
  });

  it("retries while the watcher still has queued or in-flight work", () => {
    const captureBlock = main.slice(
      main.indexOf("private async captureMomentNow("),
      main.indexOf("private attachMomentState("),
    );
    assert.match(captureBlock, /watcherStats\.pendingItems === 0 && watcherStats\.inFlight === 0/);
    assert.match(captureBlock, /watcher\.isPaused\(\)/);
  });
});
