import { test as base, expect } from "./fixtures.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { THEME_IDS } from "../../shared/types.ts";
import { contrastRatio } from "../fixtures/contrast.ts";
import { readVerifyStages, writeVerifyPackage } from "../fixtures/verify-package.ts";

const test = base.extend({
  projectRoot: async ({ projectRoot }, use) => {
    await writeFile(join(projectRoot, ".gitignore"), "/stages.jsonl\nnode_modules/\n");
    await writeVerifyPackage(projectRoot, { test: "termina-verify-fixture fail" });
    await use(projectRoot);
  },
});

async function visibleColors(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((elements) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    const rgba = (color: string): number[] => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const hex = (color: number[]): string => "#" + color.slice(0, 3).map((channel) => channel.toString(16).padStart(2, "0")).join("");
    return elements.filter((element) => element.getBoundingClientRect().width > 0).map((element) => {
      const style = getComputedStyle(element);
      let parent: Element | null = element;
      let background: number[] = [];
      while (parent) {
        background = rgba(getComputedStyle(parent).backgroundColor);
        if (background[3] !== 0) break;
        parent = parent.parentElement;
      }
      if (background[3] !== 255 || rgba(style.color)[3] !== 255) throw new Error("Contrast fixture expects opaque colors after resolving transparent ancestors");
      return { element: element.id || element.className, foreground: hex(rgba(style.color)), background: hex(background), outline: style.outlineStyle };
    });
  });
}

for (const theme of THEME_IDS) {
  for (const family of ["Departure Mono", "Menlo"] as const) {
    test(`keyboard owner inspection, saved source and reflow in ${theme} with ${family}`, async ({ page, electronApp, projectRoot, runRoot }, testInfo) => {
      await expect(page.locator("#splash")).toBeHidden();
      const projectA = (await page.evaluate(() => window.termina.projectList())).find((project) => project.active)!;
      const rootB = join(runRoot, "other", "test-project");
      await mkdir(join(runRoot, "other"));
      execFileSync("git", ["clone", "-q", "--no-hardlinks", projectRoot, rootB]);
      await writeFile(join(rootB, ".gitignore"), "/stages.jsonl\nnode_modules/\n");
      await writeVerifyPackage(rootB, { test: "termina-verify-fixture fail" });
      await page.evaluate((root) => window.termina.projectOpenPath(root), rootB);
      const projectB = (await page.evaluate(() => window.termina.projectList())).find((project) => project.active)!;
      const agents = await page.evaluate(() => window.termina.getInstances());
      const ownerA = agents.find((agent) => agent.projectId === projectA.id)!;
      const ownerB = agents.find((agent) => agent.projectId === projectB.id)!;
      for (const owner of [ownerA, ownerB]) {
        expect(await page.evaluate((id) => window.termina.runVerify(id), owner.id)).toEqual({ ok: true });
        await expect.poll(() => page.evaluate((id) => window.termina.getInstances().then((instances) => instances.find((entry) => entry.id === id)?.verify?.state), owner.id)).toBe("fail");
      }
      await page.evaluate(() => (window as unknown as { __openSettings(): void }).__openSettings());
      await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Appearance", exact: true }).click();
      await page.getByLabel("Font family", { exact: true }).selectOption(family);
      for (const label of ["Editor font size", "Terminal font size"]) {
        const slider = page.getByRole("slider", { name: label, exact: true });
        await slider.focus();
        await page.keyboard.press("End");
        await expect(slider).toHaveValue("20");
      }
      await page.locator(`.settings-theme-card[data-theme="${theme}"]`).click();
      await page.getByRole("button", { name: "Close settings", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect.poll(() => page.evaluate(() => window.termina.getPreferences())).toMatchObject({ theme, fontFamily: family, editorFontSize: 20, terminalFontSize: 20 });
      const railA = page.locator(`#project-tabs .project-tab[data-project-id="${projectA.id}"] .project-select`);
      const railB = page.locator(`#project-tabs .project-tab[data-project-id="${projectB.id}"] .project-select`);
      await railB.focus();
      await page.keyboard.press("Home");
      await expect(railA).toBeFocused();
      await expect(railA).toHaveAccessibleDescription(new RegExp(projectA.cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      await page.keyboard.press("Enter");
      await expect(railA).toHaveAttribute("aria-current", "page");
      await page.locator("#explorer-tree .explorer-row").filter({ hasText: "greeting.ts" }).dblclick();
      const editorInput = page.getByRole("textbox", { name: "Editor content", exact: true });
      await editorInput.focus();
      await page.keyboard.press("ControlOrMeta+a");
      const changed = 'export const greeting = "keyboard accessibility source";\n';
      await page.keyboard.insertText(changed);
      await page.keyboard.press("ControlOrMeta+s");
      await expect.poll(() => readFile(join(projectRoot, "greeting.ts"), "utf8")).toBe(changed);
      await expect.poll(() => page.evaluate((id) => window.termina.getInstances().then((instances) => instances.find((entry) => entry.id === id)?.verify?.state), ownerA.id)).toBe("stale");
      await railB.focus();
      await page.keyboard.press("Enter");
      await expect(railB).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("textbox", { name: "Terminal input", exact: true })).toHaveCount(1);
      await electronApp.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        window.setSize(900, 700);
        window.webContents.setZoomFactor(2);
      });
      await page.emulateMedia({ reducedMotion: "reduce" });
      const opener = page.locator("#btn-all-projects");
      await opener.focus();
      await page.keyboard.press("Enter");
      const region = page.getByRole("region", { name: "Attention across all projects", exact: true });
      await expect(page.getByRole("button", { name: "Close attention", exact: true })).toBeFocused();
      await expect(region.locator(".attention-inspect")).toHaveCount(2);
      const inspection = region.locator(`.attention-item[data-project-id="${projectA.id}"] .attention-inspect`);
      await expect(inspection).toHaveAccessibleDescription(new RegExp(projectA.cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      await expect(inspection).toHaveAccessibleDescription(/Shared project files/);
      // Opening can initially render the cached failed-check row. Its identity
      // legitimately changes when the current stale projection arrives, moving
      // focus to Refresh. Traverse the current item, not that obsolete control.
      await expect(inspection.locator("..").locator("h3")).toHaveText("Verify is outdated");
      const focusInspection = async () => {
        await page.keyboard.press("Tab");
        await expect(region.getByRole("button", { name: "Refresh", exact: true })).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(region.locator(".attention-inspect").first()).toBeFocused();
        if (!(await inspection.evaluate((element) => element === document.activeElement))) await page.keyboard.press("Tab");
        await expect(inspection).toBeFocused();
      };
      await focusInspection();
      const samples = await visibleColors(page, "#attention-view h2, #attention-view h3, #attention-view p:not(:empty), #attention-view button, #project-tabs .project-path, #project-tabs .project-counts, #btn-all-projects");
      for (const sample of samples) expect(contrastRatio(sample.foreground, sample.background), JSON.stringify(sample)).toBeGreaterThanOrEqual(4.5);
      await expect(inspection).toHaveCSS("outline-style", "solid");
      const geometry = await region.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: innerWidth, height: innerHeight,
          scroll: element.scrollWidth, client: element.clientWidth, animations: element.getAnimations({ subtree: true }).length };
      });
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(geometry.width + 1);
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.height + 1);
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
      expect(geometry.animations).toBe(0);
      await page.keyboard.press("Escape");
      await expect(opener).toBeFocused();
      await page.keyboard.press("Enter");
      await focusInspection();
      await page.keyboard.press("Enter");
      await expect(region).toBeHidden();
      await expect.poll(() => page.evaluate(() => window.termina.projectList().then((projects) => projects.find((project) => project.active)?.id))).toBe(projectA.id);
      await expect(page.locator(".work-summary-report")).toContainText("**Status:** ⚠️ OUTDATED");
      await expect(page.locator(".work-summary-report")).toContainText("Historical execution");
      await expect(page.locator(".work-summary-report")).toContainText("exit code 7");
      await expect(page.getByRole("textbox", { name: "Terminal input", exact: true })).toHaveCount(1);
      expect(await readVerifyStages(projectRoot)).toHaveLength(1);
      expect(await readVerifyStages(rootB)).toHaveLength(1);
      expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain(family);
      expect(await page.evaluate((id) => (window as unknown as {
        __panes: Map<string, { view: { getTerminal(): import("@xterm/xterm").Terminal } }>;
      }).__panes.get(id)!.view.getTerminal().options.fontSize, ownerA.id)).toBe(20);
      await testInfo.attach("workspace-accessibility-measurements", { body: JSON.stringify({ theme, family, samples, geometry }, null, 2), contentType: "application/json" });
      await testInfo.attach("workspace-accessibility", { body: await page.screenshot(), contentType: "image/png" });
    });
  }
}
