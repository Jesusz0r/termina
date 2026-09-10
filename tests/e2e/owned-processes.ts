import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { readSystemProcessIdentity } from "../../shared/process-identity.js";

function checkedIdentity(pid: number): string | null {
  const identity = readSystemProcessIdentity(pid);
  if (identity) return identity;
  try { process.kill(pid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return null;
    throw error;
  }
  throw new Error(`cannot revalidate live test descendant ${pid}; retaining test files`);
}

function currentParent(pid: number): number | null {
  try {
    return Number(execFileSync("ps", ["-p", String(pid), "-o", "ppid="], {
      encoding: "utf8", timeout: 1_000, maxBuffer: 1024,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"],
    }).trim());
  } catch (error) {
    if ((error as { status?: number }).status === 1 && checkedIdentity(pid) === null) return null;
    throw error;
  }
}

/** Descendants of one launched test Electron, never a process-name search.
 * Keep birth identities before main exits and the PTY children are reparented. */
export class OwnedProcessTree {
  private readonly identities = new Map<number, string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private scanError: unknown = null;
  private shutdown: Promise<void> | null = null;

  constructor(private readonly rootPid: number) {
    const identity = readSystemProcessIdentity(rootPid);
    if (!identity) throw new Error(`cannot identify test Electron process ${rootPid}`);
    this.identities.set(rootPid, identity);
    this.capture();
    this.timer = setInterval(() => {
      try { this.capture(); } catch (error) { this.scanError = error; }
    }, 250);
    this.timer.unref();
  }

  capture(): void {
    const text = execFileSync("ps", ["-axo", "pid=,ppid="], {
      encoding: "utf8", timeout: 2_000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    });
    const children = new Map<number, number[]>();
    for (const line of text.trim().split("\n")) {
      const [pid, parent] = line.trim().split(/\s+/).map(Number);
      if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parent) || pid! <= 0) continue;
      const siblings = children.get(parent!) ?? [];
      siblings.push(pid!);
      children.set(parent!, siblings);
    }
    const queue = [...this.identities.keys()];
    const visited = new Set<number>();
    for (let index = 0; index < queue.length; index++) {
      const pid = queue[index]!;
      if (visited.has(pid)) continue;
      visited.add(pid);
      if (!this.stillOwned(pid)) continue;
      for (const child of children.get(pid) ?? []) {
        if (!this.identities.has(child)) {
          const identity = checkedIdentity(child);
          // Short-lived helpers can exit between the census and this read.
          if (!identity) continue;
          if (currentParent(child) !== pid || !this.stillOwned(pid) || checkedIdentity(child) !== identity) continue;
          this.identities.set(child, identity);
        }
        queue.push(child);
      }
    }
  }

  private stillOwned(pid: number): boolean {
    const expected = this.identities.get(pid);
    if (!expected) return false;
    const current = checkedIdentity(pid);
    if (current === expected) return true;
    // A reused PID is not ours, even if it has the same executable name.
    this.identities.delete(pid);
    return false;
  }

  private descendants(): number[] {
    return [...this.identities.keys()].filter((pid) => pid !== this.rootPid && this.stillOwned(pid));
  }

  private signal(pid: number, signal: NodeJS.Signals): void {
    if (!this.stillOwned(pid)) return;
    try { process.kill(pid, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  stop(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    clearInterval(this.timer);
    this.shutdown = (async () => {
      this.capture();
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        for (const pid of this.descendants()) this.signal(pid, signal);
        const deadline = Date.now() + (signal === "SIGTERM" ? 1_000 : 3_000);
        while (this.descendants().length > 0 && Date.now() < deadline) await delay(25);
      }
      const remaining = this.descendants();
      if (remaining.length) throw new Error(`test descendants did not exit: ${remaining.join(", ")}`);
      if (this.scanError) throw this.scanError;
    })();
    return this.shutdown;
  }
}
