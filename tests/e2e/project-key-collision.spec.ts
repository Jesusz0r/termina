import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test, expect, closeOwnedElectron, launchOwnedElectron } from "./fixtures.ts";

test("folders that share a sanitized name keep separate terminal rosters", async ({ page, electronApp, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  // `my-app` and `my/app` both sanitize to `--…-my-app--`.
  const dashed = join(runRoot, "my-app");
  const nested = join(runRoot, "my", "app");
  mkdirSync(dashed);
  mkdirSync(nested, { recursive: true });
  for (const cwd of [dashed, nested]) await page.evaluate((cwd) => window.termina.projectOpenPath(cwd), cwd);
  await expect(page.locator(".project-tab")).toHaveCount(3);
  const projects = await page.evaluate(() => window.termina.projectList());
  const dashedProject = projects.find((p) => realpathSync(p.cwd) === realpathSync(dashed))!;
  for (let i = 0; i < 2; i++) {
    const created = await page.evaluate((projectId) => window.termina.createTerminal({ type: "shell", projectId }), dashedProject.id);
    expect(created.ok, created.error).toBe(true);
  }
  const countOf = async (target: typeof page, cwd: string) => {
    const project = (await target.evaluate(() => window.termina.projectList())).find((p) => realpathSync(p.cwd) === realpathSync(cwd))!;
    await target.evaluate((id) => window.termina.projectActivate(id, "entry"), project.id);
    await expect.poll(async () => (await target.evaluate(() => window.termina.projectList())).find((p) => p.active)?.id).toBe(project.id);
    return target.locator(".terminal-tab:visible").count();
  };
  const before = { dashed: await countOf(page, dashed), nested: await countOf(page, nested) };
  expect(before.dashed).toBe(before.nested + 2);
  const environment = await electronApp.evaluate(() => ({ ...process.env }));
  const env = Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  delete env.TERMINA_INITIAL_CWD;
  await closeOwnedElectron(electronApp);
  const replacement = await launchOwnedElectron(env, runRoot);
  try {
    const restored = await replacement.firstWindow();
    await expect(restored.locator(".project-tab")).toHaveCount(3);
    await expect.poll(() => countOf(restored, dashed)).toBe(before.dashed);
    await expect.poll(() => countOf(restored, nested)).toBe(before.nested);
  } finally {
    await closeOwnedElectron(replacement);
  }
});
