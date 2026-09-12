import { test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";

/**
 * Keyboard access to the left pane's two strip surfaces: the activity tab bar
 * (WAI-ARIA tabs with a roving tabindex) and the Session Timeline dots.
 *
 * Timeline dots only appear from a live agent run and this suite has no
 * provider, so the strip is seeded through the `__timelineView` seam main.ts
 * exposes — the same object main pushes real events into. Everything asserted
 * here is renderer behavior.
 */

/** Panel id per tab, to prove selection follows focus. */
const PANEL_ID: Record<string, string> = {
  timeline: "timeline-strip",
  plan: "plan-panel",
  worldlines: "worldline-panel",
  modified: "modified-panel",
};

async function seedDots(page: Page, count: number): Promise<void> {
  await page.evaluate((n: number) => {
    const view = (window as unknown as Record<string, unknown>).__timelineView as { setEvents(events: unknown[]): void };
    view.setEvents(
      Array.from({ length: n }, (_, i) => ({
        seq: i + 1,
        t: "tool",
        ts: Date.now() + i,
        toolName: "read_file",
        relPath: `file-${i + 1}.ts`,
      })),
    );
  }, count);
}

test.describe("keyboard panes", () => {
  test("activity tabs are a single tab stop with arrow navigation", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const bar = page.locator("#activity-tabbar");
    await expect(bar).toBeVisible();
    // Roving tabindex: the bar is one stop, not four.
    await expect(bar.locator(".activity-tab[tabindex='0']")).toHaveCount(1);
    await expect(page.locator("#activity-tab-timeline")).toHaveAttribute("aria-selected", "true");

    const visible = await bar
      .locator(".activity-tab:visible")
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-tab") ?? ""));
    const tab = (name: string) => page.locator(`#activity-tab-${name}`);

    // Arrows move along the visible tabs and the panel follows the focus.
    await tab("timeline").focus();
    await page.keyboard.press("ArrowRight");
    await expect(tab(visible[1])).toBeFocused();
    await expect(tab(visible[1])).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(`#${PANEL_ID[visible[1]]}`)).toBeVisible();

    // End reaches the last tab, and the arrows wrap around the ends.
    await page.keyboard.press("End");
    await expect(tab(visible[visible.length - 1])).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(tab(visible[0])).toBeFocused();
    await expect(page.locator(`#${PANEL_ID[visible[0]]}`)).toBeVisible();

    // The tab stop follows the selection, and stays unique.
    await expect(tab(visible[0])).toHaveAttribute("tabindex", "0");
    await expect(bar.locator(".activity-tab[tabindex='0']")).toHaveCount(1);
  });

  test("timeline dots are one toolbar stop with arrow selection", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    await seedDots(page, 3);
    const dots = page.locator("#timeline-dots .timeline-dot");
    await expect(dots).toHaveCount(3);
    await expect(page.locator("#timeline-dots")).toHaveAttribute("role", "toolbar");
    await expect(dots.first()).toHaveAttribute("role", "button");
    await expect(dots.first()).toHaveAttribute("aria-label", /read_file file-1\.ts/);

    // Tab enters the strip once, on the newest moment — never dot by dot.
    await expect(dots.last()).toHaveAttribute("tabindex", "0");
    await page.locator("#btn-timeline-play").focus();
    await page.keyboard.press("Tab");
    await expect(dots.last()).toBeFocused();

    // Arrows move the selection one moment at a time.
    await page.keyboard.press("ArrowLeft");
    await expect(dots.nth(1)).toBeFocused();
    await expect(dots.nth(1)).toHaveAttribute("aria-current", "true");
    await expect(dots.nth(1)).toHaveAttribute("tabindex", "0");

    // Home/End reach both ends; the arrows hold there instead of wrapping.
    await page.keyboard.press("Home");
    await expect(dots.nth(0)).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(dots.nth(0)).toBeFocused();
    await page.keyboard.press("End");
    await expect(dots.nth(2)).toBeFocused();

    // Escape stops a replay even after focus leaves the strip (snapshots
    // open in the editor). The terminal still owns the key.
    await page.locator("#btn-timeline-play").click();
    await expect(page.locator("#btn-timeline-play")).toHaveClass(/playing/);
    await page.locator("#terminal-container").click();
    await page.keyboard.press("Escape");
    await expect(page.locator("#btn-timeline-play")).toHaveClass(/playing/);
    await page.locator("#btn-min-editor").focus();
    await page.keyboard.press("Escape");
    await expect(page.locator("#btn-timeline-play")).not.toHaveClass(/playing/);
  });

  test("empty, single, and capped timeline strips stay one tab stop", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const dots = page.locator("#timeline-dots .timeline-dot");

    await seedDots(page, 0);
    await expect(dots).toHaveCount(0);

    await seedDots(page, 1);
    await expect(dots).toHaveCount(1);
    await expect(dots).toHaveAttribute("tabindex", "0");
    await dots.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(dots).toBeFocused();

    await seedDots(page, 400);
    await expect(dots).toHaveCount(400);
    await expect(page.locator("#timeline-dots .timeline-dot[tabindex='0']")).toHaveCount(1);
    await dots.last().focus();
    await page.keyboard.press("Home");
    await expect(dots.first()).toBeFocused();
    await page.keyboard.press("End");
    await expect(dots.last()).toBeFocused();
    await page.keyboard.press("Home");
    await expect(dots.first()).toBeFocused();

    // Cap eviction of the oldest (focused) moment must leave one tab stop.
    await page.evaluate(() => {
      const view = (window as unknown as Record<string, unknown>).__timelineView as { push(event: unknown): void };
      view.push({
        seq: 401,
        t: "tool",
        ts: Date.now(),
        toolName: "read_file",
        relPath: "file-401.ts",
      });
    });
    await expect(dots).toHaveCount(400);
    await expect(page.locator("#timeline-dots .timeline-dot[tabindex='0']")).toHaveCount(1);
    await expect(page.locator("#timeline-dots .timeline-dot[tabindex='0']")).toBeFocused();
  });
});
