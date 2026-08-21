// Build the Electron main process and preload script with esbuild.
// Renderer is built separately by Vite (vite build).
import { build } from "esbuild";
import { buildCore } from "./build-core.mjs";

const shared = {
  bundle: true,
  sourcemap: true,
  target: "node22",
  external: ["electron", "electron-updater", "@lydell/node-pty", "@lydell/node-pty-darwin-arm64", "@lydell/node-pty-win32-x64", "@lydell/node-pty-linux-x64"],
  logLevel: "info",
};

await build({
  ...shared,
  entryPoints: ["electron/main.ts"],
  platform: "node",
  format: "esm",
  outfile: "dist-electron/main.mjs",
});

// The Rust snapshot core replaces the old snapshot worker thread.
buildCore();

// The session worker runs SessionManager work off the main thread.
// The pi package stays external: it resolves from node_modules at runtime.
await build({
  ...shared,
  entryPoints: ["electron/session-worker.ts"],
  platform: "node",
  format: "esm",
  outfile: "dist-electron/session-worker.mjs",
  external: [...shared.external, "@earendil-works/pi-coding-agent"],
});

// Preload must be CommonJS: sandboxed preloads cannot load ESM.
await build({
  ...shared,
  entryPoints: ["electron/preload.ts"],
  platform: "node",
  format: "cjs",
  outfile: "dist-electron/preload.cjs",
});

console.log("✓ main + preload built");