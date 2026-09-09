import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fuzzyScore, listProjectSnapshot, searchProjectFiles } from "../../../electron/quick-open.ts";

describe("quick-open fuzzyScore", () => {
  it("rejects non-subsequences", () => {
    expect(fuzzyScore("xyz", "src/main.ts")).toBeNull();
    expect(fuzzyScore("", "src/main.ts")).toBeNull();
  });

  it("prefers basename and consecutive matches", () => {
    const consecutive = fuzzyScore("main", "src/main.ts")!;
    const scattered = fuzzyScore("main", "my-app-note-index.ts")!;
    expect(consecutive).toBeGreaterThan(scattered);
  });

  it("rewards exact basename matches", () => {
    expect(fuzzyScore("main.ts", "src/main.ts")!).toBeGreaterThan(fuzzyScore("main.ts", "src/main.tsx")!);
  });

  it("is case-insensitive", () => {
    expect(fuzzyScore("MAIN", "src/main.ts")).not.toBeNull();
  });
});

describe("quick-open searchProjectFiles", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "termina-quickopen-"));
    await writeFile(join(root, "main.ts"), "x");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "editor.ts"), "x");
    await mkdir(join(root, "node_modules", "dep"), { recursive: true });
    await writeFile(join(root, "node_modules", "dep", "index.js"), "x");
    await writeFile(join(root, ".hidden"), "x");
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git", "config"), "x");
    await symlink(join(root, "src"), join(root, "loop"), "dir").catch(() => undefined);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds files by fuzzy query", async () => {
    const { entries } = await searchProjectFiles(root, "edit");
    expect(entries.some((e) => e.relPath === join("src", "editor.ts"))).toBe(true);
  });

  it("skips ignored segments and dotfiles", async () => {
    const { entries } = await searchProjectFiles(root, "");
    const rels = entries.map((e) => e.relPath);
    expect(rels).toContain("main.ts");
    expect(rels.some((r) => r.includes("node_modules"))).toBe(false);
    expect(rels.some((r) => r.includes(".git") || r === ".hidden")).toBe(false);
  });

  it("terminates on symlink cycles", async () => {
    const { entries, truncated } = await searchProjectFiles(root, "main");
    expect(truncated).toBe(false);
    expect(entries.length).toBeGreaterThan(0);
  });

  it("returns [] for nul queries", async () => {
    expect((await searchProjectFiles(root, "a\0b")).entries).toEqual([]);
  });
});

describe("quick-open listProjectSnapshot", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "termina-snapshot-"));
    await writeFile(join(root, "main.ts"), "x");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "editor.ts"), "x");
    await mkdir(join(root, "node_modules", "dep"), { recursive: true });
    await writeFile(join(root, "node_modules", "dep", "index.js"), "x");
    await writeFile(join(root, ".hidden"), "x");
    await symlink(join(root, "src"), join(root, "loop"), "dir").catch(() => undefined);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists top levels first with directories suffixed", async () => {
    const { entries, truncated } = await listProjectSnapshot(root);
    expect(truncated).toBe(false);
    expect(entries).toContain("main.ts");
    expect(entries).toContain("src/");
    expect(entries).toContain(join("src", "editor.ts"));
    expect(entries.indexOf("src/") < entries.indexOf(join("src", "editor.ts"))).toBe(true);
    expect(entries.some((e) => e.includes("node_modules"))).toBe(false);
    expect(entries).not.toContain(".hidden");
  });

  it("caps entries and reports truncation", async () => {
    const { entries, truncated } = await listProjectSnapshot(root, { maxEntries: 2 });
    expect(entries.length).toBe(2);
    expect(truncated).toBe(true);
  });

  it("terminates on symlink cycles", async () => {
    const { truncated } = await listProjectSnapshot(root);
    expect(truncated).toBe(false);
  });
});
