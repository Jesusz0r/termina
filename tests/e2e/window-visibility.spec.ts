import { test, expect } from "./fixtures.ts";

/**
 * The suite drives the real app in a real Electron window. A shown window takes
 * the user's focus (and a Dock tile) for the whole run, so the fixture asks main
 * for a window that is never displayed (`TERMINA_E2E_HIDDEN`).
 *
 * Without this guard the property regresses silently: removing the variable
 * leaves every other test green while the suite starts hijacking the machine
 * again. The page must still render and be drivable while hidden.
 */
test("e2e runs drive the app with no visible window and no dock tile", async ({ page, electronApp }) => {
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

  const state = await electronApp.evaluate(({ BrowserWindow, app }) => ({
    visible: BrowserWindow.getAllWindows().map((win) => win.isVisible()),
    dockVisible: process.platform === "darwin" ? app.dock?.isVisible() ?? null : null,
  }));

  // The app is drivable...
  await expect(page.locator("#explorer-tree")).toBeVisible();
  // ...but a window exists without ever being shown.
  expect(state.visible.length).toBeGreaterThan(0);
  expect(state.visible.every((visible) => visible === false)).toBe(true);
  if (process.platform === "darwin") expect(state.dockVisible).toBe(false);
});
