import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_SESSION_SEARCH_QUERY,
  collectSessionSearchFiles,
  mergeSessionFiles,
  searchSessionFiles,
  type SessionFileEntry,
} from "../../../electron/session-search.ts";

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

describe("collectSessionSearchFiles", () => {
  it("merges pi history with core bundles, ignoring non-jsonl files", async () => {
    const root = mkdtempSync(join(tmpdir(), "ssc-"));
    try {
      const piDir = join(root, "pi");
      const coreDir = join(root, "core");
      mkdirSync(piDir, { recursive: true });
      mkdirSync(coreDir, { recursive: true });
      writeFileSync(join(piDir, "2024-06-01T10-00-00.jsonl"), "{}\n");
      writeFileSync(join(piDir, "notes.txt"), "not a session\n");
      const files = await collectSessionSearchFiles(piDir, coreDir);
      expect(files.map((e) => e.name)).toEqual(["2024-06-01T10-00-00.jsonl"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("yields [] for missing directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "ssc-"));
    try {
      const files = await collectSessionSearchFiles(join(root, "no-pi"), join(root, "no-core"));
      expect(files).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("searchSessionFiles bounds", () => {
  function sessionFile(dir: string, name: string, content: string): SessionFileEntry {
    const path = join(dir, name);
    writeFileSync(path, `${JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content } })}\n`);
    return { path, name, mtimeMs: 1 };
  }

  function searchOpts(files: SessionFileEntry[], query: string) {
    return {
      query,
      files,
      projectCwd: "/proj",
      canonicalize: (p: string) => p,
      isProjectFile: () => false,
    };
  }

  it("truncates over-long queries instead of scanning with them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ssq-"));
    try {
      // 256 chars: the truncated needle matches, the full query cannot.
      const text = `start-${"q".repeat(250)}`;
      expect(text).toHaveLength(MAX_SESSION_SEARCH_QUERY);
      const file = sessionFile(dir, "s.jsonl", text);
      const hits = await searchSessionFiles(searchOpts([file], `${text}-not-in-text`));
      expect(hits).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never scans past the file cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ssq-"));
    try {
      const files: SessionFileEntry[] = [];
      for (let i = 0; i < 50; i++) files.push(sessionFile(dir, `quiet-${i}.jsonl`, "nothing relevant here"));
      const loud = sessionFile(dir, "loud.jsonl", "the marker phrasing");
      // Control: the 51st file matches when it is inside the searched prefix.
      expect(await searchSessionFiles(searchOpts([loud], "marker"))).toHaveLength(1);
      // Past the cap it is never opened.
      expect(await searchSessionFiles(searchOpts([...files, loud], "marker"))).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
