import { describe, it, expect } from "vitest";
import { mergeSessionFiles, type SessionFileEntry } from "../../../electron/session-search.ts";

function entry(name: string, mtimeMs: number, path = `/s/${name}`): SessionFileEntry {
  return { path, name, mtimeMs };
}

describe("mergeSessionFiles", () => {
  it("orders newest first by ISO name timestamp, then mtime, then name", () => {
    const old = entry("2024-01-01T10-00-00.jsonl", 1000);
    const newer = entry("2024-06-01T10-00-00.jsonl", 500);
    const noTs = entry("notes.jsonl", 9_999_999_999_999);
    expect(mergeSessionFiles([[old, newer, noTs]]).map((e) => e.name)).toEqual([
      "notes.jsonl",
      "2024-06-01T10-00-00.jsonl",
      "2024-01-01T10-00-00.jsonl",
    ]);
  });

  it("dedupes by path across groups, keeping the first occurrence", () => {
    const a = entry("2024-06-01T10-00-00.jsonl", 1, "/s/shared.jsonl");
    const b = entry("2024-01-01T10-00-00.jsonl", 2);
    const merged = mergeSessionFiles([[a], [a, b]]);
    expect(merged.map((e) => e.path)).toEqual(["/s/shared.jsonl", b.path]);
  });
});
