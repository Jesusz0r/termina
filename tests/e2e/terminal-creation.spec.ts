import { test, expect } from "./fixtures.ts";

test("new shell tabs preserve every live terminal and remain reachable in a narrow pane", async ({ page, electronApp }) => {
  await expect(page.locator("#splash")).toBeHidden();
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(960, 800));
  const initial = await page.evaluate(() => window.termina.getInstances());
  expect(initial).toHaveLength(1);
  const liveIds = initial.map((instance) => instance.id);

  for (let count = 2; count <= 5; count++) {
    await page.locator("#btn-new-terminal").click();
    await page.locator(".terminal-menu-item").filter({ hasText: "interactive" }).first().click();
    await expect.poll(() => page.evaluate(() => window.termina.getInstances().then((list) => list.length))).toBe(count);
    const instances = await page.evaluate(() => window.termina.getInstances());
    expect(instances.map((instance) => instance.id)).toEqual(expect.arrayContaining(liveIds));
    const added = instances.find((instance) => !liveIds.includes(instance.id))!;
    expect(added.type).toBe("shell");
    liveIds.push(added.id);
    await expect(page.locator(".terminal-tab:visible")).toHaveCount(count);
    const tabState = () => page.evaluate((id) => {
      const panes = (window as unknown as { __panes: Map<string, { tabEl: HTMLElement }> }).__panes;
      const tab = panes.get(id)!.tabEl;
      const strip = document.getElementById("terminal-tabs-list")!;
      const box = tab.getBoundingClientRect();
      const bounds = strip.getBoundingClientRect();
      return { active: tab.classList.contains("active"), left: box.left, right: box.right,
        stripLeft: bounds.left, stripRight: bounds.right, scrollLeft: strip.scrollLeft,
        reachable: box.left >= bounds.left - 1 && box.right <= bounds.right + 1 };
    }, added.id);
    try { await expect.poll(tabState).toMatchObject({ active: true, reachable: true }); }
    catch (error) {
      await test.info().attach("terminal-tab-state", { body: JSON.stringify({ count, instances, tab: await tabState() }), contentType: "application/json" });
      await test.info().attach("terminal-tabs", { body: await page.screenshot(), contentType: "image/png" });
      throw error;
    }
  }

  for (const id of liveIds) {
    await page.evaluate((id) => {
      const panes = (window as unknown as { __panes: Map<string, { tabEl: HTMLElement }> }).__panes;
      panes.get(id)!.tabEl.click();
    }, id);
    await expect(page.locator(".terminal-tab.active")).toHaveCount(1);
    await expect.poll(() => page.locator(".terminal-tab.active").evaluate((tab) => {
      const box = tab.getBoundingClientRect();
      const bounds = tab.parentElement!.getBoundingClientRect();
      return box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
    })).toBe(true);
    if (id !== initial[0]!.id) {
      await page.evaluate((id) => window.termina.writeTerminal(id, `printf 'LIVE_%s\\n' '${id}'\r`), id);
      await expect.poll(() => page.evaluate((id) => {
        const panes = (window as unknown as { __panes: Map<string, {
          view: { getTerminal(): { buffer: { active: {
            length: number; getLine(index: number): { translateToString(trim: boolean): string } | undefined;
          } } } };
        }> }).__panes;
        const buffer = panes.get(id)!.view.getTerminal().buffer.active;
        return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? "").join("\n");
      }, id)).toContain(`LIVE_${id}`);
    }
  }
  expect((await page.evaluate(() => window.termina.getInstances())).map((instance) => instance.id)).toEqual(liveIds);
});
