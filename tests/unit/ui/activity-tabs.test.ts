import { describe, expect, it } from "vitest";
import {
  initialActivityTabState,
  reduceActivityTab,
  resolveActivityTab,
} from "../../../src/activity-tabs.ts";

describe("activity tabs", () => {
  it("falls back to timeline for unknown stored values", () => {
    expect(resolveActivityTab("plan")).toBe("plan");
    expect(resolveActivityTab("worldlines")).toBe("worldlines");
    expect(resolveActivityTab(null)).toBe("timeline");
    expect(resolveActivityTab("nope")).toBe("timeline");
    expect(resolveActivityTab(undefined)).toBe("timeline");
  });

  it("manual select switches and persists the tab", () => {
    const s0 = initialActivityTabState("timeline");
    const s1 = reduceActivityTab(s0, { type: "select", tab: "plan" });
    expect(s1.active).toBe("plan");
    // Re-selecting the active tab is a no-op (same state identity).
    expect(reduceActivityTab(s1, { type: "select", tab: "plan" })).toBe(s1);
  });

  it("new plan/worldlines/modified content auto-switches once", () => {
    const s0 = initialActivityTabState("timeline");
    const s1 = reduceActivityTab(s0, { type: "content", tab: "plan", has: true });
    expect(s1.active).toBe("plan");
    // Already true: no new edge, state identity preserved.
    expect(reduceActivityTab(s1, { type: "content", tab: "plan", has: true })).toBe(s1);
  });

  it("timeline content never auto-switches", () => {
    const s0 = initialActivityTabState("plan");
    const s1 = reduceActivityTab(s0, { type: "content", tab: "timeline", has: true });
    expect(s1.active).toBe("plan");
  });

  it("content loss never switches away", () => {
    const s0 = reduceActivityTab(initialActivityTabState("timeline"), { type: "content", tab: "plan", has: true });
    const s1 = reduceActivityTab(s0, { type: "content", tab: "plan", has: false });
    expect(s1.active).toBe("plan");
    expect(s1.content.plan).toBe(false);
  });

  it("sync updates state without switching", () => {
    const s0 = initialActivityTabState("timeline");
    const s1 = reduceActivityTab(s0, { type: "sync", tab: "modified", has: true });
    expect(s1.active).toBe("timeline");
    expect(s1.content.modified).toBe(true);
  });

  it("hiding the active tab falls back to timeline", () => {
    const s0 = reduceActivityTab(initialActivityTabState("timeline"), { type: "select", tab: "modified" });
    const s1 = reduceActivityTab(s0, { type: "visibility", tab: "modified", visible: false });
    expect(s1.active).toBe("timeline");
    // Hidden tabs cannot be selected.
    expect(reduceActivityTab(s1, { type: "select", tab: "modified" })).toBe(s1);
  });
});
