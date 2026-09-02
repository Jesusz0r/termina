import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

describe("Agent Core Kernel & TUI Harness Suite", () => {
  it("passes all 874 kernel harness assertions", async () => {
    const scriptPath = resolve("tests", "probes", "agent-core", "agent-core-harness-test.mjs");
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", scriptPath],
      {
        cwd: process.cwd(),
        env: { ...process.env, TERMINA_CORE_TEST: "1" },
        timeout: 120_000,
      },
    );

    expect(stdout).toContain("874/874 passed");
  });
});
