import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.{test,spec}.{ts,js,mjs}"],
    testTimeout: 60_000,
    pool: "forks",
    maxWorkers: 3,
  },
});
