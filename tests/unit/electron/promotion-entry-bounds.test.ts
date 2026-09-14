import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PROMOTION_FILE_BYTES } from "../../../electron/worldlines/limits.ts";
import { readPromotionEntry } from "../../../electron/worldlines/promotion-recovery/entry-state.ts";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("readPromotionEntry bounds (issue #176)", () => {
  it("streams small and multi-chunk files with exact hash and size", async () => {
    const dir = await mkdtemp(join(tmpdir(), "termina-promotion-entry-"));
    try {
      const small = join(dir, "small.txt");
      await writeFile(small, "hello promotion", { mode: 0o640 });
      const seen = await readPromotionEntry(small);
      expect(seen.state).toEqual({ type: "file", mode: 0o640, hash: sha256("hello promotion") });
      expect(seen.size).toBe(Buffer.byteLength("hello promotion"));

      const big = join(dir, "chunked.bin");
      const content = "x".repeat(200 * 1024 + 7);
      await writeFile(big, content);
      const chunked = await readPromotionEntry(big);
      expect(chunked.state).toEqual({ type: "file", mode: 0o644, hash: sha256(content) });
      expect(chunked.size).toBe(content.length);

      const empty = join(dir, "empty.txt");
      await writeFile(empty, "");
      const emptySeen = await readPromotionEntry(empty);
      expect(emptySeen.size).toBe(0);
      expect(emptySeen.state).toEqual({ type: "file", mode: 0o644, hash: sha256("") });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the missing/symlink/directory guards", async () => {
    const dir = await mkdtemp(join(tmpdir(), "termina-promotion-entry-"));
    try {
      expect(await readPromotionEntry(join(dir, "nope"))).toEqual({ state: { type: "missing" } });
      const target = join(dir, "target.txt");
      await writeFile(target, "t");
      const link = join(dir, "link.txt");
      await symlink(target, link);
      expect(await readPromotionEntry(link)).toEqual({ state: { type: "symlink", target } });
      const sub = join(dir, "sub");
      await mkdir(sub);
      const dirSeen = await readPromotionEntry(sub);
      expect(dirSeen.state.type).toBe("directory");
      expect(dirSeen.size).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed above the single-file cap without buffering", async () => {
    const dir = await mkdtemp(join(tmpdir(), "termina-promotion-entry-"));
    try {
      const over = join(dir, "over.bin");
      await writeFile(over, "");
      await truncate(over, MAX_PROMOTION_FILE_BYTES + 1);
      await expect(readPromotionEntry(over)).rejects.toThrow(/single-file bound/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads a file at exactly the cap via streaming", async () => {
    const dir = await mkdtemp(join(tmpdir(), "termina-promotion-entry-"));
    try {
      const at = join(dir, "at.bin");
      await writeFile(at, "");
      await truncate(at, MAX_PROMOTION_FILE_BYTES);
      const seen = await readPromotionEntry(at);
      expect(seen.state.type).toBe("file");
      expect(seen.size).toBe(MAX_PROMOTION_FILE_BYTES);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
