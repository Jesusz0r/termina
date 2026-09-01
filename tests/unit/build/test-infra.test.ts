import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

describe("Test Infrastructure & Gate Invariants", () => {
  it("enforces canonical reporting, session gates, and trace wiring", async () => {
    const scriptPath = resolve("scripts", "test-infra-test.mjs");
    const { stdout } = await execFileAsync(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      timeout: 60_000,
    });
    expect(stdout).toContain("pass 6");
    expect(stdout).toContain("fail 0");
  }, 60_000);
});
