/**
 * Packaged-app updates from GitHub Releases.
 *
 * electron-builder writes the feed file into the bundle. This module
 * checks that feed, downloads the artifact, and asks Electron to install
 * it. A source launch is unpackaged, so it stays disabled.
 */
import { app } from "electron";
import { createRequire } from "node:module";
import type { AppUpdater } from "electron-updater";
import type { AppUpdateState } from "../shared/types.js";

const require = createRequire(import.meta.url);
const { autoUpdater } = require("electron-updater") as { autoUpdater: AppUpdater };

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 60 * 1000;
const PROGRESS_THROTTLE_MS = 400;

export interface AppUpdateController {
  getState(): AppUpdateState;
  check(): void;
  install(): { ok: boolean; error?: string };
  quitAndInstall(): void;
  start(): void;
  dispose(): void;
}

function currentVersion(): string {
  return app.getVersion();
}

function statesEqual(a: AppUpdateState, b: AppUpdateState): boolean {
  if (a.status !== b.status || a.currentVersion !== b.currentVersion) return false;
  if (a.status === "available" && b.status === "available") return a.version === b.version;
  if (a.status === "downloading" && b.status === "downloading") {
    return a.version === b.version && a.percent === b.percent;
  }
  if (a.status === "ready" && b.status === "ready") return a.version === b.version;
  if (a.status === "error" && b.status === "error") return a.message === b.message;
  return true;
}

function isUpdateInFlight(state: AppUpdateState): boolean {
  return state.status === "available" || state.status === "downloading" || state.status === "ready";
}

export function createAppUpdater(opts: { send: (state: AppUpdateState) => void }): AppUpdateController {
  let state: AppUpdateState = app.isPackaged
    ? { status: "checking", currentVersion: currentVersion() }
    : { status: "disabled", currentVersion: currentVersion() };
  let version = "";
  let checkTimer: ReturnType<typeof setInterval> | null = null;
  let lastProgressAt = 0;
  let started = false;
  let checkInFlight = false;
  let checkSeq = 0;

  const setState = (next: AppUpdateState): void => {
    if (statesEqual(state, next)) return;
    state = next;
    opts.send(next);
  };

  const check = (): void => {
    if (!app.isPackaged) {
      setState({ status: "disabled", currentVersion: currentVersion() });
      return;
    }
    if (checkInFlight || isUpdateInFlight(state)) return;
    checkInFlight = true;
    const seq = ++checkSeq;
    setState({ status: "checking", currentVersion: currentVersion() });
    const timeout = setTimeout(() => {
      if (seq !== checkSeq) return;
      checkInFlight = false;
      if (state.status === "checking") {
        setState({
          status: "error",
          currentVersion: currentVersion(),
          message: "The update check timed out.",
        });
      }
    }, CHECK_TIMEOUT_MS);
    void autoUpdater
      .checkForUpdates()
      .then((result) => {
        if (seq !== checkSeq || state.status !== "checking") return;
        const found = result != null && typeof result === "object" && "isUpdateAvailable" in result
          ? Boolean((result as { isUpdateAvailable?: boolean }).isUpdateAvailable)
          : false;
        if (found) return;
        setState({ status: "current", currentVersion: currentVersion() });
      })
      .catch((err: Error) => {
        if (seq !== checkSeq) return;
        console.warn(`[update] check failed: ${err.message}`);
        setState({ status: "error", currentVersion: currentVersion(), message: err.message });
      })
      .finally(() => {
        if (seq !== checkSeq) return;
        clearTimeout(timeout);
        checkInFlight = false;
      });
  };

  return {
    getState() {
      return state;
    },

    check,

    install() {
      switch (state.status) {
        case "ready":
          return { ok: true };
        case "available":
        case "downloading":
          return { ok: false, error: "The update is still downloading." };
        default:
          return { ok: false, error: "No update is ready." };
      }
    },

    quitAndInstall() {
      autoUpdater.quitAndInstall(false, true);
    },

    start() {
      if (started) return;
      started = true;
      if (!app.isPackaged) {
        opts.send(state);
        return;
      }
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.disableWebInstaller = true;
      autoUpdater.allowPrerelease = false;
      autoUpdater.logger = null;

      autoUpdater.on("update-available", (info) => {
        if (isUpdateInFlight(state) && state.status !== "available") return;
        version = info.version;
        setState({ status: "available", currentVersion: currentVersion(), version });
      });
      autoUpdater.on("update-not-available", () => {
        if (isUpdateInFlight(state)) return;
        setState({ status: "current", currentVersion: currentVersion() });
      });
      autoUpdater.on("download-progress", (progress) => {
        if (!version && state.status === "available") version = state.version;
        if (!version) return;
        const percent = Math.max(0, Math.min(100, Math.round(progress.percent)));
        const now = Date.now();
        if (state.status === "downloading" && state.percent === percent && now - lastProgressAt < PROGRESS_THROTTLE_MS) {
          return;
        }
        lastProgressAt = now;
        setState({ status: "downloading", currentVersion: currentVersion(), version, percent });
      });
      autoUpdater.on("update-downloaded", (info) => {
        version = info.version;
        setState({ status: "ready", currentVersion: currentVersion(), version });
      });
      autoUpdater.on("error", (err) => {
        console.warn(`[update] ${err.message}`);
        if (state.status === "downloading" && version) {
          setState({ status: "available", currentVersion: currentVersion(), version });
          return;
        }
        if (state.status === "ready") return;
        setState({ status: "error", currentVersion: currentVersion(), message: err.message });
      });

      check();
      checkTimer = setInterval(check, CHECK_INTERVAL_MS);
    },

    dispose() {
      if (checkTimer) {
        clearInterval(checkTimer);
        checkTimer = null;
      }
    },
  };
}

/** Labels for the Termina application menu. */
export function updateMenuCopy(state: AppUpdateState): {
  status: string;
  action: string;
  enabled: boolean;
  kind: "check" | "install" | "none";
} {
  switch (state.status) {
    case "disabled":
      return {
        status: `Termina ${state.currentVersion} — this install is up to date (source)`,
        action: "Check for Updates…",
        enabled: true,
        kind: "check",
      };
    case "checking":
      return {
        status: `Termina ${state.currentVersion} — checking…`,
        action: "Check for Updates…",
        enabled: false,
        kind: "none",
      };
    case "current":
      return {
        status: `Termina ${state.currentVersion} — this install is up to date`,
        action: "Check for Updates…",
        enabled: true,
        kind: "check",
      };
    case "available":
      return {
        status: `Termina ${state.version} is available`,
        action: "Downloading Update…",
        enabled: false,
        kind: "none",
      };
    case "downloading":
      return {
        status: `Downloading Termina ${state.version} (${state.percent}%)`,
        action: "Downloading Update…",
        enabled: false,
        kind: "none",
      };
    case "ready":
      return {
        status: `Termina ${state.version} is ready to install`,
        action: "Restart and Install Update…",
        enabled: true,
        kind: "install",
      };
    case "error": {
      const message = state.message.length > 80 ? `${state.message.slice(0, 77)}…` : state.message;
      return {
        status: message ? `Could not check for updates: ${message}` : "Could not check for updates",
        action: "Check for Updates…",
        enabled: true,
        kind: "check",
      };
    }
  }
}
