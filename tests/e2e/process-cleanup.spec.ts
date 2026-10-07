import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, closeOwnedElectron, launchOwnedElectron } from "./fixtures.ts";

let restarted: { pid: number; root: string } | null = null;

test.afterAll(() => {
  if (!restarted) return;
  expect(() => process.kill(restarted!.pid, 0)).toThrow(/ESRCH/);
  expect(existsSync(restarted.root)).toBe(false);
});

test("ordinary fixture shutdown disposes PTYs before Electron will-quit", async ({ electronApp, page, projectRoot, runRoot, closeElectron }) => {
  if (process.platform === "darwin") {
    expect(await electronApp.evaluate(({ systemPreferences }) => systemPreferences.getUserDefault("ApplePersistenceIgnoreState", "boolean"))).toBe(true);
  }
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
  const shell = await page.evaluate(() => window.termina.createTerminal({ type: "shell" }));
  expect(shell.ok).toBe(true);
  const pidPath = join(projectRoot, "quit-shell.pid");
  await page.evaluate(({ id, path }) => window.termina.writeTerminal(id, `echo $$ > '${path}'; exec sleep 60\r`), { id: shell.id!, path: pidPath });
  await expect.poll(() => existsSync(pidPath)).toBe(true);
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  expect(pid).toBeGreaterThan(0);
  const proof = join(runRoot, "will-quit.json");
  await electronApp.evaluate(({ app }, { pid, proof }) => {
    app.once("will-quit", () => {
      let alive = true;
      try { process.kill(pid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      process.getBuiltinModule("fs").writeFileSync(proof, JSON.stringify({ alive }));
    });
  }, { pid, proof });
  await closeElectron();
  expect(existsSync(proof)).toBe(true);
  expect(JSON.parse(readFileSync(proof, "utf8"))).toEqual({ alive: false });
});

test("forced Electron shutdown reaps its surviving children and is idempotent", async ({ electronApp, closeElectron }) => {
  const pid = await electronApp.evaluate(({ app }) => {
    const { spawn } = process.getBuiltinModule("child_process");
    // Make app.close() hit the fixture's forced-exit path. This extra child is
    // intentionally outside Termina's terminal registry but owned by this app.
    app.on("before-quit", (event) => event.preventDefault());
    const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: "ignore",
    });
    return child.pid!;
  });
  expect(pid).toBeGreaterThan(0);
  await closeElectron();
  await closeElectron();
  expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
});

test("fixture teardown reaps a tracked replacement before removing its isolated roots", async ({ electronApp, page, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
  const environment = await electronApp.evaluate(() => ({ ...process.env }));
  const env = Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  await closeOwnedElectron(electronApp);
  const replacement = await launchOwnedElectron(env, runRoot);
  restarted = { pid: replacement.process().pid!, root: runRoot };
  const restored = await replacement.firstWindow();
  await expect(restored.locator("#splash")).toBeHidden({ timeout: 15_000 });
  // Leave this replacement to fixture teardown. afterAll proves it stopped first.
});
