import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures.ts";

async function activeProject(page: import("@playwright/test").Page): Promise<string | null> {
  return page.evaluate(async () => {
    const projects = await window.termina.projectList();
    return projects.find((project) => project.active)?.id ?? null;
  });
}

async function followTerminalFileLink(page: import("@playwright/test").Page, terminalId: string, path: string): Promise<void> {
  await page.evaluate(({ terminalId, path }) => {
    const panes = (window as unknown as {
      __panes: Map<string, { view: { onOpenFile?: (path: string, line?: number, column?: number) => void } }>;
    }).__panes;
    const pane = panes.get(terminalId);
    if (!pane?.view.onOpenFile) throw new Error("terminal file-link callback is unavailable");
    // Exercise the callback registered by the real PtyView. Parser and
    // modifier-key behavior are covered by the terminal-link unit tests.
    pane.view.onOpenFile(path, 2, 1);
  }, { terminalId, path });
}

for (const nested of [false, true]) {
  test(`terminal file navigation activates ${nested ? "the longest matching nested project" : "an unrelated project"} authoritatively`, async ({ page, projectRoot, runRoot }) => {
    await expect(page.locator("#splash")).toBeHidden();
    const rootB = join(nested ? projectRoot : runRoot, "linked-project");
    mkdirSync(rootB, { recursive: true });
    writeFileSync(join(rootB, "linked-only.txt"), "first line\nsecond line\n");
    await page.evaluate((cwd) => window.termina.projectOpenPath(cwd), rootB);
    await expect(page.locator("#explorer-tree").getByText("linked-only.txt", { exact: true })).toBeVisible();

    const projects = await page.evaluate(() => window.termina.projectList());
    const projectA = projects.find((project) => realpathSync(project.cwd) === realpathSync(projectRoot))!;
    const projectB = projects.find((project) => realpathSync(project.cwd) === realpathSync(rootB))!;
    expect(projectA).toBeTruthy();
    expect(projectB).toBeTruthy();
    const instances = await page.evaluate(() => window.termina.getInstances());
    const terminalA = instances.find((instance) => instance.projectId === projectA.id)!;
    const terminalB = instances.find((instance) => instance.projectId === projectB.id)!;
    expect(terminalA).toBeTruthy();
    expect(terminalB).toBeTruthy();

    await page.evaluate((id) => window.termina.projectActivate(id), projectA.id);
    await expect(page.locator(".project-tab.active .tab-name")).toHaveText("test-project");
    await expect(page.locator("#explorer-tree").getByText("hello.txt", { exact: true })).toBeVisible();
    await followTerminalFileLink(page, terminalA.id, join(projectB.cwd, "linked-only.txt"));

    await expect(page.locator(".project-tab.active .tab-name")).toHaveText("linked-project");
    await expect.poll(() => activeProject(page)).toBe(projectB.id);
    await expect(page.locator("#explorer-tree").getByText("linked-only.txt", { exact: true })).toBeVisible();
    await expect(page.locator("#explorer-tree").getByText("hello.txt", { exact: true })).toHaveCount(0);
    await expect(page.locator(`.project-editor[data-project="${projectB.id}"] .editor-tab`)).toContainText("linked-only.txt");
    await expect.poll(() => page.evaluate((id) => {
      const panes = (window as unknown as { __panes: Map<string, { tabEl: HTMLElement }> }).__panes;
      return panes.get(id)?.tabEl.classList.contains("active") ?? false;
    }, terminalB.id)).toBe(true);

    const results = await page.evaluate(() => window.termina.searchFiles("linked-only"));
    expect(results.entries.some((entry) => entry.relPath === "linked-only.txt")).toBe(true);
    const after = await page.evaluate(() => window.termina.getInstances());
    expect(after.some((instance) => instance.id === terminalA.id)).toBe(true);
    expect(after.some((instance) => instance.id === terminalB.id)).toBe(true);
  });
}

test("a background terminal's relative file link activates its owner before opening", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const rootB = join(runRoot, "background-link");
  mkdirSync(rootB, { recursive: true });
  writeFileSync(join(rootB, "background-only.txt"), "background project\n");
  await page.evaluate((cwd) => window.termina.projectOpenPath(cwd), rootB);
  await expect(page.locator("#explorer-tree").getByText("background-only.txt", { exact: true })).toBeVisible();
  const projects = await page.evaluate(() => window.termina.projectList());
  const projectA = projects.find((project) => realpathSync(project.cwd) === realpathSync(projectRoot))!;
  const projectB = projects.find((project) => realpathSync(project.cwd) === realpathSync(rootB))!;
  const terminalA = (await page.evaluate(() => window.termina.getInstances())).find((instance) => instance.projectId === projectA.id)!;
  await followTerminalFileLink(page, terminalA.id, "hello.txt");
  await expect.poll(() => activeProject(page)).toBe(projectA.id);
  await expect(page.locator(".project-tab.active .tab-name")).toHaveText("test-project");
  await expect(page.locator("#explorer-tree").getByText("hello.txt", { exact: true })).toBeVisible();
  await expect(page.locator(`.project-editor[data-project="${projectA.id}"] .editor-tab`)).toContainText("hello.txt");
  await expect(page.locator(`.project-editor[data-project="${projectB.id}"]`)).toBeHidden();
});
