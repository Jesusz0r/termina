import { mkdirSync, realpathSync, renameSync } from "node:fs";
import { join } from "node:path";
import { test, expect, closeOwnedElectron, launchOwnedElectron } from "./fixtures.ts";

test("a saved project that is missing at launch returns once its folder is back", async ({ page, electronApp, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const roots = [projectRoot];
  for (const name of ["second-project", "third-project"]) {
    const cwd = join(runRoot, name);
    mkdirSync(cwd);
    await page.evaluate((cwd) => window.termina.projectOpenPath(cwd), cwd);
    roots.push(cwd);
  }
  await expect(page.locator(".project-tab")).toHaveCount(3);
  const expected = roots.map((root) => realpathSync(root));
  const environment = await electronApp.evaluate(() => ({ ...process.env }));
  const env = Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  delete env.TERMINA_INITIAL_CWD;
  await closeOwnedElectron(electronApp);
  // Unmount stand-in: the middle project is gone for one launch.
  const middle = join(runRoot, "second-project");
  const parked = join(runRoot, "parked-second-project");
  renameSync(middle, parked);
  const without = await launchOwnedElectron(env, runRoot);
  try {
    const restored = await without.firstWindow();
    await expect(restored.locator(".project-tab")).toHaveCount(2);
  } finally {
    await closeOwnedElectron(without);
  }
  renameSync(parked, middle);
  const back = await launchOwnedElectron(env, runRoot);
  try {
    const restored = await back.firstWindow();
    await expect(restored.locator(".project-tab")).toHaveCount(3);
    const projects = await restored.evaluate(() => window.termina.projectList());
    expect(projects.map((project) => realpathSync(project.cwd))).toEqual(expected);
  } finally {
    await closeOwnedElectron(back);
  }
});
