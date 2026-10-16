import { test, expect } from "./fixtures.ts";
import { writeFile, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Page } from "@playwright/test";
import type { PlanTask } from "../../shared/types.ts";
import type { editor } from "monaco-editor";
import { savedPlanProject } from "./saved-plan-project.ts";

const chord = process.platform === "darwin" ? "Meta+k" : "Control+k";
const taskText = "Synthetic saved task: Repair <parser> & tokens";
const savedTask = (): PlanTask => ({ text: taskText, paths: ["hello.txt"], state: "pending" });
type EditorWindow = Window & { __editorMgr: {
  editor: editor.IStandaloneCodeEditor;
  openFile(path: string, options: { preview: boolean }): Promise<void>;
  flushDrafts(): Promise<boolean>;
} };

async function activeProject(page: Page) {
  const active = (await page.evaluate(() => window.termina.projectList())).find((project) => project.active);
  expect(active).toBeTruthy();
  return active!;
}

async function seedProject(page: Page, projectRoot: string, runRoot: string, index: number, owners = 1) {
  return savedPlanProject(page, projectRoot, runRoot, index, Array.from({ length: owners }, () => [savedTask()]));
}

async function palette(page: Page, query: string) {
  await page.keyboard.press(chord);
  const modal = page.locator(".search-modal");
  await expect(modal).toBeVisible();
  await modal.locator(".search-input").fill(query);
  return modal;
}

async function terminalIdentities(page: Page) {
  return page.evaluate(async () => (await window.termina.getInstances()).map(({ id, cwd, generation }) => ({ id, cwd, generation })));
}

test("keyboard task search distinguishes same-name background projects and preserves the dirty active editor", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const first = await seedProject(page, projectRoot, runRoot, 1);
  const second = await seedProject(page, projectRoot, runRoot, 2);
  expect(basename(first.project.cwd)).toBe(basename(second.project.cwd));
  await page.locator("#explorer-tree .explorer-row").filter({ hasText: "greeting.ts" }).dblclick();
  // Explorer opening is asynchronous (including the draft claim). Await the
  // canonical pending open before editing, rather than modifying its old model.
  await page.evaluate((path) => (window as unknown as EditorWindow).__editorMgr.openFile(path, { preview: false }), join(second.project.cwd, "greeting.ts"));
  await expect(page.locator(".editor-tab .tab-name").getByText("greeting.ts", { exact: true })).toBeVisible();
  const originalSource = 'export const greeting = "hello";\n';
  await expect.poll(() => page.evaluate(() => (window as unknown as EditorWindow).__editorMgr.editor.getModel()?.getValue())).toBe(originalSource);
  const draft = "// unsaved jump-to-work buffer\n";
  expect(await page.evaluate((text) => {
    const manager = (window as unknown as EditorWindow).__editorMgr;
    const model = manager.editor.getModel()!;
    manager.editor.focus();
    return manager.editor.executeEdits("work-search-test", [{ range: model.getFullModelRange(), text }]);
  }, draft)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as unknown as EditorWindow).__editorMgr.editor.getModel()?.getValue())).toBe(draft);
  await expect(page.locator(".editor-tab .tab-dirty")).toBeVisible();
  expect(await readFile(join(second.project.cwd, "greeting.ts"), "utf8")).toBe(originalSource);
  expect(await page.evaluate(() => (window as unknown as EditorWindow).__editorMgr.flushDrafts())).toBe(true);
  const identities = await terminalIdentities(page);
  const plans = await page.evaluate(async (ids) => Promise.all(ids.map((id) => window.termina.getPlan(id))), [...first.owners, ...second.owners]);
  const modal = await palette(page, "TOKENS repair");
  const rows = modal.locator(".search-hit");
  await expect(rows).toHaveCount(2);
  for (const target of [first, second]) {
    const row = rows.filter({ hasText: target.project.cwd });
    await expect(row.locator(".search-text")).toHaveText(taskText);
    await expect(row.locator(".search-path")).toContainText(target.owners[0]!);
    await expect(row.locator(".search-path")).toContainText(target.project.cwd);
    await expect(row.locator("parser")).toHaveCount(0);
  }
  const index = (await rows.allTextContents()).findIndex((text) => text.includes(first.project.cwd));
  await page.keyboard.press("End");
  await expect(rows.last()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  if (index > 0) await page.keyboard.press("ArrowDown");
  await expect(rows.nth(index)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(modal).toBeHidden();
  await expect(page.locator("#attention-view")).toBeVisible();
  await expect(page.locator("#project-work-inspector, #project-details")).toHaveCount(0);
  await expect.poll(() => page.evaluate((id) => (window as unknown as {
    __panes: Map<string, { tabEl: HTMLElement }>;
  }).__panes.get(id)?.tabEl.classList.contains("active"), first.owners[0]!)).toBe(true);
  const task = page.locator("#plan-list .plan-task").filter({ hasText: taskText });
  await expect(task.locator(".plan-text")).toHaveText(taskText);
  await expect(task.locator(".plan-task-action")).toBeFocused();
  // Task results activate the exact existing Plan Board owner, never execute it.
  expect((await activeProject(page)).id).toBe(first.project.id);
  expect(await terminalIdentities(page)).toEqual(identities);
  expect(await page.evaluate(async (ids) => Promise.all(ids.map((id) => window.termina.getPlan(id))), [...first.owners, ...second.owners])).toEqual(plans);
  expect(await readFile(join(second.project.cwd, "greeting.ts"), "utf8")).toBe(originalSource);
  await page.locator(`#project-tabs .project-tab[data-project-id="${second.project.id}"] .project-select`).click();
  await expect.poll(() => activeProject(page).then((project) => project.id)).toBe(second.project.id);
  await expect.poll(() => page.evaluate(() => (window as unknown as EditorWindow).__editorMgr.editor.getModel()?.getValue())).toBe(draft);
  await expect(page.locator(".editor-tab .tab-dirty")).toBeVisible();
  expect(await readFile(join(second.project.cwd, "greeting.ts"), "utf8")).toBe(originalSource);
  expect(await terminalIdentities(page)).toEqual(identities);
});

test("project result activates the canonical project, rail, editor and terminal roots", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const first = await seedProject(page, projectRoot, runRoot, 1);
  const second = await seedProject(page, projectRoot, runRoot, 2);
  await writeFile(join(first.project.cwd, "greeting.ts"), "// first project source\n");
  const identities = await terminalIdentities(page);
  const modal = await palette(page, first.project.cwd.toUpperCase());
  const projectRow = modal.locator(".search-hit").filter({ has: page.locator(".search-text", { hasText: basename(first.project.cwd) }) });
  await expect(projectRow).toHaveCount(1);
  await expect(projectRow.locator(".search-path")).toContainText(first.project.cwd);
  expect((await activeProject(page)).id).toBe(second.project.id);
  await projectRow.click();
  await expect(modal).toBeHidden({ timeout: 30_000 });
  await expect.poll(() => activeProject(page).then((project) => project.id)).toBe(first.project.id);
  await expect(page.locator(`#project-tabs .project-tab[data-project-id="${first.project.id}"] .project-select`)).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#attention-view")).toBeVisible();
  await page.locator("#explorer-tree .explorer-row").filter({ hasText: "greeting.ts" }).dblclick();
  await expect.poll(() => page.evaluate(() => (window as unknown as EditorWindow).__editorMgr.editor.getModel()?.getValue())).toBe("// first project source\n");
  const overview = await page.evaluate(() => window.termina.getWorkOverview());
  expect(overview.projects.find((project) => project.projectId === first.project.id)?.terminals.map((terminal) => terminal.terminalId)).toEqual(first.owners);
  expect((await terminalIdentities(page)).filter((terminal) => first.owners.includes(terminal.id)).every((terminal) => terminal.cwd === first.project.cwd)).toBe(true);
  expect(await terminalIdentities(page)).toEqual(identities);
});

test("duplicate task text selects the exact plan owner without executing tasks or fetching evidence; existing commands still execute", async ({ page, electronApp, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const target = await seedProject(page, projectRoot, runRoot, 1, 2);
  const background = await seedProject(page, projectRoot, runRoot, 2);
  expect((await activeProject(page)).id).toBe(background.project.id);
  const modal = await palette(page, "repair tokens");
  await expect(modal.locator(".search-hit")).toHaveCount(3);
  const exact = modal.locator(".search-hit").filter({ hasText: target.project.cwd }).filter({ hasText: target.owners[1]! });
  await expect(exact).toHaveCount(1);
  const identities = await terminalIdentities(page);
  const plans = await page.evaluate(async (ids) => Promise.all(ids.map((id) => window.termina.getPlan(id))), target.owners);
  await electronApp.evaluate(({ ipcMain }) => {
    type Invoke = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Invoke> })._invokeHandlers;
    const channels = ["dispatch:run", "verify:run", "verify:report", "review:baseline", "worldline:details", "worldline:file", "worldline:base-file"];
    const originals = new Map(channels.map((channel) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`Missing canonical handler: ${channel}`);
      return [channel, handler] as const;
    }));
    const probe = { calls: [] as string[], restore: () => {
      for (const [channel, handler] of originals) handlers.set(channel, handler);
    } };
    for (const [channel, handler] of originals) handlers.set(channel, (event, ...args) => {
      probe.calls.push(channel);
      return handler(event, ...args);
    });
    (globalThis as SearchProbeGlobal).__workSearchProbe = probe;
  });
  try {
    await exact.click();
    await expect(page.locator("#attention-view")).toBeVisible();
    await expect(page.locator("#project-work-inspector, #project-details")).toHaveCount(0);
    await expect.poll(() => page.evaluate((id) => (window as unknown as {
      __panes: Map<string, { tabEl: HTMLElement }>;
    }).__panes.get(id)?.tabEl.classList.contains("active"), target.owners[1]!)).toBe(true);
    await expect(page.locator("#plan-list .plan-task-action")).toBeFocused();
    expect((await activeProject(page)).id).toBe(target.project.id);
    await expect(page.locator("#plan-list .plan-task")).toHaveCount(1);
    await expect(page.locator("#plan-list")).toContainText(taskText);
    expect(await terminalIdentities(page)).toEqual(identities);
    expect(await page.evaluate(async (ids) => Promise.all(ids.map((id) => window.termina.getPlan(id))), target.owners)).toEqual(plans);
    expect(await electronApp.evaluate(() => (globalThis as SearchProbeGlobal).__workSearchProbe?.calls)).toEqual([]);
    const command = await palette(page, "Quick open");
    await expect(command.locator(".search-hit .search-text")).toHaveText("Quick open");
    await page.keyboard.press("Enter");
    await expect(command.locator(".modal-title")).toHaveText("Quick Open");
    await expect(command.locator(".search-input")).toBeFocused();
    await page.keyboard.press("Escape");
  } finally {
    await electronApp.evaluate(() => {
      const state = globalThis as SearchProbeGlobal;
      state.__workSearchProbe?.restore();
      delete state.__workSearchProbe;
    });
  }
});

test("compact native 200 percent zoom supports keyboard cancellation without activation", async ({ page, electronApp, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  await seedProject(page, projectRoot, runRoot, 1);
  const active = await activeProject(page);
  const identities = await terminalIdentities(page);
  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    win.setSize(1000, 720);
    win.webContents.setZoomFactor(2);
  });
  const opener = page.locator(`#project-tabs .project-tab[data-project-id="${active.id}"] .project-select`);
  await opener.focus();
  const modal = await palette(page, "repair");
  await expect(modal.locator(".search-hit")).toHaveCount(1);
  const box = await modal.locator(".modal").boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  await expect(opener).toBeFocused();
  expect((await activeProject(page)).id).toBe(active.id);
  expect(await terminalIdentities(page)).toEqual(identities);
});

interface OverviewGate { waiting: boolean; release(): void; restore(): void }
type GateGlobal = typeof globalThis & { __workSearchGate?: OverviewGate };
type SearchProbeGlobal = typeof globalThis & { __workSearchProbe?: { calls: string[]; restore(): void } };

test("a closed pending task is refused after a held genuine overview response", async ({ page, electronApp, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const target = await seedProject(page, projectRoot, runRoot, 1);
  const current = await seedProject(page, projectRoot, runRoot, 2);
  const modal = await palette(page, "repair tokens");
  await expect(modal.locator(".search-hit")).toHaveCount(2);
  const identities = await terminalIdentities(page);
  await electronApp.evaluate(({ ipcMain }) => {
    type Invoke = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Invoke> })._invokeHandlers;
    const original = handlers.get("work:overview");
    if (!original) throw new Error("Missing canonical work:overview handler");
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const gate: OverviewGate = {
      waiting: false, release,
      restore: () => { release(); handlers.set("work:overview", original); delete (globalThis as GateGlobal).__workSearchGate; },
    };
    handlers.set("work:overview", async (event, ...args) => {
      // Preserve genuine guarded results and root ownership; delay delivery only.
      // Hold every response so the persistent section's own refresh cannot
      // consume a one-shot gate intended for pending search navigation.
      const result = await original(event, ...args);
      gate.waiting = true;
      await ready;
      return result;
    });
    (globalThis as GateGlobal).__workSearchGate = gate;
  });
  try {
    await modal.locator(".search-hit").filter({ hasText: target.project.cwd }).click();
    await expect(modal.locator(".search-status")).toContainText("Opening work");
    await expect.poll(() => electronApp.evaluate(() => (globalThis as GateGlobal).__workSearchGate?.waiting)).toBe(true);
    // Invoke the existing close button while the modal owns pointer input. No
    // fabricated overview data, direct state changes, or weakened IPC checks.
    await page.evaluate((id) => {
      const close = document.querySelector<HTMLButtonElement>(`#project-tabs .project-tab[data-project-id="${id}"] .tab-close`);
      if (!close) throw new Error("Missing canonical project close action");
      close.click();
    }, target.project.id);
    await expect.poll(() => page.evaluate(async (id) => (await window.termina.projectList()).some((project) => project.id === id), target.project.id)).toBe(false);
    await electronApp.evaluate(() => (globalThis as GateGlobal).__workSearchGate?.release());
    await expect(modal).toBeVisible();
    await expect(modal.locator(".search-status")).toContainText(/changed|closed|unavailable/i);
    await expect(page.locator("#project-work-inspector, #project-details")).toHaveCount(0);
    await expect(page.locator("#attention-view")).toBeVisible();
    expect((await activeProject(page)).id).toBe(current.project.id);
    expect(await terminalIdentities(page)).toEqual(identities.filter((terminal) => !target.owners.includes(terminal.id)));
    await modal.locator(".search-input").fill("test-project");
    await expect(modal.locator(".search-hit").filter({ hasText: target.project.cwd })).toHaveCount(0);
  } finally {
    await electronApp.evaluate(() => (globalThis as GateGlobal).__workSearchGate?.restore());
  }
});
