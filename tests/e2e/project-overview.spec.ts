import { test as base, expect } from "./fixtures.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { PlanTask } from "../../shared/types.ts";
import { activeProject, savedPlanProject } from "./saved-plan-project.ts";
import { MAX_ROSTER_PLAN_TASKS } from "../../electron/terminal-roster.ts";
import { readVerifyStages, writeVerifyPackage } from "../fixtures/verify-package.ts";

const test = base.extend({
  projectRoot: async ({ projectRoot }, use) => {
    await writeFile(join(projectRoot, ".gitignore"), "/stages.jsonl\nnode_modules/\n");
    await writeVerifyPackage(projectRoot, { test: "termina-verify-fixture fail" });
    await use(projectRoot);
  },
});

async function savedProject(page: Page, projectRoot: string, runRoot: string, index: number, plan: PlanTask[]) {
  const boards = Array.from({ length: Math.ceil(plan.length / MAX_ROSTER_PLAN_TASKS) }, (_, board) =>
    plan.slice(board * MAX_ROSTER_PLAN_TASKS, (board + 1) * MAX_ROSTER_PLAN_TASKS));
  return (await savedPlanProject(page, projectRoot, runRoot, index, boards)).project;
}
async function openOverview(page: Page) {
  await page.locator("#btn-all-projects").click();
  await expect(page.getByRole("region", { name: "All projects", exact: true })).toBeVisible();
  await expect(page.locator(".overview-status")).toContainText(/project/);
}
function lane(page: Page, projectId: string) {
  return page.locator(`.overview-project[data-project-id="${projectId}"]`);
}

function savedTasks(index: number): PlanTask[] {
  return [
    { text: "Repair the parser", paths: ["hello.txt"], state: "pending" },
    { text: `Recover task ${index}`, paths: [], state: "pending", dispatchResult: { workerId: `term-${100 + index}`, outcome: index === 1 ? "incomplete" : "failed" } },
    { text: `Recorded done ${index}`, paths: [], state: "done" },
  ];
}

test("All projects shows three real projects and six Plan Board tasks; filtering never hides global attention", async ({ page, projectRoot, runRoot, electronApp }, testInfo) => {
  await expect(page.locator("#splash")).toBeHidden();
  const original = await activeProject(page);
  const first = await savedProject(page, projectRoot, runRoot, 1, savedTasks(1));
  const second = await savedProject(page, projectRoot, runRoot, 2, savedTasks(2));
  const before = await page.evaluate(() => window.termina.getWorkOverview());
  expect(before.projects).toHaveLength(3);
  expect(before.projects.flatMap((project) => project.terminals.flatMap((terminal) => terminal.tasks))).toHaveLength(6);
  expect(before.items).toHaveLength(2);
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900));
  await openOverview(page);
  await expect(page.locator(".overview-project")).toHaveCount(3);
  const positions = await page.locator(".overview-project").evaluateAll((projects) => projects.map((project) => {
    const box = project.getBoundingClientRect(); return { x: box.x, y: box.y };
  }));
  expect(positions[1]!.x).toBeGreaterThan(positions[0]!.x);
  expect(positions[2]!.x).toBeGreaterThan(positions[1]!.x);
  expect(positions.map((box) => box.y)).toEqual([positions[0]!.y, positions[0]!.y, positions[0]!.y]);
  await expect(page.locator(".overview-status")).toContainText("3 projects · 6 Plan Board tasks");
  await expect(page.locator("#attention-list .attention-item")).toHaveCount(2);
  await expect(page.locator("#btn-all-projects")).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#project-tabs .project-select[aria-current]")).toHaveCount(0);
  expect((await activeProject(page)).id).toBe(second.id);
  await expect(lane(page, original.id)).toContainText("No Plan Board task assigned");
  await expect(lane(page, first.id)).toContainText(first.cwd);
  await expect(lane(page, second.id)).toContainText(second.cwd);
  await expect(lane(page, first.id)).toContainText("Marked pending");
  await expect(lane(page, first.id)).toContainText("Previous attempt incomplete");
  await expect(lane(page, second.id)).toContainText("Previous attempt failed");
  await expect(lane(page, first.id)).toContainText("Marked done");
  await expect(lane(page, first.id)).toContainText("Shared project files");
  expect(await page.locator("#main-split").evaluate((node) => (node as HTMLElement).inert)).toBe(true);
  await testInfo.attach("all-projects-real-overview", { body: await page.screenshot(), contentType: "image/png" });

  const filter = page.getByRole("searchbox", { name: "Filter projects and tasks" });
  await filter.fill(first.cwd);
  await expect(page.locator(".overview-project")).toHaveCount(1);
  await expect(lane(page, first.id)).toBeVisible();
  await expect(page.locator("#attention-list .attention-item")).toHaveCount(2);
  await expect(page.locator(`#attention-list .attention-item[data-project-id="${second.id}"]`)).toContainText(second.cwd);
  expect((await activeProject(page)).id).toBe(second.id);

  const card = lane(page, first.id).locator(".overview-work-card").filter({ hasText: "Repair the parser" });
  await card.getByRole("button", { name: "Task details", exact: true }).click();
  const inspector = page.getByRole("complementary", { name: "Selected work details", exact: true });
  await expect(inspector).toBeVisible();
  await expect(inspector.locator(".overview-inspector-title")).toHaveText("Repair the parser");
  await expect(inspector).toContainText(first.cwd);
  await expect(inspector).toContainText("Marked pending");
  await expect(inspector).toContainText("No live worker assigned");
  await expect(inspector).toContainText("Owner check: Not run");
  await expect(inspector).toContainText("Declared task paths");
  await expect(inspector).toContainText("hello.txt");
  await expect(card.locator(".overview-inspect")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#attention-view")).toBeVisible();
  await expect(page.locator("#attention-list .attention-item")).toHaveCount(2);
  expect((await activeProject(page)).id).toBe(second.id);
  await filter.fill(second.cwd);
  await expect(page.locator(".overview-project")).toHaveCount(1);
  await expect(lane(page, second.id)).toBeVisible();
  await expect(inspector.locator(".overview-inspector-title")).toHaveText("Repair the parser");
  await expect(page.locator("#attention-list .attention-item")).toHaveCount(2);
  await page.locator("#btn-refresh-attention").click();
  await expect(inspector).toContainText(first.cwd);
  await expect(page.locator("#btn-refresh-attention")).toBeFocused();
  await testInfo.attach("all-projects-selected-task-inspector", { body: await page.screenshot(), contentType: "image/png" });
  await inspector.getByRole("button", { name: "Open plan", exact: true }).click();
  await expect(page.locator("#attention-view")).toBeHidden();
  expect((await activeProject(page)).id).toBe(first.id);
  await expect(page.locator("#plan-list .plan-task")).toHaveCount(3);
  await expect(page.locator("#plan-list")).toContainText("Repair the parser");
  await expect(page.locator("#activity-tab-plan")).toBeFocused();
  expect(await page.locator("#main-split").evaluate((node) => (node as HTMLElement).inert)).toBe(false);
  // Model metadata can settle during core startup; inspecting must preserve every
  // reason's identity, detail, assigned source and action, not freeze its live model.
  const withoutModel = ({ model: _model, ...reason }: (typeof before.items)[number]) => reason;
  expect((await page.evaluate(() => window.termina.getWorkOverview())).items.map(withoutModel)).toEqual(before.items.map(withoutModel));
  await expect(page.locator("#btn-all-projects")).not.toHaveAttribute("aria-current", "page");
});

test("ordinary shells stay unknown and closing a project removes only its work cards and attention", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const original = await activeProject(page);
  const shell = await page.evaluate(() => window.termina.createTerminal({ type: "shell" }));
  expect(shell.ok).toBe(true);
  const other = await savedProject(page, projectRoot, runRoot, 1, savedTasks(1));
  await openOverview(page);
  const shellCard = lane(page, original.id).locator(".overview-work-card").filter({ hasText: `Shell · ${shell.id}` });
  await expect(shellCard).toContainText("Shell activity unknown");
  await expect(shellCard).toContainText("Check: unavailable for shells");
  await expect(shellCard).not.toContainText(/completed|verified|reviewed/);
  await expect(page.locator("#attention-list .attention-item")).toHaveCount(1);
  await lane(page, other.id).locator(".overview-work-card").filter({ hasText: "Recover task 1" }).locator(".overview-inspect").click();
  await expect(page.locator("#project-work-inspector")).toContainText("Previous attempt incomplete");
  await page.locator(`#project-tabs .project-tab[data-project-id="${other.id}"] .tab-close`).click();
  await expect(page.locator(".overview-inspector-status")).toContainText("changed or closed");
  await expect(page.locator(".overview-inspector-primary")).toBeDisabled();
  await expect(page.locator(".overview-inspector-facts")).toBeHidden();
  await expect(lane(page, other.id)).toHaveCount(0);
  await expect(lane(page, original.id)).toBeVisible();
  await expect(page.locator(".overview-status")).toContainText("1 project · 0 Plan Board tasks");
  await expect(page.locator("#attention-list .attention-item")).toHaveCount(0);
  await expect(shellCard).toContainText("Shell activity unknown");
  expect((await activeProject(page)).id).toBe(original.id);
  await shellCard.getByRole("button", { name: "Context details", exact: true }).click();
  await expect(page.locator("#project-work-inspector")).toContainText("Shell activity unknown");
  await expect(page.locator(".overview-inspector-check")).toBeHidden();
  await expect(page.locator(".overview-inspector-plan")).toBeHidden();
  await page.locator(`#project-tabs .project-tab[data-project-id="${original.id}"] .project-select`).click();
  await expect(page.locator("#attention-view")).toBeHidden();
  expect(await page.locator("#main-split").evaluate((node) => (node as HTMLElement).inert)).toBe(false);
});

test("large real Plan Boards page explicitly and preserve keyboard focus at compact 200 percent zoom", async ({ page, projectRoot, runRoot, electronApp }, testInfo) => {
  await expect(page.locator("#splash")).toBeHidden();
  const plan: PlanTask[] = Array.from({ length: 72 }, (_, index) => ({ text: `Saved task ${index}`, paths: [], state: "pending" }));
  const project = await savedProject(page, projectRoot, runRoot, 1, plan);
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    window.setSize(1000, 720);
    window.webContents.setZoomFactor(2);
  });
  const all = page.locator("#btn-all-projects");
  await all.focus(); await page.keyboard.press("Space");
  await expect(page.getByRole("region", { name: "All projects", exact: true })).toBeVisible();
  await expect(lane(page, project.id).locator(".overview-work-card")).toHaveCount(50);
  const more = lane(page, project.id).getByRole("button", { name: "Show more work (22 remaining)", exact: true });
  await more.focus(); await page.keyboard.press("Enter");
  await expect(lane(page, project.id).locator(".overview-work-card")).toHaveCount(72);
  await expect(lane(page, project.id).locator(".overview-work-card").nth(50).locator(".overview-inspect")).toBeFocused();
  const filter = page.getByRole("searchbox", { name: "Filter projects and tasks" });
  await filter.fill("Saved task 71");
  await expect(page.locator(".overview-work-card")).toHaveCount(1);
  await expect(page.locator(".overview-work-card")).toContainText("Saved task 71");
  await expect(filter).toBeFocused();
  const box = await page.locator("#attention-view").boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(box!.x).toBeGreaterThan(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  const task = page.locator(".overview-work-card .overview-inspect");
  await task.focus(); await page.keyboard.press("Enter");
  await expect(page.locator(".overview-inspector-title")).toHaveText("Saved task 71");
  await expect(page.locator(".overview-inspector-title")).toBeFocused();
  const inspectorBox = await page.locator("#project-work-inspector").boundingBox();
  expect(inspectorBox!.x).toBeGreaterThanOrEqual(box!.x);
  expect(inspectorBox!.x + inspectorBox!.width).toBeLessThanOrEqual(viewport.width + 1);
  await testInfo.attach("all-projects-compact-200-percent", { body: await page.screenshot(), contentType: "image/png" });
  await page.keyboard.press("Escape");
  await expect(page.locator("#project-work-inspector")).toBeHidden();
  await expect(page.locator("#attention-view")).toBeVisible();
  await expect(task).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#attention-view")).toBeHidden();
  await expect(all).toBeFocused();
});

test("background check inspection stays in All projects, preserves attention and discards outdated output", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const original = await activeProject(page);
  expect(await page.evaluate(() => window.termina.runVerify("term-1"))).toEqual({ ok: true });
  await expect.poll(() => page.evaluate(async () => (await window.termina.getInstances())
    .find((terminal) => terminal.id === "term-1")?.verify), { timeout: 15_000 })
    .toMatchObject({ state: "fail", result: { state: "fail", exitCode: 7 } });
  const other = await savedProject(page, projectRoot, runRoot, 1, savedTasks(1));
  const before = (await page.evaluate(() => window.termina.getWorkOverview())).items;
  await openOverview(page);
  await lane(page, original.id).getByRole("button", { name: "Context details", exact: true }).click();
  const inspector = page.locator("#project-work-inspector");
  await expect(inspector).toContainText(original.cwd);
  await expect(inspector).toContainText("Check: fail");
  await expect(page.locator(".overview-inspector-report")).toBeHidden();
  expect((await activeProject(page)).id).toBe(other.id);
  await inspector.getByRole("button", { name: "Check details", exact: true }).click();
  const report = inspector.locator(".overview-inspector-report");
  await expect(report).toContainText("FAILED (exit code 7)");
  await expect(report).toContainText(original.cwd);
  await expect(report).toContainText("termina-verify-fixture fail");
  await expect(report).not.toContainText(other.cwd);
  await expect(page.locator("#attention-view")).toBeVisible();
  await expect(page.locator("#attention-list .attention-item")).toHaveCount(before.length);
  expect((await activeProject(page)).id).toBe(other.id);
  const withoutModel = ({ model: _model, ...reason }: (typeof before)[number]) => reason;
  expect((await page.evaluate(() => window.termina.getWorkOverview())).items.map(withoutModel)).toEqual(before.map(withoutModel));

  await writeFile(join(projectRoot, "hello.txt"), "source moved after verification\n");
  await expect(inspector).toContainText("Check: Outdated");
  await expect(report).toBeHidden();
  await inspector.getByRole("button", { name: "Check details", exact: true }).click();
  await expect(report).toContainText("OUTDATED");
  await expect(report).toContainText("Historical execution");
  await expect(report).toContainText("exit code 7");
  expect(await readVerifyStages(projectRoot)).toHaveLength(1); // Inspection never reruns the command.
  expect((await activeProject(page)).id).toBe(other.id);
  await inspector.getByRole("button", { name: "Open terminal", exact: true }).click();
  await expect(page.locator("#attention-view")).toBeHidden();
  expect((await activeProject(page)).id).toBe(original.id);
  expect(await page.evaluate(() => (window as unknown as { __panes: Map<string, { tabEl: HTMLElement }> })
    .__panes.get("term-1")!.tabEl.classList.contains("active"))).toBe(true);
});

test("an empty workspace gives a real project-opening action instead of sample tasks", async ({ page }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const original = await activeProject(page);
  await page.locator(`#project-tabs .project-tab[data-project-id="${original.id}"] .tab-close`).click();
  await expect(page.locator("#project-tabs .project-tab")).toHaveCount(0);
  await openOverview(page);
  await expect(page.locator(".overview-project")).toHaveCount(0);
  await expect(page.locator(".overview-empty")).toContainText("Open a project to see its work");
  await expect(page.getByRole("button", { name: "Open a project", exact: true })).toBeVisible();
  await expect(page.locator(".overview-status")).toContainText("0 projects · 0 Plan Board tasks");
  expect(await page.evaluate(() => window.termina.getWorkOverview())).toEqual({ projects: [], items: [] });
});
