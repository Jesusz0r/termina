import { test, expect } from "./fixtures.ts";

test("minimized editor keeps a right rail; toggle restores it", async ({ page }) => {
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
  // Ensure the editor ends minimized regardless of boot state.
  const wasMinimized = await page.locator("#right-pane.minimized").count();
  if (wasMinimized === 0) {
    await page.locator("#btn-min-editor").click();
  }
  await expect(page.locator("#right-pane.minimized")).toHaveCount(1, { timeout: 10_000 });
  const probe = await page.evaluate(() => {
    const w = window.innerWidth;
    const right = document.querySelector("#right-pane")!.getBoundingClientRect();
    const cs = getComputedStyle(document.querySelector("#right-pane")!);
    const btn = document.querySelector("#btn-min-editor") as HTMLElement | null;
    const btnBox = btn?.getBoundingClientRect();
    const btnVisible = !!btn && !!btnBox && btnBox.width > 0 && btnBox.height > 0;
    return {
      w,
      rightWidth: Math.round(right.width),
      rightDisplay: cs.display,
      rightLeft: Math.round(right.left),
      btnVisible,
      btnLabel: btn?.getAttribute("aria-label") ?? null,
    };
  });
  // Slim restore rail on the right edge, not display:none.
  expect(probe.rightDisplay).not.toBe("none");
  expect(probe.rightWidth).toBeGreaterThanOrEqual(30);
  expect(probe.rightWidth).toBeLessThanOrEqual(40);
  expect(probe.rightLeft).toBeGreaterThanOrEqual(probe.w - 45);
  expect(probe.btnVisible).toBe(true);
  expect(probe.btnLabel).toMatch(/restore/i);
  // Toggle restores the editor.
  await page.locator("#btn-min-editor").click();
  await expect(page.locator("#right-pane.minimized")).toHaveCount(0, { timeout: 10_000 });
});
