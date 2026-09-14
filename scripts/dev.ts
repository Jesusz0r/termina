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

  const launch = () => {
    const startedAt = Date.now();
    const child = spawn(electronPath, ["."], {
      stdio: "inherit",
      env: { ...process.env, VITE_DEV_SERVER_URL: url },
    });
    child.on("exit", (code) => {
      console.log(`electron exited (${code})`);
      // Only auto-relaunch if it actually ran for a bit; avoids a crash-loop
      // when Electron does not start (missing binary, bad config).
      if (Date.now() - startedAt > 3000) {
        setTimeout(launch, 500);
      } else {
        console.log("electron exited too quickly — not relaunching. Ctrl+C to stop.");
      }
    });
  };
  launch();

  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
