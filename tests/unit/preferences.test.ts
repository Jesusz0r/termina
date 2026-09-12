import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppPreferencesStore } from "../../electron/preferences.ts";
import { normalizeAppPreferences } from "../../shared/preferences";
import { syncParentDir } from "../../shared/fsync.ts";
import { defaultAppPreferences } from "../../shared/types.ts";

const tempFileSync = vi.hoisted(() => vi.fn());

vi.mock("../../shared/fsync.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/fsync.ts")>();
  return { ...actual, syncParentDir: vi.fn(actual.syncParentDir) };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const originalSync = handle.sync.bind(handle);
      handle.sync = async () => {
        tempFileSync();
        return originalSync();
      };
      return handle;
    },
  };
});

describe("recentModels sanitizer", () => {
  it("keeps valid entries, dedupes, caps, drops garbage", () => {
    const out = normalizeAppPreferences({
      recentModels: [
        { provider: "anthropic", model: "claude-x" },
        { provider: "anthropic", model: "claude-x" },
        { provider: "", model: "x" },
        { provider: "openai", model: "" },
        "nope",
        ...Array.from({ length: 20 }, (_, i) => ({ provider: `p${i}`, model: `m${i}` })),
      ],
    }).recentModels;
    expect(out[0]).toEqual({ provider: "anthropic", model: "claude-x" });
    expect(out.length).toBe(12);
  });
  it("defaults garbage to []", () => {
    expect(normalizeAppPreferences({ recentModels: "x" }).recentModels).toEqual([]);
  });
});

describe("AppPreferencesStore", () => {
  let root = "";
  let filePath = "";

  afterEach(async () => {
    vi.mocked(syncParentDir).mockClear();
    tempFileSync.mockClear();
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  async function openStore(): Promise<AppPreferencesStore> {
    root = await mkdtemp(join(tmpdir(), "termina-prefs-"));
    filePath = join(root, "preferences.json");
    return new AppPreferencesStore(filePath);
  }

  it("fsyncs the temp file and parent directory on save", async () => {
    const store = await openStore();
    await store.save(defaultAppPreferences());
    expect(tempFileSync).toHaveBeenCalled();
    expect(vi.mocked(syncParentDir)).toHaveBeenCalledWith(filePath);
    expect(JSON.parse(await readFile(filePath, "utf8")).theme).toBe("dark");
  });

  it("treats a missing file as safe to create", async () => {
    const store = await openStore();
    const loaded = await store.load();
    expect(loaded).toEqual(defaultAppPreferences());
    await store.save({ ...loaded, theme: "light" });
    expect(JSON.parse(await readFile(filePath, "utf8")).theme).toBe("light");
  });

  it("does not overwrite a corrupt file until reset is confirmed", async () => {
    const store = await openStore();
    const corrupt = "{not-json";
    await writeFile(filePath, corrupt, "utf8");
    const loaded = await store.load();
    expect(loaded).toEqual(defaultAppPreferences());
    await expect(store.save({ ...loaded, theme: "light" })).rejects.toThrow(/unreadable|reset is confirmed/);
    expect(await readFile(filePath, "utf8")).toBe(corrupt);
    await store.save({ ...loaded, theme: "light" }, { confirmReset: true });
    expect(JSON.parse(await readFile(filePath, "utf8")).theme).toBe("light");
  });

  it("does not overwrite an oversized file until reset is confirmed", async () => {
    const store = await openStore();
    const oversized = `${"x".repeat(128 * 1024 + 1)}`;
    await writeFile(filePath, oversized, "utf8");
    await store.load();
    await expect(store.save(defaultAppPreferences())).rejects.toThrow(/unreadable|reset is confirmed/);
    expect(await readFile(filePath, "utf8")).toBe(oversized);
    await store.save(defaultAppPreferences(), { confirmReset: true });
    expect(JSON.parse(await readFile(filePath, "utf8")).theme).toBe("dark");
  });

  it("does not overwrite a non-object prefs file until reset is confirmed", async () => {
    const store = await openStore();
    await writeFile(filePath, "[]", "utf8");
    await store.load();
    await expect(store.save(defaultAppPreferences())).rejects.toThrow(/unreadable|reset is confirmed/);
    expect(await readFile(filePath, "utf8")).toBe("[]");
    await store.save(defaultAppPreferences(), { confirmReset: true });
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({ theme: "dark" });
  });

  it("does not replace a directory at the prefs path until reset is confirmed", async () => {
    const store = await openStore();
    await mkdir(filePath);
    await store.load();
    await expect(store.save(defaultAppPreferences())).rejects.toThrow(/unreadable|reset is confirmed/);
    expect((await stat(filePath)).isDirectory()).toBe(true);
  });
});
