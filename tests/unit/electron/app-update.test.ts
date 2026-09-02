import { describe, it, expect } from "vitest";
import { updateMenuCopy } from "../../../electron/app-update.ts";
import type { AppUpdateState } from "../../../shared/types.ts";

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
