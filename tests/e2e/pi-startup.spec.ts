import { test as base, expect } from "./fixtures.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const test = base.extend({
  runRoot: async ({ runRoot }, use) => {
    const userData = join(runRoot, "user-data");
    mkdirSync(userData, { recursive: true });
    writeFileSync(join(userData, "preferences.json"), JSON.stringify({
      recentModels: [{ provider: "opencode-zen", model: "muse-spark-1.3-contributor-free" }],
    }));
    await use(runRoot);
  },
});

test("fresh Pi terminal ignores Core-only recent provider names", async ({ page, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
  const result = await page.evaluate(() => window.pi.createTerminal({ engine: "pi" }));
  expect(result.ok).toBe(true);
  // A session_ready event proves Pi completed startup instead of exiting
  // on the Core-only provider name before its bridge could initialize.
  await expect.poll(() => {
    try {
      return readFileSync(join(runRoot, "events", `${result.id}.jsonl`), "utf8")
        .split("\n").some((line) => line && JSON.parse(line).t === "session_ready");
    } catch { return false; }
  }, { timeout: 15_000 }).toBe(true);
});
