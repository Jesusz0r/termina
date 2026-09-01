import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

describe("Worldline Manager, Core Client & Retention Performance Unit Suite", () => {
  async function runScript(scriptName: string, timeout = 90_000) {
    const scriptPath = resolve("scripts", scriptName);
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", scriptPath],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TERMINA_CORE_TEST: "1",
          TERMINA_CORE_BIN: resolve("core", "target", "release", "termina-core"),
        },
        timeout,
      },
    );
    return { stdout, stderr };
  }

  it("passes worldline ready failure checks", async () => {
    const { stdout } = await runScript("worldline-ready-test.mjs");
    expect(stdout).toContain("worldline ready failure checks passed");
  });

  it("passes worldline reopen flow contracts", async () => {
    const { stdout } = await runScript("worldline-reopen-flow-test.mjs");
    expect(stdout).toContain("cancellation");
  });

  it("passes ipc/project flow probes", async () => {
    const { stdout } = await runScript("ipc-project-flow-test.mjs");
    expect(stdout).toContain("22/22 passed");
  });

  it("passes core client read budget gate", async () => {
    const { stdout } = await runScript("core-client-read-budget-test.mjs");
    expect(stdout).toContain("PASS");
  });

  it("passes retention ledger focused performance regressions", async () => {
    const { stdout } = await runScript("session-retention-performance-test.mjs", 120_000);
    expect(stdout).toContain("PASS retention-ledger focused regressions");
  }, 120_000);

  it("passes worldline runtime teardown & candidate flow", async () => {
    const { stdout } = await runScript("worldline-runtime-flow-test.mjs", 120_000);
    expect(stdout).toContain("freshCancel");
  }, 120_000);
});
