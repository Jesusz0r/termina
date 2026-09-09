import { test, expect } from "./fixtures.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

  test("near-miss grab left of the explorer divider still resizes", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const before = await page.locator("#explorer").evaluate((el) => el.getBoundingClientRect().width);
    const box = await page.locator("#explorer-divider").boundingBox();
    expect(box).not.toBeNull();
    // 6px left of the divider lands on the tree (often a draggable file row):
    // without the capture redirect this starts a file drag, not a resize.
    const y = box!.y + 100;
    await page.mouse.move(box!.x - 6, y);
    await page.mouse.down();
    await page.mouse.move(box!.x + 74, y);
    await page.mouse.up();
    const after = await page.locator("#explorer").evaluate((el) => el.getBoundingClientRect().width);
    expect(after - before).toBeGreaterThan(40);
  });

  test("explorer tracks the pointer across projects with open and collapsed editors", async ({ page, runRoot }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    await page.locator("#explorer-tree").getByText("greeting.ts").click();
    await expect(page.locator(".editor-tab").getByText("greeting.ts")).toBeVisible();
    const other = join(runRoot, "resize-other");
    mkdirSync(other);
    writeFileSync(join(other, "other.txt"), "other\n".repeat(100));
    await page.evaluate((dir) => window.termina.projectOpenPath(dir), other);
    await expect(page.locator("#explorer-tree").getByText("other.txt")).toBeVisible();

    for (const project of ["resize-other", "test-project", "resize-other"]) {
      await page.locator(".project-tab").filter({ hasText: project }).click();
      await expect(page.locator(".project-tab.active")).toContainText(project);
      for (const width of [360, 180, 300]) {
        const box = (await page.locator("#explorer-divider").boundingBox())!;
        const main = (await page.locator("#main").boundingBox())!;
        await page.mouse.move(box.x + 2, box.y + 100);
        await page.mouse.down();
        await page.mouse.move(main.x + width, box.y + 100, { steps: 10 });
        await page.mouse.up();
        await expect.poll(() => page.locator("#explorer").evaluate((el) => el.getBoundingClientRect().width)).toBeCloseTo(width, 0);
      }
    }
    await page.locator("#explorer-tree").getByText("other.txt").click();
    await expect(page.locator(".editor-tab").getByText("other.txt")).toBeVisible();
    const box = (await page.locator("#explorer-divider").boundingBox())!;
    await page.mouse.move(box.x + 2, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(400, box.y + 100, { steps: 10 });
    await page.mouse.up();
    await expect.poll(() => page.locator("#explorer").evaluate((el) => el.getBoundingClientRect().width)).toBeCloseTo(400, 0);
  });

  test("project tab clicks above the divider do not start an explorer resize", async ({ page, runRoot }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const other = join(runRoot, "resize-other");
    mkdirSync(other);
    await page.evaluate((dir) => window.termina.projectOpenPath(dir), other);
    const firstTab = page.locator(".project-tab").filter({ hasText: "test-project" });
    const tabBox = (await firstTab.boundingBox())!;
    // Put the explorer divider under the first tab, away from its close button.
    const x = tabBox.x + tabBox.width - 40;
    await page.locator("#explorer").evaluate((el, width) => { el.style.width = `${width}px`; }, x - 2);
    const dividerBox = (await page.locator("#explorer-divider").boundingBox())!;
    expect(dividerBox.x + 2).toBeCloseTo(x, 0);
    const before = await page.locator("#explorer").evaluate((el) => el.getBoundingClientRect().width);
    await page.mouse.move(x, tabBox.y + tabBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(x + 10, tabBox.y + tabBox.height / 2, { steps: 3 });
    await page.mouse.up();
    await expect(firstTab).toHaveClass(/active/);
    expect(await page.locator("#explorer").evaluate((el) => el.getBoundingClientRect().width)).toBe(before);
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
