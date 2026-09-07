import { test, expect } from "./fixtures.ts";

test.describe("pane resize dividers", () => {
  test("explorer divider drag changes explorer width", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const before = await page.locator("#explorer").evaluate((el) => el.getBoundingClientRect().width);
    const box = await page.locator("#explorer-divider").boundingBox();
    expect(box).not.toBeNull();
    const y = box!.y + 100;
    await page.mouse.move(box!.x + 2, y);
    await page.mouse.down();
    await page.mouse.move(box!.x + 82, y);
    await page.mouse.up();
    const after = await page.locator("#explorer").evaluate((el) => el.getBoundingClientRect().width);
    expect(after - before).toBeGreaterThan(40);
  });

  test("split divider drag changes the terminal share", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    await page.locator("#explorer-tree").getByText("greeting.ts").click();
    await expect(page.locator(".editor-tab").getByText("greeting.ts")).toBeVisible({ timeout: 10_000 });
    const box = await page.locator("#divider").boundingBox();
    expect(box).not.toBeNull();
    const y = box!.y + box!.height / 2;
    const before = await page.locator("#left-pane").evaluate((el) => el.getBoundingClientRect().width);
    await page.mouse.move(box!.x + 2, y);
    await page.mouse.down();
    await page.mouse.move(box!.x + 122, y);
    await page.mouse.up();
    const after = await page.locator("#left-pane").evaluate((el) => el.getBoundingClientRect().width);
    expect(after - before).toBeGreaterThan(40);
  });
});
