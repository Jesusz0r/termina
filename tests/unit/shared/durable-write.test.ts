import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableAtomicWriteError, durableAtomicWrite } from "../../../shared/durable-write.ts";

const probes = vi.hoisted(() => ({
  parentSyncError: null as Error | null,
}));

vi.mock("../../../shared/fsync.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../shared/fsync.ts")>();
  return {
    ...actual,
    syncDirectoryAsync: async (directory: string) => {
      if (probes.parentSyncError) throw probes.parentSyncError;
      return actual.syncDirectoryAsync(directory);
    },
  };
});

describe("durableAtomicWrite", () => {
  const roots: string[] = [];

  afterEach(async () => {
    probes.parentSyncError = null;
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function prepare(): Promise<{ dir: string; path: string }> {
    const dir = await mkdtemp(join(tmpdir(), "termina-durable-write-"));
    roots.push(dir);
    return { dir, path: join(dir, "payload.json") };
  }

  it("replaces the dest and leaves no temp sibling", async () => {
    const { dir, path } = await prepare();
    await durableAtomicWrite(path, "first\n");
    await durableAtomicWrite(path, "second\n");
    expect(await readFile(path, "utf8")).toBe("second\n");
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("marks renamed when parent sync fails after the dest flip", async () => {
    const { path } = await prepare();
    await writeFile(path, "old\n", { encoding: "utf8", mode: 0o600 });
    probes.parentSyncError = new Error("parent sync failed");
    await expect(durableAtomicWrite(path, "new\n")).rejects.toMatchObject({
      name: "DurableAtomicWriteError",
      renamed: true,
      message: "parent sync failed",
    } satisfies Partial<DurableAtomicWriteError>);
    expect(await readFile(path, "utf8")).toBe("new\n");
  });

  it("does not flip dest when the temp cannot be created", async () => {
    const { dir, path } = await prepare();
    await writeFile(path, "keep\n", { encoding: "utf8", mode: 0o600 });
    const missing = join(dir, "gone", "file.txt");
    await expect(durableAtomicWrite(missing, "nope\n")).rejects.toMatchObject({
      name: "DurableAtomicWriteError",
      renamed: false,
    });
    expect(await readFile(path, "utf8")).toBe("keep\n");
  });
});
