import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { sandboxShellPreamble } from "../../../electron/sandbox.ts";

const execFileAsync = promisify(execFile);

describe("Electron Candidate Filesystem & Environment Sandbox Isolation", () => {
  it("keeps per-process limits fail-closed without lowering the UID process ceiling", () => {
    expect(sandboxShellPreamble()).toBe("ulimit -t 7200 && ulimit -n 1024 && ulimit -f 2097152 || exit 126;");
  });

  it.skipIf(process.platform !== "darwin")("passes sandbox isolation contracts", async () => {
    const scriptPath = resolve("scripts", "sandbox-security-test.ts");
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
