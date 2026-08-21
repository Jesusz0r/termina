/**
 * Packaged-app updates from GitHub Releases.
 *
 * electron-builder writes the feed file into the bundle. This module
 * checks that feed, downloads the artifact, and asks Electron to install
 * it. Dev and test launches are unpackaged, so they skip this.
 */
import { app } from "electron";
import { createRequire } from "node:module";
import type { AppUpdater } from "electron-updater";
import type { AppUpdateState } from "../shared/types.js";

const require = createRequire(import.meta.url);
const { autoUpdater } = require("electron-updater") as { autoUpdater: AppUpdater };

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PROGRESS_THROTTLE_MS = 400;

export interface AppUpdateController {
  getState(): AppUpdateState;
  install(): { ok: boolean; error?: string };
  quitAndInstall(): void;
  start(): void;
  dispose(): void;
}

function statesEqual(a: AppUpdateState, b: AppUpdateState): boolean {
  if (a.status !== b.status) return false;
  if (a.status === "idle" || b.status === "idle") return true;
  if (a.status === "downloading" && b.status === "downloading") {
    return a.version === b.version && a.percent === b.percent;
  }
  return a.version === b.version;
}

function isDownloadActive(state: AppUpdateState): boolean {
  return state.status === "downloading" || state.status === "ready";
}

export function createAppUpdater(opts: { send: (state: AppUpdateState) => void }): AppUpdateController {
  let state: AppUpdateState = { status: "idle" };
  let version = "";
  let checkTimer: ReturnType<typeof setInterval> | null = null;
  let lastProgressAt = 0;
  let started = false;
  let checkInFlight = false;

  const setState = (next: AppUpdateState): void => {
    if (statesEqual(state, next)) return;
    state = next;
    opts.send(next);
  };

  const check = (): void => {
    if (checkInFlight || isDownloadActive(state)) return;
    checkInFlight = true;
    void autoUpdater
      .checkForUpdates()
      .catch((err: Error) => {
        console.warn(`[update] check failed: ${err.message}`);
      })
      .finally(() => {
        checkInFlight = false;
      });
  };

  return {
    getState() {
      return state;
    },

    install() {
      switch (state.status) {
        case "ready":
        case "available":
          return { ok: true };
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
      if (started || !app.isPackaged) return;
      started = true;
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.disableWebInstaller = true;
      autoUpdater.allowPrerelease = false;
      autoUpdater.logger = null;

      autoUpdater.on("update-available", (info) => {
        if (isDownloadActive(state)) return;
        version = info.version;
        setState({ status: "available", version });
      });
      autoUpdater.on("download-progress", (progress) => {
        const percent = Math.max(0, Math.min(100, Math.round(progress.percent)));
        const now = Date.now();
        if (state.status === "downloading" && state.percent === percent && now - lastProgressAt < PROGRESS_THROTTLE_MS) {
          return;
        }
        lastProgressAt = now;
        setState({ status: "downloading", version, percent });
      });
      autoUpdater.on("update-downloaded", (info) => {
        version = info.version;
        setState({ status: "ready", version });
      });
      autoUpdater.on("error", (err) => {
        console.warn(`[update] ${err.message}`);
        if (state.status === "downloading" && version) {
          setState({ status: "available", version });
        }
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
