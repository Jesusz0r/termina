/**
 * Manages installing the 'termina' command-line launcher into the user's PATH.
 *
 * Links /usr/local/bin/termina -> <app>/Contents/Resources/bin/termina.
 * Uses native macOS administrator authorization (osascript) when write
 * access to /usr/local/bin requires elevated privileges.
 */
import { app } from "electron";
import { existsSync, lstatSync, readlinkSync, symlinkSync, unlinkSync, mkdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const CLI_TARGET_DIR = "/usr/local/bin";
const CLI_TARGET_PATH = join(CLI_TARGET_DIR, "termina");

export function getCliSourcePath(): string {
  if (app?.isPackaged && typeof process.resourcesPath === "string") {
    return join(process.resourcesPath, "bin", "termina");
  }
  const appPath = typeof app?.getAppPath === "function" ? app.getAppPath() : process.cwd();
  const binSource = join(appPath, "bin", "termina");
  if (existsSync(binSource)) return binSource;
  return join(appPath, "resources", "bin", "termina");
}

/**
 * Parse a folder or file argument passed via CLI (e.g. `termina .` or `termina /path/to/folder`).
 * Ignores Electron switches and macOS process flags (e.g. -psn_..., --args).
 */
export function parseTargetCwdFromArgv(
  argv: string[],
  fallbackCwd = process.cwd(),
  isPackaged = Boolean(app?.isPackaged),
): string | null {
  const args = argv.slice(isPackaged ? 1 : 2).filter((arg) => !arg.startsWith("-"));
  for (const candidate of args) {
    try {
      const target = resolve(fallbackCwd, candidate);
      if (existsSync(target)) {
        const stat = statSync(target);
        if (stat.isDirectory()) return target;
        if (stat.isFile()) return dirname(target);
      }
    } catch {
      // Skip unresolvable paths
    }
  }
  return null;
}

export function isCliCommandInstalled(): boolean {
  try {
    const stat = lstatSync(CLI_TARGET_PATH);
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(CLI_TARGET_PATH);
      const expected = getCliSourcePath();
      return link === expected || link.endsWith("/bin/termina");
    }
    return true;
  } catch {
    return false;
  }
}

export function installCliCommand(): { ok: boolean; path?: string; error?: string } {
  const source = getCliSourcePath();
  if (!existsSync(source)) {
    return { ok: false, error: `CLI launcher not found at ${source}` };
  }

  // Attempt direct unprivileged symlink first (/usr/local/bin owned by user or Homebrew)
  try {
    mkdirSync(CLI_TARGET_DIR, { recursive: true });
    try {
      unlinkSync(CLI_TARGET_PATH);
    } catch {
      // Ignored if file didn't exist
    }
    symlinkSync(source, CLI_TARGET_PATH);
    return { ok: true, path: CLI_TARGET_PATH };
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code !== "EACCES" && code !== "EPERM") {
      return { ok: false, error: (err as Error).message };
    }
  }

  // Elevate via native OS dialog
  if (process.platform === "darwin") {
    try {
      const command = `mkdir -p '${CLI_TARGET_DIR}' && ln -sf '${source}' '${CLI_TARGET_PATH}'`;
      execFileSync("osascript", ["-e", `do shell script "${command}" with administrator privileges`]);
      return { ok: true, path: CLI_TARGET_PATH };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("User canceled") || msg.includes("-128")) {
        return { ok: false, error: "Installation was canceled." };
      }
      return { ok: false, error: msg };
    }
  }

  return { ok: false, error: `Permission denied writing to ${CLI_TARGET_PATH}. Run: sudo ln -sf "${source}" "${CLI_TARGET_PATH}"` };
}

export function uninstallCliCommand(): { ok: boolean; error?: string } {
  try {
    lstatSync(CLI_TARGET_PATH);
  } catch {
    return { ok: true };
  }

  try {
    unlinkSync(CLI_TARGET_PATH);
    return { ok: true };
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code !== "EACCES" && code !== "EPERM") {
      return { ok: false, error: (err as Error).message };
    }
  }

  if (process.platform === "darwin") {
    try {
      const command = `rm -f '${CLI_TARGET_PATH}'`;
      execFileSync("osascript", ["-e", `do shell script "${command}" with administrator privileges`]);
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("User canceled") || msg.includes("-128")) {
        return { ok: false, error: "Removal was canceled." };
      }
      return { ok: false, error: msg };
    }
  }

  return { ok: false, error: `Permission denied removing ${CLI_TARGET_PATH}. Run: sudo rm -f "${CLI_TARGET_PATH}"` };
}
