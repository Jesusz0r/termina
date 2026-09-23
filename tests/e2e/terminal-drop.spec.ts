import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures.ts";

/** Real-path Files: an input populated by Playwright keeps disk paths for getPathForFile. */
async function stageFiles(page: Page, paths: string[]): Promise<void> {
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.id = "drop-source";
    input.hidden = true;
    document.body.appendChild(input);
  });
  await page.setInputFiles("#drop-source", paths);
}

/** Fire an OS-style file drag at a point; returns whether the zone highlighted mid-drag. */
async function dropAt(page: Page, selector: string, fx: number, fy: number): Promise<boolean> {
  return page.evaluate(({ selector, fx, fy }) => {
    const files = Array.from((document.getElementById("drop-source") as HTMLInputElement).files ?? []);
    const zone = document.querySelector(selector) as HTMLElement;
    const r = zone.getBoundingClientRect();
    const target = document.elementFromPoint(r.x + r.width * fx, r.y + r.height * fy) as HTMLElement;
    const dt = new DataTransfer();
    for (const file of files) dt.items.add(file);
    const fire = (type: string) => target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    fire("dragenter");
    fire("dragover");
    const highlighted = document.getElementById("terminal-container")!.classList.contains("term-drop-target");
    fire("drop");
    return highlighted;
  }, { selector, fx, fy });
}

async function composerText(page: Page): Promise<string> {
  return page.evaluate(() => (document.querySelector(".term-pane.active .xterm-rows") as HTMLElement)?.innerText ?? "");
}

test.describe("terminal file drop", () => {
  test.beforeEach(async ({ page }) => {
    await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
    await page.locator(".term-pane.active .xterm").waitFor({ timeout: 20_000 });
    await expect.poll(() => composerText(page), { timeout: 20_000 }).toContain("termina");
  });

  test("a drop on the terminal body inserts the file tag", async ({ page, projectRoot }) => {
    const file = join(projectRoot, "body-drop.txt");
    writeFileSync(file, "x\n");
    await stageFiles(page, [file]);
    expect(await dropAt(page, "#terminal-container", 0.5, 0.95)).toBe(true);
    await expect.poll(() => composerText(page)).toContain("@body-drop.txt");
    await expect(page.locator("#terminal-container")).not.toHaveClass(/term-drop-target/);
  });

  test("a drop on the terminal tab bar reaches the active terminal", async ({ page, projectRoot }) => {
    const file = join(projectRoot, "tab-drop.txt");
    writeFileSync(file, "x\n");
    await stageFiles(page, [file]);
    expect(await dropAt(page, "#terminal-tabs", 0.5, 0.5)).toBe(true);
    await expect.poll(() => composerText(page)).toContain("@tab-drop.txt");
  });

  test("an image drop attaches to the agent", async ({ page, projectRoot }) => {
    const png = join(projectRoot, "shot.png");
    writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    await stageFiles(page, [png]);
    expect(await dropAt(page, "#terminal-container", 0.3, 0.3)).toBe(true);
    await expect.poll(() => composerText(page)).toContain("1 img");
  });

  test("an in-app drag does not light up the terminal", async ({ page }) => {
    const highlighted = await page.evaluate(() => {
      const tab = document.querySelector(".terminal-tab") as HTMLElement;
      const zone = document.getElementById("terminal-container")!;
      tab.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
      zone.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
      const lit = zone.classList.contains("term-drop-target");
      tab.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true }));
      return lit;
    });
    expect(highlighted).toBe(false);
  });

  test("an in-app drag whose source leaves the DOM does not block later file drops", async ({ page, projectRoot }) => {
    await page.evaluate(() => {
      // An explorer refresh can detach the dragged row mid-drag; its dragend
      // then never reaches the document.
      const source = document.createElement("div");
      source.draggable = true;
      document.body.appendChild(source);
      source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
      source.remove();
      source.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true }));
    });
    const file = join(projectRoot, "after-detach.txt");
    writeFileSync(file, "x\n");
    await stageFiles(page, [file]);
    expect(await dropAt(page, "#terminal-container", 0.5, 0.5)).toBe(true);
    await expect.poll(() => composerText(page)).toContain("@after-detach.txt");
  });

  test("a drop on another terminal's tab goes to that terminal", async ({ page, projectRoot }) => {
    const agentId = await page.evaluate(async () => (await (window as any).termina.getInstances())[0].id as string);
    const shellId = await page.evaluate(async () => (await (window as any).termina.createTerminal({ type: "shell" })).id as string);
    await expect(page.locator(".terminal-tab")).toHaveCount(2);
    // Bring the agent back to the front so the shell tab is the inactive one.
    await page.locator(".terminal-tab").first().click();
    await expect(page.locator(".terminal-tab").first()).toHaveClass(/active/);
    const file = join(projectRoot, "to-shell.txt");
    writeFileSync(file, "x\n");
    await stageFiles(page, [file]);
    await dropAt(page, ".terminal-tab:not(.active)", 0.5, 0.5);
    await expect(page.locator(".terminal-tab").nth(1)).toHaveClass(/active/);
    // A long quoted path wraps across terminal rows.
    await expect.poll(async () => (await composerText(page)).replaceAll("\n", "")).toContain("to-shell.txt'");
    expect(agentId).not.toBe(shellId);
  });
});
