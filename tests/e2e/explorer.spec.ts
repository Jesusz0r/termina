import { test, expect } from "./fixtures.ts";

test.describe("Explorer File Tree & Actions", () => {
  test("renders root directory and files with folder expansion", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const explorerTree = page.locator("#explorer-tree");
    await expect(explorerTree).toBeVisible();

    // Verify root files are visible
    await expect(explorerTree.getByText("greeting.ts")).toBeVisible();
    await expect(explorerTree.getByText("hello.txt")).toBeVisible();

    // Check directory "src"
    const srcFolder = explorerTree.locator(".explorer-row").filter({ hasText: "src" });
    await expect(srcFolder).toBeVisible();

    // Click src to toggle expansion
    await srcFolder.click();
    await expect(explorerTree.getByText("index.ts")).toBeVisible();
  });

  test("creates a new file through explorer context menu", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const explorerTree = page.locator("#explorer-tree");
    const rootRow = explorerTree.locator(".explorer-row").filter({ hasText: "test-project" });
    await rootRow.click({ button: "right" });

    const contextMenu = page.locator(".context-menu");
    await expect(contextMenu).toBeVisible();

    // Click "New File"
    await contextMenu.getByText("New File").click();

    // The modal should appear to name the file
    const input = page.locator(".modal input");
    await expect(input).toBeVisible();
    await input.fill("created-file.ts");
    await page.locator(".modal .modal-btn").filter({ hasText: "OK" }).click();

    // The new file should now be in the tree
    await expect(explorerTree.getByText("created-file.ts")).toBeVisible({ timeout: 10_000 });
  });

  test("opens file from explorer into editor on click", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const explorerTree = page.locator("#explorer-tree");
    const greeting = explorerTree.locator(".explorer-row").filter({ hasText: "greeting.ts" });
    await greeting.click();

    // Tab opens and becomes active
    const tab = page.locator(".editor-tab.active");
    await expect(tab).toBeVisible();
    await expect(tab.locator(".tab-name")).toHaveText("greeting.ts");
  });
});
