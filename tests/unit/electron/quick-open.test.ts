import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectPathIndex, SearchGenerations, fuzzyScore, listProjectSnapshot, searchProjectFiles } from "../../../electron/quick-open.ts";

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

describe("Quick Open path index", () => {
  /** A fixture tree the index and a plain walk can both read. */
  function fixture(): { root: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), "qo-index-"));
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    writeFileSync(join(root, "top.ts"), "x");
    writeFileSync(join(root, "src", "a.ts"), "x");
    writeFileSync(join(root, "src", "deep", "b.ts"), "x");
    writeFileSync(join(root, "src", "ignore-me.md"), "x");
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules", "hidden.ts"), "x");
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "config"), "x");
    return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  it("returns the same results as a plain walk", async () => {
    const { root, cleanup } = fixture();
    try {
      const index = new ProjectPathIndex();
      for (const query of ["", "a", "deep", "b.ts", "src", "zzz"]) {
        const walked = await searchProjectFiles(root, query);
        const cached = await searchProjectFiles(root, query, { candidates: await index.candidates(root) });
        expect(cached.entries).toEqual(walked.entries);
        expect(cached.truncated).toBe(walked.truncated);
      }
    } finally {
      cleanup();
    }
  });

  it("excludes ignored segments and dotfiles, like the walk", async () => {
    const { root, cleanup } = fixture();
    try {
      const index = new ProjectPathIndex();
      const { paths } = await index.candidates(root);
      expect(paths).toContain("top.ts");
      expect(paths).toContain("src/deep/b.ts");
      expect(paths).not.toContain("node_modules/hidden.ts");
      expect(paths).not.toContain(".git/config");
    } finally {
      cleanup();
    }
  });

  it("tracks creates and deletions without re-walking", async () => {
    const { root, cleanup } = fixture();
    try {
      const index = new ProjectPathIndex();
      await index.candidates(root);

      index.noteAdded("src/new.ts");
      expect((await searchProjectFiles(root, "new", { candidates: await index.candidates(root) })).entries)
        .toEqual([{ relPath: "src/new.ts" }]);

      index.noteRemoved("src/new.ts");
      expect((await searchProjectFiles(root, "new", { candidates: await index.candidates(root) })).entries).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("drops descendants when a directory is removed", async () => {
    const { root, cleanup } = fixture();
    try {
      const index = new ProjectPathIndex();
      await index.candidates(root);
      // One event for the directory, none for its files: the index must not keep
      // offering paths that are gone.
      index.noteRemoved("src");
      const { paths } = await index.candidates(root);
      expect(paths).not.toContain("src/a.ts");
      expect(paths).not.toContain("src/deep/b.ts");
      expect(paths).toContain("top.ts");
    } finally {
      cleanup();
    }
  });

  it("rebuilds when the root changes, and when invalidated", async () => {
    const { root, cleanup } = fixture();
    try {
      const index = new ProjectPathIndex();
      const first = await index.candidates(root);
      expect(first.paths).toContain("top.ts");

      // A different root must not inherit the first tree's paths.
      const other = mkdtempSync(join(tmpdir(), "qo-index-other-"));
      writeFileSync(join(other, "other.ts"), "x");
      const second = await index.candidates(other);
      expect(second.paths).toEqual(["other.ts"]);
      rmSync(other, { recursive: true, force: true });

      // Invalidation makes the next call re-read disk.
      writeFileSync(join(root, "added-later.ts"), "x");
      index.invalidate();
      expect((await index.candidates(root)).paths).toContain("added-later.ts");
    } finally {
      cleanup();
    }
  });

  it("does not cache a cancelled walk", async () => {
    const { root, cleanup } = fixture();
    try {
      const index = new ProjectPathIndex();
      await index.candidates(root, () => true);
      // The cancelled build left nothing cached, so a real call still works.
      expect((await index.candidates(root)).paths).toContain("top.ts");
    } finally {
      cleanup();
    }
  });

  it("discards a build that was invalidated while in flight", async () => {
    const { root, cleanup } = fixture();
    try {
      const index = new ProjectPathIndex();
      const view = index as unknown as { building: unknown; built: boolean };
      // No await between starting the build and invalidating, so the walk is
      // deterministically still in flight: the stale result must be dropped.
      const stale = index.candidates(root);
      index.invalidate();
      await stale;
      expect(view.built).toBe(false);
      // And the next call rebuilds from disk instead of serving stale data.
      expect((await index.candidates(root)).paths).toContain("top.ts");
    } finally {
      cleanup();
    }
  });

  it("does not let a stale build populate past an aborted replacement", async () => {
    const { root, cleanup } = fixture();
    try {
      const index = new ProjectPathIndex();
      const view = index as unknown as { built: boolean };
      const stale = index.candidates(root);
      index.invalidate();
      // A replacement starts and aborts; whichever build lands first, the
      // pre-invalidation walk must not populate the index.
      await index.candidates(root, () => true);
      await stale;
      expect(view.built).toBe(false);
      expect((await index.candidates(root)).paths).toContain("top.ts");
    } finally {
      cleanup();
    }
  });
});

describe("SearchGenerations", () => {
  it("supersedes same-lane searches without touching the other lane", () => {
    const gen = new SearchGenerations(["quick-open", "filter"] as const, "quick-open");
    const filterFirst = gen.next("filter");
    const quickFirst = gen.next("quick-open");
    expect(gen.current(filterFirst.source, filterFirst.seq)).toBe(true);
    const filterSecond = gen.next("filter");
    // The older filter search is stale, but the quick-open search that ran
    // between them is untouched: callers never abort each other.
    expect(gen.current(filterFirst.source, filterFirst.seq)).toBe(false);
    expect(gen.current(filterSecond.source, filterSecond.seq)).toBe(true);
    expect(gen.current(quickFirst.source, quickFirst.seq)).toBe(true);
  });

  it("routes unknown sources to the quick-open lane", () => {
    const gen = new SearchGenerations(["quick-open", "filter"] as const, "quick-open");
    for (const source of [undefined, null, "", "quick-open", "explorer", 42]) {
      expect(gen.next(source).source).toBe("quick-open");
    }
    expect(gen.next("filter").source).toBe("filter");
  });
});
