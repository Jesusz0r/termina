/**
 * String-form macOS system aliases that match main's realpath for /tmp and
 * /var (`/tmp` → `/private/tmp`, `/var` → `/private/var`). Not a filesystem
 * realpath — the renderer cannot do privileged fs.
 *
 * Already-canonical paths and every other platform are a no-op. One owner
 * for renderer keys (editor tabs, explorer dir maps) so they agree with the
 * canonical paths main already pushes.
 */

const MACOS_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["/tmp", "/private/tmp"],
  ["/var", "/private/var"],
];

/** Resolve the host platform without importing node:os (renderer-safe). */
function detectHostPlatform(): string {
  if (typeof process !== "undefined" && typeof process.platform === "string") {
    return process.platform;
  }
  if (typeof navigator !== "undefined" && typeof navigator.platform === "string") {
    return navigator.platform.toUpperCase().includes("MAC") ? "darwin" : navigator.platform;
  }
  return "";
}

/** Rewrite a path to the form main's realpath produces for macOS aliases. */
export function canonicalizePath(path: string, platform: string = detectHostPlatform()): string {
  if (platform !== "darwin") return path;
  for (const [from, to] of MACOS_ALIASES) {
    if (path === from) return to;
    if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
  }
  return path;
}
