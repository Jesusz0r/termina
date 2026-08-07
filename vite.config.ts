import { defineConfig } from "vite";
import { resolve } from "node:path";

// Renderer is a plain (no-framework) TypeScript app. Monaco and xterm are
// bundled from node_modules; Monaco workers are wired via ?worker imports in src/main.ts.
export default defineConfig({
  root: resolve(__dirname, "src"),
  base: "./",
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: resolve(__dirname, "dist-renderer"),
    emptyOutDir: true,
    target: "es2022",
  },
  optimizeDeps: {
    include: ["monaco-editor"],
  },
});