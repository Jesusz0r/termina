// @ts-nocheck
// Build the Electron main process and preload script with esbuild.
// Renderer is built separately by Vite (vite build).
import { build } from "esbuild";
import { buildCore } from "./build-core.ts";
import { generateThemeTokens } from "./theme-tokens.ts";
import { TERMINA_BUNDLES, terminaBuildOptions } from "./bundle-defs.ts";

// styles.css is the one place theme values are written; the terminal and
// Monaco palettes import them from the generated module (fresh every build).
generateThemeTokens();

await build(terminaBuildOptions(TERMINA_BUNDLES.main));

// The Rust snapshot core replaces the old snapshot worker thread.
buildCore();

// The session worker runs core session-bundle work off the main thread.
await build(terminaBuildOptions(TERMINA_BUNDLES.sessionWorker));

await build(terminaBuildOptions(TERMINA_BUNDLES.agentCore));

// Preload must be CommonJS: sandboxed preloads cannot load ESM.
await build(terminaBuildOptions(TERMINA_BUNDLES.preload));

console.log("✓ main + preload built");
