import { test, expect, type TerminaE2EFixtures } from "./fixtures.ts";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSidecarRecord } from "../../electron/sidecar.ts";
import { quoteShellArg } from "../../shared/terminal-control.ts";
import { answerLifecycleDialog, lifecycleDialogs, mockLifecycleDialogs } from "./lifecycle-dialog.ts";

async function firstAgent(page: TerminaE2EFixtures["page"]) {
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
  const instances = await page.evaluate(() => window.termina.getInstances());
  return instances.find((instance) => instance.type === "agent")!;
}

/** Append a producer-bound event, using the canonical sidecar parser. */
async function workingAgent(page: TerminaE2EFixtures["page"], runRoot: string, id: string): Promise<void> {
  const path = join(runRoot, "events", `${id}.jsonl`);
  const stream = () => {
    if (!existsSync(path)) return null;
    let latest: { bridgeId: string; seq: number; producerPid: number } | null = null;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const record = parseSidecarRecord(line);
      if (!record || typeof record.bridgeId !== "string" || typeof record.seq !== "number" || typeof record.producerPid !== "number") continue;
      latest = { bridgeId: record.bridgeId, seq: record.seq, producerPid: record.producerPid };
    }
    return latest;
  };
  await expect.poll(stream, { timeout: 15_000 }).not.toBeNull();
  const last = stream()!;
  appendFileSync(path, JSON.stringify({ bridgeId: last.bridgeId, seq: last.seq! + 1, producerPid: last.producerPid, t: "agent_start" }) + "\n");
  await expect.poll(() => page.evaluate((id) => window.termina.getInstances().then((instances) => instances.find((instance) => instance.id === id)?.activity?.state), id)).toBe("working");
  await expect.poll(() => page.evaluate((id) => window.termina.getRuns(id).then((runs) => runs.some((run) => run.settledAt === null)), id)).toBe(true);
}

async function clickTerminalClose(page: TerminaE2EFixtures["page"], id: string): Promise<void> {
  await page.evaluate((id) => {
    const pane = (window as unknown as { __panes: Map<string, { tabEl: HTMLElement }> }).__panes.get(id)!;
    (pane.tabEl.querySelector(".tab-close") as HTMLElement).click();
  }, id);
}

async function paneExists(page: TerminaE2EFixtures["page"], id: string): Promise<boolean> {
  return page.evaluate((id) => (window as unknown as { __panes: Map<string, unknown> }).__panes.has(id), id);
}

async function shellCommand(page: TerminaE2EFixtures["page"], root: string) {
  const created = await page.evaluate(() => window.termina.createTerminal({ type: "shell" }));
  expect(created.ok).toBe(true);
  const id = created.id!;
  const pidFile = join(root, `${id}-command.pid`);
  const script = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
  await page.evaluate(({ id, command }) => window.termina.writeTerminal(id, command), { id, command: `node -e ${quoteShellArg(script)}\r` });
  await expect.poll(() => existsSync(pidFile)).toBe(true);
  const pid = Number(readFileSync(pidFile, "utf8"));
  const instance = await page.evaluate((id) => window.termina.getInstances().then((instances) => instances.find((instance) => instance.id === id)!), id);
  return { instance, pid };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("busy agent close keeps the pane through confirmation and Cancel; acceptance removes it", async ({ page, electronApp, runRoot, projectRoot }) => {
  const agent = await firstAgent(page);
  await workingAgent(page, runRoot, agent.id);
  await mockLifecycleDialogs(electronApp, 1, true);
  await clickTerminalClose(page, agent.id);
  await expect.poll(() => lifecycleDialogs(electronApp).then((dialogs) => dialogs.length)).toBe(1);
  const options = (await lifecycleDialogs(electronApp))[0];
  expect(options.message).toBe(`Close terminal ${agent.id}?`);
  expect(options.detail).toContain("active agent");
  expect(options.detail).toContain(projectRoot);
  expect(options.defaultId).toBe(1);
  expect(await paneExists(page, agent.id)).toBe(true);
  await answerLifecycleDialog(electronApp, 1);
  await expect.poll(() => page.evaluate(() => window.termina.getInstances().then((instances) => instances.map((instance) => instance.id)))).toContain(agent.id);
  expect(await paneExists(page, agent.id)).toBe(true);
  await answerLifecycleDialog(electronApp, 0);
  await clickTerminalClose(page, agent.id);
  await expect.poll(() => paneExists(page, agent.id)).toBe(false);
  await expect.poll(() => page.evaluate(() => window.termina.getInstances().then((instances) => instances.map((instance) => instance.id)))).not.toContain(agent.id);
});

test("closing a long shell command discloses unknown activity and preserves it on Cancel", async ({ page, electronApp, projectRoot }) => {
  await firstAgent(page);
  const { instance, pid } = await shellCommand(page, projectRoot);
  await mockLifecycleDialogs(electronApp, 1);
  const cancelled = await page.evaluate(({ id, generation }) => window.termina.closeTerminal(id, generation), instance);
  expect(cancelled).toEqual({ ok: false, cancelled: true });
  expect(alive(pid)).toBe(true);
  expect(await paneExists(page, instance.id)).toBe(true);
  const options = (await lifecycleDialogs(electronApp))[0];
  expect(options.detail).toContain("shell (command activity unknown)");
  expect(options.detail).toContain("not a detach");
  await answerLifecycleDialog(electronApp, 0);
  expect(await page.evaluate(({ id, generation }) => window.termina.closeTerminal(id, generation), instance)).toEqual({ ok: true });
  await expect.poll(() => paneExists(page, instance.id)).toBe(false);
  await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
});

test("background project close names its work without stopping the foreground project", async ({ page, electronApp, projectRoot, runRoot }) => {
  const agent = await firstAgent(page);
  await workingAgent(page, runRoot, agent.id);
  const otherRoot = join(runRoot, "close-other-project");
  mkdirSync(otherRoot, { recursive: true });
  writeFileSync(join(otherRoot, "other.txt"), "other project\n");
  await page.evaluate((path) => window.termina.projectOpenPath(path), otherRoot);
  await expect(page.locator(".project-tab.active")).toContainText("close-other-project");
  const { instance: otherShell, pid } = await shellCommand(page, otherRoot);
  await mockLifecycleDialogs(electronApp, 1);
  expect(await page.evaluate((id) => window.termina.projectClose(id), agent.projectId!)).toMatchObject({ ok: false, cancelled: true });
  const options = (await lifecycleDialogs(electronApp))[0];
  expect(options.message).toBe(`Close project ${projectRoot}?`);
  expect(options.detail).toContain(agent.id);
  expect(options.detail).not.toContain(otherShell.id);
  expect(options.detail).toContain("Other projects remain open and keep running");
  expect(await paneExists(page, agent.id)).toBe(true);
  expect(alive(pid)).toBe(true);
  await answerLifecycleDialog(electronApp, 0);
  expect(await page.evaluate((id) => window.termina.projectClose(id), agent.projectId!)).toMatchObject({ ok: true });
  expect(await paneExists(page, agent.id)).toBe(false);
  expect(await paneExists(page, otherShell.id)).toBe(true);
  expect(alive(pid)).toBe(true);
  await expect(page.locator(".project-tab.active")).toContainText("close-other-project");
});

test("a rejected stale close leaves the actual pane intact", async ({ page }) => {
  const agent = await firstAgent(page);
  expect(await page.evaluate(({ id, generation }) => window.termina.closeTerminal(id, generation + 1), agent)).toMatchObject({ ok: false, error: expect.any(String) });
  expect(await paneExists(page, agent.id)).toBe(true);
  expect(await page.evaluate((id) => window.termina.getInstances().then((instances) => instances.some((instance) => instance.id === id)), agent.id)).toBe(true);
});

test("discarding dirty buffers then cancelling close retains text and recovery copies", async ({ page, electronApp, projectRoot, runRoot }) => {
  const agent = await firstAgent(page);
  const path = join(projectRoot, "greeting.ts");
  const original = readFileSync(path, "utf8");
  await page.locator("#explorer-tree .explorer-row").filter({ hasText: "greeting.ts" }).dblclick();
  await expect(page.locator(".editor-tab .tab-name").getByText("greeting.ts")).toBeVisible();
  await page.evaluate(() => {
    const manager = (window as any).__editorMgr;
    const editor = manager.editor;
    editor.executeEdits("close-test", [{ range: editor.getModel().getFullModelRange(), text: "// retain on cancelled close\n" }]);
  });
  expect(await page.evaluate(() => (window as any).__editorMgr.flushDrafts())).toBe(true);
  await workingAgent(page, runRoot, agent.id);
  await mockLifecycleDialogs(electronApp, 1);
  const close = page.evaluate((id) => window.termina.projectClose(id), agent.projectId!);
  const modal = page.locator(".modal");
  await expect(modal).toContainText("Unsaved changes");
  expect(await lifecycleDialogs(electronApp)).toHaveLength(0);
  await modal.getByRole("button", { name: "Discard", exact: true }).click();
  expect(await close).toMatchObject({ ok: false, cancelled: true });
  expect(await lifecycleDialogs(electronApp)).toHaveLength(1);
  expect(await paneExists(page, agent.id)).toBe(true);
  expect(await page.evaluate(() => (window as any).__editorMgr.editor.getModel().getValue())).toBe("// retain on cancelled close\n");
  const drafts = await page.evaluate((id) => window.termina.getEditorDrafts(id), agent.projectId!);
  expect(drafts.files.some((file) => file.path.endsWith("/greeting.ts"))).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(original);
});

test("normal app quit discloses all projects; Cancel preserves work and acceptance exits", async ({ page, electronApp, projectRoot, runRoot }) => {
  await firstAgent(page);
  const { instance, pid } = await shellCommand(page, projectRoot);
  const otherRoot = join(runRoot, "quit-other-project");
  mkdirSync(otherRoot, { recursive: true });
  writeFileSync(join(otherRoot, "other.txt"), "other project\n");
  await page.evaluate((path) => window.termina.projectOpenPath(path), otherRoot);
  const other = await shellCommand(page, otherRoot);
  await mockLifecycleDialogs(electronApp, 1);
  // The fixture bypass is disabled only in this owned process for the real quit gate.
  await electronApp.evaluate(({ app }) => { process.env.NODE_ENV = "production"; app.quit(); });
  await expect.poll(() => lifecycleDialogs(electronApp).then((dialogs) => dialogs.length)).toBe(1);
  const options = (await lifecycleDialogs(electronApp))[0];
  expect(options.message).toBe("Quit Termina?");
  expect(options.detail).toContain(instance.id);
  expect(options.detail).toContain(projectRoot);
  expect(options.detail).toContain(other.instance.id);
  expect(options.detail).toContain(otherRoot);
  expect(alive(other.pid)).toBe(true);
  expect(alive(pid)).toBe(true);
  expect(await paneExists(page, instance.id)).toBe(true);
  await answerLifecycleDialog(electronApp, 0);
  const closed = electronApp.waitForEvent("close");
  await electronApp.evaluate(({ app }) => { app.quit(); });
  await closed;
  await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
  await expect.poll(() => alive(other.pid), { timeout: 10_000 }).toBe(false);
});

test("macOS window close keeps work alive; later quit still confirms and stops it", async ({ page, electronApp, projectRoot }) => {
  test.skip(process.platform !== "darwin", "Only macOS keeps the app running after its last window closes");
  await firstAgent(page);
  const { instance, pid } = await shellCommand(page, projectRoot);
  await mockLifecycleDialogs(electronApp, 1);
  await electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  expect(alive(pid)).toBe(true);
  await electronApp.evaluate(({ app }) => { process.env.NODE_ENV = "production"; app.quit(); });
  await expect.poll(() => lifecycleDialogs(electronApp).then((dialogs) => dialogs.length)).toBe(1);
  const options = (await lifecycleDialogs(electronApp))[0];
  expect(options.message).toBe("Quit Termina?");
  expect(options.detail).toContain(instance.id);
  expect(alive(pid)).toBe(true);
  await answerLifecycleDialog(electronApp, 0);
  const closed = electronApp.waitForEvent("close");
  await electronApp.evaluate(({ app }) => { app.quit(); });
  await closed;
  await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
});
