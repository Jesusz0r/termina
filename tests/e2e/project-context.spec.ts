import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures.ts";

function contextFile(runRoot: string): string {
  return join(runRoot, "events", "project-term-1.md");
}

async function waitForContext(runRoot: string): Promise<string> {
  const path = contextFile(runRoot);
  await expect.poll(() => existsSync(path), { timeout: 20_000 }).toBe(true);
  return readFileSync(path, "utf8");
}

test("unchanged listings preserve the context while new entries refresh it", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const initial = await waitForContext(runRoot);
  expect(initial.split("\n")[0]).toBe("## Project snapshot — `test-project`");
  const modified = statSync(contextFile(runRoot)).mtimeMs;
  writeFileSync(join(projectRoot, "hello.txt"), "changed bytes, same listing\n");
  // A content-only edit schedules the five-second debounced snapshot refresh.
  // Wait through that refresh before checking the negative no-rewrite assertion.
  await page.waitForTimeout(7_000);
  expect(readFileSync(contextFile(runRoot), "utf8")).toBe(initial);
  expect(statSync(contextFile(runRoot)).mtimeMs).toBe(modified);

  writeFileSync(join(projectRoot, "new-file.txt"), "new entry\n");
  await expect.poll(() => readFileSync(contextFile(runRoot), "utf8"), { timeout: 20_000 }).toContain("new-file.txt");
});

test("long paths retain a bounded snapshot even with fewer than fifty entries", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  await waitForContext(runRoot);
  let directory = projectRoot;
  for (let index = 0; index < 3; index++) directory = join(directory, `segment-${index}-${"x".repeat(190)}`);
  mkdirSync(directory, { recursive: true });
  for (let index = 0; index < 25; index++) writeFileSync(join(directory, `file-${String(index).padStart(2, "0")}.txt`), "fixture\n");
  await expect.poll(() => readFileSync(contextFile(runRoot), "utf8"), { timeout: 20_000 }).toContain("\n…(truncated)\n");
  const text = readFileSync(contextFile(runRoot), "utf8");
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(12 * 1024);
  expect(text).toContain("segment-0-");
  expect(text).toContain("file-00.txt");
  expect(text.endsWith("```\n")).toBe(true);
});

test("deletions refresh the listing and an empty tree removes its previous context", async ({ page, projectRoot, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  expect(await waitForContext(runRoot)).toContain("\nhello.txt\n");
  rmSync(join(projectRoot, "hello.txt"));
  await expect.poll(() => readFileSync(contextFile(runRoot), "utf8"), { timeout: 20_000 }).not.toContain("\nhello.txt\n");
  for (const name of ["greeting.ts", "src"]) rmSync(join(projectRoot, name), { recursive: true });
  await expect.poll(() => existsSync(contextFile(runRoot)), { timeout: 20_000 }).toBe(false);
});
