import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { underRoot } from "./files.ts";

/** Locate only our unpacked release resource, never a cwd- or environment-selected executable. */
export function resolveBundledRipgrep(selfUrl: string, cwdRoot: string): string | null {
  try {
    const bundleDir = dirname(fileURLToPath(selfUrl));
    const unpackedDir = dirname(bundleDir);
    if (basename(bundleDir) !== "dist-electron" || basename(unpackedDir) !== "app.asar.unpacked") return null;
    const resources = realpathSync(dirname(unpackedDir));
    const expected = join(resources, "bin", "rg");
    const binary = realpathSync(expected);
    // Reject redirected resources, including symlinks into the project or arbitrary host paths.
    if (binary !== expected) return null;
    if (underRoot(binary, realpathSync(cwdRoot))) return null;
    if (!statSync(binary).isFile()) return null;
    accessSync(binary, constants.X_OK);
    return binary;
  } catch {
    return null;
  }
}
