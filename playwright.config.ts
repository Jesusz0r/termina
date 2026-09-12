import { defineConfig } from "@playwright/test";
import { e2eTempDir } from "./tests/e2e/tmpdir.ts";

// Playwright's transform cache follows TMPDIR. Keep it outside the repo
// so a developer TMPDIR inside the workspace cannot be captured.
const isolatedTmp = e2eTempDir();
process.env.TMPDIR = isolatedTmp;
process.env.TEMP = isolatedTmp;
process.env.TMP = isolatedTmp;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90_000,
  expect: {
    timeout: 10_000,
  },
  workers: 1,
  retries: 1,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
  },
});
