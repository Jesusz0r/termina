import { test, expect } from "./fixtures.ts";

test.describe("Renderer Chromium sandbox", () => {
  test("boots with the typed bridge under the strict CSP", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const status = await page.evaluate(() => ({
      hasBridge: typeof (window as unknown as { termina?: unknown }).termina === "object",
      canList: typeof (window as unknown as { termina?: { projectList?: unknown } }).termina?.projectList === "function",
    }));

    expect(status.hasBridge).toBe(true);
    expect(status.canList).toBe(true);
  });

  test("inline scripts do not run", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const ran = await page.evaluate(() => {
      const probe = window as unknown as { __cspInlineProbe?: boolean };
      probe.__cspInlineProbe = false;
      const script = document.createElement("script");
      script.textContent = "(window).__cspInlineProbe = true;";
      document.head.appendChild(script);
      return new Promise((resolve) => setTimeout(() => resolve(probe.__cspInlineProbe), 500));
    });

    expect(ran).toBe(false);
  });

  test("permission requests are denied", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const permission = await page.evaluate(async () => {
      try {
        return await Notification.requestPermission();
      } catch (error) {
        return `threw: ${(error as Error).message}`;
      }
    });

    expect(permission).toBe("denied");
  });

  test("file-drop bridge still answers under the sandbox", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const result = await page.evaluate(() => {
      const file = new File(["probe"], "sandbox-probe.txt", { type: "text/plain" });
      return (window as unknown as { termina: { dropTerminalFiles: (id: string, files: File[]) => unknown } }).termina.dropTerminalFiles("term-1", [file]);
    });

    // A synthetic File has no disk path, so the preload must fail closed
    // with a typed error — not a sandbox crash or an exception.
    expect(result).toEqual({ ok: false, error: "invalid dropped file" });
  });
});
