import { test, expect } from "./fixtures.ts";

test("retired inspector and interrupt APIs are absent from preload and main", async ({ page, electronApp }) => {
  await expect(page.locator("#splash")).toBeHidden();
  expect(await page.evaluate(() => {
    const bridge = window.termina as unknown as Record<string, unknown>;
    return ["getReviewFiles", "getReviewDiff", "interruptTerminal"].filter((name) => name in bridge);
  })).toEqual([]);

  const handlers = await electronApp.evaluate(({ ipcMain }) => {
    const registered = (ipcMain as unknown as { _invokeHandlers: Map<string, unknown> })._invokeHandlers;
    return {
      retired: ["review:files", "review:diff", "terminals:interrupt"].filter((channel) => registered.has(channel)),
      baseline: registered.has("review:baseline"),
      revert: registered.has("review:revert"),
    };
  });
  expect(handlers).toEqual({ retired: [], baseline: true, revert: true });
  const [terminal] = await page.evaluate(() => window.termina.getInstances());
  expect(terminal).toBeTruthy();
  expect(await page.evaluate((id) => window.termina.reviewBaseline(id, "/not-a-modified-file"), terminal!.id))
    .toEqual({ status: "modified", baseline: undefined });
});
