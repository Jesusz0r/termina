import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { createAppUpdater, updateMenuCopy } from "../../../electron/app-update.ts";
import type { AppUpdateState } from "../../../shared/types.ts";

vi.mock("electron", () => ({ app: { isPackaged: true, getVersion: () => "0.1.43" } }));

describe("App Update Menu Contract", () => {
  it("shows 'Check for Updates…' when disabled or up to date", () => {
    const disabledState: AppUpdateState = { status: "disabled", currentVersion: "0.1.26" };
    expect(updateMenuCopy(disabledState)).toEqual({
      label: "Check for Updates…",
      enabled: true,
      kind: "check",
    });

    const currentState: AppUpdateState = { status: "current", currentVersion: "0.1.26" };
    expect(updateMenuCopy(currentState)).toEqual({
      label: "Check for Updates…",
      enabled: true,
      kind: "check",
    });
  });

  it("shows disabled 'Checking for Updates…' when a check is in progress", () => {
    const checkingState: AppUpdateState = { status: "checking", currentVersion: "0.1.26" };
    expect(updateMenuCopy(checkingState)).toEqual({
      label: "Checking for Updates…",
      enabled: false,
      kind: "none",
    });
  });

  it("shows progress when downloading an update", () => {
    const availableState: AppUpdateState = {
      status: "available",
      currentVersion: "0.1.26",
      version: "0.1.27",
    };
    expect(updateMenuCopy(availableState)).toEqual({
      label: "Downloading Termina 0.1.27…",
      enabled: false,
      kind: "none",
    });

    const downloadingState: AppUpdateState = {
      status: "downloading",
      currentVersion: "0.1.26",
      version: "0.1.27",
      percent: 45,
    };
    expect(updateMenuCopy(downloadingState)).toEqual({
      label: "Downloading Termina 0.1.27 (45%)…",
      enabled: false,
      kind: "none",
    });
  });

  it("shows enabled restart action when an update is ready", () => {
    const readyState: AppUpdateState = {
      status: "ready",
      currentVersion: "0.1.26",
      version: "0.1.27",
    };
    expect(updateMenuCopy(readyState)).toEqual({
      label: "Restart and Install Update (Termina 0.1.27)…",
      enabled: true,
      kind: "install",
    });
  });

  it("allows re-checking when in error state", () => {
    const errorState: AppUpdateState = {
      status: "error",
      currentVersion: "0.1.26",
      message: "Network unreachable",
    };
    expect(updateMenuCopy(errorState)).toEqual({
      label: "Check for Updates…",
      enabled: true,
      kind: "check",
    });
  });
});

describe("App Update controller", () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
    let resolve!: (value: T) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  class FakeUpdater extends EventEmitter {
    attempts: Array<ReturnType<typeof deferred<unknown>>> = [];
    autoDownload = false;
    autoInstallOnAppQuit = false;
    disableWebInstaller = false;
    allowPrerelease = false;
    logger: unknown = null;
    checkForUpdates(): Promise<unknown> {
      const attempt = deferred<unknown>();
      this.attempts.push(attempt);
      return attempt.promise;
    }
    quitAndInstall(): void {}
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("releases a timed-out check so retries start fresh (refs #171)", async () => {
    vi.useFakeTimers();
    const updater = new FakeUpdater();
    const seen: AppUpdateState[] = [];
    const ctl = createAppUpdater({ send: (s) => seen.push(s), updater: updater as never });
    try {
      ctl.start();
      expect(updater.attempts).toHaveLength(1);
      const first = ctl.check();
      // Fire the 60 s deadline without waiting for it in real time.
      const timedOut = ctl.check();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await timedOut).toMatchObject({ status: "error", message: "The update check timed out." });
      expect(await first).toMatchObject({ status: "error" });
      // The retry is a new promise backed by a new underlying attempt.
      const retry = ctl.check();
      expect(retry).not.toBe(first);
      expect(updater.attempts).toHaveLength(2);
      expect(ctl.getState().status).toBe("checking");
      // Late success of the dead attempt cannot touch the new check.
      updater.attempts[0]!.resolve({ isUpdateAvailable: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(ctl.getState().status).toBe("checking");
      updater.attempts[1]!.resolve({ isUpdateAvailable: false });
      expect(await retry).toMatchObject({ status: "current" });
    } finally {
      ctl.dispose();
    }
  });

  it("fences late failures and keeps the retry's own deadline (refs #171)", async () => {
    vi.useFakeTimers();
    const updater = new FakeUpdater();
    const ctl = createAppUpdater({ send: () => undefined, updater: updater as never });
    try {
      ctl.start();
      const first = ctl.check();
      await vi.advanceTimersByTimeAsync(60_000);
      await first;
      const retry = ctl.check();
      expect(updater.attempts).toHaveLength(2);
      // The dead attempt's late failure is fenced: it neither changes state
      // nor clears the live attempt's timer and ownership.
      updater.attempts[0]!.reject(new Error("socket hang up"));
      await vi.advanceTimersByTimeAsync(0);
      expect(ctl.getState().status).toBe("checking");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await retry).toMatchObject({ status: "error", message: "The update check timed out." });
    } finally {
      ctl.dispose();
    }
  });

  it("retries on the schedule and stops all timers on dispose (refs #171)", async () => {
    vi.useFakeTimers();
    const updater = new FakeUpdater();
    const ctl = createAppUpdater({ send: () => undefined, updater: updater as never });
    try {
      ctl.start();
      await vi.advanceTimersByTimeAsync(60_000);
      updater.attempts[0]!.resolve({ isUpdateAvailable: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(updater.attempts).toHaveLength(1);
      // The 6 h schedule starts a fresh attempt after the timeout cleared ownership.
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
      expect(updater.attempts).toHaveLength(2);
      ctl.dispose();
      updater.attempts[1]!.resolve({ isUpdateAvailable: false });
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(updater.attempts).toHaveLength(2);
    } finally {
      ctl.dispose();
    }
  });

  it("reports a failed download as a recoverable error (refs #172)", async () => {
    const updater = new FakeUpdater();
    const ctl = createAppUpdater({ send: () => undefined, updater: updater as never });
    try {
      ctl.start();
      const first = ctl.check();
      updater.attempts[0]!.resolve({ isUpdateAvailable: true, updateInfo: { version: "0.2.0" } });
      await first;
      // The ownership release runs a microtask after the check promise settles.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(ctl.getState()).toMatchObject({ status: "available", version: "0.2.0" });
      updater.emit("download-progress", { percent: 10 });
      expect(ctl.getState()).toMatchObject({ status: "downloading", percent: 10 });
      updater.emit("error", new Error("socket hang up"));
      const failed = ctl.getState();
      expect(failed).toMatchObject({ status: "error", message: "socket hang up" });
      // The menu, checks, and install agree: retry is offered, install refuses honestly.
      expect(updateMenuCopy(failed)).toEqual({ label: "Check for Updates…", enabled: true, kind: "check" });
      expect(ctl.install()).toEqual({ ok: false, error: "No update is ready." });
      // A late completion for the failed download cannot mark it ready, and
      // late progress cannot resurrect the downloading label.
      updater.emit("update-downloaded", { version: "0.2.0" });
      expect(ctl.getState().status).toBe("error");
      updater.emit("download-progress", { percent: 90 });
      expect(ctl.getState().status).toBe("error");
      // The user retries through the same owner and the download restarts.
      const retry = ctl.check();
      expect(updater.attempts).toHaveLength(2);
      updater.attempts[1]!.resolve({ isUpdateAvailable: true, updateInfo: { version: "0.2.0" } });
      await retry;
      expect(ctl.getState()).toMatchObject({ status: "available", version: "0.2.0" });
      updater.emit("download-progress", { percent: 50 });
      updater.emit("update-downloaded", { version: "0.2.0" });
      expect(ctl.getState()).toMatchObject({ status: "ready", version: "0.2.0" });
      expect(ctl.install()).toEqual({ ok: true });
    } finally {
      ctl.dispose();
    }
  });
});
