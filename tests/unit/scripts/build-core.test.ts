/**
 * Core-build validation regressions (issue #134).
 *
 * Every source build must ask cargo to validate its incremental inputs and
 * stage the result through stageCoreBinary. No mtime shortcut may report
 * success without cargo validation — including for a future-dated or
 * otherwise unrelated staged destination. Uses an isolated fixture project
 * with a fake cargo executable; never the real toolchain or tree.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCore } from "../../../scripts/build-core.ts";

const ENV_KEYS = ["CARGO", "CARGO_TARGET_DIR", "CARGO_BUILD_TARGET_DIR", "TERMINA_SKIP_CORE_BUILD", "FAKE_CARGO_MARKER"] as const;

describe("buildCore cargo validation (#134)", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const savedCwd = process.cwd();
  const fixtures: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    delete process.env.CARGO_BUILD_TARGET_DIR;
    delete process.env.TERMINA_SKIP_CORE_BUILD;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    process.chdir(savedCwd);
    logSpy.mockRestore();
    while (fixtures.length > 0) rmSync(fixtures.pop()!, { recursive: true, force: true });
  });

  /** Isolated fixture project with a fake cargo that records invocations. */
  function makeProject(binaryBytes = "fake-core-binary"): {
    root: string;
    destination: string;
    marker: string;
  } {
    const root = mkdtempSync(join(tmpdir(), "termina-build-core-"));
    fixtures.push(root);
    mkdirSync(join(root, "dist-electron"), { recursive: true });
    const targetDir = join(root, "cargo-target");
    const marker = join(root, "cargo-invocations.log");
    const fakeCargo = join(root, "fake-cargo.sh");
    writeFileSync(
      fakeCargo,
      `#!/bin/sh\necho "cargo-invoked: $@" >> "$FAKE_CARGO_MARKER"\nmkdir -p "$CARGO_TARGET_DIR/release"\nprintf '${binaryBytes}' > "$CARGO_TARGET_DIR/release/termina-core"\n`,
    );
    chmodSync(fakeCargo, 0o755);
    process.env.CARGO = fakeCargo;
    process.env.CARGO_TARGET_DIR = targetDir;
    process.env.FAKE_CARGO_MARKER = marker;
    process.chdir(root);
    return { root, destination: join(root, "dist-electron", "termina-core"), marker };
  }

  const invocations = (marker: string): string[] =>
    readFileSync(marker, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
  const logged = (): string => logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");

  it("retains no mtime shortcut around cargo", () => {
    const source = readFileSync(join(savedCwd, "scripts/build-core.ts"), "utf8");
    expect(source).not.toContain("isCoreUpToDate");
    expect(source).not.toContain("up to date");
  });

  it("validates through cargo despite a future-dated unrelated destination", () => {
    const { destination, marker } = makeProject();
    writeFileSync(destination, "unrelated text, not a core binary");
    const future = new Date("2035-01-01T00:00:00Z");
    utimesSync(destination, future, future);

    buildCore();

    const calls = invocations(marker);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("cargo-invoked: build --release --manifest-path core/Cargo.toml");
    expect(readFileSync(destination, "utf8")).toBe("fake-core-binary");
    expect(logged()).toContain("termina-core built");
  });

  it("revalidates every build and follows a changed target dir", () => {
    const { destination, marker } = makeProject("binary-from-target-a");
    buildCore();
    expect(invocations(marker)).toHaveLength(1);

    // A second build stages fresh output even though the destination is new,
    // and a changed target dir changes what gets staged.
    const targetB = join(mkdirsTmp(), "cargo-target-b");
    mkdirSync(targetB, { recursive: true });
    process.env.CARGO_TARGET_DIR = targetB;
    process.env.CARGO = rewriteFakeCargo(targetB, "binary-from-target-b");
    buildCore();

    expect(invocations(marker)).toHaveLength(2);
    expect(readFileSync(destination, "utf8")).toBe("binary-from-target-b");

    function mkdirsTmp(): string {
      const dir = mkdtempSync(join(tmpdir(), "termina-build-core-b-"));
      fixtures.push(dir);
      return dir;
    }
    function rewriteFakeCargo(targetDir: string, binaryBytes: string): string {
      const fakeCargo = join(targetDir, "..", "fake-cargo-b.sh");
      writeFileSync(
        fakeCargo,
        `#!/bin/sh\necho "cargo-invoked: $@" >> "${marker}"\nmkdir -p "${targetDir}/release"\nprintf '${binaryBytes}' > "${targetDir}/release/termina-core"\n`,
      );
      chmodSync(fakeCargo, 0o755);
      return fakeCargo;
    }
  });

  it("preserves the TERMINA_SKIP_CORE_BUILD trusted-reuse boundary", () => {
    const { destination } = makeProject();
    writeFileSync(destination, "trusted staged binary");
    process.env.TERMINA_SKIP_CORE_BUILD = "1";
    process.env.CARGO = join(tmpdir(), "cargo-must-not-run");

    buildCore();

    expect(readFileSync(destination, "utf8")).toBe("trusted staged binary");
    expect(logged()).toContain("reused (TERMINA_SKIP_CORE_BUILD)");
  });

  it("builds when the reuse boundary is set but no destination exists", () => {
    const { destination, marker } = makeProject();
    process.env.TERMINA_SKIP_CORE_BUILD = "1";

    buildCore();

    expect(invocations(marker)).toHaveLength(1);
    expect(readFileSync(destination, "utf8")).toBe("fake-core-binary");
  });

  it("rebuilds under force even with the reuse boundary set", () => {
    const { destination, marker } = makeProject();
    writeFileSync(destination, "trusted staged binary");
    process.env.TERMINA_SKIP_CORE_BUILD = "1";

    buildCore(true);

    expect(invocations(marker)).toHaveLength(1);
    expect(readFileSync(destination, "utf8")).toBe("fake-core-binary");
  });
});
