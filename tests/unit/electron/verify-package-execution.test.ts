import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { detectTestCommand } from "../../../electron/verify-detect.ts";
import { filterVerifyEnvironment } from "../../../electron/sandbox.ts";
import { readVerifyStages, writeVerifyPackage } from "../../fixtures/verify-package.ts";

const execFileAsync = promisify(execFile);

async function withPackage(
  scripts: Record<string, string>,
  check: (root: string, env: NodeJS.ProcessEnv) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "termina verify package "));
  try {
    await writeVerifyPackage(root, scripts);
    await mkdir(join(root, "home"));
    await mkdir(join(root, "tmp"));
    const env = filterVerifyEnvironment({
      ...process.env, HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
      ANTHROPIC_API_KEY: "verify-package-canary", PI_SESSION_FILE: "verify-session-canary",
    }, [dirname(process.execPath)]);
    await check(root, env);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")("live Verify package execution", () => {
  it("uses npm for local binaries, ordered lifecycle hooks, and the script environment", async () => {
    await withPackage({
      pretest: "termina-verify-fixture pre",
      test: 'termina-verify-fixture "two words" && termina-verify-fixture main',
      posttest: "termina-verify-fixture post",
    }, async (root, env) => {
      const command = await detectTestCommand(root);
      expect(command).toEqual({ command: "npm", args: ["run", "test"], label: "npm run test" });
      await execFileAsync(command!.command, command!.args, { cwd: root, env, timeout: 20_000 });
      const output = await readVerifyStages(root);
      expect(output.map((stage) => stage.args)).toEqual([["pre"], ["two words"], ["main"], ["post"]]);
      expect(output.map((stage) => stage.event)).toEqual(["pretest", "test", "test", "posttest"]);
      expect(output.map((stage) => stage.cwd)).toEqual(Array(4).fill(await realpath(root)));
      expect(output.every((stage) => stage.secret === null && stage.hostSession === null)).toBe(true);
    });
  });

  it("runs the selected test:* script and its matching hooks", async () => {
    await withPackage({
      "pretest:unit": "termina-verify-fixture pre",
      "test:unit": "termina-verify-fixture unit",
      "posttest:unit": "termina-verify-fixture post",
    }, async (root, env) => {
      const command = await detectTestCommand(root);
      expect(command).toEqual({ command: "npm", args: ["run", "test:unit"], label: "npm run test:unit" });
      await execFileAsync(command!.command, command!.args, { cwd: root, env, timeout: 20_000 });
      expect((await readVerifyStages(root)).map((stage) => stage.event)).toEqual(["pretest:unit", "test:unit", "posttest:unit"]);
    });
  });

  it("does not bypass a failing pretest hook", async () => {
    await withPackage({
      pretest: "termina-verify-fixture fail",
      test: "termina-verify-fixture should-not-run",
      posttest: "termina-verify-fixture should-not-run",
    }, async (root, env) => {
      const command = await detectTestCommand(root);
      await expect(execFileAsync(command!.command, command!.args, { cwd: root, env, timeout: 20_000 })).rejects.toMatchObject({ code: 7 });
      expect((await readVerifyStages(root)).map((stage) => stage.args)).toEqual([["fail"]]);
    });
  });

  it("does not run posttest after a failing test", async () => {
    await withPackage({
      pretest: "termina-verify-fixture pre",
      test: "termina-verify-fixture fail",
      posttest: "termina-verify-fixture should-not-run",
    }, async (root, env) => {
      const command = await detectTestCommand(root);
      await expect(execFileAsync(command!.command, command!.args, { cwd: root, env, timeout: 20_000 })).rejects.toMatchObject({ code: 7 });
      expect((await readVerifyStages(root)).map((stage) => stage.event)).toEqual(["pretest", "test"]);
    });
  });
});
