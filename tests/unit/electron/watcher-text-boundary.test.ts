import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectWatcher } from "../../../electron/watcher.ts";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "watcher-text-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("uses the editor text boundary for seed caches, updates and recovery", async () => {
  const path = join(root, "file.txt");
  const invalid = Buffer.from([0x72, 0xe9, 0x73]);
  await writeFile(path, invalid);
  const watcher = new ProjectWatcher(root);
  const internals = watcher as unknown as {
    generation: number;
    seedExisting(generation: number): Promise<void>;
    emit(path: string, generation: number): Promise<void>;
  };
  const changes: Array<{ content: string; prev?: string }> = [];
  const uncached: string[] = [];
  watcher.onChange = (change) => { changes.push(change); };
  watcher.onFileUncached = (path) => { uncached.push(path); };

  await internals.seedExisting(internals.generation);
  expect(watcher.lastContents.has(path)).toBe(false);
  await internals.emit("file.txt", internals.generation);
  expect(changes).toEqual([]);
  expect(uncached).toEqual([path]);

  await writeFile(path, "valid �");
  await internals.emit("file.txt", internals.generation);
  expect(changes.at(-1)?.content).toBe("valid �");
  expect(watcher.lastContents.get(path)).toBe("valid �");

  await writeFile(path, invalid);
  await internals.emit("file.txt", internals.generation);
  expect(changes).toHaveLength(1);
  expect(watcher.lastContents.has(path)).toBe(false);

  await writeFile(path, "recovered");
  await internals.emit("file.txt", internals.generation);
  expect(changes.at(-1)).toMatchObject({ content: "recovered", prev: undefined });
});
