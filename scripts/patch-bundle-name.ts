// @ts-nocheck
/**
 * Names the Electron bundle so the macOS menu bar shows the app name.
 *
 * The macOS menu bar takes the app menu title from the bundle name, not
 * from app.name or the menu labels. An unpackaged Electron run defaults
 * to "Electron". This script patches CFBundleName and CFBundleDisplayName
 * in the installed Electron bundle once. Electron reinstalls restore the
 * original values; the next launch patches again.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PLIST_BUDDY = "/usr/libexec/PlistBuddy";
const APP_NAME = "Termina";

export function patchBundleName() {
  if (process.platform !== "darwin") return false;
  const electronPath = require("electron");
  const parts = electronPath.split("/");
  const appIndex = parts.findIndex((part) => part.endsWith(".app"));
  if (appIndex < 0) return false;
  const bundleRoot = parts.slice(0, appIndex + 1).join("/");
  const plist = join(bundleRoot, "Contents", "Info.plist");
  if (!existsSync(plist)) return false;
  let current = "";
  try {
    current = execFileSync(PLIST_BUDDY, ["-c", "Print :CFBundleName", plist], { encoding: "utf8" }).trim();
  } catch {
    return false;
  }
  if (current === APP_NAME) return true;
  execFileSync(PLIST_BUDDY, ["-c", `Set :CFBundleName ${APP_NAME}`, "-c", `Set :CFBundleDisplayName ${APP_NAME}`, plist]);
  return true;
}
