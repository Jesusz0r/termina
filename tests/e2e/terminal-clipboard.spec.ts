import { test, expect } from "./fixtures.ts";

test.describe("Terminal Clipboard & Selection Integration", () => {
  test("copies terminal selection to system clipboard", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const marker = "TERMINAL_CLIPBOARD_TEST_MARKER";

    // Write marker text into the active terminal pane and select it
    await page.evaluate((text) => {
      return new Promise<void>((resolve) => {
        const pane = [...(window as any).__panes.values()][0];
        const term = pane?.view.getTerminal();
        if (!term) return resolve();
        term.write(`\r\n${text}\r\n`, () => {
          term.selectAll();
          pane.view.copySelection();
          resolve();
        });
      });
    }, marker);

    await page.waitForTimeout(300);

    // Verify clipboard content via window.pi.readClipboard()
    const clipboardContent = await page.evaluate(() => (window as any).pi.readClipboard());
    expect(clipboardContent).toContain(marker);
  });
});
