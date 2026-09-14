import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { defaultAppPreferences } from "../../../shared/types.ts";
import {
  PREFS_BOOT_ATTEMPTS,
  loadPreferencesWithRetry,
  prefsBootErrorMessage,
} from "../../../src/preferences-boot.ts";

const renderer = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");
const settingsSrc = readFileSync(new URL("../../../src/settings.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../../src/styles.css", import.meta.url), "utf8");

describe("loadPreferencesWithRetry", () => {
  it("returns normalized prefs on the first success", async () => {
    const getPreferences = vi.fn(async () => ({ theme: "light" }));
    const result = await loadPreferencesWithRetry(getPreferences, { sleep: async () => undefined });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preferences.theme).toBe("light");
    expect(result.preferences.editorFontSize).toBe(defaultAppPreferences().editorFontSize);
    expect(getPreferences).toHaveBeenCalledTimes(1);
  });

  it("retries after failure and succeeds within the bound", async () => {
    const getPreferences = vi.fn()
      .mockRejectedValueOnce(new Error("ipc timeout"))
      .mockRejectedValueOnce(new Error("ipc timeout"))
      .mockResolvedValueOnce({ theme: "atom" });
    const sleep = vi.fn(async () => undefined);
    const result = await loadPreferencesWithRetry(getPreferences, { sleep });
    expect(result).toEqual({ ok: true, preferences: expect.objectContaining({ theme: "atom" }) });
    expect(getPreferences).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not substitute defaults after the bound is exhausted", async () => {
    const getPreferences = vi.fn(async () => {
      throw new Error("ipc timeout");
    });
    const sleep = vi.fn(async () => undefined);
    const result = await loadPreferencesWithRetry(getPreferences, { sleep });
    expect(result).toEqual({ ok: false, error: "ipc timeout" });
    expect(getPreferences).toHaveBeenCalledTimes(PREFS_BOOT_ATTEMPTS);
    expect(sleep).toHaveBeenCalledTimes(PREFS_BOOT_ATTEMPTS - 1);
  });

  it("maps a non-Error rejection to a generic message", () => {
    expect(prefsBootErrorMessage("nope")).toBe("could not load settings");
    expect(prefsBootErrorMessage(new Error(""))).toBe("could not load settings");
  });
});

describe("prefs boot contract (refs #275)", () => {
  it("does not pin defaults from a failed getPreferences catch", () => {
    expect(renderer).toContain("loadPreferencesWithRetry");
    expect(renderer).not.toContain("getPreferences().catch(() => defaultAppPreferences())");
    expect(renderer).toContain("showPrefsLoadBanner");
    expect(renderer).toContain("settingsView.open(committedPreferences)");
    expect(settingsSrc).toContain("open(preferences: AppPreferences | null)");
    expect(settingsSrc).toContain("renderUnavailable");
    expect(settingsSrc).toContain("Could not load settings");
    expect(styles).toContain(".settings-load-banner");
    expect(styles).toContain(".toast-action");
  });
});
