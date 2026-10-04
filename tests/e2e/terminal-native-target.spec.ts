import { test, expect, type TerminaE2EFixtures } from "./fixtures.ts";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { quoteShellArg } from "../../shared/terminal-control.ts";

async function nativeAction(app: TerminaE2EFixtures["electronApp"], label: string): Promise<void> {
  await app.evaluate(({ Menu, BrowserWindow }, label) => {
    const terminal = Menu.getApplicationMenu()?.items.find((item) => item.label === "Terminal");
    const action = terminal?.submenu?.items.find((item) => item.label === label);
    if (!action) throw new Error(`native action not found: ${label}`);
    action.click(undefined, BrowserWindow.getAllWindows()[0], {});
  }, label);
}

async function shell(page: TerminaE2EFixtures["page"]) {
  const result = await page.evaluate(() => window.termina.createTerminal({ type: "shell" }));
  expect(result.ok).toBe(true);
  const id = result.id!;
  await expect.poll(() => page.evaluate((id) =>
    window.termina.getInstances().then((instances) => instances.find((instance) => instance.id === id)?.generation), id)).toBeGreaterThan(0);
  const instance = await page.evaluate((id) =>
    window.termina.getInstances().then((instances) => instances.find((instance) => instance.id === id)!), id);
  return instance;
}

async function selectPane(page: TerminaE2EFixtures["page"], id: string): Promise<void> {
  // Use the real tab callback; the immutable bridge is not replaced.
  await page.evaluate((id) => {
    const panes = (window as unknown as { __panes: Map<string, { tabEl: HTMLElement }> }).__panes;
    panes.get(id)!.tabEl.click();
  }, id);
}

test("native interrupt and close target the first selected terminal, not the last created", async ({ page, electronApp, projectRoot }) => {
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
  const first = await shell(page);
  const second = await shell(page);
  for (const instance of [first, second]) {
    const script = `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(join(projectRoot, `${instance.id}-ready`))},'ready'); process.on('SIGINT',()=>{fs.writeFileSync(${JSON.stringify(join(projectRoot, `${instance.id}-interrupted`))},'interrupted');process.exit(0)});setInterval(()=>{},1000)`;
    await page.evaluate(({ id, command }) => window.termina.writeTerminal(id, command), {
      id: instance.id, command: `node -e ${quoteShellArg(script)}\r`,
    });
    await expect.poll(() => existsSync(join(projectRoot, `${instance.id}-ready`))).toBe(true);
  }
  await selectPane(page, first.id);
  // This invoke is an ordering barrier after the tab's real selection report.
  await page.evaluate(() => window.termina.getInstances());
  await nativeAction(electronApp, "Send Ctrl+C (abort)");
  await expect.poll(() => existsSync(join(projectRoot, `${first.id}-interrupted`))).toBe(true);
  expect(existsSync(join(projectRoot, `${second.id}-interrupted`))).toBe(false);
  await nativeAction(electronApp, "Close Terminal");
  await expect.poll(() => page.evaluate(() => window.termina.getInstances().then((instances) => instances.map((instance) => instance.id))))
    .not.toContain(first.id);
  expect(await page.evaluate(() => window.termina.getInstances().then((instances) => instances.map((instance) => instance.id))))
    .toContain(second.id);
});

test("selection rejects stale generations and inactive-project targets", async ({ page, electronApp, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
  const first = await shell(page);
  const second = await shell(page);
  await selectPane(page, first.id);
  expect(await page.evaluate(({ id, generation }) => window.termina.selectTerminal(id, generation), {
    id: second.id, generation: second.generation + 1,
  })).toEqual({ ok: false });
  const other = join(runRoot, "native-other-project");
  mkdirSync(other, { recursive: true });
  await page.evaluate((path) => window.termina.projectOpenPath(path), other);
  await expect(page.locator(".project-tab.active")).toContainText("native-other-project");
  const current = await shell(page);
  await selectPane(page, current.id);
  expect(await page.evaluate(({ id, generation }) => window.termina.selectTerminal(id, generation), first)).toEqual({ ok: false });
  await nativeAction(electronApp, "Close Terminal");
  await expect.poll(() => page.evaluate(() => window.termina.getInstances().then((instances) => instances.map((instance) => instance.id))))
    .not.toContain(current.id);
  const live = await page.evaluate(() => window.termina.getInstances().then((instances) => instances.map((instance) => instance.id)));
  expect(live).toContain(first.id);
  expect(live).toContain(second.id);
});
