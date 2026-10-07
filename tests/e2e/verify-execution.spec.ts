import { expect, test as base } from "./fixtures.ts";
import { readFile, access, mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { readVerifyStages, writeVerifyPackage } from "../fixtures/verify-package.ts";
import { mockLifecycleDialogs } from "./lifecycle-dialog.ts";

const scripts = {
  pretest: "termina-verify-fixture pre",
  test: 'termina-verify-fixture "two words" && termina-verify-fixture main',
  posttest: "termina-verify-fixture post",
};

const test = base.extend({
  runRoot: async ({ runRoot }, use) => {
    await mkdir(join(runRoot, "events"), { recursive: true, mode: 0o700 });
    await writeFile(join(runRoot, "events", "verify-term-1.md"), "**Status:** ✅ PASSED — unrelated prior terminal\n", { mode: 0o600 });
    await use(runRoot);
  },
  projectRoot: async ({ projectRoot }, use) => {
    // Fixture output and installed binaries are not application source.
    await writeFile(join(projectRoot, ".gitignore"), "/stages.jsonl\nnode_modules/\n");
    await writeVerifyPackage(projectRoot, scripts);
    await use(projectRoot);
  },
});

async function verifyInfo(page: Page, terminalId: string) {
  return page.evaluate(async (id) => (await window.termina.getInstances()).find((instance) => instance.id === id)?.verify, terminalId);
}

async function verifyContext(runRoot: string, terminalId: string): Promise<string> {
  // Main writes the context asynchronously after publishing the verdict.
  return readFile(join(runRoot, "events", `verify-${terminalId}.md`), "utf8").catch(() => "");
}

test("a new terminal cannot inherit an unrelated prior green context", async ({ page, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  expect((await verifyInfo(page, "term-1"))?.state).toBe("untested");
  await expect.poll(() => verifyContext(runRoot, "term-1")).toContain("**Status:** NOT RUN");
  expect(await verifyContext(runRoot, "term-1")).not.toContain("unrelated prior terminal");
});

test("Verify executes npm lifecycle stages and requires reverify after a source edit", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  expect(await page.evaluate(() => window.termina.detectTest("term-1"))).toEqual({ command: "npm", args: ["run", "test"], label: "npm run test" });
  const button = page.locator("#btn-verify");
  await expect(button).toBeEnabled();
  await expect(button).toHaveAttribute("title", "Run npm run test");
  await button.click();
  await expect.poll(async () => (await verifyInfo(page, "term-1"))?.state).toBe("pass");
  await expect(page.locator("#verify-badge")).toHaveClass(/state-pass/);
  await expect(page.locator("#verify-badge")).toHaveAttribute("title", /^npm run test\n.+ · exit 0 · \d+ ms\n/);
  const scope = (await page.locator("#verify-badge").getAttribute("title"))!.split("\n").at(-1)!;
  expect(realpathSync(scope)).toBe(realpathSync(projectRoot));
  const stages = await readVerifyStages(projectRoot);
  expect(stages.map((stage) => stage.args)).toEqual([["pre"], ["two words"], ["main"], ["post"]]);
  expect(stages.map((stage) => stage.event)).toEqual(["pretest", "test", "test", "posttest"]);
  expect(stages.map((stage) => stage.cwd)).toEqual(Array(4).fill(realpathSync(projectRoot)));
  await expect.poll(() => verifyContext(runRoot, "term-1")).toContain("✅ PASSED (exit code 0)");
  const context = await verifyContext(runRoot, "term-1");
  expect(context).toContain("`npm run test`");
  expect(context).toContain('"event":"pretest"');
  expect(context).toContain('"event":"posttest"');
  const verdict = (await verifyInfo(page, "term-1"))!;
  expect(verdict.source?.tree).toMatch(/^[0-9a-f]{40}$/);
  expect(realpathSync(verdict.source!.root)).toBe(realpathSync(projectRoot));
  expect(verdict.result).toMatchObject({ state: "pass", exitCode: 0 });
  expect(verdict.result!.finishedAt).toBeGreaterThanOrEqual(verdict.result!.startedAt);

  await writeFile(join(projectRoot, "greeting.ts"), 'export const greeting = "changed outside the editor";\n');
  await expect.poll(async () => (await verifyInfo(page, "term-1"))?.state).toBe("stale");
  await expect(page.locator("#verify-badge")).toHaveClass(/state-stale/);
  const stale = (await verifyInfo(page, "term-1"))!;
  expect(stale.source).toEqual(verdict.source);
  expect(stale.result).toEqual(verdict.result);
  expect(stale.command).toBe(verdict.command);
  await expect.poll(() => verifyContext(runRoot, "term-1")).toContain("**Status:** ⚠️ OUTDATED");
  expect(await verifyContext(runRoot, "term-1")).toContain("**Historical execution:** ✅ PASSED (exit code 0)");

  expect(await page.evaluate(() => window.termina.runVerify("term-1"))).toEqual({ ok: true });
  await expect.poll(async () => (await verifyInfo(page, "term-1"))?.state).toBe("pass");
  const updated = (await verifyInfo(page, "term-1"))!;
  expect(updated.source?.tree).not.toBe(verdict.source?.tree);
  expect(updated.result!.startedAt).toBeGreaterThan(verdict.result!.finishedAt);
  expect((await readVerifyStages(projectRoot))).toHaveLength(8);
  await expect.poll(() => verifyContext(runRoot, "term-1")).toContain(updated.source!.tree);
});

for (const writer of ["editor save", "shell command"] as const) {
  test(`a real ${writer} invalidates a passing check and Attention opens its unchanged history`, async ({ page, projectRoot, electronApp }) => {
    await expect(page.locator("#splash")).toBeHidden();
    const project = (await page.evaluate(() => window.termina.projectList())).find((entry) => entry.active)!;
    expect(await page.evaluate(() => window.termina.runVerify("term-1"))).toEqual({ ok: true });
    await expect.poll(async () => (await verifyInfo(page, "term-1"))?.state).toBe("pass");
    const previous = (await verifyInfo(page, "term-1"))!;
    const path = join(projectRoot, "greeting.ts");
    const content = `export const greeting = "${writer} mutation";\n`;
    if (writer === "editor save") {
      const original = await readFile(path, "utf8");
      await page.locator("#explorer-tree .explorer-row").filter({ hasText: "greeting.ts" }).dblclick();
      await expect.poll(() => page.evaluate(() => (window as unknown as {
        __editorMgr: { editor: { getModel(): { getValue(): string } } };
      }).__editorMgr.editor.getModel().getValue())).toBe(original);
      await page.evaluate(async (text) => {
        const manager = (window as unknown as {
          __editorMgr: { editor: { getModel(): { getFullModelRange(): unknown }; executeEdits(source: string, edits: { range: unknown; text: string }[]): void }; saveActive(): Promise<void> };
        }).__editorMgr;
        manager.editor.executeEdits("verify-source-edit", [{ range: manager.editor.getModel().getFullModelRange(), text }]);
        await manager.saveActive();
      }, content);
      expect(await readFile(path, "utf8")).toBe(content);
      await expect(page.locator(".editor-tab").filter({ hasText: "greeting.ts" }).locator(".tab-dirty")).toBeHidden();
    } else {
      const shell = await page.evaluate(() => window.termina.createTerminal({ type: "shell", shell: "/bin/bash" }));
      expect(shell).toMatchObject({ ok: true });
      await page.evaluate(({ id, command }) => window.termina.writeTerminal(id, command), {
        id: shell.id!, command: `printf '%s\\n' 'export const greeting = "shell command mutation";' > greeting.ts\r`,
      });
      await expect.poll(() => readFile(path, "utf8")).toBe(content);
      const instance = (await page.evaluate(() => window.termina.getInstances())).find((entry) => entry.id === shell.id)!;
      await mockLifecycleDialogs(electronApp, 0);
      expect(await page.evaluate(({ id, generation }) => window.termina.closeTerminal(id, generation), instance)).toEqual({ ok: true });
      await expect.poll(() => page.evaluate((id) => window.termina.getInstances().then((instances) => instances.some((entry) => entry.id === id)), shell.id!)).toBe(false);
    }
    await expect.poll(async () => (await verifyInfo(page, "term-1"))?.state).toBe("stale");
    const stale = (await verifyInfo(page, "term-1"))!;
    expect(stale.source).toEqual(previous.source);
    expect(stale.result).toEqual(previous.result);
    const item = (await page.evaluate(() => window.termina.getWorkOverview())).items.find((entry) => entry.projectId === project.id && entry.reason === "verify-stale")!;
    expect(item).toMatchObject({ terminalId: "term-1", action: { kind: "evidence", terminalId: "term-1" } });
    await page.locator("#btn-attention").click();
    await page.locator(`#attention-list .attention-item[data-id="${item.id}"] .attention-inspect`).click();
    await expect(page.locator(".work-summary-report")).toContainText("**Status:** ⚠️ OUTDATED");
    await expect(page.locator(".work-summary-report")).toContainText("**Historical execution:** ✅ PASSED (exit code 0)");
    await expect(page.locator(".work-summary-report")).not.toContainText("**Status:** ✅ PASSED");
    expect(await readVerifyStages(projectRoot)).toHaveLength(4);
    expect(await page.evaluate(() => window.termina.runVerify("term-1"))).toEqual({ ok: true });
    await expect.poll(async () => (await verifyInfo(page, "term-1"))?.state).toBe("pass");
    expect((await verifyInfo(page, "term-1"))?.source?.tree).not.toBe(previous.source?.tree);
    expect(await readVerifyStages(projectRoot)).toHaveLength(8);
  });
}

for (const failingStage of ["pretest", "test", "posttest"] as const) {
  test(`Verify reports a failing ${failingStage} instead of announcing green`, async ({ page, projectRoot, runRoot }) => {
    await expect(page.locator("#splash")).toBeHidden();
    await writeVerifyPackage(projectRoot, { ...scripts, [failingStage]: "termina-verify-fixture fail" });
    expect(await page.evaluate(() => window.termina.runVerify("term-1"))).toEqual({ ok: true });
    await expect.poll(async () => (await verifyInfo(page, "term-1"))?.state).toBe("fail");
    await expect(page.locator("#verify-badge")).toHaveClass(/state-fail/);
    const expected = failingStage === "pretest" ? ["pretest"] : failingStage === "test" ? ["pretest", "test"] : ["pretest", "test", "test", "posttest"];
    expect((await readVerifyStages(projectRoot)).map((stage) => stage.event)).toEqual(expected);
    await expect.poll(() => verifyContext(runRoot, "term-1")).toContain("❌ FAILED (exit code 7)");
    expect(await verifyContext(runRoot, "term-1")).toContain("`npm run test`");
  });
}

test("background-terminal Verify uses its owner's project without changing the active project", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const otherRoot = join(runRoot, "other verify project");
  await writeVerifyPackage(otherRoot, { "test:other": "termina-verify-fixture other-project" });
  await page.evaluate((root) => window.termina.projectOpenPath(root), otherRoot);
  await expect(page.locator(".project-tab.active .tab-name")).toHaveText("other verify project");
  const otherProject = (await page.evaluate(() => window.termina.projectList())).find((project) => project.active)!;
  expect(otherProject).toBeTruthy();
  expect(await page.evaluate(() => window.termina.detectTest("term-1"))).toMatchObject({ command: "npm", label: "npm run test" });
  expect(await page.evaluate(() => window.termina.runVerify("term-1"))).toEqual({ ok: true });
  await expect.poll(async () => (await verifyInfo(page, "term-1"))?.state).toBe("pass");
  expect((await verifyInfo(page, "term-1"))?.command).toBe("npm run test");
  const stages = await readVerifyStages(projectRoot);
  expect(stages.map((stage) => stage.args)).toEqual([["pre"], ["two words"], ["main"], ["post"]]);
  expect(stages.every((stage) => stage.cwd === realpathSync(projectRoot))).toBe(true);
  expect(await access(join(otherRoot, "stages.jsonl")).then(() => true, () => false)).toBe(false);
  expect((await page.evaluate(() => window.termina.projectList())).find((project) => project.active)?.id).toBe(otherProject.id);
  await expect(page.locator(".project-tab.active .tab-name")).toHaveText("other verify project");
  await expect.poll(() => verifyContext(runRoot, "term-1")).toContain("✅ PASSED (exit code 0)");
});

test("a source edit during Verify preserves the successful execution as stale history", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const ready = join(runRoot, "verify-ready");
  const release = join(runRoot, "verify-release");
  await writeFile(join(projectRoot, "verify-gate.cjs"), `
const fs = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
(async () => {
  fs.writeFileSync(${JSON.stringify(ready)}, "ready");
  const deadline = Date.now() + 30000;
  while (!fs.existsSync(${JSON.stringify(release)})) {
    if (Date.now() >= deadline) throw new Error("verification gate was not released");
    await delay(20);
  }
})().catch((error) => { console.error(error); process.exitCode = 9; });
`);
  await writeVerifyPackage(projectRoot, { ...scripts, test: "node verify-gate.cjs && termina-verify-fixture main" });
  try {
    expect(await page.evaluate(() => window.termina.runVerify("term-1"))).toEqual({ ok: true });
    await expect.poll(() => access(ready).then(() => true, () => false)).toBe(true);
    const running = (await verifyInfo(page, "term-1"))!;
    expect(running.state).toBe("running");
    expect(running.source?.tree).toBeTruthy();
    await writeFile(join(projectRoot, "greeting.ts"), 'export const greeting = "changed during verification";\n');
    await writeFile(release, "release");
    await expect.poll(async () => (await verifyInfo(page, "term-1"))?.state).toBe("stale");
    const stale = (await verifyInfo(page, "term-1"))!;
    expect(stale.source).toEqual(running.source);
    expect(stale.result).toMatchObject({ state: "pass", exitCode: 0 });
    await expect(page.locator("#verify-badge")).toHaveClass(/state-stale/);
    await expect.poll(() => verifyContext(runRoot, "term-1")).toContain("**Status:** ⚠️ OUTDATED");

    expect(await page.evaluate(() => window.termina.runVerify("term-1"))).toEqual({ ok: true });
    await expect.poll(async () => (await verifyInfo(page, "term-1"))?.state).toBe("pass");
    expect((await verifyInfo(page, "term-1"))?.source?.tree).not.toBe(stale.source?.tree);
  } finally {
    await writeFile(release, "release");
  }
});

test("closing and reopening a project restores stale history rather than a current pass", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const originalProject = (await page.evaluate(() => window.termina.projectList())).find((project) => project.active)!;
  expect(await page.evaluate(() => window.termina.runVerify("term-1"))).toEqual({ ok: true });
  await expect.poll(async () => (await verifyInfo(page, "term-1"))?.state).toBe("pass");
  const verdict = (await verifyInfo(page, "term-1"))!;
  const otherRoot = join(runRoot, "restoration-other-project");
  await mkdir(otherRoot);
  await page.evaluate((root) => window.termina.projectOpenPath(root), otherRoot);
  expect(await page.evaluate((id) => window.termina.projectClose(id), originalProject.id)).toEqual({ ok: true });
  expect((await page.evaluate(() => window.termina.projectList())).some((project) => project.id === originalProject.id)).toBe(false);
  expect((await page.evaluate(() => window.termina.getInstances())).some((instance) => instance.projectId === originalProject.id)).toBe(false);

  await page.evaluate((root) => window.termina.projectOpenPath(root), projectRoot);
  const restoredProject = (await page.evaluate(() => window.termina.projectList())).find((project) => project.active)!;
  const restored = (await page.evaluate(() => window.termina.getInstances())).find((instance) => instance.projectId === restoredProject.id && instance.type === "agent")!;
  expect(restored).toBeTruthy();
  expect(restored.verify?.state).toBe("stale");
  expect(restored.verify?.source).toEqual(verdict.source);
  expect(restored.verify?.command).toBe(verdict.command);
  expect(restored.verify?.result).toEqual(verdict.result);
  await expect(page.locator("#verify-badge")).toHaveClass(/state-stale/);
  await expect.poll(() => verifyContext(runRoot, restored.id)).toContain("**Status:** ⚠️ OUTDATED");
  expect(await verifyContext(runRoot, restored.id)).toContain('"event":"posttest"');

  expect(await page.evaluate((id) => window.termina.runVerify(id), restored.id)).toEqual({ ok: true });
  await expect.poll(async () => (await verifyInfo(page, restored.id))?.state).toBe("pass");
  expect((await verifyInfo(page, restored.id))?.result!.startedAt).toBeGreaterThan(verdict.result!.finishedAt);
});
