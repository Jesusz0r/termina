import { test, expect } from "./fixtures.ts";

test.describe("Editor Tab Actions & Lifecycle", () => {
  test("supports preview replacement on single click and pinning on double click", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const explorer = page.locator("#explorer-tree");
    const greetingRow = explorer.locator(".explorer-row").filter({ hasText: "greeting.ts" });
    const helloRow = explorer.locator(".explorer-row").filter({ hasText: "hello.txt" });

    // Single click opens as preview
    await greetingRow.click();
    await expect(page.locator(".editor-tab .tab-name").getByText("greeting.ts")).toBeVisible();

    // Single click on second file replaces the preview tab
    await helloRow.click();
    await expect(page.locator(".editor-tab .tab-name").getByText("hello.txt")).toBeVisible();
    await expect(page.locator(".editor-tab .tab-name").getByText("greeting.ts")).toBeHidden();

    // Double click pins the tab
    await greetingRow.dblclick();
    await expect(page.locator(".editor-tab .tab-name").getByText("greeting.ts")).toBeVisible();

    // Opening another file now keeps the pinned tab open
    await helloRow.click();
    await expect(page.locator(".editor-tab .tab-name").getByText("greeting.ts")).toBeVisible();
    await expect(page.locator(".editor-tab .tab-name").getByText("hello.txt")).toBeVisible();
  });

  test("closes tabs via tab close button", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const explorer = page.locator("#explorer-tree");
    await explorer.locator(".explorer-row").filter({ hasText: "greeting.ts" }).dblclick();
    await explorer.locator(".explorer-row").filter({ hasText: "hello.txt" }).dblclick();

    const greetingTab = page.locator(".editor-tab").filter({ hasText: "greeting.ts" });
    await expect(greetingTab).toBeVisible();

    // Click close button on greeting tab
    await greetingTab.locator(".tab-close").click();
    await expect(greetingTab).toBeHidden();

    // hello.txt tab remains
    const helloTab = page.locator(".editor-tab").filter({ hasText: "hello.txt" });
    await expect(helloTab).toBeVisible();
  });

  test("context menu provides tab management actions", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const explorer = page.locator("#explorer-tree");
    await explorer.locator(".explorer-row").filter({ hasText: "greeting.ts" }).dblclick();
    await explorer.locator(".explorer-row").filter({ hasText: "hello.txt" }).dblclick();

    const greetingTab = page.locator(".editor-tab").filter({ hasText: "greeting.ts" });
    await greetingTab.click({ button: "right" });

    const contextMenu = page.locator(".context-menu");
    await expect(contextMenu).toBeVisible();

    // Context menu should contain standard actions
    await expect(contextMenu.getByText("Close", { exact: true })).toBeVisible();
    await expect(contextMenu.getByText("Close Others")).toBeVisible();
    await expect(contextMenu.getByText("Close All")).toBeVisible();

    // Click "Close Others"
    await contextMenu.getByText("Close Others").click();
    await expect(contextMenu).toBeHidden();

    // greeting.ts remains, hello.txt is closed
    await expect(page.locator(".editor-tab").filter({ hasText: "greeting.ts" })).toBeVisible();
    await expect(page.locator(".editor-tab").filter({ hasText: "hello.txt" })).toBeHidden();
  });
});
