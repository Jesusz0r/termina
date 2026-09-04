import { test, expect } from "./fixtures.ts";

test.describe("Terminal Find", () => {
  test("finds text in scrollback and closes with Escape", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const marker = "TERMINAL_FIND_TEST_MARKER";
    await page.evaluate((text) => {
      return new Promise<void>((resolve) => {
        const pane = [...(window as any).__panes.values()][0];
        const term = pane?.view.getTerminal();
        if (!term) return resolve();
        term.write(`\r\n${text}\r\n`, () => resolve());
      });
    }, marker);

    // Focus the terminal: the same chord opens Monaco's find when the editor
    // is focused, mirroring copy/paste routing.
    await page.locator("#terminal-container").click();
    await page.keyboard.press("ControlOrMeta+f");
    const bar = page.locator(".terminal-find");
    await expect(bar).toBeVisible();
    await page.locator(".terminal-find input").fill(marker);

    await page.waitForFunction(
      (text) => {
        const pane = [...(window as any).__panes.values()][0];
        return pane?.view.getTerminal().getSelection().includes(text) ?? false;
      },
      marker,
      { timeout: 5_000 },
    );

    await page.keyboard.press("Escape");
    await expect(bar).toBeHidden();
  });
});
