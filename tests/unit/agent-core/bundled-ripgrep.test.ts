import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { resolveBundledRipgrep } from "../../../agent-core/main/bundled-ripgrep.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "termina-rg-resolve-")));
  roots.push(root);
  const resources = join(root, "Resources");
  const project = join(root, "project");
  mkdirSync(join(resources, "bin"), { recursive: true });
  mkdirSync(project);
  const binary = join(resources, "bin", "rg");
  const url = pathToFileURL(join(resources, "app.asar.unpacked", "dist-electron", "agent-core.mjs")).href;
  return { root, resources, project, binary, url };
}

describe("packaged ripgrep resolution", () => {
  it("finds the executable from the unpacked bundle without consulting PATH", () => {
    const f = fixture();
    writeFileSync(f.binary, "fixture", { mode: 0o755 });
    expect(resolveBundledRipgrep(f.url, f.project)).toBe(f.binary);
  });
  it("prefers packaged rg to PATH through the actual bundled environment resolver", async () => {
    const f = fixture();
    writeFileSync(f.binary, "fixture", { mode: 0o755 });
    const output = join(f.resources, "app.asar.unpacked", "dist-electron", "agent-core.mjs");
    await build({ entryPoints: ["agent-core/main/env.ts"], outfile: output,
      bundle: true, platform: "node", format: "esm", target: "node22" });
    const pathDir = join(f.root, "host-bin");
    mkdirSync(pathDir);
    writeFileSync(join(pathDir, "rg"), "other fixture", { mode: 0o755 });
    const script = `import { resolveTrustedBin } from ${JSON.stringify(pathToFileURL(output).href)};
      console.log(resolveTrustedBin("rg", ${JSON.stringify(f.project)}));`;
    const resolve = () => execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", env: { ...process.env, PATH: pathDir },
    }).trim();
    expect(resolve()).toBe(f.binary);
    rmSync(f.binary);
    expect(resolve()).toBe(join(pathDir, "rg"));
  });
  it("rejects missing, nonexecutable, directory, or redirected resources", () => {
    const f = fixture();
    expect(resolveBundledRipgrep(f.url, f.project)).toBeNull();
    writeFileSync(f.binary, "fixture", { mode: 0o644 });
    expect(resolveBundledRipgrep(f.url, f.project)).toBeNull();
    chmodSync(f.binary, 0o755);
    expect(resolveBundledRipgrep(f.url, f.resources)).toBeNull();
    rmSync(f.binary);
    mkdirSync(f.binary);
    expect(resolveBundledRipgrep(f.url, f.project)).toBeNull();
    rmSync(f.binary, { recursive: true });
    const hostile = join(f.project, "rg");
    writeFileSync(hostile, "fixture", { mode: 0o755 });
    symlinkSync(hostile, f.binary);
    expect(resolveBundledRipgrep(f.url, f.project)).toBeNull();
  });
  it("does not infer resources from source, development bundles, or unrelated directories", () => {
    const f = fixture();
    writeFileSync(f.binary, "fixture", { mode: 0o755 });
    for (const path of ["dist-electron/agent-core.mjs", "agent-core/main/env.ts", "app.asar.unpacked/other/env.mjs"]) {
      expect(resolveBundledRipgrep(pathToFileURL(join(f.resources, path)).href, f.project)).toBeNull();
    }
  });
});
