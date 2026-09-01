import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

describe("Project Watcher & PTY Egress Backpressure Dynamics", () => {
  it("passes watcher bounded-emitter checks", async () => {
    const scriptPath = resolve("scripts", "watcher-backpressure-test.mjs");
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--no-warnings", scriptPath],
      {
        cwd: process.cwd(),
        timeout: 60_000,
      },
    );

    expect(stdout).toContain("watcher bounded-emitter checks passed");
  }, 60_000);

  it("passes pty egress queue limits and backpressure controls", async () => {
    const scriptPath = resolve("scripts", "pty-egress-test.mjs");
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--no-warnings", scriptPath],
      {
        cwd: process.cwd(),
        timeout: 30_000,
      },
    );

    expect(stdout).toContain("burstBytes");
  });
});
