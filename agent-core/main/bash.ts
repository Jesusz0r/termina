/**
 * Interruptible bash: spawn one command, own the process group until it
 * exits or is killed. `&` is still bash, not fire-and-forget.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { isErrno } from "../../shared/guards.ts";
import {
  BoundedTextAccumulator,
  boundedToolResult,
  logicalToolText,
  type CompletionState,
  type ToolTextResult,
} from "../tool-output.ts";
import { trustedPath } from "./env.ts";
import { shellQuote } from "./files.ts";

export const BASH_CAP_BYTES = 20 * 1024;
/** Same wall budget as host Verify (`electron/main.ts` 600s). */
export const BASH_TIMEOUT_MS = 10 * 60 * 1000;
/** After SIGKILL, wait this long for the process group to disappear. */
const BASH_GROUP_REAP_MS = 2_000;

/** Hold the shell until its own jobs finish, including Git Bash on Windows. */
export function bashInvocation(command: string): string {
  return `trap -- wait EXIT\n${command}`;
}

export function bashProcessGroupAlive(pid: number | undefined): boolean {
  if (process.platform === "win32" || typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return !isErrno(err, "ESRCH");
  }
}

function killBashTree(pid: number | undefined, child: ChildProcess): void {
  if (typeof pid !== "number" || pid <= 0) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    return;
  }
  if (process.platform === "win32") {
    const killed = spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 5_000,
    });
    if (killed.error || (killed.status !== 0 && killed.status !== null)) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
    return;
  } catch {
    /* fall through to the child handle */
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

export function runBash(
  command: string,
  opts: { cwd: string; timeoutMs?: number; shouldStop?: () => boolean },
): Promise<ToolTextResult> {
  const timeoutMs = opts.timeoutMs ?? BASH_TIMEOUT_MS;
  const repro = `bash ${shellQuote(command)}`;
  const continuation = `Re-run the command with a narrower output or redirect noisy streams: ${repro}`;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) env[key] = value;
      }
      env.PATH = trustedPath(process.env.PATH, opts.cwd);
      child = spawn("/bin/bash", ["-c", bashInvocation(command)], {
        cwd: opts.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
    } catch (err) {
      resolve(logicalToolText(`error: ${(err as Error).message}`, {
        maxBytes: BASH_CAP_BYTES,
        state: "failed",
        isError: true,
        repro,
      }));
      return;
    }
    const pid = child.pid;
    const stdout = new BoundedTextAccumulator({ maxBytes: BASH_CAP_BYTES, direction: "tail", marker: "" });
    const stderr = new BoundedTextAccumulator({ maxBytes: BASH_CAP_BYTES, direction: "tail", marker: "" });
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    let settled = false;
    let timedOut = false;
    let interruptedByUser = false;
    let stopCallbackFailed = false;
    let spawnFailed = false;
    let closeStatus: { code?: number | null; signal?: string | null; failed: boolean } | null = null;
    let reapDeadline: number | null = null;
    const shouldStop = (): boolean => {
      try {
        return opts.shouldStop?.() === true;
      } catch {
        stopCallbackFailed = true;
        return true;
      }
    };
    const finish = (status: { code?: number | null; signal?: string | null; failed: boolean }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      const state: CompletionState = timedOut
        ? "timeout"
        : stopCallbackFailed
          ? "failed"
          : interruptedByUser
            ? "interrupted"
            : spawnFailed
              ? "failed"
              : status.failed
                ? "failed"
                : "complete";
      const stdoutResult = stdout.finish(state);
      const stderrResult = stderr.finish(state);
      const parts = [stdoutResult.text, stderrResult.text];
      const tag = typeof status.code === "number" ? String(status.code) : status.signal ?? "error";
      let body = `${parts.filter(Boolean).join("\n") || "(no output)"}\n[exit ${tag}]`;
      const outputTruncated = stdoutResult.truncated || stderrResult.truncated;
      if (outputTruncated || state !== "complete") body += `\n${continuation}`;
      const rendered = boundedToolResult(body, {
        maxBytes: BASH_CAP_BYTES,
        direction: "tail",
        marker: "",
        state,
        isError: state !== "complete" || status.failed,
      });
      resolve(Object.freeze({
        ...rendered,
        truncated: rendered.truncated || outputTruncated,
        continuation: outputTruncated || state !== "complete" ? continuation : null,
        repro,
        stdout: stdoutResult,
        stderr: stderrResult,
        exitCode: typeof status.code === "number" ? status.code : null,
        signal: status.signal ?? null,
      }));
    };
    const requestReap = (): void => {
      if (reapDeadline == null) reapDeadline = Date.now() + BASH_GROUP_REAP_MS;
      killBashTree(pid, child);
    };
    const resolveIfReady = (): void => {
      if (settled || closeStatus == null) return;
      const groupAlive = bashProcessGroupAlive(pid);
      if (groupAlive && (timedOut || interruptedByUser || stopCallbackFailed || spawnFailed)) {
        requestReap();
      }
      const reaped = reapDeadline != null && Date.now() >= reapDeadline;
      if (groupAlive && !reaped) return;
      finish(closeStatus);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      requestReap();
      resolveIfReady();
    }, timeoutMs);
    const poll = setInterval(() => {
      if (shouldStop()) {
        interruptedByUser = true;
        requestReap();
      }
      resolveIfReady();
    }, 50);
    if (shouldStop()) {
      interruptedByUser = true;
      requestReap();
    }
    child.on("error", (e) => {
      spawnFailed = true;
      closeStatus = { signal: e.message, failed: true };
      resolveIfReady();
    });
    child.on("close", (code, signal) => {
      closeStatus = { code, signal, failed: !(code === 0 && !signal) };
      resolveIfReady();
    });
  });
}
