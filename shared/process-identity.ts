import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { platform } from "node:os";

/** Return a stable process-birth identity, or null when the OS cannot prove it. */
export function readSystemProcessIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;

  if (platform() === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(") ");
      if (commandEnd < 0) return null;
      const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/);
      const startTicks = fieldsAfterCommand[19];
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (!/^\d+$/.test(startTicks) || !/^[a-f0-9-]{36}$/.test(bootId)) return null;
      return `linux:${bootId}:${startTicks}`;
    } catch {
      return null;
    }
  }

  if (platform() === "darwin") {
    try {
      const started = darwinStart(pid);
      return started ? `darwin:${started}` : null;
    } catch {
      return null;
    }
  }

  return null;
}

/** A slow `ps` is not a missing process. Retry only a timeout. */
function darwinStart(pid: number): string {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return execFileSync(
        "/bin/ps",
        ["-o", "lstart=", "-p", String(pid)],
        {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
          maxBuffer: 1024,
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 3_000,
        },
      ).trim().replace(/\s+/g, " ");
    } catch (error) {
      last = error;
      if ((error as NodeJS.ErrnoException).code !== "ETIMEDOUT" || attempt === 2) throw error;
    }
  }
  throw last;
}
