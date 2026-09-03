import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync, realpathSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  build as viteBuild,
  createServer,
  normalizePath,
  optimizeDeps,
  resolveConfig,
} from "vite";

const expectedVersion = "3.4.14";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const viteConfig = join(repoRoot, "vite.config.ts");
const monacoSanitizer = join(
  repoRoot,
  "node_modules/monaco-editor/esm/vs/base/browser/domSanitize.js",
);
const vendoredDomPurify = join(
  repoRoot,
  "node_modules/monaco-editor/esm/vs/base/browser/dompurify/dompurify.js",
);
const installedDomPurify = join(repoRoot, "node_modules/dompurify/dist/purify.es.mjs");
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const pnpmWorkspace = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
const pnpmLock = readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8");

function collectJavaScript(root: string): string {
  const chunks: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) chunks.push(collectJavaScript(path));
    else if (entry.isFile() && entry.name.endsWith(".js")) chunks.push(readFileSync(path, "utf8"));
  }
  return chunks.join("\n");
}

/** Canonical module path for comparisons. pnpm symlinks top-level
 *  node_modules entries into its content store, so strict path equality
 *  breaks under pnpm even when the resolved file is identical. */
function canonicalModuleId(id: string): string {
  const normalized = normalizePath(id.split("?", 1)[0]);
  try {
    return normalizePath(realpathSync(normalized));
  } catch {
    return normalized;
  }
}

function assertPatchedCode(code: string) {
  expect(code).toMatch(/DOMPurify\.version\s*=\s*['"]3\.4\.14['"]/);
  expect(code).not.toMatch(/DOMPurify\.version\s*=\s*['"]3\.4\.8['"]/);
  expect(code).not.toMatch(/DOMPurify 3\.4\.8\b/);
}

describe("DOMPurify build and optimizer isolation", () => {
  let testRoot: string;

  beforeAll(() => {
    testRoot = mkdtempSync(join(tmpdir(), "termina-dompurify-security-"));
  });

  afterAll(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("pins DOMPurify version and override", () => {
    expect(packageJson.dependencies?.dompurify).toBe(expectedVersion);
    // The override lives in pnpm-workspace.yaml (pnpm 11 no longer reads
    // the npm `overrides` field); it must pin the same version.
    expect(pnpmWorkspace).toMatch(new RegExp(`^\\s*dompurify:\\s*["']?${expectedVersion}["']?\\s*$`, "m"));
  });

  it("ensures pnpm-lock contains only the patched DOMPurify", () => {
    const lockedVersions = [...new Set([...pnpmLock.matchAll(/dompurify@(\d+\.\d+\.\d+)/g)].map((m) => m[1]))];
    expect(lockedVersions).toEqual([expectedVersion]);
  });

  it("verifies installed DOMPurify is 3.4.14 and Monaco imports it", () => {
    const installedSource = readFileSync(installedDomPurify, "utf8");
    expect(installedSource).toMatch(/DOMPurify\.version\s*=\s*['"]3\.4\.14['"]/);
    expect(readFileSync(monacoSanitizer, "utf8")).toMatch(
      /import purify from ['"]\.\/dompurify\/dompurify\.js['"]/,
    );
  });

  it("replaces Monaco's vendored sanitizer in Vite serve/resolve", async () => {
    const server = await createServer({
      configFile: viteConfig,
      cacheDir: join(testRoot, "resolve-cache"),
      logLevel: "silent",
      server: { middlewareMode: true },
    });
    try {
      const resolved = await server.pluginContainer.resolveId(
        "./dompurify/dompurify.js",
        monacoSanitizer,
      );
      expect(resolved).toBeTruthy();
      expect(canonicalModuleId(resolved!.id)).toBe(canonicalModuleId(installedDomPurify));
    } finally {
      await server.close();
    }
  });

  it("replaces vendored sanitizer during Vite dependency optimization", async () => {
    const optimizerConfig = await resolveConfig(
      {
        configFile: viteConfig,
        cacheDir: join(testRoot, "optimizer-cache"),
        logLevel: "silent",
        optimizeDeps: { force: true },
      },
      "serve",
    );
    const optimizerMetadata = await optimizeDeps(optimizerConfig, true, false);
    const optimizedMonaco = optimizerMetadata.optimized["monaco-editor"];
    expect(optimizedMonaco).toBeTruthy();
    assertPatchedCode(collectJavaScript(dirname(optimizedMonaco.file)));
  });

  it("bundles the patched DOMPurify into production Monaco chunk", async () => {
    const buildResult = await viteBuild({
      configFile: viteConfig,
      logLevel: "silent",
      build: { minify: false, write: false },
    });
    const outputs = Array.isArray(buildResult) ? buildResult : [buildResult];
    const chunks = outputs.flatMap((output) => (output as any).output).filter((item) => item.type === "chunk");
    const expectedModule = canonicalModuleId(installedDomPurify);
    const forbiddenModule = canonicalModuleId(vendoredDomPurify);
    const sanitizerChunk = chunks.find((chunk) =>
      Object.keys(chunk.modules).some((id) => canonicalModuleId(id) === expectedModule),
    );

    expect(sanitizerChunk).toBeTruthy();
    expect(sanitizerChunk.fileName).toMatch(/(?:^|\/)monaco(?:-|\.)/);
    const containsForbidden = chunks.some((chunk) =>
      Object.keys(chunk.modules).some((id) => canonicalModuleId(id) === forbiddenModule),
    );
    expect(containsForbidden).toBe(false);
    assertPatchedCode(sanitizerChunk.code);
  }, 300_000);
});
