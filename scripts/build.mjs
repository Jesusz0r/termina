// Build the Electron main process and preload script with esbuild.
// Renderer is built separately by Vite (vite build).
import { build } from "esbuild";

const shared = {
  bundle: true,
  sourcemap: true,
  target: "node22",
  external: ["electron", "@lydell/node-pty", "@lydell/node-pty-darwin-arm64", "@lydell/node-pty-win32-x64", "@lydell/node-pty-linux-x64"],
  logLevel: "info",
};

await build({
  ...shared,
  entryPoints: ["electron/main.ts"],
  platform: "node",
  format: "esm",
  outfile: "dist-electron/main.mjs",
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