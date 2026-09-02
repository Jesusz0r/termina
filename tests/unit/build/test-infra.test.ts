import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseNativeByteBound } from "../../test-support.mjs";

const repo = process.cwd();

function runNode(args: string[], options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
}

describe("Test Infrastructure & Gate Invariants", () => {
  it("verifies package-wired session gate executes canonical Vitest targets", () => {
    const scripts = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).scripts;
    expect(scripts["test:agent-core-session"]).toContain("session.test.ts");
    expect(scripts["test:agent-core-session"]).toContain("session-receipt.test.ts");
  });

  it("propagates a failed check as nonzero in canonical callback reporter", () => {
    const supportUrl = pathToFileURL(join(repo, "tests/test-support.mjs")).href;
    const source = [
      `import { runExportedChecks } from ${JSON.stringify(supportUrl)};`,
      'const result = await runExportedChecks(({ check }) => check("forced failure", false), { label: "forced" });',
      "process.exitCode = result.exitCode;",
    ].join("\n");
    const result = runNode(["--input-type=module", "-e", source]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAIL  forced failure");
    expect((result.stdout.match(/^FAIL  forced failure$/gm) ?? []).length).toBe(1);
    expect((result.stdout.match(/^0\/1 passed$/gm) ?? []).length).toBe(1);
    expect(result.stdout).not.toContain("PASS  forced failure");
  });

  it("wires default and release graphs through canonical Vitest suites", () => {
    const scripts = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).scripts;
    expect(scripts["test:agent-core-trace"]).toContain("tests/unit/agent-core/trace.test.ts");
    expect(scripts["test"]).toContain("npm run test:unit");
    expect(scripts["test:release"]).toContain("npm run test");
  });

  it("wires ipc-navigation through its isolated E2E spec runner", () => {
    const scripts = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).scripts;
    expect(scripts["test:ipc-navigation"]).toBe("playwright test tests/e2e/ipc-navigation.spec.ts");
  });

  it("derives decimal byte bound from native read-budget failures", () => {
    expect(parseNativeByteBound("blob fixture exceeds its 49283072-byte bound")).toBe(49_283_072);
    expect(() => parseNativeByteBound("blob fixture exceeded the native read budget")).toThrow(/byte bound/);
  });
});
