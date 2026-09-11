import { test, expect } from "./fixtures.ts";

/**
 * The suite pins software rendering (`--disable-gpu` in the fixture launch
 * args). Without the pin the GPU mode varies with the host; on hosts where
 * the GPU process cannot initialize, Chromium logs a GLES kFatalFailure at
 * startup and falls back to software (a counted, zero-blast-radius warning —
 * see the fixture's stderr filter).
 *
 * Without this guard the property regresses silently: removing the flag
 * leaves every other test green while GPU behavior goes host-dependent
 * again. WebGL is the canary — it is only ever absent when the GPU is off.
 */
test("e2e runs pin software rendering (no WebGL)", async ({ page }) => {
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

  const webgl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    return canvas.getContext("webgl") !== null;
  });
  expect(webgl).toBe(false);

  // The app is drivable: canvas-2D rendering (xterm, Monaco) needs no GPU.
  await expect(page.locator("#explorer-tree")).toBeVisible();
});
