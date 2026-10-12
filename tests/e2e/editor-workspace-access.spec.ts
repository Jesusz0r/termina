import { test, expect } from "./fixtures.ts";
import { readFile, lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseSidecarRecord } from "../../electron/sidecar.ts";
import type { Page } from "@playwright/test";
import type { ProjectWorkspaceRef } from "../../shared/types.ts";

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

async function selectEditorTab(page: Page, path: string): Promise<void> {
  await page.locator(`.editor-tab:has(.tab-name[title="${path}"])`).click();
}

test("candidate files stay read-only in cached editor tabs and all renderer save paths", async ({ page, projectRoot, runRoot }) => {
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
  const candidate = (await page.evaluate((projectId) => window.termina.getWorldlines(projectId), project!.id))
    .find((item) => item.terminalId === created.id);
  expect(candidate).toMatchObject({ role: "session", state: "ready", error: null });
  expect(candidate!.root).not.toBe(projectRoot);
  await waitReady(join(dirname(candidate!.root), "A-support", "events"), created.id!);
  const terminal = (await page.evaluate(() => window.termina.getInstances())).find((item) => item.id === created.id)!;
  const selected = await page.evaluate(({ id, generation }) => window.termina.selectTerminal(id, generation), terminal);
  expect(selected).toMatchObject({ ok: true });
  if (!selected.ok) throw new Error("candidate terminal could not be selected");
  const owner: ProjectWorkspaceRef = { projectId: project!.id, workspaceId: selected.folder.workspaceId };
  const candidatePath = join(candidate!.root, "greeting.ts");
  const candidateBytes = await readFile(candidatePath, "utf8");

  expect(await page.evaluate(({ path, owner }) => window.termina.openFile(path, owner, "editor"), { path: candidatePath, owner }))
    .toMatchObject({ ok: true, readOnly: true, content: candidateBytes });
  await expect.poll(() => page.locator("#explorer-tree [data-path]").first().getAttribute("data-path")).toBe(candidate!.root);
  await page.locator("#explorer-tree .explorer-row.file").filter({ hasText: "greeting.ts" }).dblclick();
  await expect.poll(() => editorState(page)).toEqual({ readOnly: true, content: candidateBytes });

  // An idle agent must not make its candidate editor editable.
  await focusEditor(page);
  await page.keyboard.type("renderer must not write this");
  await saveActive(page);
  expect(await editorState(page)).toEqual({ readOnly: true, content: candidateBytes });
  expect(await readFile(candidatePath, "utf8")).toBe(candidateBytes);

  const missingPath = join(candidate!.root, "must-not-restore.txt");
  for (const restore of [false, true]) {
    const path = restore ? missingPath : candidatePath;
    const saved = await page.evaluate(({ path, owner, restore }) => window.termina.saveFile(path, "rejected bytes", owner, restore), { path, owner, restore });
    expect(saved).toMatchObject({ ok: false, error: expect.stringContaining("read-only") });
    const flushed = await page.evaluate(({ path, owner, restore }) => window.termina.flushSave(path, "rejected bytes", "preflight:holder", owner, restore), { path, owner, restore });
    expect(flushed).toMatchObject({ ok: false, error: expect.stringContaining("read-only") });
  }
  await expect(lstat(missingPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(candidatePath, "utf8")).toBe(candidateBytes);

  // Access belongs to each cached file, not whichever terminal is selected.
  await selectEditorTab(page, sourcePath);
  await expect.poll(() => editorState(page)).toEqual({ readOnly: false, content: sourceBytes });
  await focusEditor(page);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
  await page.keyboard.type("// primary remains editable\n");
  const editedSource = (await editorState(page)).content;
  expect(editedSource).not.toBe(sourceBytes);
  await saveActive(page);
  expect(await readFile(sourcePath, "utf8")).toBe(editedSource);

  await selectEditorTab(page, candidatePath);
  await expect.poll(() => editorState(page)).toEqual({ readOnly: true, content: candidateBytes });
  expect(await readFile(candidatePath, "utf8")).toBe(candidateBytes);
});
