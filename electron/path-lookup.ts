/**
 * Cached host path resolution: realpath and PATH lookup. Both caches are
 * tiny and self-clearing; misses are never cached because the filesystem
 * can change under a stable key.
 */
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";

export class PathLookup {
  private realpathCache = new Map<string, string>();
  private findOnPathCache = new Map<string, string | null>();

  /** Sync realpath with a tiny cache. appReadPaths runs per candidate
   * launch; the binary paths it resolves change only when PATH does. */
  cachedRealpath(input: string): string {
    const hit = this.realpathCache.get(input);
    if (hit !== undefined) return hit;
    const resolved = realpathSync(input);
    if (this.realpathCache.size >= 16) this.realpathCache.clear();
    this.realpathCache.set(input, resolved);
    return resolved;
  }

  findOnPath(name: string): string | null {
    const pathEnv = process.env.PATH ?? "";
    const key = `${pathEnv}\0${name}`;
    const hit = this.findOnPathCache.get(key);
    if (hit !== undefined) return hit;
    const found = this.findOnPathUncached(name, pathEnv);
    // Cache hits only: a miss may resolve later (new install under the same
    // PATH) and must fall through to process.execPath fresh each time.
    if (found !== null) {
      if (this.findOnPathCache.size >= 16) this.findOnPathCache.clear();
      this.findOnPathCache.set(key, found);
    }
    return found;
  }

  private findOnPathUncached(name: string, pathEnv: string): string | null {
    for (const dir of pathEnv.split(delimiter)) {
      if (!dir) continue;
      try {
        const candidate = join(dir, name);
        if (existsSync(candidate)) {
          accessSync(candidate, constants.X_OK);
          return candidate;
        }
      } catch {
        /* keep scanning */
      }
    }
    return null;
  }
}
