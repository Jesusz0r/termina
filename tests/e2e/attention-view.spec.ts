import { test as base, expect } from "./fixtures.ts";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { realpathSync } from "node:fs";
import { sanitizeSessionDir } from "../../electron/main/project-workspace.ts";
import { rosterFilePath } from "../../electron/roster-store.ts";
import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import type { WorkAttentionItem, WorkAttentionReason } from "../../shared/types.ts";
import { readVerifyStages, writeVerifyPackage } from "../fixtures/verify-package.ts";

const test = base.extend({
  projectRoot: async ({ projectRoot }, use) => {
    // Verification output and nested navigation fixtures are not tested source.
    await writeFile(join(projectRoot, ".gitignore"), "/stages.jsonl\nnode_modules/\n/nested/\n");
    await writeVerifyPackage(projectRoot, { test: "termina-verify-fixture attention-pass" });
    await use(projectRoot);
  },
});

async function activeProject(page: Page) {
  const project = (await page.evaluate(() => window.termina.projectList())).find((entry) => entry.active);
  expect(project).toBeTruthy();
  return { ...project!, name: basename(project!.cwd) };
}

function projectTab(page: Page, projectId: string) {
  return page.locator(`#project-tabs .project-tab[data-project-id="${projectId}"]`);
}

function attentionItem(page: Page, item: WorkAttentionItem) {
  return page.locator(`#attention-list .attention-item[data-id="${item.id}"]`);
}

async function waitForItem(page: Page, projectId: string, reason: WorkAttentionReason): Promise<WorkAttentionItem> {
  let found: WorkAttentionItem | undefined;
  await expect.poll(async () => {
    found = (await page.evaluate(() => window.termina.getWorkOverview())).items
      .find((item) => item.projectId === projectId && item.reason === reason);
    return Boolean(found);
  }, { timeout: 15_000 }).toBe(true);
  return found!;
}

async function openAttention(page: Page, opener = "#btn-attention") {
  await page.locator(opener).click();
  await expect(page.getByRole("region", { name: "Attention across all projects", exact: true })).toBeVisible();
  await expect(page.locator("#attention-status")).not.toContainText("Loading", { timeout: 15_000 });
}

async function openSameNameProject(page: Page, root: string, testCommand = "termina-verify-fixture other-project-pass") {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, ".gitignore"), "/stages.jsonl\nnode_modules/\n");
  await writeVerifyPackage(root, { test: testCommand });
  await page.evaluate((path) => window.termina.projectOpenPath(path), root);
  const project = await activeProject(page);
  await expect(projectTab(page, project.id)).toHaveClass(/active/);
  return project;
}

async function failVerify(page: Page, projectRoot: string, projectId: string) {
  await writeVerifyPackage(projectRoot, { test: "termina-verify-fixture fail" });
  expect(await page.evaluate(() => window.termina.runVerify("term-1"))).toEqual({ ok: true });
  return waitForItem(page, projectId, "verify-failed");
}

test("startup stays in the workspace; empty global attention is keyboard-accessible and factual", async ({ page }) => {
  await expect(page.locator("#splash")).toBeHidden();
  await expect(page.locator(".term-pane.active")).toBeVisible();
  await expect(page.locator("#attention-view")).toBeHidden();
  await expect(page.locator("aside#project-bar")).toBeVisible();
  const project = await activeProject(page);
  const tab = projectTab(page, project.id);
  await expect(tab.locator(".project-select")).toContainText(project.name);
  await expect(tab.locator(".project-select")).toContainText(project.cwd);
  await expect(tab.getByRole("button", { name: `Close project ${project.name}`, exact: true })).toBeVisible();
  await expect(tab.locator(".project-working")).toContainText("0");
  await expect(tab.locator(".project-attention")).toContainText("0");
  expect((await page.evaluate(() => window.termina.getWorkOverview())).items).toEqual([]);

  const button = page.locator("#btn-attention");
  await expect(button).toBeVisible();
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#attention-view")).toBeVisible();
  await expect(page.locator("#attention-status")).toContainText(/no .*attention|nothing .*attention/i);
  await expect(page.locator("#attention-list .attention-item")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator("#attention-view")).toBeHidden();
  await expect(button).toBeFocused();

  const allProjects = page.locator("#btn-all-projects");
  await allProjects.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("region", { name: "Attention across all projects", exact: true })).toBeVisible();
  expect((await activeProject(page)).id).toBe(project.id);
  await page.locator("#btn-refresh-attention").click();
  await expect(page.locator("#attention-list .attention-item")).toHaveCount(0);
  await page.locator("#btn-close-attention").click();
  await expect(allProjects).toBeFocused();
  await expect(tab.locator(".project-working")).not.toContainText(/success|complete|passed/i);
});

test("sixty saved task results paginate without losing identity, focus or exact plan targeting", async ({ page, projectRoot, runRoot }, testInfo) => {
  await expect(page.locator("#splash")).toBeHidden();
  const restored: Array<{ projectId: string; root: string; terminalId: string }> = [];
  for (let project = 0; project < 3; project++) {
    const root = join(runRoot, `saved-results-${project}`, basename(projectRoot));
    await mkdir(join(runRoot, `saved-results-${project}`));
    execFileSync("git", ["clone", "-q", "--no-hardlinks", projectRoot, root]);
    const terminalId = `term-${project + 2}`;
    // Valid historical roster fixtures, loaded by the real file store/parser.
    // These are not sixty executed workers or injected sidecar/overview state.
    const outcome = (["failed", "incomplete", "interrupted"] as const)[project]!;
    const plan = Array.from({ length: 20 }, (_, index) => ({
      text: `Saved ${outcome} task ${project}-${index} in hello.txt`, paths: ["hello.txt"], state: "pending",
      dispatchResult: { workerId: `term-${100 + project * 20 + index}`, outcome },
    }));
    await writeFile(rosterFilePath(join(runRoot, "user-data"), sanitizeSessionDir(realpathSync(root))), JSON.stringify({
      terminals: [{ id: terminalId, type: "agent", engine: "core", plan }],
    }));
    await page.evaluate((root) => window.termina.projectOpenPath(root), root);
    const owner = await activeProject(page);
    await expect.poll(() => page.evaluate((id) => window.termina.getPlan(id).then((tasks) => tasks.length), terminalId)).toBe(20);
    restored.push({ projectId: owner.id, root: owner.cwd, terminalId });
  }
  const overview = await page.evaluate(() => window.termina.getWorkOverview());
  expect(overview.projects).toHaveLength(4);
  expect(overview.items).toHaveLength(60);
  expect(overview.projects.map((project) => project.working)).toEqual([0, 0, 0, 0]);
  await openAttention(page);
  const rows = page.locator("#attention-list .attention-item");
  await expect(rows).toHaveCount(50);
  const ids = () => rows.evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.id));
  expect(await ids()).toEqual(overview.items.slice(0, 50).map((item) => item.id));
  const first = rows.first().locator(".attention-inspect");
  const retained = await first.elementHandle();
  try {
    await page.locator("#btn-more-attention").focus();
    await expect(page.locator("#btn-more-attention")).toContainText("10 remaining");
    await page.keyboard.press("Enter");
    await expect(rows).toHaveCount(60);
    await expect(rows.nth(50).locator(".attention-inspect")).toBeFocused();
    expect(await ids()).toEqual(overview.items.map((item) => item.id));
    await page.locator("#btn-refresh-attention").click();
    await expect(rows).toHaveCount(60);
    expect(await first.evaluate((button, original) => button === original, retained)).toBe(true);
    const last = overview.items.at(-1)!;
    const owner = restored.find((project) => project.projectId === last.projectId)!;
    await attentionItem(page, last).getByRole("button", { name: "Inspect plan", exact: true }).click();
    expect((await activeProject(page)).id).toBe(owner.projectId);
    await expect(page.locator("#plan-list .plan-task")).toHaveCount(20);
    await expect(page.locator("#plan-list")).toContainText(last.taskText!);
    expect((await page.evaluate(() => window.termina.getWorkOverview())).items).toHaveLength(60);
    await testInfo.attach("attention-restored-results", { body: JSON.stringify({ restored, overview }, null, 2), contentType: "application/json" });
  } finally {
    await retained?.dispose();
  }
});

test("the application Attention command opens the same region and Escape restores its previous focus", async ({ page, electronApp }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const project = await activeProject(page);
  const opener = projectTab(page, project.id).locator(".project-select");
  await opener.focus();
  // Invoke the real application menu command, not a synthetic IPC push.
  await electronApp.evaluate(({ Menu, BrowserWindow }) => {
    const findAttention = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const item of items) {
        if (/attention/i.test(item.label) && item.type === "normal") return item;
        const nested = item.submenu && findAttention(item.submenu.items);
        if (nested) return nested;
      }
      return undefined;
    };
    const action = findAttention(Menu.getApplicationMenu()?.items ?? []);
    if (!action) throw new Error("Application Attention command not found");
    action.click(undefined, BrowserWindow.getAllWindows()[0], {});
  });
  await expect(page.getByRole("region", { name: "Attention across all projects", exact: true })).toBeVisible();
  expect((await activeProject(page)).id).toBe(project.id);
  await page.keyboard.press("Escape");
  await expect(page.locator("#attention-view")).toBeHidden();
  await expect(opener).toBeFocused();
});

test("a background failed Verify is globally attributed and Inspect opens only its canonical evidence", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const original = await activeProject(page);
  const ready = join(runRoot, "attention-verify-ready");
  const release = join(runRoot, "attention-verify-release");
  await writeFile(join(projectRoot, "attention-gate.cjs"), `
const fs = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
(async () => {
  fs.writeFileSync(${JSON.stringify(ready)}, "ready");
  const deadline = Date.now() + 30000;
  while (!fs.existsSync(${JSON.stringify(release)})) {
    if (Date.now() >= deadline) throw new Error("attention verification gate not released");
    await delay(20);
  }
})().catch((error) => { console.error(error); process.exitCode = 9; });
`);
  await writeVerifyPackage(projectRoot, { test: "node attention-gate.cjs && termina-verify-fixture fail" });
  // Prepare the nested source before Verify: navigation during the run must not
  // also create a tree and invalidate the result we are testing.
  const other = await openSameNameProject(page, join(projectRoot, "nested", basename(projectRoot)));
  expect(other.id).not.toBe(original.id);
  expect(other.name).toBe(original.name);
  await projectTab(page, original.id).locator(".project-select").click();
  await expect(projectTab(page, original.id)).toHaveClass(/active/);
  const otherSelect = projectTab(page, other.id).locator(".project-select");
  try {
    expect(await page.evaluate(() => window.termina.runVerify("term-1"))).toEqual({ ok: true });
    await expect.poll(() => access(ready).then(() => true, () => false)).toBe(true);
    await otherSelect.click();
    await expect(projectTab(page, other.id)).toHaveClass(/active/);
    await otherSelect.focus();
    await writeFile(release, "release");
    await expect.poll(() => page.evaluate(async () => (await window.termina.getInstances())
      .find((terminal) => terminal.id === "term-1")?.verify), { timeout: 15_000 })
      .toMatchObject({ state: "fail", result: { state: "fail", exitCode: 7 } });
    const item = await waitForItem(page, original.id, "verify-failed");
    await expect(projectTab(page, original.id).locator(".project-attention")).toContainText("1");
    await expect(projectTab(page, original.id).locator(".project-working")).toContainText("0");
    await expect(page.locator("#btn-attention")).toContainText("1");
    await expect(otherSelect).toBeFocused();
    expect((await activeProject(page)).id).toBe(other.id);

    await openAttention(page);
    expect((await activeProject(page)).id).toBe(other.id);
    const row = attentionItem(page, item);
    await expect(row).toHaveAttribute("data-project-id", original.id);
    await expect(row).toContainText("Verify failed");
    await expect(row).toContainText(item.terminalId);
    await expect(row).toContainText(item.model ?? /model unknown/i);
    await expect(row).toContainText(original.cwd);
    await expect(row).toContainText(/no .*task|task .*unassigned/i);
    await expect(row).toContainText("Shared project files");
    expect(item.workArea?.kind).toBe("project");
    expect(item.workArea?.root).toBe(original.cwd);
    expect(item.action).toMatchObject({ kind: "evidence", terminalId: "term-1", generation: item.generation });

    await projectTab(page, original.id).locator(".project-select").click();
    await expect(page.locator("#attention-view")).toBeVisible();
    await expect(row).toBeVisible();
    await otherSelect.click();
    await expect(page.locator("#attention-view")).toBeVisible();
    await expect(row).toBeVisible();
    const canonicalReport = await page.evaluate(({ terminalId, generation }) => window.termina.getVerifyReport(terminalId, generation), item);
    expect(canonicalReport).toContain("**Status:** ❌ FAILED (exit code 7)");
    await row.locator(".attention-inspect").click();
    await expect(page.locator("#attention-view")).toBeHidden();
    expect((await activeProject(page)).id).toBe(original.id);
    await expect(page.locator("#work-summary")).toHaveAttribute("open", "");
    await expect(page.locator(".work-summary-report")).toBeVisible();
    await expect.poll(() => page.locator(".work-summary-report").textContent()).toBe(canonicalReport);
    await expect(page.locator("#work-summary dd").filter({ hasText: /^term-1 ·/ })).toBeVisible();
    const summary = await page.evaluate((id) => window.termina.getProjectWorkSummary(id), original.id);
    expect(summary?.terminals.find((terminal) => terminal.terminalId === item.terminalId)?.generation).toBe(item.generation);
    expect(await readVerifyStages(projectRoot)).toHaveLength(1);

    await openAttention(page);
    await expect(attentionItem(page, item)).toContainText("Verify failed");
    expect((await page.evaluate(() => window.termina.getWorkOverview())).items.find((entry) => entry.id === item.id)).toEqual(item);
    expect(await readVerifyStages(projectRoot)).toHaveLength(1);
  } finally {
    await writeFile(release, "release");
  }
});

interface AttentionInvokeProbe {
  calls: Array<{ channel: string; target: unknown[] }>;
  restore(): void;
}

test("Attention loads summaries only; exact check output is fetched on inspection", async ({ page, projectRoot, electronApp }, testInfo) => {
  await expect(page.locator("#splash")).toBeHidden();
  const project = await activeProject(page);
  const item = await failVerify(page, projectRoot, project.id);
  const channels = ["work:overview", "verify:report", "timeline:get", "timeline:progress", "review:baseline", "file:open", "worldline:details", "worldline:file", "worldline:base-file"];
  await electronApp.evaluate(({ ipcMain }, channels) => {
    type Invoke = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
    // Observe invokes in this test-owned app only. Preserve the original guarded
    // handlers and results; no preload override, fabricated report or main seam.
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Invoke> })._invokeHandlers;
    const originals = new Map(channels.map((channel) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`Missing canonical handler: ${channel}`);
      return [channel, handler] as const;
    }));
    const probe: AttentionInvokeProbe = {
      calls: [], restore: () => { for (const [channel, handler] of originals) handlers.set(channel, handler); },
    };
    for (const [channel, handler] of originals) handlers.set(channel, (event, ...args) => {
      probe.calls.push({ channel, target: args.slice(0, 2) });
      return handler(event, ...args);
    });
    (globalThis as unknown as { __attentionInvokes: AttentionInvokeProbe }).__attentionInvokes = probe;
  }, channels);
  const calls = () => electronApp.evaluate(() => (globalThis as unknown as { __attentionInvokes: AttentionInvokeProbe }).__attentionInvokes.calls);
  try {
    await openAttention(page);
    await expect.poll(async () => (await calls()).filter((call) => call.channel === "work:overview").length).toBeGreaterThan(0);
    const initialLoads = (await calls()).filter((call) => call.channel === "work:overview").length;
    // Cached rows can open before the coalesced load runs. Observe that first
    // request before demanding a separate explicit Refresh request.
    await page.locator("#btn-refresh-attention").click();
    await expect.poll(async () => (await calls()).filter((call) => call.channel === "work:overview").length).toBeGreaterThan(initialLoads);
    const before = await calls();
    expect(before.filter((call) => call.channel !== "work:overview")).toEqual([]);
    await attentionItem(page, item).getByRole("button", { name: "Inspect check", exact: true }).click();
    await expect(page.locator(".work-summary-report")).toContainText("**Status:** ❌ FAILED (exit code 7)");
    const after = await calls();
    const reports = after.filter((call) => call.channel === "verify:report");
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.every((call) => JSON.stringify(call.target) === JSON.stringify([item.terminalId, item.generation]))).toBe(true);
    expect(await readVerifyStages(projectRoot)).toHaveLength(1);
    expect((await page.evaluate(() => window.termina.getWorkOverview())).items.map((entry) => entry.id)).toContain(item.id);
    await testInfo.attach("attention-lazy-invokes", { body: JSON.stringify({ before, after }, null, 2), contentType: "application/json" });
  } finally {
    await electronApp.evaluate(() => {
      const state = globalThis as unknown as { __attentionInvokes?: AttentionInvokeProbe };
      state.__attentionInvokes?.restore();
      delete state.__attentionInvokes;
    });
  }
});

test("historical pass becomes outdated attention, never current passing evidence", async ({ page, projectRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const project = await activeProject(page);
  expect(await page.evaluate(() => window.termina.runVerify("term-1"))).toEqual({ ok: true });
  await expect.poll(() => page.evaluate((id) => window.termina.getProjectWorkSummary(id).then((summary) => summary?.terminals[0]?.verify?.state), project.id)).toBe("pass");
  expect((await page.evaluate(() => window.termina.getWorkOverview())).items).toEqual([]);
  await writeFile(join(projectRoot, "greeting.ts"), 'export const greeting = "changed after attention verification";\n');
  const item = await waitForItem(page, project.id, "verify-stale");
  await openAttention(page);
  await expect(attentionItem(page, item)).toContainText("Verify is outdated");
  await attentionItem(page, item).locator(".attention-inspect").click();
  await expect(page.locator("#attention-view")).toBeHidden();
  const report = page.locator(".work-summary-report");
  await expect(report).toContainText("**Status:** ⚠️ OUTDATED");
  await expect(report).not.toContainText("**Status:** ✅ PASSED");
  await expect(report).toContainText("**Historical execution:** ✅ PASSED (exit code 0)");
  await expect(report).toContainText("attention-pass");
  await expect.poll(() => report.textContent()).toBe(await page.evaluate(({ terminalId, generation }) => window.termina.getVerifyReport(terminalId, generation), item));
  expect(await readVerifyStages(projectRoot)).toHaveLength(1);
  await openAttention(page);
  await expect(attentionItem(page, item)).toContainText("Verify is outdated");
});

test("missing attention ids reject without activation and ordinary shells produce no phantom issue", async ({ page }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const project = await activeProject(page);
  const shell = await page.evaluate(() => window.termina.createTerminal({ type: "shell" }));
  expect(shell.ok).toBe(true);
  await expect.poll(() => page.evaluate(() => window.termina.getInstances().then((instances) => instances.filter((instance) => instance.type === "shell").length))).toBe(1);
  const before = await page.evaluate(() => window.termina.getWorkOverview());
  expect(before.items).toEqual([]);
  expect(before.projects.find((entry) => entry.projectId === project.id)).toMatchObject({ working: 0, attentionCount: 0 });
  const result = await page.evaluate(() => window.termina.inspectWorkAttention("missing-attention-id"));
  expect(result.ok).toBe(false);
  expect((await activeProject(page)).id).toBe(project.id);
  expect(await page.evaluate(() => window.termina.getWorkOverview())).toEqual(before);
  const summary = await page.evaluate((id) => window.termina.getProjectWorkSummary(id), project.id);
  const shellWork = summary?.terminals.find((terminal) => terminal.terminalId === shell.id);
  expect(shellWork).toMatchObject({ type: "shell", activity: null, verify: null, attention: [] });
  await openAttention(page, "#btn-all-projects");
  await expect(page.locator("#attention-list .attention-item")).toHaveCount(0);
  await expect(page.locator("#attention-status")).toContainText(/no .*attention|nothing .*attention/i);
});

test("closing the active project invalidates its previous attention id instead of activating the wrong root", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const original = await activeProject(page);
  const item = await failVerify(page, projectRoot, original.id);
  const other = await openSameNameProject(page, join(runRoot, "close-other", basename(projectRoot)));
  await projectTab(page, original.id).locator(".project-select").click();
  expect((await activeProject(page)).id).toBe(original.id);
  await openAttention(page);
  await expect(attentionItem(page, item)).toBeVisible();
  await projectTab(page, original.id).getByRole("button", { name: `Close project ${original.name}`, exact: true }).click();
  await expect(projectTab(page, original.id)).toHaveCount(0);
  await expect.poll(async () => (await activeProject(page)).id).toBe(other.id);
  const result = await page.evaluate((id) => window.termina.inspectWorkAttention(id), item.id);
  expect(result.ok).toBe(false);
  expect((await activeProject(page)).id).toBe(other.id);
  await expect(page.locator("#attention-view")).toBeVisible();
  await page.locator("#btn-refresh-attention").click();
  await expect(attentionItem(page, item)).toHaveCount(0);
  expect((await page.evaluate(() => window.termina.getWorkOverview())).projects.map((project) => project.projectId)).toEqual([other.id]);
  expect((await page.evaluate(() => window.termina.getWorkOverview())).items).toEqual([]);
});

test("attention and rail navigation preserve an unsaved editor buffer without writing project source", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const original = await activeProject(page);
  const path = join(projectRoot, "greeting.ts");
  const diskText = await readFile(path, "utf8");
  await page.locator("#explorer-tree .explorer-row").filter({ hasText: "greeting.ts" }).dblclick();
  const greetingTab = page.locator(".editor-tab").filter({ hasText: "greeting.ts" });
  const bufferText = () => page.evaluate(() => (window as unknown as {
    __editorMgr: { editor: { getModel(): { getValue(): string } } };
  }).__editorMgr.editor.getModel().getValue());
  // The click starts an asynchronous file read; edit only its loaded model,
  // not the editor's initial empty model.
  await expect(greetingTab).toHaveClass(/active/);
  await expect.poll(bufferText).toBe(diskText);
  const draft = "// attention navigation must preserve this unsaved buffer\n";
  // Existing renderer editor seam: normal executeEdits, never a bridge override.
  await page.evaluate((text) => {
    const manager = (window as unknown as { __editorMgr: { editor: { getModel(): { getFullModelRange(): unknown }; executeEdits(source: string, edits: { range: unknown; text: string }[]): void } } }).__editorMgr;
    manager.editor.executeEdits("attention-navigation-test", [{ range: manager.editor.getModel().getFullModelRange(), text }]);
  }, draft);
  await expect.poll(bufferText).toBe(draft);
  await expect(greetingTab.locator(".tab-dirty")).toBeVisible();
  await openAttention(page);
  await page.keyboard.press("Escape");
  const other = await openSameNameProject(page, join(runRoot, "draft-other", basename(projectRoot)));
  await openAttention(page, "#btn-all-projects");
  await projectTab(page, original.id).locator(".project-select").click();
  await expect(page.locator("#attention-view")).toBeVisible();
  expect((await activeProject(page)).id).toBe(original.id);
  await page.locator("#btn-close-attention").click();
  await expect.poll(bufferText).toBe(draft);
  await expect(greetingTab.locator(".tab-dirty")).toBeVisible();
  expect(await readFile(path, "utf8")).toBe(diskText);
  await expect(projectTab(page, other.id).locator(".project-select")).toContainText(other.cwd);
});

test("explorer resizing is measured from the explorer, not the persistent rail", async ({ page }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const explorer = page.locator("#explorer");
  const box = await explorer.boundingBox();
  const divider = await page.locator("#explorer-divider").boundingBox();
  expect(box).not.toBeNull();
  expect(divider).not.toBeNull();
  expect(box!.x).toBeGreaterThan(0);
  await page.mouse.move(divider!.x + divider!.width / 2, divider!.y + divider!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + 240, divider!.y + divider!.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await explorer.boundingBox())!.width).toBeCloseTo(240, 0);
  await openAttention(page);
  await page.locator("#btn-close-attention").click();
  await expect.poll(async () => (await explorer.boundingBox())!.width).toBeCloseTo(240, 0);
});

test("the persistent project rail keeps vertical order and works at compact 200 percent zoom", async ({ page, projectRoot, runRoot, electronApp }, testInfo) => {
  await expect(page.locator("#splash")).toBeHidden();
  const original = await activeProject(page);
  const other = await openSameNameProject(page, join(runRoot, "rail-other", basename(projectRoot)));
  const order = () => page.locator("#project-tabs .project-tab").evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.projectId));
  expect(await order()).toEqual([original.id, other.id]);
  const firstBox = await projectTab(page, original.id).boundingBox();
  const secondBox = await projectTab(page, other.id).boundingBox();
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  expect(secondBox!.y).toBeGreaterThanOrEqual(firstBox!.y + firstBox!.height);
  await page.mouse.move(secondBox!.x + secondBox!.width / 2, secondBox!.y + secondBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(firstBox!.x + firstBox!.width / 2, firstBox!.y + 2, { steps: 12 });
  await page.mouse.up();
  await expect.poll(order).toEqual([other.id, original.id]);
  await projectTab(page, original.id).locator(".project-select").click();
  await projectTab(page, other.id).locator(".project-select").click();
  expect(await order()).toEqual([other.id, original.id]);

  await failVerify(page, projectRoot, original.id);
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 720));
  await page.evaluate(() => { document.body.style.zoom = "2"; });
  await expect(page.locator("#btn-attention")).toBeVisible();
  await openAttention(page);
  await expect(page.locator("#btn-close-attention")).toBeVisible();
  await expect(page.locator("#attention-list .attention-inspect")).toBeVisible();
  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return ["--bg", "--bg-panel", "--border", "--text", "--accent"].map((token) => style.getPropertyValue(token).trim());
  });
  expect(tokens.every(Boolean)).toBe(true);
  await testInfo.attach("attention-compact-200-percent", { body: await page.screenshot(), contentType: "image/png" });
});

async function measureOverview(page: Page, samples: number) {
  return page.evaluate(async (count) => {
    const samplesMs: number[] = [];
    let overview: Awaited<ReturnType<typeof window.termina.getWorkOverview>> | undefined;
    for (let index = 0; index < count; index++) {
      const start = performance.now();
      overview = await window.termina.getWorkOverview();
      samplesMs.push(performance.now() - start);
      // Space samples across the bounded output workload, outside the timer.
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const sorted = [...samplesMs].sort((a, b) => a - b);
    return {
      samplesMs, medianMs: sorted[Math.floor(sorted.length / 2)]!,
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
      payloadBytes: new TextEncoder().encode(JSON.stringify(overview)).byteLength,
      projects: overview!.projects.length, items: overview!.items.length,
    };
  }, samples);
}

interface AttentionOutputProbe {
  streams: Record<string, { characters: number; tail: string; done: boolean }>;
  stop(): void;
}

for (const workload of [
  { projects: 3, shellEvery: 1, busySamples: 20, minimizedSamples: 10, maxSeconds: 20 },
  { projects: 12, shellEvery: 2, busySamples: 300, minimizedSamples: 100, maxSeconds: 45 },
]) {
  test(`measures overview IPC across ${workload.projects} projects and ${workload.projects * 2} idle agents during bounded shell output`, async ({ page, projectRoot, runRoot, electronApp }, testInfo) => {
    await expect(page.locator("#splash")).toBeHidden();
    const original = await activeProject(page);
    const projects = [original];
    const shells: string[] = [];
    const idle = [];
    for (let index = 0; index < workload.projects; index++) {
      const root = index === 0 ? projectRoot : join(runRoot, `scale-${index}`, basename(projectRoot));
      if (index !== 0) {
        await mkdir(join(runRoot, `scale-${index}`));
        // Valid source identity is required for current, rather than stale, Verify evidence.
        execFileSync("git", ["clone", "-q", "--no-hardlinks", projectRoot, root]);
      }
      const project = index === 0 ? original : await openSameNameProject(page, root, "termina-verify-fixture fail");
      if (index !== 0) projects.push(project);
      const extra = await page.evaluate((projectId) => window.termina.createTerminal({ type: "agent", projectId }), project.id);
      expect(extra).toMatchObject({ ok: true });
      const agents = (await page.evaluate(() => window.termina.getInstances()))
        .filter((terminal) => terminal.projectId === project.id && terminal.type === "agent");
      expect(agents).toHaveLength(2);
      if (index === 0) await writeVerifyPackage(root, { test: "termina-verify-fixture fail" });
      expect(await page.evaluate((id) => window.termina.runVerify(id), agents[0]!.id)).toEqual({ ok: true });
      await waitForItem(page, project.id, "verify-failed");
      if (index % workload.shellEvery === 0) {
        const shell = await page.evaluate((projectId) => window.termina.createTerminal({ type: "shell", shell: "/bin/bash", projectId }), project.id);
        expect(shell).toMatchObject({ ok: true });
        shells.push(shell.id!);
      }
      idle.push(await measureOverview(page, 10));
    }
    const agents = (await page.evaluate(() => window.termina.getInstances())).filter((terminal) => terminal.type === "agent");
    expect(agents).toHaveLength(workload.projects * 2);
    expect(agents.every((terminal) => !terminal.busy)).toBe(true);
    const paneGeometry = await page.locator(".term-pane").evaluateAll((elements) => elements.map((element) => ({
      width: element.clientWidth, height: element.clientHeight,
      visible: getComputedStyle(element).visibility === "visible", inert: (element as HTMLElement).inert,
    })));
    expect(paneGeometry).toHaveLength(agents.length + shells.length);
    expect(paneGeometry.every((pane) => pane.width > 0 && pane.height > 0)).toBe(true);
    expect(paneGeometry.filter((pane) => pane.visible)).toHaveLength(1);
    expect(paneGeometry.filter((pane) => !pane.visible).every((pane) => pane.inert)).toBe(true);
    await openAttention(page);
    await expect(page.locator("#attention-list .attention-item")).toHaveCount(workload.projects);
    for (const project of projects) {
      await expect(page.locator(`#attention-list .attention-item[data-project-id="${project.id}"]`)).toContainText(project.cwd);
    }
    const inspect = page.locator("#attention-list .attention-inspect").first();
    await inspect.focus();
    const stable = await inspect.elementHandle();
    await page.evaluate((ids) => {
      const streams = Object.fromEntries(ids.map((id) => [id, { characters: 0, tail: "", done: false }]));
      const stop = window.termina.onPtyData(({ id, data }) => {
        const stream = streams[id];
        if (!stream) return;
        stream.characters += data.length;
        stream.tail = (stream.tail + data).slice(-128);
        stream.done ||= stream.tail.includes("ATTENTION_LOAD_DONE");
      });
      (window as unknown as { __attentionOutput: AttentionOutputProbe }).__attentionOutput = { streams, stop };
    }, shells);
    const output = () => page.evaluate(() => (window as unknown as { __attentionOutput: AttentionOutputProbe }).__attentionOutput.streams);
    const stopPath = join(runRoot, "attention-output-stop");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const memory: Array<{ phase: string; main: unknown; renderer: Record<string, number> }> = [];
    async function sampleMemory(phase: string) {
      const { metrics } = await cdp.send("Performance.getMetrics");
      const main = await electronApp.evaluate(({ app, BrowserWindow }) => ({
        memoryBytes: process.memoryUsage(),
        // Electron app metrics use KiB; these are app-owned processes, not a host-wide sample.
        processes: app.getAppMetrics().map(({ pid, type, memory }) => ({ pid, type, memoryKiB: memory })),
        rendererPid: BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId(),
      }));
      const renderer = Object.fromEntries(metrics.filter(({ name }) => ["JSHeapUsedSize", "JSHeapTotalSize", "Nodes", "Documents"].includes(name))
        .map(({ name, value }) => [name, value]));
      expect(renderer.JSHeapUsedSize).toBeGreaterThan(0);
      memory.push({ phase, main, renderer });
    }
    try {
      await sampleMemory("idle");
      // Release after sampling, with a hard duration bound even if the test fails.
      // The control leaf is fixture-private, outside every tested source tree.
      const command = `printf -v line '%4096s' ''; deadline=$((SECONDS+${workload.maxSeconds})); while [[ ! -e ${JSON.stringify(stopPath)} && $SECONDS -lt $deadline ]]; do printf '%s\\n' "$line"; sleep 0.05; done; printf '%s%s\\n' ATTENTION_LOAD_ DONE\r`;
      for (const id of shells) await page.evaluate(({ id, command }) => window.termina.writeTerminal(id, command), { id, command });
      await expect.poll(async () => Object.values(await output()).every((stream) => stream.characters > 4096 && !stream.done)).toBe(true);
      const before = await output();
      await electronApp.evaluate(() => {
        const pulse = { ticks: 0, maxIntervalMs: 0, timer: undefined as ReturnType<typeof setInterval> | undefined };
        let previous = performance.now();
        pulse.timer = setInterval(() => {
          const now = performance.now();
          pulse.maxIntervalMs = Math.max(pulse.maxIntervalMs, now - previous);
          pulse.ticks++;
          previous = now;
        }, 10);
        (globalThis as unknown as { __attentionMainPulse: typeof pulse }).__attentionMainPulse = pulse;
      });
      const busy = await measureOverview(page, workload.busySamples);
      await sampleMemory("busy");
      await expect(inspect).toBeFocused();
      // The nonmodal Attention region overlaps this pointer target; use its real keyboard action.
      await page.locator("#btn-min-terminal").focus();
      await page.keyboard.press("Space");
      await expect(page.locator(".term-pane.active:visible")).toHaveCount(0);
      expect(await page.locator(".term-pane").evaluateAll((elements) => elements.every((element) => element.clientWidth > 0 && element.clientHeight > 0))).toBe(true);
      const minimized = await measureOverview(page, workload.minimizedSamples);
      await sampleMemory("minimized");
      await page.locator("#btn-min-terminal").focus();
      await page.keyboard.press("Space");
      await inspect.focus();
      const mainPulse = await electronApp.evaluate(() => {
        const state = globalThis as unknown as { __attentionMainPulse: { ticks: number; maxIntervalMs: number; timer: ReturnType<typeof setInterval> } };
        const { ticks, maxIntervalMs, timer } = state.__attentionMainPulse;
        clearInterval(timer);
        return { ticks, maxIntervalMs, nominalIntervalMs: 10 };
      });
      const after = await output();
      await testInfo.attach("attention-overview-samples", { body: JSON.stringify({ idle, busy, minimized, mainPulse, before, after }, null, 2), contentType: "application/json" });
      expect(busy.projects).toBe(workload.projects);
      expect(busy.items).toBe(workload.projects);
      expect(minimized.projects).toBe(workload.projects);
      expect(minimized.items).toBe(workload.projects);
      expect(mainPulse.ticks).toBeGreaterThan(0);
      expect(shells.every((id) => after[id]!.characters > before[id]!.characters && !after[id]!.done)).toBe(true);
      await expect(inspect).toBeFocused();
      expect(await inspect.evaluate((button, originalButton) => button === originalButton, stable)).toBe(true);
      await page.keyboard.press("Escape");
      await expect(page.locator("#attention-view")).toBeHidden();
      await expect(page.locator("#btn-attention")).toBeFocused();
      await writeFile(stopPath, "stop");
      await expect.poll(async () => Object.values(await output()).every((stream) => stream.done), { timeout: 15_000 }).toBe(true);
      await sampleMemory("output-finished");
      // Repeated ordinary navigation must reuse the same bounded rows and restore focus.
      for (let cycle = 0; cycle < 10; cycle++) {
        await openAttention(page);
        await expect(page.locator("#attention-list .attention-item")).toHaveCount(workload.projects);
        await page.keyboard.press("Escape");
        await expect(page.locator("#btn-attention")).toBeFocused();
      }
      await sampleMemory("after-ten-open-close-cycles");
      const result = { workload: { projects: workload.projects, idleAgentTerminals: agents.length, shells: shells.length, maxSecondsPerShell: workload.maxSeconds, lineCharacters: 4096 }, idle, busy, minimized, mainPulse, memory, output: await output() };
      console.log("attention overview scale baseline", JSON.stringify(result));
      await testInfo.attach("attention-overview-scale", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
    } finally {
      await writeFile(stopPath, "stop");
      await electronApp.evaluate(() => {
        const state = globalThis as unknown as { __attentionMainPulse?: { timer: ReturnType<typeof setInterval> } };
        if (state.__attentionMainPulse) clearInterval(state.__attentionMainPulse.timer);
        delete state.__attentionMainPulse;
      });
      await page.evaluate(() => {
        const state = window as unknown as { __attentionOutput?: AttentionOutputProbe };
        state.__attentionOutput?.stop();
        delete state.__attentionOutput;
      });
      await stable?.dispose();
      await cdp.detach();
    }
  });
}

test("keyboard inspection reflows at native 200 percent zoom with enlarged inherited text and reduced motion", async ({ page, projectRoot, electronApp }, testInfo) => {
  await expect(page.locator("#splash")).toBeHidden();
  const project = await activeProject(page);
  const item = await failVerify(page, projectRoot, project.id);
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    window.setSize(900, 700);
    window.webContents.setZoomFactor(2);
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => { document.body.style.fontSize = "20px"; });
  const opener = page.locator("#btn-all-projects");
  await opener.focus();
  await page.keyboard.press("Enter");
  const region = page.getByRole("region", { name: "Attention across all projects", exact: true });
  const close = page.getByRole("button", { name: "Close attention", exact: true });
  await expect(region).toBeVisible();
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  const inspect = attentionItem(page, item).getByRole("button", { name: "Inspect check", exact: true });
  await expect(inspect).toBeFocused();
  expect(await inspect.evaluate((button) => getComputedStyle(button).outlineStyle)).not.toBe("none");
  const geometry = await region.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom,
      clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      animations: element.getAnimations({ subtree: true }).length,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport.width + 1);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewport.height + 1);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  expect(geometry.reducedMotion).toBe(true);
  expect(geometry.animations).toBe(0);
  const semantics = await region.ariaSnapshot();
  expect(semantics).toContain('heading "Attention across all projects" [level=2]');
  expect(semantics).toContain(project.cwd);
  expect(semantics).toContain('button "Inspect check"');
  await testInfo.attach("attention-accessibility-geometry", { body: JSON.stringify(geometry, null, 2), contentType: "application/json" });
  await testInfo.attach("attention-accessibility-tree", { body: semantics, contentType: "text/plain" });
  await testInfo.attach("attention-native-zoom-enlarged-text", { body: await page.screenshot(), contentType: "image/png" });
  await page.keyboard.press("Escape");
  await expect(region).toBeHidden();
  await expect(opener).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(inspect).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(region).toBeHidden();
  await expect(page.locator(".work-summary-report")).toContainText("**Status:** ❌ FAILED (exit code 7)");
  expect((await activeProject(page)).id).toBe(project.id);
  expect(await readVerifyStages(projectRoot)).toHaveLength(1);
  expect((await page.evaluate(() => window.termina.getWorkOverview())).items.map((entry) => entry.id)).toContain(item.id);
});
