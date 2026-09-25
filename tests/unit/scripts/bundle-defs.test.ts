import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TERMINA_BUNDLES, TERMINA_EXTERNALS, terminaBuildOptions } from "../../../scripts/bundle-defs.ts";
import { emitThemeTokens, parseThemeTokens } from "../../../scripts/theme-tokens.ts";

const ROOT = new URL("../../..", import.meta.url).pathname;
const buildSrc = readFileSync(new URL("../../../scripts/build.ts", import.meta.url), "utf8");
const devSrc = readFileSync(new URL("../../../scripts/dev.ts", import.meta.url), "utf8");
const defsSrc = readFileSync(new URL("../../../scripts/bundle-defs.ts", import.meta.url), "utf8");

describe("shared bundle definitions (refs #133)", () => {
  it("defines the app and worker bundles with entry, output, and format", () => {
    expect(TERMINA_BUNDLES.contentSearchWorker).toEqual({
      entryPoints: ["electron/content-search/match-lines.js"],
      outfile: "dist-electron/content-search-worker.mjs", format: "esm",
    });
    expect(buildSrc).toContain("terminaBuildOptions(TERMINA_BUNDLES.contentSearchWorker)");
    expect(TERMINA_BUNDLES.main).toEqual({ entryPoints: ["electron/main.ts"], outfile: "dist-electron/main.mjs", format: "esm" });
    expect(TERMINA_BUNDLES.sessionWorker).toEqual({
      entryPoints: ["electron/session-worker.ts"],
      outfile: "dist-electron/session-worker.mjs",
      format: "esm",
    });
    expect(TERMINA_BUNDLES.agentCore).toEqual({
      entryPoints: ["agent-core/main.ts"],
      outfile: "dist-electron/agent-core.mjs",
      format: "esm",
    });
    // Preload stays CommonJS: sandboxed preloads cannot load ESM.
    expect(TERMINA_BUNDLES.preload).toEqual({
      entryPoints: ["electron/preload.ts"],
      outfile: "dist-electron/preload.cjs",
      format: "cjs",
    });
  });

  it("keeps one external list with the native runtime modules", () => {
    for (const name of ["electron", "electron-updater", "@lydell/node-pty", "@lydell/node-pty-darwin-arm64", "@lydell/node-pty-win32-x64", "@lydell/node-pty-linux-x64"]) {
      expect(TERMINA_EXTERNALS).toContain(name);
    }
  });

  it("builds node22 bundled options with sourcemaps for every definition", () => {
    for (const def of Object.values(TERMINA_BUNDLES)) {
      const options = terminaBuildOptions(def);
      expect(options).toMatchObject({
        bundle: true,
        sourcemap: true,
        target: "node22",
        platform: "node",
        logLevel: "info",
        entryPoints: def.entryPoints,
        outfile: def.outfile,
        format: def.format,
      });
      expect(options.external).toEqual(TERMINA_EXTERNALS);
    }
  });

  it("is the single source both entry points compose — no repeated definitions", () => {
    for (const src of [buildSrc, devSrc]) {
      expect(src).toContain('from "./bundle-defs.ts"');
      expect(src).toContain("TERMINA_BUNDLES");
      expect(src).toContain("terminaBuildOptions");
      // No independent external lists, targets, or entry/output paths left behind.
      expect(src).not.toContain("external:");
      expect(src).not.toContain("electron/main.ts");
      expect(src).not.toContain("electron/preload.ts");
      expect(src).not.toContain("electron/session-worker.ts");
      expect(src).not.toContain("agent-core/main.ts");
      expect(src).not.toContain("dist-electron/");
    }
  });

  it("regenerates theme tokens on dev startup, exactly like production", () => {
    for (const src of [buildSrc, devSrc]) {
      expect(src).toContain('from "./theme-tokens.ts"');
      expect(src).toContain("generateThemeTokens();");
    }
    // Dev refreshes the generated palette before bundling, so a stale
    // checked-in file cannot desync the stylesheet from Monaco/xterm.
    expect(devSrc.indexOf("generateThemeTokens();")).toBeLessThan(devSrc.indexOf("TERMINA_BUNDLES).map((def) => build("));
  });

  it("regeneration tracks the stylesheet, so a dev-startup refresh repairs staleness", () => {
    const css = readFileSync(join(ROOT, "src", "styles.css"), "utf8");
    const fresh = emitThemeTokens(parseThemeTokens(css));
    // A palette generated from older CSS differs from the current one: the
    // dev-startup generateThemeTokens() call above is what repairs that drift.
    // (Simulated in memory — mutating the checked-in file here would race the
    // freshness test running in another worker.)
    const staleCss = css.replace("--accent: #b8f04a;", "--accent: #000000;");
    expect(staleCss).not.toBe(css);
    expect(emitThemeTokens(parseThemeTokens(staleCss))).not.toBe(fresh);
    expect(fresh).toContain('"#b8f04a"');
  });

  it("keeps dev process and Vite lifecycle out of the shared definitions", () => {
    expect(defsSrc).not.toContain("vite");
    expect(defsSrc).not.toContain("child_process");
    expect(defsSrc).not.toContain("createServer");
    expect(defsSrc).not.toContain("spawn");
    expect(devSrc).toContain("createServer");
    expect(devSrc).toContain("spawn(");
  });
});
