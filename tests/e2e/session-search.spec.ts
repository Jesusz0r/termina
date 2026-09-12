import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures.ts";

/** Project-scoped core session dir, mirroring main's sanitizeSessionDir. */
function expectedCoreDir(runRoot: string, projectRoot: string): string {
  const canonical = realpathSync(projectRoot);
  const slug = `--${canonical.replace(/^[/\\]+/, "").replace(/[/\\]+$/, "").replace(/[/\\:]/g, "-")}--`;
  return join(runRoot, "user-data", "agent-sessions", slug);
}

function messageLine(storageSeq: number, content: string): string {
  return `${JSON.stringify({ storageSeq, type: "message", message: { role: "user", content } })}\n`;
}

test.describe("Session Search Modal & Search Query E2E", () => {
  test("opens session search modal, inputs query, and closes cleanly", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    // Open session search modal
    await page.evaluate(() => {
      const search = (window as any).__sessionSearch;
      if (search) search.open();
    });

    const modal = page.locator(".search-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });

    const input = modal.locator(".search-input");
    await expect(input).toBeVisible();

    // Type query
    await input.fill("compute");

    // Results container should be attached
    const results = modal.locator(".search-results");
    await expect(results).toBeAttached();

    // Close on Escape
    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
  });

  test("surfaces listing errors instead of a silent empty", async ({ page, runRoot, projectRoot }) => {
    test.skip(process.platform === "win32" || process.getuid?.() === 0, "chmod isolation needs POSIX non-root");
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const coreDir = expectedCoreDir(runRoot, projectRoot);
    mkdirSync(coreDir, { recursive: true });
    chmodSync(coreDir, 0o000);
    try {
      await page.evaluate(() => {
        const search = (window as any).__sessionSearch;
        if (search) search.open();
      });
      const modal = page.locator(".search-modal");
      await expect(modal).toBeVisible({ timeout: 5_000 });
      await modal.locator(".search-input").fill("compute");
      const empty = modal.locator(".search-empty");
      await expect(empty.first()).toContainText("session listing uncertain", { timeout: 15_000 });
      await expect(modal.locator(".search-results")).not.toContainText("No matches.");
    } finally {
      chmodSync(coreDir, 0o700);
      await page.keyboard.press("Escape");
    }
  });

  test("navigates hits with arrows and opens with enter", async ({ page, runRoot, projectRoot }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const coreDir = expectedCoreDir(runRoot, projectRoot);
    const current = join(coreDir, "e2e-search-bundle", "current");
    mkdirSync(current, { recursive: true });
    writeFileSync(
      join(current, "session.jsonl"),
      messageLine(1, "e2e53marker greeting.ts") + messageLine(2, "e2e53marker hello world"),
    );

    await page.evaluate(() => {
      const search = (window as any).__sessionSearch;
      if (search) search.open();
    });
    const modal = page.locator(".search-modal");
    await expect(modal).toBeVisible({ timeout: 5_000 });
    await modal.locator(".search-input").fill("e2e53marker");

    const hits = modal.locator(".search-hit");
    await expect(hits).toHaveCount(2, { timeout: 15_000 });
    await expect(hits.first().locator(".search-path")).toHaveText("greeting.ts");
    await expect(hits.nth(1).locator(".search-no-file")).toHaveText("no linked file");

    // First hit starts selected; arrows move the selection.
    await expect(hits.first()).toHaveClass(/selected/);
    await page.keyboard.press("ArrowDown");
    await expect(hits.nth(1)).toHaveClass(/selected/);
    await expect(hits.first()).not.toHaveClass(/selected/);

    // Enter on a hit without a file keeps the modal open.
    await page.keyboard.press("Enter");
    await expect(modal).toBeVisible();

    await page.keyboard.press("ArrowUp");
    await expect(hits.first()).toHaveClass(/selected/);
    await page.keyboard.press("Enter");
    await expect(modal).toBeHidden();
    await expect(page.locator(".editor-tab").getByText("greeting.ts").first()).toBeVisible({ timeout: 10_000 });
  });
});
