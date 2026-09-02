import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

describe("Agent Core Segmented Session Bundles & Retention", () => {
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

  it("passes segmented session bundle tests", async () => {
    const { stdout } = await runScript("agent-core-session-test.mjs", 120_000);
    expect(stdout).toContain("112/112 passed");
  }, 120_000);

  it("passes session retention admission regressions", async () => {
    const { stdout } = await runScript("agent-core-session-retention-test.mjs", 60_000);
    expect(stdout).toContain("agent-core session retention admission regressions");
  }, 60_000);
});
