import { describe, it, expect } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_SESSION_SEARCH_QUERY,
  collectSessionSearchFiles,
  mergeSessionFiles,
  parseSessionMessageLine,
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
  it("lists core session bundles and ignores loose files", async () => {
    const root = mkdtempSync(join(tmpdir(), "ssc-"));
    try {
      const coreDir = join(root, "core");
      const current = join(coreDir, "core-11111111-1111-1111-1111-111111111111", "current");
      mkdirSync(current, { recursive: true });
      writeFileSync(join(current, "session.jsonl"), "{}\n");
      writeFileSync(join(coreDir, "notes.txt"), "not a session\n");
      writeFileSync(join(coreDir, "loose.jsonl"), "{}\n");
      const { files, error } = await collectSessionSearchFiles(coreDir);
      expect(error).toBeUndefined();
      expect(files.map((e) => e.name)).toEqual([
        "core-11111111-1111-1111-1111-111111111111/current/session.jsonl",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("yields [] for missing directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "ssc-"));
    try {
      const missing = await collectSessionSearchFiles(join(root, "no-core"));
      expect(missing.files).toEqual([]);
      expect(missing.error).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports uncertain when the core directory cannot be listed", async () => {
    const root = mkdtempSync(join(tmpdir(), "ssc-"));
    try {
      const coreDir = join(root, "core-file");
      writeFileSync(coreDir, "not a directory\n");
      const { files, error } = await collectSessionSearchFiles(coreDir);
      expect(files).toEqual([]);
      expect(error).toMatch(/session listing uncertain/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports uncertain when a session bundle cannot be listed, keeping the readable ones", async () => {
    const root = mkdtempSync(join(tmpdir(), "ssc-"));
    try {
      const coreDir = join(root, "core");
      const good = join(coreDir, "good-bundle-1", "current");
      mkdirSync(good, { recursive: true });
      writeFileSync(join(good, "session.jsonl"), "{}\n");
      const bad = join(coreDir, "bad-bundle-1", "current");
      mkdirSync(bad, { recursive: true });
      writeFileSync(join(bad, "session.jsonl"), "{}\n");
      writeFileSync(join(bad, "weird.jsonl"), "{}\n");
      const { files, error } = await collectSessionSearchFiles(coreDir);
      expect(files.map((e) => e.name)).toEqual(["good-bundle-1/current/session.jsonl"]);
      expect(error).toMatch(/session listing uncertain: 1 session could not be listed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores loose files named like session ids", async () => {
    const root = mkdtempSync(join(tmpdir(), "ssc-"));
    try {
      const coreDir = join(root, "core");
      mkdirSync(coreDir, { recursive: true });
      writeFileSync(join(coreDir, "fake-session-1"), "not a directory\n");
      const { files, error } = await collectSessionSearchFiles(coreDir);
      expect(files).toEqual([]);
      expect(error).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports uncertain when a bundle directory is unreadable", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const root = mkdtempSync(join(tmpdir(), "ssc-"));
    const locked = join(root, "core", "locked-bundle-1");
    try {
      const coreDir = join(root, "core");
      mkdirSync(join(locked, "current"), { recursive: true });
      writeFileSync(join(locked, "current", "session.jsonl"), "{}\n");
      chmodSync(locked, 0o000);
      const { files, error } = await collectSessionSearchFiles(coreDir);
      expect(files).toEqual([]);
      expect(error).toMatch(/session listing uncertain/);
    } finally {
      try {
        chmodSync(locked, 0o700);
      } catch {
        /* best-effort restore before the recursive remove */
      }
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
      const { hits, error } = await searchSessionFiles(searchOpts([file], `${text}-not-in-text`));
      expect(hits).toHaveLength(1);
      expect(error).toBeUndefined();
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
      expect((await searchSessionFiles(searchOpts([loud], "marker"))).hits).toHaveLength(1);
      // Past the cap it is never opened.
      expect((await searchSessionFiles(searchOpts([...files, loud], "marker"))).hits).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("searchSessionFiles walk errors", () => {
  function messageLine(content: string): string {
    return `${JSON.stringify({ storageSeq: 1, type: "message", message: { role: "user", content } })}\n`;
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

  it("returns hits so far plus listing uncertainty when a later segment is unreadable", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const root = mkdtempSync(join(tmpdir(), "ssw-"));
    const current = join(root, "core-walk-1", "current");
    const locked = join(current, "session.jsonl");
    try {
      mkdirSync(current, { recursive: true });
      const part = join(current, "part-000001.jsonl");
      writeFileSync(part, messageLine("first segment has the marker phrasing"));
      writeFileSync(locked, messageLine("second segment also mentions marker"));
      chmodSync(locked, 0o000);
      const result = await searchSessionFiles(
        searchOpts(
          [{ path: locked, name: "core-walk-1/current/session.jsonl", mtimeMs: 1, segments: [part, locked] }],
          "marker",
        ),
      );
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]?.text).toMatch(/first segment/);
      expect(result.error).toMatch(/session listing uncertain/);
    } finally {
      try {
        chmodSync(locked, 0o700);
      } catch {
        /* best-effort restore before the recursive remove */
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats a vanished segment as a race, not uncertainty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ssw-"));
    try {
      const goodPath = join(dir, "good.jsonl");
      writeFileSync(goodPath, messageLine("the marker phrasing"));
      const good: SessionFileEntry = { path: goodPath, name: "good.jsonl", mtimeMs: 1 };
      const missing: SessionFileEntry = { path: join(dir, "gone.jsonl"), name: "gone.jsonl", mtimeMs: 1 };
      const result = await searchSessionFiles(searchOpts([good, missing], "marker"));
      expect(result.hits).toHaveLength(1);
      expect(result.error).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks uncertainty when segment listing fails, keeping earlier hits", async () => {
    const root = mkdtempSync(join(tmpdir(), "ssw-"));
    try {
      const goodPath = join(root, "good.jsonl");
      writeFileSync(goodPath, messageLine("the marker phrasing"));
      const current = join(root, "core-broken", "current");
      mkdirSync(current, { recursive: true });
      const active = join(current, "session.jsonl");
      writeFileSync(active, messageLine("hidden by a malformed bundle"));
      writeFileSync(join(current, "weird.jsonl"), "{}\n");
      const result = await searchSessionFiles(
        searchOpts(
          [
            { path: goodPath, name: "good.jsonl", mtimeMs: 1 },
            { path: active, name: "core-broken/current/session.jsonl", mtimeMs: 2, segments: [active] },
          ],
          "marker",
        ),
      );
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]?.sessionFile).toBe("good.jsonl");
      expect(result.error).toMatch(/session listing uncertain/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("parseSessionMessageLine reclaim and errors (#452)", () => {
  it("indexes bash commands on tool_use", () => {
    const line = JSON.stringify({
      storageSeq: 2,
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "1", name: "bash", input: { command: "pnpm run test:unit" } }],
      },
    });
    const parsed = parseSessionMessageLine(line);
    expect(parsed?.text).toContain("[bash]");
    expect(parsed?.text).toContain("pnpm run test:unit");
  });

  it("indexes tool_result error text and repro after a failed turn", () => {
    const line = JSON.stringify({
      storageSeq: 4,
      type: "message",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "1",
          is_error: true,
          content: "ENOENT: no such file unique-error-token",
          repro: "bash 'ls missing.txt'",
        }],
      },
    });
    const parsed = parseSessionMessageLine(line);
    expect(parsed?.text).toContain("unique-error-token");
    expect(parsed?.text).toContain("reproduce: bash 'ls missing.txt'");
  });

  it("indexes prune stub reproduce: text so search still finds the command", () => {
    const line = JSON.stringify({
      storageSeq: 6,
      type: "revision",
      kind: "prune",
      revisionId: "rev-1",
      targets: [{
        sseq: 4,
        blockIndex: 0,
        action: "stub",
        original: { type: "tool_result", chars: 80, bytes: 80, sha256: "abc" },
        reclaimedTokens: 20,
        tool: "bash",
        repro: "bash 'pnpm run test:unit'",
        recovery: { source: "session-record", tool: "bash", repro: "bash 'pnpm run test:unit'" },
      }],
    });
    const parsed = parseSessionMessageLine(line);
    expect(parsed?.role).toBe("reclaim");
    expect(parsed?.text).toContain("reproduce: bash 'pnpm run test:unit'");
    expect(parsed?.text).toContain("storageSeq 4");
  });

  it("indexes summarize handoff text without dropping it", () => {
    const line = JSON.stringify({
      storageSeq: 8,
      type: "revision",
      kind: "summarize",
      evicted: 2,
      summarySseq: 8,
      message: { role: "user", content: "<context-handoff>\nkeep unique-handoff-token\n</context-handoff>" },
    });
    const parsed = parseSessionMessageLine(line);
    expect(parsed?.role).toBe("user");
    expect(parsed?.text).toContain("unique-handoff-token");
  });

  it("still parses a user message that mentions revision", () => {
    const line = JSON.stringify({
      storageSeq: 1,
      type: "message",
      message: { role: "user", content: 'please check the "revision" receipt' },
    });
    const parsed = parseSessionMessageLine(line);
    expect(parsed?.role).toBe("user");
    expect(parsed?.text).toContain("revision");
  });

  it("caps a huge tool_use command so the walk stays bounded", () => {
    const command = `echo ${"a".repeat(5000)}TAIL`;
    const line = JSON.stringify({
      storageSeq: 2,
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "1", name: "bash", input: { command } }],
      },
    });
    const parsed = parseSessionMessageLine(line);
    expect(parsed?.text).toContain("echo ");
    expect(parsed?.text.includes("TAIL")).toBe(false);
    expect(parsed?.text.length ?? 0).toBeLessThan(3000);
  });

  it("indexes is_error when the result body is empty", () => {
    const line = JSON.stringify({
      storageSeq: 4,
      type: "message",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "1", is_error: true, content: "" }],
      },
    });
    const parsed = parseSessionMessageLine(line);
    expect(parsed?.text).toContain("is_error");
  });

  it("skips prune drops that have no reproduce command", () => {
    const line = JSON.stringify({
      storageSeq: 6,
      type: "revision",
      kind: "prune",
      revisionId: "rev-drop",
      targets: [{
        sseq: 2,
        blockIndex: 0,
        action: "drop",
        original: { type: "thinking", chars: 12, bytes: 12, sha256: "abc" },
        reclaimedTokens: 3,
        recovery: { source: "session-record", tool: "thinking", repro: null },
      }],
    });
    expect(parseSessionMessageLine(line)).toBeNull();
  });

  it("ignores malformed prune targets and negative seq fields", () => {
    const line = JSON.stringify({
      storageSeq: 6,
      type: "revision",
      kind: "prune",
      revisionId: "rev-1",
      targets: [
        null,
        "nope",
        {
          sseq: -4,
          blockIndex: 0,
          action: "stub",
          original: { type: "tool_result", chars: Number.POSITIVE_INFINITY, bytes: 80, sha256: "abc" },
          reclaimedTokens: 20,
          tool: "grep",
          repro: "grep 'needle-token'",
          recovery: { source: "session-record", tool: "grep", repro: "grep 'needle-token'" },
        },
      ],
    });
    const parsed = parseSessionMessageLine(line);
    expect(parsed?.text).toContain("reproduce: grep 'needle-token'");
    expect(parsed?.text).toContain("storageSeq 0");
    expect(parsed?.text).toContain("cleared: 0 chars");
  });
});

describe("searchSessionFiles reclaim coverage (#452)", () => {
  function searchOpts(files: SessionFileEntry[], query: string) {
    return {
      query,
      files,
      projectCwd: "/proj",
      canonicalize: (p: string) => p,
      isProjectFile: () => false,
    };
  }

  it("hits prune reproduce: lines and tool-error text in one walk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ssr-"));
    try {
      const path = join(dir, "session.jsonl");
      writeFileSync(path, [
        JSON.stringify({
          storageSeq: 4,
          type: "message",
          message: {
            role: "user",
            content: [{
              type: "tool_result",
              is_error: true,
              content: "command failed unique-error-token",
              repro: "bash 'ls missing.txt'",
            }],
          },
        }),
        JSON.stringify({
          storageSeq: 6,
          type: "revision",
          kind: "prune",
          revisionId: "rev-1",
          targets: [{
            sseq: 4,
            blockIndex: 0,
            action: "stub",
            original: { type: "tool_result", chars: 40, bytes: 40, sha256: "abc" },
            reclaimedTokens: 10,
            tool: "bash",
            repro: "bash 'pnpm run test:unit'",
            recovery: { source: "session-record", tool: "bash", repro: "bash 'pnpm run test:unit'" },
          }],
        }),
      ].map((line) => `${line}\n`).join(""));
      const file: SessionFileEntry = { path, name: "session.jsonl", mtimeMs: 1 };
      const errorHits = await searchSessionFiles(searchOpts([file], "unique-error-token"));
      expect(errorHits.hits).toHaveLength(1);
      expect(errorHits.hits[0]?.text).toContain("unique-error-token");
      const reproHits = await searchSessionFiles(searchOpts([file], "test:unit"));
      expect(reproHits.hits.length).toBeGreaterThanOrEqual(1);
      expect(reproHits.hits.some((hit) => hit.text.includes("reproduce:"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
