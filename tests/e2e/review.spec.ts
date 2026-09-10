import { test, expect, type Page } from "./fixtures.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Change Review (diff view + revert).
 *
 * Entry point is the Modified list, which main populates only for a *busy*
 * terminal — and the pre-run baseline is captured at the same moment. So the
 * complete path (including a successful revert) needs a live agent run, which
 * this suite has no provider for.
 *
 * These tests therefore drive the renderer deterministically: seed the pane's
 * modified list through the `__panes` seam (the same one resize.spec.ts uses)
 * and re-render it by clicking the terminal tab, whose handler runs
 * activatePane -> renderChrome -> renderModified.
 *
 * Everything asserted here is unconditional. The one thing a run is required
 * for — reverting against a real baseline — is instead pinned from the refusal
 * side, so the guard cannot regress unnoticed.
 */

/** Seed the modified list of the active pane and re-render it. */
async function seedModified(
  page: Page,
  relPath: string,
  status: "created" | "modified" | "deleted" = "modified",
): Promise<string> {
  const absPath = await page.evaluate(({ relPath, status }) => {
    const w = window as unknown as Record<string, unknown>;
    const panes = w.__panes as Map<string, { error: boolean; exited: boolean; modified: unknown[] }>;
    const pane = [...panes.values()].find((p) => !p.error && !p.exited) ?? [...panes.values()][0]!;
    const root = document.querySelector<HTMLElement>("#explorer-tree [data-path]")!.dataset.path!;
    const abs = `${root}/${relPath}`;
    pane.modified = [{ path: abs, relPath, status }];
    return abs;
  }, { relPath, status });
  // A terminal-tab click runs activatePane -> renderChrome -> renderModified.
  // Unlike clicking Accept all, it re-renders without mutating pane state.
  await page.locator(".terminal-tab").first().click();
  return absPath;
}

test.describe("Diff Review Mode & Revert Lifecycle", () => {
  test("opens the diff view for a modified file and shows the real change", async ({ page, projectRoot }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const changed = 'export const greeting = "hi there";\n';
    writeFileSync(join(projectRoot, "greeting.ts"), changed);
    await seedModified(page, "greeting.ts");
    await page.locator(".activity-tab[data-tab='modified']").click();

    // The list itself must render the entry (previously never asserted).
    const row = page.locator("#modified-list li").filter({ hasText: "greeting.ts" });
    await expect(row).toBeVisible();
    await expect(row.locator(".status-badge")).toHaveText("M");

    await row.click();
    await expect(page.locator("#review-container")).toBeVisible();
    await expect(page.locator("#review-filename")).toHaveText("greeting.ts");
    await expect(page.locator("#review-diff")).toBeVisible();

    // Diff content comes from the live file, read through the review debug seam.
    const sides = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__reviewDebug as { original: string; modified: string },
    );
    expect(sides.modified).toContain("hi there");
    // No run baseline exists here, so the original side is empty.
    expect(sides.original).toBe("");

    // Back hides the review again.
    await page.locator("#review-back").click();
    await expect(page.locator("#review-container")).toBeHidden();
  });

  test("revert is refused without a run-captured baseline and leaves the file alone", async ({ page, projectRoot }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const changed = 'export const greeting = "hi there";\n';
    writeFileSync(join(projectRoot, "greeting.ts"), changed);
    const absPath = await seedModified(page, "greeting.ts");
    await page.locator(".activity-tab[data-tab='modified']").click();

    const row = page.locator("#modified-list li").filter({ hasText: "greeting.ts" });
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.locator("#review-container")).toBeVisible();

    // 1. The UI must not offer a revert it cannot perform: main only captured a
    //    baseline at run start, and no run happened.
    await expect(page.locator("#review-revert")).toBeDisabled();

    // 2. main refuses the operation too (the safety net behind that button).
    const refused = await page.evaluate(async (path) => {
      const w = window as unknown as Record<string, unknown> & {
        termina: { reviewRevert(terminalId: string, path: string): Promise<{ ok: boolean; error?: string }> };
        __panes: Map<string, { instanceId: string }>;
      };
      const pane = [...w.__panes.values()][0]!;
      return w.termina.reviewRevert(pane.instanceId, path);
    }, absPath);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("baseline");

    // 3. Nothing was written: the file still holds the changed content.
    expect(readFileSync(join(projectRoot, "greeting.ts"), "utf8")).toBe(changed);
  });
});
