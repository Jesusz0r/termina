import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { editProjectFile } from "../../../agent-core/main/file-ops.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "termina-edit-validation-"));
  roots.push(root);
  return root;
}

/** A normalization hang trips the timeout instead of stalling the suite. */
const FAST = { timeout: 10_000 };

describe("edit search-term validation (#157)", () => {
  it("rejects BOM-only search in replace-all mode without hanging", FAST, () => {
    const root = project();
    writeFileSync(join(root, "text.txt"), "unchanged\n");
    for (const replacement of ["", "grown"]) {
      const started = Date.now();
      const got = editProjectFile(root, "text.txt", "\uFEFF", replacement, true);
      expect(Date.now() - started).toBeLessThan(FAST.timeout);
      expect(got.isError).toBe(true);
      expect(got.content).toContain("old_text must not be empty");
      expect(readFileSync(join(root, "text.txt"), "utf8")).toBe("unchanged\n");
    }
  });

  it("rejects BOM-only search in unique mode without hanging", FAST, () => {
    const root = project();
    writeFileSync(join(root, "text.txt"), "unchanged\n");
    const started = Date.now();
    const got = editProjectFile(root, "text.txt", "\uFEFF", "x", false);
    expect(Date.now() - started).toBeLessThan(FAST.timeout);
    expect(got.isError).toBe(true);
    expect(got.content).toContain("old_text must not be empty");
    expect(readFileSync(join(root, "text.txt"), "utf8")).toBe("unchanged\n");
  });

  it("rejects BOM-only search on empty files", FAST, () => {
    const root = project();
    writeFileSync(join(root, "empty.txt"), "");
    const started = Date.now();
    const got = editProjectFile(root, "empty.txt", "\uFEFF", "", true);
    expect(Date.now() - started).toBeLessThan(FAST.timeout);
    expect(got.isError).toBe(true);
    expect(readFileSync(join(root, "empty.txt"), "utf8")).toBe("");
  });

  it("still edits ordinary BOM-prefixed content", () => {
    const root = project();
    writeFileSync(join(root, "bom.txt"), "\uFEFFhello\n");
    const got = editProjectFile(root, "bom.txt", "hello", "bye");
    expect(got.isError).toBe(false);
    expect(readFileSync(join(root, "bom.txt"), "utf8")).toBe("bye\n");
  });

  it("strips a leading BOM from the search term, not the match", () => {
    const root = project();
    writeFileSync(join(root, "bom.txt"), "\uFEFFhello\n");
    const got = editProjectFile(root, "bom.txt", "\uFEFFhello", "bye");
    expect(got.isError).toBe(false);
    expect(readFileSync(join(root, "bom.txt"), "utf8")).toBe("bye\n");
  });

  it("rejects empty search terms before touching the filesystem", () => {
    const root = project();
    expect(editProjectFile(root, "missing.txt", "", "x").content).toContain("old_text must not be empty");
  });
});
