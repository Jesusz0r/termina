import { test, expect } from "./fixtures.ts";

test.describe("Settings & Preferences E2E", () => {
  test("opens settings modal and lists categories", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    // Open settings modal
    await page.evaluate(() => (window as any).__openSettings());
    const modal = page.locator(".settings-modal");
    await expect(modal).toBeVisible();

    // Check Appearance is selected by default
    const activeNav = modal.locator(".settings-nav-item.active");
    await expect(activeNav).toHaveText("Appearance");

    // Close settings modal
    await modal.locator(".settings-close").click();
    await expect(modal).toBeHidden();
  });

  test("applies and persists theme changes", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    await page.evaluate(() => (window as any).__openSettings());
    const modal = page.locator(".settings-modal");
    await expect(modal).toBeVisible();

    // Click light theme card
    const lightThemeCard = modal.locator('.settings-theme-card[data-theme="light"]');
    await lightThemeCard.click();

    // The document element theme attribute updates
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    // Close and reopen to verify persistence
    await modal.locator(".settings-close").click();
    await expect(modal).toBeHidden();

    await page.evaluate(() => (window as any).__openSettings());
    await expect(page.locator('.settings-theme-card[data-theme="light"]')).toHaveClass(/selected/);

    // Reset to default
    await page.locator(".settings-reset").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.locator(".settings-close").click();
  });

  test("navigates to keyboard shortcuts and lists options", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    await page.evaluate(() => (window as any).__openSettings());
    const modal = page.locator(".settings-modal");
    await expect(modal).toBeVisible();

    // Click keyboard shortcuts category
    const keyboardNav = modal.locator(".settings-nav-item").nth(1);
    await keyboardNav.click();

    // Shortcuts should be visible
    const shortcutRows = modal.locator(".settings-shortcut-row");
    await expect(shortcutRows.first()).toBeVisible();
    const count = await shortcutRows.count();
    expect(count).toBeGreaterThanOrEqual(30);

    await modal.locator(".settings-close").click();
  });
});
