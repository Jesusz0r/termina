import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, closeOwnedElectron, launchOwnedElectron } from "./fixtures.ts";
import { EXTERNAL_CLIS } from "../../shared/types.ts";
import { mockLifecycleDialogs } from "./lifecycle-dialog.ts";

test("quit and restart restores open agent, shell and CLI tabs in every project", async ({ page, electronApp, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const first = (await page.evaluate(() => window.termina.projectList()))[0]!;
  expect(await page.evaluate((projectId) => window.termina.createTerminal({ type: "shell", projectId }), first.id)).toMatchObject({ ok: true });
  const second = join(runRoot, "second-project");
  mkdirSync(second);
  await electronApp.evaluate(({ dialog }, cwd) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cwd] });
  }, second);
  expect(await page.evaluate(() => window.termina.projectOpen())).toMatchObject({ cwd: second });
  await expect(page.locator(".project-tab")).toHaveCount(2);
  const secondProject = (await page.evaluate(() => window.termina.projectList())).find((p) => p.cwd === second)!;
  expect(await page.evaluate((projectId) => window.termina.createTerminal({ type: "shell", projectId }), secondProject.id)).toMatchObject({ ok: true });
  const bin = join(runRoot, "cli-bin");
  mkdirSync(bin);
  for (const cli of EXTERNAL_CLIS) {
    const executable = cli === "gemini" ? "agy" : cli;
    writeFileSync(join(bin, executable), "#!/bin/sh\nexec /bin/cat\n", { mode: 0o700 });
  }
  await electronApp.evaluate((_, bin) => {
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.CODEX_HOME = `${process.env.HOME}/.codex`;
    process.env.GROK_HOME = `${process.env.HOME}/.grok`;
    process.env.XDG_CONFIG_HOME = `${process.env.HOME}/.config`;
  }, bin);
  for (const cli of EXTERNAL_CLIS) {
    const created = await page.evaluate((cli) => window.termina.createTerminal({ cli }), cli);
    expect(created.ok, created.error).toBe(true);
  }
  await mockLifecycleDialogs(electronApp, 0);
  const closing = await page.evaluate(() => window.termina.createTerminal({ cli: "codex" }));
  expect(closing.ok).toBe(true);
  const closingInstance = (await page.evaluate(() => window.termina.getInstances())).find((entry) => entry.id === closing.id)!;
  expect(await page.evaluate(({ id, generation }) => window.termina.closeTerminal(id, generation), closingInstance)).toMatchObject({ ok: true });
  const before = await page.evaluate(() => window.termina.getInstances());
  expect(before).toHaveLength(9);
  const environment = await electronApp.evaluate(() => ({ ...process.env }));
  const env = Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  delete env.TERMINA_INITIAL_CWD;
  await mockLifecycleDialogs(electronApp, 0);
  const closed = electronApp.waitForEvent("close");
  await electronApp.evaluate(({ app }) => { process.env.NODE_ENV = "production"; app.quit(); });
  await closed;
  await closeOwnedElectron(electronApp);
  const rosterDir = join(runRoot, "user-data", "terminal-rosters");
  const saved = readdirSync(rosterDir).flatMap((name) => JSON.parse(readFileSync(join(rosterDir, name), "utf8")).terminals);
  expect(saved.map((entry) => entry.id).sort()).toEqual(before.map((entry) => entry.id).sort());
  const replacement = await launchOwnedElectron(env, runRoot);
  try {
    const restored = await replacement.firstWindow();
    await expect(restored.locator(".project-tab")).toHaveCount(2);
    const projects = await restored.evaluate(() => window.termina.projectList());
    const secondRestored = projects.find((p) => realpathSync(p.cwd) === realpathSync(second))!;
    await restored.evaluate((id) => window.termina.projectActivate(id, "entry"), secondRestored.id);
    await expect(restored.locator(".terminal-tab:visible")).toHaveCount(7);
    const after = await restored.evaluate(() => window.termina.getInstances());
    expect(after.map((entry) => ({ id: entry.id, type: entry.type, cwd: realpathSync(entry.cwd), shellName: entry.shellName })).sort((a,b) => a.id.localeCompare(b.id)))
      .toEqual(before.map((entry) => ({ id: entry.id, type: entry.type, cwd: realpathSync(entry.cwd), shellName: entry.shellName })).sort((a,b) => a.id.localeCompare(b.id)));
    const firstRestored = projects.find((p) => realpathSync(p.cwd) !== realpathSync(second))!;
    await restored.evaluate((id) => window.termina.projectActivate(id, "entry"), firstRestored.id);
    await expect(restored.locator(".terminal-tab:visible")).toHaveCount(2);
  } finally { await closeOwnedElectron(replacement); }
});
