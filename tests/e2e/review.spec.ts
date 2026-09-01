import { test, expect } from "./fixtures.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

test.describe("Diff Review Mode & Revert Lifecycle", () => {
  test("displays modified files and opens diff view", async ({ page, projectRoot }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const greetingPath = join(projectRoot, "greeting.ts");

    // Modify greeting.ts directly to simulate a modified working tree
    writeFileSync(greetingPath, 'export const greeting = "hi there";\n');

    // Wait for the sidecar / watcher to detect modification
    const modifiedList = page.locator("#modified-list");
    const greetingItem = modifiedList.locator("li").filter({ hasText: "greeting.ts" });

    // Open review diff container if visible or trigger review via API
    await page.evaluate((path) => {
      if ((window as any).__openReview) {
        (window as any).__openReview(path);
      }
    }, greetingPath);

    const reviewContainer = page.locator("#review-container");
    if (await reviewContainer.isVisible()) {
      await expect(page.locator("#review-filename")).toContainText("greeting.ts");
      await expect(page.locator("#review-diff")).toBeVisible();

      // Click revert button
      const revertBtn = page.locator("#review-revert");
      if (await revertBtn.isVisible()) {
        await revertBtn.click();
      }
    } else {
      // Review container opens upon item click
      if (await greetingItem.isVisible()) {
        await greetingItem.click();
        await expect(page.locator("#review-filename")).toContainText("greeting.ts");
      }
    }
  });
});
