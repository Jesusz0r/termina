import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

export const PINNED_AGENT_DESKTOP_VERSION = "1.0.2";

// From the release's checksums.txt, checked in rather than trusted at download time:
// https://github.com/vercel-labs/agent-desktop/releases/tag/v1.0.2
const AGENT_DESKTOP_RELEASES: Record<string, readonly [string, string]> = {
  "darwin-arm64": ["aarch64-apple-darwin", "7bee385196d7b478de80cf05ca4304aaa38f0eba593b3406ad3c247c1773be19"],
  "darwin-x64": ["x86_64-apple-darwin", "8edda6df17eafc042395502a823dbb8415bc8ac14835a6731e4d8becc9cb4121"],
};
// Apache-2.0 text at the same tag; the release archives carry no license file.
const AGENT_DESKTOP_LICENSE_SHA256 = "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";

/** The desktop tool is macOS-only; other targets ship nothing. */
export function agentDesktopReleaseFor(platform: string, arch: string) {
  const release = AGENT_DESKTOP_RELEASES[`${platform}-${arch}`];
  if (!release) return null;
  const [target, sha256] = release;
  const tag = `v${PINNED_AGENT_DESKTOP_VERSION}`;
  return {
    archive: {
      sha256,
      url: `https://github.com/vercel-labs/agent-desktop/releases/download/${tag}/agent-desktop-${tag}-${target}.tar.gz`,
    },
    license: {
      sha256: AGENT_DESKTOP_LICENSE_SHA256,
      url: `https://raw.githubusercontent.com/vercel-labs/agent-desktop/${tag}/LICENSE`,
    },
  };
}

type DownloadArchive = (options: {
  url: string;
  destination: string;
  sha256: string;
  maxBytes: number;
}) => Promise<unknown>;

function requireDirectory(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`not a real directory: ${path}`);
}

/** Uses the resource preparer's bounded, checksum-verified downloader. Never runs an old binary. */
export async function prepareAgentDesktop({
  resourcesDir,
  downloadArchive,
  targetPlatform = process.platform,
  targetArch = process.arch,
}: {
  resourcesDir: string;
  downloadArchive: DownloadArchive;
  targetPlatform?: string;
  targetArch?: string;
}) {
  const release = agentDesktopReleaseFor(targetPlatform, targetArch);
  if (!release) return;
  mkdirSync(resourcesDir, { recursive: true });
  requireDirectory(resourcesDir);
  const binDir = join(resourcesDir, "bin");
  mkdirSync(binDir, { recursive: true });
  requireDirectory(binDir);
  const stage = mkdtempSync(join(resourcesDir, ".agent-desktop-stage-"));
  try {
    const archive = join(stage, "agent-desktop.tar.gz");
    await downloadArchive({ ...release.archive, destination: archive, maxBytes: 32 * 1024 * 1024 });
    const license = join(stage, "LICENSE");
    await downloadArchive({ ...release.license, destination: license, maxBytes: 64 * 1024 });
    // The helper must sit beside the binary; tar never resolves through user PATH.
    const members = ["agent-desktop", "agent-desktop-macos-helper"];
    execFileSync("/usr/bin/tar", ["-xf", archive, "-C", stage, ...members], { stdio: "pipe" });
    for (const name of members) {
      const path = join(stage, name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`invalid agent-desktop archive member: ${name}`);
      chmodSync(path, 0o755);
    }
    // Stage by atomic file replacement: failed verification/extraction preserves the prior binary.
    chmodSync(license, 0o644);
    renameSync(license, join(binDir, "agent-desktop-LICENSE"));
    renameSync(join(stage, "agent-desktop-macos-helper"), join(binDir, "agent-desktop-macos-helper"));
    renameSync(join(stage, "agent-desktop"), join(binDir, "agent-desktop"));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
