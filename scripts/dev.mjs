// Dev workflow: build main+preload with esbuild, start the Vite dev server,
// then launch Electron pointing at it. Restarts Electron when it exits.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
// Under plain Node, `require("electron")` resolves to the path of the Electron binary.
const electronPath = require("electron");

const run = async () => {
  await build({
    bundle: true,
    sourcemap: true,
    target: "node22",
    external: ["electron"],
    logLevel: "info",
    entryPoints: ["electron/main.ts"],
    platform: "node",
    format: "esm",
    outfile: "dist-electron/main.mjs",
  });
  await build({
    bundle: true,
    sourcemap: true,
    target: "node22",
    external: ["electron"],
    logLevel: "info",
    entryPoints: ["electron/preload.ts"],
    platform: "node",
    format: "cjs",
    outfile: "dist-electron/preload.cjs",
  });

  const server = await createServer({
    configFile: "vite.config.ts",
  });
  await server.listen();
  const port = server.config.server.port;
  const url = `http://localhost:${port}`;
  console.log(`✓ vite dev server at ${url}`);

  const launch = () => {
    const child = spawn(electronPath, ["."], {
      stdio: "inherit",
      env: { ...process.env, VITE_DEV_SERVER_URL: url },
    });
    child.on("exit", (code) => {
      console.log(`electron exited (${code}) — relaunching, Ctrl+C to stop`);
      setTimeout(launch, 500);
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