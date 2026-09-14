/**
 * Release-gate graph regressions (issue #132).
 *
 * package.json owns one canonical release graph: app + test typechecks,
 * unit tests, Rust tests, then the portable native suites — each suite
 * once, with the macOS-only layer (platform spike, sandbox-live,
 * built-Electron smoke) at the packaging layer. release.yml wires build
 * artifacts before the gate and publication after it. Required
 * artifact-dependent checks must fail, not silently pass, when their
 * prerequisite is missing.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = resolve(__dirname, "..", "..", "..");
const scripts = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).scripts as Record<string, string>;
const workflow = readFileSync(join(repo, ".github/workflows/release.yml"), "utf8");

/** Count standalone `name` steps in a `&&`-chained npm script. */
function countStep(script: string, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (String(script ?? "").match(new RegExp(`(?:^|&&|\\s)${escaped}(?=\\s|$)`, "g")) ?? []).length;
}

function jobBlock(name: string): string {
  const startMatch = new RegExp(`^  ${name}:\\s*$`, "m").exec(workflow);
  expect(startMatch, `release workflow needs a ${name} job`).toBeTruthy();
  const start = startMatch!.index;
  const rest = workflow.slice(start + startMatch![0].length);
  const nextJob = /^  [a-zA-Z0-9_-]+:\s*$/m.exec(rest);
  return workflow.slice(start, nextJob ? start + startMatch![0].length + nextJob.index : undefined);
}

describe("release graph (#132)", () => {
  it("defines one canonical gate with explicit prerequisites, each suite once", () => {
    const release = scripts["test:release"];
    expect(countStep(release, "pnpm run test")).toBe(1);
    expect(countStep(release, "pnpm run typecheck:tests")).toBe(1);
    expect(countStep(release, "pnpm run test:rust")).toBe(1);
    expect(countStep(release, "pnpm run test:native")).toBe(1);
    // Prerequisite order: types + unit, then test types, Rust, native.
    const order = ["pnpm run test", "pnpm run typecheck:tests", "pnpm run test:rust", "pnpm run test:native"].map((s) =>
      release.indexOf(s),
    );
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("reruns no Vitest subset without a distinct validation purpose", () => {
    const release = scripts["test:release"];
    for (const subset of ["test:release-core", "test:agent-core-main", "test:release-workflow"]) {
      expect(release, `${subset} is already covered by test:unit`).not.toContain(subset);
    }
  });

  it("runs Rust tests against the core manifest", () => {
    expect(scripts["test:rust"]).toBe("cargo test --manifest-path core/Cargo.toml");
  });

  it("covers the native safety suites at the right platform layer", () => {
    const native = scripts["test:native"];
    for (const suite of [
      "capture",
      "merge",
      "tree-delta",
      "gitignore",
      "terminal-roster",
      "core-session-promotion",
      "promotion-transaction",
      "watcher-idle",
    ]) {
      expect(countStep(native, `pnpm run spike -- ${suite}`)).toBe(1);
    }
    expect(countStep(native, "pnpm run test:promotion-native-boundary")).toBe(1);
    // The platform spike is macOS-only by design; it must not gate Ubuntu.
    expect(native).not.toContain("platform");
    // The full spike bundle is the portable graph plus the platform spike —
    // no suite listed twice.
    expect(scripts["test:spikes"]).toBe("pnpm run test:native && pnpm run spike -- platform");
    // macOS packaging layer: platform spike, then the live gates, in order.
    const macos = scripts["test:release-macos"];
    const order = ["pnpm run spike -- platform", "pnpm run test:sandbox-security-live", "pnpm run test:e2e-release-smoke"].map(
      (s) => macos.indexOf(s),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("wires build artifacts before the gate and publication after it", () => {
    const testJob = jobBlock("test");
    const buildJob = jobBlock("build");
    const publishJob = jobBlock("publish");
    const buildStep = testJob.indexOf("run: pnpm run build");
    const gateStep = testJob.search(/run: pnpm run test:release\b/);
    expect(buildStep).toBeGreaterThanOrEqual(0);
    expect(gateStep).toBeGreaterThan(buildStep);
    expect(buildJob).toMatch(/needs:\s*(?:test|\[\s*test\s*\])\b/);
    expect(publishJob).toMatch(/needs:\s*(?:build|\[\s*build\s*\])\b/);
    const macGateRun = buildJob.indexOf("run: pnpm run test:release-macos");
    const packageStep = buildJob.indexOf("name: Package");
    expect(macGateRun).toBeGreaterThanOrEqual(0);
    expect(macGateRun).toBeLessThan(packageStep);
  });

  it("fails the core-staging gate when its required binary is missing", () => {
    const source = readFileSync(join(repo, "tests/unit/build/release-core.test.ts"), "utf8");
    expect(source).not.toMatch(/skipping/);
    // Behavioral: point the target dir at an empty fixture so the binary is
    // absent, and the standalone gate must fail instead of passing.
    const emptyTarget = mkdtempSync(join(tmpdir(), "termina-no-core-target-"));
    const env: NodeJS.ProcessEnv = { ...process.env, CARGO_TARGET_DIR: emptyTarget };
    delete env.CARGO_BUILD_TARGET_DIR;
    const result = spawnSync(
      process.execPath,
      [join(repo, "node_modules/vitest/vitest.mjs"), "run", "tests/unit/build/release-core.test.ts"],
      { cwd: repo, encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024, env },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    expect(result.status, `expected the missing-artifact gate to fail:\n${output}`).not.toBe(0);
    expect(output).toContain("must fail when its required artifact is missing");
  });
});
