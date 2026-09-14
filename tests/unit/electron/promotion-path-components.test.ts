import { describe, it, expect } from "vitest";
import { promotionDirectoryComponents } from "../../../electron/worldlines/promotion-recovery/bound-dirs.ts";
import {
  promotionDestinationComponents,
  promotionParentComponents,
  promotionSourceComponents,
} from "../../../electron/worldlines/promotion-recovery/entry-state.ts";
import { isSafePromotionRelativePath } from "../../../electron/worldlines/promotion-recovery/primitives.ts";

describe("promotion path language (issue #177)", () => {
  it("treats backslash as a filename character on POSIX", () => {
    expect(isSafePromotionRelativePath("a\\b")).toBe(true);
    expect(isSafePromotionRelativePath("sub\\file")).toBe(true);
    expect(promotionSourceComponents("a\\b")).toEqual(["a\\b"]);
    expect(promotionSourceComponents("sub\\file")).toEqual(["sub\\file"]);
    expect(promotionParentComponents("/primary", "/primary/a\\b")).toEqual(["a\\b"]);
    expect(promotionDestinationComponents("/primary", "/primary/a\\b", "f")).toEqual(["a\\b", "f"]);
    expect(promotionDestinationComponents("/primary", "/primary", "a\\b")).toEqual(["a\\b"]);
    expect(promotionDirectoryComponents("/r", "/r/a\\b", "probe")).toEqual(["a\\b"]);
  });

  it("keeps a/b and a\\b distinct", () => {
    expect(promotionSourceComponents("a/b")).toEqual(["a", "b"]);
    expect(promotionSourceComponents("a/b")).not.toEqual(promotionSourceComponents("a\\b"));
  });

  it("rejects ./a in the validator and every splitter alike", () => {
    expect(isSafePromotionRelativePath("./a")).toBe(false);
    expect(isSafePromotionRelativePath("a/./b")).toBe(false);
    expect(() => promotionSourceComponents("./a")).toThrow(/invalid native promotion source/);
    expect(() => promotionSourceComponents("a/./b")).toThrow(/invalid native promotion source/);
  });

  it("rejects escapes and keeps ..foo valid everywhere", () => {
    for (const rel of ["../a", "a/../b", "..", "", ".", "/a", "a\0b"]) {
      expect(isSafePromotionRelativePath(rel)).toBe(false);
      expect(() => promotionSourceComponents(rel)).toThrow();
    }
    // A backslash-heavy but separator-free name is one component, not an escape.
    expect(isSafePromotionRelativePath("a\\..\\b")).toBe(true);
    expect(promotionSourceComponents("a\\..\\b")).toEqual(["a\\..\\b"]);
    expect(isSafePromotionRelativePath("..foo")).toBe(true);
    expect(promotionSourceComponents("..foo")).toEqual(["..foo"]);
    expect(promotionDirectoryComponents("/r", "/r/..foo", "probe")).toEqual(["..foo"]);
    expect(() => promotionParentComponents("/primary", "/other")).toThrow(/invalid native promotion parent/);
    expect(() => promotionDirectoryComponents("/r", "/other", "probe")).toThrow(/invalid probe components/);
  });

  it("collapses redundant slashes the same way everywhere", () => {
    expect(isSafePromotionRelativePath("a//b")).toBe(true);
    expect(promotionSourceComponents("a//b")).toEqual(["a", "b"]);
    expect(promotionParentComponents("/primary", "/primary")).toEqual([]);
  });
});
