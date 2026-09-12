/**
 * Explorer row builders and row state.
 *
 * DOM construction for tree rows plus the mounted-directory view model.
 * The Explorer owns the tree; this module owns row elements. Split from
 * components/explorer.ts (issue #38) with no behavior change.
 */
import { fileIconKind, rowLevel, splitExtension } from "../explorer-file";
import type { ExplorerEntry } from "../../shared/types";

/** Icon element for a file row; the kind drives the CSS shape/color. */
export function makeFileIcon(name: string): HTMLElement {
  const icon = document.createElement("span");
  icon.className = "explorer-icon file-icon";
  icon.dataset.kind = fileIconKind(name);
  return icon;
}

/** Right-edge dot for a row the agent changed. Always occupies its width (the
 *  `.changed` class toggles opacity only), so marking never reflows the row. */
export function makeChangeMark(): HTMLElement {
  const mark = document.createElement("span");
  mark.className = "explorer-change";
  mark.setAttribute("aria-hidden", "true");
  return mark;
}

/** Non-interactive placeholder (loading, truncation). Not a button. */
export function makeNote(text: string): HTMLElement {
  const note = document.createElement("div");
  note.className = "explorer-note";
  note.textContent = text;
  return note;
}

/** Name element; for files the extension is dimmed so the basename reads
 *  first. Directories stay single-tone (a dot is just part of the name). */
export function makeNameEl(name: string, twoTone = true): HTMLElement {
  const el = document.createElement("span");
  el.className = "explorer-name";
  el.title = name;
  const { base, ext } = twoTone ? splitExtension(name) : { base: name, ext: "" };
  if (!ext) {
    el.textContent = name;
    return el;
  }
  const baseEl = document.createElement("span");
  baseEl.className = "explorer-name-base";
  baseEl.textContent = base;
  const extEl = document.createElement("span");
  extEl.className = "explorer-name-ext";
  extEl.textContent = ext;
  el.append(baseEl, extEl);
  return el;
}

export interface DirState {
  expanded: boolean;
  loaded: boolean;
  /** Bumped per list. A slow listing never fills a newer expand. */
  loadSeq: number;
}

export interface DirView {
  entry: ExplorerEntry;
  state: DirState;
  node: HTMLElement;
  children: HTMLElement;
  /** The row element and its chevron, so a keyboard toggle updates both. */
  row: HTMLElement;
  arrow: HTMLElement;
}

/**
 * ARIA treeitem attributes for a row. `aria-level` follows the tree depth and
 * `aria-expanded` exists only for directories (a file must not claim it).
 */
export function applyRowA11y(row: HTMLElement, entry: ExplorerEntry, expanded?: boolean): void {
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-level", String(rowLevel(entry.relPath)));
  if (entry.type === "dir") row.setAttribute("aria-expanded", expanded ? "true" : "false");
  row.setAttribute("aria-selected", row.classList.contains("selected") ? "true" : "false");
  // Roving tabindex: exactly one row is tabbable, the rest are reachable by arrow.
  if (row.tabIndex !== 0) row.tabIndex = -1;
}
