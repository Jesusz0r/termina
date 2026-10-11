import { test as base, expect } from "./fixtures.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, join } from "node:path";
import type { Page } from "@playwright/test";
import { writeVerifyPackage } from "../fixtures/verify-package.ts";

const test = base.extend({
  projectRoot: async ({ projectRoot }, use) => {
    await writeFile(join(projectRoot, ".gitignore"), "/stages.jsonl\nnode_modules/\n");
    await writeVerifyPackage(projectRoot, { test: "termina-verify-fixture summary-check" });
    await use(projectRoot);
  },
});
async function activeProject(page: Page) {
  return page.evaluate(async () => (await window.termina.projectList()).find((project) => project.active)!);
}
async function openChecks(page: Page) {
  await page.locator("#activity-tab-checks").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#checks-panel")).toBeVisible();
}

test("workspace checks are optional, keyboard accessible and exact-generation, without Project work", async ({ page, projectRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  await expect(page.locator("#work-summary")).toHaveCount(0);
  const project = await activeProject(page);
  expect(realpathSync(project.cwd)).toBe(realpathSync(projectRoot));
  await openChecks(page);
  await expect(page.locator(".checks-context")).toContainText("term-1");
  await expect(page.locator(".checks-context")).toContainText(project.cwd);
  await expect(page.locator(".checks-context")).toContainText("Not run");
  await expect(page.locator(".checks-report")).toBeHidden();
  await page.locator(".checks-details").focus(); await page.keyboard.press("Enter");
  await expect(page.locator(".checks-report")).toContainText("**Status:** NOT RUN");
  expect(await page.evaluate(() => window.termina.getVerifyReport("term-1", 999_999))).toBeNull();
  await expect(page.locator(".term-pane.active")).toBeVisible();
});

test("same-name projects retain exact check attribution and background reads never navigate", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const first = await activeProject(page);
  const otherRoot = join(runRoot, "other", basename(projectRoot));
  await mkdir(otherRoot, { recursive: true });
  await writeVerifyPackage(otherRoot, { test: "termina-verify-fixture other" });
  await page.evaluate((root) => window.termina.projectOpenPath(root), otherRoot);
  const second = await activeProject(page);
  expect(second.id).not.toBe(first.id);
  await openChecks(page);
  await expect(page.locator(".checks-context")).toContainText(second.cwd);
  const background = await page.evaluate((id) => window.termina.getWorkOverview().then((overview) => overview.projects.find((project) => project.projectId === id) ?? null), first.id);
  expect(background?.root).toBe(first.cwd);
  expect((await activeProject(page)).id).toBe(second.id);
  await page.locator(`#project-tabs .project-tab[data-project-id="${first.id}"] .project-select`).click();
  await expect(page.locator(".checks-context")).toContainText(first.cwd);
  expect((await activeProject(page)).id).toBe(first.id);
});

test("stale checks retain historical execution and bounded output without certifying current source", async ({ page, projectRoot }, testInfo) => {
  await expect(page.locator("#splash")).toBeHidden();
  const project = await activeProject(page);
  expect(await page.evaluate(() => window.termina.runVerify("term-1"))).toEqual({ ok: true });
  await expect.poll(() => page.evaluate((id) => window.termina.getWorkOverview().then((overview) => overview.projects.find((project) => project.projectId === id) ?? null).then((summary) => summary?.terminals[0]?.verify?.state), project.id)).toBe("pass");
  await openChecks(page);
  await page.locator(".checks-details").click();
  const report = page.locator(".checks-report");
  await expect(report).toContainText("**Status:** ✅ PASSED (exit code 0)");
  await expect(report).toContainText("summary-check");
  await writeFile(join(projectRoot, "greeting.ts"), 'export const greeting = "summary changed source";\n');
  await expect(page.locator(".checks-context")).toContainText("Outdated · npm run test · historical pass (exit 0)");
  await expect(report).toBeHidden();
  await page.locator(".checks-details").click();
  await expect(report).toContainText("**Status:** ⚠️ OUTDATED");
  await expect(report).toContainText("**Historical execution:** ✅ PASSED (exit code 0)");
  for (const field of ["**Workspace:**", "**Tree:**", "**Elapsed:**", "summary-check"]) await expect(report).toContainText(field);
  await page.evaluate(() => { document.body.style.zoom = "2"; });
  await expect(page.locator(".checks-details")).toBeVisible();
  await testInfo.attach("checks-200-percent", { body: await page.screenshot(), contentType: "image/png" });
});
