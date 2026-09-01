import { test, expect } from "./fixtures.ts";

test.describe("Session Search Modal & Search Query E2E", () => {
  test("opens session search modal, inputs query, and closes cleanly", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    // Open session search modal
    await page.evaluate(() => {
      const search = (window as any).__sessionSearch;
      if (search) search.open();
    });

    const modal = page.locator(".search-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });

    const input = modal.locator(".search-input");
    await expect(input).toBeVisible();

    // Type query
    await input.fill("compute");

    // Results container should be attached
    const results = modal.locator(".search-results");
    await expect(results).toBeAttached();

    // Close on Escape
    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
  });
});
