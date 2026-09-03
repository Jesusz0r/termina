import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseTargetCwdFromArgv, getCliSourcePath } from "../../../electron/cli-install.ts";

describe("CLI Launch and Argument Parsing", () => {
  const repoRoot = resolve(__dirname, "../../..");

  it("resolves '.' to fallbackCwd", () => {
    const result = parseTargetCwdFromArgv(["node", "scripts/dev.ts", "."], repoRoot, false);
    expect(result).toBe(repoRoot);
  });

  it("resolves relative subdirectories against fallbackCwd", () => {
    const result = parseTargetCwdFromArgv(["node", "scripts/dev.ts", "electron"], repoRoot, false);
    expect(result).toBe(resolve(repoRoot, "electron"));
  });

  it("resolves files to their parent directory", () => {
    const result = parseTargetCwdFromArgv(["node", "scripts/dev.ts", "package.json"], repoRoot, false);
    expect(result).toBe(repoRoot);
  });

  it("filters out Electron flags and macOS process flags", () => {
    const argv = [
      "termina",
      "-psn_0_123456",
      "--no-sandbox",
      "--args",
      "electron",
    ];
    const result = parseTargetCwdFromArgv(argv, repoRoot, true);
    expect(result).toBe(resolve(repoRoot, "electron"));
  });

  it("returns null when no valid directory or file argument is given", () => {
    const argv = ["termina", "--some-flag", "non-existent-directory-xyz-12345"];
    const result = parseTargetCwdFromArgv(argv, repoRoot, true);
    expect(result).toBeNull();
  });

  it("handles packaged argv structure correctly (slice 1 instead of 2)", () => {
    const argv = ["/Applications/Termina.app/Contents/MacOS/Termina", "."];
    const result = parseTargetCwdFromArgv(argv, repoRoot, true);
    expect(result).toBe(repoRoot);
  });

  it("returns null when no arguments are passed", () => {
    expect(parseTargetCwdFromArgv(["node", "scripts/dev.ts"], repoRoot, false)).toBeNull();
    expect(parseTargetCwdFromArgv(["termina"], repoRoot, true)).toBeNull();
  });

  it("locates the bundled CLI launcher script in resources/bin/termina", () => {
    const sourcePath = getCliSourcePath();
    expect(existsSync(sourcePath)).toBe(true);
    expect(sourcePath.endsWith("bin/termina")).toBe(true);

    const stat = statSync(sourcePath);
    // Executable bit set (at least user executable 0o100)
    expect((stat.mode & 0o111) !== 0).toBe(true);
  });

  it("prints help message when --help or -h is passed to bin/termina", () => {
    const sourcePath = getCliSourcePath();
    const output = execFileSync(sourcePath, ["--help"], { encoding: "utf8" });
    expect(output).toContain("Usage: termina");
    expect(output).toContain("--help");
    expect(output).toContain("--version");
  });

  it("prints version string when --version or -v is passed to bin/termina", () => {
    const sourcePath = getCliSourcePath();
    const output = execFileSync(sourcePath, ["--version"], { encoding: "utf8" });
    expect(output).toMatch(/Termina/);
  });
});
