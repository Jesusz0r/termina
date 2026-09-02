import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

describe("Sandbox Required-Live Security Gate & Policy Contracts", () => {
  it("passes sandbox required-live policy contract", async () => {
    const scriptPath = resolve("scripts", "sandbox-security-policy-test.mjs");
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--no-warnings", scriptPath],
      {
        cwd: process.cwd(),
        timeout: 90_000,
      },
    );

    expect(stdout).toContain("sandbox required-live policy contract passed");
  }, 90_000);

  it.skipIf(process.platform !== "darwin")("passes sandbox gate signal, orphan, and failed-probe contracts", async () => {
    const scriptPath = resolve("scripts", "sandbox-security-gate-lifecycle-test.mjs");
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--no-warnings", scriptPath],
      {
        cwd: process.cwd(),
        timeout: 90_000,
      },
    );

    expect(stdout).toContain("sandbox gate signal/orphan and failed-probe contracts passed");
  }, 90_000);
});
