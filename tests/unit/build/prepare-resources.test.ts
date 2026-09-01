import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

describe("Build, Installer & Resources Integration Invariants", () => {
  it("enforces fail-closed Node runtime staging and verification", async () => {
    const scriptPath = resolve("scripts/prepare-resources-test.mjs");
    const { stdout } = await execFileAsync(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      timeout: 120_000,
    });
    expect(stdout).toContain("PASS a known correct SHA-256 is accepted");
    expect(stdout).toContain("PASS a symlinked component in the extracted runtime is rejected");
  }, 120_000);

  it("verifies clean source installer staging and execution", async () => {
    const scriptPath = resolve("scripts/install-source-test.mjs");
    const { stdout } = await execFileAsync(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      timeout: 60_000,
    });
    expect(stdout).toContain("source installer: 6/6 passed");
  }, 60_000);
});
