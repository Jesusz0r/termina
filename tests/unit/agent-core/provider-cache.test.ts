import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

describe("Agent Core Provider Capabilities, Cache Policies & Rate Accounting", () => {
  async function runScript(scriptName: string, timeout = 60_000) {
    const scriptPath = resolve("tests", "probes", "agent-core", scriptName);
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

  it("passes provider cache tests", async () => {
    const { stdout } = await runScript("agent-core-provider-cache-test.mjs");
    expect(stdout).toContain("provider/cache tests passed");
  });

  it("passes provider probe tests", async () => {
    const { stdout } = await runScript("agent-core-provider-probe-test.mjs");
    expect(stdout).toContain("PASS");
  });

  it("passes cache experiment tests", async () => {
    const { stdout } = await runScript("agent-core-cache-experiment-test.mjs");
    expect(stdout).toContain("agent-core cache experiment tests passed");
  });

  it("passes rate accounting tests", async () => {
    const { stdout } = await runScript("agent-core-rates-test.mjs");
    expect(stdout).toContain("agent-core-rates-test");
  });

  it("passes token calibration tests", async () => {
    const { stdout } = await runScript("agent-core-token-calibration-test.mjs");
    expect(stdout).toContain("agent-core token calibration tests passed");
  });
});
