/**
 * Current directory of another process. Shell `cd` updates the process,
 * which is the directory a restored shell tab must start in.
 */
import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";

/** `lsof -Fn` cwd line. Only the `n` record after `fcwd` is the directory. */
export function parseLsofCwd(stdout: string): string | null {
  const lines = stdout.split("\n");
  const cwdAt = lines.findIndex((line) => line === "fcwd");
  if (cwdAt < 0) return null;
  for (const line of lines.slice(cwdAt + 1)) {
    if (!line.startsWith("n") || line.length < 2) continue;
    const path = line.slice(1);
    if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path;
    return null;
  }
  return null;
}

export async function processCwd(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      return await readlink(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  if (process.platform !== "darwin") return null;
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 2000, maxBuffer: 64 * 1024 }, (err, out) => {
        if (err) reject(err);
        else resolve(out);
      });
    });
    return parseLsofCwd(stdout);
  } catch {
    return null;
  }
}
