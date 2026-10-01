import { test, expect } from "./fixtures.ts";

test("native emergency chord sends no terminal bytes; ordinary Escape still does", async ({ page, electronApp }) => {
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
  const textarea = page.locator("#terminal-container .xterm-helper-textarea");
  await expect(textarea).toHaveCount(1);

  // Keep the real renderer and immutable preload bridge. Capture only this
  // isolated app's writes, without sending input to a PTY or starting a helper.
  await electronApp.evaluate(({ ipcMain }) => {
    const writes: { id: string; data: string }[] = [];
    (globalThis as unknown as { terminalKeyWrites: typeof writes }).terminalKeyWrites = writes;
    ipcMain.removeHandler("terminals:write");
    ipcMain.handle("terminals:write", (_event, id: string, data: string) => { writes.push({ id, data }); });
  });
  const writes = () => electronApp.evaluate(() =>
    (globalThis as unknown as { terminalKeyWrites: { id: string; data: string }[] }).terminalKeyWrites);

  // DOM-only events: never page.keyboard.press() for this global shortcut.
  // No OS key injection, hotkey registration, capture, or desktop input occurs.
  const escape = { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true };
  await textarea.dispatchEvent("keydown", escape);
  await expect.poll(writes).toEqual([{ id: "term-1", data: "\x1b" }]);
  await textarea.dispatchEvent("keydown", { ...escape, ctrlKey: true, altKey: true, metaKey: true });
  // A subsequent ordinary key is also an IPC ordering barrier: a leaked
  // modified Escape would appear between the two ordinary Escape writes.
  await textarea.dispatchEvent("keydown", escape);
  await expect.poll(writes).toEqual([
    { id: "term-1", data: "\x1b" },
    { id: "term-1", data: "\x1b" },
  ]);
  expect(page.isClosed()).toBe(false);
  expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
});
