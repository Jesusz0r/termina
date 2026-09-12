import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stepTimelineIndex } from "../../../src/timeline.ts";

const html = readFileSync(new URL("../../../src/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../../../src/styles.css", import.meta.url), "utf8");

describe("timeline keyboard", () => {
  it("clamps arrow movement at both ends of the strip", () => {
    expect(stepTimelineIndex(3, 0, 1)).toBe(1);
    expect(stepTimelineIndex(3, 2, -1)).toBe(1);
    // A timeline reads in order: the ends hold instead of wrapping.
    expect(stepTimelineIndex(3, 0, -1)).toBeNull();
    expect(stepTimelineIndex(3, 2, 1)).toBeNull();
    expect(stepTimelineIndex(1, 0, 1)).toBeNull();
    // An empty strip, or a dot that is no longer in the model.
    expect(stepTimelineIndex(0, 0, 1)).toBeNull();
    expect(stepTimelineIndex(3, -1, 1)).toBeNull();
    expect(stepTimelineIndex(3, 3, -1)).toBeNull();
  });

  it("presents the strip as one labelled toolbar stop", () => {
    expect(html).toMatch(/id="timeline-dots"[^>]*role="toolbar"[^>]*aria-label="[^"]+"/);
    // Keyboard focus needs a ring: the dot is 8px and the hover zoom is mouse-only.
    expect(css).toMatch(/\.timeline-dot:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/);
  });
});
