import { test, expect } from "./fixtures.ts";

/**
 * Quick Open polish: matched-character highlighting, reveal-in-explorer on
 * open, and recent-files-first for an empty query.
 */
test.describe("Quick Open polish", () => {
  test("highlights the matched characters in each hit", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const chord = process.platform === "darwin" ? "Meta+p" : "Control+p";
    await page.keyboard.press(chord);
    const modal = page.locator(".search-modal");
    await expect(modal).toBeVisible();
    await expect(modal.locator(".modal-title")).toHaveText("Quick Open");

    await modal.locator(".search-input").fill("greet");
    const hits = modal.locator(".search-hit");
    await expect(hits).toHaveCount(1, { timeout: 15_000 });
    // One consecutive run renders as one mark, in both the label and the path.
    await expect(hits.first().locator(".search-text mark")).toHaveText("greet");
    await expect(hits.first().locator(".search-path mark")).toHaveText("greet");
  });

  test("opening a file reveals it in the explorer", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const chord = process.platform === "darwin" ? "Meta+p" : "Control+p";
    await page.keyboard.press(chord);
    const modal = page.locator(".search-modal");
    await expect(modal).toBeVisible();

    // src/index.ts starts unmounted (src is collapsed); opening it must
    // expand the ancestor and select the row without stealing editor focus.
    await modal.locator(".search-input").fill("index");
    const hits = modal.locator(".search-hit");
    await expect(hits).toHaveCount(1, { timeout: 15_000 });
    await hits.first().click();
    await expect(modal).toBeHidden();
    await expect(page.locator(".editor-tab").getByText("index.ts").first()).toBeVisible();

    const row = page.locator('.explorer-row[data-rel-path="src/index.ts"]');
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('.explorer-row[data-rel-path="src"]')).toHaveAttribute("aria-expanded", "true");
  });

  test("empty query leads with recently opened files", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    // Open two files through the modal so the full record path runs.
    const chord = process.platform === "darwin" ? "Meta+p" : "Control+p";
    for (const query of ["greet", "hello"]) {
      await page.keyboard.press(chord);
      const modal = page.locator(".search-modal");
      await expect(modal).toBeVisible();
      await modal.locator(".search-input").fill(query);
      const hits = modal.locator(".search-hit");
      await expect(hits).toHaveCount(1, { timeout: 15_000 });
      await hits.first().click();
      await expect(modal).toBeHidden();
    }

    // Wait for main to persist both recents before asserting order.
    const recents = (): Promise<string[]> =>
      page.evaluate(async () => (await window.termina.getPreferences()).recentFiles.map((f) => f.relPath));
    await expect.poll(recents, { timeout: 10_000 }).toEqual(["hello.txt", "greeting.ts"]);

    const rels = (): Promise<string[]> =>
      page.evaluate(async () => (await window.termina.searchFiles("")).entries.map((e) => e.relPath));
    await expect.poll(rels, { timeout: 10_000 }).toEqual(["hello.txt", "greeting.ts", "src/index.ts"]);
  });
});
