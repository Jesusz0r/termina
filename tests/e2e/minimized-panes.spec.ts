import { test, expect } from "./fixtures.ts";

test("minimized editor leaves no right rail; terminal owns full width", async ({ page }) => {
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
  // Ensure the editor ends minimized regardless of boot state.
  const wasMinimized = await page.locator("#right-pane.minimized").count();
  if (wasMinimized === 0) {
    await page.locator("#btn-min-editor").click();
  }
  await expect(page.locator("#right-pane.minimized")).toHaveCount(1, { timeout: 10_000 });
  const probe = await page.evaluate(() => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const el = document.elementFromPoint(w - 4, Math.floor(h / 2));
    const chain: string[] = [];
    let cur: Element | null = el;
    while (cur && chain.length < 6) {
      chain.push(cur.id ? `#${cur.id}` : cur.className ? `.${String(cur.className).split(" ")[0]}` : cur.tagName);
      cur = cur.parentElement;
    }
    const left = document.querySelector("#left-pane")!.getBoundingClientRect();
    const cs = getComputedStyle(document.querySelector("#right-pane")!);
    return { w, edgeEl: chain, leftRight: Math.round(left.right), rightDisplay: cs.display };
  });
  expect(probe.rightDisplay).toBe("none");
  expect(probe.leftRight).toBeGreaterThanOrEqual(probe.w - 1);
});
