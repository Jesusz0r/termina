import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

describe("Release Core Binary Staging & Architecture Invariants", () => {
  it("preserves identity, architecture, and bounded JSON-lines protocol", async () => {
    const scriptPath = resolve("scripts", "release-core-stage-test.mjs");
    const { stdout } = await execFileAsync(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      timeout: 30_000,
    });
    expect(stdout).toContain("PASS release core staging preserves identity, architecture, and a bounded JSON-lines response");
  });
});
