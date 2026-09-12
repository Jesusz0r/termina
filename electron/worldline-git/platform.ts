/**
 * Platform capabilities and disk space.
 *
 * Owns platform feature probes and free-space reads. Split from
 * electron/worldline-git.ts (issue #38).
 */
import { SANDBOX_EXEC } from "../sandbox.js";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";


/** Pair-creation disk reserve for Worldline candidates. */
export const MIN_WORLDS_FREE_BYTES = 512 * 1024 * 1024;


/** Free disk bytes on the volume that holds `path`. Returns null on error. */
export async function freeDiskBytes(path: string): Promise<number | null> {
  try {
    const out = await new Promise<string>((res) => {
      execFile("df", ["-k", path], { encoding: "utf8", maxBuffer: 1024 * 1024 }, (_err, stdout) => res(stdout));
    });
    const lines = out.trim().split("\n");
    const header = lines[0]?.split(/\s+/) ?? [];
    // macOS says "Available"; Linux says "Avail".
    const availIdx = header.findIndex((h) => h.startsWith("Avail"));
    const row = lines[1]?.split(/\s+/) ?? [];
    const avail = Number(row[availIdx]);
    return Number.isFinite(avail) ? avail * 1024 : null;
  } catch {
    return null;
  }
}


/** True when the platform provides a reliable recursive watcher. */
export function platformHasRecursiveWatcher(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}


/** True when the platform binary `sandbox-exec` exists (macOS). */
export function platformHasSandboxExec(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    readFileSync(SANDBOX_EXEC);
    return true;
  } catch {
    return false;
  }
}


/** True when the platform provides copy-on-write clones (`cp -c`). */
export function platformHasCopyOnWrite(): boolean {
  return process.platform === "darwin";
}
