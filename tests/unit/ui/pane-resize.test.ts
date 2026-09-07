import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const renderer = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");

describe("explorer divider grab", () => {
  it("claims near-miss presses before draggable file rows see them", () => {
    // Rows are draggable=true, so a grab 1px left of the 4px divider starts a
    // file drag in dense-tree projects. The capture redirect must run first.
    expect(renderer).toContain("EXPLORER_GRAB_PX");
    expect(renderer).toContain('window.addEventListener("mousedown"');
    const grabStart = renderer.indexOf("EXPLORER_GRAB_PX = ");
    const grabBlock = renderer.slice(grabStart, grabStart + 1200);
    expect(grabBlock).toContain(", true)");
    expect(grabBlock).toContain("stopPropagation");
    expect(grabBlock).toContain("exploring = true");
  });

  it("heals a drag whose mouseup landed outside the window", () => {
    const moveStart = renderer.indexOf("if (!exploring) return;");
    const moveBlock = renderer.slice(moveStart, moveStart + 600);
    expect(moveBlock).toContain("e.buttons === 0");
    expect(moveBlock).toContain("finishExplorerDrag");
  });

  it("restores the editor when switching back to a project with open tabs", () => {
    // minimizedWork is global but occupancy is per-project: switching to an
    // empty project collapses, switching back must restore, and an explicit
    // terminal minimize must survive both directions.
    expect(renderer).toContain("syncEditorMinimizedForProject()");
    const syncStart = renderer.indexOf("function syncEditorMinimizedForProject()");
    const sync = renderer.slice(syncStart, syncStart + 600);
    expect(sync).toContain('if (minimizedWork === "editor") setMinimizedWork(null)');
    expect(sync).toContain('if (minimizedWork === null) setMinimizedWork("editor")');
    const setActiveStart = renderer.indexOf("function setActiveProject(");
    const setActive = renderer.slice(setActiveStart, renderer.indexOf("drainPendingToolTargets(activeProjectId)", setActiveStart));
    expect(setActive).toContain("syncEditorMinimizedForProject()");
    expect(setActive).not.toContain("collapseEditorIfIdle()");
  });
});
