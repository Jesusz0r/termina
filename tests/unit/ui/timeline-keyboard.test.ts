import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MAX_TIMELINE_EVENTS, stepTimelineIndex } from "../../../src/timeline.ts";

const html = readFileSync(new URL("../../../src/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../../../src/styles.css", import.meta.url), "utf8");
const timelineSrc = readFileSync(new URL("../../../src/timeline.ts", import.meta.url), "utf8");

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

  it("caps the strip and restores a tab stop after eviction", () => {
    expect(MAX_TIMELINE_EVENTS).toBe(400);
    expect(timelineSrc).toContain("if (this.tabStopSeq === null || !this.dots.has(this.tabStopSeq))");
    expect(timelineSrc).toContain("const hadDotFocus = this.timelineHasDotFocus()");
    expect(timelineSrc).toContain("this.restoreTimelineFocus(hadDotFocus)");
  });

  it("stops replay on Escape unless a nested surface owns the key", () => {
    expect(timelineSrc).toContain("document.addEventListener(\"keydown\", this.onDocumentKeydown)");
    expect(timelineSrc).toContain('target.closest("#terminal-container")');
    expect(timelineSrc).toContain('target.closest("#modal-root")');
    expect(timelineSrc).toContain('target.closest("#review-container")');
  });
});
