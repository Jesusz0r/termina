import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evictOldest } from "../../../shared/evict-oldest.ts";

describe("evictOldest", () => {
  it("deletes insertion-order oldest keys while size exceeds cap", () => {
    const map = new Map<string, number>([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    expect(evictOldest(map, 2)).toEqual([["a", 1]]);
    expect([...map.keys()]).toEqual(["b", "c"]);
  });

  it("is a no-op when size is within cap", () => {
    const map = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    expect(evictOldest(map, 2)).toEqual([]);
    expect(map.size).toBe(2);
  });

  it("evicts multiple oldest entries when far over cap", () => {
    const map = new Map([
      ["a", 1],
      ["b", 2],
      ["c", 3],
      ["d", 4],
    ]);
    expect(evictOldest(map, 1)).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    expect([...map.entries()]).toEqual([["d", 4]]);
  });

  it("clears the map when cap is 0", () => {
    const map = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    evictOldest(map, 0);
    expect(map.size).toBe(0);
  });

  it("leaves an empty map empty", () => {
    const map = new Map<string, number>();
    expect(evictOldest(map, 0)).toEqual([]);
    expect(map.size).toBe(0);
  });

  it("treats a delete-and-set refresh as newest", () => {
    const map = new Map([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    map.delete("a");
    map.set("a", 1);
    evictOldest(map, 2);
    expect([...map.keys()]).toEqual(["c", "a"]);
  });
});

const MAP_CALLERS = [
  "electron/main.ts",
  "electron/watcher.ts",
  "electron/diagnostics.ts",
  "electron/subagents.ts",
  "agent-core/cache.ts",
  "src/main.ts",
];

describe("evictOldest callers", () => {
  it("migrates every listed Map site and leaves Set eviction local", () => {
    for (const file of MAP_CALLERS) {
      const src = readFileSync(file, "utf8");
      expect(src, file).toContain("evictOldest(");
      expect(src, file).not.toContain("keys().next()");
    }
    const main = readFileSync("electron/main.ts", "utf8");
    expect(main).toContain("pendingHints.values().next()");
  });
});
