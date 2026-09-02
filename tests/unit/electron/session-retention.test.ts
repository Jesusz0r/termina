import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

describe("Session Fork Teardown, Retention & Pi Admission Invariants", () => {
  it("passes session fork teardown and retention regressions", async () => {
    const scriptPath = resolve("tests", "probes", "electron", "session-fork-retention-test.mjs");
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", scriptPath],
      {
        cwd: process.cwd(),
        env: { ...process.env, TERMINA_CORE_TEST: "1" },
        timeout: 120_000,
      },
    );

    expect(stdout).toContain("PASS session-fork teardown/retention regressions");
  }, 120_000);

  it("passes Pi session admission and cleanup regressions", async () => {
    const scriptPath = resolve("tests", "probes", "electron", "session-pi-admission-test.mjs");
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", scriptPath],
      {
        cwd: process.cwd(),
        env: { ...process.env, TERMINA_CORE_TEST: "1" },
        timeout: 60_000,
      },
    );

    expect(stdout).toContain("PASS Pi session admission/cleanup regressions");
  }, 60_000);
});
