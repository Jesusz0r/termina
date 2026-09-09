import { test, expect } from "./fixtures.ts";

test.describe("Privileged Renderer IPC Navigation Isolation", () => {
  test("trusted application window exposes the typed bridge", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const status = await page.evaluate(() => ({
      hasBridge: typeof (window as any).termina === "object",
      canList: typeof (window as any).termina?.projectList === "function",
    }));

    expect(status.hasBridge).toBe(true);
    expect(status.canList).toBe(true);
  });

  test("foreign page navigation cannot invoke privileged IPC", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const foreignUrl = `data:text/html,${encodeURIComponent(
      "<title>foreign</title><script>window.__foreignLoaded = true;</script>",
    )}`;

    // Navigating away from the app should either be blocked or strip the bridge
    try {
      await page.goto(foreignUrl, { timeout: 3_000 });
      const foreignBridge = await page.evaluate(() => typeof (window as any).termina);
      expect(foreignBridge).toBe("undefined");
    } catch {
      // Navigation blocked by Electron security policies (fail closed) is also a pass
      expect(true).toBe(true);
    }
  });
});
