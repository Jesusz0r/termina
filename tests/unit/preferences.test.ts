import { describe, it, expect } from "vitest";
import { normalizeAppPreferences } from "../../shared/preferences";

describe("recentModels sanitizer", () => {
  it("keeps valid entries, dedupes, caps, drops garbage", () => {
    const out = normalizeAppPreferences({
      recentModels: [
        { provider: "anthropic", model: "claude-x" },
        { provider: "anthropic", model: "claude-x" },
        { provider: "", model: "x" },
        { provider: "openai", model: "" },
        "nope",
        ...Array.from({ length: 20 }, (_, i) => ({ provider: `p${i}`, model: `m${i}` })),
      ],
    }).recentModels;
    expect(out[0]).toEqual({ provider: "anthropic", model: "claude-x" });
    expect(out.length).toBe(12);
  });
  it("defaults garbage to []", () => {
    expect(normalizeAppPreferences({ recentModels: "x" }).recentModels).toEqual([]);
  });
});
