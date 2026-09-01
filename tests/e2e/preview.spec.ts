import { test, expect } from "./fixtures.ts";

test.describe("Editor Tab Preview & Pinning Lifecycle", () => {
  test("single-click opens a preview tab and subsequent clicks replace it", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const explorerTree = page.locator("#explorer-tree");
    const helloFile = explorerTree.locator(".explorer-row").filter({ hasText: "hello.txt" });
    const greetingFile = explorerTree.locator(".explorer-row").filter({ hasText: "greeting.ts" });

    // 1. click hello.txt -> one preview tab
    await helloFile.click();
    const tabs = page.locator(".editor-tab");
    await expect(tabs).toHaveCount(1);
    await expect(tabs.first().locator(".tab-name")).toHaveText("hello.txt");
    await expect(tabs.first()).toHaveClass(/preview/);

    // 2. click greeting.ts -> replaces the preview tab (still 1 tab)
    await greetingFile.click();
    await expect(tabs).toHaveCount(1);
    await expect(tabs.first().locator(".tab-name")).toHaveText("greeting.ts");
    await expect(tabs.first()).toHaveClass(/preview/);
  });

  test("double-clicking or editing pins the preview tab", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const explorerTree = page.locator("#explorer-tree");
    const greetingFile = explorerTree.locator(".explorer-row").filter({ hasText: "greeting.ts" });
    const helloFile = explorerTree.locator(".explorer-row").filter({ hasText: "hello.txt" });

    // Double-click to pin
    await greetingFile.dblclick();
    const tabs = page.locator(".editor-tab");
    await expect(tabs).toHaveCount(1);
    await expect(tabs.first()).not.toHaveClass(/preview/);

    // Opening another file opens a second preview tab alongside the pinned tab
    await helloFile.click();
    await expect(tabs).toHaveCount(2);
    await expect(tabs.filter({ hasText: "greeting.ts" })).not.toHaveClass(/preview/);
    await expect(tabs.filter({ hasText: "hello.txt" })).toHaveClass(/preview/);
  });
});
