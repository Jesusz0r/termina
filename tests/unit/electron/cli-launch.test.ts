import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { statSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseTargetCwdFromArgv, getCliSourcePath, quoteAppleScriptString } from "../../../electron/cli-install.ts";
import { quoteShellArg } from "../../../shared/terminal-control.ts";

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

  it("escapes AppleScript double-quoted strings", () => {
    expect(quoteAppleScriptString("plain")).toBe("plain");
    expect(quoteAppleScriptString('say "hi"')).toBe('say \\"hi\\"');
    expect(quoteAppleScriptString("a\\b")).toBe("a\\\\b");
    expect(quoteAppleScriptString("\\\"")).toBe("\\\\\\\"");
  });

  it("keeps a hostile launcher path inside both quoting layers", () => {
    // The privileged install command interpolates the launcher path (derived
    // from the install location) into sh single-quotes inside an AppleScript
    // double-quoted string. Either layer breaking out runs attacker text as
    // root, so pin the composition, not just the helpers.
    const hostile = `/tmp/evil's"; $(touch /tmp/pwned); \`id\` \\`;
    const command = `mkdir -p ${quoteShellArg("/usr/local/bin")} && ln -sf ${quoteShellArg(hostile)} ${quoteShellArg("/usr/local/bin/termina")}`;
    const script = `do shell script "${quoteAppleScriptString(command)}" with administrator privileges`;
    const inner = script.slice(
      'do shell script "'.length,
      script.lastIndexOf('" with administrator privileges'),
    );
    // AppleScript layer: every double-quote and backslash inside the string
    // must be escaped (no string breakout).
    expect(inner.replace(/\\(.)/g, "")).not.toContain('"');
    expect(inner.replace(/\\(.)/g, "")).not.toContain("\\");
    // Unescaping the AppleScript string must reproduce the command verbatim.
    expect(inner.replace(/\\(.)/g, "$1")).toBe(command);
    // Shell layer: the hostile path sits inside one single-quoted word.
    expect(command).toContain(`'${hostile.replace(/'/g, `'\\''`)}'`);
  });

  it("routes privileged osascript commands through the quoting helpers", () => {
    const source = readFileSync("electron/cli-install.ts", "utf8");
    expect(source).toMatch(/quoteShellArg\(source\)/);
    expect(source).toMatch(/quoteAppleScriptString\(command\)/);
    expect(source).not.toMatch(/ln -sf '\$\{source\}'/);
  });
});
