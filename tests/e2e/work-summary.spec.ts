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
async function contextField(page: Page, label: string) {
  return page.locator("#work-summary dt").filter({ hasText: new RegExp(`^${label}$`) }).locator("+ dd");
}
async function openContext(page: Page) {
  await expect(page.locator("#work-summary")).toBeVisible();
  await expect(page.locator(".work-summary-heading")).toContainText("Project work");
  await page.locator("#work-summary > summary").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#work-summary")).toHaveAttribute("open", "");
}

test("one-agent context is optional, keyboard-accessible and factual", async ({ page, projectRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  await expect(page.locator("#work-summary")).not.toHaveAttribute("open", "");
  await openContext(page);
  const project = await activeProject(page);
  expect(realpathSync(project.cwd)).toBe(realpathSync(projectRoot));
  await expect(await contextField(page, "Project")).toContainText(project.cwd);
  await expect(await contextField(page, "Agent")).toContainText("term-1");
  await expect(await contextField(page, "Task")).toHaveText("No Plan Board task assigned");
  await expect(await contextField(page, "Execution")).toHaveText("idle");
  await expect(await contextField(page, "Work area")).toContainText("Shared project files");
  await expect(await contextField(page, "Evidence")).toContainText("Not run");
  await expect(await contextField(page, "Attention")).toContainText("idle is not task completion");
  const summary = await page.evaluate((id) => window.termina.getProjectWorkSummary(id), project.id);
  expect(summary?.terminals[0]?.workArea?.kind).toBe("project");
  expect(realpathSync(summary!.terminals[0]!.workArea!.root)).toBe(realpathSync(projectRoot));
  expect(await page.evaluate(() => window.termina.getProjectWorkSummary("missing"))).toBeNull();
  expect(await page.evaluate(() => window.termina.getVerifyReport("term-1", 999_999))).toBeNull();
  await page.locator("#work-summary > summary").click();
  await expect(page.locator("#work-summary")).not.toHaveAttribute("open", "");
  await expect(page.locator(".term-pane.active")).toBeVisible();
});

test("same-name projects retain exact attribution when switching and reading background facts", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const first = await activeProject(page);
  const otherRoot = join(runRoot, "other", basename(projectRoot));
  await mkdir(otherRoot, { recursive: true });
  await writeVerifyPackage(otherRoot, { test: "termina-verify-fixture other" });
  await page.evaluate((root) => window.termina.projectOpenPath(root), otherRoot);
  const second = await activeProject(page);
  expect(second.id).not.toBe(first.id);
  await openContext(page);
  expect(realpathSync(second.cwd)).toBe(realpathSync(otherRoot));
  await expect(await contextField(page, "Project")).toContainText(second.cwd);
  const background = await page.evaluate((id) => window.termina.getProjectWorkSummary(id), first.id);
  expect(background?.root).toBe(first.cwd);
  expect(realpathSync(background!.root)).toBe(realpathSync(projectRoot));
  expect((await activeProject(page)).id).toBe(second.id);
  await page.getByTitle(first.cwd, { exact: true }).click();
  await expect(await contextField(page, "Project")).toContainText(first.cwd);
  expect((await activeProject(page)).id).toBe(first.id);
});

test("a stale check exposes historical execution and bounded output without certifying current source", async ({ page, projectRoot }, testInfo) => {
  await expect(page.locator("#splash")).toBeHidden();
  const project = await activeProject(page);
  expect(await page.evaluate(() => window.termina.runVerify("term-1"))).toEqual({ ok: true });
  await expect.poll(() => page.evaluate((id) => window.termina.getProjectWorkSummary(id).then((summary) => summary?.terminals[0]?.verify?.state), project.id)).toBe("pass");
  await openContext(page);
  await page.getByRole("button", { name: "Check details", exact: true }).click();
  const report = page.locator(".work-summary-report");
  await expect(report).toContainText("**Status:** ✅ PASSED (exit code 0)");
  await expect(report).toContainText("summary-check");
  await writeFile(join(projectRoot, "greeting.ts"), 'export const greeting = "summary changed source";\n');
  await expect(await contextField(page, "Evidence")).toContainText("Outdated · npm run test · historical pass (exit 0)");
  await expect(await contextField(page, "Attention")).toContainText("Verify is outdated");
  await expect(report).toBeHidden();
  await page.getByRole("button", { name: "Check details", exact: true }).click();
  await expect(report).toContainText("**Status:** ⚠️ OUTDATED");
  await expect(report).toContainText("**Historical execution:** ✅ PASSED (exit code 0)");
  await expect(report).toContainText("**Workspace:**");
  await expect(report).toContainText("**Tree:**");
  await expect(report).toContainText("**Elapsed:**");
  await expect(report).toContainText("summary-check");
  await page.evaluate(() => { document.body.style.zoom = "2"; });
  await expect(page.getByRole("button", { name: "Check details", exact: true })).toBeVisible();
  await testInfo.attach("work-context-200-percent", { body: await page.screenshot(), contentType: "image/png" });
});

test("opening a failed terminal clears only the unseen nudge, not factual attention", async ({ page, projectRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const project = await activeProject(page);
  await writeVerifyPackage(projectRoot, { test: "termina-verify-fixture fail" });
  const created = await page.evaluate(() => window.termina.createTerminal({ type: "agent" }));
  expect(created.ok).toBe(true);
  await expect(page.locator("#terminal-tabs-list .terminal-tab")).toHaveCount(2);
  await page.evaluate((id) => {
    (window as unknown as { __panes: Map<string, { tabEl: HTMLElement }> }).__panes.get(id!)!.tabEl.click();
  }, created.id);
  await expect.poll(() => page.evaluate((id) => {
    return (window as unknown as { __panes: Map<string, { tabEl: HTMLElement }> }).__panes.get(id!)?.tabEl.classList.contains("active");
  }, created.id)).toBe(true);
  expect(await page.evaluate(() => window.termina.runVerify("term-1"))).toEqual({ ok: true });
  await expect.poll(() => page.evaluate((id) => window.termina.getProjectWorkSummary(id).then((summary) => summary?.terminals[0]?.verify?.state), project.id)).toBe("fail");
  expect(await page.evaluate(() => (window as unknown as { __panes: Map<string, { verifyAttention: boolean }> }).__panes.get("term-1")!.verifyAttention)).toBe(true);
  await page.evaluate(() => {
    (window as unknown as { __panes: Map<string, { tabEl: HTMLElement }> }).__panes.get("term-1")!.tabEl.click();
  });
  expect(await page.evaluate(() => (window as unknown as { __panes: Map<string, { verifyAttention: boolean }> }).__panes.get("term-1")!.verifyAttention)).toBe(false);
  await openContext(page);
  await expect(await contextField(page, "Attention")).toContainText("Verify failed");
  await page.locator("#work-summary > summary").click();
  await page.locator("#work-summary > summary").click();
  await expect(await contextField(page, "Attention")).toContainText("Verify failed");
  expect((await page.evaluate((id) => window.termina.getProjectWorkSummary(id), project.id))?.terminals.find((terminal) => terminal.terminalId === "term-1")?.attention).toContain("verify-failed");
});
