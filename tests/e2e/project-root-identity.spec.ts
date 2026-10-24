import { mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, closeOwnedElectron, launchOwnedElectron } from "./fixtures.ts";

test("durable root identity restores saved projects after restart and permits opening another folder", async ({ page, electronApp, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const second = join(runRoot, "second-project");
  mkdirSync(second);
  writeFileSync(join(second, "second.txt"), "second project\n");
  await page.evaluate((cwd) => window.termina.projectOpenPath(cwd), second);
  await expect(page.locator(".project-tab")).toHaveCount(2);
  const environment = await electronApp.evaluate(() => ({ ...process.env }));
  const env = Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  delete env.TERMINA_INITIAL_CWD;
  await closeOwnedElectron(electronApp);
  const records = readdirSync(runRoot).filter((name) => /^\.termina-promotion-root-.*\.json$/.test(name));
  expect(records).toHaveLength(1);
  const provenance = readFileSync(join(runRoot, records[0]!), "utf8");
  expect(JSON.parse(provenance).version).toBe(2);
  if (process.platform === "darwin") {
    expect(JSON.parse(provenance).root.volume).toMatch(/^[a-f0-9]{32}$/);
    expect(JSON.parse(provenance).root.dev).toBeUndefined();
  }
  const replacement = await launchOwnedElectron(env, runRoot);
  try {
    const restored = await replacement.firstWindow();
    await expect(restored.locator(".project-tab")).toHaveCount(2);
    const projects = await restored.evaluate(() => window.termina.projectList());
    expect(projects.map((project) => project.cwd).sort()).toEqual([projectRoot, second].map((cwd) => realpathSync(cwd)).sort());
    const third = join(runRoot, "third-project");
    mkdirSync(third);
    writeFileSync(join(third, "third.txt"), "third project\n");
    await restored.evaluate((cwd) => window.termina.projectOpenPath(cwd), third);
    await expect(restored.locator(".project-tab")).toHaveCount(3);
    await expect(restored.locator("#explorer-tree").getByText("third.txt")).toBeVisible();
    expect(readFileSync(join(runRoot, records[0]!), "utf8")).toBe(provenance);
  } finally {
    await closeOwnedElectron(replacement);
  }
});
