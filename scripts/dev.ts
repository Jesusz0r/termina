// @ts-nocheck
// Dev workflow: build main+preload with esbuild, start the Vite dev server,
// then launch Electron pointing at it. Restarts Electron when it exits.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { createServer } from "vite";
import { patchBundleName } from "./patch-bundle-name.ts";
import { buildCore } from "./build-core.ts";
import { generateThemeTokens } from "./theme-tokens.ts";
import { TERMINA_BUNDLES, terminaBuildOptions } from "./bundle-defs.ts";

const require = createRequire(import.meta.url);
// Under plain Node, `require("electron")` resolves to the path of the Electron binary.
const electronPath = require("electron");

patchBundleName();
buildCore();

// styles.css is the one place theme values are written; regenerate the module
// the terminal and Monaco palettes import, exactly like the production build.
// Without this, editing theme colors and restarting dev leaves the stylesheet
// and the generated palette inconsistent.
generateThemeTokens();

const run = async () => {
  await Promise.all(Object.values(TERMINA_BUNDLES).map((def) => build(terminaBuildOptions(def))));

  const server = await createServer({
    configFile: "vite.config.ts",
  });
  await server.listen();
  const port = server.config.server.port;
  const url = `http://localhost:${port}`;
  console.log(`✓ vite dev server at ${url}`);

  let electron = null;
  let relaunchTimer = null;
  let stopping = false;

  const launch = () => {
    if (stopping) return;
    const startedAt = Date.now();
    const child = spawn(electronPath, ["."], {
      stdio: "inherit",
      env: { ...process.env, VITE_DEV_SERVER_URL: url },
    });
    electron = child;
    child.on("exit", (code) => {
      if (electron === child) electron = null;
      console.log(`electron exited (${code})`);
      if (stopping) return;
      // Only auto-relaunch if it actually ran for a bit; avoids a crash-loop
      // when Electron does not start (missing binary, bad config).
      if (Date.now() - startedAt > 3000) {
        relaunchTimer = setTimeout(launch, 500);
      } else {
        console.log("electron exited too quickly — not relaunching. Ctrl+C to stop.");
      }
    });
  };
  launch();

  // Electron is a GUI process. Ctrl+C stops this script and Vite; the app
  // otherwise stays in the Dock. Ask it to quit, then kill it if quit hangs.
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    if (relaunchTimer) clearTimeout(relaunchTimer);
    const child = electron;
    if (child && child.exitCode === null && child.signalCode === null) {
      const termExit = waitForExit(child, 2000);
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      await termExit;
      if (child.exitCode === null && child.signalCode === null) {
        const killExit = waitForExit(child, 2000);
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        await killExit;
      }
    }
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  if (process.platform !== "win32") process.on("SIGHUP", () => void shutdown());
};

function waitForExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
