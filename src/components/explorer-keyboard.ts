/**
 * Explorer keyboard navigation and roving focus.
 *
 * Owns the focus/type-ahead state and every tree keystroke. The Explorer
 * owns the tree data and row rendering; this collaborator drives them
 * through a narrow host. Split from components/explorer.ts (issue #38)
 * with no behavior change.
 */
import { findTypeAheadIndex, isTypeAheadKey, parentRowRel } from "../explorer-file";
import type { ExplorerEntry } from "../../shared/types";
import type { DirView } from "./explorer-rows";

/** Matches the CSS transition on the focus ring; type-ahead resets after it. */
const TYPE_AHEAD_RESET_MS = 700;

/** Narrow Explorer surface the keyboard collaborator drives. */
export interface ExplorerKeyboardHost {
  treeEl: HTMLElement;
  rowEntry: WeakMap<HTMLElement, ExplorerEntry>;
  dirViews: Map<string, DirView>;
  select(entry: ExplorerEntry, row: HTMLElement): void;
  invalidateDisconnectedSelection(): void;
  setDirExpanded(absPath: string, expanded: boolean): Promise<void>;
  deleteAt(entry: ExplorerEntry): Promise<void>;
  renameAt(entry: ExplorerEntry): Promise<void>;
  openFile(absPath: string, preview?: boolean): void;
}

export class ExplorerKeyboard {
  /** The row currently holding the roving tabindex (tabIndex 0). */
  private focusedRow: HTMLElement | null = null;
  /** Roving tabindex target: the project-relative path of the focused row. */

  /** Roving tabindex target: the project-relative path of the focused row. */
  private focusedPath: string | null = null;
  /** Filter box, when the host markup provides one. */

  /** Type-ahead buffer and its reset timer (keyboard name search). */
  private typeBuffer = "";

  private typeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private host: ExplorerKeyboardHost) {}

  /** Clear focus and type-ahead (project switch tears the tree down). */
  reset(): void {
    this.focusedRow = null;
    this.focusedPath = null;
    this.resetTypeAhead();
  }

  /**
   * Rows the keyboard can reach, in DOM order (which is preorder traversal and
   * therefore visual order).
   *
   * Hidden rows are excluded: an active filter hides rows without unmounting
   * them, so without this the arrow keys and type-ahead would walk into rows the
   * user cannot see.
   */
  visibleRows(): HTMLElement[] {
    return [...this.host.treeEl.querySelectorAll<HTMLElement>(".explorer-row:not([hidden])")];
  }

  rowByRel(rel: string): HTMLElement | null {
    for (const row of this.visibleRows()) {
      if (row.dataset.relPath === rel) return row;
    }
    return null;
  }

  currentRow(rows: HTMLElement[]): HTMLElement | null {
    if (rows.length === 0) return null;
    const byPath = this.focusedPath ? rows.find((r) => r.dataset.relPath === this.focusedPath) : undefined;
    return byPath ?? rows[0]!;
  }

  /** Remember the focused row and move the roving tabindex onto it. */
  /**
   * Move the roving tabindex onto `row`. O(1): only the previously focused row
   * and the new one change, so a keystroke on a 2000-entry tree does two DOM
   * writes instead of re-scanning every row.
   */

  /** Remember the focused row and move the roving tabindex onto it. */
  /**
   * Move the roving tabindex onto `row`. O(1): only the previously focused row
   * and the new one change, so a keystroke on a 2000-entry tree does two DOM
   * writes instead of re-scanning every row.
   */
  markFocus(row: HTMLElement): void {
    const previous = this.focusedRow;
    if (previous && previous !== row) previous.tabIndex = -1;
    row.tabIndex = 0;
    this.focusedRow = row;
    this.focusedPath = row.dataset.relPath ?? null;
  }

  storeFocusedRow(): void {
    const active = document.activeElement as HTMLElement | null;
    if (active && this.host.treeEl.contains(active) && active.dataset.relPath !== undefined) {
      this.markFocus(active);
    }
  }

  /** Focus a row: selection follows focus, so rename/delete target it. */

  /** Focus a row: selection follows focus, so rename/delete target it. */
  focusRow(row: HTMLElement, focus = true): void {
    this.markFocus(row);
    if (focus) row.focus();
    const entry = this.host.rowEntry.get(row);
    if (entry) this.host.select(entry, row);
  }

  /**
   * Re-apply roving focus after the tree was rebuilt (refresh, expand,
   * collapse). Keeps DOM focus only when the tree already had it, so a
   * background watcher refresh never steals focus from the editor.
   */

  /**
   * Re-apply roving focus after the tree was rebuilt (refresh, expand,
   * collapse). Keeps DOM focus only when the tree already had it, so a
   * background watcher refresh never steals focus from the editor.
   */
  restoreFocus(fallbackRel: string | null = null): void {
    // A rebuild can drop the selected entry (deleted on disk, filtered out).
    // Leaving it selected would aim rename/delete at a path that is gone.
    this.host.invalidateDisconnectedSelection();
    const rows = this.visibleRows();
    if (rows.length === 0) return;
    const hadFocus = this.host.treeEl.contains(document.activeElement);
    const target =
      (this.focusedPath ? rows.find((r) => r.dataset.relPath === this.focusedPath) : undefined)
      ?? (fallbackRel !== null ? rows.find((r) => r.dataset.relPath === fallbackRel) : undefined)
      ?? rows[0]!;
    this.markFocus(target);
    if (hadFocus) target.focus();
  }

  /**
   * Expand the tree to a project-relative file and move the selection onto
   * its row, so the tree agrees with the editor about where the user is.
   * Moves the roving tabindex but never DOM focus, so opening a file from
   * Quick Open does not steal focus back from the editor.
   */

  /** Drop the type-ahead buffer. Navigation keys end a name search, so a stale
   *  buffer cannot combine with the next keystroke. */
  private resetTypeAhead(): void {
    this.typeBuffer = "";
    if (this.typeTimer) {
      clearTimeout(this.typeTimer);
      this.typeTimer = null;
    }
  }

  onKeyDown(e: KeyboardEvent): void {
    if (e.defaultPrevented) return;
    // Modifier combos belong to the shortcut dispatcher and the browser.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // The capture-phase shortcut dispatcher in main handles F2 when it is
    // bound; this fallback keeps rename working when it is unbound.
    if (e.key === "F2") {
      const row = this.currentRow(this.visibleRows());
      const entry = row ? this.host.rowEntry.get(row) : undefined;
      if (entry) {
        e.preventDefault();
        void this.host.renameAt(entry);
      }
      return;
    }
    const rows = this.visibleRows();
    const row = this.currentRow(rows);
    if (!row) return;
    const index = rows.indexOf(row);
    const entry = this.host.rowEntry.get(row);

    const move = (delta: number): void => {
      const next = rows[index + delta];
      if (next) this.focusRow(next);
    };

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        this.resetTypeAhead();
        move(1);
        return;
      case "ArrowUp":
        e.preventDefault();
        this.resetTypeAhead();
        move(-1);
        return;
      case "Home":
        e.preventDefault();
        this.resetTypeAhead();
        this.focusRow(rows[0]!);
        return;
      case "End":
        e.preventDefault();
        this.resetTypeAhead();
        this.focusRow(rows[rows.length - 1]!);
        return;
      case "ArrowRight": {
        if (!entry) return;
        e.preventDefault();
        this.resetTypeAhead();
        if (entry.type === "dir") {
          const view = this.host.dirViews.get(entry.path);
          if (view && !view.state.expanded) void this.host.setDirExpanded(entry.path, true);
          // Already open: step into the first child, if it is mounted.
          else {
            const next = rows[index + 1];
            if (next && Number(next.getAttribute("aria-level")) > Number(row.getAttribute("aria-level"))) {
              this.focusRow(next);
            }
          }
        }
        return;
      }
      case "ArrowLeft": {
        if (!entry) return;
        e.preventDefault();
        this.resetTypeAhead();
        const view = entry.type === "dir" ? this.host.dirViews.get(entry.path) : undefined;
        if (view?.state.expanded) {
          void this.host.setDirExpanded(entry.path, false);
          return;
        }
        const parentRel = parentRowRel(entry.relPath);
        if (parentRel !== null) {
          const parentRow = this.rowByRel(parentRel);
          if (parentRow) this.focusRow(parentRow);
        }
        return;
      }
      case "Enter": {
        if (!entry) return;
        e.preventDefault();
        this.resetTypeAhead();
        if (entry.type === "dir") {
          const view = this.host.dirViews.get(entry.path);
          void this.host.setDirExpanded(entry.path, !(view?.state.expanded ?? false));
        } else {
          // Same as double-click: open pinned, not as a preview.
          this.host.openFile(entry.path, false);
        }
        return;
      }
      case "Delete": {
        // The root row has no relPath; there is nothing to delete.
        if (!entry || !entry.relPath) return;
        e.preventDefault();
        void this.host.deleteAt(entry);
        return;
      }
      case "Backspace": {
        // While a type-ahead search is active, Backspace edits the search
        // instead of arming a delete: a typo must never open a destructive
        // confirm in the middle of typing a file name.
        if (this.typeBuffer) {
          e.preventDefault();
          this.typeBuffer = this.typeBuffer.slice(0, -1);
          if (this.typeBuffer) this.applyTypeAhead(rows, index);
          return;
        }
        if (!entry || !entry.relPath) return;
        e.preventDefault();
        void this.host.deleteAt(entry);
        return;
      }
      default:
        break;
    }

    // Type-ahead: a printable single character jumps to the next matching name.
    if (isTypeAheadKey(e.key)) {
      if (this.typeAhead(rows, index, e.key)) e.preventDefault();
    }
  }

  /** Focus the row matching the current buffer; false when nothing matches. */

  /** Focus the row matching the current buffer; false when nothing matches. */
  private applyTypeAhead(rows: HTMLElement[], index: number): boolean {
    const names = rows.map((r) => r.dataset.name ?? "");
    const found = findTypeAheadIndex(names, index, this.typeBuffer);
    const row = found === -1 ? undefined : rows[found];
    if (!row) return false;
    this.focusRow(row);
    return true;
  }

  /** Extend the type-ahead buffer and focus the next name that matches it. */

  /** Extend the type-ahead buffer and focus the next name that matches it. */
  private typeAhead(rows: HTMLElement[], index: number, char: string): boolean {
    this.typeBuffer += char;
    if (this.typeTimer) clearTimeout(this.typeTimer);
    this.typeTimer = setTimeout(() => {
      this.typeTimer = null;
      this.typeBuffer = "";
    }, TYPE_AHEAD_RESET_MS);
    return this.applyTypeAhead(rows, index);
  }
}
