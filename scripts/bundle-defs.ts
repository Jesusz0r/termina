/**
 * One typed owner for the esbuild bundle definitions shared by the
 * production build (scripts/build.ts) and development startup (scripts/dev.ts).
 *
 * Entry/output paths, format, target, and the intentional external lists live
 * here so the two entry points cannot drift. Process/Vite lifecycle stays in
 * dev.ts; the Rust core build stays in build-core.ts.
 *
 * `@lydell/node-pty` (and its platform packages) stays external: the native
 * binding loads at runtime, never from a bundle. Preload stays CommonJS:
 * sandboxed preloads cannot load ESM.
 */
import type { BuildOptions } from "esbuild";

export type TerminaBundleName = "main" | "sessionWorker" | "agentCore" | "preload";

export interface TerminaBundleDef {
  entryPoints: string[];
  outfile: string;
  format: "esm" | "cjs";
}

/** Single external list for every bundle (production is canonical). */
export const TERMINA_EXTERNALS: string[] = [
  "electron",
  "electron-updater",
  "@lydell/node-pty",
  "@lydell/node-pty-darwin-arm64",
  "@lydell/node-pty-win32-x64",
  "@lydell/node-pty-linux-x64",
];

export const TERMINA_BUNDLES: Record<TerminaBundleName, TerminaBundleDef> = {
  main: {
    entryPoints: ["electron/main.ts"],
    outfile: "dist-electron/main.mjs",
    format: "esm",
  },
  sessionWorker: {
    entryPoints: ["electron/session-worker.ts"],
    outfile: "dist-electron/session-worker.mjs",
    format: "esm",
  },
  agentCore: {
    entryPoints: ["agent-core/main.ts"],
    outfile: "dist-electron/agent-core.mjs",
    format: "esm",
  },
  preload: {
    entryPoints: ["electron/preload.ts"],
    outfile: "dist-electron/preload.cjs",
    format: "cjs",
  },
};

const TERMINA_TARGET = "node22";

export function terminaBuildOptions(def: TerminaBundleDef): BuildOptions {
  return {
    bundle: true,
    sourcemap: true,
    target: TERMINA_TARGET,
    external: [...TERMINA_EXTERNALS],
    logLevel: "info",
    entryPoints: def.entryPoints,
    platform: "node",
    format: def.format,
    outfile: def.outfile,
  };
}
