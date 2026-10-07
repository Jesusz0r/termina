import { test, expect } from "./fixtures.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test.describe("pane resize dividers", () => {
  test("explorer divider drag changes explorer width", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const before = await page.locator("#explorer").evaluate((el) => el.getBoundingClientRect().width);
    const box = await page.locator("#explorer-divider").boundingBox();
    expect(box).not.toBeNull();
    const y = box!.y + 100;
    await page.mouse.move(box!.x + 2, y);
    await page.mouse.down();
    await page.mouse.move(box!.x + 82, y);
    await page.mouse.up();
    const after = await page.locator("#explorer").evaluate((el) => el.getBoundingClientRect().width);
    expect(after - before).toBeGreaterThan(40);
  });

  test("near-miss grab left of the explorer divider still resizes", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const before = await page.locator("#explorer").evaluate((el) => el.getBoundingClientRect().width);
    const box = await page.locator("#explorer-divider").boundingBox();
    expect(box).not.toBeNull();
    // 6px left of the divider lands on the tree (often a draggable file row):
    // without the capture redirect this starts a file drag, not a resize.
    const y = box!.y + 100;
    await page.mouse.move(box!.x - 6, y);
    await page.mouse.down();
    await page.mouse.move(box!.x + 74, y);
    await page.mouse.up();
    const after = await page.locator("#explorer").evaluate((el) => el.getBoundingClientRect().width);
    expect(after - before).toBeGreaterThan(40);
  });

  test("explorer tracks the pointer across projects with open and collapsed editors", async ({ page, runRoot }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    await page.locator("#explorer-tree").getByText("greeting.ts").click();
    await expect(page.locator(".editor-tab").getByText("greeting.ts")).toBeVisible();
    const other = join(runRoot, "resize-other");
    mkdirSync(other);
    writeFileSync(join(other, "other.txt"), "other\n".repeat(100));
    await page.evaluate((dir) => window.termina.projectOpenPath(dir), other);
    await expect(page.locator("#explorer-tree").getByText("other.txt")).toBeVisible();

    for (const project of ["resize-other", "test-project", "resize-other"]) {
      await page.locator(".project-tab").filter({ hasText: project }).click();
      await expect(page.locator(".project-tab.active")).toContainText(project);
      for (const width of [360, 180, 300]) {
        const box = (await page.locator("#explorer-divider").boundingBox())!;
        const explorer = (await page.locator("#explorer").boundingBox())!;
        await page.mouse.move(box.x + 2, box.y + 100);
        await page.mouse.down();
        await page.mouse.move(explorer.x + width, box.y + 100, { steps: 10 });
        await page.mouse.up();
        await expect.poll(() => page.locator("#explorer").evaluate((el) => el.getBoundingClientRect().width)).toBeCloseTo(width, 0);
      }
    }
    await page.locator("#explorer-tree").getByText("other.txt").click();
    await expect(page.locator(".editor-tab").getByText("other.txt")).toBeVisible();
    const box = (await page.locator("#explorer-divider").boundingBox())!;
    const explorer = (await page.locator("#explorer").boundingBox())!;
    await page.mouse.move(box.x + 2, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(explorer.x + 400, box.y + 100, { steps: 10 });
    await page.mouse.up();
    await expect.poll(() => page.locator("#explorer").evaluate((el) => el.getBoundingClientRect().width)).toBeCloseTo(400, 0);
  });

  test("agent auto-open keeps the explorer width exact", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    // Narrow window + wide explorer + visible editor overflows the layout:
    // as a shrinkable flex item the explorer used to absorb the overflow
    // (worse the wider it was), so after an agent auto-open revealed the
    // editor the divider stopped tracking the pointer.
    await page.setViewportSize({ width: 900, height: 600 });
    await page.locator("#explorer-tree").getByText("greeting.ts").click();
    await expect(page.locator(".editor-tab").getByText("greeting.ts")).toBeVisible();
    const width = () => page.locator("#explorer").evaluate((el) => el.getBoundingClientRect().width);
    const dragTo = async (target: number): Promise<void> => {
      const box = (await page.locator("#explorer-divider").boundingBox())!;
      const explorer = (await page.locator("#explorer").boundingBox())!;
      await page.mouse.move(box.x + 2, box.y + 100);
      await page.mouse.down();
      await page.mouse.move(explorer.x + target, box.y + 100, { steps: 10 });
      await page.mouse.up();
    };
    await dragTo(420);
    await expect.poll(width).toBeCloseTo(420, 0);
    // The agent auto-open path (onToolTarget / drainPendingToolTargets):
    // EditorManager.openFile with preview:false, which reveals the editor.
    // Close first so the editor collapses, then auto-open reveals it again.
    // The path comes from the explorer root: projectList cwd may be the
    // non-canonical /var alias, which would open a second same-named tab.
    await page.evaluate(() => (window as any).__editorMgr.closeAllTabs());
    await page.evaluate(async () => {
      const w = window as any;
      const root = document.querySelector<HTMLElement>("#explorer-tree [data-path]")!.dataset.path!;
      const list = await w.termina.projectList();
      const proj = list.find((p: any) => p.active) ?? list[0];
      await w.__editorMgr.openFile(`${root}/greeting.ts`, {
        preview: false,
        owner: { projectId: proj.id, workspaceId: proj.workspaceId },
      });
    });
    await expect(page.locator(".editor-tab").getByText("greeting.ts").first()).toBeVisible();
    await expect.poll(width).toBeCloseTo(420, 0);
    await dragTo(300);
    await expect.poll(width).toBeCloseTo(300, 0);
  });

  test("custom split ratio survives minimize and review open", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    await page.locator("#explorer-tree").getByText("greeting.ts").click();
    await expect(page.locator(".editor-tab").getByText("greeting.ts").first()).toBeVisible();
    const leftWidth = () => page.locator("#left-pane").evaluate((el) => el.getBoundingClientRect().width);
    const before = await leftWidth();
    const box = (await page.locator("#divider").boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 122, y, { steps: 10 });
    await page.mouse.up();
    const custom = await leftWidth();
    // Require more than 10% growth from the initial 50/50 split. A fixed
    // 620px threshold assumes the old available width without the rail.
    expect(custom).toBeGreaterThan(before * 1.1);
    // Minimize the editor with tabs open, then open a modified file: the
    // review reveal restores the editor, and must restore the ratio too —
    // not reset to 50/50. The minimize takeover itself still clears the
    // inline sizes (inline flex would beat the full-width rule).
    await page.locator("#btn-min-editor").click();
    // A real modified row through the pane object + Accept-all re-render,
    // then the row click opens the genuine review path.
    await page.evaluate(() => {
      const w = window as any;
      const panes = w.__panes as Map<string, any>;
      const pane = [...panes.values()].find((p: any) => !p.error && !p.exited) ?? [...panes.values()][0];
      const root = (document.querySelector("#explorer-tree [data-path]") as HTMLElement).dataset.path!;
      pane.modified.push({ path: `${root}/greeting.ts`, relPath: "greeting.ts", status: "modified" });
    });
    await page.locator(".activity-tab[data-tab='modified']").click();
    await page.locator("#btn-accept-all").click();
    await page.locator("#modified-list li").first().click();
    await expect(page.locator("#review-container")).toBeVisible();
    await expect.poll(leftWidth).toBeCloseTo(custom, 0);
    await page.locator("#review-back").click();
    await expect.poll(leftWidth).toBeCloseTo(custom, 0);
  });

  test("activity panel placeholders share one geometry", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const panels: Array<[string, string]> = [
      ["timeline", "timeline-strip"],
      ["plan", "plan-panel"],
      ["worldlines", "worldline-panel"],
      ["modified", "modified-panel"],
    ];
    // One chrome contract: title row and empty copy share the same inset.
    // Measure the glyphs so a later box tweak cannot silently drift.
    const read = (panel: HTMLElement) => {
      const empty = panel.querySelector<HTMLElement>("[data-empty]")!;
      const header = panel.querySelector<HTMLElement>(".timeline-header, .panel-header")!;
      const range = document.createRange();
      range.selectNodeContents(empty);
      const text = range.getBoundingClientRect();
      return {
        left: text.left - panel.getBoundingClientRect().left,
        gap: text.top - header.getBoundingClientRect().bottom,
      };
    };

    const seen: Array<{ tab: string; left: number; gap: number }> = [];
    for (const [tab, id] of panels) {
      await page.locator(`#activity-tab-${tab}`).click();
      await expect(page.locator(`#${id} [data-empty]`)).toBeVisible();
      seen.push({ tab, ...(await page.locator(`#${id}`).evaluate(read)) });
    }

    // Switching tabs must not move the copy.
    const [first, ...rest] = seen;
    for (const other of rest) {
      expect(other.left, `${other.tab} inset`).toBeCloseTo(first.left, 0);
      expect(other.gap, `${other.tab} header gap`).toBeCloseTo(first.gap, 0);
    }
  });

  test("project rail selection does not start an explorer resize", async ({ page, runRoot }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    const other = join(runRoot, "resize-other");
    mkdirSync(other);
    await page.evaluate((dir) => window.termina.projectOpenPath(dir), other);
    const firstTab = page.locator(".project-tab").filter({ hasText: "test-project" });
    const otherTab = page.locator(".project-tab").filter({ hasText: "resize-other" });
    const select = firstTab.locator(".project-select");
    const tabBox = (await select.boundingBox())!;
    const width = () => page.locator("#explorer").evaluate((el) => el.getBoundingClientRect().width);
    const before = await width();
    const x = tabBox.x + tabBox.width / 2;
    const y = tabBox.y + tabBox.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    // Stay below the 5px reorder threshold: this is selection, not a rail drag.
    await page.mouse.move(x + 2, y + 2, { steps: 3 });
    expect(await page.locator("body").evaluate((el) => el.style.cursor)).not.toBe("col-resize");
    expect(await width()).toBe(before);
    await expect(page.locator(".tab-grabbed, .tab-drop-slot")).toHaveCount(0);
    await page.mouse.up();
    await expect(firstTab).toHaveClass(/active/);
    expect(await width()).toBe(before);

    for (const [tab, key] of [[otherTab, "Enter"], [firstTab, "Space"]] as const) {
      await tab.locator(".project-select").focus();
      await page.keyboard.press(key);
      await expect(tab).toHaveClass(/active/);
      expect(await width()).toBe(before);
      expect(await page.locator("body").evaluate((el) => el.style.cursor)).not.toBe("col-resize");
    }
  });

  test("split divider drag changes the terminal share", async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    await page.locator("#explorer-tree").getByText("greeting.ts").click();
    await expect(page.locator(".editor-tab").getByText("greeting.ts")).toBeVisible({ timeout: 10_000 });
    const box = await page.locator("#divider").boundingBox();
    expect(box).not.toBeNull();
    const y = box!.y + box!.height / 2;
    const before = await page.locator("#left-pane").evaluate((el) => el.getBoundingClientRect().width);
    await page.mouse.move(box!.x + 2, y);
    await page.mouse.down();
    await page.mouse.move(box!.x + 122, y);
    await page.mouse.up();
    const after = await page.locator("#left-pane").evaluate((el) => el.getBoundingClientRect().width);
    expect(after - before).toBeGreaterThan(40);
  });
});
