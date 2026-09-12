import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

describe("recording bootstrap", () => {
  it("keeps the snapshot store when the initial capture fails", () => {
    const main = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");
    // The core client is a directory; read every module so the probes cover
    // the whole owner instead of one file.
    const ownerDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "electron", "worldline-git");
    const worldlineGit = ["../../../electron/worldline-git.ts", ...readdirSync(ownerDir)
      .filter((name) => name.endsWith(".ts"))
      .sort()
      .map((name) => `../../../electron/worldline-git/${name}`)]
      .map((rel) => readFileSync(new URL(rel, import.meta.url), "utf8"))
      .join("\n");
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
