import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentBrowserReleaseFor, agentDesktopReleaseFor, prepareAgentBrowser, prepareAgentDesktop } from "../../../scripts/prepare-native-tools.ts";
import { downloadVerifiedArchive } from "../../../scripts/prepare-resources.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "termina-native-stage-"));
  roots.push(root);
  const source = join(root, "source");
  mkdirSync(source);
  writeFileSync(join(source, "agent-desktop"), "fixture binary");
  writeFileSync(join(source, "agent-desktop-macos-helper"), "fixture helper");
  const archive = join(root, "fixture.tar.gz");
  execFileSync("/usr/bin/tar", ["-czf", archive, "-C", source, "agent-desktop", "agent-desktop-macos-helper"]);
  const files = { archive: readFileSync(archive), license: new TextEncoder().encode("fixture license") };
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  return { root, resourcesDir: join(root, "resources"), files, sha };
}

describe("agent-desktop release staging", () => {
  it("pins both macOS archives and ships nothing elsewhere", () => {
    for (const arch of ["arm64", "x64"]) {
      const release = agentDesktopReleaseFor("darwin", arch);
      expect(release?.archive.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(release?.archive.url).toContain("/v1.0.2/agent-desktop-v1.0.2-");
      expect(release?.license.url).toContain("/v1.0.2/LICENSE");
    }
    expect(agentDesktopReleaseFor("linux", "x64")).toBeNull();
  });

  it("stages the binary, its helper, and the license from verified bytes", async () => {
    const f = fixture();
    await prepareAgentDesktop({ resourcesDir: f.resourcesDir, targetPlatform: "darwin", targetArch: "arm64",
      downloadArchive: (options) => {
        const bytes = options.url.endsWith("/LICENSE") ? f.files.license : f.files.archive;
        return downloadVerifiedArchive({ ...options, sha256: f.sha(bytes), fetchImpl: async () => new Response(bytes) });
      },
    });
    const bin = join(f.resourcesDir, "bin");
    expect(readFileSync(join(bin, "agent-desktop"), "utf8")).toBe("fixture binary");
    expect(statSync(join(bin, "agent-desktop-macos-helper")).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(bin, "agent-desktop-LICENSE"), "utf8")).toBe("fixture license");
    expect(readdirSync(f.resourcesDir)).toEqual(["bin"]);
  });

  it("fails closed on checksum mismatch, preserving the previous binary", async () => {
    const f = fixture();
    mkdirSync(join(f.resourcesDir, "bin"), { recursive: true });
    const previous = join(f.resourcesDir, "bin", "agent-desktop");
    writeFileSync(previous, "previous");
    await expect(prepareAgentDesktop({ resourcesDir: f.resourcesDir, targetPlatform: "darwin", targetArch: "arm64",
      downloadArchive: (options) => downloadVerifiedArchive({ ...options, fetchImpl: async () => new Response(f.files.archive) }),
    })).rejects.toThrow("checksum mismatch");
    expect(readFileSync(previous, "utf8")).toBe("previous");
    expect(existsSync(join(f.resourcesDir, "bin", "agent-desktop-macos-helper"))).toBe(false);
    expect(readdirSync(f.resourcesDir)).toEqual(["bin"]);
  });
});

describe("agent-browser release staging", () => {
  it("pins macOS and Linux binaries with their licenses and ships nothing on Windows", () => {
    for (const platform of ["darwin", "linux"]) for (const arch of ["arm64", "x64"]) {
      const release = agentBrowserReleaseFor(platform, arch);
      expect(release?.binary.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(release?.binary.url).toContain(`/v0.41.0/agent-browser-${platform}-${arch}`);
      expect(release?.licenses.map((license) => license.name)).toEqual([
        "agent-browser-LICENSE", "agent-browser-LICENSE-axe-core", "agent-browser-LICENSE-axe-core-THIRD-PARTY",
      ]);
    }
    expect(agentBrowserReleaseFor("win32", "x64")).toBeNull();
  });

  it("stages an executable binary and licenses, and keeps the old binary on a bad checksum", async () => {
    const f = fixture();
    const binary = new TextEncoder().encode("fixture browser");
    await prepareAgentBrowser({ resourcesDir: f.resourcesDir, targetPlatform: "linux", targetArch: "x64",
      downloadArchive: (options) => {
        const bytes = options.url.includes("/releases/") ? binary : f.files.license;
        return downloadVerifiedArchive({ ...options, sha256: f.sha(bytes), fetchImpl: async () => new Response(bytes) });
      },
    });
    const bin = join(f.resourcesDir, "bin");
    expect(statSync(join(bin, "agent-browser")).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(bin, "agent-browser-LICENSE-axe-core"), "utf8")).toBe("fixture license");
    await expect(prepareAgentBrowser({ resourcesDir: f.resourcesDir, targetPlatform: "linux", targetArch: "x64",
      downloadArchive: (options) => downloadVerifiedArchive({ ...options, fetchImpl: async () => new Response(binary) }),
    })).rejects.toThrow("checksum mismatch");
    expect(readFileSync(join(bin, "agent-browser"), "utf8")).toBe("fixture browser");
    expect(readdirSync(f.resourcesDir)).toEqual(["bin"]);
  });
});
