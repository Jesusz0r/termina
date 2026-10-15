import { test, expect } from "./fixtures.ts";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { parseSidecarRecord } from "../../electron/sidecar.ts";
import type { Page } from "@playwright/test";

interface EditorHarness {
  editor: { getRawOptions(): { readOnly?: boolean }; getValue(): string; hasTextFocus(): boolean };
  saveActive(): Promise<void>;
}

async function waitReady(eventsDir: string, id: string): Promise<void> {
  await expect.poll(async () => {
    try {
      return (await readFile(join(eventsDir, `${id}.jsonl`), "utf8")).split("\n")
        .some((line) => { const record = parseSidecarRecord(line); return record?.t === "session_ready" && record.ok; });
    } catch { return false; }
  }, { timeout: 30_000 }).toBe(true);
}

async function editorState(page: Page) {
  return page.evaluate(() => {
    const manager = (window as unknown as { __editorMgr: EditorHarness }).__editorMgr;
    return { readOnly: manager.editor.getRawOptions().readOnly, content: manager.editor.getValue() };
  });
}

async function focusEditor(page: Page): Promise<void> {
  // Monaco's EditContext receives input through the widget, not its textarea.
  await page.locator(".project-editor .monaco-editor").first().click({ position: { x: 100, y: 60 } });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __editorMgr: EditorHarness }).__editorMgr.editor.hasTextFocus())).toBe(true);
}

async function saveActive(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __editorMgr: EditorHarness }).__editorMgr.saveActive());
}

test("a second agent shares the project editor and can save it", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const [project] = await page.evaluate(() => window.termina.projectList());
  const [primaryTerminal] = await page.evaluate(() => window.termina.getInstances());
  expect(project).toBeTruthy();
  expect(primaryTerminal).toBeTruthy();
  await waitReady(join(runRoot, "events"), primaryTerminal!.id);

  const sourcePath = await realpath(join(projectRoot, "greeting.ts"));
  const sourceBytes = await readFile(sourcePath, "utf8");
  await page.locator("#explorer-tree .explorer-row.file").filter({ hasText: "greeting.ts" }).dblclick();
  await expect.poll(() => editorState(page)).toEqual({ readOnly: false, content: sourceBytes });

  const created = await page.evaluate((projectId) => window.termina.createTerminal({ type: "agent", projectId }), project!.id);
  expect(created).toMatchObject({ ok: true });
  await waitReady(join(runRoot, "events"), created.id!);
  const terminal = (await page.evaluate(() => window.termina.getInstances())).find((item) => item.id === created.id)!;
  expect(await realpath(terminal.cwd)).toBe(await realpath(projectRoot));
  const selected = await page.evaluate(({ id, generation }) => window.termina.selectTerminal(id, generation), terminal);
  expect(selected).toMatchObject({ ok: true });
  await expect.poll(() => editorState(page)).toEqual({ readOnly: false, content: sourceBytes });

  await focusEditor(page);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
  await page.keyboard.type("// shared project remains editable\n");
  const editedSource = (await editorState(page)).content;
  expect(editedSource).not.toBe(sourceBytes);
  await saveActive(page);
  expect(await readFile(sourcePath, "utf8")).toBe(editedSource);
});
