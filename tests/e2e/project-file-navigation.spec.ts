import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures.ts";

type TerminalPanes = Map<string, { view: { getTerminal(): import("@xterm/xterm").Terminal } }>;

async function terminalPoint(page: import("@playwright/test").Page, id: string, needle: string) {
  return page.evaluate(({ id, needle }) => {
    const term = (window as unknown as { __panes: TerminalPanes }).__panes.get(id)!.view.getTerminal();
    const bounds = term.element!.querySelector(".xterm-screen")!.getBoundingClientRect();
    const buffer = term.buffer.active;
    for (let row = 0; row < term.rows; row++) {
      const line = buffer.getLine(buffer.viewportY + row);
      const start = line?.translateToString(true).indexOf(needle) ?? -1;
      if (start < 0 || !line) continue;
      let offset = 0;
      for (let column = 0; column < term.cols; column++) {
        const cell = line.getCell(column);
        if (!cell || cell.getWidth() === 0) continue;
        if (offset >= start) return {
          x: bounds.x + (column + 0.5) * bounds.width / term.cols,
          y: bounds.y + (row + 0.5) * bounds.height / term.rows,
          cellWidth: bounds.width / term.cols,
        };
        offset += (cell.getChars() || " ").length;
      }
    }
    return null;
  }, { id, needle });
}

interface DelayedActivation {
  waiting: boolean;
  release(): void;
  restore(): void;
}

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

test("a delayed activation reply cannot restore an older owner across main, rail, explorer, editor, terminal and search", async ({ page, projectRoot, runRoot, electronApp }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const projectA = (await page.evaluate(() => window.termina.projectList())).find((project) => project.active)!;
  const rootB = join(runRoot, "newer-owner");
  mkdirSync(rootB);
  writeFileSync(join(rootB, "newer-only.txt"), "newer project source\n");
  await page.evaluate((cwd) => window.termina.projectOpenPath(cwd), rootB);
  await expect(page.locator("#explorer-tree").getByText("newer-only.txt", { exact: true })).toBeVisible();
  const projectB = (await page.evaluate(() => window.termina.projectList())).find((project) => project.active)!;
  const terminalB = (await page.evaluate(() => window.termina.getInstances())).find((instance) => instance.projectId === projectB.id)!;
  await electronApp.evaluate(({ ipcMain }, delayedId) => {
    type Invoke = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Invoke> })._invokeHandlers;
    const original = handlers.get("project:activate");
    if (!original) throw new Error("Missing canonical activation handler");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const state: DelayedActivation = { waiting: false, release, restore: () => handlers.set("project:activate", original) };
    handlers.set("project:activate", async (event, ...args) => {
      const result = await original(event, ...args);
      if (args[0] === delayedId) { state.waiting = true; await gate; }
      return result;
    });
    (globalThis as unknown as { __delayedActivation: DelayedActivation }).__delayedActivation = state;
  }, projectA.id);
  try {
    await page.locator(`#project-tabs .project-tab[data-project-id="${projectA.id}"] .project-select`).click();
    await expect.poll(() => electronApp.evaluate(() => (globalThis as unknown as { __delayedActivation: DelayedActivation }).__delayedActivation.waiting)).toBe(true);
    await page.locator(`#project-tabs .project-tab[data-project-id="${projectB.id}"] .project-select`).click();
    await expect.poll(() => activeProject(page)).toBe(projectB.id);
    await expect(page.locator("#explorer-tree").getByText("newer-only.txt", { exact: true })).toBeVisible();
    await electronApp.evaluate(() => (globalThis as unknown as { __delayedActivation: DelayedActivation }).__delayedActivation.release());
    // A real subsequent file read is an ordering barrier, not an arbitrary sleep.
    await page.locator("#explorer-tree").getByText("newer-only.txt", { exact: true }).dblclick();
    await expect(page.locator(`.project-editor[data-project="${projectB.id}"] .editor-tab`)).toContainText("newer-only.txt");
    await expect.poll(() => page.evaluate(() => (window as unknown as {
      __editorMgr: { editor: { getModel(): { getValue(): string } } };
    }).__editorMgr.editor.getModel().getValue())).toBe("newer project source\n");
    expect(await activeProject(page)).toBe(projectB.id);
    await expect(page.locator(`#project-tabs .project-tab[data-project-id="${projectB.id}"]`)).toHaveClass(/active/);
    await expect(page.locator("#explorer-tree").getByText("hello.txt", { exact: true })).toHaveCount(0);
    await expect(page.locator(`.project-editor[data-project="${projectB.id}"]`)).toBeVisible();
    await expect.poll(() => page.evaluate((id) => (window as unknown as {
      __panes: Map<string, { tabEl: HTMLElement }>;
    }).__panes.get(id)?.tabEl.classList.contains("active"), terminalB.id)).toBe(true);
    expect((await page.evaluate(() => window.termina.searchFiles("newer-only"))).entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ relPath: "newer-only.txt" }),
    ]));
    expect((await page.evaluate((id) => window.termina.getProjectWorkSummary(id), projectB.id))?.root).toBe(projectB.cwd);
    expect(realpathSync(projectA.cwd)).toBe(realpathSync(projectRoot));
  } finally {
    await electronApp.evaluate(() => {
      const state = globalThis as unknown as { __delayedActivation?: DelayedActivation };
      state.__delayedActivation?.release();
      state.__delayedActivation?.restore();
      delete state.__delayedActivation;
    });
  }
});

for (const nested of [false, true]) {
  for (const osc of [false, true]) {
    test(`real ${osc ? "OSC 8" : "wrapped plaintext"} modifier-click selects the ${nested ? "nested" : "unrelated"} file owner`, async ({ page, projectRoot, runRoot }, testInfo) => {
      await expect(page.locator("#splash")).toBeHidden();
      const projectA = (await page.evaluate(() => window.termina.projectList())).find((project) => project.active)!;
      const rootB = join(nested ? projectRoot : runRoot, "mouse-linked-project");
      mkdirSync(rootB, { recursive: true });
      const file = join(rootB, "linked-only.txt");
      writeFileSync(file, "first line\nsecond line\nthird line\n");
      await page.evaluate((cwd) => window.termina.projectOpenPath(cwd), rootB);
      const projectB = (await page.evaluate(() => window.termina.projectList())).find((project) => project.active)!;
      const terminalB = (await page.evaluate(() => window.termina.getInstances())).find((instance) => instance.projectId === projectB.id)!;
      await page.locator(`#project-tabs .project-tab[data-project-id="${projectA.id}"] .project-select`).click();
      const shell = await page.evaluate((projectId) => window.termina.createTerminal({ type: "shell", shell: "/bin/bash", projectId }), projectA.id);
      expect(shell).toMatchObject({ ok: true });
      const id = shell.id!;
      await page.locator("#terminal-tabs-list .terminal-tab").filter({ hasText: "bash" }).click();
      await expect.poll(() => page.evaluate((id) => (window as unknown as { __panes: Map<string, { tabEl: HTMLElement }> }).__panes.get(id)?.tabEl.classList.contains("active"), id)).toBe(true);
      await page.evaluate((id) => window.termina.writeTerminal(id, "stty -echo; printf '\\nGESTURE_READY\\n'\r"), id);
      await expect.poll(() => page.evaluate((id) => {
        const term = (window as unknown as { __panes: TerminalPanes }).__panes.get(id)!.view.getTerminal();
        return Array.from({ length: term.rows }, (_, row) => term.buffer.active.getLine(term.buffer.active.viewportY + row)?.translateToString(true))
          .includes("GESTURE_READY");
      }, id)).toBe(true);
      const target = `${realpathSync(file)}:2:3`;
      const reference = osc ? `\x1b]8;;file://termina.local/?target=${encodeURIComponent(target)}\x1b\\Open fixture\x1b]8;;\x1b\\`
        : target;
      const output = `\x1b[2J\x1b[H界 e\u0301 ${reference}\r\nLINK_OUTPUT_READY\r\n`;
      const escaped = output.replace(/\\/g, "\\\\").replace(/\x1b/g, "\\033").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
      const command = `printf '%b' ${"'" + escaped.replace(/'/g, "'\\''") + "'"}\r`;
      await page.evaluate(({ id, command }) => window.termina.writeTerminal(id, command), { id, command });
      const needle = osc ? "Open fixture" : realpathSync(file).slice(0, 10);
      await expect.poll(() => terminalPoint(page, id, needle)).not.toBeNull();
      const point = (await terminalPoint(page, id, needle))!;
      await page.mouse.move(point.x + point.cellWidth, point.y);
      await page.mouse.move(point.x, point.y);
      if (!osc) await expect.poll(() => page.evaluate((id) => (window as unknown as { __panes: TerminalPanes }).__panes.get(id)!.view.getTerminal().element?.title, id)).toBe(`Open ${realpathSync(file)}:2:3`);
      else await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await page.mouse.click(point.x, point.y);
      expect(await activeProject(page)).toBe(projectA.id);
      await expect(page.locator(`.project-editor[data-project="${projectB.id}"] .editor-tab`)).toHaveCount(0);
      const modifier = process.platform === "darwin" ? "Meta" : "Control";
      await page.evaluate((id) => {
        const term = (window as unknown as { __panes: TerminalPanes }).__panes.get(id)!.view.getTerminal();
        term.element!.addEventListener("mouseup", (event) => {
          (window as unknown as { __linkGesture: unknown }).__linkGesture = {
            trusted: event.isTrusted, meta: event.metaKey, ctrl: event.ctrlKey, button: event.button,
            platform: navigator.platform, title: term.element!.title, selection: term.hasSelection(),
            target: (event.target as HTMLElement).className, alt: event.altKey,
          };
        }, { once: true });
      }, id);
      await page.keyboard.down(modifier);
      await page.mouse.move(point.x + point.cellWidth, point.y);
      await page.mouse.move(point.x, point.y);
      try { await page.mouse.click(point.x, point.y); }
      finally { await page.keyboard.up(modifier); }
      const gesture = await page.evaluate(() => {
        const state = window as unknown as { __linkGesture?: unknown };
        const result = state.__linkGesture;
        delete state.__linkGesture;
        return result;
      });
      await testInfo.attach("trusted-terminal-link-gesture", { body: JSON.stringify(gesture, null, 2), contentType: "application/json" });
      expect(gesture).toMatchObject({ trusted: true, button: 0, meta: process.platform === "darwin", ctrl: process.platform !== "darwin" });
      await expect.poll(() => activeProject(page)).toBe(projectB.id);
      await expect(page.locator(`#project-tabs .project-tab[data-project-id="${projectB.id}"]`)).toHaveClass(/active/);
      await expect(page.locator("#explorer-tree").getByText("linked-only.txt", { exact: true })).toBeVisible();
      await expect(page.locator(`.project-editor[data-project="${projectB.id}"] .editor-tab`)).toContainText("linked-only.txt");
      await expect.poll(() => page.evaluate(() => {
        const editor = (window as unknown as { __editorMgr: { editor: import("monaco-editor").editor.IStandaloneCodeEditor } }).__editorMgr.editor;
        return { content: editor.getModel()?.getValue(), position: editor.getPosition() };
      })).toMatchObject({ content: "first line\nsecond line\nthird line\n", position: { lineNumber: 2, column: 3 } });
      await expect.poll(() => page.evaluate((id) => (window as unknown as { __panes: Map<string, { tabEl: HTMLElement }> }).__panes.get(id)?.tabEl.classList.contains("active"), terminalB.id)).toBe(true);
      expect((await page.evaluate(() => window.termina.searchFiles("linked-only"))).entries).toEqual(expect.arrayContaining([expect.objectContaining({ relPath: "linked-only.txt" })]));
      expect((await page.evaluate((id) => window.termina.getProjectWorkSummary(id), projectB.id))?.root).toBe(projectB.cwd);
      expect((await page.evaluate(() => window.termina.getInstances())).some((instance) => instance.id === id)).toBe(true);
    });
  }
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
