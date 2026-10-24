import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test, expect, closeOwnedElectron, launchOwnedElectron } from "./fixtures.ts";

test("restart refocuses the project that was active, not the last tab", async ({ page, electronApp, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  // Three tabs: the last open's save is still pending when boot finishes, so
  // only a middle open can overwrite the stored focus on the first tab.
  for (const name of ["second-project", "third-project"]) {
    const cwd = join(runRoot, name);
    mkdirSync(cwd);
    await page.evaluate((cwd) => window.termina.projectOpenPath(cwd), cwd);
  }
  await expect(page.locator(".project-tab")).toHaveCount(3);
  const first = (await page.evaluate(() => window.termina.projectList())).find((p) => realpathSync(p.cwd) === realpathSync(projectRoot))!;
  await page.evaluate((id) => window.termina.projectActivate(id, "entry"), first.id);
  await expect.poll(async () => (await page.evaluate(() => window.termina.projectList())).find((p) => p.active)?.id).toBe(first.id);
  // The focus save is asynchronous; quit only after it reached disk.
  await expect.poll(() => {
    try {
      return JSON.parse(readFileSync(join(runRoot, "user-data", "preferences.json"), "utf8")).activeProject;
    } catch {
      return null;
    }
  }).toBe(realpathSync(projectRoot));
  const environment = await electronApp.evaluate(() => ({ ...process.env }));
  const env = Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  delete env.TERMINA_INITIAL_CWD;
  await closeOwnedElectron(electronApp);
  const replacement = await launchOwnedElectron(env, runRoot);
  try {
    const restored = await replacement.firstWindow();
    await expect(restored.locator(".project-tab")).toHaveCount(3);
    await expect.poll(async () => {
      const active = (await restored.evaluate(() => window.termina.projectList())).find((p) => p.active);
      return active ? realpathSync(active.cwd) : null;
    }).toBe(realpathSync(projectRoot));
  } finally {
    await closeOwnedElectron(replacement);
  }
});
