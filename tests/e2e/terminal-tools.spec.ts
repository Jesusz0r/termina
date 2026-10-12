import { test, expect } from "./fixtures.ts";
import { savedPlanProject } from "./saved-plan-project.ts";

const panels = "#checks-panel, #timeline-strip, #plan-panel, #worldline-panel, #modified-panel";

for (const zoom of [1, 2]) {
  test(`terminal tools stay on demand and retain loaded checks at ${zoom * 100} percent zoom`, async ({ page, electronApp }, testInfo) => {
    await expect(page.locator("#splash")).toBeHidden();
    await electronApp.evaluate(({ BrowserWindow }, factor) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setSize(1000, 720);
      window.webContents.setZoomFactor(factor);
    }, zoom);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const terminal = page.locator(".term-pane.active:visible");
    const pane = await terminal.elementHandle();
    const closedHeight = await terminal.evaluate((element) => element.clientHeight);
    for (const panel of await page.locator(panels).all()) await expect(panel).toBeHidden();
    const close = page.getByRole("button", { name: "Close terminal tools", exact: true });
    await expect(close).toBeHidden();
    const checks = page.locator("#activity-tab-checks");
    await checks.focus(); await page.keyboard.press("Enter");
    await expect(checks).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#checks-panel")).toBeVisible();
    await page.locator(".checks-details").click();
    const report = page.locator(".checks-report");
    await expect(report).toContainText("**Status:** NOT RUN");
    const loaded = await report.textContent();
    const reportNode = await report.elementHandle();
    await expect.poll(() => terminal.evaluate((element) => element.clientHeight)).toBeLessThan(closedHeight);
    await expect(close).toBeInViewport();
    await close.focus(); await page.keyboard.press("Enter");
    await expect(checks).toBeFocused();
    await expect(checks).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#checks-panel")).toBeHidden();
    await expect.poll(() => terminal.evaluate((element) => element.clientHeight)).toBe(closedHeight);
    await page.keyboard.press("Enter");
    await expect(report).toBeVisible();
    await expect(report).toHaveText(loaded!);
    expect(await reportNode!.evaluate((node) => node === document.querySelector(".checks-report"))).toBe(true);
    await report.focus(); await page.keyboard.press("Escape");
    await expect(page.locator("#checks-panel")).toBeHidden();
    await expect(checks).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#timeline-strip")).toBeVisible();
    await terminal.locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("Escape");
    await expect(page.locator("#timeline-strip")).toBeVisible();
    expect(await pane!.evaluate((node) => node.isConnected && node.parentElement?.id === "terminal-container")).toBe(true);
    await testInfo.attach(`terminal-tools-${zoom * 100}-percent`, { body: await page.screenshot(), contentType: "image/png" });
    await pane?.dispose(); await reportNode?.dispose();
  });
}

test("restored plan badges never open tools and a stored tab starts closed after reload", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const task = { text: "Saved task without automatic dispatch", paths: ["hello.txt"], state: "pending" as const };
  const { owners } = await savedPlanProject(page, projectRoot, runRoot, 1, [[task]]);
  const plan = page.locator("#activity-tab-plan");
  await expect(plan.locator(".activity-count")).toHaveText("(1)");
  for (const panel of await page.locator(panels).all()) await expect(panel).toBeHidden();
  await plan.click();
  await expect(page.locator("#plan-list")).toContainText(task.text);
  await page.getByRole("button", { name: "Close terminal tools", exact: true }).click();
  await page.reload();
  await expect(page.locator("#splash")).toBeHidden();
  await expect(plan.locator(".activity-count")).toHaveText("(1)");
  for (const panel of await page.locator(panels).all()) await expect(panel).toBeHidden();
  await expect(plan).toHaveAttribute("tabindex", "0");
  await plan.focus(); await page.keyboard.press("Enter");
  await expect(page.locator("#plan-list")).toContainText(task.text);
  expect(await page.evaluate((id) => window.termina.getPlan(id), owners[0]!)).toEqual([task]);
});
