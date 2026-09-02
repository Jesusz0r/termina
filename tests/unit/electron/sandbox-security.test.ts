import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

describe("Electron Candidate Filesystem & Environment Sandbox Isolation", () => {
  it.skipIf(process.platform !== "darwin")("passes sandbox isolation contracts", async () => {
    const scriptPath = resolve("scripts", "sandbox-security-test.mjs");
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", scriptPath],
      {
        cwd: process.cwd(),
        timeout: 90_000,
      },
    );
    expect(stdout).toMatch(/\d+\/\d+ passed/);
  }, 90_000);
});
