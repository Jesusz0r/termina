import { describe, it, expect } from "vitest";
import { normalizeAppPreferences, normalizeUserPreferencePatch, recordRecentModel } from "../../../shared/preferences.ts";

describe("recentModels preferences", () => {
  it("defaults to an empty list", () => {
    expect(normalizeAppPreferences({}).recentModels).toEqual([]);
    expect(normalizeAppPreferences(undefined).recentModels).toEqual([]);
  });

  it("keeps well-formed entries, most recent first, one per provider", () => {
    const got = normalizeAppPreferences({
      recentModels: [
        { provider: "anthropic", model: "claude-sonnet-4-6" },
        { provider: "openai", model: "gpt-5.3" },
        { provider: "anthropic", model: "claude-opus-4-6" },
      ],
    }).recentModels;
    expect(got).toEqual([
      { provider: "anthropic", model: "claude-sonnet-4-6" },
      { provider: "openai", model: "gpt-5.3" },
    ]);
  });

  it("drops malformed entries", () => {
    const got = normalizeAppPreferences({
      recentModels: [
        { provider: "", model: "x" },
        { provider: "a/b", model: "x" },
        { provider: "anthropic", model: "" },
        { provider: "anthropic" },
        "anthropic/claude",
        null,
        { provider: "openai", model: "gpt-5.3" },
      ],
    }).recentModels;
    expect(got).toEqual([{ provider: "openai", model: "gpt-5.3" }]);
  });

  it("caps the list", () => {
    const input = Array.from({ length: 20 }, (_, i) => ({ provider: `p${i}`, model: `m${i}` }));
    expect(normalizeAppPreferences({ recentModels: input }).recentModels).toHaveLength(12);
  });

  it("is main-owned: the renderer patch path cannot set it", () => {
    const patch = normalizeUserPreferencePatch({ recentModels: [{ provider: "x", model: "y" }], theme: "light" });
    expect("recentModels" in patch).toBe(false);
    expect(patch.theme).toBe("light");
  });
});

describe("recordRecentModel", () => {
  it("moves the touched provider to the front", () => {
    const prev = [
      { provider: "openai", model: "gpt-5.3" },
      { provider: "anthropic", model: "claude-sonnet-4-6" },
    ];
    expect(recordRecentModel(prev, "anthropic", "claude-opus-4-6")).toEqual([
      { provider: "anthropic", model: "claude-opus-4-6" },
      { provider: "openai", model: "gpt-5.3" },
    ]);
  });

  it("ignores malformed input and sanitizes the previous list", () => {
    const prev = [
      { provider: "openai", model: "gpt-5.3" },
      { provider: "", model: "x" },
    ] as { provider: string; model: string }[];
    expect(recordRecentModel(prev, "", "x")).toEqual([{ provider: "openai", model: "gpt-5.3" }]);
    expect(recordRecentModel(prev, "a/b", "x")).toEqual([{ provider: "openai", model: "gpt-5.3" }]);
  });
});
