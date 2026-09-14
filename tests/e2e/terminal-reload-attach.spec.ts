import { test, expect } from "./fixtures.ts";
import type { Page } from "@playwright/test";

/**
 * Renderer reload reattaches the live in-process PTY (issue #292 Phase A).
 * Quanta already on the egress ledger replay; sidecar history does not.
 */

async function paneBuffer(page: Page, instanceId: string): Promise<string> {
  return page.evaluate((id) => {
    const w = window as unknown as {
      __panes: Map<string, {
        instanceId: string;
        view: { getTerminal: () => { buffer: { active: { length: number; getLine: (i: number) => { translateToString: (trim: boolean) => string } | undefined } } } };
      }>;
    };
    const pane = [...w.__panes.values()].find((p) => p.instanceId === id);
    const term = pane?.view.getTerminal();
    if (!term) return "";
    let text = "";
    for (let i = 0; i < term.buffer.active.length; i++) {
      text += term.buffer.active.getLine(i)?.translateToString(true) ?? "";
    }
    return text;
  }, instanceId);
}

test.describe("terminal reload attach (issue #292)", () => {
  test("renderer reload replays PTY quanta and does not replay sidecar history", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    await expect(page.locator("#terminal-container")).toBeVisible();

    const created = await page.evaluate(() => window.termina.createTerminal({ type: "shell" }));
    expect(created.ok).toBe(true);
    expect(created.id).toBeTruthy();
    const shellId = created.id!;

    await expect.poll(async () => {
      const list = await page.evaluate(() => window.termina.getInstances());
      return list.find((item) => item.id === shellId && item.generation > 0) ?? null;
    }, { timeout: 15_000 }).toBeTruthy();
    const before = (await page.evaluate(() => window.termina.getInstances())).find((item) => item.id === shellId)!;

    const marker = `RELOAD_ATTACH_${Date.now()}`;
    await page.evaluate(({ id, text }) => window.termina.writeTerminal(id, `printf '%s\\n' '${text}'\r`), {
      id: before.id,
      text: marker,
    });
    await expect.poll(() => paneBuffer(page, before.id), { timeout: 15_000 }).toContain(marker);

    await page.reload();
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    await expect(page.locator("#terminal-container")).toBeVisible();

    await expect.poll(async () => {
      const list = await page.evaluate(() => window.termina.getInstances());
      const shell = list.find((item) => item.id === before.id);
      if (!shell || shell.generation !== before.generation) return null;
      const text = await paneBuffer(page, before.id);
      return text.includes(marker) ? shell.generation : null;
    }, { timeout: 15_000 }).toBe(before.generation);
  });
});
