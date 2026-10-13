import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PathLookup, shellPathEntries, useShellPathDirs } from "../../../electron/path-lookup.ts";

describe("shell PATH lookup", () => {
  const previous = process.env.PATH;

  afterEach(() => {
    process.env.PATH = previous;
    useShellPathDirs(null);
  });

  it("keeps absolute login-shell directories and drops banners and relative entries", () => {
    expect(shellPathEntries("welcome\n__TERMINA_PATH__/usr/bin:./relative:/opt/homebrew/bin:")).toEqual([
      "/usr/bin",
      "/opt/homebrew/bin",
    ]);
    expect(shellPathEntries("no marker")).toEqual([]);
  });

  it("finds an executable that is not on the process PATH once the shell directories are known", () => {
    const dir = mkdtempSync(join(tmpdir(), "termina-path-"));
    const bin = join(dir, "claude");
    writeFileSync(bin, "");
    chmodSync(bin, 0o755);
    process.env.PATH = "/usr/bin:/bin";
    const paths = new PathLookup();
    expect(paths.findOnPath("claude")).toBeNull();
    useShellPathDirs([dir]);
    expect(paths.findOnHostPath("claude")).toBe(bin);
    expect(paths.hostPathEnv().split(delimiter)).toContain(dir);
  });
});
