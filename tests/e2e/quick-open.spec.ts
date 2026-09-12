import { test, expect } from "./fixtures.ts";

/**
 * Quick Open polish: matched-character highlighting, reveal-in-explorer on
 * open, and recent-files-first for an empty query.
 */
async function focusEditor(page: any): Promise<void> {
  // Since #68, Ctrl+P with a focused core terminal cycles models; Quick Open
  // answers the chord only from other surfaces. Open a file and take editor
  // focus so the chord reaches the menu.
  await page.locator("#explorer-tree .explorer-row").filter({ hasText: "greeting.ts" }).dblclick();
  await expect(page.locator(".editor-tab .tab-name").getByText("greeting.ts")).toBeVisible();
  await page.evaluate(() => (window as any).__editorMgr?.focusEditor?.());
  await expect.poll(() => page.evaluate(() => (window as any).__editorMgr?.editor?.hasTextFocus?.() ?? null), { timeout: 5_000 }).toBe(true);
}

test.describe("Quick Open polish", () => {
  test("highlights the matched characters in each hit", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    await focusEditor(page);

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
    await focusEditor(page);

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
    await focusEditor(page);

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

/**
 * Accelerator scope (#68): a focused core TUI owns Ctrl+P (next model) and
 * Ctrl+R (history search). The menu blanks those chords so they reach the
 * pty instead of opening Quick Open or reloading the window.
 */
test.describe("Quick Open accelerator scope", () => {
  test("yields Ctrl+P and Ctrl+R to a focused core terminal", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    // Focus the terminal through the real path, then settle the async menu
    // scope before pressing TUI chords: the polled report only proves the
    // renderer sent it, while the awaited invoke proves main rebuilt the menu.
    await page.locator("#terminal-container").click();
    await expect.poll(() => page.evaluate(() => (window as any).__terminalFocusScope?.() ?? null), { timeout: 5_000 }).toBe(true);
    await page.evaluate(() => window.termina.setTerminalFocus(true));

    // Ctrl+P cycles models in the TUI; the menu must not surface Quick Open.
    // Negative assertion: give a stolen chord time to open the modal.
    const modal = page.locator(".search-modal");
    await page.keyboard.press("Control+p");
    await page.waitForTimeout(500);
    await expect(modal).toBeHidden();

    // Ctrl+R searches prompt history; the window must not reload.
    await page.evaluate(() => { (window as any).__noReloadMarker = 1; });
    await page.keyboard.press("Control+r");
    await page.waitForTimeout(500);
    await expect(modal).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as any).__noReloadMarker ?? null)).toBe(1);
  });
});
