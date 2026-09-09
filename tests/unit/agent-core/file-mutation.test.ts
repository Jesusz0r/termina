import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileMutationKey, withFileMutation } from "../../../agent-core/main.ts";

describe("file mutation serialization", () => {
  it("keys by confined absolute path", () => {
    const cwd = mkdtempSync(join(tmpdir(), "file-mutex-"));
    const root = realpathSync(cwd);
    expect(fileMutationKey(cwd, "a/b.ts")).toBe(join(root, "a/b.ts"));
    expect(fileMutationKey(cwd, "a/b.ts")).toBe(fileMutationKey(cwd, "a/b.ts"));
    expect(fileMutationKey(cwd, "a/c.ts")).not.toBe(fileMutationKey(cwd, "a/b.ts"));
    expect(fileMutationKey(cwd, "../outside.ts")).toBe(null);
  });

  it("serializes same-key mutations in call order", async () => {
    const seen: string[] = [];
    const slow = withFileMutation("k1", async () => {
      await new Promise((r) => setTimeout(r, 20));
      seen.push("slow");
      return 1;
    });
    const fast = withFileMutation("k1", async () => {
      seen.push("fast");
      return 2;
    });
    expect(await Promise.all([slow, fast])).toEqual([1, 2]);
    expect(seen).toEqual(["slow", "fast"]);
  });

  it("lets different keys overlap and releases after failure", async () => {
    const seen: string[] = [];
    const failing = withFileMutation("k2", async () => {
      await new Promise((r) => setTimeout(r, 10));
      seen.push("failing");
      throw new Error("boom");
    });
    const next = withFileMutation("k2", async () => {
      seen.push("next");
      return true;
    });
    const other = withFileMutation("k3", async () => {
      seen.push("other");
      return true;
    });
    await expect(failing).rejects.toThrow("boom");
    expect(await Promise.all([next, other])).toEqual([true, true]);
    expect(seen).toContain("next");
  });

  it("runs null keys unserialized", async () => {
    expect(await withFileMutation(null, async () => 42)).toBe(42);
  });
});
