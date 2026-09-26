import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

export const PINNED_RIPGREP_VERSION = "14.1.1";

// Official release .tar.gz.sha256 files, checked in rather than trusted at download time:
// https://github.com/BurntSushi/ripgrep/releases/tag/14.1.1
const RELEASES: Record<string, readonly [string, string]> = {
  "darwin-arm64": ["aarch64-apple-darwin", "24ad76777745fbff131c8fbc466742b011f925bfa4fffa2ded6def23b5b937be"],
  "darwin-x64": ["x86_64-apple-darwin", "fc87e78f7cb3fea12d69072e7ef3b21509754717b746368fd40d88963630e2b3"],
  "linux-arm64": ["aarch64-unknown-linux-gnu", "c827481c4ff4ea10c9dc7a4022c8de5db34a5737cb74484d62eb94a95841ab2f"],
  "linux-x64": ["x86_64-unknown-linux-musl", "4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e"],
};

export function ripgrepReleaseFor(platform: string, arch: string) {
  const release = RELEASES[`${platform}-${arch}`];
  if (!release) throw new Error(`unsupported ripgrep platform: ${platform}-${arch}`);
  const [target, sha256] = release;
  const directoryName = `ripgrep-${PINNED_RIPGREP_VERSION}-${target}`;
  return {
    directoryName,
    sha256,
    url: `https://github.com/BurntSushi/ripgrep/releases/download/${PINNED_RIPGREP_VERSION}/${directoryName}.tar.gz`,
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
export async function prepareRipgrep({
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
  const release = ripgrepReleaseFor(targetPlatform, targetArch);
  mkdirSync(resourcesDir, { recursive: true });
  requireDirectory(resourcesDir);
  const binDir = join(resourcesDir, "bin");
  mkdirSync(binDir, { recursive: true });
  requireDirectory(binDir);
  const stage = mkdtempSync(join(resourcesDir, ".ripgrep-stage-"));
  try {
    const archive = join(stage, "ripgrep.tar.gz");
    await downloadArchive({ ...release, destination: archive, maxBytes: 32 * 1024 * 1024 });
    // Extract only the binary and its license; tar never resolves through user PATH.
    const members = ["rg", "COPYING", "LICENSE-MIT", "UNLICENSE"];
    execFileSync("/usr/bin/tar", ["-xf", archive, "-C", stage,
      ...members.map((name) => `${release.directoryName}/${name}`)], { stdio: "pipe" });
    const extracted = join(stage, release.directoryName);
    requireDirectory(extracted);
    for (const name of members) {
      const stat = lstatSync(join(extracted, name));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`invalid ripgrep archive member: ${name}`);
    }
    const binary = join(extracted, "rg");
    chmodSync(binary, 0o755);
    // Stage by atomic file replacement: failed verification/extraction preserves the prior binary.
    for (const name of members.slice(1)) renameSync(join(extracted, name), join(binDir, `ripgrep-${name}`));
    renameSync(binary, join(binDir, "rg"));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
