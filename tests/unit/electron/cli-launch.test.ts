import { describe, it, expect, afterEach } from "vitest";
import { resolve, join, dirname } from "node:path";
import { statSync, existsSync, readFileSync, mkdtempSync, mkdirSync, copyFileSync, chmodSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
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

describe("Linux launcher target resolution (#129)", () => {
  const repoRoot = resolve(__dirname, "../../..");
  const launcherSource = resolve(repoRoot, "bin/termina");
  // Every launch below is a bounded owned fixture: the timeout turns any
  // self-exec regression into a fast failure instead of a hung suite.
  const LAUNCH_TIMEOUT_MS = 15_000;
  const fixtures: string[] = [];
  afterEach(() => {
    while (fixtures.length > 0) rmSync(fixtures.pop()!, { recursive: true, force: true });
  });

  /** Owned fixture: a `bin/termina` launcher copy plus a marker executable. */
  function makeFixture(): { root: string; launcher: string; markerBin: string; marker: string } {
    const root = mkdtempSync(join(tmpdir(), "termina-cli-launch-"));
    fixtures.push(root);
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "app"), { recursive: true });
    const launcher = join(root, "bin", "termina");
    copyFileSync(launcherSource, launcher);
    chmodSync(launcher, 0o755);
    const marker = join(root, "marker");
    const markerBin = join(root, "app", "real");
    writeFileSync(markerBin, `#!/bin/sh\necho "launched: $@" >> "${marker}"\n`);
    chmodSync(markerBin, 0o755);
    return { root, launcher, markerBin, marker };
  }

  function linuxEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, OSTYPE: "linux-gnu", ...extra };
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete env[key];
    }
    return env;
  }

  function launchFails(file: string, args: string[], env: NodeJS.ProcessEnv): { status: number | null; stderr: string } {
    try {
      execFileSync(file, args, { encoding: "utf8", env, timeout: LAUNCH_TIMEOUT_MS });
      throw new Error("expected the launcher to fail");
    } catch (error) {
      if (error instanceof Error && error.message === "expected the launcher to fail") throw error;
      const execError = error as { status?: number | null; stderr?: string };
      return { status: execError.status ?? null, stderr: String(execError.stderr ?? "") };
    }
  }

  it("honors TERMINA_BIN first with the launcher first in PATH (no-arg)", () => {
    const { launcher, markerBin, marker } = makeFixture();
    const binDir = dirname(launcher);
    execFileSync("termina", [], {
      encoding: "utf8",
      env: linuxEnv({ PATH: `${binDir}:${process.env.PATH ?? ""}`, TERMINA_BIN: markerBin }),
      timeout: LAUNCH_TIMEOUT_MS,
    });
    expect(readFileSync(marker, "utf8")).toBe("launched: \n");
  });

  it("normalizes a path argument before execing TERMINA_BIN", () => {
    const { root, launcher, markerBin, marker } = makeFixture();
    execFileSync(launcher, ["."], {
      encoding: "utf8",
      cwd: root,
      env: linuxEnv({ PATH: `${dirname(launcher)}:${process.env.PATH ?? ""}`, TERMINA_BIN: markerBin }),
      timeout: LAUNCH_TIMEOUT_MS,
    });
    expect(readFileSync(marker, "utf8")).toBe(`launched: ${root}\n`);
  });

  it("rejects self-resolution without looping", () => {
    const { launcher } = makeFixture();
    const binDir = dirname(launcher);
    const failed = launchFails("termina", [], linuxEnv({ PATH: `${binDir}:/usr/bin:/bin`, TERMINA_BIN: undefined }));
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("TERMINA_BIN");
  });

  it("rejects symlink self-resolution without looping", () => {
    const { root, launcher } = makeFixture();
    const linkDir = join(root, "link");
    mkdirSync(linkDir, { recursive: true });
    const link = join(linkDir, "termina");
    symlinkSync(launcher, link);
    const failed = launchFails(link, ["."], {
      ...linuxEnv({ PATH: `${linkDir}:/usr/bin:/bin`, TERMINA_BIN: undefined }),
    });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("TERMINA_BIN");
  });

  it("fails clearly for missing and invalid executables", () => {
    const { root, launcher } = makeFixture();
    const binDir = dirname(launcher);
    const emptyDir = join(root, "empty");
    // Nothing named termina on PATH and no TERMINA_BIN.
    const missing = launchFails(launcher, [], linuxEnv({ PATH: `${emptyDir}:/usr/bin:/bin`, TERMINA_BIN: undefined }));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("TERMINA_BIN");
    // An invalid TERMINA_BIN (a directory) cannot loop either.
    const invalid = launchFails("termina", [], linuxEnv({ PATH: `${binDir}:/usr/bin:/bin`, TERMINA_BIN: root }));
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("TERMINA_BIN");
  });

  it("still discovers a distinct PATH binary and prefers explicit TERMINA_BIN", () => {
    const { root, launcher, markerBin, marker } = makeFixture();
    const otherDir = join(root, "other");
    mkdirSync(otherDir, { recursive: true });
    const otherBin = join(otherDir, "termina");
    const otherMarker = join(root, "other-marker");
    writeFileSync(otherBin, `#!/bin/sh\necho "other: $@" >> "${otherMarker}"\n`);
    chmodSync(otherBin, 0o755);
    // PATH discovery of a real (non-launcher) binary keeps working.
    execFileSync(launcher, ["sub/dir"], {
      encoding: "utf8",
      cwd: root,
      env: linuxEnv({ PATH: `${otherDir}:/usr/bin:/bin`, TERMINA_BIN: undefined }),
      timeout: LAUNCH_TIMEOUT_MS,
    });
    expect(readFileSync(otherMarker, "utf8")).toBe(`other: ${join(root, "sub", "dir")}\n`);
    // An explicit TERMINA_BIN wins over PATH discovery.
    execFileSync(launcher, [], {
      encoding: "utf8",
      env: linuxEnv({ PATH: `${otherDir}:${dirname(launcher)}:/usr/bin:/bin`, TERMINA_BIN: markerBin }),
      timeout: LAUNCH_TIMEOUT_MS,
    });
    expect(readFileSync(marker, "utf8")).toBe("launched: \n");
  });
});
