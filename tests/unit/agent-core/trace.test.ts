import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

describe("Agent Core Telemetry & Execution Traces", () => {
  async function runScript(scriptName: string, timeout = 60_000) {
    const scriptPath = resolve("scripts", scriptName);
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", scriptPath],
      {
        cwd: process.cwd(),
        env: { ...process.env, TERMINA_CORE_TEST: "1" },
        timeout,
      },
    );
    return { stdout, stderr };
  }

  it("passes agent-core trace runtime tests", async () => {
    const { stdout } = await runScript("agent-core-trace-runtime-test.mjs");
    expect(stdout).toContain("agent-core trace runtime tests passed");
  });

  it("passes agent-core trace v2 tests", async () => {
    const { stdout } = await runScript("agent-core-trace-v2-test.mjs");
    expect(stdout).toContain("agent-core trace v2 tests passed");
  });

  it("passes agent-core trace report tests", async () => {
    const { stdout } = await runScript("agent-core-trace-report-test.mjs");
    expect(stdout).toContain("agent-core trace report tests passed");
  });
});
