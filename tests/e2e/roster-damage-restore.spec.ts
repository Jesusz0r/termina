import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, closeOwnedElectron, launchOwnedElectron } from "./fixtures.ts";

test("a damaged terminal list is kept aside instead of being overwritten", async ({ page, electronApp, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const environment = await electronApp.evaluate(() => ({ ...process.env }));
  const env = Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  delete env.TERMINA_INITIAL_CWD;
  await closeOwnedElectron(electronApp);
  const rosterDir = join(runRoot, "user-data", "terminal-rosters");
  const [roster] = readdirSync(rosterDir).filter((name) => name.endsWith(".json"));
  expect(roster).toBeTruthy();
  const damaged = "{\"terminals\": [ truncated by a crash";
  writeFileSync(join(rosterDir, roster!), damaged);
  const replacement = await launchOwnedElectron(env, runRoot);
  try {
    const restored = await replacement.firstWindow();
    await expect(restored.locator(".project-tab")).toHaveCount(1);
    const project = (await restored.evaluate(() => window.termina.projectList()))[0]!;
    // A new tab saves the roster; the damaged bytes must survive beside it.
    const created = await restored.evaluate((projectId) => window.termina.createTerminal({ type: "shell", projectId }), project.id);
    expect(created.ok, created.error).toBe(true);
    await expect.poll(() => readdirSync(rosterDir).filter((name) => name.startsWith(`${roster}.corrupt-`)).length).toBe(1);
    const aside = readdirSync(rosterDir).find((name) => name.startsWith(`${roster}.corrupt-`))!;
    expect(readFileSync(join(rosterDir, aside), "utf8")).toBe(damaged);
    await expect.poll(() => {
      try {
        return JSON.parse(readFileSync(join(rosterDir, roster!), "utf8")).terminals.length;
      } catch {
        return -1;
      }
    }).toBe(1);
  } finally {
    await closeOwnedElectron(replacement);
  }
});
