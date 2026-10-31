/**
 * Process boundary for the native agent CLIs (`agent-desktop`, `agent-browser`):
 * an allowlisted child environment and one bounded, interruptible spawn.
 * Request parsing, approval policy, and output formatting stay with each tool.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { killProcessTree } from "./bash.ts";
import { trustedPath } from "./env.ts";

const NATIVE_CLI_STDERR_BYTES = 16 * 1024;
const NATIVE_CLI_REAP_MS = 2_000;
const NATIVE_CLI_STOP_POLL_MS = 100;

/** Only these host variables reach the child; no PI_*, provider keys, or tool config. */
const NATIVE_CLI_ENV_KEYS = [
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "USER",
  "LOGNAME",
  "SHELL",
] as const;

export type NativeCliResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  interrupted: boolean;
  outputOverflow: boolean;
  spawnError: string | null;
};

/** Allowlisted host environment plus the tool's own settings, which win. */
export function nativeCliEnv(cwd: string, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { PATH: trustedPath(process.env.PATH, cwd) };
  for (const key of NATIVE_CLI_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined && !value.includes("\0")) env[key] = value;
  }
  return { ...env, ...extra };
}

/** Spawn without a shell, in its own process group; timeout, overflow, interrupt, and parent exit kill the tree. */
export function runNativeCli(
  binary: string,
  argv: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    maxStdoutBytes: number;
    shouldStop?: () => boolean;
  },
): Promise<NativeCliResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, argv, {
        cwd: opts.cwd,
        detached: true,
        env: opts.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        stdout: "",
        stderr: "",
        code: null,
        signal: null,
        timedOut: false,
        interrupted: false,
        outputOverflow: false,
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputOverflow = false;
    let timedOut = false;
    let interrupted = false;
    let settled = false;
    let closeStatus: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let reapTimer: ReturnType<typeof setTimeout> | null = null;

    const stopOnParentExit = (): void => killProcessTree(child.pid, child);
    process.once("exit", stopOnParentExit);

    const finish = (spawnError: string | null = null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearInterval(stopPoll);
      if (reapTimer) clearTimeout(reapTimer);
      process.off("exit", stopOnParentExit);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        code: closeStatus?.code ?? null,
        signal: closeStatus?.signal ?? null,
        timedOut,
        interrupted,
        outputOverflow,
        spawnError,
      });
    };

    const reap = (): void => {
      if (reapTimer) return;
      killProcessTree(child.pid, child);
      reapTimer = setTimeout(() => finish(), NATIVE_CLI_REAP_MS);
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      reap();
    }, Math.max(1, opts.timeoutMs));
    const stopPoll = setInterval(() => {
      let stop = false;
      try {
        stop = opts.shouldStop?.() === true;
      } catch {
        stop = true;
      }
      if (!stop) return;
      interrupted = true;
      reap();
    }, NATIVE_CLI_STOP_POLL_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (outputOverflow) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > opts.maxStdoutBytes) {
        outputOverflow = true;
        reap();
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= NATIVE_CLI_STDERR_BYTES) return;
      const kept = chunk.subarray(0, NATIVE_CLI_STDERR_BYTES - stderrBytes);
      stderrBytes += kept.byteLength;
      stderrChunks.push(kept);
    });
    child.on("error", (error) => finish(error.message));
    child.on("close", (code, signal) => {
      closeStatus = { code, signal };
      finish();
    });
  });
}
