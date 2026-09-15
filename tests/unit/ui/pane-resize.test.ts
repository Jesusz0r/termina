import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const renderer = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");
const layoutSrc = readFileSync(new URL("../../../src/main/layout.ts", import.meta.url), "utf8");
const editor = readFileSync(new URL("../../../src/editor.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../../../src/styles.css", import.meta.url), "utf8");

describe("explorer divider grab", () => {
  it("claims near-miss presses before draggable file rows see them", () => {
    // Rows are draggable=true, so a grab 1px left of the 4px divider starts a
    // file drag in dense-tree projects. The capture redirect must run first.
    expect(layoutSrc).toContain("EXPLORER_GRAB_PX");
    expect(layoutSrc).toContain('window.addEventListener("mousedown"');
    const grabStart = layoutSrc.indexOf("const onExplorerGrab");
    const grabBlock = layoutSrc.slice(grabStart, grabStart + 1200);
    expect(grabBlock).toContain(", true)");
    expect(grabBlock).toContain("stopPropagation");
    expect(grabBlock).toContain("exploring = true");
  });

  it("heals a drag whose mouseup landed outside the window", () => {
    const moveStart = layoutSrc.indexOf("if (!exploring) return;");
    const moveBlock = layoutSrc.slice(moveStart, moveStart + 600);
    expect(moveBlock).toContain("e.buttons === 0");
    expect(moveBlock).toContain("finishExplorerDrag");
  });

  it("restores the editor when switching back to a project with open tabs", () => {
    // minimizedWork is layout-owned but occupancy is per-project: switching to an
    // empty project collapses, switching back must restore, and an explicit
    // terminal minimize must survive both directions.
    expect(renderer).toContain("layout.syncEditorMinimizedForProject()");
    const syncStart = layoutSrc.indexOf("function syncEditorMinimizedForProject()");
    const sync = layoutSrc.slice(syncStart, syncStart + 600);
    expect(sync).toContain("bindings.editorOccupied()");
    expect(sync).toContain('if (minimizedWork === "editor") setMinimizedWork(null)');
    expect(sync).toContain('if (minimizedWork === null) setMinimizedWork("editor")');
    const setActiveStart = renderer.indexOf("function setActiveProject(");
    const setActive = renderer.slice(setActiveStart, renderer.indexOf("drainPendingToolTargets(activeProjectId)", setActiveStart));
    expect(setActive).toContain("layout.syncEditorMinimizedForProject()");
    expect(setActive).not.toContain("collapseEditorIfIdle()");
  });

  it("skips auto-minimize when needsLogin and the editor is empty", () => {
    const occStart = renderer.indexOf("function editorPaneOccupied()");
    const occ = renderer.slice(occStart, renderer.indexOf("layout = createLayout("));
    expect(occ).toContain("hasOpenTabs()");
    expect(occ).toContain("needsLogin");
    expect(occ).toContain("syncEmptyState");
    // Tabs still occupy the pane; login only counts when no file is open.
    expect(occ.indexOf("hasOpenTabs()")).toBeLessThan(occ.indexOf("needsLogin"));
    expect(occ).toContain("return view?.needsLogin === true");

    const syncStart = layoutSrc.indexOf("function syncEditorMinimizedForProject()");
    const sync = layoutSrc.slice(syncStart, layoutSrc.indexOf("function collapseEditorIfIdle()"));
    expect(sync).toContain("bindings.editorOccupied()");
    // Occupied (tabs or login hint) restores; empty + signed-in still collapses.
    expect(sync.indexOf("bindings.editorOccupied()")).toBeLessThan(sync.indexOf('setMinimizedWork(null)'));
    expect(sync.indexOf('setMinimizedWork(null)')).toBeLessThan(sync.indexOf('setMinimizedWork("editor")'));

    const collapseStart = layoutSrc.indexOf("function collapseEditorIfIdle()");
    const collapse = layoutSrc.slice(collapseStart, layoutSrc.indexOf("function revealEditor()"));
    expect(collapse).toContain("bindings.editorOccupied()");
    expect(collapse).toContain('setMinimizedWork("editor")');

    // No second login surface: chrome copy still lives in syncEmptyState.
    expect(editor).toContain("const showLogin = this.projectOpen && this.needsLogin && noTabs");
    expect(editor).toContain("this.emptyLogin.hidden = !showLogin");
  });

  it("clears needsLogin when auth:login-hint says credentials exist", () => {
    expect(renderer).toContain('window.termina.onLoginHint');
    expect(renderer).toContain("view.needsLogin = e.needsLogin === true");
    expect(renderer).toContain("layout.syncEditorMinimizedForProject()");
    const main = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");
    expect(main).toContain("startLoginHintWatch");
    expect(main).toContain('this.send("auth:login-hint", { needsLogin })');
    expect(main).toContain('name !== "auth.json"');
  });

  it("preserves the split ratio across minimize/restore", () => {
    // The minimize takeover must clear the inline sizes (inline flex beats
    // the full-width rule), so the ratio is stashed on minimize and
    // re-applied on restore. Explicit layout changes drop the stash.
    expect(layoutSrc).toContain("stashedSplit");
    const setMinStart = layoutSrc.indexOf("function setMinimizedWork(");
    const setMin = layoutSrc.slice(setMinStart, setMinStart + 600);
    expect(setMin).toContain("stashSplitSizes()");
    expect(setMin).toContain("restoreSplitSizes()");
    const stashStart = layoutSrc.indexOf("function stashSplitSizes()");
    const stash = layoutSrc.slice(stashStart, stashStart + 500);
    expect(stash).toContain("leftPane.style.flex");
    expect(stash).toContain("leftPane.style.flexBasis");
  });
});

describe("explorer minimize chrome", () => {
  it("hides the filter with the same minimized CSS as the tree", () => {
    // applyExplorerMinimized only toggles the class; body chrome must hide
    // via that one CSS list, including the filter that sits under the header.
    const applyStart = layoutSrc.indexOf("function applyExplorerMinimized()");
    const apply = layoutSrc.slice(applyStart, layoutSrc.indexOf("function setExplorerMinimized("));
    expect(apply).toContain('explorerEl.classList.toggle("minimized", explorerMinimized)');
    expect(apply).not.toContain("explorer-filter");

    const hideStart = css.indexOf("#explorer.minimized #explorer-tree");
    expect(hideStart).toBeGreaterThan(-1);
    const hideBlock = css.slice(hideStart, css.indexOf("}", hideStart) + 1);
    expect(hideBlock).toContain(".explorer-filter");
    expect(hideBlock).toContain(".explorer-content");
    expect(hideBlock).toMatch(/display:\s*none/);
  });

  it("hides the tree scrollbar without disabling overflow", () => {
    const start = css.indexOf("#explorer-tree {");
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf("}", start) + 1);
    expect(block).toMatch(/overflow-y:\s*auto/);
    expect(block).toMatch(/scrollbar-width:\s*none/);
    // Content height must not become the sidebar's minimum or a tall tree
    // grows #main and leaves a blank strip under the status bar.
    expect(block).toMatch(/min-height:\s*0/);

    const explorerStart = css.indexOf("#explorer {");
    expect(explorerStart).toBeGreaterThan(-1);
    const explorer = css.slice(explorerStart, css.indexOf("}", explorerStart) + 1);
    expect(explorer).toMatch(/min-height:\s*0/);

    const webkitStart = css.indexOf("#explorer-tree::-webkit-scrollbar");
    expect(webkitStart).toBeGreaterThan(-1);
    const webkit = css.slice(webkitStart, css.indexOf("}", webkitStart) + 1);
    expect(webkit).toMatch(/display:\s*none/);
  });
});

describe("work pane minimize", () => {
  it("lets the terminal collapse while the editor owns the split", () => {
    const start = layoutSrc.indexOf("function requestMinimize(");
    const block = layoutSrc.slice(start, layoutSrc.indexOf("function syncPaneToggle("));
    // Occupancy used to no-op terminal minimize when the editor was empty,
    // so an expanded/maximized editor could not collapse the terminal.
    expect(block).not.toContain("editorPaneOccupied()");
    expect(block).not.toContain('pane === "terminal" && !editorPaneOccupied()');
    expect(block).toContain("setMinimizedWork(pane)");
    // Clicking the already-collapsed pane restores it; clicking the other
    // swaps so both are never bars.
    expect(block).toContain("if (minimizedWork === pane)");
    expect(block).toContain("setMinimizedWork(null)");
    // Terminal fullscreen is a maximize: leave it, then still minimize.
    expect(block).toContain("isFullscreenLayout()");
    expect(block).toContain("exitFullscreen()");
    expect(block.indexOf('pane === "editor"')).toBeLessThan(block.lastIndexOf("setMinimizedWork(pane)"));
  });

  it("does not auto-collapse an idle editor over an explicit terminal minimize", () => {
    const collapseStart = layoutSrc.indexOf("function collapseEditorIfIdle()");
    const collapse = layoutSrc.slice(collapseStart, layoutSrc.indexOf("function revealEditor()"));
    expect(collapse).toContain('minimizedWork === "terminal"');
    expect(collapse.indexOf('minimizedWork === "terminal"')).toBeLessThan(collapse.indexOf('setMinimizedWork("editor")'));
  });
});
