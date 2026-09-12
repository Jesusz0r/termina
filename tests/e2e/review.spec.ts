import { test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
 * Everything asserted here is unconditional. A live agent run is still out of
 * reach (no provider), but main's baseline capture does not need one: the
 * success test appends the exact `tool` record the engine emits at edit start
 * to the terminal's sidecar file, and the tailer delivers it through the real
 * path — baseline capture, review UI, revert, baseline consumed. The refusal
 * side stays pinned too, so the guard cannot regress unnoticed.
 */

/** Seed the modified list of the active pane and re-render it. */
async function seedModified(
  page: Page,
  relPath: string,
  status: "created" | "modified" | "deleted" = "modified",
): Promise<string> {
  const absPath = await page.evaluate(({ relPath, status }: { relPath: string; status: "created" | "modified" | "deleted" }) => {
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

    // Escape dismisses the diff, but never out of the terminal: there the key
    // belongs to the pty (shell or agent TUI).
    await page.locator("#terminal-container").click();
    await page.keyboard.press("Escape");
    await expect(page.locator("#review-container")).toBeVisible();

    await page.locator("#review-back").focus();
    await page.keyboard.press("Escape");
    await expect(page.locator("#review-container")).toBeHidden();

    // Reopening works after a keyboard dismissal.
    await row.click();
    await expect(page.locator("#review-container")).toBeVisible();

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

  test("revert restores the baseline captured from a tool event", async ({ page, projectRoot, runRoot }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });

    const original = 'export const greeting = "hello";\n';
    const changed = 'export const greeting = "hi there";\n';
    expect(readFileSync(join(projectRoot, "greeting.ts"), "utf8")).toBe(original);
    writeFileSync(join(projectRoot, "greeting.ts"), changed);

    // The active pane's terminal id plus the absolute path, resolved the same
    // way seedModified resolves it (explorer root + rel path).
    const target = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const panes = w.__panes as Map<string, { instanceId: string; error: boolean; exited: boolean }>;
      const pane = [...panes.values()].find((p) => !p.error && !p.exited) ?? [...panes.values()][0]!;
      const root = document.querySelector<HTMLElement>("#explorer-tree [data-path]")!.dataset.path!;
      return { instanceId: pane.instanceId, absPath: `${root}/greeting.ts` };
    });

    // The exact sidecar record the engine emits at edit start: main captures
    // the pre-edit baseline by reversing the landed edit. No provider needed —
    // the tailer delivers this the same way it delivers a real run's events.
    const eventsDir = join(runRoot, "events");
    mkdirSync(eventsDir, { recursive: true });
    appendFileSync(
      join(eventsDir, `${target.instanceId}.jsonl`),
      JSON.stringify({
        bridgeId: "e2e-change-review",
        seq: 1,
        t: "tool",
        toolName: "edit",
        path: target.absPath,
        edits: [{ oldText: '"hello"', newText: '"hi there"' }],
        toolCallId: "e2e-change-review-1",
      }) + "\n",
    );

    // 1. main captured the baseline: the original content, reconstructed from
    //    the changed file and the edit regions.
    const baselineOf = (): Promise<{ status: string; baseline?: string | null }> =>
      page.evaluate(async ({ instanceId, absPath }: { instanceId: string; absPath: string }) => {
        const w = window as unknown as Record<string, unknown> & {
          termina: { reviewBaseline(terminalId: string, path: string): Promise<{ status: string; baseline?: string | null }> };
        };
        return w.termina.reviewBaseline(instanceId, absPath);
      }, target);
    await expect.poll(async () => (await baselineOf()).baseline, { timeout: 15_000 }).toBe(original);

    // 2. The review UI offers the revert it can now perform, against the real baseline.
    await seedModified(page, "greeting.ts");
    await page.locator(".activity-tab[data-tab='modified']").click();
    const row = page.locator("#modified-list li").filter({ hasText: "greeting.ts" });
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.locator("#review-container")).toBeVisible();
    await expect(page.locator("#review-revert")).toBeEnabled();
    const sides = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__reviewDebug as { original: string; modified: string },
    );
    expect(sides.original).toBe(original);
    expect(sides.modified).toContain("hi there");

    // 3. Reverting restores the file to the baseline.
    await page.locator("#review-revert").click();
    await expect.poll(() => readFileSync(join(projectRoot, "greeting.ts"), "utf8"), { timeout: 10_000 }).toBe(original);

    // 4. The baseline is consumed: a second revert is refused and the file is untouched.
    const again = await page.evaluate(async ({ instanceId, absPath }: { instanceId: string; absPath: string }) => {
      const w = window as unknown as Record<string, unknown> & {
        termina: { reviewRevert(terminalId: string, path: string): Promise<{ ok: boolean; error?: string }> };
      };
      return w.termina.reviewRevert(instanceId, absPath);
    }, target);
    expect(again.ok).toBe(false);
    expect(again.error).toContain("baseline");
    expect(readFileSync(join(projectRoot, "greeting.ts"), "utf8")).toBe(original);
  });
});
