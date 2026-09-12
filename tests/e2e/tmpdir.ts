import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** True when `abs` is `root` or a path inside it. */
export function pathIsInside(root: string, abs: string): boolean {
  const rel = relative(resolve(root), resolve(abs));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function defaultTempCandidates(): string[] {
  const candidates: string[] = [tmpdir()];
  if (process.platform === "win32") {
    if (process.env.SystemRoot) candidates.push(join(process.env.SystemRoot, "Temp"));
  } else {
    candidates.push("/tmp", "/var/tmp");
  }
  return candidates;
}

/**
 * Temp directory for e2e run roots and Playwright caches.
 *
 * If TMPDIR points at the repo, Electron user-data and Playwright
 * transform caches land in the workspace. The snapshot core then
 * captures Chromium files that are replaced while open.
 */
export function e2eTempDir(repo = resolve("."), candidates?: readonly string[]): string {
  const list = candidates && candidates.length > 0 ? candidates : defaultTempCandidates();
  for (const candidate of list) {
    if (!candidate) continue;
    const abs = resolve(candidate);
    if (!pathIsInside(repo, abs)) return abs;
  }
  return process.platform === "win32" ? tmpdir() : "/tmp";
}
