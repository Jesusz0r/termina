import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const renderer = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");
const editor = readFileSync(new URL("../../../src/editor.ts", import.meta.url), "utf8");

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
    expect(sync).toContain("editorPaneOccupied()");
    expect(sync).toContain('if (minimizedWork === "editor") setMinimizedWork(null)');
    expect(sync).toContain('if (minimizedWork === null) setMinimizedWork("editor")');
    const setActiveStart = renderer.indexOf("function setActiveProject(");
    const setActive = renderer.slice(setActiveStart, renderer.indexOf("drainPendingToolTargets(activeProjectId)", setActiveStart));
    expect(setActive).toContain("syncEditorMinimizedForProject()");
    expect(setActive).not.toContain("collapseEditorIfIdle()");
  });

  it("skips auto-minimize when needsLogin and the editor is empty", () => {
    const occStart = renderer.indexOf("function editorPaneOccupied()");
    const occ = renderer.slice(occStart, renderer.indexOf("function syncEditorMinimizedForProject()"));
    expect(occ).toContain("hasOpenTabs()");
    expect(occ).toContain("needsLogin");
    expect(occ).toContain("syncEmptyState");
    // Tabs still occupy the pane; login only counts when no file is open.
    expect(occ.indexOf("hasOpenTabs()")).toBeLessThan(occ.indexOf("needsLogin"));
    expect(occ).toContain("return view?.needsLogin === true");

    const syncStart = renderer.indexOf("function syncEditorMinimizedForProject()");
    const sync = renderer.slice(syncStart, renderer.indexOf("function collapseEditorIfIdle()"));
    expect(sync).toContain("editorPaneOccupied()");
    // Occupied (tabs or login hint) restores; empty + signed-in still collapses.
    expect(sync.indexOf("editorPaneOccupied()")).toBeLessThan(sync.indexOf('setMinimizedWork(null)'));
    expect(sync.indexOf('setMinimizedWork(null)')).toBeLessThan(sync.indexOf('setMinimizedWork("editor")'));

    const collapseStart = renderer.indexOf("function collapseEditorIfIdle()");
    const collapse = renderer.slice(collapseStart, renderer.indexOf("function revealEditor()"));
    expect(collapse).toContain("editorPaneOccupied()");
    expect(collapse).toContain('setMinimizedWork("editor")');

    // No second login surface: chrome copy still lives in syncEmptyState.
    expect(editor).toContain("const showLogin = this.projectOpen && this.needsLogin && noTabs");
    expect(editor).toContain("this.emptyLogin.hidden = !showLogin");
  });

  it("preserves the split ratio across minimize/restore", () => {
    // The minimize takeover must clear the inline sizes (inline flex beats
    // the full-width rule), so the ratio is stashed on minimize and
    // re-applied on restore. Explicit layout changes drop the stash.
    expect(renderer).toContain("stashedSplit");
    const setMinStart = renderer.indexOf("function setMinimizedWork(");
    const setMin = renderer.slice(setMinStart, setMinStart + 600);
    expect(setMin).toContain("stashSplitSizes()");
    expect(setMin).toContain("restoreSplitSizes()");
    const stashStart = renderer.indexOf("function stashSplitSizes()");
    const stash = renderer.slice(stashStart, stashStart + 500);
    expect(stash).toContain("leftPane.style.flex");
    expect(stash).toContain("leftPane.style.flexBasis");
  });
});
