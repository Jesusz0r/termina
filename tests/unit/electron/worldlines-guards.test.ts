import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isComparisonDirectoryCollision, isInside, parseStorageSeq, requireStorageSeq } from "../../../electron/worldlines/guards.ts";

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const child = join(root, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(child));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(child);
  }
  return out;
}

describe("worldlines guards (issue #193)", () => {
  it("implements within-or-equal containment with trailing-slash tolerance", () => {
    expect(isInside("/a", "/a/b")).toBe(true);
    expect(isInside("/a/", "/a/b")).toBe(true);
    expect(isInside("/a", "/a/b/")).toBe(true);
    expect(isInside("/", "/a")).toBe(true);
    // Equality holds: a root-level file's parent is the root itself.
    expect(isInside("/a", "/a")).toBe(true);
    expect(isInside("/a/", "/a/")).toBe(true);
    expect(isInside("/a/", "/a")).toBe(true);
    expect(isInside("/", "/")).toBe(true);
    expect(isInside("/a", "/a-b")).toBe(false);
    expect(isInside("/a", "/b")).toBe(false);
    expect(isInside("/a/b", "/a")).toBe(false);
  });

  it("parses decimal storage seqs only", () => {
    expect(parseStorageSeq("0")).toBe(0);
    expect(parseStorageSeq("42")).toBe(42);
    expect(parseStorageSeq("007")).toBe(7);
    expect(parseStorageSeq(null)).toBe(null);
    expect(parseStorageSeq(undefined)).toBe(null);
    expect(parseStorageSeq("")).toBe(null);
    expect(parseStorageSeq("0x10")).toBe(null);
    expect(parseStorageSeq("1e3")).toBe(null);
    expect(parseStorageSeq(" 5")).toBe(null);
    expect(parseStorageSeq("5 ")).toBe(null);
    expect(parseStorageSeq("5\n")).toBe(null);
    expect(parseStorageSeq("-1")).toBe(null);
    expect(parseStorageSeq("4.5")).toBe(null);
    expect(parseStorageSeq("9".repeat(30))).toBe(null);
  });

  it("requireStorageSeq rejects missing and zero B anchors", () => {
    expect(requireStorageSeq("42", "b")).toBe(42);
    expect(() => requireStorageSeq(undefined, "the alternative session address is missing"))
      .toThrow(/the alternative session address is missing/);
    expect(() => requireStorageSeq("0", "the alternative session address is missing"))
      .toThrow(/the alternative session address is missing/);
    expect(() => requireStorageSeq("abc", "this moment has no session address"))
      .toThrow(/this moment has no session address/);
  });

  it("isComparisonDirectoryCollision uses errno, not a message regex", () => {
    const collision = Object.assign(new Error("EEXIST: file already exists, mkdir"), { code: "EEXIST" });
    expect(isComparisonDirectoryCollision(collision)).toBe(true);
    expect(isComparisonDirectoryCollision(new Error("promotion directory cmp-1 already exists"))).toBe(false);
    expect(isComparisonDirectoryCollision(new Error("already exists"))).toBe(false);
  });

  it("keeps a single errno/record inspector beside shared/guards.ts", () => {
    const root = fileURLToPath(new URL("../../../electron/worldlines/", import.meta.url));
    const offenders: string[] = [];
    for (const file of sourceFiles(root)) {
      const text = readFileSync(file, "utf8");
      if (/function\s+(errnoCode|objectRecord)\s*\(/.test(text)) offenders.push(file);
      if (/from\s+["']\.\.?\/.*guards\.js["']/.test(text) && /errnoCode|objectRecord/.test(text)) offenders.push(`${file} (imports duplicates)`);
    }
    expect(offenders).toEqual([]);
  });
});
