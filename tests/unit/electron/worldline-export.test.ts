import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildExportMarkdown,
  buildUnifiedPatch,
  unifiedFileDiff,
} from "../../../electron/worldlines/export.ts";

describe("export unified diff", () => {
  it("emits an empty diff for identical content", () => {
    expect(unifiedFileDiff("a\nb\n", "a\nb\n")).toEqual([]);
  });

  it("diffs a mid-file change with context", () => {
    const before = "1\n2\n3\n4\n5\n6\n7\n8\n9\n";
    const after = "1\n2\n3\n4\nCHANGED\n6\n7\n8\n9\n";
    expect(unifiedFileDiff(before, after)).toEqual([
      "@@ -2,7 +2,7 @@",
      " 2",
      " 3",
      " 4",
      "-5",
      "+CHANGED",
      " 6",
      " 7",
      " 8",
    ]);
  });

  it("splits distant changes into two hunks", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m"].join("\n") + "\n";
    const after = ["A", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "M"].join("\n") + "\n";
    const hunks = unifiedFileDiff(before, after);
    expect(hunks.filter((line) => line.startsWith("@@")).length).toBe(2);
  });

  it("handles added and deleted files", () => {
    expect(buildUnifiedPatch([{ relPath: "new.ts", before: null, after: "x\n" }])).toContain("new file mode 100644");
    const deleted = buildUnifiedPatch([{ relPath: "old.ts", before: "x\n", after: null }]);
    expect(deleted).toContain("deleted file mode 100644");
    expect(deleted).toContain("--- a/old.ts");
    expect(deleted).toContain("+++ /dev/null");
  });

  it("stubs binary and oversized files", () => {
    expect(buildUnifiedPatch([{ relPath: "img.png", before: "a\0b", after: "a\0c" }])).toContain("Binary file changed");
    const big = `${"x\n".repeat(2100)}`;
    expect(buildUnifiedPatch([{ relPath: "big.ts", before: "y\n", after: big }])).toContain("Binary file changed");
  });

  it("sorts files by path", () => {
    const patch = buildUnifiedPatch([
      { relPath: "z.ts", before: null, after: "1\n" },
      { relPath: "a.ts", before: null, after: "1\n" },
    ]);
    expect(patch.indexOf("b/a.ts")).toBeLessThan(patch.indexOf("b/z.ts"));
  });

  it("round-trips through git apply semantics markers", () => {
    const patch = buildUnifiedPatch([{ relPath: "f.ts", before: "a\nb\n", after: "a\nc\n" }]);
    expect(patch).toContain("diff --git a/f.ts b/f.ts");
    expect(patch).toContain("--- a/f.ts");
    expect(patch).toContain("+++ b/f.ts");
    expect(patch.endsWith("\n")).toBe(true);
  });
});

describe("export markdown", () => {
  it("summarizes files, evidence, and profiles", () => {
    const md = buildExportMarkdown({
      comparisonId: "cmp-1",
      label: "A",
      role: "reference",
      model: "test/model",
      baseCommit: "abc123",
      exportedAt: "2026-01-01T00:00:00.000Z",
      files: [{ relPath: "a.ts", status: "modified" }],
      evidence: [{ kind: "verify", status: "pass", reason: null }],
      profiles: [{ profile: "simpler-implementation", winner: "A" }],
    });
    expect(md).toContain("Candidate A export — cmp-1");
    expect(md).toContain("`a.ts` (modified)");
    expect(md).toContain("| verify | pass | — |");
    expect(md).toContain("simpler-implementation: A");
  });

  it("handles empty evidence", () => {
    const md = buildExportMarkdown({
      comparisonId: "cmp-1",
      label: "B",
      role: "alternative",
      model: null,
      baseCommit: null,
      exportedAt: "now",
      files: [],
      evidence: [],
      profiles: [],
    });
    expect(md).toContain("No evidence records.");
    expect(md).toContain("Model: unknown");
  });

  it("notes truncation and stale evidence", () => {
    const md = buildExportMarkdown({
      comparisonId: "cmp-1",
      label: "A",
      role: "reference",
      model: "m",
      baseCommit: "abc",
      exportedAt: "now",
      files: [{ relPath: "a.ts", status: "modified" }],
      evidence: [],
      profiles: [],
      truncatedFiles: 5,
      evidenceStale: true,
    });
    expect(md).toContain("5 more files listed only");
    expect(md).toContain("Stale: the candidate ran again");
  });

  it("escapes markdown-breaking paths and reasons", () => {
    const md = buildExportMarkdown({
      comparisonId: "cmp-1",
      label: "A",
      role: "reference",
      model: "m",
      baseCommit: "abc",
      exportedAt: "now",
      files: [{ relPath: "we`ird\nname.ts", status: "modified" }],
      evidence: [{ kind: "verify", status: "fail", reason: "a|b\nnext" }],
      profiles: [],
    });
    // No raw backtick/newline inside the code span, no raw pipe/newline in
    // the table row: each record stays on exactly one line.
    expect(md).toContain("`we'ird name.ts` (modified)");
    expect(md).toContain("| verify | fail | a\\|b next |");
    expect(md).not.toContain("we`ird");
  });
});

describe("export wiring", () => {
  it("routes IPC, bridge, and button through exportCandidate", () => {
    const main = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");
    const preload = readFileSync(new URL("../../../electron/preload.ts", import.meta.url), "utf8");
    const types = readFileSync(new URL("../../../shared/types.ts", import.meta.url), "utf8");
    const view = readFileSync(new URL("../../../src/worldlines.ts", import.meta.url), "utf8");
    expect(main.includes('ipcMain.handle("worldline:export"')).toBe(true);
    expect(main.includes("return manager.exportCandidate(comparisonId, label);")).toBe(true);
    expect(preload.includes('exportWorldline: (comparisonId, label) => ipcRenderer.invoke("worldline:export", comparisonId, label),')).toBe(true);
    expect(types.includes("exportWorldline(comparisonId: string, label: \"A\" | \"B\"): Promise<{ ok: boolean; path?: string; error?: string }>;")).toBe(true);
    expect(view.includes("actionButton(\"cand-export\", \"Export\"")).toBe(true);
  });
});
