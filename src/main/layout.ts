/**
 * Workbench layout: split orientation, minimize bars, and the three
 * divider drags (main split, explorer, modified list).
 * Owns persisted geometry and drag flags. Main supplies occupancy,
 * editor/terminal fit, and the modified-tab visibility hook.
 */

export type Layout = "terminal-left" | "terminal-right" | "terminal-top" | "terminal-bottom" | "terminal-fullscreen";
export type WorkPane = "terminal" | "editor";
export const SPLIT_LAYOUTS = ["terminal-left", "terminal-right", "terminal-top", "terminal-bottom"] as const;
export const DEFAULT_LAYOUT: Layout = "terminal-left";
export const LAYOUT_KEY = "termina.layout";
export const EXPLORER_KEY = "termina.explorer";
export const MODIFIED_KEY = "termina.modified";
export const MODIFIED_HEIGHT_KEY = "termina.modifiedHeight";
export const WORKPANE_KEY = "termina.workpane";
export const PANE_MIN_ICON = "–";
export const PANE_MAX_ICON = "□";
export const EXPLORER_GRAB_PX = 8;
export const MODIFIED_LIST_MIN = 72;
export const MODIFIED_LIST_DEFAULT = 160;
export const TERMINAL_MIN_PX = 128;

export function isSplitLayout(value: string | null): value is (typeof SPLIT_LAYOUTS)[number] {
  return SPLIT_LAYOUTS.includes(value as (typeof SPLIT_LAYOUTS)[number]);
}

export function parseLayout(raw: string | null): Layout {
  if (raw === "terminal-fullscreen" || isSplitLayout(raw)) return raw;
  return DEFAULT_LAYOUT;
}

export function clampModifiedListHeight(px: number, max: number): number {
  const cap = Number.isFinite(max) ? max : Math.max(MODIFIED_LIST_MIN, Math.round(px));
  return Math.min(cap, Math.max(MODIFIED_LIST_MIN, Math.round(px)));
}

export interface LayoutElements {
  splitEl: HTMLElement;
  leftPane: HTMLElement;
  rightPaneEl: HTMLElement;
  explorerEl: HTMLElement;
  explorerDividerEl: HTMLElement;
  modifiedPanelEl: HTMLElement;
  modifiedList: HTMLElement;
  modifiedResizeEl: HTMLElement;
  termContainer: HTMLElement;
  divider: HTMLElement;
  btnMinExplorer: HTMLButtonElement;
  btnMinTerminal: HTMLButtonElement;
  btnMinEditor: HTMLButtonElement;
  mainEl: HTMLElement;
}

interface LayoutBindings {
  elements: LayoutElements;
  editorOccupied(): boolean;
  layoutEditors(): void;
  layoutActiveTerminal(): void;
  setModifiedTabVisible(visible: boolean): void;
}

export function createLayout(bindings: LayoutBindings): {
  applyLayout(layout: Layout): void;
  isFullscreenLayout(): boolean;
  exitFullscreen(): void;
  fitPanes(): void;
  setExplorerMinimized(minimized: boolean): void;
  syncEditorMinimizedForProject(): void;
  collapseEditorIfIdle(): void;
  revealEditor(): void;
  revealTerminal(): void;
  requestMinimize(pane: WorkPane): void;
  setModifiedVisible(visible: boolean): void;
  toggleExplorer(): void;
  toggleModified(): void;
  restore(): void;
  workPaneCollapsed(): boolean;
  isColumnLayout(): boolean;
  dispose(): void;
} {
  const {
    splitEl,
    leftPane,
    rightPaneEl,
    explorerEl,
    explorerDividerEl,
    modifiedPanelEl,
    modifiedList,
    modifiedResizeEl,
    termContainer,
    divider,
    btnMinExplorer,
    btnMinTerminal,
    btnMinEditor,
    mainEl,
  } = bindings.elements;

  let explorerMinimized = false;
  let minimizedWork: WorkPane | null = null;
  let lastSplitLayout: Layout = DEFAULT_LAYOUT;
  /** The user's split-divider ratio, stashed while a work pane is minimized
   *  and re-applied on restore. The minimize takeover needs the inline sizes
   *  cleared (inline flex would beat the full-width CSS rule), but without
   *  the stash every minimize/restore cycle — minimize button, review reveal,
   *  project switch to an empty project — silently reset the ratio. Explicit
   *  layout changes drop the stash: a new geometry starts from 50/50. */
  let stashedSplit: { flex: string; flexBasis: string } | null = null;

  function isFullscreenLayout(): boolean {
    return splitEl.classList.contains("layout-terminal-fullscreen");
  }

  function exitFullscreen(): void {
    if (isFullscreenLayout()) applyLayout(lastSplitLayout);
  }

  function applyLayout(layout: Layout): void {
    if (isSplitLayout(layout)) lastSplitLayout = layout;
    for (const l of ["terminal-left", "terminal-right", "terminal-top", "terminal-bottom", "terminal-fullscreen"] as const) {
      splitEl.classList.toggle(`layout-${l}`, l === layout);
    }
    // Fullscreen hides the editor and explorer so the TUI owns the window.
    // Minimize bars stay in the persisted state and return when fullscreen ends.
    if (layout === "terminal-fullscreen") {
      setExplorerHidden(true);
      rightPaneEl.style.display = "none";
    } else {
      setExplorerHidden(false);
      rightPaneEl.style.display = "";
      applyExplorerMinimized();
      applyWorkMinimized();
    }
    clearSplitSizes();
    stashedSplit = null;
    localStorage.setItem(LAYOUT_KEY, layout);
    fitPanes();
  }

  function clearSplitSizes(): void {
    leftPane.style.width = "";
    leftPane.style.height = "";
    leftPane.style.flexBasis = "";
    leftPane.style.flex = "";
  }

  function stashSplitSizes(): void {
    // Only a real divider drag overwrites: swapping which pane is minimized
    // must keep the earlier stash, not replace it with cleared inline sizes.
    const flex = leftPane.style.flex;
    const flexBasis = leftPane.style.flexBasis;
    if (flex || flexBasis) stashedSplit = { flex, flexBasis };
  }

  function restoreSplitSizes(): void {
    if (!stashedSplit) return;
    if (stashedSplit.flex) leftPane.style.flex = stashedSplit.flex;
    if (stashedSplit.flexBasis) leftPane.style.flexBasis = stashedSplit.flexBasis;
    stashedSplit = null;
  }

  function fitPanes(): void {
    // Flush the new flex sizes before measuring. A delayed fit paints one
    // frame at the old cell grid, then snaps — that is the occupancy flicker.
    void splitEl.getBoundingClientRect();
    bindings.layoutEditors();
    // Only the visible pane: hidden panes measure 0 and skip anyway, but
    // fitting each of them on every layout change spams pty resizes when
    // they become visible with stale grids. They fit on activation instead.
    bindings.layoutActiveTerminal();
  }

  function setExplorerHidden(hidden: boolean): void {
    explorerEl.style.display = hidden ? "none" : "";
    explorerDividerEl.style.display = hidden || explorerMinimized ? "none" : "";
  }

  function applyExplorerMinimized(): void {
    explorerEl.classList.toggle("minimized", explorerMinimized);
    if (!isFullscreenLayout()) {
      explorerEl.style.display = "";
      explorerDividerEl.style.display = explorerMinimized ? "none" : "";
    }
    syncPaneToggle(btnMinExplorer, explorerMinimized, "explorer");
  }

  function setExplorerMinimized(minimized: boolean): void {
    explorerMinimized = minimized;
    localStorage.setItem(EXPLORER_KEY, minimized ? "0" : "1");
    applyExplorerMinimized();
    fitPanes();
  }

  function applyWorkMinimized(): void {
    leftPane.classList.toggle("minimized", minimizedWork === "terminal");
    rightPaneEl.classList.toggle("minimized", minimizedWork === "editor");
    syncPaneToggle(btnMinTerminal, minimizedWork === "terminal", "terminal");
    syncPaneToggle(btnMinEditor, minimizedWork === "editor", "editor");
  }

  function setMinimizedWork(pane: WorkPane | null): void {
    minimizedWork = pane;
    if (pane) localStorage.setItem(WORKPANE_KEY, pane);
    else localStorage.removeItem(WORKPANE_KEY);
    if (pane) stashSplitSizes();
    applyWorkMinimized();
    clearSplitSizes();
    if (!pane) restoreSplitSizes();
    fitPanes();
  }

  /** Project switches share one minimize bar but occupancy is per-project: an
   *  empty project auto-collapses the editor, and returning to a project with
   *  open tabs (or a first-run login hint) restores it. An explicit terminal
   *  minimize is never clobbered. */
  function syncEditorMinimizedForProject(): void {
    if (bindings.editorOccupied()) {
      if (minimizedWork === "editor") setMinimizedWork(null);
      return;
    }
    if (minimizedWork === null) setMinimizedWork("editor");
  }

  function collapseEditorIfIdle(): void {
    if (bindings.editorOccupied()) return;
    // An explicit terminal minimize owns the split. Closing the last tab
    // must not steal it by auto-collapsing the empty editor.
    if (minimizedWork === "terminal") return;
    if (minimizedWork !== "editor") setMinimizedWork("editor");
  }

  function revealEditor(): void {
    exitFullscreen();
    if (minimizedWork === "editor") setMinimizedWork(null);
  }

  function revealTerminal(): void {
    exitFullscreen();
    if (minimizedWork === "terminal") setMinimizedWork(null);
  }

  function requestMinimize(pane: WorkPane): void {
    if (isFullscreenLayout()) {
      exitFullscreen();
      // Terminal fullscreen is a maximize. Toggle-editor only leaves that
      // layout so the editor can come back; toggle-terminal falls through
      // so the terminal can still collapse while the editor stays up.
      if (pane === "editor") {
        if (minimizedWork === "editor") setMinimizedWork(null);
        return;
      }
    }
    // Restore when this pane is already the thin bar. Manual toggle always
    // restores, even an empty editor; auto-collapse still hides it on idle.
    if (minimizedWork === pane) {
      setMinimizedWork(null);
      return;
    }
    // One work pane always stays expanded. Minimizing the last visible
    // pane swaps: the other is restored (maximized) automatically.
    // Occupancy must not block this — an expanded editor, empty or not,
    // can still collapse the terminal.
    setMinimizedWork(pane);
  }

  function syncPaneToggle(button: HTMLButtonElement, minimized: boolean, label: string): void {
    button.textContent = minimized ? PANE_MAX_ICON : PANE_MIN_ICON;
    const action = minimized ? "Restore" : "Minimize";
    button.title = `${action} ${label}`;
    button.setAttribute("aria-label", `${action} ${label}`);
  }

  function setModifiedVisible(visible: boolean): void {
    modifiedPanelEl.style.display = visible ? "" : "none";
    bindings.setModifiedTabVisible(visible);
    localStorage.setItem(MODIFIED_KEY, visible ? "1" : "0");
  }

  function toggleExplorer(): void {
    if (isFullscreenLayout()) exitFullscreen();
    else setExplorerMinimized(!explorerMinimized);
  }

  function toggleModified(): void {
    setModifiedVisible(modifiedPanelEl.style.display === "none");
  }

  function isColumnLayout(): boolean {
    return splitEl.classList.contains("layout-terminal-top") || splitEl.classList.contains("layout-terminal-bottom");
  }

  function workPaneCollapsed(): boolean {
    return minimizedWork !== null;
  }

  const onMinExplorer = (event: Event): void => {
    event.stopPropagation();
    if (isFullscreenLayout()) {
      exitFullscreen();
      return;
    }
    setExplorerMinimized(!explorerMinimized);
  };
  const onMinTerminal = (event: Event): void => {
    event.stopPropagation();
    requestMinimize("terminal");
  };
  const onMinEditor = (event: Event): void => {
    event.stopPropagation();
    requestMinimize("editor");
  };
  btnMinExplorer.addEventListener("click", onMinExplorer);
  btnMinTerminal.addEventListener("click", onMinTerminal);
  btnMinEditor.addEventListener("click", onMinEditor);

  // ------------------------------------------------------------ split pane ----

  let dragging = false;
  const onDividerDown = (e: MouseEvent): void => {
    if (workPaneCollapsed()) return;
    e.preventDefault();
    dragging = true;
    suppressNativeDrag(true);
    document.body.style.cursor = isColumnLayout() ? "row-resize" : "col-resize";
  };
  divider.addEventListener("mousedown", onDividerDown);
  const onSplitMove = (e: MouseEvent): void => {
    if (!dragging) return;
    const rect = splitEl.getBoundingClientRect();
    if (isColumnLayout()) {
      const pct = ((e.clientY - rect.top) / rect.height) * 100;
      leftPane.style.flexBasis = `${Math.min(75, Math.max(25, pct))}%`;
    } else {
      // flex-basis (not width) drives the split: #left-pane is a flex item
      // whose flex-basis overrides width. Grow stays on so the right pane
      // absorbs free space and the left lands exactly on the dragged share.
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      leftPane.style.flex = `0 1 ${Math.min(70, Math.max(30, pct))}%`;
    }
  };
  const onSplitUp = (): void => {
    dragging = false;
    suppressNativeDrag(false);
    document.body.style.cursor = "";
  };
  window.addEventListener("mousemove", onSplitMove);
  window.addEventListener("mouseup", onSplitUp);

  // explorer ↔ editor divider
  let exploring = false;
  function finishExplorerDrag(): void {
    exploring = false;
    suppressNativeDrag(false);
    document.body.style.cursor = "";
  }
  // File rows are native drag sources (`draggable=true` in explorer.ts): a grab
  // that lands even 1px left of the 4px divider starts a file drag instead of a
  // resize, and its mousemoves never reach the window. Projects with dense trees
  // fill the grab row, so the divider feels broken there and fine in sparse
  // projects. This capture-phase redirect claims near-miss presses before any
  // row sees them.
  const onExplorerGrab = (e: MouseEvent): void => {
    if (e.button !== 0 || exploring || explorerMinimized) return;
    const box = explorerDividerEl.getBoundingClientRect();
    // Only claim the divider's vertical span, not project tabs above it.
    if (box.width === 0 || e.clientY < box.top || e.clientY >= box.bottom) return;
    if (Math.abs(e.clientX - (box.left + box.width / 2)) > EXPLORER_GRAB_PX) return;
    e.preventDefault();
    e.stopPropagation();
    exploring = true;
    suppressNativeDrag(true);
    document.body.style.cursor = "col-resize";
  };
  window.addEventListener("mousedown", onExplorerGrab, true);
  const onExplorerDividerDown = (e: MouseEvent): void => {
    if (explorerMinimized) return;
    e.preventDefault();
    exploring = true;
    suppressNativeDrag(true);
    document.body.style.cursor = "col-resize";
  };
  explorerDividerEl.addEventListener("mousedown", onExplorerDividerDown);
  const onExplorerMove = (e: MouseEvent): void => {
    if (!exploring) return;
    // Released outside the window: no mouseup arrives, so heal here instead of
    // leaving the flag stuck (same pattern as the modified-list resize).
    if (e.buttons === 0) {
      finishExplorerDrag();
      return;
    }
    const rect = mainEl.getBoundingClientRect();
    const w = Math.min(420, Math.max(140, e.clientX - rect.left));
    explorerEl.style.width = `${w}px`;
  };
  const onExplorerUp = (): void => {
    finishExplorerDrag();
  };
  window.addEventListener("mousemove", onExplorerMove);
  window.addEventListener("mouseup", onExplorerUp);

  /** A native file drag started from a near-miss press steals the gesture
   *  (moves arrive as drag events, plus pointercancel) and can leave a pane
   *  drag flag stuck. Suppress dragstart while any divider drag is active. */
  let nativeDragSuppressed = false;
  function suppressNativeDrag(on: boolean): void {
    if (on === nativeDragSuppressed) return;
    nativeDragSuppressed = on;
    if (on) window.addEventListener("dragstart", cancelNativeDrag, true);
    else window.removeEventListener("dragstart", cancelNativeDrag, true);
  }
  function cancelNativeDrag(e: Event): void {
    e.preventDefault();
    e.stopPropagation();
  }
  const onPointerCancel = (): void => {
    dragging = false;
    exploring = false;
    suppressNativeDrag(false);
    document.body.style.cursor = "";
  };
  window.addEventListener("pointercancel", onPointerCancel);

  function modifiedPanelIsOpen(): boolean {
    return modifiedPanelEl.style.display !== "none" && !modifiedPanelEl.classList.contains("collapsed");
  }

  function modifiedListMaxHeight(): number {
    const paneH = leftPane.clientHeight;
    if (paneH <= 0) return Number.POSITIVE_INFINITY;
    const listH = modifiedList.getBoundingClientRect().height;
    const termH = termContainer.getBoundingClientRect().height;
    return Math.max(MODIFIED_LIST_MIN, Math.round(listH + termH - TERMINAL_MIN_PX));
  }

  function applyModifiedListHeight(px: number, max?: number): void {
    modifiedList.style.height = `${clampModifiedListHeight(px, max ?? modifiedListMaxHeight())}px`;
  }

  function restoreModifiedListHeight(): void {
    const raw = Number(localStorage.getItem(MODIFIED_HEIGHT_KEY));
    const h = Number.isFinite(raw) && raw > 0 ? raw : MODIFIED_LIST_DEFAULT;
    modifiedList.style.height = `${Math.max(MODIFIED_LIST_MIN, Math.round(h))}px`;
    requestAnimationFrame(() => applyModifiedListHeight(h));
  }

  let resizingModified = false;
  let modifiedDragStartY = 0;
  let modifiedDragStartH = 0;
  let modifiedDragMax = MODIFIED_LIST_MIN;
  let modifiedClampRaf = 0;

  function finishModifiedResize(): void {
    if (!resizingModified) return;
    resizingModified = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    localStorage.setItem(MODIFIED_HEIGHT_KEY, String(Math.round(modifiedList.getBoundingClientRect().height)));
    fitPanes();
  }
  const onModifiedDown = (e: MouseEvent): void => {
    if (!modifiedPanelIsOpen()) return;
    e.preventDefault();
    resizingModified = true;
    modifiedDragStartY = e.clientY;
    modifiedDragStartH = modifiedList.getBoundingClientRect().height;
    modifiedDragMax = modifiedListMaxHeight();
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  };
  modifiedResizeEl.addEventListener("mousedown", onModifiedDown);
  const onModifiedMove = (e: MouseEvent): void => {
    if (!resizingModified) return;
    if (e.buttons === 0) {
      finishModifiedResize();
      return;
    }
    applyModifiedListHeight(modifiedDragStartH + (modifiedDragStartY - e.clientY), modifiedDragMax);
  };
  const onModifiedUp = (): void => {
    if (resizingModified) finishModifiedResize();
  };
  window.addEventListener("mousemove", onModifiedMove);
  window.addEventListener("mouseup", onModifiedUp);

  const modifiedClampObserver = new ResizeObserver(() => {
    if (resizingModified || modifiedClampRaf) return;
    modifiedClampRaf = requestAnimationFrame(() => {
      modifiedClampRaf = 0;
      if (!modifiedPanelIsOpen()) return;
      applyModifiedListHeight(modifiedList.getBoundingClientRect().height);
    });
  });
  modifiedClampObserver.observe(leftPane);

  function restore(): void {
    const layout = parseLayout(localStorage.getItem(LAYOUT_KEY));
    explorerMinimized = localStorage.getItem(EXPLORER_KEY) === "0";
    const storedWork = localStorage.getItem(WORKPANE_KEY);
    minimizedWork = storedWork === "terminal" || storedWork === "editor" ? storedWork : null;
    if (isSplitLayout(layout)) lastSplitLayout = layout;
    applyLayout(layout);
    if (minimizedWork !== "editor" && !bindings.editorOccupied()) syncEditorMinimizedForProject();
    if (localStorage.getItem(MODIFIED_KEY) === "0") setModifiedVisible(false);
    restoreModifiedListHeight();
  }

  return {
    applyLayout,
    isFullscreenLayout,
    exitFullscreen,
    fitPanes,
    setExplorerMinimized,
    syncEditorMinimizedForProject,
    collapseEditorIfIdle,
    revealEditor,
    revealTerminal,
    requestMinimize,
    setModifiedVisible,
    toggleExplorer,
    toggleModified,
    restore,
    workPaneCollapsed,
    isColumnLayout,
    dispose: () => {
      btnMinExplorer.removeEventListener("click", onMinExplorer);
      btnMinTerminal.removeEventListener("click", onMinTerminal);
      btnMinEditor.removeEventListener("click", onMinEditor);
      divider.removeEventListener("mousedown", onDividerDown);
      window.removeEventListener("mousemove", onSplitMove);
      window.removeEventListener("mouseup", onSplitUp);
      window.removeEventListener("mousedown", onExplorerGrab, true);
      explorerDividerEl.removeEventListener("mousedown", onExplorerDividerDown);
      window.removeEventListener("mousemove", onExplorerMove);
      window.removeEventListener("mouseup", onExplorerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      modifiedResizeEl.removeEventListener("mousedown", onModifiedDown);
      window.removeEventListener("mousemove", onModifiedMove);
      window.removeEventListener("mouseup", onModifiedUp);
      modifiedClampObserver.disconnect();
      suppressNativeDrag(false);
    },
  };
}
