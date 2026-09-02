// @ts-nocheck
/**
 * Bounded representative real-Electron release smoke.
 *
 * The settings suite exercises the renderer, preload, main IPC, preferences,
 * and a core terminal without running the full worldline E2E matrix. The
 * caller must build first; the runner owns its per-run fixture/profile root.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const playwrightCli = (() => {
  try {
    return require.resolve("@playwright/test/cli");
  } catch {
    return require.resolve("@playwright/test/cli.js");
  }
})();

const supported = process.platform === "darwin" || process.platform === "linux";
if (!supported) {
  console.log(`SKIP representative Electron smoke on unsupported platform ${process.platform}`);
  process.exit(0);
}

const rawTimeout = process.env.TERMINA_E2E_SMOKE_TIMEOUT_MS ?? "120000";
const timeoutMs = Number(rawTimeout);
if (!/^\d+$/.test(rawTimeout) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
  console.error("TERMINA_E2E_SMOKE_TIMEOUT_MS must be a positive integer");
  process.exit(2);
}
const child = spawn(process.execPath, [playwrightCli, "test", resolve("tests/e2e/settings.spec.ts")], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  detached: process.platform !== "win32",
});

let settled = false;
let interruptCode = null;
let timeoutHandle;
let killHandle;

function signalChild(signal) {
  if (settled || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

const close = new Promise((resolveClose, rejectClose) => {
  child.once("error", rejectClose);
  child.once("close", (code, signal) => {
    settled = true;
    clearTimeout(timeoutHandle);
    clearTimeout(killHandle);
    resolveClose({ code, signal });
  });
});

const onParentSignal = (signal) => {
  if (settled) return;
  interruptCode ??= signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
  signalChild(signal);
};
process.once("SIGINT", () => onParentSignal("SIGINT"));
process.once("SIGTERM", () => onParentSignal("SIGTERM"));
process.once("SIGHUP", () => onParentSignal("SIGHUP"));

const timedOut = new Promise((resolveTimeout) => {
  timeoutHandle = setTimeout(() => {
    console.error(`representative Electron smoke exceeded ${timeoutMs}ms; stopping its owned runner`);
    signalChild("SIGTERM");
    killHandle = setTimeout(() => signalChild("SIGKILL"), 10_000);
    resolveTimeout({ code: 124, signal: "SIGTERM" });
  }, timeoutMs);
});

try {
  const result = await Promise.race([close, timedOut]);
  if (result.code === 124) {
    await close.catch(() => undefined);
    process.exit(124);
  }
  process.exit(interruptCode ?? result.code ?? 1);
} catch (error) {
  console.error(`representative Electron smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  signalChild("SIGTERM");
  await close.catch(() => undefined);
  process.exit(1);
}
