import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

describe("Sidecar Concurrency & Race Condition Invariants", () => {
  async function runScript(scriptName: string) {
    const scriptPath = resolve("tests", "probes", "electron", scriptName);
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--no-warnings", scriptPath],
      {
        cwd: process.cwd(),
        env: { ...process.env, TERMINA_CORE_TEST: "1" },
        timeout: 30_000,
      },
    );
    return { stdout, stderr };
  }

  it("passes sidecar rotation race tests", async () => {
    const { stdout } = await runScript("sidecar-rotation-race-test.mjs");
    expect(stdout).toContain("sidecar sealed rotation race passed");
  });

  it("passes sidecar shutdown race tests", async () => {
    const { stdout } = await runScript("sidecar-shutdown-race-test.mjs");
    expect(stdout).toContain("sidecar shutdown marker race passed");
  });

  it("passes sidecar retirement race tests", async () => {
    const { stdout } = await runScript("sidecar-retirement-race-test.mjs");
    expect(stdout).toContain("sidecar retirement race and restart probes passed");
  });

  it("passes sidecar runtime flow tests", async () => {
    const { stdout } = await runScript("sidecar-runtime-flow-test.mjs");
    expect(stdout).toContain("concurrent");
  });
});
