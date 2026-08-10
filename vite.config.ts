import { defineConfig } from "vite";
import { resolve } from "node:path";

// Renderer is a plain (no-framework) TypeScript app. Monaco and xterm load
// from separate chunks; Monaco workers use ?worker imports in src/main.ts.
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
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/monaco-editor")) return "monaco";
          if (id.includes("node_modules/@xterm")) return "xterm";
          return undefined;
        },
      },
    },
  },
  optimizeDeps: {
    include: ["monaco-editor"],
  },
});