import { test, expect } from "./fixtures.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

for (const kind of ["project", "terminal"] as const) {
  test(`${kind} tabs drag without a hold, keep a stable slot, and cancel cleanly`, async ({ page, runRoot }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    if (kind === "project") {
      for (const name of ["short", "longer-project-name"]) {
        const dir = join(runRoot, name);
        mkdirSync(dir);
        await page.evaluate((path) => window.termina.projectOpenPath(path), dir);
      }
    } else {
      for (let count = 2; count <= 3; count++) {
        await page.locator("#btn-new-terminal").click();
        await page.locator(".terminal-menu-item").filter({ hasText: "interactive" }).first().click();
        await expect(page.locator(".terminal-tab:visible")).toHaveCount(count);
      }
    }
    const strip = page.locator(kind === "project" ? "#project-tabs" : "#terminal-tabs-list");
    const tabs = strip.locator(`.${kind}-tab:visible`);
    await expect(tabs).toHaveCount(3);
    // Stable identities let us assert DOM order independently of tab labels/status.
    await tabs.evaluateAll((elements) => elements.forEach((el, i) => el.setAttribute("data-reorder-test", String(i))));
    const order = () => tabs.evaluateAll((elements) => elements.map((el) => el.getAttribute("data-reorder-test")));
    await expect(tabs.first()).toHaveCSS("cursor", "default");
    const first = (await tabs.first().boundingBox())!;
    const last = (await tabs.last().boundingBox())!;
    const x = first.x + 15;
    const y = first.y + first.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 10, y);
    await expect(page.locator(".tab-grabbed")).toHaveCount(1);
    await expect(strip).toHaveCSS("cursor", "grabbing");
    const lifted = await page.locator(".tab-grabbed").evaluate((el) => parseFloat((el as HTMLElement).style.left));
    expect(lifted).toBeCloseTo(first.x + 10, 0);
    const target = last.x + last.width - 5;
    await page.mouse.move(target, y);
    const slotIndex = () => strip.locator(".tab-drop-slot").evaluate((el) => [...el.parentElement!.children].indexOf(el));
    const settledIndex = await slotIndex();
    await page.waitForTimeout(180); // Let the neighbor slide animation finish.
    await page.mouse.move(target - 1, y);
    expect(await slotIndex()).toBe(settledIndex);
    await page.mouse.up();
    await expect.poll(order).toEqual(["1", "2", "0"]);
    await expect(page.locator(".tab-grabbed, .tab-drop-slot")).toHaveCount(0);
    await expect(tabs.first()).toHaveCSS("cursor", "default");

    // Escape restores the original order, and must not swallow the next click.
    const box = (await tabs.first().boundingBox())!;
    await page.mouse.move(box.x + 15, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(target, y);
    await expect(page.locator(".tab-grabbed")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect.poll(order).toEqual(["1", "2", "0"]);
    await tabs.first().click();
    await expect(tabs.first()).toHaveClass(/active/);

    // Losing focus while dragging must restore the tab and cursor too.
    await page.mouse.move(box.x + 15, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(target, y);
    await expect(page.locator(".tab-grabbed")).toHaveCount(1);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.mouse.up();
    await expect.poll(order).toEqual(["1", "2", "0"]);
    await expect(page.locator(".tab-grabbed, .tab-drop-slot")).toHaveCount(0);
    await expect(tabs.first()).toHaveCSS("cursor", "default");

    // Capture can be lost independently of pointerup (for example by another control).
    await strip.evaluate((el) => el.addEventListener("gotpointercapture", (event) => {
      el.releasePointerCapture((event as PointerEvent).pointerId);
    }, { once: true }));
    await page.mouse.move(box.x + 15, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(target, y);
    await page.mouse.move(target - 1, y);
    await page.mouse.move(target - 2, y);
    await page.mouse.up();
    await expect.poll(order).toEqual(["1", "2", "0"]);
    await expect(page.locator(".tab-grabbed, .tab-drop-slot")).toHaveCount(0);

    // Reordering back to the beginning exercises leftward movement as well.
    const endTab = (await tabs.last().boundingBox())!;
    await page.mouse.move(endTab.x + 15, endTab.y + endTab.height / 2);
    await page.mouse.down();
    await page.mouse.move(first.x + 2, y);
    await page.mouse.up();
    await expect.poll(order).toEqual(["0", "1", "2"]);
    await tabs.first().click();
    await expect(tabs.first()).toHaveClass(/active/);
    await tabs.first().locator(".tab-close").click();
    await expect(tabs).toHaveCount(2);
    await expect(page.locator(".tab-grabbed, .tab-drop-slot")).toHaveCount(0);
  });
}
