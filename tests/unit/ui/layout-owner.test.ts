import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  clampModifiedListHeight,
  DEFAULT_LAYOUT,
  MODIFIED_LIST_MIN,
  parseLayout,
} from "../../../src/main/layout.ts";

const owner = readFileSync(new URL("../../../src/main/layout.ts", import.meta.url), "utf8");
const renderer = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");

describe("layout owner (issue #358)", () => {
  it("parses persisted layouts and rejects unknown values", () => {
    expect(parseLayout("terminal-right")).toBe("terminal-right");
    expect(parseLayout("terminal-fullscreen")).toBe("terminal-fullscreen");
    expect(parseLayout("nope")).toBe(DEFAULT_LAYOUT);
    expect(parseLayout(null)).toBe(DEFAULT_LAYOUT);
  });

  it("clamps the modified list between the floor and the supplied max", () => {
    expect(clampModifiedListHeight(10, 200)).toBe(MODIFIED_LIST_MIN);
    expect(clampModifiedListHeight(400, 180)).toBe(180);
    expect(clampModifiedListHeight(120, Number.POSITIVE_INFINITY)).toBe(120);
  });

  it("owns split geometry and the three divider drags", () => {
    expect(owner).toContain("export function createLayout");
    expect(owner).toContain("function requestMinimize(");
    expect(owner).toContain("onDividerDown");
    expect(owner).toContain("onExplorerGrab");
    expect(owner).toContain("onModifiedDown");
    expect(renderer).toContain("createLayout");
    expect(renderer).toContain("function editorPaneOccupied()");
    expect(renderer).not.toContain("function applyLayout(");
    expect(renderer).not.toContain("let dragging = false");
  });
});
