import { expect, test as base } from "./fixtures.ts";
import { readFile, access, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { readVerifyStages, writeVerifyPackage } from "../fixtures/verify-package.ts";

const scripts = {
  pretest: "termina-verify-fixture pre",
  test: 'termina-verify-fixture "two words" && termina-verify-fixture main',
  posttest: "termina-verify-fixture post",
};

const test = base.extend({
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

test("Verify executes npm lifecycle stages", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  expect(await page.evaluate(() => window.termina.detectTest("term-1"))).toEqual({ command: "npm", args: ["run", "test"], label: "npm run test" });
  const button = page.locator("#btn-verify");
  await expect(button).toBeEnabled();
  await expect(button).toHaveAttribute("title", "Run npm run test");
  await button.click();
  await expect.poll(async () => (await verifyInfo(page, "term-1"))?.state).toBe("pass");
  await expect(page.locator("#verify-badge")).toHaveClass(/state-pass/);
  const stages = await readVerifyStages(projectRoot);
  expect(stages.map((stage) => stage.args)).toEqual([["pre"], ["two words"], ["main"], ["post"]]);
  expect(stages.map((stage) => stage.event)).toEqual(["pretest", "test", "test", "posttest"]);
  expect(stages.map((stage) => stage.cwd)).toEqual(Array(4).fill(realpathSync(projectRoot)));
  await expect.poll(() => verifyContext(runRoot, "term-1")).toContain("✅ PASSED (exit code 0)");
  const context = await verifyContext(runRoot, "term-1");
  expect(context).toContain("`npm run test`");
  expect(context).toContain('"event":"pretest"');
  expect(context).toContain('"event":"posttest"');
});

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
