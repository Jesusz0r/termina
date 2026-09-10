import { test, expect } from "./fixtures.ts";

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
