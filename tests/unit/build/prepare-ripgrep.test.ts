import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRipgrep, ripgrepReleaseFor } from "../../../scripts/prepare-ripgrep.ts";
import { downloadVerifiedArchive } from "../../../scripts/prepare-resources.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "termina-rg-stage-"));
  roots.push(root);
  const release = ripgrepReleaseFor("linux", "x64");
  const source = join(root, release.directoryName);
  mkdirSync(source);
  writeFileSync(join(source, "rg"), "fixture binary");
  for (const name of ["COPYING", "LICENSE-MIT", "UNLICENSE"]) writeFileSync(join(source, name), "fixture license");
  const archive = join(root, "fixture.tar.gz");
  execFileSync("/usr/bin/tar", ["-czf", archive, "-C", root, release.directoryName]);
  const bytes = readFileSync(archive);
  const resourcesDir = join(root, "resources");
  return { root, resourcesDir, bytes };
}

describe("ripgrep release staging", () => {
  it("pins every supported archive and rejects unsupported targets", () => {
    for (const platform of ["darwin", "linux"]) for (const arch of ["arm64", "x64"]) {
      const release = ripgrepReleaseFor(platform, arch);
      expect(release.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(release.url).toContain("/14.1.1/ripgrep-14.1.1-");
    }
    expect(() => ripgrepReleaseFor("win32", "x64")).toThrow("unsupported");
  });
  it("stages executable and license using verified bytes and cleans the stage", async () => {
    const f = fixture();
    await prepareRipgrep({ resourcesDir: f.resourcesDir, targetPlatform: "linux", targetArch: "x64",
      downloadArchive: (options) => downloadVerifiedArchive({ ...options,
        sha256: createHash("sha256").update(f.bytes).digest("hex"),
        fetchImpl: async () => new Response(f.bytes),
      }),
    });
    expect(readFileSync(join(f.resourcesDir, "bin", "rg"), "utf8")).toBe("fixture binary");
    expect(statSync(join(f.resourcesDir, "bin", "rg")).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(f.resourcesDir, "bin", "ripgrep-COPYING"), "utf8")).toBe("fixture license");
    expect(readdirSync(f.resourcesDir)).toEqual(["bin"]);
  });
  it("fails closed on checksum mismatch, preserving the previous binary", async () => {
    const f = fixture();
    mkdirSync(join(f.resourcesDir, "bin"), { recursive: true });
    const previous = join(f.resourcesDir, "bin", "rg");
    writeFileSync(previous, "previous");
    await expect(prepareRipgrep({ resourcesDir: f.resourcesDir,
      downloadArchive: (options) => downloadVerifiedArchive({ ...options, fetchImpl: async () => new Response(f.bytes) }),
    })).rejects.toThrow("checksum mismatch");
    expect(readFileSync(previous, "utf8")).toBe("previous");
    expect(readdirSync(f.resourcesDir)).toEqual(["bin"]);
  });
  it("rejects redirected bin directories before downloading", async () => {
    const f = fixture();
    mkdirSync(f.resourcesDir);
    symlinkSync(f.root, join(f.resourcesDir, "bin"));
    let downloaded = false;
    await expect(prepareRipgrep({ resourcesDir: f.resourcesDir,
      downloadArchive: async () => { downloaded = true; },
    })).rejects.toThrow("not a real directory");
    expect(downloaded).toBe(false);
    expect(existsSync(join(f.root, "rg"))).toBe(false);
  });
});
