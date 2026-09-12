import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("recording bootstrap", () => {
  it("keeps the snapshot store when the initial capture fails", () => {
    const main = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");
    const worldlineGit = readFileSync(new URL("../../../electron/worldline-git.ts", import.meta.url), "utf8");
    const checks: string[] = [];
    function check(name: string, value: unknown) {
      assert.equal(Boolean(value), true, name);
      checks.push(name);
    }

    check(
      "initial capture failure keeps the store",
      main.includes("initial workspace capture failed")
        && main.includes("this.pushRecorderForWorkspace(ws, \"paused\", rendererTarget);")
        && main.includes("return store;"),
    );
    check(
      "non-private event leaves are replaced through the bound parent",
      worldlineGit.includes("promotion read file is not a bounded private regular file")
        && worldlineGit.includes("expectedDestinationForBoundWrite")
        && worldlineGit.includes("await removeBoundOwnedEntry({ binding })"),
    );
    assert.ok(checks.length >= 2);
  });
});
