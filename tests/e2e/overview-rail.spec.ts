import { test, expect } from "./fixtures.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { editor } from "monaco-editor";
import type { WorkAttentionItem } from "../../shared/types.ts";
import { activeProject, savedPlanProject } from "./saved-plan-project.ts";

type EditorWindow = Window & { __editorMgr: {
  editor: editor.IStandaloneCodeEditor;
  openFile(path: string, options: { preview: boolean }): Promise<void>;
  flushDrafts(): Promise<boolean>;
} };
const withoutModel = ({ model: _model, ...item }: WorkAttentionItem) => item;
const lane = (id: string) => `.overview-project[data-project-id="${id}"]`;
const rail = (id: string) => `#project-tabs .project-tab[data-project-id="${id}"] .project-select`;

async function setup(page: Parameters<typeof activeProject>[0], projectRoot: string, runRoot: string) {
  const first = await savedPlanProject(page, projectRoot, runRoot, 1, [[
    { text: "Recover first parser", paths: ["hello.txt"], state: "pending", dispatchResult: { workerId: "term-901", outcome: "failed" } },
  ]]);
  const second = await savedPlanProject(page, projectRoot, runRoot, 2, [[
    { text: "Recover second parser", paths: ["hello.txt"], state: "pending", dispatchResult: { workerId: "term-902", outcome: "incomplete" } },
  ]]);
  await page.locator("#btn-all-projects").click();
  await expect(page.getByRole("region", { name: "All projects", exact: true })).toBeVisible();
  await expect(page.locator(lane(first.project.id))).toBeVisible();
  await expect(page.locator(lane(second.project.id))).toBeVisible();
  return { first, second };
}

test("rail filters same-name Overview lanes without navigating, saving drafts or hiding global attention; workspace navigation remains explicit", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const { first, second } = await setup(page, projectRoot, runRoot);
  // Return once to the current workspace to prepare a real unsaved active model.
  await page.locator("#btn-close-attention").click();
  const path = join(second.project.cwd, "greeting.ts");
  const disk = await readFile(path, "utf8");
  const draft = "// rail filtering must not save the active model\n";
  await page.evaluate((path) => (window as unknown as EditorWindow).__editorMgr.openFile(path, { preview: false }), path);
  expect(await page.evaluate((text) => {
    const editor = (window as unknown as EditorWindow).__editorMgr.editor;
    return editor.executeEdits("overview-rail-test", [{ range: editor.getModel()!.getFullModelRange(), text }]);
  }, draft)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as EditorWindow).__editorMgr.flushDrafts())).toBe(true);
  const before = await page.evaluate(() => window.termina.getWorkOverview());
  const projectName = before.projects.find((project) => project.projectId === first.project.id)!.name;
  expect(before.projects.find((project) => project.projectId === second.project.id)!.name).toBe(projectName);
  expect(first.project.cwd).not.toBe(second.project.cwd);
  const active = await activeProject(page);
  const identities = await page.evaluate(async () => (await window.termina.getInstances()).map(({ id, generation, cwd, projectId, workspaceId }) => ({ id, generation, cwd, projectId, workspaceId })));
  await page.locator("#btn-all-projects").click();
  const search = page.getByRole("searchbox", { name: "Filter projects and tasks", exact: true });
  await search.fill(projectName);
  await page.locator(rail(first.project.id)).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".overview-project")).toHaveCount(1);
  await expect(page.locator(lane(first.project.id))).toBeVisible();
  await expect(page.locator(rail(first.project.id))).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(rail(second.project.id))).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(rail(first.project.id))).toHaveAccessibleName(`Filter Overview to project ${projectName}`);
  await expect(page.locator(rail(first.project.id))).toBeFocused();
  await expect(page.locator(".overview-project-filter")).toContainText(first.project.cwd);
  await expect(page.locator(".overview-project-filter")).toContainText("Attention remains global");
  await expect(page.locator("#attention-list .attention-item")).toHaveCount(before.items.length);
  await expect(search).toHaveValue(projectName);
  expect(await activeProject(page)).toMatchObject({ id: active.id, activationGeneration: active.activationGeneration });
  expect(await page.evaluate(async () => (await window.termina.getInstances()).map(({ id, generation, cwd, projectId, workspaceId }) => ({ id, generation, cwd, projectId, workspaceId })))).toEqual(identities);
  expect(await readFile(path, "utf8")).toBe(disk);
  expect(await page.evaluate(() => (window as unknown as EditorWindow).__editorMgr.editor.getModel()?.getValue())).toBe(draft);
  const other = before.items.find((item) => item.projectId === second.project.id)!;
  const attentionRow = page.locator(`#attention-list .attention-item[data-id="${other.id}"]`);
  const inspect = attentionRow.getByRole("button", { name: "Inspect details", exact: true });
  await inspect.click();
  await expect(attentionRow).toHaveClass(/is-selected/);
  await expect(inspect).toHaveAttribute("aria-pressed", "true");
  await expect(inspect).toHaveAttribute("aria-expanded", "true");
  const inspector = page.locator("#project-work-inspector");
  await expect(inspector.locator(".overview-inspector-title")).toHaveText("Recover second parser");
  await expect(page.locator(".overview-project")).toHaveCount(1);
  await expect(page.locator(lane(first.project.id))).toBeVisible();
  expect((await activeProject(page)).id).toBe(second.project.id);
  await page.locator("#btn-refresh-attention").click();
  await expect(page.locator("#attention-status")).not.toContainText("Loading");
  await expect(page.locator(lane(first.project.id))).toBeVisible();
  await expect(search).toHaveValue(projectName);
  await page.locator(".overview-clear-project-filter").click();
  await expect(page.locator(lane(second.project.id))).toBeVisible();
  await expect(search).toHaveValue(projectName);
  await expect(search).toBeFocused();
  await page.locator(rail(first.project.id)).click();
  await page.locator("#btn-all-projects").click();
  await expect(page.locator(lane(second.project.id))).toBeVisible();
  await expect(page.locator(rail(first.project.id))).toHaveAttribute("aria-pressed", "false");
  await page.locator(rail(first.project.id)).click();
  await page.locator(lane(first.project.id)).getByRole("button", { name: "Open project", exact: true }).click();
  await expect(page.locator("#attention-view")).toBeHidden();
  expect((await activeProject(page)).id).toBe(first.project.id);
  await expect(page.locator(rail(second.project.id))).toHaveAccessibleName(`Open project ${projectName}`);
  await page.locator(rail(second.project.id)).click();
  await expect.poll(async () => (await activeProject(page)).id).toBe(second.project.id);
  expect((await page.evaluate(() => window.termina.getWorkOverview())).items.map(withoutModel)).toEqual(before.items.map(withoutModel));
  expect(await readFile(path, "utf8")).toBe(disk);
});

test("a closed filtered project remains explicitly invalid rather than revealing another same-name project", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const { first, second } = await setup(page, projectRoot, runRoot);
  await page.locator(rail(first.project.id)).click();
  await expect(page.locator(lane(first.project.id))).toBeVisible();
  expect(await page.evaluate((id) => window.termina.projectClose(id), first.project.id)).toEqual({ ok: true });
  await expect(page.locator(".overview-project")).toHaveCount(0);
  await expect(page.locator(".overview-project-filter")).toContainText("changed or closed");
  await expect(page.locator(".overview-project-filter")).toContainText(first.project.cwd);
  await expect(page.locator(".overview-new-task")).toBeDisabled();
  await expect(page.locator("#attention-list")).toContainText("Recover second parser");
  await expect(page.locator("#attention-view")).toBeVisible();
  expect((await activeProject(page)).id).toBe(second.project.id);
  await page.locator(".overview-clear-project-filter").click();
  await expect(page.locator(lane(second.project.id))).toBeVisible();
  await expect(page.locator(".overview-new-task")).toBeEnabled();
});
