import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

describe("Release Workflow & CI Publication Invariants", () => {
  it("enforces single all-platform transaction after test gate", async () => {
    const scriptPath = resolve("scripts", "release-workflow-test.mjs");
    const { stdout } = await execFileAsync(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      timeout: 30_000,
    });
    expect(stdout).toContain("release workflow publication contract passed");
  });
});
