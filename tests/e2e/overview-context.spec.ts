import { test, expect } from "./fixtures.ts";
import type { Locator, Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, join } from "node:path";
import type { PlanTask, WorkAttentionItem } from "../../shared/types.ts";
import { activeProject, savedPlanProject } from "./saved-plan-project.ts";
import { readVerifyStages, writeVerifyPackage } from "../fixtures/verify-package.ts";

async function openOverview(page: Page) {
  await page.locator("#btn-all-projects").click();
  await expect(page.getByRole("region", { name: "All projects", exact: true })).toBeVisible();
  await expect(page.locator("#attention-status")).not.toContainText("Loading");
}

function lane(page: Page, projectId: string) {
  return page.locator(`.overview-project[data-project-id="${projectId}"]`);
}

function attentionRow(page: Page, item: WorkAttentionItem) {
  return page.locator(`#attention-list .attention-item[data-id="${item.id}"]`);
}

function fact(inspector: Locator, label: string) {
  return inspector.locator("dt").filter({ hasText: new RegExp(`^${label}$`) })
    .locator("xpath=following-sibling::dd[1]");
}

async function identities(page: Page) {
  return page.evaluate(async () => (await window.termina.getInstances())
    .map(({ id, cwd, generation, projectId, workspaceId }) => ({ id, cwd, generation, projectId, workspaceId })));
}

async function storedPlans(roster: string) {
  const saved = JSON.parse(await readFile(roster, "utf8")) as { terminals: Array<{ id: string; plan?: PlanTask[] }> };
  return saved.terminals.map(({ id, plan }) => ({ id, plan }));
}

// Model metadata can arrive during agent startup. Everything else in an attention
// reason must be preserved by read-only inspection, including its assigned root.
function withoutModel({ model: _model, ...item }: WorkAttentionItem) {
  return item;
}

async function expectCurrentContext(page: Page, inspector: Locator, projectId: string, ownerId: string) {
  await expect.poll(async () => {
    const overview = await page.evaluate(() => window.termina.getWorkOverview());
    const owner = overview.projects.find((project) => project.projectId === projectId)!
      .terminals.find((terminal) => terminal.terminalId === ownerId)!;
    const text = await fact(inspector, "Assigned context").innerText();
    return text.includes(`${ownerId} · ${owner.model ?? "model unknown"}`)
      && text.includes(owner.workArea!.root);
  }).toBe(true);
}

async function expectActiveTerminal(page: Page, terminalId: string) {
  await expect.poll(() => page.evaluate((id) => (window as unknown as {
    __panes: Map<string, { tabEl: HTMLElement }>;
  }).__panes.get(id)?.tabEl.classList.contains("active") ?? false, terminalId)).toBe(true);
}

const failedTask: PlanTask = {
  text: "Repair <parser> & preserve `hello.txt`", paths: ["hello.txt"], state: "pending",
  dispatchResult: { workerId: "term-901", outcome: "failed" },
};
const incompleteTask: PlanTask = {
  text: "Recover the incomplete greeting", paths: ["greeting.ts"], state: "pending",
  dispatchResult: { workerId: "term-902", outcome: "incomplete" },
};

test("global attention inspects exact saved tasks without navigating or clearing a local filter; Open plan is explicit", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const target = await savedPlanProject(page, projectRoot, runRoot, 1, [[failedTask, incompleteTask]]);
  const current = await savedPlanProject(page, projectRoot, runRoot, 2, [[]]);
  expect(basename(target.project.cwd)).toBe(basename(current.project.cwd));
  expect(target.project.cwd).not.toBe(current.project.cwd);
  const beforeInstances = await identities(page);
  const before = await page.evaluate(() => window.termina.getWorkOverview());
  expect(before.items).toHaveLength(2);
  const ownerId = target.owners[0]!;
  await openOverview(page);
  const filter = page.getByRole("searchbox", { name: "Filter projects and tasks", exact: true });
  await filter.fill(current.project.cwd);
  await expect(page.locator(".overview-project")).toHaveCount(1);
  await expect(lane(page, current.project.id)).toBeVisible();
  await expect(page.locator(".overview-status")).toContainText("3 projects · 2 Plan Board tasks · 1 matching project");
  await expect(page.locator("#attention-list .attention-item")).toHaveCount(2);
  const inspector = page.getByRole("complementary", { name: "Selected work details", exact: true });

  for (const [index, task] of [failedTask, incompleteTask].entries()) {
    const item = before.items.find((item) => item.taskText === task.text)!;
    expect(item).toMatchObject({ projectId: target.project.id, terminalId: ownerId, taskText: task.text });
    const row = attentionRow(page, item);
    await expect(row).toContainText(target.project.cwd);
    const opener = row.getByRole("button", { name: "Inspect details", exact: true });
    await expect(opener).toHaveClass(/attention-inspect/);
    if (index === 0) await opener.click();
    else { await opener.focus(); await page.keyboard.press("Enter"); }
    await expect(inspector).toBeVisible();
    await expect(inspector.locator(".overview-inspector-title")).toHaveText(task.text);
    await expect(inspector.locator(".overview-inspector-title")).toBeFocused();
    await expect(fact(inspector, "Project")).toHaveText(`${basename(target.project.cwd)}\n${target.project.cwd}`);
    await expect(fact(inspector, "Task state")).toHaveText("Marked pending");
    await expect(fact(inspector, "Execution")).toContainText(`Previous attempt ${task.dispatchResult!.outcome} (${task.dispatchResult!.workerId})`);
    await expect(fact(inspector, "Declared task paths")).toHaveText(task.paths.join("\n"));
    await expectCurrentContext(page, inspector, target.project.id, ownerId);
    await expect(page.locator("#attention-view")).toBeVisible();
    await expect(filter).toHaveValue(current.project.cwd);
    await expect(page.locator(".overview-project")).toHaveCount(1);
    await expect(lane(page, current.project.id)).toBeVisible();
    await expect(page.locator(".overview-status")).toContainText("3 projects · 2 Plan Board tasks · 1 matching project");
    await expect(page.locator("#attention-list .attention-item")).toHaveCount(2);
    await expect(page.locator("#btn-attention .attention-count")).toHaveText("2");
    expect(await activeProject(page)).toMatchObject({ id: current.project.id, activationGeneration: current.project.activationGeneration });
    expect(await identities(page)).toEqual(beforeInstances);
    expect(await page.evaluate((id) => window.termina.getPlan(id), ownerId)).toEqual([failedTask, incompleteTask]);
    expect((await page.evaluate(() => window.termina.getWorkOverview())).items.map(withoutModel)).toEqual(before.items.map(withoutModel));
    await page.keyboard.press("Escape");
    await expect(inspector).toBeHidden();
    await expect(page.locator("#attention-view")).toBeVisible();
    await expect(opener).toBeFocused();
  }

  await attentionRow(page, before.items.find((item) => item.taskText === incompleteTask.text)!)
    .getByRole("button", { name: "Inspect details", exact: true }).click();
  await inspector.getByRole("button", { name: "Open plan", exact: true }).click();
  await expect(page.locator("#attention-view")).toBeHidden();
  expect((await activeProject(page)).id).toBe(target.project.id);
  await expectActiveTerminal(page, ownerId);
  await expect(page.locator("#plan-list .plan-task")).toHaveCount(2);
  await expect(page.locator("#plan-list")).toContainText(incompleteTask.text);
  await expect(page.locator("#activity-tab-plan")).toBeFocused();
  expect(await identities(page)).toEqual(beforeInstances);
  expect((await page.evaluate(() => window.termina.getWorkOverview())).items.map(withoutModel)).toEqual(before.items.map(withoutModel));
});

test("closing an inspected background attention target invalidates details instead of selecting another same-name project", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const target = await savedPlanProject(page, projectRoot, runRoot, 1, [[failedTask]]);
  const current = await savedPlanProject(page, projectRoot, runRoot, 2, [[incompleteTask]]);
  const beforeInstances = await identities(page);
  const items = (await page.evaluate(() => window.termina.getWorkOverview())).items;
  const item = items.find((entry) => entry.projectId === target.project.id)!;
  const remaining = items.filter((entry) => entry.projectId !== target.project.id).map(withoutModel);
  await openOverview(page);
  await attentionRow(page, item).getByRole("button", { name: "Inspect details", exact: true }).click();
  const inspector = page.locator("#project-work-inspector");
  await expect(inspector.locator(".overview-inspector-title")).toHaveText(failedTask.text);
  await page.locator(`#project-tabs .project-tab[data-project-id="${target.project.id}"] .tab-close`).click();
  await expect(inspector.locator(".overview-inspector-status")).toContainText("changed or closed");
  await expect(inspector.locator(".overview-inspector-primary")).toBeDisabled();
  await expect(inspector.locator(".overview-inspector-facts")).toBeHidden();
  await expect(page.locator("#attention-view")).toBeVisible();
  await expect(lane(page, target.project.id)).toHaveCount(0);
  await expect(page.locator("#attention-list .attention-item")).toHaveCount(1);
  await expect(attentionRow(page, items.find((entry) => entry.projectId === current.project.id)!)).toContainText(current.project.cwd);
  expect((await activeProject(page)).id).toBe(current.project.id);
  expect(await identities(page)).toEqual(beforeInstances.filter((instance) => instance.projectId !== target.project.id));
  expect((await page.evaluate(() => window.termina.getWorkOverview())).items.map(withoutModel)).toEqual(remaining);
  expect(await page.evaluate((id) => window.termina.getPlan(id), current.owners[0]!)).toEqual([incompleteTask]);
});

test("terminal-wide failed verification on a multi-task owner stays terminal context; Check details reads evidence without rerunning", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const tasks: PlanTask[] = [
    { text: "First board task is not the check owner", paths: ["hello.txt"], state: "pending" },
    { text: "Second unrelated board task", paths: ["greeting.ts"], state: "pending" },
  ];
  const target = await savedPlanProject(page, projectRoot, runRoot, 1, [tasks]);
  await writeFile(join(target.project.cwd, ".gitignore"), "/stages.jsonl\nnode_modules/\n");
  await writeVerifyPackage(target.project.cwd, { test: "termina-verify-fixture fail" });
  const ownerId = target.owners[0]!;
  expect(await page.evaluate((id) => window.termina.runVerify(id), ownerId)).toEqual({ ok: true });
  await expect.poll(() => page.evaluate(async (id) => (await window.termina.getInstances())
    .find((instance) => instance.id === id)?.verify, ownerId), { timeout: 15_000 })
    .toMatchObject({ state: "fail", result: { state: "fail", exitCode: 7 } });
  const current = await savedPlanProject(page, projectRoot, runRoot, 2, [[]]);
  const beforeInstances = await identities(page);
  const before = await page.evaluate(() => window.termina.getWorkOverview());
  const item = before.items.find((entry) => entry.projectId === target.project.id && entry.reason === "verify-failed")!;
  expect(item).toMatchObject({ terminalId: ownerId, taskText: null, reason: "verify-failed" });
  expect(item.workArea?.root).toBe(target.project.cwd);
  expect(before.items).toHaveLength(1);
  await openOverview(page);
  const filter = page.getByRole("searchbox", { name: "Filter projects and tasks", exact: true });
  await filter.fill(current.project.cwd);
  const opener = attentionRow(page, item).getByRole("button", { name: "Inspect details", exact: true });
  await opener.focus();
  await page.keyboard.press("Space");
  const inspector = page.locator("#project-work-inspector");
  await expect(inspector).toBeVisible();
  await expect(inspector.locator(".overview-inspector-title")).toHaveText(`Agent · ${ownerId}`);
  await expect(fact(inspector, "Project")).toHaveText(`${basename(target.project.cwd)}\n${target.project.cwd}`);
  await expectCurrentContext(page, inspector, target.project.id, ownerId);
  await expect(fact(inspector, "Evidence")).toContainText("Check: fail");
  await expect(fact(inspector, "Evidence")).toContainText("exit 7");
  await expect(inspector.locator(".overview-inspector-title")).not.toContainText(tasks[0]!.text);
  await expect(fact(inspector, "Task state")).not.toHaveText("Marked pending");
  await expect(fact(inspector, "Declared task paths")).not.toContainText("hello.txt");
  await expect(fact(inspector, "Declared task paths")).not.toContainText("greeting.ts");
  await expect(inspector.locator(".overview-inspector-start")).toBeHidden();
  await expect(inspector.locator(".overview-inspector-retry")).toBeHidden();
  await expect(inspector.locator(".overview-inspector-report")).toBeHidden();
  await inspector.getByRole("button", { name: "Check details", exact: true }).click();
  const report = inspector.locator(".overview-inspector-report");
  await expect(report).toContainText("FAILED (exit code 7)");
  await expect(report).toContainText(target.project.cwd);
  await expect(report).toContainText("termina-verify-fixture fail");
  await expect(report).not.toContainText(current.project.cwd);
  await expect(page.locator("#attention-view")).toBeVisible();
  await expect(filter).toHaveValue(current.project.cwd);
  await expect(page.locator(".overview-project")).toHaveCount(1);
  await expect(page.locator("#attention-list .attention-item")).toHaveCount(1);
  expect((await activeProject(page)).id).toBe(current.project.id);
  expect(await identities(page)).toEqual(beforeInstances);
  expect(await page.evaluate((id) => window.termina.getPlan(id), ownerId)).toEqual(tasks);
  expect((await page.evaluate(() => window.termina.getWorkOverview())).items.map(withoutModel)).toEqual(before.items.map(withoutModel));
  expect(await readVerifyStages(target.project.cwd)).toMatchObject([{ args: ["fail"], event: "test", cwd: realpathSync(target.project.cwd) }]);
  await inspector.getByRole("button", { name: "Open terminal", exact: true }).click();
  await expect(page.locator("#attention-view")).toBeHidden();
  expect((await activeProject(page)).id).toBe(target.project.id);
  await expectActiveTerminal(page, ownerId);
  expect(await identities(page)).toEqual(beforeInstances);
  expect(await readVerifyStages(target.project.cwd)).toHaveLength(1);
});

test("each contextual New task opener names and describes its exact project; Cancel and Escape restore it at compact native 200 percent", async ({ page, projectRoot, runRoot, electronApp }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const original = await activeProject(page);
  const target = await savedPlanProject(page, projectRoot, runRoot, 1, [[incompleteTask]]);
  const current = await savedPlanProject(page, projectRoot, runRoot, 2, [[]]);
  expect(basename(target.project.cwd)).toBe(basename(current.project.cwd));
  const beforeInstances = await identities(page);
  const before = await page.evaluate(() => window.termina.getWorkOverview());
  const beforeRoster = await storedPlans(target.roster);
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    window.setSize(1000, 850);
    window.webContents.setZoomFactor(2);
  });
  await openOverview(page);
  await expect(page.locator(".overview-new-project-task")).toHaveCount(3);
  for (const project of [original, target.project, current.project]) {
    const button = lane(page, project.id).locator(".overview-new-project-task");
    await expect(button).toHaveText("New task");
    await expect(button).toHaveAccessibleName(`New task in ${basename(project.cwd)}`);
    await expect(button).toHaveAccessibleDescription(project.cwd);
    await expect(button).toHaveAttribute("aria-controls", "overview-new-task-form");
  }
  const opener = lane(page, target.project.id).locator(".overview-new-project-task");
  const form = page.locator(".overview-task-composer");
  for (const cancelWith of ["Cancel", "Escape"] as const) {
    await opener.focus();
    await page.keyboard.press(cancelWith === "Cancel" ? "Enter" : "Space");
    await expect(form).toBeVisible();
    await expect(page.locator(".overview-task-composer")).toHaveCount(1);
    await expect(form.getByRole("combobox", { name: "Project", exact: true })).toHaveValue(target.project.id);
    await expect(form.locator(".overview-task-destination")).toContainText(target.project.cwd);
    const value = await form.getByRole("combobox", { name: "Plan Board", exact: true }).inputValue();
    expect(JSON.parse(value).owner).toMatchObject({ projectId: target.project.id, terminalId: target.owners[0]!, root: target.project.cwd });
    await expect(form.getByLabel("Outcome", { exact: true })).toBeFocused();
    await form.getByLabel("Outcome", { exact: true }).fill(`Unsaved ${cancelWith} draft`);
    expect(await form.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    expect(await activeProject(page)).toMatchObject({ id: current.project.id, activationGeneration: current.project.activationGeneration });
    expect(await identities(page)).toEqual(beforeInstances);
    expect(await page.evaluate((id) => window.termina.getPlan(id), target.owners[0]!)).toEqual([incompleteTask]);
    if (cancelWith === "Cancel") await form.getByRole("button", { name: "Cancel", exact: true }).click();
    else await page.keyboard.press("Escape");
    await expect(form).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(page.locator("#attention-view")).toBeVisible();
    expect(await activeProject(page)).toMatchObject({ id: current.project.id, activationGeneration: current.project.activationGeneration });
    expect(await identities(page)).toEqual(beforeInstances);
    expect(await page.evaluate((id) => window.termina.getPlan(id), target.owners[0]!)).toEqual([incompleteTask]);
    expect(await page.evaluate((id) => window.termina.getPlan(id), current.owners[0]!)).toEqual([]);
    expect((await page.evaluate(() => window.termina.getWorkOverview())).items.map(withoutModel)).toEqual(before.items.map(withoutModel));
  }
  expect(await storedPlans(target.roster)).toEqual(beforeRoster);
});

test("a contextual composer retains a closed destination as invalid instead of falling back to the active same-name project", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const target = await savedPlanProject(page, projectRoot, runRoot, 1, [[incompleteTask]]);
  const current = await savedPlanProject(page, projectRoot, runRoot, 2, [[]]);
  const beforeInstances = await identities(page);
  await openOverview(page);
  await lane(page, target.project.id).locator(".overview-new-project-task").click();
  const form = page.locator(".overview-task-composer");
  await expect(form).toBeVisible();
  await expect(form.getByRole("combobox", { name: "Project", exact: true })).toHaveValue(target.project.id);
  const board = form.getByRole("combobox", { name: "Plan Board", exact: true });
  const destination = await board.inputValue();
  const draft = "Keep this unsaved outcome on its closed destination";
  await form.getByLabel("Outcome", { exact: true }).fill(draft);
  await page.evaluate((id) => {
    const button = document.querySelector<HTMLButtonElement>(`#project-tabs .project-tab[data-project-id="${id}"] .tab-close`);
    if (!button) throw new Error("Missing canonical project close action");
    button.click();
  }, target.project.id);
  await expect.poll(() => page.evaluate(async (id) => (await window.termina.projectList())
    .some((project) => project.id === id), target.project.id)).toBe(false);
  await expect(form.getByRole("button", { name: "Create task", exact: true })).toBeDisabled();
  await expect(form.locator(".overview-task-status")).toContainText(/unavailable|changed/i);
  await expect(form.getByRole("combobox", { name: "Project", exact: true })).toHaveValue(target.project.id);
  await expect(board).toHaveValue(destination);
  await expect(form.locator(".overview-task-destination")).toContainText(target.project.cwd);
  await expect(form.getByLabel("Outcome", { exact: true })).toHaveValue(draft);
  await page.locator("#btn-refresh-attention").click();
  await expect(form.getByRole("button", { name: "Create task", exact: true })).toBeDisabled();
  await expect(board).toHaveValue(destination);
  expect((await activeProject(page)).id).toBe(current.project.id);
  expect(await identities(page)).toEqual(beforeInstances.filter((instance) => instance.projectId !== target.project.id));
  expect(await page.evaluate((id) => window.termina.getPlan(id), current.owners[0]!)).toEqual([]);
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(form).toBeHidden();
  await expect(page.locator("#attention-view")).toBeVisible();
});
