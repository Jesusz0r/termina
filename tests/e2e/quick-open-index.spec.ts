import { test, expect } from "./fixtures.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Quick Open path index caches the project file list and patches it from
 * watcher events, so results must track the filesystem without any explicit
 * refresh. These are the correctness guarantees for that cache: a stale index
 * would silently hide files that exist, which is worse than a slow search.
 */
test("index invalidation: external create and delete are searchable", async ({ page, projectRoot }) => {
  await expect(page.locator("#splash")).toBeHidden({ timeout: 15_000 });
  const search = (q: string) => page.evaluate((query) => window.termina.searchFiles(query), q);
  const rels = async (q: string) => (await search(q)).entries.map((e) => e.relPath);

  // Warm the index so later searches score the cached list.
  await search("greeting");
  expect(await rels("brand-new")).toEqual([]);

  // Externally created file must become searchable (watcher -> noteAdded).
  writeFileSync(join(projectRoot, "brand-new-file.ts"), "x");
  await expect.poll(async () => (await rels("brand-new-file")), { timeout: 15_000 })
    .toEqual(["brand-new-file.ts"]);

  // A file inside a new directory too.
  mkdirSync(join(projectRoot, "freshdir"), { recursive: true });
  writeFileSync(join(projectRoot, "freshdir", "nested.ts"), "x");
  await expect.poll(async () => (await rels("nested")), { timeout: 15_000 }).toEqual(["freshdir/nested.ts"]);

  // Deleting must remove it from results.
  rmSync(join(projectRoot, "brand-new-file.ts"));
  await expect.poll(async () => (await rels("brand-new-file")), { timeout: 15_000 }).toEqual([]);

  // Deleting a directory drops its descendants (one event, no per-file event).
  rmSync(join(projectRoot, "freshdir"), { recursive: true, force: true });
  await expect.poll(async () => (await rels("nested")), { timeout: 15_000 }).toEqual([]);
});
