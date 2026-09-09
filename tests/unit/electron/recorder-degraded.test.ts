import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Source-level probes for degraded timeline recovery: a failed moment
 * capture reports its reason to the timeline tooltip, and a dangling base
 * (rebuilt store) reseeds primary workspaces with one bounded full capture
 * instead of failing every incremental capture forever.
 */
describe("Recorder Degraded Invariants", () => {
  const main = readFileSync("electron/main.ts", "utf8");
  const timeline = readFileSync("src/timeline.ts", "utf8");

  it("pushes the capture error with the degraded recorder state", () => {
    assert.match(main, /timeline:recorder-state.+detail: inst\.recorderDetail/s);
    assert.match(main, /message\.slice\(0, 160\)/);
  });

  it("reseeds a dangling base with a bounded full capture on primary workspaces", () => {
    assert.match(main, /ws\.primary && Date\.now\(\) - inst\.lastReseedMs > 60_000/);
    assert.match(main, /store\.capture\(await gitHead\(ws\.root\), null\)/);
  });

  it("renders the capture error in the degraded tooltip", () => {
    assert.match(timeline, /\$\{base\}: \$\{detail\}/);
  });
});
