import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { platform } from "node:os";

/** Return a stable process-birth identity, or null when the OS cannot prove it. */
export function readSystemProcessIdentity(pid) {
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
      const started = execFileSync(
        "/bin/ps",
        ["-o", "lstart=", "-p", String(pid)],
        {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
          maxBuffer: 1024,
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 1_000,
        },
      ).trim().replace(/\s+/g, " ");
      return started ? `darwin:${started}` : null;
    } catch {
      return null;
    }
  }

  return null;
}
