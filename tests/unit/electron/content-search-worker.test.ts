import { describe, expect, it } from "vitest";
import { ContentLineMatcher } from "../../../electron/content-search/line-matcher.ts";
import { validateGrepPattern } from "../../../shared/grep-pattern.ts";

describe("fallback regex worker lifecycle", () => {
  it("bounds an accepted pathological match without blocking main timers", async () => {
    expect(validateGrepPattern("a+$")).toBeNull();
    const matcher = new ContentLineMatcher("a+$", () => false, 500);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    try {
      expect(await matcher.match("aaa", 50, 240)).toHaveLength(1);
      ticks = 0;
      expect(await matcher.match("a".repeat(200000) + "!", 50, 240)).toEqual([]);
      expect(matcher.timedOut).toBe(true);
      expect(ticks).toBeGreaterThan(2);
    } finally { clearInterval(timer); await matcher.dispose(); }
  });
  it("cancels a running match and lets a subsequent query complete", async () => {
    let cancelled = false;
    const matcher = new ContentLineMatcher("a+$", () => cancelled, 5000);
    try {
      await matcher.match("aaa", 50, 240);
      const blocked = matcher.match("a".repeat(200000) + "!", 50, 240);
      cancelled = true;
      expect(await blocked).toEqual([]);
      expect(matcher.stopped).toBe(true);
      expect(matcher.timedOut).toBe(false);
    } finally { await matcher.dispose(); }
    const next = new ContentLineMatcher("needle", () => false, 5000);
    try { expect(await next.match("é needle", 50, 240)).toEqual([{line: 1, column: 3, text: "é needle"}]); }
    finally { await next.dispose(); }
  });
});
