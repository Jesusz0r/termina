import { defineConfig, normalizePath, type Plugin as VitePlugin } from "vite";
import type { Plugin as EsbuildPlugin } from "esbuild";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const monacoDomPurifyImport = "./dompurify/dompurify.js";
const monacoSanitizerSuffix = "/node_modules/monaco-editor/esm/vs/base/browser/domSanitize.js";
const domPurifyEntry = normalizePath(fileURLToPath(import.meta.resolve("dompurify")));

function isMonacoDomPurifyImport(source: string, importer: string | undefined): boolean {
  return source === monacoDomPurifyImport
    && importer !== undefined
    && normalizePath(importer).endsWith(monacoSanitizerSuffix);
}

const monacoDomPurifyPlugin: VitePlugin = {
  name: "termina-monaco-dompurify",
  enforce: "pre",
  resolveId(source, importer) {
    return isMonacoDomPurifyImport(source, importer) ? domPurifyEntry : null;
  },
};

// Vite's dependency optimizer resolves relative imports inside Monaco directly
// through esbuild, so its normal resolver plugin cannot enforce the replacement.
const monacoDomPurifyOptimizerPlugin: EsbuildPlugin = {
  name: "termina-monaco-dompurify-optimizer",
  setup(build) {
    build.onResolve({ filter: /^\.\/dompurify\/dompurify\.js$/ }, (args) => {
      if (isMonacoDomPurifyImport(args.path, args.importer)) return { path: domPurifyEntry };
      return undefined;
    });
  },
};

// Renderer is a plain (no-framework) TypeScript app. Monaco and xterm load
// from separate chunks; Monaco workers use ?worker imports in src/main.ts.
export default defineConfig({
  root: resolve(__dirname, "src"),
  base: "./",
  plugins: [monacoDomPurifyPlugin],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: resolve(__dirname, "dist-renderer"),
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/monaco-editor") || normalizePath(id) === domPurifyEntry) return "monaco";
          if (id.includes("node_modules/@xterm")) return "xterm";
          return undefined;
        },
      },
    },
  },
  optimizeDeps: {
    include: ["monaco-editor"],
    esbuildOptions: {
      plugins: [monacoDomPurifyOptimizerPlugin],
    },
  },
});
