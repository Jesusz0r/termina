// @ts-nocheck
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { resolve } from "node:path";

const SIGNAL_EXIT_CODES = {
  SIGINT: 130,
  SIGHUP: 129,
  SIGTERM: 143,
};
const TERM_WAIT_MS = 1_500;
const KILL_WAIT_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 120_000;

function signalExitCode(signal) {
  return SIGNAL_EXIT_CODES[signal] ?? 128 + (osConstants.signals[signal] ?? 1);
}

function gateTimeout() {
  const raw = process.env.TERMINA_SANDBOX_GATE_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS);
  const timeout = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(timeout) || timeout < 1) {
    throw new Error("TERMINA_SANDBOX_GATE_TIMEOUT_MS must be a positive integer");
  }
  return timeout;
}

function childTarget() {
  const testChild = process.env.NODE_ENV === "test" ? process.env.TERMINA_SANDBOX_GATE_TEST_CHILD : undefined;
  return resolve(testChild || "scripts/sandbox-security-test.ts");
}

function wait(delayMs) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
}

/**
 * Run the required-live sandbox child with owned signal/descendant cleanup.
 * The test-only child override is available only under NODE_ENV=test so the
 * release gate always executes the real sandbox suite.
 */
export async function runSandboxGate({ captureOutput = false } = {}) {
  const grouped = process.platform !== "win32";
  const timeoutMs = gateTimeout();
  let interruptedSignal = null;
  let stopChild;
  const onSignal = (signal) => {
    interruptedSignal ??= signal;
    if (stopChild) void stopChild(signal).catch(() => undefined);
  };
  const signalHandlers = {
    SIGINT: () => onSignal("SIGINT"),
    SIGTERM: () => onSignal("SIGTERM"),
    SIGHUP: () => onSignal("SIGHUP"),
  };
  // Install handlers before spawning so an interrupt during child creation
  // cannot take the wrapper down before it owns the child group.
  process.on("SIGINT", signalHandlers.SIGINT);
  process.on("SIGTERM", signalHandlers.SIGTERM);
  process.on("SIGHUP", signalHandlers.SIGHUP);
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", childTarget()],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TERMINA_SANDBOX_REQUIRE_LIVE: "1",
        TERMINA_SANDBOX_GATE_WRAPPED: "1",
      },
      stdio: captureOutput ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
      detached: grouped,
    },
  );

  let stdout = "";
  let stderr = "";
  if (captureOutput) {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
  }

  let closed = false;
  let spawnError = null;
  let resolveClose;
  const closePromise = new Promise((resolveClosed) => {
    resolveClose = resolveClosed;
  });
  const settleClose = (result) => {
    if (closed) return;
    closed = true;
    resolveClose(result);
  };
  child.once("error", (error) => {
    spawnError = error;
    settleClose({ code: null, signal: null, error });
  });
  child.once("close", (code, signal) => settleClose({ code, signal }));

  const groupExists = () => {
    if (!grouped || !child.pid) return !closed;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      if (error?.code === "EPERM") return true;
      throw error;
    }
  };

  const signalChild = (signal) => {
    if (!child.pid) return false;
    if (grouped) {
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch (error) {
        if (error?.code === "ESRCH") return false;
        throw error;
      }
    }
    if (closed || child.exitCode !== null || child.signalCode !== null) return false;
    try {
      return child.kill(signal);
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      throw error;
    }
  };

  const waitForStopped = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (closed && !groupExists()) return true;
      await wait(Math.min(20, Math.max(1, deadline - Date.now())));
    }
    return closed && !groupExists();
  };

  let stopPromise;
  stopChild = (initialSignal = "SIGTERM") => {
    stopPromise ??= (async () => {
      let signalError = null;
      try {
        signalChild(initialSignal);
      } catch (error) {
        signalError = error;
      }
      if (await waitForStopped(TERM_WAIT_MS)) {
        if (signalError) throw signalError;
        return { signalError, escalated: false };
      }
      try {
        signalChild("SIGKILL");
      } catch (error) {
        signalError ??= error;
      }
      if (!(await waitForStopped(KILL_WAIT_MS))) {
        throw new Error(`sandbox gate child did not stop after SIGKILL${grouped ? " (process group)" : ""}`);
      }
      if (signalError) throw signalError;
      return { signalError, escalated: true };
    })();
    return stopPromise;
  };
  if (interruptedSignal) void stopChild(interruptedSignal).catch(() => undefined);
  let timeoutHandle;

  let result;
  try {
    const timeout = new Promise((resolveTimeout) => {
      timeoutHandle = setTimeout(() => resolveTimeout({ timedOut: true }), timeoutMs);
    });
    const finished = await Promise.race([closePromise, timeout]);
    let cleanupError = null;
    try {
      await stopChild(interruptedSignal ?? "SIGTERM");
    } catch (error) {
      cleanupError = error;
    }

    if (interruptedSignal) {
      result = {
        code: signalExitCode(interruptedSignal),
        signal: interruptedSignal,
        interrupted: true,
        cleanupError,
      };
    } else if (finished.timedOut) {
      result = { code: 124, signal: "SIGTERM", timedOut: true, cleanupError };
    } else if (spawnError || finished.error) {
      result = { code: 1, signal: null, error: spawnError || finished.error, cleanupError };
    } else {
      const code = finished.signal ? signalExitCode(finished.signal) : finished.code ?? 1;
      result = {
        code: cleanupError && code === 0 ? 1 : code,
        signal: finished.signal,
        cleanupError,
      };
    }
  } finally {
    clearTimeout(timeoutHandle);
    process.removeListener("SIGINT", signalHandlers.SIGINT);
    process.removeListener("SIGTERM", signalHandlers.SIGTERM);
    process.removeListener("SIGHUP", signalHandlers.SIGHUP);
  }

  return { ...result, stdout, stderr };
}
