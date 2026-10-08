import { expect, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import type { PlanTask } from "../../shared/types.ts";
import { sanitizeSessionDir } from "../../electron/main/project-workspace.ts";
import { rosterFilePath } from "../../electron/roster-store.ts";

export async function activeProject(page: Page) {
  const project = (await page.evaluate(() => window.termina.projectList())).find((entry) => entry.active);
  expect(project).toBeTruthy();
  return project!;
}

/** Restore real Plan Boards through the existing roster, in a fixture-owned clone. */
export async function savedPlanProject(page: Page, projectRoot: string, runRoot: string, index: number, plans: PlanTask[][] = [[], []]) {
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
  const project = await activeProject(page);
  // Restored concurrent agents receive new independent-session terminal IDs.
  // The canonical instance list preserves the project's terminal strip order.
  const restored = await page.evaluate(async (projectId) => (await window.termina.getInstances())
    .filter((instance) => instance.projectId === projectId), project.id);
  expect(restored).toHaveLength(boards.length);
  expect(restored.map((instance) => instance.type)).toEqual(boards.map((board) => board.type));
  const owners = restored.map((instance) => instance.id);
  await expect.poll(() => page.evaluate(async (ids) => Promise.all(ids.map((id) => window.termina.getPlan(id))), owners)).toEqual(boards.map((board) => board.plan));
  return { project, owners, roster };
}
