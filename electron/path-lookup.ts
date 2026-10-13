/**
 * Cached host path resolution: realpath and PATH lookup. Both caches are
 * tiny and self-clearing; misses are never cached because the filesystem
 * can change under a stable key.
 *
 * A GUI launch on macOS does not receive the login shell PATH, so external
 * CLIs installed under ~/.local/bin, Homebrew, or nvm are invisible to
 * process.env.PATH. One login-shell read fills that gap.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

const SHELL_PATH_MARKER = "__TERMINA_PATH__";

/** Absolute PATH entries from a login shell. Relative and empty entries are dropped. */
export function shellPathEntries(output: string): string[] {
  const marker = output.lastIndexOf(SHELL_PATH_MARKER);
  const raw = marker >= 0 ? output.slice(marker + SHELL_PATH_MARKER.length) : "";
  const dirs: string[] = [];
  for (const entry of raw.split(delimiter)) {
    const dir = entry.trim();
    if (!dir || !isAbsolute(dir) || dir.includes("\0") || dirs.includes(dir)) continue;
    dirs.push(dir);
  }
  return dirs;
}

let shellPathDirs: string[] | null = null;
let shellPathTask: Promise<string[]> | null = null;

function loginShell(): string | null {
  if (process.platform === "win32") return null;
  const configured = process.env.SHELL?.trim();
  if (configured && isAbsolute(configured) && !configured.includes("\0") && existsSync(configured)) return configured;
  return existsSync("/bin/zsh") ? "/bin/zsh" : existsSync("/bin/bash") ? "/bin/bash" : null;
}

function readLoginShellPath(): Promise<string[]> {
  const shell = loginShell();
  if (!shell) return Promise.resolve([]);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (dirs: string[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(dirs);
    };
    const child = spawn(shell, ["-lic", "printf '%s%s' __TERMINA_PATH__ \"$PATH\""], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      finish([]);
    }, 8000);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 64 * 1024) child.kill();
    });
    child.on("error", () => finish([]));
    child.on("close", () => finish(shellPathEntries(stdout)));
  });
}

/** Directories from the user's login shell. The first call is shared; later calls reuse it. */
export function userShellPathDirs(): Promise<readonly string[]> {
  if (shellPathDirs) return Promise.resolve(shellPathDirs);
  shellPathTask ??= readLoginShellPath().then((dirs) => {
    shellPathDirs = dirs;
    return dirs;
  });
  return shellPathTask;
}

/** Replace the cached shell PATH. Tests use this so they do not spawn a login shell. */
export function useShellPathDirs(dirs: readonly string[] | null): void {
  shellPathDirs = dirs ? [...dirs] : null;
  shellPathTask = shellPathDirs ? Promise.resolve(shellPathDirs) : null;
}

function cachedShellPathDirs(): readonly string[] {
  return shellPathDirs ?? [];
}

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
    const found = this.findNamed(name, pathEnv.split(delimiter));
    // Cache hits only: a miss may resolve later (new install under the same
    // PATH) and must fall through to process.execPath fresh each time.
    if (found !== null) {
      if (this.findOnPathCache.size >= 16) this.findOnPathCache.clear();
      this.findOnPathCache.set(key, found);
    }
    return found;
  }

  /** Process PATH, then the login-shell PATH loaded by {@link warmHostPath}. */
  findOnHostPath(name: string): string | null {
    return this.findOnPath(name) ?? this.findNamed(name, cachedShellPathDirs());
  }

  /** Load the login-shell PATH once so {@link findOnHostPath} can see user installs. */
  warmHostPath(): Promise<readonly string[]> {
    return userShellPathDirs();
  }

  /** PATH string for a child that must resolve the same tools as the user's shell. */
  hostPathEnv(): string {
    const dirs = cachedShellPathDirs();
    return dirs.length > 0 ? dirs.join(delimiter) : process.env.PATH ?? "";
  }

  private findNamed(name: string, dirs: readonly string[]): string | null {
    if (!name || name.includes("/") || name.includes("\0")) return null;
    for (const dir of dirs) {
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
