import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

describe("Agent Core Main Loop, Streaming, Tool Call & Shutdown Contracts", () => {
  async function runScript(scriptName: string, timeout = 60_000) {
    const scriptPath = resolve("scripts", scriptName);
    try {
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
    } catch (err: any) {
      throw new Error(`${err.message}\nSTDOUT: ${err.stdout}\nSTDERR: ${err.stderr}`);
    }
  }

  it("passes P0 focused main integration tests", async () => {
    const { stdout } = await runScript("agent-core-main-p0-test.mjs");
    expect(stdout).toContain("all focused main integration tests passed");
  }, 30_000);

  it("passes Stage 3 integration contracts", async () => {
    const { stdout } = await runScript("agent-core-main-stage3-test.mjs");
    expect(stdout).toContain("agent-core main Stage 3 integration contracts passed");
  }, 30_000);

  it("passes Stage 3B retry trace contract", async () => {
    const { stdout } = await runScript("agent-core-main-stage3b-test.mjs");
    expect(stdout).toContain("agent-core main Stage 3B retry trace contract passed");
  }, 30_000);

  it("passes Anthropic stream-bound contract", async () => {
    const { stdout } = await runScript("agent-core-main-anthropic-stream-test.mjs");
    expect(stdout).toContain("agent-core Anthropic stream-bound contract passed");
  }, 30_000);

  it("passes Anthropic terminal contract", async () => {
    const { stdout } = await runScript("agent-core-main-anthropic-terminal-test.mjs");
    expect(stdout).toContain("agent-core Anthropic terminal contract passed");
  }, 30_000);

  it("passes catalog cancellation contract", async () => {
    const { stdout } = await runScript("agent-core-main-catalog-cancel-test.mjs");
    expect(stdout).toContain("main auth and catalog operations retain caller cancellation");
  }, 30_000);

  it("passes canonical cost calculation contract", async () => {
    const { stdout } = await runScript("agent-core-main-cost-test.mjs");
    expect(stdout).toContain("agent-core main canonical cost contract passed");
  }, 30_000);

  it("passes failed-provider trace contract", async () => {
    const { stdout } = await runScript("agent-core-main-failure-trace-test.mjs");
    expect(stdout).toContain("agent-core failed-provider trace contract passed");
  }, 30_000);

  it("passes final-review contracts", async () => {
    const { stdout } = await runScript("agent-core-main-final-review-test.mjs");
    expect(stdout).toContain("agent-core main final-review contracts passed");
  }, 30_000);

  it("passes shutdown-with-pending-approval contract", async () => {
    const { stdout } = await runScript("agent-core-main-shutdown-approval-test.mjs");
    expect(stdout).toContain("agent-core shutdown-with-pending-approval contract passed");
  }, 30_000);
});
