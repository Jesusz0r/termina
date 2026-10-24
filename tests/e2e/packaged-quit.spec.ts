import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test, expect, launchOwnedElectron, closeOwnedElectron } from "./fixtures.ts";
import { quoteShellArg } from "../../shared/terminal-control.ts";
import { mockLifecycleDialogs, lifecycleDialogs, answerLifecycleDialog } from "./lifecycle-dialog.ts";

const executablePath = resolve(process.env.TERMINA_E2E_PACKAGED_EXECUTABLE
  ?? `release/mac${process.arch === "arm64" ? "-arm64" : ""}/Termina.app/Contents/MacOS/Termina`);

test("packaged Termina cancels quit, then exits with a live terminal and an unfinished hook", async ({ runRoot, projectRoot }) => {
  test.skip(process.platform !== "darwin" || !existsSync(executablePath), "Build the macOS app with electron-builder --mac --dir first");
  const env: Record<string, string> = {
    ...process.env,
    HOME: join(runRoot, "home"), USERPROFILE: join(runRoot, "home"),
    TERMINA_INITIAL_CWD: projectRoot,
    TERMINA_EVENTS_DIR: join(runRoot, "events"),
    TERMINA_WORLDS_DIR: join(runRoot, "worlds"),
    TERMINA_USER_DATA_DIR: join(runRoot, "user-data"),
    TERMINA_E2E_RUN_ROOT: runRoot,
    TERMINA_E2E_HIDDEN: "1",
    NODE_ENV: "test",
  };
  delete env.VITE_DEV_SERVER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of ["HOME", "TERMINA_EVENTS_DIR", "TERMINA_USER_DATA_DIR"]) mkdirSync(env[key]!, { recursive: true });
  const app = await launchOwnedElectron(env, runRoot, { executablePath });
  try {
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const page = await app.firstWindow();
    await expect(page.locator("#splash")).toBeHidden();
    await expect(page.locator(".project-tab")).toHaveCount(1);
    const shell = await page.evaluate(() => window.termina.createTerminal({ type: "shell" }));
    expect(shell.ok).toBe(true);
    const pidFile = join(projectRoot, "packaged-shell.pid");
    // A live client must not make shutdown wait for the terminal that owns it.
    const script = `const socket=require('node:net').connect(process.env.TERMINA_EXTERNAL_HOOK_SOCKET);socket.on('connect',()=>{socket.write('{"v":1');require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));});setInterval(()=>{},1000);`;
    await page.evaluate(({ id, command }) => window.termina.writeTerminal(id, command), {
      id: shell.id!, command: `node -e ${quoteShellArg(script)}\r`,
    });
    await expect.poll(() => existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await mockLifecycleDialogs(app, 1);
    await app.evaluate(({ app }) => { process.env.NODE_ENV = "production"; app.quit(); });
    await expect.poll(() => lifecycleDialogs(app).then((dialogs) => dialogs.length)).toBe(1);
    expect((await lifecycleDialogs(app))[0]!.message).toBe("Quit Termina?");
    expect(() => process.kill(pid, 0)).not.toThrow();
    await answerLifecycleDialog(app, 0);
    const closed = app.waitForEvent("close");
    await app.evaluate(({ app }) => app.quit());
    await closed;
    await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false);
  } finally {
    await closeOwnedElectron(app);
  }
});
