/** Regression coverage for Monaco's build-time DOMPurify replacement. */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, mkdtempSync } from "node:fs";
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
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
const packageLock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"));

assert.equal(
  packageJson.dependencies?.dompurify,
  expectedVersion,
  "DOMPurify must be a pinned production dependency because Monaco uses it at runtime",
);
assert.equal(
  packageJson.overrides?.dompurify,
  expectedVersion,
  "the override must prevent Monaco's exact vulnerable dependency from being installed",
);

const lockedDomPurify = Object.entries(packageLock.packages ?? {})
  .filter(([path]) => path === "node_modules/dompurify" || path.endsWith("/node_modules/dompurify"))
  .map(([path, entry]) => [path, entry.version]);
assert.deepEqual(
  lockedDomPurify,
  [["node_modules/dompurify", expectedVersion]],
  "the lockfile must contain one patched DOMPurify and no nested vulnerable copy",
);

const installedSource = readFileSync(installedDomPurify, "utf8");
assert.match(installedSource, /DOMPurify\.version\s*=\s*['"]3\.4\.14['"]/, "installed DOMPurify must be 3.4.14");
assert.match(
  readFileSync(monacoSanitizer, "utf8"),
  /import purify from ['"]\.\/dompurify\/dompurify\.js['"]/,
  "the guarded Monaco import seam changed; update the resolver and this test together",
);

function collectJavaScript(root) {
  const chunks = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) chunks.push(collectJavaScript(path));
    else if (entry.isFile() && entry.name.endsWith(".js")) chunks.push(readFileSync(path, "utf8"));
  }
  return chunks.join("\n");
}

function assertPatchedCode(label, code) {
  assert.match(
    code,
    /DOMPurify\.version\s*=\s*['"]3\.4\.14['"]/,
    `${label} must execute DOMPurify 3.4.14`,
  );
  assert.doesNotMatch(code, /DOMPurify\.version\s*=\s*['"]3\.4\.8['"]/, `${label} must not execute DOMPurify 3.4.8`);
  assert.doesNotMatch(code, /DOMPurify 3\.4\.8\b/, `${label} must not contain Monaco's vulnerable vendored module`);
}

const testRoot = mkdtempSync(join(tmpdir(), "termina-dompurify-security-"));

try {
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
    assert.ok(resolved, "Vite must resolve Monaco's DOMPurify import");
    assert.equal(
      normalizePath(resolved.id.split("?", 1)[0]),
      normalizePath(installedDomPurify),
      "Vite serve/build resolution must replace Monaco's vendored sanitizer",
    );
  } finally {
    await server.close();
  }

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
  assert.ok(optimizedMonaco, "Monaco must remain prebundled for fast development startup");
  assertPatchedCode("Vite dependency optimization", collectJavaScript(dirname(optimizedMonaco.file)));

  const buildResult = await viteBuild({
    configFile: viteConfig,
    logLevel: "silent",
    build: { minify: false, write: false },
  });
  const outputs = Array.isArray(buildResult) ? buildResult : [buildResult];
  const chunks = outputs.flatMap((output) => output.output).filter((item) => item.type === "chunk");
  const expectedModule = normalizePath(installedDomPurify);
  const forbiddenModule = normalizePath(vendoredDomPurify);
  const sanitizerChunk = chunks.find((chunk) =>
    Object.keys(chunk.modules).some((id) => normalizePath(id.split("?", 1)[0]) === expectedModule));

  assert.ok(sanitizerChunk, "the production renderer build must include the patched DOMPurify module");
  assert.match(sanitizerChunk.fileName, /(?:^|\/)monaco(?:-|\.)/, "patched DOMPurify must stay in the Monaco chunk");
  assert.equal(
    chunks.some((chunk) => Object.keys(chunk.modules).some((id) => normalizePath(id.split("?", 1)[0]) === forbiddenModule)),
    false,
    "the production renderer build must exclude Monaco's vendored DOMPurify source",
  );
  assertPatchedCode("production Monaco chunk", sanitizerChunk.code);
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}

console.log("Monaco DOMPurify build and optimizer isolation passed");
