import { test, expect } from "./fixtures.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import type { Page } from "@playwright/test";
import type { editor } from "monaco-editor";
import type { PlanTask } from "../../shared/types.ts";
import { sanitizeSessionDir } from "../../electron/main/project-workspace.ts";
import { rosterFilePath } from "../../electron/roster-store.ts";

const chord = process.platform === "darwin" ? "Meta+k" : "Control+k";
type EditorWindow = Window & { __editorMgr: {
  editor: editor.IStandaloneCodeEditor;
  openFile(path: string, options: { preview: boolean }): Promise<void>;
  flushDrafts(): Promise<boolean>;
} };
async function activeProject(page: Page) {
  const project = (await page.evaluate(() => window.termina.projectList())).find((entry) => entry.active);
  expect(project).toBeTruthy();
  return project!;
}
async function savedProject(page: Page, projectRoot: string, runRoot: string, index: number, plans: PlanTask[][] = [[], []]) {
  const parent = join(runRoot, `new-task-${index}-<saved>&`);
  await mkdir(parent);
  const root = join(parent, basename(projectRoot));
  execFileSync("git", ["clone", "-q", "--no-hardlinks", projectRoot, root]);
  const instances = await page.evaluate(() => window.termina.getInstances());
  const next = Math.max(0, ...instances.map((instance) => Number(instance.id.slice(5)))) + 1;
  const boards = plans.length ? plans.map((plan, owner) => ({ id: `term-${next + owner}`, type: "agent", engine: "core", plan }))
    : [{ id: `term-${next}`, type: "shell", engine: "core", plan: [] }];
  const roster = rosterFilePath(join(runRoot, "user-data"), sanitizeSessionDir(realpathSync(root)));
  await writeFile(roster, JSON.stringify({ terminals: boards }));
  expect(await page.evaluate((root) => window.termina.projectOpenPath(root), root)).toMatchObject({ cwd: root });
  await expect.poll(() => page.evaluate(async (ids) => Promise.all(ids.map((id) => window.termina.getPlan(id))), boards.map((board) => board.id))).toEqual(boards.map((board) => board.plan));
  return { project: await activeProject(page), owners: boards.map((board) => board.id), roster };
}
async function openComposer(page: Page) {
  await page.locator("#btn-all-projects").click();
  await expect(page.getByRole("region", { name: "All projects", exact: true })).toBeVisible();
  await page.locator(".overview-new-task").click();
  const form = page.locator(".overview-task-composer");
  await expect(form).toBeVisible();
  return form;
}
async function selectDestination(page: Page, projectId: string, terminalId: string) {
  const form = page.locator(".overview-task-composer");
  await form.getByRole("combobox", { name: "Project", exact: true }).selectOption(projectId);
  const board = form.getByRole("combobox", { name: "Plan Board", exact: true });
  const choice = board.locator("option").filter({ hasText: `${terminalId} ·` });
  // A restored owner can arrive after the project's first canonical overview.
  await expect(choice).toHaveCount(1);
  const value = await choice.getAttribute("value");
  expect(value).not.toBeNull();
  expect(JSON.parse(value!).owner).toMatchObject({ projectId, terminalId });
  await board.selectOption(value!);
}
async function identities(page: Page) {
  return page.evaluate(async () => (await window.termina.getInstances()).map(({ id, cwd, generation }) => ({ id, cwd, generation })));
}

test("queues on the exact background owner and preserves the active dirty editor without executing work", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const previous: PlanTask = { text: "Previous incomplete task", paths: [], state: "pending", dispatchResult: { workerId: "term-999", outcome: "incomplete" } };
  const first = await savedProject(page, projectRoot, runRoot, 1, [[previous], []]);
  const second = await savedProject(page, projectRoot, runRoot, 2);
  expect(basename(first.project.cwd)).toBe(basename(second.project.cwd));
  await page.locator("#explorer-tree .explorer-row").filter({ hasText: "greeting.ts" }).dblclick();
  await page.evaluate((path) => (window as unknown as EditorWindow).__editorMgr.openFile(path, { preview: false }), join(second.project.cwd, "greeting.ts"));
  await expect(page.locator(".editor-tab .tab-name").getByText("greeting.ts", { exact: true })).toBeVisible();
  const source = 'export const greeting = "hello";\n';
  await expect.poll(() => page.evaluate(() => (window as unknown as EditorWindow).__editorMgr.editor.getModel()?.getValue())).toBe(source);
  const draft = "// unsaved task-composer buffer\n";
  expect(await page.evaluate((text) => {
    const editor = (window as unknown as EditorWindow).__editorMgr.editor;
    editor.focus();
    return editor.executeEdits("new-task-test", [{ range: editor.getModel()!.getFullModelRange(), text }]);
  }, draft)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as EditorWindow).__editorMgr.flushDrafts())).toBe(true);
  const before = await identities(page);
  const form = await openComposer(page);
  await expect(form.getByLabel("Project").locator("option").filter({ hasText: first.project.cwd })).toHaveCount(1);
  await expect(form.getByLabel("Project").locator("option").filter({ hasText: second.project.cwd })).toHaveCount(1);
  await selectDestination(page, first.project.id, first.owners[1]!);
  await expect(form.locator(".overview-task-destination")).toContainText(first.project.cwd);
  const text = "New <outcome> & literal: improve `hello.txt`";
  await form.getByLabel("Outcome", { exact: true }).fill(text);
  await form.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(form).toBeHidden();
  const queued: PlanTask = { text, paths: ["hello.txt"], state: "pending" };
  await expect.poll(() => page.evaluate((id) => window.termina.getPlan(id), first.owners[1]!)).toEqual([queued]);
  expect(await page.evaluate((id) => window.termina.getPlan(id), first.owners[0]!)).toEqual([previous]);
  for (const owner of second.owners) expect(await page.evaluate((id) => window.termina.getPlan(id), owner)).toEqual([]);
  await expect(page.locator(".overview-work-card").filter({ hasText: text })).toHaveCount(1);
  await expect(page.locator(".overview-work-card").filter({ hasText: text })).toContainText("Marked pending");
  await expect(page.locator("#project-work-inspector .overview-inspector-title")).toHaveText(text);
  await expect(page.locator("#project-work-inspector")).toContainText(first.owners[1]!);
  await expect(page.locator("#project-work-inspector")).toContainText("No live worker assigned");
  await expect(page.locator("#project-work-inspector outcome")).toHaveCount(0);
  expect((await activeProject(page)).id).toBe(second.project.id);
  expect(await identities(page)).toEqual(before);
  await expect.poll(async () => (JSON.parse(await readFile(first.roster, "utf8")) as { terminals: Array<{ id: string; plan?: PlanTask[] }> }).terminals.find((entry) => entry.id === first.owners[1])?.plan).toEqual([queued]);
  expect(await readFile(join(second.project.cwd, "greeting.ts"), "utf8")).toBe(source);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator("#attention-view")).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as EditorWindow).__editorMgr.editor.getModel()?.getValue())).toBe(draft);
  await expect(page.locator(".editor-tab .tab-dirty")).toBeVisible();
  // Creation feeds the canonical overview; global search needs no parallel registry.
  await page.keyboard.press(chord);
  const palette = page.locator(".search-modal");
  await palette.locator(".search-input").fill("new literal outcome");
  await expect(palette.locator(".search-hit").filter({ hasText: text })).toHaveCount(1);
  await expect(palette.locator(".search-hit").filter({ hasText: text })).toContainText(first.project.cwd);
  await page.keyboard.press("Escape");
  expect(await identities(page)).toEqual(before);
});

test("Cancel and Escape preserve plans, project and terminals at native 200 percent zoom", async ({ page, projectRoot, runRoot, electronApp }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const target = await savedProject(page, projectRoot, runRoot, 1);
  const before = await identities(page);
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    window.setSize(1000, 850);
    window.webContents.setZoomFactor(2);
  });
  const form = await openComposer(page);
  await selectDestination(page, target.project.id, target.owners[1]!);
  const input = form.getByLabel("Outcome", { exact: true });
  await input.fill("Cancelled task");
  await expect(input).toBeFocused();
  expect(await form.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(form).toBeHidden();
  await expect(page.locator(".overview-new-task")).toBeFocused();
  await expect(page.locator("#attention-view")).toBeVisible();
  await page.locator(".overview-new-task").click();
  await form.getByLabel("Outcome").fill("Also cancelled");
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(form).toBeHidden();
  expect((await activeProject(page)).id).toBe(target.project.id);
  expect(await identities(page)).toEqual(before);
  for (const id of target.owners) expect(await page.evaluate((id) => window.termina.getPlan(id), id)).toEqual([]);
});

test("rejects duplicate and automatic schedule text without changing previous plan or executing", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const previous: PlanTask = { text: "Existing outcome", paths: [], state: "done" };
  const target = await savedProject(page, projectRoot, runRoot, 1, [[previous]]);
  const before = await identities(page);
  const form = await openComposer(page);
  await selectDestination(page, target.project.id, target.owners[0]!);
  const input = form.getByLabel("Outcome", { exact: true });
  await input.fill(previous.text);
  await form.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(form.locator(".overview-task-status")).toContainText("already");
  await expect(input).toHaveValue(previous.text);
  await input.fill("Unexpected scheduled work @every 5m");
  await form.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(form.locator(".overview-task-status")).toContainText("schedule");
  expect(await page.evaluate((id) => window.termina.getPlan(id), target.owners[0]!)).toEqual([previous]);
  expect(await identities(page)).toEqual(before);
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("full Plan Boards and projects without an existing agent do not create a terminal", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const tasks: PlanTask[] = Array.from({ length: 20 }, (_, index) => ({ text: `Task ${index}`, paths: [], state: "pending" }));
  const target = await savedProject(page, projectRoot, runRoot, 1, [tasks]);
  const emptyProject = (await savedProject(page, projectRoot, runRoot, 2, [])).project;
  const before = await identities(page);
  const form = await openComposer(page);
  await form.getByRole("combobox", { name: "Project", exact: true }).selectOption(target.project.id);
  await form.getByLabel("Outcome").fill("Should not fit");
  await expect(form.getByRole("button", { name: "Create task", exact: true })).toBeDisabled();
  await expect(form.locator(".overview-task-status")).toContainText("full");
  await form.getByRole("combobox", { name: "Project", exact: true }).selectOption(emptyProject.id);
  await expect(form.getByRole("button", { name: "Create task", exact: true })).toBeDisabled();
  await expect(form.locator(".overview-task-status")).toContainText("No existing agent");
  expect(await identities(page)).toEqual(before);
  expect(await page.evaluate((id) => window.termina.getPlan(id), target.owners[0]!)).toEqual(tasks);
});

test("a closed background destination invalidates the draft rather than retargeting another board", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const target = await savedProject(page, projectRoot, runRoot, 1);
  const current = await savedProject(page, projectRoot, runRoot, 2);
  const before = await identities(page);
  const form = await openComposer(page);
  await selectDestination(page, target.project.id, target.owners[1]!);
  await form.getByLabel("Outcome").fill("Draft for closed destination");
  await page.evaluate((id) => {
    const close = document.querySelector<HTMLButtonElement>(`#project-tabs .project-tab[data-project-id="${id}"] .tab-close`);
    if (!close) throw new Error("Missing canonical close action");
    close.click();
  }, target.project.id);
  await expect.poll(() => page.evaluate(async (id) => (await window.termina.projectList()).some((project) => project.id === id), target.project.id)).toBe(false);
  await expect(form.getByRole("button", { name: "Create task", exact: true })).toBeDisabled();
  await expect(form.getByLabel("Outcome")).toHaveValue("Draft for closed destination");
  await expect(form.locator(".overview-task-status")).toContainText(/unavailable|changed/i);
  expect((await activeProject(page)).id).toBe(current.project.id);
  expect(await identities(page)).toEqual(before.filter((instance) => !target.owners.includes(instance.id)));
  for (const id of current.owners) expect(await page.evaluate((id) => window.termina.getPlan(id), id)).toEqual([]);
});
