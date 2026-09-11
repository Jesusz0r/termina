import { describe, it, expect } from "vitest";
import { normalizeAppPreferences, normalizeUserPreferencePatch, recordRecentFile, recordRecentModel } from "../../../shared/preferences.ts";

describe("autoOpenAgentFiles preference", () => {
  it("defaults to true", () => {
    expect(normalizeAppPreferences({}).autoOpenAgentFiles).toBe(true);
  });

  it("keeps an explicit false and falls back on garbage", () => {
    expect(normalizeAppPreferences({ autoOpenAgentFiles: false }).autoOpenAgentFiles).toBe(false);
    expect(normalizeAppPreferences({ autoOpenAgentFiles: "no" }).autoOpenAgentFiles).toBe(true);
  });

  it("is user-patchable", () => {
    const patch = normalizeUserPreferencePatch({ autoOpenAgentFiles: false });
    expect(patch.autoOpenAgentFiles).toBe(false);
  });
});

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

describe("recordRecentFile", () => {
  it("moves the file to the front, most recent first", () => {
    const prev = [{ projectId: "p", relPath: "a.ts" }];
    expect(recordRecentFile(prev, "p", "b.ts")).toEqual([
      { projectId: "p", relPath: "b.ts" },
      { projectId: "p", relPath: "a.ts" },
    ]);
    expect(recordRecentFile(recordRecentFile(prev, "p", "b.ts"), "p", "a.ts")[0]).toEqual({
      projectId: "p",
      relPath: "a.ts",
    });
  });

  it("dedupes by project and path, not by path alone", () => {
    const prev = [{ projectId: "p1", relPath: "a.ts" }];
    expect(recordRecentFile(prev, "p2", "a.ts")).toEqual([
      { projectId: "p2", relPath: "a.ts" },
      { projectId: "p1", relPath: "a.ts" },
    ]);
  });

  it("drops malformed and escaping entries", () => {
    expect(recordRecentFile([], "p", "../outside.ts")).toEqual([]);
    expect(recordRecentFile([], "p", "/abs.ts")).toEqual([]);
    expect(recordRecentFile([], "", "a.ts")).toEqual([]);
    expect(recordRecentFile([], "p", "")).toEqual([]);
  });

  it("bounds the list", () => {
    let files: Array<{ projectId: string; relPath: string }> = [];
    for (let i = 0; i < 30; i++) files = recordRecentFile(files, "p", `f${i}.ts`);
    expect(files).toHaveLength(20);
    expect(files[0]).toEqual({ projectId: "p", relPath: "f29.ts" });
  });

  it("defaults empty and stays main-owned", () => {
    expect(normalizeAppPreferences({}).recentFiles).toEqual([]);
    const patch = normalizeUserPreferencePatch({ recentFiles: [{ projectId: "p", relPath: "a.ts" }], theme: "light" });
    expect("recentFiles" in patch).toBe(false);
    expect(patch.theme).toBe("light");
  });
});

describe("defaultEffort preference", () => {
  it("defaults to null", () => {
    expect(normalizeAppPreferences({}).defaultEffort).toBe(null);
  });

  it("keeps a well-formed level and drops garbage", () => {
    expect(normalizeAppPreferences({ defaultEffort: "xhigh" }).defaultEffort).toBe("xhigh");
    expect(normalizeAppPreferences({ defaultEffort: " HIGH " }).defaultEffort).toBe("high");
    expect(normalizeAppPreferences({ defaultEffort: "turbo" }).defaultEffort).toBe("turbo");
    expect(normalizeAppPreferences({ defaultEffort: 3 }).defaultEffort).toBe(null);
    expect(normalizeAppPreferences({ defaultEffort: "high!" }).defaultEffort).toBe(null);
  });

  it("stays main-owned, not user-patchable", () => {
    const patch = normalizeUserPreferencePatch({ defaultEffort: "high", theme: "light" });
    expect("defaultEffort" in patch).toBe(false);
    expect(patch.theme).toBe("light");
  });
});

describe("defaultEffort preference", () => {
  it("defaults to null", () => {
    expect(normalizeAppPreferences({}).defaultEffort).toBe(null);
  });

  it("keeps a well-formed level and drops garbage", () => {
    expect(normalizeAppPreferences({ defaultEffort: "xhigh" }).defaultEffort).toBe("xhigh");
    expect(normalizeAppPreferences({ defaultEffort: " HIGH " }).defaultEffort).toBe("high");
    expect(normalizeAppPreferences({ defaultEffort: "turbo" }).defaultEffort).toBe("turbo");
    expect(normalizeAppPreferences({ defaultEffort: 3 }).defaultEffort).toBe(null);
    expect(normalizeAppPreferences({ defaultEffort: "high!" }).defaultEffort).toBe(null);
  });

  it("stays main-owned, not user-patchable", () => {
    const patch = normalizeUserPreferencePatch({ defaultEffort: "high", theme: "light" });
    expect("defaultEffort" in patch).toBe(false);
    expect(patch.theme).toBe("light");
  });
});
