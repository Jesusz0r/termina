import { test, expect } from "./fixtures.ts";

test.describe("Termina Desktop Application Smoke Test", () => {
  test("launches Electron, hides splash, and renders project bar and explorer", async ({ page }) => {
    // Splash screen should be dismissed once the application is ready
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    // The main shell should be visible
    await expect(page.locator("#app")).toBeVisible();
    await expect(page.locator("#project-bar")).toBeVisible();
    await expect(page.locator("#explorer")).toBeVisible();
    await expect(page.locator("#terminal-container")).toBeVisible();
  });

  test("renders the explorer tree with initial project files", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const explorerTree = page.locator("#explorer-tree");
    await expect(explorerTree).toBeVisible();

    // Verify initial project files appear in the explorer
    await expect(explorerTree.getByText("greeting.ts")).toBeVisible({ timeout: 10_000 });
    await expect(explorerTree.getByText("hello.txt")).toBeVisible({ timeout: 10_000 });
  });

  test("clicking a file in the explorer opens it in an editor tab", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const greetingItem = page.locator("#explorer-tree").getByText("greeting.ts");
    await expect(greetingItem).toBeVisible({ timeout: 10_000 });
    await greetingItem.click();

    // The tab should now be created in the editor tab bar
    const editorTab = page.locator(".editor-tab").getByText("greeting.ts");
    await expect(editorTab).toBeVisible({ timeout: 10_000 });
  });
});
