/**
 * Packaged-app updates from GitHub Releases.
 *
 * electron-builder writes the feed file into the bundle. This module
 * checks that feed, downloads the artifact, and asks Electron to install
 * it. A source launch is unpackaged, so it stays disabled.
 */
import { app } from "electron";
import { createRequire } from "node:module";
import type { AppUpdater, ProgressInfo, UpdateInfo } from "electron-updater";
import type { AppUpdateState } from "../shared/types.js";

const require = createRequire(import.meta.url);

function getAutoUpdater(): AppUpdater {
  return (require("electron-updater") as { autoUpdater: AppUpdater }).autoUpdater;
}

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 60 * 1000;
const PROGRESS_THROTTLE_MS = 400;

export type AppUpdateController = ReturnType<typeof createAppUpdater>;

function currentVersion(): string {
  return typeof app?.getVersion === "function" ? app.getVersion() : "0.0.0";
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

export function createAppUpdater(opts: { send: (state: AppUpdateState) => void }) {
  let state: AppUpdateState = app.isPackaged
    ? { status: "current", currentVersion: currentVersion() }
    : { status: "disabled", currentVersion: currentVersion() };
  let version = "";
  let checkTimer: ReturnType<typeof setInterval> | null = null;
  let checkTimeout: ReturnType<typeof setTimeout> | null = null;
  let checkPromise: Promise<AppUpdateState> | null = null;
  let lastProgressAt = 0;
  let started = false;
  let checkSeq = 0;

  const setState = (next: AppUpdateState): void => {
    if (statesEqual(state, next)) return;
    state = next;
    opts.send(next);
  };

  const check = (): Promise<AppUpdateState> => {
    if (!app.isPackaged) {
      setState({ status: "disabled", currentVersion: currentVersion() });
      return Promise.resolve(state);
    }
    if (checkPromise) return checkPromise;
    if (isUpdateInFlight(state)) return Promise.resolve(state);
    const seq = ++checkSeq;
    setState({ status: "checking", currentVersion: currentVersion() });

    checkPromise = new Promise<AppUpdateState>((resolve) => {
      checkTimeout = setTimeout(() => {
        checkTimeout = null;
        if (seq !== checkSeq) return resolve(state);
        if (state.status === "checking") {
          setState({
            status: "error",
            currentVersion: currentVersion(),
            message: "The update check timed out.",
          });
        }
        resolve(state);
      }, CHECK_TIMEOUT_MS);

      void getAutoUpdater()
        .checkForUpdates()
        .then((result) => {
          if (seq !== checkSeq) return resolve(state);
          const found = result != null && typeof result === "object" && "isUpdateAvailable" in result
            ? Boolean((result as { isUpdateAvailable?: boolean }).isUpdateAvailable)
            : false;
          if (found && result && "updateInfo" in result && (result as { updateInfo?: { version?: string } }).updateInfo?.version) {
            version = (result as { updateInfo: { version: string } }).updateInfo.version;
            setState({ status: "available", currentVersion: currentVersion(), version });
          } else if (!found) {
            setState({ status: "current", currentVersion: currentVersion() });
          }
          resolve(state);
        })
        .catch((err: Error) => {
          if (seq !== checkSeq) return resolve(state);
          console.warn(`[update] check failed: ${err.message}`);
          setState({ status: "error", currentVersion: currentVersion(), message: err.message });
          resolve(state);
        })
        .finally(() => {
          if (seq !== checkSeq) return;
          if (checkTimeout) clearTimeout(checkTimeout);
          checkTimeout = null;
          checkPromise = null;
        });
    });

    return checkPromise;
  };

  const onUpdateAvailable = (info: UpdateInfo): void => {
    if (isUpdateInFlight(state) && state.status !== "available") return;
    version = info.version;
    setState({ status: "available", currentVersion: currentVersion(), version });
  };
  const onUpdateNotAvailable = (): void => {
    if (isUpdateInFlight(state)) return;
    setState({ status: "current", currentVersion: currentVersion() });
  };
  const onDownloadProgress = (progress: ProgressInfo): void => {
    if (!version && state.status === "available") version = state.version;
    if (!version) return;
    const percent = Math.max(0, Math.min(100, Math.round(progress.percent)));
    const now = Date.now();
    if (state.status === "downloading" && state.percent === percent && now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
    lastProgressAt = now;
    setState({ status: "downloading", currentVersion: currentVersion(), version, percent });
  };
  const onUpdateDownloaded = (info: UpdateInfo): void => {
    version = info.version;
    setState({ status: "ready", currentVersion: currentVersion(), version });
  };
  const onError = (err: Error): void => {
    console.warn(`[update] ${err.message}`);
    if (state.status === "downloading" && version) {
      setState({ status: "available", currentVersion: currentVersion(), version });
      return;
    }
    if (state.status === "ready") return;
    setState({ status: "error", currentVersion: currentVersion(), message: err.message });
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
      getAutoUpdater().quitAndInstall(false, true);
    },

    start() {
      if (started) return;
      started = true;
      if (!app?.isPackaged) {
        opts.send(state);
        return;
      }
      const updater = getAutoUpdater();
      updater.autoDownload = true;
      updater.autoInstallOnAppQuit = true;
      updater.disableWebInstaller = true;
      updater.allowPrerelease = false;
      updater.logger = null;

      updater.on("update-available", onUpdateAvailable);
      updater.on("update-not-available", onUpdateNotAvailable);
      updater.on("download-progress", onDownloadProgress);
      updater.on("update-downloaded", onUpdateDownloaded);
      updater.on("error", onError);

      void check();
      checkTimer = setInterval(() => void check(), CHECK_INTERVAL_MS);
    },

    dispose() {
      started = false;
      checkSeq++;
      checkPromise = null;
      if (checkTimer) clearInterval(checkTimer);
      checkTimer = null;
      if (checkTimeout) clearTimeout(checkTimeout);
      checkTimeout = null;
      if (app?.isPackaged) {
        const updater = getAutoUpdater();
        updater.off("update-available", onUpdateAvailable);
        updater.off("update-not-available", onUpdateNotAvailable);
        updater.off("download-progress", onDownloadProgress);
        updater.off("update-downloaded", onUpdateDownloaded);
        updater.off("error", onError);
      }
    },
  };
}

/** Labels for the Termina application menu. */
export function updateMenuCopy(state: AppUpdateState): {
  label: string;
  enabled: boolean;
  kind: "check" | "install" | "none";
} {
  switch (state.status) {
    case "disabled":
    case "current":
      return {
        label: "Check for Updates…",
        enabled: true,
        kind: "check",
      };
    case "checking":
      return {
        label: "Checking for Updates…",
        enabled: false,
        kind: "none",
      };
    case "available":
      return {
        label: `Downloading Termina ${state.version}…`,
        enabled: false,
        kind: "none",
      };
    case "downloading":
      return {
        label: `Downloading Termina ${state.version} (${state.percent}%)…`,
        enabled: false,
        kind: "none",
      };
    case "ready":
      return {
        label: `Restart and Install Update (Termina ${state.version})…`,
        enabled: true,
        kind: "install",
      };
    case "error":
      return {
        label: "Check for Updates…",
        enabled: true,
        kind: "check",
      };
  }
}

