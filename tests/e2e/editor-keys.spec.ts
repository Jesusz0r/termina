import { test, expect } from "./fixtures.ts";

// The Electron Edit menu eats Cmd/Ctrl+Z/X/C/V/A before Monaco sees them,
// so these must round-trip through the menu-command routing. Regression
// coverage: undo/redo used the removed `editor.action.undo` alias (silent
// no-op) and cut/copy/paste bypassed Monaco entirely, which has no focused
// textarea to receive a native clipboard command under the EditContext
// renderer.
const mod = process.platform === "darwin" ? "Meta" : "Control";

function editorText(page: any): Promise<string | null> {
  return page.evaluate(() => {
    const mgr = (window as any).__editorMgr;
    try {
      return (mgr as any)?.editor?.getModel?.()?.getValue?.() ?? null;
    } catch {
      return null;
    }
  });
}

async function openGreeting(page: any): Promise<void> {
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
  await page.locator("#explorer-tree .explorer-row").filter({ hasText: "greeting.ts" }).dblclick();
  await expect(page.locator(".editor-tab .tab-name").getByText("greeting.ts")).toBeVisible();
}

test.describe("Editor keyboard editing", () => {
  test("Cmd/Ctrl+Z undoes typed text", async ({ page }) => {
    await openGreeting(page);
    await page.locator(".project-editor .monaco-editor").first().click({ position: { x: 100, y: 60 } });

    const before = await editorText(page);
    await page.keyboard.type("ABCXYZ");
    expect(await editorText(page)).toContain("ABCXYZ");

    await page.keyboard.press(`${mod}+z`);
    await expect.poll(() => editorText(page), { timeout: 5_000 }).toBe(before);

    // Redo restores the typed text through the same menu path.
    await page.keyboard.press(`Shift+${mod}+z`);
    await expect.poll(() => editorText(page), { timeout: 5_000 }).toContain("ABCXYZ");
  });

  test("Cmd/Ctrl+X cuts and Cmd/Ctrl+V pastes", async ({ page }) => {
    await openGreeting(page);
    await page.evaluate(() => (window as any).__editorMgr?.focusEditor?.());
    // Programmatic focus must leave the editor with text focus, or menu
    // edit commands silently fall through to the browser.
    await expect.poll(() => page.evaluate(() => (window as any).__editorMgr?.editor?.hasTextFocus?.() ?? null), { timeout: 5_000 }).toBe(true);

    const before = await editorText(page);
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.press(`${mod}+x`);
    await expect.poll(() => editorText(page), { timeout: 5_000 }).toBe("");

    await page.keyboard.press(`${mod}+v`);
    await expect.poll(() => editorText(page), { timeout: 5_000 }).toBe(before);
  });
});
