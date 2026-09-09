import { test, expect } from "./fixtures.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test.describe("Multi-Project Tabs & Workspace Switching", () => {
  test("opens multiple projects and switches between them", async ({ page, runRoot }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const projA = join(runRoot, "multiproj-a");
    const projB = join(runRoot, "multiproj-b");

    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });

    writeFileSync(join(projA, "file-in-a.txt"), "hello from A\n");
    writeFileSync(join(projB, "file-in-b.txt"), "hello from B\n");

    // Initially one project is open from the fixture
    const initialTabs = page.locator(".project-tab");
    await expect(initialTabs).toHaveCount(1);

    // Open project A
    await page.evaluate((dir) => (window as any).termina.projectOpenPath(dir), projA);
    await expect(page.locator(".project-tab")).toHaveCount(2, { timeout: 10_000 });
    await expect(page.locator("#explorer-tree").getByText("file-in-a.txt")).toBeVisible({ timeout: 10_000 });

    // Open project B
    await page.evaluate((dir) => (window as any).termina.projectOpenPath(dir), projB);
    await expect(page.locator(".project-tab")).toHaveCount(3, { timeout: 10_000 });
    await expect(page.locator("#explorer-tree").getByText("file-in-b.txt")).toBeVisible({ timeout: 10_000 });

    // Switch back to project A by clicking its tab
    const tabA = page.locator(".project-tab").filter({ hasText: "multiproj-a" });
    await tabA.click();
    await expect(tabA).toHaveClass(/active/);
    await expect(page.locator("#explorer-tree").getByText("file-in-a.txt")).toBeVisible({ timeout: 10_000 });

    // Close project B via its tab close button
    const tabB = page.locator(".project-tab").filter({ hasText: "multiproj-b" });
    await tabB.locator(".tab-close").click();
    await expect(page.locator(".project-tab")).toHaveCount(2);
  });

  test("editor collapse on an empty project does not stick to a project with open tabs", async ({ page, runRoot }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const projA = join(runRoot, "collapse-a");
    const projB = join(runRoot, "collapse-b");
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });
    writeFileSync(join(projA, "file-in-a.txt"), "hello from A\n");

    await page.evaluate((dir) => (window as any).termina.projectOpenPath(dir), projA);
    const tabA = page.locator(".project-tab").filter({ hasText: "collapse-a" });
    await expect(tabA).toHaveClass(/active/, { timeout: 10_000 });
    await page.locator("#explorer-tree").getByText("file-in-a.txt").click();
    await expect(page.locator(".editor-tab").getByText("file-in-a.txt")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#right-pane.minimized")).toHaveCount(0);

    // B has no open files, so the editor auto-collapses when it activates.
    await page.evaluate((dir) => (window as any).termina.projectOpenPath(dir), projB);
    const tabB = page.locator(".project-tab").filter({ hasText: "collapse-b" });
    await expect(tabB).toHaveClass(/active/, { timeout: 10_000 });
    await expect(page.locator("#right-pane.minimized")).toHaveCount(1);

    // Back to A: the open tab restores the editor instead of staying a bar.
    await tabA.click();
    await expect(tabA).toHaveClass(/active/, { timeout: 10_000 });
    await expect(page.locator("#right-pane.minimized")).toHaveCount(0);
    await expect(page.locator(".editor-tab").getByText("file-in-a.txt")).toBeVisible({ timeout: 10_000 });
  });
});
