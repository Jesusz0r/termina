import { test, expect } from "./fixtures.ts";

/**
 * Content search (find in files).
 *
 * The Search Contents modal jumps to a match; the Explorer keeps the grouped
 * listing persistently. Hit order is engine-dependent (ripgrep walks in
 * parallel), so every assertion addresses hits by file, never by position.
 */
test.describe("Content Search", () => {
  test("modal jumps to the match and Explorer lists it persistently", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    // Open the modal through the menu accelerator (View → Search File Contents).
    const chord = process.platform === "darwin" ? "Meta+Alt+f" : "Control+Alt+f";
    await page.keyboard.press(chord);
    const modal = page.locator(".search-modal");
    await expect(modal).toBeVisible();
    await expect(modal.locator(".modal-title")).toHaveText("Search Contents");

    await modal.locator(".search-input").fill("export");
    const hits = modal.locator(".search-hit");
    await expect(hits).toHaveCount(2, { timeout: 15_000 });
    await expect(hits.filter({ hasText: "greeting.ts:1" })).toHaveCount(1);
    await expect(hits.filter({ hasText: "index.ts:1" })).toHaveCount(1);
    await expect(hits.filter({ hasText: "greeting.ts:1" }).locator(".search-text")).toContainText("export const greeting");

    // Explorer mirrors the search grouped by file.
    const listing = page.locator("#explorer-content");
    await expect(listing).toBeVisible();
    await expect(page.locator("#explorer-content-title")).toContainText('2 matches for "export"');
    await expect(page.locator(".explorer-content-file")).toHaveCount(2);

    // Clicking the greeting hit jumps: the file opens with the cursor on the match.
    await hits.filter({ hasText: "greeting.ts:1" }).click();
    await expect(modal).toBeHidden();
    await expect(page.locator(".editor-tab").getByText("greeting.ts").first()).toBeVisible();
    const cursorLine = (): Promise<number | null> =>
      page.evaluate(() => {
        const mgr = (window as unknown as Record<string, unknown>).__editorMgr as
          | { editor?: { getPosition: () => { lineNumber: number } | null } }
          | undefined;
        return mgr?.editor?.getPosition()?.lineNumber ?? null;
      });
    await expect.poll(cursorLine, { timeout: 10_000 }).toBe(1);

    // The listing persists after the modal closes; clicking a hit jumps too.
    await expect(listing).toBeVisible();
    await page.locator('.explorer-content-hit[title="src/index.ts:1"]').click();
    await expect(page.locator(".editor-tab").getByText("index.ts").first()).toBeVisible();
    await expect.poll(cursorLine, { timeout: 10_000 }).toBe(1);

    // Re-run refreshes, clear dismisses.
    await page.locator("#explorer-content-rerun").click();
    await expect(page.locator("#explorer-content-title")).toContainText('2 matches for "export"');
    await expect(page.locator(".explorer-content-hit")).toHaveCount(2);
    await page.locator("#explorer-content-clear").click();
    await expect(listing).toBeHidden();
  });

  test("invalid patterns surface the validator error", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const chord = process.platform === "darwin" ? "Meta+Alt+f" : "Control+Alt+f";
    await page.keyboard.press(chord);
    const modal = page.locator(".search-modal");
    await expect(modal).toBeVisible();
    await modal.locator(".search-input").fill("(a+)+");
    await expect(modal.locator(".search-empty")).toContainText("unsafe regular expression", { timeout: 15_000 });
  });
});
