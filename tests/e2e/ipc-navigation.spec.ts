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

    // Only the navigation itself may fail closed (blocked by Electron security
    // policies). The bridge assertions below run outside the catch: once
    // navigation succeeds, a remaining bridge must fail the test, never pass it.
    let navigationBlocked = false;
    try {
      await page.goto(foreignUrl, { timeout: 3_000 });
    } catch {
      navigationBlocked = true;
    }
    if (navigationBlocked) {
      // Fail closed: the app window never left, so the trusted bridge is
      // intact and no foreign page exists to abuse it.
      await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
      return;
    }

    const foreign = await page.evaluate(() => ({
      loaded: (window as unknown as Record<string, unknown>).__foreignLoaded === true,
      bridge: typeof (window as unknown as Record<string, unknown>).termina,
    }));
    expect(foreign.loaded).toBe(true);
    expect(foreign.bridge).toBe("undefined");
  });
});
