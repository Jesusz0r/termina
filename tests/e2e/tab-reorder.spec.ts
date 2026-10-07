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
    const vertical = kind === "project";
    const axis = vertical ? "y" : "x";
    const size = vertical ? "height" : "width";
    const cross = vertical ? first.x + 15 : first.y + first.height / 2;
    const moveTo = (position: number) => page.mouse.move(vertical ? cross : position, vertical ? position : cross);
    await moveTo(first[axis] + 15);
    await page.mouse.down();
    await moveTo(first[axis] + 25);
    await expect(page.locator(".tab-grabbed")).toHaveCount(1);
    await expect(strip).toHaveCSS("cursor", "grabbing");
    const lifted = await page.locator(".tab-grabbed").evaluate((el, vertical) => {
      const style = (el as HTMLElement).style;
      return parseFloat(vertical ? style.top : style.left);
    }, vertical);
    expect(lifted).toBeCloseTo(first[axis] + 10, 0);
    const target = last[axis] + last[size] - 5;
    await moveTo(target);
    const slotIndex = () => strip.locator(".tab-drop-slot").evaluate((el) => [...el.parentElement!.children].indexOf(el));
    const settledIndex = await slotIndex();
    await page.waitForTimeout(180); // Let the neighbor slide animation finish.
    await moveTo(target - 1);
    expect(await slotIndex()).toBe(settledIndex);
    await page.mouse.up();
    await expect.poll(order).toEqual(["1", "2", "0"]);
    await expect(page.locator(".tab-grabbed, .tab-drop-slot")).toHaveCount(0);
    await expect(tabs.first()).toHaveCSS("cursor", "default");

    // Escape restores the original order, and must not swallow the next click.
    const box = (await tabs.first().boundingBox())!;
    await moveTo(box[axis] + 15);
    await page.mouse.down();
    await moveTo(target);
    await expect(page.locator(".tab-grabbed")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect.poll(order).toEqual(["1", "2", "0"]);
    await tabs.first().click();
    await expect(tabs.first()).toHaveClass(/active/);

    // Losing focus while dragging must restore the tab and cursor too.
    await moveTo(box[axis] + 15);
    await page.mouse.down();
    await moveTo(target);
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
    await moveTo(box[axis] + 15);
    await page.mouse.down();
    await moveTo(target);
    await moveTo(target - 1);
    await moveTo(target - 2);
    await page.mouse.up();
    await expect.poll(order).toEqual(["1", "2", "0"]);
    await expect(page.locator(".tab-grabbed, .tab-drop-slot")).toHaveCount(0);

    // The horizontal strip can scroll when the first tab is selected. Bring
    // the last tab into view and measure this gesture's current coordinates.
    await tabs.last().scrollIntoViewIfNeeded();
    const startTab = (await tabs.first().boundingBox())!;
    const endTab = (await tabs.last().boundingBox())!;
    await moveTo(endTab[axis] + 15);
    await page.mouse.down();
    await moveTo(startTab[axis] + 2);
    await expect(page.locator(".tab-grabbed")).toHaveCount(1);
    await page.mouse.up();
    await expect.poll(order).toEqual(["0", "1", "2"]);
    await tabs.first().click();
    await expect(tabs.first()).toHaveClass(/active/);
    await tabs.first().locator(".tab-close").click();
    await expect(tabs).toHaveCount(2);
    await expect(page.locator(".tab-grabbed, .tab-drop-slot")).toHaveCount(0);
  });
}
