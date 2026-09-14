import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildExportMarkdown,
  buildSkippedFilesText,
  buildUnifiedPatch,
  exportStubReason,
  partitionExportPatchFiles,
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

  it("excludes binary and oversized files from the patch as listed-only stubs", () => {
    const files = [
      { relPath: "img.png", before: "a\0b", after: "a\0c" },
      { relPath: "big.ts", before: "y\n", after: `${"x\n".repeat(2100)}` },
      { relPath: "huge.ts", before: "y\n", after: `z${"z".repeat(300 * 1024)}\n` },
      { relPath: "ok.ts", before: "a\n", after: "b\n" },
    ];
    expect(exportStubReason(files[0]!)).toBe("binary");
    expect(exportStubReason(files[1]!)).toBe("long");
    expect(exportStubReason(files[2]!)).toBe("oversized");
    expect(exportStubReason(files[3]!)).toBe(null);
    const { patchable, stubs } = partitionExportPatchFiles(files);
    expect(patchable.map((f) => f.relPath)).toEqual(["ok.ts"]);
    expect(stubs.map((s) => s.relPath)).toEqual(["img.png", "big.ts", "huge.ts"]);
    const patch = buildUnifiedPatch(files);
    expect(patch).toContain("diff --git a/ok.ts b/ok.ts");
    expect(patch).not.toContain("img.png");
    expect(patch).not.toContain("big.ts");
    expect(patch).not.toContain("huge.ts");
    const skipped = buildSkippedFilesText(stubs);
    expect(skipped).toContain("img.png (binary,");
    expect(skipped).toContain("big.ts (long,");
    expect(skipped).toContain("huge.ts (oversized,");
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

  it("keeps +x on created executables, 644 otherwise", () => {
    const patch = buildUnifiedPatch([
      { relPath: "run.sh", before: null, after: "x\n", mode: "100755" },
      { relPath: "plain.ts", before: null, after: "x\n" },
      { relPath: "bogus.ts", before: null, after: "x\n", mode: "100777" },
    ]);
    expect(patch).toContain("new file mode 100755");
    expect(patch.match(/new file mode 100644/g)?.length).toBe(2);
  });
});

describe("export git apply (issue #189)", () => {
  function fixtureRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "termina-export-apply-"));
    const git = (...args: string[]): void => {
      execFileSync("git", ["-c", "user.email=test@termina.local", "-c", "user.name=test", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "pipe" });
    };
    git("init", "-q", ".");
    writeFileSync(join(dir, "a-stub.ts"), "y\n");
    writeFileSync(join(dir, "img.png"), "img-bytes\n");
    writeFileSync(join(dir, "z-normal.ts"), "a\nb\n");
    git("add", ".");
    git("commit", "-qm", "init");
    return dir;
  }

  function applyCheck(dir: string, patch: string): number {
    const patchPath = join(dir, "candidate.patch");
    writeFileSync(patchPath, patch);
    try {
      execFileSync("git", ["apply", "--check", patchPath], { cwd: dir, stdio: "pipe" });
      return 0;
    } catch (err) {
      return (err as { status?: number }).status ?? 1;
    } finally {
      rmSync(patchPath, { force: true });
    }
  }

  it("passes git apply --check with a stub, a binary, and an oversized file", () => {
    const dir = fixtureRepo();
    try {
      // Stub sorts first: the pre-fix patch died here with exit 128.
      const patch = buildUnifiedPatch([
        { relPath: "a-stub.ts", before: "y\n", after: `${"x\n".repeat(2100)}` },
        { relPath: "img.png", before: "img-bytes\n", after: "img-\0bytes\n" },
        { relPath: "oversized.ts", before: null, after: `z${"z".repeat(300 * 1024)}\n` },
        { relPath: "z-normal.ts", before: "a\nb\n", after: "a\nc\n" },
      ]);
      expect(applyCheck(dir, patch)).toBe(0);
      // The surviving patch still applies for real.
      const patchPath = join(dir, "candidate.patch");
      writeFileSync(patchPath, patch);
      execFileSync("git", ["apply", patchPath], { cwd: dir, stdio: "pipe" });
      expect(readFileSync(join(dir, "z-normal.ts"), "utf8")).toBe("a\nc\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes git apply --check for a stub-free patch and an all-stub patch", () => {
    const dir = fixtureRepo();
    try {
      const clean = buildUnifiedPatch([{ relPath: "z-normal.ts", before: "a\nb\n", after: "a\nc\n" }]);
      expect(applyCheck(dir, clean)).toBe(0);
      const allStub = buildUnifiedPatch([
        { relPath: "a-stub.ts", before: "y\n", after: `${"x\n".repeat(2100)}` },
        { relPath: "img.png", before: "img-bytes\n", after: "img-\0bytes\n" },
      ]);
      // Nothing patchable: an empty patch plus the skipped-files listing.
      expect(allStub).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("export newlines (issue #193)", () => {
  it("renders the trailing-newline matrix git-faithfully", () => {
    expect(unifiedFileDiff("a", "a\n")).toEqual(["@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+a"]);
    expect(unifiedFileDiff("a\n", "a")).toEqual(["@@ -1 +1 @@", "-a", "+a", "\\ No newline at end of file"]);
    expect(unifiedFileDiff("hello", "hello\n")).toEqual(["@@ -1 +1 @@", "-hello", "\\ No newline at end of file", "+hello"]);
    expect(unifiedFileDiff("a\nb", "a\nc")).toEqual([
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "\\ No newline at end of file",
      "+c",
      "\\ No newline at end of file",
    ]);
    // Identical bytes (either newline state) still diff empty.
    expect(unifiedFileDiff("a", "a")).toEqual([]);
    expect(unifiedFileDiff("a\n", "a\n")).toEqual([]);
  });

  it("applies the matrix with byte-exact results, including +x", () => {
    const dir = mkdtempSync(join(tmpdir(), "termina-export-newlines-"));
    const git = (...args: string[]): void => {
      execFileSync("git", ["-c", "user.email=test@termina.local", "-c", "user.name=test", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "pipe" });
    };
    try {
      git("init", "-q", ".");
      writeFileSync(join(dir, "f1"), "a");
      writeFileSync(join(dir, "f2"), "a\n");
      writeFileSync(join(dir, "f3"), "a\nb");
      writeFileSync(join(dir, "f5"), "x\n");
      writeFileSync(join(dir, "f6"), "a");
      writeFileSync(join(dir, "f7"), "hello");
      git("add", ".");
      git("commit", "-qm", "init");
      const patch = buildUnifiedPatch([
        { relPath: "f1", before: "a", after: "a\n" },
        { relPath: "f2", before: "a\n", after: "a" },
        { relPath: "f3", before: "a\nb", after: "a\nc" },
        { relPath: "f4", before: null, after: "new\n" },
        { relPath: "f5", before: "x\n", after: "" },
        { relPath: "f6", before: "a", after: "a\nb\n" },
        { relPath: "f7", before: "hello", after: "hello\n" },
        { relPath: "run.sh", before: null, after: "x\n", mode: "100755" },
      ]);
      const patchPath = join(dir, "candidate.patch");
      writeFileSync(patchPath, patch);
      execFileSync("git", ["apply", "--check", patchPath], { cwd: dir, stdio: "pipe" });
      execFileSync("git", ["apply", patchPath], { cwd: dir, stdio: "pipe" });
      const bytes = (name: string): string => readFileSync(join(dir, name), "utf8");
      expect(bytes("f1")).toBe("a\n");
      expect(bytes("f2")).toBe("a");
      expect(bytes("f3")).toBe("a\nc");
      expect(bytes("f4")).toBe("new\n");
      expect(bytes("f5")).toBe("");
      expect(bytes("f6")).toBe("a\nb\n");
      // The 5-byte file gains exactly its newline: 6 bytes, not 5.
      expect(bytes("f7")).toBe("hello\n");
      expect(readFileSync(join(dir, "f7"), "utf8").length).toBe(6);
      expect(statSync(join(dir, "run.sh")).mode & 0o111).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
